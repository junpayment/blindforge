# The image shared by agent / gates / app / holdout.
# The official Playwright image comes with Node.js and browsers.
FROM mcr.microsoft.com/playwright:v1.65.0

RUN npm install -g pnpm@10 @anthropic-ai/claude-code \
  && npm cache clean --force

# gates / app / preview source this to get a per-container checkout directory on the pnpm-store volume,
# so pnpm can hardlink from the store instead of copying (see compose.yaml).
# Checkouts older than 6 hours are swept first (containers stopped by `compose down` can't clean up after themselves)
RUN printf '%s\n' \
  'RUNS=/home/pwuser/.pnpm-store/_runs' \
  'mkdir -p "$RUNS"' \
  'find "$RUNS" -mindepth 1 -maxdepth 1 -mmin +360 -exec rm -rf {} + 2>/dev/null || true' \
  'RUN_DIR="$RUNS/$(hostname)-$$"' \
  'rm -rf "$RUN_DIR" && mkdir -p "$RUN_DIR"' \
  'trap '"'"'rm -rf "$RUN_DIR"'"'"' EXIT' \
  > /usr/local/bin/blindforge-rundir

USER pwuser
# Repositories mounted from the host have a different owner, so allow them via git's safe.directory
RUN git config --global --add safe.directory '*'
# Pin the pnpm store to the container's home directory.
# Otherwise .pnpm-store/ gets created inside the mounted workspace, where lint picks it up or it gets committed.
# The cache volumes are mounted here, so create the directories up front, owned by pwuser
# (an empty named volume inherits the owner of the image's directory)
RUN mkdir -p /home/pwuser/.pnpm-store /home/pwuser/.npm \
  && pnpm config set store-dir /home/pwuser/.pnpm-store --global \
  && pnpm config set fetch-retries 6 --global \
  && pnpm config set fetch-retry-maxtimeout 120000 --global \
  && npm config set fetch-retries 6 \
  && npm config set fetch-retry-maxtimeout 120000
WORKDIR /work
