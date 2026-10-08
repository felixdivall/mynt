/**
 * Semantic tokens: what each name in the source *is*, from the bound model.
 *
 * Classification comes from bound nodes first (a local reference is a
 * variable or parameter because of its symbol, a field is a property
 * because of its FieldSchema, a record type is a type because of its
 * RecordSchema), then from the syntax tree for the things the bound model
 * does not carry: keywords at the positions where they are keywords,
 * literals, and the type names in function signatures. A contextual word
 * is a keyword only where the parser read it as one; `let where = "x"`
 * yields a variable at `where`, because that is what bound there.
 *
 * The taxonomy an editor sees, all standard LSP types and modifiers:
 *   fn let return if for in where to save ...   keyword
 *   query search load create copy transform      function + defaultLibrary
 *   log / log.debug                              namespace / method + defaultLibrary
 *   string number boolean                        type + defaultLibrary
 *   Customer SalesOrder                          struct
 *   create | edit                                enumMember
 *   true false                                   no token: the grammar's boolean capture stays
 *
 * The kinds and modifiers are the standard LSP vocabulary so that any
 * theme can style them; nothing here encodes protocol indexes.
 */
import { isPrimitiveTypeName } from "./types.js";
import type { Identifier } from "../parser/ast.js";
import type { Span } from "../diagnostics.js";
import type {
  BuiltinReference,
  FieldRead,
  FieldWrite,
  FunctionReference,
  LineInitializer,
  LocalDeclaration,
  LocalReference,
  LocalSymbol,
  LookupField,
  QueryField,
  RecordIdRead,
  RecordTypeReference,
  SublistAccess,
} from "./bound.js";
import { children, type SemanticDocument, type TreeNode } from "./query.js";
import { allBoundNodes } from "./symbols.js";

export type TokenKind =
  | "namespace"
  | "type"
  | "struct"
  | "parameter"
  | "variable"
  | "property"
  | "function"
  | "method"
  | "enumMember"
  | "keyword"
  | "string"
  | "number";

export type TokenModifier = "declaration" | "readonly" | "defaultLibrary" | "modification";

export interface SemanticToken {
  span: Span;
  kind: TokenKind;
  modifiers: TokenModifier[];
}

/** Every semantic token of the document, sorted by position, none overlapping. */
export function semanticTokens(doc: SemanticDocument): SemanticToken[] {
  const byStart = new Map<number, SemanticToken>();
  const add = (span: Span, kind: TokenKind, ...modifiers: TokenModifier[]): void => {
    if (span.start.offset === span.end.offset) return;
    const existing = byStart.get(span.start.offset);
    // Bound tokens are added first and win; syntax-derived tokens fill the gaps.
    if (!existing) byStart.set(span.start.offset, { span, kind, modifiers });
  };

  collectBound(doc, add);
  collectSyntax(doc, add);

  const tokens = [...byStart.values()].sort((a, b) => a.span.start.offset - b.span.start.offset);
  const out: SemanticToken[] = [];
  let end = -1;
  for (const token of tokens) {
    if (token.span.start.offset < end) continue;
    out.push(token);
    end = token.span.end.offset;
  }
  return out;
}

type Add = (span: Span, kind: TokenKind, ...modifiers: TokenModifier[]) => void;

function collectBound(doc: SemanticDocument, add: Add): void {
  const unit = doc.unit;
  if (!unit) return;

  if (unit.kind === "UserEvent") {
    for (const entryPoint of unit.entryPoints) add(entryPoint.parameter.declaredAt, "parameter", "declaration");
  }
  for (const fn of unit.functions) {
    add(fn.nameSpan, "function", "declaration");
    for (const parameter of fn.parameters) add(parameter.declaredAt, "parameter", "declaration");
  }

  for (const node of allBoundNodes(doc)) {
    switch (node.kind) {
      case "LocalReference": {
        const { local } = node as unknown as LocalReference;
        add(node.span, local.origin === "parameter" ? "parameter" : "variable");
        break;
      }
      case "LocalDeclaration":
        add((node as unknown as LocalDeclaration).local.declaredAt, "variable", "declaration");
        break;
      case "ForEach":
        add((node as unknown as { local: LocalSymbol }).local.declaredAt, "variable", "declaration");
        break;
      case "FieldRead": {
        const read = node as unknown as FieldRead;
        add(read.fieldSpan, "property", ...(read.field.writable ? [] : (["readonly"] as const)));
        break;
      }
      case "FieldWrite": {
        const write = node as unknown as FieldWrite;
        add(write.fieldSpan, "property", "modification");
        break;
      }
      case "LineInitializer":
        add((node as unknown as LineInitializer).fieldSpan, "property", "modification");
        break;
      case "QueryField": {
        const field = node as unknown as QueryField;
        add(field.span, "property", ...(field.field.writable ? [] : (["readonly"] as const)));
        break;
      }
      case "SublistAccess":
        add((node as unknown as SublistAccess).nameSpan, "property");
        break;
      case "LookupField": {
        // A projected field is a field read, wherever its values come from.
        const projected = node as unknown as LookupField;
        add(projected.span, "property", ...(projected.field.writable ? [] : (["readonly"] as const)));
        break;
      }
      case "RecordIdRead":
        add((node as unknown as RecordIdRead).nameSpan, "property", "readonly");
        break;
      case "RecordTypeReference":
        add((node as unknown as RecordTypeReference).span, "struct");
        break;
      case "BuiltinReference": {
        const reference = node as unknown as BuiltinReference;
        if (reference.namespaceSpan) {
          add(reference.namespaceSpan, "namespace", "defaultLibrary");
          add(reference.nameSpan, "method", "defaultLibrary");
        } else {
          add(reference.nameSpan, "function", "defaultLibrary");
        }
        break;
      }
      case "FunctionReference":
        add((node as unknown as FunctionReference).span, "function");
        break;
      default:
        break;
    }
  }
}

/** Keywords where the parser read them as keywords, literals, and signature type names. */
function collectSyntax(doc: SemanticDocument, add: Add): void {
  // A builtin type is a type from the default library. A schema record type
  // is a struct: a named, structured type with a known field schema and no
  // behavior of its own. Any other name in a type position is an error the
  // binder reports; it stays a plain type.
  const addTypeName = (type: Identifier): void => {
    if (isPrimitiveTypeName(type.name)) add(type.span, "type", "defaultLibrary");
    else if (doc.schema.getRecordByName(type.name)) add(type.span, "struct");
    else add(type.span, "type");
  };
  const visit = (node: TreeNode): void => {
    const n = node as Record<string, unknown> & TreeNode;
    switch (node.kind) {
      case "UserEventDeclaration":
        add(n.hookSpan as Span, "keyword");
        for (const event of n.events as TreeNode[]) add(event.span, "enumMember");
        break;
      case "ScheduledDeclaration":
      case "LetStatement":
      case "SaveStatement":
      case "DeleteStatement":
      case "RemoveStatement":
      case "AddStatement":
      case "ReturnStatement":
        add(n.keywordSpan as Span, "keyword");
        break;
      case "FunctionDeclaration":
        add(n.keywordSpan as Span, "keyword");
        for (const parameter of n.parameters as { type: Identifier }[]) addTypeName(parameter.type);
        if (n.returnType) addTypeName(n.returnType as Identifier);
        break;
      case "IfStatement":
        add(n.keywordSpan as Span, "keyword");
        if (n.elseSpan) add(n.elseSpan as Span, "keyword");
        break;
      case "ForStatement":
        add(n.keywordSpan as Span, "keyword");
        add(n.inSpan as Span, "keyword");
        break;
      case "QueryExpression":
        // `query` is a builtin operation like `load`, not structural syntax; `where` is.
        add(n.keywordSpan as Span, "function", "defaultLibrary");
        if (n.whereSpan) add(n.whereSpan as Span, "keyword");
        break;
      case "CallExpression":
        if (n.toSpan) add(n.toSpan as Span, "keyword");
        break;
      case "StringLiteral":
        add(node.span, "string");
        break;
      case "NumberLiteral":
        add(node.span, "number");
        break;
      case "BoolLiteral":
        // LSP has no boolean token type. Emitting `keyword` here would
        // override the grammar's boolean capture in a combined editor, so
        // literals are left to the grammar.
        break;
      default:
        break;
    }
    for (const child of children(node)) visit(child);
  };
  for (const declaration of doc.ast.declarations) visit(declaration as unknown as TreeNode);
}
