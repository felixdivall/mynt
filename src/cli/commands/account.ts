import { existsSync } from "node:fs";
import { UserError } from "../../errors.js";
import {
  DEFAULT_REDIRECT_PORT,
  findProjectRoot,
  readProjectConfig,
  schemaSnapshotPath,
  writeProjectConfig,
  type AccountProfile,
} from "../../netsuite/account/config.js";
import { assertAccountId } from "../../netsuite/account/url.js";
import { stringOption, type ParsedArgs } from "../args.js";
import type { CliContext } from "../context.js";

const USAGE = `Usage:
  mynt account add <alias> [--account-id <id>] [--client-id <id>] [--port <port>]
  mynt account list
  mynt account use <alias>
`;

export async function runAccount(args: ParsedArgs, context: CliContext): Promise<number> {
  const [sub, alias] = args.positional;
  switch (sub) {
    case "add":
      return add(alias, args, context);
    case "list":
      return list(context);
    case "use":
      return use(alias, context);
    default:
      throw new UserError(USAGE);
  }
}

async function ask(context: CliContext, given: string | undefined, question: string): Promise<string> {
  if (given) return given;
  const answer = await context.prompt(question);
  if (!answer) throw new UserError("Aborted: no value given.");
  return answer;
}

async function add(alias: string | undefined, args: ParsedArgs, context: CliContext): Promise<number> {
  if (!alias) throw new UserError(USAGE);
  if (!/^[A-Za-z0-9_-]+$/.test(alias)) throw new UserError(`'${alias}' is not a valid alias (letters, digits, '-' and '_' only).`);

  const accountId = await ask(context, stringOption(args.options, "account-id"), "NetSuite account id (e.g. 1234567_SB1): ");
  assertAccountId(accountId);
  const clientId = await ask(
    context,
    stringOption(args.options, "client-id"),
    "OAuth 2.0 client id of the Mynt integration record (Setup > Integration > Manage Integrations): ",
  );
  const portText = stringOption(args.options, "port") ?? String(DEFAULT_REDIRECT_PORT);
  const redirectPort = Number(portText);
  if (!Number.isInteger(redirectPort) || redirectPort < 1 || redirectPort > 65535) {
    throw new UserError(`'${portText}' is not a valid port.`);
  }

  const profile: AccountProfile = { accountId, clientId, redirectPort };
  context.userConfig.setProfile(alias, profile);
  context.stdout(
    `mynt: saved account '${alias}' (${accountId}) to ${context.userConfig.path}.\n` +
      `      The integration record's redirect URI must be http://localhost:${redirectPort}/callback.\n` +
      `      Next: mynt auth login ${alias}\n`,
  );
  return 0;
}

async function list(context: CliContext): Promise<number> {
  const { accounts } = context.userConfig.read();
  const root = findProjectRoot(context.cwd);
  const current = root ? readProjectConfig(root).account : undefined;
  const aliases = Object.keys(accounts).sort();
  if (aliases.length === 0) {
    context.stdout("mynt: no accounts configured. Run `mynt account add <alias>`.\n");
    return 0;
  }
  for (const alias of aliases) {
    const profile = accounts[alias]!;
    const loggedIn = (await context.credentialStore.get(alias)) !== undefined;
    const snapshot = root ? existsSync(schemaSnapshotPath(root, alias)) : false;
    const marks = [alias === current ? "default" : "", loggedIn ? "logged in" : "not logged in", snapshot ? "snapshot pulled" : "no snapshot"]
      .filter(Boolean)
      .join(", ");
    context.stdout(`${alias === current ? "*" : " "} ${alias}  ${profile.accountId}  (${marks})\n`);
  }
  context.stdout(`\ncredentials: ${context.credentialStore.description}\n`);
  return 0;
}

async function use(alias: string | undefined, context: CliContext): Promise<number> {
  if (!alias) throw new UserError(USAGE);
  context.userConfig.getProfile(alias);
  const root = findProjectRoot(context.cwd) ?? context.cwd;
  writeProjectConfig(root, { ...readProjectConfig(root), account: alias });
  context.stdout(`mynt: ${root}/mynt.json now selects account '${alias}'.\n`);
  return 0;
}

/** The alias from the argument or the project default. */
export function resolveAlias(given: string | undefined, context: CliContext): string {
  if (given) return given;
  const root = findProjectRoot(context.cwd);
  const alias = root ? readProjectConfig(root).account : undefined;
  if (!alias) {
    throw new UserError("No account given and mynt.json selects none.\nPass an alias, or run `mynt account use <alias>`.");
  }
  return alias;
}
