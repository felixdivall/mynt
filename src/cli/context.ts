/**
 * Everything a command needs from the outside world, so tests can run the
 * CLI with fakes: no real network, keychain, browser, or home directory.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { UserConfigStore, userConfigDir } from "../netsuite/account/config.js";
import { defaultCredentialStore, type CredentialStore } from "../netsuite/account/credentials.js";
import { login, type LoginOptions } from "../netsuite/client/oauth.js";

export interface CliContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetch: typeof fetch;
  prompt: (question: string) => Promise<string>;
  openBrowser: (url: string) => Promise<void>;
  credentialStore: CredentialStore;
  userConfig: UserConfigStore;
  /** The interactive login flow; replaced in tests. */
  login: (options: LoginOptions) => ReturnType<typeof login>;
  now: () => Date;
}

export function defaultContext(): CliContext {
  const configDir = userConfigDir(process.env);
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    fetch: globalThis.fetch,
    prompt: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return (await rl.question(question)).trim();
      } finally {
        rl.close();
      }
    },
    openBrowser: async (url) => {
      const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
      await new Promise<void>((resolve) => execFile(command, args, () => resolve()));
    },
    credentialStore: defaultCredentialStore(process.platform, join(configDir, "credentials.json")),
    userConfig: new UserConfigStore(configDir),
    login,
    now: () => new Date(),
  };
}
