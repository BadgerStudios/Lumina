/**
 * A short, human description of a user-agent string for the owner console: "Android 14 · Lumina app",
 * "Windows 10 · Chrome 128", "iPhone · Safari". The full string is always shown next to it; this only
 * saves reading one. Pure, so it is unit tested.
 */
export function describeUserAgent(ua: string | null | undefined, clientType?: string | null): string {
  if (!ua) return clientType ? clientName(clientType) : "Unknown device";
  const s = ua;
  let os = "Unknown OS";
  let m: RegExpMatchArray | null;
  if ((m = s.match(/Android (\d+(?:\.\d+)?)/))) os = `Android ${m[1].replace(/\.0$/, "")}`;
  else if (/iPhone/.test(s)) os = "iPhone";
  else if (/iPad/.test(s)) os = "iPad";
  else if ((m = s.match(/Windows NT (\d+\.\d+)/))) os = m[1] === "10.0" ? "Windows 10/11" : `Windows NT ${m[1]}`;
  else if ((m = s.match(/Mac OS X (\d+[._]\d+)/))) os = `macOS ${m[1].replace("_", ".")}`;
  else if (/CrOS/.test(s)) os = "ChromeOS";
  else if (/Linux/.test(s)) os = "Linux";
  // Model, when an Android browser reports one: "Android 14; SM-S918B Build/..."
  const model = s.match(/Android [\d.]+;\s*([^;)]+?)(?:\s+Build\/|\))/);
  let app: string;
  if (/LuminaOwner|Lumina-Owner/i.test(s)) app = "Lumina owner app";
  else if (/Lumina/i.test(s) && /Electron/i.test(s)) app = "Lumina desktop";
  else if (/; wv\)/.test(s) || clientType === "mobile") app = "Lumina app";
  else if (/Electron/i.test(s)) app = "Lumina desktop";
  else if ((m = s.match(/Edg\/(\d+)/))) app = `Edge ${m[1]}`;
  else if ((m = s.match(/OPR\/(\d+)/))) app = `Opera ${m[1]}`;
  else if ((m = s.match(/SamsungBrowser\/(\d+)/))) app = `Samsung Internet ${m[1]}`;
  else if ((m = s.match(/Firefox\/(\d+)/))) app = `Firefox ${m[1]}`;
  else if ((m = s.match(/Chrome\/(\d+)/))) app = `Chrome ${m[1]}`;
  else if (/Safari\//.test(s)) app = "Safari";
  else if (/okhttp|Dalvik/i.test(s)) app = "Lumina app";
  else app = clientType ? clientName(clientType) : "Browser";
  const dev = model && !/^(K|Linux)$/.test(model[1].trim()) ? ` (${model[1].trim()})` : "";
  return `${os}${dev} · ${app}`;
}

function clientName(c: string): string {
  return c === "mobile" ? "Lumina app" : c === "desktop" ? "Lumina desktop" : c;
}
