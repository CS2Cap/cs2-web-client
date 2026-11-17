import { fromBinary } from "@bufbuild/protobuf";
import "../protobuf-text.js";
import type { DomainItem } from "../types.js";
import { decodeEconItem } from "../items/decode.js";
import { loadAttributeIds, type AttributeIds } from "../items/attributes.js";
import {
  type CMsgSOCacheSubscribed,
  CMsgClientWelcomeSchema,
  CMsgSOCacheSubscribedSchema,
  CMsgSOSingleObjectSchema,
  CMsgSOMultipleObjectsSchema,
} from "../gen/csgo/gcsdk_gcmessages_pb.js";
import { CSOEconItemSchema } from "../gen/csgo/base_gcmessages_pb.js";
import { CSOAccountItemPersonalStoreSchema, CSOAccountKeychainRemoveToolChargesSchema, CSOAccountXpShopSchema, CSOVolatileItemOfferSchema } from "../gen/csgo/cstrike15_gcmessages_pb.js";

/** SO type id of CSOEconItem. */
export const SO_TYPE_ECON_ITEM = 1;
/** SO type id of the account's charm removal charges; absent while there are none (live 2026-10-26). */
const SO_TYPE_REMOVAL_CHARGES = 15;
/** SO type id of CSOAccountItemPersonalStore: the weekly care package (CS2's "PersonalStore" cache type; 4 slots in the recorded welcome). */
const SO_TYPE_PERSONAL_STORE = 4;
/** SO type id of CSOAccountXpShop: the Armory's star balance and pass tracks (client.dll template id; 3 stars on the test account, live 2026-10-27). */
const SO_TYPE_XP_SHOP = 6;
/** SO type id of CSOVolatileItemOffer: per terminal kind, the collection's skins offered on any terminal, as a set sorted by faux id (live 2026-10-27: no offer order kept; CS2's "Collection Catalog XP", per its UpdateCollectionDots). Steam only holds it for a while after CS2 opens a terminal (gone 73 min after the last offer, live 2026-10-27). */
const SO_TYPE_VOLATILE_OFFER = 20;
/** Non-economy flag: store-bought untradable keys, name tags and Sticker Slabs carry it (flags 24), and Steam's own inventory shows those. */
export const FLAG_HIDDEN = 0x8;
/** A faux item id (0xF000000000000000 | def) is a placeholder Steam keeps, never an owned item (live 2026-10-28: a CS:GO Weapon Case). */
const faux = (i: DomainItem): boolean => BigInt(i.gcItemId) >= 0xf000000000000000n;

/** The weekly care package as CS2's rankup_redemption_store reads it: a faux id is a slot already claimed. */
export interface PersonalStore { generationTime: number; balance: number; itemIds: string[] }
/** One care-package slot: `item` is the offered reward while it can be claimed, null once claimed (Steam swaps in a faux id). */
export interface CarePackageSlot { itemId: string; claimed: boolean; item: DomainItem | null }
export interface CarePackage { generationTime: number; balance: number; slots: CarePackageSlot[] }

export type SOMutation = { kind: "create" | "update" | "destroy"; item: DomainItem | null; id: string };
/** An object or message nothing decodes yet (terminal offers among them), kept raw for study. */
export interface RawCapture { typeId: number; kind: "create" | "update" | "destroy" | "message"; hex: string; at: number }
const RAW_KEPT = 200;
export const toHex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");

export class SOCache {
  private readonly attrs: AttributeIds = loadAttributeIds(null);
  private readonly items = new Map<string, DomainItem>();
  private readonly offers = new Map<number, bigint[]>();
  private stars: number | null = null;
  private personal: PersonalStore | null = null;
  private tracks: number[] = [];
  private readonly listeners: Array<(m: SOMutation) => void> = [];
  private failures = 0;
  private charges = 0;
  private readonly rawKept: RawCapture[] = [];

  /** Undecoded objects and messages, oldest first, the last 200. */
  get raw(): RawCapture[] { return [...this.rawKept]; }

  /** A chatty message type keeps only its last 5, so it never pushes the rest out. */
  keepRaw(typeId: number, kind: RawCapture["kind"], data: Uint8Array): void {
    const same = (r: RawCapture) => r.kind === "message" && r.typeId === typeId;
    if (kind === "message" && this.rawKept.filter(same).length >= 5) this.rawKept.splice(this.rawKept.findIndex(same), 1);
    this.rawKept.push({ typeId, kind, hex: toHex(data), at: Date.now() });
    if (this.rawKept.length > RAW_KEPT) this.rawKept.shift();
  }

  /** The skins a terminal kind's collection has offered, as faux item ids in Steam's (sorted) order; null with no record. */
  offersShown(defIndex: number): bigint[] | null { return this.offers.get(defIndex) ?? null; }

  /** Armory stars the account can spend; null before Steam sends the shop object. */
  get armoryStars(): number | null { return this.stars; }

  /** The weekly care package; null before Steam sends it. */
  get personalStore(): PersonalStore | null { return this.personal; }

  /** The care package with each slot's reward; null before Steam sends it. */
  carePackage(): CarePackage | null {
    const p = this.personal;
    if (!p) return null;
    const slots = p.itemIds.map((itemId) => {
      const item = this.items.get(itemId);
      const open = !!item && !faux(item) && this.unclaimedReward(item);
      return { itemId, claimed: !open, item: open ? item : null };
    });
    return { generationTime: p.generationTime, balance: p.balance, slots };
  }

  /** A care-package reward still on offer (free reward status 1) is a choice, not an owned item. */
  isUnclaimedReward(gcItemId: string): boolean {
    const i = this.items.get(gcItemId);
    return !!i && this.unclaimedReward(i);
  }

  /** Each active Armory Pass's XP, as CS2's Armory reads `xp_tracks`; empty before the shop object or with no pass active. */
  get armoryTracks(): number[] { return this.tracks; }

  /** Charm removals the account has left. */
  get removalCharges(): number { return this.charges; }

  /** Objects whose bytes could not be decoded; a snapshot with any is not complete. */
  get decodeFailures(): number { return this.failures; }

  onMutation(cb: (m: SOMutation) => void): void { this.listeners.push(cb); }

  private emit(m: SOMutation): void { for (const cb of this.listeners) cb(m); }

  private decode(typeId: number, data: Uint8Array): DomainItem | null {
    if (typeId !== SO_TYPE_ECON_ITEM) return null;
    return decodeEconItem(fromBinary(CSOEconItemSchema, data), this.attrs);
  }

  private upsert(typeId: number, data: Uint8Array, kind: "create" | "update"): void {
    if (typeId === SO_TYPE_REMOVAL_CHARGES) {
      this.charges = fromBinary(CSOAccountKeychainRemoveToolChargesSchema, data).charges ?? 0;
      return;
    }
    if (typeId === SO_TYPE_PERSONAL_STORE) {
      try {
        const p = fromBinary(CSOAccountItemPersonalStoreSchema, data);
        this.personal = { generationTime: p.generationTime ?? 0, balance: p.redeemableBalance ?? 0, itemIds: p.items.map(String) };
      } catch { this.failures++; }
      return;
    }
    if (typeId === SO_TYPE_XP_SHOP) {
      try {
        const shop = fromBinary(CSOAccountXpShopSchema, data);
        this.stars = shop.redeemableBalance ?? 0;
        this.tracks = [...shop.xpTracks];
      } catch { this.failures++; }
      return;
    }
    if (typeId === SO_TYPE_VOLATILE_OFFER) {
      try { const o = fromBinary(CSOVolatileItemOfferSchema, data); this.offers.set(o.defidx, [...o.fauxItemid]); } catch { this.failures++; }
    }
    if (typeId !== SO_TYPE_ECON_ITEM) { this.keepRaw(typeId, kind, data); return; }
    let item: DomainItem | null;
    try { item = this.decode(typeId, data); } catch { this.failures++; return; }
    if (!item) return;
    this.items.set(item.gcItemId, item);
    this.emit({ kind, item, id: item.gcItemId });
  }

  applyCacheSubscribed(body: Uint8Array): void {
    this.applySubscribed(fromBinary(CMsgSOCacheSubscribedSchema, body));
  }

  /** CS2 delivers the full inventory inside ClientWelcome.outofdate_subscribed_caches. */
  applyClientWelcome(body: Uint8Array): void {
    for (const c of fromBinary(CMsgClientWelcomeSchema, body).outofdateSubscribedCaches) this.applySubscribed(c);
  }

  private applySubscribed(msg: CMsgSOCacheSubscribed): void {
    for (const t of msg.objects) {
      for (const data of t.objectData) this.upsert(t.typeId, data, "create");
    }
  }

  applyCreate(body: Uint8Array): void {
    const o = fromBinary(CMsgSOSingleObjectSchema, body);
    this.upsert(o.typeId, o.objectData, "create");
  }

  applyUpdate(body: Uint8Array): void {
    const o = fromBinary(CMsgSOSingleObjectSchema, body);
    this.upsert(o.typeId, o.objectData, "update");
  }

  applyDestroy(body: Uint8Array): void {
    const o = fromBinary(CMsgSOSingleObjectSchema, body);
    if (o.typeId === SO_TYPE_REMOVAL_CHARGES) this.charges = 0;
    if (o.typeId === SO_TYPE_PERSONAL_STORE) this.personal = null;
    if (o.typeId === SO_TYPE_VOLATILE_OFFER) { try { this.offers.delete(fromBinary(CSOVolatileItemOfferSchema, o.objectData).defidx); } catch { this.failures++; } }
    else if (o.typeId !== SO_TYPE_ECON_ITEM) this.keepRaw(o.typeId, "destroy", o.objectData);
    const item = this.decode(o.typeId, o.objectData);
    if (!item) return;
    this.items.delete(item.gcItemId);
    this.emit({ kind: "destroy", item: null, id: item.gcItemId });
  }

  applyUpdateMultiple(body: Uint8Array): void {
    const msg = fromBinary(CMsgSOMultipleObjectsSchema, body);
    for (const o of msg.objectsModified) this.upsert(o.typeId, o.objectData, "update");
  }

  rootItems(): DomainItem[] {
    return [...this.items.values()].filter((i) => i.casketId === null && (i.flags & FLAG_HIDDEN) === 0 && !this.unclaimedReward(i) && !faux(i));
  }

  /** Everything currently decoded, including already loaded storage contents. No network read. */
  knownItems(): DomainItem[] { return [...this.items.values()]; }

  /** Non-economy root items (untradable store-bought keys, name tags and Sticker Slabs among them). */
  nonEconomyItems(): DomainItem[] {
    return [...this.items.values()].filter((i) => i.casketId === null && (i.flags & FLAG_HIDDEN) !== 0 && !this.unclaimedReward(i) && !faux(i));
  }

  private unclaimedReward(i: DomainItem): boolean {
    const a = i.unknownAttributes.find((x) => x.defindex === this.attrs.freeRewardStatus);
    return !!a && a.rawValue.length >= 4 && new DataView(a.rawValue.buffer, a.rawValue.byteOffset, 4).getUint32(0, true) === 1;
  }

  casketContents(casketId: string): DomainItem[] {
    return [...this.items.values()].filter((i) => i.casketId === casketId);
  }

  get(gcItemId: string): DomainItem | undefined { return this.items.get(gcItemId); }
}
