/**
 * SuiteScript 2.1 backend. Consumes a bound ScriptUnit, never the AST.
 *
 * Output is deliberately plain: a JSDoc header, an AMD `define` whose
 * dependency list comes from the unit's inferred dependencies, one function
 * per entry point, `setValue`/`getValue`/`save`/`log.*`/`record.load`
 * calls, and `if` statements whose conditions use strict comparison.
 *
 * Expressions are lowered to strings that may span several lines, with
 * continuation lines indented relative to the first; the Writer re-indents
 * every line to the current depth. That keeps nested object literals
 * readable without an AST printer.
 */
import type { BuiltinId, NetSuiteModule } from "../semantic/builtins.js";
import type {
  BoundExpression,
  BoundScheduledEntryPoint,
  BoundStatement,
  BoundUserEventEntryPoint,
  BoundFunction,
  BuiltinCall,
  ComparisonOperation,
  LineBinding,
  LocalSymbol,
  Logical,
  Query,
  QueryPredicate,
  ScriptUnit,
  UserEventType,
} from "../semantic/bound.js";
import { isLineType, isRecordType } from "../semantic/types.js";
import { directExpressions, forEachExpression, forEachStatement } from "../semantic/walk.js";
import type { RecordSchema } from "../schema/types.js";

const INDENT = "    ";

/** Sail event names map 1:1 onto `context.UserEventType` constants. */
const USER_EVENT_CONSTANTS: Record<UserEventType, string> = {
  create: "CREATE",
  edit: "EDIT",
  view: "VIEW",
  copy: "COPY",
  delete: "DELETE",
  xedit: "XEDIT",
  approve: "APPROVE",
  cancel: "CANCEL",
  reject: "REJECT",
  pack: "PACK",
  ship: "SHIP",
  dropship: "DROPSHIP",
  specialorder: "SPECIALORDER",
  orderitems: "ORDERITEMS",
  paybills: "PAYBILLS",
};

/** Preferred local binding name for each module in the `define` factory parameters. */
const MODULE_LOCAL_NAMES: Record<NetSuiteModule, string> = {
  "N/log": "log",
  "N/record": "record",
  "N/query": "query",
};

/** `query.Operator` members for each Sail comparison, on Text/Number fields. */
const QUERY_OPERATORS: Record<ComparisonOperation, string> = {
  Equal: "EQUAL",
  NotEqual: "EQUAL_NOT",
  Less: "LESS",
  LessOrEqual: "LESS_OR_EQUAL",
  Greater: "GREATER",
  GreaterOrEqual: "GREATER_OR_EQUAL",
};

/** The name of the emitted query helper. `$` keeps it clear of Sail locals. */
const QUERY_HELPER = "sail$query";

/**
 * Sail `==` and `!=` are semantic equality on operands the binder has already
 * proven to have one type, so they lower to the strict operators. The loose
 * JavaScript operators would only add coercions Sail never permits.
 */
const COMPARISON_OPERATORS: Record<ComparisonOperation, string> = {
  Equal: "===",
  NotEqual: "!==",
  Less: "<",
  LessOrEqual: "<=",
  Greater: ">",
  GreaterOrEqual: ">=",
};

const LOGICAL_OPERATORS: Record<Logical["operation"], string> = {
  And: "&&",
  Or: "||",
};

/**
 * JavaScript precedence of each bound expression form, higher binding
 * tighter. The printer parenthesizes an operand only when its form binds
 * looser than its position requires, so output carries exactly the
 * parentheses JavaScript needs and no more.
 */
const PRECEDENCE = {
  Or: 1,
  And: 2,
  Equality: 3,
  Relational: 4,
  Not: 5,
  /** Literals, locals, member and call expressions. */
  Primary: 6,
} as const;

function precedenceOf(expression: BoundExpression): number {
  switch (expression.kind) {
    case "Logical":
      return expression.operation === "Or" ? PRECEDENCE.Or : PRECEDENCE.And;
    case "Comparison":
      return expression.operation === "Equal" || expression.operation === "NotEqual"
        ? PRECEDENCE.Equality
        : PRECEDENCE.Relational;
    case "Not":
      return PRECEDENCE.Not;
    default:
      return PRECEDENCE.Primary;
  }
}

const SCRIPT_TYPE_ANNOTATION: Record<ScriptUnit["kind"], string> = {
  UserEvent: "UserEventScript",
  Scheduled: "ScheduledScript",
};

/**
 * Names the emitter introduces (`context`, module locals) must not collide
 * with Sail locals, which become JavaScript locals under their own names.
 * `$` cannot appear in a Sail identifier, so appending it always frees a name.
 */
class NameAllocator {
  constructor(private readonly reserved: ReadonlySet<string>) {}

  fresh(base: string): string {
    let name = base;
    while (this.reserved.has(name)) name += "$";
    return name;
  }
}

/** Per-unit and per-entry-point information lowerings need. */
interface EmitContext {
  entryPointName: string;
  /** The entry point's context parameter name. */
  contextName: string;
  moduleLocal(module: NetSuiteModule): string;
  /**
   * For a new record (create, copy, transform) that is deleted later: the
   * JavaScript variable holding the id its save returned. A loaded record
   * has `Record.id`; a record the script made has an id only in the value
   * `save()` returns, so that value is kept.
   */
  capturedId(local: LocalSymbol): string | undefined;
  /** Columns a query must fetch: `id` plus every field read from its rows. */
  queryColumns(query: Query): string[];
  /** For a line local: its binding from the unit. The index variable is derived from the line's name. */
  line(local: LocalSymbol): LineBinding | undefined;
}

/** The JavaScript index variable of a line local. `$` keeps it clear of Sail locals, and names cannot be shadowed. */
function lineIndex(binding: LineBinding): string {
  return `${binding.line.name}$index`;
}

/** The flag set when a loop body removed its current line, so the index does not advance. */
function lineRemovedFlag(binding: LineBinding): string {
  return `${binding.line.name}$removed`;
}

export function emitSuiteScript(unit: ScriptUnit): string {
  const writer = new Writer();
  const names = new NameAllocator(collectLocalNames(unit));

  // Sorted so generated output does not depend on bind order.
  const modules = [...unit.dependencies].sort();
  const moduleLocals = new Map(modules.map((m) => [m, names.fresh(MODULE_LOCAL_NAMES[m])]));
  const contextName = names.fresh("context");
  const moduleLocal = (module: NetSuiteModule): string => {
    const local = moduleLocals.get(module);
    if (!local) throw new Error(`Module ${module} was not declared as a dependency of ${unit.file}`);
    return local;
  };
  const captured = capturedIds(unit);
  const capturedId = (local: LocalSymbol): string | undefined => captured.get(local);
  const columns = planQueryColumns(unit);
  const queryColumns = (query: Query): string[] => ["id", ...[...(columns.get(query) ?? new Set<string>())].sort()];
  const line = (local: LocalSymbol): LineBinding | undefined => unit.lineBindings.get(local);

  writer.line("/**");
  writer.line(" * @NApiVersion 2.1");
  writer.line(` * @NScriptType ${SCRIPT_TYPE_ANNOTATION[unit.kind]}`);
  writer.line(" * @NModuleScope SameAccount");
  writer.line(` * Generated by Sail from ${unit.file}.${unit.kind === "UserEvent" ? ` Target record: ${unit.record.id}.` : ""}`);
  writer.line(" */");

  const dependencyList = modules.map((m) => jsString(m)).join(", ");
  const factoryParams = modules.map((m) => moduleLocals.get(m)!).join(", ");
  writer.line(`define([${dependencyList}], (${factoryParams}) => {`);
  writer.indent();

  if (unit.dependencies.has("N/query")) {
    emitQueryHelper(writer, moduleLocal("N/query"));
    writer.blank();
  }

  for (const fn of unit.functions) {
    emitFunction(writer, fn, { entryPointName: fn.name, contextName, moduleLocal, capturedId, queryColumns, line });
    writer.blank();
  }

  const exported: string[] = [];
  switch (unit.kind) {
    case "UserEvent":
      unit.entryPoints.forEach((entryPoint, index) => {
        if (index > 0) writer.blank();
        emitUserEventEntryPoint(writer, entryPoint, { entryPointName: entryPoint.hook, contextName, moduleLocal, capturedId, queryColumns, line });
        exported.push(entryPoint.hook);
      });
      break;
    case "Scheduled":
      emitScheduledEntryPoint(writer, unit.entryPoint, { entryPointName: "execute", contextName, moduleLocal, capturedId, queryColumns, line });
      exported.push(unit.entryPoint.hook);
      break;
  }

  if (exported.length > 0) writer.blank();
  writer.line(`return { ${exported.join(", ")} };`);

  writer.dedent();
  writer.line("});");

  return writer.toString();
}

function bodies(unit: ScriptUnit): readonly BoundStatement[][] {
  const entryPoints = unit.kind === "UserEvent" ? unit.entryPoints.map((e) => e.body) : [unit.entryPoint.body];
  return [...unit.functions.map((f) => f.body), ...entryPoints];
}

/** A Sail function is a plain JavaScript function in the module factory. */
function emitFunction(writer: Writer, fn: BoundFunction, context: EmitContext): void {
  writer.line(`function ${fn.name}(${fn.parameters.map((p) => p.name).join(", ")}) {`);
  writer.indent();
  emitBody(writer, fn.body, context, false);
  writer.dedent();
  writer.line("}");
}

/**
 * Which fields each query must fetch: every field read from a loop variable
 * iterating it. A query reached through a local (`let rows = query ...`,
 * possibly re-bound by another `let`) is resolved to its Query node.
 */
function planQueryColumns(unit: ScriptUnit): Map<Query, Set<string>> {
  const queryOf = new Map<LocalSymbol, Query>();
  for (const body of bodies(unit)) {
    forEachStatement(body, (s) => {
      if (s.kind !== "LocalDeclaration") return;
      const query = resolveQuery(s.initializer, queryOf);
      if (query) queryOf.set(s.local, query);
    });
  }
  const columns = new Map<Query, Set<string>>();
  for (const body of bodies(unit)) {
    forEachStatement(body, (s) => {
      if (s.kind !== "ForEach") return;
      const query = resolveQuery(s.iterable, queryOf);
      if (!query) return;
      const fields = columns.get(query) ?? new Set<string>();
      columns.set(query, fields);
      forEachStatement(s.body, (inner) => collectRowFields(inner, s.local, fields));
    });
  }
  return columns;
}

function resolveQuery(expression: BoundExpression, queryOf: Map<LocalSymbol, Query>): Query | undefined {
  if (expression.kind === "Query") return expression;
  if (expression.kind === "LocalReference") return queryOf.get(expression.local);
  return undefined;
}

/** Fields read from `row` anywhere in a statement's expressions (nested bodies are visited by the caller). */
function collectRowFields(statement: BoundStatement, row: LocalSymbol, into: Set<string>): void {
  for (const root of directExpressions(statement)) {
    forEachExpression(root, (expression) => {
      if (expression.kind === "FieldRead" && expression.receiver.kind === "LocalReference" && expression.receiver.local === row) {
        into.add(expression.field.id);
      }
    });
  }
}

/** Whether a loop body removes the line it iterates, which decides the loop's lowering. */
function removesOwnLine(body: readonly BoundStatement[], binding: LineBinding): boolean {
  let found = false;
  forEachStatement(body, (statement) => {
    if (statement.kind === "RemoveLine" && statement.binding === binding) found = true;
  });
  return found;
}

/**
 * The query helper: runs one query and returns every row as a plain object
 * keyed by column. `runPaged` avoids `run()`'s result cap; pages are stable
 * because the query is sorted by its first column, the internal id, which
 * is unique.
 */
function emitQueryHelper(writer: Writer, queryModule: string): void {
  writer.line(`function ${QUERY_HELPER}(type, columns, condition) {`);
  writer.indent();
  writer.line(`const q = ${queryModule}.create({ type });`);
  writer.line("q.columns = columns.map((fieldId) => q.createColumn({ fieldId, alias: fieldId }));");
  writer.line("if (condition) q.condition = condition(q);");
  writer.line("q.sort = [q.createSort({ column: q.columns[0], ascending: true })];");
  writer.line("const rows = [];");
  writer.line("const paged = q.runPaged({ pageSize: 1000 });");
  writer.line("paged.pageRanges.forEach((range) => {");
  writer.indent();
  writer.line("paged.fetch({ index: range.index }).data.results.forEach((result) => rows.push(result.asMap()));");
  writer.dedent();
  writer.line("});");
  writer.line("return rows;");
  writer.dedent();
  writer.line("}");
}

/** New-record locals that are deleted somewhere: their save result must be kept. `$` keeps the name clear of Sail locals. */
function capturedIds(unit: ScriptUnit): Map<LocalSymbol, string> {
  const deleted = new Set<LocalSymbol>();
  for (const body of bodies(unit)) forEachStatement(body, (s) => s.kind === "DeleteRecord" && deleted.add(s.target.local));
  const captured = new Map<LocalSymbol, string>();
  for (const body of bodies(unit)) {
    forEachStatement(body, (s) => {
      if (s.kind !== "LocalDeclaration" || !deleted.has(s.local)) return;
      const { initializer } = s;
      if (initializer.kind === "BuiltinCall" && initializer.builtin.kind === "recordOperation" && initializer.builtin.result === "new") {
        captured.set(s.local, `${s.local.name}$id`);
      }
    });
  }
  return captured;
}

/** Every Sail local name in the unit, so emitter-introduced names can avoid them. */
function collectLocalNames(unit: ScriptUnit): Set<string> {
  const names = new Set<string>();
  if (unit.kind === "UserEvent") for (const entryPoint of unit.entryPoints) names.add(entryPoint.parameter.name);
  for (const fn of unit.functions) {
    names.add(fn.name);
    for (const parameter of fn.parameters) names.add(parameter.name);
  }
  for (const body of bodies(unit)) {
    forEachStatement(body, (statement) => {
      if (statement.kind === "LocalDeclaration") names.add(statement.local.name);
      if (statement.kind === "ForEach") names.add(statement.local.name);
    });
  }
  return names;
}

// ---- entry points ----------------------------------------------------------

function emitUserEventEntryPoint(writer: Writer, entryPoint: BoundUserEventEntryPoint, context: EmitContext): void {
  writer.line(`function ${entryPoint.hook}(${context.contextName}) {`);
  writer.indent();

  if (entryPoint.events.length > 0) {
    emitEventGuard(writer, entryPoint.events, context);
    writer.blank();
  }

  writer.line(`const ${entryPoint.parameter.name} = ${context.contextName}.newRecord;`);
  emitBody(writer, entryPoint.body, context, true);

  writer.dedent();
  writer.line("}");
}

function emitScheduledEntryPoint(writer: Writer, entryPoint: BoundScheduledEntryPoint, context: EmitContext): void {
  writer.line(`function ${entryPoint.hook}(${context.contextName}) {`);
  writer.indent();
  emitBody(writer, entryPoint.body, context, false);
  writer.dedent();
  writer.line("}");
}

function emitEventGuard(writer: Writer, events: readonly UserEventType[], context: EmitContext): void {
  const ctx = context.contextName;
  const conditions = events.map((e) => `${ctx}.type !== ${ctx}.UserEventType.${USER_EVENT_CONSTANTS[e]}`);
  openIf(writer, conditions.join(" &&\n"));
  writer.indent();
  writer.line("return;");
  writer.dedent();
  writer.line("}");
}

/**
 * Writes `if (<condition>) {`. A multi-line condition goes on its own
 * indented lines between `if (` and `) {` so the braces stay visible.
 */
function openIf(writer: Writer, condition: string): void {
  if (!condition.includes("\n")) {
    writer.line(`if (${condition}) {`);
    return;
  }
  writer.line("if (");
  writer.indent();
  writer.line(condition);
  writer.dedent();
  writer.line(") {");
}

/** Emits statements separated by blank lines. `leadingBlank` separates from a preamble. */
function emitBody(writer: Writer, body: readonly BoundStatement[], context: EmitContext, leadingBlank: boolean): void {
  body.forEach((statement, index) => {
    if (index > 0 || leadingBlank) writer.blank();
    emitStatement(writer, statement, context);
  });
}

// ---- statements ------------------------------------------------------------

function emitStatement(writer: Writer, statement: BoundStatement, context: EmitContext): void {
  switch (statement.kind) {
    case "LocalDeclaration": {
      writer.line(`const ${statement.local.name} = ${emitExpression(statement.initializer, context)};`);
      const captured = context.capturedId(statement.local);
      if (captured) writer.line(`let ${captured};`);
      return;
    }
    case "FieldWrite": {
      const line = context.line(statement.receiver.local);
      if (line) {
        const options = objectLiteral([
          ["sublistId", jsString(line.sublist.id)],
          ["fieldId", jsString(statement.field.id)],
          ["line", lineIndex(line)],
          ["value", emitExpression(statement.value, context)],
        ]);
        writer.line(`${line.parent.name}.setSublistValue(${options});`);
        return;
      }
      const receiver = emitExpression(statement.receiver, context);
      const options = objectLiteral([
        ["fieldId", jsString(statement.field.id)],
        ["value", emitExpression(statement.value, context)],
      ]);
      writer.line(`${receiver}.setValue(${options});`);
      return;
    }
    case "SaveRecord": {
      // Record.save() returns the internal id; the statement form discards
      // it unless a later delete needs it.
      const captured = statement.target.kind === "LocalReference" ? context.capturedId(statement.target.local) : undefined;
      const save = `${emitExpression(statement.target, context)}.save();`;
      writer.line(captured ? `${captured} = ${save}` : save);
      return;
    }
    case "RemoveLine": {
      const { binding } = statement;
      writer.line(`${binding.parent.name}.removeLine(${objectLiteral([["sublistId", jsString(binding.sublist.id)], ["line", lineIndex(binding)]])});`);
      writer.line(`${lineRemovedFlag(binding)} = true;`);
      return;
    }
    case "AddLine": {
      // Append in standard mode: insert at the current count, then set each
      // field. A block keeps the index local, so adds can follow each other.
      const parent = statement.parent.name;
      const sublistId = statement.target.sublist.id;
      const index = `${sublistId}$line`;
      writer.line("{");
      writer.indent();
      writer.line(`const ${index} = ${parent}.getLineCount({ sublistId: ${jsString(sublistId)} });`);
      writer.line(`${parent}.insertLine({ sublistId: ${jsString(sublistId)}, line: ${index} });`);
      for (const initializer of statement.initializers) {
        const options = objectLiteral([
          ["sublistId", jsString(sublistId)],
          ["fieldId", jsString(initializer.field.id)],
          ["line", index],
          ["value", emitExpression(initializer.value, context)],
        ]);
        writer.line(`${parent}.setSublistValue(${options});`);
      }
      writer.dedent();
      writer.line("}");
      return;
    }
    case "DeleteRecord": {
      // record.delete takes a type and an id, not the record object. The
      // type is static; the id is Record.id for a loaded record and the
      // captured save result for one the script made.
      const { local } = statement.target;
      const recordModule = context.moduleLocal("N/record");
      const type = isRecordType(local.type) ? recordTypeExpression(local.type.record, recordModule) : jsString("?");
      const id = context.capturedId(local) ?? `${local.name}.id`;
      writer.line(`${recordModule}.delete(${objectLiteral([["type", type], ["id", id]])});`);
      return;
    }
    case "ForEach": {
      const { iterable, line: binding } = statement;
      if (binding) {
        // A line is an index into the parent's sublist; there is no line object.
        const parent = binding.parent.name;
        const index = lineIndex(binding);
        const count = `${parent}.getLineCount({ sublistId: ${jsString(binding.sublist.id)} })`;
        if (removesOwnLine(statement.body, binding)) {
          // Removing a line shifts the lines after it down, so the index
          // advances only when the body did not remove the current line.
          // Iteration stays first-to-last and no line is skipped.
          const removed = lineRemovedFlag(binding);
          writer.line(`let ${index} = 0;`);
          writer.line(`while (${index} < ${count}) {`);
          writer.indent();
          writer.line(`let ${removed} = false;`);
          emitBody(writer, statement.body, context, true);
          writer.blank();
          writer.line(`if (!${removed}) {`);
          writer.indent();
          writer.line(`${index} += 1;`);
          writer.dedent();
          writer.line("}");
          writer.dedent();
          writer.line("}");
          return;
        }
        writer.line("for (");
        writer.indent();
        writer.line(`let ${index} = 0;`);
        writer.line(`${index} < ${count};`);
        writer.line(`${index} += 1`);
        writer.dedent();
        writer.line(") {");
        writer.indent();
        emitBody(writer, statement.body, context, false);
        writer.dedent();
        writer.line("}");
        return;
      }
      writer.line(`for (const ${statement.local.name} of ${emitExpression(iterable, context)}) {`);
      writer.indent();
      emitBody(writer, statement.body, context, false);
      writer.dedent();
      writer.line("}");
      return;
    }
    case "If":
      openIf(writer, emitExpression(statement.condition, context));
      writer.indent();
      emitBody(writer, statement.thenBody, context, false);
      writer.dedent();
      if (statement.elseBody) {
        writer.line("} else {");
        writer.indent();
        emitBody(writer, statement.elseBody, context, false);
        writer.dedent();
      }
      writer.line("}");
      return;
    case "ExpressionStatement":
      writer.line(`${emitExpression(statement.expression, context)};`);
      return;
    case "Return":
      writer.line(statement.value ? `return ${emitExpression(statement.value, context)};` : "return;");
      return;
  }
}

// ---- expressions -----------------------------------------------------------

function emitExpression(expression: BoundExpression, context: EmitContext): string {
  switch (expression.kind) {
    case "StringLiteral":
      return jsString(expression.value);
    case "NumberLiteral":
      return String(expression.value);
    case "BoolLiteral":
      return String(expression.value);
    case "LocalReference":
      return expression.local.name;
    case "FieldRead": {
      if (expression.receiver.kind === "LocalReference" && isLineType(expression.receiver.type)) {
        const line = context.line(expression.receiver.local);
        if (!line) throw new Error(`Line '${expression.receiver.local.name}' has no binding`);
        return `${line.parent.name}.getSublistValue(${objectLiteral([
          ["sublistId", jsString(line.sublist.id)],
          ["fieldId", jsString(expression.field.id)],
          ["line", lineIndex(line)],
        ])})`;
      }
      const receiver = emitExpression(expression.receiver, context);
      // A query row is a plain object keyed by column; a record is a Record.
      if (isRecordType(expression.receiver.type) && expression.receiver.type.origin === "query") return `${receiver}.${expression.field.id}`;
      return `${receiver}.getValue(${objectLiteral([["fieldId", jsString(expression.field.id)]])})`;
    }
    case "SublistAccess":
      throw new Error("A sublist is lowered through the loop that iterates it, never as a value");
    case "RecordIdRead":
      return `${emitExpression(expression.receiver, context)}.id`;
    case "Query":
      return emitQuery(expression, context);
    case "QueryField":
      throw new Error("A query field is lowered through its predicate, never as an expression");
    case "BuiltinCall":
      return LOWERINGS[expression.builtin.id](expression, context);
    case "FunctionCall":
      return call(expression.function.name, expression.arguments.map((a) => emitExpression(a, context)));
    case "Comparison": {
      // Non-associative: both operands must bind tighter than the comparison.
      const own = precedenceOf(expression);
      const left = emitOperand(expression.left, own + 1, context);
      const right = emitOperand(expression.right, own + 1, context);
      return `${left} ${COMPARISON_OPERATORS[expression.operation]} ${right}`;
    }
    case "Logical": {
      // Left-associative: the left operand may be at the same level, the
      // right one must bind tighter. Native && and || keep the short-circuit
      // semantics Sail defines for these operators.
      const own = precedenceOf(expression);
      const left = emitOperand(expression.left, own, context);
      const right = emitOperand(expression.right, own + 1, context);
      const operator = LOGICAL_OPERATORS[expression.operation];
      // Long conditions break after the operator, one operand per line.
      const separator = left.includes("\n") || right.includes("\n") ? "\n" : " ";
      return `${left} ${operator}${separator}${right}`;
    }
    case "Not":
      return `!${emitOperand(expression.operand, PRECEDENCE.Not, context)}`;
  }
}

function emitQuery(query: Query, context: EmitContext): string {
  const q = context.moduleLocal("N/query");
  const type = recordTypeExpression(query.recordType.record, q);
  const columns = `[${context.queryColumns(query).map(jsString).join(", ")}]`;
  if (!query.predicate) return `${QUERY_HELPER}(${type}, ${columns})`;
  const condition = emitPredicate(query.predicate, context, q);
  return `${QUERY_HELPER}(${type}, ${columns}, (q) =>\n${INDENT}${indentTail(condition)}\n)`;
}

/** `name(a, b)` on one line, or one argument per line when any is multi-line. */
function call(name: string, args: string[]): string {
  if (!args.some((a) => a.includes("\n"))) return `${name}(${args.join(", ")})`;
  return `${name}(\n${args.map((a) => `${INDENT}${indentTail(a)}`).join(",\n")}\n)`;
}

/**
 * A predicate as `q.createCondition`/`q.and`/`q.or`/`q.not` calls. An
 * empty-Text comparison becomes EMPTY/EMPTY_NOT, since an empty NetSuite
 * field is null, not "". A Bool field uses IS.
 */
function emitPredicate(predicate: QueryPredicate, context: EmitContext, q: string): string {
  switch (predicate.kind) {
    case "And":
      return call("q.and", [emitPredicate(predicate.left, context, q), emitPredicate(predicate.right, context, q)]);
    case "Or":
      return call("q.or", [emitPredicate(predicate.left, context, q), emitPredicate(predicate.right, context, q)]);
    case "Not":
      return call("q.not", [emitPredicate(predicate.operand, context, q)]);
    case "Flag":
      return `q.createCondition(${objectLiteral([
        ["fieldId", jsString(predicate.field.id)],
        ["operator", `${q}.Operator.IS`],
        ["values", `[${String(predicate.value)}]`],
      ])})`;
    case "Compare": {
      const { value } = predicate;
      if (value.kind === "Constant" && value.value === "" && (predicate.operation === "Equal" || predicate.operation === "NotEqual")) {
        return `q.createCondition(${objectLiteral([
          ["fieldId", jsString(predicate.field.id)],
          ["operator", `${q}.Operator.${predicate.operation === "Equal" ? "EMPTY" : "EMPTY_NOT"}`],
        ])})`;
      }
      const literal = value.kind === "Constant" ? (typeof value.value === "string" ? jsString(value.value) : String(value.value)) : value.local.name;
      return `q.createCondition(${objectLiteral([
        ["fieldId", jsString(predicate.field.id)],
        ["operator", `${q}.Operator.${QUERY_OPERATORS[predicate.operation]}`],
        ["values", `[${literal}]`],
      ])})`;
    }
  }
}

/** Emits an operand, parenthesized if its form binds looser than `minPrecedence`. */
function emitOperand(expression: BoundExpression, minPrecedence: number, context: EmitContext): string {
  const text = emitExpression(expression, context);
  if (precedenceOf(expression) >= minPrecedence) return text;
  return text.includes("\n") ? `(\n${INDENT}${indentTail(text)}\n)` : `(${text})`;
}

// ---- built-in lowerings ----------------------------------------------------

/**
 * How each built-in becomes a SuiteScript expression. Keyed by the semantic
 * built-in id, so the emitter never inspects source identifiers. A lowering
 * is used the same way in statement and value position.
 */
type Lowering = (call: BuiltinCall, context: EmitContext) => string;

function logLowering(level: "debug" | "audit" | "error" | "emergency"): Lowering {
  return (call, context) => {
    // N/log takes { title, details }. The title is the entry point name so the
    // execution log's Title column says where the line came from; Sail's
    // one-argument form supplies only the details.
    const log = context.moduleLocal("N/log");
    return `${log}.${level}(${objectLiteral([
      ["title", jsString(context.entryPointName)],
      ["details", emitExpression(call.arguments[0]!, context)],
    ])})`;
  };
}

const loadLowering: Lowering = (call, context) => {
  const record = context.moduleLocal("N/record");
  return `${record}.load(${objectLiteral([
    ["type", recordTypeExpression(call.recordType!.record, record)],
    ["id", emitExpression(call.arguments[0]!, context)],
  ])})`;
};

const createLowering: Lowering = (call, context) => {
  const record = context.moduleLocal("N/record");
  return `${record}.create(${objectLiteral([["type", recordTypeExpression(call.recordType!.record, record)]])})`;
};

const copyLowering: Lowering = (call, context) => {
  const record = context.moduleLocal("N/record");
  return `${record}.copy(${objectLiteral([
    ["type", recordTypeExpression(call.recordType!.record, record)],
    ["id", emitExpression(call.arguments[0]!, context)],
  ])})`;
};

const transformLowering: Lowering = (call, context) => {
  const record = context.moduleLocal("N/record");
  return `${record}.transform(${objectLiteral([
    ["fromType", recordTypeExpression(call.recordType!.record, record)],
    ["fromId", emitExpression(call.arguments[0]!, context)],
    ["toType", recordTypeExpression(call.targetType!.record, record)],
  ])})`;
};

/**
 * `record.Type.CUSTOMER` for standard records, which have a constant, and the
 * id string (`"customrecord_foo"`) for records that do not.
 */
function recordTypeExpression(record: RecordSchema, recordModuleLocal: string): string {
  return record.suiteScriptType ? `${recordModuleLocal}.Type.${record.suiteScriptType}` : jsString(record.id);
}

const LOWERINGS: Record<BuiltinId, Lowering> = {
  "log.debug": logLowering("debug"),
  "log.audit": logLowering("audit"),
  "log.error": logLowering("error"),
  "log.emergency": logLowering("emergency"),
  load: loadLowering,
  create: createLowering,
  copy: copyLowering,
  transform: transformLowering,
};

// ---- text helpers ----------------------------------------------------------

/** JSON string syntax is valid JavaScript string syntax. */
function jsString(value: string): string {
  return JSON.stringify(value);
}

/**
 * A multi-line object literal. Values may themselves be multi-line; their
 * continuation lines are indented one level deeper.
 */
function objectLiteral(entries: ReadonlyArray<readonly [key: string, value: string]>): string {
  const body = entries
    .map(([key, value], index) => `${INDENT}${key}: ${indentTail(value)}${index < entries.length - 1 ? "," : ""}`)
    .join("\n");
  return `{\n${body}\n}`;
}

/** Indents every line after the first by one level. */
function indentTail(text: string): string {
  return text.split("\n").join(`\n${INDENT}`);
}

class Writer {
  private readonly lines: string[] = [];
  private depth = 0;

  /** Appends text at the current depth. Multi-line text is indented line by line. */
  line(text: string): void {
    for (const part of text.split("\n")) {
      this.lines.push(part === "" ? "" : INDENT.repeat(this.depth) + part);
    }
  }

  blank(): void {
    this.lines.push("");
  }

  indent(): void {
    this.depth++;
  }

  dedent(): void {
    this.depth--;
  }

  toString(): string {
    return this.lines.join("\n") + "\n";
  }
}
