import { describe, it, expect, vi } from "vitest";
import { beginQr, pollQr, steamIdFromJwt } from "../src/qr-auth.js";

function jwt(sub: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ typ: "JWT" })}.${b64({ iss: "steam", sub })}.sig`;
}
const json = (body: object) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);

describe("qr-auth", () => {
  it("parses a QR challenge from BeginAuthSessionViaQR", async () => {
    const f = vi.fn().mockReturnValue(json({ response: { client_id: "C", request_id: "R", challenge_url: "https://s.team/q/1/9", interval: 5 } }));
    const ch = await beginQr(f as unknown as typeof fetch);
    expect(ch).toMatchObject({ clientId: "C", requestId: "R", challengeUrl: "https://s.team/q/1/9", interval: 5 });
    const [, init] = f.mock.calls[0];
    expect(String((init as RequestInit).body)).toContain("platform_type=1");
  });
  it("derives the SteamID from the refresh-token JWT sub", () => {
    expect(steamIdFromJwt(jwt("76561198000000042"))).toBe("76561198000000042");
  });
  it("returns pending, then done once the refresh token arrives", async () => {
    const ch = { clientId: "C", requestId: "R", challengeUrl: "u", interval: 2 };
    const pending = vi.fn().mockReturnValue(json({ response: {} }));
    expect(await pollQr(ch, pending as unknown as typeof fetch)).toEqual({ status: "pending" });
    const done = vi.fn().mockReturnValue(json({ response: { refresh_token: jwt("76561198000000042"), account_name: "fixture-login" } }));
    expect(await pollQr(ch, done as unknown as typeof fetch))
      .toMatchObject({ status: "done", result: { steamId: "76561198000000042", accountName: "fixture-login" } });
  });
  it("returns refresh with the rotated challenge", async () => {
    const ch = { clientId: "C", requestId: "R", challengeUrl: "u", interval: 2 };
    const f = vi.fn().mockReturnValue(json({ response: { new_client_id: "C2", new_challenge_url: "https://s.team/q/1/10" } }));
    expect(await pollQr(ch, f as unknown as typeof fetch)).toEqual({
      status: "refresh",
      challenge: { clientId: "C2", requestId: "R", challengeUrl: "https://s.team/q/1/10", interval: 2 },
    });
  });
});
