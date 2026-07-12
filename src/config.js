function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  token: required('DISCORD_TOKEN'),
  clientId: required('DISCORD_CLIENT_ID'),

  dataFeedUrl: process.env.VATSIM_DATA_URL || 'https://data.vatsim.net/v3/vatsim-data.json',
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 15_000),
  // How many consecutive polls a session may be absent from the feed before we
  // call it a disconnect. The feed occasionally drops entries for a single tick.
  missedPollsBeforeOffline: Number(process.env.MISSED_POLLS_BEFORE_OFFLINE || 2),

  databasePath: process.env.DATABASE_PATH || '/data/rcnotify.sqlite',
};
