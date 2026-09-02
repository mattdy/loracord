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
 *     lastSeen: number (epoch ms),
 *     hopsAway: number (hops the last packet took, absent if unreported),
 *   }
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

// Evict stale entries every 10 minutes
setInterval(evictStale, 10 * 60 * 1000).unref();

module.exports = { upsert, getDisplayName, getEntry, list };
