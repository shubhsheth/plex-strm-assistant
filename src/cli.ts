#!/usr/bin/env node
/**
 * Single entrypoint for the toolkit. Everything ships under one bin
 * (`plex-strm-assistant`) and splits internally by subcommand:
 *
 *   plex-strm-assistant setup         Install the auto-patch DB triggers
 *   plex-strm-assistant patch         Scan .strm files and rewrite DB rows directly
 *   plex-strm-assistant probe         Full-sweep ffprobe pass over the .strm tree
 *   plex-strm-assistant probe-worker  Drain the probe queue (event-driven)
 *   plex-strm-assistant proxy         Run the redirect proxy server
 *
 * Each subcommand is its own module with its own flags; this launcher just
 * routes to it. The modules read process.argv at load, so we rewrite argv to
 * drop the subcommand token (leaving "<bin> <sub>" as argv[1] for nice --help
 * output) and then require the target -- which runs it. The same modules stay
 * directly runnable as dist/<name>.js (used by the Docker entrypoint).
 */
const commands: Record<string, string> = {
  setup: './setup',
  patch: './index',
  probe: './probe-cli',
  'probe-worker': './probe-worker',
  proxy: './proxy',
};

function usage(): string {
  return [
    'Usage: plex-strm-assistant <command> [options]',
    '',
    'Commands:',
    '  setup          Install the auto-patch DB triggers',
    '  patch          Scan .strm files and rewrite DB rows directly',
    '  probe          Full-sweep ffprobe pass over the .strm tree',
    '  probe-worker   Drain the probe queue (event-driven)',
    '  proxy          Run the redirect proxy server',
    '',
    'Run "plex-strm-assistant <command> --help" for command-specific options.',
  ].join('\n');
}

const [sub, ...rest] = process.argv.slice(2);

if (!sub || sub === '--help' || sub === '-h') {
  console.log(usage());
  process.exit(0);
}

if (sub === '--version' || sub === '-V') {
  const { version } = require('../package.json') as { version: string };
  console.log(version);
  process.exit(0);
}

const target = commands[sub];
if (!target) {
  console.error(`Unknown command: ${sub}\n`);
  console.error(usage());
  process.exit(1);
}

// Rewrite argv so the subcommand module's own parser sees just its args, with a
// program name of "plex-strm-assistant <sub>" in any usage/help it prints.
process.argv = [process.argv[0], `${process.argv[1]} ${sub}`, ...rest];
require(target);
