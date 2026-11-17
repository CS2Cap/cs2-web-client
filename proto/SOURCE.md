# Vendored protobufs

Source: https://github.com/SteamDatabase/Protobufs (`steam/` and `csgo/` directories).
`SOURCE_COMMIT.txt` pins the exact upstream revision. Files are unmodified copies.

Two separate buf inputs (`proto/steam`, `proto/csgo`) because the two upstream
directories define conflicting versions of `steammessages_base.proto` and
`enums_clientserver.proto`. Each generates into its own folder under `src/gen/`.
`google/protobuf/descriptor.proto` is supplied by buf's built-in well-known types.
`csgo/steammessages_base.proto` is intentionally not vendored (it duplicates
`csgo/steammessages.proto`, which is what the GC protos import).
