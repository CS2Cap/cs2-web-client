// Dev-only shared session plumbing for harness.ts and record-fixtures.ts.
import { readFileSync } from "node:fs";
import { CMClient, CMConnection } from "../src/cm/client.js";
import { NodeWsTransport } from "../src/transport-node.js";
import { GCClient } from "../src/gc/client.js";
import { assertGitignoredPath, qrLogin, requireDev, type QrLogin } from "./auth-qr.js";

export function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Credentials from --token-file (gitignored .local/) or an interactive QR login. */
export async function getCredentials(argv: string[]): Promise<QrLogin> {
  requireDev();
  const tokenFile = flag(argv, "--token-file");
  if (tokenFile) {
    const j = JSON.parse(readFileSync(assertGitignoredPath(tokenFile), "utf8"));
    return { steamId: BigInt(j.steamId), accountName: j.accountName, refreshToken: j.refreshToken };
  }
  return qrLogin({ saveTokenPath: flag(argv, "--save-token") });
}

export async function pickCmUrl(): Promise<string> {
  const res = await fetch("https://api.steampowered.com/ISteamDirectory/GetCMListForConnect/v1/?cellid=0");
  if (!res.ok) throw new Error(`GetCMListForConnect HTTP ${res.status}`);
  const json = (await res.json()) as { response?: { serverlist?: Array<{ endpoint: string; type: string }> } };
  const ws = (json.response?.serverlist ?? []).filter((s) => s.type === "websockets");
  if (!ws.length) throw new Error("no websocket CM endpoints returned");
  return `wss://${ws[Math.floor(Math.random() * ws.length)].endpoint}/cmsocket/`;
}

export interface LiveSession { conn: CMConnection; cm: CMClient; gc: GCClient; creds: QrLogin }

/** Logon, claim CS2 and wait for the GC welcome. `beforeWelcome` runs after the GC handler is armed (for taps). */
export async function openSession(creds: QrLogin, beforeWelcome?: (s: LiveSession) => void): Promise<LiveSession> {
  requireDev();
  const url = await pickCmUrl();
  console.log(`connecting ${url}`);
  const conn = new CMConnection(new NodeWsTransport(url, { Origin: "https://steamcommunity.com" }));
  await conn.open();
  const cm = new CMClient(conn);
  const gc = new GCClient(cm);
  const session = { conn, cm, gc, creds };
  beforeWelcome?.(session);
  await cm.logon(creds);
  await cm.assertNotPlaying(3000);
  await cm.claimCs2(1000);
  await gc.waitForWelcome(20000);
  return session;
}

export function closeSession(s: LiveSession): void {
  try { s.cm.releaseGames(); } catch { /* socket may already be gone */ }
  s.conn.close();
}
