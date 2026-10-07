import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli/main.js";
import type { CliContext } from "../src/cli/context.js";
import { UserConfigStore } from "../src/netsuite/account/config.js";
import { MemoryCredentialStore } from "../src/netsuite/account/credentials.js";
import { fakeNetSuiteFetch } from "./fixtures/netsuite-metadata.js";

function makeContext(overrides: Partial<CliContext> = {}) {
  const home = mkdtempSync(join(tmpdir(), "mynt-cli-"));
  const cwd = join(home, "project");
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(cwd);
  const out: string[] = [];
  const err: string[] = [];
  const context: CliContext = {
    cwd,
    env: {},
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    fetch: fakeNetSuiteFetch({ expectToken: "AT" }),
    prompt: async () => "",
    openBrowser: async () => {},
    credentialStore: new MemoryCredentialStore(),
    userConfig: new UserConfigStore(join(home, "config", "mynt")),
    login: async () => ({ credentials: { accessToken: "AT", refreshToken: "RT", expiresAt: Date.now() + 3600_000 }, callback: { code: "c", company: "1234567_SB1", role: "3" } }),
    now: () => new Date("2026-10-07T12:00:00.000Z"),
    ...overrides,
  };
  const run = (...argv: string[]) => main(argv, context);
  return { context, run, out: () => out.join(""), err: () => err.join(""), reset: () => { out.length = 0; err.length = 0; }, cwd, home };
}

async function configured() {
  const t = makeContext();
  expect(await t.run("account", "add", "sandbox", "--account-id", "1234567_SB1", "--client-id", "cid", "--port", "9000")).toBe(0);
  expect(await t.run("account", "use", "sandbox")).toBe(0);
  expect(await t.run("auth", "login")).toBe(0);
  t.reset();
  return t;
}

describe("cli: accounts and auth", () => {
  it("adds a profile from flags, selects it for the project, and lists it", async () => {
    const t = makeContext();
    expect(await t.run("account", "add", "sandbox", "--account-id", "1234567_SB1", "--client-id", "cid")).toBe(0);
    expect(t.out()).toContain("redirect URI must be http://localhost:8484/callback");
    expect(t.context.userConfig.getProfile("sandbox")).toEqual({ accountId: "1234567_SB1", clientId: "cid", redirectPort: 8484 });

    expect(await t.run("account", "use", "sandbox")).toBe(0);
    expect(JSON.parse(readFileSync(join(t.cwd, "mynt.json"), "utf8"))).toEqual({ account: "sandbox" });

    t.reset();
    expect(await t.run("account", "list")).toBe(0);
    expect(t.out()).toContain("* sandbox  1234567_SB1  (default, not logged in, no snapshot)");
  });

  it("prompts for missing values and validates them", async () => {
    const answers = ["1234567_SB1", "cid"];
    const t = makeContext({ prompt: async () => answers.shift() ?? "" });
    expect(await t.run("account", "add", "sb")).toBe(0);
    expect(t.context.userConfig.getProfile("sb").accountId).toBe("1234567_SB1");

    const bad = makeContext();
    expect(await bad.run("account", "add", "sb", "--account-id", "not valid", "--client-id", "c")).toBe(1);
    expect(bad.err()).toContain("is not a NetSuite account id");
    expect(await bad.run("account", "use", "missing")).toBe(1);
    expect(bad.err()).toContain("No account profile named 'missing'.\nRun `mynt account add missing`.");
  });

  it("logs in through the injected flow, stores tokens, and logs out", async () => {
    const t = makeContext();
    await t.run("account", "add", "sandbox", "--account-id", "1234567_SB1", "--client-id", "cid");
    t.reset();
    expect(await t.run("auth", "login", "sandbox")).toBe(0);
    expect(t.out()).toBe("mynt: logged in to 'sandbox' (1234567_SB1) with role 3. Tokens stored in the in-memory store.\n");
    expect(await t.context.credentialStore.get("sandbox")).toMatchObject({ accessToken: "AT", refreshToken: "RT" });
    expect(t.out()).not.toContain("RT");

    t.reset();
    expect(await t.run("auth", "logout", "sandbox")).toBe(0);
    expect(await t.context.credentialStore.get("sandbox")).toBeUndefined();
    expect(await t.run("auth", "login")).toBe(1);
    expect(t.err()).toContain("No account given and mynt.json selects none.");
  });

  it("refuses to store a login for a different account than the profile", async () => {
    const t = makeContext({
      login: async () => ({ credentials: { accessToken: "AT", refreshToken: "RT", expiresAt: 1 }, callback: { code: "c", company: "7654321" } }),
    });
    await t.run("account", "add", "sandbox", "--account-id", "1234567_SB1", "--client-id", "cid");
    expect(await t.run("auth", "login", "sandbox")).toBe(1);
    expect(t.err()).toContain("The browser login was for account 7654321, but 'sandbox' is configured as 1234567_SB1. Nothing was stored.");
    expect(await t.context.credentialStore.get("sandbox")).toBeUndefined();
  });
});

describe("cli: schema pull, diff, and compilation against the snapshot", () => {
  it("pulls, normalizes, writes a deterministic snapshot, and is a no-op the second time", async () => {
    const t = await configured();
    expect(await t.run("schema", "pull")).toBe(0);
    const path = join(t.cwd, ".mynt", "schema", "sandbox.json");
    expect(t.out()).toBe(`mynt: wrote ${path} (4 records, 27 fields).\n`);
    expect(t.err()).toContain("mynt: [4/4]");
    expect(t.err()).toContain("warning: customer.currencyPrecision");
    const first = readFileSync(path, "utf8");
    expect(first).not.toMatch(/AT|RT|cid/);
    expect(JSON.parse(first).source).toEqual({ kind: "account", platform: "netsuite", account: "1234567_SB1", pulledAt: "2026-10-07T12:00:00.000Z" });

    t.reset();
    t.context.now = () => new Date("2026-10-08T12:00:00.000Z");
    expect(await t.run("schema", "pull", "sandbox", "--records", "customer,salesOrder,subsidiary,customrecord_mynt_test")).toBe(0);
    expect(t.out()).toContain("is up to date (4 records, 27 fields; no changes since 2026-10-07T12:00:00.000Z)");
    expect(readFileSync(path, "utf8")).toBe(first);
  });

  it("keeps raw responses on request, in a git-ignored directory", async () => {
    const t = await configured();
    expect(await t.run("schema", "pull", "--keep-raw", "--records", "customer")).toBe(0);
    const raw = join(t.cwd, ".mynt", "schema", "raw", "sandbox", "customer.json");
    expect(existsSync(raw)).toBe(true);
    expect(JSON.parse(readFileSync(raw, "utf8")).properties.isPerson.type).toBe("boolean");
    expect(readFileSync(".gitignore", "utf8")).toContain(".mynt/schema/raw/");
  });

  it("reports skipped types, records them with the raw files, and inspects the raw shape", async () => {
    const t = await configured();
    t.context.fetch = fakeNetSuiteFetch({ expectToken: "AT", forbid: ["subsidiary"] });
    expect(await t.run("schema", "pull", "--keep-raw")).toBe(0);
    expect(t.err()).toContain("mynt: skipped subsidiary: subsidiary metadata could not be retrieved because the selected role does not have access.");
    expect(t.out()).toContain("(3 records,");
    expect(existsSync(join(t.cwd, ".mynt", "schema", "raw", "sandbox", "_failures.json"))).toBe(true);

    t.reset();
    expect(await t.run("schema", "inspect")).toBe(0);
    const report = t.out();
    expect(report).toContain("3 record types");
    expect(report).toContain("failed to fetch: 1");
    expect(report).toContain("== customer");
    expect(report).toContain("== salesOrder");
    expect(report).toContain("== customrecord_mynt_test");
    expect(report).toContain("required (top-level): [\"companyName\"]");
    expect(report).toMatch(/readOnly: true=2 false=0 absent=\d+/);
    expect(report).toContain("$ref targets: 1\n  /services/rest/record/v1/metadata-catalog/subsidiary  (1) e.g. subsidiary");
    expect(report).toContain("enum properties: 1\n  emailPreference: 3 values");
    expect(report).toContain("custom fields: x-ns-custom-field=1 cust*-prefixed=2\n  prefixed but not marked: custentity_mynt_score");
    expect(report).toContain("snapshot: Customer id=customer record.Type=CUSTOMER custom=false");
    expect(report).toContain("Unknown: 1  currencyprecision");
    expect(report).not.toContain("Company Name");

    t.reset();
    expect(await t.run("schema", "inspect", "--records", "salesOrder")).toBe(0);
    expect(t.out()).not.toContain("== customer");

    const fresh = makeContext();
    expect(await fresh.run("schema", "inspect", "sandbox")).toBe(1);
    expect(fresh.err()).toContain("No raw metadata at");
  });

  it("reports changes against the previous snapshot and diffs two snapshots", async () => {
    const t = await configured();
    await t.run("schema", "pull", "--records", "customer,subsidiary");
    t.reset();
    expect(await t.run("schema", "pull", "--records", "customer,salesOrder")).toBe(0);
    expect(t.out()).toContain("2 changes since the previous snapshot:\n  + record salesorder\n  - record subsidiary\n");

    const other = join(t.cwd, "other.json");
    writeFileSync(other, readFileSync(join(t.cwd, ".mynt", "schema", "sandbox.json"), "utf8").replace('"writable": false', '"writable": true'));
    t.reset();
    expect(await t.run("schema", "diff", "sandbox", "other.json")).toBe(1);
    expect(t.out()).toContain("~ customer.balance: writable false -> true");
  });

  it("explains a missing login, a wrong token, and a missing profile without stack traces", async () => {
    const t = makeContext();
    await t.run("account", "add", "sandbox", "--account-id", "1234567_SB1", "--client-id", "cid");
    expect(await t.run("schema", "pull", "sandbox")).toBe(1);
    expect(t.err()).toBe("mynt: Not logged in to 'sandbox'.\nRun `mynt auth login sandbox`.\n");

    t.reset();
    await t.context.credentialStore.set("sandbox", { accessToken: "WRONG", refreshToken: "RT", expiresAt: Date.now() + 3600_000 });
    expect(await t.run("schema", "pull", "sandbox")).toBe(1);
    expect(t.err()).toBe("mynt: Could not authenticate to NetSuite account '1234567_SB1'. Run `mynt auth login` again.\nmynt: run with --verbose for details.\n");

    t.reset();
    expect(await t.run("schema", "pull", "sandbox", "--verbose")).toBe(1);
    expect(t.err()).toContain("INVALID_LOGIN: Invalid login attempt.");
    expect(t.err()).not.toContain("WRONG");
  });

  it("check and build use the project's pulled snapshot, or --schema, or the built-in sample", async () => {
    const t = await configured();
    await t.run("schema", "pull");
    writeFileSync(join(t.cwd, "real.mn"), `beforeSubmit edit (customer: Customer) {\n    customer.custentity_mynt_tier = "gold"\n    if customer.isperson {\n        customer.comments = "person"\n    }\n}\n`);
    writeFileSync(join(t.cwd, "invented.mn"), `beforeSubmit edit (customer: Customer) {\n    customer.notreal = "x"\n}\n`);

    t.reset();
    expect(await t.run("check", "real.mn")).toBe(0);
    expect(t.out()).toBe("mynt: real.mn OK (Customer user event, schema: account 'sandbox')\n");

    t.reset();
    expect(await t.run("check", "invented.mn")).toBe(1);
    expect(t.err()).toContain("error MYNT1004: Customer has no field 'notreal'");

    t.reset();
    expect(await t.run("check", "real.mn", "--schema", "../nope.json")).toBe(1);
    expect(t.err()).toContain("No schema snapshot at");

    // The built-in sample has no custom field, so the same file fails there.
    t.reset();
    writeFileSync(join(t.cwd, "mynt.json"), "{}\n");
    expect(await t.run("check", "real.mn")).toBe(1);
    expect(t.err()).toContain("Customer has no field 'custentity_mynt_tier'");

    t.reset();
    writeFileSync(join(t.cwd, "mynt.json"), JSON.stringify({ account: "sandbox" }));
    expect(await t.run("build", "real.mn")).toBe(0);
    expect(readFileSync(join(t.cwd, "real.js"), "utf8")).toContain('fieldId: "custentity_mynt_tier"');
  });

  it("fails clearly when the project selects an account with no snapshot", async () => {
    const t = await configured();
    writeFileSync(join(t.cwd, "x.mn"), "scheduled { }\n");
    expect(await t.run("check", "x.mn")).toBe(1);
    expect(t.err()).toContain("mynt.json selects account 'sandbox', but there is no snapshot at");
  });
});
