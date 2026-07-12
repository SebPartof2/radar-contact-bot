import { config } from './config.js';
import * as db from './db.js';
import { formatFrequency } from './vnas.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The full vNAS airspace definition is ~14 MB of video maps, transceivers and sector geometry.
 * We keep only what a person needs to pick a position out of a tree, which is ~2% of that, and
 * refresh it once a day — the NAS does not change hour to hour.
 */
function slimFacility(facility) {
  return {
    id: facility.id,
    type: facility.type,
    name: facility.name,
    positions: (facility.positions ?? []).map((position) => ({
      id: position.id,
      name: position.name,
      radioName: position.radioName,
      callsign: position.callsign,
      frequency: formatFrequency(position.frequency),
      starred: Boolean(position.starred),
    })),
    children: (facility.childFacilities ?? []).map(slimFacility),
  };
}

export async function fetchNasTree() {
  const response = await fetch(config.nasApiUrl, {
    headers: { 'User-Agent': 'RC-Notify (Discord bot)' },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`vNAS ARTCC API returned ${response.status}`);

  const artccs = await response.json();
  return {
    id: 'NAS',
    type: 'Nas',
    name: 'National Airspace System',
    positions: [],
    children: artccs
      .map((artcc) => slimFacility(artcc.facility))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/* --- in-memory view, rebuilt whenever the tree is refreshed --- */

let tree = null;
/** facilityId -> every facility id at or below it, so a facility watch covers everything under it. */
let descendants = new Map();
/** positionId -> { position, facility } for labelling watches without walking the tree. */
let positionIndex = new Map();
/** facilityId -> facility node. */
let facilityIndex = new Map();
/** facilityId -> itself plus every facility above it, so an exclusion shadows what is under it. */
let ancestorIndex = new Map();

function reindex(next) {
  tree = next;
  descendants = new Map();
  positionIndex = new Map();
  facilityIndex = new Map();
  ancestorIndex = new Map();

  const walk = (facility, above) => {
    const ids = new Set([facility.id]);
    facilityIndex.set(facility.id, facility);
    ancestorIndex.set(facility.id, new Set([facility.id, ...above]));

    for (const position of facility.positions) {
      positionIndex.set(position.id, { position, facility });
    }
    for (const child of facility.children) {
      for (const id of walk(child, ancestorIndex.get(facility.id))) ids.add(id);
    }
    descendants.set(facility.id, ids);
    return ids;
  };

  for (const artcc of tree.children) walk(artcc, new Set());
}

/** The facility and everything above it, up to the ARTCC. */
export function facilityAncestors(facilityId) {
  return ancestorIndex.get(facilityId) ?? new Set([facilityId]);
}

export function getNasTree() {
  return tree;
}

export function getPosition(positionId) {
  return positionIndex.get(positionId);
}

export function getFacility(facilityId) {
  return facilityIndex.get(facilityId);
}

/** Does a position sitting in `facilityId` fall under the watched facility? */
export function facilityCovers(watchedFacilityId, facilityId) {
  return Boolean(descendants.get(watchedFacilityId)?.has(facilityId));
}

/**
 * Serve from the cached copy, and only hit vNAS when it is stale. On a cold start with vNAS
 * down we simply have no tree: the dashboard says so, and monitoring is unaffected.
 */
export async function startNasRefresh() {
  const cached = db.getNasTree();
  if (cached) {
    reindex(cached.tree);
    console.log(
      `[nas] loaded ${positionIndex.size} positions from cache (fetched ${new Date(cached.fetchedAt).toISOString()})`,
    );
  }

  const refresh = async (force = false) => {
    const current = db.getNasTree();
    if (!force && current && Date.now() - current.fetchedAt < DAY_MS) return;

    try {
      const next = await fetchNasTree();
      db.saveNasTree(next);
      reindex(next);
      console.log(
        `[nas] refreshed: ${positionIndex.size} positions across ${next.children.length} ARTCCs`,
      );
    } catch (error) {
      console.error('[nas] refresh failed:', error.message);
    }
  };

  await refresh();
  setInterval(() => void refresh(true), DAY_MS);
}
