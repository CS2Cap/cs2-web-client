import { describe, it, expect } from "vitest";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { GCClient } from "../src/gc/client.js";
import { wrapClientToGC, parseClientFromGC } from "../src/gc/envelope.js";
import {
  CMsgGCCStrike15_v2_MatchListRequestTournamentGamesSchema,
  CMsgGCCStrike15_v2_MatchListSchema,
  CMsgGCCStrike15_v2_PredictionsSchema,
} from "../src/gen/csgo/cstrike15_gcmessages_pb.js";
import type { CMClient } from "../src/cm/client.js";
import { readBracket, readPicks, savePicks } from "../src/gc/pickem.js";

function offlineGc() {
  const handlers: Array<(b: Uint8Array) => void> = [];
  const sent: Array<{ type: number; body: Uint8Array }> = [];
  const fakeCm = { connection: {
    addHandler: (_e: number, cb: (b: Uint8Array) => void) => { handlers.push(cb); return () => {}; },
    get isClosed() { return false; },
    sendMessage: (_e: number, b: Uint8Array) => { const m = parseClientFromGC(b); sent.push({ type: m.gcMsgType, body: m.body }); },
  } };
  const gc = new GCClient(fakeCm as unknown as CMClient);
  const feed = (t: number, b: Uint8Array) => handlers.forEach((h) => h(wrapClientToGC(t, b)));
  return { gc, feed, sent };
}

const matchList = (eventId: number) => toBinary(CMsgGCCStrike15_v2_MatchListSchema, create(CMsgGCCStrike15_v2_MatchListSchema, {
  msgrequestid: 9146,
  tournamentinfo: {
    tournamentEvent: { eventId, activeSectionId: 111 },
    sections: [
      { sectionid: 111, name: "Stage I", groups: [{ groupid: 281, name: "Stage I", desc: "Stage I", picks: Array.from({ length: 10 }, () => ({})), picklockuntiltime: 1795878000, pointsPerPick: 1, teams: [{ teamId: 1 }, { teamId: 153 }] }] },
      { sectionid: 114, name: "Quarterfinals", groups: [{ groupid: 284, name: "Quarterfinal", desc: "Match 1", picks: [{}], picklockuntiltime: 1797174000, pointsPerPick: 12, teams: [{ teamId: 0 }, { teamId: 0 }] }] },
    ],
    tournamentTeams: [{ teamId: 1, teamTag: "NiP", teamName: "Ninjas in Pyjamas" }],
  },
}));
const predictions = (eventId: number, picks: Array<[number, number, number]>) => toBinary(CMsgGCCStrike15_v2_PredictionsSchema, create(CMsgGCCStrike15_v2_PredictionsSchema, {
  eventId, groupMatchTeamPicks: picks.map(([groupid, index, teamid]) => ({ groupid, index, teamid })),
}));

describe("readBracket", () => {
  it("asks for the event's games and reads its groups and teams (shape live 2026-11-18)", async () => {
    const { gc, feed, sent } = offlineGc();
    const p = readBracket(gc, 27, 2000);
    expect(sent[0].type).toBe(9146);
    expect(fromBinary(CMsgGCCStrike15_v2_MatchListRequestTournamentGamesSchema, sent[0].body).eventid).toBe(27);
    feed(9139, matchList(26));
    feed(9139, matchList(27));
    expect(await p).toEqual({
      activeSectionId: 111,
      groups: [
        { sectionId: 111, groupId: 281, name: "Stage I", desc: "Stage I", slots: 10, lockTime: 1795878000, pointsPerPick: 1, teamIds: [1, 153] },
        { sectionId: 114, groupId: 284, name: "Quarterfinal", desc: "Match 1", slots: 1, lockTime: 1797174000, pointsPerPick: 12, teamIds: [0, 0] },
      ],
      teams: [{ teamId: 1, tag: "NiP", name: "Ninjas in Pyjamas" }],
    });
  });

  it("times out when the bracket never comes", async () => {
    const { gc } = offlineGc();
    await expect(readBracket(gc, 27, 20)).rejects.toThrow("timeout waiting for the Pick'Em bracket");
  });
});

describe("readPicks", () => {
  it("asks with the event alone and reads the saved picks", async () => {
    const { gc, feed, sent } = offlineGc();
    const p = readPicks(gc, 27, 2000);
    expect(sent[0].type).toBe(9160);
    const m = fromBinary(CMsgGCCStrike15_v2_PredictionsSchema, sent[0].body);
    expect([m.eventId, m.groupMatchTeamPicks.length]).toEqual([27, 0]);
    feed(9160, predictions(27, [[281, 0, 153], [281, 1, 1]]));
    expect(await p).toEqual([{ groupId: 281, index: 0, teamId: 153 }, { groupId: 281, index: 1, teamId: 1 }]);
  });
});

describe("savePicks", () => {
  it("uploads each slot named by the faux id of the team's first sticker and resolves with Steam's echo (live 2026-11-18)", async () => {
    const { gc, feed, sent } = offlineGc();
    const p = savePicks(gc, 27, [
      { sectionId: 111, groupId: 281, index: 0, teamId: 153, stickerId: 11878 },
      { sectionId: 111, groupId: 281, index: 1, teamId: 1, stickerId: 11870 },
    ], 2000);
    expect(sent[0].type).toBe(9161);
    const m = fromBinary(CMsgGCCStrike15_v2_PredictionsSchema, sent[0].body);
    expect(m.eventId).toBe(27);
    expect(m.groupMatchTeamPicks.map((x) => [x.sectionid, x.groupid, x.index, x.teamid, x.itemid])).toEqual([
      [111, 281, 0, 153, 17293822569881142457n],
      [111, 281, 1, 1, 17293822569880618169n],
    ]);
    feed(9161, predictions(27, [[281, 0, 153], [281, 1, 1]]));
    expect(await p).toEqual([{ groupId: 281, index: 0, teamId: 153 }, { groupId: 281, index: 1, teamId: 1 }]);
  });
});
