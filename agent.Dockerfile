# The image shared by agent / gates / app / holdout.
# The official Playwright image comes with Node.js and browsers.
FROM mcr.microsoft.com/playwright:v1.65.0

RUN npm install -g pnpm@10 @anthropic-ai/claude-code \
  && npm cache clean --force

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
