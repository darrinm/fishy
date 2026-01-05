import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import multer from 'multer';

import { MODEL_ALIASES } from '../models.js';
import { getVideoFiles, getVideosWithMetadata, createThumbnail, getVideoRecordingDate } from '../video.js';
import { analyzeVideoFile } from '../analyzer.js';
import { jobManager } from './progress.js';
import {
  saveAnalysis,
  getHistory,
  getAnalysis,
  deleteAnalysis,
  clearHistory,
  deduplicateHistory,
  getAggregatedSpecies,
  getStarredFrames,
  toggleStarFrame,
  getRotations,
  setRotation,
  getAllBoundingBoxes,
  saveBoundingBoxes,
  updateAnalysisDate,
} from './storage.js';
import { detectBoundingBoxes, listFiles, deleteAllFiles } from '../gemini.js';
import type { AnalyzeOptions, Provider } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const router = Router();

// Configure multer for video uploads
const uploadsDir = join(__dirname, '../../data/uploads');
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_req, file, cb) => {
    // Use unique ID + original extension to avoid conflicts
    const ext = file.originalname.split('.').pop();
    cb(null, `${uuidv4()}.${ext}`);
  },
});
const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'];
    const ext = '.' + file.originalname.split('.').pop()?.toLowerCase();
    cb(null, videoExts.includes(ext));
  },
});

// ============ JOB QUEUE (SINGLE CONCURRENCY) ============

interface QueuedJob {
  jobId: string;
  videoPath: string;
  originalName: string;
  modelConfig: { model: string; provider: string };
  fps: number;
}

const analysisQueue: QueuedJob[] = [];
const MAX_CONCURRENT_JOBS = 4;
let activeJobCount = 0;

async function processQueue(): Promise<void> {
  while (analysisQueue.length > 0 && activeJobCount < MAX_CONCURRENT_JOBS) {
    const job = analysisQueue.shift()!;
    activeJobCount++;

    // Run job without awaiting - allows parallel execution
    analyzeVideoJob(job.jobId, job.videoPath, job.originalName, job.modelConfig, job.fps)
      .catch(error => console.error(`Job ${job.jobId} failed:`, error))
      .finally(() => {
        activeJobCount--;
        processQueue(); // Process next job when one finishes
      });
  }
}

function enqueueJob(job: QueuedJob): void {
  // Create the job immediately so SSE can connect
  jobManager.createJob(job.jobId);
  jobManager.updateProgress(job.jobId, {
    stage: 'processing',
    percent: 0,
    message: 'Queued',
  });

  analysisQueue.push(job);
  processQueue();
}

// POST /api/upload - Upload video files (batch)
router.post('/upload', upload.array('videos', 50), (req: Request, res: Response) => {
  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) {
    res.status(400).json({ error: 'No video files uploaded' });
    return;
  }

  const uploaded = files.map(f => ({
    originalName: f.originalname,
    path: f.path,
    size: f.size,
  }));

  res.json({ files: uploaded });
});

// POST /api/upload/single - Upload single video file
router.post('/upload/single', upload.single('video'), (req: Request, res: Response) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'No video file uploaded' });
    return;
  }

  res.json({
    originalName: file.originalname,
    path: file.path,
    size: file.size,
  });
});

// DELETE /api/upload - Clean up uploaded files
router.delete('/upload', async (req: Request, res: Response) => {
  try {
    const { paths } = req.body as { paths: string[] };
    if (paths && paths.length > 0) {
      await Promise.all(paths.map(p => rm(p, { force: true })));
    }
    res.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// GET /api/models - List available models
router.get('/models', (_req: Request, res: Response) => {
  const models = Object.entries(MODEL_ALIASES).map(([id, config]) => ({
    id,
    name: id,
    model: config.model,
    provider: config.provider,
  }));

  res.json({ models });
});

// ============ SIMPLE ANALYZE ENDPOINT (NO BATCHES) ============

// POST /api/analyze - Upload and analyze a single video
router.post('/analyze', upload.single('video'), (req: Request, res: Response) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'No video file uploaded' });
    return;
  }

  const { model = '3-flash', fps = '1' } = req.body;

  const modelConfig = MODEL_ALIASES[model];
  if (!modelConfig) {
    res.status(400).json({ error: `Unknown model: ${model}` });
    return;
  }

  const jobId = uuidv4();

  // Add to queue (processes one at a time)
  enqueueJob({
    jobId,
    videoPath: file.path,
    originalName: file.originalname,
    modelConfig,
    fps: parseFloat(fps) || 1,
  });

  res.json({
    jobId,
    filename: file.originalname,
    path: file.path,
  });
});

// GET /api/analyze/:jobId/progress - SSE progress stream for single video
router.get('/analyze/:jobId/progress', (req: Request, res: Response) => {
  const { jobId } = req.params;
  const job = jobManager.getJob(jobId);

  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // If job already completed or failed, send that state immediately
  if (job.status === 'completed') {
    res.write(`event: complete\ndata: ${JSON.stringify({ result: job.result })}\n\n`);
    res.end();
    return;
  }
  if (job.status === 'failed') {
    res.write(`event: error\ndata: ${JSON.stringify({ error: job.error })}\n\n`);
    res.end();
    return;
  }

  // Send current progress if available
  if (job.progress) {
    res.write(`event: progress\ndata: ${JSON.stringify(job.progress)}\n\n`);
  }

  // Listen for progress updates
  const onProgress = (progress: { stage: string; percent: number; message: string }) => {
    res.write(`event: progress\ndata: ${JSON.stringify(progress)}\n\n`);
  };

  const onComplete = (result: unknown) => {
    res.write(`event: complete\ndata: ${JSON.stringify({ result })}\n\n`);
    cleanup();
    res.end();
  };

  const onError = (error: string) => {
    res.write(`event: error\ndata: ${JSON.stringify({ error })}\n\n`);
    cleanup();
    res.end();
  };

  const cleanup = () => {
    jobManager.off(`progress:${jobId}`, onProgress);
    jobManager.off(`complete:${jobId}`, onComplete);
    jobManager.off(`error:${jobId}`, onError);
  };

  jobManager.on(`progress:${jobId}`, onProgress);
  jobManager.on(`complete:${jobId}`, onComplete);
  jobManager.on(`error:${jobId}`, onError);

  // Handle client disconnect
  req.on('close', cleanup);
});

// Background analysis function for single video
async function analyzeVideoJob(
  jobId: string,
  videoPath: string,
  originalName: string,
  modelConfig: { model: string; provider: string },
  fps: number
): Promise<void> {
  // Job already created by enqueueJob
  const startTime = Date.now();

  try {
    const options: AnalyzeOptions = {
      output: 'json',
      extractFrames: join(__dirname, '../../frames'),
      model: modelConfig.model,
      verbose: false,
      fps,
      provider: modelConfig.provider as Provider,
      onProgress: (stage, message) => {
        // Map analyzer stages to job manager stages
        const stageMap: Record<string, 'uploading' | 'processing' | 'analyzing' | 'extracting'> = {
          'uploading': 'uploading',
          'extracting-frames': 'processing',
          'analyzing': 'analyzing',
          'saving-frames': 'extracting',
        };
        jobManager.updateProgress(jobId, {
          stage: stageMap[stage] || 'processing',
          percent: 0,
          message,
        });
      },
    };

    // analyzeVideoFile handles upload + AI analysis internally
    const result = await analyzeVideoFile(videoPath, options);

    // Store original filename for display, keep upload path for playback
    result.video = originalName;
    result.videoPath = `/uploads/${basename(videoPath)}`;

    // Extract recording date from video metadata
    const recordedAt = await getVideoRecordingDate(videoPath);
    if (recordedAt) {
      result.recordedAt = recordedAt;
    }

    // Auto-save to history
    await saveAnalysis(result);

    // Merge timing info (analyzeVideoFile may have set detailed timing)
    const totalMs = Date.now() - startTime;
    result.timing = {
      ...result.timing,
      analysisMs: result.timing?.analysisMs ?? 0,
      totalMs,
    };

    jobManager.completeJob(jobId, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Analysis failed';
    jobManager.failJob(jobId, message);
  }
}

// GET /api/videos - List videos in directory
router.get('/videos', async (req: Request, res: Response) => {
  try {
    const dir = req.query.dir as string;
    if (!dir) {
      res.status(400).json({ error: 'Missing dir parameter' });
      return;
    }

    const videos = await getVideosWithMetadata(dir);
    res.json({ videos });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// POST /api/analyze - Start analysis job
router.post('/analyze', async (req: Request, res: Response) => {
  try {
    const { videoPath, model, fps = 1, extractFrames = true } = req.body;

    if (!videoPath) {
      res.status(400).json({ error: 'Missing videoPath' });
      return;
    }

    const modelConfig = MODEL_ALIASES[model || '3-flash'];
    if (!modelConfig) {
      res.status(400).json({ error: `Unknown model: ${model}` });
      return;
    }

    const jobId = uuidv4();
    const job = jobManager.createJob(jobId);

    // Return job ID immediately
    res.json({ jobId, status: 'started' });

    // Run analysis in background
    const options: AnalyzeOptions = {
      output: 'json',
      extractFrames: extractFrames ? join(__dirname, '../../frames') : undefined,
      model: modelConfig.model,
      verbose: true,
      fps: parseFloat(fps) || 1,
      provider: modelConfig.provider as Provider,
    };

    // Update progress during analysis
    jobManager.updateProgress(jobId, {
      stage: 'uploading',
      percent: 10,
      message: 'Preparing video for analysis...',
    });

    try {
      jobManager.updateProgress(jobId, {
        stage: 'analyzing',
        percent: 30,
        message: `Analyzing with ${model || '3-flash'}...`,
      });

      const result = await analyzeVideoFile(videoPath, options);

      jobManager.updateProgress(jobId, {
        stage: 'extracting',
        percent: 90,
        message: 'Saving results...',
      });

      // Auto-save to history
      await saveAnalysis(result);

      jobManager.completeJob(jobId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Analysis failed';
      jobManager.failJob(jobId, message);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// GET /api/analyze/:jobId/result - Get completed result
router.get('/analyze/:jobId/result', (req: Request, res: Response) => {
  const { jobId } = req.params;
  const job = jobManager.getJob(jobId);

  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  if (job.status === 'completed') {
    res.json({ status: 'completed', result: job.result });
  } else if (job.status === 'failed') {
    res.json({ status: 'failed', error: job.error });
  } else {
    res.json({ status: job.status, progress: job.progress });
  }
});

// GET /api/history - List all past analyses
router.get('/history', async (_req: Request, res: Response) => {
  try {
    const analyses = await getHistory();
    res.json({ analyses });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// GET /api/history/species - Aggregated species counts
router.get('/history/species', async (_req: Request, res: Response) => {
  try {
    const species = await getAggregatedSpecies();
    res.json({ species });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// GET /api/history/species/:name/frames - Get all frames for a species
router.get('/history/species/:name/frames', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const history = await getHistory();
    const frames: Array<{ url: string; videoName: string; timestamp: number }> = [];

    for (const analysis of history) {
      const videoName = basename(analysis.video);
      for (const species of analysis.identifiedSpecies) {
        if (species.commonName.toLowerCase() === name.toLowerCase()) {
          if (species.frameFiles) {
            for (const framePath of species.frameFiles) {
              const filename = basename(framePath);
              // Extract timestamp from filename (e.g., GX010167_clownfish_4s.jpg -> 4)
              const match = filename.match(/_(\d+)s\.jpg$/);
              const timestamp = match ? parseInt(match[1], 10) : 0;
              frames.push({
                url: `/frames/${filename}`,
                videoName,
                timestamp,
              });
            }
          }
        }
      }
    }

    res.json({ frames });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// GET /api/history/video/:videoPath - Check if video already analyzed
router.get('/history/video', async (req: Request, res: Response) => {
  try {
    const videoPath = req.query.path as string;
    if (!videoPath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    const history = await getHistory();
    const existing = history.find(a => a.video === videoPath);

    if (existing) {
      res.json({ exists: true, analysis: existing });
    } else {
      res.json({ exists: false });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// GET /api/history/:id - Get specific analysis
router.get('/history/:id', async (req: Request, res: Response) => {
  try {
    const analysis = await getAnalysis(req.params.id);
    if (!analysis) {
      res.status(404).json({ error: 'Analysis not found' });
      return;
    }
    res.json({ analysis });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// DELETE /api/history/:id - Remove analysis
router.delete('/history/:id', async (req: Request, res: Response) => {
  try {
    const deleted = await deleteAnalysis(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Analysis not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// PATCH /api/history/:id/date - Update recording date for an analysis
router.patch('/history/:id/date', async (req: Request, res: Response) => {
  try {
    const { recordedAt } = req.body;
    if (!recordedAt) {
      res.status(400).json({ error: 'Missing recordedAt' });
      return;
    }

    const updated = await updateAnalysisDate(req.params.id, recordedAt);
    if (!updated) {
      res.status(404).json({ error: 'Analysis not found' });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// DELETE /api/history - Clear all history
router.delete('/history', async (_req: Request, res: Response) => {
  try {
    await clearHistory();
    res.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// POST /api/history/deduplicate - Remove duplicate video entries
router.post('/history/deduplicate', async (_req: Request, res: Response) => {
  try {
    const removed = await deduplicateHistory();
    res.json({ success: true, removed });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// GET /api/starred - Get all starred frames
router.get('/starred', async (_req: Request, res: Response) => {
  try {
    const frames = await getStarredFrames();
    res.json({ frames });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// POST /api/starred - Toggle star on a frame
router.post('/starred', async (req: Request, res: Response) => {
  try {
    const { filename, speciesName, videoName, timestamp } = req.body;

    if (!filename) {
      res.status(400).json({ error: 'Missing filename' });
      return;
    }

    const starred = await toggleStarFrame(
      filename,
      speciesName || '',
      videoName || '',
      timestamp || 0
    );

    res.json({ starred });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// DELETE /api/frames/:filename - Delete a frame file
router.delete('/frames/:filename', async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    const { unlink } = await import('node:fs/promises');
    const framePath = join(__dirname, '../../frames', filename);

    await unlink(framePath);
    res.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// GET /api/rotations - Get all frame rotations
router.get('/rotations', async (_req: Request, res: Response) => {
  try {
    const rotations = await getRotations();
    res.json({ rotations });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// POST /api/rotations - Set rotation for a frame
router.post('/rotations', async (req: Request, res: Response) => {
  try {
    const { filename, degrees } = req.body;

    if (!filename || degrees === undefined) {
      res.status(400).json({ error: 'Missing filename or degrees' });
      return;
    }

    await setRotation(filename, degrees);
    res.json({ success: true, degrees });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// GET /api/bounding-boxes - Get all cached bounding boxes
router.get('/bounding-boxes', async (_req: Request, res: Response) => {
  try {
    const boxes = await getAllBoundingBoxes();
    res.json({ boxes });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// POST /api/bounding-boxes/detect/:filename - Detect bounding boxes for a frame
router.post('/bounding-boxes/detect/:filename', async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    const { readFile } = await import('node:fs/promises');

    // Read the frame file
    const framePath = join(__dirname, '../../frames', filename);
    const imageBuffer = await readFile(framePath);
    const imageBase64 = imageBuffer.toString('base64');

    // Parse filename: {videoName}_{speciesName}_{timestamp}s.jpg
    const match = filename.match(/^(.+?)_(.+)_(\d+)s\.jpg$/i);
    let speciesHints: string[] = [];

    if (match) {
      const [, videoName, , timestampStr] = match;
      const timestamp = parseInt(timestampStr, 10);

      // Look up the analysis for this video to find all species at this timestamp
      const history = await getHistory();
      const analysis = history.find(a => basename(a.video).replace(/\.[^.]+$/, '') === videoName);

      if (analysis) {
        // Find all species visible at this timestamp
        speciesHints = analysis.identifiedSpecies
          .filter(s => s.timestamps.some(t => timestamp >= t.start && timestamp <= t.end))
          .map(s => s.commonName);
      }
    }

    // Detect bounding boxes with species hints
    const boxes = await detectBoundingBoxes(imageBase64, speciesHints);

    // Save to storage
    await saveBoundingBoxes(filename, boxes);

    res.json({ boxes });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// ============ BATCH ANALYSIS ENDPOINTS ============

// POST /api/batch/create - Create empty batch for incremental uploads
router.post('/batch/create', (req: Request, res: Response) => {
  try {
    const { model = '3-flash', fps = 1, expectedCount } = req.body;

    const modelConfig = MODEL_ALIASES[model];
    if (!modelConfig) {
      res.status(400).json({ error: `Unknown model: ${model}` });
      return;
    }

    const batch = jobManager.createEmptyBatch(model, parseFloat(fps) || 1, expectedCount);

    // Start the processor (it will wait for videos to be added)
    processIncrementalBatch(batch.batchId, modelConfig);

    res.json({
      batchId: batch.batchId,
      status: 'created',
      model,
      fps: batch.fps,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// POST /api/batch/:batchId/add - Add video to batch
router.post('/batch/:batchId/add', (req: Request, res: Response) => {
  try {
    const { batchId } = req.params;
    const { path: videoPath, originalName } = req.body;

    if (!videoPath) {
      res.status(400).json({ error: 'Missing path' });
      return;
    }

    const batch = jobManager.getBatch(batchId);
    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }

    const added = jobManager.addVideoToBatch(batchId, videoPath, originalName || basename(videoPath));
    if (!added) {
      res.status(400).json({ error: 'Cannot add video to completed or cancelled batch' });
      return;
    }

    res.json({
      success: true,
      queueLength: batch.videoQueue.length,
      total: batch.videos.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// POST /api/batch/:batchId/complete - Mark all uploads as complete
router.post('/batch/:batchId/complete', (req: Request, res: Response) => {
  try {
    const { batchId } = req.params;

    const batch = jobManager.getBatch(batchId);
    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }

    jobManager.markUploadsComplete(batchId);

    res.json({
      success: true,
      total: batch.videos.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// POST /api/batch/analyze - Start batch analysis (legacy - all videos upfront)
router.post('/batch/analyze', async (req: Request, res: Response) => {
  try {
    const { videos, model = '3-flash', fps = 1 } = req.body;

    if (!videos || !Array.isArray(videos) || videos.length === 0) {
      res.status(400).json({ error: 'Missing or empty videos array' });
      return;
    }

    const modelConfig = MODEL_ALIASES[model];
    if (!modelConfig) {
      res.status(400).json({ error: `Unknown model: ${model}` });
      return;
    }

    // Support both old format (string[]) and new format ({path, originalName}[])
    const videoList: Array<{ path: string; originalName: string }> = videos.map(
      (v: string | { path: string; originalName: string }) =>
        typeof v === 'string' ? { path: v, originalName: basename(v) } : v
    );

    // Create batch job with paths
    const batch = jobManager.createBatch(
      videoList.map(v => v.path),
      model,
      parseFloat(fps) || 1
    );

    // Store original names mapping
    const originalNames = new Map(videoList.map(v => [v.path, v.originalName]));

    // Return batch ID immediately
    res.json({ batchId: batch.batchId, status: 'started', totalVideos: videos.length });

    // Process videos in background
    processBatchVideos(batch.batchId, modelConfig, originalNames);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// Background batch processing function
async function processBatchVideos(
  batchId: string,
  modelConfig: { model: string; provider: string },
  originalNames: Map<string, string>
): Promise<void> {
  const batch = jobManager.getBatch(batchId);
  if (!batch) return;

  // Get already-analyzed videos to skip duplicates (check by original name)
  const history = await getHistory();
  const analyzedNames = new Set(history.map(a => basename(a.video)));

  for (const videoPath of batch.videos) {
    // Check if batch was cancelled
    if (jobManager.isBatchCancelled(batchId)) {
      break;
    }

    const originalName = originalNames.get(videoPath) || basename(videoPath);

    // Skip already-analyzed videos (by original name)
    if (analyzedNames.has(originalName)) {
      jobManager.skipBatchVideo(batchId, videoPath, 'Already analyzed');
      continue;
    }

    const jobId = uuidv4();
    jobManager.startBatchVideo(batchId, videoPath, jobId);

    try {
      const options: AnalyzeOptions = {
        output: 'json',
        extractFrames: join(__dirname, '../../frames'),
        model: modelConfig.model,
        verbose: false,
        fps: batch.fps,
        provider: modelConfig.provider as Provider,
      };

      // Update progress
      jobManager.updateBatchVideoProgress(batchId, videoPath, {
        stage: 'uploading',
        percent: 10,
        message: 'Uploading video...',
      });

      jobManager.updateBatchVideoProgress(batchId, videoPath, {
        stage: 'analyzing',
        percent: 30,
        message: 'Analyzing with AI...',
      });

      const result = await analyzeVideoFile(videoPath, options);

      // Store original filename for display, keep upload path for playback
      result.video = originalName;
      result.videoPath = `/uploads/${basename(videoPath)}`;

      // Extract recording date from video metadata
      const recordedAt = await getVideoRecordingDate(videoPath);
      if (recordedAt) {
        result.recordedAt = recordedAt;
      }

      jobManager.updateBatchVideoProgress(batchId, videoPath, {
        stage: 'extracting',
        percent: 90,
        message: 'Saving results...',
      });

      // Auto-save to history
      await saveAnalysis(result);

      jobManager.completeBatchVideo(batchId, videoPath, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Analysis failed';
      jobManager.failBatchVideo(batchId, videoPath, message);
    }
  }

  // Mark batch as complete
  if (!jobManager.isBatchCancelled(batchId)) {
    jobManager.completeBatch(batchId);
  }
}

// Background incremental batch processing function (processes videos as they're added)
async function processIncrementalBatch(
  batchId: string,
  modelConfig: { model: string; provider: string }
): Promise<void> {
  const batch = jobManager.getBatch(batchId);
  if (!batch) return;

  // Get already-analyzed videos to skip duplicates (check by original name)
  const history = await getHistory();
  const analyzedNames = new Set(history.map(a => basename(a.video)));

  // Worker function - each worker pulls from queue and processes
  const worker = async () => {
    while (!jobManager.isBatchCancelled(batchId)) {
      // Get next video from queue
      const nextVideo = jobManager.getNextQueuedVideo(batchId);

      if (!nextVideo) {
        // Queue empty - check if we should wait or finish
        if (jobManager.isBatchDone(batchId)) {
          break; // All uploads complete and queue empty
        }
        // Wait for more videos to be added (poll every 100ms)
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }

      const { path: videoPath, originalName } = nextVideo;

      // Skip already-analyzed videos (by original name)
      if (analyzedNames.has(originalName)) {
        jobManager.skipBatchVideo(batchId, videoPath, 'Already analyzed');
        continue;
      }

      // Mark as being analyzed to prevent other workers from picking it up
      analyzedNames.add(originalName);

      const jobId = uuidv4();
      jobManager.startBatchVideo(batchId, videoPath, jobId);

      try {
        const options: AnalyzeOptions = {
          output: 'json',
          extractFrames: join(__dirname, '../../frames'),
          model: modelConfig.model,
          verbose: false,
          fps: batch.fps,
          provider: modelConfig.provider as Provider,
        };

        // Update progress
        jobManager.updateBatchVideoProgress(batchId, videoPath, {
          stage: 'analyzing',
          percent: 30,
          message: 'Analyzing with AI...',
        });

        const result = await analyzeVideoFile(videoPath, options);

        // Store original filename for display, keep upload path for playback
        result.video = originalName;
        result.videoPath = `/uploads/${basename(videoPath)}`;

        // Extract recording date from video metadata
        const recordedAt = await getVideoRecordingDate(videoPath);
        if (recordedAt) {
          result.recordedAt = recordedAt;
        }

        jobManager.updateBatchVideoProgress(batchId, videoPath, {
          stage: 'extracting',
          percent: 90,
          message: 'Saving results...',
        });

        // Auto-save to history
        await saveAnalysis(result);

        jobManager.completeBatchVideo(batchId, videoPath, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Analysis failed';
        jobManager.failBatchVideo(batchId, videoPath, message);
      }
    }
  };

  // Use single worker for strict FIFO order (videos analyzed in upload order)
  await worker();

  // Mark batch as complete
  if (!jobManager.isBatchCancelled(batchId)) {
    jobManager.completeBatch(batchId);
  }
}

// GET /api/batch/:batchId/progress - SSE progress stream
router.get('/batch/:batchId/progress', (req: Request, res: Response) => {
  const { batchId } = req.params;
  const batch = jobManager.getBatch(batchId);

  if (!batch) {
    res.status(404).json({ error: 'Batch not found' });
    return;
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send current state
  res.write(`event: batch_status\ndata: ${JSON.stringify({
    batchId,
    status: batch.status,
    total: batch.videos.length,
    completed: batch.completed.length,
    failed: batch.failed.length,
    currentIndex: batch.currentIndex,
    uploadsComplete: batch.uploadsComplete,
    queueLength: batch.videoQueue.length,
  })}\n\n`);

  // If already completed or cancelled
  if (batch.status === 'completed') {
    res.write(`event: batch_complete\ndata: ${JSON.stringify({
      completed: batch.completed,
      failed: batch.failed,
      total: batch.videos.length,
    })}\n\n`);
    res.end();
    return;
  }

  if (batch.status === 'cancelled') {
    res.write(`event: batch_cancelled\ndata: ${JSON.stringify({
      completed: batch.completed,
      failed: batch.failed,
      remaining: batch.videos.length - batch.completed.length - batch.failed.length,
    })}\n\n`);
    res.end();
    return;
  }

  // Listen for updates
  const onVideoStart = (data: unknown) => {
    res.write(`event: video_start\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const onVideoProgress = (data: unknown) => {
    res.write(`event: video_progress\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const onBatchProgress = (data: unknown) => {
    res.write(`event: batch_progress\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const onVideoComplete = (data: unknown) => {
    res.write(`event: video_complete\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const onVideoError = (data: unknown) => {
    res.write(`event: video_error\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const onVideoSkipped = (data: unknown) => {
    res.write(`event: video_skipped\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const onVideoAdded = (data: unknown) => {
    res.write(`event: video_added\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const onUploadsComplete = (data: unknown) => {
    res.write(`event: uploads_complete\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const onBatchComplete = (data: unknown) => {
    res.write(`event: batch_complete\ndata: ${JSON.stringify(data)}\n\n`);
    cleanup();
    res.end();
  };

  const onBatchCancelled = (data: unknown) => {
    res.write(`event: batch_cancelled\ndata: ${JSON.stringify(data)}\n\n`);
    cleanup();
    res.end();
  };

  const cleanup = () => {
    jobManager.off(`batch:video_start:${batchId}`, onVideoStart);
    jobManager.off(`batch:video_progress:${batchId}`, onVideoProgress);
    jobManager.off(`batch:progress:${batchId}`, onBatchProgress);
    jobManager.off(`batch:video_complete:${batchId}`, onVideoComplete);
    jobManager.off(`batch:video_error:${batchId}`, onVideoError);
    jobManager.off(`batch:video_skipped:${batchId}`, onVideoSkipped);
    jobManager.off(`batch:video_added:${batchId}`, onVideoAdded);
    jobManager.off(`batch:uploads_complete:${batchId}`, onUploadsComplete);
    jobManager.off(`batch:complete:${batchId}`, onBatchComplete);
    jobManager.off(`batch:cancelled:${batchId}`, onBatchCancelled);
  };

  jobManager.on(`batch:video_start:${batchId}`, onVideoStart);
  jobManager.on(`batch:video_progress:${batchId}`, onVideoProgress);
  jobManager.on(`batch:progress:${batchId}`, onBatchProgress);
  jobManager.on(`batch:video_complete:${batchId}`, onVideoComplete);
  jobManager.on(`batch:video_error:${batchId}`, onVideoError);
  jobManager.on(`batch:video_skipped:${batchId}`, onVideoSkipped);
  jobManager.on(`batch:video_added:${batchId}`, onVideoAdded);
  jobManager.on(`batch:uploads_complete:${batchId}`, onUploadsComplete);
  jobManager.on(`batch:complete:${batchId}`, onBatchComplete);
  jobManager.on(`batch:cancelled:${batchId}`, onBatchCancelled);

  // Cleanup on client disconnect
  req.on('close', cleanup);
});

// GET /api/batch/:batchId - Get batch status
router.get('/batch/:batchId', (req: Request, res: Response) => {
  const { batchId } = req.params;
  const batch = jobManager.getBatch(batchId);

  if (!batch) {
    res.status(404).json({ error: 'Batch not found' });
    return;
  }

  res.json({
    batchId: batch.batchId,
    status: batch.status,
    videos: batch.videos,
    completed: batch.completed,
    failed: batch.failed,
    currentIndex: batch.currentIndex,
    startedAt: batch.startedAt,
    completedAt: batch.completedAt,
  });
});

// DELETE /api/batch/:batchId - Cancel batch
router.delete('/batch/:batchId', (req: Request, res: Response) => {
  const { batchId } = req.params;

  const cancelled = jobManager.cancelBatch(batchId);

  if (cancelled) {
    res.json({ success: true, message: 'Batch cancelled' });
  } else {
    const batch = jobManager.getBatch(batchId);
    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
    } else {
      res.status(400).json({ error: `Cannot cancel batch in ${batch.status} state` });
    }
  }
});

// ============ GEMINI FILE MANAGEMENT ============

// GET /api/gemini/files - List all files stored in Gemini
router.get('/gemini/files', async (_req: Request, res: Response) => {
  try {
    const files = await listFiles();
    const totalBytes = files.reduce((sum, f) => sum + (parseInt(f.sizeBytes || '0', 10) || 0), 0);
    res.json({
      files,
      count: files.length,
      totalBytes,
      totalMB: (totalBytes / (1024 * 1024)).toFixed(2),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// DELETE /api/gemini/files - Delete all files stored in Gemini
router.delete('/gemini/files', async (_req: Request, res: Response) => {
  try {
    const result = await deleteAllFiles();
    res.json({
      success: true,
      deleted: result.deleted,
      failed: result.failed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// ============ THUMBNAIL MIGRATION ============

// POST /api/migrate/thumbnails - Generate thumbnails for existing frames
router.post('/migrate/thumbnails', async (_req: Request, res: Response) => {
  try {
    const { readdir, mkdir, access } = await import('node:fs/promises');
    const { constants } = await import('node:fs');

    const framesDir = join(__dirname, '../../frames');
    const thumbsDir = join(framesDir, 'thumbs');

    // Ensure thumbs directory exists
    await mkdir(thumbsDir, { recursive: true });

    // Get all frame files (excluding thumbs subdirectory)
    const files = await readdir(framesDir);
    const frameFiles = files.filter(f => f.endsWith('.jpg') && !f.startsWith('.'));

    let generated = 0;
    let skipped = 0;
    let failed = 0;

    for (const filename of frameFiles) {
      const thumbPath = join(thumbsDir, filename);

      // Check if thumbnail already exists
      try {
        await access(thumbPath, constants.F_OK);
        skipped++;
        continue;
      } catch {
        // Thumbnail doesn't exist, create it
      }

      try {
        const sourcePath = join(framesDir, filename);
        await createThumbnail(sourcePath, thumbsDir);
        generated++;
      } catch (error) {
        console.error(`Failed to create thumbnail for ${filename}:`, error);
        failed++;
      }
    }

    res.json({
      success: true,
      total: frameFiles.length,
      generated,
      skipped,
      failed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});
