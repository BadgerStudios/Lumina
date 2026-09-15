/**
 * The tones Lumina can play for a notification on Android, the kinds of notification that each
 * get their own, and how a chosen tone becomes a channel.
 *
 * Why this is a table and not a setting: Android locks a notification channel's sound the moment
 * the channel is created — it belongs to the person, not the app, and later changes are ignored.
 * So "let people choose their tone" cannot mean one channel whose sound is swapped. It has to mean
 * a channel per chosen tone, created on the phone when the choice is made, the previous one deleted.
 * The server's only job is to name the right channel in each push (channelIdFor). The ids here are
 * also the resource names under res/raw/ in both apps, so a wrong id would be a silent
 * notification; isSoundId() is the gate every client-supplied value goes through.
 *
 * Numbers are stable and shown in the picker, so "42" means the same tone in a conversation as it
 * does on a phone. Order is by family, then by character within it.
 */
export const SOUND_IDS = ["glint", "facet", "prism", "crystal", "quartz", "frost", "opal", "refract", "glimmer", "dawn", "beacon", "lumen", "halo", "ting", "carillon", "vesper", "zenith", "kindle", "ember", "candle", "lantern", "hearth", "firefly", "sunbeam", "spark", "twinkle", "strum", "harp", "ripple", "dewdrop", "photon", "nova", "corona", "flare", "aurora", "pulse", "blink", "glow", "daybreak", "aura", "breath", "mist", "radiance", "starlight", "droplet", "plink", "rain", "rise", "pond", "cascade"] as const;
export type SoundId = (typeof SOUND_IDS)[number];

export interface NotificationSound {
  number: number;
  id: SoundId;
  name: string;
  family: string;
}

export const NOTIFICATION_SOUNDS: readonly NotificationSound[] = [
  { number: 1, id: "glint", name: "Glint", family: "Glass & crystal" },
  { number: 2, id: "facet", name: "Facet", family: "Glass & crystal" },
  { number: 3, id: "prism", name: "Prism", family: "Glass & crystal" },
  { number: 4, id: "crystal", name: "Crystal", family: "Glass & crystal" },
  { number: 5, id: "quartz", name: "Quartz", family: "Glass & crystal" },
  { number: 6, id: "frost", name: "Frost", family: "Glass & crystal" },
  { number: 7, id: "opal", name: "Opal", family: "Glass & crystal" },
  { number: 8, id: "refract", name: "Refract", family: "Glass & crystal" },
  { number: 9, id: "glimmer", name: "Glimmer", family: "Bells & chimes" },
  { number: 10, id: "dawn", name: "Dawn", family: "Bells & chimes" },
  { number: 11, id: "beacon", name: "Beacon", family: "Bells & chimes" },
  { number: 12, id: "lumen", name: "Lumen", family: "Bells & chimes" },
  { number: 13, id: "halo", name: "Halo", family: "Bells & chimes" },
  { number: 14, id: "ting", name: "Ting", family: "Bells & chimes" },
  { number: 15, id: "carillon", name: "Carillon", family: "Bells & chimes" },
  { number: 16, id: "vesper", name: "Vesper", family: "Bells & chimes" },
  { number: 17, id: "zenith", name: "Zenith", family: "Bells & chimes" },
  { number: 18, id: "kindle", name: "Kindle", family: "Mallets" },
  { number: 19, id: "ember", name: "Ember", family: "Mallets" },
  { number: 20, id: "candle", name: "Candle", family: "Mallets" },
  { number: 21, id: "lantern", name: "Lantern", family: "Mallets" },
  { number: 22, id: "hearth", name: "Hearth", family: "Mallets" },
  { number: 23, id: "firefly", name: "Firefly", family: "Mallets" },
  { number: 24, id: "sunbeam", name: "Sunbeam", family: "Mallets" },
  { number: 25, id: "spark", name: "Spark", family: "Plucks" },
  { number: 26, id: "twinkle", name: "Twinkle", family: "Plucks" },
  { number: 27, id: "strum", name: "Strum", family: "Plucks" },
  { number: 28, id: "harp", name: "Harp", family: "Plucks" },
  { number: 29, id: "ripple", name: "Ripple", family: "Plucks" },
  { number: 30, id: "dewdrop", name: "Dewdrop", family: "Plucks" },
  { number: 31, id: "photon", name: "Photon", family: "FM bells" },
  { number: 32, id: "nova", name: "Nova", family: "FM bells" },
  { number: 33, id: "corona", name: "Corona", family: "FM bells" },
  { number: 34, id: "flare", name: "Flare", family: "FM bells" },
  { number: 35, id: "aurora", name: "Aurora", family: "FM bells" },
  { number: 36, id: "pulse", name: "Pulse", family: "FM bells" },
  { number: 37, id: "blink", name: "Blink", family: "FM bells" },
  { number: 38, id: "glow", name: "Glow", family: "Glow & swell" },
  { number: 39, id: "daybreak", name: "Daybreak", family: "Glow & swell" },
  { number: 40, id: "aura", name: "Aura", family: "Glow & swell" },
  { number: 41, id: "breath", name: "Breath", family: "Glow & swell" },
  { number: 42, id: "mist", name: "Mist", family: "Glow & swell" },
  { number: 43, id: "radiance", name: "Radiance", family: "Glow & swell" },
  { number: 44, id: "starlight", name: "Starlight", family: "Glow & swell" },
  { number: 45, id: "droplet", name: "Droplet", family: "Drops & ripples" },
  { number: 46, id: "plink", name: "Plink", family: "Drops & ripples" },
  { number: 47, id: "rain", name: "Rain", family: "Drops & ripples" },
  { number: 48, id: "rise", name: "Rise", family: "Drops & ripples" },
  { number: 49, id: "pond", name: "Pond", family: "Drops & ripples" },
  { number: 50, id: "cascade", name: "Cascade", family: "Drops & ripples" },
];

/** #42. Two airy notes rising a fourth — chosen by the owner as what Lumina sounds like by default. */
export const DEFAULT_SOUND: SoundId = "mist";

export function isSoundId(value: unknown): value is SoundId {
  return typeof value === "string" && (SOUND_IDS as readonly string[]).includes(value);
}

/**
 * The kinds of notification a person can give a different tone to. Everything not chat-shaped —
 * a friend request, a like on a post, a staff alert — is "message".
 *
 * "channel" is @everyone and role mentions: the pings aimed at a room rather than at you. Kept
 * apart from "mention" because a phone that buzzes the same way for "@you" and for the fortieth
 * "@everyone" of the day teaches its owner to ignore both.
 */
export const PUSH_KINDS = ["message", "direct", "mention", "channel"] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

export const PUSH_KIND_LABELS: Record<PushKind, string> = {
  message: "Messages",
  direct: "Direct messages",
  mention: "@mentions",
  channel: "Channel mentions",
};

/**
 * Channel ids carry the tone in their name. The prefixes are what the native side uses to find
 * and delete a superseded channel, so they must match NotificationSoundsPlugin.java in both apps.
 */
export const CHANNEL_PREFIX: Record<PushKind, string> = {
  message: "lumina_message__",
  direct: "lumina_direct__",
  mention: "lumina_mention__",
  channel: "lumina_channel__",
};
export const channelIdFor = (kind: PushKind, sound: SoundId): string => CHANNEL_PREFIX[kind] + sound;

export type DeviceTones = Record<PushKind, SoundId>;
export const DEFAULT_TONES: DeviceTones = { message: DEFAULT_SOUND, direct: DEFAULT_SOUND, mention: DEFAULT_SOUND, channel: DEFAULT_SOUND };

/** The column a kind's tone is stored in on DeviceToken. */
export const toneColumn = (kind: PushKind): `${PushKind}Sound` => `${kind}Sound`;

/**
 * Tones from a stored row, or from anything shaped like one. Anything that is not a known id
 * becomes the default rather than an error, because the alternative is a notification that names
 * a channel no phone has — which Android drops without a sound or a trace.
 */
export function tonesFrom(row: Partial<Record<`${PushKind}Sound`, unknown>> | null | undefined): DeviceTones {
  const out = { ...DEFAULT_TONES };
  for (const kind of PUSH_KINDS) {
    const v = row?.[toneColumn(kind)];
    if (isSoundId(v)) out[kind] = v;
  }
  return out;
}
