# Faceful reel render worker. Build from the repository root so the image gets the studio's composition:
#   docker build -f workers/reel-render/Dockerfile -t faceful-reel-worker .
FROM node:24-bookworm-slim

# Libraries Chrome Headless Shell needs, plus fonts for Greek, Latin and emoji text.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates libnss3 libdbus-1-3 libatk1.0-0 libgbm1 libasound2 libxrandr2 libxkbcommon0 \
      libxfixes3 libxcomposite1 libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 \
      fonts-noto-core fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY workers/reel-render/package.json workers/reel-render/package-lock.json workers/reel-render/
RUN cd workers/reel-render \
  && npm ci --omit=dev --no-audit --no-fund \
  && node -e "import('@remotion/renderer').then((r) => r.ensureBrowser())"

# The exact component the studio previews, and its typeface.
COPY apps/web/src/video apps/web/src/video
COPY apps/web/public/fonts/InterVariable.woff2 apps/web/public/fonts/InterVariable.woff2
COPY packages/engine/src/voice-providers.ts packages/engine/src/voice-providers.ts
COPY workers/reel-render/src workers/reel-render/src

RUN chown -R node:node /app
USER node
ENV NODE_ENV=production NODE_NO_WARNINGS=1
CMD ["node", "workers/reel-render/src/worker.ts"]
