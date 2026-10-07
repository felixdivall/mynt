import { UserError } from "../../errors.js";
import type { ParsedArgs } from "../args.js";
import type { CliContext } from "../context.js";
import { resolveAlias } from "./account.js";

const USAGE = `Usage:
  sail auth login [alias]
  sail auth logout [alias]
`;

export async function runAuth(args: ParsedArgs, context: CliContext): Promise<number> {
  const [sub, given] = args.positional;
  if (sub !== "login" && sub !== "logout") throw new UserError(USAGE);
  const alias = resolveAlias(given, context);

  if (sub === "logout") {
    const removed = await context.credentialStore.delete(alias);
    context.stdout(removed ? `sail: logged out of '${alias}'.\n` : `sail: '${alias}' was not logged in.\n`);
    return 0;
  }

  const profile = context.userConfig.getProfile(alias);
  const { credentials, callback } = await context.login({
    accountId: profile.accountId,
    clientId: profile.clientId,
    port: profile.redirectPort,
    fetch: context.fetch,
    openBrowser: context.openBrowser,
    log: (line) => context.stderr(line + "\n"),
  });

  if (callback.company && callback.company.toUpperCase() !== profile.accountId.toUpperCase()) {
    throw new UserError(
      `The browser login was for account ${callback.company}, but '${alias}' is configured as ${profile.accountId}. Nothing was stored.`,
    );
  }

  await context.credentialStore.set(alias, credentials);
  const role = callback.role ? ` with role ${callback.role}` : "";
  context.stdout(`sail: logged in to '${alias}' (${profile.accountId})${role}. Tokens stored in the ${context.credentialStore.description}.\n`);
  if (context.credentialStore.warning) context.stderr(`sail: warning: ${context.credentialStore.warning}\n`);
  return 0;
}
