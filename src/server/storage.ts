import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import type { FishFinderResult, BoundingBox } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../data');
const UPLOADS_DIR = join(DATA_DIR, 'uploads');
const FRAMES_DIR = join(__dirname, '../../frames');
const HISTORY_FILE = join(DATA_DIR, 'history.json');
const STARRED_FILE = join(DATA_DIR, 'starred.json');
const ROTATIONS_FILE = join(DATA_DIR, 'rotations.json');
const BOUNDING_BOXES_FILE = join(DATA_DIR, 'bounding-boxes.json');

export interface StoredAnalysis extends FishFinderResult {
  id: string;
}

interface HistoryData {
  analyses: StoredAnalysis[];
}

async function ensureDataDir(): Promise<void> {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

async function readHistory(): Promise<HistoryData> {
  await ensureDataDir();

  if (!existsSync(HISTORY_FILE)) {
    return { analyses: [] };
  }

  try {
    const content = await readFile(HISTORY_FILE, 'utf-8');
    return JSON.parse(content) as HistoryData;
  } catch {
    return { analyses: [] };
  }
}

async function writeHistory(data: HistoryData): Promise<void> {
  await ensureDataDir();
  await writeFile(HISTORY_FILE, JSON.stringify(data, null, 2));
}

export async function saveAnalysis(result: FishFinderResult): Promise<StoredAnalysis> {
  const history = await readHistory();

  const stored: StoredAnalysis = {
    ...result,
    id: uuidv4(),
  };

  history.analyses.unshift(stored); // Add to beginning (most recent first)
  await writeHistory(history);

  return stored;
}

export async function getHistory(): Promise<StoredAnalysis[]> {
  const history = await readHistory();
  return history.analyses;
}

export async function getAnalysis(id: string): Promise<StoredAnalysis | null> {
  const history = await readHistory();
  return history.analyses.find(a => a.id === id) || null;
}

export async function deleteAnalysis(id: string): Promise<boolean> {
  const history = await readHistory();
  const index = history.analyses.findIndex(a => a.id === id);

  if (index === -1) {
    return false;
  }

  const analysis = history.analyses[index];

  // Collect all frame filenames from this analysis
  const frameFilenames: string[] = [];
  for (const species of analysis.identifiedSpecies) {
    if (species.frameFiles) {
      for (const framePath of species.frameFiles) {
        frameFilenames.push(basename(framePath));
      }
    }
  }

  // Delete starred frames that match
  const starred = await readStarred();
  starred.frames = starred.frames.filter(f => !frameFilenames.includes(f.filename));
  await writeStarred(starred);

  // Delete rotations for matching frames
  const rotations = await readRotations();
  for (const filename of frameFilenames) {
    delete rotations.rotations[filename];
  }
  await writeRotations(rotations);

  // Delete bounding boxes for matching frames
  const boundingBoxes = await readBoundingBoxes();
  for (const filename of frameFilenames) {
    delete boundingBoxes.boxes[filename];
  }
  await writeBoundingBoxes(boundingBoxes);

  // Delete the video file if it exists
  if (analysis.videoPath) {
    const videoFilename = basename(analysis.videoPath);
    const videoPath = join(UPLOADS_DIR, videoFilename);
    try {
      await unlink(videoPath);
    } catch {
      // File may not exist, ignore
    }
  }

  // Delete frame files
  for (const filename of frameFilenames) {
    const framePath = join(FRAMES_DIR, filename);
    try {
      await unlink(framePath);
    } catch {
      // File may not exist, ignore
    }
  }

  // Remove from history
  history.analyses.splice(index, 1);
  await writeHistory(history);
  return true;
}

export async function clearHistory(): Promise<void> {
  await writeHistory({ analyses: [] });
}

export async function deduplicateHistory(): Promise<number> {
  const history = await readHistory();
  const seen = new Set<string>();
  const deduplicated: StoredAnalysis[] = [];

  // Sort by date descending to keep most recent
  const sorted = [...history.analyses].sort((a, b) =>
    new Date(b.analyzedAt).getTime() - new Date(a.analyzedAt).getTime()
  );

  for (const analysis of sorted) {
    if (!seen.has(analysis.video)) {
      seen.add(analysis.video);
      deduplicated.push(analysis);
    }
  }

  const removedCount = history.analyses.length - deduplicated.length;
  if (removedCount > 0) {
    await writeHistory({ analyses: deduplicated });
  }
  return removedCount;
}

export interface SpeciesCount {
  commonName: string;
  scientificName: string;
  count: number;
  videoCount: number;
}

export async function getAggregatedSpecies(): Promise<SpeciesCount[]> {
  const history = await readHistory();
  const speciesMap = new Map<string, SpeciesCount>();

  for (const analysis of history.analyses) {
    const seenInVideo = new Set<string>();

    for (const species of analysis.identifiedSpecies) {
      // Normalize key to lowercase for case-insensitive matching
      const key = species.commonName.toLowerCase().trim();

      if (!speciesMap.has(key)) {
        speciesMap.set(key, {
          commonName: species.commonName,
          scientificName: species.scientificName,
          count: 0,
          videoCount: 0,
        });
      }

      const entry = speciesMap.get(key)!;
      entry.count++;

      if (!seenInVideo.has(key)) {
        entry.videoCount++;
        seenInVideo.add(key);
      }
    }
  }

  // Sort by count descending
  return Array.from(speciesMap.values()).sort((a, b) => b.count - a.count);
}

// Starred frames
export interface StarredFrame {
  filename: string;
  speciesName: string;
  videoName: string;
  timestamp: number;
  starredAt: string;
}

interface StarredData {
  frames: StarredFrame[];
}

async function readStarred(): Promise<StarredData> {
  await ensureDataDir();

  if (!existsSync(STARRED_FILE)) {
    return { frames: [] };
  }

  try {
    const content = await readFile(STARRED_FILE, 'utf-8');
    return JSON.parse(content) as StarredData;
  } catch {
    return { frames: [] };
  }
}

async function writeStarred(data: StarredData): Promise<void> {
  await ensureDataDir();
  await writeFile(STARRED_FILE, JSON.stringify(data, null, 2));
}

export async function getStarredFrames(): Promise<StarredFrame[]> {
  const data = await readStarred();
  return data.frames;
}

export async function isFrameStarred(filename: string): Promise<boolean> {
  const data = await readStarred();
  return data.frames.some(f => f.filename === filename);
}

export async function toggleStarFrame(
  filename: string,
  speciesName: string,
  videoName: string,
  timestamp: number
): Promise<boolean> {
  const data = await readStarred();
  const index = data.frames.findIndex(f => f.filename === filename);

  if (index >= 0) {
    // Unstar
    data.frames.splice(index, 1);
    await writeStarred(data);
    return false;
  } else {
    // Star
    data.frames.unshift({
      filename,
      speciesName,
      videoName,
      timestamp,
      starredAt: new Date().toISOString(),
    });
    await writeStarred(data);
    return true;
  }
}

// Frame rotations
interface RotationsData {
  rotations: Record<string, number>;
}

async function readRotations(): Promise<RotationsData> {
  await ensureDataDir();

  if (!existsSync(ROTATIONS_FILE)) {
    return { rotations: {} };
  }

  try {
    const content = await readFile(ROTATIONS_FILE, 'utf-8');
    return JSON.parse(content) as RotationsData;
  } catch {
    return { rotations: {} };
  }
}

async function writeRotations(data: RotationsData): Promise<void> {
  await ensureDataDir();
  await writeFile(ROTATIONS_FILE, JSON.stringify(data, null, 2));
}

export async function getRotations(): Promise<Record<string, number>> {
  const data = await readRotations();
  return data.rotations;
}

export async function setRotation(filename: string, degrees: number): Promise<void> {
  const data = await readRotations();
  if (degrees === 0) {
    delete data.rotations[filename];
  } else {
    data.rotations[filename] = degrees;
  }
  await writeRotations(data);
}

// Bounding boxes
interface BoundingBoxesData {
  boxes: Record<string, BoundingBox[]>;
}

async function readBoundingBoxes(): Promise<BoundingBoxesData> {
  await ensureDataDir();

  if (!existsSync(BOUNDING_BOXES_FILE)) {
    return { boxes: {} };
  }

  try {
    const content = await readFile(BOUNDING_BOXES_FILE, 'utf-8');
    return JSON.parse(content) as BoundingBoxesData;
  } catch {
    return { boxes: {} };
  }
}

async function writeBoundingBoxes(data: BoundingBoxesData): Promise<void> {
  await ensureDataDir();
  await writeFile(BOUNDING_BOXES_FILE, JSON.stringify(data, null, 2));
}

export async function getAllBoundingBoxes(): Promise<Record<string, BoundingBox[]>> {
  const data = await readBoundingBoxes();
  return data.boxes;
}

export async function getBoundingBoxes(filename: string): Promise<BoundingBox[]> {
  const data = await readBoundingBoxes();
  return data.boxes[filename] || [];
}

export async function saveBoundingBoxes(filename: string, boxes: BoundingBox[]): Promise<void> {
  const data = await readBoundingBoxes();
  data.boxes[filename] = boxes;
  await writeBoundingBoxes(data);
}
