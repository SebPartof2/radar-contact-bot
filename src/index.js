import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { handleInteraction, registerCommands } from './commands.js';
import * as db from './db.js';
import { startTracker } from './tracker.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (ready) => {
  console.log(`[ready] logged in as ${ready.user.tag} in ${ready.guilds.cache.size} server(s)`);
  await registerCommands();
  startTracker(ready);
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

// Kicked or the server was deleted — drop its config, watches, and sessions.
client.on(Events.GuildDelete, (guild) => {
  db.forgetGuild(guild.id);
  console.log(`[guild] removed from ${guild.id}, configuration dropped`);
});

process.on('unhandledRejection', (error) => console.error('[unhandledRejection]', error));

await client.login(config.token);
