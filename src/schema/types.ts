/**
 * Schema model: what the compiler knows about NetSuite record types.
 *
 * This is deliberately the same shape `sail schema pull` writes to disk, so
 * the built-in snapshot, a committed account snapshot, and a test fixture
 * are all just instances of SchemaDocument. The compiler never sees where a
 * document came from.
 */

/**
 * Sail's value types for fields.
 *
 *   Text, Number, Bool   fully typed: readable, assignable, comparable per
 *                        the language rules.
 *   Date                 a date/time value. Readable, but no Sail operation
 *                        accepts one yet, so such a field is inert until the
 *                        language grows a Date type.
 *   Ref                  a reference to another record (a select field).
 *                        Readable and inert for now; `refTarget` names the
 *                        target when the metadata does.
 *   Unknown              the metadata did not say enough to type the field.
 *                        Inert: it can be read, but nothing accepts it.
 *
 * The inert types are deliberately not Text: a wrong strong type would let
 * incorrect scripts compile, while a truthful inert type only limits them.
 */
export type FieldType = "Text" | "Number" | "Bool" | "Date" | "Ref" | "Unknown";

export const FIELD_TYPES: readonly FieldType[] = ["Text", "Number", "Bool", "Date", "Ref", "Unknown"];

export interface FieldSchema {
  /** NetSuite field script id, e.g. `comments` or `custentity_tier`. */
  id: string;
  type: FieldType;
  label: string;
  /** Whether scripts may set this field. */
  writable: boolean;
  /** True for account-specific custom fields. */
  custom: boolean;
  /** For Ref fields: the Sail name of the target record type, when known. */
  refTarget?: string;
  /** True when the metadata marks the field required. Absent means the metadata did not say. */
  required?: boolean;
  /** Fixed list of values the metadata reports for a Text select field. */
  values?: readonly string[];
}

/**
 * A sublist of a record: `item` on a sales order. Its lines are typed child
 * structures of the record, persisted with it; they are never records. Each
 * sublist field is its own FieldSchema object, so identity is record,
 * sublist, and field, never spelling.
 *
 * Sublists are represented here and in the fixture, but live extraction of
 * NetSuite sublist metadata is not yet validated against an account.
 */
export interface SublistSchema {
  /** NetSuite sublist id, e.g. `item`. */
  id: string;
  label: string;
  fields: ReadonlyMap<string, FieldSchema>;
}

export interface RecordSchema {
  /** NetSuite record type id, e.g. `customer` or `salesorder`. */
  id: string;
  /** Sail-facing name, e.g. `Customer` or `SalesOrder`. */
  name: string;
  /**
   * The `record.Type` constant name in SuiteScript, e.g. `SALES_ORDER`.
   * This is platform metadata, not account metadata: known standard records
   * have one, custom records (and standard records Sail has no entry for)
   * do not and are addressed by their id string instead.
   */
  suiteScriptType: string | undefined;
  /** True for custom records (`customrecord_*`, `customtransaction_*`, ...). */
  custom: boolean;
  fields: ReadonlyMap<string, FieldSchema>;
  sublists: ReadonlyMap<string, SublistSchema>;
}

/** On-disk JSON shape. Keys of `records` are NetSuite record type ids. */
export interface SchemaDocument {
  sailSchemaVersion: 1;
  source: SchemaSource;
  records: Record<string, SchemaDocumentRecord>;
}

export type SchemaSource =
  | { kind: "builtin" }
  | {
      kind: "account";
      platform: "netsuite";
      /** The NetSuite account id, e.g. `1234567_SB1`. Not a credential. */
      account: string;
      /** ISO 8601 timestamp of the pull that produced the records. */
      pulledAt: string;
    };

export interface SchemaDocumentRecord {
  name: string;
  /** `record.Type` constant name. Present for known standard records only. */
  suiteScriptType?: string;
  custom?: boolean;
  fields: Record<string, SchemaDocumentField>;
  /** Keys are NetSuite sublist ids. */
  sublists?: Record<string, SchemaDocumentSublist>;
  /** Provenance in NetSuite's own terms. Written by `sail schema pull`, ignored by the compiler. */
  netsuite?: {
    /** The REST record type name, e.g. `salesOrder`. */
    restType: string;
    /** REST properties left out of `fields`, with the reason. */
    omitted?: Record<string, string>;
  };
}

export interface SchemaDocumentSublist {
  label: string;
  fields: Record<string, SchemaDocumentField>;
}

export interface SchemaDocumentField {
  type: FieldType;
  label: string;
  writable: boolean;
  custom?: boolean;
  refTarget?: string;
  required?: boolean;
  values?: string[];
  /** Provenance in NetSuite's own terms. Written by `sail schema pull`, ignored by the compiler. */
  netsuite?: {
    /** The REST property name, e.g. `companyName`; Sail's field id is the SuiteScript id. */
    restName: string;
    /** The JSON Schema type the REST metadata reported. */
    restType: string;
    format?: string;
  };
}
