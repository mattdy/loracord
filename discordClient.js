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

/**
 * Never ping anyone, whatever the text says.
 *
 * Names and message bodies both come off the mesh, where anyone within radio
 * range picks their own. Escaping stops them rendering as a mention; this
 * stops them notifying anyone even if an escape is ever missed. Channel links
 * the bridge writes itself still render — they were never pings to begin with.
 */
const NO_MENTIONS = { parse: [] };

// Callbacks registered by the bridge
let onDiscordMessage = null;
let onNodesCommand = null;
let onStatusCommand = null;
let onNodeCommand = null;
let onNodeAutocomplete = null;

const NODES_COMMAND = new SlashCommandBuilder()
  .setName('nodes')
  .setDescription('List the Meshtastic nodes heard on the mesh recently')
  .toJSON();

const STATUS_COMMAND = new SlashCommandBuilder()
  .setName('status')
  .setDescription('Show how the bridge, its MQTT link and the gateway node are doing')
  .toJSON();

// The key is free text rather than a node picker because a mesh can hold more
// nodes than Discord will show as choices, and people know their own by ID as
// often as by name. Autocomplete narrows it as they type.
const NODE_COMMAND = new SlashCommandBuilder()
  .setName('node')
  .setDescription('Show everything the bridge knows about one node')
  .addStringOption((option) =>
    option
      .setName('key')
      .setDescription('Node ID (!a1b2c3d4), short name, or part of a long name')
      .setRequired(true)
      .setAutocomplete(true)
  )
  .toJSON();

const COMMANDS = [NODES_COMMAND, STATUS_COMMAND, NODE_COMMAND];

/**
 * Connect to Discord and begin listening.
 *
 * @param {object} handlers
 * @param {function} handlers.onDiscordMessage  - called with { discordChannelId, content, authorTag }
 * @param {function} handlers.onNodesCommand    - no arguments, returns string[] to reply with
 * @param {function} handlers.onStatusCommand   - no arguments, returns string[] to reply with
 * @param {function} handlers.onNodeCommand     - called with the typed key, returns string[]
 * @param {function} handlers.onNodeAutocomplete - called with the partial key, returns
 *   [{ name, value }] choices
 */
async function connect(handlers) {
  onDiscordMessage = handlers.onDiscordMessage;
  onNodesCommand = handlers.onNodesCommand;
  onStatusCommand = handlers.onStatusCommand;
  onNodeCommand = handlers.onNodeCommand;
  onNodeAutocomplete = handlers.onNodeAutocomplete;

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
      await guild.commands.set(COMMANDS);
      log.info(`Registered ${COMMANDS.length} commands in ${guild.name}`);
    } catch (err) {
      log.error(
        { err, guildId },
        'Failed to register commands — the bot most likely needs re-inviting with the ' +
        'applications.commands scope as well as bot'
      );
    }
  }
}

/**
 * What each slash command does, keyed by name. Every one returns the messages
 * to reply with, so the surrounding plumbing — ephemerality, splitting, error
 * handling — is written once rather than per command.
 */
const COMMAND_HANDLERS = {
  nodes: () => onNodesCommand?.(),
  status: () => onStatusCommand?.(),
  node: (interaction) => onNodeCommand?.(interaction.options.getString('key')),
};

/**
 * Handle a slash command invocation.
 *
 * Replies are ephemeral: a node dump is for whoever asked for it, and posting
 * it into a bridged channel would just be noise for everyone else.
 */
async function handleInteraction(interaction) {
  if (interaction.isAutocomplete()) {
    await handleAutocomplete(interaction);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const handler = COMMAND_HANDLERS[interaction.commandName];
  if (!handler) return;

  try {
    const messages = (await handler(interaction)) || [];
    if (!messages.length) return;

    await interaction.reply({
      content: messages[0],
      flags: MessageFlags.Ephemeral,
      allowedMentions: NO_MENTIONS,
    });
    for (const followUp of messages.slice(1)) {
      await interaction.followUp({
        content: followUp,
        flags: MessageFlags.Ephemeral,
        allowedMentions: NO_MENTIONS,
      });
    }
  } catch (err) {
    log.error({ err, command: interaction.commandName }, 'Failed to handle command');
    // An interaction that never gets a reply shows the user a red "failed"
    // banner with no explanation, so answer even when the command broke.
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({
          content: '⚠️ Something went wrong running that command.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
  }
}

/**
 * Suggest nodes as someone types the /node key.
 *
 * Discord gives this three seconds and accepts at most 25 choices, and treats
 * a failed response as a broken command — so a lookup that goes wrong answers
 * with an empty list, leaving the typed text usable, rather than throwing.
 */
async function handleAutocomplete(interaction) {
  if (interaction.commandName !== 'node') return;

  try {
    const choices = (await onNodeAutocomplete?.(interaction.options.getFocused())) || [];
    await interaction.respond(choices.slice(0, 25));
  } catch (err) {
    log.debug({ err }, 'Autocomplete lookup failed');
    await interaction.respond([]).catch(() => {});
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
    await channel.send({ content, allowedMentions: NO_MENTIONS });
    return true;
  } catch (err) {
    log.error({ err, channelId }, 'Failed to send to channel');
    return false;
  }
}

module.exports = { connect, sendToChannel };
