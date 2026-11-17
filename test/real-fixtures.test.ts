import { beforeAll, describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseClientFromGC } from "../src/gc/envelope.js";
import { SOCache } from "../src/gc/so-cache.js";
import { GCMsg } from "../src/emsg.js";

const DIR = resolve(import.meta.dirname, "fixtures");
const WELCOME = resolve(DIR, "welcome.bin");
const CASKET = resolve(DIR, "casket-contents.bin");

function frames(buf: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let o = 0; o + 4 <= buf.length;) { const n = dv.getUint32(o, true); out.push(buf.subarray(o + 4, o + 4 + n)); o += 4 + n; }
  return out;
}

function route(cache: SOCache, envelope: Uint8Array): void {
  const { gcMsgType, body } = parseClientFromGC(envelope);
  if (gcMsgType === GCMsg.ClientWelcome) cache.applyClientWelcome(body);
  else if (gcMsgType === GCMsg.SOCacheSubscribed) cache.applyCacheSubscribed(body);
  else if (gcMsgType === GCMsg.SOCreate) cache.applyCreate(body);
  else if (gcMsgType === GCMsg.SOUpdate) cache.applyUpdate(body);
  else if (gcMsgType === GCMsg.SOUpdateMultiple) cache.applyUpdateMultiple(body);
}

// Local-only: recordings hold real account data and are gitignored.
describe.skipIf(!existsSync(WELCOME))("real recorded fixtures", () => {
  const cache = new SOCache();
  // In beforeAll: a skipped describe still runs its body, and a fresh clone has no recordings.
  beforeAll(() => route(cache, readFileSync(WELCOME)));

  it("decodes the whole welcome inventory without failures", () => {
    expect(cache.rootItems().length).toBeGreaterThan(0);
    expect(cache.decodeFailures).toBe(0);
  });

  it("decodes storage units with sane counts and clean names", () => {
    const units = cache.rootItems().filter((i) => i.containedItemCount !== null);
    for (const u of units) {
      expect(u.containedItemCount!).toBeLessThanOrEqual(1000);
      expect(u.customName).not.toMatch(/[\x00-\x1f]/);
    }
  });

  it("decodes skins into valid float / integer seed / integer paint", () => {
    const skins = cache.rootItems().filter((i) => i.paintWear !== null);
    expect(skins.length).toBeGreaterThan(0);
    for (const s of skins) {
      expect(s.paintWear!).toBeGreaterThanOrEqual(0);
      expect(s.paintWear!).toBeLessThanOrEqual(1);
      if (s.paintSeed !== null) expect(Number.isInteger(s.paintSeed) && s.paintSeed >= 0 && s.paintSeed <= 1000).toBe(true);
      if (s.paintIndex !== null) expect(Number.isInteger(s.paintIndex)).toBe(true);
    }
  });

  it("decodes the recorded music kit and highlight charm", () => {
    const items = cache.rootItems();
    expect(items.filter((i) => i.defIndex === 1314).map((i) => i.musicKitId)).toEqual([70]);
    expect(items.filter((i) => i.defIndex === 1355).map((i) => i.charms[0])).toEqual([{ slot: 0, charmId: 83, pattern: null, highlightReelId: 633, offset: null }]);
    for (const i of items.filter((x) => x.defIndex === 1314 || x.defIndex === 1355)) {
      expect(i.unknownAttributes.map((a) => a.defindex)).not.toContain(166);
      expect(i.unknownAttributes.map((a) => a.defindex)).not.toContain(314);
    }
  });

  it.skipIf(!existsSync(CASKET))("loads the recorded storage unit to its declared count", () => {
    for (const f of frames(readFileSync(CASKET))) route(cache, f);
    const loaded = cache.rootItems().filter((u) => u.containedItemCount !== null && cache.casketContents(u.gcItemId).length > 0);
    expect(loaded.length).toBeGreaterThan(0);
    for (const u of loaded) expect(cache.casketContents(u.gcItemId).length).toBe(u.containedItemCount);
  });
});
