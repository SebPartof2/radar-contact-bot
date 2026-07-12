import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { handleInteraction, registerCommands, registerForGuild } from './commands.js';
import * as db from './db.js';
import { startTracker } from './tracker.js';

// GuildMessages carries message-delete events; it is not a privileged intent and we never
// read message content. Without it we would not notice someone deleting one of our embeds.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once(Events.ClientReady, async (ready) => {
  console.log(`[ready] logged in as ${ready.user.tag} in ${ready.guilds.cache.size} server(s)`);
  await registerCommands(ready);
  startTracker(ready);
});

// Invited to a new server — put the commands there right away.
client.on(Events.GuildCreate, async (guild) => {
  console.log(`[guild] joined ${guild.name} (${guild.id})`);
  await registerForGuild(guild.id);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    await handleInteraction(interaction);
  } catch (error) {
    console.error('[interaction] failed:', error);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  }
});

// Someone deleted one of our embeds by hand. Forget the session so the next poll re-posts it
// while that connection is still online.
client.on(Events.MessageDelete, (message) => {
  if (db.deleteSessionsByMessageIds([message.id]) > 0) {
    console.log(`[message] embed ${message.id} was deleted, will re-post on the next poll`);
  }
});

client.on(Events.MessageBulkDelete, (messages) => {
  const removed = db.deleteSessionsByMessageIds([...messages.keys()]);
  if (removed > 0) console.log(`[message] ${removed} embed(s) bulk-deleted, will re-post`);
});

// Kicked or the server was deleted — drop its config, watches, and sessions.
client.on(Events.GuildDelete, (guild) => {
  db.forgetGuild(guild.id);
  console.log(`[guild] removed from ${guild.id}, configuration dropped`);
});

process.on('unhandledRejection', (error) => console.error('[unhandledRejection]', error));

await client.login(config.token);
