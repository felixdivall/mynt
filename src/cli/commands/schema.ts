import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { UserError } from "../../errors.js";
import { findProjectRoot, rawMetadataDir, schemaSnapshotPath } from "../../netsuite/account/config.js";
import { pullRawMetadata } from "../../netsuite/client/metadata.js";
import { RestClient } from "../../netsuite/client/rest.js";
import { createSession } from "../../netsuite/client/session.js";
import { diffSchemas, formatChange } from "../../netsuite/schema/diff.js";
import { assertKnownTypes, normalize } from "../../netsuite/schema/normalize.js";
import { inspectRawMetadata } from "../../netsuite/schema/inspect.js";
import { readSnapshot, writeSnapshot } from "../../netsuite/schema/snapshot.js";
import { stringOption, type ParsedArgs } from "../args.js";
import type { CliContext } from "../context.js";
import { resolveAlias } from "./account.js";

const USAGE = `Usage:
  sail schema pull [alias] [--records customer,salesOrder] [--keep-raw]
  sail schema diff <alias-or-file> <alias-or-file>
  sail schema inspect [alias] [--records customer,salesOrder]   Report the raw metadata's shape (needs --keep-raw)
`;

export async function runSchema(args: ParsedArgs, context: CliContext): Promise<number> {
  const [sub] = args.positional;
  switch (sub) {
    case "pull":
      return pull(args, context);
    case "diff":
      return diff(args, context);
    case "inspect":
      return inspect(args, context);
    default:
      throw new UserError(USAGE);
  }
}

async function pull(args: ParsedArgs, context: CliContext): Promise<number> {
  const alias = resolveAlias(args.positional[1], context);
  const profile = context.userConfig.getProfile(alias);
  const root = findProjectRoot(context.cwd) ?? context.cwd;

  const session = createSession({ alias, profile, store: context.credentialStore, fetch: context.fetch });
  const client = new RestClient({ accountId: profile.accountId, session, fetch: context.fetch });

  const recordsOption = stringOption(args.options, "records");
  const raw = await pullRawMetadata(client, {
    ...(recordsOption ? { records: recordsOption.split(",").map((r) => r.trim()).filter(Boolean) } : {}),
    onProgress: (done, total, type) => context.stderr(`sail: [${done}/${total}] ${type}\n`),
  });

  for (const [type, reason] of Object.entries(raw.failures ?? {})) {
    context.stderr(`sail: skipped ${type}: ${reason}\n`);
  }
  if (Object.keys(raw.records).length === 0) {
    throw new UserError("No record metadata could be fetched; every listed type failed. See the messages above.");
  }

  if (args.options["keep-raw"]) {
    const dir = rawMetadataDir(root, alias);
    mkdirSync(dir, { recursive: true });
    for (const [type, schema] of Object.entries(raw.records)) {
      writeFileSync(join(dir, `${type}.json`), JSON.stringify(schema, null, 2) + "\n");
    }
    if (raw.failures) writeFileSync(join(dir, "_failures.json"), JSON.stringify(raw.failures, null, 2) + "\n");
    context.stderr(`sail: raw metadata written to ${dir}\n`);
  }

  const { document, warnings } = normalize(raw, { account: profile.accountId, pulledAt: context.now().toISOString() });
  assertKnownTypes(document);

  const path = schemaSnapshotPath(root, alias);
  const previous = existsSync(path) ? readSnapshot(path) : undefined;
  const outcome = writeSnapshot(path, document);

  const recordCount = Object.keys(document.records).length;
  const fieldCount = Object.values(document.records).reduce((n, r) => n + Object.keys(r.fields).length, 0);
  for (const warning of warnings) context.stderr(`sail: warning: ${warning}\n`);

  if (outcome === "unchanged") {
    context.stdout(`sail: ${path} is up to date (${recordCount} records, ${fieldCount} fields; no changes since ${previous?.source.kind === "account" ? previous.source.pulledAt : "last pull"}).\n`);
    return 0;
  }
  context.stdout(`sail: wrote ${path} (${recordCount} records, ${fieldCount} fields).\n`);
  if (previous) {
    const changes = diffSchemas(previous, document);
    context.stdout(`sail: ${changes.length} change${changes.length === 1 ? "" : "s"} since the previous snapshot:\n`);
    for (const change of changes.slice(0, 50)) context.stdout(`  ${formatChange(change)}\n`);
    if (changes.length > 50) context.stdout(`  ... and ${changes.length - 50} more\n`);
  }
  return 0;
}

/** Prints what the raw responses look like, so normalization assumptions can be checked against them. */
async function inspect(args: ParsedArgs, context: CliContext): Promise<number> {
  const alias = resolveAlias(args.positional[1], context);
  const root = findProjectRoot(context.cwd) ?? context.cwd;
  const dir = rawMetadataDir(root, alias);
  if (!existsSync(dir)) throw new UserError(`No raw metadata at ${dir}.\nRun \`sail schema pull ${alias} --keep-raw\` first.`);
  const snapshotPath = schemaSnapshotPath(root, alias);
  const snapshot = existsSync(snapshotPath) ? readSnapshot(snapshotPath) : undefined;
  const recordsOption = stringOption(args.options, "records");
  const report = inspectRawMetadata(dir, {
    ...(recordsOption ? { records: recordsOption.split(",").map((r) => r.trim()).filter(Boolean) } : {}),
    ...(snapshot ? { snapshot } : {}),
  });
  context.stdout(report);
  return 0;
}

function snapshotArgument(argument: string, context: CliContext): string {
  if (argument.endsWith(".json") || existsSync(resolve(context.cwd, argument))) return resolve(context.cwd, argument);
  const root = findProjectRoot(context.cwd) ?? context.cwd;
  return schemaSnapshotPath(root, argument);
}

async function diff(args: ParsedArgs, context: CliContext): Promise<number> {
  const [, a, b] = args.positional;
  if (!a || !b) throw new UserError(USAGE);
  const before = readSnapshot(snapshotArgument(a, context));
  const after = readSnapshot(snapshotArgument(b, context));
  const changes = diffSchemas(before, after);
  if (changes.length === 0) {
    context.stdout(`sail: no structural differences between ${a} and ${b}.\n`);
    return 0;
  }
  for (const change of changes) context.stdout(formatChange(change) + "\n");
  context.stdout(`sail: ${changes.length} change${changes.length === 1 ? "" : "s"}.\n`);
  return 1;
}
