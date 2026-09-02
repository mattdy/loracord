'use strict';

const config = require('./config');
const mqttClient = require('./mqttClient');
const discordClient = require('./discordClient');
const nodeCache = require('./nodeCache');
const packetDedupe = require('./packetDedupe');
const stats = require('./stats');
const nodeId = require('./nodeId');
const formatter = require('./formatter');
const log = require('./logger').child({ component: 'Bridge' });

// ─── MQTT → Discord ───────────────────────────────────────────────────────────

/**
 * Called when a text message arrives on the mesh.
 * Looks up which Discord channel the mesh channel maps to and posts.
 */
async function handleMeshTextMessage({ meshChannel, fromId, text }) {
  const discordChannelId = config.channels.meshtasticToDiscord.get(meshChannel);
  if (!discordChannelId) {
    log.debug(`No Discord mapping for mesh channel "${meshChannel}" — ignoring`);
    return;
  }

  const formatted = formatter.meshMessageToDiscord({ fromId, text });
  log.info(`Mesh → Discord [${meshChannel}]: ${formatted}`);
  const posted = await discordClient.sendToChannel(discordChannelId, formatted);
  if (posted) stats.increment('meshToDiscord');
}

/**
 * Called the first time a node is heard from.
 * Posted inline in the relevant channel, unless SUPPRESS_NODE_EVENTS is set.
 */
async function handleNodeEvent({ meshChannel, nodeId, type, displayName }) {
  if (config.suppressNodeEvents) return;

  const discordChannelId = config.channels.meshtasticToDiscord.get(meshChannel);
  if (!discordChannelId) return;

  const formatted = formatter.nodeEventToDiscord({ type, displayName });
  if (!formatted) return;

  log.info(`Node event → Discord [${meshChannel}]: ${formatted}`);
  await discordClient.sendToChannel(discordChannelId, formatted);
}

// ─── Discord → MQTT ───────────────────────────────────────────────────────────

/**
 * Called when a user types in a mapped Discord channel.
 * Publishes the message to the mesh via MQTT downlink.
 */
async function handleDiscordMessage({ discordChannelId, content, authorTag }) {
  const meshChannel = config.channels.discordToMeshtastic.get(discordChannelId);
  if (!meshChannel) return; // shouldn't happen, but be defensive

  log.info(`Discord [${meshChannel}] from ${authorTag}: ${content}`);
  const sent = mqttClient.sendToMesh(content, meshChannel);
  stats.increment(sent === null ? 'sendsRefused' : 'discordToMesh');

  // Confirm with what actually went out rather than what was typed, so a
  // message truncated to fit the mesh is visibly truncated in the echo.
  if (sent !== null && config.confirmSends) {
    await discordClient.sendToChannel(
      discordChannelId,
      formatter.sendConfirmationToDiscord({ text: sent })
    );
  }
}

// ─── Slash commands ───────────────────────────────────────────────────────────

/**
 * Called when someone runs /nodes in Discord.
 *
 * Reports what the bridge has heard recently — which is everything the node
 * cache holds, so it empties on restart and drops nodes once they pass
 * NODE_CACHE_TTL_MS without being heard from.
 *
 * @returns {string[]} the reply, split across messages if the list is long
 */
function handleNodesCommand() {
  const nodes = nodeCache.list();
  log.info(`/nodes → ${nodes.length} node(s)`);
  return formatter.nodeListToDiscord(nodes);
}

/**
 * Called when someone runs /status in Discord.
 *
 * Reports the things that actually stop the bridge working: whether MQTT is
 * up, whether the gateway node ID is known yet, and whether each mapped
 * channel has a slot number to transmit on.
 *
 * @returns {string[]} the reply, split across messages if it runs long
 */
function handleStatusCommand() {
  const gatewayId = mqttClient.getGatewayNodeId();

  const channels = [...config.channels.meshtasticToDiscord.entries()].map(
    ([meshChannel, discordChannelId]) => ({
      meshChannel,
      discordChannelId,
      index: mqttClient.getChannelIndex(meshChannel),
      pinned: config.channels.meshChannelIndex.has(meshChannel),
    })
  );

  log.info('/status');
  return formatter.statusToDiscord({
    mqtt: mqttClient.getConnectionInfo(),
    gateway: {
      id: gatewayId,
      // Whether the ID came from GATEWAY_NODE_ID or was learned from a topic
      source: config.meshtastic.gatewayNodeId === null ? 'discovered' : 'configured',
      entry: gatewayId === null ? null : nodeCache.getEntry(gatewayId),
    },
    channels,
    counters: stats.snapshot(),
    dedupe: { enabled: packetDedupe.enabled, windowMs: packetDedupe.windowMs },
  });
}

/**
 * Called when someone runs /node in Discord.
 *
 * The key can be an ID, a short name or part of a long name, so a lookup can
 * legitimately match nothing or several nodes — those get their own replies
 * rather than an arbitrary pick.
 *
 * @param {string} key
 * @returns {string[]} the reply, split across messages if it runs long
 */
function handleNodeCommand(key) {
  const matches = nodeCache.find(key);
  log.info(`/node "${key}" → ${matches.length} match(es)`);

  if (!matches.length) return formatter.nodeNotFoundToDiscord(key);
  if (matches.length > 1) return formatter.nodeChoicesToDiscord(key, matches);

  const [node] = matches;
  const gatewayId = mqttClient.getGatewayNodeId();
  const gateway = gatewayId === null ? null : nodeCache.getEntry(gatewayId);

  return formatter.nodeDetailToDiscord({
    node,
    isGateway: node.id === gatewayId,
    gatewayPosition: gateway ? gateway.position : null,
  });
}

/**
 * Suggest nodes as someone types the /node key.
 *
 * Suggestions carry the hex ID as their value, so picking one resolves to
 * exactly that node however ambiguous the text they typed was.
 *
 * @param {string} partial
 * @returns {Array<{ name: string, value: string }>}
 */
function handleNodeAutocomplete(partial) {
  const query = String(partial || '').trim();
  const matches = query ? nodeCache.find(query) : nodeCache.list();
  return matches.map((node) => ({
    name: autocompleteLabel(node),
    value: nodeId.format(node.id),
  }));
}

/**
 * A node as it reads in the autocomplete dropdown, clipped to the 100
 * characters Discord allows a choice label.
 */
function autocompleteLabel(node) {
  const name = node.longName
    ? `${node.shortName || '????'} · ${node.longName}`
    : 'no nodeinfo yet';
  const label = `${name} (${nodeId.format(node.id)})`;
  return label.length > 100 ? `${label.slice(0, 99)}…` : label;
}

// ─── Startup ──────────────────────────────────────────────────────────────────

async function main() {
  log.info('Starting loracord…');
  log.info(`Root topic: ${config.meshtastic.rootTopic}`);
  const { gatewayNodeId } = config.meshtastic;
  log.info(
    gatewayNodeId !== null
      ? `Gateway node ID: ${nodeId.format(gatewayNodeId)} (${gatewayNodeId})`
      : 'Gateway node ID: not set — will auto-discover from the first uplink'
  );
  log.info(
    packetDedupe.enabled
      ? `Duplicate suppression: packets remembered for ${Math.round(packetDedupe.windowMs / 1000)}s`
      : 'Duplicate suppression: disabled — a packet heard by two gateways will bridge twice'
  );
  log.info(`Mapped channels: ${[...config.channels.meshtasticToDiscord.entries()]
    .map(([m, d]) => {
      const index = config.channels.meshChannelIndex.get(m);
      return `${m}${index === undefined ? '' : ` (index ${index})`} → ${d}`;
    })
    .join(', ')}`);

  // Connect Discord first so the client is ready before mesh messages arrive
  await discordClient.connect({
    onDiscordMessage: handleDiscordMessage,
    onNodesCommand: handleNodesCommand,
    onStatusCommand: handleStatusCommand,
    onNodeCommand: handleNodeCommand,
    onNodeAutocomplete: handleNodeAutocomplete,
  });

  // Then connect MQTT
  mqttClient.connect({
    onTextMessage: handleMeshTextMessage,
    onNodeEvent: handleNodeEvent,
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function shutdown() {
  log.info('Shutting down…');
  process.exit(0);
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
