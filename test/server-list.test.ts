import { describe, it, expect, vi } from "vitest";
import { getServerList, type ServerListDeps } from "../src/server-list.js";

const LIST = { response: { serverlist: [{ endpoint: "cm1:443", type: "websockets" }, { endpoint: "cm2:27017", type: "netfilter" }] } };
const ok = () => ({ ok: true, json: async () => LIST }) as unknown as Response;

function deps(fetchImpl: ReturnType<typeof vi.fn>, stored: Record<string, unknown> = {}): ServerListDeps & { saved: Record<string, unknown> } {
  const saved: Record<string, unknown> = { ...stored };
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    storage: { get: async (k) => ({ [k]: saved[k] }), set: async (items) => { Object.assign(saved, items); } },
    now: () => 1_000_000_000,
    wait: async () => {},
    saved,
  };
}

describe("getServerList", () => {
  it("keeps the websocket servers and remembers them", async () => {
    const d = deps(vi.fn().mockResolvedValue(ok()));
    expect(await getServerList(d)).toEqual(["wss://cm1:443/cmsocket/"]);
    expect(d.saved.cm_server_list).toEqual({ urls: ["wss://cm1:443/cmsocket/"], fetchedAt: 1_000_000_000 });
  });

  it("retries a failed fetch before giving up on Steam", async () => {
    const f = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(ok());
    expect(await getServerList(deps(f))).toEqual(["wss://cm1:443/cmsocket/"]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("falls back to the last good list when Steam keeps failing", async () => {
    const f = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const d = deps(f, { cm_server_list: { urls: ["wss://old:443/cmsocket/"], fetchedAt: 1_000_000_000 - 3600_000 } });
    expect(await getServerList(d)).toEqual(["wss://old:443/cmsocket/"]);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("says the server list was the problem when there is no usable fallback", async () => {
    const stale = { cm_server_list: { urls: ["wss://old:443/cmsocket/"], fetchedAt: 0 } };
    await expect(getServerList(deps(vi.fn().mockRejectedValue(new TypeError("Failed to fetch")), stale))).rejects.toThrow(
      "Steam server list unavailable (Failed to fetch)",
    );
  });
});
