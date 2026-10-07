export interface ParsedArgs {
  positional: string[];
  options: Record<string, string | true>;
}

/** `--key value`, `--key=value`, `--flag`. Everything else is positional. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const options: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      options[body.slice(0, eq)] = body.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
      options[body] = argv[++i]!;
    } else {
      options[body] = true;
    }
  }
  return { positional, options };
}

export function stringOption(options: ParsedArgs["options"], name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}
