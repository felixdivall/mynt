import { DiagnosticBag, DiagnosticCode, spanFrom, type Span } from "../diagnostics.js";
import { tokenize } from "../lexer/lexer.js";
import type { Token, TokenKind } from "../lexer/tokens.js";
import { isPrimitiveTypeName } from "../semantic/types.js";
import {
  BOOL_LITERALS,
  DECLARATION_KEYWORDS,
  USER_EVENT_HOOKS,
  type AddStatement,
  type AssignmentStatement,
  type BinaryOperator,
  type Block,
  type BoolLiteral,
  type Declaration,
  type DeleteStatement,
  type Expression,
  type ExpressionStatement,
  type ForStatement,
  type FunctionDeclaration,
  type Identifier,
  type IfStatement,
  type LetStatement,
  type NumberLiteral,
  type OrExpression,
  type Parameter,
  type ProjectionExpression,
  type QueryExpression,
  type QueryOperation,
  type SavedSearchClause,
  type SearchClause,
  type SelectItem,
  type AggregateCall,
  type SortKey,
  QUERY_OPERATIONS,
  AGGREGATE_FUNCTIONS,
  SEARCH_CLAUSE_KEYWORDS,
  type RemoveStatement,
  type ReturnStatement,
  type SaveStatement,
  type ScheduledDeclaration,
  type SourceFile,
  type Statement,
  type StringLiteral,
  type TryStatement,
  type UnaryExpression,
  type UserEventDeclaration,
  type UserEventHook,
} from "./ast.js";

/**
 * Thrown internally to abandon the current construct on a syntax error. A
 * statement that fails is skipped to the end of the statement and its block
 * continues; a declaration header that fails is skipped to the next
 * top-level declaration. Either way one error does not hide the others, and
 * the surviving syntax still binds, which is what editor features rely on
 * while a line is being typed.
 */
class ParseAbort extends Error {}

const TOKEN_DESCRIPTIONS: Record<TokenKind, string> = {
  Identifier: "identifier",
  String: "string literal",
  Number: "number literal",
  LParen: "'('",
  RParen: "')'",
  LBrace: "'{'",
  RBrace: "'}'",
  LBracket: "'['",
  RBracket: "']'",
  Pipe: "'|'",
  Colon: "':'",
  Dot: "'.'",
  Equals: "'='",
  Comma: "','",
  EqualsEquals: "'=='",
  BangEquals: "'!='",
  EqualsEqualsEquals: "'==='",
  BangEqualsEquals: "'!=='",
  Bang: "'!'",
  AmpAmp: "'&&'",
  PipePipe: "'||'",
  Less: "'<'",
  LessEquals: "'<='",
  Greater: "'>'",
  GreaterEquals: "'>='",
  Terminator: "end of statement",
  EOF: "end of file",
};

/**
 * Binary operators by token, with their precedence (higher binds tighter)
 * and associativity. The table follows JavaScript: relational above
 * equality, `&&` above `||`. Comparisons do not chain (`a == b == c` is an
 * error, not `(a == b) == c`); the logical operators are left-associative.
 * Prefix `!` binds tighter than every binary operator and postfix binds
 * tighter still. Arithmetic, when it arrives, is a set of entries above the
 * comparisons.
 */
interface BinaryOperatorInfo {
  operator: BinaryOperator;
  precedence: number;
  associativity: "left" | "none";
}

const BINARY_OPERATORS: Partial<Record<TokenKind, BinaryOperatorInfo>> = {
  PipePipe: { operator: "||", precedence: 1, associativity: "left" },
  AmpAmp: { operator: "&&", precedence: 2, associativity: "left" },
  EqualsEquals: { operator: "==", precedence: 3, associativity: "none" },
  BangEquals: { operator: "!=", precedence: 3, associativity: "none" },
  EqualsEqualsEquals: { operator: "===", precedence: 3, associativity: "none" },
  BangEqualsEquals: { operator: "!==", precedence: 3, associativity: "none" },
  Less: { operator: "<", precedence: 4, associativity: "none" },
  LessEquals: { operator: "<=", precedence: 4, associativity: "none" },
  Greater: { operator: ">", precedence: 4, associativity: "none" },
  GreaterEquals: { operator: ">=", precedence: 4, associativity: "none" },
};

/** Words that begin a statement; a comma-separated list cut short at a line's end stops before one. */
const STATEMENT_START_WORDS: readonly string[] = ["let", "if", "for", "save", "delete", "remove", "add", "return"];

/** Tokens that can begin an expression. */
const EXPRESSION_START = new Set<TokenKind>(["Identifier", "String", "Number", "LParen", "Bang"]);

/**
 * Tokens that make a leading identifier part of an expression rather than a
 * statement keyword: `save.x`, `save = ...`, `save == ...`. `(` is handled
 * per keyword: `save(x)` is a call (and so not the save statement, whose
 * target is written without parentheses), while `if (x) {` is an if.
 */
const EXPRESSION_CONTINUATION = new Set<TokenKind>(["Dot", "Equals", ...(Object.keys(BINARY_OPERATORS) as TokenKind[])]);

/** `order.item` or `Customer(...)` for a hint, or `...` for anything more complex. */
function describeExpression(expression: Expression): string {
  if (expression.kind === "Identifier") return expression.name;
  if (expression.kind === "MemberExpression") return `${describeExpression(expression.object)}.${expression.property.name}`;
  if (expression.kind === "CallExpression") {
    return `${describeExpression(expression.callee)}${expression.typeArgument ? ` ${expression.typeArgument.name}` : ""}(...)`;
  }
  return "...";
}

function describe(token: Token): string {
  if (token.kind === "Identifier") return `'${token.text}'`;
  if (token.kind === "String") return `string ${token.text}`;
  if (token.kind === "Number") return `number ${token.text}`;
  return TOKEN_DESCRIPTIONS[token.kind];
}

/**
 * Hand-written recursive-descent parser for the v0 grammar:
 *
 *   File        := Declaration*
 *   Declaration := UserEvent | Scheduled | Function
 *   Function    := "fn" Identifier "(" (Parameter ("," Parameter)*)? ")" (":" Identifier)? Block
 *   UserEvent   := Hook EventFilter? "(" Parameter ")" Block
 *   Hook        := "beforeSubmit" | "afterSubmit"
 *   Scheduled   := "scheduled" Block
 *   EventFilter := Identifier ("|" Identifier)*
 *   Parameter   := Identifier ":" Identifier
 *   Block       := "{" Statement* "}"
 *   Statement   := LetStatement | SaveStatement | DeleteStatement | RemoveStatement | AddStatement | ReturnStatement
 *                | IfStatement | ForStatement | TryStatement | Expression ("=" Expression)? Terminator?
 *   TryStatement:= "try" Block ("catch" Identifier? Block)? ("finally" Block)?
 *   LetStatement:= "let" Identifier "=" Expression (Terminator? "or" ("return" Expression? | Block))? Terminator?
 *   SaveStatement:= "save" Expression Terminator?
 *   DeleteStatement:= "delete" Expression Terminator?
 *   RemoveStatement:= "remove" Expression Terminator?
 *   AddStatement:= "add" Expression Block Terminator?
 *   ReturnStatement:= "return" Expression? Terminator?
 *   IfStatement := "if" Expression Block ("else" Block)? Terminator?
 *   ForStatement:= "for" Identifier "in" Expression Block Terminator?
 *   Expression  := Binary
 *   Binary      := Unary (BinaryOperator Unary)*            (precedence climbing; see BINARY_OPERATORS)
 *   BinaryOperator := "||" | "&&" | "==" | "!=" | "===" | "!==" | "<" | "<=" | ">" | ">="
 *   Unary       := "!" Unary | Postfix
 *   Postfix     := Primary ("." Identifier | TypeArgument ("(" Arguments ")")? ("to" TypeArgument)? | "(" Arguments ")" | Projection)*
 *   Projection  := "[" Identifier ("," Identifier)* "]"
 *   TypeArgument:= Identifier
 *   Arguments   := (Expression ("," Expression)*)?
 *   Primary     := Identifier | String | Number | "true" | "false" | "(" Expression ")" | Query
 *   Query       := ("query" | "search") (Identifier | "saved" Identifier? (String | Identifier)) (Terminator? Clause)*
 *   Clause      := "where" Expression | "select" FieldPath ("," FieldPath)* | "order" "by" SortKey ("," SortKey)* | "limit" Primary | "first"
 *   SortKey     := FieldPath ("asc" | "desc")?
 *   FieldPath   := Identifier ("." Identifier)*
 *
 * Declaration keywords, `let`, `save`, `if`, `else`, event names, and built-in
 * names are contextual: they are ordinary identifiers that the parser
 * (declarations, `let`, `save`, `if`) and binder (events, built-ins such as
 * `log` and `load`, record types such as `Customer`) interpret by position.
 * `true` and `false` are literals wherever an expression is expected.
 * `Customer(123)` is syntactically a call whose callee is a bare name; the
 * binder reads it as a record reference because `Customer` is a record type.
 * Brackets exist only for projections: `[` after an expression names fields.
 */
export function parse(source: string, file: string, diagnostics: DiagnosticBag): SourceFile {
  const tokens = tokenize(source, diagnostics);
  const parser = new Parser(tokens, diagnostics);
  return parser.parseSourceFile(file);
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly diagnostics: DiagnosticBag,
  ) {}

  // ---- token helpers -------------------------------------------------------

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)]!;
  }

  private at(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private next(): Token {
    const token = this.peek();
    if (token.kind !== "EOF") this.index++;
    return token;
  }

  private expect(kind: TokenKind, context: string): Token {
    if (this.at(kind)) return this.next();
    const token = this.peek();
    this.fail(`Expected ${TOKEN_DESCRIPTIONS[kind]} ${context}, found ${describe(token)}`, token.span);
  }

  private skipTerminators(): void {
    while (this.at("Terminator")) this.next();
  }

  private fail(message: string, span: Span): never {
    this.diagnostics.error(DiagnosticCode.SyntaxError, message, span);
    throw new ParseAbort(message);
  }

  /**
   * After a failed statement: skip to the end of that statement. A nested
   * block that begins inside the bad statement is skipped as a whole so its
   * closing brace is not mistaken for the enclosing block's.
   */
  private recoverStatement(): void {
    while (!this.at("EOF")) {
      const kind = this.peek().kind;
      if (kind === "Terminator") {
        this.next();
        return;
      }
      if (kind === "RBrace") return;
      if (kind === "LBrace") {
        this.skipBalancedBlock();
        continue;
      }
      this.next();
    }
  }

  /** Skip `( ... )`, nested parentheses included. */
  private skipBalancedParens(): void {
    let depth = 0;
    do {
      const kind = this.next().kind;
      if (kind === "LParen") depth++;
      else if (kind === "RParen") depth--;
      else if (kind === "EOF" || kind === "Terminator") return;
    } while (depth > 0);
  }

  private skipBalancedBlock(): void {
    let depth = 0;
    do {
      const kind = this.next().kind;
      if (kind === "LBrace") depth++;
      else if (kind === "RBrace") depth--;
      else if (kind === "EOF") return;
    } while (depth > 0);
  }

  /** Skip forward to the next token that can begin a top-level declaration. */
  private synchronize(): void {
    while (!this.at("EOF")) {
      const token = this.peek();
      if (token.kind === "Identifier" && DECLARATION_KEYWORDS.includes(token.text)) {
        return;
      }
      this.next();
    }
  }

  // ---- grammar -------------------------------------------------------------

  parseSourceFile(file: string): SourceFile {
    const start = this.peek().span;
    const declarations: Declaration[] = [];

    this.skipTerminators();
    while (!this.at("EOF")) {
      try {
        declarations.push(this.parseDeclaration());
      } catch (error) {
        if (!(error instanceof ParseAbort)) throw error;
        this.synchronize();
      }
      this.skipTerminators();
    }

    return { kind: "SourceFile", file, declarations, span: spanFrom(start, this.peek().span) };
  }

  private parseDeclaration(): Declaration {
    const token = this.peek();
    if (token.kind === "Identifier" && (USER_EVENT_HOOKS as readonly string[]).includes(token.text)) {
      return this.parseUserEvent();
    }
    if (token.kind === "Identifier" && token.text === "scheduled") {
      return this.parseScheduled();
    }
    if (token.kind === "Identifier" && token.text === "fn") {
      return this.parseFunction();
    }
    this.fail(
      `Expected an entry point (${USER_EVENT_HOOKS.join(", ")}, scheduled) or a function (fn) at file level, found ${describe(token)}`,
      token.span,
    );
  }

  private parseScheduled(): ScheduledDeclaration {
    const keyword = this.next();
    const body = this.parseBlock();
    return {
      kind: "ScheduledDeclaration",
      keywordSpan: keyword.span,
      body,
      span: spanFrom(keyword.span, body.span),
    };
  }

  private parseFunction(): FunctionDeclaration {
    const keyword = this.next();
    const name = this.parseBindingName("as the function name");
    this.expect("LParen", `after 'fn ${name.name}'`);
    const parameters: Parameter[] = [];
    if (!this.at("RParen")) {
      for (;;) {
        parameters.push(this.parseParameter());
        if (this.at("Comma")) {
          this.next();
          continue;
        }
        break;
      }
    }
    this.expect("RParen", "to close the parameter list");
    let returnType: Identifier | undefined;
    if (this.at("Colon")) {
      this.next();
      returnType = this.parseIdentifier("as the return type after ':'");
    }
    if (!this.at("LBrace")) {
      this.fail(`Expected '{' to begin the body of '${name.name}', found ${describe(this.peek())}`, this.peek().span);
    }
    const body = this.parseBlock(`the body of '${name.name}'`);
    return { kind: "FunctionDeclaration", keywordSpan: keyword.span, name, parameters, returnType, body, span: spanFrom(keyword.span, body.span) };
  }

  private parseUserEvent(): UserEventDeclaration {
    const hookToken = this.next();
    const hook = hookToken.text as UserEventHook;

    // Event filter: identifiers separated by '|' until the parameter list.
    const events: Identifier[] = [];
    while (this.at("Identifier")) {
      events.push(this.parseIdentifier());
      if (this.at("Pipe")) {
        this.next();
        if (!this.at("Identifier")) {
          this.fail(`Expected an event name after '|', found ${describe(this.peek())}`, this.peek().span);
        }
      } else {
        break;
      }
    }

    this.expect("LParen", `after ${hook} event filter`);
    const parameter = this.parseParameter();
    this.expect("RParen", "after the record parameter");
    const body = this.parseBlock();

    return {
      kind: "UserEventDeclaration",
      hook,
      hookSpan: hookToken.span,
      events,
      parameter,
      body,
      span: spanFrom(hookToken.span, body.span),
    };
  }

  private parseParameter(): Parameter {
    const name = this.parseBindingName("as the parameter name");
    this.expect("Colon", "after the parameter name");
    const type = this.parseIdentifier("as the parameter type");
    return { kind: "Parameter", name, type, span: spanFrom(name.span, type.span) };
  }

  private parseBlock(what = "the entry point body"): Block {
    const open = this.expect("LBrace", `to begin ${what}`);
    const statements: Statement[] = [];
    this.skipTerminators();
    while (!this.at("RBrace")) {
      if (this.at("EOF")) {
        // Report, but keep the block: an unclosed body is the normal state of
        // a file being typed, and what was parsed is still worth binding.
        this.diagnostics.error(DiagnosticCode.SyntaxError, `Expected '}' to close ${what}, found end of file`, this.peek().span);
        return { kind: "Block", statements, span: spanFrom(open.span, this.peek().span) };
      }
      try {
        statements.push(this.parseStatement());
      } catch (error) {
        if (!(error instanceof ParseAbort)) throw error;
        this.recoverStatement();
      }
      this.skipTerminators();
    }
    const close = this.next();
    return { kind: "Block", statements, span: spanFrom(open.span, close.span) };
  }

  private parseStatement(): Statement {
    const statement = this.parseStatementBody();
    // A bad terminator does not discard the statement that was just parsed
    // correctly: report it, skip to the end of the line, keep the statement.
    try {
      this.endStatement();
    } catch (error) {
      if (!(error instanceof ParseAbort)) throw error;
      this.recoverStatement();
    }
    return statement;
  }

  private parseStatementBody(): Statement {
    // `let` is contextual: it begins a declaration only when a name follows.
    if (this.at("Identifier") && this.peek().text === "let" && this.peek(1).kind === "Identifier") {
      return this.parseLet();
    }

    // `save`, `delete`, `remove`, `add`, and `if` are contextual: each begins a statement unless used as an expression.
    if (this.at("Identifier") && ["save", "delete", "remove"].includes(this.peek().text)) {
      const next = this.peek(1).kind;
      if (!EXPRESSION_CONTINUATION.has(next) && next !== "LParen") return this.parseRecordStatement();
    }
    if (this.at("Identifier") && this.peek().text === "add") {
      const next = this.peek(1).kind;
      if (!EXPRESSION_CONTINUATION.has(next) && next !== "LParen") return this.parseAdd();
    }
    // `return` always begins a statement, so `return (a || b)` is a return, not a call.
    if (this.at("Identifier") && this.peek().text === "return") return this.parseReturn();
    if (this.at("Identifier") && this.peek().text === "try" && this.peek(1).kind === "LBrace") return this.parseTry();
    if (this.at("Identifier") && (this.peek().text === "catch" || this.peek().text === "finally") && (this.peek(1).kind === "LBrace" || this.peek(1).kind === "Identifier")) {
      this.fail(`'${this.peek().text}' must be on the same line as the '}' that closes the try block: write '} ${this.peek().text}${this.peek().text === "catch" ? " err" : ""} {'`, this.peek().span);
    }
    if (this.at("Identifier") && this.peek().text === "if" && !EXPRESSION_CONTINUATION.has(this.peek(1).kind)) {
      return this.parseIf();
    }
    if (this.at("Identifier") && this.peek().text === "for" && this.peek(1).kind === "Identifier") {
      return this.parseFor();
    }
    if (this.at("Identifier") && this.peek().text === "else" && this.peek(1).kind === "LBrace") {
      this.fail("'else' must be on the same line as the '}' that closes the if block: write '} else {'", this.peek().span);
    }

    const expression = this.parseExpression();

    if (this.at("Equals")) {
      this.next();
      const value = this.parseExpression();
      const statement: AssignmentStatement = {
        kind: "AssignmentStatement",
        target: expression,
        value,
        span: spanFrom(expression.span, value.span),
      };
      return statement;
    }

    const statement: ExpressionStatement = {
      kind: "ExpressionStatement",
      expression,
      span: expression.span,
    };
    return statement;
  }

  private parseLet(): LetStatement {
    const keyword = this.next();
    const name = this.parseBindingName("as the variable name");
    if (!this.at("Equals")) {
      this.fail(
        `Expected '=' after 'let ${name.name}' (an initializer is required), found ${describe(this.peek())}`,
        this.peek().span,
      );
    }
    this.next();
    const initializer = this.parseOrExpression();
    return {
      kind: "LetStatement",
      keywordSpan: keyword.span,
      name,
      initializer,
      span: spanFrom(keyword.span, initializer.span),
    };
  }

  /**
   * An expression, then optionally `or return` / `or { ... }` resolving it
   * as an optional. `or` may begin the next line (after a search's last
   * clause, typically) and is a resolution only when `return` or `{`
   * follows; otherwise the word is left for whatever comes next.
   */
  private parseOrExpression(): Expression {
    const value = this.parseExpression();
    const at = this.at("Terminator") ? 1 : 0;
    const word = this.peek(at);
    if (word.kind !== "Identifier" || word.text !== "or") return value;
    const after = this.peek(at + 1);
    if (!(after.kind === "Identifier" && after.text === "return") && after.kind !== "LBrace") {
      // `or` with something else after it. On the value's own line it can only be a resolution, so it is one that
      // is malformed (`x or y` is not a fallback); on the next line it is a resolution only when cut short there,
      // and otherwise the word is left to begin the next statement.
      const cutShort = after.kind === "Terminator" || after.kind === "EOF" || after.kind === "RBrace";
      if (at === 0 || cutShort) {
        if (at === 1) this.next();
        const orSpan = this.next().span;
        this.diagnostics.error(DiagnosticCode.SyntaxError, `Expected 'return' or '{' after 'or', found ${describe(this.peek())}`, this.peek().span);
        // Skip the rest of the line; the statement's own terminator stays for the caller.
        while (!this.at("Terminator") && !this.at("EOF") && !this.at("RBrace")) {
          if (this.at("LBrace")) this.skipBalancedBlock();
          else this.next();
        }
        const branch: Block = { kind: "Block", statements: [], span: orSpan };
        return { kind: "OrExpression", value, orSpan, branch, span: spanFrom(value.span, orSpan) };
      }
      return value;
    }
    if (at === 1) this.next();
    const orSpan = this.next().span;
    let branch: Block;
    if (this.at("LBrace")) {
      branch = this.parseBlock("the or block");
    } else {
      const statement = this.parseReturn();
      branch = { kind: "Block", statements: [statement], span: statement.span };
    }
    const resolved: OrExpression = { kind: "OrExpression", value, orSpan, branch, span: spanFrom(value.span, branch.span) };
    return resolved;
  }

  private parseRecordStatement(): SaveStatement | DeleteStatement | RemoveStatement {
    const keyword = this.next();
    const verb = keyword.text as "save" | "delete" | "remove";
    if (this.at("Terminator") || this.at("RBrace") || this.at("EOF")) {
      const what = verb === "remove" ? "a line" : "a record";
      this.fail(`Expected ${what} to ${verb} after '${verb}', found ${describe(this.peek())}`, this.peek().span);
    }
    const target = this.parseExpression();
    const span = spanFrom(keyword.span, target.span);
    switch (verb) {
      case "save":
        return { kind: "SaveStatement", keywordSpan: keyword.span, target, span };
      case "delete":
        return { kind: "DeleteStatement", keywordSpan: keyword.span, target, span };
      case "remove":
        return { kind: "RemoveStatement", keywordSpan: keyword.span, target, span };
    }
  }

  private parseTry(): TryStatement {
    const keyword = this.next();
    const body = this.parseBlock("the try block");
    let catchSpan: Span | undefined;
    let binding: Identifier | undefined;
    let handler: Block | undefined;
    let finallySpan: Span | undefined;
    let finalizer: Block | undefined;
    if (this.at("Identifier") && this.peek().text === "catch") {
      catchSpan = this.next().span;
      if (this.at("Identifier")) binding = this.parseBindingName("as the error name after 'catch'");
      if (!this.at("LBrace")) {
        this.fail(`Expected '{' after 'catch${binding ? ` ${binding.name}` : ""}', found ${describe(this.peek())}`, this.peek().span);
      }
      handler = this.parseBlock("the catch block");
    }
    if (this.at("Identifier") && this.peek().text === "finally") {
      finallySpan = this.next().span;
      if (!this.at("LBrace")) this.fail(`Expected '{' after 'finally', found ${describe(this.peek())}`, this.peek().span);
      finalizer = this.parseBlock("the finally block");
    }
    if (!handler && !finalizer) {
      this.fail("A 'try' needs a 'catch' (or 'finally') on the same line as its closing '}': write '} catch err {'", this.peek().span);
    }
    return { kind: "TryStatement", keywordSpan: keyword.span, body, catchSpan, binding, handler, finallySpan, finalizer, span: spanFrom(keyword.span, (finalizer ?? handler ?? body).span) };
  }

  private parseReturn(): ReturnStatement {
    const keyword = this.next();
    if (this.at("Terminator") || this.at("RBrace") || this.at("EOF")) {
      return { kind: "ReturnStatement", keywordSpan: keyword.span, value: undefined, span: keyword.span };
    }
    const value = this.parseExpression();
    return { kind: "ReturnStatement", keywordSpan: keyword.span, value, span: spanFrom(keyword.span, value.span) };
  }

  private parseAdd(): AddStatement {
    const keyword = this.next();
    if (!EXPRESSION_START.has(this.peek().kind) || this.at("LParen")) {
      this.fail(`Expected a sublist to add to after 'add', like 'add order.item {', found ${describe(this.peek())}`, this.peek().span);
    }
    const target = this.parseExpression();
    if (!this.at("LBrace")) {
      this.fail(`Expected '{' to begin the line's fields after 'add ${describeExpression(target)}', found ${describe(this.peek())}`, this.peek().span);
    }
    const body = this.parseBlock("the add block");
    return { kind: "AddStatement", keywordSpan: keyword.span, target, body, span: spanFrom(keyword.span, body.span) };
  }

  private parseIf(): IfStatement {
    const keyword = this.next();
    if (this.at("LBrace") || this.at("Terminator") || this.at("RBrace") || this.at("EOF")) {
      this.fail(`Expected a condition after 'if', found ${describe(this.peek())}`, this.peek().span);
    }
    const condition = this.parseExpression();
    if (this.at("Terminator") && this.peek(1).kind === "LBrace") {
      this.fail("The '{' must be on the same line as the if condition", this.peek(1).span);
    }
    if (!this.at("LBrace")) {
      this.fail(`Expected '{' after the if condition, found ${describe(this.peek())}`, this.peek().span);
    }
    const thenBlock = this.parseBlock("the if block");

    let elseBlock: Block | undefined;
    let elseSpan: Span | undefined;
    if (this.at("Identifier") && this.peek().text === "else") {
      elseSpan = this.next().span;
      if (this.at("Identifier") && this.peek().text === "if") {
        this.fail("'else if' is not supported; write 'else {' and nest the if inside", this.peek().span);
      }
      if (!this.at("LBrace")) {
        this.fail(`Expected '{' after 'else', found ${describe(this.peek())}`, this.peek().span);
      }
      elseBlock = this.parseBlock("the else block");
    }

    return {
      kind: "IfStatement",
      keywordSpan: keyword.span,
      condition,
      thenBlock,
      elseSpan,
      elseBlock,
      span: spanFrom(keyword.span, (elseBlock ?? thenBlock).span),
    };
  }

  private parseFor(): ForStatement {
    const keyword = this.next();
    const variable = this.parseBindingName("as the loop variable");
    if (!(this.at("Identifier") && this.peek().text === "in")) {
      this.fail(`Expected 'in' after 'for ${variable.name}', found ${describe(this.peek())}`, this.peek().span);
    }
    const inSpan = this.next().span;
    if (!EXPRESSION_START.has(this.peek().kind)) {
      this.fail(`Expected a collection to iterate after 'in', found ${describe(this.peek())}`, this.peek().span);
    }
    const iterable = this.parseExpression();
    if (!this.at("LBrace")) {
      this.fail(`Expected '{' after the for header, found ${describe(this.peek())}`, this.peek().span);
    }
    const body = this.parseBlock("the for block");
    return { kind: "ForStatement", keywordSpan: keyword.span, variable, inSpan, iterable, body, span: spanFrom(keyword.span, body.span) };
  }

  private parseQuery(operation: QueryOperation): QueryExpression {
    const keyword = this.next();
    let recordType: Identifier | undefined;
    let saved: SavedSearchClause | undefined;
    if (this.at("Identifier") && this.peek().text === "saved") {
      // `saved "customsearch_x"` or `saved Customer "customsearch_x"`: a saved
      // search. A name right after `saved` is the record type when an id
      // follows it on the same line, otherwise it is the id itself (a local).
      const savedKeyword = this.next();
      if (operation !== "search") {
        this.fail(`'saved' loads a saved search and belongs to 'search'; write 'search saved ...' (query is N/query, which has no saved searches)`, savedKeyword.span);
      }
      saved = { kind: "SavedSearchClause", keywordSpan: savedKeyword.span, id: undefined, span: savedKeyword.span };
      const next = this.peek(1);
      if (this.at("Identifier") && this.peek().text !== "where" && (next.kind === "String" || (next.kind === "Identifier" && next.text !== "where"))) {
        recordType = this.parseIdentifier();
      }
      if (this.at("String") || (this.at("Identifier") && this.peek().text !== "where")) {
        saved.id = this.parsePrimary();
        saved.span = spanFrom(savedKeyword.span, saved.id.span);
      } else if (this.at("Number")) {
        this.fail(
          `A saved search is named by its script id, a string like "customsearch_active_customers", not a number; numeric internal ids are not accepted`,
          this.peek().span,
        );
      } else {
        // Report, and keep the search so what was written still binds while typing.
        this.diagnostics.error(
          DiagnosticCode.SyntaxError,
          `Expected a saved search id after 'saved${recordType ? ` ${recordType.name}` : ""}', like "customsearch_active_customers", found ${describe(this.peek())}`,
          this.peek().span,
        );
      }
    } else {
      recordType = this.parseIdentifier(`as the record type to ${operation}`);
      if (this.at("Identifier") && this.peek().text === "using") {
        // The pre-release spelling. Point at the current one rather than reporting a bare syntax error.
        this.fail(`Saved searches are written 'search saved "customsearch_x"' (or 'search saved ${recordType.name} "customsearch_x"' to state the type); 'using' is no longer part of Mynt`, this.peek().span);
      }
    }
    // Clauses, in any order. Each may start the next line: look past one terminator for a clause word.
    const clauses: SearchClause[] = [];
    for (;;) {
      const at = this.at("Terminator") ? 1 : 0;
      const word = this.peek(at);
      if (word.kind !== "Identifier" || !SEARCH_CLAUSE_KEYWORDS.includes(word.text)) break;
      if (at === 1) this.next();
      clauses.push(this.parseSearchClause());
    }
    const where = clauses.find((c): c is Extract<SearchClause, { kind: "WhereClause" }> => c.kind === "WhereClause");
    const last = clauses[clauses.length - 1];
    return {
      kind: "QueryExpression",
      operation,
      keywordSpan: keyword.span,
      recordType,
      saved,
      clauses,
      whereSpan: where?.keywordSpan,
      condition: where?.condition,
      span: spanFrom(keyword.span, (last ?? saved?.id ?? recordType ?? { span: saved?.keywordSpan ?? keyword.span }).span),
    };
  }

  private parseSearchClause(): SearchClause {
    const word = this.next();
    switch (word.text) {
      case "where": {
        if (!EXPRESSION_START.has(this.peek().kind)) {
          this.fail(`Expected a condition after 'where', found ${describe(this.peek())}`, this.peek().span);
        }
        const condition = this.parseExpression();
        return { kind: "WhereClause", keywordSpan: word.span, condition, span: spanFrom(word.span, condition.span) };
      }
      case "select": {
        // Items, comma-separated; a line may continue after a comma. An
        // empty list is reported and kept, so completion sees the clause.
        const items: SelectItem[] = [];
        if (this.at("Identifier")) {
          for (;;) {
            items.push(this.parseSelectItem());
            if (!this.at("Comma")) break;
            this.next();
            // `name = aggregate(` or a bare `aggregate(` continues the list; neither is a statement on the next line.
            const aliasNext = this.at("Identifier") && this.peek(1).kind === "Equals" && this.peek(2).kind === "Identifier" && this.peek(3).kind === "LParen";
            const aggregateNext = this.at("Identifier") && AGGREGATE_FUNCTIONS.includes(this.peek().text) && this.peek(1).kind === "LParen";
            if (!this.at("Identifier") || (this.atStatementStart() && !aliasNext && !aggregateNext)) {
              this.diagnostics.error(DiagnosticCode.SyntaxError, `Expected a field after ',' in 'select', found ${describe(this.peek())}`, this.peek().span);
              break;
            }
          }
        } else {
          this.diagnostics.error(DiagnosticCode.SyntaxError, `Expected the fields to select after 'select', like 'select tranid, amount', found ${describe(this.peek())}`, this.peek().span);
        }
        return { kind: "SelectClause", keywordSpan: word.span, items, span: spanFrom(word.span, (items[items.length - 1] ?? { span: word.span }).span) };
      }
      case "order": {
        let bySpan: Span | undefined;
        const keys: SortKey[] = [];
        if (this.at("Identifier") && this.peek().text === "by") {
          bySpan = this.next().span;
          if (this.at("Identifier")) {
            for (;;) {
              const field = this.parseFieldPath();
              let direction: SortKey["direction"];
              let directionSpan: Span | undefined;
              if (this.at("Identifier") && (this.peek().text === "asc" || this.peek().text === "desc")) {
                const token = this.next();
                direction = token.text as "asc" | "desc";
                directionSpan = token.span;
              }
              keys.push({ kind: "SortKey", field, direction, directionSpan, span: spanFrom(field.span, directionSpan ?? field.span) });
              if (!this.at("Comma")) break;
              this.next();
              if (!this.at("Identifier") || this.atStatementStart()) {
                this.diagnostics.error(DiagnosticCode.SyntaxError, `Expected a field after ',' in 'order by', found ${describe(this.peek())}`, this.peek().span);
                break;
              }
            }
          } else {
            this.diagnostics.error(DiagnosticCode.SyntaxError, `Expected a field to sort by after 'order by', like 'order by trandate desc', found ${describe(this.peek())}`, this.peek().span);
          }
        } else {
          this.diagnostics.error(DiagnosticCode.SyntaxError, `Expected 'by' after 'order', as in 'order by trandate desc', found ${describe(this.peek())}`, this.peek().span);
        }
        const end = keys[keys.length - 1]?.span ?? bySpan ?? word.span;
        return { kind: "OrderByClause", keywordSpan: word.span, bySpan, keys, span: spanFrom(word.span, end) };
      }
      case "group": {
        let bySpan: Span | undefined;
        const fields: Expression[] = [];
        if (this.at("Identifier") && this.peek().text === "by") {
          bySpan = this.next().span;
          if (this.at("Identifier")) {
            for (;;) {
              fields.push(this.parseFieldPath());
              if (!this.at("Comma")) break;
              this.next();
              if (!this.at("Identifier") || this.atStatementStart()) {
                this.diagnostics.error(DiagnosticCode.SyntaxError, `Expected a field after ',' in 'group by', found ${describe(this.peek())}`, this.peek().span);
                break;
              }
            }
          } else {
            this.diagnostics.error(DiagnosticCode.SyntaxError, `Expected a field to group by after 'group by', like 'group by entity', found ${describe(this.peek())}`, this.peek().span);
          }
        } else {
          this.diagnostics.error(DiagnosticCode.SyntaxError, `Expected 'by' after 'group', as in 'group by entity', found ${describe(this.peek())}`, this.peek().span);
        }
        const end = fields[fields.length - 1]?.span ?? bySpan ?? word.span;
        return { kind: "GroupByClause", keywordSpan: word.span, bySpan, fields, span: spanFrom(word.span, end) };
      }
      case "limit": {
        let count: Expression | undefined;
        if (EXPRESSION_START.has(this.peek().kind)) count = this.parsePrimary();
        else this.diagnostics.error(DiagnosticCode.SyntaxError, `Expected the number of rows after 'limit', like 'limit 100', found ${describe(this.peek())}`, this.peek().span);
        return { kind: "LimitClause", keywordSpan: word.span, count, span: spanFrom(word.span, count?.span ?? word.span) };
      }
      case "first":
        return { kind: "FirstClause", keywordSpan: word.span, span: word.span };
      case "take":
        // The pre-release spelling of `limit`.
        this.fail("Search limits are written with 'limit', like 'limit 100'; 'take' is no longer part of Mynt (and 'first' returns one optional row)", word.span);
      default:
        throw new Error(`${word.text} is not a search clause`);
    }
  }

  /**
   * A list cut short at a line's end: the next line begins a statement
   * rather than continuing the list. A statement word, or a name (with
   * member accesses) that is called or assigned, is not a field.
   */
  private atStatementStart(): boolean {
    const token = this.peek();
    if (token.kind !== "Identifier") return false;
    if (STATEMENT_START_WORDS.includes(token.text) && this.peek(1).kind !== "Comma" && this.peek(1).kind !== "Dot") return true;
    let i = 1;
    while (this.peek(i).kind === "Dot" && this.peek(i + 1).kind === "Identifier") i += 2;
    return this.peek(i).kind === "LParen" || this.peek(i).kind === "Equals";
  }

  /**
   * One `select` item: a field path, or `name = aggregate(field)`. The
   * aggregate names are recognized only here, before `(`; `name = field`
   * and a bare aggregate are kept with their parts so the binder can say
   * what is missing.
   */
  private parseSelectItem(): SelectItem {
    let alias: Identifier | undefined;
    let equalsSpan: Span | undefined;
    if (this.at("Identifier") && this.peek(1).kind === "Equals") {
      alias = this.parseIdentifier("as the result name");
      equalsSpan = this.next().span;
    }
    let value: Expression | AggregateCall;
    if (this.at("Identifier") && AGGREGATE_FUNCTIONS.includes(this.peek().text) && this.peek(1).kind === "LParen") {
      const name = this.parseIdentifier();
      this.next(); // (
      let argument: Expression | undefined;
      if (this.at("Identifier")) argument = this.parseFieldPath();
      else if (!this.at("RParen")) {
        this.diagnostics.error(DiagnosticCode.SyntaxError, `Expected a field inside '${name.name}(...)', like '${name.name}(amount)', found ${describe(this.peek())}`, this.peek().span);
      }
      let closeSpan: Span | undefined;
      if (this.at("RParen")) closeSpan = this.next().span;
      else this.diagnostics.error(DiagnosticCode.SyntaxError, `Expected ')' to close '${name.name}(', found ${describe(this.peek())}`, this.peek().span);
      value = { kind: "AggregateCall", function: name, argument, closeSpan, span: spanFrom(name.span, closeSpan ?? argument?.span ?? name.span) };
    } else if (this.at("Identifier") && this.peek(1).kind === "LParen") {
      // A call that is not an aggregate: name the aggregates, and skip the call so the clause ends cleanly.
      const name = this.parseIdentifier();
      this.diagnostics.error(DiagnosticCode.InvalidAggregate, `'${name.name}' is not an aggregate; 'select' aggregates with sum, count, min, max, and avg`, name.span);
      this.skipBalancedParens();
      value = { kind: "Identifier", name: "", span: name.span };
    } else if (this.at("Identifier")) {
      value = this.parseFieldPath();
    } else {
      this.diagnostics.error(DiagnosticCode.SyntaxError, `Expected an aggregate after '${alias?.name ?? ""} =', like '${alias?.name ?? "total"} = sum(amount)', found ${describe(this.peek())}`, this.peek().span);
      value = { kind: "Identifier", name: "", span: this.peek().span };
    }
    const start = alias?.span ?? value.span;
    return { kind: "SelectItem", alias, equalsSpan, value, span: spanFrom(start, value.span) };
  }

  /** `field` or `field.field` in a `select` or `order by`: a path of names, never a call, so a following `asc`/`desc` is not read as a type argument. */
  private parseFieldPath(): Expression {
    let expression: Expression = this.parseIdentifier("as a field");
    while (this.at("Dot")) {
      this.next();
      const property = this.parseIdentifier("after '.'");
      expression = { kind: "MemberExpression", object: expression, property, span: spanFrom(expression.span, property.span) };
    }
    return expression;
  }

  /** A statement ends at a terminator, or right before the closing brace (or the end of an unclosed file). */
  private endStatement(): void {
    if (this.at("Terminator")) {
      this.next();
      return;
    }
    if (this.at("RBrace") || this.at("EOF")) return;
    this.fail(`Expected end of statement, found ${describe(this.peek())}`, this.peek().span);
  }

  private parseExpression(): Expression {
    return this.parseBinary(0);
  }

  /**
   * Precedence climbing. Parses operators binding at least as tightly as
   * `minPrecedence`, so a right operand never absorbs a looser operator.
   * A left-associative operator parses its right operand one level tighter
   * than itself, so `a && b && c` is `(a && b) && c`.
   */
  private parseBinary(minPrecedence: number): Expression {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      const entry = BINARY_OPERATORS[token.kind];
      if (!entry || entry.precedence < minPrecedence) return left;
      this.next();
      this.expectExpressionStart(`after '${entry.operator}'`);
      const right = this.parseBinary(entry.precedence + 1);
      left = {
        kind: "BinaryExpression",
        operator: entry.operator,
        operatorSpan: token.span,
        left,
        right,
        span: spanFrom(left.span, right.span),
      };

      // Comparisons do not chain: `a == b == c` compares a boolean with c, which
      // is never what was meant.
      const next = BINARY_OPERATORS[this.peek().kind];
      if (entry.associativity === "none" && next && next.precedence === entry.precedence) {
        this.fail(
          `Comparisons cannot be chained ('${entry.operator}' followed by '${next.operator}'); compare one pair at a time`,
          this.peek().span,
        );
      }
    }
  }

  private parseUnary(): Expression {
    if (this.at("Bang")) {
      const token = this.next();
      this.expectExpressionStart("after '!'");
      const operand = this.parseUnary();
      const unary: UnaryExpression = {
        kind: "UnaryExpression",
        operator: "!",
        operatorSpan: token.span,
        operand,
        span: spanFrom(token.span, operand.span),
      };
      return unary;
    }
    return this.parsePostfix();
  }

  private expectExpressionStart(context: string): void {
    if (!EXPRESSION_START.has(this.peek().kind)) {
      this.fail(`Expected an expression ${context}, found ${describe(this.peek())}`, this.peek().span);
    }
  }

  private parsePostfix(): Expression {
    let expression = this.parsePrimary();
    for (;;) {
      if (this.at("Dot")) {
        const dot = this.next();
        if (!this.at("Identifier")) {
          // `customer.` with nothing after it: report, and keep a member
          // access with an empty name so the receiver still binds. The
          // binder stays silent about the empty name.
          const found = this.peek();
          this.diagnostics.error(DiagnosticCode.SyntaxError, `Expected identifier after '.', found ${describe(found)}`, found.span);
          const property: Identifier = { kind: "Identifier", name: "", span: { start: dot.span.end, end: dot.span.end } };
          return { kind: "MemberExpression", object: expression, property, span: spanFrom(expression.span, dot.span) };
        }
        const property = this.parseIdentifier("after '.'");
        expression = {
          kind: "MemberExpression",
          object: expression,
          property,
          span: spanFrom(expression.span, property.span),
        };
      } else if (
        this.at("Identifier") &&
        this.peek().text === "to" &&
        expression.kind === "CallExpression" &&
        expression.typeArgument &&
        !expression.targetType
      ) {
        // `transform SalesOrder("1") to Invoice`: a target record type.
        const toSpan = this.next().span;
        const targetType = this.parseIdentifier("as the target record type after 'to'");
        expression = { ...expression, targetType, toSpan, span: spanFrom(expression.span, targetType.span) };
      } else if (
        this.at("LParen") ||
        (this.at("Identifier") && (expression.kind === "Identifier" || this.peek(1).kind === "LParen"))
      ) {
        // `callee(args)`, `callee Type(args)`, or `callee Type`: after a bare
        // identifier, a record type alone is a call with no argument list, as
        // in `create Customer`. A literal or member followed by a name is not.
        const typeArgument = this.at("Identifier") ? this.parseIdentifier() : undefined;
        let args: Expression[] = [];
        let end = typeArgument?.span ?? expression.span;
        if (this.at("LParen")) {
          this.next();
          args = this.parseArguments();
          end = this.expect("RParen", "to close the argument list").span;
        }
        expression = {
          kind: "CallExpression",
          callee: expression,
          typeArgument,
          arguments: args,
          targetType: undefined,
          toSpan: undefined,
          span: spanFrom(expression.span, end),
        };
      } else if (this.at("LBracket")) {
        expression = this.parseProjection(expression);
      } else if (this.at("String") && this.peek(1).kind === "LParen") {
        // `load "Customer"(123)`: a quoted name where a record type belongs.
        const token = this.peek();
        this.fail(
          `Expected a record type name before the argument list, found string ${token.text}. ` +
            `Record types are written without quotes, like ${token.value ?? "Customer"}(...)`,
          token.span,
        );
      } else {
        return expression;
      }
    }
  }

  /**
   * `receiver[field, field]`. A projection that is cut short (`x[`, `x[email,`
   * at the end of a line) is reported and kept with the fields read so far,
   * so the receiver still binds and completion can offer its fields.
   */
  private parseProjection(receiver: Expression): ProjectionExpression {
    const open = this.next();
    const fields: Identifier[] = [];
    const incomplete = (found: Token): ProjectionExpression => {
      this.diagnostics.error(DiagnosticCode.SyntaxError, `Expected ']' to close the field list, found ${describe(found)}`, found.span);
      return { kind: "ProjectionExpression", receiver, fields, openSpan: open.span, closeSpan: undefined, span: spanFrom(receiver.span, fields[fields.length - 1]?.span ?? open.span) };
    };
    if (this.at("RBracket")) {
      this.fail(`Expected at least one field inside '[...]', like ${describeExpression(receiver)}[email]`, this.peek().span);
    }
    for (;;) {
      if (this.at("String")) {
        const token = this.peek();
        this.fail(`Expected a field name inside '[...]', found string ${token.text}. Fields are written without quotes, like [${token.value ?? "email"}]`, token.span);
      }
      if (this.at("Terminator") || this.at("EOF") || this.at("RBrace")) return incomplete(this.peek());
      fields.push(this.parseIdentifier("as a field name inside '[...]'"));
      if (this.at("Comma")) {
        this.next();
        continue;
      }
      if (this.at("RBracket")) {
        const close = this.next();
        return { kind: "ProjectionExpression", receiver, fields, openSpan: open.span, closeSpan: close.span, span: spanFrom(receiver.span, close.span) };
      }
      if (this.at("Terminator") || this.at("EOF") || this.at("RBrace")) return incomplete(this.peek());
      this.fail(`Expected ',' or ']' after the field name, found ${describe(this.peek())}`, this.peek().span);
    }
  }

  private parseArguments(): Expression[] {
    const args: Expression[] = [];
    if (this.at("RParen")) return args;
    for (;;) {
      args.push(this.parseExpression());
      if (this.at("Comma")) {
        this.next();
        continue;
      }
      if (this.at("RParen")) return args;
      this.fail(`Expected ',' or ')' after argument, found ${describe(this.peek())}`, this.peek().span);
    }
  }

  private parsePrimary(): Expression {
    const token = this.peek();
    if (token.kind === "Identifier" && BOOL_LITERALS.includes(token.text)) {
      this.next();
      const literal: BoolLiteral = { kind: "BoolLiteral", value: token.text === "true", span: token.span };
      return literal;
    }
    if (token.kind === "Identifier" && (QUERY_OPERATIONS as readonly string[]).includes(token.text) && this.peek(1).kind === "Identifier") {
      return this.parseQuery(token.text as QueryOperation);
    }
    if (token.kind === "Identifier") return this.parseIdentifier();
    if (token.kind === "LParen") {
      // Grouping. No node survives: the inner expression keeps its structure
      // and takes the parenthesized span, so diagnostics underline the parens.
      this.next();
      if (this.at("RParen")) {
        this.fail("Expected an expression inside the parentheses, found ')'", this.peek().span);
      }
      const inner = this.parseExpression();
      const close = this.at("RParen")
        ? this.next()
        : this.fail(`Expected ')' to close the parenthesized expression, found ${describe(this.peek())}`, this.peek().span);
      return { ...inner, span: spanFrom(token.span, close.span) };
    }
    if (token.kind === "String") {
      this.next();
      const literal: StringLiteral = { kind: "StringLiteral", value: token.value ?? "", span: token.span };
      return literal;
    }
    if (token.kind === "Number") {
      this.next();
      const literal: NumberLiteral = { kind: "NumberLiteral", value: token.number ?? 0, span: token.span };
      return literal;
    }
    this.fail(`Expected an expression, found ${describe(token)}`, token.span);
  }

  private parseIdentifier(context?: string): Identifier {
    const token = this.expect("Identifier", context ?? "");
    return { kind: "Identifier", name: token.text, span: token.span };
  }

  /** A name being declared. Literals cannot be declared, since they could never be referenced. */
  private parseBindingName(context: string): Identifier {
    const name = this.parseIdentifier(context);
    if (BOOL_LITERALS.includes(name.name)) {
      this.fail(`'${name.name}' is a boolean literal and cannot be used as a name`, name.span);
    }
    if (isPrimitiveTypeName(name.name)) {
      this.fail(`'${name.name}' is a builtin type and cannot be used as a name`, name.span);
    }
    return name;
  }
}
