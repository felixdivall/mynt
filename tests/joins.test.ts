/**
 * Typed joins: a schema-known relationship (`SalesOrder.entity ->
 * Customer`) makes the referenced record's fields usable in a search,
 * as `entity.email` in a condition and `order.entity.email` on a row. The
 * join is one planned column of the same search: no record is loaded,
 * nothing is looked up. One hop only; a bare `Ref<T>` elsewhere keeps
 * its `id`/`text`, and `[field]` stays the explicit lookup. Uses the
 * reference fixture (tests/helpers.ts).
 */
import { parse as parseJs } from "acorn";
import { describe, expect, it } from "vitest";
import { compile } from "../src/compiler.js";
import { completionsAt } from "../src/lsp/completion.js";
import { hoverAt } from "../src/lsp/hover.js";
import { analyze, typeAt } from "../src/semantic/query.js";
import { referencesOf, symbolAt } from "../src/semantic/symbols.js";
import { semanticTokens } from "../src/semantic/tokens.js";
import { typeName } from "../src/semantic/types.js";
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
const type = (source: string) => {
  const { doc, offset } = at(source);
  const t = typeAt(doc, offset);
  return t && typeName(t);
};
const tokens = (text: string) =>
  semanticTokens(analyze(text, "t.mn", referenceSchema)).map((t) => `${text.slice(t.span.start.offset, t.span.end.offset)}:${t.kind}${t.modifiers.map((m) => `+${m}`).join("")}`);

/** Orders referencing customers, with the fake told that a sales order search joins through `entity` to customers. */
function seeded() {
  const netsuite = new FakeNetSuite();
  netsuite.record.seed("subsidiary", "1", { name: "Parent Company", country: "SE" });
  netsuite.record.seed("subsidiary", "2", { name: "Nordic AB", country: "SE" });
  netsuite.record.seed("customer", "123", { email: "a@x.com", comments: "", subsidiary: "1" }, {}, { subsidiary: "Parent Company" });
  netsuite.record.seed("customer", "124", { email: "", comments: "", subsidiary: "2" }, {}, { subsidiary: "Nordic AB" });
  netsuite.record.seed("customer", "125", { email: "c@x.com", comments: "", subsidiary: "2" }, {}, { subsidiary: "Nordic AB" });
  netsuite.record.seed("salesorder", "5", { memo: "first", total: 10, entity: "123" }, {}, { entity: "Acme" });
  netsuite.record.seed("salesorder", "6", { memo: "second", total: 20, entity: "124" }, {}, { entity: "Beta" });
  netsuite.record.seed("salesorder", "7", { memo: "third", total: 30, entity: "125" }, {}, { entity: "Gamma" });
  netsuite.record.seed("salesorder", "8", { memo: "orphan", total: 40, entity: "" }, {}, { entity: "" });
  netsuite.search.relate("salesorder", "entity", "entity", "customer");
  netsuite.search.relate("customer", "subsidiary", "subsidiary", "subsidiary");
  return netsuite;
}
const run = (js: string, netsuite = seeded()) => {
  netsuite.load(js).execute!(scheduledContext());
  return netsuite;
};

describe("joined predicates", () => {
  it("entity.email in a search condition is a joined field of Customer, filtered as join.field", () => {
    expect(type(scheduled(`    for o in search SalesOrder where entity.em§ail != "" { }`))).toBe("string");
    const result = compileRefs(scheduled(`    let orders = search SalesOrder\n        where entity.email != ""\n    for o in orders { }`));
    expect(result.diagnostics).toEqual([]);
    const declaration = result.unit!.kind === "Scheduled" ? result.unit!.entryPoint.body[0]! : undefined;
    expect(declaration).toMatchObject({
      initializer: {
        predicate: { kind: "Compare", field: { id: "email" }, join: { via: { id: "entity" }, target: { name: "Customer" } }, operation: "NotEqual" },
        filter: { kind: "Filter", field: { id: "email" }, join: { via: { id: "entity" }, target: { name: "Customer" } }, operator: "ISNOTEMPTY" },
      },
    });
    expect(result.output).toContain('["entity.email", search.Operator.ISNOTEMPTY, ""]');
    const js = output(scheduled(`    for o in search SalesOrder where entity.email != "" {\n        log.debug(o.memo)\n    }\n    for o in search SalesOrder where entity.email == "c@x.com" {\n        log.debug(o.memo)\n    }`));
    const netsuite = run(js);
    expect(netsuite.search.runs.map((r) => r.filters)).toEqual([[["entity.email", "isnotempty", ""]], [["entity.email", "is", "c@x.com"]]]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["first", "third", "third"]);
    expect(netsuite.record.loadCalls).toEqual([]);
    expect(netsuite.search.lookupCalls).toEqual([]);
  });

  it("a joined reference field compares by identity through the same one hop, and ! flips it", () => {
    const js = output(scheduled(`    for o in search SalesOrder where entity.subsidiary == Subsidiary(2) {\n        log.debug(o.memo)\n    }\n    for o in search SalesOrder where !(entity.subsidiary == Subsidiary(2)) && entity.email != "" {\n        log.debug(o.memo)\n    }`));
    expect(js).toContain('["entity.subsidiary", search.Operator.ANYOF, ["2"]]');
    expect(js).toContain('["entity.subsidiary", search.Operator.NONEOF, ["2"]]');
    expect(run(js).log.calls.map((c) => c.details)).toEqual(["second", "third", "first"]);
  });

  it("joined scalar fields take the existing operators by type", () => {
    const netsuite = seeded();
    netsuite.record.seed("customrecord_mynt_log", "1", { name: "n", custrecord_mynt_done: true });
    expect(messages(scheduled(`    for c in search Customer where subsidiary.name == "Parent Company" { }`))).toEqual([]);
    expect(first(scheduled(`    for c in search Customer where subsidiary.name > 1 { }`))).toContain("MYNT1022 Cannot compare string with number");
    expect(first(scheduled(`    for o in search SalesOrder where entity.email == Customer(1) { }`))).toBe(
      "MYNT1022 Cannot compare 'email', a string field, with a Customer reference: a reference compares only with a reference to the same record type",
    );
  });
});

describe("joined row fields", () => {
  it("order.entity.email is planned as one joined column, nested under the reference on the row, without loading anything", () => {
    expect(type(scheduled(`    for o in search SalesOrder {\n        log.debug(o.entity.em§ail)\n    }`))).toBe("string");
    const js = output(scheduled(`    let orders = search SalesOrder\n    for order in orders {\n        log.debug(order.entity.email)\n        log.debug(order.entity.email)\n        log.debug(order.memo)\n    }`));
    expect(js).toContain('mynt$search(search.Type.SALES_ORDER, [{ name: "email", join: "entity", field: "entity" }, "memo"], [])');
    expect(js).toContain("details: order.entity.email");
    expect(js.split("function execute")[1]).not.toMatch(/getValue\(|createColumn/);
    const netsuite = run(js);
    expect(netsuite.search.runs).toEqual([{ type: "salesorder", columns: ["internalid", "entity.email", "memo"], filters: undefined }]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["a@x.com", "a@x.com", "first", "", "", "second", "c@x.com", "c@x.com", "third", undefined, undefined, "orphan"]);
    expect(netsuite.record.loadCalls).toEqual([]);
    expect(netsuite.search.lookupCalls).toEqual([]);
  });

  it("id, text, and joined fields coexist on the reference; the reference column is planned only when id or text is read", () => {
    const js = output(
      scheduled(
        `    for order in search SalesOrder where entity.email != "" {\n        log.debug(order.entity.id)\n        log.debug(order.entity.text)\n        log.debug(order.entity.email)\n        log.debug(order.entity.subsidiary.text)\n        log.debug(order.entity.subsidiary.id)\n    }`,
      ),
    );
    expect(js).toContain('["entity", { name: "email", join: "entity", field: "entity" }, { name: "subsidiary", join: "entity", field: "entity" }], ["entity", "entity.subsidiary"]');
    const netsuite = run(js);
    expect(netsuite.search.runs[0]!.columns).toEqual(["internalid", "entity", "entity.email", "entity.subsidiary"]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["123", "Acme", "a@x.com", "Parent Company", "1", "125", "Gamma", "c@x.com", "Nordic AB", "2"]);
    expect(netsuite.search.lookupCalls).toEqual([]);
  });

  it("the same joined field in the predicate and on the row is one filter and one column", () => {
    const js = output(scheduled(`    for o in search SalesOrder where entity.email == "a@x.com" {\n        log.debug(o.entity.email)\n    }`));
    expect(js).toContain('[{ name: "email", join: "entity", field: "entity" }], [], [["entity.email", search.Operator.IS, "a@x.com"]]');
    const netsuite = run(js);
    expect(netsuite.search.runs[0]!.columns).toEqual(["internalid", "entity.email"]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["a@x.com"]);
  });

  it("a joined reference field on a row is a display reference whose own fields are a second hop", () => {
    expect(type(scheduled(`    for o in search SalesOrder {\n        log.debug(o.entity.subsid§iary.text)\n    }`))).toBe("Ref<Subsidiary>");
    expect(labels(scheduled(`    for o in search SalesOrder {\n        log.debug(o.entity.subsidiary.§)\n    }`))).toEqual(["id", "text"]);
    expect(first(scheduled(`    for o in search SalesOrder {\n        log.debug(o.entity.subsidiary.name)\n    }`))).toBe(
      "MYNT1053 'o.entity.subsidiary.name' is a second join hop (entity to Customer, then subsidiary to Subsidiary); joins are one hop deep for now. Look the field up explicitly instead: 'o.entity.subsidiary[name]'",
    );
    expect(first(scheduled(`    for o in search SalesOrder where entity.subsidiary.name == "x" { }`))).toContain("MYNT1053 'entity.subsidiary.name' is a second join hop");
    // The explicit lookup the message names is the one network call, and it is the author's.
    const js = output(scheduled(`    for o in search SalesOrder where entity.email == "a@x.com" {\n        log.debug(o.entity.subsidiary[name])\n    }`));
    const netsuite = run(js);
    expect(netsuite.search.lookupCalls).toEqual([{ type: "subsidiary", id: "1", columns: ["name"] }]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["Parent Company"]);
  });
});

describe("joins stay inside search", () => {
  it("a loaded record's reference does not follow the relationship: the lookup form is named instead", () => {
    expect(first(scheduled(`    let order = load SalesOrder(5)\n    log.debug(order.entity.email)`))).toBe(
      "MYNT1011 'order.entity' is a Ref<Customer>: a reference to the record, not the record itself. Look the field up without loading, 'order.entity[email]', or load the record, 'let x = load Customer(order.entity.id)', then 'x.email'",
    );
    expect(first(scheduled(`    let c = Customer(123)\n    log.debug(c.email)`))).toContain("Look the field up without loading, 'c[email]'");
    expect(labels(scheduled(`    let c = Customer(123)\n    log.debug(c.§)`))).toEqual(["id"]);
    expect(labels(scheduled(`    let order = load SalesOrder(5)\n    log.debug(order.entity.§)`))).toEqual(["id"]);
  });

  it("query refuses the relationship with a backend diagnostic, in the condition and on rows", () => {
    expect(first(scheduled(`    for o in query SalesOrder where entity.email == "x" { }`))).toBe(
      "MYNT1053 'entity.email' follows a relationship, which 'search' plans as a join; N/query's join model is not supported yet, so use 'search' or look the field up with 'entity[email]'",
    );
    expect(first(scheduled(`    for o in query SalesOrder {\n        log.debug(o.entity.email)\n    }`))).toContain("MYNT1053 'o.entity.email' follows a relationship");
    expect(labels(scheduled(`    for o in query SalesOrder {\n        log.debug(o.entity.§)\n    }`))).toEqual(["id"]);
  });

  it("unknown targets and multiselects are not joins, and an unknown joined field is reported against the target", () => {
    expect(first(scheduled(`    for c in search Customer where parent.email == "x" { }`))).toBe(
      "MYNT1011 Cannot access '.email' on 'parent': the schema does not name the record type it refers to, so Mynt cannot determine which fields it has. A reference with a known target has '.id' (and '.text' from a lookup or search row)",
    );
    expect(first(scheduled(`    for c in search Customer where category.name == "x" { }`))).toBe(
      "MYNT1053 'category' is a multiselect: it holds several references, so 'category.name' is not one relationship to follow. Iterating or filtering a multiselect is not supported yet",
    );
    expect(first(scheduled(`    for c in search Customer {\n        log.debug(c.category.name)\n    }`))).toContain("MYNT1053 'category' is a multiselect");
    expect(first(scheduled(`    for o in search SalesOrder where entity.emial == "x" { }`))).toBe("MYNT1004 Customer (through entity) has no field 'emial'. Did you mean 'email'?");
  });
});

describe("joins on saved searches and custom records", () => {
  it("a saved search gets the joined column appended, or reuses an exact joined column, and never a plain or summarized one", () => {
    const netsuite = seeded();
    netsuite.search.saveSearch("customsearch_open_orders", {
      searchType: "transaction",
      columns: [{ name: "memo" }, { name: "email", join: "entity" }, { name: "email" }, { name: "email", join: "entity", summary: "COUNT" }],
      filters: [["memo", "isnot", "orphan"]],
    });
    const js = output(scheduled(`    for o in search saved "customsearch_open_orders" where entity.email != "" {\n        log.debug(o.entity.email)\n        log.debug(o.entity.subsidiary.text)\n    }`));
    expect(js).toContain(
      'mynt$savedSearch([search.Type.SALES_ORDER, "transaction"], "customsearch_open_orders", [{ name: "email", join: "entity", field: "entity" }, { name: "subsidiary", join: "entity", field: "entity" }], ["entity.subsidiary"], [["entity.email", search.Operator.ISNOTEMPTY, ""]])',
    );
    run(js, netsuite);
    // The exact joined `email` is reused; the joined `subsidiary` is appended; the plain and summary `email` columns stay where they were.
    expect(netsuite.search.runs[0]!.columns).toEqual(["memo", "entity.email", "email", "COUNT(entity.email)", "entity.subsidiary"]);
    expect(netsuite.search.runs[0]!.filters).toEqual([[["memo", "isnot", "orphan"]], "and", [["entity.email", "isnotempty", ""]]]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["a@x.com", "Parent Company", "c@x.com", "Nordic AB"]);
    expect(netsuite.search.savedDefinition("customsearch_open_orders")!.columns).toHaveLength(4);
  });

  it("a custom record relationship joins by the custom field id, and a snapshot's searchJoin overrides the default join id", () => {
    const netsuite = seeded();
    netsuite.record.seed("customrecord_mynt_log", "10", { name: "a", custrecord_mynt_done: true, custrecord_mynt_owner: "123" }, {}, { custrecord_mynt_owner: "Acme" });
    netsuite.record.seed("customrecord_mynt_log", "11", { name: "b", custrecord_mynt_done: false, custrecord_mynt_owner: "124" }, {}, { custrecord_mynt_owner: "Beta" });
    netsuite.search.relate("customrecord_mynt_log", "custrecord_mynt_owner", "custrecord_mynt_owner", "customer");
    netsuite.search.relate("salesorder", "customer", "entity", "customer");
    const withJoins = compile(
      scheduled(`    for entry in search MyntLog where custrecord_mynt_owner.email != "" {\n        log.debug(entry.custrecord_mynt_owner.email)\n    }\n    for o in search SalesOrder where entity.email != "" {\n        log.debug(o.entity.email)\n    }`),
      {
        file: "t.mn",
        schema: {
          getRecordByName: (name) => {
            const record = referenceSchema.getRecordByName(name);
            if (!record) return undefined;
            if (name === "MyntLog") {
              const fields = new Map(record.fields);
              fields.set("custrecord_mynt_owner", { id: "custrecord_mynt_owner", type: "Ref", label: "Owner", writable: true, custom: true, refTarget: "Customer", selection: "single" });
              return { ...record, fields };
            }
            if (name === "SalesOrder") {
              const fields = new Map(record.fields);
              fields.set("entity", { ...record.fields.get("entity")!, searchJoin: "customer" });
              return { ...record, fields };
            }
            return record;
          },
          listRecords: () => referenceSchema.listRecords(),
          getSavedSearch: (id) => referenceSchema.getSavedSearch(id),
          listSavedSearches: () => referenceSchema.listSavedSearches(),
        },
      },
    );
    expect(withJoins.diagnostics).toEqual([]);
    expect(withJoins.output).toContain('mynt$search("customrecord_mynt_log", [{ name: "email", join: "custrecord_mynt_owner", field: "custrecord_mynt_owner" }], [], [["custrecord_mynt_owner.email", search.Operator.ISNOTEMPTY, ""]])');
    expect(withJoins.output).toContain('mynt$search(search.Type.SALES_ORDER, [{ name: "email", join: "customer", field: "entity" }], [], [["customer.email", search.Operator.ISNOTEMPTY, ""]])');
    run(withJoins.output!, netsuite);
    expect(netsuite.search.runs.map((r) => r.columns)).toEqual([["internalid", "custrecord_mynt_owner.email"], ["internalid", "customer.email"]]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["a@x.com", "a@x.com", "c@x.com"]);
  });
});

describe("joins in the editor", () => {
  it("completion offers the target's fields after a search row's reference and after a condition's reference, marked as joined", () => {
    expect(labels(scheduled(`    for o in search SalesOrder {\n        log.debug(o.entity.§)\n    }`))).toEqual(["id", "text", "comments", "email", "entityid", "subsidiary", "parent", "category"]);
    expect(labels(scheduled(`    for o in search SalesOrder where entity.§ { }`))).toEqual(["id", "text", "comments", "email", "entityid", "subsidiary", "parent", "category"]);
    const items = completionsAt(at(scheduled(`    for o in search SalesOrder {\n        log.debug(o.entity.§)\n    }`)).doc, at(scheduled(`    for o in search SalesOrder {\n        log.debug(o.entity.§)\n    }`)).offset);
    expect(items.find((i) => i.label === "email")).toMatchObject({ detail: "string · writable · joined", documentation: "Email · Customer via entity\nNetSuite field `email`" });
    expect(labels(scheduled(`    let s = Customer(123)[subsidiary]\n    log.debug(s.§)`))).toEqual(["id", "text"]);
  });

  it("hover shows the target field with the relationship it is reached through", () => {
    expect(hover(scheduled(`    for o in search SalesOrder {\n        log.debug(o.entity.ema§il)\n    }`))).toBe(
      "```mynt\nCustomer.email: string\n```\n\nEmail · string · writable · NetSuite field `email`\n\nreached through SalesOrder.entity, as a joined column of the same search; no record is loaded",
    );
    expect(hover(scheduled(`    for o in search SalesOrder where entity.ema§il != "" { }`))).toContain("reached through SalesOrder.entity");
    expect(hover(scheduled(`    for o in search SalesOrder {\n        log.debug(o.ent§ity.email)\n    }`))).toContain("SalesOrder.entity: Ref");
  });

  it("semantic tokens keep both parts properties, and references find the joined field as Customer.email", () => {
    const text = scheduled(`    for o in search SalesOrder where entity.email != "" {\n        log.debug(o.entity.email)\n    }`);
    expect(tokens(text).filter((t) => /^(entity|email):/.test(t))).toEqual(["entity:property", "email:property", "entity:property", "email:property"]);
    const { doc, offset } = at(scheduled(`    for o in search SalesOrder where entity.em§ail != "" {\n        log.debug(o.entity.email)\n        let c = load Customer(1)\n        log.debug(c.email)\n    }`));
    const symbol = symbolAt(doc, offset)!;
    expect(symbol).toMatchObject({ kind: "field", record: { name: "Customer" }, field: { id: "email" } });
    expect(referencesOf(doc, symbol)).toHaveLength(3);
  });
});
