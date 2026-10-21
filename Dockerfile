FROM node:20-slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for build)
RUN npm ci

# Copy source files
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Production image
FROM node:20-slim

# Install ffmpeg for video processing. ca-certificates is named so the build
# takes the newest one, not the base image's: 20250419~deb12u2 distrusts the
# compromised eMudhra intermediates (src/tls-distrust.ts covers Node).
RUN apt-get update && apt-get install -y \
    ca-certificates \
    ffmpeg \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' ca-certificates)" ge '20250419~deb12u2' \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy built application from builder
COPY --from=builder /app/dist ./dist/
COPY web/ ./web/

# Create data directories
RUN mkdir -p data/uploads frames

# Environment
ENV NODE_ENV=production
ENV PORT=4000

EXPOSE 4000

CMD ["node", "dist/server/index.js"]
