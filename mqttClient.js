'use strict';

const mqtt = require('mqtt');
const config = require('./config');
const nodeCache = require('./nodeCache');
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

// Callbacks registered by the bridge
let onTextMessage = null;
let onNodeEvent = null;

/**
 * Connect to the MQTT broker and set up subscriptions.
 *
 * @param {object} handlers
 * @param {function} handlers.onTextMessage  - called with { meshChannel, fromId, text }
 * @param {function} handlers.onNodeEvent    - called with { meshChannel, nodeId, type: 'online'|'offline'|'updated', displayName }
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

  discoverGatewayNodeId(gatewayId);
  // Before the echo check below — our own reflected packets name their channel
  // index just as usefully as anyone else's.
  discoverChannelIndex(meshChannel, msg.channel);

  const fromId = msg.from; // decimal node ID

  // ── Ignore our own gateway's reflected messages ────────────────────────────
  if (fromId === gatewayNodeId) return;

  const msgType = msg.type;

  // ── Node info — cache it and fire an "updated" event ─────────────────────
  if (msgType === 'nodeinfo' && msg.payload) {
    const wasKnown = nodeCache.getEntry(fromId) !== null;
    nodeCache.upsert(fromId, {
      longName: msg.payload.longname || nodeId.format(fromId),
      shortName: msg.payload.shortname || '????',
      isOnline: true,
    });

    if (!wasKnown) {
      // New node appearing — treat as an online event
      onNodeEvent?.({
        meshChannel,
        nodeId: fromId,
        type: 'online',
        displayName: nodeCache.getDisplayName(fromId),
      });
    }
    return;
  }

  // ── Text messages ─────────────────────────────────────────────────────────
  if (msgType === 'text' && msg.payload) {
    onTextMessage?.({
      meshChannel,
      fromId,
      text: extractText(msg.payload),
    });
    return;
  }

  // ── Neighbour info / position can signal a node is alive ─────────────────
  // We track presence without emitting Discord events for every packet
  if (fromId && (msgType === 'position' || msgType === 'neighborinfo' || msgType === 'telemetry')) {
    const wasKnown = nodeCache.getEntry(fromId) !== null;
    nodeCache.upsert(fromId, { isOnline: true });
    if (!wasKnown) {
      onNodeEvent?.({
        meshChannel,
        nodeId: fromId,
        type: 'online',
        displayName: nodeCache.getDisplayName(fromId),
      });
    }
  }
}

module.exports = { connect, sendToMesh, getGatewayNodeId, getChannelIndex };
