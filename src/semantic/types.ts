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
  /**
   * For a search row of a search with an explicit `select`: exactly the
   * fields the row exposes (a schema field, or a field one join away),
   * besides `id`, which is row identity and always present. Absent means
   * every schema field is exposed and the planner fetches what is read.
   * It is part of the row's type, not its identity: two rows of one record
   * are one type whatever they expose.
   */
  exposes?: readonly ExposedField[];
}

/** One field a projected search row exposes: `tranid`, or `email` through `entity`. */
export interface ExposedField {
  field: FieldSchema;
  join: { via: FieldSchema; target: RecordSchema } | undefined;
}

/** Whether a row exposes a plain field (not through a join); true when the row is not projected. */
export function exposesField(type: RecordType, fieldId: string): boolean {
  return !type.exposes || type.exposes.some((e) => !e.join && e.field.id === fieldId);
}

/** Whether a row exposes `field` through the join `via`; true when the row is not projected. */
export function exposesJoinedField(type: RecordType, via: string, fieldId: string): boolean {
  return !type.exposes || type.exposes.some((e) => e.join?.via.id === via && e.field.id === fieldId);
}

/** Whether a row may be followed through the relationship `via` at all: it exposes the reference or a field joined through it. */
export function exposesRelationship(type: RecordType, via: string): boolean {
  return !type.exposes || type.exposes.some((e) => (e.join ? e.join.via.id === via : e.field.id === via));
}

/**
 * `Bool` (spelled `boolean` in source) is the type of a comparison and the
 * only type an `if` condition may have. There is no truthiness: a string or
 * number value is never a condition.
 * It is not a FieldType yet because no schema field produces one; when
 * checkbox fields arrive it moves into FieldType unchanged.
 */
/**
 * A materialized, re-iterable collection. From a `query` or `search` it
 * holds rows of one record type, and `source` is the backend that produced
 * it. From a multiselect field in a lookup it holds display references
 * (`Sequence<Ref<Category>>`), and `source` is `lookup`. Either way `for`
 * iterates it and the loop variable has the element type.
 */
export interface SequenceType {
  kind: "Sequence";
  element: RecordType | ReferenceType | SummaryType;
  source: RowOrigin | "lookup";
}

/** The aggregates a summary search computes; `group` is the grouping itself. Each is one `search.Summary` member. */
export type AggregateKind = "sum" | "count" | "min" | "max" | "avg";

export const AGGREGATE_KINDS: readonly AggregateKind[] = ["sum", "count", "min", "max", "avg"];

export function isAggregateKind(name: string): name is AggregateKind {
  return (AGGREGATE_KINDS as readonly string[]).includes(name);
}

/**
 * One field a summary row exposes. A grouped field keeps its source field
 * (and join, for `entity.email`, nested under the relationship as on an
 * ordinary row); an aggregate is named by its alias and remembers what it
 * aggregates. `count()` has no source field: it counts rows.
 */
export interface ResultField {
  /** The row member: the field id for a grouped field (nested under `join.via` when joined), the alias for an aggregate. */
  name: string;
  summary: "group" | AggregateKind;
  field: FieldSchema | undefined;
  join: { via: FieldSchema; target: RecordSchema } | undefined;
  type: MyntType;
}

/**
 * `search T group by ... select ...`: a row of a summary search, which is
 * an aggregate bucket rather than a record. It exposes exactly its result
 * fields, grouped or aggregated, and nothing else: no `id`, since a bucket
 * is not one record, and no other field of T. Read-only like any row.
 */
export interface SummaryType {
  kind: "Summary";
  record: RecordSchema;
  fields: readonly ResultField[];
}

export function summaryType(record: RecordSchema, fields: readonly ResultField[]): SummaryType {
  return { kind: "Summary", record, fields };
}

export function isSummaryType(type: MyntType): type is SummaryType {
  return typeof type === "object" && type.kind === "Summary";
}

/** A row of any kind: a query or search row, or a summary row. What they share: plain-object members, read-only. */
export function isRowLike(type: MyntType): type is (RecordType & { origin: RowOrigin }) | SummaryType {
  return isRowRecord(type) || isSummaryType(type);
}

/** The grouped result field a summary row exposes as a plain member (`row.entity`), if any. */
export function summaryField(type: SummaryType, name: string): ResultField | undefined {
  return type.fields.find((f) => f.summary === "group" && !f.join && f.field!.id === name);
}

/** The aggregate result field named `alias`, if any. */
export function summaryAggregate(type: SummaryType, alias: string): ResultField | undefined {
  return type.fields.find((f) => f.summary !== "group" && f.name === alias);
}

/** The grouped joined field `via.name` a summary row exposes (`row.entity.email`), if any. */
export function summaryJoinedField(type: SummaryType, via: string, name: string): ResultField | undefined {
  return type.fields.find((f) => f.summary === "group" && f.join?.via.id === via && f.field!.id === name);
}

/** Whether a summary row may be followed through the relationship `via`: it exposes the reference or a field grouped through it. */
export function summaryExposesRelationship(type: SummaryType, via: string): boolean {
  return type.fields.some((f) => f.summary === "group" && (f.join ? f.join.via.id === via : f.field!.id === via));
}

/** The result names of a summary row for messages, in result order: `entity`, `entity.email`, `total`. */
export function summaryResultNames(type: SummaryType): string[] {
  return type.fields.map((f) => (f.summary === "group" ? (f.join ? `${f.join.via.id}.${f.field!.id}` : f.field!.id) : f.name));
}

/** The top-level member names of a summary row, in result order: grouped fields (a joined one by its relationship) and aliases. */
export function summaryMemberNames(type: SummaryType): string[] {
  const names: string[] = [];
  for (const f of type.fields) {
    const name = f.summary === "group" ? (f.join ? f.join.via.id : f.field!.id) : f.name;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * A reference to one record of type T. Two kinds of value have this type:
 *
 *   identity   `Customer(123)`, or a select field read from a loaded record
 *              or a query row: the record's internal id and nothing else.
 *              `ref.id` is the id; there is no `ref.text`, and asking for
 *              it is an error rather than a hidden lookup.
 *   display    a select field from a lookup or a search row, whose backend
 *              representation carries the display text with the id:
 *              `ref.id` and `ref.text`, both strings, both already fetched.
 *
 * `text` says which one a value is. It is a property of where the value
 * came from, never of the record type: the same `Ref<Subsidiary>` is an
 * identity reference from `Subsidiary(1)` and a display reference from
 * `Customer(1)[subsidiary]`. Either way constructing or reading the
 * reference performs no NetSuite work of its own, nothing can be written
 * through it, and fields of the referenced record are fetched with a
 * projection, `ref[email, ...]`, which lowers to `N/search.lookupFields`.
 */
export interface ReferenceType {
  kind: "Reference";
  record: RecordSchema;
  /** Whether the value carries display text (`ref.text`) alongside its id. */
  text: boolean;
}

/** One projected field with the type its value has, which depends on the projection's source (a select field is a display reference from a lookup, an identity from a record). */
export interface ProjectedField {
  field: FieldSchema;
  type: MyntType;
}

/**
 * `Customer(123)[email, comments]`: a read-only projection of some fields
 * of one record. Only the projected fields exist on it, each with the type
 * its value has. It is not a record: it has no identity, no lifecycle, and
 * cannot be saved, deleted, or assigned. A single-field projection has the
 * field's own type instead of this one.
 */
export interface ProjectionType {
  kind: "Projection";
  record: RecordSchema;
  fields: readonly ProjectedField[];
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

/**
 * `search ... first`: one search row, or none. Mynt has no null, so an
 * optional value is its own type: nothing can be read from it directly,
 * and the ways to use one (an unwrapping form) are not in the language
 * yet. It is deliberately not a sequence: `limit 1` is a sequence of at
 * most one row, `first` is a single optional row, and the type says which.
 */
export interface OptionalType {
  kind: "Optional";
  element: RecordType | SummaryType;
}

/**
 * `Error`: the value a `catch` binds, a thrown JavaScript or NetSuite
 * error. Opaque except for `name` and `message`, which every runtime error
 * carries, and loggable as it is. Not a record, not comparable, not a
 * field type: it exists only inside `catch`.
 */
export type MyntType = FieldType | "Bool" | "Void" | "Error" | RecordType | SequenceType | SublistType | LineType | ReferenceType | ProjectionType | OptionalType | SummaryType;

/** The members an Error exposes, each a string. */
export const ERROR_MEMBERS: readonly string[] = ["name", "message"];

export function optionalType(element: RecordType | SummaryType): OptionalType {
  return { kind: "Optional", element };
}

export function isOptionalType(type: MyntType): type is OptionalType {
  return typeof type === "object" && type.kind === "Optional";
}

export function recordType(record: RecordSchema, origin: RecordOrigin): RecordType {
  return { kind: "Record", record, origin };
}

export function sequenceType(record: RecordSchema, source: RowOrigin = "query", exposes?: readonly ExposedField[]): SequenceType {
  const element = recordType(record, source);
  if (exposes) element.exposes = exposes;
  return { kind: "Sequence", element, source };
}

/** `Sequence<Summary<T>>`: the rows of a summary search. */
export function summarySequenceType(element: SummaryType): SequenceType {
  return { kind: "Sequence", element, source: "search" };
}

export function referenceType(record: RecordSchema, text = false): ReferenceType {
  return { kind: "Reference", record, text };
}

/** `Sequence<Ref<T>>`: the display references of a multiselect field, from a lookup. */
export function referenceSequenceType(record: RecordSchema): SequenceType {
  return { kind: "Sequence", element: referenceType(record, true), source: "lookup" };
}

export function projectionType(record: RecordSchema, fields: readonly ProjectedField[]): ProjectionType {
  return { kind: "Projection", record, fields };
}

/**
 * Where a field's value is being read from, which decides what a select
 * field yields:
 *
 *   record   a loaded, created, context, or parameter record (`getValue`):
 *            the id only, so an identity reference;
 *   query    a query row (`N/query` column): the id only, an identity;
 *   search   a search row: `getValue` and `getText` together, a display
 *            reference;
 *   lookup   `N/search.lookupFields`: value and text together, a display
 *            reference, or a sequence of them for a multiselect.
 */
export type FieldSource = "record" | "query" | "search" | "lookup";

/**
 * The Mynt type of a field's value when read from `source`. Scalars are
 * their field type. A select field whose target the schema names is a
 * reference; `text` follows the source. A multiselect is a sequence of
 * display references from a lookup and is not modeled from the other
 * sources yet, where it stays the inert `Ref`, as does any reference whose
 * target the schema does not name. Nothing here guesses a target.
 */
export function fieldValueType(field: FieldSchema, source: FieldSource, resolveRecord: (name: string) => RecordSchema | undefined): MyntType {
  if (field.type !== "Ref") return field.type;
  const target = field.refTarget ? resolveRecord(field.refTarget) : undefined;
  if (!target) return "Ref";
  if (field.selection === "multiple") return source === "lookup" ? referenceSequenceType(target) : "Ref";
  return referenceType(target, source === "lookup" || source === "search");
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
    return isSequenceType(a) && isSequenceType(b) && sameType(a.element, b.element);
  }
  if (isOptionalType(a) || isOptionalType(b)) {
    return isOptionalType(a) && isOptionalType(b) && sameType(a.element, b.element);
  }
  if (isSummaryType(a) || isSummaryType(b)) {
    // Two summary rows are one type when they expose the same result fields with the same meaning, in order.
    return (
      isSummaryType(a) &&
      isSummaryType(b) &&
      a.record === b.record &&
      a.fields.length === b.fields.length &&
      a.fields.every((f, i) => f.name === b.fields[i]!.name && f.summary === b.fields[i]!.summary && f.field === b.fields[i]!.field && f.join?.via === b.fields[i]!.join?.via)
    );
  }
  if (isReferenceType(a) || isReferenceType(b)) {
    // Identity and display references to one record type are one type; `text` is what the value carries, like a row's origin.
    return isReferenceType(a) && isReferenceType(b) && a.record === b.record;
  }
  if (isProjectionType(a) || isProjectionType(b)) {
    return (
      isProjectionType(a) &&
      isProjectionType(b) &&
      a.record === b.record &&
      a.fields.length === b.fields.length &&
      a.fields.every((field, index) => field.field === b.fields[index]!.field)
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
  if (isSequenceType(type)) return `Sequence<${typeName(type.element)}>`;
  if (isOptionalType(type)) return `${typeName(type.element)}?`;
  if (isSummaryType(type)) return `Summary<${type.record.name}>`;
  if (isReferenceType(type)) return `Ref<${type.record.name}>`;
  if (isProjectionType(type)) return `${type.record.name}[${type.fields.map((f) => f.field.id).join(", ")}]`;
  if (isSublistType(type)) return `Sublist<${sublistName(type)}>`;
  if (isLineType(type)) return `Line<${sublistName(type)}>`;
  return PRIMITIVE_SPELLING[type] ?? type;
}
