'use strict';

/**
 * Meshtastic node ID helpers.
 *
 * Meshtastic shows node IDs as 8-digit hex with a "!" prefix (e.g. "!a1b2c3d4"),
 * but the JSON MQTT envelope carries them as unsigned 32-bit decimals. These
 * helpers convert between the two so users never have to do it by hand.
 */

/**
 * Parse a node ID written in any of the forms a user might reasonably supply:
 *
 *   "!a1b2c3d4"   → 2712847316   (Meshtastic app / MQTT topic form)
 *   "0xa1b2c3d4"  → 2712847316
 *   "a1b2c3d4"    → 2712847316   (bare hex — contains a-f)
 *   "2712847316"  → 2712847316   (decimal, for backwards compatibility)
 *
 * All-digit strings are ambiguous (valid as both hex and decimal); they are
 * read as decimal, so prefix with "!" or "0x" if you mean hex.
 *
 * @param {string} raw
 * @param {string} label - name used in error messages (e.g. an env var name)
 * @returns {number} unsigned 32-bit node ID
 */
function parse(raw, label = 'node ID') {
  const trimmed = String(raw).trim();
  if (!trimmed) throw new Error(`Invalid ${label}: value is empty`);

  let value;
  if (/^!([0-9a-f]{1,8})$/i.test(trimmed)) {
    value = parseInt(trimmed.slice(1), 16);
  } else if (/^0x([0-9a-f]{1,8})$/i.test(trimmed)) {
    value = parseInt(trimmed.slice(2), 16);
  } else if (/^[0-9]+$/.test(trimmed)) {
    value = parseInt(trimmed, 10);
  } else if (/^[0-9a-f]{1,8}$/i.test(trimmed)) {
    value = parseInt(trimmed, 16);
  } else {
    throw new Error(
      `Invalid ${label}: "${trimmed}" — expected hex (!a1b2c3d4) or decimal (2712847316)`
    );
  }

  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`Invalid ${label}: "${trimmed}" — out of range for a 32-bit node ID`);
  }
  return value;
}

/**
 * Format a decimal node ID back into Meshtastic's "!a1b2c3d4" convention.
 *
 * @param {number} nodeId
 * @returns {string}
 */
function format(nodeId) {
  return `!${nodeId.toString(16).padStart(8, '0')}`;
}

module.exports = { parse, format };
