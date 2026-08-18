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

# Optional periodic probe pass. Off by default; set PROBE_INTERVAL (seconds) to
# enable. Each cycle spawns a fresh, short-lived process (so the DB handle is
# released between runs) that probes source URLs and publishes real stream
# metadata. The probe_sig cache means only new/changed .strm files do real work.
#
# NOTE: this writes to the live Plex DB while Plex is running. SQLite's WAL
# locking (with a busy timeout) serialises this safely, but if you'd rather not
# write to a running DB, leave this off and run the probe manually with Plex
# stopped (see README).
if [ -n "${PROBE_INTERVAL:-}" ]; then
  echo "[strm-proxy] Periodic probe enabled (every ${PROBE_INTERVAL}s)"
  (
    while true; do
      sleep "$PROBE_INTERVAL"
      echo "[strm-proxy] Running probe pass..."
      node --experimental-sqlite /app/dist/probe-cli.js \
        --db "$DB" \
        --scan-strm "${STRM_ROOT:-/strm}" \
        --rebase "${STRM_ROOT:-/strm}:${CONTAINER_PREFIX}" \
        --proxy-base "$PROXY_BASE" \
        --ffprobe-path "${FFPROBE_PATH:-ffprobe}" \
        || echo "[strm-proxy] probe pass failed (continuing)"
    done
  ) &
fi

echo "[strm-proxy] Starting proxy..."
exec node /app/dist/proxy.js
