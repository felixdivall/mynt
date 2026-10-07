/**
 * Authenticated GET against SuiteTalk REST, with NetSuite's error bodies
 * translated into UserErrors. Requests carry the bearer token; errors and
 * details never include request headers, so a token cannot leak through a
 * message.
 */
import { UserError } from "../../errors.js";
import { restBaseUrl } from "../account/url.js";
import type { Session } from "./session.js";

interface NetSuiteErrorBody {
  title?: string;
  status?: number;
  "o:errorDetails"?: { detail?: string; "o:errorCode"?: string }[];
}

/** A translated HTTP failure. `status` lets callers decide what is fatal (401) and what is skippable (403, 404). */
export class NetSuiteHttpError extends UserError {
  constructor(
    readonly status: number,
    message: string,
    details?: string,
  ) {
    super(message, details);
    this.name = "NetSuiteHttpError";
  }
}

export class RestClient {
  constructor(
    private readonly options: { accountId: string; session: Session; fetch: typeof fetch },
  ) {}

  /** `what` names the thing being fetched, for error messages ("Customer metadata"). */
  async getJson<T>(path: string, what: string, accept = "application/json"): Promise<T> {
    const url = `${restBaseUrl(this.options.accountId)}${path}`;
    const token = await this.options.session.accessToken();

    let response: Response;
    try {
      response = await this.options.fetch(url, { headers: { authorization: `Bearer ${token}`, accept } });
    } catch (error) {
      throw new UserError(`Could not reach NetSuite account '${this.options.accountId}' to fetch ${what}.`, String(error));
    }

    if (response.ok) return (await response.json()) as T;

    const text = await response.text();
    throw translateError(response.status, text, what, this.options.accountId);
  }
}

export function translateError(status: number, body: string, what: string, accountId: string): NetSuiteHttpError {
  let details = body.slice(0, 2000);
  try {
    const parsed = JSON.parse(body) as NetSuiteErrorBody;
    const items = parsed["o:errorDetails"]?.map((d) => [d["o:errorCode"], d.detail].filter(Boolean).join(": "));
    if (items && items.length > 0) details = items.join("\n");
  } catch {
    // Not JSON; keep the raw text as details.
  }

  const make = (message: string) => new NetSuiteHttpError(status, message, details);
  switch (status) {
    case 401:
      return make(`Could not authenticate to NetSuite account '${accountId}'. Run \`sail auth login\` again.`);
    case 403:
      return make(`${what} could not be retrieved because the selected role does not have access.`);
    case 404:
      return make(`${what} was not found in NetSuite account '${accountId}'.`);
    case 429:
      return make(`NetSuite account '${accountId}' is rate limiting requests; try again shortly.`);
    default:
      return make(`NetSuite returned HTTP ${status} while fetching ${what}.`);
  }
}
