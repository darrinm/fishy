import { GoogleGenAI } from '@google/genai';
import { stat } from 'node:fs/promises';
import type { GeminiAnalysisResponse, BoundingBox } from './types.js';

let client: GoogleGenAI | null = null;

export function getClient(): GoogleGenAI {
  if (client) return client;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY environment variable is required.\n' +
      'Get your API key at: https://aistudio.google.com/apikey'
    );
  }

  client = new GoogleGenAI({ apiKey });
  return client;
}

export async function uploadVideo(
  filePath: string,
  verbose: boolean = false
): Promise<{ uri: string; mimeType: string; fileName: string }> {
  const ai = getClient();

  // Get file size for progress info
  const fileStats = await stat(filePath);
  const sizeMB = (fileStats.size / (1024 * 1024)).toFixed(1);

  if (verbose) {
    console.log(`Uploading video: ${filePath} (${sizeMB} MB)`);
  }

  // Start upload with elapsed time tracking
  const startTime = Date.now();
  let progressInterval: NodeJS.Timeout | undefined;

  if (verbose) {
    progressInterval = setInterval(() => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      process.stdout.write(`\r  Uploading... ${elapsed}s elapsed`);
    }, 1000);
  }

  try {
    const file = await ai.files.upload({
      file: filePath,
      config: { mimeType: getMimeType(filePath) },
    });

    if (progressInterval) {
      clearInterval(progressInterval);
      process.stdout.write('\n');
    }

    if (!file.uri || !file.mimeType || !file.name) {
      throw new Error('Failed to upload video - no URI returned');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (verbose) {
      console.log(`Upload complete in ${elapsed}s: ${file.uri}`);
      console.log('Waiting for video processing...');
    }

    // Poll until file is ACTIVE
    const processedFile = await waitForFileActive(file.name, verbose);

    return { uri: processedFile.uri!, mimeType: processedFile.mimeType!, fileName: file.name };
  } catch (error) {
    if (progressInterval) {
      clearInterval(progressInterval);
      process.stdout.write('\n');
    }
    throw error;
  }
}

async function waitForFileActive(
  fileName: string,
  verbose: boolean = false
): Promise<{ uri?: string; mimeType?: string; state?: string }> {
  const ai = getClient();
  const maxAttempts = 60; // 5 minutes max
  const pollInterval = 5000; // 5 seconds

  const startTime = Date.now();
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const file = await ai.files.get({ name: fileName });
    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    if (verbose && attempt > 0) {
      console.log(`  Status: ${file.state} (${elapsed}s)`);
    }

    if (file.state === 'ACTIVE') {
      if (verbose) {
        console.log('Video processing complete!');
      }
      return file;
    }

    if (file.state === 'FAILED') {
      throw new Error('Video processing failed on Google servers');
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  throw new Error('Timeout waiting for video processing');
}

export async function analyzeVideo(
  fileUri: string,
  mimeType: string,
  model: string,
  verbose: boolean = false,
  fps: number = 1
): Promise<GeminiAnalysisResponse> {
  const ai = getClient();

  const prompt = `You are an expert marine biologist analyzing a diving video. Identify all marine species visible in this video, including fish, invertebrates (lobsters, crabs, shrimp, octopus, nudibranchs, sea slugs, jellyfish, anemones, sea stars, urchins), marine mammals, sea turtles, and any other identifiable marine life.

For each species you identify, provide:
1. Common name
2. Scientific name
3. Confidence level (0.0 to 1.0)
4. Timestamps (in seconds) when the species appears
5. Typical habitat description
6. Brief description of the species' appearance

Respond ONLY with valid JSON in this exact format:
{
  "species": [
    {
      "common_name": "Clownfish",
      "scientific_name": "Amphiprion ocellaris",
      "confidence": 0.95,
      "timestamps": [{"start": 12, "end": 18}, {"start": 45, "end": 52}],
      "habitat": "Coral reefs in the Indo-Pacific region, typically found among sea anemones",
      "description": "Orange body with three white vertical bands outlined in black"
    }
  ],
  "summary": "Brief summary of all marine life observed in the video",
  "video_duration_seconds": 120
}

If no marine life is visible, return an empty species array. Be thorough but only identify species you can see clearly.`;

  if (verbose) {
    console.log(`Analyzing video with model: ${model} at ${fps} FPS`);
  }

  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [
          {
            fileData: {
              fileUri,
              mimeType,
            },
            videoMetadata: {
              fps,
            },
          } as any,
          { text: prompt },
        ],
      },
    ],
  });

  const text = response.text;
  if (!text) {
    throw new Error('No response from Gemini');
  }

  // Extract JSON from response (handle potential markdown code blocks)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Could not parse JSON response from Gemini');
  }

  try {
    return JSON.parse(jsonMatch[0]) as GeminiAnalysisResponse;
  } catch {
    throw new Error(`Invalid JSON in Gemini response: ${text}`);
  }
}

function getMimeType(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop();
  const mimeTypes: Record<string, string> = {
    mp4: 'video/mp4',
    mpeg: 'video/mpeg',
    mov: 'video/mov',
    avi: 'video/avi',
    flv: 'video/x-flv',
    mpg: 'video/mpg',
    webm: 'video/webm',
    wmv: 'video/wmv',
    '3gp': 'video/3gpp',
  };

  return mimeTypes[ext || ''] || 'video/mp4';
}

// File management functions

export interface GeminiFile {
  name: string;
  displayName?: string;
  mimeType?: string;
  sizeBytes?: string;
  createTime?: string;
  expirationTime?: string;
  state?: string;
  uri?: string;
}

export async function listFiles(): Promise<GeminiFile[]> {
  const ai = getClient();
  const files: GeminiFile[] = [];

  try {
    const response = await ai.files.list();
    for await (const file of response) {
      files.push(file as GeminiFile);
    }
  } catch (error) {
    console.error('Failed to list Gemini files:', error);
  }

  return files;
}

export async function deleteFile(fileName: string): Promise<boolean> {
  const ai = getClient();

  try {
    await ai.files.delete({ name: fileName });
    return true;
  } catch (error) {
    console.error(`Failed to delete Gemini file ${fileName}:`, error);
    return false;
  }
}

export async function deleteAllFiles(): Promise<{ deleted: number; failed: number }> {
  const files = await listFiles();
  let deleted = 0;
  let failed = 0;

  for (const file of files) {
    if (file.name) {
      const success = await deleteFile(file.name);
      if (success) {
        deleted++;
      } else {
        failed++;
      }
    }
  }

  return { deleted, failed };
}

export async function detectBoundingBoxes(
  imageBase64: string,
  speciesHints: string[] = [],
  model: string = 'gemini-2.0-flash'
): Promise<BoundingBox[]> {
  const ai = getClient();

  // Build context about known species in this frame
  const speciesContext = speciesHints.length > 0
    ? `\n\nKnown species in this frame from prior analysis: ${speciesHints.join(', ')}. Use these exact names when you detect them.`
    : '';

  const prompt = `You are an expert marine biologist. Identify and locate all individual fish and marine creatures in this underwater image.

For EACH individual animal visible, provide:
1. Its specific species common name (e.g., "Yellowtail Damselfish", "Moorish Idol", "Powder Blue Tang") - NOT generic terms like "fish" or "coral"
2. A bounding box around that individual
3. Your confidence in the species identification${speciesContext}

Respond ONLY with valid JSON:
{
  "detections": [
    { "label": "Clownfish", "box_2d": [ymin, xmin, ymax, xmax], "confidence": 0.95 },
    { "label": "Magnificent Sea Anemone", "box_2d": [ymin, xmin, ymax, xmax], "confidence": 0.85 }
  ]
}

Rules:
- Use specific species names, not generic categories like "fish" or "coral"
- If you can only identify to genus level, use that (e.g., "Dascyllus sp.")
- box_2d coordinates are normalized 0-1000
- confidence is 0.0-1.0 for species identification certainty
- Return { "detections": [] } if no marine life visible`;

  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: 'image/jpeg',
              data: imageBase64,
            },
          },
          { text: prompt },
        ],
      },
    ],
  });

  const text = response.text;
  if (!text) {
    return [];
  }

  // Extract JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return [];
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      detections: Array<{
        label?: string;
        box_2d: number[];
        confidence?: number;
      }>;
    };

    // Convert 0-1000 coordinates to 0-1 normalized
    return parsed.detections.map(det => ({
      ymin: det.box_2d[0] / 1000,
      xmin: det.box_2d[1] / 1000,
      ymax: det.box_2d[2] / 1000,
      xmax: det.box_2d[3] / 1000,
      confidence: det.confidence,
      label: det.label,
    }));
  } catch {
    return [];
  }
}
