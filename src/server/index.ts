import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { router as apiRouter } from './api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.json());

// API routes (before static files)
app.use('/api', apiRouter);

// Serve extracted frames
const framesDir = join(__dirname, '../../frames');
app.use('/frames', express.static(framesDir));

// Serve uploaded videos for playback
const uploadsDir = join(__dirname, '../../data/uploads');
app.use('/uploads', express.static(uploadsDir));

// Serve static files from web directory
const webDir = join(__dirname, '../../web');
app.use(express.static(webDir));

// Fallback to index.html for SPA routing
app.get('*', (_req, res) => {
  res.sendFile(join(webDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Fishy server running at http://localhost:${PORT}`);
  console.log(`Serving web UI from: ${webDir}`);
  console.log(`Frames directory: ${framesDir}`);
});
