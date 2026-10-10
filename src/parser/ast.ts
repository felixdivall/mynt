/**
 * Syntax tree. Nodes are purely syntactic: names are unresolved strings and
 * nothing here knows about the schema or built-ins. Every node carries a Span.
 */
import type { Span } from "../diagnostics.js";

export interface SourceFile {
  kind: "SourceFile";
  file: string;
  declarations: Declaration[];
  span: Span;
}

export type Declaration = UserEventDeclaration | ScheduledDeclaration | FunctionDeclaration;

/**
 *   fn cleanOrder(order: SalesOrder) { ... }
 *   fn isBulk(quantity: number): boolean { ... }
 *
 * Parameter and return types are names the binder resolves: string, number,
 * boolean, or a record type for parameters; string, number, or boolean for
 * returns. The parser reserves the three builtin names at declaration sites.
 */
export interface FunctionDeclaration {
  kind: "FunctionDeclaration";
  keywordSpan: Span;
  name: Identifier;
  parameters: Parameter[];
  returnType: Identifier | undefined;
  body: Block;
  span: Span;
}

export type UserEventHook = "beforeSubmit" | "afterSubmit";

export const USER_EVENT_HOOKS: readonly UserEventHook[] = ["beforeSubmit", "afterSubmit"];

/** Identifiers that begin a top-level declaration. Contextual, not lexical keywords. */
export const DECLARATION_KEYWORDS: readonly string[] = [...USER_EVENT_HOOKS, "scheduled", "fn"];

/**
 *   beforeSubmit create | edit (customer: Customer) { ... }
 */
export interface UserEventDeclaration {
  kind: "UserEventDeclaration";
  hook: UserEventHook;
  hookSpan: Span;
  /** Event filter, e.g. `create | edit`. Empty means "all events". */
  events: Identifier[];
  parameter: Parameter;
  body: Block;
  span: Span;
}

/**
 *   scheduled { ... }
 */
export interface ScheduledDeclaration {
  kind: "ScheduledDeclaration";
  keywordSpan: Span;
  body: Block;
  span: Span;
}

export interface Parameter {
  kind: "Parameter";
  name: Identifier;
  /** The record type name, e.g. `Customer`. Also the deployment target. */
  type: Identifier;
  span: Span;
}

export interface Block {
  kind: "Block";
  statements: Statement[];
  span: Span;
}

export type Statement =
  | TryStatement
  | LetStatement
  | SaveStatement
  | DeleteStatement
  | IfStatement
  | ForStatement
  | RemoveStatement
  | AddStatement
  | ReturnStatement
  | AssignmentStatement
  | ExpressionStatement;

/**
 *   try { ... } catch err { ... } finally { ... }
 *
 * Recovery from a thrown runtime error, lowered to JavaScript's own
 * try/catch. `catch` (with or without a binding) and `finally` follow the
 * closing `}` on the same line, like `else`. At least one of them is
 * required; a bare `try` is an error. Absence (`T?`) never enters `catch`:
 * that is `or`'s business.
 */
export interface TryStatement {
  kind: "TryStatement";
  keywordSpan: Span;
  body: Block;
  catchSpan: Span | undefined;
  /** The error local, or undefined for `catch { ... }`. */
  binding: Identifier | undefined;
  handler: Block | undefined;
  finallySpan: Span | undefined;
  finalizer: Block | undefined;
  span: Span;
}

/**
 *   let account = search Account first
 *       or return
 *   let account = search Account first
 *       or { log.error("missing"); return }
 *
 * Resolution of an optional value at the point it arises: the value if
 * present, else the branch, which must leave the current control flow, so
 * the binding is the non-optional type. `or` is contextual (a local may be
 * named `or`) and belongs to the expression, not to a search: it reads
 * past one newline so it can follow a search's last clause, and it is
 * taken only when `return` or `{` follows it. `or return` is a one-return
 * block. Not boolean or, which stays `||`.
 */
export interface OrExpression {
  kind: "OrExpression";
  value: Expression;
  orSpan: Span;
  branch: Block;
  span: Span;
}

/** `return` or `return expression`. `return` always begins a statement. */
export interface ReturnStatement {
  kind: "ReturnStatement";
  keywordSpan: Span;
  value: Expression | undefined;
  span: Span;
}

/**
 *   remove line
 *
 * Contextual like `save`. The binder requires a sublist line from an
 * enclosing loop; the lifecycle analysis then treats the line as consumed.
 */
export interface RemoveStatement {
  kind: "RemoveStatement";
  keywordSpan: Span;
  target: Expression;
  span: Span;
}

/**
 *   add order.item {
 *       quantity = 2
 *   }
 *
 * Contextual. The block is parsed with the ordinary statement parser; the
 * binder requires each statement to be `field = expression`, with bare
 * names on the left denoting the sublist's fields.
 */
export interface AddStatement {
  kind: "AddStatement";
  keywordSpan: Span;
  target: Expression;
  body: Block;
  span: Span;
}

/**
 *   for customer in customers { ... }
 *
 * `for` and `in` are contextual. The loop variable is scoped to the body.
 */
export interface ForStatement {
  kind: "ForStatement";
  keywordSpan: Span;
  variable: Identifier;
  inSpan: Span;
  iterable: Expression;
  body: Block;
  span: Span;
}

/**
 *   delete customer
 *
 * Contextual like `save`. The binder requires a named, owned record that the
 * lifecycle analysis can prove persisted and not yet deleted.
 */
export interface DeleteStatement {
  kind: "DeleteStatement";
  keywordSpan: Span;
  target: Expression;
  span: Span;
}

/**
 *   if customer.email == "" { ... } else { ... }
 *
 * `if` and `else` are contextual. The condition is a bare expression (no
 * parentheses) and `else` must follow the closing `}` on the same line,
 * because a newline after `}` ends the statement. There is no `else if`
 * production; an `if` nested inside `else { }` expresses the same thing.
 */
export interface IfStatement {
  kind: "IfStatement";
  keywordSpan: Span;
  condition: Expression;
  thenBlock: Block;
  elseSpan: Span | undefined;
  elseBlock: Block | undefined;
  span: Span;
}

/**
 *   save customer
 *
 * A language-level persistence operation. `save` is contextual: it begins a
 * statement only when it is not itself used as an expression (`save.x`,
 * `save(...)`, `save = ...`). The target is any expression; the binder
 * requires it to be a saveable record.
 */
export interface SaveStatement {
  kind: "SaveStatement";
  keywordSpan: Span;
  target: Expression;
  span: Span;
}

/**
 *   let customer = load Customer(123)
 *
 * The initializer is mandatory for now; a type annotation slot can be added
 * between the name and `=` later without disturbing this shape.
 */
export interface LetStatement {
  kind: "LetStatement";
  keywordSpan: Span;
  name: Identifier;
  initializer: Expression;
  span: Span;
}

export interface AssignmentStatement {
  kind: "AssignmentStatement";
  target: Expression;
  value: Expression;
  span: Span;
}

export interface ExpressionStatement {
  kind: "ExpressionStatement";
  expression: Expression;
  span: Span;
}

export type Expression =
  | OrExpression
  | Identifier
  | MemberExpression
  | CallExpression
  | ProjectionExpression
  | QueryExpression
  | BinaryExpression
  | UnaryExpression
  | StringLiteral
  | NumberLiteral
  | BoolLiteral;

/**
 *   Customer(123)[email]
 *   customer[email, comments]
 *
 * A field projection: the fields named inside the brackets, read from the
 * receiver. Fields are schema field names, written bare, never strings or
 * arbitrary expressions, and at least one is required. This is the only
 * bracket syntax in Mynt: there is no indexing, so `rows[0]` is an error.
 * Whether the projection is a remote lookup or a local read depends on the
 * receiver's type, which the binder decides.
 */
export interface ProjectionExpression {
  kind: "ProjectionExpression";
  receiver: Expression;
  fields: Identifier[];
  /** The `[`. */
  openSpan: Span;
  /** The `]`, or undefined while the projection is still being typed. */
  closeSpan: Span | undefined;
  span: Span;
}

/** The NetSuite backend a `query`/`search` expression targets. The programmer chooses; the compiler never picks. */
export type QueryOperation = "query" | "search";

/**
 * One clause of a search, after its source. Each is contextual syntax:
 * `where`, `select`, `order by`, `take` begin a clause only there, and a
 * line that begins with one of them continues the search.
 *
 *   where <condition>                   the filter
 *   select <field>, <field>.<field>     the fields the rows expose (schema fields, one join hop)
 *   order by <field> [asc|desc], ...    the sort keys (a result name in a summary search)
 *   group by <field>, ...               the summary buckets; with aggregates in select, a summary search
 *   limit <count>                       at most this many rows, still a sequence
 *   first                               one optional row: the first, or none
 *
 * `select` items and sort keys are expressions, so an aggregate can be an
 * item later; today the binder accepts a field or a joined field.
 */
export type SearchClause = WhereClause | SelectClause | OrderByClause | GroupByClause | LimitClause | FirstClause;

export interface WhereClause {
  kind: "WhereClause";
  keywordSpan: Span;
  condition: Expression;
  span: Span;
}

export interface SelectClause {
  kind: "SelectClause";
  keywordSpan: Span;
  items: SelectItem[];
  span: Span;
}

/**
 * One `select` item: a field (`tranid`, `entity.email`), or a named
 * aggregate (`total = sum(amount)`). Only an aggregate takes a name, which
 * becomes the result field; a plain field is exposed under its own name.
 * The parser keeps a name on a field, or an unnamed aggregate, so the
 * binder can report it precisely.
 */
export interface SelectItem {
  kind: "SelectItem";
  /** The result name, for `name = ...`. */
  alias: Identifier | undefined;
  equalsSpan: Span | undefined;
  value: Expression | AggregateCall;
  span: Span;
}

/**
 * `sum(amount)`, `count()`, `max(entity.creditlimit)`: an aggregate over a
 * source field, written only as a `select` item's value. Not an
 * expression: the aggregate names are contextual to `select`, so a
 * function named `sum` is still a function everywhere else.
 */
export interface AggregateCall {
  kind: "AggregateCall";
  function: Identifier;
  /** The field aggregated; undefined for `count()`, which counts rows. */
  argument: Expression | undefined;
  closeSpan: Span | undefined;
  span: Span;
}

/** The aggregate names `select` recognizes before `(`. */
export const AGGREGATE_FUNCTIONS: readonly string[] = ["sum", "count", "min", "max", "avg"];

/** `group by <field>, ...`: the fields that define the summary buckets. */
export interface GroupByClause {
  kind: "GroupByClause";
  /** `group`. */
  keywordSpan: Span;
  /** `by`, or undefined while being typed. */
  bySpan: Span | undefined;
  fields: Expression[];
  span: Span;
}

export interface OrderByClause {
  kind: "OrderByClause";
  /** `order`. */
  keywordSpan: Span;
  /** `by`, or undefined while being typed. */
  bySpan: Span | undefined;
  keys: SortKey[];
  span: Span;
}

export interface SortKey {
  kind: "SortKey";
  field: Expression;
  direction: "asc" | "desc" | undefined;
  directionSpan: Span | undefined;
  span: Span;
}

/** `limit <count>`: at most this many rows; the result stays a sequence, even for `limit 1`. */
export interface LimitClause {
  kind: "LimitClause";
  keywordSpan: Span;
  /** Undefined while being typed. */
  count: Expression | undefined;
  span: Span;
}

/** `first`: the first row under the effective ordering, or none; the result is one optional row, not a sequence. */
export interface FirstClause {
  kind: "FirstClause";
  keywordSpan: Span;
  span: Span;
}

/** The words that begin a search clause. Contextual: identifiers anywhere else. `take` is recognized only to point at `limit`. */
export const SEARCH_CLAUSE_KEYWORDS: readonly string[] = ["where", "select", "order", "group", "limit", "first", "take"];

/** `saved "customsearch_x"` / `saved Customer "customsearch_x"`: the modifier and the id expression (a string or a name; undefined while being typed). A node, so tooling walks into the id. */
export interface SavedSearchClause {
  kind: "SavedSearchClause";
  keywordSpan: Span;
  id: Expression | undefined;
  span: Span;
}

export const QUERY_OPERATIONS: readonly QueryOperation[] = ["query", "search"];

/**
 *   query Customer
 *       where email != "" && isperson
 *   search Customer
 *       where email != ""
 *
 *   search saved "customsearch_active_customers"
 *       where email !== ""
 *   search saved SystemNote "customsearch_system_notes"
 *
 * `query`, `search`, `saved`, and `where` are contextual. Inside the
 * condition, bare names are the record's fields. A `where` may begin the
 * next line. The two operations share one syntax and differ only in
 * backend: `query` lowers to `N/query`, `search` to `N/search`.
 *
 * `search T` builds a new search, so it names the record type. `search
 * saved id` loads an existing saved search, which already has a type: the
 * record type is omitted and inferred from the account snapshot, and is
 * written only when the snapshot cannot say (an unknown or dynamic id) or
 * to assert it. `saved` is a modifier of `search`, recognized only there.
 */
export interface QueryExpression {
  kind: "QueryExpression";
  operation: QueryOperation;
  keywordSpan: Span;
  /** The record type written: required for an ad-hoc search, optional for a saved one. */
  recordType: Identifier | undefined;
  /** The `saved` clause, for a saved search. */
  saved: SavedSearchClause | undefined;
  /**
   * The search clauses, in source order. They describe one search, so
   * their order carries no meaning; the binder normalizes them and reports
   * a singleton clause written twice. `whereSpan`/`condition` below are
   * the `where` clause, kept directly for the tooling that reads them.
   */
  clauses: SearchClause[];
  whereSpan: Span | undefined;
  condition: Expression | undefined;
  span: Span;
}

export type BinaryOperator = "==" | "!=" | "===" | "!==" | "<" | "<=" | ">" | ">=" | "&&" | "||";

/**
 *   customer.email === ""
 *   a == "" || b == ""
 *
 * The operator is the source spelling; the binder decides what it means for
 * the operand types. `==`/`!=` are JavaScript's loose equality and
 * `===`/`!==` its strict one, and each is emitted as written. Parentheses do
 * not produce a node: `(a || b) && c` is a BinaryExpression whose left
 * operand is the `||` node, with its span widened to include the parens.
 */
export interface BinaryExpression {
  kind: "BinaryExpression";
  operator: BinaryOperator;
  operatorSpan: Span;
  left: Expression;
  right: Expression;
  span: Span;
}

export interface Identifier {
  kind: "Identifier";
  name: string;
  span: Span;
}

export interface MemberExpression {
  kind: "MemberExpression";
  object: Expression;
  property: Identifier;
  span: Span;
}

/**
 *   log.debug("x")          callee log.debug, no type argument
 *   load Customer(123)    callee load, type argument Customer
 *
 * A type argument is an identifier written between the callee and the
 * argument list. Syntactically it is just a name; the binder decides that it
 * must denote a record type.
 */
export interface CallExpression {
  kind: "CallExpression";
  callee: Expression;
  typeArgument: Identifier | undefined;
  arguments: Expression[];
  /** `transform SalesOrder("1") to Invoice`: the record type after `to`. */
  targetType: Identifier | undefined;
  toSpan: Span | undefined;
  span: Span;
}

/**
 *   !(customer.email == "")
 */
export interface UnaryExpression {
  kind: "UnaryExpression";
  operator: "!";
  operatorSpan: Span;
  operand: Expression;
  span: Span;
}

export interface StringLiteral {
  kind: "StringLiteral";
  value: string;
  span: Span;
}

export interface NumberLiteral {
  kind: "NumberLiteral";
  value: number;
  span: Span;
}

/** `true` or `false`. Literals wherever an expression is expected; they cannot name a local. */
export interface BoolLiteral {
  kind: "BoolLiteral";
  value: boolean;
  span: Span;
}

export const BOOL_LITERALS: readonly string[] = ["true", "false"];
