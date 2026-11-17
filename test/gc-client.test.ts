import { describe, it, expect, vi } from "vitest";
import { create, toBinary } from "@bufbuild/protobuf";
import { FakeCM } from "../src/testing/fake-cm.js";
import { CMClient, CMConnection } from "../src/cm/client.js";
import { GCClient } from "../src/gc/client.js";
import { GCMsg } from "../src/emsg.js";
import { wrapClientToGC } from "../src/gc/envelope.js";
import { CMsgSOSingleObjectSchema } from "../src/gen/csgo/gcsdk_gcmessages_pb.js";
import { CSOEconItemSchema } from "../src/gen/csgo/base_gcmessages_pb.js";
import { buildSyntheticCacheSubscribed, makeEconItem } from "../src/testing/synthetic.js";

const UNIT = "5000000000001";

function offlineGc(): { gc: GCClient; feed: (t: number, b: Uint8Array) => void } {
  const handlers: Array<(b: Uint8Array) => void> = [];
  const fakeCm = { connection: { addHandler: (_e: number, cb: (b: Uint8Array) => void) => { handlers.push(cb); return () => {}; } } };
  const gc = new GCClient(fakeCm as unknown as CMClient);
  return { gc, feed: (t, b) => handlers.forEach((h) => h(wrapClientToGC(t, b))) };
}

describe("GCClient", () => {
  it("reaches welcome and exposes the subscribed cache", async () => {
    const fake = await FakeCM.start({ logonResult: 1, sessionId: 1, gcWelcomeWithCache: true });
    const conn = new CMConnection(fake.transport());
    await conn.open();
    const cm = new CMClient(conn);
    await cm.logon({ steamId: 1n, accountName: "x", refreshToken: "t.t.t" });
    const gc = new GCClient(cm);
    await gc.waitForWelcome(3000);
    expect(gc.cache.rootItems().length).toBeGreaterThan(0);
    await fake.stop();
  });

  it("a malformed SO object does not stop later messages", () => {
    const { gc, feed } = offlineGc();
    feed(GCMsg.SOCreate, new Uint8Array([0xff, 0xff, 0xff]));
    feed(GCMsg.SOCacheSubscribed, buildSyntheticCacheSubscribed());
    expect(gc.cache.rootItems().length).toBe(2);
  });

  it("reconcileAfter does not treat absence as applied before the cache is welcomed", async () => {
    const { gc } = offlineGc();
    expect(await gc.reconcileAfter({ kind: "withdraw", itemId: "999", casketId: UNIT })).toBe("not-applied");
    expect(await gc.reconcileAfter({ kind: "destroy", itemId: "999" })).toBe("not-applied");
  });

  it("waitForWelcome clears its timers and rejects when the send throws", async () => {
    const fakeCm = { connection: { isClosed: false, onClose: () => () => {}, addHandler: () => () => {}, sendMessage: () => { throw new Error("closed"); } } };
    const gc = new GCClient(fakeCm as unknown as CMClient);
    vi.useFakeTimers();
    try {
      await expect(gc.waitForWelcome(60000)).rejects.toThrow("closed");
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  function liveGc() {
    const handlers: Array<(b: Uint8Array) => void> = [];
    const sent: number[] = [];
    const fakeCm = { connection: { isClosed: false, onClose: () => () => {}, addHandler: (_e: number, cb: (b: Uint8Array) => void) => { handlers.push(cb); return () => {}; }, sendMessage: () => { sent.push(Date.now()); } } };
    const gc = new GCClient(fakeCm as unknown as CMClient);
    return { gc, sent, welcome: () => handlers.forEach((h) => h(wrapClientToGC(GCMsg.SOCacheSubscribed, buildSyntheticCacheSubscribed()))) };
  }

  it("re-claims CS2 once when the welcome stalls, then still takes the welcome", async () => {
    vi.useFakeTimers();
    try {
      const { gc, welcome } = liveGc();
      const reclaim = vi.fn().mockResolvedValue(undefined);
      const wait = gc.waitForWelcome(25000, { afterMs: 10000, reclaim });
      await vi.advanceTimersByTimeAsync(9999);
      expect(reclaim).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10000);
      expect(reclaim).toHaveBeenCalledTimes(1);
      welcome();
      await expect(wait).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("a re-claim Steam refuses ends the welcome wait with that error", async () => {
    vi.useFakeTimers();
    try {
      const { gc } = liveGc();
      const wait = gc.waitForWelcome(25000, { afterMs: 10000, reclaim: () => Promise.reject(new Error("busy")) });
      const settled = expect(wait).rejects.toThrow("busy");
      await vi.advanceTimersByTimeAsync(10000);
      await settled;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("a welcome before the stall never re-claims", async () => {
    vi.useFakeTimers();
    try {
      const { gc, welcome } = liveGc();
      const reclaim = vi.fn().mockResolvedValue(undefined);
      const wait = gc.waitForWelcome(25000, { afterMs: 10000, reclaim });
      welcome();
      await wait;
      await vi.advanceTimersByTimeAsync(30000);
      expect(reclaim).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("reconcileAfter reports whether the intended transition already happened", async () => {
    const { gc, feed } = offlineGc();
    feed(GCMsg.SOCacheSubscribed, buildSyntheticCacheSubscribed());
    expect(await gc.reconcileAfter({ kind: "withdraw", itemId: "300", casketId: UNIT })).toBe("not-applied");
    expect(await gc.reconcileAfter({ kind: "withdraw", itemId: "999", casketId: UNIT })).toBe("not-applied"); // absent from a fresh cache = unit contents unloaded, not withdrawn
    expect(await gc.reconcileAfter({ kind: "withdraw", itemId: "100", casketId: UNIT })).toBe("applied");
    expect(await gc.reconcileAfter({ kind: "deposit", itemId: "300", casketId: UNIT })).toBe("applied");
    expect(await gc.reconcileAfter({ kind: "deposit", itemId: "100", casketId: UNIT })).toBe("not-applied");
    expect(await gc.reconcileAfter({ kind: "destroy", itemId: "100" })).toBe("not-applied");
    expect(await gc.reconcileAfter({ kind: "destroy", itemId: "999" })).toBe("applied");
    expect(await gc.reconcileAfter({ kind: "rename", itemId: "100", expectedName: "x" })).toBe("not-applied");
    const renamed = makeEconItem({ id: 100n, defIndex: 507 });
    renamed.customName = "x";
    feed(GCMsg.SOUpdate, toBinary(CMsgSOSingleObjectSchema, create(CMsgSOSingleObjectSchema, {
      typeId: 1, objectData: toBinary(CSOEconItemSchema, renamed),
    })));
    expect(await gc.reconcileAfter({ kind: "rename", itemId: "100", expectedName: "x" })).toBe("applied");
  });
});
