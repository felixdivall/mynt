/**
 * References compared as typed identities: `entity == Customer(123)` in a
 * search, and `ref == ref` anywhere. Equality is always `.id` against
 * `.id`; display text and runtime shape never take part; the record type
 * must agree on both sides; N/search filters select fields with
 * anyof/noneof over ids. Uses the reference fixture (tests/helpers.ts).
 */
import { parse as parseJs } from "acorn";
import { describe, expect, it } from "vitest";
import { compile } from "../src/compiler.js";
import { completionsAt } from "../src/lsp/completion.js";
import { hoverAt } from "../src/lsp/hover.js";
import { analyze } from "../src/semantic/query.js";
import { referenceSchema } from "./helpers.js";
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
function at(source: string) {
  const offset = source.indexOf("§");
  const text = source.slice(0, offset) + source.slice(offset + 1);
  return { doc: analyze(text, "t.mn", referenceSchema), offset, text };
}
const labels = (source: string) => completionsAt(at(source).doc, at(source).offset).map((i) => i.label);
const hover = (source: string) => hoverAt(at(source).doc, at(source).offset)?.contents;

/** Orders whose `entity` select field holds a customer id, with display text beside it, as the backend lowering expects. */
function seeded() {
  const netsuite = new FakeNetSuite();
  netsuite.record.seed("customer", "123", { email: "a@x.com", comments: "", subsidiary: "1" }, {}, { subsidiary: "Parent Company" });
  netsuite.record.seed("customer", "124", { email: "b@x.com", comments: "", subsidiary: "2" }, {}, { subsidiary: "Nordic AB" });
  netsuite.record.seed("salesorder", "5", { memo: "first", total: 10, entity: "123" }, {}, { entity: "Acme" });
  netsuite.record.seed("salesorder", "6", { memo: "second", total: 20, entity: "124" }, {}, { entity: "Beta" });
  netsuite.record.seed("salesorder", "7", { memo: "third", total: 30, entity: "123" }, {}, { entity: "Acme" });
  netsuite.record.seed("salesorder", "8", { memo: "orphan", total: 0, entity: "" }, {}, { entity: "" });
  return netsuite;
}
const run = (js: string) => {
  const netsuite = seeded();
  netsuite.load(js).execute!(scheduledContext());
  return netsuite;
};

describe("search where: reference equality by identity", () => {
  it("entity == Customer(123) is a reference leaf in both IRs and lowers to anyof over the id, never the reference object", () => {
    const source = scheduled(`    let orders = search SalesOrder\n        where entity == Customer(123)\n    for order in orders {\n        log.debug(order.memo)\n    }`);
    const result = compileRefs(source);
    expect(result.diagnostics).toEqual([]);
    const declaration = result.unit!.kind === "Scheduled" ? result.unit!.entryPoint.body[0]! : undefined;
    expect(declaration).toMatchObject({
      initializer: {
        kind: "Query",
        predicate: { kind: "CompareReference", field: { id: "entity" }, record: { name: "Customer" }, operation: "Equal", values: [{ kind: "Id", value: { kind: "Constant", value: 123 } }] },
        filter: { kind: "ReferenceFilter", field: { id: "entity" }, operator: "ANYOF", values: [{ kind: "Id", value: { kind: "Constant", value: 123 } }] },
      },
    });
    expect(result.output).toContain('["entity", search.Operator.ANYOF, ["123"]]');
    expect(result.output!.split("function execute")[1]).not.toMatch(/\.text|value/);
    const netsuite = run(result.output!);
    expect(netsuite.search.runs[0]!.filters).toEqual([["entity", "anyof", ["123"]]]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["first", "third"]);
    expect(netsuite.search.lookupCalls).toEqual([]);
  });

  it("!= lowers to noneof, the exact select complement; a field on the right flips nothing", () => {
    const js = output(scheduled(`    for order in search SalesOrder where entity != Customer("123") {\n        log.debug(order.memo)\n    }\n    for order in search SalesOrder where Customer(124) == entity {\n        log.debug(order.memo)\n    }`));
    expect(js).toContain('["entity", search.Operator.NONEOF, ["123"]]');
    expect(js).toContain('["entity", search.Operator.ANYOF, ["124"]]');
    const netsuite = run(js);
    expect(netsuite.search.runs.map((r) => r.filters)).toEqual([[["entity", "noneof", ["123"]]], [["entity", "anyof", ["124"]]]]);
    // noneof, as the complement of anyof, matches the order whose entity is empty; see the unverified assumptions in the README.
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["second", "orphan", "second"]);
  });

  it("! over a reference comparison flips the operator, and composes with other filters", () => {
    const js = output(scheduled(`    for order in search SalesOrder where !(entity == Customer(123)) && total > 5 {\n        log.debug(order.memo)\n    }`));
    expect(js).toContain('["entity", search.Operator.NONEOF, ["123"]]');
    expect(js).toContain('["total", search.Operator.GREATERTHAN, 5]');
    expect(run(js).log.calls.map((c) => c.details)).toEqual(["second"]);
  });

  it("a captured reference local is emitted as its id, whether identity or display, whatever its id was written as", () => {
    const js = output(
      scheduled(
        `    let customer = Customer(123)\n    let n = 124\n    let other = Customer(n)\n    let parentCompany = Customer(123)[subsidiary]\n` +
          `    for order in search SalesOrder where entity == customer {\n        log.debug(order.memo)\n    }\n` +
          `    for order in search SalesOrder where entity == other {\n        log.debug(order.memo)\n    }\n` +
          `    for row in search Customer where subsidiary == parentCompany {\n        log.debug(row.email)\n    }\n` +
          `    for row in search Customer where subsidiary == Subsidiary("2") {\n        log.debug(row.email)\n    }`,
      ),
    );
    expect(js).toContain('const customer = "123";');
    expect(js).toContain("const other = String(n);");
    expect(js).toContain('["entity", search.Operator.ANYOF, [customer]]');
    expect(js).toContain('["entity", search.Operator.ANYOF, [other]]');
    // A display reference contributes its id only; its text is never read.
    expect(js).toContain('["subsidiary", search.Operator.ANYOF, [parentCompany.id]]');
    expect(js).toContain('["subsidiary", search.Operator.ANYOF, ["2"]]');
    const netsuite = run(js);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["first", "third", "second", "a@x.com", "b@x.com"]);
    expect(netsuite.search.lookupCalls).toHaveLength(1);
  });

  it("a reference read from a record or row can be captured in a local and compared", () => {
    const js = output(scheduled(`    let order = load SalesOrder(5)\n    let customer = order.entity\n    for o in search SalesOrder where entity == customer {\n        log.debug(o.memo)\n    }`));
    expect(js).toContain('["entity", search.Operator.ANYOF, [customer]]');
    expect(run(js).log.calls.map((c) => c.details)).toEqual(["first", "third"]);
  });

  it("only a constructor with a literal or local id, or a reference local, can be a filter value", () => {
    expect(first(scheduled(`    let order = load SalesOrder(5)\n    for o in search SalesOrder where entity == order.entity { }`))).toBe(
      "MYNT1049 Unsupported search condition: a reference in a condition is written Customer(id) with a literal or local id, or is a reference local",
    );
    expect(first(scheduled(`    let row = load SalesOrder(5)\n    for o in search SalesOrder where entity == Customer(row.memo) { }`))).toContain("MYNT1049");
  });

  it("entity.id against a string points back at the typed form", () => {
    expect(first(scheduled(`    for o in search SalesOrder where entity.id == "123" { }`))).toBe(
      "MYNT1049 Unsupported search condition: compare the reference itself rather than its id: 'entity == Customer(...)' keeps the record type checked",
    );
  });
});

describe("reference comparison typing", () => {
  it("rejects a different record target, a raw id, a scalar field against a reference, and an unknown target", () => {
    expect(first(scheduled(`    for o in search SalesOrder where entity == Subsidiary(1) { }`))).toBe(
      "MYNT1022 Cannot compare a Customer reference with a Subsidiary reference: they refer to different record types",
    );
    expect(first(scheduled(`    for o in search SalesOrder where entity == "123" { }`))).toBe(
      'MYNT1022 Cannot compare a Customer reference with a string: a reference compares with a reference, by identity, and loose equality does not coerce references. Write the reference, Customer("123"), so the record type is checked, rather than its raw id',
    );
    expect(first(scheduled(`    for o in search SalesOrder where entity === "123" { }`))).toContain("by identity. Write the reference");
    expect(first(scheduled(`    for o in search SalesOrder where entity == 123 { }`))).toContain("Write the reference, Customer(123)");
    expect(first(scheduled(`    for o in search SalesOrder where memo == Customer(123) { }`))).toBe(
      "MYNT1022 Cannot compare 'memo', a string field, with a Customer reference: a reference compares only with a reference to the same record type",
    );
    expect(first(scheduled(`    for c in search Customer where parent == Customer(123) { }`))).toBe(
      "MYNT1023 Cannot compare 'parent': Mynt cannot verify which record type it refers to, because the schema metadata names no target for it. Comparisons between references need a known target on both sides",
    );
    expect(first(scheduled(`    for c in search Customer where category == CustomerCategory(1) { }`))).toBe(
      "MYNT1023 'category' is a multiselect: it holds several references, so '==' against one reference has no meaning. A membership test for multiselects is not supported yet",
    );
    expect(first(scheduled(`    if Customer(1) < Customer(2) { }`))).toContain("MYNT1023 '<' is not defined for references; references compare by identity with == and !=");
  });

  it("query shares the expression rule but refuses to lower a reference comparison, since N/query's operator is undecided", () => {
    expect(first(scheduled(`    for o in query SalesOrder where entity == Customer(123) { }`))).toBe(
      "MYNT1031 Unsupported query condition: comparing the reference field 'entity' is supported by 'search'; how N/query filters a select field by id has not been decided, so 'query' does not lower it yet",
    );
    expect(messages(scheduled(`    for o in query SalesOrder where memo == "x" { }`))).toEqual([]);
  });
});

describe("ordinary expression equality on references", () => {
  it("compares identities with ===, normalizing identity and display shapes, outside any search", () => {
    const js = output(
      scheduled(
        `    let order = load SalesOrder(5)\n    let subsidiary = Customer(123)[subsidiary]\n    let n = 123\n` +
          `    if order.entity === Customer(123) {\n        log.debug("mine")\n    }\n` +
          `    if order.entity !== Customer(n) {\n        log.debug("not mine")\n    }\n` +
          `    if subsidiary === Subsidiary(1) {\n        log.debug("parent")\n    }\n` +
          `    if Customer(123)[subsidiary] == order.entity[subsidiary] {\n        log.debug("same subsidiary")\n    }\n` +
          `    for row in search SalesOrder {\n        if row.entity === order.entity {\n            log.debug(row.memo)\n        }\n    }`,
      ),
    );
    expect(js).toMatch(/order\.getValue\(\{\s+fieldId: "entity"\s+\}\) === "123"/);
    expect(js).toContain("}) !== String(n)");
    expect(js).toContain('subsidiary.id === "1"');
    // A loose reference comparison is still identity: both sides are canonical id strings, and the operator is emitted as written.
    expect(js).toContain(".subsidiary.id == ");
    expect(js).toContain(`row.entity.id === order.getValue({`);
    const netsuite = run(js);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["mine", "parent", "same subsidiary", "first", "third"]);
    expect(netsuite.search.lookupCalls.map((c) => c.columns)).toEqual([["subsidiary"], ["subsidiary"], ["subsidiary"]]);
  });

  it("is the same type rule everywhere: wrong targets and raw ids are rejected outside search too", () => {
    expect(first(scheduled(`    if Customer(1) == Subsidiary(1) { }`))).toContain("MYNT1022 Cannot compare a Customer reference with a Subsidiary reference");
    expect(first(scheduled(`    let c = load Customer(123)\n    if c.subsidiary == "1" { }`))).toContain("Write the reference, Subsidiary(\"1\")");
  });
});

describe("editor regression around reference predicates", () => {
  it("completion after == still offers the constructor and locals, and the field completes as a reference", () => {
    const items = labels(scheduled(`    let customer = Customer(123)\n    for o in search SalesOrder where entity == §`));
    expect(items).toContain("customer");
    expect(items).toContain("memo");
    expect(labels(scheduled(`    for o in search SalesOrder where ent§`))).toContain("entity");
    // On a search row the reference also offers the fields a join can plan.
    expect(labels(scheduled(`    for o in search SalesOrder where entity == Customer(123) {\n        log.debug(o.entity.§)\n    }`))).toEqual(["id", "text", "comments", "email", "entityid", "subsidiary", "parent", "category"]);
  });

  it("hover shows the reference field and the constructor on each side of ==", () => {
    expect(hover(scheduled(`    for o in search SalesOrder where ent§ity == Customer(123) { }`))).toBe(
      "```mynt\nSalesOrder.entity: Ref\n```\n\nCustomer · reference to Customer · writable · NetSuite field `entity`",
    );
    expect(hover(scheduled(`    for o in search SalesOrder where entity == Cust§omer(123) { }`))).toContain("Customer reference · id: string");
    expect(hover(scheduled(`    let customer = Customer(123)\n    for o in search SalesOrder where entity == cust§omer { }`))).toContain("customer: Ref<Customer>");
  });
});
