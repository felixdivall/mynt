/**
 * Mynt's value types as the binder sees them.
 *
 * Primitive field types are the schema's string names so they compare with
 * `===` and read naturally in tests. Record types carry their schema so field
 * access on any record-typed value (entry point parameter, loaded record)
 * goes through one path.
 */
import type { FieldType, RecordSchema, SublistSchema } from "../schema/types.js";

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
export type RecordOrigin = "context" | "owned" | "query" | "parameter";

export interface RecordType {
  kind: "Record";
  record: RecordSchema;
  origin: RecordOrigin;
}

/**
 * `Bool` is the type of a comparison and the only type an `if` condition may
 * have. There is no truthiness: a Text or Number value is never a condition.
 * It is not a FieldType yet because no schema field produces one; when
 * checkbox fields arrive it moves into FieldType unchanged.
 */
/** The result of a query: a materialized, re-iterable collection of query rows of one record type. */
export interface SequenceType {
  kind: "Sequence";
  element: RecordType;
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

export type MyntType = FieldType | "Bool" | "Void" | RecordType | SequenceType | SublistType | LineType;

export function recordType(record: RecordSchema, origin: RecordOrigin): RecordType {
  return { kind: "Record", record, origin };
}

export function sequenceType(record: RecordSchema): SequenceType {
  return { kind: "Sequence", element: recordType(record, "query") };
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
    return isSequenceType(a) && isSequenceType(b) && a.element.record === b.element.record;
  }
  if (typeof a === "object" || typeof b === "object") {
    return typeof a === "object" && typeof b === "object" && a.kind === b.kind && a.sublist === b.sublist && a.parent.record === b.parent.record;
  }
  return a === b;
}

/** How a type is spelled in diagnostics: `Text`, `Bool`, `Void`, `Customer`, `Sequence<Customer>`. */
export function typeName(type: MyntType): string {
  if (isRecordType(type)) return type.record.name;
  if (isSequenceType(type)) return `Sequence<${type.element.record.name}>`;
  if (isSublistType(type)) return `Sublist<${sublistName(type)}>`;
  if (isLineType(type)) return `Line<${sublistName(type)}>`;
  return type;
}
