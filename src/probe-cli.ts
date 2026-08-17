#!/usr/bin/env node
/**
 * Probe pass: resolves each .strm source URL, runs ffprobe, and writes real
 * per-track stream metadata into the Plex DB -- replacing the placeholder
 * h264/aac pair the triggers seed for instant playback.
 *
 * Safe to re-run: a probe signature (hash of the source URL) is stored in
 * media_parts.extra_data, so an unchanged part is skipped unless --force. This
 * is what makes the container's periodic PROBE_INTERVAL loop cheap: each cycle
 * only probes new or changed .strm files.
 *
 * Like the setup step, Plex should be stopped while this writes to the DB
 * (concurrent writes to the SQLite DB risk corruption).
 */
import { Command } from 'commander';
import path from 'path';
import {
  DEFAULT_DB_PATH,
  findPartByContainerPath,
  openDb,
  writeProbedStreams,
  parseExtraDataField,
} from './db';
import { probeSignature, probeUrl } from './probe';
import { readStrmUrl, toContainerPath, toProxyUrl, walkStrm } from './strm';

const program = new Command();

program
  .name('plex-strm-probe')
  .description('Probe .strm source URLs with ffprobe and publish real stream metadata to Plex')
  .option('-d, --db <path>', 'Path to Plex library database', DEFAULT_DB_PATH)
  .requiredOption('--scan-strm <local-dir>', 'Local directory to scan for .strm files')
  .requiredOption(
    '--rebase <from:to>',
    'Map the local scan dir to the container path Plex recorded, e.g. "./strm:/media/strm"',
  )
  .option(
    '--proxy-base <url>',
    'Base URL of the strm-proxy sidecar (helps locate rows already patched to proxy URLs)',
  )
  .option('--ffprobe-path <path>', 'Path to the ffprobe binary', 'ffprobe')
  .option('--probe-timeout <ms>', 'Per-URL ffprobe timeout in milliseconds', '30000')
  .option('--concurrency <n>', 'How many URLs to probe in parallel', '3')
  .option('--force', 'Re-probe every file even if its source URL is unchanged')
  .option('--dry-run', 'Report what would change without writing to the database')
  .parse(process.argv);

const opts = program.opts<{
  db: string;
  scanStrm: string;
  rebase: string;
  proxyBase?: string;
  ffprobePath: string;
  probeTimeout: string;
  concurrency: string;
  force?: boolean;
  dryRun?: boolean;
}>();

const timeoutMs = Number(opts.probeTimeout) || 30000;
const concurrency = Math.max(1, Number(opts.concurrency) || 3);

async function main(): Promise<void> {
  console.log(`Plex database: ${opts.db}`);
  console.log(`Scanning:      ${opts.scanStrm}`);
  console.log(`Rebase:        ${opts.rebase}`);
  if (opts.dryRun) console.log('DRY RUN -- no changes will be written\n');

  const db = openDb(opts.db);
  const strmFiles = walkStrm(path.resolve(opts.scanStrm));

  if (strmFiles.length === 0) {
    console.log('No .strm files found in scan directory.');
    return;
  }

  console.log(`Found ${strmFiles.length} .strm file(s). Probing (concurrency=${concurrency})...\n`);

  let probed = 0;
  let skipped = 0;
  let notInDb = 0;
  let failed = 0;

  await mapPool(strmFiles, concurrency, async (localPath) => {
    const containerPath = toContainerPath(localPath, opts.rebase);
    const realUrl = readStrmUrl(localPath);
    if (!realUrl) {
      console.warn(`  SKIP  ${localPath}\n        (empty or non-HTTP content)`);
      skipped++;
      return;
    }

    const hints = opts.proxyBase
      ? [toProxyUrl(containerPath, opts.rebase, opts.proxyBase), realUrl]
      : [realUrl];
    const part = findPartByContainerPath(db, containerPath, hints);
    if (!part) {
      console.warn(`  NOT IN DB  ${containerPath}\n             Has Plex scanned this file yet?`);
      notInDb++;
      return;
    }

    const sig = probeSignature(realUrl);
    if (!opts.force && parseExtraDataField(part.extraData, 'probe_sig') === sig) {
      console.log(`  SKIP (unchanged)  id=${part.id}  ${containerPath}`);
      skipped++;
      return;
    }

    const outcome = await probeUrl(realUrl, { ffprobePath: opts.ffprobePath, timeoutMs });
    if (!outcome.ok) {
      console.warn(`  FAILED  id=${part.id}  ${containerPath}\n          ${outcome.error}`);
      failed++;
      return;
    }

    const result = outcome.result;
    writeProbedStreams(db, part, result, sig, opts.dryRun ?? false);
    const label = opts.dryRun ? 'WOULD PROBE' : 'PROBED';
    console.log(`  ${label}  id=${part.id}  ${describe(result)}`);
    console.log(`    ${containerPath}`);
    probed++;
  });

  const summary = [
    `probed=${probed}`,
    `skipped=${skipped}`,
    `not-in-db=${notInDb}`,
    `failed=${failed}`,
  ];
  console.log(`\nDone. ${summary.join('  ')}`);
}

/** One-line human summary of a probe result. */
function describe(result: import('./probe').ProbeResult): string {
  const v = result.streams.find((s) => s.kind === 'video');
  const audio = result.streams.filter((s) => s.kind === 'audio').length;
  const subs = result.streams.filter((s) => s.kind === 'subtitle').length;
  const parts: string[] = [];
  if (v && v.kind === 'video') {
    parts.push(`${v.codec}${v.width && v.height ? ` ${v.width}x${v.height}` : ''}`);
  }
  parts.push(`${audio} audio`);
  parts.push(`${subs} subtitle`);
  return parts.join('  ');
}

/** Runs `fn` over items with a bounded number of concurrent workers. */
async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
