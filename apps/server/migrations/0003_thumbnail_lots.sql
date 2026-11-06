-- The thumbnail lots (docs/FEATURES.md, D3): every hour, one lot per group of the sync stream, a
-- fixed number of fragments sealed for devices, padded with decoys. One row per lot, at the fixed
-- position of its hour of the week and its group, overwritten a week later: no date, no delete.
CREATE TABLE lots (
  position INTEGER NOT NULL PRIMARY KEY,
  blob BLOB NOT NULL
) WITHOUT ROWID;
