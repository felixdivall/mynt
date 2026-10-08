// Prepares the local Zed dev extension.
//
// Zed loads a grammar from a Git repository at a commit. The grammar lives
// in this monorepo under tree-sitter-mynt/, so this script copies it into a
// standalone Git repository under .mynt-dev/ (the shape it will have once it
// is its own GitHub repository), commits it, and renders
// editors/zed/extension.toml from the template with that repository's
// file:// URL and commit. Nothing machine-specific is tracked.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("..", import.meta.url).pathname);
const grammar = resolve(root, "tree-sitter-mynt");
const target = resolve(root, ".mynt-dev", "tree-sitter-mynt");

for (const required of ["src/parser.c", "src/scanner.c", "grammar.js"]) {
  if (!existsSync(resolve(grammar, required))) {
    console.error(`tree-sitter-mynt/${required} is missing; run \`pnpm grammar generate\` first.`);
    process.exit(1);
  }
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const entry of ["grammar.js", "tree-sitter.json", "package.json", "src"]) {
  cpSync(resolve(grammar, entry), resolve(target, entry), { recursive: true });
}
const git = (...args) => execFileSync("git", args, { cwd: target, stdio: ["ignore", "pipe", "inherit"] }).toString().trim();
git("init", "-q");
git("add", "-A");
git("-c", "user.name=mynt-dev", "-c", "user.email=mynt-dev@localhost", "commit", "-q", "-m", "tree-sitter-mynt dev snapshot");
const commit = git("rev-parse", "HEAD");

const template = readFileSync(resolve(root, "editors/zed/extension.toml.in"), "utf8");
const rendered = template
  .split("\n")
  .filter((line) => !line.startsWith("# Template.") && !line.startsWith("# local grammar") && !line.startsWith("# When tree-sitter") && !line.startsWith("# with the repository"))
  .join("\n")
  .replace("@GRAMMAR_REPOSITORY@", pathToFileURL(target).toString())
  .replace("@GRAMMAR_COMMIT@", commit);
writeFileSync(resolve(root, "editors/zed/extension.toml"), rendered);
console.log(`grammar repository: ${pathToFileURL(target)} @ ${commit.slice(0, 12)}`);
console.log("rendered editors/zed/extension.toml");

const grammarMtime = statSync(resolve(grammar, "grammar.js")).mtimeMs;
if (grammarMtime > statSync(resolve(grammar, "src/parser.c")).mtimeMs) {
  console.warn("warning: tree-sitter-mynt/grammar.js is newer than src/parser.c; run `pnpm grammar:generate` and rerun this script.");
}
if (!existsSync(resolve(root, "dist/cli/main.js"))) {
  console.warn("warning: dist/ is missing; run `pnpm build` so the language server can start.");
}

const server = resolve(root, "bin/mynt.js");
console.log(`
Next, in Zed:
  1. command palette -> \`zed: install dev extension\` -> choose ${resolve(root, "editors/zed")}
  2. add to settings (\`zed: open settings\`), which runs this checkout's server
     and layers its semantic tokens over the grammar's highlighting:

{
  "lsp": {
    "mynt": { "binary": { "path": "${server}", "arguments": ["lsp"] } }
  },
  "languages": {
    "Mynt": { "semantic_tokens": "combined" }
  }
}

  3. open ${resolve(root, "examples/zed-tour.mn")}
After a grammar change: \`pnpm grammar:generate\`, rerun this script, and reinstall the dev extension.`);
