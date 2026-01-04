# Fishy

AI-powered marine species identifier for diving videos. Upload your underwater footage and get detailed species identification with timestamps, habitat info, and extracted frames. The best models (Gemini 3 Pro and Gemini 3 Flash) are still not great at identifying marine life therefore this project is best used as a first pass to identify potential species and then manually review the results.

![Fishy](https://img.shields.io/badge/status-beta-blue)

## Features

- **Multi-video batch analysis** - Upload and analyze multiple videos at once
- **AI-powered identification** - Uses Google Gemini or OpenAI GPT-5 for species recognition
- **Detailed results** - Common name, scientific name, confidence score, habitat, and description
- **Timestamp tracking** - See exactly when each species appears in your video
- **Frame extraction** - Automatically extracts frames showing identified species
- **Analysis history** - Browse and search past analyses

## Quick Start

### Prerequisites

- Node.js 20+
- ffmpeg (for frame extraction)
- API key for [Google Gemini](https://ai.google.dev/) or [OpenAI](https://platform.openai.com/)

### Installation

```bash
git clone https://github.com/darrinm/fishy.git
cd fishy
npm install
npm run build
```

### Configuration

Create a `.env` file:

```bash
GEMINI_API_KEY=your-gemini-api-key
# Or for OpenAI:
OPENAI_API_KEY=your-openai-api-key
```

### Run

```bash
npm run web
```

Open http://localhost:4000

## Docker

```bash
npm run build
GEMINI_API_KEY=your-key docker compose up --build
```

## Usage

1. Click **Browse** to select one or more video files
2. Choose your AI model (Gemini or OpenAI)
3. Adjust frames per second if needed (higher = more detail, slower)
4. Click **Analyze**
5. View results with species info, timestamps, and extracted frames

## CLI

For command-line usage:

```bash
# Analyze a single video
npm start -- analyze path/to/video.mp4

# Analyze with options
npm start -- analyze path/to/video.mp4 \
  --model 2.5-pro \
  --fps 2 \
  --extract-frames ./frames \
  --output text

# Available models: 3-flash (default), 3-pro, 2.5-flash, 2.5-pro, gpt-5, gpt-5-mini
```

## Tech Stack

- **Backend**: Node.js, Express, TypeScript
- **AI**: Google Gemini API, OpenAI API
- **Video**: ffmpeg for frame extraction
- **Frontend**: Vanilla HTML/CSS/JS

## License

MIT
