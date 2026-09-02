# loracord

A bidirectional Meshtastic ↔ Discord bridge over MQTT, written in Node.js and designed for Docker deployment.

**What it does:**
- Forwards incoming Meshtastic text messages to mapped Discord channels
- Sends messages typed in those Discord channels back out over the mesh via MQTT downlink
- Posts inline node online/offline events in the relevant channel

---

## Prerequisites

- Docker + Docker Compose
- A Meshtastic node connected to your local MQTT broker (Mosquitto or similar) with **JSON mode enabled**
- A Discord bot token (see below)
- Your MQTT broker reachable from the host running this container

---

## 1. Meshtastic Node Setup

Before the bot will work, your gateway node needs configuring in the Meshtastic app:

**MQTT Module** (Settings → Module Config → MQTT):
- Enabled: ✅
- MQTT Server Address: your broker's LAN IP (e.g. `192.168.1.10`)
- JSON Enabled: ✅ ← **critical for this bridge**
- Encryption Enabled: leave off if using a private broker (simpler)

**Channels** (Settings → Channels):
- On each channel you want to bridge, enable **Uplink** ✅
- Create a channel named exactly `mqtt` and enable **Downlink** ✅ on it
  - The PSK for the `mqtt` channel can be set to anything — it doesn't matter
  - Reboot the node after creating this channel

**Gateway Node ID — you probably don't need to set this:**

The bridge learns your gateway's node ID by itself. Every JSON packet your node
uplinks is published under a topic ending in that node's ID
(`msh/EU_868/2/json/LongFast/!a1b2c3d4`), so the first packet to arrive tells
the bridge what it needs, and it logs what it found:

```
[MQTT] Discovered gateway node ID: !a1b2c3d4 (2712847316)
```

Set `GATEWAY_NODE_ID` explicitly only if your broker carries traffic from more
than one gateway and you need to pin a specific one. When you do, paste the ID
exactly as the Meshtastic app shows it on the node info screen:

```env
GATEWAY_NODE_ID=!a1b2c3d4
```

Plain decimal (`2712847316`) and `0xa1b2c3d4` are also accepted. An all-digit
value is read as decimal, so use the `!` or `0x` prefix if you mean hex.

> **Why is the `mqtt` channel needed — and does that mean everything goes out on it?**
> No. The node builds its MQTT subscriptions from your channel names, so a
> channel named exactly `mqtt` with downlink enabled is what makes it listen on
> `msh/REGION/2/json/mqtt/`. That topic is only the doorway for instructions;
> nothing is ever transmitted *on* the `mqtt` channel. Which channel the node
> actually broadcasts on is set by the `channel` index in the downlink envelope,
> so a message typed in the Discord channel mapped to `LongFast` goes out on
> LongFast, and one typed in the `Private` channel goes out on Private. See
> [Channel indices](#channel-indices) for how the bridge works those out.

---

## 2. Discord Bot Setup

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** → give it a name (e.g. `Loracord`)
3. Go to **Bot** → click **Add Bot**
4. Under **Privileged Gateway Intents**, enable:
   - **Message Content Intent** ← required to read channel messages
5. Copy the **Token** — this is your `DISCORD_TOKEN`
6. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Read Messages/View Channels`, `Read Message History`
7. Copy the generated URL, open it in a browser, and invite the bot to your server

**Getting Discord Channel IDs:**
- In Discord, go to User Settings → Advanced → enable **Developer Mode**
- Right-click any channel → **Copy Channel ID**

---

## 3. Configuration

Copy the example env file:

```bash
cp .env.example .env
```

Edit `.env`:

```env
DISCORD_TOKEN=your-bot-token

MQTT_HOST=192.168.1.10
MQTT_PORT=1883

MQTT_ROOT_TOPIC=msh/EU_868          # match your node's region setting
# GATEWAY_NODE_ID=!a1b2c3d4        # optional — auto-discovered if omitted

# Map mesh channel names to Discord channel IDs (comma-separated)
CHANNEL_MAP=LongFast:1234567890123456789,Private:9876543210987654321
```

**`CHANNEL_MAP` format:**

```
MeshtasticChannelName:DiscordChannelId
MeshtasticChannelName:ChannelIndex:DiscordChannelId    # index pinned
```

Multiple channels separated by commas. The Meshtastic channel name must match **exactly** (case-sensitive) what appears in the Meshtastic app.

### Channel indices

Downlink envelopes address channels by their **slot number** on the node (0–7,
where 0 is the primary channel), not by name — so to send a Discord message out
on the right mesh channel, the bridge needs to know which slot that channel sits
in.

It works this out on its own. Every JSON packet carries the index alongside the
channel name in its topic, so the first packet seen on a channel is enough:

```
[MQTT] Discovered channel index for "Private": 2
```

Until a channel has been seen, Discord → mesh sends on it are **refused** rather
than guessed at, since falling back to slot 0 would put a message meant for a
private channel out on the primary one. If you'd rather not wait for that first
packet — or the channel is quiet enough that it may be a while — pin the index
in `CHANNEL_MAP` by slotting it between the name and the Discord channel ID:

```env
CHANNEL_MAP=LongFast:0:1234567890123456789,Private:2:9876543210987654321
```

The channel's index is its position in the Meshtastic app's channel list,
counting from 0 at the top. A pinned index always wins over discovery.

---

## 4. Running with Docker Compose

```bash
# Build and start
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

The container will restart automatically on failure or reboot (`restart: unless-stopped`).

---

## 5. How It Works

### Mesh → Discord

When a text message arrives on the mesh via MQTT, the bridge:

1. Parses the JSON packet from the topic `msh/REGION/2/json/CHANNELNAME/!nodeId`:
   ```json
   { "from": 2712847316, "channel": 0, "type": "text", "payload": { "text": "message text" } }
   ```
   Note the asymmetry with the downlink below: uplinked text is **wrapped in an
   object**, never a bare string. And if the message body itself happens to parse
   as JSON, the firmware publishes that value in place of the wrapper — so a mesh
   user typing `42` or `{"a":1}` yields a `payload` that is a number or an object.
   The bridge unwraps all three shapes.
2. Looks up the sender's short name and long name from its node cache
3. Posts to the mapped Discord channel as: `✉️ **SHRT · Long Name**: message text`

Nodes are usually seen via a position or telemetry packet before their `nodeinfo`
arrives, and those carry no names — until one does, a node is shown by the hex ID
Meshtastic displays (`!a1b2c3d4`) rather than a name.

Node online events are posted inline as: `🟢 **SHRT · Long Name** is now on the mesh`

### Discord → Mesh

When a message is sent in a mapped Discord channel:

1. The bot picks it up (messages from other bots are ignored)
2. Looks up which mesh channel that Discord channel maps to, and that channel's index
3. Publishes a JSON downlink to `msh/REGION/2/json/mqtt/`:
   ```json
   { "from": 2712847316, "channel": 2, "type": "sendtext", "payload": "your message" }
   ```
4. Your gateway node receives it and broadcasts over LoRa on channel index 2

Messages longer than 220 characters are truncated (Meshtastic's protocol limit is ~228 bytes).

### Echo Prevention

The bridge ignores any uplinked packets where `from` matches the gateway node ID — whether that was configured via `GATEWAY_NODE_ID` or discovered from the topic. This prevents messages the node rebroadcasts from being echo-posted back to Discord.

Until the ID is known (i.e. before the first uplink arrives on a fresh start with `GATEWAY_NODE_ID` unset), Discord → mesh sends are refused with a warning, since the downlink envelope needs it.

---

## 6. Logging

Logging uses [pino](https://getpino.io). Every line is tagged with the component
that emitted it (`Bridge`, `MQTT`, `Discord`).

Set `LOG_LEVEL` in your `.env` to control verbosity:

| Level | Description |
|-------|-------------|
| `trace` | Everything, including pino internals |
| `debug` | Every packet seen, publish confirmations |
| `info` | Startup, connections, every bridged message (default) |
| `warn` | Reconnections, skipped messages |
| `error` | Failures only |
| `silent` | No output |

```env
LOG_LEVEL=debug
```

An unrecognised value falls back to `info`.

### Output format

Under Docker (`NODE_ENV=production`) each line is a JSON record, ready for
`docker compose logs`, Loki, or anything else that ingests structured logs:

```json
{"level":30,"time":1730000000000,"component":"MQTT","msg":"Connected"}
```

Running locally with dev dependencies installed, output is colourised and
human-readable via `pino-pretty`:

```
[2026-01-01 12:00:00] INFO: [MQTT] Connected
```

To pretty-print production JSON on the fly:

```bash
docker compose logs -f | npx pino-pretty
```

---

## 7. Troubleshooting

**No messages appearing in Discord from the mesh:**
- Check `docker compose logs -f` — are MQTT messages being received?
- Confirm the Meshtastic channel name in `CHANNEL_MAP` matches exactly (check casing)
- Ensure JSON is enabled on the node's MQTT module
- Ensure Uplink is enabled on the channel

**Messages sent in Discord aren't reaching the mesh:**
- Confirm the node has a channel named exactly `mqtt` with Downlink enabled
- The node must have been rebooted after creating that channel
- Check logs for `Cannot send — channel index for "X" not known yet` — nothing has been seen on that channel yet, so pin its index in `CHANNEL_MAP` (see [Channel indices](#channel-indices))
- Check logs for `[MQTT] Published to mesh` — if it's there, the publish succeeded; the issue is node-side

**Messages from Discord arrive on the wrong mesh channel:**
- The index the bridge discovered doesn't match the node's actual slot for that channel
- Pin the correct one in `CHANNEL_MAP` as `MeshChannel:Index:DiscordChannelId` — counting from 0 at the top of the app's channel list

**Node names showing as `!a1b2c3d4` instead of real names:**
- The bridge caches node names from `nodeinfo` packets, which nodes broadcast periodically
- Wait a few minutes for nodes to announce themselves, or trigger a node info broadcast from the app
- Node cache TTL is 1 hour by default; set `NODE_CACHE_TTL_MS` to adjust

**Discord bot not responding to messages:**
- Ensure the **Message Content Intent** is enabled in the Discord developer portal
- Confirm the bot has been invited with the correct permissions

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Docker Container                                           │
│                                                             │
│  ┌──────────────┐      ┌──────────────┐                    │
│  │  mqttClient  │      │discordClient │                    │
│  │              │      │              │                    │
│  │ subscribe:   │      │ listen:      │                    │
│  │ msh/+/2/     │      │ mapped       │                    │
│  │ json/#       │      │ channels     │                    │
│  └──────┬───────┘      └──────┬───────┘                    │
│         │                     │                            │
│         └─────────┬───────────┘                            │
│                   │                                        │
│            ┌──────▼──────┐                                 │
│            │   index.js  │  (bridge + routing logic)       │
│            └──────┬──────┘                                 │
│                   │                                        │
│            ┌──────▼──────┐                                 │
│            │  nodeCache  │  (node ID → display name)       │
│            └─────────────┘                                 │
└─────────────────────────────────────────────────────────────┘
         │                              │
   ┌─────▼──────┐                ┌──────▼──────┐
   │   MQTT     │                │   Discord   │
   │   Broker   │                │     API     │
   └─────┬──────┘                └─────────────┘
         │
   ┌─────▼──────┐
   │Meshtastic  │
   │  Node      │
   └────────────┘
```

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | ✅ | — | Discord bot token |
| `MQTT_HOST` | ✅ | — | MQTT broker hostname or IP |
| `MQTT_PORT` | | `1883` | MQTT broker port |
| `MQTT_USERNAME` | | — | MQTT auth username |
| `MQTT_PASSWORD` | | — | MQTT auth password |
| `MQTT_ROOT_TOPIC` | | `msh/EU_868` | Meshtastic root topic |
| `GATEWAY_NODE_ID` | | auto-discovered | Gateway node ID as hex (`!a1b2c3d4`) or decimal, for echo prevention + downlink |
| `CHANNEL_MAP` | ✅ | — | `MeshChannel:DiscordChannelId,...`, or `MeshChannel:ChannelIndex:DiscordChannelId,...` to pin indices |
| `NODE_CACHE_TTL_MS` | | `3600000` | Node info cache TTL (ms) |
| `LOG_LEVEL` | | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, or `silent` |
