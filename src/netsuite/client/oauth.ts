/**
 * NetSuite OAuth 2.0 authorization code grant with PKCE, as a public client.
 *
 * Bootstrap NetSuite requires before this can work (there is no way around
 * it; the CLI prints these steps when login fails with an unknown client):
 *
 *   1. Setup > Company > Enable Features > SuiteCloud > "OAuth 2.0".
 *   2. Setup > Integration > Manage Integrations > New: enable
 *      "Authorization Code Grant", enable "Public Client" (PKCE), set the
 *      redirect URI to http://localhost:<port>/callback, scope
 *      "REST Web Services". Save and copy the client id.
 *   3. The logging-in user's role needs the "REST Web Services" and
 *      "Log in using OAuth 2.0 Access Tokens" permissions, plus view access
 *      to the records whose metadata is pulled.
 *
 * The client id is then given to `sail account add`. Tokens: the access
 * token lives one hour; NetSuite's refresh token for this grant lives seven
 * days, after which `sail auth login` must run again.
 *
 * Network access goes through an injected `fetch` so the flow is testable.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { UserError } from "../../errors.js";
import type { StoredCredentials } from "../account/credentials.js";
import { authorizeUrl, tokenUrl } from "../account/url.js";

export const OAUTH_SCOPE = "rest_webservices";

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function pkcePair(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** NetSuite requires `state` to be between 22 and 1024 characters. */
export function newState(): string {
  return randomBytes(24).toString("base64url");
}

export function redirectUri(port: number): string {
  return `http://localhost:${port}/callback`;
}

export function buildAuthorizeUrl(options: {
  accountId: string;
  clientId: string;
  port: number;
  state: string;
  challenge: string;
}): string {
  const url = new URL(authorizeUrl(options.accountId));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", redirectUri(options.port));
  url.searchParams.set("scope", OAUTH_SCOPE);
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface CallbackResult {
  code: string;
  /** NetSuite appends the account id, user (entity), and role to the callback. */
  company?: string;
  entity?: string;
  role?: string;
}

const CALLBACK_PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family: system-ui; margin: 3rem"><h1>${title}</h1><p>${body}</p></body>`;

/**
 * Listens on the loopback interface for NetSuite's redirect. Resolves with
 * the authorization code once a request with the expected state arrives.
 * `port` 0 picks a free port (tests); `onListening` receives the real one.
 */
export function waitForCallback(options: {
  port: number;
  expectedState: string;
  timeoutMs: number;
  onListening?: (port: number) => void;
}): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (error) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(CALLBACK_PAGE("Sail: login refused", `NetSuite reported: ${error}. You can close this tab.`));
        finish(() => reject(new UserError(`NetSuite refused the login: ${error}`)));
        return;
      }
      if (!code || state !== options.expectedState) {
        response.writeHead(400, { "content-type": "text/html" });
        response.end(CALLBACK_PAGE("Sail: unexpected callback", "This callback did not match the login in progress."));
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(CALLBACK_PAGE("Sail: logged in", "You can close this tab and return to the terminal."));
      finish(() =>
        resolve({
          code,
          ...(url.searchParams.has("company") ? { company: url.searchParams.get("company")! } : {}),
          ...(url.searchParams.has("entity") ? { entity: url.searchParams.get("entity")! } : {}),
          ...(url.searchParams.has("role") ? { role: url.searchParams.get("role")! } : {}),
        }),
      );
    });

    const timer = setTimeout(() => {
      finish(() => reject(new UserError("Timed out waiting for the browser login to complete.")));
    }, options.timeoutMs);

    const finish = (settle: () => void): void => {
      clearTimeout(timer);
      server.close();
      settle();
    };

    server.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "EADDRINUSE") {
        reject(new UserError(`Port ${options.port} is in use. Sail needs it for the login redirect; free it or configure another port with \`sail account add\`.`));
      } else {
        reject(error);
      }
    });
    server.listen(options.port, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") options.onListening?.(address.port);
    });
  });
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function requestToken(
  accountId: string,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
  failure: string,
): Promise<StoredCredentials> {
  let response: Response;
  try {
    response = await fetchImpl(tokenUrl(accountId), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(body).toString(),
    });
  } catch (error) {
    throw new UserError(`${failure}: could not reach ${tokenUrl(accountId)}.`, String(error));
  }

  let payload: TokenResponse = {};
  try {
    payload = (await response.json()) as TokenResponse;
  } catch {
    // Non-JSON body: fall through to the status-based message.
  }

  if (!response.ok || !payload.access_token || !payload.refresh_token) {
    const reason = payload.error ? `${payload.error}${payload.error_description ? ` (${payload.error_description})` : ""}` : `HTTP ${response.status}`;
    throw new UserError(`${failure}: ${reason}.`, undefined);
  }

  const expiresIn = payload.expires_in ?? 3600;
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

export function exchangeCode(
  options: { accountId: string; clientId: string; port: number; code: string; verifier: string },
  fetchImpl: typeof fetch,
): Promise<StoredCredentials> {
  return requestToken(
    options.accountId,
    {
      grant_type: "authorization_code",
      code: options.code,
      redirect_uri: redirectUri(options.port),
      code_verifier: options.verifier,
      client_id: options.clientId,
    },
    fetchImpl,
    `Could not authenticate to NetSuite account '${options.accountId}'`,
  );
}

export function refreshAccessToken(
  options: { accountId: string; clientId: string; refreshToken: string },
  fetchImpl: typeof fetch,
): Promise<StoredCredentials> {
  return requestToken(
    options.accountId,
    { grant_type: "refresh_token", refresh_token: options.refreshToken, client_id: options.clientId },
    fetchImpl,
    `Could not refresh the login for NetSuite account '${options.accountId}'`,
  );
}

export interface LoginOptions {
  accountId: string;
  clientId: string;
  port: number;
  fetch: typeof fetch;
  /** Opens the URL in a browser. The URL is also printed, so this may do nothing. */
  openBrowser: (url: string) => Promise<void>;
  log: (line: string) => void;
  timeoutMs?: number;
}

/** The whole interactive flow: browser authorization, loopback callback, code exchange. */
export async function login(options: LoginOptions): Promise<{ credentials: StoredCredentials; callback: CallbackResult }> {
  const pkce = pkcePair();
  const state = newState();
  const url = buildAuthorizeUrl({ ...options, state, challenge: pkce.challenge });

  const callback = waitForCallback({
    port: options.port,
    expectedState: state,
    timeoutMs: options.timeoutMs ?? 5 * 60 * 1000,
  });
  options.log(`Opening NetSuite login in your browser. If it does not open, visit:\n\n  ${url}\n`);
  await options.openBrowser(url);
  const result = await callback;
  const credentials = await exchangeCode({ ...options, code: result.code, verifier: pkce.verifier }, options.fetch);
  return { credentials, callback: result };
}
