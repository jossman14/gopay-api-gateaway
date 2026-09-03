# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Gateway ini tidak menulis apa pun ke disk: seluruh state ada di PostgreSQL,
# termasuk sesi provider. Karena itu tidak ada volume dan tidak perlu chown.
USER node
EXPOSE 3000

# Migrasi dijalankan saat start oleh src/server.js sebelum mendengarkan port,
# jadi deployment tidak pernah melayani permintaan dengan skema tertinggal.
CMD ["node", "src/server.js"]
