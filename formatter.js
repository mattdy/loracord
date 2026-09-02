'use strict';

const {
  escapeMarkdown,
  codeBlock: fence,
  inlineCode,
  channelMention,
  hyperlink,
} = require('discord.js');
const config = require('./config');
const nodeCache = require('./nodeCache');
const nodeId = require('./nodeId');
const geo = require('./geo');

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
 * Format a node arriving on the mesh for Discord.
 *
 * There's deliberately no departure counterpart: LoRa is connectionless
 * broadcast, so a node that powers off or walks out of range simply stops
 * transmitting — nothing announces it. The only leave signal Meshtastic offers
 * is the MQTT last-will on msh/REGION/2/stat/!id, which covers only nodes
 * holding their own broker connection (i.e. gateways), not the mesh nodes we
 * report on here. Absence shows up instead as a node ageing out of /nodes.
 *
 * How far off it was heard is included when the packet reported a hop count,
 * which is the one moment that reading is genuinely news — it says whether the
 * new arrival is on the doorstep or several relays out.
 *
 * Output: "🟢 SHRT · Long Name is now on the mesh · 2 hops away"
 */
function nodeEventToDiscord({ type, displayName, hopsAway }) {
  if (type === 'online') {
    const distance = formatHopDistance(hopsAway);
    return `🟢 **${displayName}** is now on the mesh${distance ? ` · ${distance}` : ''}`;
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
    const block = fence(batch.join('\n'));
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
 * The same reading as formatHops, phrased to sit in a sentence.
 *
 * Returns null rather than '?' when no hop count was reported: a line of prose
 * can simply omit the detail, where a table column has to fill its cell.
 */
function formatHopDistance(hopsAway) {
  if (!Number.isInteger(hopsAway)) return null;
  return hopsAway === 0 ? 'heard direct' : `${formatHops(hopsAway)} away`;
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
 *
 * discord.js gets right what a character class gets wrong: ~~ and || only mean
 * anything doubled, so a lone ~ in a node name no longer picks up a stray
 * backslash. Headings and lists are opt-in there and default to off, but a
 * mesh message opening with "# " or "- " is exactly the surprise this exists
 * to prevent, so they are switched on.
 *
 * Angle brackets stay ours to handle: discord.js never escapes them, and they
 * are what turns a name chosen on the mesh into a mention or channel chip.
 * Pings are separately defused by allowedMentions at the send boundary; this
 * stops the chip rendering at all.
 */
function escapeDiscordMarkdown(text) {
  const escaped = escapeMarkdown(text, {
    heading: true,
    bulletedList: true,
    numberedList: true,
  });
  return escaped.replace(/[<>]/g, (char) => `\\${char}`);
}

// ─── /status ─────────────────────────────────────────────────────────────────

/**
 * Format the bridge's own status.
 *
 * Answers the questions you actually ask when something looks wrong: is MQTT
 * up, does the bridge know its gateway yet, does it know how to address each
 * channel, and is traffic moving in both directions.
 *
 * @param {object} params
 * @param {object} params.mqtt      - from mqttClient.getConnectionInfo()
 * @param {object} params.gateway   - { id, source, entry } for our own node
 * @param {Array}  params.channels  - { meshChannel, discordChannelId, index, pinned }
 * @param {object} params.counters  - from stats.snapshot()
 * @param {object} params.dedupe    - { enabled, windowMs }
 * @returns {string[]} one or more Discord messages
 */
function statusToDiscord({ mqtt, gateway, channels, counters, dedupe }) {
  const sections = ['📊 **loracord status**'];

  sections.push(
    codeBlock(
      renderRows([
        ['Uptime', formatDuration(counters.uptimeMs)],
        ['MQTT', describeConnection(mqtt)],
        ['Topic', mqtt.subscribedTopic || 'not subscribed yet'],
        ['Gateway', describeGateway(gateway)],
        ['Dedupe', dedupe.enabled ? `${formatDuration(dedupe.windowMs)} window` : 'disabled'],
      ])
    )
  );

  sections.push(
    '**Traffic since startup**\n' +
      codeBlock(
        renderRows([
          ['Packets seen', counters.packetsReceived],
          ['Duplicates dropped', counters.duplicatesDropped],
          ['Mesh to Discord', counters.meshToDiscord],
          ['Discord to mesh', counters.discordToMesh],
          ['Sends refused', counters.sendsRefused],
        ])
      )
  );

  // Left outside a code block so the channel mentions resolve to real links
  sections.push('**Channels**\n' + channels.map(describeChannel).join('\n'));

  // Only when our node has told us something about itself. On a fresh start
  // that can take a few minutes, so say so rather than showing empty rows.
  const own = gateway.entry ? renderRows(ownNodeRows(gateway.entry)) : null;
  sections.push(
    own
      ? `**This node** — ${describeNodeName(gateway.entry, gateway.id)}\n${codeBlock(own)}`
      : '**This node** — nothing heard from it yet; it reports in on its own telemetry interval.'
  );

  return packSections(sections);
}

function describeConnection(mqtt) {
  const state = mqtt.connected ? 'connected' : 'disconnected';
  return `${state} · ${mqtt.broker}${mqtt.authenticated ? ' (authenticated)' : ''}`;
}

function describeGateway({ id, source }) {
  if (id === null) return 'not known yet — waiting for the first uplink';
  return `${nodeId.format(id)} (${source})`;
}

/**
 * One channel mapping: which mesh channel goes where, and whether the bridge
 * can currently transmit on it.
 *
 * An unknown index is the thing worth spotting here — sends on that channel
 * are refused until a packet arrives to teach the bridge its slot number.
 */
function describeChannel({ meshChannel, discordChannelId, index, pinned }) {
  const slot =
    index === null
      ? '⚠️ index not known yet'
      : `index ${index} (${pinned ? 'pinned' : 'discovered'})`;
  return `${inlineCode(meshChannel)} → ${channelMention(discordChannelId)} · ${slot}`;
}

function ownNodeRows(entry) {
  return [...metricRows(entry), ['Heard', formatAge(Date.now() - entry.lastSeen)]];
}

// ─── /node ───────────────────────────────────────────────────────────────────

/**
 * Format everything known about a single node.
 *
 * Rows the bridge has no reading for are dropped rather than shown empty, so
 * the reply only ever states things actually heard over the air.
 *
 * @param {object} params
 * @param {object} params.node                   - a nodeCache entry, with its id
 * @param {boolean} [params.isGateway]           - node is the bridge's own gateway
 * @param {object|null} [params.gatewayPosition] - for the distance row
 * @returns {string[]} one or more Discord messages
 */
function nodeDetailToDiscord({ node, isGateway = false, gatewayPosition = null }) {
  const suffix = isGateway ? ' — this bridge’s gateway' : '';
  const header = `📡 **${describeNodeName(node, node.id)}**${suffix}`;

  // Distance is only meaningful between two different nodes, and only when
  // both have reported a fix
  const relative = isGateway ? null : geo.relativePosition(gatewayPosition, node.position);

  const rows = renderRows([
    ['Node ID', `${nodeId.format(node.id)} (${node.id})`],
    ['Hardware', [node.hardware, node.role].filter(Boolean).join(' · ') || null],
    ['Last heard', formatAge(Date.now() - node.lastSeen)],
    ['Hops', Number.isInteger(node.hopsAway) ? formatHops(node.hopsAway) : null],
    ['Signal', formatSignal(node)],
    ['Position', formatPosition(node.position)],
    [
      'Distance',
      relative ? `${formatDistance(relative.metres)} ${relative.compass} of this gateway` : null,
    ],
    ...metricRows(node),
  ]);

  const sections = [header, codeBlock(rows)];
  if (geo.isPosition(node.position)) sections.push(mapLink(node.position));
  return packSections(sections);
}

/**
 * Reply when /node matched nothing.
 */
function nodeNotFoundToDiscord(query) {
  return [
    `❓ Nothing matching **${escapeDiscordMarkdown(query)}** has been heard in ` +
      `${describeWindow(config.nodeCacheTtlMs)}. Run \`/nodes\` to see what the bridge currently knows.`,
  ];
}

/**
 * Reply when /node matched several nodes — list them rather than guessing.
 */
function nodeChoicesToDiscord(query, nodes) {
  const header =
    `🔎 **${nodes.length} nodes** match **${escapeDiscordMarkdown(query)}** — ` +
    'run `/node` again with one of these:';
  const lines = nodes.map((node) => {
    const name = node.longName
      ? sanitiseForCodeBlock(`${node.shortName || '????'} · ${node.longName}`)
      : '(no nodeinfo yet)';
    return `${nodeId.format(node.id)}  ${name}`;
  });
  return chunkIntoCodeBlocks(header, lines);
}

// ─── Shared rendering helpers ────────────────────────────────────────────────

/**
 * The readings a node reports about itself, shared by /status and /node.
 */
function metricRows(entry) {
  const device = entry.deviceMetrics || {};
  const environment = entry.environmentMetrics || {};
  const uptime = Number.isFinite(device.uptimeSeconds)
    ? formatDuration(device.uptimeSeconds * 1000)
    : null;

  return [
    ['Battery', formatBattery(device)],
    ['Air util TX', formatPercent(device.airUtilTx)],
    ['Chan util', formatPercent(device.channelUtilization)],
    ['Environment', formatEnvironment(environment)],
    ['Node uptime', uptime],
  ];
}

/**
 * Lay out label/value pairs as aligned rows, dropping any the bridge has no
 * value for. Returns null when nothing is known at all.
 */
function renderRows(rows) {
  const known = rows.filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (!known.length) return null;

  const width = Math.max(...known.map(([label]) => label.length));
  return known.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n');
}

function codeBlock(body) {
  return body === null ? '' : fence(body);
}

/**
 * A node's name for use outside a code block, escaped so a name chosen on the
 * mesh can't reformat the reply around it.
 */
function describeNodeName(entry, id) {
  if (!entry || !entry.longName) return nodeId.format(id);
  return escapeDiscordMarkdown(`${entry.shortName || '????'} · ${entry.longName}`);
}

/**
 * Pack sections into as few messages as possible, each under Discord's limit.
 */
function packSections(sections, limit = 1900) {
  const messages = [];
  let current = '';

  for (const section of sections.filter(Boolean)) {
    const candidate = current ? `${current}\n${section}` : section;
    if (current && candidate.length > limit) {
      messages.push(current);
      current = section;
    } else {
      current = candidate;
    }
  }

  if (current) messages.push(current);
  return messages;
}

// ─── Value formatting ────────────────────────────────────────────────────────

/**
 * A duration as its two most significant units — "2d 4h", "3h 12m", "45m".
 * Distinct from formatAge: this measures a span, not how long ago something was.
 */
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/**
 * Battery as the node reports it.
 *
 * Meshtastic sends a level above 100 to mean "running on external power", so
 * that has to read as mains rather than as an impossible percentage.
 */
function formatBattery(device) {
  const { batteryLevel, voltage } = device;
  const volts = Number.isFinite(voltage) ? `${voltage.toFixed(2)} V` : null;

  if (!Number.isFinite(batteryLevel)) return volts;
  if (batteryLevel > 100) return volts ? `mains powered (${volts})` : 'mains powered';
  return volts ? `${batteryLevel}% (${volts})` : `${batteryLevel}%`;
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : null;
}

function formatEnvironment({ temperature, relativeHumidity, barometricPressure }) {
  const parts = [];
  if (Number.isFinite(temperature)) parts.push(`${temperature.toFixed(1)} °C`);
  if (Number.isFinite(relativeHumidity)) parts.push(`${Math.round(relativeHumidity)}% RH`);
  if (Number.isFinite(barometricPressure)) parts.push(`${barometricPressure.toFixed(1)} hPa`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Link quality for the last packet heard from a node.
 *
 * SNR is the useful half — it's what decides whether a packet decodes at all —
 * so it leads, with RSSI after it when the firmware reported one.
 */
function formatSignal({ snr, rssi }) {
  const parts = [];
  if (Number.isFinite(snr)) parts.push(`SNR ${snr.toFixed(2)} dB`);
  if (Number.isFinite(rssi)) parts.push(`RSSI ${Math.round(rssi)} dBm`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * A position fix, with how long ago it was reported — a node's last known
 * location is only as good as its age.
 */
function formatPosition(position) {
  if (!geo.isPosition(position)) return null;

  const coords = `${position.latitude.toFixed(5)}, ${position.longitude.toFixed(5)}`;
  const altitude = Number.isFinite(position.altitude) ? ` · ${Math.round(position.altitude)} m` : '';
  const age = Number.isFinite(position.at) ? ` (${formatAge(Date.now() - position.at)})` : '';
  return `${coords}${altitude}${age}`;
}

/**
 * Metres below a kilometre, kilometres above it — LoRa link distances span
 * both, and neither unit reads well across the whole range.
 */
function formatDistance(metres) {
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`;
}

function mapLink({ latitude, longitude }) {
  const lat = latitude.toFixed(5);
  const lon = longitude.toFixed(5);
  return hyperlink(
    'Show on map',
    `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=13/${lat}/${lon}`
  );
}

module.exports = {
  meshMessageToDiscord,
  nodeEventToDiscord,
  sendConfirmationToDiscord,
  nodeListToDiscord,
  statusToDiscord,
  nodeDetailToDiscord,
  nodeNotFoundToDiscord,
  nodeChoicesToDiscord,
};
