// Dev-only live test for storage mutations against real Steam, driven from Node (missing Origin is
// allowed, so no browser/DNR needed). Exercises the REAL GCClient methods so a Node run verifies the
// exact code the extension ships, without round-tripping through the browser + a human.
//   CS2_WEB_CLIENT_LIVE=1 pnpm tsx tools/mutate-test.ts rename --token-file .local/token.json [--unit <gcItemId>] [--name <newName>]
//   CS2_WEB_CLIENT_LIVE=1 pnpm tsx tools/mutate-test.ts identity --token-file .local/token.json [--unit <gcItemId>] [--item <gcItemId>]
//     (identity: deposit -> withdraw -> rename unit and back on ONE item, recording gcItemId/steamAssetId at each step;
//      MUTATES the real account, restores state in a finally. Plan 3 Task 9 identity-stability check.)
import { requireDev } from "./auth-qr.js";
import { MutationTimeout } from "../src/gc/client.js";
import type { DomainItem } from "../src/types.js";
import { closeSession, flag, getCredentials, openSession } from "./session.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rename(argv: string[]): Promise<void> {
  const creds = await getCredentials(argv);
  const s = await openSession(creds);
  try {
    const units = s.gc.cache.rootItems().filter((i) => i.containedItemCount !== null);
    console.log(`storage units: ${units.map((u) => `${u.gcItemId}="${u.customName}"`).join(", ")}`);
    const unitId = flag(argv, "--unit") ?? units[0]?.gcItemId;
    if (!unitId) { console.log("no storage unit found"); return; }
    const original = s.gc.cache.get(unitId)?.customName ?? "";
    const newName = flag(argv, "--name") ?? `test-${Date.now() % 100000}`;

    console.log(`rename ${unitId} "${original}" -> "${newName}" via GCClient.renameItem...`);
    await s.gc.renameItem(unitId, newName, 15000);
    console.log(`  ✓ applied; customName now "${s.gc.cache.get(unitId)?.customName}"`);

    console.log(`restoring "${original}"...`);
    await s.gc.renameItem(unitId, original, 15000);
    console.log(`  ✓ restored; customName now "${s.gc.cache.get(unitId)?.customName}"`);
    console.log("RESULT: renameItem works live");
  } catch (e) {
    console.log(`RESULT: renameItem FAILED: ${(e as Error).name}: ${(e as Error).message}`);
  } finally {
    await sleep(500);
    closeSession(s);
  }
}

type Ids = { gc: string; asset: string };
const ids = (i: DomainItem): Ids => ({ gc: i.gcItemId, asset: i.steamAssetId });
const fmt = (i: Ids | null) => (i ? `gcItemId=${i.gc} steamAssetId=${i.asset}` : "MISSING");
const yn = (b: boolean) => (b ? "yes" : "no");

/** Same physical item by attributes, used only when its gcItemId changed. */
function sameItem(a: DomainItem, b: DomainItem): boolean {
  return a.defIndex === b.defIndex && a.paintIndex === b.paintIndex && a.paintSeed === b.paintSeed
    && a.paintWear === b.paintWear && a.customName === b.customName && a.isStatTrak === b.isStatTrak;
}

/** Find the item by its original gcItemId, else a not-previously-known item that matches by attributes. */
function locate(pool: DomainItem[], orig: DomainItem, known: Set<string>, label: string): { item: DomainItem | null; idChanged: boolean } {
  const byId = pool.find((i) => i.gcItemId === orig.gcItemId);
  if (byId) return { item: byId, idChanged: false };
  console.log(`  ! gcItemId ${orig.gcItemId} not found ${label}: the gcItemId CHANGED`);
  const cands = pool.filter((i) => !known.has(i.gcItemId) && sameItem(i, orig));
  for (const c of cands) console.log(`  candidate: ${fmt(ids(c))} defIndex=${c.defIndex} paint=${c.paintIndex}/${c.paintSeed}/${c.paintWear}`);
  if (cands.length !== 1) console.log(`  ${cands.length} candidates; cannot identify the moved item unambiguously`);
  return { item: cands.length === 1 ? cands[0] : null, idChanged: true };
}

async function identity(argv: string[]): Promise<void> {
  const creds = await getCredentials(argv);
  const s = await openSession(creds);
  const gc = s.gc;
  const checks: Array<[string, boolean]> = [];
  let unitId = "";
  let originalName = "";
  let renamedAway = false;
  let curItemId: string | null = null; // gcItemId of the moved item while it may sit in the unit
  let orig: DomainItem | null = null;
  let known = new Set<string>();
  const snapshot = async () => {
    const unitItems = await gc.loadCasketContents(unitId, 30000);
    return { roots: gc.cache.rootItems(), unitItems };
  };
  try {
    const roots0 = gc.cache.rootItems();
    const units = roots0.filter((i) => i.containedItemCount !== null);
    console.log(`storage units: ${units.map((u) => `${u.gcItemId}="${u.customName}" (${u.containedItemCount})`).join(", ") || "none"}`);
    const wantUnit = flag(argv, "--unit");
    const unit = wantUnit ? units.find((u) => u.gcItemId === wantUnit) : units.find((u) => (u.containedItemCount ?? 0) < 1000);
    if (!unit) { console.log(`RESULT: identity NOT RUN: no ${wantUnit ? `storage unit ${wantUnit}` : "storage unit with free space"} found`); return; }
    const wantItem = flag(argv, "--item");
    const nowSec = Date.now() / 1000;
    const item = wantItem
      ? roots0.find((i) => i.gcItemId === wantItem && i.containedItemCount === null)
      : roots0.find((i) => i.containedItemCount === null && (i.tradableAfter ?? 0) <= nowSec);
    if (!item) { console.log(`RESULT: identity NOT RUN: no ${wantItem ? `movable root item ${wantItem} (must exist and not be a unit)` : "tradable non-unit root item"} found`); return; }
    unitId = unit.gcItemId; originalName = unit.customName ?? "";
    orig = { ...item }; curItemId = item.gcItemId;
    console.log(`unit: ${unitId} "${originalName}" (${unit.containedItemCount} items)`);
    console.log(`item: ${item.gcItemId} ${item.marketHashName ?? `defIndex ${item.defIndex}`} (override with --item)`);

    console.log("baseline...");
    const base = await snapshot();
    const baseRoots = new Map(base.roots.map((i) => [i.gcItemId, i.steamAssetId]));
    const baseUnit = new Map(base.unitItems.map((i) => [i.gcItemId, i.steamAssetId]));
    known = new Set([...baseRoots.keys(), ...baseUnit.keys()]);
    const unitBase = ids(gc.cache.get(unitId)!);
    console.log(`  item before: ${fmt(ids(orig))}`);
    console.log(`  unit before: ${fmt(unitBase)} name="${originalName}"; ${baseRoots.size} root items, ${baseUnit.size} in unit`);

    // 3. deposit
    console.log("depositing...");
    try { await gc.depositItem(orig.gcItemId, unitId, 15000); console.log("  applied"); }
    catch (e) {
      console.log(`  ${(e as Error).name}: ${(e as Error).message}; re-reading unit contents instead of retrying`);
      if (!(e instanceof MutationTimeout)) throw e;
    }
    const afterDep = await snapshot();
    const dep = locate(afterDep.unitItems, orig, known, "in the unit");
    if (!dep.item) throw new Error("moved item not found in the unit after deposit; aborting the rest");
    const depIds = ids(dep.item);
    curItemId = dep.item.gcItemId;
    console.log(`  item in unit: ${fmt(depIds)}`);
    checks.push(["moved item gcItemId stable across deposit", depIds.gc === orig.gcItemId]);
    checks.push(["moved item steamAssetId stable across deposit", depIds.asset === orig.steamAssetId]);

    // 4. withdraw
    console.log("withdrawing...");
    try { await gc.withdrawItem(curItemId, unitId, 15000); console.log("  applied"); }
    catch (e) {
      console.log(`  ${(e as Error).name}: ${(e as Error).message}; re-reading state instead of retrying`);
      if (!(e instanceof MutationTimeout)) throw e;
    }
    const afterWd = await snapshot();
    const wd = locate(afterWd.roots, { ...orig, gcItemId: curItemId }, known, "in root inventory");
    if (!wd.item) throw new Error("moved item not found in root inventory after withdraw; aborting the rest");
    const wdIds = ids(wd.item);
    curItemId = null;
    console.log(`  item in root: ${fmt(wdIds)}`);
    checks.push(["moved item gcItemId stable across withdraw", wdIds.gc === depIds.gc]);
    checks.push(["moved item steamAssetId stable across withdraw", wdIds.asset === depIds.asset]);

    // 5. rename and back
    const tmp = `test-${Date.now() % 100000}`;
    const unitSteps: Array<Ids | null> = [unitBase];
    const renameTo = async (name: string) => {
      try { await gc.renameItem(unitId, name, 15000); console.log("  applied"); }
      catch (e) {
        console.log(`  ${(e as Error).name}: ${(e as Error).message}; checking cache instead of retrying`);
        if (!(e instanceof MutationTimeout) || (await gc.reconcileAfter({ kind: "rename", itemId: unitId, expectedName: name })) !== "applied") throw e;
        console.log("  reconciled: applied");
      }
      const u = gc.cache.get(unitId);
      unitSteps.push(u ? ids(u) : null);
      console.log(`  unit: ${fmt(unitSteps[unitSteps.length - 1])} name="${u?.customName}"`);
    };
    console.log(`renaming unit to "${tmp}"...`);
    renamedAway = true;
    await renameTo(tmp);
    console.log(`restoring "${originalName}"...`);
    await renameTo(originalName);
    renamedAway = false;
    checks.push(["unit ids stable across rename", unitSteps.every((u) => u !== null && u.gc === unitBase.gc && u.asset === unitBase.asset)]);

    // 6. diff
    const fin = await snapshot();
    const finAll = new Map([...fin.roots, ...fin.unitItems].map((i) => [i.gcItemId, i.steamAssetId]));
    const by: string[] = [];
    let total = 0;
    for (const [m, label] of [[baseRoots, "root"], [baseUnit, "unit"]] as const) {
      for (const [gcId, asset] of m) {
        if (gcId === orig.gcItemId || gcId === unitId) continue;
        total++;
        const now = finAll.get(gcId);
        if (now === undefined) by.push(`${label} ${gcId}: gcItemId gone`);
        else if (now !== asset) by.push(`${label} ${gcId}: steamAssetId ${asset} -> ${now}`);
      }
    }
    for (const l of by) console.log(`  changed: ${l}`);
    checks.push([`bystander items unchanged: ${total - by.length}/${total}`, by.length === 0]);

    console.log("\n--- summary ---");
    for (const [name, ok] of checks) console.log(name.startsWith("bystander") ? `${name} ${ok ? "(yes)" : "(no)"}` : `${name}: ${yn(ok)}`);
    const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
    console.log(bad.length ? `RESULT: identity CHANGED (${bad.join("; ")})` : "RESULT: identity STABLE");
  } catch (e) {
    console.log(`RESULT: identity INCONCLUSIVE: ${(e as Error).name}: ${(e as Error).message}`);
  } finally {
    // Leave the account as found. No blind retries: each cleanup is attempted once after re-reading state.
    console.log("cleanup...");
    try {
      if (curItemId && orig) {
        const inUnit = (await gc.loadCasketContents(unitId, 30000));
        const there = locate(inUnit, { ...orig, gcItemId: curItemId }, known, "in the unit (cleanup)").item;
        if (there) {
          console.log(`  item still in unit; withdrawing ${there.gcItemId}`);
          try { await gc.withdrawItem(there.gcItemId, unitId, 15000); console.log("  cleanup withdraw: applied"); }
          catch (e) { console.log(`  cleanup withdraw: ${(e as Error).name}: ${(e as Error).message}; state NOT retried, verify manually`); }
        } else console.log("  item not in unit; nothing to withdraw");
      }
    } catch (e) { console.log(`  cleanup withdraw check failed: ${(e as Error).message}`); }
    try {
      const now = unitId ? gc.cache.get(unitId)?.customName : undefined;
      if (unitId && (renamedAway || now !== originalName) && now !== undefined) {
        if (now === originalName) console.log("  unit name already original");
        else {
          console.log(`  unit name is "${now}"; restoring "${originalName}"`);
          try { await gc.renameItem(unitId, originalName, 15000); console.log("  cleanup rename: applied"); }
          catch (e) { console.log(`  cleanup rename: ${(e as Error).name}: ${(e as Error).message}; state NOT retried, verify manually`); }
        }
      }
    } catch (e) { console.log(`  cleanup rename check failed: ${(e as Error).message}`); }
    await sleep(500);
    closeSession(s);
  }
}

async function churn(argv: string[]): Promise<void> {
  const creds = await getCredentials(argv);
  const n = Number(flag(argv, "--n") ?? 5);
  const gap = Number(flag(argv, "--gap") ?? 500);
  console.log(`rapid reconnect x${n}, gap ${gap}ms`);
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    try {
      const s = await openSession(creds);
      console.log(`#${i}: logon OK (${Date.now() - t0}ms)`);
      closeSession(s);
    } catch (e) {
      const err = e as { name?: string; eresult?: number; message?: string };
      console.log(`#${i}: FAILED name=${err.name} eresult=${err.eresult} msg=${JSON.stringify(err.message)} (${Date.now() - t0}ms)`);
    }
    if (i < n - 1) await sleep(gap);
  }
}

async function main(): Promise<void> {
  requireDev();
  const [cmd, ...argv] = process.argv.slice(2);
  if (cmd === "rename") await rename(argv);
  else if (cmd === "identity") await identity(argv);
  else if (cmd === "churn") await churn(argv);
  else { console.error("usage: mutate-test.ts <rename|identity|churn> --token-file .local/token.json [--unit id] [--item id] [--name n] [--n 5] [--gap 500]"); process.exit(2); }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
