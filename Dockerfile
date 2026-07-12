# --- build the dashboard ---
FROM node:20-bookworm-slim AS web

WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install

COPY web/ ./
RUN npm run build

# --- bot + api ---
FROM node:20-bookworm-slim

# better-sqlite3 compiles a native addon on install.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY --from=web /web/dist ./web/dist

RUN mkdir -p /data
VOLUME /data

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/index.js"]
