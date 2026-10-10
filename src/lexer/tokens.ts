import type { Span } from "../diagnostics.js";

export type TokenKind =
  | "Identifier"
  | "String"
  | "Number"
  | "LParen"
  | "RParen"
  | "LBrace"
  | "RBrace"
  | "LBracket"
  | "RBracket"
  | "Pipe"
  | "Colon"
  | "Dot"
  | "Equals"
  | "Comma"
  | "EqualsEquals"
  | "BangEquals"
  | "EqualsEqualsEquals"
  | "BangEqualsEquals"
  | "Bang"
  | "AmpAmp"
  | "PipePipe"
  | "Less"
  | "LessEquals"
  | "Greater"
  | "GreaterEquals"
  /** Statement terminator: an explicit `;` or an inserted newline. */
  | "Terminator"
  | "EOF";

export interface Token {
  kind: TokenKind;
  /** Raw source text. For strings, the decoded value lives in `value`. */
  text: string;
  /** Decoded string literal value. Only set for `String` tokens. */
  value?: string;
  /** Numeric value. Only set for `Number` tokens. */
  number?: number;
  span: Span;
}
