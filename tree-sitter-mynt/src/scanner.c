// External scanner for Mynt: statement terminators at newlines.
//
// Mynt ends a statement at a newline wherever a statement may end (Go's
// rule). Tree-sitter tells the scanner whether a terminator is valid in the
// current parse state, which is the same question, so the scanner emits a
// terminator token covering the newline exactly then. One exception mirrors the
// compiler: a line beginning with a search clause word (`where`, `select`,
// `order`, `limit`, `first`) continues the search before it, and one
// beginning with `or` continues the expression before it.

#include "tree_sitter/parser.h"
#include <wctype.h>

enum TokenType { NEWLINE_TERMINATOR };

void *tree_sitter_mynt_external_scanner_create(void) { return NULL; }
void tree_sitter_mynt_external_scanner_destroy(void *payload) {}
unsigned tree_sitter_mynt_external_scanner_serialize(void *payload, char *buffer) { return 0; }
void tree_sitter_mynt_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {}

static bool looking_at_clause(TSLexer *lexer) {
  static const char *words[] = {"where", "select", "order", "group", "limit", "first", "or"};
  // Read one identifier (at most 8 chars matter) and compare; the lexer has
  // already marked the terminator's end, so consuming here is lookahead only.
  char buffer[9];
  int length = 0;
  while (length < 8 && (iswalnum(lexer->lookahead) || lexer->lookahead == '_')) {
    buffer[length++] = (char)lexer->lookahead;
    lexer->advance(lexer, false);
  }
  buffer[length] = '\0';
  if (iswalnum(lexer->lookahead) || lexer->lookahead == '_') return false;
  for (unsigned i = 0; i < sizeof(words) / sizeof(words[0]); i++) {
    const char *word = words[i];
    int j = 0;
    while (word[j] != '\0' && buffer[j] == word[j]) j++;
    if (word[j] == '\0' && buffer[j] == '\0') return true;
  }
  return false;
}

bool tree_sitter_mynt_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  if (!valid_symbols[NEWLINE_TERMINATOR]) return false;

  while (lexer->lookahead == ' ' || lexer->lookahead == '\t' || lexer->lookahead == '\r') lexer->advance(lexer, true);
  if (lexer->lookahead != '\n') return false;

  // The terminator is the newline itself, so the parser always advances.
  lexer->advance(lexer, false);
  lexer->mark_end(lexer);
  while (iswspace(lexer->lookahead)) lexer->advance(lexer, true);
  if (looking_at_clause(lexer)) return false;

  lexer->result_symbol = NEWLINE_TERMINATOR;
  return true;
}
