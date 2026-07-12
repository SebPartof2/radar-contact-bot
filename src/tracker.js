import { config } from './config.js';
import * as db from './db.js';
import { buildEmbed } from './embeds.js';
import { fetchVnasFeed, indexVnasControllers } from './vnas.js';
import { facilityAncestors, facilityCovers } from './nas.js';

const nas = { facilityAncestors, facilityCovers };
import {
  extractConnections,
  fetchDataFeed,
  fingerprint,
  matchWatch,
  positionPrefix,
  sessionKey,
} from './vatsim.js';

/** Last poll's matched connections per guild, so the dashboard can render a live view. */
const liveByGuild = new Map();

export function getLive(guildId) {
  return liveByGuild.get(guildId) ?? [];
}

export function startTracker(client) {
  const tick = () => poll(client).catch((error) => console.error('[poll] failed:', error.message));
  reconcileSessions(client)
    .catch((error) => console.error('[reconcile] failed:', error.message))
    .finally(() => {
      tick();
      setInterval(tick, config.pollIntervalMs);
    });
}

/**
 * Embeds can be deleted while we are offline, and we would never notice: nothing about the
 * connection changed, so the poll would keep marking the session seen and never touch Discord.
 * Drop any session whose message is gone so the next poll re-announces it.
 */
async function reconcileSessions(client) {
  for (const session of db.getAllSessions()) {
    try {
      const channel = await client.channels.fetch(session.channel_id);
      await channel.messages.fetch(session.message_id);
    } catch {
      db.deleteSession(session.guild_id, session.key);
      console.log(`[${session.guild_id}] embed for ${session.callsign} is gone, will re-post`);
    }
  }
}

/** One fetch of each feed per tick, fanned out to every configured guild. */
async function poll(client) {
  const guilds = db.listGuildConfigs();
  if (guilds.length === 0) return;

  // vNAS is enrichment, not the source of truth for who is online: if it fails we still report
  // everyone from the VATSIM feed, just with the plainer embed.
  const [feed, vnasFeed] = await Promise.all([
    fetchDataFeed(),
    fetchVnasFeed().catch((error) => {
      console.warn('[poll] vNAS feed unavailable:', error.message);
      return null;
    }),
  ]);

  const vnasByCallsign = vnasFeed ? indexVnasControllers(vnasFeed) : new Map();
  const connections = extractConnections(feed).map((connection) =>
    connection.type === 'controller'
      ? { ...connection, vnas: vnasByCallsign.get(connection.callsign.toUpperCase()) ?? null }
      : connection,
  );

  for (const guild of guilds) {
    try {
      await syncGuild(client, guild, connections);
    } catch (error) {
      console.error(`[poll] guild ${guild.guild_id} failed:`, error.message);
    }
  }
}

async function syncGuild(client, guild, connections) {
  const channel = await client.channels.fetch(guild.channel_id);
  const watches = db.getWatchSets(guild.guild_id);

  const online = new Map();
  for (const connection of connections) {
    const watch = matchWatch(connection, watches, nas);
    if (watch) online.set(sessionKey(connection), { connection, watch });
  }

  liveByGuild.set(guild.guild_id, [...online.values()]);

  for (const [key, { connection, watch }] of online) {
    const label = watches.labels.get(`${watch.kind}:${watch.value}`);
    const existing = db.getSession(guild.guild_id, key);
    const stamp = fingerprint(connection);

    if (!existing) {
      await announce(channel, guild.guild_id, key, connection, watch, label, stamp);
    } else if (existing.fingerprint !== stamp) {
      await update(channel, existing, connection, watch, label, stamp);
    } else {
      db.markSeen(guild.guild_id, key, stamp);
    }
  }

  for (const session of db.getSessions(guild.guild_id)) {
    if (online.has(session.key)) continue;
    // The feed drops entries for a tick now and then, so require a few misses in a row.
    const missed = db.incrementMissedPolls(guild.guild_id, session.key);
    if (missed >= config.missedPollsBeforeOffline) await retract(client, session);
  }
}

async function announce(channel, guildId, key, connection, watch, label, stamp) {
  const message = await channel.send({ embeds: [buildEmbed(connection, watch, label)] });
  db.upsertSession({
    guild_id: guildId,
    key,
    cid: connection.cid,
    callsign: connection.callsign,
    message_id: message.id,
    channel_id: channel.id,
    fingerprint: stamp,
    seen_at: Date.now(),
    watch_kind: watch.kind,
    watch_value: watch.value,
  });
  console.log(`[${guildId}] online: ${connection.callsign} (${connection.cid})`);
}

async function update(channel, session, connection, watch, label, stamp) {
  try {
    const message = await channel.messages.fetch(session.message_id);
    await message.edit({ embeds: [buildEmbed(connection, watch, label)] });
    db.markSeen(session.guild_id, session.key, stamp);
  } catch (error) {
    // Message was deleted out from under us, or the notify channel moved — post a fresh one.
    console.warn(`[${session.guild_id}] re-posting ${session.callsign}: ${error.message}`);
    db.deleteSession(session.guild_id, session.key);
    await announce(channel, session.guild_id, session.key, connection, watch, label, stamp);
  }
}

async function retract(client, session) {
  try {
    const channel = await client.channels.fetch(session.channel_id);
    const message = await channel.messages.fetch(session.message_id);
    await message.delete();
  } catch {
    // Already gone; nothing to remove.
  }
  db.deleteSession(session.guild_id, session.key);
  console.log(`[${session.guild_id}] offline: ${session.callsign} (${session.cid})`);
}

/**
 * Called after a watch is removed so its messages disappear without waiting for a poll. Each
 * session records the watch that produced it, so this is an exact lookup rather than a guess —
 * a session created by a facility watch is not collateral damage when a CID watch is removed.
 */
export async function retractUnwatched(client, guildId) {
  const live = new Set(db.listWatches(guildId).map((watch) => `${watch.kind}:${watch.value}`));

  for (const session of db.getSessions(guildId)) {
    if (live.has(`${session.watch_kind}:${session.watch_value}`)) continue;
    await retract(client, session);
  }
}

/** Called when the notify channel changes so stale embeds do not linger in the old one. */
export async function retractAll(client, guildId) {
  for (const session of db.getSessions(guildId)) {
    await retract(client, session);
  }
}
