/**
 * Hover from the bound model. The innermost bound node at the cursor says
 * what is there: a local reference, a field read or write, a built-in or
 * record-type reference, a declaration. Nothing is re-resolved from syntax;
 * the only syntax-tree use is the entry point header's event names, which
 * are declarations, not expressions.
 */
import type { Span } from "../diagnostics.js";
import type { Identifier, UserEventDeclaration } from "../parser/ast.js";
import type { FieldSchema, RecordSchema } from "../schema/types.js";
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
  Query,
  QueryField,
  RecordIdRead,
  RecordReference,
  RecordTypeReference,
  SublistAccess,
} from "../semantic/bound.js";
import { builtinSignature, type Builtin } from "../semantic/builtins.js";
import { boundPathAt, contains, syntaxPathAt, type SemanticDocument, type TreeNode } from "../semantic/query.js";
import { allBoundNodes } from "../semantic/symbols.js";
import { isLineType, isPrimitiveTypeName, isProjectionType, isRecordType, isReferenceType, sublistName, typeName } from "../semantic/types.js";
import { code, describeLocal, fieldDetail, recordDetail } from "./describe.js";
import { wordOffsetAt } from "./position.js";
import { functionSignatureInfo, referenceSignatureInfo } from "./signature-help.js";

export interface HoverResult {
  /** Markdown. */
  contents: string;
  span: Span;
}

export function hoverAt(doc: SemanticDocument, offset: number): HoverResult | undefined {
  return hoverExactlyAt(doc, wordOffsetAt(doc.text, offset));
}

function hoverExactlyAt(doc: SemanticDocument, offset: number): HoverResult | undefined {
  const path = boundPathAt(doc, offset);
  const node = path[path.length - 1];
  if (node) return boundHover(doc, node, path[path.length - 2], offset) ?? undefined;
  return headerHover(doc, offset);
}

function boundHover(doc: SemanticDocument, node: TreeNode, parent: TreeNode | undefined, offset: number): HoverResult | undefined {
  switch (node.kind) {
    case "LocalReference": {
      const reference = node as unknown as LocalReference;
      return { contents: localHover(reference.local), span: reference.span };
    }
    case "FieldRead": {
      const read = node as unknown as FieldRead;
      if (!contains(read.fieldSpan, offset)) return undefined;
      return { contents: fieldHover(ownerOf(read.receiver.type), read.field), span: read.fieldSpan };
    }
    case "FieldWrite": {
      const write = node as unknown as FieldWrite;
      if (!contains(write.fieldSpan, offset)) return undefined;
      return { contents: fieldHover(ownerOf(write.receiver.type), write.field), span: write.fieldSpan };
    }
    case "LineInitializer": {
      const initializer = node as unknown as LineInitializer;
      if (!contains(initializer.fieldSpan, offset)) return undefined;
      return { contents: fieldHover(initializerOwner(doc, offset), initializer.field), span: initializer.fieldSpan };
    }
    case "SublistAccess": {
      const access = node as unknown as SublistAccess;
      if (!contains(access.nameSpan, offset)) return undefined;
      const parent = access.type.parent.record.name;
      return {
        contents: code(`${access.sublist.id}: sublist of ${parent}`) + `\n\n${access.sublist.label} · ${access.sublist.fields.size} fields · iterate with \`for line in x.${access.sublist.id}\`; lines persist when the ${parent} is saved`,
        span: access.nameSpan,
      };
    }
    case "QueryField": {
      const field = node as unknown as QueryField;
      return { contents: fieldHover(field.record.name, field.field), span: field.span };
    }
    case "RecordIdRead": {
      const read = node as unknown as RecordIdRead;
      if (!contains(read.nameSpan, offset)) return undefined;
      const record = recordOf(read.receiver.type) ?? (isReferenceType(read.receiver.type) ? read.receiver.type.record : undefined);
      return { contents: code(`${record ? `${record.name}.` : ""}id: string`) + "\n\ninternal id of the record · use it to `load` the record", span: read.nameSpan };
    }
    case "LookupField": {
      const projected = node as unknown as LookupField;
      const lookup = parent as unknown as Lookup | undefined;
      return { contents: fieldHover(lookup?.kind === "Lookup" ? lookup.record.name : undefined, projected.field), span: projected.span };
    }
    case "Query": {
      // The `query`/`search` word has no bound node of its own; it is the start of the expression.
      const query = node as unknown as Query;
      const keyword = { start: query.span.start, end: { ...query.span.start, offset: query.span.start.offset + query.operation.length, column: query.span.start.column + query.operation.length } };
      if (!contains(keyword, offset)) return undefined;
      const record = query.recordType.record.name;
      const module = query.operation === "query" ? "N/query" : "N/search";
      return {
        contents:
          code(`${query.operation} ${record}${query.condition ? " where ..." : ""}: Sequence<${record}>`) +
          `\n\n${query.operation === "query" ? "query" : "search"} over \`${module}\` · read-only rows with \`id\` and the fields the program reads · one ${query.operation} runs per expression`,
        span: keyword,
      };
    }
    case "BuiltinReference": {
      const reference = node as unknown as BuiltinReference;
      if (reference.namespaceSpan && contains(reference.namespaceSpan, offset)) {
        const namespace = reference.builtin.name.slice(0, reference.builtin.name.indexOf("."));
        return { contents: code(`namespace ${namespace}`), span: reference.namespaceSpan };
      }
      return { contents: builtinHover(reference.builtin), span: reference.nameSpan };
    }
    case "RecordTypeReference": {
      const reference = node as unknown as RecordTypeReference;
      if (parent?.kind === "RecordReference") {
        const record = (parent as unknown as RecordReference).recordType.record;
        return {
          contents:
            code(referenceSignatureInfo(record).label) +
            `\n\nreference to a ${record.name} by internal id · nothing is loaded · read fields with \`[email, ...]\` (one \`N/search.lookupFields\` call) or load it with \`load ${record.name}(ref.id)\``,
          span: reference.span,
        };
      }
      return { contents: recordHover(reference.record), span: reference.span };
    }
    case "FunctionReference": {
      const reference = node as unknown as FunctionReference;
      return { contents: functionHover(reference.function), span: reference.span };
    }
    case "LocalDeclaration": {
      const declaration = node as unknown as LocalDeclaration;
      if (!contains(declaration.local.declaredAt, offset)) return undefined;
      return { contents: localHover(declaration.local), span: declaration.local.declaredAt };
    }
    default:
      return undefined;
  }
}

/** Declaration headers: entry point parameter, event names, function names and parameters. */
function headerHover(doc: SemanticDocument, offset: number): HoverResult | undefined {
  if (doc.unit?.kind === "UserEvent") {
    const entryPoint = doc.unit.entryPoints.find((e) => contains(e.parameter.declaredAt, offset));
    if (entryPoint) return { contents: localHover(entryPoint.parameter), span: entryPoint.parameter.declaredAt };
  }
  for (const fn of doc.unit?.functions ?? []) {
    if (contains(fn.nameSpan, offset)) return { contents: functionHover(fn), span: fn.nameSpan };
    const parameter = fn.parameters.find((p) => contains(p.declaredAt, offset));
    if (parameter) return { contents: localHover(parameter), span: parameter.declaredAt };
  }
  // Type names in a function signature: builtin types and record types
  // are hovered differently so the distinction the editor draws is spelled out.
  for (const declaration of doc.ast.declarations) {
    if (declaration.kind !== "FunctionDeclaration") continue;
    const types = [...declaration.parameters.map((p) => p.type), ...(declaration.returnType ? [declaration.returnType] : [])];
    const type = types.find((t) => contains(t.span, offset));
    if (!type) continue;
    if (isPrimitiveTypeName(type.name)) return { contents: primitiveHover(type.name), span: type.span };
    const record = doc.schema.getRecordByName(type.name);
    if (record) return { contents: recordHover(record), span: type.span };
  }
  const path = syntaxPathAt(doc, offset);
  const node = path[path.length - 1];
  const parent = path[path.length - 2];
  if (node?.kind === "Identifier" && parent?.kind === "UserEventDeclaration") {
    const identifier = node as unknown as Identifier;
    if ((parent as unknown as UserEventDeclaration).events.includes(identifier)) {
      return {
        contents: code(`event ${identifier.name}`) + `\n\n\`context.UserEventType.${identifier.name.toUpperCase()}\``,
        span: identifier.span,
      };
    }
  }
  return undefined;
}

function recordOf(type: unknown): RecordSchema | undefined {
  return isRecordType(type as never) ? (type as { record: RecordSchema }).record : undefined;
}

/** The `SalesOrder.item` of the add block containing `offset`. */
function initializerOwner(doc: SemanticDocument, offset: number): string | undefined {
  let owner: string | undefined;
  for (const node of allBoundNodes(doc)) {
    if (node.kind === "AddLine" && contains(node.span, offset)) {
      const add = node as unknown as { target: SublistAccess };
      owner = sublistName(add.target.type);
    }
  }
  return owner;
}

/** Who owns a field: `Customer`, or `SalesOrder.item` for a line, or the record a projection was taken from. */
function ownerOf(type: unknown): string | undefined {
  if (isLineType(type as never)) return sublistName(type as never);
  if (isProjectionType(type as never)) return (type as { record: RecordSchema }).record.name;
  return recordOf(type)?.name;
}

const PRIMITIVE_SUMMARY: Record<string, string> = {
  string: "text; the type of string literals and text fields",
  number: "numeric; the type of number literals and numeric fields",
  boolean: "true or false; the type of comparisons and the only type an `if` or `where` condition may have",
};

function primitiveHover(name: string): string {
  return code(`builtin type ${name}`) + `\n\nMynt builtin type · ${PRIMITIVE_SUMMARY[name] ?? ""}`;
}

function recordHover(record: RecordSchema): string {
  return code(`${record.custom ? "custom record" : "record"} ${record.name}`) + `\n\n${recordDetail(record)}`;
}

function fieldHover(owner: string | undefined, field: FieldSchema): string {
  const prefix = owner ? `${owner}.` : "";
  return code(`${prefix}${field.id}: ${typeName(field.type)}`) + `\n\n${field.label} · ${fieldDetail(field)} · NetSuite field \`${field.id}\``;
}

function localHover(local: LocalSymbol): string {
  const what = { parameter: "parameter", let: "local", loop: "loop variable" }[local.origin];
  return code(`${local.name}: ${typeName(local.type)}`) + `\n\n${what} · ${describeLocal(local)}`;
}

export function functionSignature(fn: BoundFunction): string {
  return functionSignatureInfo(fn).label;
}

function functionHover(fn: BoundFunction): string {
  const records = fn.parameters.filter((p) => isRecordType(p.type)).map((p) => p.name);
  return code(functionSignature(fn)) + (records.length > 0 ? `\n\nrecord parameters: ${records.join(", ")} · what the function does to them is checked at each call` : "");
}

function builtinHover(builtin: Builtin): string {
  return code(builtinSignature(builtin)) + `\n\n${builtin.summary}` + (builtin.module ? ` · NetSuite module \`${builtin.module}\`` : "");
}
