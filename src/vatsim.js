import { config } from './config.js';
import { getStanding } from './ironmic.js';

export const RATINGS = {
  '-1': 'INAC',
  0: 'SUS',
  1: 'OBS',
  2: 'S1',
  3: 'S2',
  4: 'S3',
  5: 'C1',
  6: 'C2',
  7: 'C3',
  8: 'I1',
  9: 'I2',
  10: 'I3',
  11: 'SUP',
  12: 'ADM',
};

export const FACILITIES = {
  0: 'OBS',
  1: 'FSS',
  2: 'DEL',
  3: 'GND',
  4: 'TWR',
  5: 'APP',
  6: 'CTR',
};

export async function fetchDataFeed() {
  const response = await fetch(config.dataFeedUrl, {
    headers: { 'User-Agent': 'RC-Notify (Discord bot)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`VATSIM data feed returned ${response.status}`);
  return response.json();
}

/** The part of a callsign before the first underscore, e.g. SFO_36_TWR -> SFO. */
export function positionPrefix(callsign) {
  return String(callsign || '').toUpperCase().split('_')[0];
}

function isAtis(callsign) {
  return String(callsign || '').toUpperCase().endsWith('_ATIS');
}

/**
 * vNAS re-files every plan a US controller touches as IFR, tucking the real rules into the
 * altitude as "VFR/45" or "VFR/OTP". Peel that prefix off: the remainder is the cruise
 * altitude and the rules are really VFR, whatever flight_rules claims.
 */
function parseCruise(plan) {
  const raw = String(plan.altitude ?? '').trim();
  const match = raw.match(/^VFR\s*\/?\s*(.*)$/i);
  if (match) return { cruise: match[1].trim(), rules: 'V' };
  return { cruise: raw, rules: plan.flight_rules || '' };
}

/**
 * Flattens the feed into a uniform list of connections we are willing to report on.
 * Observers are dropped on the controller side; every pilot counts.
 */
export function extractConnections(feed) {
  const connections = [];

  for (const pilot of feed.pilots ?? []) {
    const plan = pilot.flight_plan;
    connections.push({
      type: 'pilot',
      cid: String(pilot.cid),
      name: pilot.name,
      callsign: pilot.callsign,
      logonTime: pilot.logon_time,
      server: pilot.server,
      altitude: pilot.altitude,
      groundspeed: pilot.groundspeed,
      flightPlan: plan
        ? {
            departure: plan.departure || '????',
            arrival: plan.arrival || '????',
            alternate: plan.alternate || '',
            route: plan.route || '',
            aircraft: plan.aircraft_short || plan.aircraft_faa || plan.aircraft || '',
            ...parseCruise(plan),
            deptime: plan.deptime || '',
          }
        : null,
    });
  }

  for (const controller of feed.controllers ?? []) {
    // OBS positions (and anyone still holding an Observer rating) are not "on position".
    if (controller.facility === 0 || controller.rating <= 1) continue;
    if (isAtis(controller.callsign)) continue;

    connections.push({
      type: 'controller',
      cid: String(controller.cid),
      name: controller.name,
      callsign: controller.callsign,
      rating: RATINGS[controller.rating] ?? String(controller.rating),
      facility: FACILITIES[controller.facility] ?? String(controller.facility),
      frequency: controller.frequency,
      logonTime: controller.logon_time,
      server: controller.server,
      atis: (controller.text_atis ?? []).join('\n').trim(),
    });
  }

  // feed.atis[] is a separate array of ATIS "controllers" — intentionally ignored.
  return connections;
}

/**
 * Which watch, if any, this connection matches. Prefix watches apply to controllers only;
 * position and facility watches additionally need vNAS, which is the only feed that knows
 * every position a controller is actually working.
 */
export function matchWatch(connection, watches, nas) {
  const { cids, prefixes, positions, facilities, exclusions, cidModes } = watches;

  if (cids.has(connection.cid)) {
    // A CID watch can be limited to only when that person is flying, or only controlling.
    const mode = cidModes?.get(connection.cid) ?? 'both';
    if (mode === 'both' || mode === connection.type) {
      return { kind: 'cid', value: connection.cid };
    }
  }
  if (connection.type !== 'controller') return null;

  const prefix = positionPrefix(connection.callsign);
  if (prefixes.has(prefix)) return { kind: 'prefix', value: prefix };

  const vnas = connection.vnas;
  if (!vnas) return null;

  /** Has this position been carved out of the facility watch that would otherwise cover it? */
  const excluded = (position) => {
    if (exclusions.positions.has(position.positionId)) return true;
    // An excluded TRACON hides every tower beneath it, so check the whole chain upward.
    for (const facilityId of nas.facilityAncestors(position.facilityId)) {
      if (exclusions.facilities.has(facilityId)) return true;
    }
    return false;
  };

  // Every position they hold counts, not just the one they are signed in as: a Center
  // controller covering PHX_A_APP top-down is working Phoenix Approach.
  for (const position of [vnas.primary, ...vnas.topDown]) {
    // An explicitly ticked position always wins, even inside an excluded facility.
    if (positions.has(position.positionId)) {
      return { kind: 'position', value: position.positionId };
    }
    if (excluded(position)) continue;

    for (const facilityId of facilities) {
      if (nas.facilityCovers(facilityId, position.facilityId)) {
        return { kind: 'facility', value: facilityId };
      }
    }
  }

  return null;
}

/** Session identity: one Discord message per (cid, callsign) connection. */
export function sessionKey(connection) {
  return `${connection.cid}:${connection.callsign.toUpperCase()}`;
}

/** Changes to these fields cause the existing embed to be edited in place. */
export function fingerprint(connection, ironMicThreshold = 3) {
  if (connection.type === 'controller') {
    const v = connection.vnas;
    // Only a standing inside this guild's threshold appears on the embed, so only that can
    // invalidate it — a #7 rank changing hours must not churn a top-3 guild's messages.
    const standing = v && getStanding(connection.callsign);
    const shown = standing && standing.rank <= ironMicThreshold ? standing : null;
    return JSON.stringify([
      connection.frequency,
      connection.facility,
      connection.atis,
      // Picking up or dropping a top-down position rewrites the embed.
      v && [v.primary.positionId, v.primary.frequency, v.controllerInfo, v.positionIds],
      shown && [shown.rank, shown.hours.toFixed(1)],
    ]);
  }
  const p = connection.flightPlan;
  return JSON.stringify(
    p ? [p.departure, p.arrival, p.route, p.aircraft, p.cruise, p.rules] : ['no-plan'],
  );
}
