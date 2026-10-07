import { describe, expect, it } from "vitest";
import { LineIndex } from "../src/lsp/position.js";
import { ProjectRegistry } from "../src/lsp/project.js";
import { encodeSemanticTokens, SEMANTIC_TOKENS_LEGEND, TOKEN_MODIFIERS, TOKEN_TYPES } from "../src/lsp/semantic-tokens.js";
import { SailLanguageService } from "../src/lsp/service.js";
import { signatureHelpAt } from "../src/lsp/signature-help.js";
import { analyze } from "../src/semantic/query.js";
import { semanticTokens } from "../src/semantic/tokens.js";
import { schema } from "./helpers.js";

/** `name:kind[+mod...]` for every token, in order, for readable assertions. */
function tokens(text: string): string[] {
  const doc = analyze(text, "t.sail", schema);
  return semanticTokens(doc).map((t) => {
    const name = text.slice(t.span.start.offset, t.span.end.offset);
    return `${name}:${t.kind}${t.modifiers.map((m) => `+${m}`).join("")}`;
  });
}

/** The token at the Nth occurrence of `name`. */
function tokenAt(text: string, name: string, occurrence = 0): string | undefined {
  const doc = analyze(text, "t.sail", schema);
  let offset = -1;
  for (let i = 0; i <= occurrence; i++) offset = text.indexOf(name, offset + 1);
  const token = semanticTokens(doc).find((t) => t.span.start.offset === offset);
  return token && `${token.kind}${token.modifiers.map((m) => `+${m}`).join("")}`;
}

function help(source: string) {
  const offset = source.indexOf("§");
  const text = source.slice(0, offset) + source.slice(offset + 1);
  const result = signatureHelpAt(analyze(text, "t.sail", schema), offset);
  if (!result) return undefined;
  const active = result.signature.parameters[result.activeParameter];
  return `${result.signature.label} @${result.activeParameter}${active ? ` [${active.label}]` : ""}`;
}

describe("semantic tokens: declarations and references", () => {
  it("classifies the user event example as the compiler sees it", () => {
    expect(tokens(`beforeSubmit edit (customer: Customer) {\n    let other = load Customer("123")\n    other.comments = customer.email\n    log.debug(other.email)\n}\n`)).toEqual([
      "beforeSubmit:keyword",
      "edit:enumMember",
      "customer:parameter+declaration",
      "Customer:type",
      "let:keyword",
      "other:variable+declaration",
      "load:function+defaultLibrary",
      "Customer:type",
      '"123":string',
      "other:variable",
      "comments:property+modification",
      "customer:parameter",
      "email:property",
      "log:namespace+defaultLibrary",
      "debug:method+defaultLibrary",
      "other:variable",
      "email:property",
    ]);
  });

  it("functions: declaration, parameters, signature types, calls, and return", () => {
    expect(tokens(`fn review(customer: Customer, note: Text) -> Bool {\n    return customer.email == note\n}\nscheduled {\n    let c = load Customer("1")\n    if review(c, "x") { }\n}\n`)).toEqual([
      "fn:keyword",
      "review:function+declaration",
      "customer:parameter+declaration",
      "Customer:type",
      "note:parameter+declaration",
      "Text:type",
      "Bool:type",
      "return:keyword",
      "customer:parameter",
      "email:property",
      "note:parameter",
      "scheduled:keyword",
      "let:keyword",
      "c:variable+declaration",
      "load:function+defaultLibrary",
      "Customer:type",
      '"1":string',
      "if:keyword",
      "review:function",
      "c:variable",
      '"x":string',
    ]);
  });

  it("loop variables are variables, and record types are types everywhere", () => {
    const text = `scheduled {\n    for row in query Customer\n        where email != "" {\n        let c = load Customer(row.id)\n        let d = create Customer\n        let e = copy Customer("2")\n        let i = transform SalesOrder("3") to Invoice\n        save c\n        save d\n        save e\n        save i\n    }\n}\n`;
    const all = tokens(text);
    expect(all.filter((t) => t.endsWith(":type"))).toEqual(["Customer:type", "Customer:type", "Customer:type", "Customer:type", "SalesOrder:type", "Invoice:type"]);
    expect(all.slice(0, 8)).toEqual(["scheduled:keyword", "for:keyword", "row:variable+declaration", "in:keyword", "query:keyword", "Customer:type", "where:keyword", "email:property"]);
    expect(tokenAt(text, "row.id")).toBe("variable");
    expect(tokenAt(text, "id)")).toBe("property+readonly");
    expect(all).toContain("to:keyword");
    expect(all.filter((t) => t.startsWith("copy") || t.startsWith("transform") || t.startsWith("create"))).toEqual([
      "create:function+defaultLibrary",
      "copy:function+defaultLibrary",
      "transform:function+defaultLibrary",
    ]);
  });
});

describe("semantic tokens: schema symbols and contextual words", () => {
  it("fields, read-only fields, sublists, line fields, and add initializers", () => {
    const text = `scheduled {\n    let order = load SalesOrder("1")\n    log.debug(order.memo)\n    if order.total > 1 { }\n    for line in order.item {\n        line.quantity = line.rate\n        if line.amount > 1 {\n            remove line\n        }\n    }\n    add order.item {\n        quantity = 2\n    }\n    delete order\n}\n`;
    expect(tokenAt(text, "memo)")).toBe("property");
    expect(tokenAt(text, "total")).toBe("property+readonly");
    expect(tokenAt(text, "item {")).toBe("property");
    expect(tokenAt(text, "item {", 1)).toBe("property");
    expect(tokenAt(text, "quantity = line")).toBe("property+modification");
    expect(tokenAt(text, "rate")).toBe("property+readonly".replace("+readonly", ""));
    expect(tokenAt(text, "amount")).toBe("property+readonly");
    expect(tokenAt(text, "line in")).toBe("variable+declaration");
    expect(tokenAt(text, "remove")).toBe("keyword");
    expect(tokenAt(text, "line\n        }")).toBe("variable");
    expect(tokenAt(text, "quantity = 2")).toBe("property+modification");
    expect(tokenAt(text, "delete")).toBe("keyword");
    expect(tokenAt(text, "order\n}")).toBe("variable");
  });

  it("contextual words are keywords only where they are keywords", () => {
    const text = `scheduled {\n    let where = "x"\n    let query = where\n    let c = query Customer\n        where email == query\n    for row in c { }\n    save.y = "z"\n}\n`;
    expect(tokenAt(text, "where = ")).toBe("variable+declaration");
    expect(tokenAt(text, "where\n")).toBe("variable");
    expect(tokenAt(text, "query = ")).toBe("variable+declaration");
    expect(tokenAt(text, "query Customer")).toBe("keyword");
    expect(tokenAt(text, "where email")).toBe("keyword");
    expect(tokenAt(text, "query\n")).toBe("variable");
    expect(tokenAt(text, "email ==")).toBe("property");
    expect(tokenAt(text, "for")).toBe("keyword");
    expect(tokenAt(text, "in c")).toBe("keyword");
    expect(tokenAt(text, "save.y")).toBeUndefined(); // an unbound assignment to a local member: nothing semantic here
    expect(tokens(`scheduled {\n    let x = true\n    if !x { }\n}\n`)).toEqual(["scheduled:keyword", "let:keyword", "x:variable+declaration", "true:keyword", "if:keyword", "x:variable"]);
  });

  it("statement keywords, else, and numbers", () => {
    expect(tokens(`scheduled {\n    let n = 2\n    if n > 1 {\n        log.debug("big")\n    } else {\n        log.debug("small")\n    }\n}\n`)).toEqual([
      "scheduled:keyword", "let:keyword", "n:variable+declaration", "2:number", "if:keyword", "n:variable", "1:number",
      "log:namespace+defaultLibrary", "debug:method+defaultLibrary", '"big":string', "else:keyword",
      "log:namespace+defaultLibrary", "debug:method+defaultLibrary", '"small":string',
    ]);
  });
});

describe("semantic tokens: protocol", () => {
  it("encodes sorted, non-overlapping tokens with relative UTF-16 positions", () => {
    const text = `scheduled {\n    log.debug("😀 hi")\n    let c = load Customer("1")\n    save c\n}\n`;
    const doc = analyze(text, "t.sail", schema);
    const data = encodeSemanticTokens(doc, new LineIndex(text));
    expect(data.length % 5).toBe(0);
    const rows: number[][] = [];
    for (let i = 0; i < data.length; i += 5) rows.push(data.slice(i, i + 5));
    expect(rows[0]).toEqual([0, 0, 9, TOKEN_TYPES.indexOf("keyword"), 0]);
    expect(rows[1]).toEqual([1, 4, 3, TOKEN_TYPES.indexOf("namespace"), 1 << TOKEN_MODIFIERS.indexOf("defaultLibrary")]);
    expect(rows[2]).toEqual([0, 4, 5, TOKEN_TYPES.indexOf("method"), 1 << TOKEN_MODIFIERS.indexOf("defaultLibrary")]);
    expect(rows[3]).toEqual([0, 6, 7, TOKEN_TYPES.indexOf("string"), 0]); // "😀 hi" is 7 UTF-16 units including quotes
    expect(rows[4]).toEqual([1, 4, 3, TOKEN_TYPES.indexOf("keyword"), 0]);
    const starts = semanticTokens(doc).map((t) => t.span.start.offset);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    const spans = semanticTokens(doc).map((t) => t.span);
    for (let i = 1; i < spans.length; i++) expect(spans[i]!.start.offset).toBeGreaterThanOrEqual(spans[i - 1]!.end.offset);
    expect(SEMANTIC_TOKENS_LEGEND.tokenTypes).toContain("property");
  });

  it("is served by the language service", () => {
    const svc = new SailLanguageService(new ProjectRegistry(() => schema));
    svc.open("untitled:t.sail", `scheduled {\n    let c = create Customer\n    save c\n}\n`, 1);
    expect(svc.semanticTokens("untitled:t.sail").data.length).toBe(7 * 5);
  });
});

describe("signature help", () => {
  const FN = `fn calculate(value: Number, multiplier: Number) -> Number {\n    return value\n}\n`;

  it("shows user functions with the active parameter", () => {
    expect(help(`${FN}scheduled {\n    let r = calculate(§)\n}\n`)).toBe("fn calculate(value: Number, multiplier: Number) -> Number @0 [value: Number]");
    expect(help(`${FN}scheduled {\n    let r = calculate(10, §)\n}\n`)).toBe("fn calculate(value: Number, multiplier: Number) -> Number @1 [multiplier: Number]");
    expect(help(`${FN}scheduled {\n    let r = calculate(10, 2§0)\n}\n`)).toContain("@1");
  });

  it("shows built-ins, namespace members, and record operations specialized to the written type", () => {
    expect(help(`scheduled {\n    let c = load Customer(§)\n}\n`)).toBe("load Customer(id: Text) -> Customer @0 [id: Text]");
    expect(help(`scheduled {\n    let c = copy SalesOrder("1"§)\n}\n`)).toBe("copy SalesOrder(id: Text) -> SalesOrder @0 [id: Text]");
    expect(help(`scheduled {\n    let i = transform SalesOrder(§) to Invoice\n}\n`)).toBe("transform SalesOrder(id: Text) to U -> U @0 [id: Text]");
    expect(help(`scheduled {\n    log.debug(§)\n}\n`)).toBe("log.debug(message: Text) -> Void @0 [message: Text]");
    expect(help(`scheduled {\n    let c = load Nope(§)\n}\n`)).toBe("load T(id: Text) -> T @0 [id: Text]");
  });

  it("selects the innermost call and survives incomplete and over-long argument lists", () => {
    expect(help(`${FN}scheduled {\n    let r = calculate(calculate(1, §), 2)\n}\n`)).toContain("@1");
    expect(help(`${FN}scheduled {\n    let r = calculate(calculate(1, 2), §)\n}\n`)).toContain("@1");
    expect(help(`${FN}scheduled {\n    let r = calculate(§`)).toContain("@0");
    expect(help(`${FN}scheduled {\n    let r = calculate(1,§`)).toContain("@1");
    expect(help(`scheduled {\n    log.debug(§`)).toContain("log.debug");
    expect(help(`scheduled {\n    let c = load Customer(§`)).toContain("load Customer");
    expect(help(`${FN}scheduled {\n    let r = calculate(1, 2, 3, §)\n}\n`)).toBe("fn calculate(value: Number, multiplier: Number) -> Number @3");
  });

  it("gives nothing outside a call, inside a string, or for an unknown callee", () => {
    expect(help(`${FN}scheduled {\n    let r = §calculate(1, 2)\n}\n`)).toBeUndefined();
    expect(help(`${FN}scheduled {\n    let r = calculate(1, 2)§\n}\n`)).toBeUndefined();
    expect(help(`scheduled {\n    log.debug("he§llo")\n}\n`)).toBeUndefined();
    expect(help(`scheduled {\n    nope(§)\n}\n`)).toBeUndefined();
    expect(help(`scheduled {\n    let c = load Customer("1")\n    if (c.email == §"") { }\n}\n`)).toBeUndefined();
  });

  it("is served by the language service with LSP parameter ranges", () => {
    const svc = new SailLanguageService(new ProjectRegistry(() => schema));
    const text = `${FN}scheduled {\n    let r = calculate(10, )\n}\n`;
    svc.open("untitled:t.sail", text, 1);
    const lines = new LineIndex(text);
    const result = svc.signatureHelp("untitled:t.sail", lines.positionAt(text.indexOf("10, ") + 4))!;
    expect(result.activeParameter).toBe(1);
    expect(result.signatures[0]!.parameters.map((p) => p.label)).toEqual([[13, 26], [28, 46]]);
    expect(result.signatures[0]!.label.slice(13, 26)).toBe("value: Number");
    expect(svc.signatureHelp("untitled:t.sail", { line: 0, character: 0 })).toBeNull();
  });
});
