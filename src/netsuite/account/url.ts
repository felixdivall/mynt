import { UserError } from "../../errors.js";

/**
 * NetSuite account-specific hostnames. An account id such as `1234567_SB1`
 * appears in hostnames as `1234567-sb1`: lowercase, underscores as hyphens.
 * That rule is documented by NetSuite, not inferred.
 */
export function accountSlug(accountId: string): string {
  return accountId.toLowerCase().replace(/_/g, "-");
}

export function assertAccountId(accountId: string): void {
  if (!/^[A-Za-z0-9]+(_[A-Za-z0-9]+)?$/.test(accountId)) {
    throw new UserError(
      `'${accountId}' is not a NetSuite account id. Expected something like 1234567 or 1234567_SB1 ` +
        `(Setup > Company > Company Information > Account ID).`,
    );
  }
}

export function appBaseUrl(accountId: string): string {
  return `https://${accountSlug(accountId)}.app.netsuite.com`;
}

export function suiteTalkBaseUrl(accountId: string): string {
  return `https://${accountSlug(accountId)}.suitetalk.api.netsuite.com`;
}

export function authorizeUrl(accountId: string): string {
  return `${appBaseUrl(accountId)}/app/login/oauth2/authorize.nl`;
}

export function tokenUrl(accountId: string): string {
  return `${suiteTalkBaseUrl(accountId)}/services/rest/auth/oauth2/v1/token`;
}

export function restBaseUrl(accountId: string): string {
  return `${suiteTalkBaseUrl(accountId)}/services/rest`;
}
