/**
 * Traversal over the bound tree, shared by every phase that walks it so no
 * phase keeps its own list of which statements hold nested bodies.
 */
import type { BoundExpression, BoundStatement } from "./bound.js";

/** Visits every statement in `body`, including those in nested bodies, in source order. */
export function forEachStatement(body: readonly BoundStatement[], visit: (statement: BoundStatement) => void): void {
  for (const statement of body) {
    visit(statement);
    for (const nested of nestedBodies(statement)) forEachStatement(nested, visit);
  }
}

/** The statement lists a statement contains: branches of an `if`, body of a `for`. */
export function nestedBodies(statement: BoundStatement): readonly (readonly BoundStatement[])[] {
  switch (statement.kind) {
    case "If":
      return statement.elseBody ? [statement.thenBody, statement.elseBody] : [statement.thenBody];
    case "ForEach":
      return [statement.body];
    case "TryCatch":
      return [statement.body, ...(statement.handler ? [statement.handler] : []), ...(statement.finalizer ? [statement.finalizer] : [])];
    case "LocalDeclaration":
      // The absence branch of `let x = value or { ... }` is a body of its own.
      return statement.initializer.kind === "OptionalResolve" ? [statement.initializer.absence] : [];
    default:
      return [];
  }
}

/** The expressions a statement evaluates directly, not those of nested bodies. */
export function directExpressions(statement: BoundStatement): BoundExpression[] {
  switch (statement.kind) {
    case "LocalDeclaration":
      return [statement.initializer];
    case "Destructure":
      return [statement.source];
    case "FieldWrite":
      return [statement.receiver, statement.value];
    case "SaveRecord":
      return [statement.target];
    case "DeleteRecord":
      return [statement.target];
    case "RemoveLine":
      return [statement.line];
    case "AddLine":
      return [statement.target, ...statement.initializers.map((i) => i.value)];
    case "ExpressionStatement":
      return [statement.expression];
    case "TryCatch":
      return [];
    case "Return":
      return statement.value ? [statement.value] : [];
    case "If":
      return [statement.condition];
    case "ForEach":
      return [statement.iterable];
  }
}

/** Visits an expression and every expression inside it, outermost first. */
export function forEachExpression(expression: BoundExpression, visit: (expression: BoundExpression) => void): void {
  visit(expression);
  switch (expression.kind) {
    case "FieldRead":
    case "JoinedFieldRead":
    case "RecordIdRead":
    case "ReferenceTextRead":
    case "ErrorPropertyRead":
    case "ResultFieldRead":
    case "SublistAccess":
    case "Lookup":
      forEachExpression(expression.receiver, visit);
      break;
    case "OptionalResolve":
      forEachExpression(expression.value, visit);
      break;
    case "OptionalPresence":
      forEachExpression(expression.reference, visit);
      break;
    case "JoinedQueryField":
      forEachExpression(expression.base, visit);
      break;
    case "SelectedAggregate":
      if (expression.argument) forEachExpression(expression.argument, visit);
      break;
    case "AliasReference":
      break;
    case "RecordReference":
    case "FileLoad":
      forEachExpression(expression.id, visit);
      break;
    case "BuiltinCall":
    case "FunctionCall":
      for (const argument of expression.arguments) forEachExpression(argument, visit);
      break;
    case "Comparison":
    case "Logical":
      forEachExpression(expression.left, visit);
      forEachExpression(expression.right, visit);
      break;
    case "Not":
      forEachExpression(expression.operand, visit);
      break;
    case "Query":
      if (expression.source.kind === "saved") forEachExpression(expression.source.id, visit);
      if (expression.condition) forEachExpression(expression.condition, visit);
      break;
    default:
      break;
  }
}
