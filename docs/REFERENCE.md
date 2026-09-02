# loracord reference

Technical detail behind the bridge. For getting set up, see the [README](../README.md).

- [How it works](#how-it-works)
- [Channel indices](#channel-indices)
- [Gateway node ID](#gateway-node-id)
- [Duplicate suppression](#duplicate-suppression)
- [Echo prevention](#echo-prevention)
- [Slash command output](#slash-command-output)
- [Logging](#logging)
- [Architecture](#architecture)
- [Environment variables](#environment-variables)
- [Troubleshooting](#troubleshooting)

---

## How it works

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

Only text messages are posted to Discord, but every packet type is read for what
it says about its sender, and the result is what `/node` reports:

| Packet | Recorded |
|---|---|
| any | signal quality (`snr`, `rssi`) and hop count, when the packet carried them |
| `nodeinfo` | long and short names, hardware model, node role |
| `position` | latitude, longitude and altitude |
| `telemetry` | battery, voltage, channel utilisation, air utilisation, node uptime — and separately temperature, humidity and pressure |

Device and environment telemetry are kept apart, because a node sending both
would otherwise have each reading blanked by the other's packet. Position is
replaced whole rather than merged, so a node that moves can't be left carrying
the altitude it had two hilltops ago.

### Node announcements

The first time a node is heard from, it's announced inline as:
`🟢 **SHRT · Long Name** is now on the mesh · 2 hops away`

The hop count comes from the announcing packet — `heard direct` for a node
whose signal reached the gateway itself. Firmware reports it only when the
packet carried a usable count, and the trailing detail is left off entirely
when it didn't.

The exception is a node first heard via a text message: its message is bridged
into the channel as normal and the node is cached like any other, but no notice
is posted — the message itself is already proof the node is there, so a notice
directly above it would add nothing.

On a busy mesh these can outnumber the actual conversation, and the cache is
empty on startup so a restart re-announces everything. Set
`SUPPRESS_NODE_EVENTS=true` to drop them and bridge only real messages. The node
cache still tracks everything either way, so `/nodes` keeps working as normal.

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

Set `CONFIRM_SENDS=true` to have the bot echo each bridged message back into the
Discord channel as `✅ Sent to mesh: your message`. The echo is the text *as sent*,
so a message that was truncated to fit shows up truncated — which is the point of
having it. Off by default, since it doubles the traffic in a busy channel.

### Why the node needs an `mqtt` channel

Nothing is ever transmitted *on* the `mqtt` channel. The node builds its MQTT
subscriptions from your channel names, so a channel named exactly `mqtt` with
downlink enabled is what makes it listen on `msh/REGION/2/json/mqtt/`. That topic
is only the doorway for instructions; which channel the node actually broadcasts
on is set by the `channel` index in the downlink envelope. A message typed in the
Discord channel mapped to `LongFast` goes out on LongFast, and one typed in the
`Private` channel goes out on Private.

---

## Channel indices

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

## Gateway node ID

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

---

## Duplicate suppression

The bridge subscribes to `msh/REGION/2/json/#`, which covers **every** gateway
publishing under that root, not just yours. That's deliberate — it's what lets
the gateway node ID be discovered rather than configured — but it means a mesh
packet that two gateways both heard gets uplinked twice, arriving as two
identical JSON messages on two different topics.

Left alone, each copy would post to Discord separately and overwrite the
sender's cached hop count with the path through whichever gateway happened to
arrive last. So each packet is remembered by its sender and packet ID
(`from` + `id`, unique per transmission) for `DEDUPE_WINDOW_MS` — 5 minutes by
default — and later copies are dropped before anything is posted or cached.

Channel-index and gateway-ID discovery run *before* the check, since a
duplicate's topic identifies its channel just as well as the first copy's.

Packets carrying no usable ID are always treated as new: bridging an occasional
duplicate beats silently swallowing a real message. If you're on a
single-gateway broker and want the check gone entirely, set `DEDUPE_WINDOW_MS=0`
— the startup log says which mode is active.

---

## Echo prevention

The bridge never bridges or announces packets where `from` matches the gateway
node ID — whether that was configured via `GATEWAY_NODE_ID` or discovered from
the topic. This prevents messages the node rebroadcasts from being echo-posted
back to Discord.

Those packets are still *recorded*, though: your gateway's own telemetry is where
`/status` gets this node's battery and airtime figures, and it appears in `/nodes`
and `/node` like any other node. What's suppressed is posting, not listening.

Until the ID is known (i.e. before the first uplink arrives on a fresh start with
`GATEWAY_NODE_ID` unset), Discord → mesh sends are refused with a warning, since
the downlink envelope needs it.

---

## Slash command output

Commands are registered per-server on startup, in each server holding a channel from
`CHANNEL_MAP`, which makes them available immediately. If the log shows a registration
failure, the bot was almost certainly invited before `applications.commands` was added
to its OAuth2 scopes — re-invite it with that scope and restart.

### `/nodes`

Lists every node the bridge has heard from recently, most recent first:

```
📡 3 nodes heard in the last hour
!a1b2c3d4  MDYS · Matt's Base     2m ago  direct
!7f3e0011  HILL · Hilltop Relay  18m ago  2 hops
!0c9a4d22  (no nodeinfo yet)     51m ago  ?
```

The reply is ephemeral — only the person who ran it sees it, so it doesn't clutter
a bridged channel. Long lists are split across several messages.

Notes on reading the output:

- The list is whatever the in-memory node cache holds, so it **empties on restart**
  and drops nodes once they go `NODE_CACHE_TTL_MS` (1 hour by default) without being
  heard from. It's "recently heard", not the node's full NodeDB.
- Nodes that have only sent position or telemetry packets show as `(no nodeinfo yet)`
  — the bridge knows they exist but hasn't been told their name.
- The hop column comes from `hops_away` on the uplinked packet. `direct` means the
  gateway heard the node itself; `?` means that packet carried no hop count.

### `/status`

How the bridge, its MQTT link and your own node are doing:

```
📊 loracord status
Uptime   3h 12m
MQTT     connected · 192.168.1.10:1883
Topic    msh/EU_868/2/json/#
Gateway  !a1b2c3d4 (discovered)
Dedupe   5m window

Traffic since startup
Packets seen        1204
Duplicates dropped   143
Mesh to Discord       87
Discord to mesh       12
Sends refused          0

Channels
LongFast → #meshtastic · index 0 (discovered)
Private  → #mesh-private · ⚠️ index not known yet

This node — MDYS · Matt's Base
Battery      mains powered (4.12 V)
Air util TX  3.2%
Chan util    11.4%
Node uptime  2d 4h
Heard        2m ago
```

This is the command to reach for when messages aren't getting through. The two
rows that usually explain it:

- **Gateway** — `not known yet` means no uplink has arrived, so Discord → mesh
  sends are still being refused.
- **Channels** — a channel marked `⚠️ index not known yet` can receive from the
  mesh but can't transmit to it yet, because the bridge hasn't seen a packet on
  that channel to learn its slot number. Pin it in `CHANNEL_MAP` to skip the wait.

**`This node`** comes from your own gateway's telemetry, so it appears once the
node has reported in on its own telemetry interval — a few minutes after a cold
start. `Air util TX` is the node's own measure of how much of the last hour it
spent transmitting, which is the figure that matters against the 10% duty cycle
EU 868 allows.

### `/node <key>`

Everything the bridge knows about one node:

```
📡 HILL · Hilltop Relay
Node ID      !7f3e0011 (2134573073)
Hardware     HELTEC_V3 · CLIENT
Last heard   4m ago
Hops         2 hops
Signal       SNR 6.25 dB · RSSI -94 dBm
Position     53.48095, -2.23743 · 187 m (12m ago)
Distance     2.4 km NE of this gateway
Battery      64% (3.87 V)
Air util TX  1.1%
Chan util    9.8%
Environment  18.4 °C · 61% RH · 1013.2 hPa
Node uptime  9h 42m
```

The key can be a node ID (`!7f3e0011`, `0x7f3e0011` or a plain decimal), an exact
short name (`HILL`), or part of a long name or hex ID (`hillt`, `3e00`). Those are
tried in that order and the first that matches wins, so an exact short name is
never buried under loose substring hits. Autocomplete offers the nodes currently
in the cache as you type, and picking one resolves to its ID exactly.

Several matches get listed to choose from rather than the bridge guessing; none
gets a plain "nothing matching that" reply.

Every row is omitted when the bridge has no reading for it, so the reply only ever
states things actually heard over the air. A node that has sent nothing but a
position packet shows little more than its ID and when it was last heard — the
rest arrives as it sends `nodeinfo` and telemetry. `Distance` needs a position
from both that node and your gateway, and a map link is appended whenever the
node's own position is known.

---

## Logging

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
│         │                     │                            │
│  ┌──────▼───────┐             │                            │
│  │ packetDedupe │             │  (drop copies of a packet  │
│  │              │             │   other gateways uplinked) │
│  └──────┬───────┘             │                            │
│         │                     │                            │
│         └─────────┬───────────┘                            │
│                   │                                        │
│            ┌──────▼──────┐                                 │
│            │   index.js  │  (bridge + routing logic)       │
│            └──────┬──────┘                                 │
│                   │                                        │
│            ┌──────▼──────┐                                 │
│            │  nodeCache  │  (node ID → names, last seen,   │
│            │             │   hops, signal, position,       │
│            │             │   telemetry)                    │
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

## Environment variables

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
| `CONFIRM_SENDS` | | `false` | Echo each bridged message back into Discord, showing what actually reached the mesh |
| `SUPPRESS_NODE_EVENTS` | | `false` | Don't post the 🟢 notice when a node is first heard |
| `NODE_CACHE_TTL_MS` | | `3600000` | Node info cache TTL (ms) |
| `DEDUPE_WINDOW_MS` | | `300000` | How long a packet ID is remembered to recognise copies uplinked by other gateways; `0` disables |
| `LOG_LEVEL` | | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, or `silent` |

---

## Troubleshooting

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
