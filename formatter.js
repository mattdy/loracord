'use strict';

const nodeCache = require('./nodeCache');

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
 * Escape Discord markdown special characters in user-provided text.
 * Prevents mesh messages containing * _ ` ~ from breaking Discord formatting.
 */
function escapeDiscordMarkdown(text) {
  return text.replace(/([*_`~\\|<>])/g, '\\$1');
}

module.exports = { meshMessageToDiscord, nodeEventToDiscord, sendConfirmationToDiscord };
