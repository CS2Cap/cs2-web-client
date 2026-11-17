// Ids from vendored enums_clientserver.proto (EMsg) and the CS2 GC protos (GCMsg).
export const EMsg = {
  ClientLogOff: 706,
  ClientLoggedOff: 757,
  ClientAccountInfo: 768, // k_EMsgClientAccountInfo, enums_clientserver.proto
  Multi: 1,
  ServiceMethodResponse: 147,
  ServiceMethodCallFromClient: 151,
  ClientHeartBeat: 703,
  ClientChangeStatus: 716,
  ClientLogOnResponse: 751,
  ClientGamesPlayed: 5410,
  ClientPlayingSessionState: 9600, // k_EMsgClientPlayingSessionState, enums_clientserver.proto
  ClientToGC: 5452,
  ClientWalletInfoUpdate: 5528, // k_EMsgClientWalletInfoUpdate
  ClientFromGC: 5453,
  ClientLogon: 5514,
} as const;
export const GCMsg = {
  SOCreate: 21,
  SOUpdate: 22,
  SODestroy: 23,
  SOCacheSubscribed: 24,
  SOUpdateMultiple: 26,
  ClientWelcome: 4004,
  ClientHello: 4006,
  NameItem: 1006, // rename / start a unit (CMsgModifyItemStringAttr since 2026-10-08)
  CasketItemAdd: 1092, // deposit
  CasketItemExtract: 1093, // withdraw
  CasketItemLoadContents: 1094,
  VolatileItemLoadContents: 2536,
  ItemCustomizationNotification: 1090,
} as const;
export const PROTO_MASK = 0x80000000;
