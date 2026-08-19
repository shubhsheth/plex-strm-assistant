/**
 * Shared probe-one-part logic used by both the full-sweep CLI (probe-cli.ts,
 * which walks the filesystem) and the event-driven worker (probe-worker.ts,
 * which drains the SQLite work queue). Keeping the ffprobe + write step in one
 * place means both paths skip unchanged files identically and write results the
 * same way.
 */
import type { DatabaseSync } from 'node:sqlite';
import { parseExtraDataField, writeProbedStreams, type StrmPart } from './db';
import { probeSignature, probeUrl } from './probe';

export type ProbeStatus = 'probed' | 'skipped' | 'failed';

export type ProbeAndWriteResult =
  | { status: 'probed'; summary: string }
  | { status: 'skipped'; reason: 'unchanged' }
  | { status: 'failed'; error: string };

export type ProbeAndWriteOptions = {
  part: StrmPart;
  realUrl: string;
  force: boolean;
  dryRun: boolean;
  ffprobePath: string;
  timeoutMs: number;
};

/**
 * Probes one resolved source URL and writes real stream metadata to the Plex DB
 * for the given part, unless its probe signature is unchanged (skip) or ffprobe
 * fails. Pure orchestration -- no filesystem walking, no queue bookkeeping.
 */
export async function probeAndWritePart(
  db: DatabaseSync,
  opts: ProbeAndWriteOptions,
): Promise<ProbeAndWriteResult> {
  const { part, realUrl, force, dryRun, ffprobePath, timeoutMs } = opts;

  const sig = probeSignature(realUrl);
  if (!force && parseExtraDataField(part.extraData, 'probe_sig') === sig) {
    return { status: 'skipped', reason: 'unchanged' };
  }

  const outcome = await probeUrl(realUrl, { ffprobePath, timeoutMs });
  if (!outcome.ok) {
    return { status: 'failed', error: outcome.error };
  }

  writeProbedStreams(db, part, outcome.result, sig, dryRun);
  return { status: 'probed', summary: describe(outcome.result) };
}

/** One-line human summary of a probe result (e.g. "h264 1920x1080  2 audio  1 subtitle"). */
export function describe(result: import('./probe').ProbeResult): string {
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
export async function mapPool<T>(
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

/** Sleeps for `ms` milliseconds (used for inter-probe cooldown and poll intervals). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
