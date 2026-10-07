import { describe, expect, it } from "vitest";
import { DiagnosticBag } from "../src/diagnostics.js";
import { tokenize } from "../src/lexer/lexer.js";
import { parse } from "../src/parser/parser.js";

function parseSource(source: string) {
  const diagnostics = new DiagnosticBag("test.sail");
  const ast = parse(source, "test.sail", diagnostics);
  return { ast, diagnostics: diagnostics.items };
}

describe("lexer", () => {
  it("inserts statement terminators at newlines only after statement-ending tokens", () => {
    const kinds = tokenize(`a\n.b = "x"\n\n}`, new DiagnosticBag("t")).map((t) => t.kind);
    expect(kinds).toEqual(["Identifier", "Terminator", "Dot", "Identifier", "Equals", "String", "Terminator", "RBrace", "EOF"]);
  });

  it("decodes string escapes and tracks positions", () => {
    const [token] = tokenize(`"a\\"b\\n"`, new DiagnosticBag("t"));
    expect(token!.value).toBe('a"b\n');
    expect(token!.span.end).toEqual({ offset: 8, line: 1, column: 9 });
  });

  it("skips line comments", () => {
    const kinds = tokenize(`a // comment\nb`, new DiagnosticBag("t")).map((t) => t.kind);
    expect(kinds).toEqual(["Identifier", "Terminator", "Identifier", "EOF"]);
  });

  it("reports unterminated strings and unexpected characters", () => {
    const bag = new DiagnosticBag("t");
    tokenize(`"open\n@`, bag);
    expect(bag.items.map((d) => d.message)).toEqual(["Unterminated string literal", "Unexpected character '@'"]);
  });
});

describe("parser", () => {
  it("parses an entry point with an event filter", () => {
    const { ast, diagnostics } = parseSource(`beforeSubmit create | edit (customer: Customer) {\n    customer.comments = "Managed by Sail"\n}\n`);
    expect(diagnostics).toEqual([]);
    expect(ast.declarations).toHaveLength(1);
    const decl = ast.declarations[0]!;
    expect(decl.hook).toBe("beforeSubmit");
    expect(decl.events.map((e) => e.name)).toEqual(["create", "edit"]);
    expect(decl.parameter.name.name).toBe("customer");
    expect(decl.parameter.type.name).toBe("Customer");
    expect(decl.body.statements[0]).toMatchObject({
      kind: "AssignmentStatement",
      target: { kind: "MemberExpression", object: { name: "customer" }, property: { name: "comments" } },
      value: { kind: "StringLiteral", value: "Managed by Sail" },
    });
  });

  it("accepts semicolons and single-line bodies", () => {
    const { ast, diagnostics } = parseSource(`afterSubmit create (c: Customer) { c.email = "a"; c.comments = "b" }`);
    expect(diagnostics).toEqual([]);
    expect(ast.declarations[0]!.body.statements).toHaveLength(2);
  });

  it("reports a located syntax error and recovers at the next entry point", () => {
    const { ast, diagnostics } = parseSource(`beforeSubmit create (customer Customer) {\n}\nafterSubmit create (c: Customer) {\n}\n`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe("SAIL0001");
    expect(diagnostics[0]!.message).toBe("Expected ':' after the parameter name, found 'Customer'");
    expect(diagnostics[0]!.span.start).toMatchObject({ line: 1, column: 31 });
    expect(ast.declarations.map((d) => d.hook)).toEqual(["afterSubmit"]);
  });

  it("rejects statements at file level", () => {
    const { diagnostics } = parseSource(`customer.comments = "x"\n`);
    expect(diagnostics[0]!.message).toContain("Expected an entry point (beforeSubmit, afterSubmit, scheduled) or a function (fn) at file level");
  });

  it("rejects two statements on one line without a separator", () => {
    const { diagnostics } = parseSource(`beforeSubmit (c: Customer) { c.email = "a" c.comments = "b" }`);
    expect(diagnostics[0]!.message).toBe("Expected end of statement, found 'c'");
  });
});

describe("parser: scheduled and calls", () => {
  it("parses a scheduled block", () => {
    const { ast, diagnostics } = parseSource(`scheduled {\n    log.debug("Hello from Sail")\n}\n`);
    expect(diagnostics).toEqual([]);
    const decl = ast.declarations[0]!;
    expect(decl.kind).toBe("ScheduledDeclaration");
    expect(decl.span.start).toMatchObject({ line: 1, column: 1 });
    expect(decl.body.statements).toHaveLength(1);
  });

  it("parses a member call with a string argument", () => {
    const { ast } = parseSource(`scheduled {\n    log.debug("Hello")\n}\n`);
    const statement = ast.declarations[0]!.body.statements[0]!;
    expect(statement).toMatchObject({
      kind: "ExpressionStatement",
      expression: {
        kind: "CallExpression",
        callee: { kind: "MemberExpression", object: { name: "log" }, property: { name: "debug" } },
        arguments: [{ kind: "StringLiteral", value: "Hello" }],
      },
    });
    expect(statement.span.start).toMatchObject({ line: 2, column: 5 });
    expect(statement.span.end).toMatchObject({ line: 2, column: 23 });
  });

  it("parses zero and multiple arguments and chained postfix", () => {
    const { ast, diagnostics } = parseSource(`scheduled { log.debug(); log.debug("a", "b"); log.debug("a").x }`);
    expect(diagnostics).toEqual([]);
    const [zero, two, chained] = ast.declarations[0]!.body.statements;
    expect(zero).toMatchObject({ expression: { kind: "CallExpression", arguments: [] } });
    expect(two).toMatchObject({ expression: { kind: "CallExpression", arguments: [{ value: "a" }, { value: "b" }] } });
    expect(chained).toMatchObject({ expression: { kind: "MemberExpression", object: { kind: "CallExpression" } } });
  });

  it("reports an unclosed argument list", () => {
    const { diagnostics } = parseSource(`scheduled {\n    log.debug("Hello"\n}\n`);
    expect(diagnostics[0]!.message).toBe("Expected ',' or ')' after argument, found end of statement");
    expect(diagnostics[0]!.span.start).toMatchObject({ line: 2, column: 22 });
  });

  it("reports a missing argument after a comma", () => {
    const { diagnostics } = parseSource(`scheduled { log.debug("a", ) }`);
    expect(diagnostics[0]!.message).toBe("Expected an expression, found ')'");
  });

  it("requires a body after scheduled", () => {
    const { diagnostics } = parseSource(`scheduled\n`);
    expect(diagnostics[0]!.message).toBe("Expected '{' to begin the entry point body, found end of statement");
  });

  it("does not treat log or debug as keywords", () => {
    const { diagnostics } = parseSource(`beforeSubmit create (log: Customer) {\n    log.debug = "x"\n}\n`);
    expect(diagnostics).toEqual([]);
  });
});

describe("parser: let and record-type arguments", () => {
  it("parses a let declaration with a record-type call initializer", () => {
    const { ast, diagnostics } = parseSource(`scheduled {\n    let customer = load Customer("123")\n}\n`);
    expect(diagnostics).toEqual([]);
    const statement = ast.declarations[0]!.body.statements[0]!;
    expect(statement).toMatchObject({
      kind: "LetStatement",
      name: { name: "customer" },
      initializer: {
        kind: "CallExpression",
        callee: { kind: "Identifier", name: "load" },
        typeArgument: { kind: "Identifier", name: "Customer" },
        arguments: [{ kind: "StringLiteral", value: "123" }],
      },
    });
    expect(statement.span.start).toMatchObject({ line: 2, column: 5 });
    expect(statement.span.end).toMatchObject({ line: 2, column: 40 });
    if (statement.kind !== "LetStatement") throw new Error("expected let");
    expect(statement.keywordSpan.end.column).toBe(8);
    expect(statement.initializer.kind === "CallExpression" && statement.initializer.typeArgument?.span.start.column).toBe(25);
  });

  it("parses member access on a local as an argument", () => {
    const { ast, diagnostics } = parseSource(`scheduled {\n    log.debug(customer.email)\n}\n`);
    expect(diagnostics).toEqual([]);
    expect(ast.declarations[0]!.body.statements[0]).toMatchObject({
      expression: {
        kind: "CallExpression",
        typeArgument: undefined,
        arguments: [{ kind: "MemberExpression", object: { name: "customer" }, property: { name: "email" } }],
      },
    });
  });

  it("requires an initializer", () => {
    const { diagnostics } = parseSource(`scheduled {\n    let customer\n}\n`);
    expect(diagnostics[0]!.message).toBe("Expected '=' after 'let customer' (an initializer is required), found end of statement");
  });

  it("does not yet accept a type annotation", () => {
    const { diagnostics } = parseSource(`scheduled {\n    let customer: Customer = load Customer("1")\n}\n`);
    expect(diagnostics[0]!.message).toBe("Expected '=' after 'let customer' (an initializer is required), found ':'");
  });

  it("explains a quoted name in record-type position", () => {
    const { diagnostics } = parseSource(`scheduled {\n    let x = load "Customer"("123")\n}\n`);
    expect(diagnostics[0]!.message).toBe(
      'Expected a record type name before the argument list, found string "Customer". Record types are written without quotes, like Customer(...)',
    );
    expect(diagnostics[0]!.span.start).toMatchObject({ line: 2, column: 18 });
  });

  it("treats let as an ordinary identifier when no name follows", () => {
    const { ast, diagnostics } = parseSource(`scheduled {\n    let.x\n}\n`);
    expect(diagnostics).toEqual([]);
    expect(ast.declarations[0]!.body.statements[0]).toMatchObject({ kind: "ExpressionStatement" });
  });
});

describe("parser: save", () => {
  it("parses save with a local target", () => {
    const { ast, diagnostics } = parseSource(`scheduled {\n    save customer\n}\n`);
    expect(diagnostics).toEqual([]);
    const statement = ast.declarations[0]!.body.statements[0]!;
    expect(statement).toMatchObject({ kind: "SaveStatement", target: { kind: "Identifier", name: "customer" } });
    expect(statement.span.start).toMatchObject({ line: 2, column: 5 });
    expect(statement.span.end).toMatchObject({ line: 2, column: 18 });
    if (statement.kind !== "SaveStatement") throw new Error("expected save");
    expect(statement.keywordSpan.end.column).toBe(9);
  });

  it("parses save with an expression target and leaves validation to the binder", () => {
    const { ast, diagnostics } = parseSource(`scheduled { save customer.email }`);
    expect(diagnostics).toEqual([]);
    expect(ast.declarations[0]!.body.statements[0]).toMatchObject({
      kind: "SaveStatement",
      target: { kind: "MemberExpression" },
    });
  });

  it("reports a bare save", () => {
    const { diagnostics } = parseSource(`scheduled {\n    save\n}\n`);
    expect(diagnostics[0]!.message).toBe("Expected a record to save after 'save', found end of statement");
    expect(diagnostics[0]!.span.start).toMatchObject({ line: 2, column: 9 });
  });

  it("parses a name after the save target as a type argument, which the binder then rejects", () => {
    const { ast, diagnostics } = parseSource(`scheduled { save customer now }`);
    expect(diagnostics).toEqual([]);
    expect(ast.declarations[0]!.body.statements[0]).toMatchObject({
      kind: "SaveStatement",
      target: { kind: "CallExpression", callee: { name: "customer" }, typeArgument: { name: "now" }, arguments: [] },
    });
  });

  it("does not make save a keyword elsewhere", () => {
    const { ast, diagnostics } = parseSource(`scheduled {\n    let save = load Customer("1")\n    save.comments = "x"\n    save save\n    save("x")\n}\n`);
    expect(diagnostics).toEqual([]);
    expect(ast.declarations[0]!.body.statements.map((s) => s.kind)).toEqual([
      "LetStatement",
      "AssignmentStatement",
      "SaveStatement",
      "ExpressionStatement",
    ]);
  });

  it("does not turn other identifiers into commands", () => {
    const { ast, diagnostics } = parseSource(`scheduled { submit customer }`);
    expect(diagnostics).toEqual([]);
    expect(ast.declarations[0]!.body.statements[0]).toMatchObject({
      kind: "ExpressionStatement",
      expression: { kind: "CallExpression", callee: { name: "submit" }, typeArgument: { name: "customer" } },
    });
  });
});

describe("lexer: comparison operators and numbers", () => {
  it("gives a final single-character token a one-character span", () => {
    for (const source of ["a.", "a}", "a<", "a="]) {
      const tokens = tokenize(source, new DiagnosticBag("t"));
      expect(tokens[1]!.span).toMatchObject({ start: { offset: 1 }, end: { offset: 2 } });
      expect(tokens[2]!.kind).toBe("EOF");
    }
  });

  it("tokenizes two-character operators before one-character ones", () => {
    const kinds = tokenize(`a == b != c < d <= e > f >= g = h`, new DiagnosticBag("t")).map((t) => t.kind);
    expect(kinds).toEqual([
      "Identifier", "EqualsEquals", "Identifier", "BangEquals", "Identifier", "Less", "Identifier", "LessEquals",
      "Identifier", "Greater", "Identifier", "GreaterEquals", "Identifier", "Equals", "Identifier", "EOF",
    ]);
  });

  it("tokenizes integer and decimal numbers and terminates statements after them", () => {
    const tokens = tokenize(`10\n3.25`, new DiagnosticBag("t"));
    expect(tokens.map((t) => t.kind)).toEqual(["Number", "Terminator", "Number", "EOF"]);
    expect(tokens[0]!.number).toBe(10);
    expect(tokens[2]!.number).toBe(3.25);
  });

  it("does not continue a statement across a newline after a comparison operator", () => {
    const kinds = tokenize(`a ==\n"x"`, new DiagnosticBag("t")).map((t) => t.kind);
    expect(kinds).toEqual(["Identifier", "EqualsEquals", "String", "EOF"]);
  });

  it("tokenizes logical operators, not, and grouping parentheses", () => {
    const kinds = tokenize(`!(a && b) || c`, new DiagnosticBag("t")).map((t) => t.kind);
    expect(kinds).toEqual(["Bang", "LParen", "Identifier", "AmpAmp", "Identifier", "RParen", "PipePipe", "Identifier", "EOF"]);
  });

  it("keeps a single pipe for event filters and rejects a lone ampersand", () => {
    const bag = new DiagnosticBag("t");
    const kinds = tokenize(`a | b & c`, bag).map((t) => t.kind);
    expect(kinds).toEqual(["Identifier", "Pipe", "Identifier", "Identifier", "EOF"]);
    expect(bag.items.map((d) => d.message)).toEqual(["Unexpected character '&'"]);
  });
});

describe("parser: if and comparisons", () => {
  it("parses a simple if with an equality condition", () => {
    const { ast, diagnostics } = parseSource(`scheduled {\n    if customer.email == "" {\n        save customer\n    }\n}\n`);
    expect(diagnostics).toEqual([]);
    const statement = ast.declarations[0]!.body.statements[0]!;
    expect(statement).toMatchObject({
      kind: "IfStatement",
      condition: {
        kind: "BinaryExpression",
        operator: "==",
        left: { kind: "MemberExpression", object: { name: "customer" }, property: { name: "email" } },
        right: { kind: "StringLiteral", value: "" },
      },
      thenBlock: { statements: [{ kind: "SaveStatement" }] },
      elseBlock: undefined,
    });
    expect(statement.span.start).toMatchObject({ line: 2, column: 5 });
    expect(statement.span.end).toMatchObject({ line: 4, column: 6 });
    if (statement.kind !== "IfStatement" || statement.condition.kind !== "BinaryExpression") throw new Error();
    expect(statement.condition.operatorSpan.start).toMatchObject({ line: 2, column: 23 });
  });

  it("parses if/else", () => {
    const { ast, diagnostics } = parseSource(`scheduled {\n    if a == "" {\n        log.debug("yes")\n    } else {\n        log.debug("no")\n    }\n}\n`);
    expect(diagnostics).toEqual([]);
    const statement = ast.declarations[0]!.body.statements[0]!;
    expect(statement).toMatchObject({
      kind: "IfStatement",
      thenBlock: { statements: [{ kind: "ExpressionStatement" }] },
      elseBlock: { statements: [{ kind: "ExpressionStatement" }] },
    });
    expect(statement.span.end).toMatchObject({ line: 6, column: 6 });
  });

  it("parses inequality and relational operators with number literals", () => {
    const { ast, diagnostics } = parseSource(`scheduled { if a != "x" { }; if b < 10 { }; if c <= 2.5 { }; if d > 0 { }; if e >= 1 { } }`);
    expect(diagnostics).toEqual([]);
    const operators = ast.declarations[0]!.body.statements.map((s) => s.kind === "IfStatement" && s.condition.kind === "BinaryExpression" ? s.condition.operator : null);
    expect(operators).toEqual(["!=", "<", "<=", ">", ">="]);
    const second = ast.declarations[0]!.body.statements[2]!;
    expect(second).toMatchObject({ condition: { right: { kind: "NumberLiteral", value: 2.5 } } });
  });

  it("binds postfix tighter than comparison", () => {
    const { ast } = parseSource(`scheduled { if load Customer("1").email == a.b { } }`);
    const statement = ast.declarations[0]!.body.statements[0]!;
    expect(statement).toMatchObject({
      condition: {
        kind: "BinaryExpression",
        left: { kind: "MemberExpression", object: { kind: "CallExpression", typeArgument: { name: "Customer" } } },
        right: { kind: "MemberExpression", object: { name: "a" }, property: { name: "b" } },
      },
    });
  });

  it("parses nested blocks and an if inside else", () => {
    const { ast, diagnostics } = parseSource(
      `scheduled {\n    if a == "" {\n        if b == "" {\n            save a\n        }\n    } else {\n        if c == "" {\n        }\n    }\n}\n`,
    );
    expect(diagnostics).toEqual([]);
    const outer = ast.declarations[0]!.body.statements[0]!;
    expect(outer).toMatchObject({
      thenBlock: { statements: [{ kind: "IfStatement", thenBlock: { statements: [{ kind: "SaveStatement" }] } }] },
      elseBlock: { statements: [{ kind: "IfStatement", elseBlock: undefined }] },
    });
  });

  it("allows a comparison as an expression statement and as a let initializer", () => {
    const { ast, diagnostics } = parseSource(`scheduled {\n    let empty = a.email == ""\n    a.email == ""\n}\n`);
    expect(diagnostics).toEqual([]);
    expect(ast.declarations[0]!.body.statements.map((s) => s.kind)).toEqual(["LetStatement", "ExpressionStatement"]);
  });

  it("rejects chained comparisons", () => {
    const { diagnostics } = parseSource(`scheduled { if a == b == c { } }`);
    expect(diagnostics[0]!.message).toBe("Comparisons cannot be chained ('==' followed by '=='); compare one pair at a time");
    expect(diagnostics[0]!.span.start).toMatchObject({ line: 1, column: 23 });
  });

  it("rejects a missing or malformed condition", () => {
    expect(parseSource(`scheduled { if { } }`).diagnostics[0]!.message).toBe("Expected a condition after 'if', found '{'");
    expect(parseSource(`scheduled { if a == { } }`).diagnostics[0]!.message).toBe("Expected an expression after '==', found '{'");
    expect(parseSource(`scheduled { if a == "" }`).diagnostics[0]!.message).toBe("Expected '{' after the if condition, found '}'");
  });

  it("accepts a parenthesized condition, since parentheses are ordinary grouping", () => {
    const { ast, diagnostics } = parseSource(`scheduled { if (a == "") { } }`);
    expect(diagnostics).toEqual([]);
    expect(ast.declarations[0]!.body.statements[0]).toMatchObject({ kind: "IfStatement", condition: { kind: "BinaryExpression", operator: "==" } });
  });

  it("requires the brace on the condition line and else on the closing-brace line", () => {
    expect(parseSource(`scheduled {\n    if a == ""\n    {\n    }\n}\n`).diagnostics[0]!.message).toBe(
      "The '{' must be on the same line as the if condition",
    );
    const { diagnostics } = parseSource(`scheduled {\n    if a == "" {\n    }\n    else {\n    }\n}\n`);
    expect(diagnostics[0]!.message).toBe("'else' must be on the same line as the '}' that closes the if block: write '} else {'");
    expect(diagnostics[0]!.span.start).toMatchObject({ line: 4, column: 5 });
  });

  it("rejects else if with a hint", () => {
    const { diagnostics } = parseSource(`scheduled { if a == "" { } else if b == "" { } }`);
    expect(diagnostics[0]!.message).toBe("'else if' is not supported; write 'else {' and nest the if inside");
  });

  it("reports an unclosed if block at end of file", () => {
    const { diagnostics } = parseSource(`scheduled {\n    if a == "" {\n        save a\n`);
    expect(diagnostics[0]!.message).toBe("Expected '}' to close the if block, found end of file");
  });

  it("does not treat if or else as keywords in expression position", () => {
    const { ast, diagnostics } = parseSource(`scheduled {\n    if.x = "a"\n    else.y = "b"\n    if == "c"\n}\n`);
    expect(diagnostics).toEqual([]);
    expect(ast.declarations[0]!.body.statements.map((s) => s.kind)).toEqual([
      "AssignmentStatement",
      "AssignmentStatement",
      "ExpressionStatement",
    ]);
  });

  it("requires a statement separator after an if block", () => {
    const { diagnostics } = parseSource(`scheduled { if a == "" { } save a }`);
    expect(diagnostics[0]!.message).toBe("Expected end of statement, found 'save'");
  });
});

describe("parser: logical operators, not, and grouping", () => {
  const condition = (source: string) => {
    const { ast, diagnostics } = parseSource(`scheduled { if ${source} { } }`);
    expect(diagnostics).toEqual([]);
    const statement = ast.declarations[0]!.body.statements[0]!;
    if (statement.kind !== "IfStatement") throw new Error();
    return statement.condition;
  };

  it("parses logical and, logical or, and unary not", () => {
    expect(condition(`a == "" && b == ""`)).toMatchObject({ kind: "BinaryExpression", operator: "&&", left: { operator: "==" }, right: { operator: "==" } });
    expect(condition(`a == "" || b == ""`)).toMatchObject({ kind: "BinaryExpression", operator: "||" });
    expect(condition(`!a`)).toMatchObject({ kind: "UnaryExpression", operator: "!", operand: { kind: "Identifier", name: "a" } });
  });

  it("gives && precedence over ||, and comparisons precedence over both", () => {
    expect(condition(`a == b && c != d || e == f`)).toMatchObject({
      operator: "||",
      left: { operator: "&&", left: { operator: "==" }, right: { operator: "!=" } },
      right: { operator: "==" },
    });
    expect(condition(`a || b && c`)).toMatchObject({ operator: "||", left: { name: "a" }, right: { operator: "&&" } });
    expect(condition(`a < 1 == b`)).toMatchObject({ operator: "==", left: { operator: "<" }, right: { name: "b" } });
  });

  it("makes && and || left-associative", () => {
    expect(condition(`a && b && c`)).toMatchObject({ operator: "&&", left: { operator: "&&", left: { name: "a" }, right: { name: "b" } }, right: { name: "c" } });
    expect(condition(`a || b || c`)).toMatchObject({ operator: "||", left: { operator: "||" }, right: { name: "c" } });
  });

  it("binds ! tighter than binary operators and looser than postfix", () => {
    expect(condition(`!a == b`)).toMatchObject({ operator: "==", left: { kind: "UnaryExpression" }, right: { name: "b" } });
    expect(condition(`!a.b`)).toMatchObject({ kind: "UnaryExpression", operand: { kind: "MemberExpression" } });
    expect(condition(`!!a`)).toMatchObject({ kind: "UnaryExpression", operand: { kind: "UnaryExpression", operand: { name: "a" } } });
    expect(condition(`!load Customer("1").email == ""`)).toMatchObject({ operator: "==", left: { kind: "UnaryExpression", operand: { kind: "MemberExpression" } } });
  });

  it("parses grouping and nested grouping without a dedicated node", () => {
    const grouped = condition(`(a || b) && c`);
    expect(grouped).toMatchObject({ operator: "&&", left: { operator: "||" }, right: { name: "c" } });
    expect(condition(`!(a == b)`)).toMatchObject({ kind: "UnaryExpression", operand: { operator: "==" } });
    expect(condition(`(a == b || (c == d && e == f)) && g == h`)).toMatchObject({
      operator: "&&",
      left: { operator: "||", right: { operator: "&&" } },
      right: { operator: "==" },
    });
    expect(condition(`((a))`)).toMatchObject({ kind: "Identifier", name: "a" });
  });

  it("widens a grouped expression's span to include the parentheses", () => {
    const grouped = condition(`(a || b) && c`);
    if (grouped.kind !== "BinaryExpression") throw new Error();
    expect(grouped.left.span.start).toMatchObject({ column: 16 });
    expect(grouped.left.span.end).toMatchObject({ column: 24 });
    expect(grouped.span.start).toMatchObject({ column: 16 });
  });

  it("parses true and false as literals", () => {
    expect(condition(`true`)).toMatchObject({ kind: "BoolLiteral", value: true });
    expect(condition(`false || a`)).toMatchObject({ operator: "||", left: { kind: "BoolLiteral", value: false } });
  });

  it("rejects true and false as names", () => {
    expect(parseSource(`scheduled { let true = "x" }`).diagnostics[0]!.message).toBe("'true' is a Bool literal and cannot be used as a name");
    expect(parseSource(`beforeSubmit (false: Customer) { }`).diagnostics[0]!.message).toBe("'false' is a Bool literal and cannot be used as a name");
  });

  it("keeps comparisons non-associative even next to logical operators", () => {
    expect(parseSource(`scheduled { if a == b == c && d { } }`).diagnostics[0]!.message).toContain("Comparisons cannot be chained");
    expect(parseSource(`scheduled { if a < b <= c { } }`).diagnostics[0]!.message).toBe("Comparisons cannot be chained ('<' followed by '<='); compare one pair at a time");
    expect(parseSource(`scheduled { if (a == b) == c { } }`).diagnostics).toEqual([]);
  });

  it("reports malformed logical expressions and grouping", () => {
    const message = (source: string) => parseSource(`scheduled { if ${source} { } }`).diagnostics[0]!.message;
    expect(message(`(a == "" `)).toBe("Expected ')' to close the parenthesized expression, found '{'");
    expect(message(`()`)).toBe("Expected an expression inside the parentheses, found ')'");
    expect(message(`a == "" &&`)).toBe("Expected an expression after '&&', found '{'");
    expect(message(`a && || b`)).toBe("Expected an expression after '&&', found '||'");
    expect(message(`!`)).toBe("Expected an expression after '!', found '{'");
    expect(message(`a || (b`)).toBe("Expected ')' to close the parenthesized expression, found '{'");
  });

  it("if ( is an if statement, save ( is still a call", () => {
    expect(parseSource(`scheduled { if (a) { } }`).diagnostics).toEqual([]);
    const { ast } = parseSource(`scheduled { save(a) }`);
    expect(ast.declarations[0]!.body.statements[0]).toMatchObject({ kind: "ExpressionStatement", expression: { kind: "CallExpression" } });
  });
});

describe("parser: create", () => {
  it("parses create Customer as a call with a type argument and no argument list", () => {
    const { ast, diagnostics } = parseSource(`scheduled {\n    let customer = create Customer\n}\n`);
    expect(diagnostics).toEqual([]);
    const statement = ast.declarations[0]!.body.statements[0]!;
    expect(statement).toMatchObject({
      kind: "LetStatement",
      initializer: { kind: "CallExpression", callee: { name: "create" }, typeArgument: { name: "Customer" }, arguments: [] },
    });
    if (statement.kind !== "LetStatement") throw new Error();
    expect(statement.initializer.span.end).toMatchObject({ line: 2, column: 35 });
  });

  it("also accepts an empty argument list, and a call form with arguments", () => {
    expect(parseSource(`scheduled { let c = create Customer() }`).diagnostics).toEqual([]);
    const { ast } = parseSource(`scheduled { let c = create Customer("x") }`);
    expect(ast.declarations[0]!.body.statements[0]).toMatchObject({ initializer: { arguments: [{ value: "x" }] } });
  });

  it("reports a missing record type and malformed forms", () => {
    expect(parseSource(`scheduled {\n    let c = create\n}\n`).diagnostics).toEqual([]);
    expect(parseSource(`scheduled { let c = create "Customer" }`).diagnostics[0]!.message).toBe("Expected end of statement, found string \"Customer\"");
    expect(parseSource(`scheduled { let c = create Customer. }`).diagnostics[0]!.message).toBe("Expected identifier after '.', found '}'");
  });

  it("keeps a statement whose terminator is bad and recovers on the same line", () => {
    const { ast, diagnostics } = parseSource(`beforeSubmit (c: Customer) { c.email = "a" c.comments = "b" }`);
    expect(diagnostics.map((d) => d.message)).toEqual(["Expected end of statement, found 'c'"]);
    expect(ast.declarations[0]!.body.statements).toHaveLength(1);
  });

  it("keeps a member access with a missing name", () => {
    const { ast, diagnostics } = parseSource(`scheduled {\n    customer.\n}\n`);
    expect(diagnostics.map((d) => d.message)).toEqual(["Expected identifier after '.', found '}'"]);
    expect(ast.declarations[0]!.body.statements[0]).toMatchObject({
      kind: "ExpressionStatement",
      expression: { kind: "MemberExpression", object: { name: "customer" }, property: { name: "" } },
    });
  });
});

describe("parser: delete and transform", () => {
  it("parses delete like save", () => {
    const { ast, diagnostics } = parseSource(`scheduled {\n    delete customer\n}\n`);
    expect(diagnostics).toEqual([]);
    expect(ast.declarations[0]!.body.statements[0]).toMatchObject({ kind: "DeleteStatement", target: { kind: "Identifier", name: "customer" } });
    expect(parseSource(`scheduled { delete }`).diagnostics[0]!.message).toBe("Expected a record to delete after 'delete', found '}'");
    expect(parseSource(`scheduled { delete.x = "a"; delete(1) }`).ast.declarations[0]!.body.statements.map((s) => s.kind)).toEqual([
      "AssignmentStatement",
      "ExpressionStatement",
    ]);
  });

  it("parses transform T(...) to U as a call with a target type", () => {
    const { ast, diagnostics } = parseSource(`scheduled {\n    let invoice = transform SalesOrder("123") to Invoice\n}\n`);
    expect(diagnostics).toEqual([]);
    const statement = ast.declarations[0]!.body.statements[0]!;
    expect(statement).toMatchObject({
      kind: "LetStatement",
      initializer: {
        kind: "CallExpression",
        callee: { name: "transform" },
        typeArgument: { name: "SalesOrder" },
        arguments: [{ value: "123" }],
        targetType: { name: "Invoice" },
      },
    });
    expect(statement.span.end).toMatchObject({ line: 2, column: 57 });
  });

  it("reports a missing target after to, and leaves to alone elsewhere", () => {
    expect(parseSource(`scheduled { let i = transform SalesOrder("1") to }`).diagnostics[0]!.message).toBe(
      "Expected identifier as the target record type after 'to', found '}'",
    );
    expect(parseSource(`scheduled { let i = transform SalesOrder("1") to Invoice to Other }`).diagnostics[0]!.message).toBe("Expected end of statement, found 'to'");
    const { ast } = parseSource(`scheduled { save to }`);
    expect(ast.declarations[0]!.body.statements[0]).toMatchObject({ kind: "SaveStatement", target: { name: "to" } });
  });
});

describe("parser: query and for", () => {
  it("parses query with and without a where, including a where on the next line", () => {
    const { ast, diagnostics } = parseSource(`scheduled {\n    let all = query Customer\n    let some = query Customer\n        where email != "" && isperson\n    let inline = query Customer where email == ""\n}\n`);
    expect(diagnostics).toEqual([]);
    const [all, some, inline] = ast.declarations[0]!.body.statements;
    expect(all).toMatchObject({ initializer: { kind: "QueryExpression", recordType: { name: "Customer" }, condition: undefined } });
    expect(some).toMatchObject({ initializer: { kind: "QueryExpression", condition: { kind: "BinaryExpression", operator: "&&", left: { operator: "!=" }, right: { name: "isperson" } } } });
    expect(inline).toMatchObject({ initializer: { condition: { operator: "==" } } });
    if (some?.kind !== "LetStatement") throw new Error();
    expect(some.initializer.span.end).toMatchObject({ line: 4, column: 38 });
  });

  it("parses for/in with a block", () => {
    const { ast, diagnostics } = parseSource(`scheduled {\n    for customer in customers {\n        log.debug(customer.email)\n    }\n}\n`);
    expect(diagnostics).toEqual([]);
    expect(ast.declarations[0]!.body.statements[0]).toMatchObject({
      kind: "ForStatement",
      variable: { name: "customer" },
      iterable: { kind: "Identifier", name: "customers" },
      body: { statements: [{ kind: "ExpressionStatement" }] },
    });
  });

  it("reports malformed queries and loops, keeping what parsed", () => {
    const message = (source: string) => parseSource(source).diagnostics[0]?.message;
    expect(parseSource(`scheduled {\n    let q = query\n}\n`).diagnostics).toEqual([]); // a bare `query` is just a name; the binder reports it
    expect(message(`scheduled {\n    let q = query Customer where\n}\n`)).toBe("Expected a condition after 'where', found end of statement");
    expect(message(`scheduled {\n    for customer customers { }\n}\n`)).toBe("Expected 'in' after 'for customer', found 'customers'");
    expect(message(`scheduled {\n    for customer in\n}\n`)).toBe("Expected a collection to iterate after 'in', found end of statement");
    expect(message(`scheduled {\n    for customer in customers\n    save customer\n}\n`)).toBe("Expected '{' after the for header, found end of statement");
    expect(message(`scheduled {\n    for true in customers { }\n}\n`)).toBe("'true' is a Bool literal and cannot be used as a name");
    const unclosed = parseSource(`scheduled {\n    for customer in customers {\n        log.debug(customer.email)\n`);
    expect(unclosed.diagnostics.map((d) => d.message)).toEqual(["Expected '}' to close the for block, found end of file", "Expected '}' to close the entry point body, found end of file"]);
    expect(unclosed.ast.declarations[0]!.body.statements[0]).toMatchObject({ kind: "ForStatement", body: { statements: [{ kind: "ExpressionStatement" }] } });
  });

  it("treats query, where, for, and in as ordinary names elsewhere", () => {
    const { ast, diagnostics } = parseSource(`scheduled {\n    query.x = "a"\n    where.y = "b"\n    save in\n    for.z = "c"\n}\n`);
    expect(diagnostics).toEqual([]);
    expect(ast.declarations[0]!.body.statements).toHaveLength(4);
  });
});

describe("parser: remove and add", () => {
  it("parses remove like save and delete", () => {
    const { ast, diagnostics } = parseSource(`scheduled {\n    remove line\n}\n`);
    expect(diagnostics).toEqual([]);
    expect(ast.declarations[0]!.body.statements[0]).toMatchObject({ kind: "RemoveStatement", target: { name: "line" } });
    expect(parseSource(`scheduled { remove }`).diagnostics[0]!.message).toBe("Expected a line to remove after 'remove', found '}'");
    expect(parseSource(`scheduled { remove.x = 1; remove(2) }`).ast.declarations[0]!.body.statements.map((s) => s.kind)).toEqual(["AssignmentStatement", "ExpressionStatement"]);
  });

  it("parses an add block whose body is ordinary statements", () => {
    const { ast, diagnostics } = parseSource(`scheduled {\n    add order.item {\n        item = "100"\n        quantity = 2\n    }\n}\n`);
    expect(diagnostics).toEqual([]);
    expect(ast.declarations[0]!.body.statements[0]).toMatchObject({
      kind: "AddStatement",
      target: { kind: "MemberExpression", object: { name: "order" }, property: { name: "item" } },
      body: { statements: [{ kind: "AssignmentStatement", target: { name: "item" } }, { kind: "AssignmentStatement", target: { name: "quantity" } }] },
    });
    expect(parseSource(`scheduled { add order.item { } }`).diagnostics).toEqual([]);
  });

  it("reports malformed adds and keeps add as a name elsewhere", () => {
    const message = (source: string) => parseSource(source).diagnostics[0]!.message;
    expect(message(`scheduled {\n    add\n}\n`)).toBe("Expected a sublist to add to after 'add', like 'add order.item {', found end of statement");
    expect(message(`scheduled {\n    add order.item\n    save order\n}\n`)).toBe("Expected '{' to begin the line's fields after 'add order.item', found end of statement");
    expect(message(`scheduled {\n    add order.item {\n        quantity = 1\n`)).toBe("Expected '}' to close the add block, found end of file");
    const { ast, diagnostics } = parseSource(`scheduled {\n    add.x = "a"\n    add(1)\n    save add\n}\n`);
    expect(diagnostics).toEqual([]);
    expect(ast.declarations[0]!.body.statements.map((s) => s.kind)).toEqual(["AssignmentStatement", "ExpressionStatement", "SaveStatement"]);
  });
});

describe("parser: functions and return", () => {
  it("parses a function with typed parameters, a return type, and a body", () => {
    const { ast, diagnostics } = parseSource(`fn isBulk(quantity: Number, note: Text) -> Bool {\n    return quantity > 100\n}\nscheduled { }\n`);
    expect(diagnostics).toEqual([]);
    expect(ast.declarations[0]).toMatchObject({
      kind: "FunctionDeclaration",
      name: { name: "isBulk" },
      parameters: [{ name: { name: "quantity" }, type: { name: "Number" } }, { name: { name: "note" }, type: { name: "Text" } }],
      returnType: { name: "Bool" },
      body: { statements: [{ kind: "ReturnStatement", value: { kind: "BinaryExpression", operator: ">" } }] },
    });
    const { ast: voidAst } = parseSource(`fn clean(order: SalesOrder) {\n    return\n}\nscheduled { }\n`);
    expect(voidAst.declarations[0]).toMatchObject({ kind: "FunctionDeclaration", parameters: [{ type: { name: "SalesOrder" } }], returnType: undefined, body: { statements: [{ kind: "ReturnStatement", value: undefined }] } });
    expect(parseSource(`fn none() { }\nscheduled { }\n`).ast.declarations[0]).toMatchObject({ kind: "FunctionDeclaration", parameters: [] });
  });

  it("return always begins a statement, even before a parenthesis", () => {
    const { ast, diagnostics } = parseSource(`fn f(a: Bool, b: Bool) -> Bool {\n    return (a || b) && a\n}\nscheduled { }\n`);
    expect(diagnostics).toEqual([]);
    expect(ast.declarations[0]).toMatchObject({ body: { statements: [{ kind: "ReturnStatement", value: { kind: "BinaryExpression", operator: "&&" } }] } });
  });

  it("reports malformed functions and recovers at the next declaration", () => {
    const message = (source: string) => parseSource(source).diagnostics[0]!.message;
    expect(message(`fn (x: Number) { }\nscheduled { }\n`)).toBe("Expected identifier as the function name, found '('");
    expect(message(`fn f x { }\nscheduled { }\n`)).toBe("Expected '(' after 'fn f', found 'x'");
    expect(message(`fn f(x Number) { }\nscheduled { }\n`)).toBe("Expected ':' after the parameter name, found 'Number'");
    expect(message(`fn f(x: Number) -> { }\nscheduled { }\n`)).toBe("Expected identifier as the return type after '->', found '{'");
    expect(message(`fn f(x: Number)\n    return x\nscheduled { }\n`)).toBe("Expected '{' to begin the body of 'f', found end of statement");
    expect(message(`fn true() { }\nscheduled { }\n`)).toBe("'true' is a Bool literal and cannot be used as a name");
    const { ast } = parseSource(`fn broken(x: { }\nscheduled {\n    log.debug("still here")\n}\n`);
    expect(ast.declarations.map((d) => d.kind)).toEqual(["ScheduledDeclaration"]);
  });
});
