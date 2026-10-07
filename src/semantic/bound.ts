/**
 * Bound program model: the resolved, type-checked form of a Sail file.
 *
 * This is what the backend consumes. Names are gone; every reference points
 * at a schema object, a local symbol, or a built-in symbol. Every node keeps
 * its Span so diagnostics and future tooling can map back to source.
 */
import type { Span } from "../diagnostics.js";
import type { FieldSchema, FieldType, RecordSchema, SublistSchema } from "../schema/types.js";
import type { Builtin, NetSuiteModule } from "./builtins.js";
import type { SailType, SequenceType, SublistType } from "./types.js";

export type ScriptUnit = UserEventUnit | ScheduledUnit;

interface ScriptUnitBase {
  file: string;
  /**
   * Every local the binder declared, with the source region in which its
   * name resolves to it. This is the binder's scoping, recorded rather than
   * recomputed, so editor features answer "what is `x` here?" the same way
   * the binder did.
   */
  symbols: readonly ScopedLocal[];
  /**
   * Every expression the binder bound, including ones inside statements
   * that failed to bind or parse completely. The bound tree is the
   * program; this table is the source-position index over it, and it is
   * what makes queries work on a half-typed line.
   */
  expressions: readonly BoundExpression[];
  /** Every sublist loop's line variable, by its symbol. */
  lineBindings: ReadonlyMap<LocalSymbol, LineBinding>;
  /** Top-level functions, in declaration order. */
  functions: readonly BoundFunction[];
  /**
   * NetSuite modules the program needs, inferred from the built-ins it binds.
   * The backend turns this into the `define([...])` dependency list.
   */
  dependencies: ReadonlySet<NetSuiteModule>;
  span: Span;
}

export interface UserEventUnit extends ScriptUnitBase {
  kind: "UserEvent";
  /** The record type every entry point in this file is bound to. */
  record: RecordSchema;
  entryPoints: BoundUserEventEntryPoint[];
}

export interface ScheduledUnit extends ScriptUnitBase {
  kind: "Scheduled";
  entryPoint: BoundScheduledEntryPoint;
}

export type UserEventHook = "beforeSubmit" | "afterSubmit";

/** NetSuite `context.UserEventType` members, in Sail spelling. */
export const USER_EVENT_TYPES = [
  "create",
  "edit",
  "view",
  "copy",
  "delete",
  "xedit",
  "approve",
  "cancel",
  "reject",
  "pack",
  "ship",
  "dropship",
  "specialorder",
  "orderitems",
  "paybills",
] as const;

export type UserEventType = (typeof USER_EVENT_TYPES)[number];

export interface ScopedLocal {
  local: LocalSymbol;
  /** From where the name becomes visible to the end of its block. */
  scope: Span;
}

/** A named, typed local: an entry point parameter or a `let` variable. */
export interface LocalSymbol {
  name: string;
  type: SailType;
  origin: "parameter" | "let" | "loop";
  declaredAt: Span;
}

export interface BoundUserEventEntryPoint {
  hook: UserEventHook;
  /** Empty means the handler runs for every event type. */
  events: UserEventType[];
  /** The local bound to `context.newRecord`. */
  parameter: LocalSymbol;
  /** The record type written after the parameter name. */
  parameterType: RecordTypeReference;
  body: BoundStatement[];
  span: Span;
}

export interface BoundScheduledEntryPoint {
  hook: "execute";
  body: BoundStatement[];
  span: Span;
}

export type BoundStatement =
  | LocalDeclaration
  | FieldWrite
  | SaveRecord
  | DeleteRecord
  | BoundIf
  | BoundForEach
  | RemoveLine
  | AddLine
  | BoundReturn
  | BoundExpressionStatement;

/** `return` / `return value`. In an entry point only the bare form is allowed. */
export interface BoundReturn {
  kind: "Return";
  value: BoundExpression | undefined;
  span: Span;
}

/**
 * A top-level function. Parameters are locals of the body; record
 * parameters have origin "parameter". The body is bound and analyzed once;
 * what it does to each record parameter is summarized by the lifecycle
 * analysis and applied at every call.
 */
export interface BoundFunction {
  kind: "Function";
  name: string;
  nameSpan: Span;
  parameters: LocalSymbol[];
  returnType: FieldType | "Bool" | "Void";
  body: BoundStatement[];
  span: Span;
}

/** A function named at a call site. */
export interface FunctionReference {
  kind: "FunctionReference";
  function: BoundFunction;
  span: Span;
}

export interface FunctionCall {
  kind: "FunctionCall";
  function: BoundFunction;
  callee: FunctionReference;
  arguments: BoundExpression[];
  type: SailType;
  span: Span;
}

/**
 * The line variable of a sublist loop, the record local whose sublist it
 * iterates, and the sublist. One object per loop, shared by the binder,
 * the lifecycle analysis (the parent owns every line mutation), and the
 * emitter (reads and writes go through the parent by index). The runtime
 * index itself is the emitter's business.
 */
export interface LineBinding {
  line: LocalSymbol;
  parent: LocalSymbol;
  sublist: SublistSchema;
}

/** `remove line`: removes the line from its parent's sublist. The line is consumed; the parent is modified. */
export interface RemoveLine {
  kind: "RemoveLine";
  line: LocalReference;
  binding: LineBinding;
  span: Span;
}

/**
 * `add order.item { quantity = 2 }`: appends a line to the sublist of a
 * named record, initialized from the block. A mutation of the parent, with
 * no line value of its own.
 */
export interface AddLine {
  kind: "AddLine";
  target: SublistAccess;
  /** The record local that owns the sublist. */
  parent: LocalSymbol;
  initializers: LineInitializer[];
  span: Span;
}

export interface LineInitializer {
  kind: "LineInitializer";
  field: FieldSchema;
  fieldSpan: Span;
  value: BoundExpression;
  span: Span;
}

/**
 * `for customer in customers { ... }` over a Sequence, or
 * `for line in order.item { ... }` over a sublist. The loop variable is a
 * local scoped to the body: a query row, or a line of the sublist.
 */
export interface BoundForEach {
  kind: "ForEach";
  local: LocalSymbol;
  iterable: BoundExpression;
  /** Set when iterating a sublist: the loop variable is a line of it. */
  line: LineBinding | undefined;
  body: BoundStatement[];
  span: Span;
}

/**
 * `delete customer`: the target is a named, owned record. Whether it is
 * persisted and not yet deleted on every path is the lifecycle analysis's
 * question, not the binder's.
 */
export interface DeleteRecord {
  kind: "DeleteRecord";
  target: LocalReference;
  span: Span;
}

/**
 * `if cond { ... } else { ... }`. The condition is already known to be Bool.
 * Each branch is its own lexical scope; locals declared inside do not
 * escape. `elseBody` is undefined when there is no else block, which the
 * analysis treats as an empty branch.
 */
export interface BoundIf {
  kind: "If";
  condition: BoundExpression;
  thenBody: BoundStatement[];
  elseBody: BoundStatement[] | undefined;
  span: Span;
}

export interface LocalDeclaration {
  kind: "LocalDeclaration";
  local: LocalSymbol;
  initializer: BoundExpression;
  span: Span;
}

export interface FieldWrite {
  kind: "FieldWrite";
  /** A record-typed local (entry point parameter or owned record), or a line local whose parent owns the write. */
  receiver: LocalReference;
  field: FieldSchema;
  /** Where the field name is written. */
  fieldSpan: Span;
  value: BoundExpression;
  span: Span;
}

/**
 * `save customer`, already validated: the target is a record value whose
 * origin permits explicit persistence. Statement-only for now; NetSuite's
 * returned internal id is discarded. Exposing it later means giving this
 * node a `type` and letting it appear as a BoundExpression.
 */
export interface SaveRecord {
  kind: "SaveRecord";
  target: BoundExpression;
  span: Span;
}

/** An expression evaluated for its effect: a built-in or function call. */
export interface BoundExpressionStatement {
  kind: "ExpressionStatement";
  expression: BuiltinCall | FunctionCall;
  span: Span;
}

export type BoundExpression =
  | BoundStringLiteral
  | BoundNumberLiteral
  | BoundBoolLiteral
  | LocalReference
  | FieldRead
  | SublistAccess
  | RecordIdRead
  | QueryField
  | Query
  | BuiltinCall
  | FunctionCall
  | Comparison
  | Logical
  | Not;

/**
 * `order.item`: a sublist of a record value. Only a `for` may consume it,
 * and only on a named record, so that every line read or write knows the
 * parent local that owns its persistence.
 */
export interface SublistAccess {
  kind: "SublistAccess";
  receiver: BoundExpression;
  sublist: SublistSchema;
  nameSpan: Span;
  type: SublistType;
  span: Span;
}

/** `customer.id` on a query row: the record's internal id, a language property rather than a schema field. */
export interface RecordIdRead {
  kind: "RecordIdRead";
  receiver: BoundExpression;
  nameSpan: Span;
  type: "Text";
  span: Span;
}

/** A bare field name inside a query condition: `email` in `query Customer where email != ""`. */
export interface QueryField {
  kind: "QueryField";
  record: RecordSchema;
  field: FieldSchema;
  type: FieldType;
  span: Span;
}

/**
 * A query condition in the backend's terms, derived from the type-checked
 * bound condition. Only shapes every backend can express exist here: a
 * field compared with a constant or a captured local, a Bool field, and
 * their combinations.
 */
export type QueryPredicate =
  | { kind: "Compare"; field: FieldSchema; operation: ComparisonOperation; value: QueryValue }
  | { kind: "Flag"; field: FieldSchema; value: boolean }
  | { kind: "And"; left: QueryPredicate; right: QueryPredicate }
  | { kind: "Or"; left: QueryPredicate; right: QueryPredicate }
  | { kind: "Not"; operand: QueryPredicate };

export type QueryValue = { kind: "Constant"; value: string | number | boolean } | { kind: "Local"; local: LocalSymbol };

/**
 * `query Customer where ...`: an executed query whose value is the
 * materialized result. `condition` is the bound expression as written, for
 * tooling; `predicate` is what the backend lowers.
 */
export interface Query {
  kind: "Query";
  recordType: RecordTypeReference;
  condition: BoundExpression | undefined;
  predicate: QueryPredicate | undefined;
  type: SequenceType;
  span: Span;
}

export interface BoundStringLiteral {
  kind: "StringLiteral";
  value: string;
  type: "Text";
  span: Span;
}

export interface BoundNumberLiteral {
  kind: "NumberLiteral";
  value: number;
  type: "Number";
  span: Span;
}

export interface BoundBoolLiteral {
  kind: "BoolLiteral";
  value: boolean;
  type: "Bool";
  span: Span;
}

export type ComparisonOperation = "Equal" | "NotEqual" | "Less" | "LessOrEqual" | "Greater" | "GreaterOrEqual";

/**
 * A type-checked comparison. Both operands have `operandType`, and the
 * operation is defined for that type (ordering only on Number). The emitter
 * only spells the operation; it never decides whether two types compare.
 */
export interface Comparison {
  kind: "Comparison";
  operation: ComparisonOperation;
  operandType: "Text" | "Number";
  left: BoundExpression;
  right: BoundExpression;
  type: "Bool";
  span: Span;
}

export interface LocalReference {
  kind: "LocalReference";
  local: LocalSymbol;
  type: SailType;
  span: Span;
}

export interface FieldRead {
  kind: "FieldRead";
  /** A record-typed expression. */
  receiver: BoundExpression;
  field: FieldSchema;
  /** Where the field name is written. */
  fieldSpan: Span;
  type: FieldType;
  span: Span;
}

/** A built-in named in source: `load`, or `log.debug` with its namespace. */
export interface BuiltinReference {
  kind: "BuiltinReference";
  builtin: Builtin;
  /** The member or root name: `debug`, `load`. */
  nameSpan: Span;
  /** The namespace name, for members: `log`. */
  namespaceSpan: Span | undefined;
  /** The whole callee: `log.debug`. */
  span: Span;
}

/** A record type named in source: the `Customer` in `load Customer(...)` or `(c: Customer)`. */
export interface RecordTypeReference {
  kind: "RecordTypeReference";
  record: RecordSchema;
  span: Span;
}

/**
 * `a && b` / `a || b` on Bool operands. Both are short-circuiting: the right
 * operand is evaluated only when the left one does not decide the result.
 * That is part of Sail's semantics, not an emitter detail, so built-ins
 * with effects may rely on it once they can appear in expressions.
 */
export interface Logical {
  kind: "Logical";
  operation: "And" | "Or";
  left: BoundExpression;
  right: BoundExpression;
  type: "Bool";
  span: Span;
}

/** `!a` on a Bool operand. */
export interface Not {
  kind: "Not";
  operand: BoundExpression;
  type: "Bool";
  span: Span;
}

export interface BuiltinCall {
  kind: "BuiltinCall";
  builtin: Builtin;
  callee: BuiltinReference;
  /** The record type written after the callee, when the built-in takes one. */
  recordType: RecordTypeReference | undefined;
  /** The record type written after `to`, for operations with a target. */
  targetType: RecordTypeReference | undefined;
  arguments: BoundExpression[];
  type: SailType;
  span: Span;
}
