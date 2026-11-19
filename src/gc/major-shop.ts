import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";
import { CMsgGCCStrike15_v2_VolatileShopSubscribeSchema } from "../gen/csgo/cstrike15_gcmessages_pb.js";
import { valveLzmaDecode } from "../lzma.js";
import type { GCClient } from "./client.js";
import type { PurchaseLine } from "./purchase.js";

const VOLATILE_SHOP_SUBSCRIBE = 9228;

/** One thing a Major's shop sells for tokens. `itemId` is its faux item id (0xF000… | paintIndex << 16 | defIndex), what a checkout names; a sticker's `paintIndex` is its sticker id. */
export interface ShopOffer { itemId: string; defIndex: number; paintIndex: number; tokens: number }

/** A shop container's unpacked price list: repeated field 2 = { 1: faux item id, 2: tokens }. Fields 4 and 5 repeated the price in every offer seen (live 2026-11-18). */
export function shopOffers(list: Uint8Array): ShopOffer[] {
  const offers: ShopOffer[] = [];
  const top = new BinaryReader(list);
  while (top.pos < top.len) {
    const [field, wire] = top.tag();
    if (field !== 2 || wire !== WireType.LengthDelimited) { top.skip(wire); continue; }
    const r = new BinaryReader(top.bytes());
    let id = 0n, tokens = 0;
    while (r.pos < r.len) {
      const [f, w] = r.tag();
      if (f === 1 && w === WireType.Bit64) id = BigInt(r.fixed64());
      else if (f === 2 && w === WireType.Varint) tokens = r.uint32();
      else r.skip(w);
    }
    offers.push({ itemId: id.toString(), defIndex: Number(id & 0xffffn), paintIndex: Number((id >> 16n) & 0xffffffffn), tokens });
  }
  return offers;
}

/** Reads one of a Major's shop containers (its sticker or souvenir def), as CS2's StoreAPI.VolatileShopSubscribe does (9228 → 9228). */
export async function readShop(gc: GCClient, containerDef: number, timeoutMs: number): Promise<ShopOffer[]> {
  const payload = await new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("timeout waiting for the Major shop")); }, timeoutMs);
    const off = gc.onGcMessage((type, b) => {
      if (type !== VOLATILE_SHOP_SUBSCRIBE) return;
      const r = fromBinary(CMsgGCCStrike15_v2_VolatileShopSubscribeSchema, b);
      if (r.defidx !== containerDef) return;
      clearTimeout(timer);
      off();
      resolve(r.payload);
    });
    gc.sendRaw(VOLATILE_SHOP_SUBSCRIBE, toBinary(CMsgGCCStrike15_v2_VolatileShopSubscribeSchema, create(CMsgGCCStrike15_v2_VolatileShopSubscribeSchema, { defidx: containerDef })), { proto: true });
  });
  return payload.length ? shopOffers(valveLzmaDecode(payload)) : [];
}

/** The store line that buys `tokens` Major tokens: CS2's `StoreItemPurchase('<def>(<tokens>)')`. The count is the supplemental data, never the quantity (refused, result 2), and the price rounds up (live 2026-11-18). */
export function tokensLine(defIndex: number, tokens: number, centsPer100: number): PurchaseLine {
  return { defIndex, quantity: 1, costCents: Math.ceil(tokens * centsPer100 / 100), supplemental: String(tokens) };
}
