/**
 * Bound program model: the resolved, type-checked form of a Mynt file.
 *
 * This is what the backend consumes. Names are gone; every reference points
 * at a schema object, a local symbol, or a built-in symbol. Every node keeps
 * its Span so diagnostics and future tooling can map back to source.
 */
import type { Span } from "../diagnostics.js";
import type { FieldSchema, FieldType, RecordSchema, SublistSchema } from "../schema/types.js";
import type { Builtin, NetSuiteModule } from "./builtins.js";
import type { SearchPredicate } from "./search.js";
import type { AggregateKind, MyntType, OptionalType, ProjectionType, RecordType, ReferenceType, ResultField, SequenceType, SublistType, SummaryType } from "./types.js";
import type { QueryOperation } from "../parser/ast.js";

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

/** NetSuite `context.UserEventType` members, in Mynt spelling. */
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
  type: MyntType;
  origin: "parameter" | "let" | "loop" | "catch";
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
  | TryCatch
  | LocalDeclaration
  | Destructure
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
  type: MyntType;
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

/**
 * `try { } catch err { } finally { }`: JavaScript's own construct. The
 * handler runs when the body throws, bound to a local of type Error (or
 * none); the finalizer runs either way. Absence of an optional value is
 * not a throw and never reaches the handler.
 */
export interface TryCatch {
  kind: "TryCatch";
  body: BoundStatement[];
  /** The caught error local, when written. */
  binding: LocalSymbol | undefined;
  handler: BoundStatement[] | undefined;
  finalizer: BoundStatement[] | undefined;
  span: Span;
}

export interface LocalDeclaration {
  kind: "LocalDeclaration";
  local: LocalSymbol;
  initializer: BoundExpression;
  span: Span;
}

/**
 * `let { email, comments: note } = value`: one evaluation of a structured
 * value (a projection), then one ordinary local per listed field. The
 * source field keeps its identity (`field`, `fieldSpan`) beside the local,
 * so a rename of the local never touches the schema name.
 */
export interface Destructure {
  kind: "Destructure";
  source: BoundExpression;
  record: RecordSchema;
  bindings: DestructureBinding[];
  span: Span;
}

export interface DestructureBinding {
  field: FieldSchema;
  fieldSpan: Span;
  local: LocalSymbol;
  /** Whether the local was named with `: name`; without it, `fieldSpan` is the local's declaration too. */
  aliased: boolean;
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
  | OptionalResolve
  | OptionalPresence
  | ErrorPropertyRead
  | ResultFieldRead
  | FileLoad
  | SelectedAggregate
  | AliasReference
  | BoundStringLiteral
  | BoundNumberLiteral
  | BoundBoolLiteral
  | LocalReference
  | FieldRead
  | JoinedFieldRead
  | SublistAccess
  | RecordIdRead
  | ReferenceTextRead
  | RecordReference
  | Lookup
  | QueryField
  | JoinedQueryField
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

/**
 * `value or return` / `value or { ... }`: an optional resolved where it
 * arises. `value` is evaluated once; if absent, `absence` runs, and since
 * it leaves the current control flow (the binder proves every path ends
 * in `return`), the expression's type is the inner, non-optional type.
 * Allowed as a `let` initializer, where the emitter can hoist the test.
 */
export interface OptionalResolve {
  kind: "OptionalResolve";
  value: BoundExpression;
  absence: BoundStatement[];
  type: RecordType | SummaryType;
  span: Span;
}

/** `if account { ... }` on an optional local: a presence test, not truthiness; the local is narrowed inside the branch. */
export interface OptionalPresence {
  kind: "OptionalPresence";
  reference: LocalReference;
  type: "Bool";
  span: Span;
}

/** `err.name` / `err.message` on a caught Error. */
export interface ErrorPropertyRead {
  kind: "ErrorPropertyRead";
  receiver: BoundExpression;
  property: "name" | "message";
  nameSpan: Span;
  type: "Text";
  span: Span;
}

/**
 * `customer.id` on a query or search row, or on a record reference: the
 * record's internal id, a language property rather than a schema field.
 * Always a string, whatever the reference was constructed from.
 */
export interface RecordIdRead {
  kind: "RecordIdRead";
  receiver: BoundExpression;
  nameSpan: Span;
  type: "Text";
  span: Span;
}

/**
 * `ref.text` on a display reference: the display text the backend supplied
 * with the id. Only a reference whose type says it carries text has this;
 * on an identity reference the binder reports it instead of fetching.
 */
export interface ReferenceTextRead {
  kind: "ReferenceTextRead";
  receiver: BoundExpression;
  nameSpan: Span;
  type: "Text";
  span: Span;
}

/**
 * `Customer(123)` / `Customer("123")`: a typed reference to one record. The
 * id is a number or string expression; the value performs no NetSuite work.
 * At runtime the reference is the id itself, as written, which every
 * N/search and N/record call that takes an id expects.
 */
export interface RecordReference {
  kind: "RecordReference";
  recordType: RecordTypeReference;
  id: BoundExpression;
  type: ReferenceType;
  span: Span;
}

/**
 * Where a projection's values come from, decided by the receiver's type:
 *
 *   lookupFields  a record reference: one `N/search.lookupFields` call
 *                 fetches exactly the projected columns, without loading;
 *   record        a loaded, created, context, or parameter record: local
 *                 `getValue` reads, no NetSuite call;
 *   row           a query or search row: local reads of columns the
 *                 backend already fetched, which the column planner adds.
 */
export type LookupSource = "lookupFields" | "record" | "row";

/** One projected field, where it is written, and the type its value has from this lookup's source. */
export interface LookupField {
  kind: "LookupField";
  field: FieldSchema;
  type: MyntType;
  span: Span;
}

/**
 * `receiver[field, ...]`, validated against the schema. One field yields
 * that field's value directly; several yield a projection holding exactly
 * those fields. Whatever the source, one projection is one fetch.
 */
export interface Lookup {
  kind: "Lookup";
  receiver: BoundExpression;
  record: RecordSchema;
  fields: LookupField[];
  source: LookupSource;
  /** One field: that field's value type. Several: the projection. */
  type: MyntType;
  /** The `lookup` word, when the operation was spelled out; the meaning is the same without it. */
  keywordSpan: Span | undefined;
  span: Span;
}

/** `load File(456)`: a File Cabinet file by internal id, an opaque File value. */
export interface FileLoad {
  kind: "FileLoad";
  id: BoundExpression;
  /** The `load` word. */
  operationSpan: Span;
  /** The `File` type name. */
  typeSpan: Span;
  type: "File";
  span: Span;
}

/**
 * One join hop: the select field the relationship goes through, and the
 * record type it reaches, both from the schema (`refTarget`, `selection:
 * single`). Predicates and planned columns share this, so a joined filter
 * and a joined column describe the relationship the same way.
 */
export interface JoinStep {
  via: FieldSchema;
  target: RecordSchema;
}

/**
 * `order.entity.email` on a search row: a field of the record the row's
 * select field refers to, fetched by the same search through a joined
 * column the planner adds. No record is loaded and nothing is looked up;
 * the receiver is the row's reference field read.
 */
export interface JoinedFieldRead {
  kind: "JoinedFieldRead";
  receiver: FieldRead;
  join: JoinStep;
  field: FieldSchema;
  fieldSpan: Span;
  type: MyntType;
  span: Span;
}

/** `entity.email` inside `search SalesOrder where ...`: a field of the referenced record, filtered through the join. */
export interface JoinedQueryField {
  kind: "JoinedQueryField";
  base: QueryField;
  join: JoinStep;
  field: FieldSchema;
  fieldSpan: Span;
  type: MyntType;
  span: Span;
}

/** A bare field name inside a query condition: `email` in `query Customer where email != ""`. A select field is a reference, as on a row. */
export interface QueryField {
  kind: "QueryField";
  record: RecordSchema;
  field: FieldSchema;
  type: MyntType;
  span: Span;
}

/**
 * A query condition in the backend's terms, derived from the type-checked
 * bound condition. Only shapes every backend can express exist here: a
 * field compared with a constant or a captured local, a Bool field, and
 * their combinations.
 */
export type QueryPredicate =
  | { kind: "Compare"; field: FieldSchema; join: JoinStep | undefined; operation: ComparisonOperation; value: QueryValue }
  /**
   * A select field compared with references by identity: `entity ==
   * Customer(123)`. The field refers to `record`, every operand refers to
   * the same record type, and only ids take part. `values` is a list so a
   * membership form (`entity in [...]`) is the same leaf with more values.
   */
  | { kind: "CompareReference"; field: FieldSchema; join: JoinStep | undefined; record: RecordSchema; operation: EqualityOperation; values: ReferenceOperand[] }
  | { kind: "Flag"; field: FieldSchema; join: JoinStep | undefined; value: boolean }
  | { kind: "And"; left: QueryPredicate; right: QueryPredicate }
  | { kind: "Or"; left: QueryPredicate; right: QueryPredicate }
  | { kind: "Not"; operand: QueryPredicate };

export type QueryValue = { kind: "Constant"; value: string | number | boolean } | { kind: "Local"; local: LocalSymbol };

/**
 * A reference in a predicate: `Customer(123)` or `Customer(n)`, carried as
 * its id, or a reference-typed local (identity or display; only its id is
 * used). Never a display text, never a reference object.
 */
export type ReferenceOperand = { kind: "Id"; value: QueryValue } | { kind: "Local"; local: LocalSymbol };

/**
 * Where a search's definition comes from: built here from the record type
 * and the predicate (`adHoc`), or loaded from an existing saved search by
 * its script id (`saved`), keeping that search's own filters and columns.
 * A query is always ad hoc.
 */
export type SearchSource =
  | { kind: "adHoc" }
  | {
      kind: "saved";
      id: BoundExpression;
      /** The `Search(id)` source. Not named `span`: the source is a property of the Query, not a node of its own. */
      clause: Span;
      /** The `Search` type name. */
      typeSpan: Span;
      /** Where the result record type came from: the account snapshot's saved-search metadata (the only source now). */
      recordFrom: "snapshot";
      /** The N/search type `search.load` must be passed, for a standalone search type the snapshot marks; undefined otherwise. */
      loadType: string | undefined;
    };

/**
 * `query Customer where ...` or `search Customer where ...`: an executed
 * query whose value is the materialized result. `condition` is the bound
 * expression as written, for tooling; `predicate` is the backend-neutral
 * form of it. For a search, `filter` is the predicate translated into
 * N/search terms, which the emitter lowers; a query lowers `predicate`
 * directly. Only the programmer's `operation` decides the backend, and
 * only `source` says whether a saved search is loaded first.
 */
export interface Query {
  kind: "Query";
  operation: QueryOperation;
  /** The operation word: `query`, `search`, or `load` for a saved search. */
  operationSpan: Span;
  source: SearchSource;
  recordType: RecordTypeReference;
  condition: BoundExpression | undefined;
  predicate: QueryPredicate | undefined;
  filter: SearchPredicate | undefined;
  /**
   * The `select` clause: the fields the rows expose, each a field of the
   * searched record or a field one join away, bound in the condition scope
   * so they are the same nodes a `where` uses. Undefined means the rows
   * expose every schema field and the planner fetches what is read.
   */
  select: (SelectedField | SelectedAggregate)[] | undefined;
  /** The `group by` clause, in key order: the summary buckets. Undefined when there is none. */
  groupBy: GroupKey[] | undefined;
  /** Summary mode: a `group by` clause, or an aggregate in `select`. The rows are then summary rows, never records. */
  summary: boolean;
  /** The `order by` clause, in key order. Undefined means the backend's own order (ad hoc: by internal id; saved: as defined). */
  orderBy: SortSpec[] | undefined;
  /** The `limit` clause: at most this many rows, a positive integer; the result stays a sequence. */
  limit: number | undefined;
  /** The `first` clause: the result is one optional row instead of a sequence. Never with `limit`. */
  first: boolean;
  type: SequenceType | OptionalType;
  span: Span;
}

export interface SelectedField {
  kind: "SelectedField";
  field: QueryField | JoinedQueryField;
  span: Span;
}

/**
 * `total = sum(amount)` in a `select`: an aggregate over a source field
 * (or over rows, for `count()`), exposed on the summary row under its
 * alias. The alias is a result name, never a schema field; `aliasSpan` is
 * its declaration for tooling.
 */
export interface SelectedAggregate {
  kind: "SelectedAggregate";
  alias: string;
  aliasSpan: Span;
  aggregate: AggregateKind;
  /** The aggregate name as written, for tooling. */
  functionSpan: Span;
  /** The source field; undefined for `count()`. */
  argument: QueryField | JoinedQueryField | undefined;
  /** The result field this item defines on the row. */
  result: ResultField;
  type: MyntType;
  span: Span;
}

/** `order by total`: a sort key naming a summary result (an aggregate alias) rather than a source field. */
export interface AliasReference {
  kind: "AliasReference";
  item: SelectedAggregate;
  type: MyntType;
  span: Span;
}

/** `group by entity`: one grouping field, a field of the record or one join away, bound in the condition scope like a `where` field. */
export interface GroupKey {
  kind: "GroupKey";
  field: QueryField | JoinedQueryField;
  span: Span;
}

export interface SortSpec {
  kind: "SortSpec";
  /** The sort key: a source field, or in a summary search a result name. */
  field: QueryField | JoinedQueryField | AliasReference;
  direction: "asc" | "desc";
  span: Span;
}

/** `row.total` on a summary row: an aggregate result read by its alias. Grouped fields read as FieldRead/JoinedFieldRead, like an ordinary row's. */
export interface ResultFieldRead {
  kind: "ResultFieldRead";
  receiver: BoundExpression;
  result: ResultField;
  nameSpan: Span;
  type: MyntType;
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

/**
 * `Equal`/`NotEqual` are the loose operators (`==`/`!=`, JavaScript's
 * abstract equality); `StrictEqual`/`StrictNotEqual` are `===`/`!==`. The
 * distinction is kept all the way into the backends: an ordinary
 * expression emits exactly the operator written, and a backend that has
 * no coercion decides per operand types whether the loose form is exact.
 */
export type EqualityOperation = "Equal" | "NotEqual" | "StrictEqual" | "StrictNotEqual";

export type ComparisonOperation = EqualityOperation | "Less" | "LessOrEqual" | "Greater" | "GreaterOrEqual";

export const EQUALITY_OPERATIONS: readonly EqualityOperation[] = ["Equal", "NotEqual", "StrictEqual", "StrictNotEqual"];

export function isEqualityOperation(operation: ComparisonOperation): operation is EqualityOperation {
  return (EQUALITY_OPERATIONS as readonly string[]).includes(operation);
}

/** Whether an equality operation asserts sameness (`==`, `===`) rather than difference. */
export function assertsEqual(operation: EqualityOperation): boolean {
  return operation === "Equal" || operation === "StrictEqual";
}

/** The loose or strict mode of an equality operation. */
export function equalityMode(operation: EqualityOperation): "loose" | "strict" {
  return operation === "Equal" || operation === "NotEqual" ? "loose" : "strict";
}

/**
 * A type-checked comparison. `operandType` is what the equality table
 * (equality.ts) found: one primitive on both sides, `Reference` for two
 * references to one record type (compared by id, equality only), or
 * `Mixed` for a loose comparison across primitive types, which runs as
 * JavaScript's abstract equality and which backends without coercion
 * refuse. Ordering is defined on Number only. The emitter only spells the
 * operation; it never decides whether two types compare.
 */
export interface Comparison {
  kind: "Comparison";
  operation: ComparisonOperation;
  operandType: "Text" | "Number" | "Bool" | "Reference" | "Mixed";
  left: BoundExpression;
  right: BoundExpression;
  type: "Bool";
  span: Span;
}

export interface LocalReference {
  kind: "LocalReference";
  local: LocalSymbol;
  type: MyntType;
  span: Span;
}

export interface FieldRead {
  kind: "FieldRead";
  /** A record-typed expression. */
  receiver: BoundExpression;
  field: FieldSchema;
  /** Where the field name is written. */
  fieldSpan: Span;
  /** The value's type: the field type, or a reference for a select field whose target the schema names. */
  type: MyntType;
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
 * That is part of Mynt's semantics, not an emitter detail, so built-ins
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
  type: MyntType;
  span: Span;
}
