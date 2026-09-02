# loracord

A bridge between your Meshtastic mesh and a Discord server. Messages sent on the
mesh appear in Discord, and messages typed in Discord go back out over the mesh.

It also announces nodes as they turn up, and adds three slash commands for
seeing what's on the air: `/nodes`, `/status` and `/node`.

## What you need

- **Docker** and Docker Compose on a machine that stays on
- **An MQTT broker** on your network (Mosquitto is the usual choice)
- **A Meshtastic node** connected to that broker, which will be your gateway
- **A Discord server** you can add a bot to

---

## 1. Set up your Meshtastic node

In the Meshtastic app, on the node you want to act as the gateway:

**Settings → Module Config → MQTT**

- Enabled ✅
- MQTT Server Address: your broker's LAN IP, e.g. `192.168.1.10`
- **JSON Enabled ✅** — the bridge won't see anything without this
- Encryption Enabled: leave off if the broker is your own

**Settings → Channels**

- Turn on **Uplink** for each channel you want bridged into Discord
- Add a channel named exactly `mqtt` and turn on **Downlink** for it. The PSK can
  be anything. This is what lets Discord messages reach the mesh — nothing is
  ever sent on the `mqtt` channel itself.
- Reboot the node once you've added it

---

## 2. Create the Discord bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
   and click **New Application** — call it whatever you like
2. Open **Bot**, click **Add Bot**, and enable **Message Content Intent** under
   Privileged Gateway Intents
3. Copy the **Token** — you'll need it in a moment, and it won't be shown again
4. Open **OAuth2 → URL Generator** and tick:
   - Scopes: `bot` and `applications.commands`
   - Permissions: `Send Messages`, `Read Messages/View Channels`, `Read Message History`
5. Open the URL it generates and invite the bot to your server

You'll also need the ID of each Discord channel you want to bridge. Enable
**User Settings → Advanced → Developer Mode**, then right-click a channel and
choose **Copy Channel ID**.

---

## 3. Configure

```bash
cp .env.example .env
```

Then fill in `.env`:

```env
DISCORD_TOKEN=your-bot-token

MQTT_HOST=192.168.1.10
MQTT_PORT=1883

# Must match your node's region
MQTT_ROOT_TOPIC=msh/EU_868

# Which mesh channel goes to which Discord channel
CHANNEL_MAP=LongFast:1234567890123456789
```

`CHANNEL_MAP` pairs a Meshtastic channel name with a Discord channel ID, and
takes a comma-separated list if you're bridging more than one:

```env
CHANNEL_MAP=LongFast:1234567890123456789,Private:9876543210987654321
```

The channel name must match what's in the Meshtastic app **exactly**, including
capitals. Everything else has a sensible default — see the
[reference](docs/REFERENCE.md#environment-variables) if you want to change it.

---

## 4. Run it

```bash
docker compose up -d      # start
docker compose logs -f    # watch it work
docker compose down       # stop
```

It restarts on its own after a crash or a reboot.

Give it a minute or two after starting. The bridge picks up which node is your
gateway, and which slot each channel sits in, from the first packets that come
in — until it has seen them, Discord messages won't be sent out to the mesh.
Run `/status` to see whether it's ready.

---

## Using it

Messages coming off the mesh appear in the mapped channel:

```
✉️ MDYS · Matt's Base: heading up the hill
```

Anything you type in that channel goes out over the mesh (keep it under 220
characters — longer messages get cut off). New nodes get a 🟢 notice when
they're first heard.

**`/nodes`** — everything heard from in the last hour, most recent first:

```
📡 3 nodes heard in the last hour
!a1b2c3d4  MDYS · Matt's Base     2m ago  direct
!7f3e0011  HILL · Hilltop Relay  18m ago  2 hops
!0c9a4d22  (no nodeinfo yet)     51m ago  ?
```

**`/status`** — whether the bridge, MQTT and your own node are healthy, plus
message counts since it started. This is the one to check when messages aren't
getting through.

**`/node <name>`** — everything known about one node: where it is, how far away,
signal, battery, temperature, uptime. Start typing and it will autocomplete.

Replies to these are only visible to you, so they don't clutter the channel.

---

## Something's not working

Run **`/status`** first — most problems show up there:

- **Gateway `not known yet`** — no packets have arrived from your node. Check
  MQTT is enabled on it, with JSON on.
- **A channel marked `⚠️ index not known yet`** — the bridge can receive on that
  channel but can't send to it yet, because nothing has come in on it. Wait for
  traffic, or [pin the index](docs/REFERENCE.md#channel-indices).

Then check `docker compose logs -f`. Common causes:

| Symptom | Usual cause |
|---|---|
| Nothing arrives from the mesh | JSON or Uplink not enabled on the node, or a typo in the channel name |
| Discord messages don't reach the mesh | No `mqtt` channel with Downlink on the node, or it wasn't rebooted after adding it |
| Nodes show as `!a1b2c3d4` | Their name hasn't been broadcast yet — wait a few minutes |
| Bot ignores messages | Message Content Intent is off in the developer portal |
| Slash commands missing | Bot was invited without `applications.commands` — re-invite and restart |

More detail in [Troubleshooting](docs/REFERENCE.md#troubleshooting).

---

## Going deeper

[**docs/REFERENCE.md**](docs/REFERENCE.md) covers how the bridge works packet by
packet, all environment variables, channel indices, duplicate handling, logging
and the architecture.
