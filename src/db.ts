import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import os from 'os';
import type { ProbeResult, ProbeStream } from './probe';

export type StrmPart = {
  id: number;
  file: string;
  size: number | null;
  mediaItemId: number;
  extraData: string | null;
  strmSource: string | null;
};

export type UpdateOutcome = {
  urlUpdated: boolean; // file column changed
  sourceSeeded: boolean; // strm_source added to extra_data for the first time
};

const DEFAULT_DB_PATH = path.join(
  os.homedir(),
  'Library/Application Support/Plex/Plex Media Server/Plug-in Support/Databases/com.plexapp.plugins.library.db',
);

export function openDb(dbPath = DEFAULT_DB_PATH): DatabaseSync {
  // timeout: wait up to 5 s if Plex holds a brief write lock (DB is in WAL mode so reads never block us)
  return new DatabaseSync(dbPath, { timeout: 5000 });
}

/**
 * Finds the media_parts row for a given .strm file.
 * Tries three lookups in order:
 *   1. file = containerPath          (never patched yet)
 *   2. extra_data has strm_source    (patched by this tool)
 *   3. file = urlHint                (patched before strm_source tracking was added)
 */
export function findPartByContainerPath(
  db: DatabaseSync,
  containerPath: string,
  urlHints: string[] = [],
): StrmPart | null {
  const select = `
    SELECT id, file, size, media_item_id AS mediaItemId, extra_data AS extraData
    FROM media_parts
    WHERE deleted_at IS NULL AND `;

  // 1. File is still the .strm container path (never patched)
  const byFile = db.prepare(select + 'file = ?').get(containerPath) as RawPart | undefined;
  if (byFile) return toStrmPart(byFile);

  // 2. Previously patched by this tool -- strm_source recorded in extra_data
  // JSON pattern: {"strm_source":"/the/path"} -- container paths have no " so safe
  const pattern = `%"strm_source":${JSON.stringify(containerPath)}%`;
  const bySource = db.prepare(select + 'extra_data LIKE ?').get(pattern) as RawPart | undefined;
  if (bySource) return toStrmPart(bySource);

  // 3. Patched before strm_source tracking -- try matching by stored URL
  for (const hint of urlHints) {
    const byUrl = db.prepare(select + 'file = ?').get(hint) as RawPart | undefined;
    if (byUrl) return toStrmPart(byUrl);
  }

  return null;
}

export function updatePartFile(
  db: DatabaseSync,
  part: StrmPart,
  containerPath: string,
  url: string,
  dryRun: boolean,
): UpdateOutcome {
  // strmSource already set means this was patched before -- keep the original path.
  const sourceToStore = part.strmSource ?? containerPath;
  const newExtraData = injectStrmSource(part.extraData, sourceToStore);

  const urlChanged = part.file !== url;
  const sourceSeeded = part.strmSource === null;

  if (!urlChanged && !sourceSeeded) {
    return { urlUpdated: false, sourceSeeded: false };
  }

  if (!dryRun) {
    db.prepare(
      `UPDATE media_parts
       SET file = ?, extra_data = ?, updated_at = strftime('%s','now')
       WHERE id = ?`,
    ).run(url, newExtraData, part.id);
  }

  return { urlUpdated: urlChanged, sourceSeeded };
}

// -- types & helpers --

type RawPart = Omit<StrmPart, 'strmSource'> & { extraData: string | null };

function toStrmPart(raw: RawPart): StrmPart {
  return { ...raw, strmSource: parseStrmSource(raw.extraData) };
}

function parseStrmSource(extraData: string | null): string | null {
  if (!extraData) return null;
  try {
    const obj = JSON.parse(extraData) as Record<string, unknown>;
    const val = obj['strm_source'];
    return typeof val === 'string' ? val : null;
  } catch {
    return null;
  }
}

function injectStrmSource(extraData: string | null, strmPath: string): string {
  return mergeExtraData(extraData, { strm_source: strmPath });
}

/** Merges keys into the JSON object stored in media_parts.extra_data. */
function mergeExtraData(extraData: string | null, fields: Record<string, unknown>): string {
  let obj: Record<string, unknown> = {};
  if (extraData) {
    try {
      obj = JSON.parse(extraData) as Record<string, unknown>;
    } catch {
      obj = { _raw: extraData };
    }
  }
  Object.assign(obj, fields);
  return JSON.stringify(obj);
}

/** Reads a string field from the JSON object in media_parts.extra_data, or null. */
export function parseExtraDataField(extraData: string | null, key: string): string | null {
  if (!extraData) return null;
  try {
    const obj = JSON.parse(extraData) as Record<string, unknown>;
    const val = obj[key];
    return typeof val === 'string' ? val : null;
  } catch {
    return null;
  }
}

/**
 * Installs a BEFORE UPDATE trigger that prevents Plex rescans from reverting
 * proxy URLs back to .strm file paths.
 *
 * When Plex rescans and tries:
 *   UPDATE media_parts SET file = '/media/strm/...' WHERE id = ?
 * and the current value is our proxy URL, the trigger calls RAISE(IGNORE).
 * SQLite silently skips the update; Plex gets a success return with 0 rows
 * affected and carries on -- no errors, no crash, proxy URL stays intact.
 */
export function installGuardTrigger(db: DatabaseSync): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS strm_proxy_guard
    BEFORE UPDATE OF file ON media_parts
    WHEN NEW.file LIKE '%.strm' AND OLD.file LIKE 'http%strm-proxy%'
    BEGIN
      SELECT RAISE(IGNORE);
    END
  `);
}

export function guardTriggerExists(db: DatabaseSync): boolean {
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'strm_proxy_guard'`)
    .get();
  return row != null;
}

// -- probe results -> Plex DB --

export type ProbeWriteOutcome = {
  streamsWritten: number;
  itemUpdated: boolean;
  partUpdated: boolean;
};

/**
 * Writes real ffprobe results into the Plex DB, replacing the placeholder
 * streams with per-track rows and accurate media_items / media_parts fields.
 *
 * Robust to Plex schema differences across versions: every table's columns are
 * introspected with PRAGMA table_info and only existing columns are written, so
 * a column missing on one Plex version is skipped rather than erroring.
 *
 * Replacement is scoped to *embedded* streams (media_streams.url IS NULL) --
 * the placeholders this tool seeds. Sidecar subtitles Plex discovered carry a
 * url and are left untouched.
 *
 * `probeSig` is stored in media_parts.extra_data so the probe pass can skip a
 * part whose source URL is unchanged on the next run.
 */
export function writeProbedStreams(
  db: DatabaseSync,
  part: StrmPart,
  probe: ProbeResult,
  probeSig: string,
  dryRun: boolean,
): ProbeWriteOutcome {
  const streamCols = tableColumns(db, 'media_streams');
  const itemCols = tableColumns(db, 'media_items');
  const partCols = tableColumns(db, 'media_parts');
  const now = Math.floor(Date.now() / 1000);

  // 1. Replace embedded streams (keep Plex-discovered sidecar rows: url NOT NULL)
  if (!dryRun) {
    db.prepare(`DELETE FROM media_streams WHERE media_part_id = ? AND url IS NULL`).run(part.id);
  }
  for (const stream of probe.streams) {
    insertStream(db, part, stream, streamCols, now, dryRun);
  }

  // 2. media_items: codecs + geometry from the primary video/audio streams
  const video = probe.streams.find(
    (s): s is Extract<ProbeStream, { kind: 'video' }> => s.kind === 'video',
  );
  const audio = probe.streams.find(
    (s): s is Extract<ProbeStream, { kind: 'audio' }> => s.kind === 'audio',
  );
  const itemUpdates: Record<string, SqlValue> = {};
  if (video?.codec) itemUpdates['video_codec'] = video.codec;
  if (audio?.codec) itemUpdates['audio_codec'] = audio.codec;
  if (probe.container) itemUpdates['container'] = probe.container;
  if (video?.width != null) itemUpdates['width'] = video.width;
  if (video?.height != null) {
    itemUpdates['height'] = video.height;
    itemUpdates['video_resolution'] = resolutionLabel(video.height);
  }
  if (video?.width != null && video?.height != null && video.height !== 0) {
    itemUpdates['aspect_ratio'] = Math.round((video.width / video.height) * 100) / 100;
  }
  if (video?.frameRate != null) itemUpdates['frames_per_second'] = video.frameRate;
  if (audio?.channels != null) itemUpdates['audio_channels'] = audio.channels;
  if (probe.bitrate != null) itemUpdates['bitrate'] = Math.round(probe.bitrate / 1000); // kbps
  if (probe.durationSec != null) itemUpdates['duration'] = Math.round(probe.durationSec * 1000); // ms
  const itemUpdated = runUpdate(
    db,
    'media_items',
    itemUpdates,
    itemCols,
    'id',
    part.mediaItemId,
    dryRun,
  );

  // 3. media_parts: duration/size + probe bookkeeping in extra_data
  const partUpdates: Record<string, SqlValue> = {
    extra_data: mergeExtraData(part.extraData, { probe_sig: probeSig, probed_at: now }),
  };
  if (probe.durationSec != null) partUpdates['duration'] = Math.round(probe.durationSec * 1000);
  if (probe.sizeBytes != null) partUpdates['size'] = probe.sizeBytes;
  const partUpdated = runUpdate(db, 'media_parts', partUpdates, partCols, 'id', part.id, dryRun);

  return { streamsWritten: probe.streams.length, itemUpdated, partUpdated };
}

type SqlValue = string | number | null;

/** Inserts one probed stream, writing only columns present in this Plex schema. */
function insertStream(
  db: DatabaseSync,
  part: StrmPart,
  s: ProbeStream,
  cols: Set<string>,
  now: number,
  dryRun: boolean,
): void {
  const row: Record<string, SqlValue> = {
    stream_type_id: s.kind === 'video' ? 1 : s.kind === 'audio' ? 2 : 3,
    media_item_id: part.mediaItemId,
    media_part_id: part.id,
    codec: s.codec || null,
    index: s.index,
    url: null,
    created_at: now,
    updated_at: now,
  };
  if (s.kind === 'audio') row['channels'] = s.channels;
  if (s.kind !== 'video' && s.language) {
    // ffprobe reports an ISO 639-2 code (e.g. "eng"). Plex keys language display
    // off language_code/language_tag; these are PRAGMA-guarded so absent columns
    // on older schemas are skipped.
    row['language'] = s.language;
    row['language_code'] = s.language;
    row['language_tag'] = s.language;
  }
  if ((s.kind === 'video' || s.kind === 'audio') && s.bitrate != null) {
    row['bitrate'] = Math.round(s.bitrate / 1000); // kbps
  }
  const extra = encodeStreamExtraData(s);
  if (extra) row['extra_data'] = extra;

  const keys = Object.keys(row).filter((k) => cols.has(k));
  if (keys.length === 0 || dryRun) return;
  const sql = `INSERT INTO media_streams (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys
    .map(() => '?')
    .join(', ')})`;
  db.prepare(sql).run(...keys.map((k) => row[k]));
}

/**
 * Best-effort per-stream attributes for media_streams.extra_data, using Plex's
 * `ma:`-namespaced URL-encoded form. First-class columns above carry the data
 * Plex reliably displays; these deeper attributes (profile, bit depth, colour,
 * forced/default, track title) are layered on top and should be spot-checked
 * against a live Plex DB, as the exact key set varies by Plex version.
 */
function encodeStreamExtraData(s: ProbeStream): string {
  const kv: Record<string, string | number> = {};
  if (s.kind === 'video') {
    if (s.profile) kv['ma:profile'] = s.profile;
    if (s.bitDepth != null) kv['ma:bitDepth'] = s.bitDepth;
    if (s.colorSpace) kv['ma:colorSpace'] = s.colorSpace;
    if (s.frameRate != null) kv['ma:frameRate'] = s.frameRate;
    if (s.level != null) kv['ma:level'] = s.level;
  } else if (s.kind === 'audio') {
    if (s.channelLayout) kv['ma:audioChannelLayout'] = s.channelLayout;
    if (s.sampleRate != null) kv['ma:samplingRate'] = s.sampleRate;
    if (s.title) kv['ma:title'] = s.title;
    if (s.default) kv['ma:default'] = 1;
    if (s.forced) kv['ma:forced'] = 1;
  } else {
    if (s.title) kv['ma:title'] = s.title;
    if (s.forced) kv['ma:forced'] = 1;
    if (s.default) kv['ma:default'] = 1;
  }
  return Object.entries(kv)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/** Maps a pixel height to Plex's video_resolution label. */
function resolutionLabel(height: number): string {
  if (height >= 2000) return '4k';
  if (height >= 1400) return '1440';
  if (height >= 900) return '1080';
  if (height >= 700) return '720';
  if (height >= 560) return '576';
  if (height >= 460) return '480';
  return 'sd';
}

/** Runs a dynamic UPDATE, writing only columns present in the table. Returns true if it wrote. */
function runUpdate(
  db: DatabaseSync,
  table: string,
  updates: Record<string, SqlValue>,
  cols: Set<string>,
  whereCol: string,
  whereVal: SqlValue,
  dryRun: boolean,
): boolean {
  const keys = Object.keys(updates).filter((k) => cols.has(k));
  if (keys.length === 0) return false;
  if (dryRun) return true;
  const setSql = keys.map((k) => `"${k}" = ?`).join(', ');
  const touch = cols.has('updated_at') ? `, "updated_at" = strftime('%s','now')` : '';
  db.prepare(`UPDATE ${table} SET ${setSql}${touch} WHERE "${whereCol}" = ?`).run(
    ...keys.map((k) => updates[k]),
    whereVal,
  );
  return true;
}

const columnCache = new Map<string, Set<string>>();

/** Returns the set of column names for a table (cached), via PRAGMA table_info. */
function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const cols = new Set(rows.map((r) => r.name));
  columnCache.set(table, cols);
  return cols;
}

export { DEFAULT_DB_PATH };
