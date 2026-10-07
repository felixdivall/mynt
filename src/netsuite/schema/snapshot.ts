/**
 * Snapshot files: deterministic JSON with every object's keys sorted, so a
 * pull that changes nothing produces no diff. `writeSnapshot` leaves the
 * file untouched (including its `pulledAt`) when the records are identical.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { UserError } from "../../errors.js";
import type { SchemaDocument } from "../../schema/types.js";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner !== undefined) out[key] = sortKeys(inner);
    }
    return out;
  }
  return value;
}

export function serializeSnapshot(document: SchemaDocument): string {
  return JSON.stringify(sortKeys(document), null, 2) + "\n";
}

export function readSnapshot(path: string): SchemaDocument {
  if (!existsSync(path)) throw new UserError(`No schema snapshot at ${path}.\nRun \`mynt schema pull\`.`);
  let parsed: Partial<SchemaDocument>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SchemaDocument>;
  } catch (error) {
    throw new UserError(`${path} is not valid JSON.`, String(error));
  }
  if (parsed.myntSchemaVersion !== 1 || typeof parsed.records !== "object" || !parsed.records) {
    throw new UserError(`${path} is not a Mynt schema snapshot (expected "myntSchemaVersion": 1).`);
  }
  return parsed as SchemaDocument;
}

export function recordsEqual(a: SchemaDocument, b: SchemaDocument): boolean {
  return JSON.stringify(sortKeys(a.records)) === JSON.stringify(sortKeys(b.records));
}

export function writeSnapshot(path: string, document: SchemaDocument): "written" | "unchanged" {
  if (existsSync(path)) {
    const existing = readSnapshot(path);
    const sameAccount =
      existing.source.kind === "account" && document.source.kind === "account" && existing.source.account === document.source.account;
    if (sameAccount && recordsEqual(existing, document)) return "unchanged";
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeSnapshot(document));
  return "written";
}
