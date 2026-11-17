// Dev-only live harness: `CS2_WEB_CLIENT_LIVE=1 pnpm tsx tools/harness.ts <login|smoke|identity|matrix|persona>`.
import { buildSnapshot, type AccountSnapshot } from "../src/snapshot.js";
import { requireDev } from "./auth-qr.js";
import { qrLogin } from "./auth-qr.js";
import { closeSession, flag, getCredentials, openSession, pickCmUrl } from "./session.js";
import { CMClient, CMConnection } from "../src/cm/client.js";
import { NodeWsTransport } from "../src/transport-node.js";

const MATRIX = [
  "Already playing CS2 on this account",
  "Playing another Steam game",
  "Launch CS2 mid-acquisition",
  "Steam client offline",
  "Steam client online on the same machine",
  "Another PC gaming on the account",
];

async function snapshot(argv: string[], creds?: Awaited<ReturnType<typeof getCredentials>>) {
  const c = creds ?? (await getCredentials(argv));
  const s = await openSession(c);
  try {
    return { creds: c, snap: await buildSnapshot(s.gc, { steamId: c.steamId, loadTimeoutMs: 20000 }), roots: s.gc.cache.rootItems() };
  } finally {
    closeSession(s);
  }
}

async function smoke(argv: string[]): Promise<void> {
  const { snap, roots } = await snapshot(argv);
  const units = roots.filter((i) => i.containedItemCount !== null);
  console.log(`root items: ${roots.length}`);
  console.log(`storage units: ${units.length}  complete: ${snap.complete}`);
  for (const u of units) {
    const n = snap.items.filter((i) => i.casketId === u.gcItemId).length;
    console.log(`unit ${u.gcItemId} "${u.customName}": ${n}/${u.containedItemCount} items`);
  }
  const skins = roots.filter((i) => i.paintWear !== null).slice(0, 5);
  console.log("sample root skins (def / paint / seed / float):");
  for (const i of skins) console.log(`  ${i.defIndex} / ${i.paintIndex} / ${i.paintSeed} / ${i.paintWear}`);
}

function idMap(s: AccountSnapshot): Map<string, string> {
  return new Map(s.items.map((i) => [i.gcItemId, i.steamAssetId]));
}

async function identity(argv: string[]): Promise<void> {
  const first = await snapshot(argv);
  console.log("reconnecting for a second read...");
  const second = await snapshot(argv, first.creds);
  const a = idMap(first.snap);
  const b = idMap(second.snap);
  let missing = 0, changed = 0;
  for (const [gc, asset] of a) {
    if (!b.has(gc)) missing++;
    else if (b.get(gc) !== asset) changed++;
  }
  const sameAsGc = [...a].filter(([gc, asset]) => gc === asset).length;
  console.log(`read1 items: ${a.size}, read2 items: ${b.size}`);
  console.log(`gcItemId missing in read2: ${missing}; steamAssetId changed for same gcItemId: ${changed}`);
  console.log(`steamAssetId == gcItemId for ${sameAsGc}/${a.size} items`);
  console.log(missing === 0 && changed === 0 ? "IDENTITY STABLE across re-read" : "IDENTITY NOT STABLE: investigate");
}

/** Read-only: CM logon only (no CS2 claim, no GC, no item ops), print the captured persona name, close. Never prints a token. */
async function persona(argv: string[]): Promise<void> {
  const creds = await getCredentials(argv);
  const conn = new CMConnection(new NodeWsTransport(await pickCmUrl(), { Origin: "https://steamcommunity.com" }));
  await conn.open();
  const cm = new CMClient(conn);
  try {
    await cm.logon(creds);
    const deadline = Date.now() + 10000;
    while (cm.personaName === null && !conn.isClosed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    console.log(`SteamID: ${creds.steamId}`);
    if (cm.personaName === null) console.log("persona name: not received within 10 s of logon (EMsg 768)");
    else console.log(`persona name: ${JSON.stringify(cm.personaName)} (differs from login name: ${cm.personaName !== creds.accountName ? "yes" : "no"})`);
  } finally {
    conn.close();
  }
}

function matrix(): void {
  console.log("Section 9 gameplay matrix (fill in the observed result for each):\n");
  for (const row of MATRIX) {
    console.log(`  [ ] ${row}`);
    console.log("      logon result: ________  GC welcome: ________  kicked/blocked: ________\n");
  }
}

async function main(): Promise<void> {
  const [cmd, ...argv] = process.argv.slice(2);
  if (!["login", "smoke", "identity", "matrix", "persona"].includes(cmd ?? "")) {
    console.error("usage: harness.ts <login|smoke|identity|matrix|persona> [--save-token .local/token.json] [--token-file .local/token.json]");
    process.exit(2);
  }
  requireDev();
  if (cmd === "login") {
    const r = await qrLogin({ saveTokenPath: flag(argv, "--save-token") });
    console.log(`SteamID: ${r.steamId} (${r.accountName})`);
    console.log("refresh token obtained (direct CM logon)");
  } else if (cmd === "smoke") await smoke(argv);
  else if (cmd === "identity") await identity(argv);
  else if (cmd === "persona") await persona(argv);
  else matrix();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
