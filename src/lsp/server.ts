/**
 * Language Server Protocol transport over stdio. Everything editor-facing
 * is in MyntLanguageService; this file only moves messages. Any LSP client
 * (Zed, VS Code, Neovim) that can run `mynt lsp` can use it.
 */
import { createConnection, ErrorCodes, ProposedFeatures, ResponseError, TextDocuments, TextDocumentSyncKind } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { ProjectRegistry } from "./project.js";
import { SEMANTIC_TOKENS_LEGEND } from "./semantic-tokens.js";
import { MyntLanguageService } from "./service.js";

/** How the server identifies itself to clients. */
export const SERVER_NAME = "mynt";

export function startServer(): Promise<void> {
  const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
  const documents = new TextDocuments(TextDocument);
  const service = new MyntLanguageService(new ProjectRegistry());

  connection.onInitialize(() => ({
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: ["."] },
      hoverProvider: true,
      definitionProvider: true,
      documentSymbolProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      semanticTokensProvider: { legend: SEMANTIC_TOKENS_LEGEND, full: true, range: false },
      signatureHelpProvider: { triggerCharacters: ["(", ","] },
    },
    serverInfo: { name: SERVER_NAME },
  }));

  const publish = (document: TextDocument): void => {
    service.change(document.uri, document.getText(), document.version);
    connection.sendDiagnostics({ uri: document.uri, diagnostics: service.diagnostics(document.uri) });
  };

  documents.onDidOpen((event) => {
    publish(event.document);
    connection.console.log(`mynt: ${event.document.uri} checked against ${service.schemaDescription(event.document.uri)}`);
  });
  documents.onDidChangeContent((event) => publish(event.document));
  documents.onDidClose((event) => {
    service.close(event.document.uri);
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  });

  connection.onCompletion((params) => service.completion(params.textDocument.uri, params.position));
  connection.onHover((params) => service.hover(params.textDocument.uri, params.position));
  connection.onDefinition((params) => service.definition(params.textDocument.uri, params.position));
  connection.onDocumentSymbol((params) => service.documentSymbols(params.textDocument.uri));
  connection.onReferences((params) => service.references(params.textDocument.uri, params.position, params.context.includeDeclaration));
  connection.languages.semanticTokens.on((params) => service.semanticTokens(params.textDocument.uri));
  connection.onSignatureHelp((params) => service.signatureHelp(params.textDocument.uri, params.position));
  connection.onPrepareRename((params) => {
    const result = service.prepareRename(params.textDocument.uri, params.position);
    if ("error" in result) throw new ResponseError(ErrorCodes.InvalidParams, result.error);
    return result.ok;
  });
  connection.onRenameRequest((params) => {
    const result = service.rename(params.textDocument.uri, params.position, params.newName);
    if ("error" in result) throw new ResponseError(ErrorCodes.InvalidParams, result.error);
    return result.ok;
  });

  documents.listen(connection);
  connection.listen();
  return new Promise((resolve) => connection.onExit(() => resolve()));
}
