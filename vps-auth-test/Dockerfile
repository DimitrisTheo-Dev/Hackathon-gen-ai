# One image, many customers: each customer gets their own container whose
# home directory is their own volume, so their Claude credentials live only there.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates git bash less procps \
 && rm -rf /var/lib/apt/lists/*

# Install Claude Code exactly as Anthropic publishes it (unmodified binary),
# then move it out of $HOME so a customer's home can be a fresh volume.
RUN curl -fsSL https://claude.ai/install.sh | bash \
 && install -m 0755 "$(readlink -f /root/.local/bin/claude)" /usr/local/bin/claude \
 && rm -rf /root/.local/share/claude /root/.local/bin/claude

RUN useradd -m -s /bin/bash customer \
 && mkdir -p /home/customer/work \
 && chown -R customer:customer /home/customer

# The binary is shared and read-only for customers; update by rebuilding the image.
ENV DISABLE_AUTOUPDATER=1

USER customer
WORKDIR /home/customer/work
CMD ["claude"]
