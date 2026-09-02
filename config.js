'use strict';

require('dotenv').config();

const nodeId = require('./nodeId');

function requireEnv(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

/**
 * Parse the CHANNEL_MAP env var into a two-way lookup plus any pinned indices:
 *   meshtasticToDiscord: { 'LongFast' => '1234567890' }
 *   discordToMeshtastic: { '1234567890' => 'LongFast' }
 *   meshChannelIndex:    { 'LongFast' => 0 }   (only explicitly pinned entries)
 *
 * Entries take one of two forms:
 *   MeshChannel:DiscordChannelId              — index discovered from uplinks
 *   MeshChannel:ChannelIndex:DiscordChannelId — index pinned to the node's slot
 *
 * The index is the channel's slot number on the node (0 = primary), which is
 * what the downlink envelope needs to transmit on the right channel.
 */
function parseChannelMap(raw) {
  const meshtasticToDiscord = new Map();
  const discordToMeshtastic = new Map();
  const meshChannelIndex = new Map();

  if (!raw || !raw.trim()) {
    throw new Error('CHANNEL_MAP is required and must not be empty');
  }

  for (const pair of raw.split(',')) {
    const parts = pair.trim().split(':').map((part) => part.trim());

    let meshChannel, rawIndex, discordChannelId;
    if (parts.length === 2) [meshChannel, discordChannelId] = parts;
    else if (parts.length === 3) [meshChannel, rawIndex, discordChannelId] = parts;

    if (!meshChannel || !discordChannelId) {
      throw new Error(
        `Invalid CHANNEL_MAP entry: "${pair}" — expected MeshChannel:DiscordChannelId ` +
        'or MeshChannel:ChannelIndex:DiscordChannelId'
      );
    }

    if (rawIndex !== undefined) {
      // Meshtastic nodes hold 8 channel slots
      if (!/^[0-7]$/.test(rawIndex)) {
        throw new Error(`Invalid channel index "${rawIndex}" in CHANNEL_MAP entry "${pair}" — must be 0–7`);
      }
      meshChannelIndex.set(meshChannel, Number(rawIndex));
    }

    meshtasticToDiscord.set(meshChannel, discordChannelId);
    discordToMeshtastic.set(discordChannelId, meshChannel);
  }

  return { meshtasticToDiscord, discordToMeshtastic, meshChannelIndex };
}

/**
 * GATEWAY_NODE_ID accepts either the hex form shown in the Meshtastic app
 * ("!a1b2c3d4") or a plain decimal. Blank/unset means "discover it at runtime".
 */
function parseGatewayNodeId(raw) {
  if (!raw || !raw.trim()) return null;
  return nodeId.parse(raw, 'GATEWAY_NODE_ID');
}

const channelMap = parseChannelMap(process.env.CHANNEL_MAP);

const config = {
  discord: {
    token: requireEnv('DISCORD_TOKEN'),
  },
  mqtt: {
    host: requireEnv('MQTT_HOST'),
    port: parseInt(process.env.MQTT_PORT || '1883', 10),
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
  },
  meshtastic: {
    rootTopic: (process.env.MQTT_ROOT_TOPIC || 'msh/EU_868').replace(/\/$/, ''),
    // Optional — if unset, it's discovered from the gateway ID in the MQTT
    // topic of the first packet our node uplinks. See mqttClient.js.
    gatewayNodeId: parseGatewayNodeId(process.env.GATEWAY_NODE_ID),
  },
  channels: channelMap,
  nodeCacheTtlMs: parseInt(process.env.NODE_CACHE_TTL_MS || '3600000', 10),
};

module.exports = config;
