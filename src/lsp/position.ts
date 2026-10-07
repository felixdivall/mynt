/**
 * Offsets <-> LSP positions. Compiler offsets are JavaScript string indices,
 * which are UTF-16 code units, and LSP `character` is also UTF-16 code
 * units, so the conversion is a line table and nothing else. Lines are
 * split on "\n"; a preceding "\r" stays on the line it ends.
 */
import type { Span } from "../diagnostics.js";

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** A cursor at the end of a word means that word: the offset of its last character. */
export function wordOffsetAt(text: string, offset: number): number {
  const before = text[offset - 1] ?? "";
  const at = text[offset] ?? "";
  return /[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(at) ? offset - 1 : offset;
}

export class LineIndex {
  private readonly lineStarts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") this.lineStarts.push(i + 1);
  }

  positionAt(offset: number): LspPosition {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.lineStarts[mid]! <= clamped) low = mid;
      else high = mid - 1;
    }
    return { line: low, character: clamped - this.lineStarts[low]! };
  }

  offsetAt(position: LspPosition): number {
    if (position.line < 0) return 0;
    if (position.line >= this.lineStarts.length) return this.text.length;
    const start = this.lineStarts[position.line]!;
    const end = position.line + 1 < this.lineStarts.length ? this.lineStarts[position.line + 1]! - 1 : this.text.length;
    return Math.min(start + Math.max(0, position.character), end);
  }

  rangeOf(span: Span): LspRange {
    return { start: this.positionAt(span.start.offset), end: this.positionAt(span.end.offset) };
  }
}
