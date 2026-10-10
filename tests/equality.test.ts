/**
 * The four equality operators: `==`/`!=` are JavaScript's loose equality,
 * `===`/`!==` its strict one. Each is emitted as written; the equality
 * table (src/semantic/equality.ts) decides what may be compared; backends
 * without coercion refuse loose cross-type comparisons rather than
 * lowering them to something that may answer differently.
 */
import { parse as parseJs } from "acorn";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile } from "../src/compiler.js";
import { tokenize } from "../src/lexer/lexer.js";
import { DiagnosticBag } from "../src/diagnostics.js";
import { equalityOf } from "../src/semantic/equality.js";
import { referenceType } from "../src/semantic/types.js";
import { compileMynt, errorCodes, referenceSchema } from "./helpers.js";
import { FakeNetSuite, scheduledContext } from "./harness/fake-netsuite.js";

const scheduled = (body: string) => `scheduled {\n${body}\n}\n`;
const compileRefs = (source: string) => compile(source, { file: "t.mn", schema: referenceSchema });
const messages = (source: string) => compileRefs(source).diagnostics.map((d) => `${d.code} ${d.message}`);
const first = (source: string) => messages(source)[0] ?? "";
const output = (source: string) => {
  const result = compileRefs(source);
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(() => parseJs(result.output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
  return result.output!;
};
/** Runs a scheduled script whose body logs, and returns what it logged. */
function logged(body: string, netsuite = new FakeNetSuite()): unknown[] {
  netsuite.load(output(scheduled(body))).execute!(scheduledContext());
  return netsuite.log.calls.map((c) => c.details);
}

describe("lexing and parsing", () => {
  it("lexes === and !== as single tokens, never == then =", () => {
    const kinds = tokenize(`a === b !== c == d != e = f`, new DiagnosticBag("t")).map((t) => t.kind);
    expect(kinds).toEqual(["Identifier", "EqualsEqualsEquals", "Identifier", "BangEqualsEquals", "Identifier", "EqualsEquals", "Identifier", "BangEquals", "Identifier", "Equals", "Identifier", "EOF"]);
  });

  it("all four sit at the equality level and do not chain", () => {
    const result = compileMynt(scheduled(`    let a = 1\n    let b = 2\n    if a === b || a !== b && a == b || a != b { }`));
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toContain("if (a === b || a !== b && a == b || a != b) {");
    expect(first(scheduled(`    let a = 1\n    if a === 1 === true { }`))).toContain("MYNT0001 Comparisons cannot be chained ('===' followed by '===')");
    expect(first(scheduled(`    let a = 1\n    if a == 1 !== true { }`))).toContain("Comparisons cannot be chained ('==' followed by '!==')");
  });
});

describe("the equality table", () => {
  it("answers strict and loose for every category", () => {
    const customer = referenceSchema.getRecordByName("Customer")!;
    const subsidiary = referenceSchema.getRecordByName("Subsidiary")!;
    expect(equalityOf("Text", "Text", "strict")).toEqual({ kind: "same", type: "Text" });
    expect(equalityOf("Bool", "Bool", "strict")).toEqual({ kind: "same", type: "Bool" });
    expect(equalityOf("Number", "Text", "strict")).toEqual({ kind: "incompatible", reason: "strict" });
    expect(equalityOf("Number", "Text", "loose")).toEqual({ kind: "coercive", left: "Number", right: "Text" });
    expect(equalityOf("Bool", "Number", "loose")).toEqual({ kind: "coercive", left: "Bool", right: "Number" });
    expect(equalityOf("Text", "Bool", "loose")).toEqual({ kind: "coercive", left: "Text", right: "Bool" });
    expect(equalityOf(referenceType(customer), referenceType(customer, true), "loose")).toEqual({ kind: "reference", record: customer });
    expect(equalityOf(referenceType(customer), referenceType(customer), "strict")).toEqual({ kind: "reference", record: customer });
    expect(equalityOf(referenceType(customer), referenceType(subsidiary), "loose")).toEqual({ kind: "incompatible", reason: "referenceTarget" });
    expect(equalityOf(referenceType(customer), "Text", "loose")).toEqual({ kind: "incompatible", reason: "domain" });
    expect(equalityOf("Date", "Date", "loose")).toEqual({ kind: "incompatible", reason: "domain" });
    expect(equalityOf("Void", "Void", "strict")).toEqual({ kind: "incompatible", reason: "domain" });
  });
});

describe("ordinary expressions", () => {
  it("emits exactly the operator written and runs with JavaScript's semantics", () => {
    const js = output(scheduled(`    let n = 1\n    let s = "1"\n    let t = true\n    if n == s { log.debug("loose number string") }\n    if n != "2" { log.debug("loose not") }\n    if 0 == false { log.debug("zero false") }\n    if n == t { log.debug("one true") }\n    if "1" == t { log.debug("string true") }\n    if n === 1 { log.debug("strict same") }\n    if n !== 2 { log.debug("strict not") }\n    if s === "1" { log.debug("strict string") }\n    if t !== false { log.debug("strict bool") }`));
    expect(js).toContain("if (n == s) {");
    expect(js).toContain('if (n != "2") {');
    expect(js).toContain("if (0 == false) {");
    expect(js).toContain("if (n == t) {");
    expect(js).toContain("if (n === 1) {");
    expect(js).toContain("if (n !== 2) {");
    expect(js).toContain('if (s === "1") {');
    expect(js).toContain("if (t !== false) {");
    const netsuite = new FakeNetSuite();
    netsuite.load(js).execute!(scheduledContext());
    expect(netsuite.log.calls.map((c) => c.details)).toEqual([
      "loose number string",
      "loose not",
      "zero false",
      "one true",
      "string true",
      "strict same",
      "strict not",
      "strict string",
      "strict bool",
    ]);
  });

  it("loose coercion is real: a string field against a number compares as JavaScript does", () => {
    const netsuite = new FakeNetSuite();
    netsuite.record.seed("customer", "1", { email: "42", comments: "" });
    expect(
      logged(`    let c = load Customer(1)\n    if c.email == 42 { log.debug("coerced") }\n    if c.email != 43 { log.debug("coerced not") }\n    if c.email === "42" { log.debug("strict") }`, netsuite),
    ).toEqual(["coerced", "coerced not", "strict"]);
  });

  it("MYNT1022 strict mismatch names the loose operator; loose only coerces among string, number, and boolean", () => {
    expect(first(scheduled(`    if 1 === "1" { }`))).toBe("MYNT1022 Strict equality cannot compare number with string. Use '==' if a coercive comparison is intended, or compare values of one type");
    expect(first(scheduled(`    if true !== 1 { }`))).toBe("MYNT1022 Strict equality cannot compare boolean with number. Use '!=' if a coercive comparison is intended, or compare values of one type");
    expect(first(scheduled(`    let c = load Customer(1)\n    if c.subsidiary == "1" { }`))).toContain("and loose equality does not coerce references");
    expect(first(scheduled(`    let c = load Customer(1)\n    if c == "1" { }`))).toBe("MYNT1022 Cannot compare Customer with string: loose equality ('==', '!=') coerces only between string, number, and boolean");
    expect(first(scheduled(`    let c = load Customer(1)\n    if c === c { }`))).toBe("MYNT1023 '===' is not defined for records (Customer); equality is defined for string, number, boolean, and references");
    expect(first(scheduled(`    if log.debug("a") == log.debug("b") { }`))).toContain("MYNT1023 '==' is not defined for Void values");
    expect(first(scheduled(`    let c = load Customer(1)\n    if c.datecreated == c.datecreated { }`))).toContain("MYNT1004");
  });

  it("the modes stay separate under the bound model", () => {
    const result = compileMynt(scheduled(`    let a = 1\n    if a == 1 { }\n    if a === 1 { }\n    if a != 1 { }\n    if a !== 1 { }\n    if a == "1" { }`));
    const operations = result.unit!.kind === "Scheduled" ? result.unit!.entryPoint.body.slice(1).map((s) => (s.kind === "If" && s.condition.kind === "Comparison" ? `${s.condition.operation}:${s.condition.operandType}` : null)) : [];
    expect(operations).toEqual(["Equal:Number", "StrictEqual:Number", "NotEqual:Number", "StrictNotEqual:Number", "Equal:Mixed"]);
  });
});

describe("references", () => {
  it("compare by canonical identity in both modes; the literal's type does not matter; targets must agree", () => {
    const js = output(scheduled(`    if Customer(123) === Customer("123") { log.debug("strict same") }\n    if Customer(123) == Customer("123") { log.debug("loose same") }\n    if Customer(123) !== Customer(124) { log.debug("strict differ") }\n    if Customer(123) != Customer(124) { log.debug("loose differ") }`));
    expect(js).toContain('if ("123" === "123") {');
    expect(js).toContain('if ("123" == "123") {');
    const netsuite = new FakeNetSuite();
    netsuite.load(js).execute!(scheduledContext());
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["strict same", "loose same", "strict differ", "loose differ"]);
    expect(first(scheduled(`    if Customer(1) === Subsidiary(1) { }`))).toContain("MYNT1022 Cannot compare a Customer reference with a Subsidiary reference");
    expect(first(scheduled(`    if Customer(1) == Subsidiary(1) { }`))).toContain("MYNT1022 Cannot compare a Customer reference with a Subsidiary reference");
    expect(first(scheduled(`    if Customer(1) < Customer(2) { }`))).toContain("MYNT1023 '<' is not defined for references");
  });
});

describe("search predicates", () => {
  const filters = (where: string, record = "Customer") => {
    const js = output(scheduled(`    for r in search ${record} where ${where} {\n        log.debug(r.id)\n    }`));
    const netsuite = new FakeNetSuite();
    netsuite.record.seed("customer", "1", { email: "x", comments: "", subsidiary: "1" }, {}, { subsidiary: "P" });
    netsuite.record.seed("customer", "2", { email: "y", comments: "", subsidiary: "2" }, {}, { subsidiary: "N" });
    netsuite.record.seed("salesorder", "5", { memo: "m", total: 100, entity: "1" }, {}, { entity: "A" });
    netsuite.record.seed("customrecord_mynt_log", "10", { name: "a", custrecord_mynt_done: true });
    netsuite.record.seed("customrecord_mynt_log", "11", { name: "b", custrecord_mynt_done: false });
    netsuite.load(js).execute!(scheduledContext());
    return { filters: netsuite.search.runs[0]!.filters, ids: netsuite.log.calls.map((c) => c.details) };
  };

  it("same-type loose and strict lower to one operator, and the IR keeps which was written", () => {
    expect(filters(`email == "x"`)).toEqual({ filters: [["email", "is", "x"]], ids: ["1"] });
    expect(filters(`email === "x"`)).toEqual({ filters: [["email", "is", "x"]], ids: ["1"] });
    expect(filters(`email != ""`).filters).toEqual([["email", "isnotempty", ""]]);
    expect(filters(`email !== ""`).filters).toEqual([["email", "isnotempty", ""]]);
    expect(filters(`total === 100`, "SalesOrder")).toEqual({ filters: [["total", "equalto", 100]], ids: ["5"] });
    expect(filters(`total != 100`, "SalesOrder").filters).toEqual([["total", "notequalto", 100]]);
    const result = compileRefs(scheduled(`    let a = search Customer where email == "x"\n    let b = search Customer where email === "x"\n    for r in a { }\n    for r in b { }`));
    const [first, second] = result.unit!.kind === "Scheduled" ? result.unit!.entryPoint.body : [];
    expect(first).toMatchObject({ initializer: { predicate: { operation: "Equal" }, filter: { operator: "IS", origin: "Equal" } } });
    expect(second).toMatchObject({ initializer: { predicate: { operation: "StrictEqual" }, filter: { operator: "IS", origin: "StrictEqual" } } });
  });

  it("references lower to anyof/noneof in both modes, and a boolean field compared with a literal is the flag", () => {
    expect(filters(`subsidiary == Subsidiary(2)`).filters).toEqual([["subsidiary", "anyof", ["2"]]]);
    expect(filters(`subsidiary === Subsidiary(2)`).filters).toEqual([["subsidiary", "anyof", ["2"]]]);
    expect(filters(`subsidiary !== Subsidiary(2)`)).toEqual({ filters: [["subsidiary", "noneof", ["2"]]], ids: ["1"] });
    expect(filters(`custrecord_mynt_done === true`, "MyntLog")).toEqual({ filters: [["custrecord_mynt_done", "is", "T"]], ids: ["10"] });
    expect(filters(`custrecord_mynt_done != true`, "MyntLog")).toEqual({ filters: [["custrecord_mynt_done", "is", "F"]], ids: ["11"] });
    expect(filters(`custrecord_mynt_done == false`, "MyntLog").filters).toEqual([["custrecord_mynt_done", "is", "F"]]);
  });

  it("MYNT1049 refuses loose cross-type comparisons: N/search cannot coerce", () => {
    expect(first(scheduled(`    for o in search SalesOrder where total == "100" { }`))).toBe(
      "MYNT1049 Unsupported search condition: loose equality between number and string cannot be represented exactly by N/search, which compares without coercion. Use '===' with a number value instead",
    );
    expect(first(scheduled(`    for o in search SalesOrder where "100" != total { }`))).toContain("Use '!==' with a number value instead");
    expect(first(scheduled(`    for c in search Customer where email == 1 { }`))).toContain("loose equality between string and number cannot be represented exactly by N/search");
    expect(first(scheduled(`    for e in search MyntLog where custrecord_mynt_done == 1 { }`))).toContain("loose equality between boolean and number");
    expect(first(scheduled(`    let flag = true\n    for e in search MyntLog where custrecord_mynt_done === flag { }`))).toContain("MYNT1049 Unsupported search condition: compare the boolean field 'custrecord_mynt_done' with true or false");
    expect(first(scheduled(`    for o in search SalesOrder where total === "100" { }`))).toContain("MYNT1022 Strict equality cannot compare number with string");
  });

  it("negation keeps the mode: !(a == b) is a loose inequality, !(a === b) a strict one, and both still lower exactly", () => {
    expect(filters(`!(email == "x")`).filters).toEqual([["email", "isnot", "x"]]);
    expect(filters(`!(email === "x")`).filters).toEqual([["email", "isnot", "x"]]);
    expect(filters(`!(subsidiary === Subsidiary(2))`).filters).toEqual([["subsidiary", "noneof", ["2"]]]);
    const result = compileRefs(scheduled(`    let a = search Customer where !(email == "x")\n    let b = search Customer where !(email === "x")\n    for r in a { }\n    for r in b { }`));
    const [loose, strict] = result.unit!.kind === "Scheduled" ? result.unit!.entryPoint.body : [];
    expect(loose).toMatchObject({ initializer: { filter: { operator: "ISNOT", origin: "NotEqual" } } });
    expect(strict).toMatchObject({ initializer: { filter: { operator: "ISNOT", origin: "StrictNotEqual" } } });
    expect(first(scheduled(`    for o in search SalesOrder where !(total == "1") { }`))).toContain("MYNT1049");
  });
});

describe("query predicates", () => {
  it("same-type forms lower identically; loose cross-type is refused for N/query too", () => {
    const js = output(scheduled(`    for c in query Customer where email == "x" {\n        log.debug(c.id)\n    }\n    for c in query Customer where email === "x" {\n        log.debug(c.id)\n    }\n    for c in query Customer where comments !== "" {\n        log.debug(c.id)\n    }`));
    expect(js.match(/operator: query\.Operator\.EQUAL\b/g)).toHaveLength(2);
    expect(js).toContain("operator: query.Operator.EMPTY_NOT");
    expect(first(scheduled(`    for o in query SalesOrder where total == "100" { }`))).toBe(
      "MYNT1031 Unsupported query condition: loose equality between number and string cannot be represented exactly by N/query, which compares without coercion. Use '===' with a number value instead",
    );
    expect(first(scheduled(`    for e in query MyntLog where custrecord_mynt_done === true { }`))).toBe("");
    expect(output(scheduled(`    for e in query MyntLog where custrecord_mynt_done !== true {\n        log.debug(e.id)\n    }`))).toContain("values: [false]");
  });
});

describe("migration of the canonical sources", () => {
  it("every example and the README's Mynt snippets use strict equality", () => {
    const loose = /(?<![=!<>])(==|!=)(?!=)/;
    for (const file of readdirSync("examples").filter((f) => f.endsWith(".mn"))) {
      const source = readFileSync(`examples/${file}`, "utf8");
      expect(loose.test(source), `${file} uses a loose operator`).toBe(false);
      // The saved-search example needs the account snapshot that knows its search, and the summary example the fuller SalesOrder; the rest compile against the sample.
      const result = file === "saved-search.mn" || file === "search-totals.mn" ? compile(source, { file, schema: referenceSchema }) : compileMynt(source);
      expect(errorCodes(result).filter((c) => c !== "MYNT1004")).toEqual([]);
    }
  });
});
