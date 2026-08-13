import net from "node:net";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { randomInt } from "node:crypto";
import { env } from "../../config/env.js";
import { isBlockedAddress } from "../../lib/safeFetch.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";

/**
 * Minecraft, the first game provider — chosen because everything it needs is genuinely open:
 * Mojang's profile APIs are public and keyless, the skin texture is public data, and the server
 * status protocol (Server List Ping) is documented and unauthenticated. No other major title
 * offers all three; this module is the template the framework grew around, not a special case
 * bolted on.
 */

const MOJANG_PROFILE = "https://api.mojang.com/users/profiles/minecraft/";
const MOJANG_SESSION = "https://sessionserver.mojang.com/session/minecraft/profile/";
const FETCH_TIMEOUT_MS = 6000;
/** A raw 64x64 skin is ~2KB; a whole megabyte means something upstream is not a skin. */
const MAX_SKIN_BYTES = 1024 * 1024;

async function mojangJson(url: string): Promise<unknown | null> {
  // Fixed, first-party hosts — this is not the SSRF surface (that's the status ping below, where
  // the operator supplies the address). Plain fetch with a timeout is the right amount of care.
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw new BadRequestError("Mojang did not answer, try again shortly");
  return res.json();
}

export interface MojangProfile {
  uuid: string;
  name: string;
  skinUrl: string | null;
}

export async function lookupMojangProfile(username: string): Promise<MojangProfile> {
  const clean = username.trim();
  // Mojang's own username rules. Validated here so a garbage string fails with a useful message
  // instead of a pass-through 404 from their API.
  if (!/^[A-Za-z0-9_]{3,16}$/.test(clean)) {
    throw new BadRequestError("That doesn't look like a Minecraft username");
  }

  const basic = (await mojangJson(MOJANG_PROFILE + encodeURIComponent(clean))) as { id: string; name: string } | null;
  if (!basic) throw new NotFoundError("No Minecraft account has that username");

  let skinUrl: string | null = null;
  try {
    const session = (await mojangJson(MOJANG_SESSION + basic.id)) as {
      properties?: { name: string; value: string }[];
    } | null;
    const textures = session?.properties?.find((p) => p.name === "textures");
    if (textures) {
      const decoded = JSON.parse(Buffer.from(textures.value, "base64").toString("utf8")) as {
        textures?: { SKIN?: { url?: string } };
      };
      skinUrl = decoded.textures?.SKIN?.url ?? null;
    }
  } catch {
    // A missing skin is a default-Steve profile, not a failed link.
  }

  return { uuid: basic.id, name: basic.name, skinUrl };
}

/**
 * Cache the skin PNG onto our own origin and return the local path.
 *
 * Hotlinking textures.minecraft.net from every profile card would leak viewer IPs to a third
 * party, break under their rate limits, and fight the CSP. The file is ~2KB; copying it once at
 * link time is strictly better on every axis. Temp-then-rename so a half-written file is never
 * served (the same discipline the soundboard upload learned the hard way).
 */
export async function cacheSkin(uuid: string, skinUrl: string | null): Promise<string | null> {
  if (!skinUrl) return null;
  const parsed = new URL(skinUrl);
  // The URL comes out of Mojang's signed payload, but trusting that chain blindly would make this
  // function an open proxy the moment anything upstream is spoofable. Pin the host.
  if (parsed.hostname !== "textures.minecraft.net") return null;

  const res = await fetch(skinUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX_SKIN_BYTES) return null;
  // PNG magic — a texture host serving HTML error pages must not land as a .png we then serve.
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;

  const dir = path.join(env.UPLOADS_DIR, "game-skins");
  await fs.mkdir(dir, { recursive: true });
  const file = `${uuid}.png`;
  const tmp = path.join(dir, `.${file}.tmp`);
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, path.join(dir, file));
  return `/game-skins/${file}`;
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function generateVerifyCode(): string {
  let out = "";
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

// ---------------------------------------------------------------- server status ping

export interface MinecraftStatus {
  online: boolean;
  playersOnline?: number;
  playersMax?: number;
  version?: string;
  motd?: string;
}

function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buf: Buffer, offset: number): { value: number; size: number } {
  let value = 0;
  let size = 0;
  for (;;) {
    if (offset + size >= buf.length) throw new Error("varint out of range");
    const b = buf[offset + size]!;
    value |= (b & 0x7f) << (7 * size);
    size++;
    if ((b & 0x80) === 0) break;
    if (size > 5) throw new Error("varint too long");
  }
  return { value, size };
}

export function parseHostPort(input: string): { host: string; port: number } {
  const m = /^([a-zA-Z0-9.-]{1,253})(?::(\d{1,5}))?$/.exec(input.trim());
  if (!m) throw new BadRequestError("Use host or host:port");
  const port = m[2] ? Number(m[2]) : 25565;
  if (port < 1 || port > 65535) throw new BadRequestError("Invalid port");
  return { host: m[1]!, port };
}

/**
 * Server List Ping — the handshake+status exchange every Minecraft server answers unauthenticated.
 *
 * ## This is the SSRF surface of the game module
 *
 * The address is operator-supplied and the dial is a raw TCP connection from inside the Docker
 * network, exactly the position the link-preview fetcher is in. Same discipline, adapted to TCP:
 * resolve the name ourselves, refuse if ANY answer is private/internal (`isBlockedAddress`, the
 * same table the link previews use), then dial the vetted IP — never the hostname — so a DNS
 * rebind between check and connect has nothing to rebind.
 */
export async function pingMinecraftServer(hostPort: string): Promise<MinecraftStatus> {
  const { host, port } = parseHostPort(hostPort);

  let address = host;
  if (net.isIP(host) === 0) {
    const answers = await dns.lookup(host, { all: true }).catch(() => []);
    if (answers.length === 0) return { online: false };
    if (answers.some((a) => isBlockedAddress(a.address))) {
      throw new BadRequestError("That address is not reachable from here");
    }
    address = answers[0]!.address;
  } else if (isBlockedAddress(host)) {
    throw new BadRequestError("That address is not reachable from here");
  }

  return new Promise<MinecraftStatus>((resolve) => {
    const socket = net.connect({ host: address, port });
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (status: MinecraftStatus) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(status);
    };

    socket.setTimeout(4000, () => done({ online: false }));
    socket.on("error", () => done({ online: false }));

    socket.on("connect", () => {
      // Handshake: protocol -1 (status doesn't care), the address we dialled, next-state 1.
      const hostBuf = Buffer.from(host, "utf8");
      const payload = Buffer.concat([
        Buffer.from([0x00]),
        writeVarInt(0xffffffff >>> 0),
        writeVarInt(hostBuf.length),
        hostBuf,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        Buffer.from([0x01]),
      ]);
      socket.write(Buffer.concat([writeVarInt(payload.length), payload]));
      // Status request.
      socket.write(Buffer.from([0x01, 0x00]));
    });

    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      // Bounded: a hostile "minecraft server" streaming forever must not grow our buffer forever.
      if (buf.length > 128 * 1024) return done({ online: false });
      try {
        const len = readVarInt(buf, 0);
        if (buf.length < len.size + len.value) return; // whole packet not here yet
        const packetId = readVarInt(buf, len.size);
        const strLen = readVarInt(buf, len.size + packetId.size);
        const start = len.size + packetId.size + strLen.size;
        const json = JSON.parse(buf.subarray(start, start + strLen.value).toString("utf8")) as {
          players?: { online?: number; max?: number };
          version?: { name?: string };
          description?: { text?: string } | string;
        };
        done({
          online: true,
          playersOnline: json.players?.online,
          playersMax: json.players?.max,
          version: json.version?.name,
          motd:
            typeof json.description === "string"
              ? json.description.slice(0, 120)
              : (json.description?.text ?? "").slice(0, 120),
        });
      } catch {
        // Incomplete varint — wait for more bytes; genuine garbage times out into offline.
      }
    });
  });
}
