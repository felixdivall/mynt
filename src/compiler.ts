/**
 * Compiler facade: source text in, diagnostics and SuiteScript out.
 * Pure: no file system, no network. Callers supply the schema.
 */
import { DiagnosticBag, type Diagnostic } from "./diagnostics.js";
import { emitSuiteScript } from "./netsuite/emit.js";
import { parse } from "./parser/parser.js";
import type { SourceFile } from "./parser/ast.js";
import type { SchemaProvider } from "./schema/provider.js";
import { checkRecordLifecycle } from "./semantic/analysis.js";
import { bind } from "./semantic/binder.js";
import type { ScriptUnit } from "./semantic/bound.js";

export interface CompileOptions {
  /** Path used in diagnostics. */
  file: string;
  schema: SchemaProvider;
}

export interface CompileResult {
  diagnostics: Diagnostic[];
  ast: SourceFile;
  /** Present when binding produced a script unit, even if later errors occurred. */
  unit: ScriptUnit | undefined;
  /** Present only when there are no errors. */
  output: string | undefined;
}

export function compile(source: string, options: CompileOptions): CompileResult {
  const diagnostics = new DiagnosticBag(options.file);

  const ast = parse(source, options.file, diagnostics);
  const unit = bind(ast, options.schema, diagnostics);
  if (unit) checkRecordLifecycle(unit, diagnostics);

  const output = unit && !diagnostics.hasErrors ? emitSuiteScript(unit) : undefined;

  return { diagnostics: diagnostics.items, ast, unit, output };
}
