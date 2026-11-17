/** Storage unit definition index; a never-named unit carries no item count until its first naming. */
export const STORAGE_UNIT_DEF = 1201;

export interface RawAttribute { defindex: number; rawValue: Uint8Array; }
export interface StickerSlot { slot: number; stickerId: number; wear: number | null; scale: number | null; rotation: number | null; offsetX: number | null; offsetY: number | null; anchor?: number | null; }
/** `stickerId`: the sticker kit sealed in a Sticker Slab; absent on every other charm. */
export interface CharmSlot { slot: number; charmId: number; pattern: number | null; highlightReelId: number | null; offset: [number, number, number] | null; stickerId?: number }
export interface DomainItem {
  steamAssetId: string; gcItemId: string;        // both persisted even when equal
  defIndex: number | null; quality: number | null; rarity: number | null;
  flags: number; origin: number | null;
  customName: string; casketId: string | null;    // storage-unit membership
  containedItemCount: number | null;              // set on storage-unit items
  paintIndex: number | null; paintSeed: number | null; paintWear: number | null;
  isStatTrak: boolean; isSouvenir: boolean; killEaterValue: number | null;
  stickers: StickerSlot[]; charms: CharmSlot[];
  tradableAfter: number | null;
  musicKitId: number | null;
  unknownAttributes: RawAttribute[];              // fail-forward
  marketHashName?: string;                        // filled by econ/descriptions
}
