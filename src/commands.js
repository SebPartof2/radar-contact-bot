import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from './config.js';
import * as db from './db.js';
import { retractAll, retractUnwatched } from './tracker.js';

const definition = new SlashCommandBuilder()
  .setName('rc')
  .setDescription('RC Notify — monitor VATSIM CIDs and position prefixes')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('setup')
      .setDescription('Set the notification channel and the role allowed to manage monitors')
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('Where online notifications are posted')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      )
      .addRoleOption((o) =>
        o
          .setName('role')
          .setDescription('Role allowed to add and remove monitors')
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('config').setDescription('Show this server’s RC Notify configuration'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('watch-cid')
      .setDescription('Monitor a VATSIM CID (pilot or controller)')
      .addStringOption((o) =>
        o.setName('cid').setDescription('VATSIM CID, e.g. 1234567').setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName('when')
          .setDescription('Notify when they are… (default: both)')
          .addChoices(
            { name: 'Flying or controlling', value: 'both' },
            { name: 'Flying only', value: 'pilot' },
            { name: 'Controlling only', value: 'controller' },
          ),
      )
      .addStringOption((o) =>
        o.setName('label').setDescription('Optional note, e.g. the person’s name'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('watch-prefix')
      .setDescription('Monitor a position prefix (everything before the underscore)')
      .addStringOption((o) =>
        o.setName('prefix').setDescription('Position prefix, e.g. SFO or ZOA').setRequired(true),
      )
      .addStringOption((o) => o.setName('label').setDescription('Optional note')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('unwatch-cid')
      .setDescription('Stop monitoring a CID')
      .addStringOption((o) => o.setName('cid').setDescription('VATSIM CID').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('unwatch-prefix')
      .setDescription('Stop monitoring a position prefix')
      .addStringOption((o) =>
        o.setName('prefix').setDescription('Position prefix').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('Show everything this server is monitoring'),
  );

const rest = new REST().setToken(config.token);
const body = [definition.toJSON()];

/**
 * Guild-only registration: it takes effect immediately, whereas global commands can take an
 * hour to propagate. Guild and global commands with the same name show up side by side rather
 * than overriding each other, so the global set is cleared to keep /rc from appearing twice.
 */
export async function registerCommands(client) {
  await rest
    .put(Routes.applicationCommands(config.clientId), { body: [] })
    .then(() => console.log('[commands] cleared global commands'))
    .catch((error) => console.error('[commands] clearing global commands failed:', error.message));

  await Promise.all([...client.guilds.cache.keys()].map((guildId) => registerForGuild(guildId)));
}

export async function registerForGuild(guildId) {
  try {
    await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), { body });
    console.log(`[commands] registered /rc in guild ${guildId}`);
  } catch (error) {
    // Almost always a missing applications.commands scope on the invite.
    console.error(`[commands] registration failed in guild ${guildId}:`, error.message);
  }
}

function canManage(interaction, guildConfig) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  // roles is a GuildMemberRoleManager when the guild is cached, a plain id array otherwise.
  const roles = interaction.member?.roles;
  return Array.isArray(roles)
    ? roles.includes(guildConfig.manager_role_id)
    : Boolean(roles?.cache?.has(guildConfig.manager_role_id));
}

const MODE_TEXT = {
  both: 'when flying or controlling',
  pilot: 'when flying',
  controller: 'when controlling',
};

const normalizeCid = (value) => value.trim();
const normalizePrefix = (value) => value.trim().toUpperCase().split('_')[0];

export async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'rc') return;
  if (!interaction.inGuild()) return;

  const reply = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  const guildId = interaction.guildId;
  const sub = interaction.options.getSubcommand();

  if (sub === 'setup') {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return reply('You need **Manage Server** to configure RC Notify.');
    }

    const channel = interaction.options.getChannel('channel');
    const role = interaction.options.getRole('role');

    const me = await interaction.guild.members.fetchMe();
    const perms = channel.permissionsFor(me);
    const missing = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ManageMessages'].filter(
      (p) => !perms?.has(PermissionFlagsBits[p]),
    );
    if (missing.length > 0) {
      return reply(`I am missing these permissions in ${channel}: ${missing.join(', ')}.`);
    }

    const previous = db.getGuildConfig(guildId);
    db.setGuildConfig(guildId, channel.id, role.id);
    await reply(`RC Notify will post in ${channel}. ${role} can manage monitors.`);

    if (previous && previous.channel_id !== channel.id) {
      // Live embeds belong to the old channel; clear them so they do not go stale there.
      // Sessions carry their own channel id, so this still finds them after the swap.
      await retractAll(interaction.client, guildId);
    }
    return;
  }

  const guildConfig = db.getGuildConfig(guildId);
  if (!guildConfig) {
    return reply('RC Notify is not set up here yet — run `/rc setup` first.');
  }

  if (sub === 'config') {
    return reply(
      `**Channel:** <#${guildConfig.channel_id}>\n` +
        `**Manager role:** <@&${guildConfig.manager_role_id}>\n` +
        `**Monitors:** ${db.listWatches(guildId).length}`,
    );
  }

  if (sub === 'list') {
    const watches = db.listWatches(guildId);
    if (watches.length === 0) return reply('Nothing is being monitored yet.');

    const lines = watches.map((w) => {
      const target =
        w.kind === 'cid'
          ? `CID \`${w.value}\` (${MODE_TEXT[w.mode] ?? 'when flying or controlling'})`
          : w.kind === 'position' || w.kind === 'facility'
            ? `${w.label ?? w.value}`
            : `\`${w.value}_*\``;
      const note = w.kind === 'cid' && w.label ? ` — ${w.label}` : '';
      return `• ${target}${note} (added by <@${w.added_by}>)`;
    });
    return reply(`**Monitored in this server:**\n${lines.join('\n')}`);
  }

  if (!canManage(interaction, guildConfig)) {
    return reply(`You need the <@&${guildConfig.manager_role_id}> role to manage monitors.`);
  }

  const label = interaction.options.getString('label');

  switch (sub) {
    case 'watch-cid': {
      const cid = normalizeCid(interaction.options.getString('cid'));
      if (!/^\d{5,10}$/.test(cid)) return reply(`\`${cid}\` is not a valid CID.`);

      const mode = interaction.options.getString('when') ?? 'both';
      const result = db.addWatch(guildId, 'cid', cid, label, interaction.user.id, mode);
      const when = MODE_TEXT[mode];

      if (result === 'unchanged') {
        return reply(`CID \`${cid}\` is already monitored ${when}.`);
      }
      return reply(
        result === 'updated'
          ? `CID \`${cid}\` now only notifies ${when}.`
          : `Now monitoring CID \`${cid}\` ${when}.`,
      );
    }

    case 'watch-prefix': {
      const prefix = normalizePrefix(interaction.options.getString('prefix'));
      if (!/^[A-Z0-9]{2,8}$/.test(prefix)) return reply(`\`${prefix}\` is not a valid prefix.`);
      const result = db.addWatch(guildId, 'prefix', prefix, label, interaction.user.id);
      return reply(
        result === 'added'
          ? `Now monitoring \`${prefix}_*\` positions.`
          : `\`${prefix}_*\` is already monitored.`,
      );
    }

    // Acknowledge before cleaning up messages — the interaction must be answered within 3s.
    case 'unwatch-cid': {
      const cid = normalizeCid(interaction.options.getString('cid'));
      const removed = db.removeWatch(guildId, 'cid', cid);
      await reply(
        removed ? `Stopped monitoring CID \`${cid}\`.` : `CID \`${cid}\` was not monitored.`,
      );
      if (removed) await retractUnwatched(interaction.client, guildId);
      return;
    }

    case 'unwatch-prefix': {
      const prefix = normalizePrefix(interaction.options.getString('prefix'));
      const removed = db.removeWatch(guildId, 'prefix', prefix);
      await reply(
        removed
          ? `Stopped monitoring \`${prefix}_*\` positions.`
          : `\`${prefix}_*\` was not monitored.`,
      );
      if (removed) await retractUnwatched(interaction.client, guildId);
      return;
    }
  }
}
