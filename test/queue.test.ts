import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  backfillQueue,
  claimQueueBatch,
  createProbeQueueTable,
  enqueuePart,
  findPartById,
  markFailed,
  markProbed,
} from '../src/db';

/** A minimal in-memory DB with just enough of the Plex schema for queue tests. */
function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE media_parts (
      id INTEGER PRIMARY KEY,
      file TEXT,
      size INTEGER,
      media_item_id INTEGER,
      extra_data TEXT,
      deleted_at INTEGER
    );
  `);
  createProbeQueueTable(db);
  return db;
}

function queueRows(db: DatabaseSync): Array<{ media_part_id: number; attempts: number }> {
  const rows = db
    .prepare(`SELECT media_part_id, attempts FROM strm_probe_queue ORDER BY media_part_id`)
    .all() as Array<{ media_part_id: number; attempts: number }>;
  // node:sqlite returns null-prototype rows; normalise to plain objects for deepEqual.
  return rows.map((r) => ({ media_part_id: r.media_part_id, attempts: r.attempts }));
}

test('enqueuePart is idempotent', () => {
  const db = makeDb();
  enqueuePart(db, 42);
  enqueuePart(db, 42);
  assert.deepEqual(queueRows(db), [{ media_part_id: 42, attempts: 0 }]);
});

test('claimQueueBatch returns due items oldest-first up to the limit', () => {
  const db = makeDb();
  enqueuePart(db, 1);
  enqueuePart(db, 2);
  enqueuePart(db, 3);
  const batch = claimQueueBatch(db, 2);
  assert.deepEqual(
    batch.map((i) => i.mediaPartId),
    [1, 2],
  );
});

test('markProbed drains an item', () => {
  const db = makeDb();
  enqueuePart(db, 7);
  markProbed(db, 7);
  assert.deepEqual(queueRows(db), []);
});

test('markFailed backs off, hiding the item until next_attempt_at', () => {
  const db = makeDb();
  enqueuePart(db, 5);
  const now = Math.floor(Date.now() / 1000);

  const outcome = markFailed(db, 5, 'boom', { maxAttempts: 5, baseBackoffSec: 60 });
  assert.equal(outcome, 'retry');
  assert.deepEqual(queueRows(db), [{ media_part_id: 5, attempts: 1 }]);

  // Not yet due (backed off ~60s into the future)...
  assert.equal(claimQueueBatch(db, 10, now + 1).length, 0);
  // ...but due once the backoff window passes.
  assert.equal(claimQueueBatch(db, 10, now + 120).length, 1);
});

test('markFailed parks an item after maxAttempts', () => {
  const db = makeDb();
  enqueuePart(db, 9);
  const opts = { maxAttempts: 3, baseBackoffSec: 1 };
  assert.equal(markFailed(db, 9, 'e1', opts), 'retry');
  assert.equal(markFailed(db, 9, 'e2', opts), 'retry');
  assert.equal(markFailed(db, 9, 'e3', opts), 'parked');
  assert.deepEqual(queueRows(db), []);
});

test('backfillQueue enqueues only un-probed, non-deleted proxy rows', () => {
  const db = makeDb();
  const proxyBase = 'http://strm-proxy:3000';
  db.exec(`
    INSERT INTO media_parts (id, file, extra_data, deleted_at) VALUES
      (1, 'http://strm-proxy:3000/A.mp4', NULL, NULL),
      (2, 'http://strm-proxy:3000/B.mp4', '{"probe_sig":"abc123"}', NULL),
      (3, 'http://strm-proxy:3000/C.mp4', NULL, 1234),
      (4, '/media/strm/D.strm', NULL, NULL);
  `);
  const added = backfillQueue(db, proxyBase);
  assert.equal(added, 1);
  assert.deepEqual(
    queueRows(db).map((r) => r.media_part_id),
    [1],
  );

  // Re-running does not duplicate.
  assert.equal(backfillQueue(db, proxyBase), 0);
});

test('findPartById reads the row and parses strm_source; skips deleted', () => {
  const db = makeDb();
  db.exec(`
    INSERT INTO media_parts (id, file, size, media_item_id, extra_data, deleted_at) VALUES
      (1, 'http://strm-proxy:3000/A.mp4', 100, 55, '{"strm_source":"/media/strm/A.strm"}', NULL),
      (2, 'http://strm-proxy:3000/B.mp4', 0, 56, NULL, 999);
  `);
  const part = findPartById(db, 1);
  assert.ok(part);
  assert.equal(part!.id, 1);
  assert.equal(part!.mediaItemId, 55);
  assert.equal(part!.strmSource, '/media/strm/A.strm');

  assert.equal(findPartById(db, 2), null); // deleted
  assert.equal(findPartById(db, 999), null); // missing
});
