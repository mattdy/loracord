'use strict';

const config = require('./config');
const nodeCache = require('./nodeCache');
const nodeId = require('./nodeId');

/**
 * Format an inbound Meshtastic text message for Discord.
 *
 * Output: "✉️ **SHRT · Long Name**: message text"
 */
function meshMessageToDiscord({ fromId, text }) {
  const displayName = nodeCache.getDisplayName(fromId);
  // Escape Discord markdown in the message body to prevent formatting surprises
  const safeText = escapeDiscordMarkdown(text);
  return `✉️ **${displayName}**: ${safeText}`;
}

/**
 * Format a node online/offline event for Discord.
 *
 * Output:
 *   🟢 SHRT · Long Name is now on the mesh
 *   🔴 SHRT · Long Name left the mesh
 */
function nodeEventToDiscord({ type, displayName }) {
  if (type === 'online') {
    return `🟢 **${displayName}** is now on the mesh`;
  }
  if (type === 'offline') {
    return `🔴 **${displayName}** left the mesh`;
  }
  return null;
}

/**
 * Format a confirmation that a Discord message made it onto the mesh.
 *
 * Echoes the text as it was actually sent, so a message truncated to fit
 * Meshtastic's payload limit shows up truncated here too.
 *
 * Output: "✅ Sent to mesh: message text"
 */
function sendConfirmationToDiscord({ text }) {
  return `✅ Sent to mesh: ${escapeDiscordMarkdown(text)}`;
}

/**
 * Format the node list for a /nodes reply.
 *
 * Rows sit in a code block so the columns line up in Discord's monospace
 * font, and split across several messages if the mesh has been busy enough
 * to push the list past Discord's 2000 character limit.
 *
 * Output:
 *   📡 **3 nodes heard in the last hour**
 *   ```
 *   !a1b2c3d4  MDYS · Matt's Base     2m ago  direct
 *   !7f3e0011  HILL · Hilltop Relay  18m ago  2 hops
 *   !0c9a4d22  (no nodeinfo yet)     51m ago  ?
 *   ```
 *
 * @param {Array<{ id: number, longName?: string, shortName?: string, lastSeen: number, hopsAway?: number }>} nodes
 * @returns {string[]} one or more Discord messages
 */
function nodeListToDiscord(nodes) {
  if (!nodes.length) {
    return ['📡 No nodes heard yet — the bridge learns them as packets arrive.'];
  }

  const header =
    `📡 **${nodes.length} node${nodes.length === 1 ? '' : 's'} heard in ` +
    `${describeWindow(config.nodeCacheTtlMs)}**`;

  const now = Date.now();
  const rows = nodes.map((node) => ({
    id: nodeId.format(node.id),
    // Presence-only packets (position, telemetry) leave an entry carrying no
    // names, so say so rather than printing an empty column.
    name: node.longName
      ? sanitiseForCodeBlock(`${node.shortName || '????'} · ${node.longName}`)
      : '(no nodeinfo yet)',
    age: formatAge(now - node.lastSeen),
    hops: formatHops(node.hopsAway),
  }));

  const nameWidth = Math.max(...rows.map((row) => row.name.length));
  const ageWidth = Math.max(...rows.map((row) => row.age.length));
  const lines = rows.map(
    (row) => `${row.id}  ${row.name.padEnd(nameWidth)}  ${row.age.padStart(ageWidth)}  ${row.hops}`
  );

  return chunkIntoCodeBlocks(header, lines);
}

/**
 * Pack lines into as few messages as possible, each one a fenced code block
 * within Discord's 2000 character limit. The header rides on the first.
 */
function chunkIntoCodeBlocks(header, lines) {
  // 2000 is the hard limit; leave room for the fences and some slack.
  const maxBody = 1900;
  const messages = [];
  let batch = [];

  const flush = () => {
    if (!batch.length) return;
    const block = '```\n' + batch.join('\n') + '\n```';
    messages.push(messages.length === 0 ? `${header}\n${block}` : block);
    batch = [];
  };

  for (const line of lines) {
    // The header only counts against the first message's budget
    const budget = messages.length === 0 ? maxBody - header.length : maxBody;
    const prospective = [...batch, line].join('\n').length;
    if (batch.length && prospective > budget) flush();
    batch.push(line);
  }
  flush();

  return messages;
}

/**
 * Human-readable age of a node's last packet: "just now", "7m ago", "2h 14m ago".
 */
function formatAge(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 1) return 'just now';
  if (totalMinutes < 60) return `${totalMinutes}m ago`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m ago` : `${hours}h ago`;
}

/**
 * Describe how far away a node was on its last packet.
 *
 * The firmware only reports this when the packet carried a hop count, and a
 * direct contact legitimately reports zero, so "unknown" and "direct" have to
 * stay tellable apart.
 */
function formatHops(hopsAway) {
  if (!Number.isInteger(hopsAway)) return '?';
  if (hopsAway === 0) return 'direct';
  return hopsAway === 1 ? '1 hop' : `${hopsAway} hops`;
}

/**
 * Describe the cache TTL as a window of time, for the /nodes header.
 */
function describeWindow(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'the last minute';
  if (minutes < 60) return `the last ${minutes} minutes`;

  const hours = minutes / 60;
  if (Number.isInteger(hours)) {
    return hours === 1 ? 'the last hour' : `the last ${hours} hours`;
  }
  return `the last ${minutes} minutes`;
}

/**
 * Make a node name safe to sit inside a fenced code block.
 *
 * Names come off the mesh, so one containing backticks would otherwise close
 * the fence early and let the rest of the list render as markdown. Long names
 * are clipped to keep the columns aligned.
 */
function sanitiseForCodeBlock(text) {
  const cleaned = text.replace(/`/g, "'").replace(/[\r\n]+/g, ' ');
  return cleaned.length > 32 ? cleaned.slice(0, 31) + '…' : cleaned;
}

/**
 * Escape Discord markdown special characters in user-provided text.
 * Prevents mesh messages containing * _ ` ~ from breaking Discord formatting.
 */
function escapeDiscordMarkdown(text) {
  return text.replace(/([*_`~\|<>])/g, '\$1');
}

module.exports = {
  meshMessageToDiscord,
  nodeEventToDiscord,
  sendConfirmationToDiscord,
  nodeListToDiscord,
};
