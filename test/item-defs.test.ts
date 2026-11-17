import { describe, expect, it } from "vitest";
import { hasCapability, shownStickers, UNTRADABLE_DEFS } from "../src/items/defs.js";

const slot = { slot: 0, stickerId: 6711, wear: null, scale: null, rotation: null, offsetX: null, offsetY: null };

describe("item definitions", () => {
  it("keeps sticker slots on guns, agents and kit items only", () => {
    expect(shownStickers(7, [slot])).toHaveLength(1); // AK-47
    expect(shownStickers(4619, [slot])).toHaveLength(1); // an agent (patches)
    expect(shownStickers(1209, [slot])).toHaveLength(1); // a sticker item
    expect(shownStickers(4885, [slot])).toEqual([]); // Paris 2023 Silver Coin: the team picked
    expect(shownStickers(null, [slot])).toEqual([]);
  });
  it("marks coins untradable from their definition", () => {
    expect(UNTRADABLE_DEFS.has(4759)).toBe(true);
    expect(UNTRADABLE_DEFS.has(7)).toBe(false);
  });
});

describe("items_game capabilities", () => {
  it.each([
    ["AK-47 takes stickers, a charm and a name", 7, ["can_sticker", "can_keychain", "nameable", "can_stattrack_swap"], ["can_patch"]],
    ["Zeus x27 is a weapon like any gun", 31, ["can_sticker", "can_keychain", "nameable", "can_stattrack_swap"], []],
    ["knives take a name and a StatTrak swap, no stickers or charm", 507, ["nameable", "can_stattrack_swap"], ["can_sticker", "can_keychain"]],
    ["default knives too", 42, ["nameable", "can_stattrack_swap"], ["can_keychain"]],
    ["music kits only swap StatTrak", 1314, ["can_stattrack_swap"], ["nameable"]],
    ["pets take a name", 4681, ["nameable"], ["can_sticker"]],
    ["gloves take nothing", 5030, [], ["nameable", "can_sticker", "can_keychain"]],
    ["agents take patches, no name", 4726, ["can_patch"], ["nameable"]],
  ] as const)("%s", (_n, def, yes, no) => {
    for (const c of yes) expect(hasCapability(def, c)).toBe(true);
    for (const c of no) expect(hasCapability(def, c)).toBe(false);
  });
  it("gives an unknown or missing definition nothing", () => {
    expect(hasCapability(null, "nameable")).toBe(false);
    expect(hasCapability(999999, "nameable")).toBe(false);
  });
});
