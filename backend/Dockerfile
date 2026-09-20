# Render's native Node runtime cannot install Chromium's system libraries (no root during build),
# so the backend is deployed as a Docker service on Microsoft's Playwright image, which already
# has Chromium and its dependencies. The image tag MUST match the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
# Render injects PORT; src/config.js reads it.
CMD ["node", "src/server.js"]
