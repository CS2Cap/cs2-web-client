import { describe, it, expect } from "vitest";
import { fromBinary } from "@bufbuild/protobuf";
import { CMClient, AccountBusyError } from "../src/cm/client.js";
import { CMConnection } from "../src/cm/connection.js";
import { EMsg } from "../src/frames.js";
import { CMsgClientGamesPlayedSchema } from "../src/gen/steam/steammessages_clientserver_pb.js";
import { CMsgClientChangeStatusSchema } from "../src/gen/steam/steammessages_clientserver_friends_pb.js";
import { FakeCM } from "../src/testing/fake-cm.js";

async function setup(opts: Parameters<typeof FakeCM.start>[0]) {
  const fake = await FakeCM.start(opts);
  const conn = new CMConnection(fake.transport());
  await conn.open();
  const client = new CMClient(conn);
  await client.logon({ steamId: 76561198000000000n, accountName: "a", refreshToken: "t" });
  return { fake, conn, client };
}

describe("CMClient session lifecycle", () => {
  it("ends the session when Steam sends LoggedOff without closing the socket", async () => {
    const { fake, conn, client } = await setup({ logonResult: 1 });
    let kicked = 0;
    client.onKicked(() => kicked++);
    fake.loggedOff(6);
    await new Promise(r => setTimeout(r, 10));
    try { expect(kicked).toBe(1); }
    finally { conn.close(); await fake.stop(); }
  });
  it("assertNotPlaying rejects with AccountBusyError when blocked", async () => {
    const { fake, conn, client } = await setup({ logonResult: 1, sessionId: 1, playingBlocked: true });
    await expect(client.assertNotPlaying(2000)).rejects.toBeInstanceOf(AccountBusyError);
    conn.close(); await fake.stop();
  });

  it("onPlayingBlocked reports a block and stops after unsubscribing", async () => {
    const fake = await FakeCM.start({ logonResult: 1, sessionId: 1, playingBlocked: true });
    const conn = new CMConnection(fake.transport());
    await conn.open();
    const client = new CMClient(conn);
    let blocked = 0;
    const stop = client.onPlayingBlocked(() => blocked++);
    await client.logon({ steamId: 76561198000000000n, accountName: "a", refreshToken: "t" });
    await new Promise((r) => setTimeout(r, 10));
    expect(blocked).toBe(1);
    stop();
    fake.playingState(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(blocked).toBe(1);
    conn.close(); await fake.stop();
  });

  it("assertNotPlaying resolves when not blocked (timeout is not an error)", async () => {
    const { fake, conn, client } = await setup({ logonResult: 1, sessionId: 1, playingBlocked: false });
    await expect(client.assertNotPlaying(300)).resolves.toBeUndefined();
    conn.close(); await fake.stop();
  });

  it("claimCs2 resolves once Steam answers the claim", async () => {
    const { fake, conn, client } = await setup({ logonResult: 1, sessionId: 1 });
    const t0 = Date.now();
    await expect(client.claimCs2(5000)).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1000);
    conn.close(); await fake.stop();
  });

  it("claimCs2 rejects with AccountBusyError when Steam answers with a block", async () => {
    const { fake, conn, client } = await setup({ logonResult: 1, sessionId: 1, playingBlocked: true });
    await expect(client.claimCs2(5000)).rejects.toBeInstanceOf(AccountBusyError);
    conn.close(); await fake.stop();
  });

  it("claimCs2 goes ahead when Steam stays silent past the wait", async () => {
    const { fake, conn, client } = await setup({ logonResult: 1, sessionId: 1, answerClaim: false });
    await expect(client.claimCs2(30)).resolves.toBeUndefined();
    conn.close(); await fake.stop();
  });

  it("claimCs2 / releaseGames send ClientGamesPlayed", async () => {
    const { fake, conn, client } = await setup({ logonResult: 1, sessionId: 1 });
    await client.claimCs2(1000);
    client.releaseGames();
    const sent = fake.receivedDecoded().filter((f) => f.emsg === EMsg.ClientGamesPlayed)
      .map((f) => fromBinary(CMsgClientGamesPlayedSchema, f.body));
    expect(sent).toHaveLength(2);
    expect(sent[0].gamesPlayed.map((g) => g.gameId)).toEqual([730n]);
    expect(sent[1].gamesPlayed).toEqual([]);
    conn.close(); await fake.stop();
  });

  it("onKicked fires when the connection closes", async () => {
    const { fake, conn, client } = await setup({ logonResult: 1, sessionId: 1 });
    let kicked = 0;
    client.onKicked(() => kicked++);
    conn.close();
    expect(kicked).toBe(1);
    await fake.stop();
  });

  it("setPersonaInvisible sends ClientChangeStatus with persona state 7", async () => {
    const { fake, client } = await setup({ logonResult: 1, sessionId: 1 });
    client.setPersonaInvisible();
    await new Promise((r) => setTimeout(r, 10));
    const sent = fake.receivedDecoded().find((f) => f.emsg === EMsg.ClientChangeStatus);
    expect(sent).toBeDefined();
    expect(fromBinary(CMsgClientChangeStatusSchema, sent!.body).personaState).toBe(7);
    await fake.stop();
  });
});
