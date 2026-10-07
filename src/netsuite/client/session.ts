/**
 * Supplies a valid access token for an alias, refreshing and persisting it
 * when the stored one is about to expire.
 */
import { UserError } from "../../errors.js";
import type { AccountProfile } from "../account/config.js";
import type { CredentialStore } from "../account/credentials.js";
import { refreshAccessToken } from "./oauth.js";

const REFRESH_MARGIN_MS = 60 * 1000;

export interface Session {
  accessToken(): Promise<string>;
}

export function createSession(options: {
  alias: string;
  profile: AccountProfile;
  store: CredentialStore;
  fetch: typeof fetch;
  now?: () => number;
}): Session {
  const now = options.now ?? Date.now;
  return {
    async accessToken() {
      const stored = await options.store.get(options.alias);
      if (!stored) {
        throw new UserError(`Not logged in to '${options.alias}'.\nRun \`mynt auth login ${options.alias}\`.`);
      }
      if (stored.expiresAt - REFRESH_MARGIN_MS > now()) return stored.accessToken;

      let refreshed;
      try {
        refreshed = await refreshAccessToken(
          { accountId: options.profile.accountId, clientId: options.profile.clientId, refreshToken: stored.refreshToken },
          options.fetch,
        );
      } catch (error) {
        const details = error instanceof UserError ? error.message : String(error);
        throw new UserError(`The login for '${options.alias}' has expired.\nRun \`mynt auth login ${options.alias}\`.`, details);
      }
      await options.store.set(options.alias, refreshed);
      return refreshed.accessToken;
    },
  };
}
