import defaults from "./attributes.default.json" with { type: "json" };

export interface AttributeIds {
  paintIndex: number; paintSeed: number; paintWear: number;
  killEater: number; customName: number; tradableAfter: number;
  containedItemCount: number; casketIdLow: number; casketIdHigh: number;
  // Sticker attributes repeat per slot: defindex = base + slot * stickerStride.
  stickerIdBase: number; stickerWearBase: number; stickerScaleBase: number; stickerRotationBase: number;
  stickerStride: number; stickerSlots: number;
  // Placement offsets: x at stickerOffsetXBase + slot * stickerOffsetStride, y right after it.
  stickerOffsetXBase: number; stickerOffsetYBase: number; stickerOffsetStride: number;
  // "sticker slot N schema" at stickerSchemaBase + slot: the place on the model the sticker hangs from (0 is place 0); absent means its own slot.
  stickerSchemaBase: number;
  charmId: number; charmPattern: number; charmHighlightReel: number; musicId: number;
  sprayTint: number;
  // "keychain slot 0 sticker": the sticker kit sealed in a Sticker Slab (live 2026-10-28).
  charmSticker: number;
  // Where the charm hangs, from the weapon's charm anchor (live 2026-10-24).
  charmOffsetX: number; charmOffsetY: number; charmOffsetZ: number;
  freeRewardStatus: number; alwaysTradable: number; cannotTrade: number; tradeProtectedUntil: number; casketModifiedAt: number;
}

const KEYS = Object.keys(defaults).filter((k) => k !== "_comment") as (keyof AttributeIds)[];

/** Prefers an object passed as `catalog` (partial AttributeIds), falling back per-key to the committed snapshot. */
export function loadAttributeIds(catalog: unknown): AttributeIds {
  const src = (catalog && typeof catalog === "object" ? catalog : {}) as Record<string, unknown>;
  const out = {} as Record<string, number>;
  for (const k of KEYS) {
    const v = src[k];
    out[k] = typeof v === "number" && Number.isInteger(v) ? v : (defaults as unknown as Record<string, number>)[k];
  }
  return out as unknown as AttributeIds;
}

/** An attribute's u32 (little-endian). Items reach the service worker from the offscreen document as JSON, where a
 * Uint8Array arrives as {"0": b0, "1": b1, …}; both forms read the same. */
export function attrU32(raw: unknown): number | null {
  const b = raw instanceof Uint8Array ? raw : raw && typeof raw === "object" ? Uint8Array.from(Object.values(raw as Record<string, number>)) : null;
  return b && b.length >= 4 ? new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true) : null;
}
