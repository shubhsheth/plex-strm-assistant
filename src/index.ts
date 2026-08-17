#!/usr/bin/env node
import { Command } from 'commander';
import path from 'path';
import {
  DEFAULT_DB_PATH,
  findPartByContainerPath,
  guardTriggerExists,
  installGuardTrigger,
  openDb,
  updatePartFile,
} from './db';
import { readStrmUrl, toContainerPath, toProxyUrl, walkStrm } from './strm';

// Read at runtime rather than imported: package.json sits outside rootDir, so
// importing it would break the dist layout. Resolves from both src/ and dist/.
const { version } = require('../package.json') as { version: string };

const program = new Command();

program
  .name('plex-strm-assistant')
  .description('Replaces .strm file paths in the Plex database with the URLs they contain')
  .version(version)
  .option('-d, --db <path>', 'Path to Plex library database', DEFAULT_DB_PATH)
  .option('--dry-run', 'Preview changes without writing to the database')
  .option(
    '--proxy-base <url>',
    'Base URL of the strm-proxy sidecar, e.g. "http://strm-proxy:3000". ' +
      'When set the DB stores stable proxy URLs instead of the real stream URLs, ' +
      'so .strm changes take effect immediately without re-patching.',
  )
  .requiredOption(
    '--scan-strm <local-dir>',
    'Local directory to scan for .strm files (source of truth)',
  )
  .requiredOption(
    '--rebase <from:to>',
    'Map the local scan dir to the container path Plex recorded, e.g. "./strm:/media/strm"',
  )
  .parse(process.argv);

const opts = program.opts<{
  db: string;
  dryRun: boolean;
  proxyBase?: string;
  scanStrm: string;
  rebase: string;
}>();

console.log(`Plex database: ${opts.db}`);
console.log(`Scanning:      ${opts.scanStrm}`);
console.log(`Rebase:        ${opts.rebase}`);
if (opts.proxyBase) console.log(`Proxy base:    ${opts.proxyBase}`);
if (opts.dryRun) console.log('DRY RUN -- no changes will be written\n');

const db = openDb(opts.db);
const strmFiles = walkStrm(path.resolve(opts.scanStrm));

if (strmFiles.length === 0) {
  console.log('No .strm files found in scan directory.');
  process.exit(0);
}

console.log(`Found ${strmFiles.length} .strm file(s):\n`);

let updated = 0;
let seeded = 0;
let skipped = 0;
let failed = 0;

for (const localPath of strmFiles) {
  const containerPath = toContainerPath(localPath, opts.rebase);
  const realUrl = readStrmUrl(localPath);

  if (!realUrl) {
    console.warn(`  SKIP  ${localPath}\n        (empty or non-HTTP content)`);
    skipped++;
    continue;
  }

  // targetUrl is what gets stored in the DB:
  //   proxy mode -> stable proxy URL (never changes when .strm content changes)
  //   direct mode -> real URL from the .strm file
  const targetUrl = opts.proxyBase
    ? toProxyUrl(containerPath, opts.rebase, opts.proxyBase)
    : realUrl;

  // Provide both URLs as hints so we can find rows regardless of which was stored previously
  const part = findPartByContainerPath(db, containerPath, [targetUrl, realUrl]);

  if (!part) {
    console.warn(
      `  NOT IN DB  ${containerPath}` + `\n             Has Plex scanned this file yet?`,
    );
    skipped++;
    continue;
  }

  const outcome = updatePartFile(db, part, containerPath, targetUrl, opts.dryRun ?? false);

  if (!outcome.urlUpdated && !outcome.sourceSeeded) {
    console.log(`  UP TO DATE  id=${part.id}  ${containerPath}`);
    skipped++;
    continue;
  }

  if (outcome.urlUpdated) {
    const label = opts.dryRun ? 'WOULD UPDATE' : 'UPDATED';
    const extra = outcome.sourceSeeded ? ' (strm_source seeded)' : '';
    console.log(`  ${label}  id=${part.id}${extra}`);
    console.log(`    strm: ${containerPath}`);
    console.log(`      to: ${targetUrl}`);
    updated++;
  } else {
    const label = opts.dryRun ? 'WOULD SEED' : 'SEEDED';
    console.log(`  ${label}  id=${part.id}  ${containerPath}`);
    seeded++;
  }
}

const summary = [
  `updated=${updated}`,
  `seeded=${seeded}`,
  `skipped=${skipped}`,
  `failed=${failed}`,
];
console.log(`\nDone. ${summary.join('  ')}`);

if (!opts.dryRun && opts.proxyBase) {
  if (!guardTriggerExists(db)) {
    installGuardTrigger(db);
    console.log('\nGuard trigger installed -- Plex rescans will no longer revert proxy URLs.');
  } else {
    console.log('\nGuard trigger already installed.');
  }
}
