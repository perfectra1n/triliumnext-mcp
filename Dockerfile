# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node --from=builder /app/dist ./dist

ENV NODE_ENV=production

USER node

# HTTP transport default port. Override --port if changed.
EXPOSE 3000

# Busybox wget ships with alpine. The /health endpoint requires no auth
# so we can probe it regardless of gateway-auth configuration.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --spider -q http://localhost:3000/health || exit 1

# Stdio by default (matches historical behavior). Container users enable
# HTTP via env (TRILIUM_TRANSPORT=http) or by passing flags to CMD.
ENTRYPOINT ["node", "dist/index.js"]
CMD []
