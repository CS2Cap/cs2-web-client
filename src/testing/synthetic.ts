import { create, toBinary } from "@bufbuild/protobuf";
import { CSOAccountKeychainRemoveToolChargesSchema } from "../gen/csgo/cstrike15_gcmessages_pb.js";
import { CSOEconItemSchema, CSOEconItemAttributeSchema } from "../gen/csgo/base_gcmessages_pb.js";
import type { CSOEconItem } from "../gen/csgo/base_gcmessages_pb.js";
import { CMsgSOCacheSubscribedSchema, CMsgSOSingleObjectSchema } from "../gen/csgo/gcsdk_gcmessages_pb.js";
import { GCMsg } from "../emsg.js";
import type { GCClient } from "../gc/client.js";
import { loadAttributeIds } from "../items/attributes.js";

export interface EconItemOpts {
  id?: bigint; defIndex?: number;
  paintWear?: number; paintSeed?: number; statTrak?: boolean; killEaterValue?: number;
  shortWearBytes?: number[];
  casketId?: bigint; containedItemCount?: number;
  unknownDefindex?: number; unknownBytes?: number[];
  stickers?: Array<{ slot: number; id: number; wear?: number; anchor?: number }>;
  charm?: { id: number; pattern?: number };
  customName?: string;
  rarity?: number;
  quality?: number;
}

const u32Bytes = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; };
const f32Bytes = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return b; };

/** Builds a CSOEconItem using the same defindexes as attributes.default.json. */
export function makeEconItem(o: EconItemOpts = {}): CSOEconItem {
  const ids = loadAttributeIds(null);
  const attribute = [] as CSOEconItem["attribute"];
  const add = (defIndex: number, valueBytes: Uint8Array) =>
    attribute.push(create(CSOEconItemAttributeSchema, { defIndex, valueBytes }));
  if (o.paintWear !== undefined) add(ids.paintWear, f32Bytes(o.paintWear));
  if (o.shortWearBytes) add(ids.paintWear, new Uint8Array(o.shortWearBytes));
  if (o.paintSeed !== undefined) add(ids.paintSeed, f32Bytes(o.paintSeed)); // GC float-encodes seeds
  if (o.statTrak) add(ids.killEater, u32Bytes(o.killEaterValue ?? 0));
  if (o.casketId !== undefined) {
    add(ids.casketIdLow, u32Bytes(Number(o.casketId & 0xffffffffn)));
    add(ids.casketIdHigh, u32Bytes(Number(o.casketId >> 32n)));
  }
  if (o.containedItemCount !== undefined) add(ids.containedItemCount, u32Bytes(o.containedItemCount));
  if (o.unknownDefindex !== undefined) add(o.unknownDefindex, new Uint8Array(o.unknownBytes ?? []));
  for (const st of o.stickers ?? []) {
    add(ids.stickerIdBase + st.slot * ids.stickerStride, u32Bytes(st.id));
    if (st.wear !== undefined) add(ids.stickerWearBase + st.slot * ids.stickerStride, f32Bytes(st.wear));
    if (st.anchor !== undefined) add(ids.stickerSchemaBase + st.slot, u32Bytes(st.anchor));
  }
  if (o.charm) {
    add(ids.charmId, u32Bytes(o.charm.id));
    if (o.charm.pattern !== undefined) add(ids.charmPattern, u32Bytes(o.charm.pattern));
  }
  return create(CSOEconItemSchema, { id: o.id ?? 1234567890123n, defIndex: o.defIndex ?? 7, quality: o.quality ?? 4, attribute, ...(o.rarity !== undefined ? { rarity: o.rarity } : {}), ...(o.customName ? { customName: o.customName } : {}) });
}

/** CMsgSOCacheSubscribed bytes: a root knife, a storage unit (1201) and one item inside it. */
export function buildSyntheticCacheSubscribed(custom?: CSOEconItem[]): Uint8Array {
  const unitId = 5000000000001n;
  const items = custom ?? [
    makeEconItem({ id: 100n, defIndex: 507 }),
    makeEconItem({ id: unitId, defIndex: 1201, containedItemCount: 1 }),
    makeEconItem({ id: 300n, defIndex: 4001, casketId: unitId }),
  ];
  return toBinary(CMsgSOCacheSubscribedSchema, create(CMsgSOCacheSubscribedSchema, {
    objects: [{ typeId: 1, objectData: items.map((i) => toBinary(CSOEconItemSchema, i)) }],
  }));
}

/** Seed one econ item into a GCClient's cache via SOCacheSubscribed, in root or a casket. */
export function seedItemInCache(_gc: GCClient, feed: (t: number, b: Uint8Array) => void, o: { itemId: string; casketId: string | null }): void {
  feed(GCMsg.SOCacheSubscribed, buildSyntheticCacheSubscribed([
    makeEconItem({ id: BigInt(o.itemId), casketId: o.casketId === null ? undefined : BigInt(o.casketId) }),
  ]));
}

/** An SOUpdate single-object frame that re-publishes one item with a new casket membership. */
export function soUpdateItemCasket(itemId: string, casketId: string | null): Uint8Array {
  const item = makeEconItem({ id: BigInt(itemId), casketId: casketId === null ? undefined : BigInt(casketId) });
  return toBinary(CMsgSOSingleObjectSchema, create(CMsgSOSingleObjectSchema, { typeId: 1, objectData: toBinary(CSOEconItemSchema, item) }));
}

/** An SOUpdate single-object frame that re-publishes one item with a new custom name. */
export function soUpdateItemName(itemId: string, name: string): Uint8Array {
  const item = create(CSOEconItemSchema, { ...makeEconItem({ id: BigInt(itemId) }), customName: name });
  return toBinary(CMsgSOSingleObjectSchema, create(CMsgSOSingleObjectSchema, { typeId: 1, objectData: toBinary(CSOEconItemSchema, item) }));
}

/** SOCreate/SOUpdate/SODestroy body for any synthetic item. */
/** The account's charm removal charges as Steam sends them: SO type 15. */
export function soCharges(charges: number): Uint8Array {
  return toBinary(CMsgSOSingleObjectSchema, create(CMsgSOSingleObjectSchema, { typeId: 15, objectData: toBinary(CSOAccountKeychainRemoveToolChargesSchema, create(CSOAccountKeychainRemoveToolChargesSchema, { charges })) }));
}

export function soItem(o: EconItemOpts): Uint8Array {
  return toBinary(CMsgSOSingleObjectSchema, create(CMsgSOSingleObjectSchema, { typeId: 1, objectData: toBinary(CSOEconItemSchema, makeEconItem(o)) }));
}
