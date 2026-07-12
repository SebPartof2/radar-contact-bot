FROM node:20-bookworm-slim

# better-sqlite3 compiles a native addon on install.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

RUN mkdir -p /data
VOLUME /data

ENV NODE_ENV=production
CMD ["node", "src/index.js"]
