FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Install dependencies first so source edits don't invalidate the npm layer.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/scheduler/package.json apps/scheduler/
COPY apps/tracker-api/package.json apps/tracker-api/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY packages packages
COPY apps apps

USER node
# Each compose service overrides the command (api / worker / scheduler / tracker-api).
CMD ["node", "apps/api/src/server.js"]
