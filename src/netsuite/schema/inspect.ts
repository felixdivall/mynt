/**
 * A structural report over raw metadata-catalog responses. It answers,
 * from the real data, the questions the normalizer's assumptions rest on:
 * which keys properties carry, how types and formats are spelled, what
 * `$ref` points at, how custom fields and records are marked, how
 * `readOnly`, `nullable`, and `required` are used, and what enums contain.
 *
 * It reads the files `sail schema pull --keep-raw` wrote and prints text.
 * It never changes anything, and it prints property names and enum values
 * but no field labels, so the output is easier to share than the raw files.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SchemaDocument } from "../../schema/types.js";
import type { RawProperty, RawRecordSchema } from "../client/metadata.js";
import { RECORD_TYPE_CONSTANTS } from "../platform/record-types.js";
import { isCustomRecord, recordId } from "./normalize.js";

export interface InspectOptions {
  /** REST type names to detail. Default: customer, salesOrder, and up to three custom records. */
  records?: string[];
  snapshot?: SchemaDocument;
}

const SAMPLE = 8;

export function inspectRawMetadata(dir: string, options: InspectOptions = {}): string {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .sort();
  const types = files.map((f) => f.slice(0, -5));
  const out: string[] = [];
  const line = (text = ""): void => {
    out.push(text);
  };

  line(`Raw metadata in ${dir}`);
  line(`${types.length} record types`);
  const custom = types.filter(isCustomRecord);
  const standard = types.filter((t) => !isCustomRecord(t));
  const unlisted = standard.filter((t) => !RECORD_TYPE_CONSTANTS[recordId(t)]);
  line(`  standard: ${standard.length} (${standard.length - unlisted.length} with a record.Type constant in the platform table)`);
  line(`  custom:   ${custom.length}${custom.length > 0 ? `  ${custom.slice(0, SAMPLE).join(", ")}${custom.length > SAMPLE ? ", ..." : ""}` : ""}`);
  if (unlisted.length > 0) line(`  standard types without a platform-table entry: ${unlisted.join(", ")}`);
  const failures = join(dir, "_failures.json");
  if (existsSync(failures)) {
    const parsed = JSON.parse(readFileSync(failures, "utf8")) as Record<string, string>;
    line(`  failed to fetch: ${Object.keys(parsed).length}`);
    for (const [type, reason] of Object.entries(parsed).slice(0, SAMPLE)) line(`    ${type}: ${reason}`);
  }
  const casing = types.filter((t) => t !== t.toLowerCase());
  line(`  type names with uppercase letters: ${casing.length}${casing.length > 0 ? `  e.g. ${casing.slice(0, SAMPLE).join(", ")}` : ""}`);

  const selected = options.records ?? [...["customer", "salesOrder"].filter((t) => types.includes(t)), ...custom.slice(0, 3)];
  for (const type of selected) {
    const path = join(dir, `${type}.json`);
    line();
    if (!existsSync(path)) {
      line(`== ${type}: no raw file`);
      continue;
    }
    const schema = JSON.parse(readFileSync(path, "utf8")) as RawRecordSchema;
    inspectRecord(type, schema, options.snapshot, line);
  }
  return out.join("\n") + "\n";
}

function inspectRecord(type: string, schema: RawRecordSchema, snapshot: SchemaDocument | undefined, line: (t?: string) => void): void {
  const properties = schema.properties ?? {};
  const names = Object.keys(properties).sort();
  line(`== ${type}`);
  line(`top-level keys: ${Object.keys(schema).sort().join(", ")}`);
  const xns = Object.keys(schema).filter((k) => k.startsWith("x-"));
  if (xns.length > 0) line(`top-level x- keys: ${xns.map((k) => `${k}=${JSON.stringify(schema[k])}`).join(", ")}`);
  if (schema.title !== undefined) line(`title: ${JSON.stringify(schema.title)}`);
  line(`required (top-level): ${JSON.stringify(schema.required ?? null)}`);
  line(`properties: ${names.length}`);

  // Keys used across properties, and how often.
  const keyCounts = new Map<string, number>();
  for (const name of names) for (const key of Object.keys(properties[name]!)) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  line(`property keys: ${[...keyCounts].sort().map(([k, n]) => `${k}(${n})`).join(", ")}`);

  // Type/format distribution.
  const shapes = new Map<string, string[]>();
  for (const name of names) {
    const p = properties[name]!;
    const shape = describeShape(p);
    shapes.set(shape, [...(shapes.get(shape) ?? []), name]);
  }
  line(`shapes:`);
  for (const [shape, members] of [...shapes].sort((a, b) => b[1].length - a[1].length)) {
    line(`  ${String(members.length).padStart(4)}  ${shape}  e.g. ${members.slice(0, SAMPLE).join(", ")}`);
  }

  const flag = (key: string, value: unknown) => names.filter((n) => properties[n]![key] === value);
  line(`readOnly: true=${flag("readOnly", true).length} false=${flag("readOnly", false).length} absent=${names.filter((n) => !("readOnly" in properties[n]!)).length}`);
  line(`  readOnly true e.g. ${flag("readOnly", true).slice(0, SAMPLE).join(", ")}`);
  line(`nullable: true=${flag("nullable", true).length} false=${flag("nullable", false).length} absent=${names.filter((n) => !("nullable" in properties[n]!)).length}`);
  const nullableFalse = flag("nullable", false);
  if (nullableFalse.length > 0) line(`  nullable false e.g. ${nullableFalse.slice(0, SAMPLE).join(", ")}`);

  const refs = new Map<string, string[]>();
  for (const name of names) {
    const ref = properties[name]!.$ref;
    if (typeof ref === "string") refs.set(ref, [...(refs.get(ref) ?? []), name]);
  }
  line(`$ref targets: ${refs.size}`);
  for (const [ref, members] of [...refs].sort()) line(`  ${ref}  (${members.length}) e.g. ${members.slice(0, 5).join(", ")}`);

  const objects = names.filter((n) => describeShape(properties[n]!).startsWith("object"));
  line(`object-shaped properties: ${objects.length}`);
  for (const name of objects.slice(0, 5)) {
    const p = properties[name]!;
    const sub = Object.keys(p.properties ?? {}).sort();
    const extra = Object.keys(p).filter((k) => !["title", "type", "nullable", "properties", "$ref"].includes(k));
    line(`  ${name}: sub-properties [${sub.join(", ")}]${extra.length > 0 ? ` other keys [${extra.join(", ")}]` : ""}`);
  }

  const enums = names.filter((n) => Array.isArray(properties[n]!.enum));
  line(`enum properties: ${enums.length}`);
  for (const name of enums.slice(0, 5)) {
    const values = properties[name]!.enum!;
    line(`  ${name}: ${values.length} values, e.g. ${values.slice(0, 6).map((v) => JSON.stringify(v)).join(", ")}`);
  }

  const marked = names.filter((n) => "x-ns-custom-field" in properties[n]!);
  const prefixed = names.filter((n) => /^cust(entity|body|item|record|event|col|page|itemnumber)/i.test(n));
  line(`custom fields: x-ns-custom-field=${marked.length} cust*-prefixed=${prefixed.length}`);
  const onlyMarked = marked.filter((n) => !prefixed.includes(n));
  const onlyPrefixed = prefixed.filter((n) => !marked.includes(n));
  if (onlyMarked.length > 0) line(`  marked but not prefixed: ${onlyMarked.slice(0, SAMPLE).join(", ")}`);
  if (onlyPrefixed.length > 0) line(`  prefixed but not marked: ${onlyPrefixed.slice(0, SAMPLE).join(", ")}`);
  if (marked.length > 0) {
    const sample = properties[marked[0]!]!;
    line(`  e.g. ${marked[0]}: ${JSON.stringify(Object.fromEntries(Object.entries(sample).filter(([k]) => k !== "title")))}`);
  }

  const upper = names.filter((n) => n !== n.toLowerCase());
  line(`property names with uppercase letters: ${upper.length} of ${names.length}  e.g. ${upper.slice(0, SAMPLE).join(", ")}`);

  if (snapshot) {
    const record = snapshot.records[recordId(type)];
    if (!record) {
      line(`snapshot: no record '${recordId(type)}'`);
      return;
    }
    const fields = Object.entries(record.fields);
    const unknown = fields.filter(([, f]) => f.type === "Unknown").map(([id]) => id);
    const counts = new Map<string, number>();
    for (const [, f] of fields) counts.set(f.type, (counts.get(f.type) ?? 0) + 1);
    line(`snapshot: ${record.name} id=${recordId(type)} record.Type=${record.suiteScriptType ?? "(none: id string)"} custom=${record.custom ?? false}`);
    line(`  field types: ${[...counts].sort().map(([t, n]) => `${t}=${n}`).join(", ")}`);
    line(`  Unknown: ${unknown.length}${unknown.length > 0 ? `  ${unknown.slice(0, SAMPLE).join(", ")}` : ""}`);
    line(`  omitted: ${JSON.stringify(record.netsuite?.omitted ?? {})}`);
    const refsWithTarget = fields.filter(([, f]) => f.type === "Ref" && f.refTarget).length;
    const refsNoTarget = fields.filter(([, f]) => f.type === "Ref" && !f.refTarget).length;
    line(`  Ref with target: ${refsWithTarget}, without: ${refsNoTarget}`);
  }
}

function describeShape(p: RawProperty): string {
  const type = Array.isArray(p.type) ? p.type.join("|") : (p.type ?? (p.$ref ? "$ref" : p.properties ? "object(no type)" : "untyped"));
  const parts = [type];
  if (p.format) parts.push(`format=${p.format}`);
  if (p.enum) parts.push("enum");
  if (p.items) parts.push("items");
  if (p.$ref && type !== "$ref") parts.push("$ref");
  return parts.join(" ");
}
