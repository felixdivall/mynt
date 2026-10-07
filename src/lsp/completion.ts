import { CompletionItemKind, InsertTextFormat, type CompletionItem } from "vscode-languageserver";
import { USER_EVENT_TYPES } from "../semantic/bound.js";
import { builtinSignature, listBuiltinRoots, type BuiltinSymbol } from "../semantic/builtins.js";
import { expressionEndingAt, localsInScopeAt, resolveNameAt, type SemanticDocument } from "../semantic/query.js";
import { isLineType, isRecordType, sublistName, type RecordType } from "../semantic/types.js";
import type { SublistSchema } from "../schema/types.js";
import type { FieldSchema, RecordSchema } from "../schema/types.js";
import { completionSite, type CompletionContext } from "./context.js";
import { describeLocal, fieldDetail, recordDetail } from "./describe.js";
import { functionSignature } from "./hover.js";

export function completionsAt(doc: SemanticDocument, offset: number): CompletionItem[] {
  const site = completionSite(doc.text, offset, (name) => resolveNameAt(doc, name, offset));
  return itemsFor(doc, offset, site.context);
}

function itemsFor(doc: SemanticDocument, offset: number, context: CompletionContext): CompletionItem[] {
  switch (context.kind) {
    case "topLevel":
      return declarationItems(firstRecordName(doc));
    case "eventName":
      return USER_EVENT_TYPES.map((event) => ({ label: event, kind: CompletionItemKind.EnumMember, detail: "user event type" }));
    case "recordType":
      return doc.schema.listRecords().map(recordItem);
    case "member":
      return memberItems(doc, context.dotOffset, context.receiver);
    case "statement":
      return [...statementItems(), ...localItems(doc, offset), ...functionItems(doc), ...builtinItems()];
    case "parameterType":
      return [...primitiveTypeItems(), ...doc.schema.listRecords().map(recordItem)];
    case "returnType":
      return primitiveTypeItems();
    case "expression":
      return [
        ...localItems(doc, offset),
        ...functionItems(doc),
        ...builtinItems(),
        { label: "true", kind: CompletionItemKind.Keyword, detail: "Bool" },
        { label: "false", kind: CompletionItemKind.Keyword, detail: "Bool" },
      ];
    case "lineInitializer": {
      const resolved = resolveNameAt(doc, context.parent, offset);
      if (resolved?.kind !== "local" || !isRecordType(resolved.local.type)) return [];
      const sublist = resolved.local.type.record.sublists.get(context.sublist);
      if (!sublist) return [];
      const owner = `${resolved.local.type.record.name}.${sublist.id}`;
      return [...sublist.fields.values()].map((field) => fieldItem(field, owner));
    }
    case "queryField": {
      const record = doc.schema.getRecordByName(context.record);
      return [
        ...(record ? [...record.fields.values()].map((field) => fieldItem(field)) : []),
        ...localItems(doc, offset),
        { label: "true", kind: CompletionItemKind.Keyword, detail: "Bool" },
        { label: "false", kind: CompletionItemKind.Keyword, detail: "Bool" },
      ];
    }
    case "none":
      return [];
  }
}

function firstRecordName(doc: SemanticDocument): string {
  return doc.schema.listRecords()[0]?.name ?? "Customer";
}

function declarationItems(recordName: string): CompletionItem[] {
  const snippet = (label: string, text: string, detail: string): CompletionItem => ({
    label,
    kind: CompletionItemKind.Keyword,
    detail,
    insertText: text,
    insertTextFormat: InsertTextFormat.Snippet,
  });
  return [
    snippet("beforeSubmit", `beforeSubmit \${1:edit} (\${2:record}: \${3:${recordName}}) {\n\t$0\n}`, "user event entry point"),
    snippet("afterSubmit", `afterSubmit \${1:edit} (\${2:record}: \${3:${recordName}}) {\n\t$0\n}`, "user event entry point"),
    snippet("scheduled", "scheduled {\n\t$0\n}", "scheduled script entry point"),
    snippet("fn", "fn ${1:name}(${2:record}: ${3:" + recordName + "}) {\n\t$0\n}", "function"),
  ];
}

function primitiveTypeItems(): CompletionItem[] {
  return ["Text", "Number", "Bool"].map((label) => ({ label, kind: CompletionItemKind.TypeParameter, detail: "type" }));
}

function functionItems(doc: SemanticDocument): CompletionItem[] {
  return (doc.unit?.functions ?? []).map((fn) => ({ label: fn.name, kind: CompletionItemKind.Function, detail: functionSignature(fn) }));
}

function statementItems(): CompletionItem[] {
  const snippet = (label: string, text: string, detail: string): CompletionItem => ({
    label,
    kind: CompletionItemKind.Keyword,
    detail,
    insertText: text,
    insertTextFormat: InsertTextFormat.Snippet,
  });
  return [
    snippet("let", "let ${1:name} = $0", "declare a local"),
    snippet("if", "if ${1:condition} {\n\t$0\n}", "conditional"),
    snippet("save", "save ${1:record}", "persist an owned record"),
    snippet("delete", "delete ${1:record}", "delete a persisted owned record"),
    snippet("for", "for ${1:row} in ${2:rows} {\n\t$0\n}", "iterate a query result or sublist"),
    snippet("add", "add ${1:record}.${2:sublist} {\n\t$0\n}", "append a sublist line"),
    snippet("remove", "remove ${1:line}", "remove the current sublist line"),
    snippet("return", "return $0", "return from the function"),
  ];
}

function recordItem(record: RecordSchema): CompletionItem {
  return {
    label: record.name,
    kind: CompletionItemKind.Class,
    detail: record.custom ? "custom record" : "record",
    documentation: recordDetail(record),
  };
}

function fieldItem(field: FieldSchema, owner?: string): CompletionItem {
  return {
    label: field.id,
    kind: CompletionItemKind.Field,
    detail: fieldDetail(field),
    documentation: `${field.label}${owner ? ` · ${owner}` : ""}\nNetSuite field \`${field.id}\``,
  };
}

function memberItemsOfType(type: import("../semantic/types.js").MyntType): CompletionItem[] {
  if (isRecordType(type)) return recordMemberItems(type);
  if (isLineType(type)) return [...type.sublist.fields.values()].map((field) => fieldItem(field, sublistName(type)));
  return [];
}

/** A record's fields, plus `id` on a query row, plus its sublists on a loaded or context record. */
function recordMemberItems(type: RecordType): CompletionItem[] {
  const items = [...type.record.fields.values()].map((field) => fieldItem(field));
  if (type.origin === "query") {
    items.unshift({ label: "id", kind: CompletionItemKind.Property, detail: "Text · internal id", documentation: `Internal id of the ${type.record.name}, for 'load ${type.record.name}(row.id)'` });
  } else {
    items.push(...[...type.record.sublists.values()].map((sublist) => sublistItem(type, sublist)));
  }
  return items;
}

function sublistItem(type: RecordType, sublist: SublistSchema): CompletionItem {
  return {
    label: sublist.id,
    kind: CompletionItemKind.Struct,
    detail: "sublist",
    documentation: `${sublist.label} · sublist of ${type.record.name} · iterate with 'for line in x.${sublist.id}'`,
  };
}

function builtinItem(symbol: BuiltinSymbol): CompletionItem {
  return symbol.kind === "namespace"
    ? { label: symbol.namespace.name, kind: CompletionItemKind.Module, detail: `built-in namespace` }
    : { label: symbol.builtin.name, kind: CompletionItemKind.Function, detail: builtinSignature(symbol.builtin) };
}

function builtinItems(): CompletionItem[] {
  return listBuiltinRoots().map(builtinItem);
}

function localItems(doc: SemanticDocument, offset: number): CompletionItem[] {
  return localsInScopeAt(doc, offset).map((local) => ({
    label: local.name,
    kind: CompletionItemKind.Variable,
    detail: describeLocal(local),
  }));
}

/**
 * Members after a `.`: if the bound expression ending at the dot has record
 * type T, the fields of T, whatever the expression is. A namespace (`log.`)
 * is not a value, so it is resolved by name instead. When the receiver did
 * not bind at all (its statement failed before it), a single identifier is
 * resolved by name as a last resort.
 */
function memberItems(doc: SemanticDocument, dotOffset: number, receiver: string[]): CompletionItem[] {
  const expression = expressionEndingAt(doc, dotOffset);
  if (expression) return memberItemsOfType(expression.type);

  if (receiver.length !== 1) return [];
  const resolved = resolveNameAt(doc, receiver[0]!, dotOffset);
  if (resolved?.kind === "local") return memberItemsOfType(resolved.local.type);
  if (resolved?.kind === "namespace") {
    return [...resolved.namespace.members.values()].map((builtin) => ({
      label: builtin.name.slice(resolved.namespace.name.length + 1),
      kind: CompletionItemKind.Method,
      detail: builtinSignature(builtin),
    }));
  }
  return [];
}
