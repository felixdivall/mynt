import { describe, expect, it } from "vitest";
import { completionsAt } from "../src/lsp/completion.js";
import { hoverAt } from "../src/lsp/hover.js";
import { signatureHelpAt } from "../src/lsp/signature-help.js";
import { analyze } from "../src/semantic/query.js";
import { semanticTokens } from "../src/semantic/tokens.js";
import { compileMynt, errorCodes, schema } from "./helpers.js";

/**
 * The builtin types are spelled `string`, `number`, `boolean` in source and
 * everywhere the editor shows a type, and are reserved names. Internally the
 * field types keep the snapshot's `Text`/`Number`/`Bool`; nothing here
 * depends on that.
 */

function at(source: string) {
  const offset = source.indexOf("§");
  const text = source.replace("§", "");
  return { doc: analyze(text, "t.mn", schema), offset, text };
}
const messages = (source: string) => compileMynt(source).diagnostics.map((d) => `${d.code} ${d.message}`);
const tokens = (text: string) => semanticTokens(analyze(text, "t.mn", schema)).map((t) => `${text.slice(t.span.start.offset, t.span.end.offset)}:${t.kind}${t.modifiers.map((m) => `+${m}`).join("")}`);

describe("primitive types: source spelling", () => {
  it("accepts string, number, and boolean in parameter and return positions", () => {
    expect(messages(`fn foo(value: string): boolean {\n    return true\n}\nfn calculate(value: number): number {\n    return value\n}\nscheduled {\n    let ok = foo("x")\n}\n`)).toEqual([]);
  });

  it("rejects the old spellings as unknown types, without aliasing", () => {
    expect(messages(`fn f(x: Text) { }\nscheduled { }\n`)).toEqual(["MYNT1040 Unknown parameter type 'Text' in 'f'. Parameters are string, number, boolean, or a record type (Customer, Invoice, MyntLog, SalesOrder)"]);
    expect(messages(`fn f(x: Number): Bool {\n    return true\n}\nscheduled { }\n`).slice(0, 2)).toEqual([
      "MYNT1040 Unknown parameter type 'Number' in 'f'. Did you mean 'number'? Parameters are string, number, boolean, or a record type (Customer, Invoice, MyntLog, SalesOrder)",
      "MYNT1040 Unknown return type 'Bool'. Functions return string, number, or boolean",
    ]);
  });

  it("reserves the primitive names: they cannot be declared as locals, parameters, loop variables, or functions", () => {
    expect(messages(`scheduled {\n    let string = "x"\n}\n`)[0]).toBe("MYNT0001 'string' is a builtin type and cannot be used as a name");
    expect(messages(`scheduled {\n    let number = 1\n}\n`)[0]).toBe("MYNT0001 'number' is a builtin type and cannot be used as a name");
    expect(messages(`fn f(boolean: boolean) { }\nscheduled { }\n`)[0]).toBe("MYNT0001 'boolean' is a builtin type and cannot be used as a name");
    expect(messages(`fn string() { }\nscheduled { }\n`)[0]).toBe("MYNT0001 'string' is a builtin type and cannot be used as a name");
    expect(messages(`scheduled {\n    for number in query Customer { }\n}\n`)[0]).toBe("MYNT0001 'number' is a builtin type and cannot be used as a name");
  });

  it("spells types the source way in diagnostics, while record types stay PascalCase", () => {
    const UE = `beforeSubmit edit (customer: Customer) {\n`;
    expect(messages(`${UE}    customer.email = 1\n}\n`)).toEqual(["MYNT1006 Cannot assign number to Customer.email, which is string"]);
    expect(messages(`${UE}    if customer.email { }\n}\n`)[0]).toContain("if condition must be boolean, but received string");
    expect(messages(`${UE}    if customer.email == 1 { }\n}\n`)[0]).toContain("Cannot compare string with number");
    expect(messages(`fn f(c: Customer): number {\n    return c\n}\nscheduled { }\n`)[0]).toContain("Cannot return Customer from 'f', which returns number");
    expect(errorCodes(compileMynt(`fn f(c: Customer, o: SalesOrder) { }\nscheduled {\n    let c = load Customer("1")\n    f(c, c)\n}\n`))).toEqual(["MYNT1014"]);
    expect(messages(`fn f(c: Customer, o: SalesOrder) { }\nscheduled {\n    let c = load Customer("1")\n    f(c, c)\n}\n`)[0]).toContain("must be SalesOrder, but received Customer");
  });
});

describe("primitive types: editor taxonomy", () => {
  it("classifies builtin types, record types, builtin operations, keywords, and literals distinctly", () => {
    const text = `fn review(order: SalesOrder, note: string): boolean {\n    return true\n}\nscheduled {\n    let rows = query Customer\n        where email != ""\n    let c = load Customer("1")\n    let d = copy Customer("1")\n    let i = transform SalesOrder("1") to Invoice\n    let n = 2\n    if review(c, note) && !false { }\n}\n`;
    const all = tokens(text);
    expect(all.filter((t) => t.startsWith("string:") || t.startsWith("boolean:"))).toEqual(["string:type+defaultLibrary", "boolean:type+defaultLibrary"]);
    expect(all.filter((t) => /^(SalesOrder|Customer|Invoice):/.test(t))).toEqual(["SalesOrder:struct", "Customer:struct", "Customer:struct", "Customer:struct", "SalesOrder:struct", "Invoice:struct"]);
    expect(all.filter((t) => /^(query|load|copy|transform):/.test(t))).toEqual(["query:function+defaultLibrary", "load:function+defaultLibrary", "copy:function+defaultLibrary", "transform:function+defaultLibrary"]);
    expect(all.filter((t) => /^(where|to|fn|return|let|if):/.test(t)).every((t) => t.endsWith(":keyword"))).toBe(true);
    expect(all.filter((t) => /^(true|false):/.test(t))).toEqual([]);
    expect(all.filter((t) => /^(2|"1"|""):/.test(t))).toEqual(['"":string', '"1":string', '"1":string', '"1":string', "2:number"]);
  });

  it("completes builtin types as keywords and record types as classes", () => {
    const { doc, offset } = at(`fn foo(value: §`);
    const items = completionsAt(doc, offset).map((i) => `${i.label}:${i.kind}:${i.detail}`);
    expect(items.slice(0, 3)).toEqual(["string:14:builtin type", "number:14:builtin type", "boolean:14:builtin type"]);
    expect(items).toContain("Customer:22:record");
  });

  it("hovers a builtin type and a record type differently in a function signature", () => {
    const hover = (source: string) => { const { doc, offset } = at(source); return hoverAt(doc, offset)?.contents; };
    expect(hover(`fn foo(value: str§ing): boolean {\n    return true\n}\nscheduled { }\n`)).toBe("```mynt\nbuiltin type string\n```\n\nMynt builtin type · text; the type of string literals and text fields");
    expect(hover(`fn foo(value: string): bool§ean {\n    return true\n}\nscheduled { }\n`)).toContain("builtin type boolean");
    expect(hover(`fn foo(order: Sales§Order) { }\nscheduled { }\n`)).toContain("record SalesOrder");
  });

  it("uses the source spelling in signature help for user functions and builtins", () => {
    const help = (source: string) => { const { doc, offset } = at(source); return signatureHelpAt(doc, offset)?.signature.label; };
    expect(help(`fn calculate(value: number, multiplier: number): number {\n    return value\n}\nscheduled {\n    let r = calculate(§)\n}\n`)).toBe("fn calculate(value: number, multiplier: number): number");
    expect(help(`scheduled {\n    let c = load Customer(§)\n}\n`)).toBe("load Customer(id: string | number): Customer");
    expect(help(`scheduled {\n    log.debug(§)\n}\n`)).toBe("log.debug(message: string): Void");
    expect(help(`scheduled {\n    let c = copy Customer(§)\n}\n`)).toBe("copy Customer(id: string | number): Customer");
  });
});
