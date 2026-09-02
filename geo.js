'use strict';

const { getPreciseDistance, getGreatCircleBearing } = require('geolib');

/**
 * Geographic helpers for comparing node positions.
 *
 * The spherical maths comes from geolib; what's left here is the bit specific
 * to us — deciding when a position is usable, and how much precision to imply
 * when reporting one. Meshtastic reports coordinates as degrees, so everything
 * here works in degrees in and metres out.
 */

const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/**
 * The nearest of the eight compass points to a bearing — enough precision for
 * "which way do I point the antenna", without implying more than LoRa position
 * accuracy supports. geolib's own getCompassDirection resolves to 16 points,
 * which oversells a fix that can be tens of metres out.
 */
function compassPoint(bearing) {
  const index = Math.round(bearing / 45) % COMPASS_POINTS.length;
  return COMPASS_POINTS[index];
}

/**
 * Distance and heading from one node to another, ready to print.
 *
 * @param {{ latitude: number, longitude: number }} from
 * @param {{ latitude: number, longitude: number }} to
 * @returns {{ metres: number, bearing: number, compass: string } | null}
 *   null when either position is unknown.
 */
function relativePosition(from, to) {
  // geolib throws on a missing coordinate and returns NaN on a malformed one,
  // so screen both positions before handing them over.
  if (!isPosition(from) || !isPosition(to)) return null;

  const bearing = getGreatCircleBearing(from, to);
  return {
    metres: getPreciseDistance(from, to),
    bearing,
    compass: compassPoint(bearing),
  };
}

function isPosition(value) {
  return Boolean(value) && Number.isFinite(value.latitude) && Number.isFinite(value.longitude);
}

module.exports = { compassPoint, relativePosition, isPosition };
