'use strict';

const config = require('./config');
const mqttClient = require('./mqttClient');
const discordClient = require('./discordClient');
const nodeCache = require('./nodeCache');
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
  await discordClient.sendToChannel(discordChannelId, formatted);
}

/**
 * Called when a node comes online or goes offline.
 * Posted inline in the relevant channel.
 */
async function handleNodeEvent({ meshChannel, nodeId, type, displayName }) {
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
