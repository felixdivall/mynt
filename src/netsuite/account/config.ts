/**
 * Configuration lives in three places with different trust levels:
 *
 *   project   `sail.json` at the project root. Committed. Holds only the
 *             default account alias; never an account id, client id, or
 *             secret. The schema snapshot path is derived from the alias.
 *   user      `$SAIL_CONFIG_DIR/config.json` (default ~/.config/sail).
 *             Per developer. Maps aliases to account id, OAuth client id,
 *             and loopback port. Not secret, but not project data either.
 *   secrets   the CredentialStore (see credentials.ts). Tokens only.
 *
 * Nothing here is imported by the compiler.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { UserError } from "../../errors.js";

export interface AccountProfile {
  /** NetSuite account id, e.g. `1234567_SB1`. */
  accountId: string;
  /** OAuth 2.0 client id of the Integration record used for login. Not a secret for a public (PKCE) client. */
  clientId: string;
  /** Loopback port registered as the Integration record's redirect URI. */
  redirectPort: number;
}

export interface UserConfig {
  accounts: Record<string, AccountProfile>;
}

export interface ProjectConfig {
  /** Default account alias for `auth`, `schema pull`, and schema resolution. */
  account?: string;
}

export const PROJECT_CONFIG_FILE = "sail.json";
export const DEFAULT_REDIRECT_PORT = 8484;

export function userConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SAIL_CONFIG_DIR) return env.SAIL_CONFIG_DIR;
  const base = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "sail");
}

/** Reads and writes the per-user account profiles. */
export class UserConfigStore {
  constructor(readonly dir: string) {}

  get path(): string {
    return join(this.dir, "config.json");
  }

  read(): UserConfig {
    if (!existsSync(this.path)) return { accounts: {} };
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<UserConfig>;
    return { accounts: parsed.accounts ?? {} };
  }

  write(config: UserConfig): void {
    // Serialize field by field so nothing but these three values can ever land in the file.
    const accounts: Record<string, AccountProfile> = {};
    for (const alias of Object.keys(config.accounts).sort()) {
      const profile = config.accounts[alias]!;
      accounts[alias] = { accountId: profile.accountId, clientId: profile.clientId, redirectPort: profile.redirectPort };
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify({ accounts }, null, 2) + "\n", { mode: 0o600 });
  }

  getProfile(alias: string): AccountProfile {
    const profile = this.read().accounts[alias];
    if (!profile) {
      throw new UserError(`No account profile named '${alias}'.\nRun \`sail account add ${alias}\`.`);
    }
    return profile;
  }

  setProfile(alias: string, profile: AccountProfile): void {
    const config = this.read();
    config.accounts[alias] = profile;
    this.write(config);
  }
}

/** Finds the directory containing `sail.json`, walking up from `from`. */
export function findProjectRoot(from: string): string | undefined {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, PROJECT_CONFIG_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function readProjectConfig(root: string): ProjectConfig {
  const path = join(root, PROJECT_CONFIG_FILE);
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ProjectConfig>;
  return typeof parsed.account === "string" ? { account: parsed.account } : {};
}

export function writeProjectConfig(root: string, config: ProjectConfig): void {
  const out: ProjectConfig = {};
  if (config.account !== undefined) out.account = config.account;
  writeFileSync(join(root, PROJECT_CONFIG_FILE), JSON.stringify(out, null, 2) + "\n");
}

/** Where `sail schema pull <alias>` writes the committed snapshot. */
export function schemaSnapshotPath(root: string, alias: string): string {
  return join(root, ".sail", "schema", `${alias}.json`);
}

/** Where `sail schema pull --keep-raw` writes NetSuite's raw responses. Git-ignored. */
export function rawMetadataDir(root: string, alias: string): string {
  return join(root, ".sail", "schema", "raw", alias);
}
