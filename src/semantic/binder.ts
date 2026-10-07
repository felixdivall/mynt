import { DiagnosticBag, DiagnosticCode, type Span } from "../diagnostics.js";
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
  QueryExpression,
  RemoveStatement,
  ReturnStatement,
  SaveStatement,
  ScheduledDeclaration,
  SourceFile,
  Statement,
  UnaryExpression,
  UserEventDeclaration,
} from "../parser/ast.js";
import type { SchemaProvider } from "../schema/provider.js";
import type { RecordSchema, SublistSchema } from "../schema/types.js";
import {
  builtinRootNames,
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
  type LineBinding,
  type LineInitializer,
  type ComparisonOperation,
  type LocalSymbol,
  type Logical,
  type Query,
  type QueryPredicate,
  type SublistAccess,
  type QueryValue,
  type RecordTypeReference,
  type ScopedLocal,
  type ScriptUnit,
  type UserEventType,
} from "./bound.js";
import { suggest } from "./suggest.js";
import {
  isLineType,
  isRecordType,
  isSequenceType,
  isSublistType,
  recordType as makeRecordType,
  sameType,
  sequenceType,
  sublistName,
  sublistType,
  typeName,
  type LineType,
  type RecordType,
  type MyntType,
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

  constructor(
    /** Entry point hook, for context-dependent checks such as afterSubmit writes; "function" inside a function body. */
    readonly hook: "beforeSubmit" | "afterSubmit" | "execute" | "function",
    /** The block this scope covers; locals declared here are visible until its end. */
    readonly span: Span,
    private readonly parent?: Scope,
    /** Inside a query condition: the record whose fields bare names denote. */
    readonly queryRecord?: RecordSchema,
    /** Inside a sublist loop body: the line being iterated. */
    readonly iterating?: LineBinding,
    /** What `return` may carry: a function's declared type, or Void in an entry point. */
    readonly returns: MyntType | "Void" = "Void",
    /** The function whose body this scope belongs to, for messages. */
    readonly functionName?: string,
  ) {}

  child(block: Block, iterating?: LineBinding): Scope {
    return new Scope(this.hook, block.span, this, undefined, iterating, this.returns, this.functionName);
  }

  /** Whether `parent.sublist` is being iterated by this scope or an enclosing one. */
  isIterating(parent: LocalSymbol, sublist: SublistSchema): boolean {
    if (this.iterating && this.iterating.parent === parent && this.iterating.sublist === sublist) return true;
    return this.parent?.isIterating(parent, sublist) ?? false;
  }

  /** The scope of a query condition: the enclosing scope plus the record's fields. */
  conditionScope(record: RecordSchema, span: Span): Scope {
    return new Scope(this.hook, span, this, record, undefined, this.returns, this.functionName);
  }

  lookup(name: string): LocalSymbol | undefined {
    return this.locals.get(name) ?? this.parent?.lookup(name);
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
      return typeof expression.type === "string" && expression.type !== "Void" ? { kind: "Local", local: expression.local } : undefined;
    default:
      return undefined;
  }
}

/** Whether every path through `body` ends in a `return`. Loops do not count: they may run zero times. */
function definitelyReturns(body: readonly BoundStatement[]): boolean {
  return body.some((statement) => {
    if (statement.kind === "Return") return true;
    if (statement.kind === "If") return statement.elseBody !== undefined && definitelyReturns(statement.thenBody) && definitelyReturns(statement.elseBody);
    return false;
  });
}

/** The source spelling of a simple expression, for hints: `order.item`. */
function sourceOf(expression: Expression): string {
  switch (expression.kind) {
    case "Identifier":
      return expression.name;
    case "MemberExpression":
      return `${sourceOf(expression.object)}.${expression.property.name}`;
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
            ? `'${name}' cannot return a ${known.name}: functions return Text, Number, or Bool; records flow in through parameters`
            : `Unknown return type '${declaration.returnType.name}'. Functions return Text, Number, or Bool`,
          declaration.returnType.span,
        );
      }
    }

    const fn: BoundFunction = { kind: "Function", name, nameSpan: declaration.name.span, parameters, returnType, body: [], span: declaration.span };
    this.functions.set(name, fn);
    this.functionList.push(fn);
  }

  private resolveValueTypeName(name: string): FieldType | "Bool" | undefined {
    return name === "Text" || name === "Number" || name === "Bool" ? name : undefined;
  }

  /** Text, Number, Bool, or a record type. Lines, sublists, and query results cannot be parameters. */
  private resolveParameterType(type: Identifier, functionName: string): MyntType | undefined {
    const value = this.resolveValueTypeName(type.name);
    if (value) return value;
    const record = this.schema.getRecordByName(type.name);
    if (record) return makeRecordType(record, "parameter");
    const known = this.schema.listRecords().map((r) => r.name).sort();
    const hint = suggest(type.name, ["Text", "Number", "Bool", ...known]);
    this.diagnostics.error(
      DiagnosticCode.InvalidSignatureType,
      `Unknown parameter type '${type.name}' in '${functionName}'. ` +
        (hint ? `Did you mean '${hint}'? ` : "") +
        `Parameters are Text, Number, Bool, or a record type (${known.join(", ")})`,
      type.span,
    );
    return undefined;
  }

  private bindFunctionBody(declaration: FunctionDeclaration): void {
    const fn = this.functions.get(declaration.name.name);
    if (!fn || fn.nameSpan !== declaration.name.span) return; // a duplicate: its body is not bound
    const scope = new Scope("function", declaration.body.span, undefined, undefined, undefined, fn.returnType, fn.name);
    for (const parameter of fn.parameters) {
      scope.declare(parameter);
      this.symbols.push({ local: parameter, scope: declaration.body.span });
    }
    fn.body = this.bindBlock(declaration.body, scope);
    if (fn.returnType !== "Void" && !definitelyReturns(fn.body)) {
      this.diagnostics.error(
        DiagnosticCode.MissingReturn,
        `'${fn.name}' returns ${fn.returnType} but not every path ends in 'return'`,
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
          scope.functionName ? `'${scope.functionName}' returns no value; remove the value or declare '-> ${typeName(value.type)}'` : `${where} returns no value`,
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
    const initializer = this.bindValue(statement.initializer, scope);
    if (!initializer) return undefined;

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

    if (object.type.origin === "query") {
      this.diagnostics.error(
        DiagnosticCode.ReadOnlyQueryResult,
        `Query result '${receiver.local.name}' is read-only. Load the record before modifying it: ` +
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
        `Cannot assign ${typeName(boundValue.type)} to ${record.name}.${field.id}, which is ${field.type}`,
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
          `Cannot assign ${typeName(value.type)} to ${owner}.${field.id}, which is ${field.type}`,
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
        `Cannot assign ${typeName(boundValue.type)} to ${owner}.${field.id}, which is ${field.type}`,
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

    if (target.type.origin === "query") {
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
    if (!isRecordType(target.type)) return;
    const name = target.kind === "LocalReference" ? target.local.name : "it";
    this.diagnostics.error(
      DiagnosticCode.ReadOnlyQueryResult,
      `Query result '${name}' cannot be ${verb}: a query row is a read-only view. ` +
        `Load the record first: 'let x = load ${target.type.record.name}(${name}.id)', then '${verb === "saved" ? "save" : "delete"} x'`,
      span,
    );
  }

  private bindSave(statement: SaveStatement, scope: Scope): BoundStatement | undefined {
    const target = this.bindRecordTarget(statement.target, "saved", scope);
    if (!target || !isRecordType(target.type)) return undefined;

    if (target.type.origin === "query") {
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
    const condition = this.bindValue(statement.condition, scope);

    if (condition && condition.type !== "Bool") {
      // No truthiness: "" / 0 / a record reference are not conditions.
      this.diagnostics.error(
        DiagnosticCode.ConditionNotBool,
        `if condition must be Bool, but received ${typeName(condition.type)}. ` +
          `Mynt has no truthiness: compare the value explicitly, for example with == or !=`,
        statement.condition.span,
      );
    }

    // Bind both branches even when the condition failed, so their errors surface.
    const thenBody = this.bindBlock(statement.thenBlock, scope.child(statement.thenBlock));
    const elseBody = statement.elseBlock ? this.bindBlock(statement.elseBlock, scope.child(statement.elseBlock)) : undefined;

    if (!condition || condition.type !== "Bool") return undefined;
    return { kind: "If", condition, thenBody, elseBody, span: statement.span };
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
            `Did you mean to load one, like 'load ${denotation.record.name}(...)'?`,
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
          `operator '${operator}' requires Bool operands, but the ${side} operand is ${typeName(operand.type)}. ` +
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
        `operator '!' requires Bool, but received ${typeName(operand.type)}. ` +
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

    if (!sameType(left.type, right.type)) {
      this.diagnostics.error(
        DiagnosticCode.IncomparableTypes,
        `Cannot compare ${typeName(left.type)} with ${typeName(right.type)}: both sides of '${operator}' must have the same type`,
        expression.span,
      );
      return undefined;
    }

    const operandType = left.type;
    if (operandType !== "Text" && operandType !== "Number") {
      const what = isRecordType(operandType) ? `records (${operandType.record.name})` : `${typeName(operandType)} values`;
      const hint =
        operandType === "Bool" && (operator === "==" || operator === "!=")
          ? `. Use a Bool directly as a condition: 'if x' or 'if !x'`
          : "";
      this.diagnostics.error(
        DiagnosticCode.UnsupportedComparison,
        `'${operator}' is not defined for ${what}; comparisons are defined for Text and Number values${hint}`,
        expression.operatorSpan,
      );
      return undefined;
    }

    if (ordering && operandType !== "Number") {
      this.diagnostics.error(
        DiagnosticCode.UnsupportedComparison,
        `'${operator}' is not defined for ${operandType} values; ordering comparisons require Number operands`,
        expression.operatorSpan,
      );
      return undefined;
    }

    const comparison: Comparison = {
      kind: "Comparison",
      operation,
      operandType,
      left,
      right,
      type: "Bool",
      span: expression.span,
    };
    return { kind: "value", type: "Bool", bound: comparison };
  }

  /**
   * `query Customer where ...`: the condition is bound like any expression,
   * in a scope where bare names are the record's fields, and then
   * translated into a backend-neutral predicate. The value is the executed
   * result, a Sequence of query rows.
   */
  private denoteQuery(expression: QueryExpression, scope: Scope): Denotation | undefined {
    const record = this.resolveRecordTypeName(expression.recordType);
    let condition: BoundExpression | undefined;
    let predicate: QueryPredicate | undefined;
    if (record && expression.condition) {
      condition = this.bindValue(expression.condition, scope.conditionScope(record, expression.condition.span));
      if (!condition) return undefined;
      if (condition.type !== "Bool") {
        this.diagnostics.error(
          DiagnosticCode.ConditionNotBool,
          `where condition must be Bool, but received ${typeName(condition.type)}. Compare a field, for example 'where email != ""'`,
          expression.condition.span,
        );
        return undefined;
      }
      predicate = this.toPredicate(condition, expression.condition);
      if (!predicate) return undefined;
    } else if (expression.condition) {
      this.bindValue(expression.condition, scope); // report its errors even without a record
    }
    if (!record) return undefined;
    this.dependencies.add("N/query");

    const type = sequenceType(record);
    const query: Query = {
      kind: "Query",
      recordType: { kind: "RecordTypeReference", record, span: expression.recordType.span },
      condition,
      predicate,
      type,
      span: expression.span,
    };
    return { kind: "value", type, bound: query };
  }

  /** The predicate shapes the backends can express. Anything else is reported, never approximated. */
  private toPredicate(condition: BoundExpression, syntax: Expression): QueryPredicate | undefined {
    const unsupported = (why: string, span: Span = condition.span): undefined => {
      this.diagnostics.error(DiagnosticCode.UnsupportedQueryCondition, `Unsupported query condition: ${why}`, span);
      return undefined;
    };
    switch (condition.kind) {
      case "QueryField":
        return condition.type === "Bool" ? { kind: "Flag", field: condition.field, value: true } : unsupported(`'${condition.field.id}' is not a Bool field`);
      case "Not": {
        const operand = this.toPredicate(condition.operand, syntax);
        return operand && { kind: "Not", operand };
      }
      case "Logical": {
        const left = this.toPredicate(condition.left, syntax);
        const right = this.toPredicate(condition.right, syntax);
        return left && right ? { kind: condition.operation === "And" ? "And" : "Or", left, right } : undefined;
      }
      case "Comparison": {
        const fieldOnLeft = condition.left.kind === "QueryField";
        const fieldSide = fieldOnLeft ? condition.left : condition.right;
        const valueSide = fieldOnLeft ? condition.right : condition.left;
        if (fieldSide.kind !== "QueryField") {
          return unsupported("one side of the comparison must be a field of the queried record");
        }
        if (valueSide.kind === "QueryField") {
          return unsupported("a field can be compared with a value, not with another field");
        }
        const value = queryValue(valueSide);
        if (!value) return unsupported("a field can only be compared with a literal or a local value", valueSide.span);
        // Flip the operation when the field is on the right: `"" != email` is `email != ""`; `1 < total` is `total > 1`.
        const operation = fieldOnLeft ? condition.operation : FLIPPED[condition.operation];
        return { kind: "Compare", field: fieldSide.field, operation, value };
      }
      default:
        return unsupported("a query condition compares fields of the queried record with values");
    }
  }

  /** Resolution order: query fields (inside `where`), then locals, built-ins, and record types (see resolveName). */
  private denoteIdentifier(identifier: Identifier, scope: Scope): Denotation | undefined {
    const { name, span } = identifier;

    const queryRecord = scope.queryRecord;
    if (queryRecord) {
      const field = queryRecord.fields.get(name);
      const local = scope.lookup(name);
      if (field && local) {
        this.diagnostics.error(
          DiagnosticCode.AmbiguousQueryName,
          `'${name}' is both a field of ${queryRecord.name} and a local in scope; inside 'where' a bare name is the field. Rename the local to use it here`,
          span,
        );
        return undefined;
      }
      if (field) {
        return { kind: "value", type: field.type, bound: { kind: "QueryField", record: queryRecord, field, type: field.type, span } };
      }
    }

    const resolved = resolveName(name, scope.lookup(name), this.schema, this.functions);
    switch (resolved?.kind) {
      case "local": {
        const { local } = resolved;
        return { kind: "value", type: local.type, bound: { kind: "LocalReference", local, type: local.type, span } };
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
        if (!isRecordType(object.type)) {
          this.diagnostics.error(
            DiagnosticCode.MemberOnNonRecord,
            `Cannot access '.${name}' on a ${typeName(object.type)} value`,
            expression.property.span,
          );
          return undefined;
        }
        const record = object.type.record;
        if (object.type.origin === "query" && name === "id") {
          // A query row carries the record's identity. It is a language
          // property, not a schema field, so it is bound as its own node.
          return {
            kind: "value",
            type: "Text",
            bound: { kind: "RecordIdRead", receiver: object.bound, nameSpan: expression.property.span, type: "Text", span: expression.span },
          };
        }
        const field = record.fields.get(name);
        if (!field) {
          const sublist = record.sublists.get(name);
          if (sublist && object.type.origin === "query") {
            this.diagnostics.error(
              DiagnosticCode.SublistOnQueryRow,
              `Sublist '${name}' is available only on a loaded or context ${record.name}; a query row has no lines. ` +
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
          this.reportUnknownField(record, expression.property, object.type.origin === "query");
          return undefined;
        }
        return {
          kind: "value",
          type: field.type,
          bound: { kind: "FieldRead", receiver: object.bound, field, fieldSpan: expression.property.span, type: field.type, span: expression.span },
        };
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

  private denoteCall(expression: CallExpression, scope: Scope): Denotation | undefined {
    const callee = this.denote(expression.callee, scope);
    // Bind arguments even when the callee is bad so their errors surface too.
    const args = expression.arguments.map((arg) => this.bindValue(arg, scope));
    if (!callee) return undefined;

    if (callee.kind === "function") return this.denoteFunctionCall(callee.function, callee.span, expression, args);

    if (callee.kind !== "builtin") {
      this.reportNotCallable(callee, expression);
      return undefined;
    }

    const { builtin } = callee;
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
      if (!sameType(arg.type, expectedType)) {
        ok = false;
        this.diagnostics.error(
          DiagnosticCode.ArgumentType,
          `${builtin.name} argument ${index + 1} must be ${expectedType}, but received ${typeName(arg.type)}`,
          expression.arguments[index]!.span,
        );
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
        if (arg.type.origin === "query") {
          ok = false;
          this.diagnostics.error(
            DiagnosticCode.ArgumentOrigin,
            `A query row cannot be passed to '${fn.name}' as a ${parameter.type.record.name}: a row is a read-only view, not a record. ` +
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
