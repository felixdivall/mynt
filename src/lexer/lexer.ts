import { DiagnosticBag, DiagnosticCode, type Position, type Span } from "../diagnostics.js";
import type { Token, TokenKind } from "./tokens.js";

/** Longer punctuation is matched before shorter: `===` is never `==` `=`. */
const PUNCTUATION: Record<string, TokenKind> = {
  "===": "EqualsEqualsEquals",
  "!==": "BangEqualsEquals",
  "==": "EqualsEquals",
  "!=": "BangEquals",
  "&&": "AmpAmp",
  "||": "PipePipe",
  "!": "Bang",
  "<=": "LessEquals",
  ">=": "GreaterEquals",
  "<": "Less",
  ">": "Greater",
  "(": "LParen",
  ")": "RParen",
  "{": "LBrace",
  "}": "RBrace",
  "[": "LBracket",
  "]": "RBracket",
  "|": "Pipe",
  ":": "Colon",
  ".": "Dot",
  "=": "Equals",
  ",": "Comma",
};

/**
 * Tokens after which a newline ends a statement. This is Go's rule: a newline
 * terminates a statement when the previous token could end one.
 */
const TERMINATES_ON_NEWLINE = new Set<TokenKind>(["Identifier", "String", "Number", "RParen", "RBrace", "RBracket"]);

function isIdentifierStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isIdentifierPart(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/**
 * Hand-written lexer. Produces a flat token array including Terminator tokens
 * and a final EOF token. Lexical errors are reported to the diagnostic bag and
 * the offending character is skipped so later phases still get something.
 */
export function tokenize(source: string, diagnostics: DiagnosticBag): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  let line = 1;
  let column = 1;

  const position = (): Position => ({ offset, line, column });

  const advance = (count = 1): void => {
    for (let i = 0; i < count; i++) {
      if (source[offset] === "\n") {
        line++;
        column = 1;
      } else {
        column++;
      }
      offset++;
    }
  };

  const push = (kind: TokenKind, start: Position, extra: { value?: string; number?: number } = {}): void => {
    const span: Span = { start, end: position() };
    const text = source.slice(start.offset, span.end.offset);
    tokens.push({ kind, text, span, ...extra });
  };

  const lastSignificant = (): Token | undefined => tokens[tokens.length - 1];

  while (offset < source.length) {
    const ch = source[offset]!;

    if (ch === "\n") {
      const previous = lastSignificant();
      if (previous && TERMINATES_ON_NEWLINE.has(previous.kind)) {
        const start = position();
        advance();
        push("Terminator", start);
      } else {
        advance();
      }
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\r") {
      advance();
      continue;
    }

    // Line comments.
    if (ch === "/" && source[offset + 1] === "/") {
      while (offset < source.length && source[offset] !== "\n") advance();
      continue;
    }

    if (ch === ";") {
      const start = position();
      advance();
      push("Terminator", start);
      continue;
    }

    // Longest operator first; a short final slice must not match a longer entry.
    const three = source.slice(offset, offset + 3);
    const threeKind = three.length === 3 ? PUNCTUATION[three] : undefined;
    const two = source.slice(offset, offset + 2);
    const twoKind = two.length === 2 ? PUNCTUATION[two] : undefined;
    const punct = threeKind ?? twoKind ?? PUNCTUATION[ch];
    if (punct) {
      const start = position();
      advance(threeKind ? 3 : twoKind ? 2 : 1);
      push(punct, start);
      continue;
    }

    // Numeric literals: digits with an optional fraction. No sign (there is
    // no unary minus) and no exponent.
    if (isDigit(ch)) {
      const start = position();
      while (offset < source.length && isDigit(source[offset]!)) advance();
      if (source[offset] === "." && isDigit(source[offset + 1] ?? "")) {
        advance();
        while (offset < source.length && isDigit(source[offset]!)) advance();
      }
      push("Number", start, { number: Number(source.slice(start.offset, offset)) });
      continue;
    }

    if (isIdentifierStart(ch)) {
      const start = position();
      while (offset < source.length && isIdentifierPart(source[offset]!)) advance();
      push("Identifier", start);
      continue;
    }

    if (ch === '"') {
      const start = position();
      advance();
      let value = "";
      let closed = false;
      while (offset < source.length) {
        const c = source[offset]!;
        if (c === '"') {
          advance();
          closed = true;
          break;
        }
        if (c === "\n") break;
        if (c === "\\") {
          const next = source[offset + 1];
          if (next === "n") value += "\n";
          else if (next === "t") value += "\t";
          else if (next === '"') value += '"';
          else if (next === "\\") value += "\\";
          else {
            diagnostics.error(
              DiagnosticCode.SyntaxError,
              `Unknown escape sequence '\\${next ?? ""}'`,
              { start: position(), end: { ...position(), column: column + 2, offset: offset + 2 } },
            );
          }
          advance(2);
          continue;
        }
        value += c;
        advance();
      }
      if (!closed) {
        diagnostics.error(DiagnosticCode.SyntaxError, "Unterminated string literal", {
          start,
          end: position(),
        });
      }
      push("String", start, { value });
      continue;
    }

    const start = position();
    advance();
    if (ch === "-" && source[offset] === ">") {
      advance();
      diagnostics.error(DiagnosticCode.SyntaxError, "Unexpected '->'; a return type is written ': Type' after the parameter list, as in 'fn name(): string'", { start, end: position() });
      continue;
    }
    diagnostics.error(DiagnosticCode.SyntaxError, `Unexpected character '${ch}'`, {
      start,
      end: position(),
    });
  }

  const eof = position();
  tokens.push({ kind: "EOF", text: "", span: { start: eof, end: eof } });
  return tokens;
}
