import { DiagnosticBag, DiagnosticCode, spanFrom, type Span } from "../diagnostics.js";
import type {
  AddStatement,
  BinaryExpression,
  BinaryOperator,
  Block,
  CallExpression,
  Declaration,
  DeleteStatement,
  Expression,
  ForStatement,
  FunctionDeclaration,
  Identifier,
  IfStatement,
  LetStatement,
  MemberExpression,
  OrExpression,
  ProjectionExpression,
  QueryExpression,
  QueryOperation,
  SelectItem,
  AggregateCall,
  LookupExpression,
  ObjectPattern,
  ProjectionExpression as ProjectionSyntax,
  RemoveStatement,
  SearchClause,
  TryStatement,
  ReturnStatement,
  SaveStatement,
  ScheduledDeclaration,
  SourceFile,
  Statement,
  UnaryExpression,
  UserEventDeclaration,
} from "../parser/ast.js";
import type { SchemaProvider } from "../schema/provider.js";
import type { FieldSchema, RecordSchema, SublistSchema } from "../schema/types.js";
import {
  acceptsArgument,
  builtinRootNames,
  parameterTypeName,
  resolveBuiltinRoot,
  type Builtin,
  type BuiltinNamespace,
  type BuiltinSymbol,
  type NetSuiteModule,
} from "./builtins.js";
import {
  USER_EVENT_TYPES,
  type BoundExpression,
  type BoundFunction,
  type BoundStatement,
  type BoundUserEventEntryPoint,
  type BuiltinCall,
  type BuiltinReference,
  type Comparison,
  type FunctionCall,
  type JoinedFieldRead,
  type JoinedQueryField,
  type JoinStep,
  type LineBinding,
  type QueryField,
  type SelectedField,
  type SelectedAggregate,
  type AliasReference,
  type GroupKey,
  type SortSpec,
  type LineInitializer,
  type ComparisonOperation,
  type EqualityOperation,
  assertsEqual,
  equalityMode,
  isEqualityOperation,
  type LocalSymbol,
  type Logical,
  type Lookup,
  type Destructure,
  type DestructureBinding,
  type FileLoad,
  type OptionalResolve,
  type LookupField,
  type LookupSource,
  type Query,
  type QueryPredicate,
  type SublistAccess,
  type QueryValue,
  type ReferenceOperand,
  type RecordReference,
  type RecordTypeReference,
  type ScopedLocal,
  type ScriptUnit,
  type UserEventType,
} from "./bound.js";
import { equalityOf, equalityOperators } from "./equality.js";
import { isPlatformTypeName, loadKindOf, platformType } from "./loadable.js";
import { toSearchPredicate } from "./search.js";
import { suggest } from "./suggest.js";
import {
  fieldValueType,
  isLineType,
  isOptionalType,
  isProjectionType,
  isRecordType,
  isReferenceType,
  isRowOrigin,
  isRowRecord,
  isSequenceType,
  isSublistType,
  PRIMITIVE_TYPE_NAMES,
  primitiveTypeNamed,
  optionalType,
  projectionType,
  recordType as makeRecordType,
  referenceType,
  rowLabel,
  sameType,
  sequenceType,
  sublistName,
  sublistType,
  exposesField,
  exposesJoinedField,
  exposesRelationship,
  type ExposedField,
  type FieldSource,
  type AggregateKind,
  type ResultField,
  type SummaryType,
  isAggregateKind,
  isSummaryType,
  isRowLike,
  summaryType,
  summarySequenceType,
  summaryField,
  summaryAggregate,
  summaryJoinedField,
  summaryExposesRelationship,
  summaryMemberNames,
  summaryResultNames,
  type LineType,
  type MyntType,
  type ProjectionType,
  type RecordType,
  type ReferenceType,
  typeName,
} from "./types.js";
import type { FieldType } from "../schema/types.js";

/**
 * The binder turns a SourceFile into a ScriptUnit, resolving every name
 * against the schema, the built-in registry, and the lexical scope, and
 * reporting semantic errors. It never throws on user errors: it reports
 * them and keeps going so one file yields all its errors.
 *
 * Returns undefined when the file cannot form a script unit at all (no entry
 * points, unknown record type, disagreeing record types).
 */
export function bind(
  file: SourceFile,
  schema: SchemaProvider,
  diagnostics: DiagnosticBag,
): ScriptUnit | undefined {
  return new Binder(schema, diagnostics).bindFile(file);
}

/**
 * What an expression denotes. Only `value` is a first-class value (and a
 * value may be record-typed); the others exist so member access, calls, and
 * type-argument positions can see through them.
 */
type Denotation =
  | { kind: "value"; type: MyntType; bound: BoundExpression }
  | { kind: "recordType"; record: RecordSchema }
  | { kind: "namespace"; namespace: BuiltinNamespace; span: Span }
  | { kind: "builtin"; builtin: Builtin; reference: BuiltinReference }
  | { kind: "function"; function: BoundFunction; span: Span };

/**
 * Lexical scope for locals: one per entry point body, plus one per `if` or
 * `else` block. Blocks see their enclosing locals; a local declared in a
 * block is gone after it. Shadowing is not allowed: a name means one thing
 * throughout an entry point.
 */
class Scope {
  private readonly locals = new Map<string, LocalSymbol>();
  /** Locals whose optional type is known to be present here (`if account { ... }`, or after an `if` whose absence branch left). */
  private readonly narrowed = new Map<LocalSymbol, MyntType>();

  constructor(
    /** Entry point hook, for context-dependent checks such as afterSubmit writes; "function" inside a function body. */
    readonly hook: "beforeSubmit" | "afterSubmit" | "execute" | "function",
    /** The block this scope covers; locals declared here are visible until its end. */
    readonly span: Span,
    private readonly parent?: Scope,
    /** Inside a query condition: the record whose fields bare names denote. */
    readonly queryRecord?: RecordSchema,
    /** Inside a query condition: which backend reads the fields, for their value types. */
    readonly querySource?: "query" | "search",
    /** Inside a sublist loop body: the line being iterated. */
    readonly iterating?: LineBinding,
    /** What `return` may carry: a function's declared type, or Void in an entry point. */
    readonly returns: MyntType | "Void" = "Void",
    /** The function whose body this scope belongs to, for messages. */
    readonly functionName?: string,
    /** Inside a search's source positions (`where`, `group by`, an aggregate's argument): the result names its `select` declares, which are not source names. */
    readonly resultNames?: ReadonlyMap<string, Span>,
  ) {}

  child(block: Block, iterating?: LineBinding): Scope {
    return new Scope(this.hook, block.span, this, undefined, undefined, iterating, this.returns, this.functionName);
  }

  /** Whether `parent.sublist` is being iterated by this scope or an enclosing one. */
  isIterating(parent: LocalSymbol, sublist: SublistSchema): boolean {
    if (this.iterating && this.iterating.parent === parent && this.iterating.sublist === sublist) return true;
    return this.parent?.isIterating(parent, sublist) ?? false;
  }

  /** The scope of a query condition: the enclosing scope plus the record's fields. */
  conditionScope(record: RecordSchema, span: Span, source: "query" | "search", resultNames?: ReadonlyMap<string, Span>): Scope {
    return new Scope(this.hook, span, this, record, source, undefined, this.returns, this.functionName, resultNames);
  }

  lookup(name: string): LocalSymbol | undefined {
    return this.locals.get(name) ?? this.parent?.lookup(name);
  }

  /** The type `local` has here: its narrowed type if a presence test proved it, else its declared type. */
  typeOf(local: LocalSymbol): MyntType {
    return this.narrowed.get(local) ?? this.parent?.typeOf(local) ?? local.type;
  }

  narrow(local: LocalSymbol, type: MyntType): void {
    this.narrowed.set(local, type);
  }

  /** Declares `local`, or returns the clash if the name is visible already. */
  declare(local: LocalSymbol): { existing: LocalSymbol; enclosing: boolean } | undefined {
    const own = this.locals.get(local.name);
    if (own) return { existing: own, enclosing: false };
    const outer = this.parent?.lookup(local.name);
    if (outer) return { existing: outer, enclosing: true };
    this.locals.set(local.name, local);
    return undefined;
  }

  names(): string[] {
    return [...(this.parent?.names() ?? []), ...this.locals.keys()];
  }
}

/** What each source operator means. `ordering` operators are defined on Number only. */
const COMPARISON_OPERATORS: Record<
  Exclude<BinaryOperator, LogicalOperator>,
  { operation: ComparisonOperation; ordering: boolean }
> = {
  "==": { operation: "Equal", ordering: false },
  "!=": { operation: "NotEqual", ordering: false },
  "===": { operation: "StrictEqual", ordering: false },
  "!==": { operation: "StrictNotEqual", ordering: false },
  "<": { operation: "Less", ordering: true },
  "<=": { operation: "LessOrEqual", ordering: true },
  ">": { operation: "Greater", ordering: true },
  ">=": { operation: "GreaterOrEqual", ordering: true },
};

type LogicalOperator = "&&" | "||";

const LOGICAL_OPERATORS: Record<LogicalOperator, Logical["operation"]> = {
  "&&": "And",
  "||": "Or",
};

function isLogicalOperator(operator: BinaryOperator): operator is LogicalOperator {
  return operator in LOGICAL_OPERATORS;
}

/** `value op field` read as `field op' value`. */
const FLIPPED: Record<ComparisonOperation, ComparisonOperation> = {
  Equal: "Equal",
  NotEqual: "NotEqual",
  StrictEqual: "StrictEqual",
  StrictNotEqual: "StrictNotEqual",
  Less: "Greater",
  LessOrEqual: "GreaterOrEqual",
  Greater: "Less",
  GreaterOrEqual: "LessOrEqual",
};

/** A constant or a captured field-typed local, as a query can carry it. */
function queryValue(expression: BoundExpression): QueryValue | undefined {
  switch (expression.kind) {
    case "StringLiteral":
    case "NumberLiteral":
    case "BoolLiteral":
      return { kind: "Constant", value: expression.value };
    case "LocalReference":
      return typeof expression.type === "string" && expression.type !== "Void" && expression.type !== "Error" ? { kind: "Local", local: expression.local } : undefined;
    default:
      return undefined;
  }
}

/**
 * A reference as a predicate can carry it: `Customer(123)` / `Customer(n)`
 * by its id, or a reference-typed local. Anything else (a field read, a
 * lookup) is not captured, as for scalar values.
 */
function referenceOperand(expression: BoundExpression): ReferenceOperand | undefined {
  if (expression.kind === "RecordReference") {
    const id = queryValue(expression.id);
    return id ? { kind: "Id", value: id } : undefined;
  }
  if (expression.kind === "LocalReference" && isReferenceType(expression.type)) return { kind: "Local", local: expression.local };
  return undefined;
}

/** Whether every path through `body` ends in a `return`. Loops do not count: they may run zero times. */
function definitelyReturns(body: readonly BoundStatement[]): boolean {
  return body.some((statement) => {
    if (statement.kind === "Return") return true;
    if (statement.kind === "If") return statement.elseBody !== undefined && definitelyReturns(statement.thenBody) && definitelyReturns(statement.elseBody);
    return false;
  });
}

/** `where`, `select`, `order by`, `take`, for messages. */
function clauseName(clause: SearchClause): string {
  return { WhereClause: "where", SelectClause: "select", OrderByClause: "order by", GroupByClause: "group by", LimitClause: "limit", FirstClause: "first" }[clause.kind];
}

/** The result names a search's `select` declares (`total = sum(amount)`), by name, before anything binds. */
function resultNamesOf(expression: QueryExpression): ReadonlyMap<string, Span> {
  const names = new Map<string, Span>();
  for (const clause of expression.clauses) {
    if (clause.kind !== "SelectClause") continue;
    for (const item of clause.items) if (item.alias && item.value.kind === "AggregateCall" && !names.has(item.alias.name)) names.set(item.alias.name, item.alias.span);
  }
  return names;
}

/** The source spelling of a simple expression, for hints: `order.item`, `Customer(...)`. */
function sourceOf(expression: Expression): string {
  switch (expression.kind) {
    case "Identifier":
      return expression.name;
    case "MemberExpression":
      return `${sourceOf(expression.object)}.${expression.property.name}`;
    case "CallExpression":
      return `${sourceOf(expression.callee)}${expression.typeArgument ? ` ${expression.typeArgument.name}` : ""}(...)`;
    case "LookupExpression":
      return `lookup ${sourceOf(expression.receiver)}`;
    case "ProjectionExpression":
      return `${sourceOf(expression.receiver)}[${expression.fields.map((f) => f.name).join(", ")}]`;
    case "StringLiteral":
      return JSON.stringify(expression.value);
    default:
      return "...";
  }
}

type ScriptKind = "UserEvent" | "Scheduled";

const SCRIPT_KIND_LABEL: Record<ScriptKind, string> = {
  UserEvent: "User Event",
  Scheduled: "Scheduled",
};

type ScriptDeclaration = Exclude<Declaration, FunctionDeclaration>;

function scriptKindOf(declaration: ScriptDeclaration): ScriptKind {
  return declaration.kind === "ScheduledDeclaration" ? "Scheduled" : "UserEvent";
}

function keywordSpanOf(declaration: ScriptDeclaration): Span {
  return declaration.kind === "ScheduledDeclaration" ? declaration.keywordSpan : declaration.hookSpan;
}

function keywordOf(declaration: ScriptDeclaration): string {
  return declaration.kind === "ScheduledDeclaration" ? "scheduled" : declaration.hook;
}

/**
 * What a bare name means, in the binder's resolution order: locals, then
 * built-ins, then record types. Shared with editor features so that hover
 * and completion resolve a name exactly as the binder does.
 */
export type NameResolution =
  | { kind: "local"; local: LocalSymbol }
  | { kind: "function"; function: BoundFunction }
  | { kind: "recordType"; record: RecordSchema }
  | BuiltinSymbol;

export function resolveName(
  name: string,
  local: LocalSymbol | undefined,
  schema: SchemaProvider,
  functions: ReadonlyMap<string, BoundFunction> = new Map(),
): NameResolution | undefined {
  if (local) return { kind: "local", local };
  const fn = functions.get(name);
  if (fn) return { kind: "function", function: fn };
  const builtin = resolveBuiltinRoot(name);
  if (builtin) return builtin;
  const record = schema.getRecordByName(name);
  if (record) return { kind: "recordType", record };
  return undefined;
}

class Binder {
  /** Modules required by the built-ins bound so far in this file. */
  private readonly dependencies = new Set<NetSuiteModule>();
  /** Every declared local and where it is in scope. */
  private readonly symbols: ScopedLocal[] = [];
  /** Every expression bound, whether or not its statement survived. */
  private readonly expressions: BoundExpression[] = [];
  /** Every sublist loop's line variable. */
  private readonly lineBindings = new Map<LocalSymbol, LineBinding>();
  /** Top-level functions by name, collected before any body is bound so calls may precede declarations. */
  private readonly functions = new Map<string, BoundFunction>();
  private readonly functionList: BoundFunction[] = [];

  constructor(
    private readonly schema: SchemaProvider,
    private readonly diagnostics: DiagnosticBag,
  ) {}

  bindFile(file: SourceFile): ScriptUnit | undefined {
    const functionDeclarations = file.declarations.filter((d): d is FunctionDeclaration => d.kind === "FunctionDeclaration");
    const scriptDeclarations = file.declarations.filter((d): d is Exclude<Declaration, FunctionDeclaration> => d.kind !== "FunctionDeclaration");
    if (scriptDeclarations.length === 0) {
      if (functionDeclarations.length > 0) {
        this.diagnostics.error(
          DiagnosticCode.MixedScriptKinds,
          "This file declares functions but no entry point; a Mynt file is one script, so add beforeSubmit, afterSubmit, or scheduled",
          functionDeclarations[0]!.keywordSpan,
        );
      }
      return undefined;
    }

    // Signatures first, so calls can precede declarations; bodies after, so
    // every body sees every function.
    for (const declaration of functionDeclarations) this.declareFunction(declaration);
    for (const declaration of functionDeclarations) this.bindFunctionBody(declaration);

    // One file is one NetSuite script, so every declaration must belong to the
    // same script kind. The first declaration decides.
    const unitKind = scriptKindOf(scriptDeclarations[0]!);
    const declarations: ScriptDeclaration[] = [];
    for (const declaration of scriptDeclarations) {
      const kind = scriptKindOf(declaration);
      if (kind === unitKind) {
        declarations.push(declaration);
        continue;
      }
      this.diagnostics.error(
        DiagnosticCode.MixedScriptKinds,
        `${SCRIPT_KIND_LABEL[kind]} and ${SCRIPT_KIND_LABEL[unitKind]} entry points cannot exist in the same Mynt script: ` +
          `this file is a ${SCRIPT_KIND_LABEL[unitKind]} script because it starts with '${keywordOf(scriptDeclarations[0]!)}'. ` +
          `Move '${keywordOf(declaration)}' to its own file.`,
        keywordSpanOf(declaration),
      );
    }

    return unitKind === "Scheduled"
      ? this.bindScheduledUnit(file, declarations as ScheduledDeclaration[])
      : this.bindUserEventUnit(file, declarations as UserEventDeclaration[]);
  }

  // ---- script units --------------------------------------------------------

  private bindScheduledUnit(file: SourceFile, declarations: ScheduledDeclaration[]): ScriptUnit {
    const [first, ...rest] = declarations;
    for (const duplicate of rest) {
      this.diagnostics.error(
        DiagnosticCode.DuplicateEntryPoint,
        "scheduled is declared more than once in this file; a scheduled script has a single body",
        duplicate.keywordSpan,
      );
    }

    const scope = new Scope("execute", first!.body.span);
    const body = this.bindBlock(first!.body, scope);

    return {
      kind: "Scheduled",
      file: file.file,
      symbols: this.symbols,
      expressions: this.expressions,
      lineBindings: this.lineBindings,
      functions: this.functionList,
      entryPoint: { hook: "execute", body, span: first!.span },
      dependencies: this.dependencies,
      span: file.span,
    };
  }

  private bindUserEventUnit(file: SourceFile, declarations: UserEventDeclaration[]): ScriptUnit | undefined {
    // Every entry point must target the same record type. The first decides.
    let unitRecord: RecordSchema | undefined;
    const seenHooks = new Set<string>();
    const entryPoints: BoundUserEventEntryPoint[] = [];

    for (const declaration of declarations) {
      const record = this.resolveRecordTypeName(declaration.parameter.type);
      if (!record) continue;

      if (!unitRecord) {
        unitRecord = record;
      } else if (record !== unitRecord) {
        this.diagnostics.error(
          DiagnosticCode.MixedRecordTypes,
          `Entry points in one file must agree on the record type: ` +
            `this file targets ${unitRecord.name}, but ${declaration.hook} targets ${record.name}`,
          declaration.parameter.type.span,
        );
        continue;
      }

      if (seenHooks.has(declaration.hook)) {
        this.diagnostics.error(
          DiagnosticCode.DuplicateEntryPoint,
          `${declaration.hook} is declared more than once in this file; ` +
            `combine the event filters into a single ${declaration.hook}`,
          declaration.hookSpan,
        );
        continue;
      }
      seenHooks.add(declaration.hook);

      entryPoints.push(this.bindUserEventEntryPoint(declaration, record));
    }

    if (!unitRecord) return undefined;

    return {
      kind: "UserEvent",
      file: file.file,
      symbols: this.symbols,
      expressions: this.expressions,
      lineBindings: this.lineBindings,
      functions: this.functionList,
      record: unitRecord,
      entryPoints,
      dependencies: this.dependencies,
      span: file.span,
    };
  }

  // ---- functions -----------------------------------------------------------

  private declareFunction(declaration: FunctionDeclaration): void {
    const name = declaration.name.name;
    const taken = this.functions.has(name)
      ? `another function (line ${this.functions.get(name)!.nameSpan.start.line})`
      : resolveBuiltinRoot(name)
        ? "a built-in"
        : this.schema.getRecordByName(name)
          ? "a record type"
          : undefined;
    if (taken) {
      this.diagnostics.error(DiagnosticCode.DuplicateFunction, `'${name}' is already the name of ${taken}; choose another name for this function`, declaration.name.span);
      return;
    }

    const parameters: LocalSymbol[] = [];
    const seen = new Set<string>();
    for (const parameter of declaration.parameters) {
      if (seen.has(parameter.name.name)) {
        this.diagnostics.error(
          DiagnosticCode.DuplicateLocal,
          `'${parameter.name.name}' is already a parameter of '${name}'`,
          parameter.name.span,
        );
        continue;
      }
      seen.add(parameter.name.name);
      const type = this.resolveParameterType(parameter.type, name);
      if (!type) continue;
      parameters.push({ name: parameter.name.name, type, origin: "parameter", declaredAt: parameter.name.span });
    }

    let returnType: BoundFunction["returnType"] = "Void";
    if (declaration.returnType) {
      const resolved = this.resolveValueTypeName(declaration.returnType.name);
      if (resolved) returnType = resolved;
      else {
        const known = this.schema.getRecordByName(declaration.returnType.name);
        this.diagnostics.error(
          DiagnosticCode.InvalidSignatureType,
          known
            ? `'${name}' cannot return a ${known.name}: functions return string, number, or boolean; records flow in through parameters`
            : `Unknown return type '${declaration.returnType.name}'. Functions return string, number, or boolean`,
          declaration.returnType.span,
        );
      }
    }

    const fn: BoundFunction = { kind: "Function", name, nameSpan: declaration.name.span, parameters, returnType, body: [], span: declaration.span };
    this.functions.set(name, fn);
    this.functionList.push(fn);
  }

  private resolveValueTypeName(name: string): FieldType | "Bool" | undefined {
    return primitiveTypeNamed(name);
  }

  /** string, number, boolean, or a record type. Lines, sublists, and query results cannot be parameters. */
  private resolveParameterType(type: Identifier, functionName: string): MyntType | undefined {
    const value = this.resolveValueTypeName(type.name);
    if (value) return value;
    const record = this.schema.getRecordByName(type.name);
    if (record) return makeRecordType(record, "parameter");
    const known = this.schema.listRecords().map((r) => r.name).sort();
    const hint = suggest(type.name, [...PRIMITIVE_TYPE_NAMES, ...known]);
    this.diagnostics.error(
      DiagnosticCode.InvalidSignatureType,
      `Unknown parameter type '${type.name}' in '${functionName}'. ` +
        (hint ? `Did you mean '${hint}'? ` : "") +
        `Parameters are string, number, boolean, or a record type (${known.join(", ")})`,
      type.span,
    );
    return undefined;
  }

  private bindFunctionBody(declaration: FunctionDeclaration): void {
    const fn = this.functions.get(declaration.name.name);
    if (!fn || fn.nameSpan !== declaration.name.span) return; // a duplicate: its body is not bound
    const scope = new Scope("function", declaration.body.span, undefined, undefined, undefined, undefined, fn.returnType, fn.name);
    for (const parameter of fn.parameters) {
      scope.declare(parameter);
      this.symbols.push({ local: parameter, scope: declaration.body.span });
    }
    fn.body = this.bindBlock(declaration.body, scope);
    if (fn.returnType !== "Void" && !definitelyReturns(fn.body)) {
      this.diagnostics.error(
        DiagnosticCode.MissingReturn,
        `'${fn.name}' returns ${typeName(fn.returnType)} but not every path ends in 'return'`,
        declaration.name.span,
      );
    }
  }

  private bindReturn(statement: ReturnStatement, scope: Scope): BoundStatement | undefined {
    const where = scope.functionName ? `'${scope.functionName}'` : scope.hook;
    const value = statement.value ? this.bindValue(statement.value, scope) : undefined;
    if (statement.value && !value) return undefined;
    if (scope.returns === "Void") {
      if (value) {
        this.diagnostics.error(
          DiagnosticCode.ReturnMismatch,
          scope.functionName ? `'${scope.functionName}' returns no value; remove the value or declare ': ${typeName(value.type)}'` : `${where} returns no value`,
          statement.value!.span,
        );
        return undefined;
      }
      return { kind: "Return", value: undefined, span: statement.span };
    }
    if (!value) {
      this.diagnostics.error(DiagnosticCode.ReturnMismatch, `${where} must return a ${typeName(scope.returns)} value`, statement.span);
      return undefined;
    }
    if (!sameType(value.type, scope.returns)) {
      this.diagnostics.error(
        DiagnosticCode.ReturnMismatch,
        `Cannot return ${typeName(value.type)} from ${where}, which returns ${typeName(scope.returns)}`,
        statement.value!.span,
      );
      return undefined;
    }
    return { kind: "Return", value, span: statement.span };
  }

  /** Resolves a name that must be a record type, with a "did you mean" hint. */
  private resolveRecordTypeName(name: Identifier): RecordSchema | undefined {
    const record = this.schema.getRecordByName(name.name);
    if (record) return record;
    const platform = platformType(name.name);
    if (platform) {
      this.diagnostics.error(
        DiagnosticCode.UnknownRecordType,
        `'${platform.name}' is a platform type, not a record type: it has no fields and is only loaded, '${platform.example}'`,
        name.span,
      );
      return undefined;
    }

    const known = this.schema
      .listRecords()
      .map((r) => r.name)
      .sort();
    const hint = suggest(name.name, known);
    this.diagnostics.error(
      DiagnosticCode.UnknownRecordType,
      `Unknown record type '${name.name}'. ` +
        (hint ? `Did you mean '${hint}'? ` : "") +
        `Known record types: ${known.join(", ")}`,
      name.span,
    );
    return undefined;
  }

  private bindUserEventEntryPoint(
    declaration: UserEventDeclaration,
    record: RecordSchema,
  ): BoundUserEventEntryPoint {
    const events: UserEventType[] = [];
    for (const event of declaration.events) {
      if ((USER_EVENT_TYPES as readonly string[]).includes(event.name)) {
        events.push(event.name as UserEventType);
      } else {
        this.diagnostics.error(
          DiagnosticCode.UnknownEventName,
          `Unknown event '${event.name}'. Expected one of: ${USER_EVENT_TYPES.join(", ")}`,
          event.span,
        );
      }
    }

    const parameter: LocalSymbol = {
      name: declaration.parameter.name.name,
      type: makeRecordType(record, "context"),
      origin: "parameter",
      declaredAt: declaration.parameter.name.span,
    };
    const scope = new Scope(declaration.hook, declaration.body.span);
    scope.declare(parameter);
    this.symbols.push({ local: parameter, scope: declaration.body.span });
    const body = this.bindBlock(declaration.body, scope);
    const parameterType: RecordTypeReference = { kind: "RecordTypeReference", record, span: declaration.parameter.type.span };

    return { hook: declaration.hook, events, parameter, parameterType, body, span: declaration.span };
  }

  // ---- statements ----------------------------------------------------------

  private bindBlock(block: Block, scope: Scope): BoundStatement[] {
    const body: BoundStatement[] = [];
    for (const statement of block.statements) {
      const bound = this.bindStatement(statement, scope);
      if (bound) body.push(bound);
    }
    return body;
  }

  private bindStatement(statement: Statement, scope: Scope): BoundStatement | undefined {
    switch (statement.kind) {
      case "LetStatement":
        return this.bindLet(statement, scope);
      case "SaveStatement":
        return this.bindSave(statement, scope);
      case "DeleteStatement":
        return this.bindDelete(statement, scope);
      case "IfStatement":
        return this.bindIf(statement, scope);
      case "ForStatement":
        return this.bindFor(statement, scope);
      case "RemoveStatement":
        return this.bindRemove(statement, scope);
      case "AddStatement":
        return this.bindAdd(statement, scope);
      case "ReturnStatement":
        return this.bindReturn(statement, scope);
      case "TryStatement":
        return this.bindTry(statement, scope);
      case "ExpressionStatement": {
        const value = this.bindValue(statement.expression, scope);
        // Only calls have an effect. A bare field read binds (so its errors are
        // reported) but has nothing to emit.
        if (value?.kind === "BuiltinCall" || value?.kind === "FunctionCall") {
          return { kind: "ExpressionStatement", expression: value, span: statement.span };
        }
        return undefined;
      }
      case "AssignmentStatement":
        return this.bindAssignment(statement, scope);
    }
  }

  private bindLet(statement: LetStatement, scope: Scope): BoundStatement | undefined {
    if (statement.initializer.kind === "Identifier" && statement.initializer.name === "") return undefined; // cut short; the parser reported it
    // `let x = value or ...` is the one place an optional is resolved: the emitter hoists the test before the binding.
    const initializer = statement.initializer.kind === "OrExpression" ? this.bindOptionalResolve(statement.initializer, scope) : this.bindValue(statement.initializer, scope);
    if (!initializer) return undefined;
    if (statement.pattern) return this.bindDestructure(statement, statement.pattern, initializer, scope);
    if (!statement.name) return undefined;

    if (initializer.type === "Void") {
      const what = initializer.kind === "BuiltinCall" ? `${initializer.builtin.name}(...)` : "this expression";
      this.diagnostics.error(
        DiagnosticCode.TypeMismatch,
        `Cannot initialize '${statement.name.name}' with ${what}, which returns Void`,
        statement.initializer.span,
      );
      return undefined;
    }
    if (isSublistType(initializer.type)) {
      this.diagnostics.error(
        DiagnosticCode.TypeMismatch,
        `A sublist cannot be stored in a local; iterate it where it is: 'for line in ${sourceOf(statement.initializer)}'`,
        statement.initializer.span,
      );
      return undefined;
    }

    const local: LocalSymbol = {
      name: statement.name.name,
      type: initializer.type,
      origin: "let",
      declaredAt: statement.name.span,
    };

    const clash = scope.declare(local);
    if (clash) {
      const { existing, enclosing } = clash;
      const what = existing.origin === "parameter" ? "the entry point parameter" : "a local";
      const where = enclosing ? "an enclosing scope" : "this scope";
      this.diagnostics.error(
        DiagnosticCode.DuplicateLocal,
        `'${local.name}' is already declared in ${where} as ${what} (line ${existing.declaredAt.start.line})`,
        statement.name.span,
      );
      return undefined;
    }

    this.symbols.push({ local, scope: { start: statement.span.end, end: scope.span.end } });
    return { kind: "LocalDeclaration", local, initializer, span: statement.span };
  }

  /**
   * `let { email, comments: note } = value`: the value must be a projection
   * (the one structured shape with named fields and no identity), every
   * listed field one of its fields, and every local a fresh name. A
   * one-field lookup is the field's value, not a projection, so it is
   * bound with a plain `let`.
   */
  private bindDestructure(statement: LetStatement, pattern: ObjectPattern, source: BoundExpression, scope: Scope): BoundStatement | undefined {
    const written = `{ ${pattern.fields.map((f) => (f.colonSpan ? `${f.source.name}: ${f.local.name}` : f.source.name)).join(", ")} }`;
    if (!isProjectionType(source.type)) {
      const subject = sourceOf(statement.initializer);
      let message: string;
      if (isRecordType(source.type) || isReferenceType(source.type) || isSummaryType(source.type)) {
        const example = pattern.fields.map((f) => f.source.name).join(", ") || "email, comments";
        message =
          `'let ${written} = ...' binds the fields of a projection, and '${subject}' is a ${typeName(source.type)}. ` +
          (isSummaryType(source.type) ? `Read its result fields directly, like '${subject}.${pattern.fields[0]?.source.name ?? "total"}'` : `Project the fields first: 'let ${written} = ${subject}[${example}]'`);
      } else if (source.kind === "Lookup" && source.fields.length === 1) {
        message =
          `'let ${written} = ...' binds the fields of a projection, but a lookup of one field is that field's value (${typeName(source.type)}), not a projection. ` +
          `Write 'let ${pattern.fields[0]?.local.name ?? source.fields[0]!.field.id} = ${subject}'`;
      } else {
        message = `'let ${written} = ...' binds the fields of a projection, and '${subject}' is a ${typeName(source.type)} value, which has no fields to bind`;
      }
      this.diagnostics.error(DiagnosticCode.DestructureShape, message, statement.initializer.span);
      return undefined;
    }
    const projection = source.type;
    const bindings: DestructureBinding[] = [];
    const seen = new Map<string, Span>();
    let ok = true;
    // An empty pattern was reported by the parser; the declaration still binds (with nothing) so the editor knows the value's shape.
    for (const entry of pattern.fields) {
      const projected = projection.fields.find((f) => f.field.id === entry.source.name);
      if (!projected) {
        ok = false;
        const names = projection.fields.map((f) => f.field.id);
        const hint = suggest(entry.source.name, names);
        const schemaField = projection.record.fields.get(entry.source.name);
        this.diagnostics.error(
          DiagnosticCode.DestructureShape,
          `'${entry.source.name}' is not in this projection (${typeName(projection)}); bind one of ${names.join(", ")}` +
            (hint ? `. Did you mean '${hint}'?` : schemaField ? `. '${entry.source.name}' is a ${projection.record.name} field, but it was not selected; add it where the projection is made` : ""),
          entry.source.span,
        );
        continue;
      }
      const earlier = seen.get(projected.field.id);
      if (earlier) {
        ok = false;
        this.diagnostics.error(DiagnosticCode.DestructureShape, `'${projected.field.id}' is bound twice (first at column ${earlier.start.column}); bind each field once`, entry.source.span);
        continue;
      }
      seen.set(projected.field.id, entry.source.span);
      const local: LocalSymbol = { name: entry.local.name, type: projected.type, origin: "let", declaredAt: entry.local.span };
      const clash = scope.declare(local);
      if (clash) {
        ok = false;
        const { existing, enclosing } = clash;
        const what = existing.origin === "parameter" ? "the entry point parameter" : "a local";
        const where = enclosing ? "an enclosing scope" : "this scope";
        this.diagnostics.error(
          DiagnosticCode.DuplicateLocal,
          `'${local.name}' is already declared in ${where} as ${what} (line ${existing.declaredAt.start.line})` + (!entry.colonSpan ? `; bind the field under another name, '${entry.source.name}: other'` : ""),
          entry.local.span,
        );
        continue;
      }
      this.symbols.push({ local, scope: { start: statement.span.end, end: scope.span.end } });
      bindings.push({ field: projected.field, fieldSpan: entry.source.span, local, aliased: entry.colonSpan !== undefined });
    }
    if (!ok) return undefined;
    const destructure: Destructure = { kind: "Destructure", source, record: projection.record, bindings, span: statement.span };
    return destructure;
  }

  private bindAssignment(
    statement: Extract<Statement, { kind: "AssignmentStatement" }>,
    scope: Scope,
  ): BoundStatement | undefined {
    // Assignment: the target must be `<record-typed local>.<field>`.
    const { target, value } = statement;
    if (target.kind !== "MemberExpression") {
      this.diagnostics.error(
        DiagnosticCode.InvalidAssignmentTarget,
        "Only record fields can be assigned, for example `customer.comments = ...`",
        target.span,
      );
      this.bindValue(value, scope);
      return undefined;
    }

    const object = this.denote(target.object, scope);
    const boundValue = this.bindValue(value, scope);
    if (!object) return undefined;
    if (target.property.name === "") return undefined; // `x. = ...`: the parser already reported it.

    if (object.kind === "value" && isLineType(object.type)) {
      return this.bindLineAssignment(statement, object.type, object.bound, boundValue, scope);
    }

    if (object.kind === "value" && (isReferenceType(object.type) || isProjectionType(object.type))) {
      this.reportReadOnlyWrite(object.type, object.bound, target.property.name, statement.span);
      return undefined;
    }

    if (object.kind !== "value" || !isRecordType(object.type)) {
      this.diagnostics.error(
        DiagnosticCode.InvalidAssignmentTarget,
        "Only record fields can be assigned, for example `customer.comments = ...`",
        target.span,
      );
      return undefined;
    }

    const record = object.type.record;
    const receiver = object.bound;
    if (receiver.kind !== "LocalReference") {
      // A write to an unnamed record (`load Customer("1").comments = ...`)
      // could never be saved, so it would be a silent no-op.
      this.diagnostics.error(
        DiagnosticCode.InvalidAssignmentTarget,
        `Assign fields on a named record: declare it first, like 'let x = load ${record.name}(...)', then write 'x.${target.property.name}'`,
        target.object.span,
      );
      return undefined;
    }

    const field = record.fields.get(target.property.name);
    if (!field) {
      this.reportUnknownField(record, target.property);
      return undefined;
    }

    if (!field.writable) {
      this.diagnostics.error(
        DiagnosticCode.ReadOnlyField,
        `${record.name}.${field.id} is read-only and cannot be assigned`,
        target.property.span,
      );
      return undefined;
    }

    if (isRowOrigin(object.type.origin)) {
      this.diagnostics.error(
        DiagnosticCode.ReadOnlyQueryResult,
        `${rowLabel(object.type.origin)} '${receiver.local.name}' is read-only. Load the record before modifying it: ` +
          `'let x = load ${record.name}(${receiver.local.name}.id)', then assign 'x.${field.id}'`,
        statement.span,
      );
      return undefined;
    }

    if (this.refuseWrite(object.type, scope, `assign ${record.name}.${field.id}`, statement.span)) return undefined;

    if (!boundValue) return undefined;

    if (!sameType(boundValue.type, field.type)) {
      this.diagnostics.error(
        DiagnosticCode.TypeMismatch,
        `Cannot assign ${typeName(boundValue.type)} to ${record.name}.${field.id}, which is ${typeName(field.type)}`,
        value.span,
      );
      return undefined;
    }

    return { kind: "FieldWrite", receiver, field, fieldSpan: target.property.span, value: boundValue, span: statement.span };
  }

  /**
   * The one rule for whether a record value may be changed here. A query
   * row is a read-only view. In afterSubmit the context record has already
   * been saved: a change to `context.newRecord` alters an in-memory copy
   * that is then discarded, which is never what the author intended, hence
   * an error. Owned records, and the context record in beforeSubmit, may
   * be changed. Returns true after reporting a refusal.
   */
  private refuseWrite(type: RecordType, scope: Scope, what: string, span: Span): boolean {
    if (type.origin === "context" && scope.hook === "afterSubmit") {
      this.diagnostics.error(
        DiagnosticCode.WriteInAfterSubmit,
        `Cannot ${what} in afterSubmit: the ${type.record.name} is already saved and the change would be silently discarded. Use beforeSubmit instead.`,
        span,
      );
      return true;
    }
    return false;
  }

  /** `remove line`: the line must come from an enclosing sublist loop; its parent must be writable. */
  private bindRemove(statement: RemoveStatement, scope: Scope): BoundStatement | undefined {
    const target = this.bindValue(statement.target, scope);
    if (!target) return undefined;
    if (!isLineType(target.type) || target.kind !== "LocalReference") {
      const subject =
        target.kind === "LocalReference" ? `'${target.local.name}' is a ${typeName(target.type)} value and` : `A ${typeName(target.type)} value`;
      this.diagnostics.error(
        DiagnosticCode.RecordOperationOnNonRecord,
        `${subject} cannot be removed. Only a sublist line from a 'for' loop can be removed`,
        statement.target.span,
      );
      return undefined;
    }
    const binding = this.lineBindings.get(target.local)!;
    if (this.refuseWrite(target.type.parent, scope, `remove a line from ${sublistName(target.type)}`, statement.span)) return undefined;
    return { kind: "RemoveLine", line: target, binding, span: statement.span };
  }

  /** `add order.item { ... }`: append a line, initialized from the block, to the sublist of a named record. */
  private bindAdd(statement: AddStatement, scope: Scope): BoundStatement | undefined {
    const target = this.bindValue(statement.target, scope);
    let access: SublistAccess | undefined;
    if (target) {
      if (target.kind !== "SublistAccess" || !isSublistType(target.type)) {
        const hint = isRecordType(target.type) && target.type.record.sublists.size > 0
          ? ` Name a sublist, like 'add ${sourceOf(statement.target)}.${[...target.type.record.sublists.keys()][0]} {'`
          : "";
        this.diagnostics.error(
          DiagnosticCode.MemberOnNonRecord,
          `Cannot add a line to a ${typeName(target.type)} value; 'add' needs a sublist, like 'add order.item { ... }'.${hint}`,
          statement.target.span,
        );
      } else if (target.receiver.kind !== "LocalReference") {
        this.diagnostics.error(
          DiagnosticCode.NotIterable,
          `Add lines to the sublist of a named record: declare it first, like 'let x = load ${target.type.parent.record.name}(...)', then 'add x.${target.sublist.id} {'`,
          statement.target.span,
        );
      } else if (scope.isIterating(target.receiver.local, target.sublist)) {
        this.diagnostics.error(
          DiagnosticCode.ModifySublistWhileIterating,
          `Cannot add a line to ${sublistName(target.type)} while iterating it; add lines after the loop`,
          statement.target.span,
        );
      } else if (!this.refuseWrite(target.type.parent, scope, `add a line to ${sublistName(target.type)}`, statement.span)) {
        access = target;
      }
    }

    // Bind the block even when the target failed, so its errors surface.
    const initializers: LineInitializer[] = [];
    const seen = new Map<string, Span>();
    for (const item of statement.body.statements) {
      if (item.kind !== "AssignmentStatement" || item.target.kind !== "Identifier") {
        this.diagnostics.error(
          DiagnosticCode.InvalidLineInitializer,
          "An add block contains only field initializers, like 'quantity = 2'",
          item.span,
        );
        if (item.kind === "AssignmentStatement") this.bindValue(item.value, scope);
        continue;
      }
      const value = this.bindValue(item.value, scope);
      if (!access) continue;
      const owner = sublistName(access.type);
      const field = access.sublist.fields.get(item.target.name);
      if (!field) {
        this.reportUnknownMember(owner, access.sublist.fields.keys(), item.target);
        continue;
      }
      const earlier = seen.get(field.id);
      if (earlier) {
        this.diagnostics.error(
          DiagnosticCode.InvalidLineInitializer,
          `${owner}.${field.id} is initialized twice in this add block (first on line ${earlier.start.line}); a new line takes one value per field`,
          item.target.span,
        );
        continue;
      }
      seen.set(field.id, item.target.span);
      if (!field.writable) {
        this.diagnostics.error(DiagnosticCode.ReadOnlyField, `${owner}.${field.id} is read-only and cannot be initialized`, item.target.span);
        continue;
      }
      if (!value) continue;
      if (!sameType(value.type, field.type)) {
        this.diagnostics.error(
          DiagnosticCode.TypeMismatch,
          `Cannot assign ${typeName(value.type)} to ${owner}.${field.id}, which is ${typeName(field.type)}`,
          item.value.span,
        );
        continue;
      }
      initializers.push({ kind: "LineInitializer", field, fieldSpan: item.target.span, value, span: item.span });
    }
    if (!access || access.receiver.kind !== "LocalReference") return undefined;
    return { kind: "AddLine", target: access, parent: access.receiver.local, initializers, span: statement.span };
  }

  /** `line.quantity = ...`: a write to the parent record through one of its lines. */
  private bindLineAssignment(
    statement: Extract<Statement, { kind: "AssignmentStatement" }>,
    line: LineType,
    receiver: BoundExpression,
    boundValue: BoundExpression | undefined,
    scope: Scope,
  ): BoundStatement | undefined {
    const target = statement.target as MemberExpression;
    if (receiver.kind !== "LocalReference") return undefined;
    const owner = sublistName(line);
    const field = line.sublist.fields.get(target.property.name);
    if (!field) {
      this.reportUnknownMember(owner, line.sublist.fields.keys(), target.property);
      return undefined;
    }
    if (!field.writable) {
      this.diagnostics.error(DiagnosticCode.ReadOnlyField, `${owner}.${field.id} is read-only and cannot be assigned`, target.property.span);
      return undefined;
    }
    if (this.refuseWrite(line.parent, scope, `assign ${owner}.${field.id}`, statement.span)) return undefined;
    if (!boundValue) return undefined;
    if (!sameType(boundValue.type, field.type)) {
      this.diagnostics.error(
        DiagnosticCode.TypeMismatch,
        `Cannot assign ${typeName(boundValue.type)} to ${owner}.${field.id}, which is ${typeName(field.type)}`,
        statement.value.span,
      );
      return undefined;
    }
    return { kind: "FieldWrite", receiver, field, fieldSpan: target.property.span, value: boundValue, span: statement.span };
  }

  /** Binds the target of `save`/`delete` and checks it is a record. */
  private bindRecordTarget(target: Expression, verb: "saved" | "deleted", scope: Scope): BoundExpression | undefined {
    const bound = this.bindValue(target, scope);
    if (!bound) return undefined;
    if (isRecordType(bound.type)) return bound;
    if (isReferenceType(bound.type) || isProjectionType(bound.type)) {
      this.reportReadOnlyWrite(bound.type, bound, verb, target.span);
      return undefined;
    }
    if (isLineType(bound.type)) {
      const parent = bound.type.parent.record.name;
      const name = bound.kind === "LocalReference" ? bound.local.name : "the line";
      this.diagnostics.error(
        DiagnosticCode.LineNotPersistable,
        `A sublist line cannot be ${verb} independently: '${name}' is a line of ${sublistName(bound.type)}, persisted with its parent. ` +
          (verb === "saved" ? `Save the parent ${parent} instead` : `Removing lines is not supported yet; delete the parent ${parent} if that is what you mean`),
        target.span,
      );
      return undefined;
    }
    const subject =
      bound.kind === "LocalReference" ? `'${bound.local.name}' is a ${typeName(bound.type)} value and` : `A ${typeName(bound.type)} value`;
    this.diagnostics.error(
      DiagnosticCode.RecordOperationOnNonRecord,
      `${subject} cannot be ${verb}. Only records can be ${verb}`,
      target.span,
    );
    return undefined;
  }

  private bindDelete(statement: DeleteStatement, scope: Scope): BoundStatement | undefined {
    const target = this.bindRecordTarget(statement.target, "deleted", scope);
    if (!target || !isRecordType(target.type)) return undefined;
    const record = target.type.record.name;

    if (isRowOrigin(target.type.origin)) {
      this.reportQueryRowOperation(target, "deleted", statement.span);
      return undefined;
    }
    if (target.type.origin === "context") {
      const name = target.kind === "LocalReference" ? `'${target.local.name}'` : `This ${record}`;
      this.diagnostics.error(
        DiagnosticCode.CannotDelete,
        `${name} is the ${record} from ${scope.hook} and cannot be deleted: it is NetSuite's record, not the script's. ` +
          `Only records the script loaded, created, copied, or transformed can be deleted`,
        statement.span,
      );
      return undefined;
    }
    if (target.kind !== "LocalReference") {
      this.diagnostics.error(
        DiagnosticCode.CannotDelete,
        `Delete a named record: declare it first, like 'let x = load ${record}(...)', then 'delete x'`,
        statement.target.span,
      );
      return undefined;
    }
    return { kind: "DeleteRecord", target, span: statement.span };
  }

  private reportQueryRowOperation(target: BoundExpression, verb: "saved" | "deleted", span: Span): void {
    if (!isRecordType(target.type) || !isRowOrigin(target.type.origin)) return;
    const name = target.kind === "LocalReference" ? target.local.name : "it";
    this.diagnostics.error(
      DiagnosticCode.ReadOnlyQueryResult,
      `${rowLabel(target.type.origin)} '${name}' cannot be ${verb}: a ${target.type.origin} row is a read-only view. ` +
        `Load the record first: 'let x = load ${target.type.record.name}(${name}.id)', then '${verb === "saved" ? "save" : "delete"} x'`,
      span,
    );
  }

  private bindSave(statement: SaveStatement, scope: Scope): BoundStatement | undefined {
    const target = this.bindRecordTarget(statement.target, "saved", scope);
    if (!target || !isRecordType(target.type)) return undefined;

    if (isRowOrigin(target.type.origin)) {
      this.reportQueryRowOperation(target, "saved", statement.span);
      return undefined;
    }

    if (target.type.origin === "context") {
      const record = target.type.record.name;
      const name = target.kind === "LocalReference" ? `'${target.local.name}'` : `This ${record}`;
      const explanation =
        scope.hook === "afterSubmit"
          ? `it was already saved before afterSubmit ran. To change it now, load a fresh copy: ` +
            `'let x = load ${record}(...)', modify x, then 'save x'`
          : `NetSuite persists changes to it automatically when ${scope.hook} returns`;
      this.diagnostics.error(
        DiagnosticCode.SaveContextRecord,
        `${name} is the ${record} from ${scope.hook} and cannot be explicitly saved: ${explanation}`,
        statement.span,
      );
      return undefined;
    }

    return { kind: "SaveRecord", target, span: statement.span };
  }

  private bindFor(statement: ForStatement, scope: Scope): BoundStatement | undefined {
    const iterable = this.bindValue(statement.iterable, scope);

    let local: LocalSymbol | undefined;
    let line: LineBinding | undefined;
    let bodyScope = scope.child(statement.body);
    if (iterable) {
      const element = this.elementType(iterable, statement.iterable);
      if (element) {
        local = { name: statement.variable.name, type: element, origin: "loop", declaredAt: statement.variable.span };
        if (isLineType(element) && iterable.kind === "SublistAccess" && iterable.receiver.kind === "LocalReference") {
          line = { line: local, parent: iterable.receiver.local, sublist: iterable.sublist };
        }
        bodyScope = scope.child(statement.body, line);
        const clash = bodyScope.declare(local);
        if (clash) {
          const what = clash.existing.origin === "parameter" ? "the entry point parameter" : "a local";
          this.diagnostics.error(
            DiagnosticCode.DuplicateLocal,
            `'${local.name}' is already declared in an enclosing scope as ${what} (line ${clash.existing.declaredAt.start.line})`,
            statement.variable.span,
          );
          local = undefined;
        } else {
          this.symbols.push({ local, scope: statement.body.span });
          if (line) this.lineBindings.set(local, line);
        }
      }
    }

    const body = this.bindBlock(statement.body, bodyScope);
    if (!iterable || !local) return undefined;
    return { kind: "ForEach", local, iterable, line, body, span: statement.span };
  }

  /** What a `for` variable is: a query row for a Sequence, a line for a sublist of a named record. */
  private elementType(iterable: BoundExpression, syntax: Expression): MyntType | undefined {
    if (isSequenceType(iterable.type)) return iterable.type.element;
    if (isSublistType(iterable.type)) {
      if (iterable.kind !== "SublistAccess" || iterable.receiver.kind !== "LocalReference") {
        this.diagnostics.error(
          DiagnosticCode.NotIterable,
          `Iterate the sublist of a named record: declare it first, like 'let x = load ${iterable.type.parent.record.name}(...)', then 'for line in x.${iterable.type.sublist.id}'`,
          syntax.span,
        );
        return undefined;
      }
      const line: LineType = { kind: "Line", parent: iterable.type.parent, sublist: iterable.type.sublist };
      return line;
    }
    if (isOptionalType(iterable.type)) {
      this.diagnostics.error(
        DiagnosticCode.NotIterable,
        `Cannot iterate over a ${typeName(iterable.type)} value: a search with 'first' is one optional row, not a sequence. Use 'limit 1' for a sequence of at most one row`,
        syntax.span,
      );
      return undefined;
    }
    const hint = isRecordType(iterable.type)
      ? iterable.type.record.sublists.size > 0
        ? `a sublist of it, like 'for line in ${sourceOf(syntax)}.${[...iterable.type.record.sublists.keys()][0]}', or`
        : ""
      : "";
    this.diagnostics.error(
      DiagnosticCode.NotIterable,
      `Cannot iterate over a ${typeName(iterable.type)} value; 'for' needs ${hint ? `${hint} ` : ""}a query result, like 'for x in query ${isRecordType(iterable.type) ? iterable.type.record.name : "Customer"}'`,
      syntax.span,
    );
    return undefined;
  }

  private bindIf(statement: IfStatement, scope: Scope): BoundStatement | undefined {
    let condition = this.bindValue(statement.condition, scope);

    // `if account { ... }` on an optional local: a presence test, the one non-boolean condition. Not truthiness: nothing else qualifies.
    let presence: { local: LocalSymbol; element: RecordType | SummaryType } | undefined;
    if (condition && condition.kind === "LocalReference" && isOptionalType(condition.type)) {
      presence = { local: condition.local, element: condition.type.element };
      condition = { kind: "OptionalPresence", reference: condition, type: "Bool", span: condition.span };
    }

    if (condition && condition.type !== "Bool") {
      // No truthiness: "" / 0 / a record reference are not conditions.
      this.diagnostics.error(
        DiagnosticCode.ConditionNotBool,
        `if condition must be boolean, but received ${typeName(condition.type)}. ` +
          `Mynt has no truthiness: compare the value explicitly, for example with == or !=`,
        statement.condition.span,
      );
    }

    // Bind both branches even when the condition failed, so their errors surface.
    const thenScope = scope.child(statement.thenBlock);
    if (presence) thenScope.narrow(presence.local, presence.element);
    const thenBody = this.bindBlock(statement.thenBlock, thenScope);
    const elseBody = statement.elseBlock ? this.bindBlock(statement.elseBlock, scope.child(statement.elseBlock)) : undefined;
    // When the absence branch leaves (`else { return }`), what follows sees the local present.
    if (presence && elseBody && definitelyReturns(elseBody)) scope.narrow(presence.local, presence.element);

    if (!condition || condition.type !== "Bool") return undefined;
    return { kind: "If", condition, thenBody, elseBody, span: statement.span };
  }

  /**
   * `value or return` / `value or { ... }` as a `let` initializer. The value
   * must be optional; the branch, bound as a block of its own, must end in
   * `return` on every path (the same check functions use), so the local
   * is the inner type. Nothing here is specific to searches: any `T?` is
   * resolved the same way.
   */
  private bindOptionalResolve(expression: OrExpression, scope: Scope): BoundExpression | undefined {
    const value = this.bindValue(expression.value, scope);
    const absence = this.bindBlock(expression.branch, scope.child(expression.branch));
    if (!value) return undefined;
    if (!isOptionalType(value.type)) {
      this.diagnostics.error(
        DiagnosticCode.OrRequiresOptional,
        `'or' requires an optional value, and this expression has type ${typeName(value.type)}. Only a search with 'first' produces an optional so far`,
        expression.orSpan,
      );
      return undefined;
    }
    if (expression.branch.statements.length === 0) return undefined; // cut short; the parser reported it
    if (!definitelyReturns(absence)) {
      this.diagnostics.error(
        DiagnosticCode.OrBranchContinues,
        "The 'or' branch may continue without producing a value. End the branch with 'return' on every path",
        expression.orSpan,
      );
      return undefined;
    }
    const resolved: OptionalResolve = { kind: "OptionalResolve", value, absence, type: value.type.element, span: expression.span };
    this.expressions.push(resolved);
    return resolved;
  }

  /** `try { } catch err { } finally { }`: three ordinary blocks; the error local is scoped to the handler and typed Error. */
  private bindTry(statement: TryStatement, scope: Scope): BoundStatement | undefined {
    const body = this.bindBlock(statement.body, scope.child(statement.body));
    let binding: LocalSymbol | undefined;
    let handler: BoundStatement[] | undefined;
    if (statement.handler) {
      const handlerScope = scope.child(statement.handler);
      if (statement.binding) {
        binding = { name: statement.binding.name, type: "Error", origin: "catch", declaredAt: statement.binding.span };
        const clash = handlerScope.declare(binding);
        if (clash) {
          this.diagnostics.error(
            DiagnosticCode.DuplicateLocal,
            `'${binding.name}' is already declared in an enclosing scope (line ${clash.existing.declaredAt.start.line}); choose another name for the caught error`,
            statement.binding.span,
          );
          binding = undefined;
        } else {
          this.symbols.push({ local: binding, scope: statement.handler.span });
        }
      }
      handler = this.bindBlock(statement.handler, handlerScope);
    }
    const finalizer = statement.finalizer ? this.bindBlock(statement.finalizer, scope.child(statement.finalizer)) : undefined;
    return { kind: "TryCatch", body, binding, handler, finalizer, span: statement.span };
  }

  private reportUnknownField(record: RecordSchema, property: Identifier, queryRow = false): void {
    const candidates = [...record.fields.keys(), ...(queryRow ? ["id"] : [...record.sublists.keys()])];
    const hint = suggest(property.name, candidates);
    const what = record.sublists.size > 0 && !queryRow ? "field or sublist" : "field";
    this.diagnostics.error(
      DiagnosticCode.UnknownField,
      `${record.name} has no ${what} '${property.name}'` + (hint ? `. Did you mean '${hint}'?` : ""),
      property.span,
    );
  }

  /** Unknown field of a sublist line: `SalesOrder.item has no field 'quantty'`. */
  private reportUnknownMember(owner: string, candidates: Iterable<string>, property: Identifier): void {
    const hint = suggest(property.name, candidates);
    this.diagnostics.error(
      DiagnosticCode.UnknownField,
      `${owner} has no field '${property.name}'` + (hint ? `. Did you mean '${hint}'?` : ""),
      property.span,
    );
  }

  // ---- expressions ---------------------------------------------------------

  /**
   * Binds an expression used as a value. Record types, namespaces, and
   * uncalled built-ins are not values; they are reported here. Returns
   * undefined after reporting an error.
   */
  private bindValue(expression: Expression, scope: Scope): BoundExpression | undefined {
    const denotation = this.denote(expression, scope);
    if (!denotation) return undefined;

    switch (denotation.kind) {
      case "value":
        return denotation.bound;
      case "recordType":
        this.diagnostics.error(
          DiagnosticCode.TypeMismatch,
          `'${denotation.record.name}' is a record type, not a value. ` +
            `Did you mean to load one, like 'load ${denotation.record.name}(...)', or to reference one by id, like ${denotation.record.name}(123)?`,
          expression.span,
        );
        return undefined;
      case "namespace":
        this.diagnostics.error(
          DiagnosticCode.TypeMismatch,
          `'${denotation.namespace.name}' is a built-in namespace, not a value`,
          expression.span,
        );
        return undefined;
      case "function":
        this.diagnostics.error(
          DiagnosticCode.TypeMismatch,
          `'${denotation.function.name}' is a function and must be called, like '${denotation.function.name}(...)'`,
          expression.span,
        );
        return undefined;
      case "builtin": {
        const { builtin } = denotation;
        const example =
          builtin.kind === "recordOperation"
            ? `${builtin.name} Customer${builtin.parameters.length > 0 ? "(...)" : ""}${builtin.target ? " to Invoice" : ""}`
            : `${builtin.name}(...)`;
        this.diagnostics.error(
          DiagnosticCode.TypeMismatch,
          `'${builtin.name}' is a built-in function and must be called, like '${example}'`,
          expression.span,
        );
        return undefined;
      }
    }
  }

  /** Resolves what an expression denotes, reporting unresolvable names. Every value is also recorded in the expression table. */
  private denote(expression: Expression, scope: Scope): Denotation | undefined {
    const denotation = this.denoteExpression(expression, scope);
    if (denotation?.kind === "value") this.expressions.push(denotation.bound);
    return denotation;
  }

  private denoteExpression(expression: Expression, scope: Scope): Denotation | undefined {
    switch (expression.kind) {
      case "StringLiteral":
        return {
          kind: "value",
          type: "Text",
          bound: { kind: "StringLiteral", value: expression.value, type: "Text", span: expression.span },
        };

      case "NumberLiteral":
        return {
          kind: "value",
          type: "Number",
          bound: { kind: "NumberLiteral", value: expression.value, type: "Number", span: expression.span },
        };

      case "BoolLiteral":
        return {
          kind: "value",
          type: "Bool",
          bound: { kind: "BoolLiteral", value: expression.value, type: "Bool", span: expression.span },
        };

      case "Identifier":
        return this.denoteIdentifier(expression, scope);

      case "MemberExpression":
        return this.denoteMember(expression, scope);

      case "CallExpression":
        return this.denoteCall(expression, scope);

      case "BinaryExpression":
        return isLogicalOperator(expression.operator)
          ? this.denoteLogical(expression, expression.operator, scope)
          : this.denoteComparison(expression, scope);

      case "QueryExpression":
        return this.denoteQuery(expression, scope);

      case "ProjectionExpression":
        return this.denoteProjection(expression, scope);

      case "LookupExpression":
        return this.denoteLookup(expression, scope);

      case "OrExpression":
        this.bindValue(expression.value, scope);
        this.diagnostics.error(
          DiagnosticCode.OrRequiresOptional,
          "'or' resolves an optional value where a local is declared: write 'let x = ... or return' (or 'or { ... }'), then use 'x'",
          expression.orSpan,
        );
        return undefined;

      case "UnaryExpression":
        return this.denoteNot(expression, scope);
    }
  }

  /** `&&` and `||`: Bool operands, Bool result. Each bad operand is reported on its own. */
  private denoteLogical(expression: BinaryExpression, operator: LogicalOperator, scope: Scope): Denotation | undefined {
    const left = this.bindValue(expression.left, scope);
    const right = this.bindValue(expression.right, scope);
    let ok = left !== undefined && right !== undefined;

    for (const [side, operand, syntax] of [
      ["left", left, expression.left],
      ["right", right, expression.right],
    ] as const) {
      if (operand && operand.type !== "Bool") {
        ok = false;
        this.diagnostics.error(
          DiagnosticCode.LogicalOperandNotBool,
          `operator '${operator}' requires boolean operands, but the ${side} operand is ${typeName(operand.type)}. ` +
            `Mynt has no truthiness: compare the value explicitly, for example with == or !=`,
          syntax.span,
        );
      }
    }
    if (!ok || !left || !right) return undefined;

    const logical: Logical = {
      kind: "Logical",
      operation: LOGICAL_OPERATORS[operator],
      left,
      right,
      type: "Bool",
      span: expression.span,
    };
    return { kind: "value", type: "Bool", bound: logical };
  }

  private denoteNot(expression: UnaryExpression, scope: Scope): Denotation | undefined {
    const operand = this.bindValue(expression.operand, scope);
    if (!operand) return undefined;
    if (operand.type !== "Bool") {
      this.diagnostics.error(
        DiagnosticCode.LogicalOperandNotBool,
        `operator '!' requires boolean, but received ${typeName(operand.type)}. ` +
          `Mynt has no truthiness: compare the value explicitly, for example with == or !=`,
        expression.operand.span,
      );
      return undefined;
    }
    return { kind: "value", type: "Bool", bound: { kind: "Not", operand, type: "Bool", span: expression.span } };
  }

  /**
   * Comparison typing. Both operands must have the same type, and that type
   * must be one the operator is defined for: equality on Text and Number,
   * ordering on Number only. Nothing is coerced; `"10" == 10` is an error,
   * not false.
   */
  private denoteComparison(expression: BinaryExpression, scope: Scope): Denotation | undefined {
    const left = this.bindValue(expression.left, scope);
    const right = this.bindValue(expression.right, scope);
    if (!left || !right) return undefined;

    const { operator } = expression;
    if (isLogicalOperator(operator)) throw new Error(`'${operator}' is not a comparison`);
    const { operation, ordering } = COMPARISON_OPERATORS[operator];

    // A reference whose target the schema does not name, or a multiselect,
    // cannot be compared with anything: identity needs a known record type.
    for (const [side, syntax] of [
      [left, expression.left],
      [right, expression.right],
    ] as const) {
      if (side.type !== "Ref") continue;
      const field = side.kind === "QueryField" || side.kind === "FieldRead" || side.kind === "JoinedQueryField" || side.kind === "JoinedFieldRead" ? side.field : undefined;
      this.diagnostics.error(
        DiagnosticCode.UnsupportedComparison,
        field?.selection === "multiple"
          ? `'${field.id}' is a multiselect: it holds several references, so '${operator}' against one reference has no meaning. A membership test for multiselects is not supported yet`
          : `Cannot compare ${field ? `'${field.id}'` : "this reference"}: Mynt cannot verify which record type it refers to, because the schema metadata names no target for it. ` +
            `Comparisons between references need a known target on both sides`,
        syntax.span,
      );
      return undefined;
    }

    // Ordering stays what it was: Number on both sides. Equality goes through the equality table.
    if (ordering) return this.denoteOrdering(expression, operation, left, right);
    if (!isEqualityOperation(operation)) throw new Error(`${operation} is neither ordering nor equality`);
    const mode = equalityMode(operation);
    const equality = equalityOf(left.type, right.type, mode);
    if (equality.kind === "incompatible") {
      const reference = isReferenceType(left.type) ? left.type : isReferenceType(right.type) ? right.type : undefined;
      const other = isReferenceType(left.type) ? right : left;
      const spelled = equalityOperators(mode);
      let message = `Cannot compare ${typeName(left.type)} with ${typeName(right.type)}: both sides of '${operator}' must have the same type`;
      if (equality.reason === "strict") {
        message =
          `Strict equality cannot compare ${typeName(left.type)} with ${typeName(right.type)}. ` +
          `Use '${equalityOperators("loose")[assertsEqual(operation) ? "equal" : "notEqual"]}' if a coercive comparison is intended, or compare values of one type`;
      } else if (reference && isReferenceType(other.type)) {
        message = `Cannot compare a ${(left.type as ReferenceType).record.name} reference with a ${(right.type as ReferenceType).record.name} reference: they refer to different record types`;
      } else if (reference && (other.kind === "QueryField" || other.kind === "FieldRead" || other.kind === "JoinedQueryField" || other.kind === "JoinedFieldRead") && (other.type === "Text" || other.type === "Number")) {
        message = `Cannot compare '${other.field.id}', a ${typeName(other.type)} field, with a ${reference.record.name} reference: a reference compares only with a reference to the same record type`;
      } else if (reference && (other.type === "Text" || other.type === "Number")) {
        const id = other.kind === "StringLiteral" ? JSON.stringify(other.value) : other.kind === "NumberLiteral" ? String(other.value) : "id";
        message =
          `Cannot compare a ${reference.record.name} reference with a ${typeName(other.type)}: a reference compares with a reference, by identity${mode === "loose" ? ", and loose equality does not coerce references" : ""}. ` +
          `Write the reference, ${reference.record.name}(${id}), so the record type is checked, rather than its raw id`;
      } else if (reference) {
        message = `Cannot compare a ${reference.record.name} reference with ${typeName(other.type)}: a reference compares only with a reference to the same record type`;
      } else if (sameType(left.type, right.type)) {
        const what = isRecordType(left.type) ? `records (${left.type.record.name})` : `${typeName(left.type)} values`;
        message = `'${operator}' is not defined for ${what}; equality is defined for string, number, boolean, and references`;
      } else if (mode === "loose") {
        message = `Cannot compare ${typeName(left.type)} with ${typeName(right.type)}: loose equality ('${spelled.equal}', '${spelled.notEqual}') coerces only between string, number, and boolean`;
      }
      this.diagnostics.error(equality.reason === "domain" && sameType(left.type, right.type) ? DiagnosticCode.UnsupportedComparison : DiagnosticCode.IncomparableTypes, message, expression.span);
      return undefined;
    }

    // Identity equality on references: `.id` on both sides, whether or not either carries text; the mode changes nothing.
    const operandType = equality.kind === "reference" ? "Reference" : equality.kind === "coercive" ? "Mixed" : equality.type;
    const comparison: Comparison = { kind: "Comparison", operation, operandType, left, right, type: "Bool", span: expression.span };
    return { kind: "value", type: "Bool", bound: comparison };
  }

  /** `<` `<=` `>` `>=`: Number on both sides, nothing else. */
  private denoteOrdering(expression: BinaryExpression, operation: ComparisonOperation, left: BoundExpression, right: BoundExpression): Denotation | undefined {
    const { operator } = expression;
    if (!sameType(left.type, right.type)) {
      this.diagnostics.error(
        DiagnosticCode.IncomparableTypes,
        `Cannot compare ${typeName(left.type)} with ${typeName(right.type)}: both sides of '${operator}' must have the same type`,
        expression.span,
      );
      return undefined;
    }
    if (left.type !== "Number") {
      const what = isReferenceType(left.type) ? "references; references compare by identity with == and !=" : `${typeName(left.type)} values; ordering comparisons require number operands`;
      this.diagnostics.error(DiagnosticCode.UnsupportedComparison, `'${operator}' is not defined for ${what}`, expression.operatorSpan);
      return undefined;
    }
    const comparison: Comparison = { kind: "Comparison", operation, operandType: "Number", left, right, type: "Bool", span: expression.span };
    return { kind: "value", type: "Bool", bound: comparison };
  }

  /**
   * `query Customer where ...` / `search Customer where ...`: the condition
   * is bound like any expression, in a scope where bare names are the
   * record's fields, and then translated into a backend-neutral predicate.
   * A search additionally translates that predicate into N/search terms,
   * which may reject shapes N/search cannot express. The value is the
   * executed result, a Sequence of rows of the chosen backend.
   */
  private denoteQuery(expression: QueryExpression, scope: Scope): Denotation | undefined {
    const { operation } = expression;
    let record = expression.recordType ? this.resolveRecordTypeName(expression.recordType) : undefined;
    let source: Query["source"] = { kind: "adHoc" };
    if (expression.saved) {
      const resolved = this.resolveSavedSearch(expression, scope);
      if (!resolved) return undefined;
      record = resolved.record;
      source = resolved.source;
    } else if (!expression.recordType) {
      throw new Error("an ad-hoc query names its record type");
    }
    // Clauses describe one search in any order; a singleton written twice is a likely mistake, not a merge.
    const clauses = this.normalizeClauses(expression, operation);
    // The result names `select` declares, known before anything binds, so a source position can say what a stray alias is.
    const resultNames = resultNamesOf(expression);
    let condition: BoundExpression | undefined;
    let predicate: QueryPredicate | undefined;
    let filter: Query["filter"];
    if (record && expression.condition) {
      condition = this.bindValue(expression.condition, scope.conditionScope(record, expression.condition.span, operation, resultNames));
      if (!condition) return undefined;
      if (condition.type !== "Bool") {
        this.diagnostics.error(
          DiagnosticCode.ConditionNotBool,
          `where condition must be boolean, but received ${typeName(condition.type)}. Compare a field, for example 'where email != ""'`,
          expression.condition.span,
        );
        return undefined;
      }
      predicate = this.toPredicate(condition, operation);
      if (!predicate) return undefined;
      if (operation === "search") {
        filter = toSearchPredicate(predicate, (why) =>
          this.diagnostics.error(DiagnosticCode.UnsupportedSearchCondition, `Unsupported search condition: ${why}`, expression.condition!.span),
        );
        if (!filter) return undefined;
      }
    } else if (expression.condition) {
      this.bindValue(expression.condition, scope); // report its errors even without a record
    }
    if (!record) return undefined;
    if (!clauses) return undefined;
    const shape = this.bindSearchShape(clauses, record, operation, scope, resultNames);
    if (!shape) return undefined;
    this.dependencies.add(operation === "query" ? "N/query" : "N/search");

    // `first` is one optional row; everything else is a sequence, `limit 1` included. A summary search's rows are summary rows.
    const rows = shape.result ? summarySequenceType(summaryType(record, shape.result)) : sequenceType(record, operation, shape.exposes);
    const type = shape.first ? optionalType(rows.element as RecordType | SummaryType) : rows;
    const query: Query = {
      kind: "Query",
      operation,
      operationSpan: expression.keywordSpan,
      source,
      // An inferred saved-search type has no written name: a zero-width reference at the id, so no token or hover claims the string.
      recordType: { kind: "RecordTypeReference", record, span: expression.recordType?.span ?? { start: expression.saved!.id!.span.start, end: expression.saved!.id!.span.start } },
      condition,
      predicate,
      filter,
      select: shape.select,
      groupBy: shape.groupBy,
      summary: shape.result !== undefined,
      orderBy: shape.orderBy,
      limit: shape.limit,
      first: shape.first,
      type,
      span: expression.span,
    };
    return { kind: "value", type, bound: query };
  }

  /**
   * One clause of each kind, whatever the order written. A second `where`,
   * `select`, `order by`, or `take` is reported at the repeat with the
   * first's line: repeating a singleton clause is treated as a mistake
   * (conditions combine with `&&`/`||`, fields and sort keys share one
   * clause), never merged. Returns undefined after reporting.
   */
  private normalizeClauses(expression: QueryExpression, operation: QueryOperation): Map<SearchClause["kind"], SearchClause> | undefined {
    const seen = new Map<SearchClause["kind"], SearchClause>();
    let ok = true;
    for (const clause of expression.clauses) {
      if (operation === "query" && clause.kind !== "WhereClause") {
        this.diagnostics.error(
          DiagnosticCode.UnsupportedQueryCondition,
          `'${clauseName(clause)}' is a search clause; 'query' (N/query) supports only 'where' so far. Use 'search' for selection, ordering, grouping, and limits`,
          clause.keywordSpan,
        );
        ok = false;
        continue;
      }
      const earlier = seen.get(clause.kind);
      if (earlier) {
        const fix = {
          WhereClause: "Combine conditions with '&&' or '||'",
          SelectClause: "Add the fields to the same clause, like 'select a, b'",
          OrderByClause: "Put every sort key in one clause, like 'order by a desc, b'",
          GroupByClause: "Put every group field in one clause, like 'group by a, b'",
          LimitClause: "Keep the one count you mean",
          FirstClause: "One 'first' is enough",
        }[clause.kind];
        this.diagnostics.error(
          DiagnosticCode.DuplicateSearchClause,
          `A search can only contain one '${clauseName(clause)}' clause; the first is on line ${earlier.keywordSpan.start.line}. ${fix}`,
          clause.keywordSpan,
        );
        ok = false;
        continue;
      }
      seen.set(clause.kind, clause);
    }
    // `first` and `limit` state different cardinalities; together they contradict, whichever came first.
    const first = seen.get("FirstClause");
    const limit = seen.get("LimitClause");
    if (first && limit) {
      const later = first.keywordSpan.start.offset > limit.keywordSpan.start.offset ? first : limit;
      this.diagnostics.error(
        DiagnosticCode.InvalidSearchClause,
        "A search cannot use both 'first' and 'limit'. Use 'first' for a single optional row or 'limit' for a bounded sequence",
        later.keywordSpan,
      );
      ok = false;
    }
    return ok ? seen : undefined;
  }

  /**
   * `select`, `group by`, `order by`, `limit`, and `first`, bound in the
   * condition scope so that a bare name is the record's field and
   * `entity.email` its one-hop join, exactly as in `where`. `select` fixes
   * what the rows expose; sort keys are backend columns that expose nothing
   * by themselves.
   *
   * A `group by`, or an aggregate in `select`, makes the search a summary
   * search: its rows are aggregate buckets exposing exactly the grouped
   * fields and the named aggregates (`result`), every selected plain field
   * must be grouped, and `order by` names result fields (a grouped field or
   * an alias), whatever order the clauses were written in: aliases are
   * collected from `select` before any sort key binds.
   */
  private bindSearchShape(
    clauses: Map<SearchClause["kind"], SearchClause>,
    record: RecordSchema,
    operation: QueryOperation,
    scope: Scope,
    resultNames: ReadonlyMap<string, Span>,
  ):
    | {
        select: (SelectedField | SelectedAggregate)[] | undefined;
        groupBy: GroupKey[] | undefined;
        orderBy: SortSpec[] | undefined;
        limit: number | undefined;
        first: boolean;
        exposes: ExposedField[] | undefined;
        /** The summary row's result fields; undefined for an ordinary search. */
        result: ResultField[] | undefined;
      }
    | undefined {
    let ok = true;
    // Source positions (`group by`, an aggregate's argument) see the result names so a stray alias is reported for what it is; `select` and `order by` resolve them themselves.
    const bindField = (item: Expression, clause: string, sourcePosition = true): QueryField | JoinedQueryField | undefined => {
      const bound = this.bindValue(item, scope.conditionScope(record, item.span, operation, sourcePosition ? resultNames : undefined));
      if (!bound) return undefined;
      if (bound.kind === "QueryField" || bound.kind === "JoinedQueryField") return bound;
      this.diagnostics.error(
        DiagnosticCode.InvalidSearchClause,
        `'${clause}' names fields of ${record.name} (or one field of a record a field refers to, like 'entity.email'); '${sourceOf(item)}' is not one`,
        item.span,
      );
      return undefined;
    };
    const fieldKey = (field: QueryField | JoinedQueryField): string => (field.kind === "JoinedQueryField" ? `${field.join.via.id}.${field.field.id}` : field.field.id);
    /** The row member a field is exposed under: a joined field sits under its relationship. */
    const memberName = (field: QueryField | JoinedQueryField): string => (field.kind === "JoinedQueryField" ? field.join.via.id : field.field.id);

    // `group by`: the buckets. Each key is a column the search groups on, exposed only if selected.
    let groupBy: GroupKey[] | undefined;
    const grouped = new Map<string, GroupKey>();
    const groupClause = clauses.get("GroupByClause");
    if (groupClause?.kind === "GroupByClause") {
      groupBy = [];
      if (groupClause.fields.length === 0) ok = false; // reported by the parser
      for (const item of groupClause.fields) {
        const field = bindField(item, "group by");
        if (!field) {
          ok = false;
          continue;
        }
        const key = fieldKey(field);
        const earlier = grouped.get(key);
        if (earlier) {
          this.diagnostics.error(DiagnosticCode.DuplicateProjectionField, `'${key}' is grouped twice (first at column ${earlier.span.start.column}); list each field once`, item.span);
          ok = false;
          continue;
        }
        if (field.field.type === "Unknown" || field.field.selection === "multiple") {
          this.diagnostics.error(
            DiagnosticCode.InvalidSearchClause,
            `Cannot group by '${key}': ${field.field.selection === "multiple" ? "a multiselect holds several values, so it does not define one bucket" : "its type is not known well enough to group by"}`,
            item.span,
          );
          ok = false;
          continue;
        }
        const groupKey: GroupKey = { kind: "GroupKey", field, span: item.span };
        grouped.set(key, groupKey);
        groupBy.push(groupKey);
      }
    }

    // `select`: plain fields, and named aggregates. One flat result namespace: a row member is a field (a joined field's relationship) or an alias, never both.
    let select: (SelectedField | SelectedAggregate)[] | undefined;
    let exposes: ExposedField[] | undefined;
    const aggregates = new Map<string, SelectedAggregate>();
    const selectClause = clauses.get("SelectClause");
    if (selectClause?.kind === "SelectClause") {
      select = [];
      exposes = [];
      const listed = new Map<string, Span>();
      const members = new Map<string, { span: Span; alias: boolean }>();
      for (const item of selectClause.items) {
        if (item.value.kind === "AggregateCall") {
          const aggregate = this.bindAggregate(item, item.value, operation, bindField);
          if (!aggregate) {
            ok = false;
            continue;
          }
          const earlier = members.get(aggregate.alias);
          if (earlier) {
            this.diagnostics.error(
              DiagnosticCode.ResultName,
              `'${aggregate.alias}' is already ${earlier.alias ? "the name of an aggregate" : "a selected field"} of this search (column ${earlier.span.start.column}); a row member means one thing. Give the aggregate another name`,
              aggregate.aliasSpan,
            );
            ok = false;
            continue;
          }
          members.set(aggregate.alias, { span: aggregate.aliasSpan, alias: true });
          aggregates.set(aggregate.alias, aggregate);
          select.push(aggregate);
          continue;
        }
        if (item.alias) {
          this.diagnostics.error(
            DiagnosticCode.ResultName,
            `Only an aggregate takes a result name; a field is selected under its own name. Write 'select ${sourceOf(item.value)}', or an aggregate like '${item.alias.name} = sum(${sourceOf(item.value)})'`,
            item.equalsSpan ?? item.alias.span,
          );
          ok = false;
          continue;
        }
        if (item.value.kind === "Identifier" && item.value.name === "") {
          ok = false; // cut short; the parser reported it
          continue;
        }
        const field = bindField(item.value, "select", false);
        if (!field) {
          ok = false;
          continue;
        }
        const key = fieldKey(field);
        const earlier = listed.get(key);
        if (earlier) {
          this.diagnostics.error(DiagnosticCode.DuplicateProjectionField, `'${key}' is selected twice (first at column ${earlier.start.column}); list each field once`, item.span);
          ok = false;
          continue;
        }
        listed.set(key, item.span);
        const member = members.get(memberName(field));
        if (member?.alias) {
          this.diagnostics.error(
            DiagnosticCode.ResultName,
            `'${memberName(field)}' is already the name of an aggregate of this search (column ${member.span.start.column}); a row member means one thing. Give the aggregate another name`,
            item.span,
          );
          ok = false;
          continue;
        }
        if (!member) members.set(memberName(field), { span: item.span, alias: false });
        select.push({ kind: "SelectedField", field, span: item.span });
        exposes.push({ field: field.field, join: field.kind === "JoinedQueryField" ? field.join : undefined });
      }
      if (select.length === 0) ok = false; // the parser reported the empty list
    }

    // Summary mode: a `group by`, or an aggregate. Every selected plain field must then be grouped, since a bucket has one value per group.
    const summary = groupBy !== undefined || aggregates.size > 0;
    let result: ResultField[] | undefined;
    if (summary) {
      result = [];
      for (const item of select ?? []) {
        if (item.kind === "SelectedAggregate") {
          result.push(item.result);
          continue;
        }
        const key = fieldKey(item.field);
        if (!grouped.has(key)) {
          const aggregate = item.field.field.type === "Number" ? "sum" : item.field.field.type === "Ref" || item.field.field.type === "Bool" ? "count" : "max";
          this.diagnostics.error(
            DiagnosticCode.UngroupedField,
            `'${key}' must appear in 'group by' or be used inside an aggregate: a summary row has one value per group, and '${key}' varies within one. ` +
              `Group by it ('group by ${[...grouped.keys(), key].join(", ")}') or aggregate it ('${item.field.field.id} = ${aggregate}(${key})')`,
            item.span,
          );
          ok = false;
          continue;
        }
        result.push({ name: item.field.field.id, summary: "group", field: item.field.field, join: item.field.kind === "JoinedQueryField" ? item.field.join : undefined, type: item.field.type });
      }
      // Without `select`, the rows expose the group keys: a distinct list of buckets.
      if (!select) for (const key of groupBy ?? []) result.push({ name: key.field.field.id, summary: "group", field: key.field.field, join: key.field.kind === "JoinedQueryField" ? key.field.join : undefined, type: key.field.type });
    }

    // `order by`: source fields, or in a summary search result names: an alias (whatever the clause order), or a grouped field.
    let orderBy: SortSpec[] | undefined;
    const orderClause = clauses.get("OrderByClause");
    if (orderClause?.kind === "OrderByClause") {
      orderBy = [];
      if (orderClause.keys.length === 0) ok = false; // reported by the parser
      for (const key of orderClause.keys) {
        if (key.field.kind === "Identifier" && resultNames.has(key.field.name)) {
          const item = aggregates.get(key.field.name);
          if (!item) {
            ok = false; // the aggregate itself did not bind, and said why
            continue;
          }
          const reference: AliasReference = { kind: "AliasReference", item, type: item.type, span: key.field.span };
          this.expressions.push(reference);
          orderBy.push({ kind: "SortSpec", field: reference, direction: key.direction ?? "asc", span: key.span });
          continue;
        }
        const field = bindField(key.field, "order by", false);
        if (!field) {
          ok = false;
          continue;
        }
        if (summary && !grouped.has(fieldKey(field))) {
          const names = [...grouped.keys(), ...aggregates.keys()];
          this.diagnostics.error(
            DiagnosticCode.InvalidSearchClause,
            `Cannot sort by '${fieldKey(field)}': a summary search orders by its result fields${names.length > 0 ? `, ${names.join(", ")}` : " (a grouped field or an aggregate name)"}; '${fieldKey(field)}' is neither grouped nor aggregated`,
            key.field.span,
          );
          ok = false;
          continue;
        }
        if (field.type === "Ref" || field.field.type === "Unknown") {
          this.diagnostics.error(
            DiagnosticCode.InvalidSearchClause,
            `Cannot sort by '${fieldKey(field)}': ${field.field.selection === "multiple" ? "a multiselect has no single value to order by" : "its type is not known well enough to order by"}`,
            key.field.span,
          );
          ok = false;
          continue;
        }
        orderBy.push({ kind: "SortSpec", field, direction: key.direction ?? "asc", span: key.span });
      }
    }

    let limit: number | undefined;
    const limitClause = clauses.get("LimitClause");
    if (limitClause?.kind === "LimitClause") {
      if (!limitClause.count) ok = false; // reported by the parser
      else if (limitClause.count.kind !== "NumberLiteral" || !Number.isInteger(limitClause.count.value) || limitClause.count.value <= 0) {
        this.bindValue(limitClause.count, scope);
        this.diagnostics.error(
          DiagnosticCode.InvalidSearchClause,
          `'limit' needs a positive whole number of rows written as a literal, like 'limit 100'${limitClause.count.kind === "NumberLiteral" ? `; ${limitClause.count.value} is not one` : ""}`,
          limitClause.count.span,
        );
        ok = false;
      } else {
        limit = limitClause.count.value;
      }
    }
    const first = clauses.has("FirstClause");
    return ok ? { select, groupBy, orderBy, limit, first, exposes, result } : undefined;
  }

  /**
   * `total = sum(amount)`: an aggregate over a source field, which must be
   * named. The result type follows the aggregate and the field: `sum` and
   * `avg` take a number and yield one; `min` and `max` take a number, date,
   * or string and yield the same; `count` takes any field, or `id`, or
   * nothing (both count rows), and yields a number. Nothing else is
   * meaningful, so nothing else is accepted.
   */
  private bindAggregate(
    item: SelectItem,
    call: AggregateCall,
    operation: QueryOperation,
    bindField: (item: Expression, clause: string) => QueryField | JoinedQueryField | undefined,
  ): SelectedAggregate | undefined {
    const name = call.function.name;
    if (!isAggregateKind(name)) {
      this.diagnostics.error(DiagnosticCode.InvalidAggregate, `'${name}' is not an aggregate; 'select' aggregates with sum, count, min, max, and avg`, call.function.span);
      return undefined;
    }
    const written = `${name}(${call.argument ? sourceOf(call.argument) : ""})`;
    if (!item.alias) {
      this.diagnostics.error(
        DiagnosticCode.InvalidAggregate,
        `An aggregate needs a result name: write '${name === "count" ? "count" : "total"} = ${written}' and read it as that name on the row`,
        call.span,
      );
      return undefined;
    }
    if (operation === "query") {
      this.diagnostics.error(DiagnosticCode.UnsupportedQueryCondition, `Aggregates are a search feature; 'query' (N/query) has no summary support yet. Use 'search'`, call.span);
      return undefined;
    }
    const alias = item.alias.name;
    let argument: QueryField | JoinedQueryField | undefined;
    const countsRows = call.argument === undefined || (call.argument.kind === "Identifier" && call.argument.name === "id");
    if (countsRows) {
      if (name !== "count") {
        this.diagnostics.error(
          DiagnosticCode.InvalidAggregate,
          call.argument ? `'id' is row identity, not a field; only 'count(id)' (or 'count()') uses it, to count rows` : `'${name}' needs a field to aggregate, like '${name}(amount)'`,
          call.argument?.span ?? call.span,
        );
        return undefined;
      }
    } else {
      argument = bindField(call.argument!, `${name}(...)`);
      if (!argument) return undefined;
      const field = argument.field;
      const accepts: Record<AggregateKind, readonly FieldType[]> = {
        sum: ["Number"],
        avg: ["Number"],
        min: ["Number", "Date", "Text"],
        max: ["Number", "Date", "Text"],
        count: ["Text", "Number", "Bool", "Date", "Ref", "Unknown"],
      };
      if (!accepts[name].includes(field.type)) {
        const described = field.type === "Ref" ? "a select field" : field.type === "Bool" ? "a boolean field" : field.type === "Unknown" ? "a field of unknown type" : `a ${typeName(field.type)} field`;
        this.diagnostics.error(
          DiagnosticCode.InvalidAggregate,
          `'${name}' takes ${name === "sum" || name === "avg" ? "a number field" : "a number, date, or string field"}; '${sourceOf(call.argument!)}' is ${described}` +
            (field.type === "Ref" || field.type === "Bool" ? `. Count it instead: '${alias} = count(${sourceOf(call.argument!)})'` : ""),
          call.argument!.span,
        );
        return undefined;
      }
    }
    const type: MyntType = name === "count" ? "Number" : argument!.field.type;
    const result: ResultField = { name: alias, summary: name, field: argument?.field, join: argument?.kind === "JoinedQueryField" ? argument.join : undefined, type };
    const aggregate: SelectedAggregate = { kind: "SelectedAggregate", alias, aliasSpan: item.alias.span, aggregate: name, functionSpan: call.function.span, argument, result, type, span: item.span };
    this.expressions.push(aggregate);
    return aggregate;
  }

  /**
   * `load Search(id)`: the saved search's result record type, from the
   * account snapshot. Mynt does not make the author repeat what NetSuite
   * owns, and does not guess: a literal id the snapshot knows infers the
   * type; an id it does not know, or a value, is reported, since nothing
   * in source states the result type (an explicit form is deliberately not
   * in the language yet). A standalone search type the snapshot marks is
   * passed to `search.load`; nothing else is.
   */
  private resolveSavedSearch(expression: QueryExpression, scope: Scope): { record: RecordSchema; source: Query["source"] } | undefined {
    const clause = expression.saved!;
    if (!clause.id) return undefined; // the parser reported the missing id
    const idDenotation = this.denote(clause.id, scope);
    if (!idDenotation) return undefined;
    if (idDenotation.kind !== "value") {
      this.diagnostics.error(
        DiagnosticCode.InvalidSavedSearchId,
        idDenotation.kind === "recordType"
          ? `'${idDenotation.record.name}' is a record type, not a saved search id. Write the script id as a string: 'load Search("customsearch_x")'`
          : `A saved search is named by its script id, a string like "customsearch_active_customers"`,
        clause.id.span,
      );
      return undefined;
    }
    const id = idDenotation.bound;
    if (id.type !== "Text") {
      this.diagnostics.error(
        DiagnosticCode.InvalidSavedSearchId,
        `A saved search is named by its script id, a string like "customsearch_active_customers", but received ${typeName(id.type)}`,
        clause.id.span,
      );
      return undefined;
    }
    if (id.kind !== "StringLiteral") {
      this.diagnostics.error(
        DiagnosticCode.UnknownSavedSearch,
        `The result type of a saved search named by a value cannot be known at compile time: 'load Search(${sourceOf(clause.id)})' would have rows of no known record type. Name the search by its literal script id, which the account snapshot knows`,
        clause.id.span,
      );
      return undefined;
    }
    const known = this.schema.getSavedSearch(id.value);
    if (!known) {
      const names = this.schema.listSavedSearches().map((s) => s.id);
      const hint = suggest(id.value, names);
      this.diagnostics.error(
        DiagnosticCode.UnknownSavedSearch,
        `The current account snapshot does not list saved search "${id.value}", so its result type is unknown. ` +
          (hint ? `Did you mean "${hint}"? ` : "") +
          `Pull a snapshot of the account that has it ('mynt schema pull'), or add it under 'savedSearches' in the snapshot${names.length > 0 ? `; known: ${names.join(", ")}` : ""}`,
        clause.id.span,
      );
      return undefined;
    }
    const record = this.schema.getRecordByName(known.record);
    if (!record) {
      this.diagnostics.error(
        DiagnosticCode.UnknownSavedSearch,
        `The account snapshot says saved search "${id.value}" returns ${known.record}, which is not a record type the snapshot defines`,
        clause.id.span,
      );
      return undefined;
    }
    this.dependencies.add("N/search");
    return { record, source: { kind: "saved", id, clause: clause.span, typeSpan: clause.keywordSpan, recordFrom: "snapshot", loadType: known.searchType } };
  }

  /** The predicate shapes the backends can express. Anything else is reported, never approximated. */
  private toPredicate(condition: BoundExpression, operation: QueryOperation): QueryPredicate | undefined {
    const unsupported = (why: string, span: Span = condition.span): undefined => {
      this.diagnostics.error(
        operation === "query" ? DiagnosticCode.UnsupportedQueryCondition : DiagnosticCode.UnsupportedSearchCondition,
        `Unsupported ${operation} condition: ${why}`,
        span,
      );
      return undefined;
    };
    switch (condition.kind) {
      case "QueryField":
        return condition.type === "Bool" ? { kind: "Flag", field: condition.field, join: undefined, value: true } : unsupported(`'${condition.field.id}' is not a Bool field`);
      case "JoinedQueryField":
        return condition.type === "Bool"
          ? { kind: "Flag", field: condition.field, join: condition.join, value: true }
          : unsupported(`'${condition.join.via.id}.${condition.field.id}' is not a Bool field`);
      case "Not": {
        const operand = this.toPredicate(condition.operand, operation);
        return operand && { kind: "Not", operand };
      }
      case "Logical": {
        const left = this.toPredicate(condition.left, operation);
        const right = this.toPredicate(condition.right, operation);
        return left && right ? { kind: condition.operation === "And" ? "And" : "Or", left, right } : undefined;
      }
      case "Comparison": {
        const isField = (side: BoundExpression): side is QueryField | JoinedQueryField => side.kind === "QueryField" || side.kind === "JoinedQueryField";
        const fieldOnLeft = isField(condition.left);
        const fieldSide = fieldOnLeft ? condition.left : condition.right;
        const valueSide = fieldOnLeft ? condition.right : condition.left;
        if (!isField(fieldSide)) {
          const idOfField = [condition.left, condition.right].find((side) => side.kind === "RecordIdRead" && side.receiver.kind === "QueryField");
          if (idOfField && idOfField.kind === "RecordIdRead" && idOfField.receiver.kind === "QueryField") {
            const field = idOfField.receiver.field;
            return unsupported(
              `compare the reference itself rather than its id: '${field.id} == ${field.refTarget ?? "Record"}(...)' keeps the record type checked`,
              idOfField.span,
            );
          }
          return unsupported("one side of the comparison must be a field of the queried record");
        }
        if (isField(valueSide)) {
          return unsupported("a field can be compared with a value, not with another field");
        }
        const join = fieldSide.kind === "JoinedQueryField" ? fieldSide.join : undefined;
        const backend = operation === "query" ? "N/query" : "N/search";
        if (condition.operandType === "Mixed") {
          // JavaScript would coerce; the backend compares typed values and cannot promise the same answer.
          const fieldType = typeName(fieldSide.type);
          const spelled = equalityOperators("strict")[assertsEqual(condition.operation as EqualityOperation) ? "equal" : "notEqual"];
          return unsupported(
            `loose equality between ${typeName(condition.left.type)} and ${typeName(condition.right.type)} cannot be represented exactly by ${backend}, which compares without coercion. ` +
              `Use '${spelled}' with a ${fieldType} value instead`,
            condition.span,
          );
        }
        if (condition.operandType === "Bool") {
          // `done == true` is the flag itself; `done != true` its negation. A boolean value must be a literal to be a filter.
          if (valueSide.kind !== "BoolLiteral" || !isEqualityOperation(condition.operation)) {
            return unsupported(`compare the boolean field '${fieldSide.field.id}' with true or false, or use it as a condition on its own`, valueSide.span);
          }
          return { kind: "Flag", field: fieldSide.field, join, value: valueSide.value === assertsEqual(condition.operation) };
        }
        if (condition.operandType === "Reference") {
          if (operation === "query") {
            return unsupported(
              `comparing the reference field '${fieldSide.field.id}' is supported by 'search'; how N/query filters a select field by id has not been decided, so 'query' does not lower it yet`,
            );
          }
          const operand = referenceOperand(valueSide);
          if (!operand) {
            return unsupported(
              `a reference in a condition is written ${fieldSide.field.refTarget ?? "Record"}(id) with a literal or local id, or is a reference local`,
              valueSide.span,
            );
          }
          if (!isEqualityOperation(condition.operation)) throw new Error("ordering on references is rejected by the binder");
          const target = isReferenceType(fieldSide.type) ? fieldSide.type.record : undefined;
          if (!target) throw new Error("a reference comparison has a reference-typed field");
          return { kind: "CompareReference", field: fieldSide.field, join, record: target, operation: condition.operation, values: [operand] };
        }
        const value = queryValue(valueSide);
        if (!value) return unsupported("a field can only be compared with a literal or a local value", valueSide.span);
        // Flip the operation when the field is on the right: `"" != email` is `email != ""`; `1 < total` is `total > 1`.
        const flipped = fieldOnLeft ? condition.operation : FLIPPED[condition.operation];
        return { kind: "Compare", field: fieldSide.field, join, operation: flipped, value };
      }
      default:
        return unsupported(`a ${operation} condition compares fields of the ${operation === "query" ? "queried" : "searched"} record with values`);
    }
  }

  /** Resolution order: query fields (inside `where`), then locals, built-ins, and record types (see resolveName). */
  private denoteIdentifier(identifier: Identifier, scope: Scope): Denotation | undefined {
    const { name, span } = identifier;

    const queryRecord = scope.queryRecord;
    if (queryRecord) {
      const field = queryRecord.fields.get(name);
      const local = scope.lookup(name);
      const resultName = scope.resultNames?.get(name);
      if (resultName) {
        // `where total > 1` with `total = sum(amount)`: a result name in a source position. Whether or not a field shares the name, the author must mean one thing.
        this.diagnostics.error(
          DiagnosticCode.ResultName,
          field
            ? `'${name}' is both a field of ${queryRecord.name} and a result name of this search (line ${resultName.start.line}); in 'where', 'group by', and an aggregate a bare name is the source field. Rename the result to make this unambiguous`
            : `'${name}' is a result name of this search's 'select' (line ${resultName.start.line}), not a field of ${queryRecord.name}: 'where' filters source rows before they are aggregated, and 'group by' and aggregates read source fields. There is no 'having' yet`,
          span,
        );
        return undefined;
      }
      if (field && local) {
        this.diagnostics.error(
          DiagnosticCode.AmbiguousQueryName,
          `'${name}' is both a field of ${queryRecord.name} and a local in scope; inside 'where' a bare name is the field. Rename the local to use it here`,
          span,
        );
        return undefined;
      }
      if (field) {
        // A select field is a reference here as on a row of the same backend, so it compares with references.
        const type = this.valueType(field, scope.querySource ?? "query");
        return { kind: "value", type, bound: { kind: "QueryField", record: queryRecord, field, type, span } };
      }
    }

    const resolved = resolveName(name, scope.lookup(name), this.schema, this.functions);
    switch (resolved?.kind) {
      case "local": {
        const { local } = resolved;
        const type = scope.typeOf(local);
        return { kind: "value", type, bound: { kind: "LocalReference", local, type, span } };
      }
      case "function":
        return { kind: "function", function: resolved.function, span };
      case "namespace":
        return { kind: "namespace", namespace: resolved.namespace, span };
      case "builtin":
        return {
          kind: "builtin",
          builtin: resolved.builtin,
          reference: { kind: "BuiltinReference", builtin: resolved.builtin, nameSpan: span, namespaceSpan: undefined, span },
        };
      case "recordType":
        return resolved;
      case undefined:
        break;
    }

    if (queryRecord) {
      this.reportUnknownField(queryRecord, identifier);
      return undefined;
    }

    const inScope = [...scope.names(), ...this.functions.keys(), ...builtinRootNames()];
    const hint = suggest(name, inScope);
    this.diagnostics.error(
      DiagnosticCode.UnknownIdentifier,
      `Unknown identifier '${name}'. ` + (hint ? `Did you mean '${hint}'? ` : "") + `Names in scope: ${inScope.join(", ")}`,
      span,
    );
    return undefined;
  }

  private denoteMember(expression: MemberExpression, scope: Scope): Denotation | undefined {
    const object = this.denote(expression.object, scope);
    if (!object) return undefined;
    const name = expression.property.name;
    if (name === "") return undefined; // `x.` while typing: the parser already reported it.

    switch (object.kind) {
      case "value": {
        if (isLineType(object.type)) {
          const field = object.type.sublist.fields.get(name);
          if (!field) {
            this.reportUnknownMember(sublistName(object.type), object.type.sublist.fields.keys(), expression.property);
            return undefined;
          }
          return {
            kind: "value",
            type: field.type,
            bound: { kind: "FieldRead", receiver: object.bound, field, fieldSpan: expression.property.span, type: field.type, span: expression.span },
          };
        }
        if (isSublistType(object.type)) {
          this.diagnostics.error(
            DiagnosticCode.MemberOnNonRecord,
            `Cannot access '.${name}' on a sublist; iterate its lines: 'for line in ${sourceOf(expression.object)}', then use 'line.${name}'`,
            expression.property.span,
          );
          return undefined;
        }
        if (object.type === "File") {
          this.diagnostics.error(
            DiagnosticCode.MemberOnNonRecord,
            `A File has no members in Mynt yet; it can be loaded ('load File(...)') and passed along, but its properties and contents are not modeled`,
            expression.property.span,
          );
          return undefined;
        }
        if (object.type === "Error") {
          if (name === "name" || name === "message") {
            return {
              kind: "value",
              type: "Text",
              bound: { kind: "ErrorPropertyRead", receiver: object.bound, property: name, nameSpan: expression.property.span, type: "Text", span: expression.span },
            };
          }
          this.diagnostics.error(
            DiagnosticCode.MemberOnNonRecord,
            `An Error has '.name' and '.message' (both strings) and can be logged as it is; it has no member '${name}'`,
            expression.property.span,
          );
          return undefined;
        }
        if (isOptionalType(object.type)) {
          const subject = sourceOf(expression.object);
          this.diagnostics.error(
            DiagnosticCode.OptionalAccess,
            `'${subject}' may be absent: a search with 'first' returns one ${typeName(object.type.element)} row or none. ` +
              `Resolve it where it is declared, 'let ${subject} = ... or return' (or 'or { ... return }'), or test for presence with 'if ${subject} { ... }' before reading '.${name}'`,
            expression.property.span,
          );
          return undefined;
        }
        if (isReferenceType(object.type)) {
          const joined = this.denoteJoinedMember(object.type, object.bound, expression, scope);
          if (joined !== "notJoined") return joined;
          return this.denoteReferenceMember(object.type, object.bound, expression);
        }
        if (isProjectionType(object.type)) return this.denoteProjectionMember(object.type, object.bound, expression);
        if (object.type === "Ref") {
          const field = object.bound.kind === "FieldRead" || object.bound.kind === "QueryField" || object.bound.kind === "JoinedFieldRead" || object.bound.kind === "JoinedQueryField" ? object.bound.field : undefined;
          this.diagnostics.error(
            field?.selection === "multiple" ? DiagnosticCode.UnsupportedJoin : DiagnosticCode.MemberOnNonRecord,
            field?.selection === "multiple"
              ? `'${field.id}' is a multiselect: it holds several references, so '${field.id}.${name}' is not one relationship to follow. Iterating or filtering a multiselect is not supported yet`
              : field
                ? `Cannot access '.${name}' on '${field.id}': the schema does not name the record type it refers to, so Mynt cannot determine which fields it has. A reference with a known target has '.id' (and '.text' from a lookup or search row)`
                : `Cannot access '.${name}' on this reference: the schema does not name the record type it refers to, or it is a multiselect read outside a lookup. ` +
                  `A reference with a known target has '.id' (and '.text' from a lookup or search row)`,
            expression.property.span,
          );
          return undefined;
        }
        if (isSummaryType(object.type)) return this.denoteSummaryMember(object.type, object.bound, expression);
        if (!isRecordType(object.type)) {
          this.diagnostics.error(
            DiagnosticCode.MemberOnNonRecord,
            `Cannot access '.${name}' on a ${typeName(object.type)} value`,
            expression.property.span,
          );
          return undefined;
        }
        const record = object.type.record;
        if (isRowOrigin(object.type.origin) && name === "id") {
          // A query row carries the record's identity. It is a language
          // property, not a schema field, so it is bound as its own node.
          return {
            kind: "value",
            type: "Text",
            bound: { kind: "RecordIdRead", receiver: object.bound, nameSpan: expression.property.span, type: "Text", span: expression.span },
          };
        }
        const field = record.fields.get(name);
        if (field && !exposesRelationship(object.type, name)) {
          this.reportNotSelected(object.type, name, expression.property.span);
          return undefined;
        }
        if (field) {
          const type = this.valueType(field, isRowOrigin(object.type.origin) ? object.type.origin : "record");
          return {
            kind: "value",
            type,
            bound: { kind: "FieldRead", receiver: object.bound, field, fieldSpan: expression.property.span, type, span: expression.span },
          };
        }
        {
          const sublist = record.sublists.get(name);
          if (sublist && isRowOrigin(object.type.origin)) {
            this.diagnostics.error(
              DiagnosticCode.SublistOnQueryRow,
              `Sublist '${name}' is available only on a loaded or context ${record.name}; a ${object.type.origin} row has no lines. ` +
                `Load the record first: 'let x = load ${record.name}(${sourceOf(expression.object)}.id)', then 'for line in x.${name}'`,
              expression.property.span,
            );
            return undefined;
          }
          if (sublist) {
            const type = sublistType(object.type, sublist);
            return {
              kind: "value",
              type,
              bound: { kind: "SublistAccess", receiver: object.bound, sublist, nameSpan: expression.property.span, type, span: expression.span },
            };
          }
          this.reportUnknownField(record, expression.property, isRowOrigin(object.type.origin));
          return undefined;
        }
      }

      case "namespace": {
        const builtin = object.namespace.members.get(name);
        if (!builtin) {
          const supported = [...object.namespace.members.keys()].join(", ");
          this.diagnostics.error(
            DiagnosticCode.UnknownBuiltinMember,
            `'${name}' is not a supported ${object.namespace.memberNoun}. ` +
              `Supported ${object.namespace.memberNoun}s: ${supported}`,
            expression.property.span,
          );
          return undefined;
        }
        const reference: BuiltinReference = {
          kind: "BuiltinReference",
          builtin,
          nameSpan: expression.property.span,
          namespaceSpan: object.span,
          span: expression.span,
        };
        return { kind: "builtin", builtin, reference };
      }

      case "recordType":
        this.diagnostics.error(
          DiagnosticCode.MemberOnNonRecord,
          `'${object.record.name}' is a record type, not a record. ` +
            `Load one first, like 'let x = load ${object.record.name}(...)', then use 'x.${name}'`,
          expression.property.span,
        );
        return undefined;

      case "builtin":
        this.diagnostics.error(
          DiagnosticCode.MemberOnNonRecord,
          `'${object.builtin.name}' is a built-in function and has no member '${name}'`,
          expression.property.span,
        );
        return undefined;

      case "function":
        this.diagnostics.error(
          DiagnosticCode.MemberOnNonRecord,
          `'${object.function.name}' is a function and has no member '${name}'`,
          expression.property.span,
        );
        return undefined;
    }
  }

  /**
   * A numeric id must be a whole number: internal ids are integers, so
   * `Customer(1.5)` is a mistake the compiler can catch. A `number`-typed
   * expression cannot be checked statically and is converted when emitted.
   */
  private checkWholeNumberId(id: BoundExpression, what: string, span: Span): boolean {
    if (id.kind === "NumberLiteral" && !Number.isInteger(id.value)) {
      this.diagnostics.error(DiagnosticCode.InvalidRecordId, `Record id must be a whole number, but ${what} received ${id.value}`, span);
      return false;
    }
    return true;
  }

  /**
   * `Customer(123)`: a typed reference to one record. Syntactically a call
   * of a bare name; semantically a value of type Ref<Customer>, because the
   * name is a record type. No NetSuite module is needed to make one.
   */
  private denoteRecordReference(record: RecordSchema, expression: CallExpression, args: (BoundExpression | undefined)[]): Denotation | undefined {
    if (expression.typeArgument) {
      this.diagnostics.error(
        DiagnosticCode.RecordTypeArgument,
        `'${record.name}' is a record type, not an operation; a reference is written ${record.name}(id), like ${record.name}(123)`,
        expression.typeArgument.span,
      );
      return undefined;
    }
    if (expression.targetType) {
      this.diagnostics.error(DiagnosticCode.RecordTypeArgument, `A record reference takes no target type; remove 'to ${expression.targetType.name}'`, expression.targetType.span);
      return undefined;
    }
    if (args.length !== 1) {
      this.diagnostics.error(
        DiagnosticCode.ArgumentCount,
        `${record.name}(...) takes exactly one argument, the internal id, like ${record.name}(123); received ${args.length}`,
        expression.span,
      );
      return undefined;
    }
    const id = args[0];
    if (!id) return undefined;
    if (!acceptsArgument("RecordId", id.type)) {
      const hint = isReferenceType(id.type) ? ` (a reference is already ${typeName(id.type)}; its id is '${sourceOf(expression.arguments[0]!)}.id')` : "";
      this.diagnostics.error(
        DiagnosticCode.InvalidRecordId,
        `Record id must be a number or a string, but ${record.name}(...) received ${typeName(id.type)}${hint}`,
        expression.arguments[0]!.span,
      );
      return undefined;
    }
    if (!this.checkWholeNumberId(id, `${record.name}(...)`, expression.arguments[0]!.span)) return undefined;
    const type = referenceType(record);
    const reference: RecordReference = {
      kind: "RecordReference",
      recordType: { kind: "RecordTypeReference", record, span: expression.callee.span },
      id,
      type,
      span: expression.span,
    };
    return { kind: "value", type, bound: reference };
  }

  /** The Mynt type of a field read from `source`: scalars as declared, select fields as references when the schema names a target. */
  private valueType(field: FieldSchema, source: FieldSource): MyntType {
    return fieldValueType(field, source, (name) => this.schema.getRecordByName(name));
  }

  /**
   * `order.entity.email` on a search row, or `entity.email` in a search
   * condition: a field of the referenced record, reached through the one
   * join hop the schema proves (`refTarget`, a single select). It is an
   * ordinary member access on a reference everywhere else, which the
   * caller then handles (`id`, `text`, or an error that names the lookup
   * form), so the same syntax never implies hidden I/O: here the value is
   * a planned joined column of the same search. Returns "notJoined" when
   * the member is `id`/`text` or the receiver is not a search relationship.
   */
  private denoteJoinedMember(type: ReferenceType, receiver: BoundExpression, expression: MemberExpression, scope: Scope): Denotation | undefined | "notJoined" {
    const name = expression.property.name;
    if (name === "id" || name === "text") return "notJoined";
    // A relationship rooted at a search row's field, or at a bare field in a search condition.
    const rowField = receiver.kind === "FieldRead" && isRowLike(receiver.receiver.type) ? receiver : undefined;
    const conditionField = receiver.kind === "QueryField" && scope.querySource ? receiver : undefined;
    const deeper = receiver.kind === "JoinedFieldRead" || receiver.kind === "JoinedQueryField" ? receiver : undefined;
    if (!rowField && !conditionField && !deeper) return "notJoined";
    const backend = rowField ? (isSummaryType(rowField.receiver.type) ? "search" : (rowField.receiver.type as RecordType).origin) : conditionField ? scope.querySource : "search";
    const subject = sourceOf(expression.object);
    if (backend === "query") {
      this.diagnostics.error(
        DiagnosticCode.UnsupportedJoin,
        `'${subject}.${name}' follows a relationship, which 'search' plans as a join; N/query's join model is not supported yet, so use 'search' or look the field up with '${subject}[${name}]'`,
        expression.property.span,
      );
      return undefined;
    }
    if (deeper) {
      this.diagnostics.error(
        DiagnosticCode.UnsupportedJoin,
        `'${subject}.${name}' is a second join hop (${deeper.join.via.id} to ${deeper.join.target.name}, then ${deeper.field.id} to ${type.record.name}); joins are one hop deep for now. ` +
          `Look the field up explicitly instead: '${subject}[${name}]'`,
        expression.property.span,
      );
      return undefined;
    }
    const via = rowField ? rowField.field : conditionField!.field;
    const target = type.record;
    const field = target.fields.get(name);
    if (!field) {
      this.reportUnknownMember(`${target.name} (through ${via.id})`, target.fields.keys(), expression.property);
      return undefined;
    }
    if (rowField && isSummaryType(rowField.receiver.type)) {
      // On a summary row only a grouped joined field exists, with the type its grouping gave it.
      const grouped = summaryJoinedField(rowField.receiver.type, via.id, name);
      if (!grouped) {
        this.reportNotInSummary(rowField.receiver.type, `${via.id}.${name}`, expression.property.span);
        return undefined;
      }
      const read: JoinedFieldRead = { kind: "JoinedFieldRead", receiver: rowField, join: { via, target }, field, fieldSpan: expression.property.span, type: grouped.type, span: expression.span };
      return { kind: "value", type: grouped.type, bound: read };
    }
    if (rowField && !exposesJoinedField(rowField.receiver.type as RecordType, via.id, name)) {
      this.reportNotSelected(rowField.receiver.type as RecordType, `${via.id}.${name}`, expression.property.span);
      return undefined;
    }
    const join: JoinStep = { via, target };
    const valueType = this.valueType(field, "search");
    if (rowField) {
      const read: JoinedFieldRead = { kind: "JoinedFieldRead", receiver: rowField, join, field, fieldSpan: expression.property.span, type: valueType, span: expression.span };
      return { kind: "value", type: valueType, bound: read };
    }
    const condition: JoinedQueryField = { kind: "JoinedQueryField", base: conditionField!, join, field, fieldSpan: expression.property.span, type: valueType, span: expression.span };
    return { kind: "value", type: valueType, bound: condition };
  }

  /**
   * A member of a summary row: an aggregate by its alias, a grouped field by
   * its name (a joined one through its relationship, as on an ordinary row),
   * and nothing else. A bucket is not a record, so there is no `id`.
   */
  private denoteSummaryMember(type: SummaryType, receiver: BoundExpression, expression: MemberExpression): Denotation | undefined {
    const name = expression.property.name;
    const aggregate = summaryAggregate(type, name);
    if (aggregate) {
      return {
        kind: "value",
        type: aggregate.type,
        bound: { kind: "ResultFieldRead", receiver, result: aggregate, nameSpan: expression.property.span, type: aggregate.type, span: expression.span },
      };
    }
    const grouped = summaryField(type, name);
    if (grouped) {
      return {
        kind: "value",
        type: grouped.type,
        bound: { kind: "FieldRead", receiver, field: grouped.field!, fieldSpan: expression.property.span, type: grouped.type, span: expression.span },
      };
    }
    const field = type.record.fields.get(name);
    if (field && summaryExposesRelationship(type, name)) {
      // `row.entity` when only `entity.email` is grouped: the relationship, followed to its grouped fields; its own id and text are not fetched.
      const valueType = this.valueType(field, "search");
      return {
        kind: "value",
        type: valueType,
        bound: { kind: "FieldRead", receiver, field, fieldSpan: expression.property.span, type: valueType, span: expression.span },
      };
    }
    if (name === "id") {
      this.diagnostics.error(
        DiagnosticCode.MemberOnNonRecord,
        `A summary row is an aggregate bucket, not a ${type.record.name} record, so it has no 'id'. It exposes ${summaryResultNames(type).join(", ")}` +
          (type.fields.some((f) => f.summary === "group" && f.type && typeof f.type === "object" && f.type.kind === "Reference") ? `; a grouped select field carries the id of what it refers to, like 'row.${type.fields.find((f) => f.summary === "group" && typeof f.type === "object" && f.type.kind === "Reference")!.field!.id}.id'` : ""),
        expression.property.span,
      );
      return undefined;
    }
    this.reportNotInSummary(type, name, expression.property.span, field !== undefined);
    return undefined;
  }

  /** A member read from a summary row that is neither grouped nor an aggregate name. */
  private reportNotInSummary(row: SummaryType, what: string, span: Span, isField = true): void {
    const names = summaryResultNames(row);
    const hint = isField ? undefined : suggest(what, summaryMemberNames(row));
    this.diagnostics.error(
      DiagnosticCode.FieldNotProjected,
      isField
        ? `'${what}' is not part of this summary: a summary row of ${row.record.name} exposes only its grouped fields and aggregates, ${names.join(", ")}. Group by '${what}' or aggregate it in 'select'`
        : `A summary row of ${row.record.name} has no member '${what}'; it exposes ${names.join(", ")}` + (hint ? `. Did you mean '${hint}'?` : ""),
      span,
    );
  }

  /** A field read from a projected search row that its `select` does not expose. */
  private reportNotSelected(row: RecordType, what: string, span: Span): void {
    const selected = (row.exposes ?? []).map((e) => (e.join ? `${e.join.via.id}.${e.field.id}` : e.field.id));
    this.diagnostics.error(
      DiagnosticCode.FieldNotProjected,
      `'${what}' was not selected: this ${row.record.name} search selects ${selected.join(", ")}. Add it to the 'select' clause, '${[...selected, what].join(", ")}'`,
      span,
    );
  }

  /**
   * `ref.id` is the reference's identity; `ref.text` is display text, which
   * only a value that carries it has (never fetched on demand); any other
   * member needs a projection or a load.
   */
  private denoteReferenceMember(type: ReferenceType, receiver: BoundExpression, expression: MemberExpression): Denotation | undefined {
    const name = expression.property.name;
    // On a projected row, the reference's own id and text come with the reference column, which must itself be selected (grouped, on a summary row).
    if ((name === "id" || name === "text") && receiver.kind === "FieldRead" && isRowRecord(receiver.receiver.type) && !exposesField(receiver.receiver.type, receiver.field.id)) {
      this.reportNotSelected(receiver.receiver.type, receiver.field.id, expression.property.span);
      return undefined;
    }
    if ((name === "id" || name === "text") && receiver.kind === "FieldRead" && isSummaryType(receiver.receiver.type) && !summaryField(receiver.receiver.type, receiver.field.id)) {
      this.reportNotInSummary(receiver.receiver.type, receiver.field.id, expression.property.span);
      return undefined;
    }
    if (name === "id") {
      return {
        kind: "value",
        type: "Text",
        bound: { kind: "RecordIdRead", receiver, nameSpan: expression.property.span, type: "Text", span: expression.span },
      };
    }
    const record = type.record;
    const subject = sourceOf(expression.object);
    if (name === "text") {
      if (type.text) {
        return {
          kind: "value",
          type: "Text",
          bound: { kind: "ReferenceTextRead", receiver, nameSpan: expression.property.span, type: "Text", span: expression.span },
        };
      }
      this.diagnostics.error(
        DiagnosticCode.ReferenceWithoutText,
        `A ${record.name} reference has an id but no display text: '${subject}' identifies the record without fetching anything. ` +
          `Display text comes with a select field read through a lookup or a search row; ` +
          `to show a name, look it up explicitly, like '${subject}[${[...record.fields.keys()][0] ?? "name"}]'`,
        expression.property.span,
      );
      return undefined;
    }
    const field = record.fields.get(name);
    this.diagnostics.error(
      DiagnosticCode.MemberOnNonRecord,
      field
        ? `'${subject}' is a ${typeName(type)}: a reference to the record, not the record itself. ` +
          `Look the field up without loading, '${subject}[${name}]', or load the record, 'let x = load ${record.name}(${subject}.id)', then 'x.${name}'`
        : `${typeName(type)} has no member '${name}'; a reference has '.id'${type.text ? " and '.text'" : ""}` +
          (suggest(name, [...record.fields.keys()]) ? `. Did you mean '${suggest(name, [...record.fields.keys()])}', looked up as '${subject}[${suggest(name, [...record.fields.keys()])}]'?` : ""),
      expression.property.span,
    );
    return undefined;
  }

  /** `info.email` on a projection: only the projected fields exist. */
  private denoteProjectionMember(type: ProjectionType, receiver: BoundExpression, expression: MemberExpression): Denotation | undefined {
    const name = expression.property.name;
    const projected = type.fields.find((f) => f.field.id === name);
    if (projected) {
      return {
        kind: "value",
        type: projected.type,
        bound: { kind: "FieldRead", receiver, field: projected.field, fieldSpan: expression.property.span, type: projected.type, span: expression.span },
      };
    }
    const projectedNames = type.fields.map((f) => f.field.id);
    const subject = sourceOf(expression.object);
    const known = type.record.fields.get(name);
    const hint = suggest(name, projectedNames);
    this.diagnostics.error(
      DiagnosticCode.FieldNotProjected,
      known
        ? `'${name}' was not projected: '${subject}' holds only ${projectedNames.join(", ")} of ${type.record.name}. ` +
          `Add it where the projection is made, '[${[...projectedNames, name].join(", ")}]'`
        : `${type.record.name} has no field '${name}'` + (hint ? `. Did you mean '${hint}'?` : `; '${subject}' holds ${projectedNames.join(", ")}`),
      expression.property.span,
    );
    return undefined;
  }

  /**
   * `receiver[field, ...]`: a projection of schema fields. The receiver's
   * type decides where the values come from (see LookupSource); every
   * field is checked against the schema and listed once.
   */
  /**
   * `lookup receiver[fields]` / `lookup receiver select fields`: the explicit
   * spelling of a projection. Both normalize to the projection the receiver's
   * `[...]` would make, so the three spellings are one operation with one
   * lowering; the word only names it. The fields must be given once, as a
   * `[...]` or a `select`, and must be fields of the one record: no
   * aggregates, no joins, since a lookup has one known identity.
   */
  private denoteLookup(expression: LookupExpression, scope: Scope): Denotation | undefined {
    const { receiver, select } = expression;
    if (receiver.kind === "ProjectionExpression" && select) {
      this.diagnostics.error(
        DiagnosticCode.LookupWithoutFields,
        `Name the fields once: in the '[...]' or in 'select', not both`,
        select.keywordSpan,
      );
      return undefined;
    }
    if (receiver.kind === "ProjectionExpression") return this.denoteProjection(receiver, scope, expression.keywordSpan);
    if (!select) {
      this.bindValue(receiver, scope); // its own errors still surface
      this.diagnostics.error(
        DiagnosticCode.LookupWithoutFields,
        `'lookup' requires one or more selected fields: write 'lookup ${sourceOf(receiver)}[email, ...]' or 'lookup ${sourceOf(receiver)} select email, ...'. ` +
          `Use 'load ${receiver.kind === "CallExpression" && receiver.callee.kind === "Identifier" ? receiver.callee.name : "Customer"}(...)' to retrieve the full record`,
        expression.keywordSpan,
      );
      return undefined;
    }
    const fields: Identifier[] = [];
    let ok = true;
    for (const item of select.items) {
      if (item.value.kind === "AggregateCall") {
        ok = false;
        this.diagnostics.error(DiagnosticCode.InvalidAggregate, `A lookup reads fields of one record; '${item.value.function.name}(...)' aggregates rows, which is a search feature ('search T select ...')`, item.value.span);
        continue;
      }
      if (item.alias) {
        ok = false;
        this.diagnostics.error(DiagnosticCode.ResultName, `A lookup's fields keep their own names; only a search aggregate takes a result name. Write 'select ${sourceOf(item.value)}'`, item.equalsSpan ?? item.alias.span);
        continue;
      }
      if (item.value.kind !== "Identifier") {
        ok = false;
        this.diagnostics.error(
          DiagnosticCode.UnsupportedJoin,
          `A lookup reads fields of the one record it names; '${sourceOf(item.value)}' follows a relationship, which is a search feature. Look the referenced record up itself: '${sourceOf(item.value).split(".")[0]}[...]' on its reference`,
          item.value.span,
        );
        continue;
      }
      if (item.value.name === "") {
        ok = false; // cut short; the parser reported it
        continue;
      }
      fields.push(item.value);
    }
    if (!ok) {
      this.bindValue(receiver, scope);
      return undefined;
    }
    if (fields.length === 0) {
      this.bindValue(receiver, scope);
      return undefined; // the parser reported the empty select
    }
    const projection: ProjectionSyntax = { kind: "ProjectionExpression", receiver, fields, openSpan: select.keywordSpan, closeSpan: undefined, span: expression.span };
    return this.denoteProjection(projection, scope, expression.keywordSpan);
  }

  private denoteProjection(expression: ProjectionExpression, scope: Scope, keywordSpan?: Span): Denotation | undefined {
    const receiver = this.denote(expression.receiver, scope);
    if (!receiver) return undefined;
    const subject = sourceOf(expression.receiver);
    if (receiver.kind !== "value") {
      const message =
        receiver.kind === "recordType"
          ? `'${receiver.record.name}' is a record type; project fields from a reference to one record, like ${receiver.record.name}(123)[${expression.fields[0]?.name ?? "email"}]`
          : receiver.kind === "namespace"
            ? `'${receiver.namespace.name}' is a built-in namespace and has no fields to project`
            : receiver.kind === "builtin"
              ? `'${receiver.builtin.name}' is a built-in function and has no fields to project`
              : `'${receiver.function.name}' is a function and has no fields to project`;
      this.diagnostics.error(DiagnosticCode.ProjectionOnNonRecord, message, expression.receiver.span);
      return undefined;
    }

    let record: RecordSchema;
    let source: LookupSource;
    let valueSource: FieldSource;
    if (isReferenceType(receiver.type)) {
      record = receiver.type.record;
      source = "lookupFields";
      valueSource = "lookup";
    } else if (isRecordType(receiver.type)) {
      record = receiver.type.record;
      source = isRowOrigin(receiver.type.origin) ? "row" : "record";
      valueSource = isRowOrigin(receiver.type.origin) ? receiver.type.origin : "record";
    } else {
      const message = isProjectionType(receiver.type)
        ? `'${subject}' is already a projection (${typeName(receiver.type)}); name every field you need in the one '[...]' that makes it`
        : isLineType(receiver.type)
          ? `A sublist line cannot be projected; read its fields directly, like '${subject}.${[...receiver.type.sublist.fields.keys()][0] ?? "quantity"}'`
          : `Cannot project fields from a ${typeName(receiver.type)} value; '[...]' reads fields of a record reference, a record, or a row`;
      this.diagnostics.error(DiagnosticCode.ProjectionOnNonRecord, message, expression.receiver.span);
      return undefined;
    }

    const fields: LookupField[] = [];
    const seen = new Map<string, Span>();
    let ok = true;
    for (const identifier of expression.fields) {
      const field = record.fields.get(identifier.name);
      if (!field) {
        ok = false;
        this.reportUnknownMember(record.name, record.fields.keys(), identifier);
        continue;
      }
      const earlier = seen.get(field.id);
      if (earlier) {
        ok = false;
        this.diagnostics.error(
          DiagnosticCode.DuplicateProjectionField,
          `'${field.id}' is projected twice (first at column ${earlier.start.column}); list each field once`,
          identifier.span,
        );
        continue;
      }
      seen.set(field.id, identifier.span);
      fields.push({ kind: "LookupField", field, type: this.valueType(field, valueSource), span: identifier.span });
    }
    // An empty list is a syntax error the parser already reported.
    if (!ok || fields.length === 0) return undefined;

    if (source === "lookupFields") this.dependencies.add("N/search");
    const type = fields.length === 1 ? fields[0]!.type : projectionType(record, fields.map((f) => ({ field: f.field, type: f.type })));
    const lookup: Lookup = { kind: "Lookup", receiver: receiver.bound, record, fields, source, type, keywordSpan, span: expression.span };
    return { kind: "value", type, bound: lookup };
  }

  /** A write through a reference or projection: neither is a record, so say what to do instead. */
  private reportReadOnlyWrite(type: ReferenceType | ProjectionType, receiver: BoundExpression, what: string, span: Span): void {
    const name = receiver.kind === "LocalReference" ? `'${receiver.local.name}'` : `A ${typeName(type)} value`;
    const load = `'let x = load ${type.record.name}(${receiver.kind === "LocalReference" ? `${receiver.local.name}.id` : "..."})'`;
    const action = what === "saved" || what === "deleted" ? `cannot be ${what}` : `cannot be assigned ('${what}')`;
    this.diagnostics.error(
      DiagnosticCode.ReadOnlyReference,
      isReferenceType(type)
        ? `${name} is a ${typeName(type)}, a reference to the record rather than the record, and ${action}. ` +
          `To change the record, load it: ${isReferenceType(type) && receiver.kind === "LocalReference" ? load : `'let x = load ${type.record.name}(...)'`}, then ${what === "saved" ? "'save x'" : what === "deleted" ? "'delete x'" : `assign 'x.${what}'`}`
        : `${name} is a read-only projection (${typeName(type)}) of ${type.record.name} fields and ${action}. ` +
          `To change the record, load it with 'load ${type.record.name}(...)' and ${what === "saved" ? "save" : what === "deleted" ? "delete" : "assign"} that`,
      span,
    );
  }

  private denoteCall(expression: CallExpression, scope: Scope): Denotation | undefined {
    const callee = this.denote(expression.callee, scope);
    // Bind arguments even when the callee is bad so their errors surface too.
    const args = expression.arguments.map((arg) => this.bindValue(arg, scope));
    if (!callee) return undefined;

    if (callee.kind === "function") return this.denoteFunctionCall(callee.function, callee.span, expression, args);
    if (callee.kind === "recordType") return this.denoteRecordReference(callee.record, expression, args);

    if (callee.kind !== "builtin") {
      this.reportNotCallable(callee, expression);
      return undefined;
    }

    const { builtin } = callee;
    // `load File(456)` and the other loadable platform objects: the type after `load` decides the operation (see loadable.ts).
    if (expression.typeArgument && isPlatformTypeName(expression.typeArgument.name)) return this.denotePlatformLoad(builtin, expression, args);
    const record = this.bindRecordTypeArgument(builtin, expression, scope);
    if (record === null) return undefined;
    const recordType: RecordTypeReference | undefined =
      record && expression.typeArgument ? { kind: "RecordTypeReference", record, span: expression.typeArgument.span } : undefined;
    const targetType = this.bindTargetType(builtin, expression);
    if (targetType === null) return undefined;

    if (args.length !== builtin.parameters.length) {
      const expected = builtin.parameters.length;
      this.diagnostics.error(
        DiagnosticCode.ArgumentCount,
        `${builtin.name} expects ${expected} argument${expected === 1 ? "" : "s"}, but received ${args.length}`,
        expression.span,
      );
      return undefined;
    }

    let ok = true;
    const boundArgs: BoundExpression[] = [];
    builtin.parameters.forEach((expectedType, index) => {
      const arg = args[index];
      if (!arg) {
        ok = false;
        return;
      }
      if (!acceptsArgument(expectedType, arg.type)) {
        ok = false;
        if (expectedType === "RecordId") {
          const hint = isReferenceType(arg.type) ? `; a reference's id is '${sourceOf(expression.arguments[index]!)}.id'` : "";
          this.diagnostics.error(
            DiagnosticCode.InvalidRecordId,
            `Record id must be a number or a string, but ${builtin.name} ${record?.name ?? "T"}(...) received ${typeName(arg.type)}${hint}`,
            expression.arguments[index]!.span,
          );
          return;
        }
        this.diagnostics.error(
          DiagnosticCode.ArgumentType,
          `${builtin.name} argument ${index + 1} must be ${parameterTypeName(expectedType)}, but received ${typeName(arg.type)}`,
          expression.arguments[index]!.span,
        );
        return;
      }
      if (expectedType === "RecordId" && !this.checkWholeNumberId(arg, `${builtin.name} ${record?.name ?? "T"}(...)`, expression.arguments[index]!.span)) {
        ok = false;
        return;
      }
      boundArgs.push(arg);
    });
    if (!ok) return undefined;

    if (builtin.module) this.dependencies.add(builtin.module);

    // A record operation's result is the subject or target type written in
    // source. It belongs to the script, hence origin "owned".
    let type: MyntType;
    if (builtin.kind === "function") type = builtin.returns;
    else type = makeRecordType(builtin.returns === "target" ? targetType!.record : record!, "owned");

    const call: BuiltinCall = {
      kind: "BuiltinCall",
      builtin,
      callee: callee.reference,
      recordType,
      targetType,
      arguments: boundArgs,
      type,
      span: expression.span,
    };
    return { kind: "value", type, bound: call };
  }

  /**
   * A call to a user function. Arguments are checked by type as for a
   * built-in; a record argument must also be a named record that is not a
   * query row, since a row is not a record object at runtime. What the
   * function does to the record, and whether this argument's origin allows
   * it, is the lifecycle analysis's question.
   */
  private denoteFunctionCall(
    fn: BoundFunction,
    calleeSpan: Span,
    expression: CallExpression,
    args: (BoundExpression | undefined)[],
  ): Denotation | undefined {
    if (expression.typeArgument) {
      this.diagnostics.error(DiagnosticCode.RecordTypeArgument, `'${fn.name}' does not take a record type; write ${fn.name}(...)`, expression.typeArgument.span);
      return undefined;
    }
    if (expression.targetType) {
      this.diagnostics.error(DiagnosticCode.RecordTypeArgument, `'${fn.name}' does not take a target record type; remove 'to ${expression.targetType.name}'`, expression.targetType.span);
      return undefined;
    }
    if (args.length !== fn.parameters.length) {
      const expected = fn.parameters.length;
      this.diagnostics.error(
        DiagnosticCode.ArgumentCount,
        `'${fn.name}' expects ${expected} argument${expected === 1 ? "" : "s"} (${fn.parameters.map((p) => `${p.name}: ${typeName(p.type)}`).join(", ")}), but received ${args.length}`,
        expression.span,
      );
      return undefined;
    }

    let ok = true;
    const boundArgs: BoundExpression[] = [];
    fn.parameters.forEach((parameter, index) => {
      const arg = args[index];
      if (!arg) {
        ok = false;
        return;
      }
      const syntax = expression.arguments[index]!;
      if (!sameType(arg.type, parameter.type)) {
        ok = false;
        this.diagnostics.error(
          DiagnosticCode.ArgumentType,
          `'${fn.name}' parameter '${parameter.name}' must be ${typeName(parameter.type)}, but received ${typeName(arg.type)}`,
          syntax.span,
        );
        return;
      }
      if (isRecordType(parameter.type) && isRecordType(arg.type)) {
        if (isRowOrigin(arg.type.origin)) {
          ok = false;
          this.diagnostics.error(
            DiagnosticCode.ArgumentOrigin,
            `A ${arg.type.origin} row cannot be passed to '${fn.name}' as a ${parameter.type.record.name}: a row is a read-only view, not a record. ` +
              `Load it first: 'let x = load ${parameter.type.record.name}(${sourceOf(syntax)}.id)'`,
            syntax.span,
          );
          return;
        }
        if (arg.kind !== "LocalReference") {
          ok = false;
          this.diagnostics.error(
            DiagnosticCode.ArgumentOrigin,
            `Pass a named record to '${fn.name}': declare it first, like 'let x = load ${parameter.type.record.name}(...)', then '${fn.name}(x)'`,
            syntax.span,
          );
          return;
        }
      }
      boundArgs.push(arg);
    });
    if (!ok) return undefined;

    const call: FunctionCall = {
      kind: "FunctionCall",
      function: fn,
      callee: { kind: "FunctionReference", function: fn, span: calleeSpan },
      arguments: boundArgs,
      type: fn.returnType,
      span: expression.span,
    };
    return { kind: "value", type: fn.returnType, bound: call };
  }

  /**
   * Checks the record type written before a call's argument list against what
   * the built-in requires. Returns the record (or undefined when none is
   * required), or null after reporting an error.
   */
  private bindRecordTypeArgument(
    builtin: Builtin,
    expression: CallExpression,
    scope: Scope,
  ): RecordSchema | undefined | null {
    const typeArgument = expression.typeArgument;

    if (builtin.kind !== "recordOperation") {
      if (!typeArgument) return undefined;
      this.diagnostics.error(
        DiagnosticCode.RecordTypeArgument,
        `${builtin.name} does not take a record type; write ${builtin.name}(...)`,
        typeArgument.span,
      );
      return null;
    }

    if (!typeArgument) {
      this.diagnostics.error(
        DiagnosticCode.RecordTypeArgument,
        `${builtin.name} expects a record type before the argument list, like ${builtin.name} Customer(...)`,
        expression.callee.span,
      );
      return null;
    }

    // A record type name is resolved directly against the schema. If the name
    // means something else in scope, say so instead of "unknown record type".
    const record = this.schema.getRecordByName(typeArgument.name);
    if (record) return record;

    const local = scope.lookup(typeArgument.name);
    if (local) {
      this.diagnostics.error(
        DiagnosticCode.RecordTypeArgument,
        `${builtin.name} expects a record type, but '${typeArgument.name}' is a ${typeName(local.type)} value. ` +
          `Write the type name, like ${builtin.name} ${isRecordType(local.type) ? local.type.record.name : "Customer"}(...)`,
        typeArgument.span,
      );
      return null;
    }

    this.resolveRecordTypeName(typeArgument);
    return null;
  }

  /**
   * `load File(456)`: a loadable platform type after `load`. Only `load`
   * applies to one (`create File` means nothing), it takes one id, and the
   * result is the platform value. `Search` never reaches here: the parser
   * makes `load Search(id)` a search expression.
   */
  private denotePlatformLoad(builtin: Builtin, expression: CallExpression, args: (BoundExpression | undefined)[]): Denotation | undefined {
    const name = expression.typeArgument!.name;
    const platform = platformType(name)!;
    if (builtin.id !== "load") {
      this.diagnostics.error(
        DiagnosticCode.RecordTypeArgument,
        `'${name}' is a platform type that can only be loaded: '${platform.example}'. ${builtin.name} works on record types`,
        expression.typeArgument!.span,
      );
      return undefined;
    }
    if (platform.kind === "search") {
      this.diagnostics.error(DiagnosticCode.InvalidSavedSearchId, `Expected the saved search's script id, like '${platform.example}'`, expression.span);
      return undefined;
    }
    if (expression.targetType) {
      this.diagnostics.error(DiagnosticCode.RecordTypeArgument, `load does not take a target record type; remove 'to ${expression.targetType.name}'`, expression.targetType.span);
      return undefined;
    }
    if (args.length !== 1) {
      this.diagnostics.error(DiagnosticCode.ArgumentCount, `load ${name}(...) expects 1 argument, the file's internal id, but received ${args.length}`, expression.span);
      return undefined;
    }
    const id = args[0];
    if (!id) return undefined;
    if (!acceptsArgument("RecordId", id.type)) {
      this.diagnostics.error(DiagnosticCode.InvalidRecordId, `A file id must be a number or a string, but load ${name}(...) received ${typeName(id.type)}`, expression.arguments[0]!.span);
      return undefined;
    }
    if (!this.checkWholeNumberId(id, `load ${name}(...)`, expression.arguments[0]!.span)) return undefined;
    this.dependencies.add(platform.module);
    const load: FileLoad = { kind: "FileLoad", id, operationSpan: expression.callee.span, typeSpan: expression.typeArgument!.span, type: "File", span: expression.span };
    return { kind: "value", type: "File", bound: load };
  }

  /**
   * The `to U` clause: required for operations with a target, an error for
   * the rest. Returns the reference, undefined when none applies, or null
   * after reporting.
   */
  private bindTargetType(builtin: Builtin, expression: CallExpression): RecordTypeReference | undefined | null {
    const { targetType } = expression;
    const wantsTarget = builtin.kind === "recordOperation" && builtin.target;
    if (!wantsTarget) {
      if (!targetType) return undefined;
      this.diagnostics.error(
        DiagnosticCode.RecordTypeArgument,
        `${builtin.name} does not take a target record type; remove 'to ${targetType.name}'`,
        targetType.span,
      );
      return null;
    }
    if (!targetType) {
      this.diagnostics.error(
        DiagnosticCode.RecordTypeArgument,
        `${builtin.name} expects a target record type after the arguments, like ${builtin.name} SalesOrder(...) to Invoice`,
        expression.span,
      );
      return null;
    }
    const record = this.resolveRecordTypeName(targetType);
    return record ? { kind: "RecordTypeReference", record, span: targetType.span } : null;
  }

  private reportNotCallable(callee: Exclude<Denotation, { kind: "builtin" | "function" }>, expression: CallExpression): void {
    let message: string;
    switch (callee.kind) {
      case "namespace": {
        const members = [...callee.namespace.members.keys()].map((m) => `${callee.namespace.name}.${m}`);
        message = `'${callee.namespace.name}' is a built-in namespace and cannot be called. Did you mean ${members.join(", ")}?`;
        break;
      }
      case "recordType":
        message = `'${callee.record.name}' is a record type and cannot be called. Did you mean 'load ${callee.record.name}(...)'?`;
        break;
      case "value":
        message =
          callee.bound.kind === "LocalReference"
            ? `'${callee.bound.local.name}' is a ${typeName(callee.type)} value and cannot be called`
            : `A ${typeName(callee.type)} value cannot be called`;
        break;
    }
    this.diagnostics.error(DiagnosticCode.NotCallable, message, expression.callee.span);
  }
}
