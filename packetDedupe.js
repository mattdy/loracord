'use strict';

const config = require('./config');

/**
 * Suppression of duplicate copies of the same mesh packet.
 *
 * We subscribe to every gateway publishing under the root topic, not just our
 * own, so a packet heard by two gateways is uplinked twice and arrives here as
 * two identical messages on two different topics. Without this, every mesh
 * message on such a broker would post to Discord once per gateway that heard
 * it, and each copy would overwrite the node's cached hop count with the path
 * through whichever gateway happened to arrive last.
 *
 * Packet key ("fromId:packetId") → when that packet was first seen (epoch ms).
 * Memory is bounded by the sweep below rather than a size cap: entries live
 * only for the dedupe window, and mesh packet rates keep that small.
 */
const seen = new Map();

const windowMs = config.dedupeWindowMs;
const enabled = windowMs > 0;

/**
 * Have we already handled this exact packet?
 *
 * Meshtastic packet IDs are unique per sending node, so the sender plus the
 * packet ID identifies one transmission however many gateways relayed it.
 *
 * A packet carrying no usable ID is always treated as new — bridging a
 * duplicate is a far smaller failure than swallowing a real message.
 */
function isDuplicate(msg) {
  if (!enabled) return false;

  // Firmware uses 0 for "no ID assigned", so it identifies nothing
  const packetId = msg.id;
  if (!Number.isInteger(packetId) || packetId === 0) return false;

  const key = `${msg.from}:${packetId}`;
  const now = Date.now();
  const firstSeen = seen.get(key);

  // An entry the sweep hasn't reached yet can still be older than the window,
  // so judge it by age rather than trusting its presence alone.
  if (firstSeen !== undefined && now - firstSeen < windowMs) return true;

  seen.set(key, now);
  return false;
}

/**
 * Drop entries that have aged out of the window.
 * Called on a periodic interval.
 */
function evictExpired() {
  const cutoff = Date.now() - windowMs;
  for (const [key, firstSeen] of seen.entries()) {
    if (firstSeen < cutoff) {
      seen.delete(key);
    }
  }
}

if (enabled) {
  setInterval(evictExpired, 60 * 1000).unref();
}

module.exports = { isDuplicate, enabled, windowMs };
