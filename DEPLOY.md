# Deploy Fishy to Coolify

## Overview
Deploy Fishy to a Hetzner VPS running Coolify, accessible at `fishy.darrinm.com`.

## Prerequisites
- ✅ Docker setup (Dockerfile, docker-compose.yml, .dockerignore)
- ✅ GitHub repo

## Steps

### 1. Provision Hetzner VPS
- Server name: `darrinm`
- Ubuntu 22.04, CPX21 (3 vCPU, 4GB RAM, 80GB disk) - ~€8/mo
- Add SSH key, note the IP

### 2. Install Coolify
```bash
ssh root@<server-ip>
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```
Access at `http://<server-ip>:8000`

### 3. Configure DNS (Namecheap)
Add A records:
- `fishy` → `<server-ip>`
- `coolify` → `<server-ip>`

### 4. Add GitHub Integration
Coolify → Sources → Add GitHub App → authorize repo

### 5. Create Application
- New Resource → Application
- Build Pack: **Dockerfile**
- Port: **4000**
- Domain: `fishy.darrinm.com`

### 6. Environment Variables
- `GEMINI_API_KEY` = your key
- `OPENAI_API_KEY` = your key (optional)

### 7. Persistent Storage
- Volume: `/app/data`
- Volume: `/app/frames`

### 8. Deploy & Verify
Click Deploy → visit `https://fishy.darrinm.com`

## Costs
- Hetzner CPX21: ~€8/mo (~$9)
- SSL: Free (Let's Encrypt)
