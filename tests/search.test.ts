/**
 * Record references, field lookups, and `search`: the N/search increment.
 *
 *   Customer(123)                   a typed reference, Ref<Customer>, no NetSuite work
 *   Customer(123)[email]            one lookupFields call, the field's value
 *   Customer(123)[email, comments]  one lookupFields call, a read-only projection
 *   loaded[email, comments]         local reads, no call
 *   row[email, comments]            planned columns, no call
 *   search Customer where ...       N/search rows, read-only, chosen explicitly
 */
import { parse as parseJs } from "acorn";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { completionsAt } from "../src/lsp/completion.js";
import { hoverAt } from "../src/lsp/hover.js";
import { signatureHelpAt } from "../src/lsp/signature-help.js";
import { analyze, typeAt } from "../src/semantic/query.js";
import { referencesOf, renameConflict, symbolAt } from "../src/semantic/symbols.js";
import { semanticTokens } from "../src/semantic/tokens.js";
import { typeName } from "../src/semantic/types.js";
import { compileMynt, errorCodes, schema } from "./helpers.js";
import { FakeNetSuite, FakeRecord, scheduledContext, userEventContext } from "./harness/fake-netsuite.js";

const LOOKUP = readFileSync(new URL("../examples/lookup-customer.mn", import.meta.url), "utf8");
const SEARCH = readFileSync(new URL("../examples/search-customers.mn", import.meta.url), "utf8");

const scheduled = (body: string) => `scheduled {\n${body}\n}\n`;
const messages = (source: string) => compileMynt(source).diagnostics.map((d) => `${d.code} ${d.message}`);
const first = (source: string) => messages(source)[0] ?? "";
const output = (source: string) => {
  const result = compileMynt(source);
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(() => parseJs(result.output!, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
  return result.output!;
};

/** Cursor helpers, as in lsp.test.ts: `§` marks the cursor. */
function at(source: string) {
  const offset = source.indexOf("§");
  const text = source.slice(0, offset) + source.slice(offset + 1);
  return { doc: analyze(text, "t.mn", schema), offset, text };
}
const labels = (source: string) => completionsAt(at(source).doc, at(source).offset).map((i) => i.label);
const hover = (source: string) => hoverAt(at(source).doc, at(source).offset)?.contents;
const type = (source: string) => {
  const { doc, offset } = at(source);
  const t = typeAt(doc, offset);
  return t && typeName(t);
};
const tokens = (text: string) =>
  semanticTokens(analyze(text, "t.mn", schema)).map((t) => `${text.slice(t.span.start.offset, t.span.end.offset)}:${t.kind}${t.modifiers.map((m) => `+${m}`).join("")}`);

function seeded() {
  const netsuite = new FakeNetSuite();
  netsuite.record.seed("customer", "123", { email: "a@x.com", comments: "Known" });
  netsuite.record.seed("customer", "1", { email: "a@x.com", comments: "" });
  netsuite.record.seed("customer", "2", { email: "", comments: "" });
  netsuite.record.seed("customer", "3", { email: "c@x.com", comments: "Already" });
  netsuite.record.seed("customer", "4", { email: "d@x.com", comments: "" });
  return netsuite;
}

describe("record ids: numbers, passed to NetSuite as written", () => {
  it("every id-taking operation accepts a number and passes it on as a number", () => {
    const js = output(
      scheduled(
        `    let a = load Customer(123)\n    let c = copy Customer(123)\n    let d = transform SalesOrder(123) to Invoice\n    save c\n    save d`,
      ),
    );
    expect(js).toContain("id: 123");
    expect(js).toContain("fromId: 123");
    expect(js).not.toContain('"123"');
    expect(js).not.toContain("String(");
  });

  it("a numeric literal is a number in the AST", () => {
    const result = compileMynt(scheduled(`    let a = load Customer(123)`));
    const declaration = result.unit!.kind === "Scheduled" ? result.unit!.entryPoint.body[0]! : undefined;
    expect(declaration).toMatchObject({ kind: "LocalDeclaration", initializer: { kind: "BuiltinCall", arguments: [{ kind: "NumberLiteral", value: 123, type: "Number" }] } });
  });

  it("a string id is still accepted and passes through as written", () => {
    const js = output(scheduled(`    let b = load Customer("123")\n    let e = load Customer("ABC123")\n    let s = Customer("123")\n    log.debug(s.id)`));
    expect(js).toContain('id: "123"');
    expect(js).toContain('id: "ABC123"');
    expect(js).toContain('const s = "123";');
  });

  it("a number-typed value passes through; a reference built from one holds its id as a string", () => {
    const js = output(`fn touch(id: number) {\n    let c = load Customer(id)\n    log.debug(c.email)\n}\n\nscheduled {\n    let n = 123\n    let a = load Customer(n)\n    let r = Customer(n)\n    log.debug(a.email)\n    log.debug(r[email])\n    touch(123)\n}\n`);
    expect(js).toContain("id: id");
    expect(js).toContain("id: n");
    expect(js).toContain("const r = String(n);");
    expect(js).toContain("id: r,");
    const netsuite = seeded();
    netsuite.load(js).execute!(scheduledContext());
    expect(netsuite.record.loadCalls).toEqual([{ type: "customer", id: "123" }, { type: "customer", id: "123" }]);
    expect(netsuite.search.lookupCalls).toEqual([{ type: "customer", id: "123", columns: ["email"] }]);
  });

  it("MYNT1045 rejects a numeric literal that is not a whole number", () => {
    expect(first(scheduled(`    let r = Customer(1.5)`))).toBe("MYNT1045 Record id must be a whole number, but Customer(...) received 1.5");
    expect(first(scheduled(`    let a = load Customer(1.5)`))).toBe("MYNT1045 Record id must be a whole number, but load Customer(...) received 1.5");
    expect(first(scheduled(`    let d = transform SalesOrder(0.25) to Invoice\n    save d`))).toBe("MYNT1045 Record id must be a whole number, but transform SalesOrder(...) received 0.25");
    expect(messages(scheduled(`    let r = Customer(0)\n    log.debug(r.id)`))).toEqual([]);
  });

  it("MYNT1045 rejects any other id type, naming the operation", () => {
    expect(first(scheduled(`    let a = load Customer(true)`))).toBe("MYNT1045 Record id must be a number or a string, but load Customer(...) received boolean");
    expect(first(scheduled(`    let a = copy Customer(load Customer(1))`))).toContain("MYNT1045 Record id must be a number or a string, but copy Customer(...) received Customer");
    expect(first(scheduled(`    let r = Customer(123)\n    let a = load Customer(r)`))).toBe(
      "MYNT1045 Record id must be a number or a string, but load Customer(...) received Ref<Customer>; a reference's id is 'r.id'",
    );
    expect(first(scheduled(`    let r = Customer(Customer(1))`))).toContain("MYNT1045 Record id must be a number or a string, but Customer(...) received Ref<Customer>");
  });

  it("a numeric id reaches the fake runtime and resolves the same record as the string", () => {
    const js = output(scheduled(`    let a = load Customer(123)\n    log.debug(a.comments)`));
    const netsuite = seeded();
    netsuite.load(js).execute!(scheduledContext());
    expect(netsuite.record.loadCalls).toEqual([{ type: "customer", id: "123" }]);
    expect(netsuite.log.calls[0]!.details).toBe("Known");
  });

  it("row ids and reference ids stay strings whatever the id was written as", () => {
    expect(type(scheduled(`    for row in query Customer {\n        log.debug(row.i§d)\n    }`))).toBe("string");
    expect(type(scheduled(`    for row in search Customer {\n        log.debug(row.i§d)\n    }`))).toBe("string");
    expect(type(scheduled(`    log.debug(Customer(123).i§d)`))).toBe("string");
    const js = output(scheduled(`    let r = Customer(123)\n    log.debug(r.id)\n    log.debug(Customer(7).id)\n    log.debug(Customer("8").id)`));
    expect(js).toContain("details: r");
    expect(js).toContain('details: "7"');
    expect(js).toContain('details: "8"');
    const netsuite = seeded();
    netsuite.load(js).execute!(scheduledContext());
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["123", "7", "8"]);
  });
});

describe("record references: Ref<T>", () => {
  it("Customer(123) is a RecordReference of type Ref<Customer> that needs no module and performs no call", () => {
    const result = compileMynt(scheduled(`    let customer = Customer(123)\n    log.debug(customer.id)`));
    expect(result.diagnostics).toEqual([]);
    const declaration = result.unit!.kind === "Scheduled" ? result.unit!.entryPoint.body[0]! : undefined;
    expect(declaration).toMatchObject({ kind: "LocalDeclaration", local: { type: { kind: "Reference", record: { name: "Customer" } } } });
    expect((declaration as { initializer: { kind: string } }).initializer.kind).toBe("RecordReference");
    expect([...result.unit!.dependencies]).toEqual(["N/log"]);
    expect(result.output).toContain('const customer = "123";');
    const netsuite = new FakeNetSuite();
    netsuite.load(result.output!).execute!(scheduledContext());
    expect(netsuite.record.loadCalls).toEqual([]);
    expect(netsuite.search.lookupCalls).toEqual([]);
  });

  it("takes exactly one id and no record type arguments", () => {
    expect(first(scheduled(`    let c = Customer()`))).toBe("MYNT1013 Customer(...) takes exactly one argument, the internal id, like Customer(123); received 0");
    expect(first(scheduled(`    let c = Customer(1, 2)`))).toContain("MYNT1013");
    expect(first(scheduled(`    let c = Customer Invoice(1)`))).toContain("MYNT1018 'Customer' is a record type, not an operation; a reference is written Customer(id)");
    // `to` only follows an operation with a type argument, so on a reference it is plain syntax.
    expect(first(scheduled(`    let c = Customer(1) to Invoice`))).toBe("MYNT0001 Expected end of statement, found 'to'");
  });

  it("MYNT1011 field access on a reference points at the lookup and the load", () => {
    expect(first(scheduled(`    let c = Customer(1)\n    log.debug(c.email)`))).toBe(
      "MYNT1011 'c' is a Ref<Customer>: a reference to the record, not the record itself. Look the field up without loading, 'c[email]', or load the record, 'let x = load Customer(c.id)', then 'x.email'",
    );
    expect(first(scheduled(`    let c = Customer(1)\n    log.debug(c.emial)`))).toBe(
      "MYNT1011 Ref<Customer> has no member 'emial'; a reference has '.id'. Did you mean 'email', looked up as 'c[email]'?",
    );
  });

  it("MYNT1046 a reference cannot be assigned through, saved, or deleted", () => {
    expect(first(scheduled(`    let customer = Customer(123)\n    customer.email = "x"`))).toBe(
      "MYNT1046 'customer' is a Ref<Customer>, a reference to the record rather than the record, and cannot be assigned ('email'). To change the record, load it: 'let x = load Customer(customer.id)', then assign 'x.email'",
    );
    expect(first(scheduled(`    let customer = Customer(123)\n    save customer`))).toContain("MYNT1046 'customer' is a Ref<Customer>, a reference to the record rather than the record, and cannot be saved. To change the record, load it: 'let x = load Customer(customer.id)', then 'save x'");
    expect(first(scheduled(`    let customer = Customer(123)\n    delete customer`))).toContain("cannot be deleted");
    expect(first(scheduled(`    save Customer(123)`))).toContain("MYNT1046 A Ref<Customer> value is a Ref<Customer>");
  });

  it("a reference is not a record, a condition, or a collection", () => {
    // References compare by identity (see reference-comparisons.test.ts); ordering is not defined for them.
    expect(messages(scheduled(`    if Customer(1) == Customer(1) { }`))).toEqual([]);
    expect(first(scheduled(`    if Customer(1) < Customer(1) { }`))).toContain("MYNT1023 '<' is not defined for references; references compare by identity with == and !=");
    expect(first(scheduled(`    for x in Customer(1) { }`))).toContain("MYNT1029 Cannot iterate over a Ref<Customer> value");
    expect(first(`fn f(c: Customer) { }\nscheduled {\n    f(Customer(1))\n}\n`)).toContain("MYNT1014 'f' parameter 'c' must be Customer, but received Ref<Customer>");
    expect(first(scheduled(`    if Customer(1) { }`))).toContain("MYNT1021 if condition must be boolean, but received Ref<Customer>");
  });
});

describe("lookup: one field", () => {
  it("has the field's type and extracts it directly from one lookupFields call", () => {
    const source = scheduled(`    let email = Customer(123)[email]\n    log.debug(email)`);
    expect(type(scheduled(`    let email = Customer(123)[em§ail]`))).toBe("string");
    expect(type(scheduled(`    let email = Customer(123)[email]\n    log.debug(em§ail)`))).toBe("string");
    const js = output(source);
    expect(js).toContain('define(["N/log", "N/search"], (log, search) => {');
    expect(js).toContain(`const email = search.lookupFields({\n            type: search.Type.CUSTOMER,\n            id: 123,\n            columns: ["email"]\n        }).email;`);
    expect(js).not.toContain("mynt$search");
    const netsuite = seeded();
    netsuite.load(js).execute!(scheduledContext());
    expect(netsuite.search.lookupCalls).toEqual([{ type: "customer", id: "123", columns: ["email"] }]);
    expect(netsuite.record.loadCalls).toEqual([]);
    expect(netsuite.log.calls[0]!.details).toBe("a@x.com");
  });

  it("works through a reference variable and with a string id", () => {
    const js = output(scheduled(`    let customer = Customer("123")\n    let comments = customer[comments]\n    log.debug(comments)`));
    expect(js).toContain('id: customer,');
    const netsuite = seeded();
    netsuite.load(js).execute!(scheduledContext());
    expect(netsuite.search.lookupCalls).toEqual([{ type: "customer", id: "123", columns: ["comments"] }]);
    expect(netsuite.log.calls[0]!.details).toBe("Known");
  });

  it("a looked-up number field compares as a number, and a Bool field is a condition", () => {
    expect(messages(scheduled(`    if SalesOrder(1)[total] > 10 { }`))).toEqual([]);
    expect(messages(scheduled(`    if MyntLog(1)[custrecord_mynt_done] { }`))).toEqual([]);
    expect(first(scheduled(`    if Customer(1)[email] > 10 { }`))).toContain("MYNT1022 Cannot compare string with number");
  });
});

describe("lookup: several fields", () => {
  const SOURCE = scheduled(`    let info = Customer(123)[email, comments]\n    log.debug(info.email)\n    log.debug(info.comments)`);

  it("is a read-only projection holding exactly those fields, fetched by one call", () => {
    expect(type(scheduled(`    let info = Customer(123)[email, comments]\n    log.debug(in§fo.email)`))).toBe("Customer[email, comments]");
    expect(type(scheduled(`    let info = Customer(123)[email, comments]\n    log.debug(info.ema§il)`))).toBe("string");
    const js = output(SOURCE);
    expect(js).toContain(`const info = search.lookupFields({\n            type: search.Type.CUSTOMER,\n            id: 123,\n            columns: ["email", "comments"]\n        });`);
    expect(js.match(/lookupFields/g)).toHaveLength(1);
    expect(js).toContain("details: info.email");
    const netsuite = seeded();
    netsuite.load(js).execute!(scheduledContext());
    expect(netsuite.search.lookupCalls).toEqual([{ type: "customer", id: "123", columns: ["email", "comments"] }]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["a@x.com", "Known"]);
  });

  it("MYNT1050 only the projected fields exist on it", () => {
    expect(first(scheduled(`    let info = Customer(123)[email, comments]\n    log.debug(info.entityid)`))).toBe(
      "MYNT1050 'entityid' was not projected: 'info' holds only email, comments of Customer. Add it where the projection is made, '[email, comments, entityid]'",
    );
    expect(first(scheduled(`    let info = Customer(123)[email, comments]\n    log.debug(info.emial)`))).toBe("MYNT1050 Customer has no field 'emial'. Did you mean 'email'?");
    expect(first(scheduled(`    let info = Customer(123)[email, comments]\n    log.debug(info.id)`))).toBe("MYNT1050 Customer has no field 'id'; 'info' holds email, comments");
  });

  it("MYNT1046 a projection cannot be assigned through, saved, or deleted", () => {
    expect(first(scheduled(`    let info = Customer(123)[email, comments]\n    info.email = "x"`))).toBe(
      "MYNT1046 'info' is a read-only projection (Customer[email, comments]) of Customer fields and cannot be assigned ('email'). To change the record, load it with 'load Customer(...)' and assign that",
    );
    expect(first(scheduled(`    let info = Customer(123)[email, comments]\n    save info`))).toContain("cannot be saved");
    expect(first(scheduled(`    let info = Customer(123)[email, comments]\n    delete info`))).toContain("cannot be deleted");
  });

  it("a projection is its own type: not a record, not a condition, not iterable", () => {
    expect(first(`fn f(c: Customer) { }\nscheduled {\n    f(Customer(1)[email, comments])\n}\n`)).toContain("must be Customer, but received Customer[email, comments]");
    expect(first(scheduled(`    for x in Customer(1)[email, comments] { }`))).toContain("Cannot iterate over a Customer[email, comments] value");
    expect(first(scheduled(`    let info = Customer(1)[email, comments]\n    let again = info[email]`))).toBe(
      "MYNT1048 'info' is already a projection (Customer[email, comments]); name every field you need in the one '[...]' that makes it",
    );
  });
});

describe("lookup: validation", () => {
  it("MYNT1004 unknown fields use the did-you-mean machinery, and never reach lookupFields", () => {
    expect(first(scheduled(`    let e = Customer(123)[emial]`))).toBe("MYNT1004 Customer has no field 'emial'. Did you mean 'email'?");
    expect(messages(scheduled(`    let e = Customer(123)[emial, commnts]`))).toEqual([
      "MYNT1004 Customer has no field 'emial'. Did you mean 'email'?",
      "MYNT1004 Customer has no field 'commnts'. Did you mean 'comments'?",
    ]);
    expect(first(scheduled(`    let e = SalesOrder(1)[item]`))).toContain("MYNT1004 SalesOrder has no field 'item'");
  });

  it("MYNT1047 rejects a duplicate field", () => {
    expect(first(scheduled(`    let e = Customer(123)[email, email]`))).toBe("MYNT1047 'email' is projected twice (first at column 27); list each field once");
  });

  it("MYNT0001 rejects an empty list, a quoted field, and indexing", () => {
    expect(first(scheduled(`    let e = Customer(123)[]`))).toBe("MYNT0001 Expected at least one field inside '[...]', like Customer(...)[email]");
    expect(first(scheduled(`    let e = Customer(123)["email"]`))).toBe(`MYNT0001 Expected a field name inside '[...]', found string "email". Fields are written without quotes, like [email]`);
    expect(first(scheduled(`    let rows = query Customer\n    let e = rows[0]`))).toBe("MYNT0001 Expected identifier as a field name inside '[...]', found number 0");
  });

  it("MYNT1048 only references, records, and rows can be projected", () => {
    expect(first(scheduled(`    let e = "x"[email]`))).toBe("MYNT1048 Cannot project fields from a string value; '[...]' reads fields of a record reference, a record, or a row");
    expect(first(scheduled(`    let e = Customer[email]`))).toBe("MYNT1048 'Customer' is a record type; project fields from a reference to one record, like Customer(123)[email]");
    expect(first(scheduled(`    let e = log[email]`))).toContain("MYNT1048 'log' is a built-in namespace");
    expect(first(scheduled(`    let o = load SalesOrder(1)\n    for line in o.item {\n        let q = line[quantity]\n    }`))).toContain("MYNT1048 A sublist line cannot be projected");
    expect(first(scheduled(`    let rows = query Customer\n    let e = rows[email]`))).toContain("Cannot project fields from a Sequence<Customer> value");
  });

  it("a half-typed projection keeps its receiver bound and reports once", () => {
    const result = compileMynt(scheduled(`    let e = Customer(123)[`));
    expect(errorCodes(result)).toEqual(["MYNT0001"]);
    expect(result.unit!.expressions.some((e) => e.kind === "RecordReference")).toBe(true);
  });
});

describe("lookup: local receivers", () => {
  it("a loaded record projects locally with getValue and no search call", () => {
    const js = output(scheduled(`    let customer = load Customer(123)\n    let info = customer[email, comments]\n    let email = customer[email]\n    log.debug(info.comments)\n    log.debug(email)`));
    expect(js).toContain('define(["N/log", "N/record"], (log, record) => {');
    expect(js).not.toContain("lookupFields");
    expect(js).toContain(`const info = {\n            email: customer.getValue({\n                fieldId: "email"\n            }),\n            comments: customer.getValue({\n                fieldId: "comments"\n            })\n        };`);
    expect(js).toContain(`const email = customer.getValue({\n            fieldId: "email"\n        });`);
    const netsuite = seeded();
    netsuite.load(js).execute!(scheduledContext());
    expect(netsuite.search.lookupCalls).toEqual([]);
    expect(netsuite.record.loadCalls).toHaveLength(1);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["Known", "a@x.com"]);
  });

  it("the context record projects locally too, and a reference inside a user event still looks up", () => {
    const js = output(`beforeSubmit edit (customer: Customer) {\n    let info = customer[email, comments]\n    let other = Customer(123)[email]\n    log.debug(info.email)\n    log.debug(other)\n}\n`);
    expect(js).toContain('define(["N/log", "N/search"], (log, search) => {');
    expect(js.match(/lookupFields/g)).toHaveLength(1);
    const netsuite = seeded();
    const record = new FakeRecord("customer", { email: "ctx@x.com", comments: "" });
    netsuite.load(js).beforeSubmit!(userEventContext("edit", record));
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["ctx@x.com", "a@x.com"]);
  });

  it("a row projects the columns the planner fetched, for query and search alike", () => {
    for (const operation of ["query", "search"] as const) {
      const js = output(scheduled(`    for row in ${operation} Customer {\n        let info = row[comments, email]\n        log.debug(info.email)\n        log.debug(row[comments])\n    }`));
      expect(js).toContain(`const info = {\n                comments: row.comments,\n                email: row.email\n            };`);
      expect(js).toContain("details: row.comments");
      const netsuite = seeded();
      netsuite.load(js).execute!(scheduledContext());
      expect(netsuite.search.lookupCalls).toEqual([]);
      if (operation === "query") expect(netsuite.query.runs[0]!.columns).toEqual(["id", "comments", "email"]);
      else expect(netsuite.search.runs[0]!.columns).toEqual(["internalid", "comments", "email"]);
      expect(netsuite.log.calls).toHaveLength(10);
    }
  });

  it("MYNT1027 a projection of a deleted record is a use after delete", () => {
    expect(first(scheduled(`    let c = load Customer(1)\n    delete c\n    let e = c[email]`))).toBe("MYNT1027 Cannot read field 'email' because 'c' has been deleted");
  });

  it("the flagship example compiles, infers N/record and N/search, and runs", () => {
    const result = compileMynt(LOOKUP, "examples/lookup-customer.mn");
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toMatchSnapshot();
    const netsuite = seeded();
    netsuite.record.seed("customer", "123", { email: "", comments: "Known" });
    netsuite.load(result.output!).execute!(scheduledContext());
    expect(netsuite.search.lookupCalls.map((c) => c.columns)).toEqual([["email"], ["email", "comments"]]);
    expect(netsuite.record.persisted("customer", "123")).toEqual({ email: "unknown@example.com", comments: "Known" });
  });
});

describe("search: an explicit N/search backend", () => {
  it("search T is a Sequence from N/search; query T stays a Sequence from N/query", () => {
    const result = compileMynt(scheduled(`    let viaQuery = query Customer\n    let viaSearch = search Customer\n    for a in viaQuery { }\n    for b in viaSearch { }`));
    expect(result.diagnostics).toEqual([]);
    const [q, s] = result.unit!.kind === "Scheduled" ? result.unit!.entryPoint.body : [];
    expect(q).toMatchObject({ initializer: { kind: "Query", operation: "query", type: { kind: "Sequence", source: "query", element: { origin: "query" } } } });
    expect(s).toMatchObject({ initializer: { kind: "Query", operation: "search", type: { kind: "Sequence", source: "search", element: { origin: "search" } } } });
    expect([...result.unit!.dependencies].sort()).toEqual(["N/query", "N/search"]);
    expect(result.output).toContain("function mynt$query(");
    expect(result.output).toContain("function mynt$search(");
    expect(first(scheduled(`    let a = query Customer\n    let b = search Customer\n    if a == b { }`))).toContain("MYNT1023");
  });

  it("the flagship example runs: filters, row fields, load by row id, save", () => {
    const result = compileMynt(SEARCH, "examples/search-customers.mn");
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toMatchSnapshot();
    expect(result.output).toContain('define(["N/log", "N/record", "N/search"], (log, record, search) => {');
    expect(result.output).not.toContain("N/query");
    const netsuite = seeded();
    netsuite.load(result.output!).execute!(scheduledContext());
    expect(netsuite.search.runs).toEqual([
      { type: "customer", columns: ["internalid", "email"], filters: [["email", "isnotempty", ""], "and", ["comments", "isempty", ""]] },
    ]);
    expect(netsuite.record.loadCalls.map((c) => c.id)).toEqual(["1", "4"]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["a@x.com", "d@x.com"]);
    expect(netsuite.record.persisted("customer", "1")).toEqual({ email: "a@x.com", comments: "Reviewed by Mynt" });
    expect(netsuite.record.persisted("customer", "123")).toBeUndefined();
  });

  it("without a where clause every record is a row, and rows carry id plus the planned columns", () => {
    const js = output(scheduled(`    let customers = search Customer\n    for c in customers {\n        log.debug(c.id)\n    }`));
    expect(js).toContain("mynt$search(search.Type.CUSTOMER, [], [])");
    const netsuite = seeded();
    netsuite.load(js).execute!(scheduledContext());
    expect(netsuite.search.runs).toEqual([{ type: "customer", columns: ["internalid"], filters: undefined }]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["1", "2", "3", "4", "123"]);
  });

  it("lowers each supported predicate to its N/search operator", () => {
    const filters = (where: string, record = "Customer") => {
      const js = output(scheduled(`    let n = "x"\n    let floor = 5\n    for r in search ${record} where ${where} {\n        log.debug(r.id)\n    }`));
      const netsuite = seeded();
      netsuite.record.seed("salesorder", "9", { memo: "m", total: 7 });
      netsuite.record.seed("customrecord_mynt_log", "10", { name: "a", custrecord_mynt_done: true });
      netsuite.record.seed("customrecord_mynt_log", "11", { name: "b", custrecord_mynt_done: false });
      netsuite.load(js).execute!(scheduledContext());
      return { filters: netsuite.search.runs[0]!.filters, ids: netsuite.log.calls.map((c) => c.details) };
    };
    expect(filters(`email == "a@x.com"`)).toEqual({ filters: [["email", "is", "a@x.com"]], ids: ["1", "123"] });
    expect(filters(`email != "a@x.com"`)).toEqual({ filters: [["email", "isnot", "a@x.com"]], ids: ["2", "3", "4"] });
    expect(filters(`email == ""`)).toEqual({ filters: [["email", "isempty", ""]], ids: ["2"] });
    expect(filters(`"" != email`)).toEqual({ filters: [["email", "isnotempty", ""]], ids: ["1", "3", "4", "123"] });
    expect(filters(`email == n`)).toEqual({ filters: [["email", "is", "x"]], ids: [] });
    expect(filters(`total > floor`, "SalesOrder")).toEqual({ filters: [["total", "greaterthan", 5]], ids: ["9"] });
    expect(filters(`total >= 7`, "SalesOrder").filters).toEqual([["total", "greaterthanorequalto", 7]]);
    expect(filters(`total < 7`, "SalesOrder").filters).toEqual([["total", "lessthan", 7]]);
    expect(filters(`7 >= total`, "SalesOrder").filters).toEqual([["total", "lessthanorequalto", 7]]);
    expect(filters(`total == 7`, "SalesOrder").filters).toEqual([["total", "equalto", 7]]);
    expect(filters(`total != 7`, "SalesOrder").filters).toEqual([["total", "notequalto", 7]]);
    expect(filters(`custrecord_mynt_done`, "MyntLog")).toEqual({ filters: [["custrecord_mynt_done", "is", "T"]], ids: ["10"] });
    expect(filters(`!custrecord_mynt_done`, "MyntLog")).toEqual({ filters: [["custrecord_mynt_done", "is", "F"]], ids: ["11"] });
    expect(filters(`email != "" && comments == ""`).filters).toEqual([["email", "isnotempty", ""], "and", ["comments", "isempty", ""]]);
    expect(filters(`email == "" || comments != ""`)).toEqual({ filters: [["email", "isempty", ""], "or", ["comments", "isnotempty", ""]], ids: ["2", "3", "123"] });
    // `!` is pushed down: operators flip and De Morgan applies, so there is never a `not` in the expression.
    expect(filters(`!(email == "" || comments != "")`)).toEqual({ filters: [["email", "isnotempty", ""], "and", ["comments", "isempty", ""]], ids: ["1", "4"] });
    expect(filters(`!!(email == "")`).filters).toEqual([["email", "isempty", ""]]);
    expect(filters(`(email != "" && comments == "") || email == "c@x.com"`).filters).toEqual([
      [["email", "isnotempty", ""], "and", ["comments", "isempty", ""]],
      "or",
      ["email", "is", "c@x.com"],
    ]);
  });

  it("emits the filter expression with enum operators and the search module local", () => {
    const js = output(scheduled(`    for r in search Customer where email != "" || comments == "x" {\n        log.debug(r.id)\n    }`));
    expect(js).toContain(`mynt$search(\n            search.Type.CUSTOMER,\n            [],\n            [],\n            [\n                ["email", search.Operator.ISNOTEMPTY, ""],\n                "or",\n                ["comments", search.Operator.IS, "x"]\n            ]\n        )`);
    expect(output(scheduled(`    let search = "x"\n    for r in search Customer where email == search {\n        log.debug(r.id)\n    }`))).toContain('["email", search$.Operator.IS, search]');
  });

  it("MYNT1049 rejects what N/search cannot express honestly", () => {
    expect(first(scheduled(`    for r in search SalesOrder where !(total > 5) { }`))).toBe(
      "MYNT1049 Unsupported search condition: '!' over an ordering comparison on 'total' has no exact N/search operator (an empty field matches neither side); write the comparison you mean instead",
    );
    expect(first(scheduled(`    for r in search SalesOrder where !(total > 5 && memo == "") { }`))).toContain("MYNT1049");
    expect(first(scheduled(`    for r in search Customer where email == comments { }`))).toBe("MYNT1049 Unsupported search condition: a field can be compared with a value, not with another field");
    expect(first(scheduled(`    for r in search Customer where email == entityid { }`))).toContain("MYNT1049");
    expect(first(scheduled(`    let c = load Customer(1)\n    for r in search Customer where email == c.email { }`))).toBe(
      "MYNT1049 Unsupported search condition: a field can only be compared with a literal or a local value",
    );
    expect(first(scheduled(`    for r in search Customer where email { }`))).toContain("MYNT1021 where condition must be boolean");
    expect(first(scheduled(`    for r in query Customer where email == comments { }`))).toContain("MYNT1031 Unsupported query condition");
  });

  it("MYNT1030 search rows are read-only views, like query rows", () => {
    expect(first(scheduled(`    for row in search Customer {\n        row.comments = "x"\n    }`))).toBe(
      "MYNT1030 Search result 'row' is read-only. Load the record before modifying it: 'let x = load Customer(row.id)', then assign 'x.comments'",
    );
    expect(first(scheduled(`    for row in search Customer {\n        save row\n    }`))).toBe(
      "MYNT1030 Search result 'row' cannot be saved: a search row is a read-only view. Load the record first: 'let x = load Customer(row.id)', then 'save x'",
    );
    expect(first(scheduled(`    for row in search Customer {\n        delete row\n    }`))).toContain("cannot be deleted: a search row is a read-only view");
    expect(first(scheduled(`    for row in search SalesOrder {\n        for line in row.item { }\n    }`))).toContain("MYNT1034 Sublist 'item' is available only on a loaded or context SalesOrder; a search row has no lines");
    expect(first(`fn f(c: Customer) { }\nscheduled {\n    for row in search Customer {\n        f(row)\n    }\n}\n`)).toContain("MYNT1044 A search row cannot be passed to 'f'");
    expect(first(scheduled(`    for row in search Customer {\n        log.debug(row.nope)\n    }`))).toContain("MYNT1004 Customer has no field 'nope'");
  });

  it("plans search columns from row field reads, as for queries, and pages through large results", () => {
    const js = output(scheduled(`    let rows = search SalesOrder\n    for r in rows {\n        log.debug(r.memo)\n    }\n    for r in rows {\n        if r.total > 10 {\n            log.debug(r.id)\n        }\n    }`));
    expect(js).toContain('mynt$search(search.Type.SALES_ORDER, ["memo", "total"], [])');
    const netsuite = new FakeNetSuite();
    for (let i = 1; i <= 2500; i++) netsuite.record.seed("salesorder", String(i), { memo: `o${i}`, total: i });
    netsuite.load(js).execute!(scheduledContext());
    expect(netsuite.search.runs).toEqual([{ type: "salesorder", columns: ["internalid", "memo", "total"], filters: undefined }]);
    expect(netsuite.log.calls).toHaveLength(2500 + 2490);
    expect(netsuite.log.calls[0]!.details).toBe("o1");
    expect(netsuite.log.calls[2500]!.details).toBe("11");
  });

  it("a custom record searches by its script id, and lookups do too", () => {
    const js = output(scheduled(`    for r in search MyntLog where custrecord_mynt_done {\n        log.debug(r.name)\n    }\n    log.debug(MyntLog(10)[name])`));
    expect(js).toContain('mynt$search("customrecord_mynt_log", ["name"], [], [["custrecord_mynt_done", search.Operator.IS, "T"]])');
    expect(js).toMatch(/type: "customrecord_mynt_log",\s+id: 10,\s+columns: \["name"\]/);
  });

  it("query is unchanged: N/query, EMPTY_NOT, the query helper, and its tests' shape", () => {
    const js = output(scheduled(`    for c in query Customer where email != "" {\n        log.debug(c.email)\n    }`));
    expect(js).toContain('define(["N/log", "N/query"], (log, query) => {');
    expect(js).toContain("operator: query.Operator.EMPTY_NOT");
    expect(js).not.toContain("search");
  });
});

describe("search and lookup: editor features", () => {
  const TOUR = scheduled(`    let reference = Customer(123)\n    let info = reference[email, comments]\n    for row in search Customer\n        where email != "" {\n        log.debug(row.id)\n    }`);

  it("semantic tokens: search is a builtin operation, Customer a struct, projected fields properties", () => {
    const all = tokens(TOUR);
    expect(all.filter((t) => /^(search|Customer):/.test(t))).toEqual(["Customer:struct", "search:function+defaultLibrary", "Customer:struct"]);
    expect(all.filter((t) => /^(email|comments):/.test(t))).toEqual(["email:property", "comments:property", "email:property"]);
    expect(all.filter((t) => t.startsWith("where:"))).toEqual(["where:keyword"]);
    expect(all.filter((t) => t.startsWith("id:"))).toEqual(["id:property+readonly"]);
    expect(all.filter((t) => /^(reference|info):/.test(t))).toEqual(["reference:variable+declaration", "info:variable+declaration", "reference:variable"]);
    expect(tokens(scheduled(`    let search = "x"\n    log.debug(search)`)).filter((t) => t.startsWith("search:"))).toEqual(["search:variable+declaration", "search:variable"]);
  });

  it("completion: fields inside [...], minus the ones listed; only projected fields after a projection; id on a reference", () => {
    expect(labels(scheduled(`    let e = Customer(123)[§`))).toEqual(["comments", "email", "entityid"]);
    expect(labels(scheduled(`    let e = Customer(123)[email, §`))).toEqual(["comments", "entityid"]);
    expect(labels(scheduled(`    let e = Customer(123)[email, com§`))).toEqual(["comments", "entityid"]);
    expect(labels(scheduled(`    let customer = Customer(123)\n    let e = customer[§`))).toEqual(["comments", "email", "entityid"]);
    expect(labels(scheduled(`    let customer = load SalesOrder(1)\n    let e = customer[§`))).toEqual(["memo", "total"]);
    expect(labels(scheduled(`    for row in search Customer {\n        let e = row[§`))).toEqual(["comments", "email", "entityid"]);
    expect(labels(scheduled(`    let info = Customer(123)[email, comments]\n    log.debug(info.§)`))).toEqual(["email", "comments"]);
    expect(labels(scheduled(`    let customer = Customer(123)\n    log.debug(customer.§)`))).toEqual(["id"]);
    expect(labels(scheduled(`    let e = "x"[§`))).toEqual([]);
  });

  it("completion: search offers record types, then fields after where, and search rows complete like query rows", () => {
    expect(labels(scheduled(`    let c = search Cus§`))).toEqual(["Customer", "SalesOrder", "MyntLog", "Invoice"]);
    expect(labels(scheduled(`    let c = search Customer where ema§`))).toEqual(["comments", "email", "entityid", "true", "false"]);
    expect(labels(scheduled(`    let c = search Customer\n        where email != "" && §`))).toContain("comments");
    expect(labels(scheduled(`    for row in search SalesOrder {\n        log.debug(row.§)\n    }`))).toEqual(["id", "memo", "total"]);
    expect(labels(scheduled(`    §`))).toContain("search");
    const items = completionsAt(at(scheduled(`    §`)).doc, at(scheduled(`    §`)).offset);
    expect(items.find((i) => i.label === "search")).toMatchObject({ detail: "search T where ...: Sequence<T>" });
  });

  it("hover: a reference, a looked-up field, a projection local, a search", () => {
    expect(hover(scheduled(`    let c = Cust§omer(123)`))).toBe(
      "```mynt\nCustomer(id: string | number): Ref<Customer>\n```\n\nCustomer reference · id: string · nothing is loaded · read fields with `[comments, ...]` (one `N/search.lookupFields` call) or load it with `load Customer(ref.id)`",
    );
    expect(hover(scheduled(`    let c = Customer(123)\n    log.debug(§c.id)`))).toBe(
      "```mynt\nc: Ref<Customer>\n```\n\nlocal · Customer reference · id: string · nothing is loaded; read fields with `[comments, ...]` (one `N/search.lookupFields` call) or load it with `load Customer(c.id)`",
    );
    expect(hover(scheduled(`    let c = Customer(123)\n    log.debug(c.i§d)`))).toBe("```mynt\nCustomer.id: string\n```\n\ninternal id of the record · use it to `load` the record");
    expect(hover(scheduled(`    let e = Customer(123)[em§ail]`))).toBe("```mynt\nCustomer.email: string\n```\n\nEmail · string · writable · NetSuite field `email`");
    expect(hover(scheduled(`    let info = Customer(123)[email, comments]\n    log.debug(in§fo.email)`))).toBe(
      "```mynt\ninfo: Customer[email, comments]\n```\n\nlocal · read-only projection of Customer: email: string, comments: string",
    );
    expect(hover(scheduled(`    let info = Customer(123)[email, comments]\n    log.debug(info.ema§il)`))).toContain("Customer.email: string");
    expect(hover(scheduled(`    let rows = sea§rch Customer where email != ""`))).toBe(
      "```mynt\nsearch Customer where ...: Sequence<Customer>\n```\n\nsearch over `N/search` · read-only rows with `id` and the fields the program reads · one search runs per expression",
    );
    expect(hover(scheduled(`    let rows = search Customer\n    for r in ro§ws { }`))).toBe("```mynt\nrows: Sequence<Customer>\n```\n\nlocal · Sequence<Customer> (N/search result, read-only rows)");
    expect(hover(scheduled(`    for row in search Customer {\n        log.debug(ro§w.email)\n    }`))).toBe("```mynt\nrow: Customer\n```\n\nloop variable · Customer (search result, read-only)");
    expect(hover(scheduled(`    let rows = que§ry Customer`))).toContain("query over `N/query`");
  });

  it("signature help: the reference constructor", () => {
    const { doc, offset } = at(scheduled(`    let c = Customer(§)`));
    const help = signatureHelpAt(doc, offset)!;
    expect(help.signature.label).toBe("Customer(id: string | number): Ref<Customer>");
    expect(help.activeParameter).toBe(0);
  });

  it("references and rename: a projected field is a reference to the schema field, and search is reserved", () => {
    const { doc, offset } = at(scheduled(`    let c = Customer(123)\n    let e = c[em§ail]\n    for row in search Customer {\n        log.debug(row.email)\n    }`));
    const symbol = symbolAt(doc, offset)!;
    expect(symbol).toMatchObject({ kind: "field", record: { name: "Customer" }, field: { id: "email" } });
    expect(referencesOf(doc, symbol).map((r) => `${r.span.start.line}:${r.span.start.column}`)).toEqual(["3:15", "5:23"]);
    const local = doc.unit!.symbols.find((s) => s.local.name === "c")!.local;
    expect(renameConflict(doc, local, "search")).toBe("'search' is reserved and cannot name a local");
  });
});
