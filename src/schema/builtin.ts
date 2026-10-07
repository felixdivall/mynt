import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DocumentSchemaProvider, type SchemaProvider } from "./provider.js";
import type { SchemaDocument } from "./types.js";

/** Loads the schema snapshot shipped with the compiler. */
export function loadBuiltinSchema(): SchemaProvider {
  const path = fileURLToPath(new URL("../../schemas/builtin.json", import.meta.url));
  const document = JSON.parse(readFileSync(path, "utf8")) as SchemaDocument;
  return new DocumentSchemaProvider(document);
}
