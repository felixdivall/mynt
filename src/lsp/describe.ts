/** Shared wording for hover and completion, so both describe a thing the same way. */
import type { FieldSchema, RecordSchema } from "../schema/types.js";
import type { LocalSymbol } from "../semantic/bound.js";
import { isLineType, isRecordType, sublistName, typeName } from "../semantic/types.js";

export function recordDetail(record: RecordSchema): string {
  const constant = record.suiteScriptType ? ` · \`record.Type.${record.suiteScriptType}\`` : "";
  return `NetSuite record \`${record.id}\`${constant}`;
}

export function fieldDetail(field: FieldSchema): string {
  return [field.type, field.writable ? "writable" : "read-only", field.custom ? "custom" : ""].filter(Boolean).join(" · ");
}

export function describeLocal(local: LocalSymbol): string {
  if (isLineType(local.type)) return `line of ${sublistName(local.type)} (persisted with the parent ${local.type.parent.record.name})`;
  if (!isRecordType(local.type)) return typeName(local.type);
  const how = {
    context: "context record, saved by NetSuite",
    owned: "owned record, persists only through save",
    query: "query result, read-only",
    parameter: "record parameter; what this function does to it is checked at each call",
  }[local.type.origin];
  return `${local.type.record.name} (${how})`;
}

export function code(text: string): string {
  return "```mynt\n" + text + "\n```";
}
