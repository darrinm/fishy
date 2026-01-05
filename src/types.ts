export interface Timestamp {
  start: number;
  end: number;
}

export interface IdentifiedSpecies {
  commonName: string;
  scientificName: string;
  confidence: number;
  timestamps: Timestamp[];
  habitat: string;
  description: string;
  frameFiles?: string[];
}

export interface AnalysisTiming {
  uploadMs?: number;      // Time to upload video to LLM (Gemini only)
  extractFramesMs?: number; // Time to extract frames locally (OpenAI only)
  analysisMs: number;     // Time for LLM analysis
  frameExtractionMs?: number; // Time to extract result frames
  totalMs: number;        // Total time
}

export interface FishFinderResult {
  video: string;
  videoPath?: string;  // Path to uploaded video file for playback
  duration: number;
  identifiedSpecies: IdentifiedSpecies[];
  summary: string;
  analyzedAt: string;
  recordedAt?: string;  // Video recording datetime from camera metadata
  timing?: AnalysisTiming;
}

export type Provider = 'gemini' | 'openai';

export type AnalysisStage = 'uploading' | 'extracting-frames' | 'analyzing' | 'saving-frames';

export interface AnalyzeOptions {
  output: 'json' | 'text';
  extractFrames?: string;
  model: string;
  verbose: boolean;
  fps?: number;
  provider: Provider;
  onProgress?: (stage: AnalysisStage, message: string) => void;
}

export interface GeminiAnalysisResponse {
  species: Array<{
    common_name: string;
    scientific_name: string;
    confidence: number;
    timestamps: Array<{ start: number; end: number }>;
    habitat: string;
    description: string;
  }>;
  summary: string;
  video_duration_seconds: number;
}

export interface BoundingBox {
  ymin: number;  // 0-1 normalized
  xmin: number;
  ymax: number;
  xmax: number;
  confidence?: number;  // 0-1
  label?: string;       // species name
}
