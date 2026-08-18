/**
 * ffprobe wrapper.
 *
 * `probeUrl` shells out to ffprobe against a (possibly remote) URL and returns
 * the parsed, normalised stream/format data. ffprobe follows HTTP 302 redirects
 * natively, so a .strm URL that redirects (e.g. 115 Drive) probes transparently.
 *
 * `normaliseProbe` is a pure function (no I/O) that maps ffprobe's raw JSON into
 * a typed `ProbeResult`. Keeping it separate makes the mapping directly unit
 * testable from saved fixtures without needing ffprobe or a network at test time.
 */
import { spawn } from 'child_process';
import { createHash } from 'crypto';

// -- normalised output types --

export type VideoStream = {
  kind: 'video';
  index: number;
  codec: string;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  bitDepth: number | null;
  profile: string | null;
  level: number | null;
  colorSpace: string | null;
  aspectRatio: string | null; // e.g. "16:9"
  bitrate: number | null;
  language: string | null;
  title: string | null;
  default: boolean;
};

export type AudioStream = {
  kind: 'audio';
  index: number;
  codec: string;
  channels: number | null;
  channelLayout: string | null; // e.g. "5.1"
  sampleRate: number | null;
  bitrate: number | null;
  language: string | null;
  title: string | null;
  default: boolean;
  forced: boolean;
};

export type SubtitleStream = {
  kind: 'subtitle';
  index: number;
  codec: string;
  language: string | null;
  title: string | null;
  forced: boolean;
  default: boolean;
};

export type ProbeStream = VideoStream | AudioStream | SubtitleStream;

export type ProbeResult = {
  container: string | null; // normalised, e.g. "mp4", "mkv"
  durationSec: number | null;
  bitrate: number | null; // overall, bits per second
  sizeBytes: number | null;
  streams: ProbeStream[];
};

export type ProbeOutcome = { ok: true; result: ProbeResult } | { ok: false; error: string };

// -- raw ffprobe JSON (loosely typed -- fields are optional/string-typed) --

type RawDisposition = { default?: number; forced?: number };
type RawTags = { language?: string; title?: string; LANGUAGE?: string; TITLE?: string };
type RawStream = {
  index?: number;
  codec_name?: string;
  codec_type?: string;
  profile?: string;
  level?: number;
  width?: number;
  height?: number;
  pix_fmt?: string;
  color_space?: string;
  bits_per_raw_sample?: string;
  sample_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  display_aspect_ratio?: string;
  channels?: number;
  channel_layout?: string;
  sample_rate?: string;
  bit_rate?: string;
  tags?: RawTags;
  disposition?: RawDisposition;
};
type RawFormat = {
  format_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
};
export type RawProbe = { streams?: RawStream[]; format?: RawFormat };

// -- ffprobe invocation --

const DEFAULT_TIMEOUT_MS = 30_000;

/** Runs ffprobe against a URL and returns normalised results, or a typed error. */
export function probeUrl(
  url: string,
  opts: { ffprobePath?: string; timeoutMs?: number } = {},
): Promise<ProbeOutcome> {
  const bin = opts.ffprobePath ?? 'ffprobe';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', url];

  return new Promise<ProbeOutcome>((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, error: `failed to start ${bin}: ${(err as Error).message}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ ok: false, error: `ffprobe timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', (err: NodeJS.ErrnoException) => {
      const msg =
        err.code === 'ENOENT'
          ? `ffprobe not found (looked for "${bin}"). Install ffmpeg or pass --ffprobe-path.`
          : `ffprobe failed to run: ${err.message}`;
      done({ ok: false, error: msg });
    });

    child.on('close', (code) => {
      if (code !== 0) {
        done({ ok: false, error: `ffprobe exited ${code}${stderr ? `: ${stderr.trim()}` : ''}` });
        return;
      }
      let raw: RawProbe;
      try {
        raw = JSON.parse(stdout) as RawProbe;
      } catch {
        done({ ok: false, error: 'ffprobe returned invalid JSON' });
        return;
      }
      done({ ok: true, result: normaliseProbe(raw) });
    });
  });
}

/** Stable short signature of a source URL, stored to skip re-probing unchanged files. */
export function probeSignature(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 16);
}

// -- pure normalisation --

/** Maps raw ffprobe JSON into a typed, Plex-agnostic ProbeResult. Pure, no I/O. */
export function normaliseProbe(raw: RawProbe): ProbeResult {
  const streams: ProbeStream[] = [];
  for (const s of raw.streams ?? []) {
    const stream = normaliseStream(s);
    if (stream) streams.push(stream);
  }
  const format = raw.format ?? {};
  return {
    container: normaliseContainer(format.format_name),
    durationSec: numOrNull(format.duration),
    bitrate: intOrNull(format.bit_rate),
    sizeBytes: intOrNull(format.size),
    streams,
  };
}

function normaliseStream(s: RawStream): ProbeStream | null {
  const index = typeof s.index === 'number' ? s.index : 0;
  const codec = s.codec_name ?? '';
  const language = tagValue(s.tags, 'language');
  const title = tagValue(s.tags, 'title');
  const isDefault = s.disposition?.default === 1;
  const isForced = s.disposition?.forced === 1;

  switch (s.codec_type) {
    case 'video':
      return {
        kind: 'video',
        index,
        codec,
        width: typeof s.width === 'number' ? s.width : null,
        height: typeof s.height === 'number' ? s.height : null,
        frameRate: parseFrameRate(s.avg_frame_rate) ?? parseFrameRate(s.r_frame_rate),
        bitDepth: intOrNull(s.bits_per_raw_sample),
        profile: s.profile ?? null,
        level: typeof s.level === 'number' ? s.level : null,
        colorSpace: s.color_space ?? null,
        aspectRatio: s.display_aspect_ratio ?? null,
        bitrate: intOrNull(s.bit_rate),
        language,
        title,
        default: isDefault,
      };
    case 'audio':
      return {
        kind: 'audio',
        index,
        codec,
        channels: typeof s.channels === 'number' ? s.channels : null,
        channelLayout: s.channel_layout ?? null,
        sampleRate: intOrNull(s.sample_rate),
        bitrate: intOrNull(s.bit_rate),
        language,
        title,
        default: isDefault,
        forced: isForced,
      };
    case 'subtitle':
      return {
        kind: 'subtitle',
        index,
        codec,
        language,
        title,
        forced: isForced,
        default: isDefault,
      };
    default:
      // data / attachment / thumbnail streams are ignored
      return null;
  }
}

/** ffprobe format_name is a comma list (e.g. "mov,mp4,m4a,..."); pick a Plex-ish label. */
function normaliseContainer(formatName?: string): string | null {
  if (!formatName) return null;
  const names = formatName.split(',').map((n) => n.trim());
  if (names.some((n) => n === 'mp4' || n === 'mov')) return 'mp4';
  if (names.some((n) => n === 'matroska' || n === 'webm')) return 'mkv';
  return names[0] ?? null;
}

/** Parses an ffprobe rational frame rate like "24000/1001" into a rounded fps. */
function parseFrameRate(rate?: string): number | null {
  if (!rate) return null;
  const [numStr, denStr] = rate.split('/');
  const num = Number(numStr);
  const den = denStr === undefined ? 1 : Number(denStr);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const fps = num / den;
  return fps > 0 ? Math.round(fps * 1000) / 1000 : null;
}

function tagValue(tags: RawTags | undefined, key: 'language' | 'title'): string | null {
  if (!tags) return null;
  const val = key === 'language' ? (tags.language ?? tags.LANGUAGE) : (tags.title ?? tags.TITLE);
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  // ffprobe reports unknown language as "und"; treat as absent
  if (!trimmed || (key === 'language' && trimmed.toLowerCase() === 'und')) return null;
  return trimmed;
}

function numOrNull(val: string | undefined): number | null {
  if (val == null) return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(val: string | undefined): number | null {
  const n = numOrNull(val);
  return n == null ? null : Math.trunc(n);
}
