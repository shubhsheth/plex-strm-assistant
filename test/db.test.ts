import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { findPartByContainerPath } from '../src/db';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(
    `CREATE TABLE media_parts (id INTEGER PRIMARY KEY, media_item_id INTEGER, file TEXT, size INTEGER, extra_data TEXT, deleted_at INTEGER);`,
  );
  return db;
}

const CONTAINER =
  '/media/radarr/Doctor Strange (2016)/Doctor Strange 2016 1080p BluRay x264 DTS-JYK.strm';

test('matches an unpatched .strm row by exact container path', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO media_parts (id, media_item_id, file) VALUES (1, 10, ?)`).run(CONTAINER);
  const part = findPartByContainerPath(db, CONTAINER);
  assert.equal(part?.id, 1);
});

test('matches a row previously patched by this tool via strm_source', () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO media_parts (id, media_item_id, file, extra_data) VALUES (2, 11, ?, ?)`,
  ).run('https://cdn.example/x.mkv', JSON.stringify({ strm_source: CONTAINER }));
  const part = findPartByContainerPath(db, CONTAINER);
  assert.equal(part?.id, 2);
});

test('matches a trigger-patched proxy URL (raw path, .strm -> .mp4)', () => {
  const db = freshDb();
  const stored =
    'http://strm-proxy:3000/Doctor Strange (2016)/Doctor Strange 2016 1080p BluRay x264 DTS-JYK.mp4';
  db.prepare(`INSERT INTO media_parts (id, media_item_id, file) VALUES (3, 12, ?)`).run(stored);
  // No hints and no strm_source: must still be found via the raw path-tail fallback.
  const part = findPartByContainerPath(db, CONTAINER);
  assert.equal(part?.id, 3);
});

test('refuses to guess when two rows share the same path tail', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO media_parts (id, media_item_id, file) VALUES (4, 13, ?)`).run(
    'http://a:3000/Doctor Strange (2016)/Doctor Strange 2016 1080p BluRay x264 DTS-JYK.mp4',
  );
  db.prepare(`INSERT INTO media_parts (id, media_item_id, file) VALUES (5, 14, ?)`).run(
    'http://b:3000/Doctor Strange (2016)/Doctor Strange 2016 1080p BluRay x264 DTS-JYK.mp4',
  );
  assert.equal(findPartByContainerPath(db, CONTAINER), null);
});

test('returns null when the file is genuinely absent', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO media_parts (id, media_item_id, file) VALUES (6, 15, ?)`).run(
    '/media/radarr/Other Movie (2020)/Other Movie.strm',
  );
  assert.equal(findPartByContainerPath(db, CONTAINER), null);
});

test('ignores soft-deleted rows', () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO media_parts (id, media_item_id, file, deleted_at) VALUES (7, 16, ?, 123)`,
  ).run(CONTAINER);
  assert.equal(findPartByContainerPath(db, CONTAINER), null);
});
