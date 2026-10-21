#!/usr/bin/env node

import 'dotenv/config';
import './tls-distrust.js';
import { Command } from 'commander';
import { getVideoFiles } from './video.js';
import { analyzeVideoFile } from './analyzer.js';
import { formatJson, formatText, formatBatchSummary } from './output.js';
import { resolveModel } from './models.js';
import type { AnalyzeOptions, FishFinderResult } from './types.js';

const program = new Command();

program
  .name('fish-finder')
  .description('Identify fish species in diving videos using Google Gemini AI')
  .version('1.0.0');

program
  .command('analyze')
  .description('Analyze video file(s) to identify fish species')
  .argument('<path>', 'Video file or directory to analyze')
  .option('-o, --output <format>', 'Output format: json or text', 'json')
  .option('-e, --extract-frames <dir>', 'Extract frames of identified fish to directory')
  .option('-m, --model <model>', 'Model: 3-flash, 3-pro, 2.5-flash, 2.5-pro, gpt-5, gpt-5-mini', '3-flash')
  .option('-f, --fps <number>', 'Frames per second to analyze (default: 1, max: 60)', '1')
  .option('-v, --verbose', 'Show detailed progress', false)
  .action(async (inputPath: string, opts) => {
    const { model, provider } = resolveModel(opts.model);
    const fps = parseFloat(opts.fps);
    if (isNaN(fps) || fps <= 0 || fps > 60) {
      console.error('Error: --fps must be a number between 0.1 and 60');
      process.exit(1);
    }
    const options: AnalyzeOptions = {
      output: opts.output as 'json' | 'text',
      extractFrames: opts.extractFrames,
      model,
      verbose: opts.verbose,
      fps,
      provider,
    };

    try {
      const videos = await getVideoFiles(inputPath);
      const results: FishFinderResult[] = [];

      for (let i = 0; i < videos.length; i++) {
        const video = videos[i];

        if (videos.length > 1) {
          console.error(`\nProcessing [${i + 1}/${videos.length}]: ${video}`);
        } else if (options.verbose) {
          console.error(`Processing: ${video}`);
        }

        const result = await analyzeVideoFile(video, options);
        results.push(result);

        // Output each result
        if (options.output === 'json') {
          console.log(formatJson(result));
        } else {
          console.log(formatText(result));
        }
      }

      // Batch summary for multiple videos
      if (results.length > 1 && options.output === 'text') {
        console.log(formatBatchSummary(results));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program.parse();
