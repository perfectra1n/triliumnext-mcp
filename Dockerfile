# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Production stage
FROM node:24-alpine

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node --from=builder /app/dist ./dist

ENV NODE_ENV=production
# The server binds to 127.0.0.1 by default, which is unreachable through a
# published container port. Listen on all interfaces inside the container;
# with no TRILIUM_ALLOWED_HOSTS set, a non-loopback bind skips the Host-header
# check, so a reverse proxy can forward any public hostname. Override with
# TRILIUM_HTTP_HOST / --host if needed.
ENV TRILIUM_HTTP_HOST=0.0.0.0

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
