// External scanner for Mynt: statement terminators at newlines.
//
// Mynt ends a statement at a newline wherever a statement may end (Go's
// rule). Tree-sitter tells the scanner whether a terminator is valid in the
// current parse state, which is the same question, so the scanner emits a
// terminator token covering the newline exactly then. One exception mirrors the
// compiler: a line beginning with `where` continues the `query` before it.

#include "tree_sitter/parser.h"
#include <wctype.h>

enum TokenType { NEWLINE_TERMINATOR };

void *tree_sitter_mynt_external_scanner_create(void) { return NULL; }
void tree_sitter_mynt_external_scanner_destroy(void *payload) {}
unsigned tree_sitter_mynt_external_scanner_serialize(void *payload, char *buffer) { return 0; }
void tree_sitter_mynt_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {}

static bool looking_at_where(TSLexer *lexer) {
  static const char word[] = "where";
  for (int i = 0; word[i] != '\0'; i++) {
    if (lexer->lookahead != (int32_t)word[i]) return false;
    lexer->advance(lexer, false);
  }
  return !(iswalnum(lexer->lookahead) || lexer->lookahead == '_');
}

bool tree_sitter_mynt_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  if (!valid_symbols[NEWLINE_TERMINATOR]) return false;

  while (lexer->lookahead == ' ' || lexer->lookahead == '\t' || lexer->lookahead == '\r') lexer->advance(lexer, true);
  if (lexer->lookahead != '\n') return false;

  // The terminator is the newline itself, so the parser always advances.
  lexer->advance(lexer, false);
  lexer->mark_end(lexer);
  while (iswspace(lexer->lookahead)) lexer->advance(lexer, true);
  if (looking_at_where(lexer)) return false;

  lexer->result_symbol = NEWLINE_TERMINATOR;
  return true;
}
