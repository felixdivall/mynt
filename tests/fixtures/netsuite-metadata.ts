/**
 * Raw SuiteTalk REST metadata-catalog responses, in the JSON Schema shape
 * NetSuite serves with `Accept: application/schema+json`.
 *
 * This fixture is a reconstruction from NetSuite's documentation and from
 * the shapes the normalizer must handle, not a capture from an account.
 * `sail schema pull --keep-raw` writes real responses to
 * .sail/schema/raw/<alias>/ so this fixture can be replaced by captures.
 */
import type { RawMetadata } from "../../src/netsuite/client/metadata.js";

const nsResource = {
  type: "object",
  properties: {
    id: { title: "Internal identifier", type: "string" },
    refName: { title: "Reference Name", type: "string" },
    externalId: { title: "External identifier", type: "string" },
    links: { type: "array", items: { type: "object" } },
  },
  nullable: true,
};

export const rawMetadata: RawMetadata = {
  records: {
    customer: {
      type: "object",
      properties: {
        links: { title: "Links", type: "array", items: { type: "object" } },
        id: { title: "Internal ID", type: "string", nullable: true },
        entityId: { title: "ID", type: "string", nullable: true },
        companyName: { title: "Company Name", type: "string", nullable: true },
        email: { title: "Email", type: "string", nullable: true },
        comments: { title: "Comments", type: "string", nullable: true },
        isPerson: { title: "Individual", type: "boolean", nullable: true },
        creditLimit: { title: "Credit Limit", type: "number", format: "double", nullable: true },
        daysOverdue: { title: "Days Overdue", type: "integer", format: "int64", nullable: true },
        balance: { title: "Balance", type: "number", format: "double", readOnly: true, nullable: true },
        dateCreated: { title: "Date Created", type: "string", format: "date-time", readOnly: true, nullable: true },
        subsidiary: { ...nsResource, title: "Subsidiary", $ref: "/services/rest/record/v1/metadata-catalog/subsidiary" },
        salesRep: { ...nsResource, title: "Sales Rep" },
        emailPreference: { title: "Email Preference", type: "string", enum: ["_pdf", "_html", "_default"], nullable: true },
        custentity_sail_tier: {
          title: "Sail Tier",
          type: "string",
          nullable: true,
          "x-ns-custom-field": "custentity_sail_tier",
        },
        custentity_sail_score: { title: "Sail Score", type: "number", format: "double", nullable: true },
        addressBook: { title: "Address Book", type: "object", properties: { items: { type: "array" } }, nullable: true },
        shippingItem: { ...nsResource, title: "Shipping Item", nullable: true },
        currencyPrecision: { title: "Currency Precision", nullable: true },
      },
      required: ["companyName"],
    },
    salesOrder: {
      type: "object",
      properties: {
        links: { type: "array", items: { type: "object" } },
        id: { title: "Internal ID", type: "string", nullable: true },
        tranId: { title: "Order #", type: "string", nullable: true },
        memo: { title: "Memo", type: "string", nullable: true },
        total: { title: "Total", type: "number", format: "double", readOnly: true, nullable: true },
        tranDate: { title: "Date", type: "string", format: "date", nullable: true },
        entity: { ...nsResource, title: "Customer", $ref: "/services/rest/record/v1/metadata-catalog/customer" },
        item: { title: "Items", type: "object", properties: { items: { type: "array" } }, nullable: true },
        custbody_sail_note: { title: "Sail Note", type: "string", nullable: true },
      },
    },
    subsidiary: {
      type: "object",
      properties: {
        links: { type: "array", items: { type: "object" } },
        id: { title: "Internal ID", type: "string", nullable: true },
        name: { title: "Name", type: "string", nullable: true },
      },
    },
    customrecord_sail_test: {
      type: "object",
      properties: {
        links: { type: "array", items: { type: "object" } },
        id: { title: "Internal ID", type: "string", nullable: true },
        name: { title: "Name", type: "string", nullable: true },
        isInactive: { title: "Inactive", type: "boolean", nullable: true },
        custrecord_sail_active: { title: "Active", type: "boolean", nullable: true },
        custrecord_sail_owner: { ...nsResource, title: "Owner", $ref: "/services/rest/record/v1/metadata-catalog/customer" },
      },
    },
  },
};

/** The record type list the catalog returns before the per-type schemas. */
export const rawRecordTypeList = {
  items: Object.keys(rawMetadata.records).map((name) => ({ name, links: [] })),
};

/** A `fetch` that serves the fixture for the metadata catalog and token endpoints. */
export function fakeNetSuiteFetch(
  options: { expectToken?: string; tokenResponses?: Record<string, unknown>[]; forbid?: string[] } = {},
): typeof fetch & {
  calls: { url: string; authorization: string | undefined }[];
} {
  const calls: { url: string; authorization: string | undefined }[] = [];
  const tokenResponses = [...(options.tokenResponses ?? [])];

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get("authorization") ?? undefined });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    if (url.endsWith("/services/rest/auth/oauth2/v1/token")) {
      const next = tokenResponses.shift();
      if (!next) return json({ error: "invalid_grant" }, 400);
      return json(next);
    }
    if (options.expectToken !== undefined && headers.get("authorization") !== `Bearer ${options.expectToken}`) {
      return json({ title: "Unauthorized", status: 401, "o:errorDetails": [{ detail: "Invalid login attempt.", "o:errorCode": "INVALID_LOGIN" }] }, 401);
    }
    const match = /\/services\/rest\/record\/v1\/metadata-catalog(?:\/([^/?]+))?$/.exec(url);
    if (!match) return json({ title: "Not Found", status: 404 }, 404);
    if (!match[1]) return json(rawRecordTypeList);
    if (headers.get("accept") !== "application/schema+json") return json({ title: "Not Acceptable", status: 406 }, 406);
    const type = decodeURIComponent(match[1]);
    if (options.forbid?.includes(type)) return json({ title: "Forbidden", status: 403, "o:errorDetails": [{ detail: "Insufficient permission." }] }, 403);
    const schema = rawMetadata.records[type];
    if (!schema) return json({ title: "Not Found", status: 404, "o:errorDetails": [{ detail: "The record type does not exist." }] }, 404);
    return json(schema);
  }) as typeof fetch & { calls: typeof calls };
  impl.calls = calls;
  return impl;
}
