package com.luxffa.lumina.owner;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The tone this phone plays for a notification, chosen by the person holding it.
 *
 * ## Why a channel per tone
 *
 * Android locks a channel's sound the moment the channel is created. It belongs to the person,
 * not the app, and any later setSound() is ignored — so "let people choose" cannot mean one
 * channel whose sound is swapped. It means a channel whose id carries the tone
 * (lumina_message__mist), created when the choice is made, with the previous one deleted so it
 * does not linger in the system settings screen. The server names the right channel in each push;
 * see @lumina/shared notificationSounds.ts, whose prefixes must match the ones here.
 *
 * ## Two entry points, deliberately different
 *
 * ensureDefaultsIfAbsent() runs at every boot and must NEVER delete a chosen channel: it only
 * creates a default one when none of that kind exists (first install), and retires the two
 * pre-tone channels this app used to create. applySounds() runs on a choice and is the only place
 * a prefixed channel is deleted. Merging them was the obvious shape, and would have reset every
 * phone to the default on every launch.
 */
@CapacitorPlugin(name = "NotificationSounds")
public class NotificationSoundsPlugin extends Plugin {

    /** Must match PUSH_KINDS and CHANNEL_PREFIX in @lumina/shared notificationSounds.ts. */
    public static final String[] KINDS = { "message", "direct", "mention", "channel" };
    /** #42, Mist. Chosen by the owner as what Lumina sounds like until a person picks otherwise. */
    public static final String DEFAULT_SOUND = "mist";
    /** The fixed-sound channels from before tones were choosable. Deleted wherever we see them. */
    private static final String[] LEGACY_IDS = { "lumina_messages", "lumina_mentions" };
    /** A tone name is a resource name, and only ever a resource name. */
    private static final Pattern SAFE = Pattern.compile("[a-z][a-z0-9_]{0,40}");

    private static String prefix(String kind) { return "lumina_" + kind + "__"; }

    private static String label(String kind) {
        switch (kind) {
            case "direct": return "Direct messages";
            case "mention": return "Mentions";
            case "channel": return "Channel mentions";
            default: return "Messages";
        }
    }

    private static String description(String kind) {
        switch (kind) {
            case "direct": return "When someone messages you directly.";
            case "mention": return "When someone mentions you by name.";
            case "channel": return "@everyone and role mentions in your spaces.";
            default: return "Messages in your spaces and conversations.";
        }
    }

    /** Heads-up for the two that are about you personally; ordinary for the room-wide ones. A
     * phone that pops a banner for the fortieth @everyone of the day teaches its owner to mute it. */
    private static int importance(String kind) {
        return kind.equals("direct") || kind.equals("mention")
            ? NotificationManager.IMPORTANCE_HIGH
            : NotificationManager.IMPORTANCE_DEFAULT;
    }

    public static void ensureDefaultsIfAbsent(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = ctx.getSystemService(NotificationManager.class);
        if (manager == null) return;
        for (String id : LEGACY_IDS) manager.deleteNotificationChannel(id);
        for (String kind : KINDS) {
            if (find(manager, prefix(kind)) == null) create(ctx, manager, kind, DEFAULT_SOUND);
        }
    }

    public static void applySounds(Context ctx, Map<String, String> tones) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = ctx.getSystemService(NotificationManager.class);
        if (manager == null) return;
        for (String id : LEGACY_IDS) manager.deleteNotificationChannel(id);
        for (String kind : KINDS) {
            String sound = tones.get(kind);
            retireOthers(manager, prefix(kind), prefix(kind) + sound);
            if (manager.getNotificationChannel(prefix(kind) + sound) == null) create(ctx, manager, kind, sound);
        }
    }

    private static void create(Context ctx, NotificationManager m, String kind, String sound) {
        create(ctx, m, prefix(kind) + sound, label(kind), description(kind), sound, importance(kind));
    }

    private static String find(NotificationManager m, String prefix) {
        for (NotificationChannel c : m.getNotificationChannels()) {
            if (c.getId().startsWith(prefix)) return c.getId();
        }
        return null;
    }

    private static void retireOthers(NotificationManager m, String prefix, String keep) {
        for (NotificationChannel c : m.getNotificationChannels()) {
            String id = c.getId();
            if (id.startsWith(prefix) && !id.equals(keep)) m.deleteNotificationChannel(id);
        }
    }

    private static void create(Context ctx, NotificationManager m, String id, String name, String description, String sound, int importance) {
        NotificationChannel channel = new NotificationChannel(id, name, importance);
        channel.setDescription(description);
        channel.enableVibration(true);
        channel.setShowBadge(true);
        channel.setSound(
            Uri.parse("android.resource://" + ctx.getPackageName() + "/raw/" + sound),
            new AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .build()
        );
        m.createNotificationChannel(channel);
    }

    private boolean hasResource(String name) {
        if (name == null || !SAFE.matcher(name).matches()) return false;
        Context ctx = getContext();
        return ctx.getResources().getIdentifier(name, "raw", ctx.getPackageName()) != 0;
    }

    private JSObject currentJson() {
        JSObject out = new JSObject();
        NotificationManager m = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? getContext().getSystemService(NotificationManager.class) : null;
        for (String kind : KINDS) {
            String sound = DEFAULT_SOUND;
            if (m != null) {
                String id = find(m, prefix(kind));
                if (id != null) sound = id.substring(prefix(kind).length());
            }
            out.put(kind, sound);
        }
        return out;
    }

    /** Make the chosen tones this phone's channels. Rejects a name that is not a bundled resource. */
    @PluginMethod
    public void apply(PluginCall call) {
        Map<String, String> tones = new HashMap<>();
        for (String kind : KINDS) {
            String sound = call.getString(kind, DEFAULT_SOUND);
            if (!hasResource(sound)) {
                call.reject("Unknown tone for " + kind);
                return;
            }
            tones.put(kind, sound);
        }
        applySounds(getContext(), tones);
        call.resolve(currentJson());
    }

    /** Which tones the channels on this phone currently carry. */
    @PluginMethod
    public void current(PluginCall call) {
        call.resolve(currentJson());
    }

    /**
     * Play a tone so a person can hear it before choosing. On the notification stream and with
     * notification attributes, so it respects the same volume and Do Not Disturb the real thing will.
     */
    @PluginMethod
    public void preview(PluginCall call) {
        String name = call.getString("name", DEFAULT_SOUND);
        if (!hasResource(name)) {
            call.reject("Unknown tone");
            return;
        }
        try {
            Context ctx = getContext();
            MediaPlayer player = new MediaPlayer();
            player.setAudioAttributes(
                new AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .build()
            );
            player.setDataSource(ctx, Uri.parse("android.resource://" + ctx.getPackageName() + "/raw/" + name));
            player.setOnCompletionListener(MediaPlayer::release);
            player.setOnErrorListener((mp, what, extra) -> { mp.release(); return true; });
            player.prepare();
            player.start();
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not play that tone", e);
        }
    }
}
