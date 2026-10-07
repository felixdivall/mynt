import type { Location, PrepareRenameResult, TextEdit, WorkspaceEdit } from "vscode-languageserver";
import { declarationOf, functionRenameConflict, referencesOf, renameConflict, renameRefusal, symbolAt } from "../semantic/symbols.js";
import type { SemanticDocument } from "../semantic/query.js";
import type { LineIndex } from "./position.js";

export function referencesAt(doc: SemanticDocument, lines: LineIndex, uri: string, offset: number, includeDeclaration: boolean): Location[] {
  const symbol = symbolAt(doc, offset);
  if (!symbol) return [];
  return referencesOf(doc, symbol)
    .filter((r) => includeDeclaration || !r.isDeclaration)
    .map((r) => ({ uri, range: lines.rangeOf(r.span) }));
}

export function definitionAtOffset(doc: SemanticDocument, lines: LineIndex, uri: string, offset: number): Location | null {
  const symbol = symbolAt(doc, offset);
  const span = symbol && declarationOf(symbol);
  return span ? { uri, range: lines.rangeOf(span) } : null;
}

export type RenameOutcome<T> = { ok: T } | { error: string };

export function prepareRenameAt(doc: SemanticDocument, lines: LineIndex, offset: number): RenameOutcome<PrepareRenameResult> {
  const symbol = symbolAt(doc, offset);
  if (!symbol) return { error: "Nothing to rename here" };
  const refusal = renameRefusal(symbol);
  if (refusal) return { error: refusal };
  if (symbol.kind !== "local" && symbol.kind !== "function") return { error: "Nothing to rename here" };
  // The range is the name at the cursor: the declaration, or the reference under the cursor.
  const name = symbol.kind === "local" ? symbol.local.name : symbol.function.name;
  const at = referencesOf(doc, symbol).find((r) => r.span.start.offset <= offset && offset <= r.span.end.offset) ?? {
    span: declarationOf(symbol)!,
  };
  return { ok: { range: lines.rangeOf(at.span), placeholder: name } };
}

/**
 * Edits for renaming the local at `offset`. Locals never cross files, so
 * the edit touches one document; a future cross-file symbol would return
 * more entries in `changes` from the same shape.
 */
export function renameAt(doc: SemanticDocument, lines: LineIndex, uri: string, offset: number, newName: string): RenameOutcome<WorkspaceEdit> {
  const symbol = symbolAt(doc, offset);
  if (!symbol) return { error: "Nothing to rename here" };
  const refusal = renameRefusal(symbol);
  if (refusal) return { error: refusal };
  if (symbol.kind !== "local" && symbol.kind !== "function") return { error: "Nothing to rename here" };
  const conflict = symbol.kind === "local" ? renameConflict(doc, symbol.local, newName) : functionRenameConflict(doc, symbol.function, newName);
  if (conflict) return { error: conflict };

  const edits: TextEdit[] = referencesOf(doc, symbol).map((r) => ({ range: lines.rangeOf(r.span), newText: newName }));
  return { ok: { changes: { [uri]: edits } } };
}
