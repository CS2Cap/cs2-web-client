import { describe, it, expect, vi } from "vitest";
import { fetchClientVersion, readClientVersion, FALLBACK_CS2_VERSION } from "../src/client-version.js";

describe("client-version", () => {
  it("parses ClientVersion from steam.inf", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("ClientVersion=2000925\nServerVersion=2000925\n") } as Response);
    expect(await fetchClientVersion(f as unknown as typeof fetch)).toBe(2000925);
  });
  it("falls back when the fetch fails", async () => {
    const f = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await fetchClientVersion(f as unknown as typeof fetch)).toBe(FALLBACK_CS2_VERSION);
  });
  it("throws from the strict read when steam.inf has no version", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("ServerVersion=1\n") } as Response);
    await expect(readClientVersion(f as unknown as typeof fetch)).rejects.toThrow("invalid client version");
  });
});
