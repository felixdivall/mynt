/**
 * Search clauses: `where`, `select`, `order by`, `take` describe one search
 * and may appear in any order; each may appear once, and a repeat is a
 * likely mistake, never a merge. `select` is optional: without it the
 * planner fetches what the loop reads; with it the rows expose exactly the
 * selected fields and `id`. Uses the reference fixture (tests/helpers.ts).
 */
import { parse as parseJs } from "acorn";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile } from "../src/compiler.js";
import { completionsAt } from "../src/lsp/completion.js";
import { completionSite } from "../src/lsp/context.js";
import { hoverAt } from "../src/lsp/hover.js";
import { analyze, resolveNameAt } from "../src/semantic/query.js";
import { semanticTokens } from "../src/semantic/tokens.js";
import { compileMynt, referenceSchema } from "./helpers.js";
import { FakeNetSuite, scheduledContext } from "./harness/fake-netsuite.js";

const EXAMPLE = readFileSync(new URL("../examples/search-select.mn", import.meta.url), "utf8");
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
/** The emitted search call: what the helper is asked for, with its parentheses balanced. */
const call = (source: string) => {
  const body = output(source).split("function execute")[1]!;
  const begin = body.search(/mynt\$(?:search|savedSearch)\(/);
  let depth = 0;
  for (let i = body.indexOf("(", begin); i < body.length; i++) {
    if (body[i] === "(") depth++;
    if (body[i] === ")" && --depth === 0) return body.slice(begin, i + 1);
  }
  throw new Error("unbalanced call");
};
function at(source: string) {
  const offset = source.indexOf("§");
  const text = source.slice(0, offset) + source.slice(offset + 1);
  return { doc: analyze(text, "t.mn", referenceSchema), offset, text };
}
const labels = (source: string) => completionsAt(at(source).doc, at(source).offset).map((i) => i.label);
const hover = (source: string) => hoverAt(at(source).doc, at(source).offset)?.contents;
const site = (source: string) => {
  const { doc, offset, text } = at(source);
  return completionSite(text, offset, (name) => resolveNameAt(doc, name, offset)).context.kind;
};
const tokens = (text: string) =>
  semanticTokens(analyze(text, "t.mn", referenceSchema)).map((t) => `${text.slice(t.span.start.offset, t.span.end.offset)}:${t.kind}${t.modifiers.map((m) => `+${m}`).join("")}`);

function seeded() {
  const netsuite = new FakeNetSuite();
  netsuite.record.seed("customer", "123", { email: "a@x.com", comments: "", subsidiary: "1" }, {}, { subsidiary: "Parent Company" });
  netsuite.record.seed("customer", "124", { email: "b@x.com", comments: "", subsidiary: "2" }, {}, { subsidiary: "Nordic AB" });
  netsuite.record.seed("salesorder", "5", { memo: "first", total: 30, entity: "123" }, {}, { entity: "Acme" });
  netsuite.record.seed("salesorder", "6", { memo: "second", total: 20, entity: "124" }, {}, { entity: "Beta" });
  netsuite.record.seed("salesorder", "7", { memo: "third", total: 30, entity: "123" }, {}, { entity: "Acme" });
  netsuite.record.seed("salesorder", "8", { memo: "fourth", total: 5, entity: "124" }, {}, { entity: "Beta" });
  netsuite.search.relate("salesorder", "entity", "entity", "customer");
  netsuite.search.saveSearch("customsearch_open_orders", {
    searchType: "transaction",
    columns: [{ name: "memo" }, { name: "total" }],
    filters: [["memo", "isnot", "fourth"]],
  });
  return netsuite;
}
const run = (js: string, netsuite = seeded()) => {
  netsuite.load(js).execute!(scheduledContext());
  return netsuite;
};
const logged = (source: string) => run(output(source)).log.calls.map((c) => c.details);

describe("clause order is not meaning", () => {
  const ORDERS = [
    ["select memo", "where total > 10", "order by total desc"],
    ["where total > 10", "order by total desc", "select memo"],
    ["order by total desc", "select memo", "where total > 10"],
    ["limit 2", "where total > 10", "select memo", "order by total desc"],
    ["select memo", "order by total desc", "limit 2", "where total > 10"],
  ];

  it("every permutation binds to one search model and emits the same call", () => {
    const calls = ORDERS.map((clauses) => call(scheduled(`    let o = search SalesOrder\n        ${clauses.join("\n        ")}\n    for x in o {\n        log.debug(x.memo)\n    }`)));
    const withoutTake = calls.slice(0, 3);
    expect(new Set(withoutTake).size).toBe(1);
    expect(withoutTake[0]).toBe('mynt$search(search.Type.SALES_ORDER, [{ name: "total", sort: "DESC", hidden: true }, "memo"], [], [["total", search.Operator.GREATERTHAN, 10]])');
    expect(calls[3]).toBe(calls[4]);
    expect(calls[3]).toBe('mynt$search(search.Type.SALES_ORDER, [{ name: "total", sort: "DESC", hidden: true }, "memo"], [], [["total", search.Operator.GREATERTHAN, 10]], 2)');
    const result = compileRefs(scheduled(`    let o = search SalesOrder\n        limit 2\n        order by total desc\n        select memo\n        where total > 10\n    for x in o { }`));
    const declaration = result.unit!.kind === "Scheduled" ? result.unit!.entryPoint.body[0]! : undefined;
    expect(declaration).toMatchObject({
      initializer: {
        kind: "Query",
        limit: 2,
        first: false,
        orderBy: [{ kind: "SortSpec", direction: "desc", field: { kind: "QueryField", field: { id: "total" } } }],
        select: [{ kind: "SelectedField", field: { kind: "QueryField", field: { id: "memo" } } }],
        predicate: { kind: "Compare", field: { id: "total" } },
        type: { element: { exposes: [{ field: { id: "memo" }, join: undefined }] } },
      },
    });
  });

  it("runs the same whichever order was written, and clauses may share a line", () => {
    for (const clauses of ORDERS) {
      expect(logged(scheduled(`    for x in search SalesOrder\n        ${clauses.join("\n        ")} {\n        log.debug(x.memo)\n    }`))).toEqual(clauses.includes("limit 2") ? ["first", "third"] : ["first", "third", "second"]);
    }
    expect(logged(scheduled(`    for x in search SalesOrder select memo where total > 10 order by memo {\n        log.debug(x.memo)\n    }`))).toEqual(["first", "second", "third"]);
  });
});

describe("singleton clauses", () => {
  it("MYNT1056 reports a repeated where, select, order by, or take at the repeat, with the first's line and the fix", () => {
    expect(first(scheduled(`    let o = search SalesOrder\n        where total > 1\n        where memo !== ""`))).toBe(
      "MYNT1056 A search can only contain one 'where' clause; the first is on line 3. Combine conditions with '&&' or '||'",
    );
    expect(first(scheduled(`    let o = search SalesOrder\n        select memo\n        select total`))).toBe(
      "MYNT1056 A search can only contain one 'select' clause; the first is on line 3. Add the fields to the same clause, like 'select a, b'",
    );
    expect(first(scheduled(`    let o = search SalesOrder\n        order by memo\n        order by total desc`))).toBe(
      "MYNT1056 A search can only contain one 'order by' clause; the first is on line 3. Put every sort key in one clause, like 'order by a desc, b'",
    );
    expect(first(scheduled(`    let o = search SalesOrder limit 1 limit 2`))).toContain("MYNT1056 A search can only contain one 'limit' clause");
    // Not merged: the second where is not AND-ed in.
    const dup = compileRefs(scheduled(`    let o = search SalesOrder\n        where total > 1\n        where memo !== ""\n    for x in o { }`));
    expect(dup.diagnostics.map((d) => d.code)).toEqual(["MYNT1056", "MYNT1010"]);
    expect(dup.output).toBeUndefined();
  });
});

describe("select", () => {
  it("fixes what the rows expose, keeps id, and plans exactly the selected columns even when unread", () => {
    expect(messages(scheduled(`    let o = search SalesOrder\n        select memo, total\n    for x in o {\n        log.debug(x.memo)\n        log.debug(x.id)\n    }`))).toEqual([]);
    expect(first(scheduled(`    let o = search SalesOrder\n        select memo\n    for x in o {\n        log.debug(x.total)\n    }`))).toBe(
      "MYNT1050 'total' was not selected: this SalesOrder search selects memo. Add it to the 'select' clause, 'memo, total'",
    );
    expect(first(scheduled(`    let o = search SalesOrder\n        select memo\n    for x in o {\n        log.debug(x.nope)\n    }`))).toContain("MYNT1004 SalesOrder has no field 'nope'");
    expect(call(scheduled(`    let o = search SalesOrder\n        select memo, total\n    for x in o {\n        log.debug(x.id)\n    }`))).toBe('mynt$search(search.Type.SALES_ORDER, ["memo", "total"], [])');
    expect(logged(scheduled(`    for x in search SalesOrder select memo, total {\n        log.debug(x.id)\n    }`))).toEqual(["5", "6", "7", "8"]);
  });

  it("without select, the planner still fetches what the loop reads", () => {
    expect(call(scheduled(`    for x in search SalesOrder where total > 10 {\n        log.debug(x.memo)\n        log.debug(x.entity.text)\n    }`))).toBe(
      'mynt$search(search.Type.SALES_ORDER, ["entity", "memo"], ["entity"], [["total", search.Operator.GREATERTHAN, 10]])',
    );
    expect(messages(scheduled(`    for x in search SalesOrder {\n        log.debug(x.memo)\n        if x.total > 1 { }\n        log.debug(x.entity.email)\n    }`))).toEqual([]);
  });

  it("selected references keep id and text, selected joined fields are one hop, and a reference's own members need the reference selected", () => {
    const js = output(scheduled(`    for x in search SalesOrder select memo, entity, entity.email {\n        log.debug(x.entity.id)\n        log.debug(x.entity.text)\n        log.debug(x.entity.email)\n    }`));
    expect(js).toContain('mynt$search(search.Type.SALES_ORDER, ["entity", { name: "email", join: "entity", field: "entity" }, "memo"], ["entity"])');
    expect(run(js).log.calls.map((c) => c.details)).toEqual(["123", "Acme", "a@x.com", "124", "Beta", "b@x.com", "123", "Acme", "a@x.com", "124", "Beta", "b@x.com"]);
    expect(first(scheduled(`    for x in search SalesOrder select entity.email {\n        log.debug(x.entity.id)\n    }`))).toBe(
      "MYNT1050 'entity' was not selected: this SalesOrder search selects entity.email. Add it to the 'select' clause, 'entity.email, entity'",
    );
    expect(first(scheduled(`    for x in search SalesOrder select entity {\n        log.debug(x.entity.email)\n    }`))).toBe(
      "MYNT1050 'entity.email' was not selected: this SalesOrder search selects entity. Add it to the 'select' clause, 'entity, entity.email'",
    );
    expect(first(scheduled(`    let o = search SalesOrder select entity.subsidiary.name`))).toContain("MYNT1053 'entity.subsidiary.name' is a second join hop");
    expect(first(scheduled(`    let o = search Customer select category.name`))).toContain("MYNT1053 'category' is a multiselect");
  });

  it("rejects what is not a field, a duplicate, an empty list, and select on query", () => {
    expect(first(scheduled(`    let o = search SalesOrder select nope`))).toContain("MYNT1004 SalesOrder has no field or sublist 'nope'");
    expect(first(scheduled(`    let o = search SalesOrder select memo, memo`))).toBe("MYNT1047 'memo' is selected twice (first at column 38); list each field once");
    expect(first(scheduled(`    let o = search SalesOrder\n        select`))).toContain("MYNT0001 Expected the fields to select after 'select'");
    expect(first(scheduled(`    let o = search SalesOrder\n        select memo,\n    log.debug("next")`))).toContain("MYNT0001 Expected a field after ',' in 'select'");
    expect(first(scheduled(`    let o = query Customer select email`))).toBe(
      "MYNT1031 'select' is a search clause; 'query' (N/query) supports only 'where' so far. Use 'search' for selection, ordering, grouping, and limits",
    );
    // Clause words are identifiers elsewhere.
    expect(messages(scheduled(`    let select = "x"\n    let order = select\n    let first = order\n    let limit = first\n    log.debug(limit)`))).toEqual([]);
  });

  it("the field-mapping search: every column lowers once, references normalize, and nothing else is fetched", () => {
    const netsuite = seeded();
    netsuite.record.seed("customrecord_field_mapping", "1", {
      type: "body",
      externalfieldid: "ext_email",
      netsuitefieldid: "email",
      netsuitefieldtype: "text",
      netsuitefieldrectype: "",
      netsuiteconnectorfield: "123",
      defaultvalue: "",
      suiteql: "",
      inclusion: true,
      searchfield: "email",
      searchjoin: "",
      searchgetmethod: "getValue",
      sortorder: 2,
    }, {}, { netsuiteconnectorfield: "Acme" });
    netsuite.record.seed("customrecord_field_mapping", "2", { type: "line", externalfieldid: "ext_qty", netsuitefieldid: "quantity", inclusion: false, sortorder: 1 });
    const source = scheduled(
      `    let mappings = search FieldMapping\n        select type,\n            externalfieldid,\n            netsuitefieldid,\n            netsuitefieldtype,\n            netsuitefieldrectype,\n            netsuiteconnectorfield,\n            defaultvalue,\n            suiteql,\n            inclusion,\n            searchfield,\n            searchjoin,\n            searchgetmethod\n        where inclusion\n        order by sortorder\n` +
        `    for mapping in mappings {\n        log.debug(mapping.externalfieldid)\n        log.debug(mapping.netsuiteconnectorfield.text)\n        log.debug(mapping.searchgetmethod)\n    }`,
    );
    const js = output(source);
    expect(js).toContain(
      'mynt$search("customrecord_field_mapping", [{ name: "sortorder", sort: "ASC", hidden: true }, "defaultvalue", "externalfieldid", "inclusion", "netsuiteconnectorfield", "netsuitefieldid", "netsuitefieldrectype", "netsuitefieldtype", "searchfield", "searchgetmethod", "searchjoin", "suiteql", "type"], ["netsuiteconnectorfield"], [["inclusion", search.Operator.IS, "T"]])',
    );
    expect(js.split("function execute")[1]).not.toMatch(/getValue|getText/);
    run(js, netsuite);
    expect(netsuite.search.runs[0]!.columns).toEqual([
      "sortorder",
      "internalid",
      "defaultvalue",
      "externalfieldid",
      "inclusion",
      "netsuiteconnectorfield",
      "netsuitefieldid",
      "netsuitefieldrectype",
      "netsuitefieldtype",
      "searchfield",
      "searchgetmethod",
      "searchjoin",
      "suiteql",
      "type",
    ]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["ext_email", "Acme", "getValue"]);
    expect(netsuite.search.lookupCalls).toEqual([]);
    expect(netsuite.record.loadCalls).toEqual([]);
    // A sort-only column is fetched but never exposed.
    expect(first(source.replace("log.debug(mapping.searchgetmethod)", "log.debug(mapping.sortorder)"))).toContain("MYNT1050 'sortorder' was not selected");
  });
});

describe("order by and take", () => {
  it("sorts ascending by default, descending on request, by several keys, with internal id as the tiebreaker", () => {
    expect(logged(scheduled(`    for x in search SalesOrder order by total {\n        log.debug(x.memo)\n    }`))).toEqual(["fourth", "second", "first", "third"]);
    expect(logged(scheduled(`    for x in search SalesOrder order by total asc {\n        log.debug(x.memo)\n    }`))).toEqual(["fourth", "second", "first", "third"]);
    expect(logged(scheduled(`    for x in search SalesOrder order by total desc, memo desc {\n        log.debug(x.memo)\n    }`))).toEqual(["third", "first", "second", "fourth"]);
    const js = output(scheduled(`    for x in search SalesOrder order by total desc, memo {\n        log.debug(x.memo)\n    }`));
    expect(js).toContain('[{ name: "total", sort: "DESC", hidden: true }, { name: "memo", sort: "ASC" }]');
    expect(run(js).search.runs[0]!.columns).toEqual(["total", "memo", "internalid"]);
    expect(messages(scheduled(`    for x in search SalesOrder order by entity.email desc {\n        log.debug(x.memo)\n    }`))).toEqual([]);
  });

  it("refuses sort keys it cannot order honestly, and reports incomplete clauses", () => {
    expect(first(scheduled(`    let c = search Customer order by category`))).toBe("MYNT1057 Cannot sort by 'category': a multiselect has no single value to order by");
    expect(first(scheduled(`    let c = search Customer order by nope`))).toContain("MYNT1004");
    expect(first(scheduled(`    let c = search Customer\n        order`))).toContain("MYNT0001 Expected 'by' after 'order'");
    expect(first(scheduled(`    let c = search Customer\n        order by`))).toContain("MYNT0001 Expected a field to sort by after 'order by'");
    expect(messages(scheduled(`    let c = search Customer\n        order by email\n    for x in c { }`))).toEqual([]);
  });

  it("limit bounds the rows after filtering and sorting, with a positive whole literal, and limit 1 is still a sequence", () => {
    const one = compileRefs(scheduled(`    let o = search SalesOrder limit 1\n    for x in o { }`));
    expect(one.unit!.kind === "Scheduled" ? one.unit!.entryPoint.body[0] : undefined).toMatchObject({ initializer: { limit: 1, first: false, type: { kind: "Sequence" } } });
    expect(logged(scheduled(`    for x in search SalesOrder order by total desc limit 2 {\n        log.debug(x.memo)\n    }`))).toEqual(["first", "third"]);
    expect(logged(scheduled(`    for x in search SalesOrder where total > 10 limit 1 {\n        log.debug(x.memo)\n    }`))).toEqual(["first"]);
    expect(first(scheduled(`    let o = search SalesOrder limit 0`))).toBe("MYNT1057 'limit' needs a positive whole number of rows written as a literal, like 'limit 100'; 0 is not one");
    expect(first(scheduled(`    let o = search SalesOrder limit 10.5`))).toContain("10.5 is not one");
    expect(first(scheduled(`    let n = 5\n    let o = search SalesOrder limit n`))).toBe("MYNT1057 'limit' needs a positive whole number of rows written as a literal, like 'limit 100'");
    expect(first(scheduled(`    let o = search SalesOrder\n        limit`))).toContain("MYNT0001 Expected the number of rows after 'limit'");
    const netsuite = seeded();
    for (let i = 10; i < 2510; i++) netsuite.record.seed("salesorder", String(i), { memo: `o${i}`, total: 1 });
    netsuite.load(output(scheduled(`    for x in search SalesOrder limit 1500 {\n        log.debug(x.id)\n    }`))).execute!(scheduledContext());
    expect(netsuite.log.calls).toHaveLength(1500);
  });
});

describe("saved searches with clauses", () => {
  it("select restricts the row shape and plans columns through the saved-search planner; where ANDs; order by replaces the saved ordering", () => {
    const js = output(scheduled(`    for o in search saved "customsearch_open_orders"\n        select memo\n        where total > 10\n        order by total desc {\n        log.debug(o.memo)\n    }`));
    expect(js).toContain('mynt$savedSearch([search.Type.SALES_ORDER, "transaction"], "customsearch_open_orders", [{ name: "total", sort: "DESC", hidden: true }, "memo"], [], [["total", search.Operator.GREATERTHAN, 10]])');
    expect(js).toContain("if (ordered) s.columns.forEach((column) => { column.sort = search.Sort.NONE; });");
    const netsuite = run(js);
    expect(netsuite.search.runs[0]!.columns).toEqual(["memo", "total"]);
    expect(netsuite.search.runs[0]!.filters).toEqual([[["memo", "isnot", "fourth"]], "and", [["total", "greaterthan", 10]]]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["first", "third", "second"]);
    expect(netsuite.search.savedDefinition("customsearch_open_orders")!.columns).toEqual([{ name: "memo" }, { name: "total" }]);
    expect(first(scheduled(`    for o in search saved "customsearch_open_orders" select memo {\n        log.debug(o.total)\n    }`))).toContain("MYNT1050 'total' was not selected");
  });

  it("limit applies to a saved search too", () => {
    expect(logged(scheduled(`    for o in search saved "customsearch_open_orders" order by total limit 1 {\n        log.debug(o.memo)\n    }`))).toEqual(["second"]);
  });
});

describe("the example", () => {
  it("compiles against the sample schema and runs each form", () => {
    const result = compileMynt(EXAMPLE, "examples/search-select.mn");
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toMatchSnapshot();
    const netsuite = new FakeNetSuite();
    netsuite.record.seed("salesorder", "1", { memo: "a", total: 5000 });
    netsuite.record.seed("salesorder", "2", { memo: "", total: 9000 });
    netsuite.record.seed("salesorder", "3", { memo: "c", total: 10 });
    netsuite.load(result.output!).execute!(scheduledContext());
    expect(netsuite.search.runs.map((r) => r.columns)).toEqual([["internalid", "memo"], ["total", "internalid", "memo"], ["total", "internalid", "memo"], ["total", "internalid"]]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["a", "c", "", "a", "2", "1"]);
  });
});

describe("editor", () => {
  it("offers the clause words not yet used at a line after a search, then the usual statements", () => {
    expect(site(scheduled(`    let o = search SalesOrder\n        §`))).toBe("searchClause");
    expect(labels(scheduled(`    let o = search SalesOrder\n        §`)).slice(0, 6)).toEqual(["where", "select", "order by", "group by", "limit", "first"]);
    expect(labels(scheduled(`    let o = search SalesOrder\n        select memo\n        §`)).slice(0, 5)).toEqual(["where", "order by", "group by", "limit", "first"]);
    expect(labels(scheduled(`    let o = search SalesOrder\n        select memo\n        where total > 1\n        order by memo\n        §`)).slice(0, 3)).toEqual(["group by", "limit", "first"]);
    // `first` and `limit` exclude each other: either rules out both.
    expect(labels(scheduled(`    let o = search SalesOrder\n        first\n        §`)).slice(0, 5)).toEqual(["or return", "or {", "where", "select", "order by"]);
    const all = labels(scheduled(`    let o = search SalesOrder\n        select memo\n        where total > 1\n        order by memo\n        limit 1\n        group by memo\n        §`));
    expect(all[0]).toBe("let");
    expect(all).not.toContain("select");
    expect(labels(scheduled(`    let o = search saved "customsearch_open_orders"\n        §`)).slice(0, 6)).toEqual(["where", "select", "order by", "group by", "limit", "first"]);
    expect(labels(scheduled(`    log.debug("x")\n    §`))[0]).toBe("let");
  });

  it("completes fields in select (minus those listed), sortable fields in order by, then asc/desc", () => {
    expect(site(scheduled(`    let o = search SalesOrder\n        select §`))).toBe("selectField");
    expect(labels(scheduled(`    let o = search SalesOrder\n        select §`)).slice(0, 7)).toEqual(["memo", "total", "entity", "amount", "mainline", "trandate", "subsidiary"]);
    expect(labels(scheduled(`    let o = search SalesOrder\n        select memo, §`)).slice(0, 6)).toEqual(["total", "entity", "amount", "mainline", "trandate", "subsidiary"]);
    expect(labels(scheduled(`    let o = search saved "customsearch_open_orders"\n        select §`)).slice(0, 7)).toEqual(["memo", "total", "entity", "amount", "mainline", "trandate", "subsidiary"]);
    expect(site(scheduled(`    let o = search SalesOrder\n        order by §`))).toBe("sortField");
    expect(labels(scheduled(`    let o = search Customer\n        order by §`))).toEqual(["comments", "email", "entityid", "subsidiary", "parent"]);
    expect(labels(scheduled(`    let o = search SalesOrder\n        order by total §`))).toEqual(["asc", "desc"]);
    expect(labels(scheduled(`    let o = search SalesOrder\n        order by total desc, §`))).toEqual(["memo", "total", "entity", "amount", "mainline", "trandate", "subsidiary"]);
    expect(labels(scheduled(`    let o = search SalesOrder\n        where §`))).toContain("memo");
  });

  it("hover summarizes the clauses, and tokens mark the clause words as keywords and the fields as properties", () => {
    expect(hover(scheduled(`    let o = sea§rch SalesOrder select memo, entity.email where total > 1 order by total desc, memo limit 5`))).toContain(
      "selects memo, entity.email (and `id`) · ordered by total desc, memo asc · at most 5 rows",
    );
    expect(hover(scheduled(`    let o = search SalesOrder select me§mo`))).toContain("SalesOrder.memo: string");
    expect(hover(scheduled(`    let o = search SalesOrder order by entity.ema§il`))).toContain("reached through SalesOrder.entity");
    const all = tokens(scheduled(`    let select = 1\n    let o = search SalesOrder\n        select memo, entity.email\n        where total > 1\n        order by total desc, memo asc\n        limit 5`));
    expect(all.filter((t) => /^(select|where|order|by|asc|desc|limit|memo|total|entity|email):/.test(t))).toEqual([
      "select:variable+declaration",
      "select:keyword",
      "memo:property",
      "entity:property",
      "email:property",
      "where:keyword",
      "total:property+readonly",
      "order:keyword",
      "by:keyword",
      "total:property+readonly",
      "desc:keyword",
      "memo:property",
      "asc:keyword",
      "limit:keyword",
    ]);
  });
});

describe("first: one optional row", () => {
  it("is an Optional of the row type, not a sequence, whatever the clause order, and pins the difference from limit 1", () => {
    for (const clauses of [
      ["where total > 10", "order by total desc", "first"],
      ["first", "where total > 10", "order by total desc"],
      ["order by total desc", "first", "where total > 10"],
    ]) {
      const result = compileRefs(scheduled(`    let latest = search SalesOrder\n        ${clauses.join("\n        ")}`));
      expect(result.diagnostics).toEqual([]);
      const declaration = result.unit!.kind === "Scheduled" ? result.unit!.entryPoint.body[0] : undefined;
      expect(declaration).toMatchObject({ initializer: { first: true, limit: undefined, type: { kind: "Optional", element: { kind: "Record", record: { name: "SalesOrder" }, origin: "search" } } }, local: { type: { kind: "Optional" } } });
      expect(call(scheduled(`    let latest = search SalesOrder\n        ${clauses.join("\n        ")}`))).toBe(
        'mynt$search(search.Type.SALES_ORDER, [{ name: "total", sort: "DESC", hidden: true }], [], [["total", search.Operator.GREATERTHAN, 10]], undefined, true)',
      );
    }
    expect(call(scheduled(`    let one = search SalesOrder where total > 10 order by total desc limit 1\n    for x in one { }`))).toBe(
      'mynt$search(search.Type.SALES_ORDER, [{ name: "total", sort: "DESC", hidden: true }], [], [["total", search.Operator.GREATERTHAN, 10]], 1)',
    );
    expect(hover(scheduled(`    let latest = sea§rch SalesOrder where total > 10 first`))).toContain("first: SalesOrder?");
    expect(hover(scheduled(`    let latest = search SalesOrder where total > 10 first\n    log.debug(lat§est.memo)`))).toContain("latest: SalesOrder?");
  });

  it("fetches one row alone through run().getRange, ordered first, with the tiebreaker, and null when there is none", () => {
    const js = output(scheduled(`    let latest = search SalesOrder\n        order by total desc\n        select memo\n        first\n    let none = search SalesOrder\n        where total > 1000\n        first\n    let lowest = search SalesOrder first`));
    expect(js).toContain("const results = s.run().getRange({ start: 0, end: 1 });");
    expect(js).not.toContain("runPaged({ pageSize: 1 })");
    const netsuite = run(js);
    expect(netsuite.search.runs.map((r) => r.columns)).toEqual([["total", "internalid", "memo"], ["internalid"], ["internalid"]]);
    // The helper returns the normalized row or null; the locals hold them.
    const script = js.split("function execute")[1]!;
    expect(script).toContain("const latest = mynt$search(");
    expect(script).toContain(", undefined, true);");
    const runtime = new FakeNetSuite();
    runtime.record.seed("salesorder", "5", { memo: "first", total: 30 });
    runtime.record.seed("salesorder", "6", { memo: "second", total: 20 });
    runtime.record.seed("salesorder", "7", { memo: "third", total: 30 });
    const first = runtime.search.create({ type: "salesorder", columns: [runtime.search.createColumn({ name: "total", sort: "DESC" }), runtime.search.createColumn({ name: "internalid", sort: "ASC" })] }).run().getRange({ start: 0, end: 1 });
    expect(first.map((r) => r.id)).toEqual(["5"]);
  });

  it("cannot be read from, iterated, repeated, or combined with limit", () => {
    expect(first(scheduled(`    let latest = search SalesOrder first\n    log.debug(latest.memo)`))).toBe(
      "MYNT1058 'latest' may be absent: a search with 'first' returns one SalesOrder row or none. Resolve it where it is declared, 'let latest = ... or return' (or 'or { ... return }'), or test for presence with 'if latest { ... }' before reading '.memo'",
    );
    expect(first(scheduled(`    let latest = search SalesOrder first\n    for x in latest { }`))).toBe(
      "MYNT1029 Cannot iterate over a SalesOrder? value: a search with 'first' is one optional row, not a sequence. Use 'limit 1' for a sequence of at most one row",
    );
    expect(first(scheduled(`    let latest = search SalesOrder\n        first\n        first`))).toBe("MYNT1056 A search can only contain one 'first' clause; the first is on line 3. One 'first' is enough");
    expect(first(scheduled(`    let latest = search SalesOrder\n        first\n        limit 10`))).toBe("MYNT1057 A search cannot use both 'first' and 'limit'. Use 'first' for a single optional row or 'limit' for a bounded sequence");
    const reversed = compileRefs(scheduled(`    let latest = search SalesOrder\n        limit 10\n        first`));
    expect(reversed.diagnostics[0]!.message).toContain("cannot use both 'first' and 'limit'");
    expect(reversed.diagnostics[0]!.span.start.line).toBe(4);
    expect(first(scheduled(`    let latest = search SalesOrder first\n    if latest === latest { }`))).toContain("MYNT1023");
  });

  it("keeps select semantics (one projected optional row) and works on saved searches, in memory only", () => {
    const projected = compileRefs(scheduled(`    let account = search SalesOrder\n        where total > 1\n        select memo\n        first`));
    expect(projected.diagnostics).toEqual([]);
    expect(projected.unit!.kind === "Scheduled" ? projected.unit!.entryPoint.body[0] : undefined).toMatchObject({
      initializer: { type: { kind: "Optional", element: { exposes: [{ field: { id: "memo" } }] } } },
    });
    const js = output(scheduled(`    let customer = search saved "customsearch_open_orders"\n        where total > 1\n        order by total\n        first`));
    expect(js).toContain('mynt$savedSearch([search.Type.SALES_ORDER, "transaction"], "customsearch_open_orders", [{ name: "total", sort: "ASC", hidden: true }], [], [["total", search.Operator.GREATERTHAN, 1]], undefined, undefined, true)');
    const netsuite = run(js);
    expect(netsuite.search.runs[0]!.filters).toEqual([[["memo", "isnot", "fourth"]], "and", [["total", "greaterthan", 1]]]);
    expect(netsuite.search.savedDefinition("customsearch_open_orders")!.columns).toEqual([{ name: "memo" }, { name: "total" }]);
  });
});
