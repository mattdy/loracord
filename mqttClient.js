'use strict';

const mqtt = require('mqtt');
const config = require('./config');
const nodeCache = require('./nodeCache');
const packetDedupe = require('./packetDedupe');
const stats = require('./stats');
const nodeId = require('./nodeId');
const log = require('./logger').child({ component: 'MQTT' });

let client = null;

// Our gateway node's decimal ID. Either supplied via GATEWAY_NODE_ID or, when
// that's left blank, discovered from the gateway segment of the first uplink
// topic we see (see discoverGatewayNodeId).
let gatewayNodeId = config.meshtastic.gatewayNodeId;

// Mesh channel name → its slot number on our gateway node. The downlink
// envelope addresses channels by index, but uplink topics name them, so we
// seed this from any indices pinned in CHANNEL_MAP and fill in the rest from
// the `channel` field on incoming packets (see discoverChannelIndex).
const channelIndexes = new Map(config.channels.meshChannelIndex);

// The topic we actually subscribed to, reported by /status
let subscribedTopic = null;

// Callbacks registered by the bridge
let onTextMessage = null;
let onNodeEvent = null;

/**
 * Connect to the MQTT broker and set up subscriptions.
 *
 * @param {object} handlers
 * @param {function} handlers.onTextMessage  - called with { meshChannel, fromId, text }
 * @param {function} handlers.onNodeEvent    - called with { meshChannel, nodeId, type: 'online', displayName }
 */
function connect(handlers) {
  onTextMessage = handlers.onTextMessage;
  onNodeEvent = handlers.onNodeEvent;

  const brokerUrl = `mqtt://${config.mqtt.host}:${config.mqtt.port}`;
  log.info(`Connecting to ${brokerUrl}`);

  client = mqtt.connect(brokerUrl, {
    username: config.mqtt.username,
    password: config.mqtt.password,
    clientId: `loracord-${Math.random().toString(16).slice(2, 8)}`,
    reconnectPeriod: 5000,
    keepalive: 60,
  });

  client.on('connect', () => {
    log.info('Connected');

    // Subscribe to all JSON uplink topics under our root
    // msh/REGION/2/json/+/+ catches all channels and all gateway nodes
    const jsonTopic = `${config.meshtastic.rootTopic}/2/json/#`;
    subscribedTopic = jsonTopic;
    client.subscribe(jsonTopic, { qos: 0 }, (err) => {
      if (err) {
        log.error({ err, topic: jsonTopic }, 'Failed to subscribe');
      } else {
        log.info(`Subscribed to ${jsonTopic}`);
      }
    });
  });

  client.on('reconnect', () => log.info('Reconnecting…'));
  client.on('offline', () => log.warn('Offline'));
  client.on('error', (err) => log.error({ err }, 'Client error'));

  client.on('message', (topic, payload) => {
    handleMessage(topic, payload);
  });
}

/**
 * Publish a text message downlink to a specific Meshtastic channel.
 *
 * The downlink always goes out on the "mqtt" topic — that's the only one the
 * node listens on, so it needs a channel named "mqtt" with downlink enabled —
 * but the channel the node *transmits* on is set by the envelope's `channel`
 * index, which we resolve from the mesh channel name.
 *
 * @param {string} text
 * @param {string} meshChannel - name of the mesh channel to transmit on
 * @returns {string|null} the text as it was actually sent (after truncation),
 *   or null if the send was refused
 */
function sendToMesh(text, meshChannel) {
  if (!client || !client.connected) {
    log.warn('Cannot send — not connected');
    return null;
  }

  if (gatewayNodeId === null) {
    log.warn(
      'Cannot send — gateway node ID not known yet. Waiting for the first uplink ' +
      'from your node, or set GATEWAY_NODE_ID to skip discovery.'
    );
    return null;
  }

  const channelIndex = channelIndexes.get(meshChannel);
  if (channelIndex === undefined) {
    // Falling back to index 0 would put the message on the primary channel,
    // which for a mapping like "Private" is the wrong audience — refuse instead.
    log.warn(
      `Cannot send — channel index for "${meshChannel}" not known yet. It's learned ` +
      'from the first packet seen on that channel; pin it in CHANNEL_MAP as ' +
      `"${meshChannel}:<index>:<discordChannelId>" to skip discovery.`
    );
    return null;
  }

  // Truncate to Meshtastic's ~228 byte limit (conservative: 220 chars for multi-byte safety)
  const truncated = text.length > 220 ? text.slice(0, 217) + '…' : text;

  const downlinkTopic = `${config.meshtastic.rootTopic}/2/json/mqtt/`;
  const envelope = {
    from: gatewayNodeId,
    channel: channelIndex,
    type: 'sendtext',
    payload: truncated,
  };

  client.publish(downlinkTopic, JSON.stringify(envelope), { qos: 0 }, (err) => {
    if (err) log.error({ err }, 'Publish failed');
    else log.debug(`Published to mesh [${meshChannel} = index ${channelIndex}]: "${truncated}"`);
  });

  return truncated;
}

// ─── Internal message handler ─────────────────────────────────────────────────

/**
 * Parse the topic to extract the channel name and the gateway that uplinked it.
 * Topic format: msh/REGION/2/json/CHANNELNAME/!nodeId
 *
 * @returns {{ meshChannel: string, gatewayId: number|null } | null}
 */
function parseTopic(topic) {
  // Strip root prefix, then: 2/json/CHANNELNAME/!GATEWAYID
  const suffix = topic.replace(`${config.meshtastic.rootTopic}/`, '');
  const parts = suffix.split('/');
  // parts: ['2', 'json', 'CHANNELNAME', '!nodeId']
  if (parts.length < 4 || parts[0] !== '2' || parts[1] !== 'json') return null;

  let gatewayId = null;
  try {
    gatewayId = nodeId.parse(parts[3], 'gateway ID in topic');
  } catch {
    // Unrecognised gateway segment — channel is still usable
  }

  return { meshChannel: parts[2], gatewayId };
}

/**
 * Learn our own gateway node ID from the topic the packet arrived on.
 *
 * Every JSON uplink is published under the ID of the node that put it on the
 * broker, so on a private broker fed by a single node that segment *is* our
 * gateway — no manual lookup needed. If you bridge a broker carrying several
 * gateways, set GATEWAY_NODE_ID explicitly to pin the right one.
 */
function discoverGatewayNodeId(gatewayId) {
  if (gatewayNodeId !== null || gatewayId === null) return;
  gatewayNodeId = gatewayId;
  log.info(
    `Discovered gateway node ID: ${nodeId.format(gatewayId)} (${gatewayId}) — ` +
    'set GATEWAY_NODE_ID to pin it if your broker carries more than one gateway'
  );
}

/**
 * Learn a bridged channel's slot number from a packet that arrived on it.
 *
 * The topic gives us the channel's name and the packet body its index, so any
 * traffic on a channel teaches us how to address it in a downlink. Channels we
 * don't bridge are ignored, and a pinned CHANNEL_MAP index always wins.
 */
function discoverChannelIndex(meshChannel, index) {
  if (!Number.isInteger(index)) return;
  if (channelIndexes.has(meshChannel)) return;
  if (!config.channels.meshtasticToDiscord.has(meshChannel)) return;

  channelIndexes.set(meshChannel, index);
  log.info(`Discovered channel index for "${meshChannel}": ${index}`);
}

function getGatewayNodeId() {
  return gatewayNodeId;
}

function getChannelIndex(meshChannel) {
  return channelIndexes.has(meshChannel) ? channelIndexes.get(meshChannel) : null;
}

function isConnected() {
  return Boolean(client && client.connected);
}

/**
 * What /status reports about the MQTT side: where we're pointed, whether we're
 * up, and what we ended up subscribed to.
 */
function getConnectionInfo() {
  return {
    connected: isConnected(),
    broker: `${config.mqtt.host}:${config.mqtt.port}`,
    authenticated: Boolean(config.mqtt.username),
    subscribedTopic,
  };
}

/**
 * Pull the message body out of a text packet's payload.
 *
 * The firmware wraps plaintext as { text: "…" }, but when the message itself
 * parses as JSON it publishes that value in place of the wrapper — so someone
 * typing "42" or "{}" on the mesh arrives here as a number or an object.
 */
function extractText(payload) {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload.text === 'string') return payload.text;
  return JSON.stringify(payload);
}

/**
 * How many hops a packet took to reach the gateway.
 *
 * The firmware includes this only when the packet carried a usable hop count,
 * and a node heard directly reports zero, so an absent value has to stay
 * distinct from a genuine 0.
 */
function extractHops(msg) {
  const raw = msg.hops_away ?? msg.hopsAway;
  return Number.isInteger(raw) ? raw : null;
}

/**
 * Read a numeric field published under either spelling.
 *
 * The JSON firmware emits snake_case, but not every build agrees — hops_away
 * above already has to accept both — so look under each and take whichever is
 * a real number.
 */
function numericField(source, snakeCase, camelCase) {
  const raw = source[snakeCase] ?? source[camelCase];
  return Number.isFinite(raw) ? raw : null;
}

/**
 * Signal quality the gateway measured while receiving this packet.
 *
 * Older firmware omits both, and a genuine 0 dB SNR is meaningful, so an
 * absent reading must not be recorded as zero.
 */
function extractSignal(msg) {
  const signal = {};
  if (Number.isFinite(msg.snr)) signal.snr = msg.snr;
  if (Number.isFinite(msg.rssi)) signal.rssi = msg.rssi;
  return signal;
}

/**
 * A coordinate published either as Meshtastic's scaled integer (degrees × 1e7)
 * or, on some builds, as a plain float.
 */
function extractCoordinate(payload, base) {
  const scaled = payload[`${base}_i`];
  if (Number.isInteger(scaled)) return scaled / 1e7;
  return Number.isFinite(payload[base]) ? payload[base] : null;
}

/**
 * Pull a fix out of a position packet.
 *
 * A packet with no usable latitude/longitude pair — which is what a node with
 * no GPS lock sends — yields nothing rather than a fix at (0, 0).
 */
function extractPosition(payload) {
  const latitude = extractCoordinate(payload, 'latitude');
  const longitude = extractCoordinate(payload, 'longitude');
  if (latitude === null || longitude === null) return null;

  const position = { latitude, longitude, at: Date.now() };
  const altitude = numericField(payload, 'altitude', 'altitude');
  if (altitude !== null) position.altitude = altitude;
  return position;
}

// Telemetry arrives as one of two payload shapes, and a node may send both.
// They're cached separately so a device reading never clears an environment
// one, and each group is replaced whole when a fresh packet of its kind lands.
const DEVICE_METRICS = {
  batteryLevel: ['battery_level', 'batteryLevel'],
  voltage: ['voltage', 'voltage'],
  channelUtilization: ['channel_utilization', 'channelUtilization'],
  airUtilTx: ['air_util_tx', 'airUtilTx'],
  uptimeSeconds: ['uptime_seconds', 'uptimeSeconds'],
};

const ENVIRONMENT_METRICS = {
  temperature: ['temperature', 'temperature'],
  relativeHumidity: ['relative_humidity', 'relativeHumidity'],
  barometricPressure: ['barometric_pressure', 'barometricPressure'],
};

function extractMetrics(payload, fields) {
  const metrics = {};
  for (const [name, [snakeCase, camelCase]] of Object.entries(fields)) {
    const value = numericField(payload, snakeCase, camelCase);
    if (value !== null) metrics[name] = value;
  }
  if (!Object.keys(metrics).length) return null;
  metrics.at = Date.now();
  return metrics;
}

/**
 * Everything a telemetry packet has to say, keyed by the cache group it
 * belongs in. Groups the packet said nothing about are left out entirely, so
 * the merge in nodeCache doesn't blank them.
 */
function extractTelemetry(payload) {
  const info = {};
  const deviceMetrics = extractMetrics(payload, DEVICE_METRICS);
  if (deviceMetrics) info.deviceMetrics = deviceMetrics;
  const environmentMetrics = extractMetrics(payload, ENVIRONMENT_METRICS);
  if (environmentMetrics) info.environmentMetrics = environmentMetrics;
  return info;
}

/**
 * Record that a node was just heard from, announcing it if it's the first time.
 *
 * Every packet carrying a sender is evidence the node is alive, so they all
 * refresh its cache entry; what differs is whether a first sighting is worth
 * telling Discord about.
 *
 * @param {object} params
 * @param {number} params.fromId       - sending node's decimal ID
 * @param {string} params.meshChannel  - channel the packet arrived on
 * @param {object} params.info         - fields to merge into the cache entry
 * @param {boolean} [params.announce]  - post a notice on a first sighting
 */
function recordNodeHeard({ fromId, meshChannel, info, announce = true }) {
  const wasKnown = nodeCache.getEntry(fromId) !== null;
  nodeCache.upsert(fromId, info);

  if (wasKnown || !announce) return;
  onNodeEvent?.({
    meshChannel,
    nodeId: fromId,
    type: 'online',
    displayName: nodeCache.getDisplayName(fromId),
  });
}

function handleMessage(topic, payload) {
  // Only process JSON topics
  if (!topic.includes('/json/')) return;

  let msg;
  try {
    msg = JSON.parse(payload.toString());
  } catch {
    // Non-JSON payload — ignore
    return;
  }

  const parsed = parseTopic(topic);
  if (!parsed) return;
  const { meshChannel, gatewayId } = parsed;

  stats.increment('packetsReceived');

  discoverGatewayNodeId(gatewayId);
  // Before the echo check below — our own reflected packets name their channel
  // index just as usefully as anyone else's.
  discoverChannelIndex(meshChannel, msg.channel);

  // ── Drop packets we've already handled ────────────────────────────────────
  // Our subscription spans every gateway under the root topic, so a packet two
  // gateways both heard arrives twice. Discovery above runs first: it's
  // idempotent, and a duplicate's topic identifies its channel just as well.
  if (packetDedupe.isDuplicate(msg)) {
    log.debug({ packetId: msg.id, from: msg.from, topic }, 'Ignoring duplicate packet');
    stats.increment('duplicatesDropped');
    return;
  }

  const fromId = msg.from; // decimal node ID

  // Everything below keys the cache by node ID, and a malformed one would land
  // there as an entry nothing can render a name for — so insist on a usable ID
  // once here instead of guarding each branch.
  if (!Number.isInteger(fromId)) return;

  // ── Our own gateway ───────────────────────────────────────────────────────
  // Its packets are still worth caching — /status reports this node's battery
  // and airtime straight off its own telemetry — but they're never bridged or
  // announced: text from it is our own traffic coming back, and the node
  // running the bridge didn't "arrive on the mesh" in any sense worth posting.
  const isOwnGateway = fromId === gatewayNodeId;

  const msgType = msg.type;

  // Only overwrite a cached reading when this packet actually carried one
  const hopsAway = extractHops(msg);
  const hops = hopsAway === null ? {} : { hopsAway };
  const signal = extractSignal(msg);

  // ── Node info — the only packet that carries names ───────────────────────
  if (msgType === 'nodeinfo' && msg.payload) {
    const { hardware, role } = msg.payload;
    recordNodeHeard({
      fromId,
      meshChannel,
      announce: !isOwnGateway,
      info: {
        longName: msg.payload.longname || nodeId.format(fromId),
        shortName: msg.payload.shortname || '????',
        ...(typeof hardware === 'string' && hardware ? { hardware } : {}),
        ...(typeof role === 'string' && role ? { role } : {}),
        ...hops,
        ...signal,
      },
    });
    return;
  }

  // ── Text messages ─────────────────────────────────────────────────────────
  if (msgType === 'text' && msg.payload) {
    // Hearing a node speak is as good a sign of life as any other packet.
    // Without this a node that only ever chats never reaches the cache at all,
    // so it stays missing from /nodes — and one already listed stops being
    // refreshed while it talks, ageing out mid-conversation only to be
    // re-announced by its next position packet.
    //
    // Cached but deliberately not announced: the message posted immediately
    // below is itself proof the node is there, so a "now on the mesh" notice
    // above it would say nothing the next line doesn't.
    recordNodeHeard({ fromId, meshChannel, info: { ...hops, ...signal }, announce: false });

    // Our own gateway's text is the traffic we just published, reflected back
    if (isOwnGateway) return;

    onTextMessage?.({
      meshChannel,
      fromId,
      text: extractText(msg.payload),
    });
    return;
  }

  // ── Position / telemetry / neighbour info — presence, never bridged ──────
  // These carry the readings /node reports, so each is unpacked for what it
  // holds; none of them is ever posted to Discord as a message of its own.
  if (msgType === 'position' || msgType === 'neighborinfo' || msgType === 'telemetry') {
    const info = { ...hops, ...signal };

    if (msgType === 'position' && msg.payload) {
      const position = extractPosition(msg.payload);
      if (position) info.position = position;
    }

    if (msgType === 'telemetry' && msg.payload) {
      Object.assign(info, extractTelemetry(msg.payload));
    }

    recordNodeHeard({ fromId, meshChannel, info, announce: !isOwnGateway });
  }
}

module.exports = {
  connect,
  sendToMesh,
  getGatewayNodeId,
  getChannelIndex,
  isConnected,
  getConnectionInfo,
};
