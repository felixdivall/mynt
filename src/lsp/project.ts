/**
 * Which schema a document compiles against. Resolution is the CLI's: walk
 * up from the file to `sail.json`, read the alias, load
 * `.sail/schema/<alias>.json`; without a project, the built-in sample.
 * State is keyed by project root and refreshed when either file's mtime
 * changes, so a `sail schema pull` is picked up without a restart.
 * No network access, ever.
 */
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "../errors.js";
import { findProjectRoot, readProjectConfig, schemaSnapshotPath } from "../netsuite/account/config.js";
import { readSnapshot } from "../netsuite/schema/snapshot.js";
import { loadBuiltinSchema } from "../schema/builtin.js";
import { DocumentSchemaProvider, type SchemaProvider } from "../schema/provider.js";

export interface ProjectSchema {
  root: string | undefined;
  provider: SchemaProvider;
  /** "account 'sandbox'" or "built-in sample schema". */
  description: string;
  /** Set when the project asks for a schema that could not be loaded; the built-in sample is used instead. */
  problem?: string;
}

interface CacheEntry {
  configMtime: number;
  snapshotMtime: number;
  result: ProjectSchema;
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

export class ProjectRegistry {
  private readonly cache = new Map<string, CacheEntry>();
  private builtin: SchemaProvider | undefined;

  constructor(private readonly loadBuiltin: () => SchemaProvider = loadBuiltinSchema) {}

  private builtinSchema(): SchemaProvider {
    return (this.builtin ??= this.loadBuiltin());
  }

  schemaForUri(uri: string): ProjectSchema {
    if (!uri.startsWith("file:")) return { root: undefined, provider: this.builtinSchema(), description: "built-in sample schema" };
    return this.schemaForPath(fileURLToPath(uri));
  }

  schemaForPath(filePath: string): ProjectSchema {
    const root = findProjectRoot(dirname(filePath));
    if (!root) return { root: undefined, provider: this.builtinSchema(), description: "built-in sample schema" };

    const configPath = `${root}/sail.json`;
    const alias = safeReadAlias(root);
    const snapshotPath = alias ? schemaSnapshotPath(root, alias) : undefined;
    const configMtime = mtime(configPath);
    const snapshotMtime = snapshotPath ? mtime(snapshotPath) : -1;
    const cached = this.cache.get(root);
    if (cached && cached.configMtime === configMtime && cached.snapshotMtime === snapshotMtime) return cached.result;

    const result = this.load(root, alias, snapshotPath);
    this.cache.set(root, { configMtime, snapshotMtime, result });
    return result;
  }

  private load(root: string, alias: string | undefined, snapshotPath: string | undefined): ProjectSchema {
    if (!alias || !snapshotPath) return { root, provider: this.builtinSchema(), description: "built-in sample schema" };
    if (!existsSync(snapshotPath)) {
      return {
        root,
        provider: this.builtinSchema(),
        description: "built-in sample schema",
        problem: `No schema snapshot found for account '${alias}'. Run \`sail schema pull ${alias}\`.`,
      };
    }
    try {
      return { root, provider: new DocumentSchemaProvider(readSnapshot(snapshotPath)), description: `account '${alias}'` };
    } catch (error) {
      const message = error instanceof UserError ? error.message : String(error);
      return { root, provider: this.builtinSchema(), description: "built-in sample schema", problem: message };
    }
  }
}

function safeReadAlias(root: string): string | undefined {
  try {
    return readProjectConfig(root).account;
  } catch {
    return undefined;
  }
}
