import type { CSOEconItem } from "../gen/csgo/base_gcmessages_pb.js";
import type { DomainItem, RawAttribute, StickerSlot } from "../types.js";
import type { AttributeIds } from "./attributes.js";

const SOUVENIR_QUALITY = 12;

function rawBytes(a: { value: number; valueBytes: Uint8Array }): Uint8Array {
  if (a.valueBytes && a.valueBytes.length > 0) return a.valueBytes;
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, a.value >>> 0, true);
  return b;
}
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u32 = (b: Uint8Array): number => (b.length >= 4 ? view(b).getUint32(0, true) : 0);
const f32 = (b: Uint8Array): number | null => (b.length >= 4 ? view(b).getFloat32(0, true) : null);
// Paint index/seed are float-encoded by the GC; the real value is the floor.
const floorF32 = (b: Uint8Array): number | null => { const v = f32(b); return v === null ? null : Math.floor(v); };

/** Custom names (attr 111) are a protobuf {1: string} wrapper: 0x0a, varint length, utf-8 bytes. */
function unwrapName(b: Uint8Array): string {
  if (b.length >= 2 && b[0] === 0x0a) {
    let len = 0, shift = 0, i = 1;
    for (; i < b.length; i++) { len |= (b[i] & 0x7f) << shift; if (!(b[i] & 0x80)) { i++; break; } shift += 7; }
    if (i + len <= b.length) return new TextDecoder("utf-8", { ignoreBOM: true }).decode(b.subarray(i, i + len));
  }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(b);
}

export function decodeEconItem(obj: CSOEconItem, attrs: AttributeIds): DomainItem {
  const id = obj.id.toString();
  const item: DomainItem = {
    steamAssetId: id, gcItemId: id,
    defIndex: obj.defIndex ?? null, quality: obj.quality ?? null, rarity: obj.rarity ?? null,
    flags: obj.flags ?? 0, origin: obj.origin ?? null,
    customName: obj.customName ?? "", casketId: null, containedItemCount: null,
    paintIndex: null, paintSeed: null, paintWear: null,
    isStatTrak: false, isSouvenir: obj.quality === SOUVENIR_QUALITY, killEaterValue: null,
    stickers: [], charms: [], musicKitId: null, tradableAfter: null, unknownAttributes: [],
  };
  const stickers = new Map<number, StickerSlot>();
  const stickerSlot = (s: number) => {
    let e = stickers.get(s);
    if (!e) stickers.set(s, (e = { slot: s, stickerId: 0, wear: null, scale: null, rotation: null, offsetX: null, offsetY: null, anchor: null }));
    return e;
  };
  let charmId: number | null = null;
  let charmPattern: number | null = null;
  let highlightReelId: number | null = null;
  let sealedSticker: number | null = null;
  const charmOffset: (number | null)[] = [null, null, null];
  let casketLow: number | null = null;
  let casketHigh: number | null = null;

  for (const a of obj.attribute) {
    const d = a.defIndex;
    const b = rawBytes(a);
    if (d !== attrs.customName && b.length < 4) {
      item.unknownAttributes.push({ defindex: d, rawValue: b });
      continue;
    }
    const rel = d - attrs.stickerIdBase;
    const slot = Math.floor(rel / attrs.stickerStride);
    const field = rel - slot * attrs.stickerStride;
    if (rel >= 0 && slot < attrs.stickerSlots && field >= 0 && field < 4) {
      const s = stickerSlot(slot);
      if (field === 0) s.stickerId = u32(b);
      else if (field === 1) s.wear = f32(b);
      else if (field === 2) s.scale = f32(b);
      else s.rotation = f32(b);
      continue;
    }
    const offRel = d - attrs.stickerOffsetXBase;
    const offSlot = Math.floor(offRel / attrs.stickerOffsetStride);
    if (offRel >= 0 && offSlot < attrs.stickerSlots) {
      const s = stickerSlot(offSlot);
      if (d === attrs.stickerOffsetXBase + offSlot * attrs.stickerOffsetStride) s.offsetX = f32(b);
      else if (d === attrs.stickerOffsetYBase + offSlot * attrs.stickerOffsetStride) s.offsetY = f32(b);
      continue;
    }
    const schemaSlot = d - attrs.stickerSchemaBase;
    if (schemaSlot >= 0 && schemaSlot < attrs.stickerSlots) {
      stickerSlot(schemaSlot).anchor = u32(b);
      continue;
    }
    switch (d) {
      case attrs.paintIndex: item.paintIndex = floorF32(b); break;
      case attrs.paintSeed: item.paintSeed = floorF32(b); break;
      case attrs.paintWear: item.paintWear = f32(b); break;
      case attrs.killEater: item.isStatTrak = true; item.killEaterValue = u32(b); break;
      case attrs.customName: if (!item.customName) item.customName = unwrapName(b); break;
      case attrs.tradableAfter: item.tradableAfter = u32(b); break;
      case attrs.containedItemCount: item.containedItemCount = u32(b); break;
      case attrs.casketIdLow: casketLow = u32(b); break;
      case attrs.casketIdHigh: casketHigh = u32(b); break;
      case attrs.charmId: charmId = u32(b); break;
      case attrs.charmPattern: charmPattern = u32(b); break;
      case attrs.charmHighlightReel: highlightReelId = u32(b); break;
      case attrs.charmSticker: sealedSticker = u32(b); break;
      case attrs.charmOffsetX: charmOffset[0] = f32(b); break;
      case attrs.charmOffsetY: charmOffset[1] = f32(b); break;
      case attrs.charmOffsetZ: charmOffset[2] = f32(b); break;
      case attrs.musicId: item.musicKitId = u32(b); break;
      default: item.unknownAttributes.push({ defindex: d, rawValue: b } satisfies RawAttribute);
    }
  }
  if (casketLow !== null || casketHigh !== null) {
    item.casketId = ((BigInt(casketHigh ?? 0) << 32n) | BigInt(casketLow ?? 0)).toString();
  }
  item.stickers = [...stickers.values()].sort((x, y) => x.slot - y.slot);
  const offset = charmOffset.every((v) => v !== null) ? (charmOffset as [number, number, number]) : null;
  if (charmId !== null || highlightReelId !== null) item.charms = [{ slot: 0, charmId: charmId ?? 0, pattern: charmPattern, highlightReelId, offset, ...(sealedSticker !== null ? { stickerId: sealedSticker } : {}) }];
  return item;
}
