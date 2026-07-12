import { fileURLToPath } from 'node:url';
import express from 'express';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { config, OAUTH_REDIRECT_PATH } from '../config.js';
import * as db from '../db.js';
import { getLive, retractAll, retractUnwatched } from '../tracker.js';
import { positionPrefix } from '../vatsim.js';
import { completeLogin, getAccess, loginUrl, logout, requireUser } from './auth.js';

const CHANNEL_PERMISSIONS = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ManageMessages'];
const staticDir = fileURLToPath(new URL('../../web/dist', import.meta.url));

export function startWebServer(client) {
  const app = express();
  app.use(express.json());

  /* --- auth --- */

  app.get('/auth/login', (req, res) => res.redirect(loginUrl(res)));

  app.get(OAUTH_REDIRECT_PATH, async (req, res) => {
    try {
      await completeLogin(req, res);
      res.redirect('/');
    } catch (error) {
      console.error('[web] login failed:', error.message);
      res.status(401).send('Sign-in failed. <a href="/auth/login">Try again</a>.');
    }
  });

  app.post('/api/logout', (req, res) => {
    logout(req, res);
    res.json({ ok: true });
  });

  /* --- api --- */

  const api = express.Router();
  api.use(requireUser);

  api.get('/me', async (req, res) => {
    const guilds = [];
    for (const guild of client.guilds.cache.values()) {
      const access = await getAccess(client, guild.id, req.user.id);
      if (!access) continue;
      guilds.push({
        id: guild.id,
        name: guild.name,
        icon: guild.icon,
        isAdmin: access.isAdmin,
        configured: Boolean(access.guildConfig),
      });
    }
    res.json({ user: req.user, guilds: guilds.sort((a, b) => a.name.localeCompare(b.name)) });
  });

  // Every route below is scoped to a guild the caller is allowed to manage.
  const guildRouter = express.Router({ mergeParams: true });
  guildRouter.use(async (req, res, next) => {
    const access = await getAccess(client, req.params.guildId, req.user.id);
    if (!access) return res.status(403).json({ error: 'No access to this server' });
    req.access = access;
    next();
  });

  guildRouter.get('/', (req, res) => {
    const { guild, guildConfig, isAdmin } = req.access;

    const me = guild.members.me;
    const channels = guild.channels.cache
      .filter(
        (channel) =>
          [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) &&
          CHANNEL_PERMISSIONS.every((p) => channel.permissionsFor(me)?.has(PermissionFlagsBits[p])),
      )
      .map((channel) => ({ id: channel.id, name: channel.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const roles = guild.roles.cache
      .filter((role) => !role.managed && role.id !== guild.id)
      .map((role) => ({ id: role.id, name: role.name, color: role.hexColor }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      isAdmin,
      config: guildConfig
        ? { channelId: guildConfig.channel_id, managerRoleId: guildConfig.manager_role_id }
        : null,
      channels,
      roles,
      watches: db.listWatches(guild.id).map((w) => ({
        kind: w.kind,
        value: w.value,
        label: w.label,
        addedBy: w.added_by,
        addedAt: w.added_at,
      })),
    });
  });

  guildRouter.get('/live', (req, res) => {
    const live = getLive(req.params.guildId).map(({ connection, watch }) => ({
      type: connection.type,
      cid: connection.cid,
      name: connection.name,
      callsign: connection.callsign,
      rating: connection.rating,
      logonTime: connection.logonTime,
      facility: connection.facility ?? null,
      frequency: connection.frequency ?? null,
      atis: connection.atis ?? null,
      flightPlan: connection.flightPlan ?? null,
      watch,
    }));
    res.json({ live: live.sort((a, b) => a.callsign.localeCompare(b.callsign)) });
  });

  guildRouter.put('/config', async (req, res) => {
    const { guild, guildConfig, isAdmin } = req.access;
    if (!isAdmin) return res.status(403).json({ error: 'Manage Server is required' });

    const { channelId, managerRoleId } = req.body ?? {};
    const channel = guild.channels.cache.get(channelId);
    const role = guild.roles.cache.get(managerRoleId);
    if (!channel) return res.status(400).json({ error: 'Unknown channel' });
    if (!role) return res.status(400).json({ error: 'Unknown role' });

    const permissions = channel.permissionsFor(guild.members.me);
    const missing = CHANNEL_PERMISSIONS.filter((p) => !permissions?.has(PermissionFlagsBits[p]));
    if (missing.length > 0) {
      return res.status(400).json({ error: `Missing in #${channel.name}: ${missing.join(', ')}` });
    }

    db.setGuildConfig(guild.id, channel.id, role.id);
    if (guildConfig && guildConfig.channel_id !== channel.id) {
      await retractAll(client, guild.id);
    }
    res.json({ ok: true });
  });

  guildRouter.post('/watches', (req, res) => {
    const { guild } = req.access;
    const { kind, label } = req.body ?? {};
    if (!db.getGuildConfig(guild.id)) {
      return res.status(400).json({ error: 'Set the channel and manager role first' });
    }

    if (kind === 'cid') {
      const cid = String(req.body.value ?? '').trim();
      if (!/^\d{5,10}$/.test(cid)) return res.status(400).json({ error: 'Invalid CID' });
      const added = db.addWatch(guild.id, 'cid', cid, label || null, req.user.id);
      return res.json({ ok: true, added });
    }

    if (kind === 'prefix') {
      const prefix = positionPrefix(String(req.body.value ?? '').trim());
      if (!/^[A-Z0-9]{2,8}$/.test(prefix)) return res.status(400).json({ error: 'Invalid prefix' });
      const added = db.addWatch(guild.id, 'prefix', prefix, label || null, req.user.id);
      return res.json({ ok: true, added });
    }

    res.status(400).json({ error: 'kind must be cid or prefix' });
  });

  guildRouter.delete('/watches/:kind/:value', async (req, res) => {
    const { guild } = req.access;
    const { kind, value } = req.params;
    if (!['cid', 'prefix'].includes(kind)) return res.status(400).json({ error: 'Unknown kind' });

    const removed = db.removeWatch(guild.id, kind, value);
    if (removed) await retractUnwatched(client, guild.id);
    res.json({ ok: true, removed });
  });

  api.use('/guilds/:guildId', guildRouter);
  app.use('/api', api);

  /* --- static dashboard --- */

  app.use(express.static(staticDir));
  app.get('*', (req, res) => res.sendFile('index.html', { root: staticDir }));

  app.listen(config.web.port, () => {
    console.log(`[web] dashboard listening on port ${config.web.port} (${config.web.baseUrl})`);
  });

  db.purgeExpiredWebSessions();
  setInterval(() => db.purgeExpiredWebSessions(), 60 * 60 * 1000);
}
