'use strict';

const {
  Client,
  GatewayIntentBits,
  Events,
  ActivityType,
  MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');
const config = require('./config');
const log = require('./logger').child({ component: 'Discord' });

let discordClient = null;

// Callbacks registered by the bridge
let onDiscordMessage = null;
let onNodesCommand = null;

const NODES_COMMAND = new SlashCommandBuilder()
  .setName('nodes')
  .setDescription('List the Meshtastic nodes heard on the mesh recently')
  .toJSON();

/**
 * Connect to Discord and begin listening.
 *
 * @param {object} handlers
 * @param {function} handlers.onDiscordMessage - called with { discordChannelId, content, authorTag }
 * @param {function} handlers.onNodesCommand   - called with no arguments, returns string[] to reply with
 */
async function connect(handlers) {
  onDiscordMessage = handlers.onDiscordMessage;
  onNodesCommand = handlers.onNodesCommand;

  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  discordClient.once(Events.ClientReady, async (readyClient) => {
    log.info(`Logged in as ${readyClient.user.tag}`);
    readyClient.user.setActivity('the mesh', { type: ActivityType.Watching });
    await registerCommands(readyClient);
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

  discordClient.on(Events.InteractionCreate, (interaction) => {
    handleInteraction(interaction);
  });

  discordClient.on(Events.Error, (err) => {
    log.error({ err }, 'Client error');
  });

  await discordClient.login(config.discord.token);
}

/**
 * Register the bot's slash commands in every guild it bridges a channel into.
 *
 * Guild-scoped registration takes effect immediately, where global commands
 * can take up to an hour to appear — and the guilds we care about are exactly
 * the ones holding the channels in CHANNEL_MAP.
 */
async function registerCommands(readyClient) {
  const guildIds = new Set();

  for (const channelId of config.channels.discordToMeshtastic.keys()) {
    try {
      const channel = await readyClient.channels.fetch(channelId);
      if (channel?.guildId) guildIds.add(channel.guildId);
    } catch (err) {
      log.warn({ err, channelId }, 'Could not resolve channel to a server — skipping command registration there');
    }
  }

  for (const guildId of guildIds) {
    try {
      const guild = await readyClient.guilds.fetch(guildId);
      await guild.commands.set([NODES_COMMAND]);
      log.info(`Registered /nodes in ${guild.name}`);
    } catch (err) {
      log.error(
        { err, guildId },
        'Failed to register /nodes — the bot most likely needs re-inviting with the ' +
        'applications.commands scope as well as bot'
      );
    }
  }
}

/**
 * Handle a slash command invocation.
 *
 * Replies are ephemeral: a node dump is for whoever asked for it, and posting
 * it into a bridged channel would just be noise for everyone else.
 */
async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'nodes') return;

  try {
    const messages = (await onNodesCommand?.()) || [];
    if (!messages.length) return;

    await interaction.reply({ content: messages[0], flags: MessageFlags.Ephemeral });
    for (const followUp of messages.slice(1)) {
      await interaction.followUp({ content: followUp, flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    log.error({ err }, 'Failed to handle /nodes');
    // An interaction that never gets a reply shows the user a red "failed"
    // banner with no explanation, so answer even when the listing broke.
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: '⚠️ Could not read the node list.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  }
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
