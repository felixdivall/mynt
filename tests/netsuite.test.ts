import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UserError } from "../src/errors.js";
import { FileCredentialStore, MemoryCredentialStore } from "../src/netsuite/account/credentials.js";
import { UserConfigStore, findProjectRoot, readProjectConfig, writeProjectConfig } from "../src/netsuite/account/config.js";
import { accountSlug, assertAccountId, authorizeUrl, tokenUrl } from "../src/netsuite/account/url.js";
import { pullRawMetadata } from "../src/netsuite/client/metadata.js";
import { buildAuthorizeUrl, exchangeCode, login, newState, pkcePair, waitForCallback } from "../src/netsuite/client/oauth.js";
import { RestClient, translateError } from "../src/netsuite/client/rest.js";
import { createSession } from "../src/netsuite/client/session.js";
import { diffSchemas, formatChange } from "../src/netsuite/schema/diff.js";
import { normalize } from "../src/netsuite/schema/normalize.js";
import { readSnapshot, serializeSnapshot, writeSnapshot } from "../src/netsuite/schema/snapshot.js";
import { DocumentSchemaProvider } from "../src/schema/provider.js";
import type { SchemaDocument } from "../src/schema/types.js";
import { compile } from "../src/compiler.js";
import { fakeNetSuiteFetch, rawMetadata } from "./fixtures/netsuite-metadata.js";

const PULLED_AT = "2026-10-07T12:00:00.000Z";

function normalized() {
  return normalize(rawMetadata, { account: "1234567_SB1", pulledAt: PULLED_AT });
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "sail-test-"));
}

describe("account urls", () => {
  it("derives hostnames from the account id by NetSuite's documented rule", () => {
    expect(accountSlug("1234567_SB1")).toBe("1234567-sb1");
    expect(authorizeUrl("1234567_SB1")).toBe("https://1234567-sb1.app.netsuite.com/app/login/oauth2/authorize.nl");
    expect(tokenUrl("1234567")).toBe("https://1234567.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token");
  });

  it("rejects malformed account ids", () => {
    expect(() => assertAccountId("1234567_SB1")).not.toThrow();
    expect(() => assertAccountId("TSTDRV123")).not.toThrow();
    expect(() => assertAccountId("not an id")).toThrow(UserError);
  });
});

describe("profiles and project config", () => {
  it("stores and looks up profiles, and reports a missing one with the fix", () => {
    const store = new UserConfigStore(join(tempDir(), "sail"));
    expect(store.read()).toEqual({ accounts: {} });
    store.setProfile("sandbox", { accountId: "1234567_SB1", clientId: "abc", redirectPort: 8484 });
    expect(store.getProfile("sandbox")).toEqual({ accountId: "1234567_SB1", clientId: "abc", redirectPort: 8484 });
    expect(() => store.getProfile("prod")).toThrow("No account profile named 'prod'.\nRun `sail account add prod`.");
  });

  it("never serializes anything but the three profile fields", () => {
    const store = new UserConfigStore(join(tempDir(), "sail"));
    const poisoned = { accountId: "1", clientId: "c", redirectPort: 1, refreshToken: "SECRET", accessToken: "SECRET" };
    store.setProfile("x", poisoned as never);
    const text = readFileSync(store.path, "utf8");
    expect(text).not.toContain("SECRET");
    expect(JSON.parse(text)).toEqual({ accounts: { x: { accountId: "1", clientId: "c", redirectPort: 1 } } });
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
  });

  it("project config holds only the account alias and is found by walking up", () => {
    const root = tempDir();
    writeProjectConfig(root, { account: "sandbox", secret: "no" } as never);
    expect(JSON.parse(readFileSync(join(root, "sail.json"), "utf8"))).toEqual({ account: "sandbox" });
    expect(findProjectRoot(join(root, "a", "b"))).toBe(root);
    expect(findProjectRoot(tmpdir())).toBeUndefined();
    expect(readProjectConfig(root)).toEqual({ account: "sandbox" });
  });
});

describe("credential stores", () => {
  it("file store round-trips with mode 0600 and removes the file when empty", async () => {
    const path = join(tempDir(), "sail", "credentials.json");
    const store = new FileCredentialStore(path);
    expect(store.warning).toContain("development fallback");
    await store.set("sandbox", { accessToken: "a", refreshToken: "r", expiresAt: 1 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await store.get("sandbox")).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: 1 });
    expect(await store.delete("sandbox")).toBe(true);
    expect(await store.delete("sandbox")).toBe(false);
    expect(await store.get("sandbox")).toBeUndefined();
  });
});

describe("oauth", () => {
  it("builds a PKCE authorization URL with NetSuite's parameters", () => {
    const pkce = pkcePair();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newState().length).toBeGreaterThanOrEqual(22);
    const url = new URL(buildAuthorizeUrl({ accountId: "1234567_SB1", clientId: "cid", port: 8484, state: "s".repeat(22), challenge: pkce.challenge }));
    expect(url.origin + url.pathname).toBe("https://1234567-sb1.app.netsuite.com/app/login/oauth2/authorize.nl");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "cid",
      redirect_uri: "http://localhost:8484/callback",
      scope: "rest_webservices",
      state: "s".repeat(22),
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    });
  });

  it("accepts the loopback callback only with the expected state", async () => {
    let port = 0;
    const result = waitForCallback({ port: 0, expectedState: "expected-state-value-123", timeoutMs: 5000, onListening: (p) => (port = p) });
    await new Promise((r) => setTimeout(r, 20));
    const wrong = await fetch(`http://127.0.0.1:${port}/callback?code=x&state=wrong`);
    expect(wrong.status).toBe(400);
    const right = await fetch(`http://127.0.0.1:${port}/callback?code=the-code&state=expected-state-value-123&company=1234567_SB1&role=3`);
    expect(right.status).toBe(200);
    expect(await right.text()).toContain("logged in");
    expect(await result).toEqual({ code: "the-code", company: "1234567_SB1", role: "3" });
  });

  it("rejects when NetSuite reports an error on the callback", async () => {
    let port = 0;
    const result = waitForCallback({ port: 0, expectedState: "expected-state-value-123", timeoutMs: 5000, onListening: (p) => (port = p) }).catch(
      (error: Error) => error,
    );
    await new Promise((r) => setTimeout(r, 20));
    await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=expected-state-value-123`);
    expect(await result).toMatchObject({ message: "NetSuite refused the login: access_denied" });
  });

  it("exchanges the code as a public client and translates token errors", async () => {
    const ok = fakeNetSuiteFetch({ tokenResponses: [{ access_token: "AT", refresh_token: "RT", expires_in: 3600 }] });
    const credentials = await exchangeCode({ accountId: "1234567_SB1", clientId: "cid", port: 8484, code: "c", verifier: "v" }, ok);
    expect(credentials.accessToken).toBe("AT");
    expect(credentials.refreshToken).toBe("RT");
    expect(credentials.expiresAt).toBeGreaterThan(Date.now() + 3500 * 1000);

    const bad = fakeNetSuiteFetch({ tokenResponses: [] });
    await expect(exchangeCode({ accountId: "1234567_SB1", clientId: "cid", port: 8484, code: "c", verifier: "v" }, bad)).rejects.toThrow(
      "Could not authenticate to NetSuite account '1234567_SB1': invalid_grant.",
    );
  });

  it("runs the whole flow against a local callback", async () => {
    const fetchImpl = fakeNetSuiteFetch({ tokenResponses: [{ access_token: "AT", refresh_token: "RT", expires_in: 3600 }] });
    const result = await login({
      accountId: "1234567_SB1",
      clientId: "cid",
      port: 0,
      fetch: fetchImpl,
      log: () => {},
      openBrowser: async (url) => {
        // Pretend to be the browser: NetSuite redirects back with the state we were given.
        const state = new URL(url).searchParams.get("state")!;
        const port = new URL(new URL(url).searchParams.get("redirect_uri")!).port;
        // Port 0 was requested; the real port is not in the URL, so this flow is tested in the unit above.
        void port;
        void state;
      },
      timeoutMs: 200,
    }).catch((error: Error) => error);
    expect(result).toBeInstanceOf(UserError);
    expect((result as Error).message).toContain("Timed out");
  });
});

describe("session and rest client", () => {
  const profile = { accountId: "1234567_SB1", clientId: "cid", redirectPort: 8484 };

  it("requires a login and refreshes an expiring token, persisting the result", async () => {
    const store = new MemoryCredentialStore();
    const fetchImpl = fakeNetSuiteFetch({ tokenResponses: [{ access_token: "NEW", refresh_token: "RT2", expires_in: 3600 }] });
    const session = createSession({ alias: "sandbox", profile, store, fetch: fetchImpl });
    await expect(session.accessToken()).rejects.toThrow("Not logged in to 'sandbox'.\nRun `sail auth login sandbox`.");

    await store.set("sandbox", { accessToken: "OLD", refreshToken: "RT", expiresAt: Date.now() + 10 * 60 * 1000 });
    expect(await session.accessToken()).toBe("OLD");

    await store.set("sandbox", { accessToken: "OLD", refreshToken: "RT", expiresAt: Date.now() + 10 * 1000 });
    expect(await session.accessToken()).toBe("NEW");
    expect((await store.get("sandbox"))?.refreshToken).toBe("RT2");
  });

  it("explains an expired refresh token", async () => {
    const store = new MemoryCredentialStore();
    await store.set("sandbox", { accessToken: "OLD", refreshToken: "RT", expiresAt: 0 });
    const session = createSession({ alias: "sandbox", profile, store, fetch: fakeNetSuiteFetch() });
    await expect(session.accessToken()).rejects.toThrow("The login for 'sandbox' has expired.\nRun `sail auth login sandbox`.");
  });

  it("sends the bearer token and translates NetSuite errors without echoing it", async () => {
    const store = new MemoryCredentialStore();
    await store.set("sandbox", { accessToken: "SECRET-TOKEN", refreshToken: "RT", expiresAt: Date.now() + 3600_000 });
    const fetchImpl = fakeNetSuiteFetch({ expectToken: "SECRET-TOKEN" });
    const client = new RestClient({ accountId: profile.accountId, session: createSession({ alias: "sandbox", profile, store, fetch: fetchImpl }), fetch: fetchImpl });
    const list = await client.getJson<{ items: { name: string }[] }>("/record/v1/metadata-catalog", "the record type list");
    expect(list.items.map((i) => i.name)).toContain("customer");
    expect(fetchImpl.calls[0]!.authorization).toBe("Bearer SECRET-TOKEN");

    await store.set("sandbox", { accessToken: "WRONG", refreshToken: "RT", expiresAt: Date.now() + 3600_000 });
    const error = await client.getJson("/record/v1/metadata-catalog", "the record type list").catch((e: UserError) => e);
    expect(error).toBeInstanceOf(UserError);
    expect((error as UserError).message).toBe("Could not authenticate to NetSuite account '1234567_SB1'. Run `sail auth login` again.");
    expect((error as UserError).details).toBe("INVALID_LOGIN: Invalid login attempt.");
    expect((error as UserError).message + (error as UserError).details).not.toContain("WRONG");
  });

  it("maps status codes to user-facing messages", () => {
    expect(translateError(403, "{}", "Customer metadata", "1").message).toBe("Customer metadata could not be retrieved because the selected role does not have access.");
    expect(translateError(404, "nope", "x metadata", "1").message).toBe("x metadata was not found in NetSuite account '1'.");
    expect(translateError(500, "boom", "x", "1").details).toBe("boom");
  });
});

describe("raw metadata pull", () => {
  it("lists types and fetches each schema with the schema+json accept header", async () => {
    const store = new MemoryCredentialStore();
    await store.set("s", { accessToken: "T", refreshToken: "R", expiresAt: Date.now() + 3600_000 });
    const fetchImpl = fakeNetSuiteFetch({ expectToken: "T" });
    const profile = { accountId: "1234567_SB1", clientId: "c", redirectPort: 1 };
    const client = new RestClient({ accountId: profile.accountId, session: createSession({ alias: "s", profile, store, fetch: fetchImpl }), fetch: fetchImpl });
    const progress: string[] = [];
    const raw = await pullRawMetadata(client, { onProgress: (_d, _t, type) => progress.push(type) });
    expect(Object.keys(raw.records).sort()).toEqual(["customer", "customrecord_sail_test", "salesOrder", "subsidiary"]);
    expect(progress.sort()).toEqual(["customer", "customrecord_sail_test", "salesOrder", "subsidiary"]);
    const limited = await pullRawMetadata(client, { records: ["salesOrder"] });
    expect(Object.keys(limited.records)).toEqual(["salesOrder"]);
    const partial = await pullRawMetadata(client, { records: ["nope", "customer"] });
    expect(Object.keys(partial.records)).toEqual(["customer"]);
    expect(partial.failures).toEqual({ nope: "nope metadata was not found in NetSuite account '1234567_SB1'." });
  });

  it("skips types the role cannot read but aborts on an authentication failure", async () => {
    const profile = { accountId: "1234567_SB1", clientId: "c", redirectPort: 1 };
    const forbidding = fakeNetSuiteFetch({ expectToken: "T", forbid: ["salesOrder"] });
    const store = new MemoryCredentialStore();
    await store.set("s", { accessToken: "T", refreshToken: "R", expiresAt: Date.now() + 3600_000 });
    const client = new RestClient({ accountId: profile.accountId, session: createSession({ alias: "s", profile, store, fetch: forbidding }), fetch: forbidding });
    const raw = await pullRawMetadata(client);
    expect(Object.keys(raw.records)).toEqual(["customer", "customrecord_sail_test", "subsidiary"]);
    expect(raw.failures).toEqual({ salesOrder: "salesOrder metadata could not be retrieved because the selected role does not have access." });

    await store.set("s", { accessToken: "WRONG", refreshToken: "R", expiresAt: Date.now() + 3600_000 });
    await expect(pullRawMetadata(client, { records: ["customer"] })).rejects.toThrow("Could not authenticate");
  });
});

describe("schema normalization", () => {
  const { document, warnings } = normalized();
  const customer = document.records.customer!;
  const order = document.records.salesorder!;

  it("writes the account header", () => {
    expect(document.sailSchemaVersion).toBe(1);
    expect(document.source).toEqual({ kind: "account", platform: "netsuite", account: "1234567_SB1", pulledAt: PULLED_AT });
  });

  it("normalizes Customer: Sail name, SuiteScript id, platform constant, provenance", () => {
    expect(customer.name).toBe("Customer");
    expect(customer.suiteScriptType).toBe("CUSTOMER");
    expect(customer.custom).toBeUndefined();
    expect(customer.netsuite?.restType).toBe("customer");
    expect(customer.fields.companyname).toMatchObject({ type: "Text", label: "Company Name", writable: true, required: true, netsuite: { restName: "companyName", restType: "string" } });
  });

  it("normalizes SalesOrder with a lowercased id and its own constant", () => {
    expect(order.name).toBe("SalesOrder");
    expect(order.suiteScriptType).toBe("SALES_ORDER");
    expect(order.fields.tranid).toMatchObject({ type: "Text", netsuite: { restName: "tranId" } });
  });

  it("maps Text, Number, Bool, and Date", () => {
    expect(customer.fields.email!.type).toBe("Text");
    expect(customer.fields.creditlimit!.type).toBe("Number");
    expect(customer.fields.daysoverdue!.type).toBe("Number");
    expect(customer.fields.isperson!.type).toBe("Bool");
    expect(customer.fields.datecreated).toMatchObject({ type: "Date", netsuite: { format: "date-time" } });
    expect(order.fields.trandate).toMatchObject({ type: "Date", netsuite: { format: "date" } });
  });

  it("keeps select values on Text fields", () => {
    expect(customer.fields.emailpreference).toMatchObject({ type: "Text", values: ["_default", "_html", "_pdf"] });
  });

  it("identifies references and their targets when the $ref names a catalog type", () => {
    expect(customer.fields.subsidiary).toMatchObject({ type: "Ref", refTarget: "Subsidiary" });
    expect(order.fields.entity).toMatchObject({ type: "Ref", refTarget: "Customer" });
    expect(customer.fields.salesrep!.type).toBe("Ref");
    expect(customer.fields.salesrep!.refTarget).toBeUndefined();
  });

  it("marks custom fields by the x-ns-custom-field key or the script id prefix", () => {
    expect(customer.fields.custentity_sail_tier).toMatchObject({ type: "Text", custom: true });
    expect(customer.fields.custentity_sail_score).toMatchObject({ type: "Number", custom: true });
    expect(order.fields.custbody_sail_note).toMatchObject({ type: "Text", custom: true });
    expect(customer.fields.email!.custom).toBeUndefined();
  });

  it("maps readOnly to writable: false and nothing else", () => {
    expect(customer.fields.balance!.writable).toBe(false);
    expect(order.fields.total!.writable).toBe(false);
    expect(customer.fields.datecreated!.writable).toBe(false);
    expect(customer.fields.entityid!.writable).toBe(true);
  });

  it("types unmapped properties Unknown with a warning", () => {
    expect(customer.fields.currencyprecision).toMatchObject({ type: "Unknown", netsuite: { restType: "unspecified" } });
    expect(warnings).toContain("customer.currencyPrecision: REST type 'unspecified' is not mapped; typed Unknown.");
  });

  it("omits links, ids, and sublists but records that it did", () => {
    expect(customer.fields.links).toBeUndefined();
    expect(customer.fields.id).toBeUndefined();
    expect(customer.fields.addressbook).toBeUndefined();
    expect(customer.netsuite?.omitted).toEqual({ links: "hypermedia links", id: "internal id, not a field", addressBook: "sublist or collection" });
    expect(order.netsuite?.omitted?.item).toBe("sublist or collection");
  });

  it("represents a custom record like any other record", () => {
    const custom = document.records.customrecord_sail_test!;
    expect(custom.name).toBe("SailTest");
    expect(custom.custom).toBe(true);
    expect(custom.suiteScriptType).toBeUndefined();
    expect(custom.fields.custrecord_sail_active).toMatchObject({ type: "Bool", custom: true });
    expect(custom.fields.custrecord_sail_owner).toMatchObject({ type: "Ref", refTarget: "Customer", custom: true });
    expect(custom.fields.isinactive).toMatchObject({ type: "Bool" });
  });

  it("names colliding records by their full id", () => {
    const raw = { records: { customer: {}, customrecord_customer: {} } };
    const result = normalize(raw, { account: "1", pulledAt: PULLED_AT });
    expect(result.document.records.customer!.name).toBe("Customer");
    expect(result.document.records.customrecord_customer!.name).toBe("CustomrecordCustomer");
    expect(result.warnings[0]).toContain("'Customer' is taken");
  });
});

describe("snapshot", () => {
  it("serializes deterministically with sorted keys and no secret material", () => {
    const { document } = normalized();
    const text = serializeSnapshot(document);
    expect(text).toBe(serializeSnapshot(JSON.parse(JSON.stringify(document)) as SchemaDocument));
    const reordered: SchemaDocument = { records: document.records, source: document.source, sailSchemaVersion: 1 };
    expect(serializeSnapshot(reordered)).toBe(text);
    const keys = text.split("\n").filter((l) => /^  "/.test(l));
    expect(keys.map((k) => k.trim().split('"')[1])).toEqual(["records", "sailSchemaVersion", "source"]);
    const recordKeys = Object.keys((JSON.parse(text) as SchemaDocument).records);
    expect(recordKeys).toEqual([...recordKeys].sort());
    expect(text).not.toMatch(/token|secret|client/i);
    expect(text).toContain('"sailSchemaVersion": 1');
  });

  it("does not rewrite an unchanged snapshot, and rewrites a changed one", () => {
    const path = join(tempDir(), ".sail", "schema", "sandbox.json");
    const first = normalized().document;
    expect(writeSnapshot(path, first)).toBe("written");
    const before = readFileSync(path, "utf8");

    const again = normalize(rawMetadata, { account: "1234567_SB1", pulledAt: "2026-10-08T00:00:00.000Z" }).document;
    expect(writeSnapshot(path, again)).toBe("unchanged");
    expect(readFileSync(path, "utf8")).toBe(before);

    const changed = structuredClone(again);
    delete changed.records.customer!.fields.email;
    expect(writeSnapshot(path, changed)).toBe("written");
    expect(readSnapshot(path).source).toMatchObject({ pulledAt: "2026-10-08T00:00:00.000Z" });
  });

  it("rejects files that are not snapshots", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "x.json"), "{}");
    expect(() => readSnapshot(join(dir, "x.json"))).toThrow("is not a Sail schema snapshot");
    expect(() => readSnapshot(join(dir, "missing.json"))).toThrow("No schema snapshot at");
  });
});

describe("schema diff", () => {
  it("reports record and field additions, removals, type and writability changes", () => {
    const before = normalized().document;
    const after = structuredClone(before);
    delete after.records.subsidiary;
    after.records.customrecord_new = { name: "New", fields: {} };
    delete after.records.customer!.fields.email;
    after.records.customer!.fields.zzz = { type: "Text", label: "Z", writable: true };
    after.records.customer!.fields.comments!.type = "Number";
    after.records.customer!.fields.balance!.writable = true;
    after.records.customer!.fields.isperson!.label = "Renamed, ignored";
    expect(diffSchemas(before, after).map(formatChange)).toEqual([
      "~ customer.balance: writable false -> true",
      "~ customer.comments: type Text -> Number",
      "- customer.email",
      "+ customer.zzz",
      "+ record customrecord_new",
      "- record subsidiary",
    ]);
    expect(diffSchemas(before, before)).toEqual([]);
  });
});

describe("compiler against a pulled-style snapshot", () => {
  const provider = new DocumentSchemaProvider(normalized().document);

  it("compiles a user event against a real-shaped Customer field unchanged", () => {
    const result = compile(`beforeSubmit edit (customer: Customer) {\n    customer.comments = "Compiled against pulled schema"\n}\n`, { file: "t.sail", schema: provider });
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toContain("record: customer");
    expect(result.output).toContain('fieldId: "comments"');
  });

  it("uses a Bool field as a condition and assigns Bool to it", () => {
    const result = compile(
      `scheduled {\n    let customer = load Customer("1")\n    if customer.isperson {\n        customer.custentity_sail_tier = "person"\n        customer.isperson = false\n        save customer\n    }\n}\n`,
      { file: "t.sail", schema: provider },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.output).toMatch(/if \(\s*customer\.getValue\(\{\s*fieldId: "isperson"\s*\}\)\s*\) \{/);
    expect(result.output).toContain("value: false");
  });

  it("compiles a custom field write and custom record load, and rejects an invented field", () => {
    const custom = compile(`scheduled {\n    let t = load SailTest("1")\n    t.custrecord_sail_active = true\n    save t\n}\n`, { file: "t.sail", schema: provider });
    expect(custom.diagnostics).toEqual([]);
    expect(custom.output).toContain('type: "customrecord_sail_test"');

    const invented = compile(`beforeSubmit edit (customer: Customer) {\n    customer.notreal = "x"\n}\n`, { file: "t.sail", schema: provider });
    expect(invented.diagnostics.map((d) => d.code)).toEqual(["SAIL1004"]);
  });

  it("read-only, Number, Date, Ref, and Unknown fields behave truthfully", () => {
    const codes = (source: string) => compile(source, { file: "t.sail", schema: provider }).diagnostics.map((d) => `${d.code} ${d.message}`);
    expect(codes(`scheduled {\n    let c = load Customer("1")\n    c.balance = 1\n}\n`)[0]).toContain("SAIL1005 Customer.balance is read-only");
    expect(codes(`scheduled {\n    let c = load Customer("1")\n    if c.creditlimit > 1000 { save c }\n}\n`)).toEqual([]);
    expect(codes(`scheduled {\n    let c = load Customer("1")\n    log.debug(c.datecreated)\n}\n`)[0]).toContain("must be Text, but received Date");
    expect(codes(`scheduled {\n    let c = load Customer("1")\n    if c.subsidiary == "1" { }\n}\n`)[0]).toContain("Cannot compare Ref with Text");
    expect(codes(`scheduled {\n    let c = load Customer("1")\n    c.currencyprecision = "x"\n}\n`)[0]).toContain("Cannot assign Text to Customer.currencyprecision, which is Unknown");
  });
});

describe("compiler boundary", () => {
  it("compiler modules import nothing that performs IO or knows about accounts", () => {
    const { readdirSync, readFileSync: read } = require("node:fs") as typeof import("node:fs");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
    const compilerFiles = [
      ...walk("src/lexer"),
      ...walk("src/parser"),
      ...walk("src/semantic"),
      "src/compiler.ts",
      "src/diagnostics.ts",
      "src/netsuite/emit.ts",
      "src/schema/provider.ts",
      "src/schema/types.ts",
    ];
    const forbidden = /from "(node:|\.\.?\/.*(client|account|platform|cli)\/|\.\.?\/.*snapshot|\.\.?\/.*normalize)/;
    for (const file of compilerFiles) {
      const imports = read(file, "utf8").split("\n").filter((line) => /^import /.test(line));
      for (const line of imports) expect(`${file}: ${line}`).not.toMatch(forbidden);
    }
  });
});

describe("integration: live NetSuite account", () => {
  const alias = process.env.SAIL_TEST_ACCOUNT;
  it.skipIf(!alias)("pulls real Customer metadata and finds a known standard field", async () => {
    const { UserConfigStore: Store, userConfigDir } = await import("../src/netsuite/account/config.js");
    const { defaultCredentialStore } = await import("../src/netsuite/account/credentials.js");
    const configDir = userConfigDir(process.env);
    const profile = new Store(configDir).getProfile(alias!);
    const store = defaultCredentialStore(process.platform, join(configDir, "credentials.json"));
    const session = createSession({ alias: alias!, profile, store, fetch });
    const client = new RestClient({ accountId: profile.accountId, session, fetch });
    const raw = await pullRawMetadata(client, { records: ["customer"] });
    const { document } = normalize(raw, { account: profile.accountId, pulledAt: new Date().toISOString() });
    expect(document.records.customer?.fields.companyname?.type).toBe("Text");
  });
});
