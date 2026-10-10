/** Shared wording for hover and completion, so both describe a thing the same way. */
import type { FieldSchema, RecordSchema } from "../schema/types.js";
import type { LocalSymbol } from "../semantic/bound.js";
import { isLineType, isProjectionType, isRecordType, isReferenceType, sublistName, typeName, isSummaryType, type ResultField, type SummaryType } from "../semantic/types.js";

export function recordDetail(record: RecordSchema): string {
  const constant = record.suiteScriptType ? ` · \`record.Type.${record.suiteScriptType}\`` : "";
  return `NetSuite record \`${record.id}\`${constant}`;
}

export function fieldDetail(field: FieldSchema): string {
  const type =
    field.type === "Ref"
      ? field.selection === "multiple"
        ? `multiselect of ${field.refTarget ?? "an unknown record type"}`
        : `reference to ${field.refTarget ?? "an unknown record type"}`
      : typeName(field.type);
  return [type, field.writable ? "writable" : "read-only", field.custom ? "custom" : ""].filter(Boolean).join(" · ");
}

/** `entity: Ref<Customer>, total: number (sum of amount)`: what a summary row exposes, one entry per result field. */
export function summaryDetail(type: SummaryType): string {
  return type.fields.map((f) => `${f.join ? `${f.join.via.id}.` : ""}${f.name}: ${typeName(f.type)}${f.summary === "group" ? "" : ` (${aggregateDetail(f)})`}`).join(", ");
}

/** `sum of SalesOrder.amount`, `count of rows`. */
export function aggregateDetail(field: ResultField): string {
  if (field.summary === "group") return "grouped";
  if (!field.field) return "count of rows";
  return `${field.summary === "avg" ? "average" : field.summary} of ${field.join ? `${field.join.target.name}.${field.field.id} (through ${field.join.via.id})` : field.field.id}`;
}

/** `Customer reference · id: string` or, for a value carrying display text, `· text: string` as well. */
export function referenceDetail(record: RecordSchema, text: boolean): string {
  return `${record.name} reference · id: string${text ? " · text: string" : ""}`;
}

export function describeLocal(local: LocalSymbol): string {
  if (local.type === "Error") return "a thrown runtime error, caught here; `name` and `message` are strings, and it can be logged as it is";
  if (isLineType(local.type)) return `line of ${sublistName(local.type)} (persisted with the parent ${local.type.parent.record.name})`;
  if (isReferenceType(local.type)) {
    return `${referenceDetail(local.type.record, local.type.text)} · nothing is loaded; read fields with \`[${[...local.type.record.fields.keys()][0] ?? "email"}, ...]\` (one \`N/search.lookupFields\` call) or load it with \`load ${local.type.record.name}(${local.name}.id)\``;
  }
  if (isProjectionType(local.type)) return `read-only projection of ${local.type.record.name}: ${local.type.fields.map((f) => `${f.field.id}: ${typeName(f.type)}`).join(", ")}`;
  if (isSummaryType(local.type)) return `summary row of ${local.type.record.name}, read-only: ${summaryDetail(local.type)}`;
  if (!isRecordType(local.type)) {
    if (typeof local.type === "object" && local.type.kind === "Optional") {
      return `${typeName(local.type)} (the first ${local.type.element.kind === "Summary" ? "summary" : local.type.element.record.name} row of a search, or none; resolve it with 'or return' where it is declared, or test it with 'if')`;
    }
    if (typeof local.type === "object" && local.type.kind === "Sequence") {
      if (local.type.source === "lookup") return `${typeName(local.type)} (multiselect field, read-only references with id and text)`;
      if (local.type.element.kind === "Summary") return `${typeName(local.type)} (N/search summary rows, read-only: ${summaryDetail(local.type.element)})`;
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
