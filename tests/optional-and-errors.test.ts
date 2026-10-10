/**
 * `or` resolves an optional (`T?` from `first`) where it is declared;
 * `try`/`catch` handles thrown runtime errors. The two never meet: an
 * absent row is not an error and never enters `catch`, and a thrown error
 * is not absence and never takes the `or` branch. Uses the reference
 * fixture (tests/helpers.ts) and the fake runtime.
 */
import { parse as parseJs } from "acorn";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile } from "../src/compiler.js";
import { completionsAt } from "../src/lsp/completion.js";
import { hoverAt } from "../src/lsp/hover.js";
import { analyze } from "../src/semantic/query.js";
import { referencesOf, symbolAt } from "../src/semantic/symbols.js";
import { semanticTokens } from "../src/semantic/tokens.js";
import { compileMynt, referenceSchema } from "./helpers.js";
import { FakeNetSuite, scheduledContext } from "./harness/fake-netsuite.js";

const EXAMPLE = readFileSync(new URL("../examples/search-first.mn", import.meta.url), "utf8");
const scheduled = (body: string) => `scheduled {\n${body}\n}\n`;
const compileRefs = (source: string) => compile(source, { file: "t.mn", schema: referenceSchema });
const messages = (source: string) => compileRefs(source).diagnostics.map((d) => `${d.code} ${d.severity} ${d.message}`);
const first = (source: string) => messages(source)[0] ?? "";
const output = (source: string) => {
  const result = compileRefs(source);
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(() => parseJs(result.output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
  return result.output!;
};
const body = (source: string) => output(source).split("function execute(context) {")[1]!.split("return { execute };")[0]!;
function at(source: string) {
  const offset = source.indexOf("§");
  const text = source.slice(0, offset) + source.slice(offset + 1);
  return { doc: analyze(text, "t.mn", referenceSchema), offset, text };
}
const labels = (source: string) => completionsAt(at(source).doc, at(source).offset).map((i) => i.label);
const hover = (source: string) => hoverAt(at(source).doc, at(source).offset)?.contents;
const tokens = (text: string) =>
  semanticTokens(analyze(text, "t.mn", referenceSchema)).map((t) => `${text.slice(t.span.start.offset, t.span.end.offset)}:${t.kind}${t.modifiers.map((m) => `+${m}`).join("")}`);

function seeded() {
  const netsuite = new FakeNetSuite();
  netsuite.record.seed("customer", "123", { email: "a@x.com", comments: "first comment", subsidiary: "1" }, {}, { subsidiary: "Parent Company" });
  netsuite.record.seed("customer", "124", { email: "b@x.com", comments: "second comment", subsidiary: "2" }, {}, { subsidiary: "Nordic AB" });
  return netsuite;
}
const run = (js: string, netsuite = seeded()) => {
  netsuite.load(js).execute!(scheduledContext());
  return netsuite;
};
const logged = (netsuite: FakeNetSuite) => netsuite.log.calls.map((c) => [c.level, c.details] as const);

const RESOLVED = scheduled(`    let c = search Customer\n        where email === "b@x.com"\n        select comments\n        first\n        or return\n    log.debug(c.comments)`);

describe("or resolves an optional where it is declared", () => {
  it("binds the local as the plain row type, evaluates the search once, and leaves on absence", () => {
    const js = body(RESOLVED);
    expect(js).toContain('const c$maybe = mynt$search(search.Type.CUSTOMER, ["comments"], [], [["email", search.Operator.IS, "b@x.com"]], undefined, true);');
    expect(js).toContain("if (c$maybe === null) {\n            return;\n        }\n        const c = c$maybe;");
    expect(js.match(/mynt\$search\(/g)).toHaveLength(1);
    expect(hover(RESOLVED.replace("log.debug(c", "log.debug(§c"))).toBe("```mynt\nc: Customer\n```\n\nlocal · Customer (search result, read-only)");
    const present = run(output(RESOLVED));
    expect(present.search.runs).toHaveLength(1);
    expect(logged(present)).toEqual([["debug", "second comment"]]);
    const absent = run(output(RESOLVED.replace("b@x.com", "nobody@x.com")));
    expect(absent.search.runs).toHaveLength(1);
    expect(logged(absent)).toEqual([]);
  });

  it("takes a block that may log before it returns, and may return from any path", () => {
    const source = scheduled(`    let c = search Customer\n        where email === "nobody@x.com"\n        first\n        or {\n            log.error("No such customer")\n            return\n        }\n    log.debug(c.email)`);
    expect(body(source)).toContain('if (c$maybe === null) {\n            log.error({\n                title: "execute",\n                details: "No such customer"\n            });\n\n            return;\n        }');
    expect(logged(run(output(source)))).toEqual([["error", "No such customer"]]);
    expect(messages(scheduled(`    let c = search Customer first\n        or {\n            if true {\n                return\n            } else {\n                log.debug("x")\n                return\n            }\n        }\n    log.debug(c.email)`))).toEqual([]);
  });

  it("MYNT1060 refuses a branch that may continue without a value", () => {
    expect(first(scheduled(`    let c = search Customer first\n        or {\n            log.error("x")\n        }`))).toBe("MYNT1060 error The 'or' branch may continue without producing a value. End the branch with 'return' on every path");
    expect(first(scheduled(`    let c = search Customer first\n        or {\n            if true {\n                return\n            }\n        }`))).toContain("MYNT1060");
    expect(first(scheduled(`    let c = search Customer first\n        or {\n            if true {\n                return\n            } else {\n                log.debug("x")\n            }\n        }`))).toContain("MYNT1060");
  });

  it("MYNT1059 refuses or on a value that is not optional, and names what produces one", () => {
    expect(first(scheduled(`    let c = search Customer limit 1\n        or return`))).toBe("MYNT1059 error 'or' requires an optional value, and this expression has type Sequence<Customer>. Only a search with 'first' produces an optional so far");
    expect(first(scheduled(`    let c = load Customer("1")\n        or return`))).toContain("MYNT1059 error 'or' requires an optional value, and this expression has type Customer.");
    expect(first(scheduled(`    let c = "x" or return`))).toContain("has type string");
    expect(first(scheduled(`    let c = true or return`))).toContain("has type boolean");
  });

  it("or is a contextual word, parsed only after a let initializer, and reports a cut-short branch", () => {
    expect(messages(scheduled(`    let or = "x"\n    let c = or\n    log.debug(c)`))).toEqual([]);
    expect(first(scheduled(`    let c = search Customer first\n        or`))).toBe("MYNT0001 error Expected 'return' or '{' after 'or', found end of statement");
    expect(first(scheduled(`    let c = search Customer first or log.debug("x")`))).toContain("MYNT0001 error Expected 'return' or '{' after 'or'");
    // On its own line and followed by neither, `or` is not a continuation; it is whatever the next statement makes of it.
    expect(first(scheduled(`    let c = search Customer first\n        or log.debug("x")`))).toContain("MYNT1010 error Unknown identifier 'or'");
    // `or` on the next line continues the declaration, as a clause word does.
    expect(messages(scheduled(`    let c = search Customer first\n    or return\n    log.debug(c.email)`))).toEqual([]);
    // Not a fallback value: there is no `x or y`.
    expect(messages(scheduled(`    let c = search Customer first or load Customer("1")\n    log.debug("next")`))).toEqual(["MYNT0001 error Expected 'return' or '{' after 'or', found 'load'"]);
    // Not a statement operator either.
    expect(first(scheduled(`    let c = search Customer first\n    log.debug(c or return)`))).toContain("MYNT0001");
  });

  it("the column planner sees fields read from the resolved row, outside any loop", () => {
    expect(body(scheduled(`    let c = search Customer where email === "a@x.com" first\n        or return\n    log.debug(c.comments)\n    log.debug(c.subsidiary.text)`))).toContain('mynt$search(search.Type.CUSTOMER, ["comments", "subsidiary"], ["subsidiary"], [["email", search.Operator.IS, "a@x.com"]], undefined, true)');
    expect(first(scheduled(`    let c = search Customer select email first\n        or return\n    log.debug(c.comments)`))).toContain("MYNT1050 error 'comments' was not selected");
  });
});

describe("an optional can be tested for presence", () => {
  it("if x narrows the then branch, and an else that returns narrows what follows", () => {
    const js = body(scheduled(`    let c = search Customer where email === "a@x.com" first\n    if c {\n        log.debug(c.comments)\n    }`));
    expect(js).toContain("if (c !== null) {");
    expect(js).toContain('mynt$search(search.Type.CUSTOMER, ["comments"], [], [["email", search.Operator.IS, "a@x.com"]], undefined, true)');
    expect(logged(run(output(scheduled(`    let c = search Customer where email === "a@x.com" first\n    if c {\n        log.debug(c.comments)\n    } else {\n        log.debug("none")\n    }`))))).toEqual([["debug", "first comment"]]);
    expect(logged(run(output(scheduled(`    let c = search Customer where email === "z@x.com" first\n    if c {\n        log.debug(c.comments)\n    } else {\n        log.debug("none")\n    }`))))).toEqual([["debug", "none"]]);
    expect(messages(scheduled(`    let c = search Customer first\n    if c {\n    } else {\n        return\n    }\n    log.debug(c.email)`))).toEqual([]);
    expect(hover(scheduled(`    let c = search Customer first\n    if c {\n        log.debug(§c.email)\n    }`))).toBe("```mynt\nc: Customer\n```\n\nlocal · Customer (search result, read-only) · narrowed by `if` from `Customer?`");
    expect(hover(scheduled(`    let c = search Customer first\n    if c {\n    }\n    log.debug(§c)`))).toContain("c: Customer?\n");
  });

  it("MYNT1058 outside the narrowed region names both forms, and the else branch is not narrowed", () => {
    expect(first(scheduled(`    let c = search Customer first\n    if c {\n    }\n    log.debug(c.email)`))).toBe(
      "MYNT1058 error 'c' may be absent: a search with 'first' returns one Customer row or none. Resolve it where it is declared, 'let c = ... or return' (or 'or { ... return }'), or test for presence with 'if c { ... }' before reading '.email'",
    );
    expect(first(scheduled(`    let c = search Customer first\n    if c {\n    } else {\n        log.debug(c.email)\n    }`))).toContain("MYNT1058");
    expect(first(scheduled(`    let c = search Customer first\n    if c {\n    } else {\n        log.debug("x")\n    }\n    log.debug(c.email)`))).toContain("MYNT1058");
    // Only a bare optional local is a presence test; there is no truthiness.
    expect(first(scheduled(`    let c = search Customer first\n    if c.email {\n    }`))).toContain("MYNT1058");
    expect(first(scheduled(`    let c = load Customer("1")\n    if c {\n    }`))).toContain("MYNT1021");
    expect(hover(scheduled(`    let c = search Customer first\n    log.debug(§c)`))).toContain("the first Customer row of a search, or none; resolve it with 'or return' where it is declared, or test it with 'if'");
  });
});

describe("try/catch handles thrown runtime errors", () => {
  const TRY = scheduled(`    try {\n        let r = load Customer("9")\n        r.comments = "x"\n        save r\n    } catch err {\n        log.error(err.name)\n        log.error(err.message)\n        log.error(err)\n    } finally {\n        log.debug("done")\n    }`);

  it("lowers to a plain JavaScript try/catch/finally and runs the handler only when something throws", () => {
    const js = body(TRY);
    expect(js).toContain("try {\n            const r = record.load({");
    expect(js).toContain("} catch (err) {\n            log.error({\n                title: \"execute\",\n                details: err.name\n            });");
    expect(js).toContain("details: err.message");
    expect(js).toContain("details: err\n");
    expect(js).toContain("} finally {\n            log.debug({");
    const failed = run(output(TRY));
    expect(failed.log.calls.map((c) => c.level)).toEqual(["error", "error", "error", "debug"]);
    expect(failed.log.calls[0]!.details).toBe("Error");
    expect(failed.log.calls[1]!.details).toBe("Fake NetSuite has no customer record with id 9");
    expect(failed.log.calls[2]!.details).toBeInstanceOf(Error);
    const fine = run(output(TRY.replace('"9"', '"123"')));
    expect(fine.log.calls.map((c) => [c.level, c.details])).toEqual([["debug", "done"]]);
    expect(fine.record.persisted("customer", "123")!["comments"]).toBe("x");
  });

  it("catch alone, finally alone, and catch without a binding are all forms; try alone is not", () => {
    expect(body(scheduled(`    try {\n        log.debug("a")\n    } catch {\n        log.error("failed")\n    }`))).toContain("} catch (mynt$error) {");
    expect(body(scheduled(`    try {\n        log.debug("a")\n    } finally {\n        log.debug("b")\n    }`))).toMatch(/try \{[\s\S]*\} finally \{/);
    expect(body(scheduled(`    try {\n        log.debug("a")\n    } finally {\n        log.debug("b")\n    }`))).not.toContain("catch");
    expect(first(scheduled(`    try {\n        log.debug("x")\n    }`))).toBe("MYNT0001 error A 'try' needs a 'catch' (or 'finally') on the same line as its closing '}': write '} catch err {'");
    expect(messages(scheduled(`    try {\n    }\n    catch err {\n    }`))).toEqual([
      "MYNT0001 error A 'try' needs a 'catch' (or 'finally') on the same line as its closing '}': write '} catch err {'",
      "MYNT0001 error 'catch' must be on the same line as the '}' that closes the try block: write '} catch err {'",
    ]);
  });

  it("the caught error is an Error local scoped to the handler, with name and message as strings", () => {
    expect(first(scheduled(`    try {\n    } catch err {\n    }\n    log.error(err)`))).toContain("MYNT1010 error Unknown identifier 'err'");
    expect(first(scheduled(`    let err = "x"\n    try {\n    } catch err {\n    }`))).toBe("MYNT1017 error 'err' is already declared in an enclosing scope (line 2); choose another name for the caught error");
    expect(first(scheduled(`    try {\n    } catch err {\n        log.error(err.stack)\n    }`))).toBe("MYNT1011 error An Error has '.name' and '.message' (both strings) and can be logged as it is; it has no member 'stack'");
    expect(first(scheduled(`    try {\n    } catch err {\n        err.message = "x"\n    }`))).toContain("MYNT1009");
    expect(first(scheduled(`    try {\n    } catch err {\n        let e = load Customer(err)\n    }`))).toContain("MYNT1045");
    expect(first(scheduled(`    try {\n    } catch err {\n        if err === "x" {\n        }\n    }`))).toContain("MYNT1022");
    expect(messages(scheduled(`    try {\n    } catch err {\n        let m = err.message\n        if m === "x" {\n            log.audit(err.name)\n        }\n    }`))).toEqual([]);
    expect(hover(scheduled(`    try {\n    } catch er§r {\n    }`))).toBe("```mynt\nerr: Error\n```\n\ncaught error · a thrown runtime error, caught here; `name` and `message` are strings, and it can be logged as it is");
    expect(hover(scheduled(`    try {\n    } catch err {\n        log.error(e§rr)\n    }`))).toContain("caught error");
    expect(hover(scheduled(`    try {\n    } catch err {\n        log.error(err.mess§age)\n    }`))).toContain("Error.message · the error's description (read-only)");
    expect(hover(scheduled(`    try {\n    } catch err {\n        log.error(err.na§me)\n    }`))).toContain("Error.name · the error's code");
    const { doc, offset } = at(scheduled(`    try {\n    } catch e§rr {\n        log.error(err)\n    }`));
    const symbol = symbolAt(doc, offset)!;
    expect(symbol.kind).toBe("local");
    expect(referencesOf(doc, symbol).map((r) => [r.span.start.line, r.isDeclaration])).toEqual([[3, true], [4, false]]);
  });

  it("a search error inside try is caught; the same error outside try propagates to NetSuite", () => {
    const inside = scheduled(`    try {\n        for c in search Customer {\n            log.debug(c.email)\n        }\n    } catch err {\n        log.error(err.name)\n    }\n    log.debug("after")`);
    const netsuite = seeded();
    netsuite.search.failWith = "Invalid search filter";
    expect(logged(run(output(inside), netsuite))).toEqual([["error", "SSS_INVALID_SRCH_FILTER"], ["debug", "after"]]);
    const outside = seeded();
    outside.search.failWith = "Invalid search filter";
    expect(() => run(output(scheduled(`    for c in search Customer {\n        log.debug(c.email)\n    }`)), outside)).toThrow("Invalid search filter");
  });
});

describe("absence and failure stay apart", () => {
  it("an absent row takes the or branch and never enters catch", () => {
    const source = scheduled(`    try {\n        let c = search Customer where email === "nobody@x.com" first\n            or {\n                log.audit("absent")\n                return\n            }\n        log.debug(c.email)\n    } catch err {\n        log.error("caught")\n    }`);
    expect(logged(run(output(source)))).toEqual([["audit", "absent"]]);
  });

  it("a thrown error bypasses or and reaches catch", () => {
    const source = scheduled(`    try {\n        let c = search Customer first\n            or {\n                log.audit("absent")\n                return\n            }\n        log.debug(c.email)\n    } catch err {\n        log.error(err.name)\n    }`);
    const netsuite = seeded();
    netsuite.search.failWith = "Invalid search filter";
    expect(logged(run(output(source), netsuite))).toEqual([["error", "SSS_INVALID_SRCH_FILTER"]]);
  });

  it("try does not change an optional's type, and or is not a catch", () => {
    expect(first(scheduled(`    try {\n        let c = search Customer first\n        log.debug(c.email)\n    } catch err {\n    }`))).toContain("MYNT1058");
    expect(first(scheduled(`    try {\n        let c = load Customer("1")\n            or return\n    } catch err {\n    }`))).toContain("MYNT1059");
  });
});

describe("lifecycle through try/catch", () => {
  it("changes the exception interrupted are not the handler's to redo, so the usual idiom does not warn", () => {
    expect(messages(scheduled(`    let r = load Customer("9")\n    try {\n        r.comments = "x"\n        save r\n    } catch err {\n        log.error(err)\n    }`))).toEqual([]);
    expect(messages(scheduled(`    let r = load Customer("9")\n    r.comments = "x"\n    try {\n        save r\n    } catch err {\n        log.error(err)\n        return\n    }`))).toEqual([]);
    expect(messages(scheduled(`    try {\n        let r = create Customer()\n        save r\n    } catch err {\n        log.error(err)\n    }`))).toEqual([]);
    // What the handler itself changes, and what the body leaves pending on the normal path, are reported as always.
    expect(messages(scheduled(`    let r = load Customer("9")\n    try {\n        log.debug("x")\n    } catch err {\n        r.comments = "failed"\n    }`))).toEqual([
      "MYNT2001 warning 'r' is modified but never saved; changes to a loaded Customer are discarded unless you 'save r'",
    ]);
    expect(messages(scheduled(`    let r = load Customer("9")\n    try {\n        r.comments = "x"\n    } catch err {\n        log.error(err)\n    }`))).toEqual([
      "MYNT2001 warning 'r' is modified but never saved; changes to a loaded Customer are discarded unless you 'save r'",
    ]);
    expect(messages(scheduled(`    let r = load Customer("9")\n    try {\n        r.comments = "x"\n    } catch err {\n        log.error(err)\n    } finally {\n        save r\n    }`))).toEqual([]);
  });

  it("a save inside try is not a certain save afterwards, and what may have happened in the body is visible in the handler and after it", () => {
    expect(first(scheduled(`    let r = create Customer()\n    try {\n        save r\n    } catch err {\n        log.error(err)\n    }\n    delete r`))).toBe("MYNT1026 error Cannot delete 'r': it may not have been saved on every path that reaches this delete");
    expect(messages(scheduled(`    let r = create Customer()\n    try {\n        save r\n    } catch err {\n        log.error(err)\n        return\n    }\n    delete r`))).toEqual([]);
    expect(first(scheduled(`    let r = load Customer("9")\n    try {\n        delete r\n    } catch err {\n        log.error(err)\n    }\n    save r`))).toContain("MYNT1027");
    expect(first(scheduled(`    let r = load Customer("9")\n    try {\n        delete r\n    } catch err {\n        save r\n    }`))).toContain("MYNT1027");
    expect(first(scheduled(`    let r = load Customer("9")\n    try {\n        delete r\n        log.debug("gone")\n    } catch err {\n        log.error(err)\n    }\n    delete r`))).toContain("MYNT1028");
  });
});

describe("editor", () => {
  it("tokens mark or, try, catch, and finally as keywords, the binding as a declaration, and name/message as read-only properties", () => {
    const text = scheduled(`    let c = search Customer first\n        or return\n    try {\n        save c\n    } catch err {\n        log.error(err.message)\n    } finally {\n    }`);
    expect(tokens(text).filter((t) => /^(or|try|catch|finally|err|message):/.test(t))).toEqual([
      "or:keyword",
      "try:keyword",
      "catch:keyword",
      "err:variable+declaration",
      "err:variable",
      "message:property+readonly",
      "finally:keyword",
    ]);
    expect(tokens(scheduled(`    let or = "x"\n    log.debug(or)`)).filter((t) => t.startsWith("or:"))).toEqual(["or:variable+declaration", "or:variable"]);
  });

  it("completes or after first, and offers try as a statement", () => {
    expect(labels(scheduled(`    let c = search Customer\n        first\n        §`)).slice(0, 2)).toEqual(["or return", "or {"]);
    expect(labels(scheduled(`    let c = search Customer\n        first\n        or §`))).not.toContain("or return");
    expect(labels(scheduled(`    let c = search Customer\n        limit 1\n        §`))).not.toContain("or return");
    const statements = labels(scheduled(`    §`));
    expect(statements).toContain("try");
    expect(statements).not.toContain("catch");
    expect(statements).not.toContain("finally");
    expect(labels(scheduled(`    try {\n    } catch err {\n        log.error(err.§)\n    }`))).toEqual(["name", "message"]);
  });
});

describe("the example", () => {
  it("compiles against the sample schema and runs both the absent and the present case", () => {
    const result = compileMynt(EXAMPLE, "examples/search-first.mn");
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toMatchSnapshot();
    const absent = new FakeNetSuite();
    absent.load(result.output!).execute!(scheduledContext());
    expect(absent.log.calls.map((c) => [c.level, c.details])).toEqual([["error", "No customer owns that address"]]);
    const present = new FakeNetSuite();
    present.record.seed("customer", "1", { email: "owner@example.com", comments: "old" });
    present.load(result.output!).execute!(scheduledContext());
    expect(present.log.calls.map((c) => [c.level, c.details])).toEqual([["debug", "old"]]);
    expect(present.record.persisted("customer", "1")!["comments"]).toBe("Reviewed by Mynt");
  });
});
