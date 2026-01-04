# Deploying Fishy to Production

Deploy Fishy to a Hetzner VPS using Coolify, accessible at `fishy.darrinm.com`.

## Infrastructure Overview

| Component | Details |
|-----------|---------|
| VPS | Hetzner CPX21 (3 vCPU, 4GB RAM, 80GB SSD) |
| OS | Ubuntu 22.04 |
| Platform | Coolify v4 (self-hosted PaaS) |
| Domain | fishy.darrinm.com |
| SSL | Automatic via Let's Encrypt |
| Auth | HTTP Basic Authentication |

## Prerequisites

- Hetzner Cloud account
- Domain with DNS access (e.g., Namecheap)
- GitHub repository with Fishy code
- API keys for Gemini and/or OpenAI

## Step 1: Provision Hetzner VPS

1. Log into [Hetzner Cloud Console](https://console.hetzner.cloud)
2. Create new project or select existing
3. Add Server:
   - **Location**: Choose nearest (e.g., Ashburn for US East)
   - **Image**: Ubuntu 22.04
   - **Type**: CPX21 (3 vCPU, 4GB RAM, 80GB SSD) - ~$8/month
   - **SSH Key**: Add your public key
4. Note the server IP address

## Step 2: Install Coolify

```bash
ssh root@YOUR_SERVER_IP
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

After installation:
- Access Coolify at `http://YOUR_SERVER_IP:8000`
- Create admin account
- Select "This Machine" for deployment server

## Step 3: Configure DNS

Add A records at your DNS provider:

| Type | Host    | Value          | TTL  |
|------|---------|----------------|------|
| A    | fishy   | YOUR_SERVER_IP | Auto |
| A    | coolify | YOUR_SERVER_IP | Auto |

## Step 4: Create Application in Coolify

1. Go to **Projects** → **Add New Resource**
2. Select **Public Repository**
3. Enter: `https://github.com/darrinm/fishy`
4. Configure:
   - **Branch**: `master` (not `main`!)
   - **Build Pack**: `Dockerfile`
   - **Port**: `4000`
   - **Domain**: `https://fishy.darrinm.com`

## Step 5: Environment Variables

Add in **Configuration** → **Environment Variables**:

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google AI API key |
| `OPENAI_API_KEY` | OpenAI API key (optional) |

## Step 6: Persistent Storage

Add in **Configuration** → **Persistent Storage**:

| Volume Name | Mount Path | Purpose |
|-------------|------------|---------|
| fishy-data | /app/data | Analysis history, uploads |
| fishy-frames | /app/frames | Extracted video frames |

## Step 7: Enable Basic Authentication

**Important**: Protects both UI and all API endpoints.

1. Go to **Configuration** → **General**
2. Scroll to **HTTP Basic Authentication**
3. Check **Enable**
4. Set username and password
5. Click **Save**
6. Click **Redeploy**

## Step 8: Deploy

Click **Deploy** and monitor logs until "Rolling update completed".

---

## Technical Details

### Multi-Stage Dockerfile

The project uses a multi-stage build to compile TypeScript inside the container:

```dockerfile
# Stage 1: Build
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci                    # Install ALL deps (including dev)
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build             # Compile TypeScript

# Stage 2: Production
FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production  # Only production deps
COPY --from=builder /app/dist ./dist/
COPY web/ ./web/
RUN mkdir -p data/uploads frames
ENV NODE_ENV=production PORT=4000
EXPOSE 4000
CMD ["node", "dist/server/index.js"]
```

### .dockerignore

Must NOT exclude source files (needed for build):

```
node_modules
npm-debug.log
.git
.gitignore
.env
*.md
.DS_Store
data/uploads/*
frames/*
```

---

## Troubleshooting

### "Remote branch main not found"
The repo uses `master`, not `main`. Change branch in **Git Source** settings.

### "/src: not found" during build
Check `.dockerignore` - it must NOT exclude `src/`, `tsconfig.json`, or `*.ts`.

### TypeScript compilation fails
Ensure Dockerfile has multi-stage build with `npm ci` (not `--only=production`) in builder stage.

### Site not accessible after deploy
- Verify DNS A record points to server IP
- Check deployment logs in Coolify
- Ensure port is set to `4000`

### Basic auth not working
- Must redeploy after enabling
- Clear browser cache

---

## Maintenance

### Auto-Deploy
Enable "Auto Deploy" in Advanced settings - pushes to `master` trigger deploys.

### Manual Redeploy
Click **Redeploy** in Coolify dashboard.

### View Logs
**Logs** tab in application view.

### SSH Access
```bash
ssh root@YOUR_SERVER_IP
```

---

## Costs

| Item | Cost |
|------|------|
| Hetzner CPX21 | ~$8/month |
| Domain | ~$10-15/year |
| SSL | Free (Let's Encrypt) |
| Gemini API | Pay per use (free tier available) |
| OpenAI API | Pay per use |

---

## Security Checklist

- [x] HTTPS enabled (automatic via Coolify/Traefik)
- [x] HTTP Basic Auth on all endpoints
- [x] API keys in environment variables (not code)
- [x] SSH key authentication only
- [x] Gemini files auto-cleaned after analysis (quota protection)
