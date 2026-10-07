import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DiagnosticCode } from "../src/diagnostics.js";
import { SERVER_NAME } from "../src/lsp/server.js";
import { PROJECT_CONFIG_FILE, findProjectRoot, rawMetadataDir, schemaSnapshotPath, userConfigDir } from "../src/netsuite/account/config.js";
import { main } from "../src/cli/main.js";
import { fixtureSchema } from "./helpers.js";

/** Built at runtime so this file does not itself contain the old name. */
const OLD = new RegExp(["s", "ail"].join(""), "i");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe("branding", () => {
  it("the CLI executable is mynt", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { name: string; bin: Record<string, string>; scripts: Record<string, string> };
    expect(pkg.name).toBe("mynt");
    expect(pkg.bin).toEqual({ mynt: "./bin/mynt.js" });
    expect(existsSync("bin/mynt.js")).toBe(true);
    expect(pkg.scripts.mynt).toContain("src/cli/main.ts");
  });

  it("sources use the .mn extension and no other", () => {
    const examples = readdirSync("examples");
    expect(examples.length).toBeGreaterThan(5);
    expect(examples.every((f) => f.endsWith(".mn") || f.endsWith(".js"))).toBe(true);
  });

  it("diagnostics use the MYNT prefix with unchanged numbers", () => {
    const codes = Object.values(DiagnosticCode);
    expect(codes.every((code) => /^MYNT\d{4}$/.test(code))).toBe(true);
    expect(DiagnosticCode.SyntaxError).toBe("MYNT0001");
    expect(DiagnosticCode.UnknownField).toBe("MYNT1004");
    expect(DiagnosticCode.UnsavedMutation).toBe("MYNT2001");
    expect(DiagnosticCode.ArgumentOrigin).toBe("MYNT1044");
  });

  it("project discovery uses mynt.json and .mynt/, never the old names", () => {
    expect(PROJECT_CONFIG_FILE).toBe("mynt.json");
    const root = mkdtempSync(join(tmpdir(), "mynt-brand-"));
    writeFileSync(join(root, ["s", "ail"].join("") + ".json"), `{ "account": "sandbox" }`);
    expect(findProjectRoot(root)).toBeUndefined();
    writeFileSync(join(root, "mynt.json"), `{ "account": "sandbox" }`);
    expect(findProjectRoot(join(root, "src"))).toBe(root);
    expect(findProjectRoot(root)).toBe(root);
    expect(schemaSnapshotPath(root, "sandbox")).toBe(join(root, ".mynt", "schema", "sandbox.json"));
    expect(rawMetadataDir(root, "sandbox")).toBe(join(root, ".mynt", "schema", "raw", "sandbox"));
  });

  it("environment variables use the MYNT_ prefix", () => {
    expect(userConfigDir({ MYNT_CONFIG_DIR: "/x" })).toBe("/x");
    expect(userConfigDir({ [["S", "AIL_CONFIG_DIR"].join("")]: "/x", XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/mynt");
  });

  it("the language server identifies itself as mynt", () => {
    expect(SERVER_NAME).toBe("mynt");
  });

  it("the schema format key is myntSchemaVersion with the version unchanged", () => {
    expect(fixtureSchema.myntSchemaVersion).toBe(1);
    const builtin = JSON.parse(readFileSync("schemas/builtin.json", "utf8")) as Record<string, unknown>;
    expect(builtin.myntSchemaVersion).toBe(1);
    expect(Object.keys(builtin).some((k) => OLD.test(k))).toBe(false);
  });

  it("a .mn file compiles against a .mynt snapshot through the CLI", async () => {
    const root = mkdtempSync(join(tmpdir(), "mynt-cli-"));
    mkdirSync(join(root, ".mynt", "schema"), { recursive: true });
    writeFileSync(join(root, "mynt.json"), `{ "account": "sandbox" }`);
    writeFileSync(join(root, ".mynt", "schema", "sandbox.json"), JSON.stringify(fixtureSchema));
    writeFileSync(join(root, "job.mn"), `scheduled {\n    let c = load Customer("1")\n    c.comments = "x"\n    save c\n}\n`);
    const out: string[] = [];
    const err: string[] = [];
    const { defaultContext } = await import("../src/cli/context.js");
    const code = await main(["check", "job.mn"], { ...defaultContext(), cwd: root, stdout: (t) => out.push(t), stderr: (t) => err.push(t) });
    expect(err.join("")).toBe("");
    expect(code).toBe(0);
    expect(out.join("")).toBe("mynt: job.mn OK (scheduled script, schema: account 'sandbox')\n");
  });

  it("no tracked source, test, example, schema, or documentation mentions the old name", () => {
    const files = [...walk("src"), ...walk("tests"), ...walk("examples"), ...walk("schemas"), "README.md", "package.json", ".gitignore"];
    const offenders = files.filter((f) => statSync(f).isFile() && f !== "tests/branding.test.ts" && !f.endsWith(".js") && OLD.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("publishing", () => {
  it("the package is publishable and ships what the CLI reads at runtime", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as Record<string, unknown>;
    expect(pkg.private).toBeUndefined();
    expect(pkg.files).toEqual(["bin", "dist", "schemas", "README.md"]);
    expect(pkg.publishConfig).toEqual({ access: "public" });
    expect((pkg.scripts as Record<string, string>).prepublishOnly).toContain("build");
    expect(typeof pkg.license).toBe("string");
    expect(existsSync("schemas/builtin.json")).toBe(true);
  });
});
