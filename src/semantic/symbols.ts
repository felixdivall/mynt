/**
 * Program symbols and their references, for navigation and refactoring.
 *
 * Identity is object identity, which the bound model already provides: a
 * declaration, its symbol-table entry, and every LocalReference share one
 * LocalSymbol; every read or write of a field shares the record's one
 * FieldSchema; every record-type reference shares the RecordSchema; every
 * built-in reference shares the registry entry. References are derived by
 * walking the bound nodes and comparing identity, never by spelling.
 */
import type { Span } from "../diagnostics.js";
import { BOOL_LITERALS, DECLARATION_KEYWORDS, QUERY_OPERATIONS } from "../parser/ast.js";
import type { FieldSchema, RecordSchema, SublistSchema } from "../schema/types.js";
import type {
  BoundFunction,
  BuiltinReference,
  FieldRead,
  FunctionReference,
  FieldWrite,
  LineInitializer,
  LocalDeclaration,
  LocalReference,
  LocalSymbol,
  Lookup,
  LookupField,
  QueryField,
  RecordTypeReference,
  SublistAccess,
} from "./bound.js";
import type { Builtin } from "./builtins.js";
import { resolveName } from "./binder.js";
import { boundPathAt, contains, type SemanticDocument, type TreeNode } from "./query.js";
import { isLineType, isProjectionType, isRecordType, type MyntType } from "./types.js";

export type SemanticSymbol =
  | { kind: "local"; local: LocalSymbol }
  /** A body field, or with `sublist` a sublist field: identity is the FieldSchema object, which is one per record and sublist. */
  | { kind: "field"; record: RecordSchema; field: FieldSchema; sublist?: SublistSchema }
  | { kind: "sublist"; record: RecordSchema; sublist: SublistSchema }
  | { kind: "recordType"; record: RecordSchema }
  | { kind: "builtin"; builtin: Builtin }
  | { kind: "function"; function: BoundFunction };

export interface SymbolReference {
  /** The identifier only, never the enclosing expression. */
  span: Span;
  isDeclaration: boolean;
}

export function symbolName(symbol: SemanticSymbol): string {
  switch (symbol.kind) {
    case "local":
      return symbol.local.name;
    case "field":
      return `${symbol.record.name}.${symbol.sublist ? `${symbol.sublist.id}.` : ""}${symbol.field.id}`;
    case "sublist":
      return `${symbol.record.name}.${symbol.sublist.id}`;
    case "recordType":
      return symbol.record.name;
    case "builtin":
      return symbol.builtin.name;
    case "function":
      return symbol.function.name;
  }
}

/** The symbol whose name is written at `offset`, if any. */
export function symbolAt(doc: SemanticDocument, offset: number): SemanticSymbol | undefined {
  const path = boundPathAt(doc, offset);
  const node = path[path.length - 1];
  switch (node?.kind) {
    case "LocalReference":
      return { kind: "local", local: (node as unknown as LocalReference).local };
    case "LocalDeclaration": {
      const { local } = node as unknown as LocalDeclaration;
      return contains(local.declaredAt, offset) ? { kind: "local", local } : undefined;
    }
    case "FieldRead":
    case "FieldWrite": {
      const access = node as unknown as FieldRead | FieldWrite;
      if (!contains(access.fieldSpan, offset)) return undefined;
      return fieldSymbol(access.receiver.type, access.field);
    }
    case "SublistAccess": {
      const access = node as unknown as SublistAccess;
      if (!contains(access.nameSpan, offset)) return undefined;
      return { kind: "sublist", record: access.type.parent.record, sublist: access.sublist };
    }
    case "LineInitializer": {
      const initializer = node as unknown as LineInitializer;
      if (!contains(initializer.fieldSpan, offset)) return undefined;
      return initializerSymbol(doc, initializer);
    }
    case "QueryField": {
      const field = node as unknown as QueryField;
      return { kind: "field", record: field.record, field: field.field };
    }
    case "LookupField": {
      const lookup = path[path.length - 2] as unknown as Lookup | undefined;
      return lookup?.kind === "Lookup" ? { kind: "field", record: lookup.record, field: (node as unknown as LookupField).field } : undefined;
    }
    case "RecordTypeReference":
      return { kind: "recordType", record: (node as unknown as RecordTypeReference).record };
    case "BuiltinReference": {
      const reference = node as unknown as BuiltinReference;
      return contains(reference.nameSpan, offset) ? { kind: "builtin", builtin: reference.builtin } : undefined;
    }
    case "FunctionReference":
      return { kind: "function", function: (node as unknown as FunctionReference).function };
    default:
      break;
  }
  const parameter = parameterDeclaredAt(doc, offset);
  if (parameter) return { kind: "local", local: parameter };
  const fn = doc.unit?.functions.find((f) => contains(f.nameSpan, offset));
  return fn ? { kind: "function", function: fn } : undefined;
}

function parameterDeclaredAt(doc: SemanticDocument, offset: number): LocalSymbol | undefined {
  if (doc.unit?.kind === "UserEvent") {
    const parameter = doc.unit.entryPoints.find((e) => contains(e.parameter.declaredAt, offset))?.parameter;
    if (parameter) return parameter;
  }
  for (const fn of doc.unit?.functions ?? []) {
    const parameter = fn.parameters.find((p) => contains(p.declaredAt, offset));
    if (parameter) return parameter;
  }
  return undefined;
}

export function declarationOf(symbol: SemanticSymbol): Span | undefined {
  if (symbol.kind === "local") return symbol.local.declaredAt;
  if (symbol.kind === "function") return symbol.function.nameSpan;
  return undefined;
}

/** The sublist field an add-block initializer names: found through the AddLine that holds it. */
function initializerSymbol(doc: SemanticDocument, initializer: LineInitializer): SemanticSymbol | undefined {
  for (const node of allBoundNodes(doc)) {
    if (node.kind !== "AddLine") continue;
    const add = node as unknown as { target: SublistAccess; initializers: LineInitializer[] };
    if (add.initializers.includes(initializer)) {
      return { kind: "field", record: add.target.type.parent.record, field: initializer.field, sublist: add.target.sublist };
    }
  }
  return undefined;
}

/** The field symbol for a read or write through a record, a projection, or a line. */
function fieldSymbol(receiverType: MyntType, field: FieldSchema): SemanticSymbol | undefined {
  if (isRecordType(receiverType) || isProjectionType(receiverType)) return { kind: "field", record: receiverType.record, field };
  if (isLineType(receiverType)) return { kind: "field", record: receiverType.parent.record, field, sublist: receiverType.sublist };
  return undefined;
}

function sameSymbol(a: SemanticSymbol, b: SemanticSymbol): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "local":
      return a.local === (b as typeof a).local;
    case "field":
      return a.field === (b as typeof a).field && a.record === (b as typeof a).record;
    case "sublist":
      return a.sublist === (b as typeof a).sublist && a.record === (b as typeof a).record;
    case "recordType":
      return a.record === (b as typeof a).record;
    case "builtin":
      return a.builtin === (b as typeof a).builtin;
    case "function":
      return a.function === (b as typeof a).function;
  }
}

/** Every bound node in the document, each once, from the tree and the expression table. */
export function allBoundNodes(doc: SemanticDocument): TreeNode[] {
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
  roots.push(...(unit.expressions as unknown as TreeNode[]));

  const seen = new Set<TreeNode>();
  const out: TreeNode[] = [];
  const visit = (node: TreeNode): void => {
    if (seen.has(node)) return;
    seen.add(node);
    out.push(node);
    for (const value of Object.values(node)) {
      if (isTreeNode(value)) visit(value);
      else if (Array.isArray(value)) for (const item of value) if (isTreeNode(item)) visit(item);
    }
  };
  for (const root of roots) visit(root);
  return out;
}

function isTreeNode(value: unknown): value is TreeNode {
  return typeof value === "object" && value !== null && typeof (value as TreeNode).kind === "string" && "span" in value;
}

/** All places `symbol` is named, in source order, declaration included and marked. */
export function referencesOf(doc: SemanticDocument, symbol: SemanticSymbol): SymbolReference[] {
  const refs = new Map<number, SymbolReference>();
  const add = (span: Span, isDeclaration = false): void => {
    refs.set(span.start.offset, { span, isDeclaration });
  };

  const declaration = declarationOf(symbol);
  if (declaration) add(declaration, true);

  for (const node of allBoundNodes(doc)) {
    switch (node.kind) {
      case "LocalReference": {
        const reference = node as unknown as LocalReference;
        if (sameSymbol(symbol, { kind: "local", local: reference.local })) add(reference.span);
        break;
      }
      case "FieldRead":
      case "FieldWrite": {
        const access = node as unknown as FieldRead | FieldWrite;
        const other = fieldSymbol(access.receiver.type, access.field);
        if (other && sameSymbol(symbol, other)) add(access.fieldSpan);
        break;
      }
      case "SublistAccess": {
        const access = node as unknown as SublistAccess;
        if (sameSymbol(symbol, { kind: "sublist", record: access.type.parent.record, sublist: access.sublist })) add(access.nameSpan);
        break;
      }
      case "LineInitializer": {
        const initializer = node as unknown as LineInitializer;
        const other = initializerSymbol(doc, initializer);
        if (other && sameSymbol(symbol, other)) add(initializer.fieldSpan);
        break;
      }
      case "QueryField": {
        const field = node as unknown as QueryField;
        if (sameSymbol(symbol, { kind: "field", record: field.record, field: field.field })) add(field.span);
        break;
      }
      case "Lookup": {
        const lookup = node as unknown as Lookup;
        for (const projected of lookup.fields) {
          if (sameSymbol(symbol, { kind: "field", record: lookup.record, field: projected.field })) add(projected.span);
        }
        break;
      }
      case "RecordTypeReference": {
        const reference = node as unknown as RecordTypeReference;
        if (sameSymbol(symbol, { kind: "recordType", record: reference.record })) add(reference.span);
        break;
      }
      case "BuiltinReference": {
        const reference = node as unknown as BuiltinReference;
        if (sameSymbol(symbol, { kind: "builtin", builtin: reference.builtin })) add(reference.nameSpan);
        break;
      }
      case "FunctionReference": {
        const reference = node as unknown as FunctionReference;
        if (sameSymbol(symbol, { kind: "function", function: reference.function })) add(reference.span);
        break;
      }
      default:
        break;
    }
  }
  return [...refs.values()].sort((a, b) => a.span.start.offset - b.span.start.offset);
}

// ---- rename ----------------------------------------------------------------

/** Contextual keywords and literals a local may not be named, whatever the parser would tolerate. */
const RESERVED = new Set([...DECLARATION_KEYWORDS, "let", "if", "else", "save", "delete", "remove", "add", "for", "in", ...QUERY_OPERATIONS, "where", "return", ...BOOL_LITERALS]);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The name a built-in is reached by at root scope: its namespace (`log`) or itself (`load`). */
export function builtinRootName(builtin: Builtin): string {
  const dot = builtin.name.indexOf(".");
  return dot < 0 ? builtin.name : builtin.name.slice(0, dot);
}

/** Why `symbol` cannot be renamed at all, or undefined if it can. */
export function renameRefusal(symbol: SemanticSymbol): string | undefined {
  switch (symbol.kind) {
    case "local":
      return undefined;
    case "field":
      return `'${symbol.field.id}' is a NetSuite field of ${symbolName({ ...symbol, field: symbol.field }).slice(0, -symbol.field.id.length - 1)}; its name comes from the schema and cannot be renamed here`;
    case "sublist":
      return `'${symbol.sublist.id}' is a NetSuite sublist of ${symbol.record.name}; its name comes from the schema and cannot be renamed here`;
    case "recordType":
      return `'${symbol.record.name}' is a record type; its name comes from the schema and cannot be renamed here`;
    case "builtin":
      return `'${symbol.builtin.name}' is a built-in and cannot be renamed`;
    case "function":
      return undefined;
  }
}

/** Why renaming a function to `newName` would be wrong, or undefined if it is safe. */
export function functionRenameConflict(doc: SemanticDocument, fn: BoundFunction, newName: string): string | undefined {
  if (!IDENTIFIER.test(newName)) return `'${newName}' is not a valid identifier`;
  if (RESERVED.has(newName)) return `'${newName}' is reserved and cannot name a function`;
  if (newName === fn.name) return `'${newName}' is already the name`;
  const other = doc.unit?.functions.find((f) => f !== fn && f.name === newName);
  if (other) return `'${newName}' is already a function (line ${other.nameSpan.start.line})`;
  if (resolveName(newName, undefined, doc.schema)) return `'${newName}' is already the name of a built-in or record type`;
  const local = doc.unit?.symbols.find((s) => s.local.name === newName);
  if (local) return `'${newName}' is a local (line ${local.local.declaredAt.start.line}), which would shadow the function wherever it is in scope`;
  return undefined;
}

/**
 * Why renaming `local` to `newName` would be wrong, or undefined if it is
 * safe. Checks, in order: the spelling is an identifier and not reserved;
 * no other local named `newName` is in scope anywhere the renamed local is
 * in scope (regions are nested or disjoint, so an overlap means one of the
 * two declarations would see the other, which the binder forbids); and no
 * built-in named `newName` is used inside the renamed local's region, since
 * a local shadows built-ins and the use would silently start meaning the
 * local.
 */
export function renameConflict(doc: SemanticDocument, local: LocalSymbol, newName: string): string | undefined {
  if (!IDENTIFIER.test(newName)) return `'${newName}' is not a valid identifier`;
  if (RESERVED.has(newName)) return `'${newName}' is reserved and cannot name a local`;
  if (newName === local.name) return `'${newName}' is already the name`;

  const entry = doc.unit?.symbols.find((s) => s.local === local);
  if (!entry) return `'${local.name}' is not declared in this document`;
  const region = entry.scope;

  for (const other of doc.unit!.symbols) {
    if (other.local === local || other.local.name !== newName) continue;
    if (overlaps(other.scope, region)) {
      const what = other.local.origin === "parameter" ? "the entry point parameter" : "a local";
      return `'${newName}' is already declared in this scope as ${what} (line ${other.local.declaredAt.start.line})`;
    }
  }

  for (const node of allBoundNodes(doc)) {
    if (node.kind !== "BuiltinReference") continue;
    const reference = node as unknown as BuiltinReference;
    const rootSpan = reference.namespaceSpan ?? reference.nameSpan;
    if (!contains(region, rootSpan.start.offset)) continue;
    if (builtinRootName(reference.builtin) === newName) {
      return `'${newName}' is used as a built-in in this scope (line ${rootSpan.start.line}); the rename would make it mean the local instead`;
    }
  }
  return undefined;
}

function overlaps(a: Span, b: Span): boolean {
  return a.start.offset < b.end.offset && b.start.offset < a.end.offset;
}
