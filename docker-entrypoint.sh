#!/bin/sh
# On start: installs SQLite triggers into the Plex DB, then runs the proxy.
#
# First-run order:
#   1. docker compose up plex          -- let Plex initialise and create its DB
#   2. docker compose stop plex        -- MUST be stopped before trigger install
#   3. docker compose up strm-proxy    -- installs triggers, then starts proxy
#   4. docker compose start plex       -- start Plex again
#
# Subsequent restarts: set SKIP_SETUP=true to skip trigger installation and
# just start the proxy (safe while Plex is running).
#
# CRITICAL: never let Plex run concurrently with trigger installation --
# concurrent writes corrupt the SQLite DB.
set -e

DB="${DB_PATH:-/plex-db/com.plexapp.plugins.library.db}"
PROXY_BASE="http://${STRM_PROXY_HOST:-strm-proxy}:${PORT:-3000}"
CONTAINER_PREFIX="${CONTAINER_PREFIX:-/media/strm}"

if [ "${SKIP_SETUP:-false}" = "true" ]; then
  echo "[strm-proxy] SKIP_SETUP=true -- skipping trigger installation"
else
  # Wait for Plex to create the DB on first run (no timeout -- user controls when to proceed)
  if [ ! -f "$DB" ]; then
    echo "[strm-proxy] Waiting for Plex DB at $DB ..."
    echo "[strm-proxy] Start Plex once to let it initialise, then stop it and restart this container."
    until [ -f "$DB" ]; do sleep 5; done
    echo "[strm-proxy] DB found."
  fi

  echo "[strm-proxy] Installing triggers (db=$DB, proxy=$PROXY_BASE)..."
  node --experimental-sqlite /app/dist/setup.js \
    --db "$DB" \
    --container-prefix "$CONTAINER_PREFIX" \
    --proxy-base "$PROXY_BASE"
fi

# Event-driven probe worker. Off by default; set PROBE_WORKER=true to enable
# (a legacy PROBE_INTERVAL value also enables it and sets the poll interval).
#
# The auto-patch triggers enqueue each newly scanned .strm file into
# strm_probe_queue; this worker drains that queue -- resolving each source URL,
# running ffprobe, and publishing real stream metadata -- so only new or changed
# files do real work, promptly, without re-walking the whole tree each cycle.
#
# NOTE: this writes to the live Plex DB while Plex is running. SQLite's WAL
# locking (with a busy timeout) serialises this safely, but if you'd rather not
# write to a running DB, leave this off and run the probe manually with Plex
# stopped (see README).
if [ "${PROBE_WORKER:-false}" = "true" ] || [ -n "${PROBE_INTERVAL:-}" ]; then
  POLL="${PROBE_POLL_INTERVAL:-${PROBE_INTERVAL:-30}}"
  echo "[strm-proxy] Probe worker enabled (poll every ${POLL}s)"
  (
    # Respawn if the worker ever exits, so a transient fatal error self-heals.
    while true; do
      node --experimental-sqlite /app/dist/probe-worker.js \
        --db "$DB" \
        --rebase "${STRM_ROOT:-/strm}:${CONTAINER_PREFIX}" \
        --proxy-base "$PROXY_BASE" \
        --ffprobe-path "${FFPROBE_PATH:-ffprobe}" \
        --poll-interval "$POLL" \
        --concurrency "${PROBE_CONCURRENCY:-3}" \
        --batch-size "${PROBE_BATCH_SIZE:-50}" \
        --cooldown-ms "${PROBE_COOLDOWN_MS:-0}" \
        --max-attempts "${PROBE_MAX_ATTEMPTS:-5}" \
        || echo "[strm-proxy] probe worker exited (restarting in 10s)"
      sleep 10
    done
  ) &
fi

echo "[strm-proxy] Starting proxy..."
exec node /app/dist/proxy.js
