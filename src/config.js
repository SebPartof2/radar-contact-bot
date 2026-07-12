function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  token: required('DISCORD_TOKEN'),
  clientId: required('DISCORD_CLIENT_ID'),

  dataFeedUrl: process.env.VATSIM_DATA_URL || 'https://data.vatsim.net/v3/vatsim-data.json',
  // vNAS knows what US controllers are really working; it wins over the VATSIM feed on a
  // callsign match. If it is unreachable the bot falls back to VATSIM-only data.
  vnasFeedUrl:
    process.env.VNAS_DATA_URL || 'https://live.env.vnas.vatsim.net/data-feed/controllers.json',
  // The full airspace definition: every ARTCC, facility and position. Fetched once a day.
  nasApiUrl: process.env.VNAS_ARTCC_API_URL || 'https://data-api.vnas.vatsim.net/api/artccs/',
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 15_000),
  // How many consecutive polls a session may be absent from the feed before we
  // call it a disconnect. The feed occasionally drops entries for a single tick.
  missedPollsBeforeOffline: Number(process.env.MISSED_POLLS_BEFORE_OFFLINE || 2),

  databasePath: process.env.DATABASE_PATH || '/data/rcnotify.sqlite',

  web: {
    // The dashboard only starts when an OAuth secret and a public URL are configured.
    enabled: Boolean(process.env.DISCORD_CLIENT_SECRET && process.env.BASE_URL),
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    baseUrl: (process.env.BASE_URL || '').replace(/\/$/, ''),
    port: Number(process.env.PORT || 3000),
    sessionTtlMs: Number(process.env.SESSION_TTL_MS || 7 * 24 * 60 * 60 * 1000),
  },
};

export const OAUTH_REDIRECT_PATH = '/auth/callback';
