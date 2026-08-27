# TableauPilot AI - deployable image (Node web UI + agent).
#
# Includes the `hyperd` engine so the "read underlying data" feature works even
# though the host has no Tableau install. The `.twbx` upload carries the .hyper
# DATA; hyperd is the ENGINE that queries it, so it must live in the image.
#
# Node >= 21 is required by the native Hyper bindings (hyperdb-api-node).
FROM node:22-slim

# hyperd is a native Linux binary; ensure common runtime libs + CA certs are present.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package*.json ./
RUN npm ci

# App source.
COPY . .

# Download the pinned hyperd for this image's platform (linux-x86_64) into ./.hyperd.
# The reader auto-detects ./.hyperd/hyper/hyperd; no HYPERD_PATH needed.
RUN node scripts/download-hyperd.mjs

# Web UI port (override with WEB_PORT).
ENV WEB_PORT=5173
EXPOSE 5173

# Secrets (LLM gateway key/helper, etc.) come from the runtime env, never baked in.
CMD ["npm", "run", "ui"]
