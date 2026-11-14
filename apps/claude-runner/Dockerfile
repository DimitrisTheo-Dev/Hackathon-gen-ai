# Claude Code runner for a VPS. The home directory is a volume, so your
# Claude sign-in, sessions and workspace survive restarts and rebuilds.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates git bash less procps ripgrep \
 && rm -rf /var/lib/apt/lists/*

# Official Claude Code binary, unmodified, installed outside $HOME so the home volume stays yours.
RUN curl -fsSL https://claude.ai/install.sh | bash \
 && install -m 0755 "$(readlink -f /root/.local/bin/claude)" /usr/local/bin/claude \
 && rm -rf /root/.local/share/claude /root/.local/bin/claude

COPY server.ts /app/server.ts

ENV HOST=0.0.0.0 \
    PORT=8787 \
    DISABLE_AUTOUPDATER=1 \
    WORKSPACE_DIR=/home/node/work

# Non-root, so Claude Code's full-access mode is allowed inside the container.
USER node
WORKDIR /home/node
RUN mkdir -p /home/node/work /home/node/.claude-runner
VOLUME /home/node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "/app/server.ts"]
