/**
 * Raw metadata retrieval from the SuiteTalk REST metadata catalog. This
 * module fetches and returns NetSuite's own JSON Schema documents; it does
 * not interpret them. Normalization is in ../schema/normalize.ts.
 *
 *   GET /record/v1/metadata-catalog                  record type list
 *   GET /record/v1/metadata-catalog/{type}           JSON Schema for one type
 *       Accept: application/schema+json
 */
import { NetSuiteHttpError, type RestClient } from "./rest.js";

export interface RawRecordTypeList {
  items?: { name?: string }[];
}

/** One JSON Schema property as NetSuite writes it. Unknown keys are kept. */
export interface RawProperty {
  title?: string;
  type?: string | string[];
  format?: string;
  nullable?: boolean;
  readOnly?: boolean;
  enum?: string[];
  properties?: Record<string, RawProperty>;
  items?: RawProperty;
  $ref?: string;
  "x-ns-custom-field"?: string;
  [key: string]: unknown;
}

export interface RawRecordSchema {
  title?: string;
  type?: string;
  properties?: Record<string, RawProperty>;
  required?: string[];
  [key: string]: unknown;
}

/** Everything a pull fetched, keyed by REST record type name. */
export interface RawMetadata {
  records: Record<string, RawRecordSchema>;
  /**
   * Types the catalog listed but whose schema could not be fetched, with the
   * reason. A role without access to a type, or a type the catalog lists
   * but does not serve, must not abort a pull of everything else; only an
   * authentication failure does.
   */
  failures?: Record<string, string>;
}

export async function listRecordTypes(client: RestClient): Promise<string[]> {
  const list = await client.getJson<RawRecordTypeList>("/record/v1/metadata-catalog", "the record type list");
  const names = (list.items ?? []).map((item) => item.name).filter((name): name is string => typeof name === "string");
  return [...new Set(names)].sort();
}

export function getRecordSchema(client: RestClient, type: string): Promise<RawRecordSchema> {
  return client.getJson<RawRecordSchema>(
    `/record/v1/metadata-catalog/${encodeURIComponent(type)}`,
    `${type} metadata`,
    "application/schema+json",
  );
}

export interface PullOptions {
  /** REST type names to pull; all listed types when omitted. */
  records?: string[];
  concurrency?: number;
  onProgress?: (done: number, total: number, type: string) => void;
}

export async function pullRawMetadata(client: RestClient, options: PullOptions = {}): Promise<RawMetadata> {
  const types = options.records ? [...options.records].sort() : await listRecordTypes(client);
  const records: Record<string, RawRecordSchema> = {};
  const failures: Record<string, string> = {};
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    while (next < types.length) {
      const type = types[next++]!;
      try {
        records[type] = await getRecordSchema(client, type);
      } catch (error) {
        if (!(error instanceof NetSuiteHttpError) || error.status === 401) throw error;
        failures[type] = error.message;
      }
      done++;
      options.onProgress?.(done, types.length, type);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 3) }, worker));

  const sortedRecords = Object.fromEntries(Object.keys(records).sort().map((k) => [k, records[k]!]));
  const sortedFailures = Object.fromEntries(Object.keys(failures).sort().map((k) => [k, failures[k]!]));
  return Object.keys(sortedFailures).length > 0 ? { records: sortedRecords, failures: sortedFailures } : { records: sortedRecords };
}
