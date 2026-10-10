/**
 * Where the cursor is, syntactically, for completion. Derived from the
 * token stream rather than the syntax tree because the tree is often
 * incomplete exactly where the user is typing. The scan recognizes
 * positions, not meanings: what a name means is asked of the semantic
 * document, never decided here.
 */
import { DiagnosticBag, type Span } from "../diagnostics.js";
import { tokenize } from "../lexer/lexer.js";
import type { Token } from "../lexer/tokens.js";
import { DECLARATION_KEYWORDS, QUERY_OPERATIONS, USER_EVENT_HOOKS } from "../parser/ast.js";
import type { NameResolution } from "../semantic/binder.js";

export type CompletionContext =
  | { kind: "topLevel" }
  | { kind: "eventName" }
  | { kind: "recordType" }
  /** A function parameter's type: string, number, boolean, or a record type. */
  | { kind: "parameterType" }
  | { kind: "returnType" }
  /** After a `.`: where the dot is, and the identifier chain before it when the receiver is one. */
  | { kind: "member"; dotOffset: number; receiver: string[] }
  | { kind: "statement" }
  | { kind: "expression" }
  /** Inside `query T where ...` or `search T where ...`: bare names are T's fields (by record name, or by the saved search's id), plus captured locals. */
  | { kind: "queryField"; record: string | undefined; savedSearch: string | undefined }
  /** After `search saved [T]`, or inside the string there: a saved search's script id; `record` filters to searches over that type. */
  | { kind: "savedSearchId"; record: string | undefined }
  /** At the start of a line after a search: the clause words not yet used by that search. */
  | { kind: "searchClause"; used: string[] }
  /** Inside `select ...`: a field of the searched record (by record name, or saved-search id), minus those already listed. */
  /** A `select` item position: a field, or an aggregate (`total = sum(`). `summary` says the search is already a summary (a `group by`, or an aggregate listed). */
  | { kind: "selectField"; record: string | undefined; savedSearch: string | undefined; listed: string[]; summary: boolean }
  /** After `name = `: an aggregate function. */
  | { kind: "aggregate"; alias: string }
  /** Inside `sum(`: the fields the aggregate accepts. */
  | { kind: "aggregateField"; record: string | undefined; savedSearch: string | undefined; aggregate: string }
  /** After `group by` or a comma in it: groupable fields, minus those listed. */
  | { kind: "groupField"; record: string | undefined; savedSearch: string | undefined; listed: string[] }
  /** Inside `order by ...` where a field goes. */
  /** A sort key position. In a summary search `result` lists what may be sorted by: the grouped fields and the aggregate names. */
  | { kind: "sortField"; record: string | undefined; savedSearch: string | undefined; result: string[] | undefined }
  /** Right after a sort key: `asc`, `desc`, or a comma. */
  | { kind: "sortDirection" }
  /** Inside `receiver[...]`: where the bracket is, the receiver's identifier chain when it is one, and the fields already listed. */
  | { kind: "projectionField"; bracketOffset: number; receiver: string[]; listed: string[] }
  /** At a statement position inside `add parent.sublist { ... }`: the sublist's fields. */
  | { kind: "lineInitializer"; parent: string; sublist: string }
  | { kind: "none" };

export interface CompletionSite {
  context: CompletionContext;
  /** The identifier being typed, up to the cursor. */
  prefix: string;
  /** What a completion replaces. */
  replace: Span;
}

const STATEMENT_KEYWORDS = new Set(["let", "if", "save", "delete", "remove", "add", "else", "for", "return", "try", "catch", "finally"]);

export function completionSite(text: string, offset: number, resolve: (name: string) => NameResolution | undefined): CompletionSite {
  const tokens = tokenize(text, new DiagnosticBag("")).filter((t) => t.kind !== "EOF");
  // Inside a token; an unterminated string (no closing quote) also contains the position right after its last character.
  const at = (t: Token) => t.span.start.offset < offset && (offset < t.span.end.offset || (offset === t.span.end.offset && t.kind === "String" && !(t.text.length > 1 && t.text.endsWith('"'))));
  const point = { offset, line: 0, column: 0 };

  const inString = tokens.find((t) => t.kind === "String" && at(t));
  if (inString) {
    // Inside the string of `search saved [T] "...`: the script id being typed completes from the snapshot.
    const before = tokens.filter((t) => t.span.end.offset <= inString.span.start.offset);
    const saved = savedSearchIdContext(before);
    if (saved) {
      const start = { ...inString.span.start, offset: inString.span.start.offset + 1, column: inString.span.start.column + 1 };
      return { context: saved, prefix: text.slice(start.offset, offset), replace: { start, end: point } };
    }
    return { context: { kind: "none" }, prefix: "", replace: { start: point, end: point } };
  }

  const prefixToken = tokens.find((t) => t.kind === "Identifier" && t.span.start.offset < offset && offset <= t.span.end.offset);
  const prefix = prefixToken ? text.slice(prefixToken.span.start.offset, offset) : "";
  const replace: Span = prefixToken ? { start: prefixToken.span.start, end: point } : { start: point, end: point };
  const boundary = prefixToken ? prefixToken.span.start.offset : offset;
  const before = tokens.filter((t) => t.span.end.offset <= boundary);

  return { context: classify(before, resolve), prefix, replace };
}

/** Whether a token is `query` or `search`. */
function isQueryOperation(token: Token | undefined): boolean {
  return token?.kind === "Identifier" && (QUERY_OPERATIONS as readonly string[]).includes(token.text);
}

/**
 * If the cursor is inside an open `[...]`, the projection being typed: the
 * innermost unmatched `[` on this statement, the identifier chain before
 * it when the receiver is one, and the field names listed so far.
 */
function projectionInProgress(before: Token[]): CompletionContext | undefined {
  let open = -1;
  for (let i = before.length - 1; i >= 0; i--) {
    const kind = before[i]!.kind;
    if (kind === "RBracket" || kind === "Terminator" || kind === "LBrace" || kind === "RBrace") return undefined;
    if (kind === "LBracket") {
      open = i;
      break;
    }
  }
  if (open < 0) return undefined;
  const listed = before.slice(open + 1).filter((t) => t.kind === "Identifier").map((t) => t.text);
  const receiver: string[] = [];
  let i = open - 1;
  while (i >= 0 && before[i]!.kind === "Identifier") {
    receiver.unshift(before[i]!.text);
    if (i >= 1 && before[i - 1]!.kind === "Dot") i -= 2;
    else break;
  }
  return { kind: "projectionField", bracketOffset: before[open]!.span.start.offset, receiver, listed };
}

const CLAUSE_WORDS = ["where", "select", "order", "group", "limit", "first"];
const AGGREGATES = ["sum", "count", "min", "max", "avg"];

/**
 * The tokens of the search the cursor is in, from its `query`/`search` to
 * the cursor, if the cursor is at a clause position or inside a clause:
 * the search's source, then clauses, each at a line start (after a
 * terminator) or directly after the source, with no other statement since.
 * Returns the index of the operation word and the clauses seen so far.
 */
function searchInProgress(before: Token[]): { start: number; clauses: { word: string; at: number }[] } | undefined {
  // Walk back to the most recent statement boundary that is not followed by a clause word.
  let start = -1;
  for (let i = before.length - 1; i >= 0; i--) {
    const t = before[i]!;
    if (t.kind === "LBrace" || t.kind === "RBrace") break;
    const continues = before[i + 1]?.kind === "Identifier" && CLAUSE_WORDS.includes(before[i + 1]!.text);
    if (t.kind === "Terminator" && !continues) break;
    if (isQueryOperation(t)) start = i;
  }
  if (start < 0) return undefined;
  // A clause begins at a line start, or right after the source (`search T`, `search saved [T] id`) on the same line.
  const clauses: { word: string; at: number }[] = [];
  for (let i = start + 1; i < before.length; i++) {
    const t = before[i]!;
    if (t.kind !== "Identifier" || !CLAUSE_WORDS.includes(t.text)) continue;
    const afterSource = clauses.length === 0 && i <= start + 4;
    if (before[i - 1]?.kind === "Terminator" || afterSource) clauses.push({ word: t.text, at: i });
  }
  return { start, clauses };
}

/** `search saved` or `search saved T` right before the cursor: the position of a saved search's id. */
function savedSearchIdContext(before: Token[]): CompletionContext | undefined {
  const n = before.length;
  const last = before[n - 1];
  if (last?.kind === "Identifier" && last.text === "saved" && isQueryOperation(before[n - 2])) return { kind: "savedSearchId", record: undefined };
  if (last?.kind === "Identifier" && before[n - 2]?.kind === "Identifier" && before[n - 2]!.text === "saved" && isQueryOperation(before[n - 3])) {
    return { kind: "savedSearchId", record: last.text };
  }
  return undefined;
}

/**
 * The record of the `query T where ...` or `search T where ...` the cursor
 * is inside, if any: the last `query T` (or `search saved [T] id`) with a
 * `where` after it and no statement boundary since (a terminator that is
 * not immediately followed by `where`). A saved search without a written
 * type is known by its id, for the semantic document to resolve.
 */
function queryRecordInScope(before: Token[]): { record: string | undefined; savedSearch: string | undefined } | undefined {
  let record: string | undefined;
  let savedSearch: string | undefined;
  let inWhere = false;
  for (let i = 0; i < before.length; i++) {
    const t = before[i]!;
    if (isQueryOperation(t) && before[i + 1]?.kind === "Identifier" && before[i + 1]!.text === "saved") {
      const a = before[i + 2];
      const b = before[i + 3];
      record = undefined;
      savedSearch = undefined;
      if (a?.kind === "Identifier" && (b?.kind === "String" || b?.kind === "Identifier")) {
        record = a.text;
        i += 3;
      } else if (a?.kind === "String") {
        savedSearch = a.value;
        i += 2;
      } else {
        i += 1;
      }
      inWhere = false;
      continue;
    }
    if (isQueryOperation(t) && before[i + 1]?.kind === "Identifier") {
      record = before[i + 1]!.text;
      savedSearch = undefined;
      inWhere = false;
      i++;
      continue;
    }
    if (t.kind === "Identifier" && t.text === "where" && (record || savedSearch)) {
      inWhere = true;
      continue;
    }
    // A line that begins with a clause word continues the search; any other boundary ends it.
    if (t.kind === "Terminator" && !(before[i + 1]?.kind === "Identifier" && CLAUSE_WORDS.includes(before[i + 1]!.text))) {
      record = undefined;
      savedSearch = undefined;
      inWhere = false;
    }
    if (t.kind === "Identifier" && (t.text === "select" || t.text === "order" || t.text === "group" || t.text === "limit" || t.text === "first") && before[i - 1]?.kind === "Terminator") inWhere = false;
    if (t.kind === "LBrace" || t.kind === "RBrace") {
      record = undefined;
      savedSearch = undefined;
      inWhere = false;
    }
  }
  return inWhere ? { record, savedSearch } : undefined;
}

/** If the innermost open block was opened by `add parent.sublist {`, that add. */
function enclosingAddBlock(before: Token[]): CompletionContext | undefined {
  let depth = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    const t = before[i]!;
    if (t.kind === "RBrace") depth++;
    else if (t.kind === "LBrace") {
      if (depth > 0) {
        depth--;
        continue;
      }
      const [add, parent, dot, sublist] = [before[i - 4], before[i - 3], before[i - 2], before[i - 1]];
      if (add?.kind === "Identifier" && add.text === "add" && parent?.kind === "Identifier" && dot?.kind === "Dot" && sublist?.kind === "Identifier") {
        return { kind: "lineInitializer", parent: parent.text, sublist: sublist.text };
      }
      return undefined;
    }
  }
  return undefined;
}

/** Inside a `select` or `order by` clause: which field position the cursor is at. */
function searchClauseContext(before: Token[]): CompletionContext | undefined {
  const search = searchInProgress(before);
  if (!search) return undefined;
  const current = search.clauses[search.clauses.length - 1];
  if (!current || (current.word !== "select" && current.word !== "order" && current.word !== "group")) return undefined;
  const scope = queryRecordInScope(before.slice(0, current.at + 1).concat([{ kind: "Identifier", text: "where", span: before[current.at]!.span }]));
  const record = scope?.record;
  const savedSearch = scope?.savedSearch;
  const after = before.slice(current.at + 1);
  const last = after[after.length - 1];
  const summary = summaryShape(before, search);
  if (current.word === "select") {
    if (after.length === 0 || last?.kind === "Comma") {
      const listed = after.filter((t, i) => t.kind === "Identifier" && after[i + 1]?.kind !== "Equals" && after[i - 1]?.kind !== "Equals").map((t) => t.text);
      return { kind: "selectField", record, savedSearch, listed, summary: summary.grouped || summary.aliases.length > 0 };
    }
    // `total = |`: an aggregate; `total = sum(|`: its field.
    if (last?.kind === "Equals" && after[after.length - 2]?.kind === "Identifier") return { kind: "aggregate", alias: after[after.length - 2]!.text };
    if (last?.kind === "LParen" && after[after.length - 2]?.kind === "Identifier" && AGGREGATES.includes(after[after.length - 2]!.text) && after[after.length - 3]?.kind === "Equals") {
      return { kind: "aggregateField", record, savedSearch, aggregate: after[after.length - 2]!.text };
    }
    return undefined;
  }
  if (current.word === "group") {
    if (after.length === 0) return undefined; // `group |`: nothing to offer but `by`, which the parser demands
    const listed = after.slice(1).filter((t) => t.kind === "Identifier").map((t) => t.text);
    if (after.length === 1 && last?.kind === "Identifier" && last.text === "by") return { kind: "groupField", record, savedSearch, listed };
    if (last?.kind === "Comma") return { kind: "groupField", record, savedSearch, listed };
    return undefined;
  }
  // order by: in a summary search, the result names; otherwise the record's sortable fields.
  const result = summary.grouped || summary.aliases.length > 0 ? [...summary.groups, ...summary.aliases] : undefined;
  if (after.length === 0) return undefined; // `order |`: nothing to offer but `by`, which the parser demands
  if (after.length === 1 && last?.kind === "Identifier" && last.text === "by") return { kind: "sortField", record, savedSearch, result };
  if (last?.kind === "Comma") return { kind: "sortField", record, savedSearch, result };
  if (last?.kind === "Identifier" && last.text !== "by" && last.text !== "asc" && last.text !== "desc") return { kind: "sortDirection" };
  return undefined;
}

/**
 * What the search's other clauses say about its summary, from tokens alone
 * (the search is being typed, so nothing has bound): the `group by` fields
 * and the aggregate names (`name =`) in `select`, in source order.
 */
function summaryShape(before: Token[], search: { start: number; clauses: { word: string; at: number }[] }): { grouped: boolean; groups: string[]; aliases: string[] } {
  const groups: string[] = [];
  const aliases: string[] = [];
  let grouped = false;
  search.clauses.forEach((clause, index) => {
    const end = search.clauses[index + 1]?.at ?? before.length;
    const tokens = before.slice(clause.at + 1, end);
    if (clause.word === "group") {
      grouped = true;
      for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i]!;
        if (t.kind !== "Identifier" || tokens[i - 1]?.kind === "Dot") continue;
        let name = t.text;
        while (tokens[i + 1]?.kind === "Dot" && tokens[i + 2]?.kind === "Identifier") {
          name += `.${tokens[i + 2]!.text}`;
          i += 2;
        }
        groups.push(name);
      }
    }
    if (clause.word === "select") {
      for (let i = 0; i < tokens.length; i++) if (tokens[i]!.kind === "Identifier" && tokens[i + 1]?.kind === "Equals") aliases.push(tokens[i]!.text);
    }
  });
  return { grouped, groups, aliases };
}

function classify(before: Token[], resolve: (name: string) => NameResolution | undefined): CompletionContext {
  const last = before[before.length - 1];
  let depth = 0;
  let parens = 0;
  for (const t of before) {
    if (t.kind === "LBrace") depth++;
    else if (t.kind === "RBrace") depth--;
    else if (t.kind === "LParen") parens++;
    else if (t.kind === "RParen") parens--;
  }

  if (last?.kind === "Dot") {
    const receiver: string[] = [];
    let i = before.length - 2;
    while (i >= 0 && before[i]!.kind === "Identifier") {
      receiver.unshift(before[i]!.text);
      if (i >= 1 && before[i - 1]!.kind === "Dot") i -= 2;
      else break;
    }
    return { kind: "member", dotOffset: last.span.start.offset, receiver };
  }

  const projection = depth > 0 ? projectionInProgress(before) : undefined;
  if (projection) return projection;

  if (depth <= 0) {
    if (!last || last.kind === "Terminator" || last.kind === "RBrace") return { kind: "topLevel" };
    // Inside a declaration header: find its keyword.
    let keyword: string | undefined;
    for (let i = before.length - 1; i >= 0; i--) {
      const t = before[i]!;
      if (t.kind === "RBrace") break;
      if (t.kind === "Identifier" && DECLARATION_KEYWORDS.includes(t.text)) {
        keyword = t.text;
        break;
      }
    }
    if (keyword && (USER_EVENT_HOOKS as readonly string[]).includes(keyword)) {
      if (parens > 0) return last.kind === "Colon" ? { kind: "recordType" } : { kind: "none" };
      return last.kind === "RParen" ? { kind: "none" } : { kind: "eventName" };
    }
    if (keyword === "fn") {
      // ':' reads "has type" in both positions: inside the parentheses it
      // types a parameter, after them it types the function's result.
      if (last.kind === "Colon") return { kind: parens > 0 ? "parameterType" : "returnType" };
    }
    return { kind: "none" };
  }

  if (!last || last.kind === "LBrace" || last.kind === "Terminator" || last.kind === "RBrace") {
    const add = enclosingAddBlock(before);
    if (add) return add;
    // A new line right after a search (or its clauses): the remaining clause words come first.
    if (last?.kind === "Terminator") {
      const search = searchInProgress(before.slice(0, -1));
      if (search && search.clauses.every((c) => c.at > search.start)) {
        const used = search.clauses.map((c) => c.word);
        return { kind: "searchClause", used: used.filter((w, i) => used.indexOf(w) === i) };
      }
    }
    return { kind: "statement" };
  }

  if (isQueryOperation(last)) return { kind: "recordType" };
  const savedId = savedSearchIdContext(before);
  if (savedId) return savedId;
  const clauseContext = searchClauseContext(before);
  if (clauseContext) return clauseContext;
  const queried = queryRecordInScope(before);
  if (queried) {
    const field: CompletionContext = { kind: "queryField", record: queried.record, savedSearch: queried.savedSearch };
    if (last.kind === "Identifier" && last.text === "where") return field;
    if (last.kind === "Identifier" && last.text === queried.record) return { kind: "none" };
    if (last.kind !== "Identifier" && last.kind !== "String" && last.kind !== "Number") return field;
  }

  if (last.kind === "Identifier") {
    if (STATEMENT_KEYWORDS.has(last.text) && !["if", "save", "delete", "remove", "add", "return"].includes(last.text)) return { kind: "none" };
    const resolved = resolve(last.text);
    if (resolved?.kind === "builtin" && resolved.builtin.kind === "recordOperation") return { kind: "recordType" };
    if (last.text === "to" && before[before.length - 2]?.kind === "RParen") return { kind: "recordType" };
    return { kind: "expression" };
  }

  if (last.kind === "Colon" || last.kind === "Pipe" || last.kind === "String" || last.kind === "Number") return { kind: "none" };
  return { kind: "expression" };
}
