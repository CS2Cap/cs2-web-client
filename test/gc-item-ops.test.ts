import { describe, it, expect, vi, afterEach } from "vitest";
import { create, fromBinary, isFieldSet, toBinary } from "@bufbuild/protobuf";
import { GCClient, MutationTimeout } from "../src/gc/client.js";
import { GCMsg } from "../src/emsg.js";
import { wrapClientToGC, parseClientFromGC } from "../src/gc/envelope.js";
import { CMsgCasketItemSchema } from "../src/gen/csgo/econ_gcmessages_pb.js";
import { CMsgApplyStickerSchema, CMsgCraftItemsRequestSchema, CMsgModifyItemStringAttrSchema, CMsgOpenCrateSchema, CMsgUseItemSchema, CSOEconItemSchema } from "../src/gen/csgo/base_gcmessages_pb.js";
import { CMsgGCCstrike15_v2_ClientRedeemMissionRewardSchema, CSOAccountSeasonalOperationSchema, CSOAccountXpShopSchema } from "../src/gen/csgo/cstrike15_gcmessages_pb.js";
import { CMsgSOSingleObjectSchema } from "../src/gen/csgo/gcsdk_gcmessages_pb.js";
import { CMsgGCClientSchema } from "../src/gen/steam/steammessages_clientserver_2_pb.js";
import { CMsgProtoBufHeaderSchema } from "../src/gen/steam/steammessages_base_pb.js";
import { decodeFrame } from "../src/frames.js";
import type { CMClient } from "../src/cm/client.js";
import { buildSyntheticCacheSubscribed, makeEconItem, soCharges, soItem, type EconItemOpts } from "../src/testing/synthetic.js";
import { ItemActionRefused, itemApplied, runItemOp } from "../src/gc/item-ops.js";

// The proto header's jobid_source; 0xFFFFFFFFFFFFFFFF is "no job", and non-proto frames carry none here.
function sourceJob(cmBody: Uint8Array): bigint {
  const payload = fromBinary(CMsgGCClientSchema, cmBody).payload;
  const frame = decodeFrame(payload);
  return frame.isProto ? fromBinary(CMsgProtoBufHeaderSchema, frame.header).jobidSource : 0xffffffffffffffffn;
}

function offlineGc(items: EconItemOpts[]) {
  const handlers: Array<(b: Uint8Array) => void> = [];
  const closed = { value: false };
  const sent: Array<{ type: number; body: Uint8Array; job: bigint }> = [];
  const fakeCm = { connection: {
    addHandler: (_e: number, cb: (b: Uint8Array) => void) => { handlers.push(cb); return () => {}; },
    get isClosed() { return closed.value; },
    sendMessage: (_e: number, b: Uint8Array) => { const m = parseClientFromGC(b); sent.push({ type: m.gcMsgType, body: m.body, job: sourceJob(b) }); },
  } };
  const gc = new GCClient(fakeCm as unknown as CMClient);
  const feed = (t: number, b: Uint8Array) => handlers.forEach((h) => h(wrapClientToGC(t, b)));
  feed(GCMsg.SOCacheSubscribed, buildSyntheticCacheSubscribed(items.map((o) => makeEconItem(o))));
  return { gc, feed, sent, closed };
}

const WEAPON = { id: 100n, defIndex: 27, stickers: [{ slot: 0, id: 5032, wear: 0.1 }] };
const scrape = { kind: "scrapeSticker" as const, itemId: "100", slot: 0, wearBefore: 0.1 };

afterEach(() => vi.useRealTimers());

describe("scrape sticker", () => {
  it("sends the scrape form of ApplySticker: no sticker item, the slot", async () => {
    const { gc, feed, sent } = offlineGc([WEAPON]);
    const p = runItemOp(gc, scrape, 2000);
    feed(GCMsg.SOUpdate, soItem({ ...WEAPON, stickers: [{ slot: 0, id: 5032, wear: 0.2 }] }));
    await p;
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe(1086);
    const m = fromBinary(CMsgApplyStickerSchema, sent[0].body);
    expect({ item: m.itemItemId, sticker: m.stickerItemId, slot: m.stickerSlot }).toEqual({ item: 100n, sticker: 0n, slot: 0 });
  });

  it("scrapes to a target as WearItemSticker does: no sticker item, the current wear and the target", async () => {
    const { gc, feed, sent } = offlineGc([WEAPON]);
    const p = runItemOp(gc, { ...scrape, target: 0.6 }, 2000);
    feed(GCMsg.SOUpdate, soItem({ ...WEAPON, stickers: [{ slot: 0, id: 5032, wear: 0.6 }] }));
    await p;
    const m = fromBinary(CMsgApplyStickerSchema, sent[0].body);
    expect(isFieldSet(m, CMsgApplyStickerSchema.field.stickerItemId)).toBe(false);
    expect({ item: m.itemItemId, slot: m.stickerSlot, wear: m.stickerWear, target: m.stickerWearTarget })
      .toEqual({ item: 100n, slot: 0, wear: expect.closeTo(0.1, 5), target: expect.closeTo(0.6, 5) });
  });

  it("sends -1 as the current wear for a sticker never scraped", async () => {
    const { gc, feed, sent } = offlineGc([WEAPON]);
    const p = runItemOp(gc, { ...scrape, wearBefore: null, target: 0.3 }, 2000);
    feed(GCMsg.SOUpdate, soItem({ ...WEAPON, stickers: [{ slot: 0, id: 5032, wear: 0.3 }] }));
    await p;
    expect(fromBinary(CMsgApplyStickerSchema, sent[0].body).stickerWear).toBe(-1);
  });

  it("confirms when the wear rises", async () => {
    const { gc, feed } = offlineGc([WEAPON]);
    const p = runItemOp(gc, scrape, 2000);
    feed(GCMsg.SOUpdate, soItem({ ...WEAPON, stickers: [{ slot: 0, id: 5032, wear: 0.2 }] }));
    await expect(p).resolves.toMatchObject({ created: [] });
  });

  it("confirms when the last scrape removes the sticker", async () => {
    const { gc, feed } = offlineGc([WEAPON]);
    const p = runItemOp(gc, scrape, 2000);
    feed(GCMsg.SOUpdate, soItem({ ...WEAPON, stickers: [] }));
    await expect(p).resolves.toMatchObject({ created: [] });
  });

  it("stays unconfirmed (MutationTimeout) when nothing changes", async () => {
    vi.useFakeTimers();
    const { gc } = offlineGc([WEAPON]);
    const p = runItemOp(gc, scrape, 2000);
    const check = expect(p).rejects.toBeInstanceOf(MutationTimeout);
    await vi.advanceTimersByTimeAsync(2100);
    await check;
  });

  it("is ambiguous (MutationTimeout) when the session drops", async () => {
    const { gc, closed } = offlineGc([WEAPON]);
    const p = runItemOp(gc, scrape, 2000);
    closed.value = true;
    await expect(p).rejects.toBeInstanceOf(MutationTimeout);
  });

  it("a change the cache already shows stands when the session drops in the same instant", async () => {
    const { gc, feed, closed } = offlineGc([WEAPON]);
    const p = runItemOp(gc, scrape, 2000);
    feed(GCMsg.SOUpdate, soItem({ ...WEAPON, stickers: [{ slot: 0, id: 5032, wear: 0.3 }] }));
    closed.value = true;
    await expect(p).resolves.toMatchObject({ itemId: "100" });
  });

  it("on a session already closed nothing is sent, and it says so instead of leaving the action unconfirmed", async () => {
    const { gc, sent, closed } = offlineGc([WEAPON]);
    closed.value = true;
    await expect(runItemOp(gc, scrape, 2000)).rejects.toMatchObject({ name: "NoSessionError" });
    expect(sent).toHaveLength(0);
  });
});

describe("itemApplied (scrape)", () => {
  it.each([
    ["wear rose", [{ slot: 0, id: 5032, wear: 0.3 }], true],
    ["sticker gone", [], true],
    ["unchanged", [{ slot: 0, id: 5032, wear: 0.1 }], false],
  ] as const)("%s", (_n, stickers, expected) => {
    const { gc } = offlineGc([{ ...WEAPON, stickers: [...stickers] }]);
    expect(itemApplied(gc.cache, scrape)).toBe(expected);
  });
  it("is not applied when the item is gone", () => {
    const { gc } = offlineGc([]);
    expect(itemApplied(gc.cache, scrape)).toBe(false);
  });
});

describe("GCClient.reconcileAfter for item intents", () => {
  it("is not-applied without an item reconciler, and asks the reconciler when one is set", async () => {
    const { gc } = offlineGc([{ ...WEAPON, stickers: [] }]);
    expect(await gc.reconcileAfter(scrape)).toBe("not-applied");
    gc.itemApplied = itemApplied;
    expect(await gc.reconcileAfter(scrape)).toBe("applied");
  });
});

describe("apply sticker", () => {
  const TARGET = { id: 100n, defIndex: 27 };
  const STICKER = { id: 200n, defIndex: 1209, stickers: [{ slot: 0, id: 5032 }] };
  const apply = { kind: "applySticker" as const, itemId: "100", stickerItemId: "200", slot: 1, offsetX: 0.05, offsetY: -0.02, rotation: 30 };

  it("sends ApplySticker with the sticker item, slot, rotation and offsets, and no scale", async () => {
    const { gc, feed, sent } = offlineGc([TARGET, STICKER]);
    const p = runItemOp(gc, apply, 2000);
    feed(GCMsg.SODestroy, soItem(STICKER));
    feed(GCMsg.SOUpdate, soItem({ ...TARGET, stickers: [{ slot: 1, id: 5032, wear: 0 }] }));
    await expect(p).resolves.toMatchObject({ created: [] });
    const m = fromBinary(CMsgApplyStickerSchema, sent[0].body);
    expect(sent[0].type).toBe(1086);
    expect({ sticker: m.stickerItemId, item: m.itemItemId, slot: m.stickerSlot, rot: m.stickerRotation, x: m.stickerOffsetX, y: m.stickerOffsetY, scaleSet: isFieldSet(m, CMsgApplyStickerSchema.field.stickerScale) })
      .toEqual({ sticker: 200n, item: 100n, slot: 1, rot: 30, x: expect.closeTo(0.05, 5), y: expect.closeTo(-0.02, 5), scaleSet: false });
    expect(isFieldSet(m, CMsgApplyStickerSchema.field.stickerWear)).toBe(false);
  });

  it("sends a scrape level as sticker_wear, never sticker_wear_target", async () => {
    const { gc, feed, sent } = offlineGc([TARGET, STICKER]);
    const p = runItemOp(gc, { ...apply, wear: 0.4 }, 2000);
    feed(GCMsg.SODestroy, soItem(STICKER));
    feed(GCMsg.SOUpdate, soItem({ ...TARGET, stickers: [{ slot: 1, id: 5032, wear: 0.4 }] }));
    await expect(p).resolves.toMatchObject({ created: [] });
    const m = fromBinary(CMsgApplyStickerSchema, sent[0].body);
    expect(m.stickerWear).toBeCloseTo(0.4, 5);
    expect(isFieldSet(m, CMsgApplyStickerSchema.field.stickerWearTarget)).toBe(false);
  });

  it.each([
    ["sticker used and slot filled", [{ ...TARGET, stickers: [{ slot: 1, id: 5032 }] }], true],
    ["sticker still there", [{ ...TARGET, stickers: [{ slot: 1, id: 5032 }] }, STICKER], false],
    ["slot still empty", [TARGET], false],
    ["sticker kept in another slot, anchored to the one asked for", [{ ...TARGET, stickers: [{ slot: 0, id: 5032, anchor: 1 }] }], true],
    ["sticker anchored elsewhere, its own slot asked for", [{ ...TARGET, stickers: [{ slot: 1, id: 5032, anchor: 0 }] }], false],
  ] as const)("itemApplied: %s", (_n, items, expected) => {
    const { gc } = offlineGc(items as unknown as EconItemOpts[]);
    expect(itemApplied(gc.cache, apply)).toBe(expected);
  });
  it.each([
    ["a second sticker in the shared place", [{ slot: 0, id: 9, anchor: 1 }, { slot: 1, id: 5032 }], true],
    ["only the sticker that was there", [{ slot: 0, id: 9, anchor: 1 }], false],
  ] as const)("itemApplied into a place already held: %s", (_n, stickers, expected) => {
    const { gc } = offlineGc([{ ...TARGET, stickers: [...stickers] }] as unknown as EconItemOpts[]);
    expect(itemApplied(gc.cache, { ...apply, stickersBefore: 1 })).toBe(expected);
  });
});

describe("charms", () => {
  const TARGET = { id: 100n, defIndex: 27 };
  const CHARM = { id: 300n, defIndex: 1355, charm: { id: 31, pattern: 7 } };
  const attach = { kind: "applyCharm" as const, itemId: "100", charmItemId: "300", offset: [0.5, -1, 2] as [number, number, number] };

  it("attaches through ApplySticker with the charm as the sticker item and its x/y/z offset", async () => {
    const { gc, feed, sent } = offlineGc([TARGET, CHARM]);
    const p = runItemOp(gc, attach, 2000);
    feed(GCMsg.SODestroy, soItem(CHARM));
    feed(GCMsg.SOUpdate, soItem({ ...TARGET, charm: { id: 31, pattern: 7 } }));
    await expect(p).resolves.toMatchObject({ created: [] });
    const m = fromBinary(CMsgApplyStickerSchema, sent[0].body);
    expect(sent[0].type).toBe(1086);
    expect({ sticker: m.stickerItemId, item: m.itemItemId, x: m.stickerOffsetX, y: m.stickerOffsetY, z: m.stickerOffsetZ }).toEqual({ sticker: 300n, item: 100n, x: 0.5, y: -1, z: 2 });
    expect(isFieldSet(m, CMsgApplyStickerSchema.field.stickerSlot)).toBe(false);
  });

  it("removes through ApplySticker with the Remove Keychain Tool sentinel, and reports the charm back in the inventory", async () => {
    const { gc, feed, sent } = offlineGc([{ ...TARGET, charm: { id: 31, pattern: 7 } }]);
    feed(GCMsg.SOCreate, soCharges(3));
    const p = runItemOp(gc, { kind: "removeCharm", itemId: "100" }, 2000);
    feed(GCMsg.SOUpdate, soItem(TARGET));
    feed(GCMsg.SOCreate, soItem({ id: 301n, defIndex: 1355, charm: { id: 31, pattern: 7 } }));
    await expect(p).resolves.toMatchObject({ created: ["301"] });
    const m = fromBinary(CMsgApplyStickerSchema, sent[0].body);
    expect({ sticker: m.stickerItemId, item: m.itemItemId }).toEqual({ sticker: 17293822569102704705n, item: 100n });
  });

  it("with no charges left, uses a Charm Detachment Pack first, then removes", async () => {
    const PACK = { id: 500n, defIndex: 4950 };
    const { gc, feed, sent } = offlineGc([{ ...TARGET, charm: { id: 31, pattern: 7 } }, PACK]);
    const p = runItemOp(gc, { kind: "removeCharm", itemId: "100" }, 2000);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].type).toBe(1025);
    expect(fromBinary(CMsgUseItemSchema, sent[0].body).itemId).toBe(500n);
    feed(GCMsg.SODestroy, soItem(PACK));
    feed(GCMsg.SOCreate, soCharges(3));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1].type).toBe(1086);
    feed(GCMsg.SOUpdate, soItem(TARGET));
    await expect(p).resolves.toMatchObject({ itemId: "100" });
  });

  it("reads the account's charges from SO type 15; none sent means none", () => {
    const { gc, feed } = offlineGc([TARGET]);
    expect(gc.cache.removalCharges).toBe(0);
    feed(GCMsg.SOCreate, soCharges(3));
    expect(gc.cache.removalCharges).toBe(3);
    feed(GCMsg.SOUpdate, soCharges(2));
    expect(gc.cache.removalCharges).toBe(2);
  });

  it.each([
    ["attach: charm used, anchor taken", "applyCharm", [{ ...TARGET, charm: { id: 31 } }], true],
    ["attach: charm still loose", "applyCharm", [TARGET, CHARM], false],
    ["remove: anchor empty", "removeCharm", [TARGET], true],
    ["remove: still attached", "removeCharm", [{ ...TARGET, charm: { id: 31 } }], false],
  ] as const)("itemApplied: %s", (_n, kind, items, expected) => {
    const { gc } = offlineGc(items as unknown as EconItemOpts[]);
    const intent = kind === "applyCharm" ? attach : { kind: "removeCharm" as const, itemId: "100" };
    expect(itemApplied(gc.cache, intent)).toBe(expected);
  });
});

describe("name tags", () => {
  const TARGET = { id: 100n, defIndex: 27 };
  const TAG = { id: 400n, defIndex: 1200 };
  const apply = { kind: "nameTag" as const, itemId: "100", nameTagItemId: "400", name: "Old Faithful" };

  it.each(["Old Faithful", "👩‍💻", "  ✨名字  ", "a\u200Bb", "\uFEFFab"])("sends name-tag text %j unchanged in NameItem", async (name) => {
    const { gc, feed, sent } = offlineGc([TARGET, TAG]);
    const p = runItemOp(gc, { ...apply, name }, 2000);
    feed(GCMsg.SODestroy, soItem(TAG));
    feed(GCMsg.SOUpdate, soItem({ ...TARGET, customName: name }));
    await expect(p).resolves.toMatchObject({ created: [] });
    expect(sent[0].type).toBe(1006);
    const m = fromBinary(CMsgModifyItemStringAttrSchema, sent[0].body);
    expect({ tool: m.toolItemId, subject: m.subjectItemId, value: m.attrValue }).toEqual({ tool: 400n, subject: 100n, value: name });
  });

  it("removes through RemoveItemName (1030, proto) naming the item", async () => {
    const { gc, feed, sent } = offlineGc([{ ...TARGET, customName: "Old Faithful" }]);
    const p = runItemOp(gc, { kind: "removeNameTag", itemId: "100" }, 2000);
    feed(GCMsg.SOUpdate, soItem(TARGET));
    await expect(p).resolves.toMatchObject({ created: [] });
    expect(sent[0].type).toBe(1030);
    expect(fromBinary(CMsgModifyItemStringAttrSchema, sent[0].body).subjectItemId).toBe(100n);
  });

  it.each([
    ["named, tag used", "nameTag", [{ ...TARGET, customName: "Old Faithful" }], true],
    ["named, tag still there", "nameTag", [{ ...TARGET, customName: "Old Faithful" }, TAG], false],
    ["other name", "nameTag", [{ ...TARGET, customName: "Other" }], false],
    ["name gone", "removeNameTag", [TARGET], true],
    ["still named", "removeNameTag", [{ ...TARGET, customName: "Old Faithful" }], false],
  ] as const)("itemApplied: %s", (_n, kind, items, expected) => {
    const { gc } = offlineGc(items as unknown as EconItemOpts[]);
    expect(itemApplied(gc.cache, kind === "nameTag" ? apply : { kind: "removeNameTag" as const, itemId: "100" })).toBe(expected);
  });
});

describe("open a container", () => {
  const CASE = { id: 500n, defIndex: 4747 };
  const KEY = { id: 501n, defIndex: 1203 };
  const open = { kind: "open" as const, itemId: "500", keyItemId: "501" };
  const unlockReply = (code: number) => { const b = new Uint8Array(6); new DataView(b.buffer).setUint32(2, code, true); return b; };

  it("sends OpenCrate with the key as the tool and reports the unboxed item", async () => {
    const { gc, feed, sent } = offlineGc([CASE, KEY]);
    const p = runItemOp(gc, open, 2000);
    feed(GCMsg.SODestroy, soItem(CASE));
    feed(GCMsg.SODestroy, soItem(KEY));
    feed(GCMsg.SOCreate, soItem({ id: 502n, defIndex: 7 }));
    await expect(p).resolves.toMatchObject({ created: ["502"] });
    expect(sent[0].type).toBe(2534);
    const m = fromBinary(CMsgOpenCrateSchema, sent[0].body);
    expect({ tool: m.toolItemId, subject: m.subjectItemId }).toEqual({ tool: 501n, subject: 500n });
  });

  it("waits for the unboxed item when it arrives after the container is gone", async () => {
    const { gc, feed } = offlineGc([CASE]);
    const p = runItemOp(gc, { ...open, keyItemId: null }, 2000);
    feed(GCMsg.SODestroy, soItem(CASE));
    await new Promise((r) => setTimeout(r, 60));
    feed(GCMsg.SOCreate, soItem({ id: 503n, defIndex: 7 }));
    await expect(p).resolves.toMatchObject({ created: ["503"] });
  });

  it("sends tool 0 for a container that needs no key", async () => {
    const { gc, feed, sent } = offlineGc([CASE]);
    const p = runItemOp(gc, { ...open, keyItemId: null }, 2000);
    feed(GCMsg.SODestroy, soItem(CASE));
    await p;
    expect(fromBinary(CMsgOpenCrateSchema, sent[0].body).toolItemId).toBe(0n);
  });

  it("is refused when Steam answers UnlockCrateResponse with a non-zero code (live: 5 on a weapon)", async () => {
    const { gc, feed } = offlineGc([CASE, KEY]);
    const p = runItemOp(gc, open, 2000);
    feed(1008, unlockReply(5));
    await expect(p).rejects.toBeInstanceOf(ItemActionRefused);
  });

  it.each([
    ["container and key gone", [], true],
    ["key still there", [KEY], false],
    ["container still there", [CASE], false],
  ] as const)("itemApplied: %s", (_n, items, expected) => {
    const { gc } = offlineGc(items as unknown as EconItemOpts[]);
    expect(itemApplied(gc.cache, open)).toBe(expected);
  });
});

describe("a fresh terminal's first offer", () => {
  const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
  const fresh = { id: 10000000002n, defIndex: 5176, quality: 14 };
  const first = { kind: "firstOffer" as const, itemId: "10000000002" };

  it("sends OpenCrate with the terminal as tool and subject and points_remaining 0 right after unsealing (captured live 2026-10-28), applied once the counter appears", async () => {
    const { gc, feed, sent } = offlineGc([fresh]);
    const p = runItemOp(gc, first, 2000);
    expect(sent[0].type).toBe(2534);
    expect(Buffer.from(sent[0].body).toString("hex")).toBe("0882c8afa0251082c8afa0252000");
    feed(GCMsg.SOUpdate, soItem({ ...fresh, unknownDefindex: 169, unknownBytes: u32(1) }));
    await expect(p).resolves.toMatchObject({ itemId: "10000000002" });
  });

  it("is not applied before the counter appears", () => {
    const { gc } = offlineGc([fresh]);
    expect(itemApplied(gc.cache, first)).toBe(false);
  });
});

describe("end a terminal at its final offer", () => {
  const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
  const terminal = { id: 10000000001n, defIndex: 5176, quality: 14, unknownDefindex: 169, unknownBytes: u32(-5) };
  const end = { kind: "endTerminal" as const, itemId: "10000000001", offerCounter: 4294967291 };

  it("sends CS2's End: OpenCrate with the terminal as tool and subject and the final counter as its uint32", async () => {
    const { gc, feed, sent } = offlineGc([terminal]);
    const p = runItemOp(gc, end, 2000);
    feed(GCMsg.SODestroy, soItem(terminal));
    await expect(p).resolves.toMatchObject({ itemId: "10000000001" });
    const m = fromBinary(CMsgOpenCrateSchema, sent[0].body);
    expect({ type: sent[0].type, tool: m.toolItemId, subject: m.subjectItemId, points: m.pointsRemaining }).toEqual({ type: 2534, tool: 10000000001n, subject: 10000000001n, points: 4294967291 });
  });

  it.each([["terminal gone", [], true], ["terminal still there", [terminal], false]] as const)("itemApplied: %s", (_n, items, expected) => {
    const { gc } = offlineGc(items as unknown as EconItemOpts[]);
    expect(itemApplied(gc.cache, end)).toBe(expected);
  });
});

describe("decline a terminal offer", () => {
  const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
  const terminal = (counter: number) => ({ id: 10000000003n, defIndex: 5176, quality: 14, unknownDefindex: 169, unknownBytes: u32(counter) });
  const OFFER = { id: 10000000004n, defIndex: 23, casketId: 10000000003n };
  const decline = { kind: "declineOffer" as const, itemId: "10000000003", offerCounter: 1, offerItemId: "10000000004" };

  it("sends OpenCrate with the terminal as tool and subject and the counter on show, as CS2's UseToolWithIntArg", async () => {
    const { gc, feed, sent } = offlineGc([terminal(1), OFFER]);
    const p = runItemOp(gc, decline, 2000);
    feed(GCMsg.SODestroy, soItem(OFFER));
    feed(GCMsg.SOUpdate, soItem(terminal(2)));
    await expect(p).resolves.toMatchObject({ itemId: "10000000003" });
    expect(sent[0].type).toBe(2534);
    const m = fromBinary(CMsgOpenCrateSchema, sent[0].body);
    expect({ tool: m.toolItemId, subject: m.subjectItemId, points: m.pointsRemaining, limit: isFieldSet(m, CMsgOpenCrateSchema.field.volatileLimit) })
      .toEqual({ tool: 10000000003n, subject: 10000000003n, points: 1, limit: false });
  });

  it.each([
    ["counter moved on, old offer gone", [terminal(2)], true],
    ["counter moved on, old offer still inside", [terminal(2), OFFER], false],
    ["counter unchanged", [terminal(1)], false],
    ["terminal gone", [], false],
  ] as const)("itemApplied: %s", (_n, items, expected) => {
    const { gc } = offlineGc(items as unknown as EconItemOpts[]);
    expect(itemApplied(gc.cache, decline)).toBe(expected);
  });

  it("is refused when Steam answers UnlockCrateResponse with a non-zero code", async () => {
    const { gc, feed } = offlineGc([terminal(1)]);
    const p = runItemOp(gc, decline, 2000);
    const b = new Uint8Array(6); new DataView(b.buffer).setUint32(2, 5, true);
    feed(1008, b);
    await expect(p).rejects.toBeInstanceOf(ItemActionRefused);
  });
});

describe("redeem Armory stars", () => {
  const shop = (stars: number) => toBinary(CMsgSOSingleObjectSchema, create(CMsgSOSingleObjectSchema, {
    typeId: 6, objectData: toBinary(CSOAccountXpShopSchema, create(CSOAccountXpShopSchema, { generationTime: 1793000000, redeemableBalance: stars, xpTracks: [1850] })),
  }));
  const redeem = { kind: "redeemArmory" as const, itemId: "armory", campaignId: 11, redeemId: 8, stars: 1, starsBefore: 3 };

  it("sends ClientRedeemMissionReward as CS2's ActionRedeemOperationGoods, and confirms on the balance drop with the new item", async () => {
    const { gc, feed, sent } = offlineGc([]);
    feed(GCMsg.SOCreate, shop(3));
    const p = runItemOp(gc, redeem, 5000);
    expect(sent[0].type).toBe(9209);
    // A 2025 Community Stickers redeem captured live 2026-10-28 was 080b10cffdb1d808180320013200: the same fields, plus an empty volatile_shop.
    const live = { ...redeem, redeemId: 2332851919 };
    const { gc: gc2, feed: feed2, sent: sent2 } = offlineGc([]);
    feed2(GCMsg.SOCreate, shop(3));
    void runItemOp(gc2, live, 50).catch(() => {});
    expect(Buffer.from(sent2[0].body).toString("hex")).toBe("080b10cffdb1d80818032001");
    // Without a source job the GC never answers (live 2026-10-28: TIMEOUT, balance unchanged), as with store purchases.
    expect(sent[0].job).not.toBe(0xffffffffffffffffn);
    const m = fromBinary(CMsgGCCstrike15_v2_ClientRedeemMissionRewardSchema, sent[0].body);
    expect({ campaign: m.campaignId, redeem: m.redeemId, balance: m.redeemableBalance, cost: m.expectedCost }).toEqual({ campaign: 11, redeem: 8, balance: 3, cost: 1 });
    feed(GCMsg.SOUpdate, shop(2));
    feed(GCMsg.SOCreate, soItem({ id: 800n, defIndex: 4001 }));
    await expect(p).resolves.toMatchObject({ created: ["800"] });
  });

  it.each([
    ["balance dropped by the cost", 2, true],
    ["balance unchanged", 3, false],
  ] as const)("itemApplied: %s", (_n, after, expected) => {
    const { gc, feed } = offlineGc([]);
    feed(GCMsg.SOCreate, shop(after));
    expect(itemApplied(gc.cache, redeem)).toBe(expected);
  });
});

describe("buy with Major tokens", () => {
  const balance = (tokens: number) => toBinary(CMsgSOSingleObjectSchema, create(CMsgSOSingleObjectSchema, {
    typeId: 40, objectData: toBinary(CSOAccountSeasonalOperationSchema, create(CSOAccountSeasonalOperationSchema, { seasonValue: 13, redeemableBalance: tokens })),
  }));
  // Three paper stickers checked out live 2026-11-18 (Singapore 2026: 25 tokens each, one twice).
  const buy = { kind: "buyWithTokens" as const, itemId: "major", campaignId: 13, offerIds: ["17293822569900082361", "17293822569876948153", "17293822569876948153"], tokens: 75, tokensBefore: 75 };

  it("sends ClientRedeemMissionReward with the cart in volatile_shop, as CS2's ActionOperationFauxPurchase, and reports every new item", async () => {
    const { gc, feed, sent } = offlineGc([]);
    feed(GCMsg.SOCreate, balance(75));
    const p = runItemOp(gc, buy, 5000);
    expect(sent[0].type).toBe(9209);
    expect(sent[0].job).not.toBe(0xffffffffffffffffn);
    const m = fromBinary(CMsgGCCstrike15_v2_ClientRedeemMissionRewardSchema, sent[0].body);
    expect({ campaign: m.campaignId, balance: m.redeemableBalance, cost: m.expectedCost, cart: m.volatileShop.map(String) }).toEqual({ campaign: 13, balance: 75, cost: 75, cart: buy.offerIds });
    expect(isFieldSet(m, CMsgGCCstrike15_v2_ClientRedeemMissionRewardSchema.field.redeemId)).toBe(false);
    for (const id of [900n, 901n, 902n]) feed(GCMsg.SOCreate, soItem({ id, defIndex: 1209 }));
    feed(GCMsg.SOUpdate, balance(0));
    await expect(p).resolves.toMatchObject({ created: ["900", "901", "902"] });
  });

  it.each([
    ["balance dropped by the cost", 0, true],
    ["balance unchanged", 75, false],
  ] as const)("itemApplied: %s", (_n, after, expected) => {
    const { gc, feed } = offlineGc([]);
    feed(GCMsg.SOCreate, balance(after));
    expect(itemApplied(gc.cache, buy)).toBe(expected);
  });

  it("activates a token item like an Armory Pass: UseItem, done when the item is gone (live 2026-11-18)", async () => {
    const tokens = { id: 54605643692n, defIndex: 5409 };
    const { gc, feed, sent } = offlineGc([tokens]);
    const p = runItemOp(gc, { kind: "activatePass", itemId: "54605643692" }, 2000);
    expect(sent[0].type).toBe(1025);
    expect(fromBinary(CMsgUseItemSchema, sent[0].body).itemId).toBe(54605643692n);
    feed(GCMsg.SODestroy, soItem(tokens));
    feed(GCMsg.SOCreate, balance(100));
    await p;
    expect(gc.cache.tokenBalance(13)).toBe(100);
  });

  it("activates a Viewer Pass: UseItem, the pass goes and its non-economy coin is the created item (live 2026-11-18)", async () => {
    const pass = { id: 54606581410n, defIndex: 5410 };
    const coin = toBinary(CMsgSOSingleObjectSchema, create(CMsgSOSingleObjectSchema, { typeId: 1, objectData: toBinary(CSOEconItemSchema, { ...makeEconItem({ id: 54606583993n, defIndex: 5412 }), flags: 8 }) }));
    const { gc, feed, sent } = offlineGc([pass]);
    const p = runItemOp(gc, { kind: "activatePass", itemId: "54606581410" }, 2000);
    expect(sent[0].type).toBe(1025);
    expect(fromBinary(CMsgUseItemSchema, sent[0].body).itemId).toBe(54606581410n);
    feed(GCMsg.SODestroy, soItem(pass));
    feed(GCMsg.SOCreate, coin);
    await expect(p).resolves.toEqual({ created: ["54606583993"], itemId: "54606581410" });
    expect(gc.cache.nonEconomyItems().map((i) => i.defIndex)).toEqual([5412]);
  });
});

describe("trade-up", () => {
  const inputs = Array.from({ length: 10 }, (_, i) => ({ id: BigInt(600 + i), defIndex: 27 }));
  const craft = { kind: "craft" as const, itemId: "600", itemIds: inputs.map((i) => i.id.toString()), recipe: 0 };
  const craftReply = (recipe: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setUint16(0, recipe, true); return b; };

  it("sends CMsgCraftItemsRequest (proto 1002) and reports the outcome item", async () => {
    const { gc, feed, sent } = offlineGc(inputs);
    const p = runItemOp(gc, craft, 2000);
    for (const i of inputs) feed(GCMsg.SODestroy, soItem(i));
    feed(GCMsg.SOCreate, soItem({ id: 700n, defIndex: 7 }));
    await expect(p).resolves.toMatchObject({ created: ["700"] });
    expect(sent[0].type).toBe(1002);
    const m = fromBinary(CMsgCraftItemsRequestSchema, sent[0].body);
    expect({ recipe: m.recipeDef, items: m.craftItems.map(String) }).toEqual({ recipe: 0, items: craft.itemIds });
  });

  it("is refused when CraftResponse names recipe 0xFFFF (live: 3 inputs)", async () => {
    const { gc, feed } = offlineGc(inputs);
    const p = runItemOp(gc, craft, 2000);
    feed(1003, craftReply(0xffff));
    await expect(p).rejects.toBeInstanceOf(ItemActionRefused);
  });

  it("itemApplied only once every input is gone", () => {
    expect(itemApplied(offlineGc([]).gc.cache, craft)).toBe(true);
    expect(itemApplied(offlineGc(inputs.slice(9)).gc.cache, craft)).toBe(false);
  });
});

describe("terminal offers", () => {
  const TERMINAL = { id: 500n, defIndex: 5176, quality: 14 };
  it("loads the offer with the casket-free form first: the terminal as item, the offer counter as field 4, no casket (live 2026-10-27)", async () => {
    const { gc, feed, sent } = offlineGc([TERMINAL]);
    const p = gc.loadTerminalOffer("500", 2000, 4);
    expect([sent[0].type, Buffer.from(sent[0].body).toString("hex")]).toEqual([2536, "10f4032004"]);
    feed(GCMsg.SOCreate, soItem({ id: 600n, defIndex: 23, casketId: 500n }));
    const r = await p;
    expect(r.items.map((i) => [i.gcItemId, i.defIndex, i.casketId])).toEqual([["600", 23, "500"]]);
    expect(r.loadedBy).toBe("counter");
  });
  it("falls back to CS2's casket form after 3 s, and goes straight to it with no counter", async () => {
    vi.useFakeTimers();
    const { gc, feed, sent } = offlineGc([TERMINAL]);
    const p = gc.loadTerminalOffer("500", 10_000, 4);
    await vi.advanceTimersByTimeAsync(3100);
    const m = fromBinary(CMsgCasketItemSchema, sent[1].body);
    expect([sent[1].type, m.casketItemId, m.itemItemId]).toEqual([2536, 500n, 500n]);
    feed(GCMsg.SOCreate, soItem({ id: 600n, defIndex: 23, casketId: 500n }));
    await vi.advanceTimersByTimeAsync(50);
    expect(await p).toMatchObject({ loadedBy: "casket", items: [{ gcItemId: "600" }] });
    const fresh = offlineGc([TERMINAL]);
    void fresh.gc.loadTerminalOffer("500", 1000, null);
    expect(fromBinary(CMsgCasketItemSchema, fresh.sent[0].body).casketItemId).toBe(500n);
  });
  it("comes back empty when nothing arrives in time", async () => {
    vi.useFakeTimers();
    const { gc } = offlineGc([TERMINAL]);
    const p = gc.loadTerminalOffer("500", 5000, 4);
    await vi.advanceTimersByTimeAsync(5500);
    expect(await p).toEqual({ items: [], loadedBy: null });
  });
});
