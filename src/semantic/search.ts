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
 *   a && b                  [a, "and", b]    a || b                  [a, "or", b]
 *
 * `!` has no leaf of its own: it is pushed down to the operand, where it
 * flips the operator (`is`/`isnot`, `isempty`/`isnotempty`, `equalto`/
 * `notequalto`, `"T"`/`"F"`) and De Morgan's laws turn `!(a && b)` into
 * `!a || !b`. The one case without an exact complement is an ordering
 * comparison: `!(total < 5)` is not `total >= 5` when `total` is empty,
 * so it is rejected and the author writes the comparison they mean.
 *
 * What is deliberately not here: joins, summaries, formulas, saved
 * searches, and text operators such as `contains`. Each needs its own
 * syntax before it needs a lowering.
 */
import type { ComparisonOperation, QueryPredicate, QueryValue } from "./bound.js";
import type { FieldSchema } from "../schema/types.js";

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
  | { kind: "Filter"; field: FieldSchema; operator: SearchOperator; value: QueryValue | undefined }
  | { kind: "And"; left: SearchPredicate; right: SearchPredicate }
  | { kind: "Or"; left: SearchPredicate; right: SearchPredicate };

const NUMBER_OPERATORS: Record<ComparisonOperation, SearchOperator> = {
  Equal: "EQUALTO",
  NotEqual: "NOTEQUALTO",
  Less: "LESSTHAN",
  LessOrEqual: "LESSTHANOREQUALTO",
  Greater: "GREATERTHAN",
  GreaterOrEqual: "GREATERTHANOREQUALTO",
};

const NEGATED: Record<ComparisonOperation, ComparisonOperation | undefined> = {
  Equal: "NotEqual",
  NotEqual: "Equal",
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
      return { kind: "Filter", field: predicate.field, operator: "IS", value: { kind: "Constant", value: predicate.value !== negated ? "T" : "F" } };
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
      const { field, value } = predicate;
      if (field.type === "Number") {
        return { kind: "Filter", field, operator: NUMBER_OPERATORS[operation], value };
      }
      if (isOrdering(operation)) throw new Error(`ordering on ${field.type} should have been rejected by the binder`);
      if (value.kind === "Constant" && value.value === "") {
        return { kind: "Filter", field, operator: operation === "Equal" ? "ISEMPTY" : "ISNOTEMPTY", value: undefined };
      }
      return { kind: "Filter", field, operator: operation === "Equal" ? "IS" : "ISNOT", value };
    }
  }
}
