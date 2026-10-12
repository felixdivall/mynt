import { ERROR_MEMBERS, PRIMITIVE_TYPE_NAMES } from "../semantic/types.js";
import { CompletionItemKind, InsertTextFormat, type CompletionItem } from "vscode-languageserver";
import { USER_EVENT_TYPES } from "../semantic/bound.js";
import { builtinSignature, listBuiltinRoots, type BuiltinSymbol } from "../semantic/builtins.js";
import { QUERY_OPERATIONS } from "../parser/ast.js";
import { boundPathAt, expressionEndingAt, localsInScopeAt, resolveNameAt, type SemanticDocument } from "../semantic/query.js";
import { isLineType, isProjectionType, isRecordType, isReferenceType, isRowOrigin, isRowRecord, isSummaryType, sublistName, summaryField, typeName, type MyntType, type RecordType } from "../semantic/types.js";
import type { BoundExpression, Destructure } from "../semantic/bound.js";
import type { SublistSchema } from "../schema/types.js";
import type { FieldSchema, FieldType, RecordSchema } from "../schema/types.js";
import { completionSite, type CompletionContext } from "./context.js";
import { aggregateDetail, describeLocal, fieldDetail, recordDetail } from "./describe.js";
import { PLATFORM_TYPES } from "../semantic/loadable.js";
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
      // After `load`, the platform types are loadable too: a saved search, a file.
      return [...doc.schema.listRecords().map(recordItem), ...(context.loadable ? platformTypeItems() : [])];
    case "patternField":
      return patternFieldItems(doc, context.patternOffset, context.listed);
    case "member":
      return memberItems(doc, context.dotOffset, context.receiver);
    case "projectionField":
      return projectionFieldItems(doc, context.bracketOffset, context.receiver, context.listed);
    case "savedSearchId":
      return savedSearchItems(doc, offset, context.record);
    case "searchClause":
      // After `first` the search is optional, and `or` (not a clause) resolves it where it is declared.
      return [...(context.used.includes("first") ? orItems() : []), ...clauseItems(context.used), ...statementItems(), ...localItems(doc, offset), ...functionItems(doc), ...builtinItems()];
    case "selectField": {
      if (context.lookup) {
        // `lookup X select |`: the fields of the one record, by type name or through the receiver's type; no aggregates.
        const receiverLocal = (context as { receiverLocal?: string }).receiverLocal;
        const resolved = receiverLocal ? resolveNameAt(doc, receiverLocal, offset) : undefined;
        const type = resolved?.kind === "local" ? resolved.local.type : undefined;
        const record = context.record ? doc.schema.getRecordByName(context.record) : type && (isReferenceType(type) || isRecordType(type)) ? type.record : undefined;
        return record ? [...record.fields.values()].filter((field) => !context.listed.includes(field.id)).map((field) => fieldItem(field, record.name)) : [];
      }
      const record = searchedRecord(doc, context.record, context.savedSearch);
      // Fields first (in a summary, the ones a bucket can carry), then the aggregates, each as a named item.
      return record ? [...[...record.fields.values()].filter((field) => !context.listed.includes(field.id)).map((field) => fieldItem(field)), ...aggregateItems()] : aggregateItems();
    }
    case "aggregate":
      return aggregateItems(context.alias);
    case "aggregateField": {
      const record = searchedRecord(doc, context.record, context.savedSearch);
      const accepts = AGGREGATE_ACCEPTS[context.aggregate] ?? [];
      return record ? [...record.fields.values()].filter((field) => accepts.includes(field.type)).map((field) => fieldItem(field)) : [];
    }
    case "groupField": {
      const record = searchedRecord(doc, context.record, context.savedSearch);
      return record ? [...record.fields.values()].filter((field) => field.type !== "Unknown" && field.selection !== "multiple" && !context.listed.includes(field.id)).map((field) => fieldItem(field)) : [];
    }
    case "sortField": {
      const record = searchedRecord(doc, context.record, context.savedSearch);
      if (context.result) {
        // A summary sorts by what it exposes: its grouped fields and its aggregate names, not the source fields.
        return context.result.map((name) => {
          const field = record?.fields.get(name);
          return field ? { ...fieldItem(field), detail: `${fieldDetail(field)} · grouped` } : { label: name, kind: CompletionItemKind.Property, detail: "aggregate result of this search" };
        });
      }
      return record ? [...record.fields.values()].filter((field) => field.type !== "Unknown" && field.selection !== "multiple").map((field) => fieldItem(field)) : [];
    }
    case "sortDirection":
      return [
        { label: "asc", kind: CompletionItemKind.Keyword, detail: "ascending (the default)" },
        { label: "desc", kind: CompletionItemKind.Keyword, detail: "descending" },
      ];
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
        { label: "true", kind: CompletionItemKind.Keyword, detail: "boolean" },
        { label: "false", kind: CompletionItemKind.Keyword, detail: "boolean" },
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
      const record = searchedRecord(doc, context.record, context.savedSearch);
      return [
        ...(record ? [...record.fields.values()].map((field) => fieldItem(field)) : []),
        ...localItems(doc, offset),
        { label: "true", kind: CompletionItemKind.Keyword, detail: "boolean" },
        { label: "false", kind: CompletionItemKind.Keyword, detail: "boolean" },
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
    snippet("fn", "fn ${1:name}(${2:value}: ${3:string}): ${4:string} {\n\t$0\n}", "function returning a value"),
  ];
}

function primitiveTypeItems(): CompletionItem[] {
  // Builtin types complete as keywords, record types as classes, so an editor
  // lists language primitives and schema records with different icons.
  return PRIMITIVE_TYPE_NAMES.map((label) => ({ label, kind: CompletionItemKind.Keyword, detail: "builtin type" }));
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
    snippet("try", "try {\n\t$1\n} catch ${2:err} {\n\t$0\n}", "recover from a thrown runtime error"),
  ];
}

function recordItem(record: RecordSchema): CompletionItem {
  return {
    label: record.name,
    kind: CompletionItemKind.Struct,
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

function memberItemsOfType(type: MyntType): CompletionItem[] {
  if (isRecordType(type)) return recordMemberItems(type);
  // A summary row has exactly its result fields: grouped fields (a joined one under its relationship) and aggregate names; no `id`.
  if (isSummaryType(type)) {
    const items: CompletionItem[] = [];
    const seen = new Set<string>();
    for (const result of type.fields) {
      const name = result.summary === "group" ? (result.join ? result.join.via.id : result.field!.id) : result.name;
      if (seen.has(name)) continue;
      seen.add(name);
      if (result.summary === "group") {
        const field = result.join ? type.record.fields.get(result.join.via.id)! : result.field!;
        items.push({ ...fieldItem(field, type.record.name), detail: `${fieldDetail(field)} · grouped` });
      } else {
        items.push({ label: name, kind: CompletionItemKind.Property, detail: `${typeName(result.type)} · ${aggregateDetail(result)}`, documentation: "Aggregate result of the summary search; read-only" });
      }
    }
    return items;
  }
  if (isLineType(type)) return [...type.sublist.fields.values()].map((field) => fieldItem(field, sublistName(type)));
  // A reference has its id, and display text only when the value carries it; its fields are reached with `[...]`.
  if (isReferenceType(type)) {
    const items: CompletionItem[] = [
      { label: "id", kind: CompletionItemKind.Property, detail: "string · internal id", documentation: `Internal id of the referenced ${type.record.name}; read fields with 'ref[email, ...]' or load it with 'load ${type.record.name}(ref.id)'` },
    ];
    if (type.text) items.push({ label: "text", kind: CompletionItemKind.Property, detail: "string · display text", documentation: `Display text of the referenced ${type.record.name}, as the backend supplied it with the id` });
    return items;
  }
  // A projection has exactly the fields it was made with.
  if (isProjectionType(type)) return type.fields.map((projected) => fieldItem(projected.field, type.record.name));
  if (type === "Error") {
    return ERROR_MEMBERS.map((member) => ({
      label: member,
      kind: CompletionItemKind.Property,
      detail: `string · Error.${member}`,
      documentation: member === "name" ? "The error's code, such as RCRD_DSNT_EXIST or SSS_INVALID_SRCH_FILTER" : "The error's description",
    }));
  }
  return [];
}

/** A record's fields, plus `id` on a query or search row, plus its sublists on a loaded or context record. */
function recordMemberItems(type: RecordType): CompletionItem[] {
  const items = [...type.record.fields.values()].map((field) => fieldItem(field));
  if (isRowOrigin(type.origin)) {
    items.unshift({ label: "id", kind: CompletionItemKind.Property, detail: "string · internal id", documentation: `Internal id of the ${type.record.name}, for 'load ${type.record.name}(row.id)'` });
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

/**
 * After `search saved [T]`: the saved searches the account snapshot knows,
 * by script id, those over T when a type was written, plus string locals.
 * Nothing is asked of NetSuite; a snapshot without saved searches offers
 * only the locals.
 */
function savedSearchItems(doc: SemanticDocument, offset: number, record: string | undefined): CompletionItem[] {
  const known = doc.schema
    .listSavedSearches()
    .filter((saved) => record === undefined || saved.record === record)
    .map((saved) => ({
      label: saved.id,
      kind: CompletionItemKind.Value,
      detail: `${saved.record} saved search${saved.searchType ? ` · standalone ${saved.searchType}` : ""}`,
      documentation: `Saved search \`${saved.id}\` returning ${saved.record} rows, from the account snapshot`,
    }));
  return [...known, ...localItems(doc, offset).filter((item) => item.detail === "string")];
}

/** `Search`, `File`: the platform types `load` accepts beside record types. */
function platformTypeItems(): CompletionItem[] {
  return [...PLATFORM_TYPES.values()].map((platform) => ({
    label: platform.name,
    kind: CompletionItemKind.Class,
    detail: `platform type · ${platform.example}`,
    documentation: platform.summary,
  }));
}

/**
 * Fields inside `let { ... } = value`: the value is after the cursor, so it
 * is found through the bound declaration containing the `{` (its source's
 * projection type), or, while the declaration does not bind, by resolving
 * a single name after `=` as a local. Fields already listed are left out.
 */
function patternFieldItems(doc: SemanticDocument, patternOffset: number, listed: string[]): CompletionItem[] {
  let type: MyntType | undefined;
  for (const node of boundPathAt(doc, patternOffset)) {
    if (node.kind === "Destructure") type = (node as unknown as Destructure).source.type;
  }
  if (!type) {
    const rest = doc.text.slice(patternOffset);
    const match = /^\{[^}=\n]*\}\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\n|$)/.exec(rest);
    const resolved = match ? resolveNameAt(doc, match[1]!, patternOffset) : undefined;
    if (resolved?.kind === "local") type = resolved.local.type;
  }
  if (!type || !isProjectionType(type)) return [];
  const record = type.record;
  return type.fields.filter((f) => !listed.includes(f.field.id)).map((f) => fieldItem(f.field, record.name));
}

/** The record a search is over: by its written name, or through the snapshot for a saved search without one. */
function searchedRecord(doc: SemanticDocument, record: string | undefined, savedSearch: string | undefined): RecordSchema | undefined {
  const name = record ?? (savedSearch !== undefined ? doc.schema.getSavedSearch(savedSearch)?.record : undefined);
  return name !== undefined ? doc.schema.getRecordByName(name) : undefined;
}

/** `or return` / `or { ... }`: resolving the optional a `first` search produced. */
function orItems(): CompletionItem[] {
  return [
    { label: "or return", kind: CompletionItemKind.Keyword, detail: "resolve the optional: return when there is no row", insertText: "or return", insertTextFormat: InsertTextFormat.Snippet },
    { label: "or {", kind: CompletionItemKind.Keyword, detail: "resolve the optional: a block that ends with return", insertText: "or {\n\t$0\n\treturn\n}", insertTextFormat: InsertTextFormat.Snippet },
  ];
}

/** What each aggregate accepts, mirrored from the binder's table. */
const AGGREGATE_ACCEPTS: Record<string, readonly FieldType[]> = {
  sum: ["Number"],
  avg: ["Number"],
  min: ["Number", "Date", "Text"],
  max: ["Number", "Date", "Text"],
  count: ["Text", "Number", "Bool", "Date", "Ref", "Unknown"],
};

/** `sum`, `count`, ...: a `select` item, written as a named aggregate; with `alias` set, the name is already written. */
function aggregateItems(alias?: string): CompletionItem[] {
  const all: [string, string, string][] = [
    ["sum", "sum(${1:field})", "the sum of a number field per group: number"],
    ["count", "count()", "how many rows per group: number"],
    ["min", "min(${1:field})", "the smallest number, date, or string per group"],
    ["max", "max(${1:field})", "the largest number, date, or string per group"],
    ["avg", "avg(${1:field})", "the average of a number field per group: number"],
  ];
  return all.map(([name, text, detail]) => ({
    label: alias ? name : `${name}(...)`,
    kind: CompletionItemKind.Function,
    detail,
    insertText: alias ? text : `\${1:${name === "count" ? "count" : "total"}} = ${text.replace("${1:", "${2:")}`,
    insertTextFormat: InsertTextFormat.Snippet,
    documentation: `An aggregate; named in select ('${alias ?? "total"} = ${name}(...)') and read as that name on each summary row`,
  }));
}

/** The search clauses not yet written for the search above the cursor: each may appear once. */
function clauseItems(used: string[]): CompletionItem[] {
  const all: [string, string, string][] = [
    ["where", "where ${1:condition}", "filter the rows"],
    ["select", "select ${1:field}", "the fields the rows expose, and named aggregates"],
    ["order by", "order by ${1:field}", "sort keys, each asc or desc"],
    ["group by", "group by ${1:field}", "the summary buckets; the rows become one per group"],
    ["limit", "limit ${1:100}", "at most this many rows, still a sequence"],
    ["first", "first", "the first row, or none: one optional row"],
  ];
  // `first` and `limit` exclude each other, so either rules out both.
  const cardinality = used.includes("first") || used.includes("limit");
  return all
    .filter(([label]) => !used.includes(label.split(" ")[0]!) && !(cardinality && (label === "first" || label === "limit")))
    .map(([label, text, detail]) => ({ label, kind: CompletionItemKind.Keyword, detail, insertText: text, insertTextFormat: InsertTextFormat.Snippet }));
}

/** `query`, `search`, and `lookup` are operations of the language, not registry built-ins; they complete beside `load` and the rest. */
function queryOperationItems(): CompletionItem[] {
  return [
    ...QUERY_OPERATIONS.map((operation) => ({
      label: operation,
      kind: CompletionItemKind.Function,
      detail: `${operation} T where ...: Sequence<T>`,
      documentation: `Rows of T from ${operation === "query" ? "N/query" : "N/search"}, read-only; the backend is the one you name`,
    })),
    {
      label: "lookup",
      kind: CompletionItemKind.Function,
      detail: "lookup T(id) select fields: the selected fields",
      documentation: "Reads selected fields of one record: one N/search.lookupFields call for a reference, a local read for a loaded record. The same operation as T(id)[fields]",
    },
  ];
}

function builtinItems(): CompletionItem[] {
  return [...queryOperationItems(), ...listBuiltinRoots().map(builtinItem)];
}

function localItems(doc: SemanticDocument, offset: number): CompletionItem[] {
  return localsInScopeAt(doc, offset).map((local) => ({
    label: local.name,
    kind: CompletionItemKind.Variable,
    detail: describeLocal(local),
  }));
}

/**
 * The fields reachable through a relationship, offered only where the
 * search plans them as a join: a reference field of a search row, or a
 * bare reference field in a search condition. A bare `Ref<T>` anywhere
 * else keeps its `id`/`text` members only, since following it would mean
 * a lookup the author must write.
 */
function joinedMemberItems(expression: BoundExpression): CompletionItem[] {
  if (!isReferenceType(expression.type)) return [];
  const viaRow = expression.kind === "FieldRead" && ((isRowRecord(expression.receiver.type) && expression.receiver.type.origin === "search") || isSummaryType(expression.receiver.type));
  const viaCondition = expression.kind === "QueryField" && expression.type.text;
  if (!viaRow && !viaCondition) return [];
  const via = expression.kind === "FieldRead" || expression.kind === "QueryField" ? expression.field.id : "";
  const target = expression.type.record;
  // On a summary row only the grouped joined fields exist.
  if (expression.kind === "FieldRead" && isSummaryType(expression.receiver.type)) {
    const summary = expression.receiver.type;
    return summary.fields.filter((f) => f.summary === "group" && f.join?.via.id === via).map((f) => ({ ...fieldItem(f.field!, `${target.name} via ${via}`), detail: `${fieldDetail(f.field!)} · grouped, joined` }));
  }
  return [...target.fields.values()].map((field) => ({ ...fieldItem(field, `${target.name} via ${via}`), detail: `${fieldDetail(field)} · joined` }));
}

/**
 * Fields inside `receiver[...]`: the record's fields, from the bound
 * receiver (a reference, a record, or a row) or, when the receiver did not
 * bind, from a single name resolved as a local. Fields already listed in
 * the brackets are left out, since a projection names each field once.
 */
function projectionFieldItems(doc: SemanticDocument, bracketOffset: number, receiver: string[], listed: string[]): CompletionItem[] {
  let type: MyntType | undefined = expressionEndingAt(doc, bracketOffset)?.type;
  if (!type && receiver.length === 1) {
    const resolved = resolveNameAt(doc, receiver[0]!, bracketOffset);
    if (resolved?.kind === "local") type = resolved.local.type;
  }
  if (!type) return [];
  const record = isReferenceType(type) || isRecordType(type) ? type.record : undefined;
  if (!record) return [];
  return [...record.fields.values()].filter((field) => !listed.includes(field.id)).map((field) => fieldItem(field, record.name));
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
  // On a summary row, a relationship whose own reference was not grouped has only its grouped joined fields: no id or text.
  const relationshipOnly = expression?.kind === "FieldRead" && isSummaryType(expression.receiver.type) && !summaryField(expression.receiver.type, expression.field.id);
  if (expression) return [...(relationshipOnly ? [] : memberItemsOfType(expression.type)), ...joinedMemberItems(expression)];

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
