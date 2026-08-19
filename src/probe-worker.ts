#!/usr/bin/env node
/**
 * Event-driven probe worker: drains the strm_probe_queue that the auto-patch
 * triggers fill whenever Plex scans a .strm file, and publishes real ffprobe
 * metadata into the Plex DB. This replaces the blind filesystem-walk loop with
 * work that only touches new or changed files -- the same pattern the mature
 * Jellyfin/Emby STRM probers use (catch-up queue + scheduled backstop).
 *
 * A queue row holds only a media_part_id. The worker loads the row, recovers the
 * original .strm source URL (from extra_data.strm_source, or the proxy URL for
 * legacy rows), runs ffprobe, writes results, and deletes the row. Failures back
 * off exponentially and park after --max-attempts so a broken URL cannot spin.
 *
 * Runs against the live Plex DB: SQLite WAL + a busy timeout serialise writes
 * safely alongside Plex (the same assumption the old PROBE_INTERVAL loop made).
 */
import { Command } from 'commander';
import {
  DEFAULT_DB_PATH,
  claimQueueBatch,
  createProbeQueueTable,
  findPartById,
  markFailed,
  markProbed,
  openDb,
} from './db';
import { mapPool, probeAndWritePart, sleep } from './probe-run';
import { proxyUrlToContainerPath, readStrmUrl, toLocalPath } from './strm';

const program = new Command();

program
  .name('plex-strm-probe-worker')
  .description('Drain the strm_probe_queue and publish real ffprobe metadata to Plex')
  .option('-d, --db <path>', 'Path to Plex library database', DEFAULT_DB_PATH)
  .requiredOption(
    '--rebase <from:to>',
    'Map the local .strm dir to the container path Plex recorded, e.g. "/strm:/media/strm"',
  )
  .option(
    '--proxy-base <url>',
    'Base URL of the strm-proxy (used to recover the source path for legacy rows)',
    'http://strm-proxy:3000',
  )
  .option('--ffprobe-path <path>', 'Path to the ffprobe binary', 'ffprobe')
  .option('--probe-timeout <ms>', 'Per-URL ffprobe timeout in milliseconds', '30000')
  .option('--concurrency <n>', 'How many URLs to probe in parallel', '3')
  .option('--poll-interval <sec>', 'Seconds to wait between queue polls', '30')
  .option('--batch-size <n>', 'Max queue items to claim per poll', '50')
  .option('--cooldown-ms <ms>', 'Delay after each probe to avoid overloading the source', '0')
  .option('--max-attempts <n>', 'Give up on an item after this many failed attempts', '5')
  .option('--force', 'Re-probe even if the source URL is unchanged')
  .option('--dry-run', 'Report what would change without writing to the DB or draining the queue')
  .option('--once', 'Process one batch and exit instead of looping')
  .parse(process.argv);

const opts = program.opts<{
  db: string;
  rebase: string;
  proxyBase: string;
  ffprobePath: string;
  probeTimeout: string;
  concurrency: string;
  pollInterval: string;
  batchSize: string;
  cooldownMs: string;
  maxAttempts: string;
  force?: boolean;
  dryRun?: boolean;
  once?: boolean;
}>();

const timeoutMs = Number(opts.probeTimeout) || 30000;
const concurrency = Math.max(1, Number(opts.concurrency) || 3);
const pollIntervalMs = Math.max(1, Number(opts.pollInterval) || 30) * 1000;
const batchSize = Math.max(1, Number(opts.batchSize) || 50);
const cooldownMs = Math.max(0, Number(opts.cooldownMs) || 0);
const maxAttempts = Math.max(1, Number(opts.maxAttempts) || 5);
// Container prefix for legacy proxy-URL resolution = the ":to" side of --rebase.
const containerPrefix = opts.rebase.slice(opts.rebase.indexOf(':') + 1);

let stopping = false;

/** Resolves the real source URL for a queued part, or null if it cannot be read. */
function resolveRealUrl(part: import('./db').StrmPart): string | null {
  const containerPath =
    part.strmSource ?? proxyUrlToContainerPath(part.file, opts.proxyBase, containerPrefix);
  if (!containerPath) return null;
  const localPath = toLocalPath(containerPath, opts.rebase);
  return readStrmUrl(localPath);
}

type CycleTally = { probed: number; skipped: number; failed: number; parked: number; gone: number };

async function runCycle(db: ReturnType<typeof openDb>): Promise<CycleTally> {
  const items = claimQueueBatch(db, batchSize);
  const tally: CycleTally = { probed: 0, skipped: 0, failed: 0, parked: 0, gone: 0 };
  if (items.length === 0) return tally;

  await mapPool(items, concurrency, async (item) => {
    const part = findPartById(db, item.mediaPartId);
    if (!part) {
      // Row was deleted since it was queued -- drop the stale queue entry.
      if (!opts.dryRun) markProbed(db, item.mediaPartId);
      tally.gone++;
      return;
    }

    const realUrl = resolveRealUrl(part);
    if (!realUrl) {
      const msg = 'could not resolve source URL (missing/unreadable .strm)';
      recordFailure(db, item.mediaPartId, msg, tally);
      console.warn(`  FAILED  id=${part.id}  ${msg}`);
      return;
    }

    const outcome = await probeAndWritePart(db, {
      part,
      realUrl,
      force: opts.force ?? false,
      dryRun: opts.dryRun ?? false,
      ffprobePath: opts.ffprobePath,
      timeoutMs,
    });

    if (outcome.status === 'failed') {
      recordFailure(db, item.mediaPartId, outcome.error, tally);
      console.warn(`  FAILED  id=${part.id}  ${outcome.error}`);
    } else {
      // Both probed and skipped (already up to date) drain the item.
      if (!opts.dryRun) markProbed(db, item.mediaPartId);
      if (outcome.status === 'probed') {
        tally.probed++;
        console.log(
          `  ${opts.dryRun ? 'WOULD PROBE' : 'PROBED'}  id=${part.id}  ${outcome.summary}`,
        );
      } else {
        tally.skipped++;
      }
    }

    if (cooldownMs > 0) await sleep(cooldownMs);
  });

  return tally;
}

function recordFailure(
  db: ReturnType<typeof openDb>,
  mediaPartId: number,
  error: string,
  tally: CycleTally,
): void {
  if (opts.dryRun) {
    tally.failed++;
    return;
  }
  const result = markFailed(db, mediaPartId, error, { maxAttempts, baseBackoffSec: 60 });
  if (result === 'parked') {
    tally.parked++;
    console.warn(`  PARKED  id=${mediaPartId}  (gave up after ${maxAttempts} attempts)`);
  } else {
    tally.failed++;
  }
}

function nonEmpty(t: CycleTally): boolean {
  return t.probed + t.skipped + t.failed + t.parked + t.gone > 0;
}

async function main(): Promise<void> {
  console.log(`Plex database: ${opts.db}`);
  console.log(`Rebase:        ${opts.rebase}`);
  if (opts.dryRun) console.log('DRY RUN -- no changes will be written\n');

  const db = openDb(opts.db);
  // Tolerate a first run before setup.js has created the table.
  createProbeQueueTable(db);

  if (opts.once) {
    const t = await runCycle(db);
    console.log(
      `Done. probed=${t.probed} skipped=${t.skipped} failed=${t.failed} parked=${t.parked} gone=${t.gone}`,
    );
    return;
  }

  console.log(`Draining queue (concurrency=${concurrency}, poll=${pollIntervalMs / 1000}s)...`);
  process.on('SIGTERM', () => (stopping = true));
  process.on('SIGINT', () => (stopping = true));

  while (!stopping) {
    try {
      const t = await runCycle(db);
      if (nonEmpty(t)) {
        console.log(
          `[probe-worker] probed=${t.probed} skipped=${t.skipped} failed=${t.failed} parked=${t.parked} gone=${t.gone}`,
        );
      }
    } catch (err) {
      console.error('[probe-worker] cycle error (continuing):', err);
    }
    if (stopping) break;
    await sleep(pollIntervalMs);
  }
  console.log('[probe-worker] stopped.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
