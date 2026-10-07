/**
 * The language service: every LSP feature as a plain method over in-memory
 * documents, with no connection. `server.ts` wires these to the protocol;
 * tests call them directly. Each open or change re-analyzes the whole
 * document, which is a few milliseconds for scripts of realistic size;
 * incremental reparsing can replace `analyze` later without touching the
 * features, which only read the SemanticDocument.
 */
import {
  DiagnosticSeverity,
  SymbolKind,
  type CompletionItem,
  type Diagnostic,
  type DocumentSymbol,
  type Hover,
  type Location,
  type PrepareRenameResult,
  type SemanticTokens,
  type SignatureHelp,
  type WorkspaceEdit,
} from "vscode-languageserver";
import type { Diagnostic as SailDiagnostic } from "../diagnostics.js";
import { analyze, type SemanticDocument } from "../semantic/query.js";
import { completionsAt } from "./completion.js";
import { hoverAt } from "./hover.js";
import { definitionAt, documentOutline, type OutlineSymbol } from "./navigation.js";
import { prepareRenameAt, referencesAt, renameAt, type RenameOutcome } from "./references.js";
import { encodeSemanticTokens } from "./semantic-tokens.js";
import { signatureHelpAt } from "./signature-help.js";
import { LineIndex, wordOffsetAt, type LspPosition } from "./position.js";
import type { ProjectRegistry, ProjectSchema } from "./project.js";

interface OpenDocument {
  uri: string;
  version: number;
  lines: LineIndex;
  schema: ProjectSchema;
  analysis: SemanticDocument;
}

export class SailLanguageService {
  private readonly documents = new Map<string, OpenDocument>();

  constructor(private readonly projects: ProjectRegistry) {}

  open(uri: string, text: string, version: number): void {
    this.update(uri, text, version);
  }

  change(uri: string, text: string, version: number): void {
    this.update(uri, text, version);
  }

  close(uri: string): void {
    this.documents.delete(uri);
  }

  private update(uri: string, text: string, version: number): void {
    const schema = this.projects.schemaForUri(uri);
    const file = uri.startsWith("file:") ? decodeURIComponent(uri.slice(uri.lastIndexOf("/") + 1)) : uri;
    const analysis = analyze(text, file, schema.provider);
    this.documents.set(uri, { uri, version, lines: new LineIndex(text), schema, analysis });
  }

  private get(uri: string): OpenDocument {
    const doc = this.documents.get(uri);
    if (!doc) throw new Error(`Document ${uri} is not open`);
    return doc;
  }

  /** Which schema the document is being checked against, for the editor's status. */
  schemaDescription(uri: string): string {
    return this.get(uri).schema.description;
  }

  diagnostics(uri: string): Diagnostic[] {
    const doc = this.get(uri);
    const items = doc.analysis.diagnostics.map((d) => toLspDiagnostic(d, doc.lines));
    if (doc.schema.problem) {
      items.unshift({
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        severity: DiagnosticSeverity.Warning,
        source: "sail",
        message: `${doc.schema.problem} Checking against the built-in sample schema until then.`,
      });
    }
    return items;
  }

  completion(uri: string, position: LspPosition): CompletionItem[] {
    const doc = this.get(uri);
    return completionsAt(doc.analysis, doc.lines.offsetAt(position));
  }

  hover(uri: string, position: LspPosition): Hover | null {
    const doc = this.get(uri);
    const result = hoverAt(doc.analysis, doc.lines.offsetAt(position));
    if (!result) return null;
    return { contents: { kind: "markdown", value: result.contents }, range: doc.lines.rangeOf(result.span) };
  }

  definition(uri: string, position: LspPosition): Location | null {
    const doc = this.get(uri);
    const span = definitionAt(doc.analysis, doc.lines.offsetAt(position));
    return span ? { uri, range: doc.lines.rangeOf(span) } : null;
  }

  references(uri: string, position: LspPosition, includeDeclaration: boolean): Location[] {
    const doc = this.get(uri);
    return referencesAt(doc.analysis, doc.lines, uri, this.wordOffset(doc, position), includeDeclaration);
  }

  prepareRename(uri: string, position: LspPosition): RenameOutcome<PrepareRenameResult> {
    const doc = this.get(uri);
    return prepareRenameAt(doc.analysis, doc.lines, this.wordOffset(doc, position));
  }

  rename(uri: string, position: LspPosition, newName: string): RenameOutcome<WorkspaceEdit> {
    const doc = this.get(uri);
    return renameAt(doc.analysis, doc.lines, uri, this.wordOffset(doc, position), newName);
  }

  private wordOffset(doc: OpenDocument, position: LspPosition): number {
    return wordOffsetAt(doc.lines.text, doc.lines.offsetAt(position));
  }

  semanticTokens(uri: string): SemanticTokens {
    const doc = this.get(uri);
    return { data: encodeSemanticTokens(doc.analysis, doc.lines) };
  }

  signatureHelp(uri: string, position: LspPosition): SignatureHelp | null {
    const doc = this.get(uri);
    const result = signatureHelpAt(doc.analysis, doc.lines.offsetAt(position));
    if (!result) return null;
    const { signature } = result;
    return {
      signatures: [
        {
          label: signature.label,
          parameters: signature.parameters.map((p) => ({ label: [p.start, p.end] as [number, number] })),
          ...(signature.documentation ? { documentation: signature.documentation } : {}),
        },
      ],
      activeSignature: 0,
      activeParameter: Math.min(result.activeParameter, Math.max(0, signature.parameters.length - 1)),
    };
  }

  documentSymbols(uri: string): DocumentSymbol[] {
    const doc = this.get(uri);
    const convert = (symbol: OutlineSymbol): DocumentSymbol => ({
      name: symbol.name,
      detail: symbol.detail,
      kind: symbol.kind === "local" ? SymbolKind.Variable : SymbolKind.Function,
      range: doc.lines.rangeOf(symbol.span),
      selectionRange: doc.lines.rangeOf(symbol.selectionSpan),
      children: symbol.children.map(convert),
    });
    return documentOutline(doc.analysis).map(convert);
  }
}

export function toLspDiagnostic(diagnostic: SailDiagnostic, lines: LineIndex): Diagnostic {
  return {
    range: lines.rangeOf(diagnostic.span),
    severity: diagnostic.severity === "error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
    code: diagnostic.code,
    source: "sail",
    message: diagnostic.message,
  };
}
