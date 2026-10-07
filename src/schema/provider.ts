import type { FieldSchema, RecordSchema, SchemaDocument, SchemaDocumentField, SublistSchema } from "./types.js";

/**
 * The only schema interface the compiler sees. Where the data comes from
 * (built-in, account snapshot, test fixture) is the caller's concern.
 */
export interface SchemaProvider {
  /** Look up a record type by its Sail name, e.g. `Customer`. */
  getRecordByName(name: string): RecordSchema | undefined;
  /** All known record types, for diagnostics and future completion. */
  listRecords(): readonly RecordSchema[];
}

function toFields(fields: Record<string, SchemaDocumentField>): Map<string, FieldSchema> {
  const out = new Map<string, FieldSchema>();
  for (const [fieldId, field] of Object.entries(fields)) {
    out.set(fieldId, {
      id: fieldId,
      type: field.type,
      label: field.label,
      writable: field.writable,
      custom: field.custom ?? false,
      ...(field.refTarget !== undefined ? { refTarget: field.refTarget } : {}),
      ...(field.required !== undefined ? { required: field.required } : {}),
      ...(field.values !== undefined ? { values: field.values } : {}),
    });
  }
  return out;
}

/** A SchemaProvider backed by an in-memory SchemaDocument. */
export class DocumentSchemaProvider implements SchemaProvider {
  private readonly byName = new Map<string, RecordSchema>();

  constructor(document: SchemaDocument) {
    for (const [recordId, record] of Object.entries(document.records)) {
      const sublists = new Map<string, SublistSchema>();
      for (const [sublistId, sublist] of Object.entries(record.sublists ?? {})) {
        sublists.set(sublistId, { id: sublistId, label: sublist.label, fields: toFields(sublist.fields) });
      }
      this.byName.set(record.name, {
        id: recordId,
        name: record.name,
        suiteScriptType: record.suiteScriptType,
        custom: record.custom ?? false,
        fields: toFields(record.fields),
        sublists,
      });
    }
  }

  getRecordByName(name: string): RecordSchema | undefined {
    return this.byName.get(name);
  }

  listRecords(): readonly RecordSchema[] {
    return [...this.byName.values()];
  }
}
