import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import {
  CMsgGCCStrike15_v2_MatchListRequestTournamentGamesSchema,
  CMsgGCCStrike15_v2_MatchListSchema,
  CMsgGCCStrike15_v2_PredictionsSchema,
} from "../gen/csgo/cstrike15_gcmessages_pb.js";
import type { GCClient } from "./client.js";

const MATCH_LIST = 9139;
const REQUEST_TOURNAMENT_GAMES = 9146;
const REQUEST_PREDICTIONS = 9160;
const UPLOAD_PREDICTIONS = 9161;
const STICKER_DEF = 1209n;

/** One Pick'Em group: a Swiss stage (10 slots: 0-1 go 3:0, 2-7 advance, 8-9 go 0:3) or a playoff match (1 slot). Unknown teams are 0. */
export interface PickGroup { sectionId: number; groupId: number; name: string; desc: string; slots: number; lockTime: number; pointsPerPick: number; teamIds: number[] }
export interface PickBracket { activeSectionId: number; groups: PickGroup[]; teams: Array<{ teamId: number; tag: string; name: string }> }
/** A saved pick: the team picked for one slot of a group. */
export interface TeamPick { groupId: number; index: number; teamId: number }
/** `stickerId` is the team's first sticker of the event (no player), which CS2 names the pick by. */
export interface TeamPickUpload extends TeamPick { sectionId: number; stickerId: number }

function request<T>(gc: GCClient, replyType: number, timeoutMs: number, what: string, match: (body: Uint8Array) => T | undefined, send: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`timeout waiting for ${what}`)); }, timeoutMs);
    const off = gc.onGcMessage((type, body) => {
      if (type !== replyType) return;
      const r = match(body);
      if (r === undefined) return;
      clearTimeout(timer);
      off();
      resolve(r);
    });
    send();
  });
}

const picksOf = (body: Uint8Array, eventId: number): TeamPick[] | undefined => {
  const m = fromBinary(CMsgGCCStrike15_v2_PredictionsSchema, body);
  return m.eventId === eventId ? m.groupMatchTeamPicks.map((p) => ({ groupId: p.groupid, index: p.index, teamId: p.teamid })) : undefined;
};

/** Reads a Major's Pick'Em bracket, as CS2's MatchListAPI does (9146 → 9139). */
export function readBracket(gc: GCClient, eventId: number, timeoutMs: number): Promise<PickBracket> {
  return request(gc, MATCH_LIST, timeoutMs, "the Pick'Em bracket", (body) => {
    const t = fromBinary(CMsgGCCStrike15_v2_MatchListSchema, body).tournamentinfo;
    if (t?.tournamentEvent?.eventId !== eventId) return undefined;
    return {
      activeSectionId: t.tournamentEvent.activeSectionId,
      groups: t.sections.flatMap((s) => s.groups.map((g) => ({
        sectionId: s.sectionid, groupId: g.groupid, name: g.name, desc: g.desc, slots: g.picks.length,
        lockTime: g.picklockuntiltime, pointsPerPick: g.pointsPerPick, teamIds: g.teams.map((x) => x.teamId),
      }))),
      teams: t.tournamentTeams.map((x) => ({ teamId: x.teamId, tag: x.teamTag, name: x.teamName })),
    };
  }, () => gc.sendRaw(REQUEST_TOURNAMENT_GAMES, toBinary(CMsgGCCStrike15_v2_MatchListRequestTournamentGamesSchema, create(CMsgGCCStrike15_v2_MatchListRequestTournamentGamesSchema, { eventid: eventId })), { proto: true }));
}

/** Reads the account's saved picks for a Major (9160 → 9160). */
export function readPicks(gc: GCClient, eventId: number, timeoutMs: number): Promise<TeamPick[]> {
  return request(gc, REQUEST_PREDICTIONS, timeoutMs, "the saved picks", (body) => picksOf(body, eventId),
    () => gc.sendRaw(REQUEST_PREDICTIONS, toBinary(CMsgGCCStrike15_v2_PredictionsSchema, create(CMsgGCCStrike15_v2_PredictionsSchema, { eventId })), { proto: true }));
}

/**
 * Saves picks as CS2's PredictionsAPI.SetMyPredictionUsingItemID does (9161 → 9161): every slot of a group in one call. Resolves with the picks Steam echoes.
 * The item id is the faux id of the team's first sticker, as client.dll's GetFakeItemIDToRepresentTeamID builds it; Steam keeps none (live 2026-11-18).
 */
export function savePicks(gc: GCClient, eventId: number, picks: TeamPickUpload[], timeoutMs: number): Promise<TeamPick[]> {
  const msg = create(CMsgGCCStrike15_v2_PredictionsSchema, {
    eventId,
    groupMatchTeamPicks: picks.map((p) => ({ sectionid: p.sectionId, groupid: p.groupId, index: p.index, teamid: p.teamId, itemid: 0xF000000000000000n | (BigInt(p.stickerId) << 16n) | STICKER_DEF })),
  });
  return request(gc, UPLOAD_PREDICTIONS, timeoutMs, "the picks to save", (body) => picksOf(body, eventId),
    () => gc.sendRaw(UPLOAD_PREDICTIONS, toBinary(CMsgGCCStrike15_v2_PredictionsSchema, msg), { proto: true }));
}
