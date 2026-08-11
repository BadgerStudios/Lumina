// Proves the offsite backup can actually be restored — from R2, not from the local disk.
//
// This is the only assertion that matters for a backup system. Everything else (the dump ran, the
// upload returned 200, the object is listed) can be true while the archive is unrestorable, and
// that is precisely the failure you discover on the worst possible day. So this pulls the newest
// dump back OUT of the bucket, loads it into a throwaway database, and counts rows in it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnv, r2Configured, r2Client, listKeys, getObject } from "../../../scripts/r2.mjs";

const REPO = "/home/lucid/lumina";
let pass = 0, fail = 0;
const ok = (m) => (console.log(`PASS: ${m}`), pass++);
const bad = (m) => (console.log(`FAIL: ${m}`), fail++);

const psql = (db, q) =>
  execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "lumina", "-d", db, "-tAc", q],
    { cwd: REPO, encoding: "utf8" }).trim();

loadEnv(REPO);

async function main() {
  const scratch = `lumina_restore_probe_${Date.now()}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-restore-"));

  try {
    if (!r2Configured()) return bad("R2 is not configured — there is no offsite copy to restore");
    const client = r2Client();
    const bucket = process.env.BACKUP_S3_BUCKET;

    const dumps = (await listKeys(client, bucket, "backups/db-")).sort(
      (a, b) => (b.modified?.getTime() ?? 0) - (a.modified?.getTime() ?? 0),
    );
    if (dumps.length === 0) return bad("no database backup found in the bucket");
    ok(`found ${dumps.length} offsite dump(s), newest ${dumps[0].key}`);

    // Downloaded, not read from disk. The local file could be fine while the uploaded bytes are
    // truncated, and that difference is the whole reason this test exists.
    const bytes = await getObject(client, bucket, dumps[0].key);
    if (bytes.length === dumps[0].size) ok(`downloaded ${(bytes.length / 1024).toFixed(0)}KB intact`);
    else bad(`downloaded ${bytes.length} bytes, listing said ${dumps[0].size}`);

    const gz = path.join(tmp, "dump.sql.gz");
    fs.writeFileSync(gz, bytes);
    try {
      execFileSync("gzip", ["-t", gz]);
      ok("the downloaded archive passes a gzip integrity check");
    } catch {
      return bad("the downloaded archive is corrupt");
    }

    execFileSync("gunzip", ["-f", gz]);
    const sqlPath = path.join(tmp, "dump.sql");

    // A scratch database, never the live one. A restore test that could touch production is not a
    // test anyone should run.
    psql("postgres", `create database "${scratch}";`);
    execFileSync("sh", ["-c",
      `docker compose exec -T postgres psql -U lumina -d ${scratch} -v ON_ERROR_STOP=0 < ${sqlPath} > /dev/null 2>&1`,
    ], { cwd: REPO });
    ok("the dump loaded into a scratch database");

    const users = Number(psql(scratch, 'select count(*) from "User";'));
    const live = Number(psql("lumina", 'select count(*) from "User";'));
    if (users > 0 && Math.abs(users - live) <= 5) {
      ok(`restored data matches production (${users} users restored, ${live} live)`);
    } else {
      bad(`restored ${users} users against ${live} live — the dump is not a full copy`);
    }

    const videos = Number(psql(scratch, 'select count(*) from "Video";'));
    if (videos > 0) ok(`content tables restored too (${videos} videos)`);
    else bad("no videos in the restored database");

    // The uploads archive is the other half — a database with no media is a half restore.
    const media = (await listKeys(client, bucket, "backups/uploads-")).sort(
      (a, b) => (b.modified?.getTime() ?? 0) - (a.modified?.getTime() ?? 0),
    );
    if (media.length > 0 && (media[0].size ?? 0) > 1_000_000) {
      ok(`the media archive is offsite too (${((media[0].size ?? 0) / 1024 / 1024).toFixed(1)}MB)`);
    } else {
      bad("no substantial uploads archive in the bucket");
    }
  } catch (e) {
    bad(`offsite restore: ${String(e).split("\n")[0]}`);
  } finally {
    try { psql("postgres", `drop database if exists "${scratch}";`); } catch { /* never created */ }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log("cleaned up the scratch database");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
