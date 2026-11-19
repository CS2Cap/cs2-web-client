// Item actions: stickers, charms, name tags, patches, cases, trade-ups and the Armory.
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { CMsgGCItemCustomizationNotificationSchema } from "../gen/csgo/econ_gcmessages_pb.js";
import { patchReplacement } from "./agent-patches.js";
import { CMsgApplyStatTrakSwapSchema, CMsgApplyStickerSchema, CMsgCraftItemsRequestSchema, CMsgModifyItemStringAttrSchema, CMsgOpenCrateSchema, CMsgUseItemSchema } from "../gen/csgo/base_gcmessages_pb.js";
import { CMsgGCCstrike15_v2_ClientRedeemFreeRewardSchema, CMsgGCCstrike15_v2_ClientRedeemMissionRewardSchema } from "../gen/csgo/cstrike15_gcmessages_pb.js";
import { MutationTimeout, type GCClient, type MutationIntent, type SkinPrint } from "./client.js";
import type { SOCache } from "./so-cache.js";
import type { DomainItem } from "../types.js";

const POLL_MS = 10;
// Opening and trading up create an item; once the inputs are gone, its SOCreate may still be in flight.
const CREATED_SETTLE_MS = 3000;
const CREATES = new Set<MutationIntent["kind"]>(["open", "craft", "redeemArmory", "buyWithTokens", "slabSticker", "crackSlab", "activatePass", "claimRewards"]);
// Sticker wear is a float32 on the wire; a scrape step is far larger than this.
const WEAR_EPSILON = 1e-6;
const APPLY_STICKER = 1086;
// def 65 "Remove Keychain Tool" as a default-item id (0xF000000000000000 | 65): removes a charm on one of the account's removal charges.
const REMOVE_KEYCHAIN_TOOL = 0xf000000000000000n | 65n;
const NAME_ITEM = 1006;
// CS2's MissionsAPI.ActionRedeemOperationGoods(track, shop_index, cost) (xpshop.vts_c).
const REDEEM_MISSION_REWARD = 9209;
// CS2's StoreAPI.StoreRedeemFreeRewards(ids) (rankup_redemption_store.vts_c): claims picked care-package rewards.
const REDEEM_FREE_REWARD = 9219;
const REMOVE_ITEM_NAME = 1030;
const OPEN_CRATE = 2534;
const UNLOCK_CRATE_RESPONSE = 1008;
const USE_ITEM = 1025;
const CHARM_DETACHMENT_PACK = 4950;
const CRAFT = 1002;
const CRAFT_RESPONSE = 1003;
const UNKNOWN_RECIPE = 0xffff;
// items_game 169 "quest points remaining": an active terminal's offer counter, 1 on its first offer (live 2026-10-26).
const OFFER_COUNTER = 169;
const MAX_I32 = 0x7fffffff;

/** The offer on show, as the terminal counts it; null before its first offer. */
export function offerCounter(item: DomainItem): number | null {
  const b = item.unknownAttributes.find((a) => a.defindex === OFFER_COUNTER)?.rawValue;
  return b && b.length >= 4 ? new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true) : null;
}

/** CS2 treats a counter of 0 or below as the final offer, where the same message ends the terminal (popup_offers_laptop_interface). */
export const declinable = (counter: number | null): counter is number => counter != null && counter >= 1 && counter <= MAX_I32;
/** CS2's _IsFinalOffer: a counter of 0 or below (a u32 past i32's range) is the final offer, where End discards the terminal. */
export const finalOffer = (counter: number | null): counter is number => counter != null && !declinable(counter);

/** The GC answered and said no: nothing changed. */
export class ItemActionRefused extends Error {
  constructor(what: string) {
    super(`refused: ${what}`);
    this.name = "ItemActionRefused";
  }
}

function send(gc: GCClient, intent: MutationIntent): void {
  switch (intent.kind) {
    case "applyPatch":
      gc.sendRaw(APPLY_STICKER, toBinary(CMsgApplyStickerSchema, create(CMsgApplyStickerSchema, {
        stickerItemId: BigInt(intent.patchItemId), itemItemId: BigInt(intent.itemId), stickerSlot: intent.slot,
      })), { proto: true });
      return;
    case "removePatch":
      gc.sendRaw(APPLY_STICKER, toBinary(CMsgApplyStickerSchema, create(CMsgApplyStickerSchema, {
        itemItemId: BigInt(intent.itemId), stickerSlot: intent.slot, stickerWear: -1,
      })), { proto: true });
      return;
    case "swapStatTrak":
      gc.sendRaw(1088, toBinary(CMsgApplyStatTrakSwapSchema, create(CMsgApplyStatTrakSwapSchema, {
        toolItemId: BigInt(intent.toolItemId), item1ItemId: BigInt(intent.itemId), item2ItemId: BigInt(intent.otherItemId),
      })), { proto: true });
      return;
    case "scrapeSticker":
      // WearItemSticker 0x18117fbc0: to a target, no field 1, the current wear (-1 without one) and the target.
      if (intent.target) {
        gc.sendRaw(APPLY_STICKER, toBinary(CMsgApplyStickerSchema, create(CMsgApplyStickerSchema, {
          itemItemId: BigInt(intent.itemId), stickerSlot: intent.slot, stickerWear: intent.wearBefore ?? -1, stickerWearTarget: intent.target,
        })), { proto: true });
        return;
      }
      // A zero sticker id makes ApplySticker a scrape of the slot.
      gc.sendRaw(APPLY_STICKER, toBinary(CMsgApplyStickerSchema, create(CMsgApplyStickerSchema, { itemItemId: BigInt(intent.itemId), stickerItemId: 0n, stickerSlot: intent.slot })), { proto: true });
      return;
    case "applySticker":
      // `sticker_slot` is the place on the model; Steam keeps the sticker in its first free slot (see placeOf).
      gc.sendRaw(APPLY_STICKER, toBinary(CMsgApplyStickerSchema, create(CMsgApplyStickerSchema, {
        stickerItemId: BigInt(intent.stickerItemId),
        itemItemId: BigInt(intent.itemId),
        stickerSlot: intent.slot,
        stickerRotation: intent.rotation,
        stickerOffsetX: intent.offsetX,
        stickerOffsetY: intent.offsetY,
        // CEconTool_Sticker 0x1811a22e0: the scrape level as sticker_wear, only above 0; never sticker_wear_target.
        ...(intent.wear ? { stickerWear: intent.wear } : {}),
      })), { proto: true });
      return;
    case "applyCharm": {
      // Live 2026-10-24: Steam takes a charm only with no slot field and a real x/y/z on the gun; a slot, or no offsets, gets no answer.
      const [x, y, z] = intent.offset!;
      gc.sendRaw(APPLY_STICKER, toBinary(CMsgApplyStickerSchema, create(CMsgApplyStickerSchema, {
        stickerItemId: BigInt(intent.charmItemId), itemItemId: BigInt(intent.itemId), stickerOffsetX: x, stickerOffsetY: y, stickerOffsetZ: z,
      })), { proto: true });
      return;
    }
    case "removeCharm":
      gc.sendRaw(APPLY_STICKER, toBinary(CMsgApplyStickerSchema, create(CMsgApplyStickerSchema, { stickerItemId: REMOVE_KEYCHAIN_TOOL, itemItemId: BigInt(intent.itemId) })), { proto: true });
      return;
    case "slabSticker":
      // CS2's UseTool(sticker, slab) under work type can_wrap_sticker: an ApplySticker onto the slab (live 2026-10-28, notification 1055).
      gc.sendRaw(APPLY_STICKER, toBinary(CMsgApplyStickerSchema, create(CMsgApplyStickerSchema, { stickerItemId: BigInt(intent.stickerItemId), itemItemId: BigInt(intent.itemId), stickerSlot: 0 })), { proto: true });
      return;
    case "crackSlab":
      // CS2's RemoveKeychain(slab, 0): the charm removal aimed at the slab; it uses no removal charge (live 2026-10-28, notification 1054).
      gc.sendRaw(APPLY_STICKER, toBinary(CMsgApplyStickerSchema, create(CMsgApplyStickerSchema, { stickerItemId: REMOVE_KEYCHAIN_TOOL, itemItemId: BigInt(intent.itemId) })), { proto: true });
      return;
    case "nameTag":
      // Same message as a storage unit rename (live since 2026-10-08), with the name tag as the tool.
      gc.sendRaw(NAME_ITEM, toBinary(CMsgModifyItemStringAttrSchema, create(CMsgModifyItemStringAttrSchema, {
        toolItemId: BigInt(intent.nameTagItemId), subjectItemId: BigInt(intent.itemId), attrValue: intent.name,
      })), { proto: true });
      return;
    case "removeNameTag":
      // Unproven: the GC ignores non-proto item messages since 2026-10-08, so the proto form is tried.
      gc.sendRaw(REMOVE_ITEM_NAME, toBinary(CMsgModifyItemStringAttrSchema, create(CMsgModifyItemStringAttrSchema, { subjectItemId: BigInt(intent.itemId) })), { proto: true });
      return;
    case "open":
      gc.sendRaw(OPEN_CRATE, toBinary(CMsgOpenCrateSchema, create(CMsgOpenCrateSchema, {
        toolItemId: intent.keyItemId ? BigInt(intent.keyItemId) : 0n, subjectItemId: BigInt(intent.itemId),
      })), { proto: true });
      return;
    case "declineOffer":
    case "endTerminal":
      // CS2's UseToolWithIntArg(terminal, terminal, counter): the terminal is its own tool, `points_remaining` the offer on show
      // (the final offer's negative counter goes as its uint32, as Steam stores it: _DealerEndTransaction).
      gc.sendRaw(OPEN_CRATE, toBinary(CMsgOpenCrateSchema, create(CMsgOpenCrateSchema, {
        toolItemId: BigInt(intent.itemId), subjectItemId: BigInt(intent.itemId), pointsRemaining: intent.offerCounter,
      })), { proto: true });
      return;
    case "firstOffer":
      // The first offer right after unsealing (captured live 2026-10-28): the same message with points_remaining 0.
      gc.sendRaw(OPEN_CRATE, toBinary(CMsgOpenCrateSchema, create(CMsgOpenCrateSchema, {
        toolItemId: BigInt(intent.itemId), subjectItemId: BigInt(intent.itemId), pointsRemaining: 0,
      })), { proto: true });
      return;
    case "redeemArmory":
      gc.sendRaw(REDEEM_MISSION_REWARD, toBinary(CMsgGCCstrike15_v2_ClientRedeemMissionRewardSchema, create(CMsgGCCstrike15_v2_ClientRedeemMissionRewardSchema, {
        campaignId: intent.campaignId, redeemId: intent.redeemId, redeemableBalance: intent.starsBefore ?? 0, expectedCost: intent.stars,
      })), { proto: true, job: true });
      return;
    case "buyWithTokens":
      // CS2's ActionOperationFauxPurchase: no redeem_id, the cart in volatile_shop (live 2026-11-18).
      gc.sendRaw(REDEEM_MISSION_REWARD, toBinary(CMsgGCCstrike15_v2_ClientRedeemMissionRewardSchema, create(CMsgGCCstrike15_v2_ClientRedeemMissionRewardSchema, {
        campaignId: intent.campaignId, redeemableBalance: intent.tokensBefore ?? 0, expectedCost: intent.tokens, volatileShop: intent.offerIds.map(BigInt),
      })), { proto: true, job: true });
      return;
    case "claimRewards":
      gc.sendRaw(REDEEM_FREE_REWARD, toBinary(CMsgGCCstrike15_v2_ClientRedeemFreeRewardSchema, create(CMsgGCCstrike15_v2_ClientRedeemFreeRewardSchema, {
        generationTime: intent.generationTime ?? 0, redeemableBalance: intent.balanceBefore ?? 0, items: intent.itemIds.map(BigInt),
      })), { proto: true, job: true });
      return;
    case "activatePass":
      // CS2's Armory Activate is UseTool(pass, '') (xpshop.vts_c), as is a Major pass's; the pass is a usable_gc #ConsumeItem tool like the Charm Detachment Pack.
      gc.sendRaw(USE_ITEM, toBinary(CMsgUseItemSchema, create(CMsgUseItemSchema, { itemId: BigInt(intent.itemId) })), { proto: true });
      return;
    case "craft":
      // Proto since the 2026-10-08 update: the legacy u16 recipe/u16 count body gets no answer (live 2026-10-22).
      gc.sendRaw(CRAFT, toBinary(CMsgCraftItemsRequestSchema, create(CMsgCraftItemsRequestSchema, { recipeDef: intent.recipe, craftItems: intent.itemIds.map(BigInt) })), { proto: true });
      return;
    default:
      throw new Error(`item action not supported: ${intent.kind}`);
  }
}

export const skinPrint = ({ defIndex, paintIndex, paintSeed, paintWear, isStatTrak }: DomainItem): SkinPrint => ({ defIndex, paintIndex, paintSeed, paintWear, isStatTrak });
const sameSkin = (a: DomainItem, b: SkinPrint) =>
  b.paintWear != null && a.defIndex === b.defIndex && a.paintIndex === b.paintIndex && a.paintSeed === b.paintSeed && a.paintWear === b.paintWear && a.isStatTrak === b.isStatTrak;

/** Where a sticker sits on the model: Steam keeps a new sticker in the first free slot and anchors it to the one asked for (live 2026-10-26). */
export const placeOf = (s: { slot: number; anchor?: number | null }) => s.anchor ?? s.slot;

/** The item the action changed: Steam re-creates it under a new id when a sticker goes on (live 2026-10-24), found again by its skin. */
export function changedItem(cache: Pick<SOCache, "get" | "rootItems" | "armoryStars">, intent: MutationIntent): DomainItem | undefined {
  if (intent.kind === "applyPatch" || intent.kind === "removePatch") return cache.get(intent.itemId) ? undefined : patchReplacement(cache.rootItems(), intent);
  const item = cache.get(intent.itemId);
  if (item || !("was" in intent) || !intent.was) return item;
  const was = intent.was;
  return cache.rootItems().find((i) => i.gcItemId !== intent.itemId && sameSkin(i, was));
}

/** Has the intended change landed in the SO cache? Used to confirm a send and to reconcile a pending one. */
export function itemApplied(cache: Pick<SOCache, "get" | "rootItems" | "armoryStars" | "tokenBalance" | "personalStore" | "isUnclaimedReward">, intent: MutationIntent): boolean {
  const item = changedItem(cache, intent);
  switch (intent.kind) {
    case "applyPatch":
      return !!item && !cache.get(intent.patchItemId);
    case "removePatch":
      return !!item;
    case "swapStatTrak": {
      const other = changedItem(cache, { ...intent, itemId: intent.otherItemId, was: intent.otherWas });
      return !!item && !!other && item.gcItemId !== other.gcItemId && !cache.get(intent.toolItemId)
        && item.killEaterValue === intent.expectedOtherCount && other.killEaterValue === intent.expectedCount;
    }
    case "open":
      return !item && (!intent.keyItemId || !cache.get(intent.keyItemId));
    case "craft":
      return intent.itemIds.every((id) => !cache.get(id));
    case "slabSticker":
      return !cache.get(intent.itemId) && !cache.get(intent.stickerItemId);
    case "crackSlab":
    case "activatePass":
      return !cache.get(intent.itemId);
    case "scrapeSticker": {
      if (!item) return false;
      const s = item.stickers.find((x) => x.slot === intent.slot);
      return !s || (s.wear ?? 0) > (intent.wearBefore ?? 0) + WEAR_EPSILON;
    }
    case "applySticker": {
      const on = item?.stickers.filter((s) => s.stickerId > 0) ?? [];
      return !!item && !cache.get(intent.stickerItemId) && on.some((s) => placeOf(s) === intent.slot) && on.length > (intent.stickersBefore ?? 0);
    }
    case "applyCharm":
      return !!item && !cache.get(intent.charmItemId) && item.charms.length > 0;
    case "removeCharm":
      return !!item && item.charms.length === 0;
    case "nameTag":
      return !!item && !cache.get(intent.nameTagItemId) && item.customName === intent.name;
    case "removeNameTag":
      return !!item && item.customName === "";
    case "redeemArmory":
      return intent.starsBefore != null && cache.armoryStars === intent.starsBefore - intent.stars;
    case "buyWithTokens":
      return intent.tokensBefore != null && cache.tokenBalance(intent.campaignId) === intent.tokensBefore - intent.tokens;
    case "claimRewards": {
      // The balance drops; should Steam drop the store object instead, the picked rewards are owned now.
      const store = cache.personalStore;
      if (intent.balanceBefore == null) return false;
      return (!!store && store.balance < intent.balanceBefore) || intent.itemIds.every((id) => !!cache.get(id) && !cache.isUnclaimedReward(id));
    }
    case "firstOffer":
      return !!item && offerCounter(item) !== null;
    case "endTerminal":
      return !cache.get(intent.itemId);
    case "declineOffer":
      // The next offer's item can land after the counter moves; the declined one must be gone first.
      return !!item && offerCounter(item) !== intent.offerCounter && (!intent.offerItemId || !cache.get(intent.offerItemId));
    default:
      return false;
  }
}

/** A Charm Detachment Pack in the inventory: what a charm removal uses when the account has no charges left. */
export function detachmentPack(cache: Pick<SOCache, "rootItems" | "nonEconomyItems">): DomainItem | undefined {
  return [...cache.rootItems(), ...cache.nonEconomyItems()].find((i) => i.defIndex === CHARM_DETACHMENT_PACK);
}

/** Uses a pack (3 charges, live 2026-10-26) and waits for the charges to arrive. */
async function usePack(gc: GCClient, intent: MutationIntent, deadline: number): Promise<void> {
  gc.sendRaw(USE_ITEM, toBinary(CMsgUseItemSchema, create(CMsgUseItemSchema, { itemId: BigInt(detachmentPack(gc.cache)!.gcItemId) })), { proto: true });
  while (gc.cache.removalCharges === 0) {
    if (gc.sessionClosed || Date.now() >= deadline) throw new MutationTimeout(intent);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** Sends one item action and waits for its change. No change in time, or a dropped session, is ambiguous: MutationTimeout. */
export async function runItemOp(gc: GCClient, intent: MutationIntent, timeoutMs: number): Promise<{ created: string[]; itemId: string }> {
  // Claimed rewards can be untradable (a Chicken Egg) and a Viewer Pass's coin always is: Steam keeps those among the non-economy items.
  const owned = () => (intent.kind === "claimRewards" || intent.kind === "activatePass" ? [...gc.cache.rootItems(), ...gc.cache.nonEconomyItems()] : gc.cache.rootItems());
  const before = new Set(owned().map((i) => i.gcItemId));
  let refusal: string | null = null;
  const off = gc.onGcMessage((t, body) => {
    refusal ??= refusalOf(t, body);
    if (t === 1090 && (intent.kind === "applyPatch" || intent.kind === "removePatch") && intent.agent) {
      const n = fromBinary(CMsgGCItemCustomizationNotificationSchema, body);
      const request = intent.kind === "applyPatch" ? 1090 : 1089;
      // Slot metadata is optional; the replacement's complete layout verifies the selected slot.
      if (n.request === request && n.itemId.length === 1 && (intent.kind === "removePatch" || n.extraData.length === 0 || n.extraData[0] === BigInt(intent.slot))) {
        const id = String(n.itemId[0]);
        if (!intent.agent.beforeIds.includes(id)) intent.agent.replacementId = id;
      }
    }
  });
  try {
    const deadline = Date.now() + timeoutMs;
    if (intent.kind === "removeCharm" && gc.cache.removalCharges === 0) await usePack(gc, intent, deadline);
    send(gc, intent);
    let appliedAt: number | null = null;
    for (;;) {
      if (refusal) throw new ItemActionRefused(refusal);
      if (itemApplied(gc.cache, intent)) {
        // An ended terminal is gone: its own id is the result.
        const itemId = CREATES.has(intent.kind) || intent.kind === "endTerminal" ? intent.itemId : changedItem(gc.cache, intent)!.gcItemId;
        const created = owned().map((i) => i.gcItemId).filter((id) => !before.has(id) && id !== itemId);
        appliedAt ??= Date.now();
        // A closed session sends nothing more: what the cache holds is the result.
        if (created.length || !CREATES.has(intent.kind) || gc.sessionClosed || Date.now() - appliedAt >= CREATED_SETTLE_MS) return { created, itemId };
      } else if (gc.sessionClosed || Date.now() >= deadline) throw new MutationTimeout(intent);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    off();
  }
}

/** Explicit refusals: only craft and crate opening answer a bad request (live 2026-10-22); the rest stay silent. */
function refusalOf(gcMsgType: number, body: Uint8Array): string | null {
  const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
  // UnlockCrateResponse: u16, then a u32 EGCMsgResponse (0 = OK).
  if (gcMsgType === UNLOCK_CRATE_RESPONSE && body.byteLength >= 6 && v.getUint32(2, true) !== 0) return `open code ${v.getUint32(2, true)}`;
  // CraftResponse: u16 recipe first; 0xFFFF means no recipe matched the inputs.
  if (gcMsgType === CRAFT_RESPONSE && body.byteLength >= 2 && v.getUint16(0, true) === UNKNOWN_RECIPE) return "no trade-up recipe matches these items";
  return null;
}
