/**
 * Equality in Mynt: the one table that says which types `==`/`!=` and
 * `===`/`!==` may compare, and what the comparison means.
 *
 *   strict   `===`/`!==`: no coercion. Both sides must have one type:
 *            string, number, boolean, or references to one record type.
 *   loose    `==`/`!=`: JavaScript abstract equality where it is honest.
 *            The same pairs as strict, plus the three primitive cross
 *            pairs JavaScript coerces (string/number, boolean/number,
 *            boolean/string). Everything else is not comparable: a
 *            reference against a raw id, two different record types,
 *            records, rows, sequences, projections, dates, unknown fields.
 *
 * References compare by identity in both modes: same record type, same
 * canonical id. The mode changes nothing for them, since an id is already
 * canonical, and loose reference equality never becomes object coercion.
 *
 * Mynt has no null or undefined, so JavaScript's `null == undefined` and
 * the object-to-primitive coercions never arise: the only values a loose
 * comparison can see are the primitives above and references.
 *
 * The binder consults this for ordinary expressions and for predicates;
 * the backends then decide which categories they can represent exactly
 * (N/search and N/query have no coercion, so `coercive` is refused there).
 */
import type { RecordSchema } from "../schema/types.js";
import { isReferenceType, type MyntType } from "./types.js";

export type EqualityMode = "loose" | "strict";

export type ComparablePrimitive = "Text" | "Number" | "Bool";

export type Equality =
  /** Both sides have this one primitive type: no coercion in either mode. */
  | { kind: "same"; type: ComparablePrimitive }
  /** A loose comparison across primitive types, with JavaScript's abstract equality at runtime. */
  | { kind: "coercive"; left: ComparablePrimitive; right: ComparablePrimitive }
  /** Two references to one record type, compared by canonical id. */
  | { kind: "reference"; record: RecordSchema }
  /** Not comparable; `reason` says why, for the diagnostic. */
  | { kind: "incompatible"; reason: "strict" | "referenceTarget" | "domain" };

const PRIMITIVES: readonly string[] = ["Text", "Number", "Bool"];

function isComparablePrimitive(type: MyntType): type is ComparablePrimitive {
  return typeof type === "string" && PRIMITIVES.includes(type);
}

/** Loose pairs JavaScript coerces between, besides a same-type pair. */
const COERCIVE_PAIRS: ReadonlyArray<readonly [ComparablePrimitive, ComparablePrimitive]> = [
  ["Text", "Number"],
  ["Bool", "Number"],
  ["Bool", "Text"],
];

export function equalityOf(left: MyntType, right: MyntType, mode: EqualityMode): Equality {
  if (isComparablePrimitive(left) && isComparablePrimitive(right)) {
    if (left === right) return { kind: "same", type: left };
    const coerces = COERCIVE_PAIRS.some(([a, b]) => (a === left && b === right) || (a === right && b === left));
    if (mode === "loose" && coerces) return { kind: "coercive", left, right };
    return { kind: "incompatible", reason: mode === "strict" && coerces ? "strict" : "domain" };
  }
  if (isReferenceType(left) && isReferenceType(right)) {
    return left.record === right.record ? { kind: "reference", record: left.record } : { kind: "incompatible", reason: "referenceTarget" };
  }
  return { kind: "incompatible", reason: "domain" };
}

/** The source spelling of a mode's operators, for messages. */
export function equalityOperators(mode: EqualityMode): { equal: string; notEqual: string } {
  return mode === "strict" ? { equal: "===", notEqual: "!==" } : { equal: "==", notEqual: "!=" };
}
