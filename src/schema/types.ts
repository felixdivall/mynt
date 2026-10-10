/**
 * Schema model: what the compiler knows about NetSuite record types.
 *
 * This is deliberately the same shape `mynt schema pull` writes to disk, so
 * the built-in snapshot, a committed account snapshot, and a test fixture
 * are all just instances of SchemaDocument. The compiler never sees where a
 * document came from.
 */

/**
 * Mynt's value types for fields.
 *
 *   Text, Number, Bool   fully typed: readable, assignable, comparable per
 *                        the language rules.
 *   Date                 a date/time value. Readable, but no Mynt operation
 *                        accepts one yet, so such a field is inert until the
 *                        language grows a Date type.
 *   Ref                  a reference to another record (a select field).
 *                        `refTarget` names the target record type when the
 *                        metadata does and `selection` says whether the
 *                        field holds one reference or several. With a known
 *                        target the value is a typed reference (`Ref<T>`);
 *                        without one it is inert: readable, accepted nowhere.
 *   Unknown              the metadata did not say enough to type the field.
 *                        Inert: it can be read, but nothing accepts it.
 *
 * The inert types are deliberately not Text: a wrong strong type would let
 * incorrect scripts compile, while a truthful inert type only limits them.
 */
export type FieldType = "Text" | "Number" | "Bool" | "Date" | "Ref" | "Unknown";

export const FIELD_TYPES: readonly FieldType[] = ["Text", "Number", "Bool", "Date", "Ref", "Unknown"];

/** How many references a Ref field holds: one (a select) or several (a multiselect). */
export type FieldSelection = "single" | "multiple";

export interface FieldSchema {
  /** NetSuite field script id, e.g. `comments` or `custentity_tier`. */
  id: string;
  type: FieldType;
  label: string;
  /** Whether scripts may set this field. */
  writable: boolean;
  /** True for account-specific custom fields. */
  custom: boolean;
  /** For Ref fields: the Mynt name of the target record type, when known. */
  refTarget?: string;
  /**
   * For Ref fields: whether the field holds one reference (a select) or
   * several (a multiselect). Absent means the metadata did not say, which
   * is treated as a single reference where a target is known. Live
   * extraction currently establishes only `single` (see normalize.ts);
   * `multiple` exists for snapshots and fixtures that state it.
   */
  selection?: FieldSelection;
  /**
   * For Ref fields: the N/search join id for this relationship, when it is
   * not the field id. NetSuite's metadata does not state join ids, so this
   * is never produced by `schema pull`; a snapshot may add it by hand where
   * an account proves the default wrong. Absent means the field id.
   */
  searchJoin?: string;
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
  /** Mynt-facing name, e.g. `Customer` or `SalesOrder`. */
  name: string;
  /**
   * The `record.Type` constant name in SuiteScript, e.g. `SALES_ORDER`.
   * This is platform metadata, not account metadata: known standard records
   * have one, custom records (and standard records Mynt has no entry for)
   * do not and are addressed by their id string instead.
   */
  suiteScriptType: string | undefined;
  /**
   * The N/search search type family, when it differs from the record id:
   * every transaction record is searched as `transaction`. Platform
   * metadata like `suiteScriptType`, from the same table; absent for
   * records searched by their own id.
   */
  searchFamily: string | undefined;
  /** True for custom records (`customrecord_*`, `customtransaction_*`, ...). */
  custom: boolean;
  fields: ReadonlyMap<string, FieldSchema>;
  sublists: ReadonlyMap<string, SublistSchema>;
}

/**
 * A saved search the account knows: what `search saved "customsearch_x"`
 * infers its result type from, offline. Account metadata, beside the
 * records, never built-in: NetSuite owns the search, Mynt only repeats
 * what it has been told. `searchType` is set only for a standalone search
 * type, which `search.load` needs to be given explicitly; ordinary saved
 * searches are loaded by id alone.
 */
export interface SavedSearchSchema {
  /** The script id, e.g. `customsearch_active_customers`. */
  id: string;
  /** The Mynt name of the record type the search returns rows of. */
  record: string;
  /** The N/search type `search.load` must be passed, for a standalone search type only. */
  searchType?: string;
}

/** On-disk JSON shape. Keys of `records` are NetSuite record type ids. */
export interface SchemaDocument {
  myntSchemaVersion: 1;
  source: SchemaSource;
  records: Record<string, SchemaDocumentRecord>;
  /**
   * Saved searches by script id. Optional and additive: a snapshot without
   * it is a version-1 snapshot that knows no saved searches. `schema pull`
   * does not fill it yet (NetSuite's REST metadata catalog has no saved
   * searches); a snapshot may state them, and a later discovery step may
   * write them, without any change to the compiler.
   */
  savedSearches?: Record<string, SchemaDocumentSavedSearch>;
}

export interface SchemaDocumentSavedSearch {
  /** Mynt record name of the result rows. */
  record: string;
  /** The N/search type to pass to `search.load`, for a standalone search type only. */
  searchType?: string;
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
  /** N/search family (`transaction`), for records whose searches report it. Platform metadata, like `suiteScriptType`. */
  searchFamily?: string;
  custom?: boolean;
  fields: Record<string, SchemaDocumentField>;
  /** Keys are NetSuite sublist ids. */
  sublists?: Record<string, SchemaDocumentSublist>;
  /** Provenance in NetSuite's own terms. Written by `mynt schema pull`, ignored by the compiler. */
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
  selection?: FieldSelection;
  searchJoin?: string;
  required?: boolean;
  values?: string[];
  /** Provenance in NetSuite's own terms. Written by `mynt schema pull`, ignored by the compiler. */
  netsuite?: {
    /** The REST property name, e.g. `companyName`; Mynt's field id is the SuiteScript id. */
    restName: string;
    /** The JSON Schema type the REST metadata reported. */
    restType: string;
    format?: string;
  };
}
