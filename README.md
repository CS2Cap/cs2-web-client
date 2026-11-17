# cs2-web-client

A headless CS2 client in TypeScript. It logs on to Steam over WebSocket and speaks the CS2 Game Coordinator protocol, so everything that normally needs the game running works from a browser extension or Node: full inventory reads, storage unit moves, item actions (stickers, cases, trade-ups) and store purchases.

## What it can do

### Sign in

- Sign in with a QR code scanned in the Steam Mobile app. No password is typed anywhere.
- Stay signed in afterwards with the refresh token Steam returns.

### Read

- The whole inventory, with every item's float, pattern seed, StatTrak count, name tag and trade lock date.
- Each sticker on an item with its position and wear, and each charm.
- All storage units and their contents.
- The CS2 in-game store catalogue with prices in the account's currency.
- The Armory star balance and the Weekly Care Package on offer.

### Storage units

- Move items into and out of storage units.
- Name a new unit to start using it, and rename existing ones.

### Customise items

- Apply a sticker at any position and rotation, and scrape it down or off.
- Seal a sticker in a Sticker Slab, and crack a slab open.
- Attach a charm where you want it on the weapon, and detach it.
- Put patches on agents and remove them.
- Apply a name tag and remove it.
- Swap StatTrak counts between two items with a StatTrak Swap Tool.

### Openings and Trade ups

- Open cases, capsules and other containers.
- Run trade-up contracts.
- Use terminals: receive offers, accept one or decline them all.

### Store and Armory

- Buy from the CS2 in-game store using Steam Wallet funds.
- Activate an Armory Pass and spend Armory stars on rewards.
- Claim Weekly Care Package rewards.

## Built for CS2Cap Inventory

This is the protocol core of [CS2Cap Inventory](https://cs2cap.com/inventory), the cs2cap.com browser extension that syncs a Steam account's items, storage units included. It was split out so other projects can use it.

## Getting started

You need a Steam account with the Steam Mobile app, which scans the sign-in QR code.

```sh
pnpm add cs2-web-client
pnpm add ws    # Node only
```

[`examples/node-inventory.ts`](examples/node-inventory.ts) goes from QR sign-in to a full inventory read. Start there.

Before you build on it:

- Steam allows one game session per account. While your client holds CS2, opening the game on that account signs one of you out, so release it when you're done.
- Item actions use things up the way they do in game, and store purchases spend Steam Wallet funds.
- In a browser extension, Steam refuses a WebSocket from a `chrome-extension://` origin. CS2Cap Inventory rewrites the `Origin` header to `https://steamcommunity.com` with a `declarativeNetRequest` rule.

## License

[MIT](LICENSE). The files in `proto/` are Valve's protocol definitions from [SteamDatabase/Protobufs](https://github.com/SteamDatabase/Protobufs) and are not covered by this license. Not affiliated with or endorsed by Valve.
