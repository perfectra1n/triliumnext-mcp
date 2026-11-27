#!/usr/bin/env sh
# Run a built image with the HTTP transport and wait for Docker's own
# HEALTHCHECK to report "healthy". Catches healthchecks that can't reach the
# server inside the container (regression for #150).
#
# Usage: scripts/docker-healthcheck-smoke.sh <image> [timeout-seconds]
set -eu

image="${1:?usage: $0 <image> [timeout-seconds]}"
timeout="${2:-60}"
name="healthcheck-smoke-$$"

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# The server starts without a reachable Trilium (it is only probed when a
# session connects), so a dummy URL and token are enough here. Health timing
# flags shorten the wait; the probe command itself comes from the image.
docker run -d --name "$name" \
  -e TRILIUM_TRANSPORT=http \
  -e TRILIUM_URL=http://127.0.0.1:1/etapi \
  -e TRILIUM_TOKEN=smoke-test \
  --health-interval=2s --health-start-period=2s --health-retries=3 \
  "$image" >/dev/null

elapsed=0
while [ "$elapsed" -lt "$timeout" ]; do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$name")"
  case "$status" in
    healthy)
      echo "container reported healthy after ${elapsed}s"
      exit 0
      ;;
    unhealthy) break ;;
  esac
  sleep 1
  elapsed=$((elapsed + 1))
done

echo "container did not become healthy (status: ${status:-unknown})" >&2
echo "--- healthcheck log ---" >&2
docker inspect -f '{{range .State.Health.Log}}exit={{.ExitCode}} {{.Output}}{{end}}' "$name" >&2
echo "--- container log ---" >&2
docker logs "$name" >&2 2>&1 || true
exit 1
