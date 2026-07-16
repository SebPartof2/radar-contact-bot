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

  -- Holes punched in a facility watch: "all of ZAB except PHX_S_TWR".
  CREATE TABLE IF NOT EXISTS exclusions (
    guild_id TEXT NOT NULL,
    kind     TEXT NOT NULL CHECK (kind IN ('position', 'facility')),
    value    TEXT NOT NULL,
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
    -- Which watch produced this message, so removing that watch can find it again.
    watch_kind   TEXT NOT NULL DEFAULT '',
    watch_value  TEXT NOT NULL DEFAULT '',
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

// Older sessions predate knowing which watch created them; the columns default to empty and
// those messages are simply reposted once.
if (db.pragma('user_version', { simple: true }) < 2) {
  const columns = db.pragma('table_info(sessions)').map((column) => column.name);
  if (!columns.includes('watch_kind')) {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN watch_kind TEXT NOT NULL DEFAULT '';
      ALTER TABLE sessions ADD COLUMN watch_value TEXT NOT NULL DEFAULT '';
    `);
  }
  db.pragma('user_version = 2');
  console.log('[db] migrated sessions to record their originating watch');
}

// A CID watch can be limited to when that person is flying, or controlling, or both.
// Existing watches keep the old behaviour, which was both.
if (db.pragma('user_version', { simple: true }) < 3) {
  const columns = db.pragma('table_info(watches)').map((column) => column.name);
  if (!columns.includes('mode')) {
    db.exec(`ALTER TABLE watches ADD COLUMN mode TEXT NOT NULL DEFAULT 'both'`);
  }
  db.pragma('user_version = 3');
  console.log('[db] migrated watches to support pilot/controller CID modes');
}

// Pilots can be sent to their own channel. NULL means "same channel as controllers", which is
// what every existing server does today.
if (db.pragma('user_version', { simple: true }) < 4) {
  const columns = db.pragma('table_info(guilds)').map((column) => column.name);
  if (!columns.includes('pilot_channel_id')) {
    db.exec('ALTER TABLE guilds ADD COLUMN pilot_channel_id TEXT');
  }
  db.pragma('user_version = 4');
  console.log('[db] migrated guilds to support a separate pilot channel');
}

// Iron mic tuning: how deep the podium goes (top 3 by default) and how often the standings
// refresh (hourly by default, never faster than every 10 minutes).
if (db.pragma('user_version', { simple: true }) < 5) {
  const columns = db.pragma('table_info(guilds)').map((column) => column.name);
  if (!columns.includes('ironmic_threshold')) {
    db.exec(`
      ALTER TABLE guilds ADD COLUMN ironmic_threshold INTEGER NOT NULL DEFAULT 3;
      ALTER TABLE guilds ADD COLUMN ironmic_refresh_minutes INTEGER NOT NULL DEFAULT 60;
    `);
  }
  db.pragma('user_version = 5');
  console.log('[db] migrated guilds to support iron mic settings');
}

/* --- guild configuration --- */

/** pilotChannelId of null means pilots are posted in the same channel as controllers. */
export function setGuildConfig(guildId, channelId, managerRoleId, pilotChannelId = null) {
  db.prepare(
    `INSERT INTO guilds (guild_id, channel_id, manager_role_id, pilot_channel_id, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET
       channel_id       = excluded.channel_id,
       manager_role_id  = excluded.manager_role_id,
       pilot_channel_id = excluded.pilot_channel_id,
       updated_at       = excluded.updated_at`,
  ).run(guildId, channelId, managerRoleId, pilotChannelId, Date.now());
}

/** Where a connection of this type belongs. Pilots fall back to the controller channel. */
export function channelFor(guildConfig, type) {
  return type === 'pilot'
    ? (guildConfig.pilot_channel_id ?? guildConfig.channel_id)
    : guildConfig.channel_id;
}

export const IRONMIC_MIN_REFRESH_MINUTES = 10;
export const IRONMIC_MAX_THRESHOLD = 25;

export function setIronMicSettings(guildId, threshold, refreshMinutes) {
  db.prepare(
    'UPDATE guilds SET ironmic_threshold = ?, ironmic_refresh_minutes = ? WHERE guild_id = ?',
  ).run(threshold, refreshMinutes, guildId);
}

/**
 * One fetcher serves every guild, so it runs at the fastest refresh any of them asked for —
 * a guild wanting 10-minute standings should not wait on another's daily setting.
 */
export function minIronMicRefreshMinutes() {
  const row = db.prepare('SELECT MIN(ironmic_refresh_minutes) AS minutes FROM guilds').get();
  return Math.max(IRONMIC_MIN_REFRESH_MINUTES, row?.minutes ?? 60);
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

/** Returns 'added', 'updated' (the mode changed) or 'unchanged'. */
export function addWatch(guildId, kind, value, label, addedBy, mode = 'both') {
  const existing = db
    .prepare('SELECT mode FROM watches WHERE guild_id = ? AND kind = ? AND value = ?')
    .get(guildId, kind, value);

  if (existing) {
    if (existing.mode === mode) return 'unchanged';
    // Re-adding a CID with a different mode retargets it rather than erroring.
    db.prepare(
      'UPDATE watches SET mode = ?, label = COALESCE(?, label) WHERE guild_id = ? AND kind = ? AND value = ?',
    ).run(mode, label ?? null, guildId, kind, value);
    return 'updated';
  }

  db.prepare(
    `INSERT INTO watches (guild_id, kind, value, label, added_by, added_at, mode)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(guildId, kind, value, label ?? null, addedBy, Date.now(), mode);
  return 'added';
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
    exclusions: getExclusionSets(guildId),
    // cid -> 'both' | 'pilot' | 'controller'
    cidModes: new Map(rows.filter((r) => r.kind === 'cid').map((r) => [r.value, r.mode])),
    labels: new Map(rows.map((r) => [`${r.kind}:${r.value}`, r.label])),
  };
}

/* --- exclusions: positions or facilities carved out of a facility watch --- */

export function addExclusion(guildId, kind, value) {
  return (
    db
      .prepare(
        `INSERT INTO exclusions (guild_id, kind, value) VALUES (?, ?, ?)
         ON CONFLICT (guild_id, kind, value) DO NOTHING`,
      )
      .run(guildId, kind, value).changes > 0
  );
}

export function removeExclusion(guildId, kind, value) {
  return (
    db
      .prepare('DELETE FROM exclusions WHERE guild_id = ? AND kind = ? AND value = ?')
      .run(guildId, kind, value).changes > 0
  );
}

export function listExclusions(guildId) {
  return db.prepare('SELECT kind, value FROM exclusions WHERE guild_id = ?').all(guildId);
}

export function getExclusionSets(guildId) {
  const rows = listExclusions(guildId);
  return {
    positions: new Set(rows.filter((r) => r.kind === 'position').map((r) => r.value)),
    facilities: new Set(rows.filter((r) => r.kind === 'facility').map((r) => r.value)),
  };
}

/** An exclusion outside every facility watch means nothing; drop it rather than let it rot. */
export function pruneExclusions(guildId, stillApplies) {
  for (const exclusion of listExclusions(guildId)) {
    if (!stillApplies(exclusion)) removeExclusion(guildId, exclusion.kind, exclusion.value);
  }
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
       (guild_id, key, cid, callsign, message_id, channel_id, fingerprint, missed_polls, seen_at,
        watch_kind, watch_value)
     VALUES
       (@guild_id, @key, @cid, @callsign, @message_id, @channel_id, @fingerprint, 0, @seen_at,
        @watch_kind, @watch_value)
     ON CONFLICT (guild_id, key) DO UPDATE SET
       message_id   = excluded.message_id,
       channel_id   = excluded.channel_id,
       fingerprint  = excluded.fingerprint,
       missed_polls = 0,
       seen_at      = excluded.seen_at,
       watch_kind   = excluded.watch_kind,
       watch_value  = excluded.watch_value`,
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
