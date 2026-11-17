// Sign in with a QR code, then print the inventory with storage unit contents. Run: pnpm tsx examples/node-inventory.ts
import { beginQr, pollQr, getServerList, openFirstReachable, CMConnection, CMClient, GCClient, buildSnapshot, fetchClientVersion, type QrResult } from "cs2-web-client";
import { NodeWsTransport } from "cs2-web-client/transport-node";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Show challengeUrl as a QR code and approve it in the Steam Mobile app. The code rotates: show each new one.
let challenge = await beginQr(fetch, "my-app");
console.log(challenge.challengeUrl);
let login: QrResult | undefined;
while (!login) {
  await sleep(challenge.interval * 1000);
  const poll = await pollQr(challenge);
  if (poll.status === "done") login = poll.result;
  if (poll.status === "refresh") { challenge = poll.challenge; console.log(challenge.challengeUrl); }
}
// login.refreshToken signs in again without a QR code until it expires. Keep it secret.

const servers = await getServerList({ fetch, storage: { get: async () => ({}), set: async () => {} }, now: Date.now, wait: sleep });
const conn = await openFirstReachable(servers, (url) => new CMConnection(new NodeWsTransport(url)), () => false);
const cm = new CMClient(conn);
const gc = new GCClient(cm, { clientVersion: await fetchClientVersion() });
try {
  await cm.logon({ steamId: BigInt(login.steamId), accountName: login.accountName, refreshToken: login.refreshToken });
  await cm.assertNotPlaying(3000); // AccountBusyError while CS2 is open on this account
  await cm.claimCs2(1000);
  await gc.waitForWelcome(20000);
  const snapshot = await buildSnapshot(gc, { steamId: BigInt(login.steamId), loadTimeoutMs: 10000 });
  console.log(`${snapshot.items.length} items, complete: ${snapshot.complete}`);
} finally {
  cm.releaseGames();
  conn.close();
}
