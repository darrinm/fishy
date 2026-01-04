import { stat, readFile, mkdtemp, rm, access } from 'node:fs/promises';
import { basename, join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { glob } from 'glob';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';

const execAsync = promisify(exec);

const SUPPORTED_EXTENSIONS = [
  '.mp4', '.mpeg', '.mov', '.avi', '.flv', '.mpg', '.webm', '.wmv', '.3gp'
];

export async function isVideoFile(filePath: string): Promise<boolean> {
  const ext = extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(ext);
}

export async function getVideoFiles(inputPath: string): Promise<string[]> {
  const stats = await stat(inputPath);

  if (stats.isFile()) {
    if (await isVideoFile(inputPath)) {
      return [inputPath];
    }
    throw new Error(`Not a supported video file: ${inputPath}`);
  }

  if (stats.isDirectory()) {
    const patterns = SUPPORTED_EXTENSIONS.map(ext => join(inputPath, `**/*${ext}`));
    const files: string[] = [];

    for (const pattern of patterns) {
      const matches = await glob(pattern, { nocase: true });
      files.push(...matches);
    }

    if (files.length === 0) {
      throw new Error(`No video files found in directory: ${inputPath}`);
    }

    return files.sort();
  }

  throw new Error(`Invalid path: ${inputPath}`);
}

export interface VideoMetadata {
  path: string;
  name: string;
  size: number;       // bytes
  duration: number;   // seconds
}

export async function getVideoMetadata(videoPath: string): Promise<VideoMetadata> {
  const stats = await stat(videoPath);
  let duration = 0;

  try {
    // Use ffprobe to get duration
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
      { timeout: 10000 }
    );
    duration = parseFloat(stdout.trim()) || 0;
  } catch {
    // ffprobe failed, duration will be 0
  }

  return {
    path: videoPath,
    name: basename(videoPath),
    size: stats.size,
    duration,
  };
}

export async function getVideosWithMetadata(inputPath: string): Promise<VideoMetadata[]> {
  const videos = await getVideoFiles(inputPath);
  return Promise.all(videos.map(getVideoMetadata));
}

export async function extractFrame(
  videoPath: string,
  timestampSeconds: number,
  outputDir: string,
  speciesName: string
): Promise<string> {
  const sanitizedName = speciesName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const videoName = basename(videoPath, extname(videoPath));
  const outputFile = join(
    outputDir,
    `${videoName}_${sanitizedName}_${Math.floor(timestampSeconds)}s.jpg`
  );

  try {
    await execAsync(
      `ffmpeg -ss ${timestampSeconds} -i "${videoPath}" -frames:v 1 -q:v 2 "${outputFile}" -y 2>/dev/null`,
      { timeout: 30000 }
    );
    // Verify the file was actually created (ffmpeg may silently fail for timestamps past video end)
    await access(outputFile, constants.F_OK);
    return outputFile;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    // Check if it's ffmpeg not being installed vs frame extraction failure
    if (message.includes('command not found') || message.includes('ffmpeg')) {
      throw new Error(
        'ffmpeg is required for frame extraction.\n' +
        'Install it with: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)'
      );
    }
    // Frame extraction failed (likely timestamp past video end)
    throw new Error(`Failed to extract frame at ${timestampSeconds}s`);
  }
}

export async function checkFfmpeg(): Promise<boolean> {
  try {
    await execAsync('ffmpeg -version');
    return true;
  } catch {
    return false;
  }
}

export async function getVideoDuration(videoPath: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
      { timeout: 30000 }
    );
    return parseFloat(stdout.trim());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('not found') || message.includes('ENOENT')) {
      throw new Error(
        'ffprobe (part of ffmpeg) is required.\n' +
        'Install it with: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)'
      );
    }
    throw new Error(`Failed to get video duration: ${message}`);
  }
}

export async function createThumbnail(
  sourcePath: string,
  thumbsDir: string
): Promise<string> {
  const filename = basename(sourcePath);
  const thumbPath = join(thumbsDir, filename);

  // Create 500x300 thumbnail (2x of 250x150 display size for retina)
  await execAsync(
    `ffmpeg -i "${sourcePath}" -vf "scale=500:300:force_original_aspect_ratio=increase,crop=500:300" -q:v 3 "${thumbPath}" -y 2>/dev/null`,
    { timeout: 10000 }
  );

  return thumbPath;
}

export async function extractFramesAsBase64(
  videoPath: string,
  fps: number,
  verbose: boolean = false
): Promise<{ frames: string[]; duration: number }> {
  const hasFfmpeg = await checkFfmpeg();
  if (!hasFfmpeg) {
    throw new Error(
      'ffmpeg is required for GPT-5 video analysis.\n' +
      'Install it with: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)'
    );
  }

  // Get video duration
  const duration = await getVideoDuration(videoPath);
  const expectedFrames = Math.ceil(duration * fps);

  if (verbose) {
    console.log(`Extracting frames at ${fps} FPS (~${expectedFrames} frames from ${duration.toFixed(1)}s video)`);
  }

  // Create temp directory for frames
  const tempDir = await mkdtemp(join(tmpdir(), 'fish-finder-'));

  try {
    const startTime = Date.now();

    // Extract frames using ffmpeg
    await execAsync(
      `ffmpeg -i "${videoPath}" -vf "fps=${fps}" -q:v 2 "${join(tempDir, 'frame_%04d.jpg')}" -y`,
      { timeout: 120000 }
    );

    // Read all frame files
    const frameFiles = await glob(join(tempDir, 'frame_*.jpg'));
    frameFiles.sort();

    if (verbose) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`Extracted ${frameFiles.length} frames in ${elapsed}s`);
    }

    // Convert to base64
    const frames: string[] = [];
    for (const framePath of frameFiles) {
      const buffer = await readFile(framePath);
      frames.push(buffer.toString('base64'));
    }

    return { frames, duration };
  } finally {
    // Cleanup temp directory
    await rm(tempDir, { recursive: true, force: true });
  }
}
