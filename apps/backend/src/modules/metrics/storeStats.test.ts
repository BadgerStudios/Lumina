import { describe, expect, it } from "vitest";
import { decodeReport, githubAssetPlatform, parsePlayInstallsCsv } from "./storeStats.js";

describe("githubAssetPlatform", () => {
  it("sorts the real release asset names", () => {
    expect(githubAssetPlatform("Lumina-1.116.apk")).toBe("android");
    expect(githubAssetPlatform("Lumina-Owner-1.116.apk")).toBe("android-owner");
    expect(githubAssetPlatform("Lumina-1.0.116.AppImage")).toBe("desktop-linux");
    expect(githubAssetPlatform("Lumina-Setup-1.0.116.exe")).toBe("desktop-windows");
    expect(githubAssetPlatform("Lumina-1.0.116-win-portable.zip")).toBe("desktop-windows");
    expect(githubAssetPlatform("lumina-windows.zip")).toBe("desktop-windows");
    expect(githubAssetPlatform("SHA256SUMS.txt")).toBeNull();
  });
});

describe("Play installs report", () => {
  const csv =
    "Date,Package Name,Daily Device Installs,Daily Device Uninstalls,Daily Device Upgrades,Total User Installs,Daily User Installs,Daily User Uninstalls,Active Device Installs,Install events,Update events,Uninstall events\n" +
    "2026-09-29,com.luxffa.lumina,3,1,0,40,2,1,31,3,0,1\n" +
    "2026-09-30,com.luxffa.lumina,\"1,204\",0,0,41,5,0,32,1,0,0\n";

  it("reads a UTF-16LE export with a BOM", () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv, "utf16le")]);
    const days = parsePlayInstallsCsv(decodeReport(buf));
    expect(days).toEqual([
      { day: "2026-09-29", installs: 2, uninstalls: 1, active: 31 },
      { day: "2026-09-30", installs: 5, uninstalls: 0, active: 32 },
    ]);
  });

  it("falls back to device columns and ignores junk rows", () => {
    const old = "Date,Package Name,Daily Device Installs,Daily Device Uninstalls\n2026-01-02,x,7,2\nnot,a,row\n";
    expect(parsePlayInstallsCsv(old)).toEqual([{ day: "2026-01-02", installs: 7, uninstalls: 2, active: null }]);
  });
});
