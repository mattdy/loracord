'use strict';

/**
 * Counters for what the bridge has done since it started, reported by /status.
 *
 * Deliberately process-local and reset by a restart: they describe this run of
 * the bridge, not the mesh's history, which is what you want when checking
 * whether traffic is flowing right now.
 */

const startedAt = Date.now();

const counters = {
  packetsReceived: 0,
  duplicatesDropped: 0,
  meshToDiscord: 0,
  discordToMesh: 0,
  sendsRefused: 0,
};

function increment(key) {
  if (!(key in counters)) throw new Error(`Unknown stat: ${key}`);
  counters[key] += 1;
}

/**
 * @returns {{ uptimeMs: number, packetsReceived: number, duplicatesDropped: number,
 *   meshToDiscord: number, discordToMesh: number, sendsRefused: number }}
 */
function snapshot() {
  return { uptimeMs: Date.now() - startedAt, ...counters };
}

module.exports = { increment, snapshot };
