import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Tree-sitter grammar is verified through its own CLI, which
 * `pnpm install` puts under tree-sitter-mynt/node_modules as a workspace dev
 * dependency. A normal install therefore verifies the grammar, and a missing
 * CLI fails rather than skips. Only MYNT_SKIP_GRAMMAR_TESTS=1 skips, for a
 * deliberately minimal environment.
 */
const CLI = resolve("tree-sitter-mynt", "node_modules", ".bin", "tree-sitter");
const skip = process.env.MYNT_SKIP_GRAMMAR_TESTS === "1";
const run = (args: string[], cwd = "tree-sitter-mynt") => {
  if (!existsSync(CLI)) throw new Error("tree-sitter-cli is not installed under tree-sitter-mynt/node_modules; run `pnpm install` (set MYNT_SKIP_GRAMMAR_TESTS=1 to skip grammar verification deliberately)");
  return execFileSync(CLI, args, { cwd, encoding: "utf8", timeout: 60_000 });
};
/** `tree-sitter parse` exits non-zero when the tree has errors; the tree is still on stdout. */
const parseTree = (file: string) => {
  try {
    return run(["parse", file]);
  } catch (error) {
    return String((error as { stdout?: string }).stdout ?? "");
  }
};
const scratch = (name: string, source: string) => {
  const file = join("tree-sitter-mynt", "node_modules", name);
  writeFileSync(file, source);
  return join("node_modules", name);
};
const HIGHLIGHTS = join("..", "editors", "zed", "languages", "mynt", "highlights.scm");

describe.skipIf(skip)("tree-sitter grammar", () => {
  it("has the CLI a normal `pnpm install` provides", () => {
    expect(existsSync(CLI), "tree-sitter-cli missing: run `pnpm install`").toBe(true);
  });

  it("generates from grammar.js without conflicts and matches the committed parser", () => {
    const before = readFileSync("tree-sitter-mynt/src/parser.c", "utf8");
    const output = run(["generate"]);
    expect(output).not.toContain("conflict");
    expect(readFileSync("tree-sitter-mynt/src/parser.c", "utf8")).toBe(before);
  });

  it("passes its corpus", () => {
    const output = run(["test"]);
    expect(output).not.toMatch(/✗|failures/);
  });

  it("parses every example without error or missing nodes", () => {
    for (const file of readdirSync("examples").filter((f) => f.endsWith(".mn"))) {
      const tree = run(["parse", join("..", "examples", file)]);
      expect(tree, file).not.toMatch(/ERROR|MISSING/);
    }
  });

  it("every Zed query file compiles against the grammar and matches something in the examples", () => {
    for (const query of ["highlights", "brackets", "indents", "outline", "textobjects"]) {
      const output = run(["query", join("..", "editors", "zed", "languages", "mynt", `${query}.scm`), join("..", "examples", "review-orders.mn")]);
      expect(output, query).toContain("pattern:");
    }
  });

  it("types a function's result with ':' like a parameter, and rejects the old '->' without losing the declaration", () => {
    const colon = parseTree(scratch(".colon.mn", `fn needsReview(memo: string): boolean {\n    return memo == "" || memo == "TBD"\n}\n`));
    expect(colon).not.toMatch(/ERROR|MISSING/);
    expect(colon).toContain("return_type: (primitive_type");
    const arrow = parseTree(scratch(".arrow.mn", `fn foo() -> Text {\n}\nscheduled { }\n`));
    expect(arrow).toContain("(ERROR");
    expect(arrow).toContain("(function_declaration");
    expect(arrow).toContain("(scheduled");
  });

  it("highlights the function example as keyword, function, parameter, type, type, keyword, operator, string", () => {
    const captures = run(["query", HIGHLIGHTS, scratch(".review.mn", `fn needsReview(memo: string): boolean {\n    return memo == "" || memo == "TBD"\n}\n`)])
      .split("\n")
      .map((line) => /capture: \d+ - ([\w.]+), .*text: `(.*)`$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => `${m[2]}:${m[1]}`);
    expect(captures).toEqual([
      "fn:keyword",
      "needsReview:function",
      "(:punctuation.bracket",
      "memo:variable.parameter",
      "::punctuation.delimiter",
      "string:type.builtin",
      "):punctuation.bracket",
      "::punctuation.delimiter",
      "boolean:type.builtin",
      "{:punctuation.bracket",
      "return:keyword",
      "==:operator",
      '"":string',
      "||:operator",
      "==:operator",
      '"TBD":string',
      "}:punctuation.bracket",
    ]);
    expect(readFileSync("editors/zed/languages/mynt/highlights.scm", "utf8")).not.toContain('"->"');
  });

  it("parses the builtin types as primitive_type only in type positions, and the old spellings as plain identifiers", () => {
    const tree = parseTree(scratch(".primitives.mn", `fn f(a: string, b: number, c: boolean, d: Customer, e: Text): number {\n    return b\n}\n`));
    expect(tree).not.toMatch(/ERROR|MISSING/);
    expect(tree.match(/\(primitive_type/g)?.length).toBe(4);
    expect(tree.match(/\(type_identifier/g)?.length).toBe(2);
    const captures = run(["query", HIGHLIGHTS, scratch(".primitives.mn", `fn f(a: string, d: Customer): boolean {\n    return true\n}\n`)]);
    expect(captures).toMatch(/type\.builtin, .*`string`/);
    expect(captures).toMatch(/type\.builtin, .*`boolean`/);
    expect(captures).toMatch(/- type, .*`Customer`/);
    expect(captures).toMatch(/boolean, .*`true`/);
    // Keyword extraction keeps the names identifiers elsewhere; the compiler,
    // not the grammar, reports that they cannot be declared.
    expect(parseTree(scratch(".primitives.mn", `scheduled {\n    let string = "x"\n    log.debug(c.number)\n}\n`))).not.toMatch(/ERROR|MISSING/);
  });

  it("keeps contextual words as identifiers where the compiler does, and keywords where it does not", () => {
    const captures = (source: string) => run(["query", HIGHLIGHTS, scratch(".contextual.mn", source)]);
    const asLocal = captures(`scheduled {\n    let where = "x"\n    let query = where\n    log.debug(query)\n}\n`);
    expect(asLocal).not.toMatch(/keyword.*`where`|keyword.*`query`/);
    expect(asLocal).toMatch(/variable.*`where`/);
    const asKeyword = captures(`scheduled {\n    for c in query Customer\n        where email != "" {\n    }\n}\n`);
    expect(asKeyword).toMatch(/function\.builtin.*`query`/);
    expect(asKeyword).not.toMatch(/keyword.*`query`/);
    expect(asKeyword).toMatch(/keyword.*`where`/);
    expect(asKeyword).toMatch(/type.*`Customer`/);
  });

  it("parses search like query, projections with named fields, and a record reference as a bare call", () => {
    const tree = parseTree(scratch(".search.mn", `scheduled {\n    let info = Customer(123)[email, comments]\n    for row in search Customer\n        where email != "" {\n        let e = row[email]\n    }\n}\n`));
    expect(tree).not.toMatch(/ERROR|MISSING/);
    expect(tree).toMatch(/projection_expression[\s\S]*receiver: \(call_expression[\s\S]*fields: \(projection_fields[\s\S]*field: \(identifier/);
    expect(tree).toMatch(/query_expression[\s\S]*query: \(call_expression/);
    const captures = run(["query", HIGHLIGHTS, scratch(".search.mn", `scheduled {\n    let info = Customer(123)[email, comments]\n    for row in search Customer where email != "" {\n        log.debug(row.id)\n    }\n    let search = "x"\n}\n`)]);
    expect(captures).toMatch(/function\.builtin.*`search`/);
    expect(captures).toMatch(/- type.*`Customer`/);
    expect(captures).toMatch(/property.*`email`/);
    expect(captures).toMatch(/property.*`comments`/);
    expect(captures).toMatch(/keyword.*`where`/);
    expect(captures).toMatch(/variable.*`search`/);
    expect(captures).not.toMatch(/keyword.*`search`/);
    // A saved search is `load Search(id)`: `load` the builtin operation, `Search` a type, the id a string; `saved` is just a name now.
    const saved = run(["query", HIGHLIGHTS, scratch(".saved.mn", `scheduled {\n    let saved = "x"\n    for c in load Search("customsearch_x") where email !== "" {\n    }\n    let n = load Search("customsearch_notes")\n}\n`)]);
    expect(saved).toMatch(/variable.*`saved`/);
    expect(saved).not.toMatch(/keyword.*`saved`/);
    expect(saved).toMatch(/function\.builtin.*`load`/);
    expect(saved).toMatch(/- type, .*`Search`/);
    expect(saved).toMatch(/string.*`"customsearch_x"`/);
    expect(saved).toMatch(/keyword.*`where`/);
    expect(parseTree(scratch(".saved.mn", `scheduled {\n    let d = load Search("customsearch_x")\n        where email !== ""\n        select email\n    let f = load Search(\n    log.debug("next")\n}\n`))).toMatch(/query_expression[\s\S]*where_clause[\s\S]*select_clause/);
    // `lookup` and a destructuring pattern: the operation is a builtin, pattern locals are variables, an aliased source is a property.
    const lookup = run(["query", HIGHLIGHTS, scratch(".lookup.mn", `scheduled {\n    let lookup = "x"\n    let info = lookup Customer(123)\n        select email, comments\n    let { email, comments: note } = info\n    let other = Customer(1)[email]\n}\n`)]);
    expect(lookup).toMatch(/function\.builtin.*`lookup`/);
    expect(lookup).toMatch(/variable.*`lookup`/);
    expect(lookup).toMatch(/keyword.*`select`/);
    expect(lookup).toMatch(/variable.*`note`/);
    expect(lookup).toMatch(/property.*`comments`/);
    expect(parseTree(scratch(".lookup.mn", `scheduled {\n    let info = lookup Customer(123)\n        select email, comments\n    let { email, comments: note } = info\n    let { a } = lookup c[a, b]\n}\n`))).toMatch(/query_expression[\s\S]*select_clause[\s\S]*object_pattern[\s\S]*pattern_field[\s\S]*projection_expression/);
    expect(parseTree(scratch(".lookup.mn", `scheduled {\n    let {\n    let { email,\n    let y = lookup Customer(1)\n        select\n    log.debug("next")\n}\n`))).toMatch(/\(expression_statement[^\n]*\n\s+\(call_expression[\s\S]*\(string \[5, 14\]/);
    // Search clauses: the clause words are keywords in a search and identifiers elsewhere; selected and sort fields are properties.
    const clauses = run(["query", HIGHLIGHTS, scratch(".clauses.mn", `scheduled {\n    let select = "x"\n    let o = search SalesOrder\n        select memo, entity.email\n        where total > 1\n        order by total desc, memo asc\n        limit 5\n    let p = search SalesOrder first\n}\n`)]);
    for (const word of ["select", "where", "order", "by", "asc", "desc", "limit", "first"]) expect(clauses).toMatch(new RegExp(`keyword, .*\\\`${word}\\\``));
    expect(clauses).toMatch(/variable.*`select`/);
    expect(clauses).toMatch(/property.*`memo`/);
    expect(clauses).toMatch(/property.*`total`/);
    expect(parseTree(scratch(".clauses.mn", `scheduled {\n    let o = search SalesOrder\n        order by total desc\n        select memo\n        where total > 1\n}\n`))).not.toMatch(/ERROR|MISSING/);
    // A summary search: `group`/`by` are keywords, an aggregate is a builtin function, its alias a property; `sum` and `group` stay identifiers elsewhere.
    const summary = run(["query", HIGHLIGHTS, scratch(".summary.mn", `scheduled {\n    let sum = 1\n    let group = sum\n    let t = search SalesOrder\n        order by total desc\n        select entity, total = sum(amount), n = count()\n        group by entity\n}\n`)]);
    for (const word of ["group", "by"]) expect(summary).toMatch(new RegExp(`keyword, .*\\\`${word}\\\``));
    expect(summary).toMatch(/function\.builtin.*`sum`/);
    expect(summary).toMatch(/function\.builtin.*`count`/);
    expect(summary).toMatch(/property.*`total`/);
    expect(summary).toMatch(/property.*`n`/);
    expect(summary).toMatch(/variable.*`sum`/);
    expect(summary).toMatch(/variable.*`group`/);
    expect(parseTree(scratch(".summary.mn", `scheduled {\n    let t = search SalesOrder\n        group by entity, subsidiary\n        select entity, total = sum(amount)\n        order by total desc\n        limit 5\n}\n`))).not.toMatch(/ERROR|MISSING/);
    expect(parseTree(scratch(".summary.mn", `scheduled {\n    let t = search SalesOrder\n        select total = sum(amount)\n        first\n        or return\n}\n`))).toMatch(/aggregate_item[\s\S]*first_clause[\s\S]*or_expression|or_expression[\s\S]*aggregate_item/);
    // `or` resolves an optional and `try`/`catch`/`finally` recover from a throw; all keywords there, identifiers elsewhere.
    const optional = run(["query", HIGHLIGHTS, scratch(".optional.mn", `scheduled {\n    let or = true\n    let c = search Customer first\n        or return\n    try {\n        save c\n    } catch err {\n        log.error(err)\n    } finally {\n        log.debug("x")\n    }\n}\n`)]);
    for (const word of ["or", "try", "catch", "finally"]) expect(optional).toMatch(new RegExp(`keyword, .*\\\`${word}\\\``));
    expect(optional).toMatch(/variable.*`or`/);
    expect(optional).toMatch(/variable.*`err`/);
    expect(parseTree(scratch(".optional.mn", `scheduled {\n    let c = search Customer first\n        or {\n            return\n        }\n    try {\n    } catch {\n    }\n}\n`))).not.toMatch(/ERROR|MISSING/);
    // All four equality operators are operators, and `===` is one token, never `==` then `=`.
    const equality = run(["query", HIGHLIGHTS, scratch(".equality.mn", `scheduled {\n    if a === b || c !== d || e == f || g != h { }\n}\n`)]);
    for (const operator of ["===", "!==", "==", "!="]) expect(equality).toMatch(new RegExp(`operator, .*\\\`${operator}\\\``));
    expect(parseTree(scratch(".equality.mn", `scheduled {\n    if a === b { }\n}\n`))).not.toMatch(/ERROR|MISSING|assignment/);
    // No indexing: a number inside the brackets is an error, as in the compiler.
    expect(parseTree(scratch(".search.mn", `scheduled {\n    let e = rows[0]\n}\n`))).toMatch(/ERROR/);
  });
});

describe("syntax guard", () => {
  it("no tracked Mynt source or documentation uses the removed '->' return syntax", () => {
    const sources = readdirSync("examples").filter((f) => f.endsWith(".mn")).map((f) => [f, readFileSync(join("examples", f), "utf8")] as const);
    const readme = readFileSync("README.md", "utf8");
    const myntBlocks = [...readme.matchAll(/```mynt\n([\s\S]*?)```/g)].map((m, i) => [`README.md mynt block ${i + 1}`, m[1]!] as const);
    for (const [name, text] of [...sources, ...myntBlocks]) expect(text, name).not.toMatch(/\)\s*->/);
  });
});

describe("zed extension metadata", () => {
  const read = (p: string) => readFileSync(join("editors", "zed", p), "utf8");

  it("declares the Mynt language with the .mn suffix, comments, and the mynt grammar", () => {
    const config = read("languages/mynt/config.toml");
    expect(config).toMatch(/^name = "Mynt"$/m);
    expect(config).toMatch(/^grammar = "mynt"$/m);
    expect(config).toMatch(/^path_suffixes = \["mn"\]$/m);
    expect(config).toMatch(/^line_comments = \["\/\/ "\]$/m);
  });

  it("registers the grammar and associates the language server with Mynt", () => {
    const manifest = read("extension.toml.in");
    expect(manifest).toMatch(/^\[grammars\.mynt\]$/m);
    expect(manifest).toMatch(/^\[language_servers\.mynt\]$/m);
    expect(manifest).toMatch(/^languages = \["Mynt"\]$/m);
    expect(manifest).toContain("@GRAMMAR_REPOSITORY@");
    const lib = read("src/lib.rs");
    expect(lib).toContain('"lsp".to_string()');
    expect(lib).toContain("LspSettings::for_worktree");
    expect(lib.indexOf("configured_path")).toBeLessThan(lib.indexOf('which("mynt")'));
    expect(lib.indexOf('which("mynt")')).toBeLessThan(lib.indexOf(".or(development)"));
  });

  it("ships semantic token rules that keep builtin types, builtin methods, and builtin namespaces on their own styles", () => {
    const rules = JSON.parse(read("languages/mynt/semantic_token_rules.json")) as { token_type: string; token_modifiers: string[]; style: string[]; foreground_color?: string }[];
    expect(rules).toEqual([
      { token_type: "type", token_modifiers: ["defaultLibrary"], style: ["type.builtin", "type"] },
      // Zed's default sends method + defaultLibrary to function.builtin; `log.debug` is a method, not a record operation.
      { token_type: "method", token_modifiers: ["defaultLibrary"], style: ["function.method", "function"] },
      { token_type: "namespace", token_modifiers: ["defaultLibrary"], style: ["namespace.builtin", "namespace", "type"] },
    ]);
    expect(rules.every((r) => !r.foreground_color)).toBe(true);
  });

  it("ships the five query files", () => {
    for (const q of ["highlights", "brackets", "indents", "outline", "textobjects"]) expect(existsSync(join("editors", "zed", "languages", "mynt", `${q}.scm`))).toBe(true);
  });
});
