package net.lumina.agent;

import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.LoggerContext;
import org.apache.logging.log4j.core.appender.AbstractAppender;
import org.apache.logging.log4j.core.config.Property;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Deque;

/**
 * Lumina Game Agent — an in-server plugin for Bukkit / Spigot / Paper / Purpur (one jar, all of
 * them, and every Minecraft version from 1.13+ where plugin.yml api-version applies; it also loads
 * fine on older 1.8–1.12 servers).
 *
 * It is deliberately DEPENDENCY-FREE: only java.net.HttpURLConnection (JDK 1.1+) and the Bukkit
 * API, so the same artifact runs on a Java 8 legacy server and a Java 21 modern one with nothing
 * to shade. It talks to exactly one Lumina endpoint — the sandbox agent heartbeat — using the
 * scoped token, so it can report this server's status and receive stop/restart, and nothing more.
 *
 * The server owner runs their own server with whatever mods/plugins they like; this plugin just
 * makes it visible and controllable from the Lumina control panel. Lumina never sees or runs any
 * of the owner's content.
 */
public final class LuminaAgentPlugin extends JavaPlugin {

    private BukkitTask heartbeatTask;
    private final Deque<String> consoleRing = new ArrayDeque<String>();
    private AbstractAppender consoleAppender;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        attachConsoleCapture();
        startHeartbeat();
        getLogger().info("Lumina Game Agent enabled — reporting to " + getConfig().getString("lumina.url"));
    }

    @Override
    public void onDisable() {
        if (heartbeatTask != null) heartbeatTask.cancel();
        if (consoleAppender != null) {
            try {
                LoggerContext ctx = (LoggerContext) LogManager.getContext(false);
                ctx.getConfiguration().getRootLogger().removeAppender(consoleAppender.getName());
                consoleAppender.stop();
            } catch (Throwable ignored) { }
        }
        // A final OFFLINE so the panel reflects the shutdown immediately rather than waiting to go stale.
        try { report("OFFLINE"); } catch (Throwable ignored) { }
    }

    // ---- console capture: a Log4j2 appender on the ROOT logger, which IS the real server console.
    // (A JUL handler on Bukkit.getLogger() only sees that one logger — found live: /version and
    // /list output never reached it. Paper/Bukkit have run on Log4j2 since 1.7.) -----------------
    private void attachConsoleCapture() {
        try {
            final Deque<String> ring = this.consoleRing;
            consoleAppender = new AbstractAppender("LuminaConsole", null, null, false, Property.EMPTY_ARRAY) {
                @Override public void append(LogEvent event) {
                    try {
                        // Strip ANSI colour codes — Paper's console is coloured, but the panel wants plain text.
                        String msg = event.getMessage().getFormattedMessage().replaceAll("\\[[;\\d]*m", "");
                        String line = event.getLevel() + " " + msg;
                        synchronized (ring) {
                            ring.addLast(line);
                            while (ring.size() > 40) ring.removeFirst();
                        }
                    } catch (Throwable ignored) { }
                }
            };
            consoleAppender.start();
            LoggerContext ctx = (LoggerContext) LogManager.getContext(false);
            ctx.getConfiguration().getRootLogger().addAppender(consoleAppender, null, null);
            ctx.updateLoggers();
        } catch (Throwable t) {
            getLogger().warning("Could not attach console capture (status/players still report): " + t.getMessage());
        }
    }

    private String consoleTail() {
        StringBuilder sb = new StringBuilder();
        synchronized (consoleRing) {
            for (String line : consoleRing) sb.append(line).append('\n');
        }
        return sb.length() > 7900 ? sb.substring(sb.length() - 7900) : sb.toString();
    }

    // ---- heartbeat loop ------------------------------------------------------------------------
    private void startHeartbeat() {
        if (heartbeatTask != null) heartbeatTask.cancel();
        long ticks = Math.max(5, getConfig().getInt("lumina.heartbeat-seconds", 10)) * 20L;
        // ASYNC: never block the main server thread on network IO.
        heartbeatTask = Bukkit.getScheduler().runTaskTimerAsynchronously(this, new Runnable() {
            @Override public void run() {
                try {
                    String command = report("ONLINE");
                    if (command != null) handleCommand(command);
                } catch (Exception e) {
                    getLogger().warning("Lumina heartbeat failed: " + e.getMessage());
                }
            }
        }, 40L, ticks);
    }

    /** POST the heartbeat; returns the queued command (or null). Runs off-thread. */
    private String report(String status) throws IOException {
        String url = getConfig().getString("lumina.url", "").replaceAll("/$", "") + "/api/sandbox/agent/heartbeat";
        String token = getConfig().getString("lumina.agent-token", "");
        if (token == null || token.isEmpty() || token.startsWith("PASTE_")) {
            getLogger().warning("Lumina agent-token is not set in config.yml — not reporting.");
            return null;
        }
        // Player counts must be read on the main thread's view but getOnlinePlayers is safe to size.
        int players = Bukkit.getOnlinePlayers().size();
        int max = Bukkit.getMaxPlayers();
        String address = getConfig().getString("lumina.public-address", "");

        String body = "{"
                + "\"status\":\"" + status + "\","
                + "\"playerCount\":" + players + ","
                + "\"maxPlayers\":" + max
                + (address != null && !address.isEmpty() ? ",\"connectAddress\":\"" + esc(address) + "\"" : "")
                + ",\"consoleTail\":\"" + esc(consoleTail()) + "\""
                + "}";

        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod("POST");
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(8000);
        conn.setDoOutput(true);
        conn.setRequestProperty("Authorization", "GameAgent " + token);
        conn.setRequestProperty("Content-Type", "application/json");
        OutputStream os = conn.getOutputStream();
        os.write(body.getBytes(StandardCharsets.UTF_8));
        os.close();

        int code = conn.getResponseCode();
        if (code < 200 || code >= 300) {
            getLogger().warning("Lumina heartbeat returned HTTP " + code);
            return null;
        }
        String resp = readAll(conn.getInputStream());
        return extractString(resp, "command"); // minimal parse; the only field we act on
    }

    private void handleCommand(String command) {
        if ("stop".equals(command)) {
            getLogger().info("Lumina control panel requested STOP — shutting down.");
            Bukkit.getScheduler().runTask(this, new Runnable() { public void run() { Bukkit.shutdown(); } });
        } else if ("restart".equals(command)) {
            getLogger().info("Lumina control panel requested RESTART.");
            // Bukkit has no portable restart; this triggers the server's own restart-script path
            // where configured, otherwise a clean stop the owner's wrapper can relaunch.
            Bukkit.getScheduler().runTask(this, new Runnable() { public void run() { Bukkit.spigot().restart(); } });
        }
        // "start" is meaningless to an already-running in-server plugin and is ignored.
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (args.length > 0 && args[0].equalsIgnoreCase("reload")) {
            reloadConfig();
            startHeartbeat();
            sender.sendMessage(ChatColor.GREEN + "[Lumina] Reloaded and reconnected.");
            return true;
        }
        String token = getConfig().getString("lumina.agent-token", "");
        boolean configured = token != null && !token.isEmpty() && !token.startsWith("PASTE_");
        sender.sendMessage(ChatColor.AQUA + "[Lumina] " + (configured ? "connected to " + getConfig().getString("lumina.url") : "NOT configured — set lumina.agent-token in config.yml"));
        return true;
    }

    // ---- tiny helpers (no JSON library needed) --------------------------------------------------
    private static String esc(String s) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default: if (c < 0x20) b.append(String.format("\\u%04x", (int) c)); else b.append(c);
            }
        }
        return b.toString();
    }

    private static String readAll(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        byte[] buf = new byte[1024];
        int n;
        while ((n = in.read(buf)) != -1) sb.append(new String(buf, 0, n, StandardCharsets.UTF_8));
        in.close();
        return sb.toString();
    }

    /** Extract a top-level string field value, or null (handles the "command": null case). */
    private static String extractString(String json, String key) {
        String needle = "\"" + key + "\"";
        int i = json.indexOf(needle);
        if (i < 0) return null;
        i = json.indexOf(':', i + needle.length());
        if (i < 0) return null;
        i++;
        while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
        if (i >= json.length() || json.charAt(i) != '"') return null; // null or non-string
        int end = json.indexOf('"', i + 1);
        return end < 0 ? null : json.substring(i + 1, end);
    }
}
