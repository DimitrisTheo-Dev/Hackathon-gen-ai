# Claude Code runner image. Used two ways:
#   - a VPS or your own computer (docker compose; the home directory is a volume), and
#   - Cloudflare Containers, one per user (apps/machines; the disk is fresh on every wake,
#     so the runner restores from the user's cloud folder).
#
# Stage 1 runs on the build machine's own CPU and only downloads. Stage 2 only copies files.
# So the image builds for another CPU (Cloudflare needs amd64) without emulation.
FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS claude
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates jq \
 && rm -rf /var/lib/apt/lists/*
# The official Claude Code binary, unmodified, checked against Anthropic's published checksum.
RUN set -eu; \
    case "$TARGETARCH" in amd64) platform=linux-x64 ;; arm64) platform=linux-arm64 ;; *) echo "unsupported CPU: $TARGETARCH" >&2; exit 1 ;; esac; \
    base=https://downloads.claude.ai/claude-code-releases; \
    version=$(curl -fsSL "$base/latest"); \
    checksum=$(curl -fsSL "$base/$version/manifest.json" | jq -r ".platforms[\"$platform\"].checksum"); \
    curl -fsSL -o /claude "$base/$version/$platform/claude"; \
    echo "$checksum  /claude" | sha256sum -c -; \
    chmod 0755 /claude; \
    echo "$version" > /claude.version

# The full Node image already has git, curl, python3 and build tools: what a coding agent needs.
FROM node:24-bookworm
COPY --from=claude /claude /usr/local/bin/claude
COPY --from=claude /claude.version /etc/claude.version
COPY server.ts /app/server.ts

ENV HOST=0.0.0.0 \
    PORT=8787 \
    DISABLE_AUTOUPDATER=1 \
    WORKSPACE_DIR=/home/node/work

# Non-root, so Claude Code's full-access mode is allowed inside the container.
USER node
WORKDIR /home/node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "/app/server.ts"]
