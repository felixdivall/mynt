/** `mynt lsp`: run the language server on stdio until the client disconnects. */
export async function runLsp(): Promise<number> {
  const { startServer } = await import("../../lsp/server.js");
  await startServer();
  return 0;
}
