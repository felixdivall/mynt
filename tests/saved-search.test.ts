/**
 * Saved searches: `load Search("customsearch_x")` loads an existing
 * N/search saved search and exposes it as the same typed, read-only rows
 * as `search T`. The result type is inferred from the account snapshot's
 * saved-search metadata; an id the snapshot does not know, or a dynamic
 * id, is an error, since nothing in source states the type. The saved
 * search is used as defined (its filters and columns
 * stay), the fields the program reads are appended to the loaded search in
 * memory, a `where` is AND-ed onto its filters, and the stored definition
 * is never written. Uses the reference fixture (tests/helpers.ts), whose
 * snapshot knows four saved searches; the fake runtime's registry is kept
 * separate so the two can disagree on purpose.
 */
import { parse as parseJs } from "acorn";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile } from "../src/compiler.js";
import { completionsAt } from "../src/lsp/completion.js";
import { completionSite } from "../src/lsp/context.js";
import { hoverAt } from "../src/lsp/hover.js";
import { readSnapshot } from "../src/netsuite/schema/snapshot.js";
import { DocumentSchemaProvider } from "../src/schema/provider.js";
import { analyze, resolveNameAt, typeAt } from "../src/semantic/query.js";
import { semanticTokens } from "../src/semantic/tokens.js";
import { typeName } from "../src/semantic/types.js";
import { referenceFixtureSchema, referenceSchema, schema as plainSchema } from "./helpers.js";
import { FakeNetSuite, scheduledContext, type SavedSearchDefinition } from "./harness/fake-netsuite.js";

const EXAMPLE = readFileSync(new URL("../examples/saved-search.mn", import.meta.url), "utf8");
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
const site = (source: string) => {
  const { doc, offset, text } = at(source);
  const s = completionSite(text, offset, (name) => resolveNameAt(doc, name, offset));
  return `${s.context.kind}${"record" in s.context && s.context.record ? `:${s.context.record}` : ""}${s.prefix ? `|${s.prefix}` : ""}`;
};
const tokens = (text: string) =>
  semanticTokens(analyze(text, "t.mn", referenceSchema)).map((t) => `${text.slice(t.span.start.offset, t.span.end.offset)}:${t.kind}${t.modifiers.map((m) => `+${m}`).join("")}`);

const ACTIVE: SavedSearchDefinition = {
  searchType: "customer",
  title: "Active customers",
  columns: [{ name: "entityid" }, { name: "email" }],
  filters: [["email", "isnotempty", ""]],
};
/** A saved search with a nested filter expression and a joined column, which Mynt must leave alone. */
const OPEN_ORDERS: SavedSearchDefinition = {
  searchType: "transaction",
  title: "Open orders",
  columns: [{ name: "memo" }, { name: "email", join: "customer" }, { name: "total", summary: "SUM" }],
  filters: [[["total", "greaterthan", 5], "or", ["memo", "is", "first"]], "and", ["memo", "isnot", "orphan"]],
};

function seeded() {
  const netsuite = new FakeNetSuite();
  netsuite.record.seed("customer", "123", { email: "a@x.com", comments: "", entityid: "A", subsidiary: "1" }, {}, { subsidiary: "Parent Company" });
  netsuite.record.seed("customer", "124", { email: "", comments: "", entityid: "B", subsidiary: "2" }, {}, { subsidiary: "Nordic AB" });
  netsuite.record.seed("customer", "125", { email: "c@x.com", comments: "Done", entityid: "C", subsidiary: "1" }, {}, { subsidiary: "Parent Company" });
  netsuite.record.seed("salesorder", "5", { memo: "first", total: 1, entity: "123" }, {}, { entity: "Acme" });
  netsuite.record.seed("salesorder", "6", { memo: "second", total: 20, entity: "124" }, {}, { entity: "Beta" });
  netsuite.record.seed("salesorder", "7", { memo: "third", total: 30, entity: "123" }, {}, { entity: "Acme" });
  netsuite.record.seed("salesorder", "8", { memo: "orphan", total: 40, entity: "" }, {}, { entity: "" });
  netsuite.record.seed("systemnote", "1", { field: "email", newvalue: "a@x.com" });
  netsuite.search.saveSearch("customsearch_active_customers", ACTIVE);
  netsuite.search.saveSearch("customsearch_customers", { ...ACTIVE, filters: undefined });
  netsuite.search.saveSearch("customsearch_open_orders", OPEN_ORDERS);
  netsuite.search.saveSearch("customsearch_system_notes", { searchType: "systemnote", standalone: true, columns: [{ name: "field" }], filters: undefined });
  return netsuite;
}
const run = (js: string, netsuite = seeded()) => {
  netsuite.load(js).execute!(scheduledContext());
  return netsuite;
};

describe("saved search: syntax and inference", () => {
  it("load Search(<literal>) infers the record type from the snapshot; downstream it is an ordinary search", () => {
    const result = compileRefs(scheduled(`    let customers = load Search("customsearch_customers")\n    for c in customers {\n        log.debug(c.email)\n    }`));
    expect(result.diagnostics).toEqual([]);
    const declaration = result.unit!.kind === "Scheduled" ? result.unit!.entryPoint.body[0]! : undefined;
    expect(declaration).toMatchObject({
      initializer: {
        kind: "Query",
        operation: "search",
        source: { kind: "saved", recordFrom: "snapshot", loadType: undefined, id: { kind: "StringLiteral", value: "customsearch_customers" } },
        recordType: { record: { name: "Customer" } },
        type: { kind: "Sequence", source: "search", element: { record: { name: "Customer" }, origin: "search" } },
      },
    });
    expect(type(scheduled(`    let customers = load Search("customsearch_customers")\n    for c in custo§mers { }`))).toBe("Sequence<Customer>");
    expect(type(scheduled(`    let orders = load Search("customsearch_open_orders")\n    for o in orders {\n        log.debug(o.me§mo)\n    }`))).toBe("string");
    expect([...result.unit!.dependencies].sort()).toEqual(["N/log", "N/search"]);
  });

  it("an id the snapshot does not know, or a value, is an error: nothing in source states a saved search's result type", () => {
    expect(first(scheduled(`    let c = load Search("customsearch_unknown")`))).toBe(
      'MYNT1054 The current account snapshot does not list saved search "customsearch_unknown", so its result type is unknown. Pull a snapshot of the account that has it (\'mynt schema pull\'), or add it under \'savedSearches\' in the snapshot; known: customsearch_customers, customsearch_active_customers, customsearch_open_orders, customsearch_system_notes, customsearch_totals',
    );
    expect(first(scheduled(`    let c = load Search("customsearch_customer")`))).toContain('Did you mean "customsearch_customers"?');
    expect(first(scheduled(`    let id = "customsearch_customers"\n    let c = load Search(id)`))).toBe(
      "MYNT1054 The result type of a saved search named by a value cannot be known at compile time: 'load Search(id)' would have rows of no known record type. Name the search by its literal script id, which the account snapshot knows",
    );
    // Downstream the Search source carries the snapshot's record and search type.
    const result = compileRefs(scheduled(`    let c = load Search("customsearch_system_notes")\n    for x in c { }`));
    expect(result.unit!.kind === "Scheduled" ? result.unit!.entryPoint.body[0] : undefined).toMatchObject({ initializer: { source: { kind: "saved", recordFrom: "snapshot", loadType: "systemnote" }, recordType: { record: { name: "SystemNote" } } } });
  });

  it("the id is one string; Search is a platform type, not a record; the old spellings point at load Search", () => {
    expect(first(scheduled(`    let s = load Search(5)`))).toBe(
      'MYNT0001 A saved search is named by its script id, a string like "customsearch_active_customers", not a number; numeric internal ids are not accepted',
    );
    expect(first(scheduled(`    let n = 5\n    let s = load Search(n)`))).toBe('MYNT1052 A saved search is named by its script id, a string like "customsearch_active_customers", but received number');
    expect(first(scheduled(`    let s = load Search(Customer)`))).toBe("MYNT1052 'Customer' is a record type, not a saved search id. Write the script id as a string: 'load Search(\"customsearch_x\")'");
    expect(first(scheduled(`    let s = load Search()`))).toBe("MYNT0001 Expected the saved search's script id, like 'load Search(\"customsearch_active_customers\")'");
    expect(first(scheduled(`    let s = load Search("a", "b")`))).toBe("MYNT0001 'load Search(...)' takes one argument, the script id; found 2");
    expect(first(scheduled(`    let s = load Search`))).toBe("MYNT0001 Expected the saved search's script id, like 'load Search(\"customsearch_active_customers\")'");
    expect(first(scheduled(`    let s = create Search`))).toBe("MYNT1018 'Search' is a platform type that can only be loaded: 'load Search(\"customsearch_active_customers\")'. create works on record types");
    expect(first(scheduled(`    let s = search Search`))).toBe("MYNT1001 'Search' is a platform type, not a record type: it has no fields and is only loaded, 'load Search(\"customsearch_active_customers\")'");
    expect(first(scheduled(`    let s = search saved "customsearch_customers"`))).toBe("MYNT0001 Saved searches are loaded with 'load Search(\"customsearch_customers\")'; 'search saved' is no longer part of Mynt");
    expect(first(scheduled(`    let s = search saved Customer "customsearch_customers"`))).toBe("MYNT0001 Saved searches are loaded with 'load Search(\"customsearch_customers\")'; 'search saved' is no longer part of Mynt");
    expect(first(scheduled(`    let s = query saved "customsearch_customers"`))).toContain("'query saved' is no longer part of Mynt");
    expect(first(scheduled(`    let s = search Customer using "customsearch_customers"`))).toBe("MYNT0001 Saved searches are loaded with 'load Search(\"customsearch_x\")'; 'using' is no longer part of Mynt");
    // `saved` and `Search` are not reserved anywhere else.
    expect(messages(scheduled(`    let saved = "x"\n    log.debug(saved)`))).toEqual([]);
    expect(messages(`fn saved(value: string): string {\n    return value\n}\nscheduled {\n    log.debug(saved("x"))\n}\n`)).toEqual([]);
    const cut = compileRefs(scheduled(`    let s = load Search(\n    let t = load Search("customsearch_customers"\n    log.debug("next")`));
    expect(cut.diagnostics.map((d) => d.code)).toEqual(["MYNT0001"]);
    expect(cut.diagnostics[0]!.message).toContain("Expected ',' or ')' after argument");
  });

  it("rows are the ordinary read-only search rows, with where, joins, and references", () => {
    expect(first(scheduled(`    for c in load Search("customsearch_customers") {\n        c.comments = "x"\n    }`))).toContain("MYNT1030 Search result 'c' is read-only");
    expect(messages(scheduled(`    for o in load Search("customsearch_open_orders") where entity === Customer(123) && entity.email !== "" {\n        log.debug(o.entity.email)\n        log.debug(o.entity.text)\n        let r = load SalesOrder(o.id)\n        r.memo = "x"\n        save r\n    }`))).toEqual([]);
    expect(first(scheduled(`    for c in load Search("customsearch_customers") where nope === "x" { }`))).toContain("MYNT1004 Customer has no field 'nope'");
  });
});

describe("saved search: execution", () => {
  it("loads by id alone, keeps the search's filters, pages every result, and exposes row.id", () => {
    const js = output(scheduled(`    for c in load Search("customsearch_active_customers") {\n        log.debug(c.id)\n    }`));
    expect(js).toContain('mynt$savedSearch(search.Type.CUSTOMER, "customsearch_active_customers", [], [])');
    expect(js).not.toContain("search.load({ id: \"customsearch_active_customers\" })"); // the helper loads; source never names search.load
    expect(js).toContain("const s = search.load(loadType ? { id, type: loadType } : { id });");
    expect(js.split("function execute")[1]).not.toContain("getRange");
    const netsuite = run(js);
    expect(netsuite.search.loadOptions).toEqual([{ id: "customsearch_active_customers" }]);
    expect(netsuite.search.runs).toEqual([{ type: "customer", columns: ["entityid", "email"], filters: [["email", "isnotempty", ""]] }]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["123", "125"]);
  });

  it("a standalone search type from the snapshot is passed to search.load, without the author repeating it", () => {
    const inferred = output(scheduled(`    for n in load Search("customsearch_system_notes") {\n        log.debug(n.field)\n    }`));
    expect(inferred).toContain('mynt$savedSearch("systemnote", "customsearch_system_notes", ["field"], [], undefined, "systemnote")');
    const netsuite = run(inferred);
    expect(netsuite.search.loadOptions).toEqual([{ id: "customsearch_system_notes", type: "systemnote" }]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["email"]);
    const filtered = output(scheduled(`    for n in load Search("customsearch_system_notes") where field === "email" {\n        log.debug(n.newvalue)\n    }`));
    expect(filtered).toContain('["newvalue"], [], [["field", search.Operator.IS, "email"]], "systemnote")');
    expect(run(filtered).log.calls.map((c) => c.details)).toEqual(["a@x.com"]);
    // Without the type the fake, like NetSuite, refuses to load a standalone search; the snapshot is what spares the author that.
    expect(() => seeded().search.load({ id: "customsearch_system_notes" })).toThrow("standalone search type and needs type to load");
  });

  it("the runtime check stays when the account disagrees with the snapshot, and accepts the transaction family", () => {
    // The snapshot says customsearch_customers returns Customer; this account's search is over transactions.
    const netsuite = seeded();
    netsuite.search.saveSearch("customsearch_customers", OPEN_ORDERS);
    const wrong = output(scheduled(`    for c in load Search("customsearch_customers") {\n        log.debug(c.id)\n    }`));
    expect(() => run(wrong, netsuite)).toThrow("Mynt: saved search customsearch_customers searches transaction records, but the script declares customer");
    const family = output(scheduled(`    for o in load Search("customsearch_open_orders") {\n        log.debug(o.memo)\n    }`));
    expect(family).toContain('mynt$savedSearch([search.Type.SALES_ORDER, "transaction"], "customsearch_open_orders", ["memo"], [])');
    expect(run(family).log.calls.map((c) => c.details)).toEqual(["first", "second", "third"]);
    // A search the snapshot knows but the account no longer has fails at runtime, as NetSuite would.
    const missing = output(scheduled(`    for c in load Search("customsearch_totals") {\n        log.debug(c.id)\n    }`));
    expect(() => run(missing)).toThrow("Fake NetSuite has no saved search customsearch_totals");
  });

  it("pages through a large saved search as the ad-hoc helper does", () => {
    const js = output(scheduled(`    for c in load Search("customsearch_active_customers") {\n        log.debug(c.entityid)\n    }`));
    const netsuite = seeded();
    for (let i = 1; i <= 2500; i++) netsuite.record.seed("customer", String(1000 + i), { email: `${i}@x.com`, entityid: `E${i}` });
    netsuite.load(js).execute!(scheduledContext());
    expect(netsuite.log.calls).toHaveLength(2502);
  });
});

describe("saved search: columns and where", () => {
  it("the fields the program reads are planned and appended once, reusing a matching column; a joined or summarized column of the same name is not mistaken for the field", () => {
    const js = output(scheduled(`    let customers = load Search("customsearch_active_customers")\n    for c in customers {\n        log.debug(c.email)\n        log.debug(c.comments)\n    }\n    for c in customers {\n        log.debug(c.comments)\n    }`));
    expect(js).toContain('mynt$savedSearch(search.Type.CUSTOMER, "customsearch_active_customers", ["comments", "email"], [])');
    const netsuite = run(js);
    expect(netsuite.search.runs[0]!.columns).toEqual(["entityid", "email", "comments"]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["a@x.com", "", "c@x.com", "Done", "", "Done"]);
    const orders = run(output(scheduled(`    for o in load Search("customsearch_open_orders") {\n        if o.total > 25 {\n            log.debug(o.memo)\n        }\n    }`)));
    expect(orders.search.runs[0]!.columns).toEqual(["memo", "customer.email", "SUM(total)", "total"]);
    expect(orders.log.calls.map((c) => c.details)).toEqual(["third"]);
  });

  it("select fields normalize like ad-hoc rows, and the stored definition is never written", () => {
    const js = output(scheduled(`    for o in load Search("customsearch_open_orders") where entity === Customer(123) {\n        log.debug(o.entity.text)\n        if o.total > 1 {\n            log.debug(o.memo)\n        }\n    }`));
    const netsuite = run(js);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["Acme", "Acme", "third"]);
    expect(netsuite.search.savedDefinition("customsearch_open_orders")).toEqual(OPEN_ORDERS);
    const reloaded = netsuite.search.load({ id: "customsearch_open_orders" });
    expect(reloaded.columns.map((c) => c.name)).toEqual(["memo", "email", "total"]);
    expect(reloaded.filterExpression).toEqual(OPEN_ORDERS.filters);
  });

  it("ANDs the Mynt filter onto the saved search's whole filter expression, preserving its nesting", () => {
    const js = output(scheduled(`    for o in load Search("customsearch_open_orders") where total < 35 {\n        log.debug(o.memo)\n    }`));
    expect(js).toContain('mynt$savedSearch([search.Type.SALES_ORDER, "transaction"], "customsearch_open_orders", ["memo"], [], [["total", search.Operator.LESSTHAN, 35]])');
    const netsuite = run(js);
    expect(netsuite.search.runs[0]!.filters).toEqual([
      [[["total", "greaterthan", 5], "or", ["memo", "is", "first"]], "and", ["memo", "isnot", "orphan"]],
      "and",
      [["total", "lessthan", 35]],
    ]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["first", "second", "third"]);
  });

  it("the example compiles against the fixture snapshot file and runs", () => {
    const snapshot = new DocumentSchemaProvider(readSnapshot("tests/fixtures/account-snapshot.json"));
    expect(snapshot.getSavedSearch("customsearch_active_customers")).toEqual({ id: "customsearch_active_customers", record: "Customer" });
    const result = compile(EXAMPLE, { file: "examples/saved-search.mn", schema: snapshot });
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toMatchSnapshot();
    const netsuite = run(result.output!);
    expect(netsuite.search.runs[0]!.filters).toEqual([[["email", "isnotempty", ""]], "and", [["comments", "isempty", ""]]]);
    expect(netsuite.record.loadCalls.map((c) => c.id)).toEqual(["123"]);
    expect(netsuite.record.persisted("customer", "123")).toMatchObject({ comments: "Reviewed by Mynt" });
    // Without saved-search metadata (the builtin-style sample) the same source cannot know the result type.
    expect(compile(EXAMPLE, { file: "examples/saved-search.mn", schema: plainSchema }).diagnostics[0]!.code).toBe("MYNT1054");
  });
});

describe("saved search: snapshot shape", () => {
  it("is optional, additive, and version 1: a snapshot without it knows no saved searches", () => {
    const { savedSearches, ...without } = referenceFixtureSchema;
    expect(savedSearches).toBeDefined();
    const provider = new DocumentSchemaProvider(without);
    expect(provider.listSavedSearches()).toEqual([]);
    expect(provider.getSavedSearch("customsearch_customers")).toBeUndefined();
    expect(referenceFixtureSchema.myntSchemaVersion).toBe(1);
    expect(referenceSchema.listSavedSearches().map((s) => `${s.id}:${s.record}${s.searchType ? `:${s.searchType}` : ""}`)).toEqual([
      "customsearch_customers:Customer",
      "customsearch_active_customers:Customer",
      "customsearch_open_orders:SalesOrder",
      "customsearch_system_notes:SystemNote:systemnote",
      "customsearch_totals:SalesOrder",
    ]);
  });
});

describe("saved search: editor", () => {
  it("completes the snapshot's script ids after load Search( and inside the string, and Search itself after load", () => {
    expect(site(scheduled(`    let s = load Search(§`))).toBe("savedSearchId");
    expect(labels(scheduled(`    let s = load Search(§`))).toEqual(["customsearch_customers", "customsearch_active_customers", "customsearch_open_orders", "customsearch_system_notes", "customsearch_totals"]);
    expect(site(scheduled(`    let s = load Search("customsearch_c§")`))).toBe("savedSearchId|customsearch_c");
    expect(labels(scheduled(`    let s = load Search("customsearch_c§")`))).toContain("customsearch_customers");
    expect(labels(scheduled(`    let id = "x"\n    let n = 1\n    let s = load Search(§`))).toEqual(["customsearch_customers", "customsearch_active_customers", "customsearch_open_orders", "customsearch_system_notes", "customsearch_totals", "id"]);
    const items = completionsAt(at(scheduled(`    let s = load Search(§`)).doc, at(scheduled(`    let s = load Search(§`)).offset);
    expect(items[0]).toMatchObject({ label: "customsearch_customers", detail: "Customer saved search" });
    expect(items[3]).toMatchObject({ label: "customsearch_system_notes", detail: "SystemNote saved search · standalone systemnote" });
    expect(labels(scheduled(`    let s = load §`))).toContain("Search");
    expect(labels(scheduled(`    let s = create §`))).not.toContain("Search");
    // A snapshot without saved searches offers only string locals.
    const plain = analyze(scheduled(`    let id = "x"\n    let s = load Search(`), "t.mn", plainSchema);
    expect(completionsAt(plain, plain.text.indexOf("Search(") + 7).map((i) => i.label)).toEqual(["id"]);
  });

  it("completes the inferred record's fields after where and on rows, and the clause words on the next line", () => {
    expect(labels(scheduled(`    let s = load Search("customsearch_open_orders") where me§`))).toEqual(["memo", "total", "entity", "amount", "mainline", "trandate", "subsidiary", "true", "false"]);
    expect(labels(scheduled(`    let s = load Search("customsearch_customers")\n        where §`))).toContain("email");
    expect(labels(scheduled(`    for c in load Search("customsearch_customers") {\n        log.debug(c.§)\n    }`))).toContain("email");
    expect(labels(scheduled(`    let s = load Search("customsearch_customers")\n        §`)).slice(0, 6)).toEqual(["where", "select", "order by", "group by", "limit", "first"]);
    expect(labels(scheduled(`    let s = load Search("customsearch_customers")\n        select §`))).toContain("email");
    expect(labels(scheduled(`    let s = search Cus§`))).toContain("Customer");
  });

  it("hover tells a saved search from an ad-hoc one, says where its type came from, and describes the Search type", () => {
    expect(hover(scheduled(`    let s = lo§ad Search("customsearch_customers")`))).toBe(
      '```mynt\nload Search("customsearch_customers"): Sequence<Customer>\n```\n\nsaved Customer search · customsearch_customers · result type from the account snapshot · loaded by script id (`N/search.load`) and used as defined (its filters and columns stay) · read-only rows with `id` and the fields the program reads · one search runs per expression',
    );
    expect(hover(scheduled(`    let s = lo§ad Search("customsearch_system_notes")`))).toContain("standalone search type systemnote");
    expect(hover(scheduled(`    let s = load Sea§rch("customsearch_system_notes")`))).toBe(
      "```mynt\nplatform type Search\n```\n\nA saved search, loaded by its script id and used as a search source: its result type comes from the account snapshot, and it takes the same clauses as `search T`. · `load Search(\"customsearch_active_customers\")` · NetSuite module `N/search`\n\nthis one returns SystemNote rows, per the account snapshot",
    );
    expect(hover(scheduled(`    let s = sea§rch Customer`))).toContain("search over `N/search`");
  });

  it("semantic tokens: load stays a builtin operation, Search a builtin type, the id a string", () => {
    const all = tokens(scheduled(`    let saved = "x"\n    let s = load Search("customsearch_customers")\n        where email !== ""\n    let n = load Search("customsearch_system_notes")`));
    expect(all.filter((t) => /^(load|saved|Search|"customsearch_customers"|"customsearch_system_notes"|where):/.test(t))).toEqual([
      "saved:variable+declaration",
      "load:function+defaultLibrary",
      "Search:type+defaultLibrary",
      '"customsearch_customers":string',
      "where:keyword",
      "load:function+defaultLibrary",
      "Search:type+defaultLibrary",
      '"customsearch_system_notes":string',
    ]);
  });
});
