import type { Span } from "../diagnostics.js";
import type { Block, LetStatement } from "../parser/ast.js";
import type { SemanticDocument } from "../semantic/query.js";
import { declarationOf, symbolAt } from "../semantic/symbols.js";
import { wordOffsetAt } from "./position.js";

/** Where the symbol at `offset` was declared. Only locals have declarations in a Mynt file. */
export function definitionAt(doc: SemanticDocument, offset: number): Span | undefined {
  const symbol = symbolAt(doc, wordOffsetAt(doc.text, offset));
  return symbol && declarationOf(symbol);
}

export interface OutlineSymbol {
  name: string;
  kind: "entryPoint" | "function" | "local";
  detail: string;
  span: Span;
  selectionSpan: Span;
  children: OutlineSymbol[];
}

export function documentOutline(doc: SemanticDocument): OutlineSymbol[] {
  return doc.ast.declarations.map((declaration) => {
    if (declaration.kind === "FunctionDeclaration") {
      const params = declaration.parameters.map((p) => `${p.name.name}: ${p.type.name}`).join(", ");
      return {
        name: declaration.name.name,
        kind: "function",
        detail: `fn (${params})${declaration.returnType ? ` -> ${declaration.returnType.name}` : ""}`,
        span: declaration.span,
        selectionSpan: declaration.name.span,
        children: locals(declaration.body),
      };
    }
    if (declaration.kind === "ScheduledDeclaration") {
      return {
        name: "scheduled",
        kind: "entryPoint",
        detail: "scheduled script",
        span: declaration.span,
        selectionSpan: declaration.keywordSpan,
        children: locals(declaration.body),
      };
    }
    const events = declaration.events.map((e) => e.name).join(" | ");
    return {
      name: declaration.hook,
      kind: "entryPoint",
      detail: `${events ? `${events} ` : ""}(${declaration.parameter.name.name}: ${declaration.parameter.type.name})`,
      span: declaration.span,
      selectionSpan: declaration.hookSpan,
      children: locals(declaration.body),
    };
  });
}

function locals(block: Block): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  for (const statement of block.statements) {
    if (statement.kind === "LetStatement") {
      const let_ = statement as LetStatement;
      out.push({ name: let_.name.name, kind: "local", detail: "let", span: let_.span, selectionSpan: let_.name.span, children: [] });
    } else if (statement.kind === "IfStatement") {
      out.push(...locals(statement.thenBlock));
      if (statement.elseBlock) out.push(...locals(statement.elseBlock));
    }
  }
  return out;
}
