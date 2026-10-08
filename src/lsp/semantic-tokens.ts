/**
 * Encodes the semantic tokens of a document as the protocol wants them:
 * a flat array of relative line, relative start, length, type index, and a
 * modifier bitmask. The legend lists the standard names this server uses.
 */
import { semanticTokens, type TokenKind, type TokenModifier } from "../semantic/tokens.js";
import type { SemanticDocument } from "../semantic/query.js";
import type { LineIndex } from "./position.js";

export const TOKEN_TYPES: readonly TokenKind[] = [
  "namespace",
  "type",
  "struct",
  "parameter",
  "variable",
  "property",
  "function",
  "method",
  "enumMember",
  "keyword",
  "string",
  "number",
];

export const TOKEN_MODIFIERS: readonly TokenModifier[] = ["declaration", "readonly", "defaultLibrary", "modification"];

export const SEMANTIC_TOKENS_LEGEND = { tokenTypes: [...TOKEN_TYPES], tokenModifiers: [...TOKEN_MODIFIERS] };

export function encodeSemanticTokens(doc: SemanticDocument, lines: LineIndex): number[] {
  const data: number[] = [];
  let previousLine = 0;
  let previousCharacter = 0;
  for (const token of semanticTokens(doc)) {
    const start = lines.positionAt(token.span.start.offset);
    const length = token.span.end.offset - token.span.start.offset;
    const deltaLine = start.line - previousLine;
    const deltaStart = deltaLine === 0 ? start.character - previousCharacter : start.character;
    let modifiers = 0;
    for (const modifier of token.modifiers) modifiers |= 1 << TOKEN_MODIFIERS.indexOf(modifier);
    data.push(deltaLine, deltaStart, length, TOKEN_TYPES.indexOf(token.kind), modifiers);
    previousLine = start.line;
    previousCharacter = start.character;
  }
  return data;
}
