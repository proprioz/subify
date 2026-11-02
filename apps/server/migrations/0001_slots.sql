-- The catalog (docs/FEATURES.md, D16). Every row of the catalog's tables is (id or position, blob):
-- ids are random or derived from secrets, positions are fixed, every blob of a table has the same
-- size, and no table keeps a rowid, so nothing stored tells what a row holds, nor when it was
-- written. Only src/catalog/vault.ts reads or writes them; the dictionary is public data.

-- One channel or one decoy per row, rewritten whole at every pass.
CREATE TABLE slots (
  id BLOB NOT NULL PRIMARY KEY,
  blob BLOB NOT NULL
) WITHOUT ROWID;

-- Rows at fixed positions, each one payload: the catalog's state, users' additions by hour of
-- day, the seed pool, the handle index's bounds.
CREATE TABLE vault (
  id INTEGER NOT NULL PRIMARY KEY,
  blob BLOB NOT NULL
) WITHOUT ROWID;

-- The thumbnail ring: one case per row, at a fixed
-- position, every blob the same size. Each pass overwrites the same number of cases, the oldest
-- first, so an old thumbnail goes when the ring wraps over it: no date, no delete.
CREATE TABLE thumbnails (
  position INTEGER NOT NULL PRIMARY KEY,
  blob BLOB NOT NULL
) WITHOUT ROWID;

-- The sync stream: a ring of batches, one per pass at
-- the position of its pass number, overwritten when the ring wraps after 30 days: no date, no
-- delete. Each batch holds a fixed number of entries, sealed for devices, padded with decoys.
CREATE TABLE stream (
  position INTEGER NOT NULL PRIMARY KEY,
  blob BLOB NOT NULL
) WITHOUT ROWID;

-- The handle index: chunks of sorted entries, one row
-- per chunk at its position, rewritten whole by the pass once an hour. The number of chunks
-- depends on the table's size alone.
CREATE TABLE handles (
  position INTEGER NOT NULL PRIMARY KEY,
  blob BLOB NOT NULL
) WITHOUT ROWID;

-- The Wikidata dictionary: public data, the YouTube channels Wikidata
-- names, which devices download whole to find a channel by its name on the device. One slice per
-- row, by the third character of the channel id, gzipped. Rewritten outside the pass, one slice a
-- minute while a refresh runs. Only src/search/dictionary.ts reads or writes these tables.
CREATE TABLE dictionary (
  slice INTEGER NOT NULL PRIMARY KEY,
  data BLOB NOT NULL
) WITHOUT ROWID;

-- Where the refresh stands, in one row: the next slice to read, when to read it, and when the
-- last full refresh ended (null before the first): a device downloads the dictionary again when
-- this is newer than its copy.
CREATE TABLE dictionary_state (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  next_slice INTEGER NOT NULL,
  next_at INTEGER NOT NULL,
  version INTEGER
) WITHOUT ROWID;
