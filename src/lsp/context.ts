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
  /** Inside `query T where ...` or `search T where ...`: bare names are T's fields, plus captured locals. */
  | { kind: "queryField"; record: string }
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

const STATEMENT_KEYWORDS = new Set(["let", "if", "save", "delete", "remove", "add", "else", "for", "return"]);

export function completionSite(text: string, offset: number, resolve: (name: string) => NameResolution | undefined): CompletionSite {
  const tokens = tokenize(text, new DiagnosticBag("")).filter((t) => t.kind !== "EOF");
  const at = (t: Token) => t.span.start.offset < offset && offset < t.span.end.offset;
  const point = { offset, line: 0, column: 0 };

  if (tokens.some((t) => t.kind === "String" && at(t))) {
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

/**
 * The record of the `query T where ...` or `search T where ...` the cursor
 * is inside, if any: the last `query T` with a `where` after it and no
 * statement boundary since (a terminator that is not immediately followed
 * by `where`).
 */
function queryRecordInScope(before: Token[]): string | undefined {
  let record: string | undefined;
  let inWhere = false;
  for (let i = 0; i < before.length; i++) {
    const t = before[i]!;
    if (isQueryOperation(t) && before[i + 1]?.kind === "Identifier") {
      record = before[i + 1]!.text;
      inWhere = false;
      i++;
      continue;
    }
    if (t.kind === "Identifier" && t.text === "where" && record) {
      inWhere = true;
      continue;
    }
    if (t.kind === "Terminator" && !(before[i + 1]?.kind === "Identifier" && before[i + 1]!.text === "where")) {
      record = undefined;
      inWhere = false;
    }
    if (t.kind === "LBrace" || t.kind === "RBrace") {
      record = undefined;
      inWhere = false;
    }
  }
  return inWhere ? record : undefined;
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
    return add ?? { kind: "statement" };
  }

  if (isQueryOperation(last)) return { kind: "recordType" };
  const queried = queryRecordInScope(before);
  if (queried) {
    if (last.kind === "Identifier" && last.text === "where") return { kind: "queryField", record: queried };
    if (last.kind === "Identifier" && last.text === queried) return { kind: "none" };
    if (last.kind !== "Identifier" && last.kind !== "String" && last.kind !== "Number") return { kind: "queryField", record: queried };
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
