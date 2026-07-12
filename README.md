# RC Notify

Discord bot that watches the VATSIM network and posts an embed when a monitored person or
position comes online — then deletes that embed when they disconnect.

One instance serves any number of Discord servers. Each server picks its own notification
channel, its own manager role, and keeps its own list of monitors; the data feed is fetched
once per poll and fanned out to all of them.

## What it watches

- **CIDs** — pilots and controllers alike.
- **Position prefixes** — everything before the first underscore, so `SFO` matches `SFO_TWR`,
  `SFO_GND`, `SFO_36_TWR`, and so on. Prefix watches apply to controllers.

Observers are ignored (OBS facility or OBS rating), as are `_ATIS` connections.

## What the embeds show

- **Controllers** — callsign, frequency, facility, rating, and the full controller ATIS.
- **Pilots** — `DEP → ARR`, aircraft, cruise altitude, and the filed route. If they connect
  without a flight plan the embed says so and is edited in place once they file one.

An embed is edited when the underlying details change (ATIS updated, route refiled) and deleted
once the connection leaves the data feed.

## Commands

All under `/rc`, and all scoped to the server they are run in.

| Command | Who | Description |
| --- | --- | --- |
| `/rc setup channel:#notams role:@staff` | Manage Server | Set the notification channel and the role allowed to manage monitors |
| `/rc config` | anyone | Show this server's configuration |
| `/rc watch-cid cid:1234567 [label]` | manager role | Monitor a CID |
| `/rc watch-prefix prefix:SFO [label]` | manager role | Monitor a position prefix |
| `/rc unwatch-cid cid:1234567` | manager role | Stop monitoring a CID |
| `/rc unwatch-prefix prefix:SFO` | manager role | Stop monitoring a prefix |
| `/rc list` | anyone | Show everything this server monitors |

Members with **Manage Server** always count as managers. Removing a watch immediately deletes
any live embeds it was responsible for, and changing the channel clears the old one.

## Discord setup

1. Create an application at <https://discord.com/developers/applications>, add a bot, copy the
   token and application ID.
2. Invite it to each server with the `bot` and `applications.commands` scopes and permission to
   view the target channel, send messages, embed links, and manage messages (so it can delete
   its own embeds on logoff).
3. No privileged intents are needed.
4. In each server, run `/rc setup` once.

## Deploying on Dokploy

1. Create a **Compose** service pointed at this repository (`docker-compose.yml` at the root).
2. Set `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` in the Dokploy environment tab. Everything else
   is optional — see [.env.example](.env.example).
3. Deploy. State lives in the `rc-notify-data` volume, so restarts and redeploys keep every
   server's configuration plus which embeds belong to which live connection.

## Running locally

```bash
cp .env.example .env   # fill it in
npm install
DATABASE_PATH=./data/rcnotify.sqlite node --env-file=.env src/index.js
```
