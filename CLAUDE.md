# Fishy - Claude Code Notes

## Running the Application

**Important:** This project has two entry points:

- `npm start` - Runs the CLI tool (for command-line video analysis)
- `npm run web` - Runs the web server with UI at http://localhost:4000

**Always use `npm run web` when working on the web interface.**

## Development Commands

- `npm run build` - Compile TypeScript
- `npm run dev` - Build + run CLI
- `npm run web` - Run web server
- `npm run web:dev` - Build + run web server
- `npm run watch` - Auto-rebuild and restart on changes

## Project Structure

- `src/` - TypeScript source files
- `dist/` - Compiled JavaScript (generated)
- `web/` - Static web UI (HTML/CSS/JS)
- `frames/` - Extracted video frames (generated)
- `data/` - Persistent storage (history, starred, uploads)

## Key Files

- `src/index.ts` - CLI entry point
- `src/server/index.ts` - Web server entry point
- `src/server/api.ts` - REST API routes
- `web/index.html` - Web UI (single file with embedded JS/CSS)

## API Endpoints

- `POST /api/upload` - Upload video files (multipart/form-data)
- `POST /api/batch/analyze` - Start batch analysis
- `GET /api/batch/:id/progress` - SSE progress stream
- `GET /api/history` - List past analyses
- `GET /api/models` - Available AI models
