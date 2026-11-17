import { readFileSync, writeFileSync } from "node:fs";

// Per item definition, resolved through its prefab chain as the game does:
// untradable-defs.json: "cannot trade" 1 (coins, pins, trophies, Valve weapons), which the GC item itself does not carry.
// sticker-defs.json: the can_sticker and can_patch capabilities (guns, the C4, agents); Pick'em coins also fill sticker slots, with the team picked.
// Usage: tsx tools/gen-item-defs.ts [path to CS2-APY static/items_game.json]
type Def = { prefab?: string; attributes?: Record<string, unknown>; capabilities?: Record<string, string> };
const src = process.argv[2] ?? "../CS2-APY/static/items_game.json";
const raw = JSON.parse(readFileSync(src, "utf8"));
const game = (raw.items_game ?? raw) as { items: Record<string, Def>; prefabs: Record<string, Def> };

const resolved = (d: Def, key: "attributes" | "capabilities"): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const p of (d.prefab ?? "").split(/\s+/)) if (game.prefabs[p]) Object.assign(out, resolved(game.prefabs[p], key));
  return Object.assign(out, d[key] ?? {});
};

const defs = (keep: (d: Def) => boolean) =>
  Object.entries(game.items).filter(([k, d]) => /^\d+$/.test(k) && keep(d)).map(([k]) => Number(k)).sort((a, b) => a - b);

const untradable = defs((d) => String(resolved(d, "attributes")["cannot trade"] ?? "0") === "1");
const stickers = defs((d) => { const c = resolved(d, "capabilities"); return c.can_sticker === "1" || c.can_patch === "1"; });
writeFileSync("src/items/untradable-defs.json", JSON.stringify(untradable) + "\n");
writeFileSync("src/items/sticker-defs.json", JSON.stringify(stickers) + "\n");
console.log(`${untradable.length} untradable, ${stickers.length} take stickers or patches`);
