/**
 * Search predicates: the `where` clause of a `search` in N/search terms.
 *
 * A `search Customer where ...` condition is bound and validated exactly
 * like a `query` condition and first becomes the backend-neutral
 * QueryPredicate (a field compared with a value, a boolean field, and
 * `&&`/`||`/`!` over those). This module translates that predicate into
 * the operators N/search actually has, and refuses what it cannot express
 * honestly instead of approximating.
 *
 * Every supported Mynt predicate has one explicit lowering:
 *
 *   string field == ""      isempty          string field != ""      isnotempty
 *   string field == "x"     is "x"           string field != "x"     isnot "x"
 *   number field == 5       equalto 5        number field != 5       notequalto 5
 *   number field <  5       lessthan 5       number field <= 5       lessthanorequalto 5
 *   number field >  5       greaterthan 5    number field >= 5       greaterthanorequalto 5
 *   boolean field           is "T"           !booleanField           is "F"
 *   select field == Ref     anyof [id]       select field != Ref     noneof [id]
 *   a && b                  [a, "and", b]    a || b                  [a, "or", b]
 *
 * `!` has no leaf of its own: it is pushed down to the operand, where it
 * flips the operator (`is`/`isnot`, `isempty`/`isnotempty`, `equalto`/
 * `notequalto`, `"T"`/`"F"`) and De Morgan's laws turn `!(a && b)` into
 * `!a || !b`. The one case without an exact complement is an ordering
 * comparison: `!(total < 5)` is not `total >= 5` when `total` is empty,
 * so it is rejected and the author writes the comparison they mean.
 *
 * A select field compares with references by identity, through `anyof`
 * and `noneof`, which take a list of internal ids; `is` is a text operator
 * and is not used for select fields. That `noneof` matches records whose
 * field is empty, as the complement of `anyof`, is taken from NetSuite's
 * documentation and not yet verified live, like `isnot` for strings.
 *
 * What is deliberately not here: joins, summaries, formulas, saved
 * searches, and text operators such as `contains`. Each needs its own
 * syntax before it needs a lowering.
 */
import { assertsEqual, isEqualityOperation, type ComparisonOperation, type EqualityOperation, type JoinStep, type QueryPredicate, type QueryValue, type ReferenceOperand } from "./bound.js";
import type { FieldSchema, RecordSchema } from "../schema/types.js";

/** The `search.Operator` members Mynt emits, by their enum name. */
export type SearchOperator =
  | "IS"
  | "ISNOT"
  | "ISEMPTY"
  | "ISNOTEMPTY"
  | "EQUALTO"
  | "NOTEQUALTO"
  | "LESSTHAN"
  | "LESSTHANOREQUALTO"
  | "GREATERTHAN"
  | "GREATERTHANOREQUALTO";

/**
 * A filter expression in N/search's own shape: a leaf `[field, operator,
 * value]`, or two expressions joined by `and`/`or`. There is no `not`
 * node, by design (see above).
 */
export type SearchPredicate =
  /** `origin` is the Mynt comparison the leaf came from (after `!` push-down), kept although loose and strict map to one operator here. */
  | { kind: "Filter"; field: FieldSchema; join: JoinStep | undefined; operator: SearchOperator; value: QueryValue | undefined; origin: ComparisonOperation | undefined }
  /** A select field against reference ids: `[field, anyof | noneof, [ids]]`. Loose and strict both mean identity, so both lower here. */
  | { kind: "ReferenceFilter"; field: FieldSchema; join: JoinStep | undefined; record: RecordSchema; operator: "ANYOF" | "NONEOF"; values: ReferenceOperand[]; origin: EqualityOperation }
  | { kind: "And"; left: SearchPredicate; right: SearchPredicate }
  | { kind: "Or"; left: SearchPredicate; right: SearchPredicate };

const NUMBER_OPERATORS: Record<ComparisonOperation, SearchOperator> = {
  Equal: "EQUALTO",
  NotEqual: "NOTEQUALTO",
  StrictEqual: "EQUALTO",
  StrictNotEqual: "NOTEQUALTO",
  Less: "LESSTHAN",
  LessOrEqual: "LESSTHANOREQUALTO",
  Greater: "GREATERTHAN",
  GreaterOrEqual: "GREATERTHANOREQUALTO",
};

/** `!` pushed into a comparison keeps its mode: a negated loose equality is a loose inequality, a negated strict one a strict inequality. */
const NEGATED: Record<ComparisonOperation, ComparisonOperation | undefined> = {
  Equal: "NotEqual",
  NotEqual: "Equal",
  StrictEqual: "StrictNotEqual",
  StrictNotEqual: "StrictEqual",
  Less: undefined,
  LessOrEqual: undefined,
  Greater: undefined,
  GreaterOrEqual: undefined,
};

function isOrdering(operation: ComparisonOperation): boolean {
  return NEGATED[operation] === undefined;
}

/**
 * Translates a predicate into N/search terms. `negated` is the pushed-down
 * `!`. Returns undefined after `reject` has been called with the reason.
 */
export function toSearchPredicate(predicate: QueryPredicate, reject: (why: string) => void, negated = false): SearchPredicate | undefined {
  switch (predicate.kind) {
    case "Not":
      return toSearchPredicate(predicate.operand, reject, !negated);
    case "And":
    case "Or": {
      const left = toSearchPredicate(predicate.left, reject, negated);
      const right = toSearchPredicate(predicate.right, reject, negated);
      if (!left || !right) return undefined;
      // De Morgan: a negated `and` is an `or` of the negations, and vice versa.
      const kind = (predicate.kind === "And") !== negated ? "And" : "Or";
      return { kind, left, right };
    }
    case "Flag":
      return { kind: "Filter", field: predicate.field, join: predicate.join, operator: "IS", value: { kind: "Constant", value: predicate.value !== negated ? "T" : "F" }, origin: undefined };
    case "CompareReference": {
      const origin = negated ? (NEGATED[predicate.operation] as EqualityOperation) : predicate.operation;
      return {
        kind: "ReferenceFilter",
        field: predicate.field,
        join: predicate.join,
        record: predicate.record,
        operator: assertsEqual(origin) ? "ANYOF" : "NONEOF",
        values: predicate.values,
        origin,
      };
    }
    case "Compare": {
      let { operation } = predicate;
      if (negated) {
        const flipped = NEGATED[operation];
        if (!flipped) {
          reject(
            `'!' over an ordering comparison on '${predicate.field.id}' has no exact N/search operator (an empty field matches neither side); ` +
              `write the comparison you mean instead`,
          );
          return undefined;
        }
        operation = flipped;
      }
      const { field, join, value } = predicate;
      if (field.type === "Number") {
        return { kind: "Filter", field, join, operator: NUMBER_OPERATORS[operation], value, origin: operation };
      }
      if (!isEqualityOperation(operation)) throw new Error(`ordering on ${field.type} should have been rejected by the binder`);
      // Same-type loose and strict equality are one thing on a string field; the origin records which was written.
      if (value.kind === "Constant" && value.value === "") {
        return { kind: "Filter", field, join, operator: assertsEqual(operation) ? "ISEMPTY" : "ISNOTEMPTY", value: undefined, origin: operation };
      }
      return { kind: "Filter", field, join, operator: assertsEqual(operation) ? "IS" : "ISNOT", value, origin: operation };
    }
  }
}
