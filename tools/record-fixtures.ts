// Dev-only fixture recorder: `CS2_WEB_CLIENT_LIVE=1 pnpm tsx tools/record-fixtures.ts [--token-file .local/token.json]`.
// Captures raw inbound ClientFromGC bodies (CMsgGCClient envelopes), scrubs them, writes test/fixtures/.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EMsg } from "../src/frames.js";
import { GCMsg } from "../src/emsg.js";
import { parseClientFromGC } from "../src/gc/envelope.js";
import { requireDev } from "./auth-qr.js";
import { scrub } from "./scrub.js";
import { closeSession, getCredentials, openSession } from "./session.js";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "test/fixtures");
async function main(): Promise<void> {
  requireDev();
  const creds = await getCredentials(process.argv.slice(2));
  const raw: Array<{ phase: string; gcMsgType: number; body: Uint8Array }> = [];
  let phase = "login";
  const s = await openSession(creds, ({ conn }) => {
    conn.addHandler(EMsg.ClientFromGC, (body) => {
      raw.push({ phase, gcMsgType: parseClientFromGC(body).gcMsgType, body });
    });
  });
  try {
    const unit = s.gc.cache.rootItems().find((i) => i.containedItemCount !== null);
    if (unit) {
      phase = "casket";
      try { await s.gc.loadCasketContents(unit.gcItemId, 20000); }
      catch (e) { console.warn(`storage unit load incomplete: ${(e as Error).message}`); }
    } else console.warn("no storage unit on this account: casket fixtures skipped");
  } finally {
    closeSession(s);
  }

  // Real protos set 0x80000000 on msgtype: mask for matching, keep the raw value in meta.
  const type = (m: number) => (m & 0x7fffffff) >>> 0;
  const welcome = raw.find((r) => type(r.gcMsgType) === GCMsg.ClientWelcome);
  const cache = raw.find((r) => type(r.gcMsgType) === GCMsg.SOCacheSubscribed);
  const casket = raw.filter((r) => r.phase === "casket");
  const files: Array<{ file: string; gcMsgType: number; phase: string; bytes: number; frames?: number }> = [];
  mkdirSync(OUT, { recursive: true });
  const write = (name: string, r: { phase: string; gcMsgType: number; body: Uint8Array } | undefined) => {
    if (!r) { console.warn(`no frame captured for ${name}`); return; }
    const clean = scrub(r.body, { steamId: creds.steamId, secrets: [creds.refreshToken] });
    writeFileSync(resolve(OUT, name), clean);
    files.push({ file: name, gcMsgType: r.gcMsgType, phase: r.phase, bytes: clean.length });
  };
  write("welcome.bin", welcome); // CS2 embeds the SO cache here (outofdate_subscribed_caches)
  if (cache) write("cache.bin", cache); // only if Steam also sent a standalone SOCacheSubscribed
  // Casket contents arrive as one SO frame per item: bundle them as [u32 LE length][body]... in arrival order.
  if (casket.length) {
    const parts = casket.map((r) => scrub(r.body, { steamId: creds.steamId, secrets: [creds.refreshToken] }));
    const out = new Uint8Array(parts.reduce((n, p) => n + 4 + p.length, 0));
    let o = 0;
    for (const p of parts) { new DataView(out.buffer).setUint32(o, p.length, true); out.set(p, o + 4); o += 4 + p.length; }
    writeFileSync(resolve(OUT, "casket-contents.bin"), out);
    files.push({ file: "casket-contents.bin", gcMsgType: -1, phase: "casket", bytes: out.length, frames: parts.length } as typeof files[number]);
  }

  const meta = {
    capturedAt: new Date().toISOString(),
    protoSourceCommit: readFileSync(resolve(ROOT, "proto/SOURCE_COMMIT.txt"), "utf8").trim(),
    testSteamId: creds.steamId.toString(),
    scrubbed: "refresh token bytes and non-test SteamID64 values zeroed in place",
    format: "raw CMsgGCClient envelope (ClientFromGC body); msgtype unmasked as received",
    files,
  };
  writeFileSync(resolve(OUT, "recorded.json"), JSON.stringify(meta, null, 2) + "\n");
  console.log(`wrote ${files.map((f) => f.file).join(", ")} to ${OUT}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
