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
 *   let customer = load Customer("123")
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

export const QUERY_OPERATIONS: readonly QueryOperation[] = ["query", "search"];

/**
 *   query Customer
 *       where email != "" && isperson
 *   search Customer
 *       where email != ""
 *
 * `query`, `search`, and `where` are contextual. Inside the condition, bare
 * names are the record's fields. A `where` may begin the next line. The two
 * operations share one syntax and differ only in backend: `query` lowers to
 * `N/query`, `search` to `N/search`.
 */
export interface QueryExpression {
  kind: "QueryExpression";
  operation: QueryOperation;
  keywordSpan: Span;
  recordType: Identifier;
  whereSpan: Span | undefined;
  condition: Expression | undefined;
  span: Span;
}

export type BinaryOperator = "==" | "!=" | "<" | "<=" | ">" | ">=" | "&&" | "||";

/**
 *   customer.email == ""
 *   a == "" || b == ""
 *
 * The operator is the source spelling; the binder decides what it means for
 * the operand types (and the emitter spells `==` as `===`). Parentheses do
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
 *   load Customer("123")    callee load, type argument Customer
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
