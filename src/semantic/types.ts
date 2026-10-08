/**
 * Mynt's value types as the binder sees them.
 *
 * Primitive field types are the schema's string names so they compare with
 * `===` and read naturally in tests. Record types carry their schema so field
 * access on any record-typed value (entry point parameter, loaded record)
 * goes through one path.
 */
import type { FieldSchema, FieldType, RecordSchema, SublistSchema } from "../schema/types.js";

/**
 * Who owns a record value's persistence. This is not part of the record's
 * identity (both are `Customer`) but it decides what the script may do:
 *
 *   context  the record NetSuite handed to the entry point (`context.newRecord`).
 *            The event lifecycle owns persistence: no explicit save, and no
 *            writes once the record is already saved (afterSubmit).
 *   owned    a record the script obtained itself (`load`, `create`). Writable,
 *            and nothing about it persists except through an explicit `save`.
 *   query    a row of a query result: a typed, read-only view of a record.
 *            Fields can be read and `id` identifies the record for `load`;
 *            nothing can be assigned, saved, or deleted through it.
 *   search   a row of a search result: the same read-only view, produced by
 *            `N/search` instead of `N/query`. The two row origins behave
 *            identically in the language; they differ only in which
 *            backend produced them, which the emitter needs.
 *   parameter a record passed into a function. Inside the body anything is
 *            allowed; what the function actually does to it is summarized,
 *            and each call site checks the summary against the argument's
 *            own origin and applies it to the argument's lifecycle state.
 *
 * Whether an owned record is persisted *yet* (a created record is not until
 * its first save) is flow state, tracked by the persistence analysis, not a
 * property of the type: the same local is unsaved before `save` and saved
 * after it.
 */
export type RecordOrigin = "context" | "owned" | "query" | "search" | "parameter";

/** The origins that are rows: read-only views produced by a `query` or a `search`. */
export type RowOrigin = "query" | "search";

export const ROW_ORIGINS: readonly RowOrigin[] = ["query", "search"];

export function isRowOrigin(origin: RecordOrigin): origin is RowOrigin {
  return (ROW_ORIGINS as readonly string[]).includes(origin);
}

/** "Query result" / "Search result", for diagnostics about a row. */
export function rowLabel(origin: RowOrigin): string {
  return origin === "query" ? "Query result" : "Search result";
}

export interface RecordType {
  kind: "Record";
  record: RecordSchema;
  origin: RecordOrigin;
}

/**
 * `Bool` (spelled `boolean` in source) is the type of a comparison and the
 * only type an `if` condition may have. There is no truthiness: a string or
 * number value is never a condition.
 * It is not a FieldType yet because no schema field produces one; when
 * checkbox fields arrive it moves into FieldType unchanged.
 */
/**
 * The result of a `query` or `search`: a materialized, re-iterable
 * collection of rows of one record type. `source` is the backend that
 * produced it, and the element rows carry the same value as their origin.
 */
export interface SequenceType {
  kind: "Sequence";
  element: RecordType;
  source: RowOrigin;
}

/**
 * `Customer(123)`: a typed reference to the record with that internal id.
 * It is a value, not a record: constructing it performs no NetSuite work,
 * nothing can be read from it except `id`, and nothing can be written
 * through it. Fields are fetched with a projection, `ref[email, ...]`,
 * which lowers to `N/search.lookupFields`. A reference obtained from a
 * select field will carry display text as well; that is not modeled yet.
 */
export interface ReferenceType {
  kind: "Reference";
  record: RecordSchema;
}

/**
 * `Customer(123)[email, comments]`: a read-only projection of some fields
 * of one record. Only the projected fields exist on it, each with its
 * schema type. It is not a record: it has no identity, no lifecycle, and
 * cannot be saved, deleted, or assigned. A single-field projection has the
 * field's own type instead of this one.
 */
export interface ProjectionType {
  kind: "Projection";
  record: RecordSchema;
  fields: readonly FieldSchema[];
}

/**
 * `order.item`: a sublist of a record value. Iterable; its lines are
 * LineType. Capabilities come from the parent: a line can be written only
 * when the parent can, and it persists only when the parent is saved.
 */
export interface SublistType {
  kind: "Sublist";
  parent: RecordType;
  sublist: SublistSchema;
}

/** One line of a sublist, inside a `for` over it. Not a record: it has no identity or persistence of its own. */
export interface LineType {
  kind: "Line";
  parent: RecordType;
  sublist: SublistSchema;
}

export type MyntType = FieldType | "Bool" | "Void" | RecordType | SequenceType | SublistType | LineType | ReferenceType | ProjectionType;

export function recordType(record: RecordSchema, origin: RecordOrigin): RecordType {
  return { kind: "Record", record, origin };
}

export function sequenceType(record: RecordSchema, source: RowOrigin = "query"): SequenceType {
  return { kind: "Sequence", element: recordType(record, source), source };
}

export function referenceType(record: RecordSchema): ReferenceType {
  return { kind: "Reference", record };
}

export function projectionType(record: RecordSchema, fields: readonly FieldSchema[]): ProjectionType {
  return { kind: "Projection", record, fields };
}

export function isReferenceType(type: MyntType): type is ReferenceType {
  return typeof type === "object" && type.kind === "Reference";
}

export function isProjectionType(type: MyntType): type is ProjectionType {
  return typeof type === "object" && type.kind === "Projection";
}

/** A record value that is a row of a query or search result. */
export function isRowRecord(type: MyntType): type is RecordType & { origin: RowOrigin } {
  return isRecordType(type) && isRowOrigin(type.origin);
}

export function isRecordType(type: MyntType): type is RecordType {
  return typeof type === "object" && type.kind === "Record";
}

export function isSequenceType(type: MyntType): type is SequenceType {
  return typeof type === "object" && type.kind === "Sequence";
}

export function sublistType(parent: RecordType, sublist: SublistSchema): SublistType {
  return { kind: "Sublist", parent, sublist };
}

export function isSublistType(type: MyntType): type is SublistType {
  return typeof type === "object" && type.kind === "Sublist";
}

export function isLineType(type: MyntType): type is LineType {
  return typeof type === "object" && type.kind === "Line";
}

/** `SalesOrder.item`, the name of a sublist as a type owner. */
export function sublistName(type: SublistType | LineType): string {
  return `${type.parent.record.name}.${type.sublist.id}`;
}

/**
 * Type identity. Origin is deliberately ignored: a loaded Customer and a
 * context Customer are the same type. When record-typed parameters arrive,
 * assignability (not identity) must consult origin, since a context record
 * cannot stand in where a saveable one is required.
 */
export function sameType(a: MyntType, b: MyntType): boolean {
  if (isRecordType(a) || isRecordType(b)) {
    return isRecordType(a) && isRecordType(b) && a.record === b.record;
  }
  if (isSequenceType(a) || isSequenceType(b)) {
    // Query and search rows behave identically, so their sequences are one type; `source` only matters to the emitter.
    return isSequenceType(a) && isSequenceType(b) && a.element.record === b.element.record;
  }
  if (isReferenceType(a) || isReferenceType(b)) {
    return isReferenceType(a) && isReferenceType(b) && a.record === b.record;
  }
  if (isProjectionType(a) || isProjectionType(b)) {
    return (
      isProjectionType(a) &&
      isProjectionType(b) &&
      a.record === b.record &&
      a.fields.length === b.fields.length &&
      a.fields.every((field, index) => field === b.fields[index])
    );
  }
  if (typeof a === "object" || typeof b === "object") {
    return typeof a === "object" && typeof b === "object" && a.kind === b.kind && a.sublist === b.sublist && a.parent.record === b.parent.record;
  }
  return a === b;
}

/**
 * The source spelling of each primitive type. Internally the field types keep
 * the schema snapshot's names (`Text`, `Number`, `Bool`); in Mynt source,
 * signatures, and diagnostics they are `string`, `number`, and `boolean`,
 * lowercase so that language primitives read differently from the
 * PascalCase record types the schema defines.
 */
export const PRIMITIVE_TYPES: ReadonlyMap<string, FieldType | "Bool"> = new Map([
  ["string", "Text"],
  ["number", "Number"],
  ["boolean", "Bool"],
]);

export const PRIMITIVE_TYPE_NAMES: readonly string[] = [...PRIMITIVE_TYPES.keys()];

export function isPrimitiveTypeName(name: string): boolean {
  return PRIMITIVE_TYPES.has(name);
}

/** The primitive type a source name denotes, or undefined for any other name (including `Text`). */
export function primitiveTypeNamed(name: string): FieldType | "Bool" | undefined {
  return PRIMITIVE_TYPES.get(name);
}

const PRIMITIVE_SPELLING: Partial<Record<string, string>> = { Text: "string", Number: "number", Bool: "boolean" };

/**
 * How a type is spelled in diagnostics and signatures: `string`, `boolean`,
 * `Void`, `Customer`, `Sequence<Customer>`, `Ref<Customer>`, and for a
 * projection its own source form, `Customer[email, comments]`.
 */
export function typeName(type: MyntType): string {
  if (isRecordType(type)) return type.record.name;
  if (isSequenceType(type)) return `Sequence<${type.element.record.name}>`;
  if (isReferenceType(type)) return `Ref<${type.record.name}>`;
  if (isProjectionType(type)) return `${type.record.name}[${type.fields.map((f) => f.id).join(", ")}]`;
  if (isSublistType(type)) return `Sublist<${sublistName(type)}>`;
  if (isLineType(type)) return `Line<${sublistName(type)}>`;
  return PRIMITIVE_SPELLING[type] ?? type;
}
