/** Shared wording for hover and completion, so both describe a thing the same way. */
import type { FieldSchema, RecordSchema } from "../schema/types.js";
import type { LocalSymbol } from "../semantic/bound.js";
import { isLineType, isProjectionType, isRecordType, isReferenceType, sublistName, typeName } from "../semantic/types.js";

export function recordDetail(record: RecordSchema): string {
  const constant = record.suiteScriptType ? ` · \`record.Type.${record.suiteScriptType}\`` : "";
  return `NetSuite record \`${record.id}\`${constant}`;
}

export function fieldDetail(field: FieldSchema): string {
  return [typeName(field.type), field.writable ? "writable" : "read-only", field.custom ? "custom" : ""].filter(Boolean).join(" · ");
}

export function describeLocal(local: LocalSymbol): string {
  if (isLineType(local.type)) return `line of ${sublistName(local.type)} (persisted with the parent ${local.type.parent.record.name})`;
  if (isReferenceType(local.type)) return `reference to a ${local.type.record.name} by internal id; nothing is loaded. Read fields with \`[email, ...]\` (one \`N/search.lookupFields\` call) or load it with \`load ${local.type.record.name}(${local.name}.id)\``;
  if (isProjectionType(local.type)) return `read-only projection of ${local.type.record.name}: ${local.type.fields.map((f) => `${f.id}: ${typeName(f.type)}`).join(", ")}`;
  if (!isRecordType(local.type)) {
    if (typeof local.type === "object" && local.type.kind === "Sequence") {
      return `${typeName(local.type)} (${local.type.source === "query" ? "N/query" : "N/search"} result, read-only rows)`;
    }
    return typeName(local.type);
  }
  const how = {
    context: "context record, saved by NetSuite",
    owned: "owned record, persists only through save",
    query: "query result, read-only",
    search: "search result, read-only",
    parameter: "record parameter; what this function does to it is checked at each call",
  }[local.type.origin];
  return `${local.type.record.name} (${how})`;
}

export function code(text: string): string {
  return "```mynt\n" + text + "\n```";
}
