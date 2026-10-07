import { DiagnosticBag, DiagnosticCode, spanFrom, type Span } from "../diagnostics.js";
import { tokenize } from "../lexer/lexer.js";
import type { Token, TokenKind } from "../lexer/tokens.js";
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
  type Parameter,
  type QueryExpression,
  type RemoveStatement,
  type ReturnStatement,
  type SaveStatement,
  type ScheduledDeclaration,
  type SourceFile,
  type Statement,
  type StringLiteral,
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
  Pipe: "'|'",
  Colon: "':'",
  Dot: "'.'",
  Equals: "'='",
  Comma: "','",
  EqualsEquals: "'=='",
  BangEquals: "'!='",
  Bang: "'!'",
  AmpAmp: "'&&'",
  PipePipe: "'||'",
  Arrow: "'->'",
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
  Less: { operator: "<", precedence: 4, associativity: "none" },
  LessEquals: { operator: "<=", precedence: 4, associativity: "none" },
  Greater: { operator: ">", precedence: 4, associativity: "none" },
  GreaterEquals: { operator: ">=", precedence: 4, associativity: "none" },
};

/** Tokens that can begin an expression. */
const EXPRESSION_START = new Set<TokenKind>(["Identifier", "String", "Number", "LParen", "Bang"]);

/**
 * Tokens that make a leading identifier part of an expression rather than a
 * statement keyword: `save.x`, `save = ...`, `save == ...`. `(` is handled
 * per keyword: `save(x)` is a call (and so not the save statement, whose
 * target is written without parentheses), while `if (x) {` is an if.
 */
const EXPRESSION_CONTINUATION = new Set<TokenKind>(["Dot", "Equals", ...(Object.keys(BINARY_OPERATORS) as TokenKind[])]);

/** `order.item` for a hint, or `...` for anything more complex. */
function describeExpression(expression: Expression): string {
  if (expression.kind === "Identifier") return expression.name;
  if (expression.kind === "MemberExpression") return `${describeExpression(expression.object)}.${expression.property.name}`;
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
 *   Function    := "fn" Identifier "(" (Parameter ("," Parameter)*)? ")" ("->" Identifier)? Block
 *   UserEvent   := Hook EventFilter? "(" Parameter ")" Block
 *   Hook        := "beforeSubmit" | "afterSubmit"
 *   Scheduled   := "scheduled" Block
 *   EventFilter := Identifier ("|" Identifier)*
 *   Parameter   := Identifier ":" Identifier
 *   Block       := "{" Statement* "}"
 *   Statement   := LetStatement | SaveStatement | DeleteStatement | RemoveStatement | AddStatement | ReturnStatement
 *                | IfStatement | ForStatement | Expression ("=" Expression)? Terminator?
 *   LetStatement:= "let" Identifier "=" Expression Terminator?
 *   SaveStatement:= "save" Expression Terminator?
 *   DeleteStatement:= "delete" Expression Terminator?
 *   RemoveStatement:= "remove" Expression Terminator?
 *   AddStatement:= "add" Expression Block Terminator?
 *   ReturnStatement:= "return" Expression? Terminator?
 *   IfStatement := "if" Expression Block ("else" Block)? Terminator?
 *   ForStatement:= "for" Identifier "in" Expression Block Terminator?
 *   Expression  := Binary
 *   Binary      := Unary (BinaryOperator Unary)*            (precedence climbing; see BINARY_OPERATORS)
 *   BinaryOperator := "||" | "&&" | "==" | "!=" | "<" | "<=" | ">" | ">="
 *   Unary       := "!" Unary | Postfix
 *   Postfix     := Primary ("." Identifier | TypeArgument ("(" Arguments ")")? ("to" TypeArgument)? | "(" Arguments ")")*
 *   TypeArgument:= Identifier
 *   Arguments   := (Expression ("," Expression)*)?
 *   Primary     := Identifier | String | Number | "true" | "false" | "(" Expression ")" | Query
 *   Query       := "query" Identifier (Terminator? "where" Expression)?
 *
 * Declaration keywords, `let`, `save`, `if`, `else`, event names, and built-in
 * names are contextual: they are ordinary identifiers that the parser
 * (declarations, `let`, `save`, `if`) and binder (events, built-ins such as
 * `log` and `load`, record types such as `Customer`) interpret by position.
 * `true` and `false` are literals wherever an expression is expected.
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
    if (this.at("Arrow")) {
      this.next();
      returnType = this.parseIdentifier("as the return type after '->'");
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
    const initializer = this.parseExpression();
    return {
      kind: "LetStatement",
      keywordSpan: keyword.span,
      name,
      initializer,
      span: spanFrom(keyword.span, initializer.span),
    };
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

  private parseQuery(): QueryExpression {
    const keyword = this.next();
    const recordType = this.parseIdentifier("as the record type to query");
    let condition: Expression | undefined;
    let whereSpan: Span | undefined;
    // `where` may start the next line: look past one terminator for it.
    const whereAt = this.at("Terminator") ? 1 : 0;
    const where = this.peek(whereAt);
    if (where.kind === "Identifier" && where.text === "where") {
      if (whereAt === 1) this.next();
      whereSpan = this.next().span;
      if (!EXPRESSION_START.has(this.peek().kind)) {
        this.fail(`Expected a condition after 'where', found ${describe(this.peek())}`, this.peek().span);
      }
      condition = this.parseExpression();
    }
    return {
      kind: "QueryExpression",
      keywordSpan: keyword.span,
      recordType,
      whereSpan,
      condition,
      span: spanFrom(keyword.span, (condition ?? recordType).span),
    };
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

      // Comparisons do not chain: `a == b == c` compares a Bool with c, which
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
      } else if (this.at("String") && this.peek(1).kind === "LParen") {
        // `load "Customer"("123")`: a quoted name where a record type belongs.
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
    if (token.kind === "Identifier" && token.text === "query" && this.peek(1).kind === "Identifier") return this.parseQuery();
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
      this.fail(`'${name.name}' is a Bool literal and cannot be used as a name`, name.span);
    }
    return name;
  }
}
