import { describe, expect, it } from "vitest";
import { openFirstReachable } from "../src/cm/open-first.js";

function conn(url: string, ok: boolean, log: string[]) {
  return {
    url,
    open: async () => { log.push(`open ${url}`); if (!ok) throw new Error(`down ${url}`); },
    close: () => { log.push(`close ${url}`); },
  };
}

describe("openFirstReachable", () => {
  it("moves on to the next server when one does not answer", async () => {
    const log: string[] = [];
    const c = await openFirstReachable(["a", "b", "c"], (u) => conn(u, u === "b", log), () => false);
    expect(c.url).toBe("b");
    expect(log).toEqual(["open a", "close a", "open b"]);
  });

  it("tries at most three servers and reports the last failure", async () => {
    const log: string[] = [];
    await expect(openFirstReachable(["a", "b", "c", "d"], (u) => conn(u, false, log), () => false)).rejects.toThrow("down c");
    expect(log.filter((l) => l.startsWith("open"))).toEqual(["open a", "open b", "open c"]);
  });

  it("stops at once when the caller cancelled", async () => {
    const log: string[] = [];
    await expect(openFirstReachable(["a", "b"], (u) => conn(u, false, log), () => true)).rejects.toThrow("down a");
    expect(log).toEqual(["open a", "close a"]);
  });

  it("fails with no servers", async () => {
    await expect(openFirstReachable([], () => conn("x", true, []), () => false)).rejects.toThrow("no Steam server");
  });
});
