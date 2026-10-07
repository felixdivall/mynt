/**
 * Raw REST metadata -> Sail SchemaDocument.
 *
 * Every mapping decision is made here and nowhere else, so the compiler
 * never sees NetSuite's shape and a change in what NetSuite reports is a
 * change to this file. Decisions that rest on a NetSuite naming rule
 * rather than on data the metadata states outright are marked DERIVED.
 */
import { FIELD_TYPES, type FieldType, type SchemaDocument, type SchemaDocumentField, type SchemaDocumentRecord } from "../../schema/types.js";
import type { RawMetadata, RawProperty, RawRecordSchema } from "../client/metadata.js";
import { RECORD_TYPE_CONSTANTS } from "../platform/record-types.js";

export interface NormalizeOptions {
  account: string;
  pulledAt: string;
}

export interface NormalizeResult {
  document: SchemaDocument;
  /** Things worth a look: unmapped types, name collisions. Not errors. */
  warnings: string[];
}

/** REST properties that are not record fields. */
const NON_FIELD_PROPERTIES: Record<string, string> = {
  links: "hypermedia links",
  id: "internal id, not a field",
  refName: "display name of a reference, not a field",
};

/** Script id prefixes NetSuite assigns to custom fields. Fixed by the platform. */
const CUSTOM_FIELD_PREFIX = /^cust(entity|body|item|record|event|col|page|itemnumber)/;

/** Script id prefixes NetSuite assigns to custom record types. Fixed by the platform. */
const CUSTOM_RECORD_PREFIX = /^(customrecord|customtransaction|customlist)_?/;

export function normalize(raw: RawMetadata, options: NormalizeOptions): NormalizeResult {
  const warnings: string[] = [];
  const restTypes = Object.keys(raw.records).sort();

  // Sail names first, so reference targets can be resolved by REST type name.
  const names = assignSailNames(restTypes, warnings);

  const records: Record<string, SchemaDocumentRecord> = {};
  for (const restType of restTypes) {
    const id = recordId(restType);
    records[id] = normalizeRecord(restType, raw.records[restType]!, names, warnings);
  }

  return {
    document: {
      sailSchemaVersion: 1,
      source: { kind: "account", platform: "netsuite", account: options.account, pulledAt: options.pulledAt },
      records,
    },
    warnings,
  };
}

/**
 * DERIVED: the SuiteScript record id is the REST type name lowercased
 * (`salesOrder` -> `salesorder`). Custom types are already lowercase.
 */
export function recordId(restType: string): string {
  return restType.toLowerCase();
}

export function isCustomRecord(restType: string): boolean {
  return CUSTOM_RECORD_PREFIX.test(restType.toLowerCase());
}

/**
 * Sail record names: `salesOrder` -> `SalesOrder`; `customrecord_sail_test`
 * -> `SailTest`. These are Sail's own names, not NetSuite identifiers. A
 * collision falls back to the full id (`CustomrecordSailTest`).
 */
function assignSailNames(restTypes: string[], warnings: string[]): Map<string, string> {
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const restType of restTypes) {
    let name = isCustomRecord(restType) ? pascalCase(restType.replace(CUSTOM_RECORD_PREFIX, "")) : capitalize(restType);
    if (!name || taken.has(name)) {
      const fallback = pascalCase(restType);
      warnings.push(`Record '${restType}' is named '${fallback}' in Sail because '${name || "(empty)"}' is taken or empty.`);
      name = fallback;
    }
    taken.add(name);
    names.set(restType, name);
  }
  return names;
}

function normalizeRecord(
  restType: string,
  schema: RawRecordSchema,
  names: Map<string, string>,
  warnings: string[],
): SchemaDocumentRecord {
  const id = recordId(restType);
  const custom = isCustomRecord(restType);
  const required = new Set(schema.required ?? []);
  const fields: Record<string, SchemaDocumentField> = {};
  const omitted: Record<string, string> = {};

  for (const restName of Object.keys(schema.properties ?? {}).sort()) {
    const property = schema.properties![restName]!;
    const skip = NON_FIELD_PROPERTIES[restName];
    if (skip) {
      omitted[restName] = skip;
      continue;
    }
    const result = normalizeField(restName, property, required.has(restName), names);
    if ("omitted" in result) {
      omitted[restName] = result.omitted;
      continue;
    }
    if (result.field.type === "Unknown") {
      warnings.push(`${restType}.${restName}: REST type '${result.field.netsuite?.restType}' is not mapped; typed Unknown.`);
    }
    // DERIVED: the SuiteScript field id is the REST property name lowercased.
    fields[restName.toLowerCase()] = result.field;
  }

  const record: SchemaDocumentRecord = {
    name: names.get(restType)!,
    fields,
    netsuite: { restType, ...(Object.keys(omitted).length > 0 ? { omitted } : {}) },
  };
  const constant = RECORD_TYPE_CONSTANTS[id];
  if (constant) record.suiteScriptType = constant;
  if (custom) record.custom = true;
  return record;
}

function normalizeField(
  restName: string,
  property: RawProperty,
  required: boolean,
  names: Map<string, string>,
): { field: SchemaDocumentField } | { omitted: string } {
  const restType = jsonType(property);

  // Sublists arrive as arrays, or as collection objects holding an `items` array.
  const itemsProperty = property.properties?.items;
  if (restType === "array" || property.items || (itemsProperty && jsonType(itemsProperty) === "array")) {
    return { omitted: "sublist or collection" };
  }

  const mapped = mapType(property, restType, names);
  const field: SchemaDocumentField = {
    type: mapped.type,
    label: property.title ?? restName,
    // NetSuite's `readOnly` is the only writability signal the catalog has.
    // Its absence does not prove a field is settable in SuiteScript.
    writable: property.readOnly !== true,
    netsuite: { restName, restType, ...(property.format ? { format: property.format } : {}) },
  };
  if (typeof property["x-ns-custom-field"] === "string" || CUSTOM_FIELD_PREFIX.test(restName.toLowerCase())) {
    field.custom = true;
  }
  if (mapped.refTarget) field.refTarget = mapped.refTarget;
  if (property.enum && property.enum.length > 0) field.values = [...property.enum].sort();
  if (required || property.nullable === false) field.required = true;
  return { field };
}

/** The property's JSON Schema type as one string: the first non-null entry of a union, or "object" for refs. */
function jsonType(property: RawProperty): string {
  if (Array.isArray(property.type)) return property.type.find((t) => t !== "null") ?? "null";
  if (typeof property.type === "string") return property.type;
  if (property.$ref || property.properties) return "object";
  return "unspecified";
}

function mapType(property: RawProperty, restType: string, names: Map<string, string>): { type: FieldType; refTarget?: string } {
  switch (restType) {
    case "boolean":
      return { type: "Bool" };
    case "number":
    case "integer":
      return { type: "Number" };
    case "string":
      return property.format === "date" || property.format === "date-time" ? { type: "Date" } : { type: "Text" };
    case "object": {
      // A reference is an object with an `id` (and usually `refName`), or a
      // `$ref` to another catalog entry. The target is the referenced
      // catalog type when the `$ref` names one; NetSuite's generic
      // `nsResource` gives no target.
      const target = refTarget(property, names);
      if (target.isReference) return target.name ? { type: "Ref", refTarget: target.name } : { type: "Ref" };
      return { type: "Unknown" };
    }
    default:
      return { type: "Unknown" };
  }
}

function refTarget(property: RawProperty, names: Map<string, string>): { isReference: boolean; name?: string } {
  if (typeof property.$ref === "string") {
    const last = property.$ref.split("/").filter(Boolean).pop() ?? "";
    const name = names.get(last);
    return name ? { isReference: true, name } : { isReference: true };
  }
  if (property.properties && "id" in property.properties) return { isReference: true };
  return { isReference: false };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function pascalCase(text: string): string {
  return text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => capitalize(part.toLowerCase()))
    .join("");
}

/** Sanity check used by tests and the pull command: every field type is one Sail knows. */
export function assertKnownTypes(document: SchemaDocument): void {
  for (const [recordId, record] of Object.entries(document.records)) {
    for (const [fieldId, field] of Object.entries(record.fields)) {
      if (!FIELD_TYPES.includes(field.type)) throw new Error(`${recordId}.${fieldId} has unknown type ${field.type}`);
    }
  }
}
