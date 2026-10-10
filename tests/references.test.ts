/**
 * References and display text: `.id` always means identity, `.text` means
 * display text the value actually carries, and NetSuite's value/getValue/
 * getText shapes never reach Mynt source.
 *
 *   Customer(123)                 identity: id only
 *   order.entity (loaded record)  identity: id only, no call
 *   row.subsidiary (query row)    identity: id only
 *   Customer(123)[subsidiary]     display: id and text, one lookupFields call
 *   row.entity (search row)       display: id and text from the row
 *   Customer(123)[category]       Sequence<Ref<CustomerCategory>>, display references
 *
 * The reference metadata is the fixture's (tests/helpers.ts), stated as a
 * pulled snapshot would state it.
 */
import { parse as parseJs } from "acorn";
import { describe, expect, it } from "vitest";
import { compile } from "../src/compiler.js";
import { completionsAt } from "../src/lsp/completion.js";
import { hoverAt } from "../src/lsp/hover.js";
import { normalize } from "../src/netsuite/schema/normalize.js";
import { analyze, typeAt } from "../src/semantic/query.js";
import { semanticTokens } from "../src/semantic/tokens.js";
import { typeName } from "../src/semantic/types.js";
import { DocumentSchemaProvider } from "../src/schema/provider.js";
import { rawMetadata } from "./fixtures/netsuite-metadata.js";
import { referenceFixtureSchema, referenceSchema } from "./helpers.js";
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

/** Customers with select fields seeded in the raw shapes the backend lowering expects: ids as values, display text beside them. */
function seeded() {
  const netsuite = new FakeNetSuite();
  netsuite.record.seed("subsidiary", "1", { name: "Parent Company", country: "SE" });
  netsuite.record.seed("subsidiary", "2", { name: "Nordic AB", country: "SE" });
  netsuite.record.seed("customercategory", "7", { name: "Retail" });
  netsuite.record.seed("customercategory", "8", { name: "Wholesale" });
  netsuite.record.seed("customer", "123", { email: "a@x.com", comments: "Known", subsidiary: "1", parent: "", category: ["7", "8"] }, {}, { subsidiary: "Parent Company", parent: "", category: ["Retail", "Wholesale"] });
  netsuite.record.seed("customer", "124", { email: "b@x.com", comments: "", subsidiary: "2", category: [] }, {}, { subsidiary: "Nordic AB", category: [] });
  netsuite.record.seed("salesorder", "5", { memo: "first", total: 10, entity: "123" }, {}, { entity: "Acme" });
  netsuite.record.seed("salesorder", "6", { memo: "second", total: 20, entity: "124" }, {}, { entity: "Beta" });
  return netsuite;
}

describe("schema: reference metadata", () => {
  it("the fixture states targets and selection explicitly; the compiler reads them through the provider", () => {
    const customer = referenceSchema.getRecordByName("Customer")!;
    expect(customer.fields.get("subsidiary")).toMatchObject({ type: "Ref", refTarget: "Subsidiary", selection: "single" });
    expect(customer.fields.get("category")).toMatchObject({ type: "Ref", refTarget: "CustomerCategory", selection: "multiple" });
    expect(customer.fields.get("parent")).toMatchObject({ type: "Ref", selection: "single" });
    expect(customer.fields.get("parent")!.refTarget).toBeUndefined();
    expect(referenceFixtureSchema.records.customer!.fields.email!.selection).toBeUndefined();
  });

  it("live normalization marks every reference `single` and names a target only from a $ref; it never produces `multiple`", () => {
    const { document } = normalize(rawMetadata, { account: "123_SB1", pulledAt: "2024-01-01T00:00:00Z" });
    const customer = document.records.customer!;
    expect(customer.fields.subsidiary).toMatchObject({ type: "Ref", refTarget: "Subsidiary", selection: "single" });
    expect(customer.fields.salesrep).toMatchObject({ type: "Ref", selection: "single" });
    expect(customer.fields.salesrep!.refTarget).toBeUndefined();
    const selections = Object.values(document.records).flatMap((r) => Object.values(r.fields).map((f) => f.selection));
    expect(selections).not.toContain("multiple");
    expect(Object.values(customer.fields).filter((f) => f.type !== "Ref").every((f) => f.selection === undefined)).toBe(true);
  });
});

describe("identity references: id, never text", () => {
  it("Customer(123) exposes id and refuses text without fetching anything", () => {
    expect(messages(scheduled(`    let customer = Customer(123)\n    log.debug(customer.id)`))).toEqual([]);
    expect(first(scheduled(`    let customer = Customer(123)\n    log.debug(customer.text)`))).toBe(
      "MYNT1051 A Customer reference has an id but no display text: 'customer' identifies the record without fetching anything. Display text comes with a select field read through a lookup or a search row; to show a name, look it up explicitly, like 'customer[comments]'",
    );
    expect(first(scheduled(`    log.debug(Customer(123).text)`))).toContain("MYNT1051 A Customer reference has an id but no display text: 'Customer(...)'");
    const js = output(scheduled(`    let customer = Customer(123)\n    log.debug(customer.id)`));
    expect(js).not.toContain("lookupFields");
    expect(js).not.toContain("N/search");
  });

  it("a select field read from a loaded record is an identity reference: its id, no extra call, no text", () => {
    expect(type(scheduled(`    let order = load SalesOrder(5)\n    log.debug(order.ent§ity.id)`))).toBe("Ref<Customer>");
    const js = output(scheduled(`    let order = load SalesOrder(5)\n    log.debug(order.entity.id)`));
    expect(js).toContain('define(["N/log", "N/record"], (log, record) => {');
    expect(js).toContain(`details: order.getValue({\n                fieldId: "entity"\n            })`);
    const netsuite = seeded();
    netsuite.load(js).execute!(scheduledContext());
    expect(netsuite.log.calls[0]!.details).toBe("123");
    expect(netsuite.search.lookupCalls).toEqual([]);
    expect(first(scheduled(`    let order = load SalesOrder(5)\n    log.debug(order.entity.text)`))).toContain("MYNT1051 A Customer reference has an id but no display text: 'order.entity'");
  });

  it("a select field on a query row is an identity reference too, since N/query gives the id alone", () => {
    expect(type(scheduled(`    for row in query Customer {\n        log.debug(row.subsid§iary.id)\n    }`))).toBe("Ref<Subsidiary>");
    const js = output(scheduled(`    for row in query Customer {\n        log.debug(row.subsidiary.id)\n    }`));
    expect(js).toContain('mynt$query(query.Type.CUSTOMER, ["id", "subsidiary"])');
    expect(js).toContain("details: row.subsidiary\n");
    expect(first(scheduled(`    for row in query Customer {\n        log.debug(row.subsidiary.text)\n    }`))).toContain("MYNT1051");
  });

  it("a reference whose target the schema does not name stays inert", () => {
    expect(type(scheduled(`    let c = load Customer(123)\n    log.debug(c.pa§rent)`))).toBe("Ref");
    expect(first(scheduled(`    let c = load Customer(123)\n    log.debug(c.parent.id)`))).toBe(
      "MYNT1011 Cannot access '.id' on 'parent': the schema does not name the record type it refers to, so Mynt cannot determine which fields it has. A reference with a known target has '.id' (and '.text' from a lookup or search row)",
    );
    expect(first(scheduled(`    let p = Customer(123)[parent]\n    log.debug(p.id)`))).toContain("MYNT1011 Cannot access '.id' on this reference");
    expect(first(scheduled(`    let c = load Customer(123)\n    log.debug(c.parent)`))).toContain("MYNT1014 log.debug argument 1 must be string, but received Ref");
  });
});

describe("display references from lookups", () => {
  it("a single select lookup returns the reference value directly, normalized from NetSuite's value/text shape by one helper", () => {
    expect(type(scheduled(`    let subsidiary = Customer(123)[subsidiary]\n    log.debug(subsid§iary.id)`))).toBe("Ref<Subsidiary>");
    expect(type(scheduled(`    let subsidiary = Customer(123)[subsidiary]\n    log.debug(subsidiary.te§xt)`))).toBe("string");
    const js = output(scheduled(`    let subsidiary = Customer(123)[subsidiary]\n    log.debug(subsidiary.id)\n    log.debug(subsidiary.text)`));
    expect(js).toContain(`const subsidiary = mynt$lookup(\n            search.Type.CUSTOMER,\n            123,\n            ["subsidiary"],\n            {\n                subsidiary: "one"\n            }\n        ).subsidiary;`);
    expect(js).toContain("details: subsidiary.id");
    expect(js).toContain("details: subsidiary.text");
    // `value` appears only inside the normalizer, never where Mynt code reads the reference.
    expect(js.split("function execute")[1]).not.toContain("value");
    const netsuite = seeded();
    netsuite.load(js).execute!(scheduledContext());
    expect(netsuite.search.lookupCalls).toEqual([{ type: "customer", id: "123", columns: ["subsidiary"] }]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["1", "Parent Company"]);
  });

  it("the raw lookup result really is NetSuite's array shape, and the helper is what turns it into id and text", () => {
    const netsuite = seeded();
    expect(netsuite.search.lookupFields({ type: "customer", id: "123", columns: ["email", "subsidiary", "category"] })).toEqual({
      email: "a@x.com",
      subsidiary: [{ value: "1", text: "Parent Company" }],
      category: [
        { value: "7", text: "Retail" },
        { value: "8", text: "Wholesale" },
      ],
    });
    const js = output(scheduled(`    let s = Customer(124)[subsidiary]\n    log.debug(s.text)\n    let p = Customer(123)[email]\n    log.debug(p)`));
    netsuite.load(js).execute!(scheduledContext());
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["Nordic AB", "a@x.com"]);
    // A scalar-only lookup is still the bare call, as before.
    expect(js).toContain(`const p = search.lookupFields({\n            type: search.Type.CUSTOMER,\n            id: 123,\n            columns: ["email"]\n        }).email;`);
  });

  it("an empty select normalizes to an empty id and text rather than failing", () => {
    const netsuite = seeded();
    netsuite.record.seed("customer", "125", { email: "", subsidiary: "" }, {}, { subsidiary: "" });
    const js = output(scheduled(`    let s = Customer(125)[subsidiary]\n    log.debug(s.id)\n    log.debug(s.text)\n    if s.id == "" {\n        log.debug("none")\n    }`));
    netsuite.load(js).execute!(scheduledContext());
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["", "", "none"]);
  });

  it("a multi-field projection keeps each field's own type and makes one call", () => {
    expect(type(scheduled(`    let info = Customer(123)[email, subsidiary]\n    log.debug(in§fo.email)`))).toBe("Customer[email, subsidiary]");
    expect(type(scheduled(`    let info = Customer(123)[email, subsidiary]\n    log.debug(info.subsid§iary.text)`))).toBe("Ref<Subsidiary>");
    const js = output(scheduled(`    let info = Customer(123)[email, subsidiary]\n    log.debug(info.email)\n    log.debug(info.subsidiary.id)\n    log.debug(info.subsidiary.text)`));
    expect(js.match(/lookupFields/g)).toHaveLength(1);
    expect(js).toContain(`const info = mynt$lookup(\n            search.Type.CUSTOMER,\n            123,\n            ["email", "subsidiary"],\n            {\n                subsidiary: "one"\n            }\n        );`);
    const netsuite = seeded();
    netsuite.load(js).execute!(scheduledContext());
    expect(netsuite.search.lookupCalls).toHaveLength(1);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["a@x.com", "1", "Parent Company"]);
  });

  it("a display reference is still a reference: no fields, no writes, and it projects through a second lookup", () => {
    expect(first(scheduled(`    let s = Customer(123)[subsidiary]\n    log.debug(s.name)`))).toContain("MYNT1011 's' is a Ref<Subsidiary>: a reference to the record, not the record itself. Look the field up without loading, 's[name]'");
    expect(first(scheduled(`    let s = Customer(123)[subsidiary]\n    s.name = "x"`))).toContain("MYNT1046");
    expect(first(scheduled(`    let s = Customer(123)[subsidiary]\n    log.debug(s.nope)`))).toContain("a reference has '.id' and '.text'");
    const js = output(scheduled(`    let s = Customer(123)[subsidiary]\n    log.debug(s[country])`));
    const netsuite = seeded();
    netsuite.load(js).execute!(scheduledContext());
    expect(netsuite.search.lookupCalls).toEqual([
      { type: "customer", id: "123", columns: ["subsidiary"] },
      { type: "subsidiary", id: "1", columns: ["country"] },
    ]);
    expect(netsuite.log.calls[0]!.details).toBe("SE");
  });
});

describe("relationship projections: order.entity[...]", () => {
  it("projects fields of the referenced record through the schema's target with one lookupFields call", () => {
    const js = output(scheduled(`    let order = load SalesOrder(5)\n    let contact = order.entity[email, subsidiary]\n    log.debug(contact.email)\n    log.debug(contact.subsidiary.text)\n    log.debug(order.entity[comments])`));
    expect(js).toContain('define(["N/log", "N/record", "N/search"], (log, record, search) => {');
    expect(js).toContain(`const contact = mynt$lookup(\n            search.Type.CUSTOMER,\n            order.getValue({\n                fieldId: "entity"\n            }),\n            ["email", "subsidiary"],`);
    const netsuite = seeded();
    netsuite.load(js).execute!(scheduledContext());
    expect(netsuite.record.loadCalls).toEqual([{ type: "salesorder", id: "5" }]);
    expect(netsuite.search.lookupCalls).toEqual([
      { type: "customer", id: "123", columns: ["email", "subsidiary"] },
      { type: "customer", id: "123", columns: ["comments"] },
    ]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["a@x.com", "Parent Company", "Known"]);
  });

  it("works from a query row and a search row too, and refuses a target the schema does not name", () => {
    expect(messages(scheduled(`    for row in query SalesOrder {\n        log.debug(row.entity[email])\n    }`))).toEqual([]);
    expect(messages(scheduled(`    for row in search SalesOrder {\n        log.debug(row.entity[email])\n    }`))).toEqual([]);
    expect(first(scheduled(`    let c = load Customer(123)\n    log.debug(c.parent[email])`))).toContain("MYNT1048 Cannot project fields from a Ref value");
  });
});

describe("search rows: display references from getValue and getText", () => {
  it("a select column on a search row carries id and text, normalized in the helper", () => {
    expect(type(scheduled(`    for row in search SalesOrder {\n        log.debug(row.ent§ity.text)\n    }`))).toBe("Ref<Customer>");
    const js = output(scheduled(`    for row in search SalesOrder {\n        log.debug(row.entity.id)\n        log.debug(row.entity.text)\n        log.debug(row.memo)\n    }`));
    expect(js).toContain('mynt$search(search.Type.SALES_ORDER, ["entity", "memo"], ["entity"])');
    expect(js).toContain("details: row.entity.id");
    expect(js).toContain("details: row.entity.text");
    expect(js.split("function execute")[1]).not.toMatch(/getText|getValue/);
    const netsuite = seeded();
    netsuite.load(js).execute!(scheduledContext());
    expect(netsuite.search.runs).toEqual([{ type: "salesorder", columns: ["internalid", "entity", "memo"], filters: undefined }]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["123", "Acme", "first", "124", "Beta", "second"]);
  });

  it("a projection of a search row keeps the reference, and a multiselect column stays inert on rows", () => {
    const js = output(scheduled(`    for row in search SalesOrder {\n        let info = row[entity, memo]\n        log.debug(info.entity.text)\n    }`));
    expect(js).toContain('mynt$search(search.Type.SALES_ORDER, ["entity", "memo"], ["entity"])');
    expect(first(scheduled(`    for row in search Customer {\n        log.debug(row.category.id)\n    }`))).toContain("MYNT1053 'category' is a multiselect: it holds several references, so 'category.id' is not one relationship to follow");
  });
});

describe("multiselect: a sequence of display references from a lookup", () => {
  it("iterates the selected references with id and text, from one call", () => {
    expect(type(scheduled(`    let categories = Customer(123)[category]\n    for c in categ§ories { }`))).toBe("Sequence<Ref<CustomerCategory>>");
    expect(type(scheduled(`    for c in Customer(123)[category] {\n        log.debug(§c.text)\n    }`))).toBe("Ref<CustomerCategory>");
    const js = output(scheduled(`    let info = Customer(123)[email, category]\n    for category in info.category {\n        log.debug(category.id)\n        log.debug(category.text)\n    }\n    for none in Customer(124)[category] {\n        log.debug(none.id)\n    }`));
    expect(js).toContain(`{\n                category: "many"\n            }`);
    const netsuite = seeded();
    netsuite.load(js).execute!(scheduledContext());
    expect(netsuite.search.lookupCalls).toHaveLength(2);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["7", "Retail", "8", "Wholesale"]);
  });

  it("is only modeled through a lookup: elsewhere the field stays inert, and the sequence is read-only", () => {
    expect(type(scheduled(`    let c = load Customer(123)\n    log.debug(c.cate§gory)`))).toBe("Ref");
    expect(first(scheduled(`    for c in Customer(123)[category] {\n        c.text = "x"\n    }`))).toContain("MYNT1046");
    expect(first(scheduled(`    let cs = Customer(123)[category]\n    log.debug(cs)`))).toContain("must be string, but received Sequence<Ref<CustomerCategory>>");
  });
});

describe("editor: the distinction is visible", () => {
  it("completion offers id alone on an identity reference and id plus text on a display reference", () => {
    expect(labels(scheduled(`    let customer = Customer(123)\n    log.debug(customer.§)`))).toEqual(["id"]);
    expect(labels(scheduled(`    let order = load SalesOrder(5)\n    log.debug(order.entity.§)`))).toEqual(["id"]);
    expect(labels(scheduled(`    let subsidiary = Customer(123)[subsidiary]\n    log.debug(subsidiary.§)`))).toEqual(["id", "text"]);
    expect(labels(scheduled(`    for row in search SalesOrder {\n        log.debug(row.entity.§)\n    }`))).toEqual(["id", "text", "comments", "email", "entityid", "subsidiary", "parent", "category"]);
    expect(labels(scheduled(`    for row in query SalesOrder {\n        log.debug(row.entity.§)\n    }`))).toEqual(["id"]);
    expect(labels(scheduled(`    let order = load SalesOrder(5)\n    let contact = order.entity[§`))).toEqual(["comments", "email", "entityid", "subsidiary", "parent", "category"]);
    expect(labels(scheduled(`    let info = Customer(123)[email, subsidiary]\n    log.debug(info.subsidiary.§)`))).toEqual(["id", "text"]);
    const items = completionsAt(at(scheduled(`    let c = load Customer(123)\n    log.debug(c.§)`)).doc, at(scheduled(`    let c = load Customer(123)\n    log.debug(c.§)`)).offset);
    expect(items.find((i) => i.label === "subsidiary")!.detail).toBe("reference to Subsidiary · writable");
    expect(items.find((i) => i.label === "category")!.detail).toBe("multiselect of CustomerCategory · writable");
    expect(items.find((i) => i.label === "parent")!.detail).toBe("reference to an unknown record type · writable");
  });

  it("hover says which kind of reference a value is without naming compiler types", () => {
    expect(hover(scheduled(`    let customer = Customer(123)\n    log.debug(§customer.id)`))).toContain("Customer reference · id: string · nothing is loaded");
    expect(hover(scheduled(`    let customer = Customer(123)\n    log.debug(§customer.id)`))).not.toContain("text: string");
    expect(hover(scheduled(`    let subsidiary = Customer(123)[subsidiary]\n    log.debug(§subsidiary.id)`))).toBe(
      "```mynt\nsubsidiary: Ref<Subsidiary>\n```\n\nlocal · Subsidiary reference · id: string · text: string · nothing is loaded; read fields with `[name, ...]` (one `N/search.lookupFields` call) or load it with `load Subsidiary(subsidiary.id)`",
    );
    expect(hover(scheduled(`    let subsidiary = Customer(123)[subsidiary]\n    log.debug(subsidiary.te§xt)`))).toBe(
      "```mynt\nSubsidiary.text: string\n```\n\ndisplay text of the referenced record, supplied by the backend with the id · never fetched on its own",
    );
    expect(hover(scheduled(`    let subsidiary = Customer(123)[subsidiary]\n    log.debug(subsidiary.i§d)`))).toContain("Subsidiary.id: string");
    expect(hover(scheduled(`    let c = load Customer(123)\n    log.debug(c.subsid§iary.id)`))).toBe("```mynt\nCustomer.subsidiary: Ref\n```\n\nSubsidiary · reference to Subsidiary · writable · NetSuite field `subsidiary`");
    expect(hover(scheduled(`    let info = Customer(123)[email, subsidiary]\n    log.debug(§info.email)`))).toContain("read-only projection of Customer: email: string, subsidiary: Ref<Subsidiary>");
    expect(hover(scheduled(`    let cs = Customer(123)[category]\n    for c in §cs { }`))).toContain("Sequence<Ref<CustomerCategory>> (multiselect field, read-only references with id and text)");
  });

  it("semantic tokens: id and text are read-only properties, the referenced types are structs", () => {
    const all = tokens(scheduled(`    let s = Customer(123)[subsidiary]\n    log.debug(s.id)\n    log.debug(s.text)\n    let o = load SalesOrder(5)\n    log.debug(o.entity.id)`));
    expect(all.filter((t) => /^(id|text):/.test(t))).toEqual(["id:property+readonly", "text:property+readonly", "id:property+readonly"]);
    expect(all.filter((t) => /^(subsidiary|entity):/.test(t))).toEqual(["subsidiary:property", "entity:property"]);
    expect(all.filter((t) => /^(Customer|SalesOrder):/.test(t))).toEqual(["Customer:struct", "SalesOrder:struct"]);
  });
});
