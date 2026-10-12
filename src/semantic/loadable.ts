/**
 * What `load` can retrieve. `load T(id)` is one operation in the language;
 * the type after it decides the platform operation, and this registry is
 * the one place that decision is declared:
 *
 *   a record type (from the schema)   N/record.load, a mutable owned record
 *   Search                            N/search.load, a saved search used as a search source
 *   File                              N/file.load, an opaque File value
 *
 * The parser sees one `load`; the binder asks `loadKindOf`; the emitter
 * lowers each bound kind. A new loadable platform object is an entry here
 * plus a bound node and a lowering, never a grammar change. Platform types
 * are not record types: they have no fields in the schema and cannot be
 * created, referenced, or searched.
 */
import type { NetSuiteModule } from "./builtins.js";
import type { SchemaProvider } from "../schema/provider.js";

export type LoadKind = "record" | "search" | "file";

export interface PlatformType {
  name: string;
  kind: Exclude<LoadKind, "record">;
  module: NetSuiteModule;
  /** One sentence for editors. */
  summary: string;
  /** How the id is written, for messages and completion. */
  example: string;
}

export const PLATFORM_TYPES: ReadonlyMap<string, PlatformType> = new Map<string, PlatformType>([
  [
    "Search",
    {
      name: "Search",
      kind: "search",
      module: "N/search",
      summary: "A saved search, loaded by its script id and used as a search source: its result type comes from the account snapshot, and it takes the same clauses as `search T`.",
      example: 'load Search("customsearch_active_customers")',
    },
  ],
  [
    "File",
    {
      name: "File",
      kind: "file",
      module: "N/file",
      summary: "A file in the File Cabinet, loaded by its internal id. Opaque so far: it can be loaded and passed along; its contents and properties are not modeled yet.",
      example: "load File(456)",
    },
  ],
]);

export function platformType(name: string): PlatformType | undefined {
  return PLATFORM_TYPES.get(name);
}

export function isPlatformTypeName(name: string): boolean {
  return PLATFORM_TYPES.has(name);
}

/** What `load <name>(...)` loads: a schema record, a platform type, or nothing known. */
export function loadKindOf(name: string, schema: SchemaProvider): LoadKind | undefined {
  if (schema.getRecordByName(name)) return "record";
  return PLATFORM_TYPES.get(name)?.kind;
}

/** Every name that may follow `load`, for completion: the schema's records and the platform types. */
export function loadableTypeNames(schema: SchemaProvider): string[] {
  return [...schema.listRecords().map((r) => r.name), ...PLATFORM_TYPES.keys()];
}
