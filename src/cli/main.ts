import { basename } from "node:path";
import { UserError } from "../errors.js";
import { parseArgs } from "./args.js";
import { runAccount } from "./commands/account.js";
import { runAuth } from "./commands/auth.js";
import { runCompile } from "./commands/compile.js";
import { runLsp } from "./commands/lsp.js";
import { runSchema } from "./commands/schema.js";
import { defaultContext, type CliContext } from "./context.js";

const USAGE = `Usage:
  mynt check <file.mn> [--schema <snapshot.json>]   Parse, bind, and report diagnostics
  mynt build <file.mn> [--schema <snapshot.json>]   Compile to SuiteScript 2.1 next to the source file

  mynt account add <alias>      Configure a NetSuite account (stored per user, never in the project)
  mynt account list
  mynt account use <alias>      Make <alias> the project default (writes mynt.json)

  mynt auth login [alias]       Log in with OAuth 2.0 in the browser
  mynt auth logout [alias]

  mynt schema pull [alias]      Write .mynt/schema/<alias>.json from the account's metadata
  mynt schema diff <a> <b>      Compare two snapshots (aliases or files)

  mynt lsp                      Run the language server on stdio (for editors)

Options: --verbose shows error details.
`;

export async function main(argv: string[], context: CliContext = defaultContext()): Promise<number> {
  const args = parseArgs(argv);
  const [command, ...rest] = args.positional;
  const subArgs = { positional: rest, options: args.options };

  try {
    switch (command) {
      case "check":
      case "build":
        return await runCompile(command, subArgs, context);
      case "account":
        return await runAccount(subArgs, context);
      case "auth":
        return await runAuth(subArgs, context);
      case "schema":
        return await runSchema(subArgs, context);
      case "lsp":
        return await runLsp();
      default:
        context.stderr(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof UserError) {
      context.stderr(`mynt: ${error.message}\n`);
      if (error.details) {
        context.stderr(args.options.verbose ? `\n${error.details}\n` : "mynt: run with --verbose for details.\n");
      }
      return 1;
    }
    throw error;
  }
}

// Allow `tsx src/cli/main.ts ...` during development.
if (process.argv[1] && /main\.(ts|js)$/.test(process.argv[1]) && import.meta.url.endsWith(basename(process.argv[1]))) {
  process.exitCode = await main(process.argv.slice(2));
}
