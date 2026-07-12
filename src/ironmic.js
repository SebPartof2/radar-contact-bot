import { config } from './config.js';

const REFRESH_MS = 60 * 60 * 1000;
const TOP_N = 3;

/** APP and DEP are one iron mic category: the TRACON. */
const CATEGORIES = { APP: 'TRACON', DEP: 'TRACON' };
const category = (suffix) => CATEGORIES[suffix] ?? suffix;

export const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };

/** The iron mic runs on the calendar month: [first of this month, first of next month). */
export function monthWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

export async function fetchIronMic() {
  const { start, end } = monthWindow();
  const url = `${config.ironMicUrl}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;

  const response = await fetch(url, {
    headers: { 'User-Agent': 'RC-Notify (Discord bot)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Iron mic API returned ${response.status}`);
  return response.json();
}

/**
 * Ranks every callsign within its category and keeps the standings for the top three, plus the
 * runner-up just outside them — a third place needs to know who is breathing down its neck.
 */
export function rankCallsigns(feed) {
  const byCategory = new Map();

  for (const entry of feed.callsigns ?? []) {
    const cat = category(entry.suffix);
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(entry);
  }

  const standings = new Map();

  for (const [cat, entries] of byCategory) {
    const sorted = entries.sort((a, b) => b.durationSeconds - a.durationSeconds);

    for (let index = 0; index < Math.min(TOP_N, sorted.length); index++) {
      const entry = sorted[index];
      const above = sorted[index - 1];
      const below = sorted[index + 1];

      standings.set(`${entry.prefix}:${cat}`, {
        prefix: entry.prefix,
        suffix: entry.suffix,
        category: cat,
        rank: index + 1,
        hours: entry.durationSeconds / 3600,
        above: above && {
          callsign: `${above.prefix}_${above.suffix}`,
          gapHours: (above.durationSeconds - entry.durationSeconds) / 3600,
        },
        below: below && {
          callsign: `${below.prefix}_${below.suffix}`,
          gapHours: (entry.durationSeconds - below.durationSeconds) / 3600,
        },
      });
    }
  }

  return standings;
}

/* --- refreshed in the background; the embeds read the cached standings --- */

let standings = new Map();

/** The standing for a signed-in callsign, e.g. MEM_2_TWR -> MEM in the TWR category. */
export function getStanding(callsign) {
  const parts = String(callsign ?? '').toUpperCase().split('_');
  if (parts.length < 2) return null;

  const prefix = parts[0];
  const suffix = parts[parts.length - 1];
  return standings.get(`${prefix}:${category(suffix)}`) ?? null;
}

export async function startIronMicRefresh() {
  const refresh = async () => {
    try {
      standings = rankCallsigns(await fetchIronMic());
      console.log(`[ironmic] refreshed: ${standings.size} top-${TOP_N} standings`);
    } catch (error) {
      // Losing the iron mic data just drops the field from the embeds.
      console.error('[ironmic] refresh failed:', error.message);
    }
  };

  await refresh();
  setInterval(() => void refresh(), REFRESH_MS);
}
