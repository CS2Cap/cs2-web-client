import type { DomainItem } from "../types.js";

import { hasCapability } from "../items/defs.js";

/** An agent that takes patches: items_game can_patch (prefab customplayertradable; default characters have can_patch 0). */
export const isAgentDef = (def: number | null) => hasCapability(def, "can_patch");
export const patchSlot = (slot: number) => Number.isInteger(slot) && slot >= 0 && slot < 3;
export type AgentPrint = { defIndex: number; patches: (number | null)[]; beforeIds: string[]; replacementId?: string };
export type PatchIntent =
  | { kind: "applyPatch"; itemId: string; patchItemId: string; slot: number; agent?: AgentPrint }
  | { kind: "removePatch"; itemId: string; slot: number; patchId: number; agent?: AgentPrint };

export const patchLayout = (item: Pick<DomainItem, "stickers">): (number | null)[] =>
  [0, 1, 2].map(slot => item.stickers.find(s => s.slot === slot)?.stickerId || null);

/** Steam's identified replacement with the expected layout; a cold snapshot alone cannot prove provenance. */
export function patchReplacement(items: DomainItem[], intent: PatchIntent): DomainItem | undefined {
  const expected = intent.agent;
  if (!expected?.replacementId || items.some(i => i.gcItemId === intent.itemId)) return undefined;
  const matches = items.filter(i => !i.casketId && i.defIndex === expected.defIndex && !expected.beforeIds.includes(i.gcItemId)
    && patchLayout(i).every((kit, slot) => kit === expected.patches[slot]));
  return matches.find(i => i.gcItemId === expected.replacementId);
}
