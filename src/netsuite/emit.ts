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
  JoinedQueryField,
  LocalSymbol,
  Logical,
  Lookup,
  QueryField,
  Query,
  QueryPredicate,
  ScriptUnit,
  UserEventType,
} from "../semantic/bound.js";
import type { SearchPredicate } from "../semantic/search.js";
import { assertsEqual, isEqualityOperation, type QueryValue, type ReferenceOperand } from "../semantic/bound.js";
import { isLineType, isRecordType, isReferenceType, isRowLike, isRowRecord, isSequenceType, type AggregateKind } from "../semantic/types.js";
import { directExpressions, forEachExpression, forEachStatement } from "../semantic/walk.js";
import type { FieldSchema, RecordSchema } from "../schema/types.js";

const INDENT = "    ";

/** Mynt event names map 1:1 onto `context.UserEventType` constants. */
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
  "N/search": "search",
};

/** `query.Operator` members for each Mynt comparison, on Text/Number fields. */
const QUERY_OPERATORS: Record<ComparisonOperation, string> = {
  Equal: "EQUAL",
  NotEqual: "EQUAL_NOT",
  StrictEqual: "EQUAL",
  StrictNotEqual: "EQUAL_NOT",
  Less: "LESS",
  LessOrEqual: "LESS_OR_EQUAL",
  Greater: "GREATER",
  GreaterOrEqual: "GREATER_OR_EQUAL",
};

/** The names of the emitted helpers. `$` keeps them clear of Mynt locals. */
const QUERY_HELPER = "mynt$query";
const SEARCH_HELPER = "mynt$search";
const SAVED_SEARCH_HELPER = "mynt$savedSearch";
const RESULTS_HELPER = "mynt$results";
const ROW_HELPER = "mynt$row";
const FIRST_HELPER = "mynt$first";
const COLUMNS_HELPER = "mynt$columns";
const LOOKUP_HELPER = "mynt$lookup";
const REFERENCE_HELPER = "mynt$ref";
const REFERENCES_HELPER = "mynt$refs";

/**
 * Each equality is emitted as written: `==`/`!=` are JavaScript's loose
 * operators, with its coercion on the primitive pairs the binder allows,
 * and `===`/`!==` the strict ones. Nothing is normalized.
 */
const COMPARISON_OPERATORS: Record<ComparisonOperation, string> = {
  Equal: "==",
  NotEqual: "!=",
  StrictEqual: "===",
  StrictNotEqual: "!==",
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
      return isEqualityOperation(expression.operation) ? PRECEDENCE.Equality : PRECEDENCE.Relational;
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
 * with Mynt locals, which become JavaScript locals under their own names.
 * `$` cannot appear in a Mynt identifier, so appending it always frees a name.
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
  /** Columns a query must fetch: every field read from its rows, plain or joined (`id` is implicit). */
  queryColumns(query: Query): ColumnPlan[];
  /** The keys of planned columns that are select fields read as references, which a search row must carry with display text. */
  referenceColumns(query: Query): string[];
  /** For a line local: its binding from the unit. The index variable is derived from the line's name. */
  line(local: LocalSymbol): LineBinding | undefined;
}

/** The JavaScript index variable of a line local. `$` keeps it clear of Mynt locals, and names cannot be shadowed. */
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
  // Sort keys first, in key order, so the backend sorts by them in precedence; the rest by key.
  const planned = (query: Query): [string, ColumnPlan][] =>
    [...(columns.get(query) ?? new Map<string, ColumnPlan>())].sort(([a, pa], [b, pb]) => {
      if (pa.sort && pb.sort) return pa.sort.index - pb.sort.index;
      if (pa.sort || pb.sort) return pa.sort ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  const queryColumns = (query: Query): ColumnPlan[] => planned(query).map(([, plan]) => plan);
  // A hidden column never reaches the row, so it is never a reference the row carries.
  const referenceColumns = (query: Query): string[] => planned(query).filter(([, plan]) => plan.reference && !plan.hidden).map(([key]) => key);
  const line = (local: LocalSymbol): LineBinding | undefined => unit.lineBindings.get(local);
  const context: Omit<EmitContext, "entryPointName"> = { contextName, moduleLocal, capturedId, queryColumns, referenceColumns, line };

  writer.line("/**");
  writer.line(" * @NApiVersion 2.1");
  writer.line(` * @NScriptType ${SCRIPT_TYPE_ANNOTATION[unit.kind]}`);
  writer.line(" * @NModuleScope SameAccount");
  writer.line(` * Generated by Mynt from ${unit.file}.${unit.kind === "UserEvent" ? ` Target record: ${unit.record.id}.` : ""}`);
  writer.line(" */");

  const dependencyList = modules.map((m) => jsString(m)).join(", ");
  const factoryParams = modules.map((m) => moduleLocals.get(m)!).join(", ");
  writer.line(`define([${dependencyList}], (${factoryParams}) => {`);
  writer.indent();

  if (unit.dependencies.has("N/query")) {
    emitQueryHelper(writer, moduleLocal("N/query"));
    writer.blank();
  }
  if (usesSearch(unit)) {
    emitSearchHelpers(writer, moduleLocal("N/search"), usesSavedSearch(unit));
    writer.blank();
  }
  if (usesReferenceLookup(unit)) {
    emitReferenceHelpers(writer, moduleLocal("N/search"));
    writer.blank();
  }

  for (const fn of unit.functions) {
    emitFunction(writer, fn, { entryPointName: fn.name, ...context });
    writer.blank();
  }

  const exported: string[] = [];
  switch (unit.kind) {
    case "UserEvent":
      unit.entryPoints.forEach((entryPoint, index) => {
        if (index > 0) writer.blank();
        emitUserEventEntryPoint(writer, entryPoint, { entryPointName: entryPoint.hook, ...context });
        exported.push(entryPoint.hook);
      });
      break;
    case "Scheduled":
      emitScheduledEntryPoint(writer, unit.entryPoint, { entryPointName: "execute", ...context });
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

/** A Mynt function is a plain JavaScript function in the module factory. */
function emitFunction(writer: Writer, fn: BoundFunction, context: EmitContext): void {
  writer.line(`function ${fn.name}(${fn.parameters.map((p) => p.name).join(", ")}) {`);
  writer.indent();
  emitBody(writer, fn.body, context, false);
  writer.dedent();
  writer.line("}");
}

function anyExpression(unit: ScriptUnit, test: (expression: BoundExpression) => boolean): boolean {
  let found = false;
  for (const body of bodies(unit)) {
    forEachStatement(body, (statement) => {
      for (const root of directExpressions(statement)) {
        forEachExpression(root, (expression) => {
          if (test(expression)) found = true;
        });
      }
    });
  }
  return found;
}

/** Whether any `search` expression exists; `N/search` alone may mean only lookups. */
function usesSearch(unit: ScriptUnit): boolean {
  return anyExpression(unit, (e) => e.kind === "Query" && e.operation === "search");
}

/** Whether any `search ... using` exists, which needs the saved-search helper beside the ad-hoc one. */
function usesSavedSearch(unit: ScriptUnit): boolean {
  return anyExpression(unit, (e) => e.kind === "Query" && e.operation === "search" && e.source.kind === "saved");
}

/** Whether a projected select field is read through `lookupFields`, which is what the reference helpers normalize. */
function usesReferenceLookup(unit: ScriptUnit): boolean {
  return anyExpression(unit, (e) => e.kind === "Lookup" && e.source === "lookupFields" && e.fields.some((f) => isReferenceField(f.type)));
}

/** A field read as a display reference or a sequence of them: its backend value needs normalizing. */
function isReferenceField(type: BoundExpression["type"]): boolean {
  return isReferenceType(type) || (isSequenceType(type) && type.source === "lookup");
}

/**
 * Which fields each query or search must fetch: every field read from a
 * loop variable iterating it, whether as `row.email` or as a projection
 * `row[email, comments]`. A query reached through a local (`let rows =
 * query ...`, possibly re-bound by another `let`) is resolved to its Query
 * node. Both backends are planned the same way: a search row, like a
 * query row, is a plain object holding exactly the planned columns.
 */
/**
 * One planned result column: a field of the searched record, or a field of
 * a record one join away. `join.id` is what N/search takes as the join
 * (see joinId), `join.field` the row slot the value is nested under, so
 * `order.entity.email` reads `row.entity.email`. `reference` marks a select
 * field read as a reference, which the row carries as `{ id, text }`.
 */
export interface ColumnPlan {
  name: string;
  join: { id: string; field: string } | undefined;
  reference: boolean;
  /** A sort key, in key order, with its direction. */
  sort: { index: number; direction: "ASC" | "DESC" } | undefined;
  /** A backend-only column (a sort key or group key the rows do not expose): fetched, never put on the row. */
  hidden: boolean;
  /** In a summary search: the column's `search.Summary` type. Every column of a summary search has one. */
  summary: SummaryColumnType | undefined;
  /** An aggregate's result name: the row slot it fills, and its planning key. */
  alias: string | undefined;
}

/** The `search.Summary` member a summary column uses. */
export type SummaryColumnType = "GROUP" | "SUM" | "COUNT" | "MIN" | "MAX" | "AVG";

const SUMMARY_TYPES: Record<"group" | AggregateKind, SummaryColumnType> = { group: "GROUP", sum: "SUM", count: "COUNT", min: "MIN", max: "MAX", avg: "AVG" };

/** The row key of a planned column: `email`, `entity.email` for a joined field, or the alias of an aggregate. */
function columnKey(plan: ColumnPlan): string {
  if (plan.alias !== undefined) return plan.alias;
  return plan.join ? `${plan.join.field}.${plan.name}` : plan.name;
}

/**
 * The N/search join id for a relationship field. ASSUMED, not established
 * by metadata: NetSuite joins are addressed by an id that is usually the
 * referencing field's id (`subsidiary`, `custrecord_owner`), but some
 * standard relationships use their own name (a transaction's `entity` is
 * joined as `customer`, `vendor`, or `employee` depending on the record).
 * The schema's `searchJoin` overrides the default where an account proves
 * it; nothing else in the compiler decides join ids.
 */
function joinId(field: FieldSchema): string {
  return field.searchJoin ?? field.id;
}

function planQueryColumns(unit: ScriptUnit): Map<Query, Map<string, ColumnPlan>> {
  const queryOf = new Map<LocalSymbol, Query>();
  // Locals that hold one row (`first`, resolved by `or` or not): their fields are read outside any loop.
  const rowLocals = new Map<LocalSymbol, Query>();
  for (const body of bodies(unit)) {
    forEachStatement(body, (s) => {
      if (s.kind !== "LocalDeclaration") return;
      const initializer = s.initializer.kind === "OptionalResolve" ? s.initializer.value : s.initializer;
      const query = resolveQuery(initializer, queryOf);
      if (!query) return;
      queryOf.set(s.local, query);
      if (query.first) rowLocals.set(s.local, query);
    });
  }
  const columns = new Map<Query, Map<string, ColumnPlan>>();
  const plansOf = (query: Query): Map<string, ColumnPlan> => {
    let plans = columns.get(query);
    if (!plans) {
      plans = new Map<string, ColumnPlan>();
      columns.set(query, plans);
      if (query.summary) {
        // A summary search's columns are fixed by its clauses: every group key (backend-only unless selected), every selected field as a GROUP column, every aggregate under its alias.
        for (const key of query.groupBy ?? []) {
          const plan = { ...planOf(key.field), summary: "GROUP" as const, hidden: query.select !== undefined };
          plans.set(columnKey(plan), plan);
        }
        for (const item of query.select ?? []) {
          if (item.kind === "SelectedField") {
            const plan = { ...planOf(item.field), summary: "GROUP" as const };
            plans.set(columnKey(plan), plan);
          } else {
            const plan: ColumnPlan = {
              name: item.argument?.field.id ?? "internalid",
              join: item.argument?.kind === "JoinedQueryField" ? { id: joinId(item.argument.join.via), field: item.argument.join.via.id } : undefined,
              reference: false,
              sort: undefined,
              hidden: false,
              summary: SUMMARY_TYPES[item.aggregate],
              alias: item.alias,
            };
            plans.set(columnKey(plan), plan);
          }
        }
      } else if (query.select) {
        // An explicit `select` fixes the columns: every selected field, whether or not the body reads it.
        for (const item of query.select) if (item.kind === "SelectedField") plans.set(columnKey(planOf(item.field)), planOf(item.field));
      }
    }
    return plans;
  };
  for (const body of bodies(unit)) {
    forEachStatement(body, (s) => {
      if (s.kind === "LocalDeclaration") {
        const initializer = s.initializer.kind === "OptionalResolve" ? s.initializer.value : s.initializer;
        if (initializer.kind === "Query") plansOf(initializer);
      }
      if (s.kind !== "ForEach") return;
      const query = resolveQuery(s.iterable, queryOf);
      if (!query) return;
      const fields = plansOf(query);
      // Without `select`, the body's reads decide; with it (or in a summary), the binder has already confined them to the selection.
      if (!query.select && !query.summary) forEachStatement(s.body, (inner) => collectRowFields(inner, s.local, fields));
    });
  }
  // A single row's fields are read wherever the local is in scope.
  for (const [local, query] of rowLocals) {
    const fields = plansOf(query);
    if (query.select || query.summary) continue;
    for (const body of bodies(unit)) forEachStatement(body, (statement) => collectRowFields(statement, local, fields));
  }
  // Sort keys are columns too; one the rows do not expose stays backend-only.
  for (const [query, plans] of columns) {
    (query.orderBy ?? []).forEach((spec, index) => {
      const sort = { index, direction: spec.direction === "asc" ? "ASC" : "DESC" } as const;
      if (spec.field.kind === "AliasReference") {
        // An aggregate sorts by its own column: the one planned under the alias carries the sort, never a second SUM(amount).
        const existing = plans.get(spec.field.item.alias);
        if (!existing) throw new Error(`Aggregate '${spec.field.item.alias}' was not planned`);
        plans.set(spec.field.item.alias, { ...existing, sort });
        return;
      }
      const plan = planOf(spec.field);
      const key = columnKey(plan);
      const existing = plans.get(key);
      plans.set(key, existing ? { ...existing, sort } : { ...plan, sort, hidden: true });
    });
  }
  return columns;
}

/** The column a condition field (bare or joined) needs. */
function planOf(field: QueryField | JoinedQueryField): ColumnPlan {
  return {
    name: field.field.id,
    join: field.kind === "JoinedQueryField" ? { id: joinId(field.join.via), field: field.join.via.id } : undefined,
    reference: isReferenceType(field.type),
    sort: undefined,
    hidden: false,
    summary: undefined,
    alias: undefined,
  };
}

function resolveQuery(expression: BoundExpression, queryOf: Map<LocalSymbol, Query>): Query | undefined {
  if (expression.kind === "Query") return expression;
  if (expression.kind === "LocalReference") return queryOf.get(expression.local);
  return undefined;
}

/**
 * Fields read from `row` anywhere in a statement's expressions (nested
 * bodies are visited by the caller), each marked when it is read as a
 * reference. `order.entity.email` plans the joined column only: the
 * reference `entity` itself is planned when something reads its id or
 * text. One key per column, however often it is read.
 */
function collectRowFields(statement: BoundStatement, row: LocalSymbol, into: Map<string, ColumnPlan>): void {
  const add = (plan: ColumnPlan): void => {
    const existing = into.get(columnKey(plan));
    into.set(columnKey(plan), existing ? { ...existing, hidden: false } : plan);
  };
  const joinedReceivers = new Set<BoundExpression>();
  for (const root of directExpressions(statement)) {
    forEachExpression(root, (expression) => {
      if (expression.kind === "JoinedFieldRead") joinedReceivers.add(expression.receiver);
    });
  }
  for (const root of directExpressions(statement)) {
    forEachExpression(root, (expression) => {
      if (expression.kind === "FieldRead" && expression.receiver.kind === "LocalReference" && expression.receiver.local === row && !joinedReceivers.has(expression)) {
        add({ name: expression.field.id, join: undefined, reference: isReferenceType(expression.type), sort: undefined, hidden: false, summary: undefined, alias: undefined });
      }
      if (expression.kind === "JoinedFieldRead" && expression.receiver.receiver.kind === "LocalReference" && expression.receiver.receiver.local === row) {
        add({ name: expression.field.id, join: { id: joinId(expression.join.via), field: expression.join.via.id }, reference: isReferenceType(expression.type), sort: undefined, hidden: false, summary: undefined, alias: undefined });
      }
      if (expression.kind === "Lookup" && expression.receiver.kind === "LocalReference" && expression.receiver.local === row) {
        for (const { field, type } of expression.fields) add({ name: field.id, join: undefined, reference: isReferenceType(type), sort: undefined, hidden: false, summary: undefined, alias: undefined });
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

/**
 * The search helpers. `mynt$results` runs a search object and returns every
 * result as a plain object keyed by column, plus `id` from `Result.id`, the
 * same row shape the query helper produces. A column named in `references`
 * is a select field read as a reference: the row holds `{ id, text }` from
 * `getValue` and `getText`, so Mynt's `ref.id`/`ref.text` never see the two
 * accessors. Every page of `runPaged` is collected, since `run().each`
 * stops at 4,000 results and a Mynt loop means every matching row.
 *
 * A summary search's columns each carry a `summary` (`search.Summary`), and
 * an aggregate fills the row slot named by its `alias`; the Column object
 * `createColumn` returned is what `getValue`/`getText` are asked with, so
 * the summary type travels with it and nothing addresses a summary column
 * by name alone. A summary row has no `id`: a bucket is not a record.
 *
 * `mynt$search` builds an ad-hoc search with the planned columns and a sort
 * by internal id, so pages are stable; a summary search gets no such column
 * (a plain column in a summary search is invalid), and its group columns
 * without a sort of their own sort ascending after the written keys instead,
 * which keeps pages stable the same way. `mynt$savedSearch` loads a saved
 * search and uses it as defined: its filters stay, its columns stay (a
 * planned column already present is reused, the rest are appended), a Mynt
 * `where` is AND-ed onto its whole filter expression as one operand, and
 * nothing is saved back, so the stored definition is untouched. Its record
 * type is checked against the declared one at runtime, which is the only
 * place that can be known. Its own sort decides the order; none is added.
 */
function emitSearchHelpers(writer: Writer, searchModule: string, saved: boolean): void {
  emitResultsHelper(writer);
  writer.blank();
  writer.line(`function ${SEARCH_HELPER}(type, columns, references, filters, limit, first) {`);
  writer.indent();
  // A column is a field name, or { name, join, field, sort, hidden, summary, alias } for a joined field, a sort key, a backend-only column, or a summary column.
  writer.line(`const cols = ${COLUMNS_HELPER}(columns);`);
  writer.line('const summary = columns.some((spec) => typeof spec !== "string" && spec.summary);');
  // Sort keys come first in key order; internal id is the final tiebreaker, so pages are stable whatever the keys. A summary search ties on its group columns instead.
  writer.line(`const sorted = cols.filter((column) => column.sort);`);
  writer.line(`const unsorted = cols.filter((column) => !column.sort);`);
  writer.line("let tiebreak = [];");
  writer.line("if (summary) {");
  writer.indent();
  writer.line(`tiebreak = unsorted.filter((column) => column.summary === ${searchModule}.Summary.GROUP);`);
  writer.line(`tiebreak.forEach((column) => { column.sort = ${searchModule}.Sort.ASC; });`);
  writer.dedent();
  writer.line("} else {");
  writer.indent();
  writer.line(`tiebreak = [${searchModule}.createColumn({ name: "internalid", sort: ${searchModule}.Sort.ASC })];`);
  writer.dedent();
  writer.line("}");
  writer.line(`const options = { type, columns: [...sorted, ...tiebreak, ...unsorted.filter((column) => tiebreak.indexOf(column) < 0)] };`);
  writer.line("if (filters) options.filters = filters;");
  writer.line(`return first ? ${FIRST_HELPER}(${searchModule}.create(options), cols, columns, references) : ${RESULTS_HELPER}(${searchModule}.create(options), cols, columns, references, limit);`);
  writer.dedent();
  writer.line("}");
  writer.blank();
  writer.line(`function ${COLUMNS_HELPER}(columns) {`);
  writer.indent();
  writer.line("return columns.map((spec) => {");
  writer.indent();
  writer.line('const options = typeof spec === "string" ? { name: spec } : { name: spec.name };');
  writer.line('if (typeof spec !== "string" && spec.join) options.join = spec.join;');
  writer.line(`if (typeof spec !== "string" && spec.sort) options.sort = ${searchModule}.Sort[spec.sort];`);
  writer.line(`if (typeof spec !== "string" && spec.summary) options.summary = ${searchModule}.Summary[spec.summary];`);
  writer.line(`return ${searchModule}.createColumn(options);`);
  writer.dedent();
  writer.line("});");
  writer.dedent();
  writer.line("}");
  if (!saved) return;
  writer.blank();
  // `loadType` is passed to search.load only for a standalone search type, which NetSuite requires; ordinary saved searches load by id alone.
  writer.line(`function ${SAVED_SEARCH_HELPER}(type, id, columns, references, filters, loadType, limit, first) {`);
  writer.indent();
  writer.line(`const s = ${searchModule}.load(loadType ? { id, type: loadType } : { id });`);
  // `type` is the record's search type, or a list with its family (a sales order search reports `transaction`).
  writer.line("const types = [].concat(type);");
  writer.line('if (types.indexOf(s.searchType) < 0) throw new Error("Mynt: saved search " + id + " searches " + s.searchType + " records, but the script declares " + types.join(" or "));');
  // A Mynt summary never merges with a saved search's own summary columns: two summary definitions would be one search with two meanings.
  // (Used as rows, a saved search with summary columns stays an unmodeled limitation, as before.)
  writer.line('const summary = columns.some((spec) => typeof spec !== "string" && spec.summary);');
  writer.line("if (summary && s.columns.some((column) => column.summary)) {");
  writer.indent();
  writer.line('throw new Error("Mynt: saved search " + id + " already has summary columns; a Mynt \'group by\' or aggregate cannot be combined with its own summary");');
  writer.dedent();
  writer.line("}");
  // A Mynt `order by` replaces the saved search's ordering for this run: every existing sort is cleared, then the keys are set.
  writer.line('const ordered = columns.some((spec) => typeof spec !== "string" && spec.sort);');
  writer.line(`if (ordered) s.columns.forEach((column) => { column.sort = ${searchModule}.Sort.NONE; });`);
  // A Mynt summary over a saved search keeps its filters and type only: every column must be a summary column, so Mynt's replace the saved ones.
  writer.line("if (summary) {");
  writer.indent();
  writer.line(`const cols = ${COLUMNS_HELPER}(columns);`);
  writer.line(`cols.filter((column) => !column.sort && column.summary === ${searchModule}.Summary.GROUP).forEach((column) => { column.sort = ${searchModule}.Sort.ASC; });`);
  writer.line("s.columns = cols.filter((column) => column.sort).concat(cols.filter((column) => !column.sort));");
  writer.line('if (filters) s.filterExpression = s.filterExpression.length > 0 ? [s.filterExpression, "and", filters] : filters;');
  writer.line(`return first ? ${FIRST_HELPER}(s, cols, columns, references) : ${RESULTS_HELPER}(s, cols, columns, references, limit);`);
  writer.dedent();
  writer.line("}");
  writer.line("const cols = columns.map((spec) => {");
  writer.indent();
  writer.line('const wanted = typeof spec === "string" ? { name: spec } : spec;');
  // An existing column is the same only with the same name and join and no summary or formula.
  writer.line("const existing = s.columns.filter((column) => column.name === wanted.name && (wanted.join ? column.join === wanted.join : !column.join) && !column.summary && !column.formula)[0];");
  writer.line(`const column = existing || ${searchModule}.createColumn(wanted.join ? { name: wanted.name, join: wanted.join } : { name: wanted.name });`);
  writer.line(`if (wanted.sort) column.sort = ${searchModule}.Sort[wanted.sort];`);
  writer.line("return column;");
  writer.dedent();
  writer.line("});");
  writer.line("s.columns = s.columns.concat(cols.filter((column) => s.columns.indexOf(column) < 0));");
  writer.line('if (filters) s.filterExpression = s.filterExpression.length > 0 ? [s.filterExpression, "and", filters] : filters;');
  writer.line(`return first ? ${FIRST_HELPER}(s, cols, columns, references) : ${RESULTS_HELPER}(s, cols, columns, references, limit);`);
  writer.dedent();
  writer.line("}");
}

function emitResultsHelper(writer: Writer): void {
  // `limit` stops after that many rows; pages are 5 to 1000 (NetSuite's bounds) and are not fetched past the limit.
  writer.line(`function ${RESULTS_HELPER}(s, cols, columns, references, limit) {`);
  writer.indent();
  writer.line("const rows = [];");
  writer.line("const paged = s.runPaged({ pageSize: limit ? Math.max(5, Math.min(limit, 1000)) : 1000 });");
  writer.line("paged.pageRanges.forEach((range) => {");
  writer.indent();
  writer.line("if (limit && rows.length >= limit) return;");
  writer.line("paged.fetch({ index: range.index }).data.forEach((result) => {");
  writer.indent();
  writer.line("if (limit && rows.length >= limit) return;");
  writer.line(`rows.push(${ROW_HELPER}(result, cols, columns, references));`);
  writer.dedent();
  writer.line("});");
  writer.dedent();
  writer.line("});");
  writer.line("return rows;");
  writer.dedent();
  writer.line("}");
  writer.blank();
  // `first`: one result under the search's ordering, fetched alone, or null when there is none.
  writer.line(`function ${FIRST_HELPER}(s, cols, columns, references) {`);
  writer.indent();
  writer.line("const results = s.run().getRange({ start: 0, end: 1 });");
  writer.line(`return results.length > 0 ? ${ROW_HELPER}(results[0], cols, columns, references) : null;`);
  writer.dedent();
  writer.line("}");
  writer.blank();
  writer.line(`function ${ROW_HELPER}(result, cols, columns, references) {`);
  writer.indent();
  // A summary row is a bucket, not a record: no id. An aggregate fills the slot named by its alias.
  writer.line('const row = columns.some((spec) => typeof spec !== "string" && spec.summary) ? {} : { id: result.id };');
  writer.line("cols.forEach((column, index) => {");
  writer.indent();
  // A column in `references` (by its row key) is a select field read as a
  // reference: the row holds { id, text } from getValue and getText, so
  // Mynt's ref.id/ref.text never see the two accessors. A joined column is
  // nested under its relationship field, beside that reference's id and
  // text when they are planned too. A hidden column (a sort key) is skipped.
  writer.line('const spec = typeof columns[index] === "string" ? { name: columns[index] } : columns[index];');
  writer.line("if (spec.hidden) return;");
  writer.line('const key = spec.alias ? spec.alias : spec.field ? spec.field + "." + spec.name : spec.name;');
  writer.line("let value = result.getValue(column);");
  writer.line("if (spec.alias) {");
  writer.indent();
  writer.line("row[spec.alias] = value;");
  writer.line("return;");
  writer.dedent();
  writer.line("}");
  writer.line("if (references.indexOf(key) >= 0) {");
  writer.indent();
  writer.line("const text = result.getText(column);");
  writer.line('value = { id: value === null || value === undefined ? "" : String(value), text: text === null || text === undefined ? "" : String(text) };');
  writer.dedent();
  writer.line("}");
  writer.line("if (spec.field) {");
  writer.indent();
  writer.line("row[spec.field] = row[spec.field] || {};");
  writer.line("row[spec.field][spec.name] = value;");
  writer.dedent();
  writer.line("} else if (references.indexOf(key) >= 0) {");
  writer.indent();
  writer.line("row[spec.name] = Object.assign(row[spec.name] || {}, value);");
  writer.dedent();
  writer.line("} else {");
  writer.indent();
  writer.line("row[spec.name] = value;");
  writer.dedent();
  writer.line("}");
  writer.dedent();
  writer.line("});");
  writer.line("return row;");
  writer.dedent();
  writer.line("}");
}

/**
 * The reference helpers: the one place NetSuite's select-field shape is
 * known. `lookupFields` reports a select as an array of `{ value, text }`
 * objects (one element for a select, several for a multiselect; this is
 * from NetSuite's documentation and not yet verified against an account).
 * `mynt$ref` turns one such value into `{ id, text }`, Mynt's reference
 * value, tolerating a bare id or an empty field; `mynt$refs` does so for
 * every element of a multiselect; `mynt$lookup` runs a lookup and
 * normalizes the columns the compiler marked. Nothing else in the output
 * mentions `value`.
 */
function emitReferenceHelpers(writer: Writer, searchModule: string): void {
  writer.line(`function ${REFERENCE_HELPER}(raw) {`);
  writer.indent();
  writer.line("const value = Array.isArray(raw) ? raw[0] : raw;");
  writer.line('if (value === undefined || value === null || value === "") return { id: "", text: "" };');
  writer.line('if (typeof value === "object") return { id: String(value.value), text: value.text === undefined || value.text === null ? "" : String(value.text) };');
  writer.line('return { id: String(value), text: "" };');
  writer.dedent();
  writer.line("}");
  writer.blank();
  writer.line(`function ${REFERENCES_HELPER}(raw) {`);
  writer.indent();
  writer.line('const values = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === "" ? [] : [raw];');
  writer.line(`return values.map((value) => ${REFERENCE_HELPER}(value));`);
  writer.dedent();
  writer.line("}");
  writer.blank();
  writer.line(`function ${LOOKUP_HELPER}(type, id, columns, references) {`);
  writer.indent();
  writer.line(`const result = ${searchModule}.lookupFields({ type, id, columns });`);
  writer.line("Object.keys(references).forEach((name) => {");
  writer.indent();
  writer.line(`result[name] = references[name] === "many" ? ${REFERENCES_HELPER}(result[name]) : ${REFERENCE_HELPER}(result[name]);`);
  writer.dedent();
  writer.line("});");
  writer.line("return result;");
  writer.dedent();
  writer.line("}");
}

/** New-record locals that are deleted somewhere: their save result must be kept. `$` keeps the name clear of Mynt locals. */
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

/** Every Mynt local name in the unit, so emitter-introduced names can avoid them. */
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
      if (statement.kind === "TryCatch" && statement.binding) names.add(statement.binding.name);
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
      if (statement.initializer.kind === "OptionalResolve") {
        // `let x = value or { ... }`: the value once into a temporary, the absence branch when it is null, then the binding.
        const resolve = statement.initializer;
        const maybe = `${statement.local.name}$maybe`;
        writer.line(`const ${maybe} = ${emitExpression(resolve.value, context)};`);
        writer.line(`if (${maybe} === null) {`);
        writer.indent();
        emitBody(writer, resolve.absence, context, false);
        writer.dedent();
        writer.line("}");
        writer.line(`const ${statement.local.name} = ${maybe};`);
        return;
      }
      writer.line(`const ${statement.local.name} = ${emitExpression(statement.initializer, context)};`);
      const captured = context.capturedId(statement.local);
      if (captured) writer.line(`let ${captured};`);
      return;
    }
    case "TryCatch": {
      // JavaScript's own construct; a handler without a binding still names one, since the 2.1 runtime's support for an optional binding is not relied on.
      writer.line("try {");
      writer.indent();
      emitBody(writer, statement.body, context, false);
      writer.dedent();
      if (statement.handler) {
        writer.line(`} catch (${statement.binding?.name ?? "mynt$error"}) {`);
        writer.indent();
        emitBody(writer, statement.handler, context, false);
        writer.dedent();
      }
      if (statement.finalizer) {
        writer.line("} finally {");
        writer.indent();
        emitBody(writer, statement.finalizer, context, false);
        writer.dedent();
      }
      writer.line("}");
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

/**
 * An internal id as an N/record or N/search `id` parameter: as written.
 * `Customer(123)` is the canonical spelling and the AST keeps the number,
 * so the parameter is the number `123`; a `number`-typed value passes
 * through, and so does a string, `Customer("123")` or `row.id`.
 */
function emitRecordId(expression: BoundExpression, context: EmitContext): string {
  return emitOperand(expression, PRECEDENCE.Primary, context);
}

/**
 * The identity of a reference-typed expression as a string: the one place
 * the two runtime shapes meet. An identity reference is its id, always a
 * string at runtime; a display reference carries it as `.id`; a constructor
 * is its id as a string, `"123"` for `Customer(123)`. Every comparison,
 * `.id` read, and filter goes through here.
 */
function emitReferenceId(expression: BoundExpression, context: EmitContext): string {
  if (expression.kind === "RecordReference") return emitIdAsString(expression.id, context);
  const text = isReferenceType(expression.type) && expression.type.text;
  return text ? `${emitOperand(expression, PRECEDENCE.Primary, context)}.id` : emitOperand(expression, PRECEDENCE.Primary, context);
}

/** An id expression as a string: a numeric literal's digits, a string as is, anything else through `String`. */
function emitIdAsString(expression: BoundExpression, context: EmitContext): string {
  if (expression.kind === "NumberLiteral") return jsString(String(expression.value));
  if (expression.type === "Text") return emitOperand(expression, PRECEDENCE.Primary, context);
  return `String(${emitExpression(expression, context)})`;
}

/** A reference operand of a filter as its id: a constant id as a string, a numeric local through `String`, a reference local through its identity. */
function emitReferenceOperand(operand: ReferenceOperand, context: EmitContext): string {
  if (operand.kind === "Local") {
    return emitReferenceId({ kind: "LocalReference", local: operand.local, type: operand.local.type, span: { start: { offset: 0, line: 0, column: 0 }, end: { offset: 0, line: 0, column: 0 } } }, context);
  }
  const { value } = operand;
  if (value.kind === "Constant") return jsString(String(value.value));
  return value.local.type === "Number" ? `String(${value.local.name})` : value.local.name;
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
    case "OptionalPresence":
      // The one place absence is spelled: `mynt$first` yields null for no row.
      return `${expression.reference.local.name} !== null`;
    case "ErrorPropertyRead":
      return `${emitOperand(expression.receiver, PRECEDENCE.Primary, context)}.${expression.property}`;
    case "OptionalResolve":
      throw new Error("An optional resolution is lowered by the declaration that holds it");
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
      // A query, search, or summary row and a projection are plain objects keyed by column; a record is a Record.
      if (isRowLike(expression.receiver.type) || (typeof expression.receiver.type === "object" && expression.receiver.type.kind === "Projection")) {
        return `${receiver}.${expression.field.id}`;
      }
      return `${receiver}.getValue(${objectLiteral([["fieldId", jsString(expression.field.id)]])})`;
    }
    case "SublistAccess":
      throw new Error("A sublist is lowered through the loop that iterates it, never as a value");
    case "RecordIdRead": {
      // A row's id is already a string; a reference's identity is emitReferenceId's business.
      const { receiver } = expression;
      if (receiver.kind === "RecordReference" || isReferenceType(receiver.type)) return emitReferenceId(receiver, context);
      return `${emitExpression(receiver, context)}.id`;
    }
    case "ReferenceTextRead":
      return `${emitExpression(expression.receiver, context)}.text`;
    case "RecordReference":
      // A reference value is its id as a string: no object, no call. Only a
      // constructor used directly as an id parameter keeps the number.
      return emitIdAsString(expression.id, context);
    case "Lookup":
      return emitLookup(expression, context);
    case "Query":
      return expression.operation === "search" ? emitSearch(expression, context) : emitQuery(expression, context);
    case "QueryField":
    case "JoinedQueryField":
      throw new Error("A query field is lowered through its predicate, never as an expression");
    case "SelectedAggregate":
    case "AliasReference":
      throw new Error("An aggregate is lowered through its search's columns, never as an expression");
    case "ResultFieldRead":
      // An aggregate's value sits on the summary row under its alias.
      return `${emitExpression(expression.receiver, context)}.${expression.result.name}`;
    case "JoinedFieldRead":
      // The joined value sits under the relationship field on the row: `row.entity.email`.
      return `${emitExpression(expression.receiver, context)}.${expression.field.id}`;
    case "BuiltinCall":
      return LOWERINGS[expression.builtin.id](expression, context);
    case "FunctionCall":
      return call(expression.function.name, expression.arguments.map((a) => emitExpression(a, context)));
    case "Comparison": {
      // References compare by identity, each side normalized to its id string.
      if (expression.operandType === "Reference") {
        return `${emitReferenceId(expression.left, context)} ${COMPARISON_OPERATORS[expression.operation]} ${emitReferenceId(expression.right, context)}`;
      }
      // Non-associative: both operands must bind tighter than the comparison.
      const own = precedenceOf(expression);
      const left = emitOperand(expression.left, own + 1, context);
      const right = emitOperand(expression.right, own + 1, context);
      return `${left} ${COMPARISON_OPERATORS[expression.operation]} ${right}`;
    }
    case "Logical": {
      // Left-associative: the left operand may be at the same level, the
      // right one must bind tighter. Native && and || keep the short-circuit
      // semantics Mynt defines for these operators.
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
  // `id` first: the helper sorts by its first column. Joins never reach here; the binder refuses them for N/query.
  const columns = `[${["id", ...context.queryColumns(query).map((plan) => plan.name)].map(jsString).join(", ")}]`;
  if (!query.predicate) return `${QUERY_HELPER}(${type}, ${columns})`;
  const condition = emitPredicate(query.predicate, context, q);
  return `${QUERY_HELPER}(${type}, ${columns}, (q) =>\n${INDENT}${indentTail(condition)}\n)`;
}

/**
 * A projection. From a reference: one `lookupFields` call for exactly the
 * projected columns; a single field is extracted from the result, several
 * are the result object itself. From a record: `getValue` per field. From
 * a row: the planned columns. One field is the value; several are an
 * object keyed by field id, which is what every projected read expects.
 */
function emitLookup(lookup: Lookup, context: EmitContext): string {
  const fields = lookup.fields.map((f) => f.field.id);
  const single = fields.length === 1 ? fields[0]! : undefined;
  switch (lookup.source) {
    case "lookupFields": {
      const search = context.moduleLocal("N/search");
      // Select fields go through the lookup helper, which normalizes them
      // to reference values; a lookup of scalars only is the call itself.
      // The id is the receiver: a constructor keeps its number, an identity
      // reference is its id, a display reference carries it as `.id`.
      const references = lookup.fields.filter((f) => isReferenceField(f.type));
      const id = lookup.receiver.kind === "RecordReference" ? emitRecordId(lookup.receiver.id, context) : emitReferenceId(lookup.receiver, context);
      const lowered =
        references.length === 0
          ? `${search}.lookupFields(${objectLiteral([
              ["type", recordTypeExpression(lookup.record, search)],
              ["id", id],
              ["columns", `[${fields.map(jsString).join(", ")}]`],
            ])})`
          : call(LOOKUP_HELPER, [
              recordTypeExpression(lookup.record, search),
              id,
              `[${fields.map(jsString).join(", ")}]`,
              objectLiteral(references.map((f) => [f.field.id, jsString(isSequenceType(f.type) ? "many" : "one")] as const)),
            ]);
      return single ? `${lowered}.${single}` : lowered;
    }
    case "record": {
      const receiver = emitExpression(lookup.receiver, context);
      const read = (field: string) => `${receiver}.getValue(${objectLiteral([["fieldId", jsString(field)]])})`;
      return single ? read(single) : objectLiteral(fields.map((field) => [field, read(field)] as const));
    }
    case "row": {
      const receiver = emitExpression(lookup.receiver, context);
      return single ? `${receiver}.${single}` : objectLiteral(fields.map((field) => [field, `${receiver}.${field}`] as const));
    }
  }
}

/** A filter's field name: `email`, or `customer.email` through a join (join id, then field id, as N/search filter expressions spell it). */
function filterName(field: FieldSchema, join: { via: FieldSchema } | undefined): string {
  return join ? `${joinId(join.via)}.${field.id}` : field.id;
}

function emitSearch(query: Query, context: EmitContext): string {
  const search = context.moduleLocal("N/search");
  const type = recordTypeExpression(query.recordType.record, search);
  // The helper adds `id` itself; only the planned field columns are passed: a name, or a descriptor for a join, a sort key, or a backend-only column.
  const columns = `[${context
    .queryColumns(query)
    .map((plan) => {
      if (!plan.join && !plan.sort && !plan.hidden && !plan.summary) return jsString(plan.name);
      const parts = [`name: ${jsString(plan.name)}`];
      if (plan.join) parts.push(`join: ${jsString(plan.join.id)}`, `field: ${jsString(plan.join.field)}`);
      if (plan.summary) parts.push(`summary: ${jsString(plan.summary)}`);
      if (plan.alias !== undefined) parts.push(`alias: ${jsString(plan.alias)}`);
      if (plan.sort) parts.push(`sort: ${jsString(plan.sort.direction)}`);
      if (plan.hidden) parts.push("hidden: true");
      return `{ ${parts.join(", ")} }`;
    })
    .join(", ")}]`;
  const references = `[${context.referenceColumns(query).map(jsString).join(", ")}]`;
  // A saved search over a record with a search family (transactions) may report the family as its type.
  const family = query.source.kind === "saved" ? query.recordType.record.searchFamily : undefined;
  const declared = family ? `[${type}, ${jsString(family)}]` : type;
  const [helper, ...leading] = query.source.kind === "saved" ? [SAVED_SEARCH_HELPER, declared, emitExpression(query.source.id, context)] : [SEARCH_HELPER, type];
  // Trailing options: filters, then (saved only) the standalone load type, then the row limit, then `first`. Unused ones before a used one are `undefined`.
  const filter = query.filter ? emitSearchFilter(query.filter, context, search) : undefined;
  const filters = filter ? (query.filter!.kind === "And" || query.filter!.kind === "Or" ? filter : `[${filter}]`) : undefined;
  const loadType = query.source.kind === "saved" ? (query.source.loadType ? jsString(query.source.loadType) : undefined) : null;
  const limit = query.limit !== undefined ? String(query.limit) : undefined;
  const first = query.first ? "true" : undefined;
  const trailing = [filters, ...(loadType === null ? [] : [loadType]), limit, first];
  while (trailing.length > 0 && trailing[trailing.length - 1] === undefined) trailing.pop();
  return call(helper!, [...leading, columns, references, ...trailing.map((t) => t ?? "undefined")]);
}

/**
 * A search predicate as an N/search filter expression: a leaf is
 * `[field, operator, value]`, and `and`/`or` join two expressions. The
 * operator is the enum member, whose value is the string the expression
 * form takes. Empty checks carry an empty value, as the operator ignores it.
 */
function emitSearchFilter(predicate: SearchPredicate, context: EmitContext, search: string): string {
  switch (predicate.kind) {
    case "And":
    case "Or":
      return `[\n${INDENT}${indentTail(emitSearchFilter(predicate.left, context, search))},\n${INDENT}${jsString(predicate.kind === "And" ? "and" : "or")},\n${INDENT}${indentTail(emitSearchFilter(predicate.right, context, search))}\n]`;
    case "Filter": {
      const { value } = predicate;
      const literal = !value ? jsString("") : value.kind === "Constant" ? (typeof value.value === "string" ? jsString(value.value) : String(value.value)) : value.local.name;
      return `[${jsString(filterName(predicate.field, predicate.join))}, ${search}.Operator.${predicate.operator}, ${literal}]`;
    }
    case "ReferenceFilter":
      // anyof/noneof take a list of internal ids; only identities are emitted, never a reference object or its text.
      return `[${jsString(filterName(predicate.field, predicate.join))}, ${search}.Operator.${predicate.operator}, [${predicate.values.map((v) => emitReferenceOperand(v, context)).join(", ")}]]`;
  }
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
    case "CompareReference":
      throw new Error("A reference comparison in a query is rejected by the binder; N/query lowering is not decided");
    case "Flag":
      return `q.createCondition(${objectLiteral([
        ["fieldId", jsString(predicate.field.id)],
        ["operator", `${q}.Operator.IS`],
        ["values", `[${String(predicate.value)}]`],
      ])})`;
    case "Compare": {
      const { value } = predicate;
      if (value.kind === "Constant" && value.value === "" && isEqualityOperation(predicate.operation)) {
        return `q.createCondition(${objectLiteral([
          ["fieldId", jsString(predicate.field.id)],
          ["operator", `${q}.Operator.${assertsEqual(predicate.operation) ? "EMPTY" : "EMPTY_NOT"}`],
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
    // execution log's Title column says where the line came from; Mynt's
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
    ["id", emitRecordId(call.arguments[0]!, context)],
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
    ["id", emitRecordId(call.arguments[0]!, context)],
  ])})`;
};

const transformLowering: Lowering = (call, context) => {
  const record = context.moduleLocal("N/record");
  return `${record}.transform(${objectLiteral([
    ["fromType", recordTypeExpression(call.recordType!.record, record)],
    ["fromId", emitRecordId(call.arguments[0]!, context)],
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
