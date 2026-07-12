import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

mkdirSync(dirname(config.databasePath), { recursive: true });

const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS guilds (
    guild_id        TEXT PRIMARY KEY,
    channel_id      TEXT NOT NULL,
    manager_role_id TEXT NOT NULL,
    updated_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS watches (
    guild_id   TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('cid', 'prefix', 'position', 'facility')),
    value      TEXT NOT NULL,
    label      TEXT,
    added_by   TEXT NOT NULL,
    added_at   INTEGER NOT NULL,
    PRIMARY KEY (guild_id, kind, value)
  );

  CREATE TABLE IF NOT EXISTS nas_tree (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    json       TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS web_sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    username   TEXT NOT NULL,
    avatar     TEXT,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    guild_id     TEXT NOT NULL,
    key          TEXT NOT NULL,
    cid          TEXT NOT NULL,
    callsign     TEXT NOT NULL,
    message_id   TEXT NOT NULL,
    channel_id   TEXT NOT NULL,
    fingerprint  TEXT NOT NULL,
    missed_polls INTEGER NOT NULL DEFAULT 0,
    seen_at      INTEGER NOT NULL,
    PRIMARY KEY (guild_id, key)
  );
`);

/**
 * Existing databases have a watches table whose CHECK constraint only allows cid and prefix,
 * and SQLite cannot alter a constraint in place — the table has to be rebuilt. Guarded by
 * user_version so this runs exactly once.
 */
if (db.pragma('user_version', { simple: true }) < 1) {
  db.exec(`
    BEGIN;
    CREATE TABLE watches_new (
      guild_id   TEXT NOT NULL,
      kind       TEXT NOT NULL CHECK (kind IN ('cid', 'prefix', 'position', 'facility')),
      value      TEXT NOT NULL,
      label      TEXT,
      added_by   TEXT NOT NULL,
      added_at   INTEGER NOT NULL,
      PRIMARY KEY (guild_id, kind, value)
    );
    INSERT INTO watches_new SELECT guild_id, kind, value, label, added_by, added_at FROM watches;
    DROP TABLE watches;
    ALTER TABLE watches_new RENAME TO watches;
    PRAGMA user_version = 1;
    COMMIT;
  `);
  console.log('[db] migrated watches to allow vNAS position and facility watches');
}

/* --- guild configuration --- */

export function setGuildConfig(guildId, channelId, managerRoleId) {
  db.prepare(
    `INSERT INTO guilds (guild_id, channel_id, manager_role_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET
       channel_id      = excluded.channel_id,
       manager_role_id = excluded.manager_role_id,
       updated_at      = excluded.updated_at`,
  ).run(guildId, channelId, managerRoleId, Date.now());
}

export function getGuildConfig(guildId) {
  return db.prepare('SELECT * FROM guilds WHERE guild_id = ?').get(guildId);
}

export function listGuildConfigs() {
  return db.prepare('SELECT * FROM guilds').all();
}

export function forgetGuild(guildId) {
  db.prepare('DELETE FROM guilds WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM watches WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM sessions WHERE guild_id = ?').run(guildId);
}

/* --- watches --- */

export function addWatch(guildId, kind, value, label, addedBy) {
  const info = db
    .prepare(
      `INSERT INTO watches (guild_id, kind, value, label, added_by, added_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, kind, value) DO NOTHING`,
    )
    .run(guildId, kind, value, label ?? null, addedBy, Date.now());
  return info.changes > 0;
}

export function removeWatch(guildId, kind, value) {
  return (
    db
      .prepare('DELETE FROM watches WHERE guild_id = ? AND kind = ? AND value = ?')
      .run(guildId, kind, value).changes > 0
  );
}

export function listWatches(guildId) {
  return db
    .prepare('SELECT * FROM watches WHERE guild_id = ? ORDER BY kind, value')
    .all(guildId);
}

export function getWatchSets(guildId) {
  const rows = listWatches(guildId);
  const of = (kind) => new Set(rows.filter((r) => r.kind === kind).map((r) => r.value));
  return {
    cids: of('cid'),
    prefixes: of('prefix'),
    positions: of('position'),
    facilities: of('facility'),
    labels: new Map(rows.map((r) => [`${r.kind}:${r.value}`, r.label])),
  };
}

/* --- cached vNAS airspace tree --- */

export function saveNasTree(tree) {
  db.prepare(
    `INSERT INTO nas_tree (id, json, fetched_at) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`,
  ).run(JSON.stringify(tree), Date.now());
}

export function getNasTree() {
  const row = db.prepare('SELECT json, fetched_at FROM nas_tree WHERE id = 1').get();
  return row ? { tree: JSON.parse(row.json), fetchedAt: row.fetched_at } : null;
}

/* --- live sessions (one Discord message each) --- */

export function getSessions(guildId) {
  return db.prepare('SELECT * FROM sessions WHERE guild_id = ?').all(guildId);
}

export function getSession(guildId, key) {
  return db.prepare('SELECT * FROM sessions WHERE guild_id = ? AND key = ?').get(guildId, key);
}

export function upsertSession(session) {
  db.prepare(
    `INSERT INTO sessions
       (guild_id, key, cid, callsign, message_id, channel_id, fingerprint, missed_polls, seen_at)
     VALUES
       (@guild_id, @key, @cid, @callsign, @message_id, @channel_id, @fingerprint, 0, @seen_at)
     ON CONFLICT (guild_id, key) DO UPDATE SET
       message_id   = excluded.message_id,
       channel_id   = excluded.channel_id,
       fingerprint  = excluded.fingerprint,
       missed_polls = 0,
       seen_at      = excluded.seen_at`,
  ).run(session);
}

export function markSeen(guildId, key, fingerprint) {
  db.prepare(
    'UPDATE sessions SET missed_polls = 0, fingerprint = ?, seen_at = ? WHERE guild_id = ? AND key = ?',
  ).run(fingerprint, Date.now(), guildId, key);
}

export function incrementMissedPolls(guildId, key) {
  db.prepare(
    'UPDATE sessions SET missed_polls = missed_polls + 1 WHERE guild_id = ? AND key = ?',
  ).run(guildId, key);
  return db
    .prepare('SELECT missed_polls FROM sessions WHERE guild_id = ? AND key = ?')
    .get(guildId, key).missed_polls;
}

export function deleteSession(guildId, key) {
  db.prepare('DELETE FROM sessions WHERE guild_id = ? AND key = ?').run(guildId, key);
}

/** Someone deleted our embed by hand — forget it so the next poll posts a fresh one. */
export function deleteSessionsByMessageIds(messageIds) {
  if (messageIds.length === 0) return 0;
  const placeholders = messageIds.map(() => '?').join(', ');
  return db
    .prepare(`DELETE FROM sessions WHERE message_id IN (${placeholders})`)
    .run(...messageIds).changes;
}

export function getAllSessions() {
  return db.prepare('SELECT * FROM sessions').all();
}

/* --- web dashboard logins --- */

export function createWebSession(token, user, expiresAt) {
  db.prepare(
    'INSERT INTO web_sessions (token, user_id, username, avatar, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(token, user.id, user.username, user.avatar ?? null, expiresAt);
}

export function getWebSession(token) {
  const row = db.prepare('SELECT * FROM web_sessions WHERE token = ?').get(token);
  if (!row) return undefined;
  if (row.expires_at < Date.now()) {
    deleteWebSession(token);
    return undefined;
  }
  return row;
}

export function deleteWebSession(token) {
  db.prepare('DELETE FROM web_sessions WHERE token = ?').run(token);
}

export function purgeExpiredWebSessions() {
  db.prepare('DELETE FROM web_sessions WHERE expires_at < ?').run(Date.now());
}

export default db;
