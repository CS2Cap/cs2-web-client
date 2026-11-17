import { describe, it, expect, vi } from "vitest";
import { create, toBinary, fromBinary, isFieldSet } from "@bufbuild/protobuf";
import { GCClient, MutationTimeout, CasketFullError, NoSessionError } from "../src/gc/client.js";
import { GCMsg } from "../src/emsg.js";
import { wrapClientToGC, parseClientFromGC } from "../src/gc/envelope.js";
import { CMsgGCClientSchema } from "../src/gen/steam/steammessages_clientserver_2_pb.js";
import { CMsgGCItemCustomizationNotificationSchema } from "../src/gen/csgo/econ_gcmessages_pb.js";
import type { CMClient } from "../src/cm/client.js";
import { buildSyntheticCacheSubscribed, makeEconItem, seedItemInCache, soUpdateItemCasket, soUpdateItemName } from "../src/testing/synthetic.js";
import { CSOEconItemSchema, CMsgModifyItemStringAttrSchema, type CSOEconItem } from "../src/gen/csgo/base_gcmessages_pb.js";
import { CMsgSOSingleObjectSchema } from "../src/gen/csgo/gcsdk_gcmessages_pb.js";

function offlineGc(): { gc: GCClient; feed: (t: number, b: Uint8Array) => void; closed: { value: boolean } } {
  const handlers: Array<(b: Uint8Array) => void> = [];
  const closed = { value: false };
  const fakeCm = { connection: {
    addHandler: (_e: number, cb: (b: Uint8Array) => void) => { handlers.push(cb); return () => {}; },
    get isClosed() { return closed.value; },
    sendMessage: () => {},
  } };
  const gc = new GCClient(fakeCm as unknown as CMClient);
  return { gc, feed: (t, b) => handlers.forEach((h) => h(wrapClientToGC(t, b))), closed };
}

describe("GCClient storage mutations", () => {
  it("does not reconcile a withdrawal as applied while the item is in another unit", async () => {
    const { gc, feed } = offlineGc();
    seedItemInCache(gc, feed, { itemId: "100", casketId: "5000000000002" });
    expect(await gc.reconcileAfter({ kind: "withdraw", itemId: "100", casketId: "5000000000001" })).toBe("not-applied");
  });
  it("withdraw reconcile on a fresh cache: absent item is not-applied, root item is applied", async () => {
    const { gc, feed } = offlineGc();
    seedItemInCache(gc, feed, { itemId: "100", casketId: null });
    expect(await gc.reconcileAfter({ kind: "withdraw", itemId: "555", casketId: "5000000000001" })).toBe("not-applied");
    expect(await gc.reconcileAfter({ kind: "withdraw", itemId: "100", casketId: "5000000000001" })).toBe("applied");
  });

  it("deposit resolves once the item moves into the casket", async () => {
    const { gc, feed } = offlineGc();
    seedItemInCache(gc, feed, { itemId: "100", casketId: null });
    const p = gc.depositItem("100", "5000000000001", 2000);
    feed(GCMsg.SOUpdate, soUpdateItemCasket("100", "5000000000001"));
    await expect(p).resolves.toBeUndefined();
  });

  // What Steam sends for a unit whose contents are not loaded (captured live 2026-10-07): the item is destroyed, then CasketAdded names the unit.
  const casketAdded = (unitId: bigint) => toBinary(CMsgGCItemCustomizationNotificationSchema,
    create(CMsgGCItemCustomizationNotificationSchema, { itemId: [unitId], request: 1013 /* CasketAdded */ }));

  it("deposit into a unit that is not loaded resolves on the destroy and the CasketAdded notification", async () => {
    const { gc, feed } = offlineGc();
    seedItemInCache(gc, feed, { itemId: "110", casketId: null });
    const p = gc.depositItem("110", "5000000000001", 2000);
    feed(GCMsg.SODestroy, soUpdateItemCasket("110", null));
    feed(GCMsg.ItemCustomizationNotification, casketAdded(5000000000001n));
    await expect(p).resolves.toBeUndefined();
  });

  it.each([
    ["the item only disappears", (feed: (t: number, b: Uint8Array) => void) => feed(GCMsg.SODestroy, soUpdateItemCasket("111", null))],
    ["CasketAdded names another unit", (feed: (t: number, b: Uint8Array) => void) => { feed(GCMsg.SODestroy, soUpdateItemCasket("111", null)); feed(GCMsg.ItemCustomizationNotification, casketAdded(5000000000002n)); }],
    ["CasketAdded arrives but the item is still in the inventory", (feed: (t: number, b: Uint8Array) => void) => feed(GCMsg.ItemCustomizationNotification, casketAdded(5000000000001n))],
  ])("deposit stays unconfirmed when %s", async (_name, send) => {
    vi.useFakeTimers();
    const { gc, feed } = offlineGc();
    seedItemInCache(gc, feed, { itemId: "111", casketId: null });
    const p = gc.depositItem("111", "5000000000001", 500);
    const assertion = expect(p).rejects.toBeInstanceOf(MutationTimeout);
    send(feed);
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
    vi.useRealTimers();
  });

  // Silence is not a refusal: Steam also ignores some deposits it does take; unstorable items
  // are refused before the send (mutation-guard storable).
  it("deposit that gets no answer while the item sits in the inventory stays pending", async () => {
    vi.useFakeTimers();
    const { gc, feed } = offlineGc();
    seedItemInCache(gc, feed, { itemId: "120", casketId: null });
    const p = gc.depositItem("120", "5000000000001", 20000);
    const assertion = expect(p).rejects.toBeInstanceOf(MutationTimeout);
    await vi.advanceTimersByTimeAsync(20100);
    await assertion;
    vi.useRealTimers();
  });

  it("deposit whose item left the inventory without a CasketAdded stays pending", async () => {
    vi.useFakeTimers();
    const { gc, feed } = offlineGc();
    seedItemInCache(gc, feed, { itemId: "121", casketId: null });
    const p = gc.depositItem("121", "5000000000001", 20000);
    const assertion = expect(p).rejects.toBeInstanceOf(MutationTimeout);
    feed(GCMsg.SODestroy, soUpdateItemCasket("121", null));
    await vi.advanceTimersByTimeAsync(20100);
    await assertion;
    vi.useRealTimers();
  });

  it("deposit into a full unit rejects immediately with CasketFullError", async () => {
    const { gc, feed } = offlineGc();
    seedItemInCache(gc, feed, { itemId: "101", casketId: null });
    const p = gc.depositItem("101", "5000000000001", 2000);
    const note = toBinary(CMsgGCItemCustomizationNotificationSchema,
      create(CMsgGCItemCustomizationNotificationSchema, { itemId: [5000000000001n], request: 1011 /* CasketTooFull */ }));
    feed(GCMsg.ItemCustomizationNotification, note);
    await expect(p).rejects.toBeInstanceOf(CasketFullError);
  });

  it("deposit that never confirms throws MutationTimeout carrying the intent", async () => {
    vi.useFakeTimers();
    const { gc } = offlineGc();
    seedItemInCache(gc, () => {}, { itemId: "102", casketId: null });
    const p = gc.depositItem("102", "5000000000001", 500);
    const assertion = expect(p).rejects.toMatchObject({ name: "MutationTimeout", intent: { kind: "deposit", itemId: "102", casketId: "5000000000001" } });
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
    vi.useRealTimers();
  });

  it("withdraw resolves once the item leaves the casket", async () => {
    const { gc, feed } = offlineGc();
    seedItemInCache(gc, feed, { itemId: "103", casketId: "5000000000001" });
    const p = gc.withdrawItem("103", "5000000000001", 2000);
    feed(GCMsg.SOUpdate, soUpdateItemCasket("103", null));
    await expect(p).resolves.toBeUndefined();
  });

  it("a deposit on an already closed socket is refused before it is sent, not left unconfirmed", async () => {
    const { gc, closed } = offlineGc();
    seedItemInCache(gc, () => {}, { itemId: "104", casketId: null });
    closed.value = true;
    await expect(gc.depositItem("104", "5000000000001", 2000)).rejects.toBeInstanceOf(NoSessionError);
  });

  it("a deposit the cache already shows stands when the socket closes in the same instant", async () => {
    const { gc, feed, closed } = offlineGc();
    seedItemInCache(gc, feed, { itemId: "104", casketId: null });
    const p = gc.depositItem("104", "5000000000001", 2000);
    feed(GCMsg.SOUpdate, soUpdateItemCasket("104", "5000000000001"));
    closed.value = true;
    await expect(p).resolves.toBeUndefined();
  });

  it("rename resolves once the unit's custom name changes", async () => {
    const { gc, feed } = offlineGc();
    seedItemInCache(gc, feed, { itemId: "5000000000001", casketId: null });
    const p = gc.renameItem("5000000000001", "Knives", 2000);
    feed(GCMsg.SOUpdate, soUpdateItemName("5000000000001", "Knives"));
    await expect(p).resolves.toBeUndefined();
  });

  it("rename that never confirms throws MutationTimeout with the rename intent", async () => {
    vi.useFakeTimers();
    const { gc } = offlineGc();
    seedItemInCache(gc, () => {}, { itemId: "5000000000002", casketId: null });
    const p = gc.renameItem("5000000000002", "Rifles", 500);
    const assertion = expect(p).rejects.toMatchObject({ name: "MutationTimeout", intent: { kind: "rename", itemId: "5000000000002", expectedName: "Rifles" } });
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
    vi.useRealTimers();
  });

  // Live 2026-10-13: naming a never-named unit destroys it and re-creates it under a new id carrying count, date and name; NameItem names the new id.
  const nameBytes = (name: string) => { const b = new TextEncoder().encode(name); return [0x0a, b.length, ...b]; };
  const freshUnit = (id: bigint) => makeEconItem({ id, defIndex: 1201 });
  const startedUnit = (id: bigint, name: string) => makeEconItem({ id, defIndex: 1201, containedItemCount: 0, unknownDefindex: 111, unknownBytes: nameBytes(name) });
  const so = (i: CSOEconItem) => toBinary(CMsgSOSingleObjectSchema, create(CMsgSOSingleObjectSchema, { typeId: 1, objectData: toBinary(CSOEconItemSchema, i) }));
  const nameItemNote = (id: bigint) => toBinary(CMsgGCItemCustomizationNotificationSchema,
    create(CMsgGCItemCustomizationNotificationSchema, { itemId: [id], request: 1006 /* NameItem */ }));

  it("first naming resolves when Steam re-creates the unit under a new id", async () => {
    const { gc, feed } = offlineGc();
    feed(GCMsg.SOCacheSubscribed, buildSyntheticCacheSubscribed([freshUnit(2000000001n)]));
    const p = gc.renameItem("2000000001", "Knives", 2000);
    feed(GCMsg.SODestroy, so(freshUnit(2000000001n)));
    feed(GCMsg.SOCreate, so(startedUnit(2000000002n, "Knives")));
    feed(GCMsg.ItemCustomizationNotification, nameItemNote(2000000002n));
    await expect(p).resolves.toBeUndefined();
  });

  it("first naming stays unconfirmed when the re-created unit carries another name", async () => {
    vi.useFakeTimers();
    const { gc, feed } = offlineGc();
    feed(GCMsg.SOCacheSubscribed, buildSyntheticCacheSubscribed([freshUnit(2000000001n)]));
    const p = gc.renameItem("2000000001", "Knives", 500);
    const assertion = expect(p).rejects.toBeInstanceOf(MutationTimeout);
    feed(GCMsg.SODestroy, so(freshUnit(2000000001n)));
    feed(GCMsg.SOCreate, so(startedUnit(2000000002n, "Rifles")));
    feed(GCMsg.ItemCustomizationNotification, nameItemNote(2000000002n));
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
    vi.useRealTimers();
  });

  it("rename reconcile on a live cache counts a re-created unit with the expected name as applied", async () => {
    const { gc, feed } = offlineGc();
    feed(GCMsg.SOCacheSubscribed, buildSyntheticCacheSubscribed([startedUnit(2000000002n, "Knives"), makeEconItem({ id: 100n, defIndex: 7 })]));
    expect(await gc.reconcileAfter({ kind: "rename", itemId: "2000000001", expectedName: "Knives" })).toBe("applied");
    expect(await gc.reconcileAfter({ kind: "rename", itemId: "2000000001", expectedName: "Rifles" })).toBe("not-applied");
  });

  it.each(["Hi", "👩‍💻", "  ✨名字  ", "a\u200Bb"])("renameItem sends %j unchanged with attr_def unset", async (name) => {
    // Since the CS2 update of 2026-10-08 the GC ignores the legacy raw NameItem body; it takes this proto under the same id.
    let sent: Uint8Array | undefined;
    const fakeCm = { connection: {
      addHandler: () => () => {}, get isClosed() { return false; },
      sendMessage: (_e: number, body: Uint8Array) => { sent = body; },
    } };
    const gc = new GCClient(fakeCm as unknown as CMClient);
    await expect(gc.renameItem("1000000001", name, 10)).rejects.toBeDefined(); // times out; we inspect the send
    expect(sent).toBeDefined();
    expect(fromBinary(CMsgGCClientSchema, sent!).appid).toBe(730);
    const { gcMsgType, body } = parseClientFromGC(sent!);
    expect(gcMsgType).toBe(GCMsg.NameItem);
    const m = fromBinary(CMsgModifyItemStringAttrSchema, body);
    expect(m.toolItemId).toBe(0n);                       // no name tag: free rename of a storage unit
    expect(m.subjectItemId).toBe(1000000001n);
    expect(m.attrValue).toBe(name);
    expect(isFieldSet(m, CMsgModifyItemStringAttrSchema.field.attrDef)).toBe(false); // with 111 the GC does not answer
  });
});
