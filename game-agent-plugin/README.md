# Lumina Game Agent — Bukkit / Spigot / Paper / Purpur plugin

Connect a Minecraft server you already run to a Lumina game sandbox. The server shows up live in
your Lumina Activity panel — status, player count, console tail — and you can stop/restart it from
Lumina. **Lumina never sees or runs your mods, plugins, or world.** This plugin only reports what
it chooses to and honours stop/restart; its token can reach nothing in Lumina but your own
sandbox's status endpoint.

## Coverage
One dependency-free jar, compiled for Java 8, using only `HttpURLConnection` + the Bukkit API:

- **Loaders:** Spigot, Paper, Purpur (anything implementing the Bukkit API).
- **Versions:** 1.13+ via `api-version`; also loads on 1.8–1.12.
- **JVM:** Java 8 through 21+.

(Forge/Fabric *mods* — for modded servers with no Bukkit API — are a separate build, coming next.
For a modded server that runs a Bukkit bridge like Mohist/Arclight/Cardboard, this plugin works
as-is.)

## Install
1. In Lumina, open your sandbox → **Mint agent token**.
2. Drop `LuminaGameAgent.jar` into your server's `plugins/` folder and start the server once to
   generate `plugins/LuminaGameAgent/config.yml`.
3. Edit that config:
   ```yaml
   lumina:
     url: "https://lumina.badgerstudios.net"
     agent-token: "lga_...your token..."
     public-address: "play.yourhost.net:25565"   # what players type to connect
     heartbeat-seconds: 10
   ```
4. `/luminaagent reload` (or restart). `/luminaagent` shows connection status.

Your server now appears in the Lumina control panel within ~10 seconds.

## Build from source
```
mvn clean package     # → target/LuminaGameAgent.jar
```
No shading, no runtime dependencies.

## Security
The agent token is **scoped to one sandbox's heartbeat endpoint only** — verified: it is rejected
(401) by every other Lumina route. Even if the token leaks, it cannot read or touch any other user
or system. Treat it like a password regardless, and rotate it in Lumina if exposed.
