import untradable from "./untradable-defs.json" with { type: "json" };
import stickerDefs from "./sticker-defs.json" with { type: "json" };
import capabilityData from "./capabilities.json" with { type: "json" };
import type { StickerSlot } from "../types.js";

// Generated from items_game by tools/gen-item-defs.ts.
export const UNTRADABLE_DEFS: ReadonlySet<number> = new Set(untradable);
const TAKES_STICKERS: ReadonlySet<number> = new Set(stickerDefs);
// Sticker, patch, sealed and unsealed graffiti items: the kit they are sits in sticker slot 0.
export const KIT_ITEM_DEFS: ReadonlySet<number> = new Set([1209, 4609, 1348, 1349]);

/** What items_game lets an item definition do, its prefab chain resolved (generated from items_game.txt). */
export type Capability = "nameable" | "can_sticker" | "can_keychain" | "can_patch" | "can_stattrack_swap" | "decodable" | "can_wrap_sticker";
const CAPABILITIES = capabilityData.capabilities as Record<string, string[]>;
export const hasCapability = (defIndex: number | null | undefined, cap: Capability): boolean =>
  defIndex != null && (CAPABILITIES[defIndex] ?? []).includes(cap);

/** Sticker slots as the game shows them: on guns and agents (can_sticker, can_patch) and kit items; a Pick'em coin's slots hold its team pick, never a sticker. */
export function shownStickers(defIndex: number | null, stickers: StickerSlot[]): StickerSlot[] {
  return defIndex != null && (TAKES_STICKERS.has(defIndex) || KIT_ITEM_DEFS.has(defIndex)) ? stickers : [];
}
