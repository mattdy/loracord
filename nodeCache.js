'use strict';

const config = require('./config');
const nodeId = require('./nodeId');

/**
 * In-memory cache of Meshtastic node info.
 * Keyed by decimal node ID (number).
 *
 * Entry shape:
 *   {
 *     longName: string,
 *     shortName: string,
 *     hardware: string,           (model reported in nodeinfo, e.g. "HELTEC_V3")
 *     role: string,               (node role, e.g. "CLIENT" / "ROUTER")
 *     lastSeen: number,           (epoch ms)
 *     hopsAway: number,           (hops the last packet took, absent if unreported)
 *     snr: number,                (signal-to-noise of the last packet, dB)
 *     rssi: number,               (received strength of the last packet, dBm)
 *     position: { latitude, longitude, altitude?, at },
 *     deviceMetrics: { batteryLevel?, voltage?, channelUtilization?, airUtilTx?, uptimeSeconds?, at },
 *     environmentMetrics: { temperature?, relativeHumidity?, barometricPressure?, at },
 *   }
 *
 * The three nested groups are stored as whole objects rather than flattened,
 * because each arrives complete in a single packet: merging a newer position
 * field-by-field over an older one would leave a node carrying the altitude it
 * had two hilltops ago. Everything else merges per-field, so a packet that
 * reports no hop count leaves the last known one alone.
 */
const cache = new Map();

function upsert(id, info) {
  const existing = cache.get(id) || {};
  cache.set(id, {
    ...existing,
    ...info,
    lastSeen: Date.now(),
  });
}

/**
 * Returns a display label for a node in the form "SHRT · Long Name".
 * Falls back gracefully if we haven't received nodeinfo for this node yet.
 */
function getDisplayName(id) {
  const entry = cache.get(id);
  // Presence-only packets (position, telemetry) create an entry carrying no
  // names, so an entry existing doesn't mean we know what the node is called.
  if (!entry || !entry.longName) {
    // Hexadecimal fallback matching Meshtastic convention
    return nodeId.format(id);
  }
  return `${entry.shortName || '????'} · ${entry.longName}`;
}

function getEntry(id) {
  return cache.get(id) || null;
}

/**
 * Evict entries older than the configured TTL.
 * Called on a periodic interval.
 */
function evictStale() {
  const cutoff = Date.now() - config.nodeCacheTtlMs;
  for (const [id, entry] of cache.entries()) {
    if (entry.lastSeen < cutoff) {
      cache.delete(id);
    }
  }
}

/**
 * Every node still inside the TTL window, most recently heard first.
 *
 * Stale entries are evicted first so the list honours the TTL exactly rather
 * than trailing up to 10 minutes behind the periodic sweep below.
 *
 * @returns {Array<{ id: number, longName?: string, shortName?: string, lastSeen: number, hopsAway?: number }>}
 */
function list() {
  evictStale();
  return [...cache.entries()]
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

/**
 * Find nodes matching what someone typed into /node.
 *
 * Tried in order of how precisely each identifies one node, stopping at the
 * first that hits, so an exact match is never buried under loose ones:
 *
 *   1. Node ID in any form nodeId.parse accepts ("!a1b2c3d4", "0x…", decimal)
 *   2. Exact short name, case-insensitive ("HILL")
 *   3. Substring of either name or of the hex ID ("hillt", "3e00")
 *
 * A single result means the caller can go straight to the detail view; several
 * mean it should ask which was meant.
 *
 * @param {string} query
 * @returns {Array<object>} matching entries, most recently heard first
 */
function find(query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return [];

  const nodes = list();

  // An all-digit or hex-looking query might name an ID, but only counts as one
  // if we've actually heard that node — otherwise "beef" falls through to the
  // name matching below, where it more likely belongs.
  let parsedId = null;
  try {
    parsedId = nodeId.parse(trimmed);
  } catch {
    // Not an ID — that's the common case
  }
  if (parsedId !== null) {
    const byId = nodes.filter((node) => node.id === parsedId);
    if (byId.length) return byId;
  }

  const needle = trimmed.toLowerCase();

  const byShortName = nodes.filter((node) => (node.shortName || '').toLowerCase() === needle);
  if (byShortName.length) return byShortName;

  return nodes.filter(
    (node) =>
      (node.longName || '').toLowerCase().includes(needle) ||
      (node.shortName || '').toLowerCase().includes(needle) ||
      nodeId.format(node.id).includes(needle)
  );
}

// Evict stale entries every 10 minutes
setInterval(evictStale, 10 * 60 * 1000).unref();

module.exports = { upsert, getDisplayName, getEntry, list, find };
