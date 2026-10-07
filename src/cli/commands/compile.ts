import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { compile } from "../../compiler.js";
import { formatDiagnostic } from "../../diagnostics.js";
import { UserError } from "../../errors.js";
import { findProjectRoot, readProjectConfig, schemaSnapshotPath } from "../../netsuite/account/config.js";
import { readSnapshot } from "../../netsuite/schema/snapshot.js";
import { loadBuiltinSchema } from "../../schema/builtin.js";
import { DocumentSchemaProvider, type SchemaProvider } from "../../schema/provider.js";
import type { ScriptUnit } from "../../semantic/bound.js";
import type { ParsedArgs } from "../args.js";
import { stringOption } from "../args.js";
import type { CliContext } from "../context.js";

/**
 * Which schema the compiler gets, in order: `--schema <file>`, the project's
 * default account snapshot (`sail.json` -> .sail/schema/<alias>.json), the
 * built-in sample. The compiler only ever receives a SchemaProvider.
 */
export function resolveSchema(context: CliContext, schemaOption: string | undefined): { provider: SchemaProvider; description: string } {
  if (schemaOption) {
    const path = resolve(context.cwd, schemaOption);
    return { provider: new DocumentSchemaProvider(readSnapshot(path)), description: schemaOption };
  }
  const root = findProjectRoot(context.cwd);
  const alias = root ? readProjectConfig(root).account : undefined;
  if (root && alias) {
    const path = schemaSnapshotPath(root, alias);
    if (!existsSync(path)) {
      throw new UserError(`sail.json selects account '${alias}', but there is no snapshot at ${path}.\nRun \`sail schema pull ${alias}\`.`);
    }
    return { provider: new DocumentSchemaProvider(readSnapshot(path)), description: `account '${alias}'` };
  }
  return { provider: loadBuiltinSchema(), description: "built-in sample schema" };
}

export async function runCompile(command: "check" | "build", args: ParsedArgs, context: CliContext): Promise<number> {
  const file = args.positional[0];
  if (!file) throw new UserError(`Usage: sail ${command} <file.sail> [--schema <snapshot.json>]`);

  let source: string;
  try {
    source = readFileSync(resolve(context.cwd, file), "utf8");
  } catch {
    throw new UserError(`cannot read '${file}'`);
  }

  const schema = resolveSchema(context, stringOption(args.options, "schema"));
  const result = compile(source, { file, schema: schema.provider });

  for (const diagnostic of result.diagnostics) {
    context.stderr(formatDiagnostic(diagnostic, source) + "\n\n");
  }

  const errors = result.diagnostics.filter((d) => d.severity === "error").length;
  const warnings = result.diagnostics.length - errors;
  const summary = [plural(errors, "error"), warnings > 0 ? plural(warnings, "warning") : ""].filter(Boolean).join(", ");
  if (errors > 0 || !result.output) {
    context.stderr(`sail: ${summary} in ${file}\n`);
    return 1;
  }
  if (warnings > 0) context.stderr(`sail: ${summary} in ${file}\n`);

  if (command === "check") {
    context.stdout(`sail: ${file} OK (${describeUnit(result.unit!)}, schema: ${schema.description})\n`);
    return 0;
  }

  const outFile = join(dirname(file), basename(file, extname(file)) + ".js");
  writeFileSync(resolve(context.cwd, outFile), result.output);
  context.stdout(`sail: wrote ${outFile}\n`);
  return 0;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function describeUnit(unit: ScriptUnit): string {
  return unit.kind === "UserEvent" ? `${unit.record.name} user event` : "scheduled script";
}
