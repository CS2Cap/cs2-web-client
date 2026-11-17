import { describe, it, expect } from "vitest";
import { fromBinary } from "@bufbuild/protobuf";
import { CMClient, SteamLogonError } from "../src/cm/client.js";
import { CMConnection } from "../src/cm/connection.js";
import { EMsg } from "../src/frames.js";
import { CMsgClientLogonSchema } from "../src/gen/steam/steammessages_clientserver_login_pb.js";
import { FakeCM } from "../src/testing/fake-cm.js";

const STEAM_ID = 76561198000000000n;

describe("CMClient.logon", () => {
  it("logs on, captures session id, and sends a well-formed logon", async () => {
    const fake = await FakeCM.start({ logonResult: 1, sessionId: 42, heartbeat: 9 });
    const conn = new CMConnection(fake.transport());
    await conn.open();
    const client = new CMClient(conn);
    await client.logon({ steamId: STEAM_ID, accountName: "acct", refreshToken: "tok" });
    expect(client.sessionId).toBe(42);
    expect(client.steamId).toBe(STEAM_ID);
    const sent = fake.receivedDecoded().find((f) => f.emsg === EMsg.ClientLogon);
    expect(sent).toBeDefined();
    const m = fromBinary(CMsgClientLogonSchema, sent!.body);
    expect(m.accountName).toBe("acct");
    expect(m.accessToken).toBe("tok");
    expect(m.protocolVersion).toBe(65580);
    conn.close();
    await fake.stop();
  });

  it("captures the persona name Steam sends after logon, and its updates", async () => {
    const fake = await FakeCM.start({ logonResult: 1, personaName: "Persona One" });
    const conn = new CMConnection(fake.transport());
    await conn.open();
    const client = new CMClient(conn);
    expect(client.personaName).toBeNull();
    await client.logon({ steamId: STEAM_ID, accountName: "login_name", refreshToken: "tok" });
    await new Promise((r) => setTimeout(r, 0));
    expect(client.personaName).toBe("Persona One");
    fake.accountInfo("Persona Two");
    await new Promise((r) => setTimeout(r, 0));
    expect(client.personaName).toBe("Persona Two");
    fake.accountInfo(""); // an empty name never replaces a known one
    await new Promise((r) => setTimeout(r, 0));
    expect(client.personaName).toBe("Persona Two");
    conn.close();
    await fake.stop();
  });

  it("logs on without waiting for account info when Steam never sends it", async () => {
    const fake = await FakeCM.start({ logonResult: 1 });
    const conn = new CMConnection(fake.transport());
    await conn.open();
    const client = new CMClient(conn);
    await client.logon({ steamId: STEAM_ID, accountName: "a", refreshToken: "t" });
    expect(client.personaName).toBeNull();
    conn.close();
    await fake.stop();
  });

  it("rejects with SteamLogonError on non-OK eresult", async () => {
    const fake = await FakeCM.start({ logonResult: 5 });
    const conn = new CMConnection(fake.transport());
    await conn.open();
    const client = new CMClient(conn);
    await expect(client.logon({ steamId: STEAM_ID, accountName: "a", refreshToken: "t" }))
      .rejects.toMatchObject({ eresult: 5 });
    await expect(client.logon({ steamId: STEAM_ID, accountName: "a", refreshToken: "t" }))
      .rejects.toBeInstanceOf(SteamLogonError);
    conn.close();
    await fake.stop();
  });
});

describe("CMClient.logOff", () => {
  it("sends ClientLogOff, which ends the login the session logged on with", async () => {
    const fake = await FakeCM.start({ logonResult: 1 });
    const conn = new CMConnection(fake.transport());
    await conn.open();
    const client = new CMClient(conn);
    await client.logon({ steamId: STEAM_ID, accountName: "acct", refreshToken: "tok" });
    client.logOff();
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.receivedDecoded().some((f) => f.emsg === 706 /* k_EMsgClientLogOff */)).toBe(true);
    conn.close();
    await fake.stop();
  });
});
