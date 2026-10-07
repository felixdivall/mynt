import type { SchemaDocument } from "../../schema/types.js";

export type SchemaChange =
  | { kind: "record-added" | "record-removed"; record: string }
  | { kind: "field-added" | "field-removed"; record: string; field: string }
  | { kind: "field-type-changed" | "field-writability-changed"; record: string; field: string; from: string; to: string };

/** Structural changes from `before` to `after`, in record then field order. Labels and provenance are ignored. */
export function diffSchemas(before: SchemaDocument, after: SchemaDocument): SchemaChange[] {
  const changes: SchemaChange[] = [];
  const recordIds = [...new Set([...Object.keys(before.records), ...Object.keys(after.records)])].sort();

  for (const record of recordIds) {
    const a = before.records[record];
    const b = after.records[record];
    if (!a) {
      changes.push({ kind: "record-added", record });
      continue;
    }
    if (!b) {
      changes.push({ kind: "record-removed", record });
      continue;
    }
    const fieldIds = [...new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])].sort();
    for (const field of fieldIds) {
      const fa = a.fields[field];
      const fb = b.fields[field];
      if (!fa) {
        changes.push({ kind: "field-added", record, field });
      } else if (!fb) {
        changes.push({ kind: "field-removed", record, field });
      } else {
        if (fa.type !== fb.type) changes.push({ kind: "field-type-changed", record, field, from: fa.type, to: fb.type });
        if (fa.writable !== fb.writable) {
          changes.push({ kind: "field-writability-changed", record, field, from: String(fa.writable), to: String(fb.writable) });
        }
      }
    }
  }
  return changes;
}

export function formatChange(change: SchemaChange): string {
  switch (change.kind) {
    case "record-added":
      return `+ record ${change.record}`;
    case "record-removed":
      return `- record ${change.record}`;
    case "field-added":
      return `+ ${change.record}.${change.field}`;
    case "field-removed":
      return `- ${change.record}.${change.field}`;
    case "field-type-changed":
      return `~ ${change.record}.${change.field}: type ${change.from} -> ${change.to}`;
    case "field-writability-changed":
      return `~ ${change.record}.${change.field}: writable ${change.from} -> ${change.to}`;
  }
}
