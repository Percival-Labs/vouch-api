FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
COPY packages/vouch-db/package.json packages/vouch-db/
COPY apps/vouch-api/package.json apps/vouch-api/
RUN bun install --frozen-lockfile || bun install

# Copy source
COPY packages/vouch-db/ packages/vouch-db/
COPY apps/vouch-api/ apps/vouch-api/
COPY tsconfig.json ./

# Use built-in non-root user
USER bun
EXPOSE 3601
CMD ["bun", "run", "apps/vouch-api/src/index.ts"]
