/**
 * Read-only queries over an analyzed document, for editor features.
 *
 * This is the only surface the language server uses to ask semantic
 * questions, and it answers them with the binder's own data: the bound
 * tree, the expression table (every expression the binder bound, whether
 * or not its statement survived), the symbol table, and the binder's name
 * resolution. Nothing here knows about editors, lines, or files.
 */
import { DiagnosticBag, type Diagnostic, type Span } from "../diagnostics.js";
import type { SourceFile } from "../parser/ast.js";
import { parse } from "../parser/parser.js";
import type { SchemaProvider } from "../schema/provider.js";
import { checkRecordLifecycle } from "./analysis.js";
import { bind, resolveName, type NameResolution } from "./binder.js";
import type { BoundExpression, LocalSymbol, ScriptUnit } from "./bound.js";
import type { SailType } from "./types.js";

export interface SemanticDocument {
  text: string;
  file: string;
  schema: SchemaProvider;
  ast: SourceFile;
  /** Undefined when the file has no bindable entry point. */
  unit: ScriptUnit | undefined;
  diagnostics: Diagnostic[];
}

/** Parse, bind, and analyze without emitting. The same phases `compile` runs. */
export function analyze(text: string, file: string, schema: SchemaProvider): SemanticDocument {
  const diagnostics = new DiagnosticBag(file);
  const ast = parse(text, file, diagnostics);
  const unit = bind(ast, schema, diagnostics);
  if (unit) checkRecordLifecycle(unit, diagnostics);
  return { text, file, schema, ast, unit, diagnostics: diagnostics.items };
}

/** Any syntax or bound node: everything with a `kind` and a `span`. */
export interface TreeNode {
  kind: string;
  span: Span;
  [key: string]: unknown;
}

function isTreeNode(value: unknown): value is TreeNode {
  return typeof value === "object" && value !== null && typeof (value as TreeNode).kind === "string" && "span" in value;
}

export function children(node: TreeNode): TreeNode[] {
  const out: TreeNode[] = [];
  for (const value of Object.values(node)) {
    if (isTreeNode(value)) out.push(value);
    else if (Array.isArray(value)) for (const item of value) if (isTreeNode(item)) out.push(item);
  }
  return out;
}

export function contains(span: Span, offset: number): boolean {
  return span.start.offset <= offset && offset < span.end.offset;
}

/** The chain of nodes containing `offset`, outermost first. */
export function pathAt(roots: readonly TreeNode[], offset: number): TreeNode[] {
  const path: TreeNode[] = [];
  let current = roots.find((root) => contains(root.span, offset));
  while (current) {
    path.push(current);
    current = children(current).find((child) => contains(child.span, offset));
  }
  return path;
}

export function syntaxPathAt(doc: SemanticDocument, offset: number): TreeNode[] {
  return pathAt(doc.ast.declarations as unknown as TreeNode[], offset);
}

/** Bound roots: every statement of every body, every entry point's parameter type, and every bound expression. */
function boundRoots(doc: SemanticDocument): TreeNode[] {
  const unit = doc.unit;
  if (!unit) return [];
  const roots: TreeNode[] = [];
  if (unit.kind === "UserEvent") {
    for (const entryPoint of unit.entryPoints) {
      roots.push(entryPoint.parameterType as unknown as TreeNode, ...(entryPoint.body as unknown as TreeNode[]));
    }
  } else {
    roots.push(...(unit.entryPoint.body as unknown as TreeNode[]));
  }
  for (const fn of unit.functions) roots.push(...(fn.body as unknown as TreeNode[]));
  roots.push(...(unit.expressions as unknown as TreeNode[]));
  return roots;
}

/**
 * The innermost bound node at `offset`: a statement, an expression, or a
 * reference (BuiltinReference, RecordTypeReference). Expressions inside a
 * statement that failed to bind are still found, through the expression
 * table.
 */
export function nodeAt(doc: SemanticDocument, offset: number): TreeNode | undefined {
  const path = pathAt(boundRoots(doc), offset);
  return path[path.length - 1];
}

function isExpression(node: TreeNode | undefined): node is TreeNode & BoundExpression {
  return node !== undefined && "type" in node && node.kind !== "FieldWrite";
}

/** The smallest bound expression containing `offset`. */
export function expressionAt(doc: SemanticDocument, offset: number): BoundExpression | undefined {
  const path = pathAt(boundRoots(doc), offset);
  for (let i = path.length - 1; i >= 0; i--) {
    const node = path[i];
    if (isExpression(node)) return node as unknown as BoundExpression;
  }
  return undefined;
}

/** The type of the smallest bound expression containing `offset`. */
export function typeAt(doc: SemanticDocument, offset: number): SailType | undefined {
  return expressionAt(doc, offset)?.type;
}

/** The largest bound expression that ends exactly at `offset`: the receiver of a `.` written there. */
export function expressionEndingAt(doc: SemanticDocument, offset: number): BoundExpression | undefined {
  let best: BoundExpression | undefined;
  for (const expression of doc.unit?.expressions ?? []) {
    if (expression.span.end.offset !== offset) continue;
    if (!best || expression.span.start.offset < best.span.start.offset) best = expression;
  }
  return best;
}

/** Locals whose names resolve at `offset`, as the binder scoped them. */
export function localsInScopeAt(doc: SemanticDocument, offset: number): LocalSymbol[] {
  if (!doc.unit) return [];
  return doc.unit.symbols
    .filter(({ scope }) => scope.start.offset <= offset && offset <= scope.end.offset)
    .map(({ local }) => local);
}

/** The local declared by the name written at `declaredAt`, if any. */
export function localDeclaredAt(doc: SemanticDocument, declaredAt: Span): LocalSymbol | undefined {
  return doc.unit?.symbols.find(({ local }) => local.declaredAt.start.offset === declaredAt.start.offset)?.local;
}

/** What `name` means at `offset`: the binder's resolution order over the binder's scopes. */
export function resolveNameAt(doc: SemanticDocument, name: string, offset: number): NameResolution | undefined {
  const local = localsInScopeAt(doc, offset).find((l) => l.name === name);
  return resolveName(name, local, doc.schema, new Map((doc.unit?.functions ?? []).map((f) => [f.name, f])));
}
