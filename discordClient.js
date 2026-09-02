'use strict';

const { Client, GatewayIntentBits, Events, ActivityType } = require('discord.js');
const config = require('./config');
const log = require('./logger').child({ component: 'Discord' });

let discordClient = null;

// Callback registered by the bridge for inbound Discord messages
let onDiscordMessage = null;

/**
 * Connect to Discord and begin listening.
 *
 * @param {object} handlers
 * @param {function} handlers.onDiscordMessage - called with { discordChannelId, content, authorTag }
 */
async function connect(handlers) {
  onDiscordMessage = handlers.onDiscordMessage;

  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  discordClient.once(Events.ClientReady, (readyClient) => {
    log.info(`Logged in as ${readyClient.user.tag}`);
    readyClient.user.setActivity('the mesh', { type: ActivityType.Watching });
  });

  discordClient.on(Events.MessageCreate, (message) => {
    // Ignore bots (including ourselves)
    if (message.author.bot) return;

    // Only handle messages in mapped Discord channels
    if (!config.channels.discordToMeshtastic.has(message.channelId)) return;

    // Ignore empty messages (attachments only, etc.)
    if (!message.content || !message.content.trim()) return;

    onDiscordMessage?.({
      discordChannelId: message.channelId,
      content: message.content.trim(),
      authorTag: message.author.username,
    });
  });

  discordClient.on(Events.Error, (err) => {
    log.error({ err }, 'Client error');
  });

  await discordClient.login(config.discord.token);
}

/**
 * Post a message to a Discord channel by ID.
 * Returns true on success, false if the channel is not found or bot lacks permission.
 *
 * @param {string} channelId
 * @param {string} content
 */
async function sendToChannel(channelId, content) {
  if (!discordClient) {
    log.warn('Cannot send — client not initialised');
    return false;
  }

  try {
    const channel = await discordClient.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      log.warn({ channelId }, 'Channel not found or not text-based');
      return false;
    }
    await channel.send(content);
    return true;
  } catch (err) {
    log.error({ err, channelId }, 'Failed to send to channel');
    return false;
  }
}

module.exports = { connect, sendToChannel };
