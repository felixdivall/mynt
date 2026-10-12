/**
 * Summary searches: `group by` and named aggregates in `select` make a
 * search's rows aggregate buckets (`Summary<T>`), exposing exactly the
 * grouped fields and the aggregate names. The clauses stay
 * order-independent, `order by` names result fields, `limit`/`first`/`or`
 * are the ordinary cardinality and optional forms. Uses the reference
 * fixture (tests/helpers.ts) and the fake runtime.
 */
import { parse as parseJs } from "acorn";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile } from "../src/compiler.js";
import { completionsAt } from "../src/lsp/completion.js";
import { completionSite } from "../src/lsp/context.js";
import { hoverAt } from "../src/lsp/hover.js";
import { analyze, resolveNameAt } from "../src/semantic/query.js";
import { referencesOf, renameRefusal, symbolAt } from "../src/semantic/symbols.js";
import { semanticTokens } from "../src/semantic/tokens.js";
import { referenceSchema } from "./helpers.js";
import { FakeNetSuite, scheduledContext } from "./harness/fake-netsuite.js";

const EXAMPLE = readFileSync(new URL("../examples/search-totals.mn", import.meta.url), "utf8");
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
/** The emitted search call, with its parentheses balanced. */
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
  netsuite.record.seed("customer", "125", { email: "c@x.com", comments: "", subsidiary: "2" }, {}, { subsidiary: "Nordic AB" });
  const order = (id: string, memo: string, amount: number, mainline: boolean, entity: string, subsidiary: string, trandate: string) =>
    netsuite.record.seed("salesorder", id, { memo, total: amount, amount, mainline, entity, subsidiary, trandate }, {}, { entity: { "123": "Acme", "124": "Beta", "125": "Gamma" }[entity]!, subsidiary: subsidiary === "1" ? "Parent Company" : "Nordic AB" });
  order("5", "first", 30, true, "123", "1", "2026-01-05");
  order("6", "second", 20, true, "124", "2", "2026-02-01");
  order("7", "third", 25, true, "123", "1", "2026-03-09");
  order("8", "fourth", 5, false, "124", "2", "2025-12-31");
  order("9", "fifth", 40, true, "125", "2", "2026-04-01");
  netsuite.search.relate("salesorder", "entity", "entity", "customer");
  netsuite.search.saveSearch("customsearch_open_orders", { searchType: "transaction", columns: [{ name: "memo" }, { name: "total" }], filters: [["memo", "isnot", "fourth"]] });
  netsuite.search.saveSearch("customsearch_totals", { searchType: "transaction", columns: [{ name: "entity", summary: "GROUP" }, { name: "amount", summary: "SUM" }], filters: undefined });
  return netsuite;
}
const run = (js: string, netsuite = seeded()) => {
  netsuite.load(js).execute!(scheduledContext());
  return netsuite;
};
const logged = (source: string, netsuite?: FakeNetSuite) => run(output(source), netsuite).log.calls.map((c) => c.details);

const TOTALS = scheduled(`    let totals = search SalesOrder\n        where mainline === true\n        group by entity\n        select entity, total = sum(amount)\n        order by total desc\n    for row in totals {\n        log.debug(row.entity.text)\n        log.debug(row.entity.id)\n        if row.total === 55 {\n            log.debug("fifty-five")\n        }\n    }`);

describe("total by customer", () => {
  it("groups the filtered rows, exposes the grouped reference with id and text, and sums per group", () => {
    expect(call(TOTALS)).toBe(
      'mynt$search(search.Type.SALES_ORDER, [{ name: "amount", summary: "SUM", alias: "total", sort: "DESC" }, { name: "entity", summary: "GROUP" }], ["entity"], [["mainline", search.Operator.IS, "T"]])',
    );
    const netsuite = run(output(TOTALS));
    expect(netsuite.search.runs[0]!.columns).toEqual(["SUM(amount)", "GROUP(entity)"]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["Acme", "123", "fifty-five", "Gamma", "125", "Beta", "124"]);
    const result = compileRefs(TOTALS);
    const declaration = result.unit!.kind === "Scheduled" ? result.unit!.entryPoint.body[0]! : undefined;
    expect(declaration).toMatchObject({
      initializer: {
        kind: "Query",
        summary: true,
        groupBy: [{ kind: "GroupKey", field: { kind: "QueryField", field: { id: "entity" } } }],
        select: [{ kind: "SelectedField" }, { kind: "SelectedAggregate", alias: "total", aggregate: "sum", type: "Number" }],
        orderBy: [{ kind: "SortSpec", field: { kind: "AliasReference" }, direction: "desc" }],
        type: { kind: "Sequence", element: { kind: "Summary", fields: [{ name: "entity", summary: "group" }, { name: "total", summary: "sum", type: "Number" }] } },
      },
    });
  });

  it("summary mode is a group by or an aggregate, never a keyword; the row type is Summary<T>", () => {
    expect(hover(scheduled(`    let t§otals = search SalesOrder group by entity select entity, total = sum(amount)`))).toBe(
      "```mynt\ntotals: Sequence<Summary<SalesOrder>>\n```\n\nlocal · Sequence<Summary<SalesOrder>> (N/search summary rows, read-only: entity: Ref<Customer>, total: number (sum of amount))",
    );
    expect(hover(scheduled(`    let t§otals = search SalesOrder select total = sum(amount)`))).toContain("Sequence<Summary<SalesOrder>>");
    expect(hover(scheduled(`    let t§otals = search SalesOrder group by entity`))).toContain("(N/search summary rows, read-only: entity: Ref<Customer>)");
    expect(hover(scheduled(`    let t§otals = search SalesOrder select entity`))).toContain("Sequence<SalesOrder>");
  });
});

describe("clause order is not meaning", () => {
  const ORDERS = [
    ["where mainline === true", "group by entity", "select entity, total = sum(amount)", "order by total desc"],
    ["select entity, total = sum(amount)", "group by entity", "where mainline === true", "order by total desc"],
    ["order by total desc", "group by entity", "select entity, total = sum(amount)", "where mainline === true"],
    ["order by total desc", "select entity, total = sum(amount)", "group by entity", "where mainline === true"],
  ];

  it("every permutation, including order by an alias before select declares it, emits the same search", () => {
    const calls = ORDERS.map((clauses) => call(scheduled(`    let o = search SalesOrder\n        ${clauses.join("\n        ")}\n    for x in o {\n        log.debug(x.entity.text)\n    }`)));
    expect(new Set(calls).size).toBe(1);
    expect(logged(scheduled(`    for row in search SalesOrder\n        order by total desc\n        select entity, total = sum(amount)\n        group by entity {\n        log.debug(row.entity.text)\n    }`))).toEqual(["Acme", "Gamma", "Beta"]);
  });

  it("group by is a singleton; several keys share one clause, and a repeated key is reported", () => {
    expect(first(scheduled(`    let o = search SalesOrder\n        group by entity\n        group by subsidiary`))).toBe(
      "MYNT1056 A search can only contain one 'group by' clause; the first is on line 3. Put every group field in one clause, like 'group by a, b'",
    );
    expect(first(scheduled(`    let o = search SalesOrder group by entity, entity`))).toBe("MYNT1047 'entity' is grouped twice (first at column 40); list each field once");
    expect(messages(scheduled(`    let o = search SalesOrder\n        group by entity, subsidiary\n        select entity, subsidiary, total = sum(amount)`))).toEqual([]);
    expect(first(scheduled(`    let o = search Customer group by category`))).toContain("MYNT1057 Cannot group by 'category': a multiselect holds several values");
    expect(first(scheduled(`    let o = search SalesOrder\n        group`))).toContain("MYNT0001 Expected 'by' after 'group'");
    expect(first(scheduled(`    let o = search SalesOrder\n        group by`))).toContain("MYNT0001 Expected a field to group by after 'group by'");
    expect(first(scheduled(`    let o = query SalesOrder group by entity`))).toContain("MYNT1031 'group by' is a search clause");
    // `group`, `by`, and the aggregate names are contextual.
    expect(messages(scheduled(`    let group = "x"\n    let sum = group\n    let count = sum\n    log.debug(count)`))).toEqual([]);
  });
});

describe("grouping validation", () => {
  it("MYNT1061 a selected field that is not grouped, with both fixes; grouping it is valid", () => {
    expect(first(scheduled(`    let o = search SalesOrder\n        group by entity\n        select entity, memo, total = sum(amount)`))).toBe(
      "MYNT1061 'memo' must appear in 'group by' or be used inside an aggregate: a summary row has one value per group, and 'memo' varies within one. Group by it ('group by entity, memo') or aggregate it ('memo = max(memo)')",
    );
    expect(first(scheduled(`    let o = search SalesOrder\n        group by entity\n        select subsidiary, total = sum(amount)`))).toContain("MYNT1061 'subsidiary' must appear in 'group by'");
    expect(messages(scheduled(`    let o = search SalesOrder\n        group by entity, memo\n        select entity, memo, total = sum(amount)`))).toEqual([]);
    // An aggregate alone needs no group by: one bucket.
    expect(messages(scheduled(`    let o = search SalesOrder select total = sum(amount)`))).toEqual([]);
    // A grouped field need not be selected: it is a backend-only group column.
    expect(call(scheduled(`    let o = search SalesOrder group by entity select total = sum(amount)`))).toBe(
      'mynt$search(search.Type.SALES_ORDER, [{ name: "entity", summary: "GROUP", hidden: true }, { name: "amount", summary: "SUM", alias: "total" }], [])',
    );
  });
});

describe("aggregates", () => {
  it("the type matrix: sum/avg take numbers, min/max numbers, dates, or strings, count anything or nothing", () => {
    const type = (item: string) => {
      const result = compileRefs(scheduled(`    let o = search SalesOrder select ${item}`));
      const declaration = result.unit!.kind === "Scheduled" ? result.unit!.entryPoint.body[0]! : undefined;
      const query = (declaration as { initializer?: { type?: { element?: { fields?: { type: string }[] } } } } | undefined)?.initializer?.type?.element;
      return result.diagnostics.map((d) => d.message)[0] ?? query?.fields?.[0]?.type;
    };
    expect(type("x = sum(amount)")).toBe("Number");
    expect(type("x = avg(amount)")).toBe("Number");
    expect(type("x = min(amount)")).toBe("Number");
    expect(type("x = max(trandate)")).toBe("Date");
    expect(type("x = min(memo)")).toBe("Text");
    expect(type("x = count(entity)")).toBe("Number");
    expect(type("x = count(id)")).toBe("Number");
    expect(type("x = count()")).toBe("Number");
    expect(type("x = sum(entity)")).toBe("'sum' takes a number field; 'entity' is a select field. Count it instead: 'x = count(entity)'");
    expect(type("x = avg(memo)")).toBe("'avg' takes a number field; 'memo' is a string field");
    expect(type("x = sum(mainline)")).toContain("'mainline' is a boolean field. Count it instead");
    expect(type("x = max(entity)")).toBe("'max' takes a number, date, or string field; 'entity' is a select field. Count it instead: 'x = count(entity)'");
    expect(type("x = sum(id)")).toBe("'id' is row identity, not a field; only 'count(id)' (or 'count()') uses it, to count rows");
    expect(type("x = sum()")).toBe("'sum' needs a field to aggregate, like 'sum(amount)'");
    expect(type("x = median(amount)")).toBe("'median' is not an aggregate; 'select' aggregates with sum, count, min, max, and avg");
  });

  it("an aggregate needs a name, a field takes none, and arbitrary expressions are not select items", () => {
    expect(first(scheduled(`    let o = search SalesOrder select sum(amount)`))).toBe("MYNT1062 An aggregate needs a result name: write 'total = sum(amount)' and read it as that name on the row");
    expect(first(scheduled(`    let o = search SalesOrder select n = count(id), count()`))).toContain("MYNT1062 An aggregate needs a result name: write 'count = count()'");
    expect(first(scheduled(`    let o = search SalesOrder select e = entity`))).toBe(
      "MYNT1063 Only an aggregate takes a result name; a field is selected under its own name. Write 'select entity', or an aggregate like 'e = sum(entity)'",
    );
    expect(first(scheduled(`    let o = search SalesOrder select x = amount * 2`))).toContain("MYNT0001");
    expect(first(scheduled(`    let o = search SalesOrder select x = 2`))).toContain("MYNT0001 Expected an aggregate after 'x =', like 'x = sum(amount)'");
    expect(first(scheduled(`    let o = search SalesOrder\n        select total = sum(\n    log.debug("next")`))).toContain("MYNT0001 Expected ')' to close 'sum('");
    expect(first(scheduled(`    let o = search SalesOrder select total = sum(1)`))).toContain("MYNT0001 Expected a field inside 'sum(...)', like 'sum(amount)'");
    expect(first(scheduled(`    let o = query SalesOrder select total = sum(amount)`))).toContain("MYNT1031 'select' is a search clause");
  });

  it("count counts rows with count() or count(id), both as COUNT of internalid, and values with count(field)", () => {
    expect(call(scheduled(`    let o = search SalesOrder select n = count()`))).toBe('mynt$search(search.Type.SALES_ORDER, [{ name: "internalid", summary: "COUNT", alias: "n" }], [])');
    expect(call(scheduled(`    let o = search SalesOrder select n = count(id)`))).toBe('mynt$search(search.Type.SALES_ORDER, [{ name: "internalid", summary: "COUNT", alias: "n" }], [])');
    expect(call(scheduled(`    let o = search SalesOrder select n = count(memo)`))).toBe('mynt$search(search.Type.SALES_ORDER, [{ name: "memo", summary: "COUNT", alias: "n" }], [])');
    expect(logged(scheduled(`    for row in search SalesOrder\n        group by subsidiary\n        select subsidiary, count = count(id)\n        order by subsidiary {\n        log.debug(row.subsidiary.text)\n        if row.count === 2 {\n            log.debug("two")\n        }\n        if row.count === 3 {\n            log.debug("three")\n        }\n    }`))).toEqual(["Parent Company", "two", "Nordic AB", "three"]);
  });

  it("aggregates over a one-hop join are summary columns with the join; grouped joined fields keep the nested row shape", () => {
    expect(call(scheduled(`    let o = search SalesOrder group by entity select entity, n = count(entity.email)`))).toBe(
      'mynt$search(search.Type.SALES_ORDER, [{ name: "entity", summary: "GROUP" }, { name: "email", join: "entity", field: "entity", summary: "COUNT", alias: "n" }], ["entity"])',
    );
    const joined = scheduled(`    for row in search SalesOrder\n        group by entity.email\n        select entity.email, total = sum(amount)\n        order by entity.email {\n        log.debug(row.entity.email)\n        if row.total === 55 {\n            log.debug("fifty-five")\n        }\n    }`);
    expect(call(joined)).toBe('mynt$search(search.Type.SALES_ORDER, [{ name: "email", join: "entity", field: "entity", summary: "GROUP", sort: "ASC" }, { name: "amount", summary: "SUM", alias: "total" }], [])');
    expect(logged(joined)).toEqual(["a@x.com", "fifty-five", "b@x.com", "c@x.com"]);
    // Only the grouped joined field exists under the relationship; its own id and text were not grouped.
    expect(first(scheduled(`    for row in search SalesOrder group by entity.email select entity.email, total = sum(amount) {\n        log.debug(row.entity.id)\n    }`))).toBe(
      "MYNT1050 'entity' is not part of this summary: a summary row of SalesOrder exposes only its grouped fields and aggregates, entity.email, total. Group by 'entity' or aggregate it in 'select'",
    );
    expect(first(scheduled(`    for row in search SalesOrder group by entity.email select entity.email, total = sum(amount) {\n        log.debug(row.entity.comments)\n    }`))).toContain("MYNT1050 'entity.comments' is not part of this summary");
    expect(first(scheduled(`    let o = search SalesOrder group by entity.subsidiary.name`))).toContain("MYNT1053");
  });
});

describe("result names", () => {
  it("one flat namespace: no alias twice, no alias over a selected field, and a result name is never a source name", () => {
    expect(first(scheduled(`    let o = search SalesOrder select total = sum(amount), total = max(amount)`))).toBe(
      "MYNT1063 'total' is already the name of an aggregate of this search (column 38); a row member means one thing. Give the aggregate another name",
    );
    // An alias over a selected field is always also a result name in a source position (the field must be grouped), so that rule reports it.
    expect(first(scheduled(`    let o = search SalesOrder group by memo select memo, memo = count(amount)`))).toContain("MYNT1063 'memo' is both a field of SalesOrder and a result name of this search");
    expect(first(scheduled(`    let o = search SalesOrder group by memo select memo = count(amount), memo`))).toContain("MYNT1063 'memo' is both a field of SalesOrder and a result name of this search");
    expect(messages(scheduled(`    let o = search SalesOrder group by memo select n = count(amount), memo`))).toEqual([]);
    expect(first(scheduled(`    let o = search SalesOrder group by amount select amount, amount = sum(amount)`))).toContain("MYNT1063 'amount' is both a field of SalesOrder and a result name of this search");
    // Aliases are output names: not in where, group by, or an aggregate's argument.
    expect(first(scheduled(`    let o = search SalesOrder where big > 10000 select big = sum(amount)`))).toBe(
      "MYNT1063 'big' is a result name of this search's 'select' (line 2), not a field of SalesOrder: 'where' filters source rows before they are aggregated, and 'group by' and aggregates read source fields. There is no 'having' yet",
    );
    expect(first(scheduled(`    let o = search SalesOrder where total > 10000 select total = sum(amount)`))).toBe(
      "MYNT1063 'total' is both a field of SalesOrder and a result name of this search (line 2); in 'where', 'group by', and an aggregate a bare name is the source field. Rename the result to make this unambiguous",
    );
    expect(first(scheduled(`    let o = search SalesOrder select total = sum(amount), doubled = sum(total)`))).toContain("MYNT1063 'total' is both a field of SalesOrder and a result name");
    expect(first(scheduled(`    let o = search SalesOrder select big = sum(amount), doubled = sum(big)`))).toContain("MYNT1063 'big' is a result name of this search's 'select'");
    expect(first(scheduled(`    let o = search SalesOrder group by big select big = sum(amount)`))).toContain("MYNT1063 'big' is a result name");
    // An alias that is also a field name is fine when the field is not used as a source in that search.
    expect(messages(scheduled(`    let o = search SalesOrder select total = sum(amount)`))).toEqual([]);
  });

  it("order by resolves aliases and grouped fields, and refuses everything else", () => {
    expect(first(scheduled(`    let o = search SalesOrder group by entity select entity, total = sum(amount) order by memo`))).toBe(
      "MYNT1057 Cannot sort by 'memo': a summary search orders by its result fields, entity, total; 'memo' is neither grouped nor aggregated",
    );
    expect(first(scheduled(`    let o = search SalesOrder group by subsidiary select subsidiary, n = count() order by subsidiary.name`))).toContain("MYNT1057 Cannot sort by 'subsidiary.name'");
    expect(logged(scheduled(`    for row in search SalesOrder\n        group by entity\n        select entity, total = sum(amount)\n        order by entity asc {\n        log.debug(row.entity.text)\n    }`))).toEqual(["Acme", "Beta", "Gamma"]);
    // A grouped field that is not selected may still order: it is a group column either way.
    expect(call(scheduled(`    let o = search SalesOrder group by entity select total = sum(amount) order by entity desc`))).toBe(
      'mynt$search(search.Type.SALES_ORDER, [{ name: "entity", summary: "GROUP", sort: "DESC", hidden: true }, { name: "amount", summary: "SUM", alias: "total" }], [])',
    );
    // One SUM(amount) column carries the sort; never a second one.
    expect(call(scheduled(`    let o = search SalesOrder select total = sum(amount) order by total desc`))).toBe(
      'mynt$search(search.Type.SALES_ORDER, [{ name: "amount", summary: "SUM", alias: "total", sort: "DESC" }], [])',
    );
  });
});

describe("summary rows", () => {
  it("expose exactly the result fields and no id; a grouped select field keeps id and text", () => {
    expect(first(scheduled(`    for row in search SalesOrder group by entity select entity, total = sum(amount) {\n        log.debug(row.id)\n    }`))).toBe(
      "MYNT1011 A summary row is an aggregate bucket, not a SalesOrder record, so it has no 'id'. It exposes entity, total; a grouped select field carries the id of what it refers to, like 'row.entity.id'",
    );
    expect(first(scheduled(`    for row in search SalesOrder select total = sum(amount) {\n        log.debug(row.id)\n    }`))).toBe(
      "MYNT1011 A summary row is an aggregate bucket, not a SalesOrder record, so it has no 'id'. It exposes total",
    );
    expect(first(scheduled(`    for row in search SalesOrder group by entity select entity, total = sum(amount) {\n        log.debug(row.memo)\n    }`))).toBe(
      "MYNT1050 'memo' is not part of this summary: a summary row of SalesOrder exposes only its grouped fields and aggregates, entity, total. Group by 'memo' or aggregate it in 'select'",
    );
    expect(first(scheduled(`    for row in search SalesOrder group by entity select entity, total = sum(amount) {\n        log.debug(row.totl)\n    }`))).toBe(
      "MYNT1050 A summary row of SalesOrder has no member 'totl'; it exposes entity, total. Did you mean 'total'?",
    );
    expect(first(scheduled(`    for row in search SalesOrder group by entity select entity, total = sum(amount) {\n        save row\n    }`))).toContain("MYNT1019");
    expect(first(scheduled(`    for row in search SalesOrder group by entity select entity, total = sum(amount) {\n        row.total = 1\n    }`))).toContain("MYNT1009");
    // The emitted row holds no id, and the grouped reference is normalized to { id, text } through the Column object.
    const js = output(TOTALS);
    expect(js).toContain('const row = columns.some((spec) => typeof spec !== "string" && spec.summary) ? {} : { id: result.id };');
    expect(js).toContain("if (spec.alias) {");
    expect(js).toContain("if (typeof spec !== \"string\" && spec.summary) options.summary = search.Summary[spec.summary];");
  });

  it("limit bounds the summary rows and first returns one optional summary row that or resolves as usual", () => {
    expect(logged(scheduled(`    for row in search SalesOrder\n        group by entity\n        select entity, total = sum(amount)\n        order by total desc\n        limit 2 {\n        log.debug(row.entity.text)\n    }`))).toEqual(["Acme", "Gamma"]);
    const top = scheduled(`    let top = search SalesOrder\n        group by entity\n        select entity, total = sum(amount)\n        order by total desc\n        first\n        or return\n    log.debug(top.entity.text)`);
    expect(call(top)).toBe('mynt$search(search.Type.SALES_ORDER, [{ name: "amount", summary: "SUM", alias: "total", sort: "DESC" }, { name: "entity", summary: "GROUP" }], ["entity"], undefined, undefined, true)');
    expect(output(top)).toContain("const top$maybe = mynt$search(");
    expect(logged(top)).toEqual(["Acme"]);
    expect(hover(scheduled(`    let t§op = search SalesOrder group by entity select entity, total = sum(amount) first`))).toContain("top: Summary<SalesOrder>?\n```\n\nlocal · Summary<SalesOrder>? (the first summary row of a search, or none");
    expect(hover(top.replace("log.debug(top", "log.debug(t§op"))).toContain("top: Summary<SalesOrder>\n```\n\nlocal · summary row of SalesOrder, read-only: entity: Ref<Customer>, total: number (sum of amount)");
    expect(messages(scheduled(`    let top = search SalesOrder group by entity select entity, total = sum(amount) first\n    if top {\n        log.debug(top.entity.text)\n    }\n    log.debug(top.entity.text)`))).toEqual([
      "MYNT1058 'top' may be absent: a search with 'first' returns one Summary<SalesOrder> row or none. Resolve it where it is declared, 'let top = ... or return' (or 'or { ... return }'), or test for presence with 'if top { ... }' before reading '.entity'",
    ]);
    expect(first(scheduled(`    let top = search SalesOrder select total = sum(amount) first limit 2`))).toContain("MYNT1057 A search cannot use both 'first' and 'limit'");
  });

  it("an ungrouped aggregate over no rows is one row of empty aggregates, so first is present and count is 0 (NetSuite assumption, pinned by the fake)", () => {
    expect(logged(scheduled(`    let overall = search SalesOrder\n        where memo === "nope"\n        select n = count(), total = sum(amount)\n        first\n        or {\n            log.debug("absent")\n            return\n        }\n    if overall.n === 0 {\n        log.debug("zero")\n    }`))).toEqual(["zero"]);
    expect(logged(scheduled(`    let top = search SalesOrder\n        where memo === "nope"\n        group by entity\n        select entity, n = count()\n        first\n        or {\n            log.debug("absent")\n            return\n        }\n    log.debug("present")`))).toEqual(["absent"]);
  });

  it("try/catch and a thrown search error need nothing summary-specific", () => {
    const netsuite = seeded();
    netsuite.search.failWith = "Invalid summary";
    expect(logged(scheduled(`    try {\n        for row in search SalesOrder group by entity select entity, total = sum(amount) {\n            log.debug(row.entity.text)\n        }\n    } catch err {\n        log.error(err.name)\n    }`), netsuite)).toEqual(["SSS_INVALID_SRCH_FILTER"]);
  });
});

describe("saved searches", () => {
  it("a Mynt summary over a saved search keeps its filters and type and replaces its columns; its own summary columns are refused at runtime", () => {
    const over = scheduled(`    for row in load Search("customsearch_open_orders")\n        group by entity\n        select entity, total = sum(amount)\n        order by total desc {\n        log.debug(row.entity.text)\n    }`);
    expect(call(over)).toBe(
      'mynt$savedSearch([search.Type.SALES_ORDER, "transaction"], "customsearch_open_orders", [{ name: "amount", summary: "SUM", alias: "total", sort: "DESC" }, { name: "entity", summary: "GROUP" }], ["entity"])',
    );
    const netsuite = run(output(over));
    expect(netsuite.search.runs[0]!.columns).toEqual(["SUM(amount)", "GROUP(entity)"]);
    expect(netsuite.search.runs[0]!.filters).toEqual([["memo", "isnot", "fourth"]]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["Acme", "Gamma", "Beta"]);
    expect(netsuite.search.savedDefinition("customsearch_open_orders")!.columns).toEqual([{ name: "memo" }, { name: "total" }]);
    expect(() => logged(scheduled(`    for row in load Search("customsearch_totals") group by entity select entity, total = sum(amount) {\n        log.debug(row.entity.text)\n    }`))).toThrow(
      "Mynt: saved search customsearch_totals already has summary columns; a Mynt 'group by' or aggregate cannot be combined with its own summary",
    );
  });
});

describe("editor", () => {
  it("completes group by fields, aggregates and their fields in select, result names in order by, and summary row members", () => {
    expect(site(scheduled(`    let o = search SalesOrder\n        group by §`))).toBe("groupField");
    expect(labels(scheduled(`    let o = search SalesOrder\n        group by §`))).toEqual(["memo", "total", "entity", "amount", "mainline", "trandate", "subsidiary"]);
    expect(labels(scheduled(`    let o = search SalesOrder\n        group by entity, §`))).toEqual(["memo", "total", "amount", "mainline", "trandate", "subsidiary"]);
    expect(labels(scheduled(`    let o = search Customer\n        group by §`))).not.toContain("category");
    expect(labels(scheduled(`    let o = search SalesOrder\n        select entity, §`)).slice(-5)).toEqual(["sum(...)", "count(...)", "min(...)", "max(...)", "avg(...)"]);
    expect(site(scheduled(`    let o = search SalesOrder\n        select total = §`))).toBe("aggregate");
    expect(labels(scheduled(`    let o = search SalesOrder\n        select total = §`))).toEqual(["sum", "count", "min", "max", "avg"]);
    expect(labels(scheduled(`    let o = search SalesOrder\n        select total = sum(§`))).toEqual(["total", "amount"]);
    expect(labels(scheduled(`    let o = search SalesOrder\n        select latest = max(§`))).toEqual(["memo", "total", "amount", "trandate"]);
    expect(labels(scheduled(`    let o = search SalesOrder\n        select entity, total = sum(amount)\n        group by entity\n        order by §`))).toEqual(["entity", "total"]);
    expect(labels(scheduled(`    let o = search SalesOrder\n        order by §`))).toContain("memo");
    expect(labels(scheduled(`    let o = search SalesOrder\n        §`))).toContain("group by");
    expect(labels(scheduled(`    for row in search SalesOrder group by entity select entity, total = sum(amount) {\n        log.debug(row.§)\n    }`))).toEqual(["entity", "total"]);
    expect(labels(scheduled(`    for row in search SalesOrder group by entity.email select entity.email, total = sum(amount) {\n        log.debug(row.entity.§)\n    }`))).toEqual(["email"]);
  });

  it("hovers aliases, aggregates, and the search; tokens mark group/by as keywords, aggregates as builtins, aliases as properties", () => {
    expect(hover(TOTALS.replace("total = sum", "to§tal = sum"))).toBe("```mynt\ntotal: number\n```\n\nsum of amount · result field of the summary row, read-only; not a NetSuite field");
    expect(hover(TOTALS.replace("= sum(", "= s§um("))).toContain("aggregate · the sum of a number field over each group · `search.Summary.SUM`");
    expect(hover(TOTALS.replace("order by total", "order by to§tal"))).toContain("sum of amount · result field of the summary row, read-only; not a NetSuite field · sorts the summary by this aggregate");
    expect(hover(TOTALS.replace("row.total ===", "row.to§tal ==="))).toContain("total: number");
    expect(hover(TOTALS.replace("row.entity.text", "row.en§tity.text"))).toContain("SalesOrder.entity");
    expect(hover(TOTALS.replace("let totals = sea§rch", "let totals = sea§rch").replace("let totals = search", "let totals = sea§rch"))).toContain(
      "of aggregate buckets, with the grouped fields and aggregates (no `id`) · grouped by entity · selects entity, total = sum(amount) · ordered by total desc",
    );
    const text = scheduled(`    let sum = 1\n    let o = search SalesOrder\n        group by entity\n        select entity, total = sum(amount), n = count()\n        order by total desc`);
    expect(tokens(text).filter((t) => /^(sum|group|by|total|count|n|entity|amount):/.test(t))).toEqual([
      "sum:variable+declaration",
      "group:keyword",
      "by:keyword",
      "entity:property",
      "entity:property",
      "total:property+declaration+readonly",
      "sum:function+defaultLibrary",
      "amount:property+readonly",
      "n:property+declaration+readonly",
      "count:function+defaultLibrary",
      "by:keyword",
      "total:property+readonly",
    ]);
  });

  it("an alias is a symbol: references find its declaration, sort key, and row reads; rename is refused with a reason", () => {
    const { doc, offset } = at(TOTALS.replace("total = sum", "to§tal = sum"));
    const symbol = symbolAt(doc, offset)!;
    expect(symbol.kind).toBe("resultField");
    expect(referencesOf(doc, symbol).map((r) => [r.span.start.line, r.isDeclaration])).toEqual([[5, true], [6, false], [10, false]]);
    expect(renameRefusal(symbol)).toContain("'total' is a result name of a search");
    expect(symbolAt(at(TOTALS.replace("order by total", "order by to§tal")).doc, at(TOTALS.replace("order by total", "order by to§tal")).offset)?.kind).toBe("resultField");
  });
});

describe("the example", () => {
  it("compiles against the reference schema and runs: totals per customer, then one overall row", () => {
    const result = compile(EXAMPLE, { file: "examples/search-totals.mn", schema: referenceSchema });
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toMatchSnapshot();
    const netsuite = run(result.output!);
    expect(netsuite.search.runs.map((r) => r.columns)).toEqual([["SUM(amount)", "GROUP(entity)"], ["COUNT(internalid)", "SUM(amount)"]]);
    expect(netsuite.log.calls.map((c) => c.details)).toEqual(["Acme", "Gamma", "Beta"]);
  });
});
