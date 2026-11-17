import { configureTextEncoding, getTextEncoding } from "@bufbuild/protobuf/wire";

// Protobuf string fields are not text files: a leading U+FEFF is name data, not a BOM to discard.
// Configure this library copy only; keep its encoder and Unicode validation unchanged.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const strictDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });

configureTextEncoding({
  ...getTextEncoding(),
  decodeUtf8: (bytes, strict) => (strict ? strictDecoder : decoder).decode(bytes),
});
