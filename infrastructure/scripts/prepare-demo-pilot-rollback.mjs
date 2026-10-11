import assert from "node:assert/strict";
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {canonicalJson, templateBody, prepareApiRollback, prepareFoundationRollback} from "../lib/demo-pilot-release-guard.ts";

const flags = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  assert.ok(["--kind", "--live-template", "--retained-template", "--api-digest", "--importers", "--out"].includes(key) && value && !value.startsWith("--") && !flags.has(key), "Invalid rollback preparation argument");
  flags.set(key, value);
}
const kind = flags.get("--kind");
assert.ok(["Api", "Foundation"].includes(kind), "Only the exact pre-window API/Foundation templates may be restored");
const required = ["--kind", "--live-template", "--retained-template", "--out", kind === "Api" ? "--api-digest" : "--importers"];
assert.ok(flags.size === required.length && required.every((key) => flags.has(key)), `Required arguments: ${required.join(", ")}`);
const json = (flag) => JSON.parse(readFileSync(flags.get(flag), "utf8"));
const live = templateBody(json("--live-template")), retained = templateBody(json("--retained-template"));
const result = kind === "Api" ? prepareApiRollback(live, retained, flags.get("--api-digest")) : prepareFoundationRollback(live, retained, json("--importers"));
const destination = resolve(flags.get("--out"));
mkdirSync(destination, {mode: 0o700});
writeFileSync(join(destination, `OpenGeo-demo-${kind}.rollback.template.json`), `${canonicalJson(result)}\n`, {flag: "wx", mode: 0o600});
process.stdout.write(`Prepared ${kind} rollback locally. Database migrations have not been reversed; this command does not execute a rollback.\n`);
