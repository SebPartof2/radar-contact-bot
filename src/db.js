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
    kind       TEXT NOT NULL CHECK (kind IN ('cid', 'prefix')),
    value      TEXT NOT NULL,
    label      TEXT,
    added_by   TEXT NOT NULL,
    added_at   INTEGER NOT NULL,
    PRIMARY KEY (guild_id, kind, value)
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
  return {
    cids: new Set(rows.filter((r) => r.kind === 'cid').map((r) => r.value)),
    prefixes: new Set(rows.filter((r) => r.kind === 'prefix').map((r) => r.value)),
    labels: new Map(rows.map((r) => [`${r.kind}:${r.value}`, r.label])),
  };
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

export default db;
