import { describe, it, expect } from "vitest";
import { create, toBinary } from "@bufbuild/protobuf";
import { SOCache } from "../src/gc/so-cache.js";
import { CSOEconItemSchema } from "../src/gen/csgo/base_gcmessages_pb.js";
import {
  CMsgSOSingleObjectSchema,
  CMsgSOMultipleObjectsSchema,
  CMsgSOCacheSubscribedSchema,
  CMsgClientWelcomeSchema,
} from "../src/gen/csgo/gcsdk_gcmessages_pb.js";
import { fromBinary } from "@bufbuild/protobuf";
import { CSOAccountSeasonalOperationSchema } from "../src/gen/csgo/cstrike15_gcmessages_pb.js";
import { buildSyntheticCacheSubscribed, makeEconItem } from "../src/testing/synthetic.js";

const single = (typeId: number, item = makeEconItem()) =>
  toBinary(CMsgSOSingleObjectSchema, create(CMsgSOSingleObjectSchema, { typeId, objectData: toBinary(CSOEconItemSchema, item) }));

describe("SOCache", () => {
  it("reads the Armory star balance from CSOAccountXpShop, SO type 6 (live 2026-10-27: 3 stars, one track at 1850 XP)", () => {
    const cache = new SOCache();
    expect(cache.armoryStars).toBeNull();
    const shop = Uint8Array.from("08f4bce4d606100318ba0e".match(/../g)!.map((h) => parseInt(h, 16)));
    cache.applyCreate(toBinary(CMsgSOSingleObjectSchema, create(CMsgSOSingleObjectSchema, { typeId: 6, objectData: shop })));
    expect(cache.armoryStars).toBe(3);
    expect(cache.armoryTracks).toEqual([1850]);
    expect(cache.raw).toEqual([]);
  });

  it("decodes a terminal kind's collection record in Steam's sorted order, and drops it on destroy (live 2026-10-27, after one decline)", () => {
    const cache = new SOCache();
    const hex = "08b82810a280f4a980808080f00110978080aa80808080f001189af482d706";
    const record = toBinary(CMsgSOSingleObjectSchema, create(CMsgSOSingleObjectSchema, { typeId: 20, objectData: Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16))) }));
    cache.applyCreate(record);
    expect(cache.offersShown(5176)).toEqual([0xf0000000053d0022n, 0xf000000005400017n]);
    expect(cache.offersShown(5181)).toBeNull();
    expect(cache.raw.map((r) => r.typeId)).toEqual([20]);
    cache.applyDestroy(record);
    expect(cache.offersShown(5176)).toBeNull();
  });

  it("reads a Major's token balance from CSOAccountSeasonalOperation, SO type 40, by its season (live 2026-11-18: 100 after activating, 75 after one sticker)", () => {
    const cache = new SOCache();
    const op = (balance: number) => toBinary(CMsgSOSingleObjectSchema, create(CMsgSOSingleObjectSchema, {
      typeId: 40, objectData: toBinary(CSOAccountSeasonalOperationSchema, create(CSOAccountSeasonalOperationSchema, { seasonValue: 13, redeemableBalance: balance, seasonPassTime: 1795052154 })),
    }));
    expect(cache.tokenBalance(13)).toBeNull();
    cache.applyCreate(op(100));
    cache.applyUpdate(op(75));
    expect(cache.tokenBalance(13)).toBe(75);
    expect(cache.tokenBalance(12)).toBeNull();
    cache.applyDestroy(op(75));
    expect(cache.tokenBalance(13)).toBeNull();
    expect(cache.raw).toEqual([]);
  });

  it("keeps objects of undecoded types raw, never as items", () => {
    const cache = new SOCache();
    const offer = toBinary(CMsgSOSingleObjectSchema, create(CMsgSOSingleObjectSchema, { typeId: 46, objectData: new Uint8Array([8, 0x98, 0x28]) }));
    cache.applyCreate(offer);
    cache.applyDestroy(offer);
    expect(cache.rootItems()).toEqual([]);
    expect(cache.raw.map((r) => [r.typeId, r.kind, r.hex])).toEqual([[46, "create", "089828"], [46, "destroy", "089828"]]);
  });

  it("keeps the last 5 of one message type, so a chatty one never pushes the rest out", () => {
    const cache = new SOCache();
    cache.keepRaw(46, "create", new Uint8Array([1]));
    for (let i = 0; i < 8; i++) cache.keepRaw(9228, "message", new Uint8Array([i]));
    expect(cache.raw.map((r) => r.hex)).toEqual(["01", "03", "04", "05", "06", "07"]);
  });

  it("separates root items from storage-unit contents", () => {
    const cache = new SOCache();
    cache.applyCacheSubscribed(buildSyntheticCacheSubscribed());
    expect(cache.rootItems().length).toBe(2);
    const unit = cache.rootItems().find((i) => i.containedItemCount !== null)!;
    expect(cache.casketContents(unit.gcItemId).length).toBe(1);
  });

  it("leaves unclaimed care-package rewards out of the root items", () => {
    const cache = new SOCache();
    cache.applyCacheSubscribed(buildSyntheticCacheSubscribed([
      makeEconItem({ id: 1n, unknownDefindex: 277, unknownBytes: [1, 0, 0, 0] }), // free reward status 1: still on offer
      makeEconItem({ id: 2n, unknownDefindex: 277, unknownBytes: [0, 0, 0, 0] }),
      makeEconItem({ id: 3n }),
    ]));
    expect(cache.rootItems().map((i) => i.gcItemId)).toEqual(["2", "3"]);
  });

  it("create/update/destroy mutate the store and notify", () => {
    const cache = new SOCache();
    const events: string[] = [];
    cache.onMutation((m) => events.push(`${m.kind}:${m.id}:${m.item ? "i" : "n"}`));
    cache.applyCreate(single(1, makeEconItem({ id: 5n })));
    expect(cache.get("5")?.defIndex).toBe(7);
    cache.applyUpdate(single(1, makeEconItem({ id: 5n, defIndex: 9 })));
    expect(cache.get("5")?.defIndex).toBe(9);
    cache.applyDestroy(single(1, makeEconItem({ id: 5n })));
    expect(cache.get("5")).toBeUndefined();
    expect(events).toEqual(["create:5:i", "update:5:i", "destroy:5:n"]);
  });

  it("ignores non-econ type ids and applies multi-object updates", () => {
    const cache = new SOCache();
    cache.applyCreate(single(2, makeEconItem({ id: 6n })));
    expect(cache.get("6")).toBeUndefined();
    const body = toBinary(CMsgSOMultipleObjectsSchema, create(CMsgSOMultipleObjectsSchema, {
      objectsModified: [
        { typeId: 1, objectData: toBinary(CSOEconItemSchema, makeEconItem({ id: 7n })) },
        { typeId: 3, objectData: new Uint8Array([1]) },
      ],
    }));
    cache.applyUpdateMultiple(body);
    expect(cache.get("7")).toBeDefined();
  });

  it("reads the inventory embedded in ClientWelcome", () => {
    const cache = new SOCache();
    const sub = fromBinary(CMsgSOCacheSubscribedSchema, buildSyntheticCacheSubscribed());
    cache.applyClientWelcome(toBinary(CMsgClientWelcomeSchema, create(CMsgClientWelcomeSchema, { outofdateSubscribedCaches: [sub] })));
    expect(cache.rootItems().length).toBe(2);
    expect(cache.decodeFailures).toBe(0);
  });

  it("counts an undecodable object without dropping its siblings", () => {
    const cache = new SOCache();
    const good = toBinary(CSOEconItemSchema, makeEconItem());
    const corrupt = new Uint8Array([0x08, 0xff]); // varint id cut off mid-byte: premature EOF
    const sub = create(CMsgSOCacheSubscribedSchema, { objects: [{ typeId: 1, objectData: [corrupt, good] }] });
    cache.applyCacheSubscribed(toBinary(CMsgSOCacheSubscribedSchema, sub));
    expect(cache.decodeFailures).toBe(1);
    expect(cache.rootItems().length).toBe(1);
  });

  it("hides non-economy (0x8) items from the root inventory", () => {
    const cache = new SOCache();
    const visible = toBinary(CSOEconItemSchema, makeEconItem({ id: 1n }));
    const hidden = toBinary(CSOEconItemSchema, create(CSOEconItemSchema, { ...makeEconItem({ id: 2n }), flags: 0x8 }));
    const sub = create(CMsgSOCacheSubscribedSchema, { objects: [{ typeId: 1, objectData: [visible, hidden] }] });
    cache.applyCacheSubscribed(toBinary(CMsgSOCacheSubscribedSchema, sub));
    expect(cache.rootItems().map((i) => i.gcItemId)).toEqual(["1"]);
  });

  it("lists non-economy root items apart: a store-bought untradable key (flags 24) is one", () => {
    const cache = new SOCache();
    const visible = toBinary(CSOEconItemSchema, makeEconItem({ id: 1n }));
    const key = toBinary(CSOEconItemSchema, create(CSOEconItemSchema, { ...makeEconItem({ id: 2n }), flags: 24 }));
    const sub = create(CMsgSOCacheSubscribedSchema, { objects: [{ typeId: 1, objectData: [visible, key] }] });
    cache.applyCacheSubscribed(toBinary(CMsgSOCacheSubscribedSchema, sub));
    expect(cache.rootItems().map((i) => i.gcItemId)).toEqual(["1"]);
    expect(cache.nonEconomyItems().map((i) => i.gcItemId)).toEqual(["2"]);
  });

  it("never lists a faux item id (0xF000... | def): a placeholder, not an owned item (live 2026-10-28: a CS:GO Weapon Case)", () => {
    const cache = new SOCache();
    const faux = (flags: number) => toBinary(CSOEconItemSchema, create(CSOEconItemSchema, { ...makeEconItem({ id: 0xf000000000000fa1n }), flags }));
    for (const flags of [0, 24]) {
      const sub = create(CMsgSOCacheSubscribedSchema, { objects: [{ typeId: 1, objectData: [faux(flags)] }] });
      cache.applyCacheSubscribed(toBinary(CMsgSOCacheSubscribedSchema, sub));
      expect(cache.rootItems()).toEqual([]);
      expect(cache.nonEconomyItems()).toEqual([]);
    }
  });
});
