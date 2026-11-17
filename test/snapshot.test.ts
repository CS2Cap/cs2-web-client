import { describe, it, expect } from "vitest";
import { buildSnapshot } from "../src/snapshot.js";
import { FakeGC } from "../src/testing/fake-gc.js";

describe("buildSnapshot", () => {
  it("marks complete when every unit loads", async () => {
    const gc = FakeGC.with({ root: 3, units: { "100": 5 }, timeouts: [] });
    const snap = await buildSnapshot(gc as any, { steamId: 1n, loadTimeoutMs: 1000 });
    expect(snap.complete).toBe(true);
    expect(snap.items.length).toBe(3 + 1 + 5);
    expect(snap.steamId).toBe("1");
    expect(snap).not.toHaveProperty("generation"); // the uploader assigns it from the persisted floor
  });

  it("carries non-economy items apart from the synced items", async () => {
    const gc = FakeGC.with({ root: 2, units: {}, timeouts: [] });
    const key = { ...gc.cache.rootItems()[0], gcItemId: "key", flags: 24 };
    gc.nonEconomy = [key];
    const snap = await buildSnapshot(gc as any, { steamId: 1n, loadTimeoutMs: 1000 });
    expect(snap.items.map((i) => i.gcItemId)).not.toContain("key");
    expect(snap.nonEconomy).toEqual([key]);
  });

  it("carries the care package", async () => {
    const gc = FakeGC.with({ root: 1, units: {}, timeouts: [] });
    const pkg = { generationTime: 1793000000, balance: 2, slots: [] };
    gc.cache.carePackage = () => pkg;
    const snap = await buildSnapshot(gc as any, { steamId: 1n, loadTimeoutMs: 1000 });
    expect(snap.carePackage).toEqual(pkg);
  });

  it("carries the Armory star balance (live 2026-10-28: READ_ARMORY read null without it)", async () => {
    const gc = FakeGC.with({ root: 1, units: {}, timeouts: [] });
    gc.cache.armoryStars = 3;
    gc.cache.armoryTracks = [1850];
    const snap = await buildSnapshot(gc as any, { steamId: 1n, loadTimeoutMs: 1000 });
    expect(snap.armoryStars).toBe(3);
    expect(snap.armoryTracks).toEqual([1850]);
  });

  it("marks incomplete and keeps partial data when a unit times out", async () => {
    const gc = FakeGC.with({ root: 3, units: { "100": 5, "200": 2 }, timeouts: ["100"] });
    const snap = await buildSnapshot(gc as any, { steamId: 1n, loadTimeoutMs: 50 });
    expect(snap.complete).toBe(false);
    expect(snap.items.length).toBeGreaterThanOrEqual(3);
    expect(snap.items.filter((i) => i.casketId === "200").length).toBe(2);
  });

  it("is never complete when the cache dropped an undecodable object", async () => {
    const gc = FakeGC.with({ root: 3, units: {}, timeouts: [] });
    (gc.cache as { decodeFailures: number }).decodeFailures = 1;
    const snap = await buildSnapshot(gc as any, { steamId: 1n, loadTimeoutMs: 1000 });
    expect(snap.complete).toBe(false);
  });

  it("skips loading a unit whose item count and modification date match a stored read, and stamps every unit", async () => {
    const gc = FakeGC.with({ root: 1, units: { "100": 2, "200": 3, "300": 1 }, timeouts: [], modified: { "100": 1791868730, "200": 1791868800 } });
    const known = { "100": { count: 2, modified: 1791868730 }, "200": { count: 3, modified: 1 }, "300": { count: 1, modified: 0 } };
    const snap = await buildSnapshot(gc as any, { steamId: 1n, loadTimeoutMs: 1000, known });
    expect(snap.reused).toEqual(["100"]);
    expect(gc.loadedUnits().sort()).toEqual(["200", "300"]); // 300 has no modification date: always read
    expect(snap.items.filter((i) => i.casketId === "100")).toEqual([]); // the caller merges the stored contents
    expect(snap.stamps).toEqual({ "100": { count: 2, modified: 1791868730 }, "200": { count: 3, modified: 1791868800 } });
    expect(snap.complete).toBe(true);
  });
});
