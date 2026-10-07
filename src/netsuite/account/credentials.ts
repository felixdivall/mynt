/**
 * Where OAuth tokens live. The interface is the boundary; the CLI picks an
 * implementation per platform:
 *
 *   macOS     the login keychain, through the `security` tool. Secrets are
 *             passed on stdin, never on the command line.
 *   others    a JSON file in the user config directory with mode 0600.
 *             This is a development fallback and the CLI says so on every
 *             use; a Secret Service / Credential Manager implementation
 *             belongs behind the same interface.
 *
 * No implementation is ever given a project path.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface StoredCredentials {
  accessToken: string;
  refreshToken: string;
  /** Access token expiry, epoch milliseconds. */
  expiresAt: number;
}

export interface CredentialStore {
  /** Human description for `account list` and warnings, e.g. "macOS keychain". */
  readonly description: string;
  /** Set when the store is a fallback the user should know about. */
  readonly warning?: string;
  get(alias: string): Promise<StoredCredentials | undefined>;
  set(alias: string, credentials: StoredCredentials): Promise<void>;
  /** Returns whether anything was stored. */
  delete(alias: string): Promise<boolean>;
}

export class MemoryCredentialStore implements CredentialStore {
  readonly description = "in-memory store";
  private readonly items = new Map<string, StoredCredentials>();

  async get(alias: string): Promise<StoredCredentials | undefined> {
    return this.items.get(alias);
  }

  async set(alias: string, credentials: StoredCredentials): Promise<void> {
    this.items.set(alias, { ...credentials });
  }

  async delete(alias: string): Promise<boolean> {
    return this.items.delete(alias);
  }
}

export class FileCredentialStore implements CredentialStore {
  readonly description: string;
  readonly warning: string;

  constructor(readonly path: string) {
    this.description = `plaintext file ${path}`;
    this.warning =
      `Credentials are stored in ${path} (mode 0600). This is a development fallback: ` +
      `the file is readable by any process running as your user.`;
  }

  private readAll(): Record<string, StoredCredentials> {
    if (!existsSync(this.path)) return {};
    return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, StoredCredentials>;
  }

  private writeAll(all: Record<string, StoredCredentials>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (Object.keys(all).length === 0) {
      if (existsSync(this.path)) unlinkSync(this.path);
      return;
    }
    writeFileSync(this.path, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  }

  async get(alias: string): Promise<StoredCredentials | undefined> {
    return this.readAll()[alias];
  }

  async set(alias: string, credentials: StoredCredentials): Promise<void> {
    const all = this.readAll();
    all[alias] = credentials;
    this.writeAll(all);
  }

  async delete(alias: string): Promise<boolean> {
    const all = this.readAll();
    if (!(alias in all)) return false;
    delete all[alias];
    this.writeAll(all);
    return true;
  }
}

const KEYCHAIN_SERVICE = "mynt-netsuite";

function run(command: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`'${command}' is not available`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** macOS login keychain via /usr/bin/security. One generic password item per alias. */
export class KeychainCredentialStore implements CredentialStore {
  readonly description = "macOS keychain";

  async get(alias: string): Promise<StoredCredentials | undefined> {
    const result = await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", alias, "-w"]);
    if (result.code !== 0) return undefined; // 44 = item not found
    const encoded = result.stdout.trim();
    if (!encoded) return undefined;
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as StoredCredentials;
  }

  async set(alias: string, credentials: StoredCredentials): Promise<void> {
    // Base64 keeps the secret to one shell-safe token; `security -i` reads the
    // command from stdin so the secret never appears in a process listing.
    const encoded = Buffer.from(JSON.stringify(credentials), "utf8").toString("base64");
    const command = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${alias} -l "Mynt NetSuite login (${alias})" -w ${encoded}\n`;
    const result = await run("security", ["-i"], command);
    if (result.code !== 0) throw new Error(`Could not store credentials in the keychain: ${result.stderr.trim()}`);
  }

  async delete(alias: string): Promise<boolean> {
    const result = await run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", alias]);
    return result.code === 0;
  }
}

export function defaultCredentialStore(platform: NodeJS.Platform, fallbackPath: string): CredentialStore {
  return platform === "darwin" ? new KeychainCredentialStore() : new FileCredentialStore(fallbackPath);
}
