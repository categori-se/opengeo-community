import {readFileSync, mkdirSync, writeFileSync} from "node:fs";
import {resolve, join} from "node:path";
import {fileURLToPath} from "node:url";
import {
  canonicalJson, sha256, templateBody, validateDemoStackIdentity,
  prepareFoundationTemplate, prepareApiTemplate, readReviewedMigrations, validateMigrationLedger, releaseContractSha256
} from "../lib/demo-pilot-release-guard.ts";

const flags = new Map();
const allowed = ["--foundation", "--api", "--stacks", "--ledger", "--api-digest", "--out"];
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (!allowed.includes(flag) || flags.has(flag) || !value || value.startsWith("--")) throw new Error("Supply each of --foundation, --api, --stacks, --ledger, --api-digest and --out exactly once.");
  flags.set(flag, value);
}
if (flags.size !== allowed.length) throw new Error("Missing release input. This command only prepares local artifacts; it cannot deploy or authorize a release.");

const json = (flag) => JSON.parse(readFileSync(flags.get(flag), "utf8"));
const stacks = json("--stacks").Stacks;
for (const kind of ["Foundation", "Api"]) {
  const matches = stacks?.filter((stack) => stack.StackName === `OpenGeo-demo-${kind}`);
  if (matches?.length !== 1) throw new Error(`Expected exactly one demo ${kind} stack.`);
  validateDemoStackIdentity(kind, matches[0]);
}
const foundation = prepareFoundationTemplate(templateBody(json("--foundation")));
const api = prepareApiTemplate(templateBody(json("--api")), flags.get("--api-digest"));
const repository = fileURLToPath(new URL("../../", import.meta.url));
const ledgerResponse = json("--ledger");
const ledger = JSON.parse(ledgerResponse.formattedRecords);
const pending = validateMigrationLedger(ledger, readReviewedMigrations(repository));
const artifacts = {
  "OpenGeo-demo-Foundation.template.json": foundation,
  "OpenGeo-demo-Api.template.json": api,
  "migration-plan.json": {appliedCount: ledger.length, pending, mode: "forward-migrations-only"}
};
const receipt = {
  schemaVersion: "opengeo.demo-pilot-prepared-artifacts.2",
  status: "prepared-locally-not-authorized-not-deployed",
  releaseContractSha256,
  apiDigest: flags.get("--api-digest"),
  artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, value]) => [name, sha256(canonicalJson(value))])),
  limitations: [
    "Input snapshots must be refreshed and revalidated immediately before an authorized mutation.",
    "Digest syntax is not proof of image provenance, ARM64 architecture, or a successful security scan.",
    "Worker/endpoints templates, policy approval, cost window, backup/recovery and pilot acceptance remain separate gates.",
    "A restored API image does not reverse database migrations."
  ]
};
// Refuse an existing destination, including an empty directory or symlink. Never overwrite release artifacts.
const destination = resolve(flags.get("--out"));
for (const [name, value] of Object.entries(artifacts)) {
  if (name.endsWith(".template.json") && Buffer.byteLength(`${canonicalJson(value)}\n`) > 51_200) {
    throw new Error("Template exceeds direct CloudFormation request size; stop for a separately reviewed private artifact path.");
  }
}
mkdirSync(destination, {mode: 0o700});
for (const [name, value] of Object.entries({...artifacts, "preparation-receipt.json": receipt})) {
  const contents = name.endsWith(".template.json") ? canonicalJson(value) : JSON.stringify(value, null, 2);
  writeFileSync(join(destination, name), `${contents}\n`, {flag: "wx", mode: 0o600});
}
process.stdout.write(`Prepared ${destination}. No AWS calls or database writes were made. Authorization and release gates remain outstanding.\n`);
