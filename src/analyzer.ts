import { mkdir } from 'node:fs/promises';
import { uploadVideo, analyzeVideo, deleteFile } from './gemini.js';
import { analyzeWithOpenAI } from './openai.js';
import { extractFrame, extractFramesAsBase64, checkFfmpeg, getVideoDuration } from './video.js';
import { join } from 'node:path';
import type { FishFinderResult, IdentifiedSpecies, AnalyzeOptions, GeminiAnalysisResponse, AnalysisTiming, AnalysisStage } from './types.js';

interface AnalysisWithTiming {
  analysis: GeminiAnalysisResponse;
  timing: Partial<AnalysisTiming>;
}

export async function analyzeVideoFile(
  videoPath: string,
  options: AnalyzeOptions
): Promise<FishFinderResult> {
  const { provider, onProgress } = options;
  const totalStart = Date.now();

  // Route to appropriate provider
  const { analysis, timing } = provider === 'openai'
    ? await analyzeWithOpenAIProvider(videoPath, options, onProgress)
    : await analyzeWithGeminiProvider(videoPath, options, onProgress);

  // Transform response to our format
  const identifiedSpecies: IdentifiedSpecies[] = analysis.species.map(s => ({
    commonName: s.common_name,
    scientificName: s.scientific_name,
    confidence: s.confidence,
    timestamps: s.timestamps,
    habitat: s.habitat,
    description: s.description,
  }));

  // Extract frames if requested
  let frameExtractionMs: number | undefined;
  if (options.extractFrames && identifiedSpecies.length > 0) {
    onProgress?.('saving-frames', 'Extracting frames');
    const frameStart = Date.now();
    await extractSpeciesFrames(videoPath, identifiedSpecies, options);
    frameExtractionMs = Date.now() - frameStart;
  }

  const totalMs = Date.now() - totalStart;

  return {
    video: videoPath,
    duration: analysis.video_duration_seconds,
    identifiedSpecies,
    summary: analysis.summary,
    analyzedAt: new Date().toISOString(),
    timing: {
      ...timing,
      frameExtractionMs,
      totalMs,
    } as AnalysisTiming,
  };
}

async function analyzeWithGeminiProvider(
  videoPath: string,
  options: AnalyzeOptions,
  onProgress?: (stage: AnalysisStage, message: string) => void
): Promise<AnalysisWithTiming> {
  const { model, verbose, fps } = options;

  // Get actual video duration for validation
  const actualDuration = await getVideoDuration(videoPath);

  // Upload video to Gemini
  onProgress?.('uploading', 'Uploading to AI');
  const uploadStart = Date.now();
  const { uri, mimeType, fileName } = await uploadVideo(videoPath, verbose);
  const uploadMs = Date.now() - uploadStart;

  // Analyze with Gemini
  onProgress?.('analyzing', 'Analyzing');
  const analysisStart = Date.now();
  let analysis: GeminiAnalysisResponse;
  try {
    analysis = await analyzeVideo(uri, mimeType, model, verbose, fps);
  } finally {
    // Always clean up the uploaded file from Gemini to free quota
    if (verbose) {
      console.log('Cleaning up uploaded file from Gemini...');
    }
    await deleteFile(fileName);
  }
  const analysisMs = Date.now() - analysisStart;

  // Validate duration - detect hallucinated results
  const reportedDuration = analysis.video_duration_seconds;
  if (actualDuration > 0 && Math.abs(reportedDuration - actualDuration) > actualDuration * 0.5) {
    console.warn(`Duration mismatch: Gemini reported ${reportedDuration}s but video is ${actualDuration.toFixed(1)}s`);
    // Override with actual duration
    analysis.video_duration_seconds = actualDuration;
    // If reported duration is way off, likely hallucinated - return empty results
    if (reportedDuration > actualDuration * 3 || reportedDuration < actualDuration * 0.3) {
      console.error(`Gemini hallucination detected - clearing invalid results`, {
        video: videoPath,
        actualDuration: actualDuration.toFixed(1),
        reportedDuration,
        speciesCount: analysis.species.length,
        species: analysis.species.map(s => s.common_name),
        summary: analysis.summary,
      });
      analysis.species = [];
      analysis.summary = 'Analysis failed: AI returned invalid results for this video.';
    }
  }

  return {
    analysis,
    timing: { uploadMs, analysisMs },
  };
}

async function analyzeWithOpenAIProvider(
  videoPath: string,
  options: AnalyzeOptions,
  onProgress?: (stage: AnalysisStage, message: string) => void
): Promise<AnalysisWithTiming> {
  const { model, verbose, fps = 1 } = options;

  // Extract frames locally
  onProgress?.('extracting-frames', 'Extracting frames');
  const extractStart = Date.now();
  const { frames, duration } = await extractFramesAsBase64(videoPath, fps, verbose);
  const extractFramesMs = Date.now() - extractStart;

  // Analyze with OpenAI
  onProgress?.('analyzing', 'Analyzing');
  const analysisStart = Date.now();
  const analysis = await analyzeWithOpenAI(frames, model, verbose, duration);
  const analysisMs = Date.now() - analysisStart;

  return {
    analysis,
    timing: { extractFramesMs, analysisMs },
  };
}

async function extractSpeciesFrames(
  videoPath: string,
  identifiedSpecies: IdentifiedSpecies[],
  options: AnalyzeOptions
): Promise<void> {
  const { extractFrames, verbose } = options;
  if (!extractFrames) return;

  const hasFfmpeg = await checkFfmpeg();
  if (!hasFfmpeg) {
    console.warn(
      'Warning: ffmpeg not found, skipping frame extraction.\n' +
      'Install with: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)'
    );
    return;
  }

  await mkdir(extractFrames, { recursive: true });

  // Create thumbs subdirectory for thumbnails
  const thumbsDir = join(extractFrames, 'thumbs');
  await mkdir(thumbsDir, { recursive: true });

  // Collect all unique timestamps needed across all species
  const timestampToSpecies = new Map<number, IdentifiedSpecies[]>();
  for (const species of identifiedSpecies) {
    for (const interval of species.timestamps) {
      const start = Math.floor(interval.start);
      const end = Math.floor(interval.end);
      for (let sec = start; sec <= end; sec++) {
        if (!timestampToSpecies.has(sec)) {
          timestampToSpecies.set(sec, []);
        }
        timestampToSpecies.get(sec)!.push(species);
      }
    }
  }

  // Extract each unique timestamp once, assign to all species that need it
  const extractedFrames = new Map<number, string>();

  for (const [sec, speciesList] of timestampToSpecies) {
    // Use first species name for filename (arbitrary but consistent)
    const primarySpecies = speciesList[0];
    try {
      const framePath = await extractFrame(
        videoPath,
        sec,
        extractFrames,
        primarySpecies.commonName,
        thumbsDir
      );
      extractedFrames.set(sec, framePath);
    } catch (error) {
      if (verbose) {
        console.warn(`Failed to extract frame at ${sec}s:`, error);
      }
    }
  }

  // Assign extracted frames to each species
  for (const species of identifiedSpecies) {
    const frameFiles: string[] = [];
    for (const interval of species.timestamps) {
      const start = Math.floor(interval.start);
      const end = Math.floor(interval.end);
      for (let sec = start; sec <= end; sec++) {
        const framePath = extractedFrames.get(sec);
        if (framePath) {
          frameFiles.push(framePath);
        }
      }
    }
    if (frameFiles.length > 0) {
      species.frameFiles = frameFiles;
      if (verbose) {
        console.log(`Assigned ${frameFiles.length} frames to ${species.commonName}`);
      }
    }
  }
}
