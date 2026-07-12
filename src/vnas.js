import { config } from './config.js';

/** vNAS spells ratings out; the embeds use the short form everyone reads. */
const RATINGS = {
  Observer: 'OBS',
  Student1: 'S1',
  Student2: 'S2',
  Student3: 'S3',
  Controller1: 'C1',
  Controller2: 'C2',
  Controller3: 'C3',
  Instructor1: 'I1',
  Instructor2: 'I2',
  Instructor3: 'I3',
  Supervisor: 'SUP',
  Administrator: 'ADM',
};

/** Positions whose title carries a sector/area name worth showing next to the radio name. */
const SUFFIXES_WITH_POSITION_NAME = ['APP', 'CTR', 'TMU'];

export async function fetchVnasFeed() {
  const response = await fetch(config.vnasFeedUrl, {
    headers: { 'User-Agent': 'RC-Notify (Discord bot)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`vNAS feed returned ${response.status}`);
  return response.json();
}

/** vNAS reports frequencies in Hz: 132200000 -> "132.200". */
export function formatFrequency(hz) {
  return typeof hz === 'number' ? (hz / 1_000_000).toFixed(3) : '—';
}

export function showsPositionName(callsign) {
  const suffix = String(callsign || '').toUpperCase().split('_').pop();
  return SUFFIXES_WITH_POSITION_NAME.includes(suffix);
}

/**
 * Keyed by callsign, since that is what the VATSIM data feed gives us to join on.
 * A vNAS controller works several positions at once: the primary one is the callsign they are
 * signed in as, and the rest are what they are covering top-down.
 */
export function indexVnasControllers(feed) {
  const byCallsign = new Map();

  for (const controller of feed.controllers ?? []) {
    if (!controller.isActive || controller.isObserver) continue;

    const callsign = controller.vatsimData?.callsign;
    if (!callsign) continue;

    const active = (controller.positions ?? []).filter((position) => position.isActive);
    const primary =
      active.find((position) => position.positionId === controller.primaryPositionId) ??
      active.find((position) => position.isPrimary) ??
      active[0];
    if (!primary) continue;

    byCallsign.set(callsign.toUpperCase(), {
      cid: String(controller.vatsimData.cid),
      callsign,
      // realName is the CID again when the controller hides it; the caller falls back to
      // the VATSIM feed's name in that case.
      realName: controller.vatsimData.realName,
      rating: RATINGS[controller.vatsimData.userRating] ?? controller.vatsimData.userRating,
      controllerInfo: (controller.vatsimData.controllerInfo ?? '').trim(),
      artccId: controller.artccId,
      loginTime: controller.loginTime,
      primary: {
        facilityId: primary.facilityId,
        facilityName: primary.facilityName,
        positionId: primary.positionId,
        positionName: primary.positionName,
        radioName: primary.radioName,
        frequency: formatFrequency(primary.frequency),
      },
      // "Top down" — everything else they are actively covering, by radio name.
      topDown: active
        .filter((position) => position.positionId !== primary.positionId)
        .map((position) => ({
          positionId: position.positionId,
          radioName: position.radioName,
          positionName: position.positionName,
          facilityId: position.facilityId,
          frequency: formatFrequency(position.frequency),
        })),
      positionIds: active.map((position) => position.positionId),
    });
  }

  return byCallsign;
}
