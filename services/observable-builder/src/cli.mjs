#!/usr/bin/env node

import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {ObservableBuilderError, runBuild, writeReport} from "./contract.mjs";
import {readPageCacheInput} from "./page-cache-input.mjs";

function argumentsFrom(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) {
      throw new ObservableBuilderError("arguments_invalid");
    }
    values.set(key, value);
  }
  const expected = [
    "--contract",
    "--framework-cache",
    "--input",
    "--observable-cli",
    "--report",
    "--workspace"
  ];
  if (expected.some((key) => !values.has(key)) ||
      [...values.keys()].some((key) => !expected.includes(key) && key !== "--page-cache")) {
    throw new ObservableBuilderError("arguments_invalid");
  }
  return Object.fromEntries([...values].map(([key, value]) => [key.slice(2), resolve(value)]));
}

try {
  process.umask(0o077);
  const options = argumentsFrom(process.argv.slice(2));
  const invocation = JSON.parse(readFileSync(options.contract, "utf8"));
  const report = runBuild({
    invocation,
    inputRoot: options.input,
    workspaceRoot: options.workspace,
    observableCliPath: options["observable-cli"],
    frameworkCacheRoot: options["framework-cache"],
    // Set only by the sealed, credential-free compiler image. Host callers of
    // runBuild retain the non-executing configuration path by default.
    allowSourceConfiguration: process.env.OPEN_GEO_FRAMEWORK_PROJECT_CONFIG === 'isolated',
    ...(options["page-cache"] ? {incrementalPageCache: readPageCacheInput(options["page-cache"])} : {})
  });
  writeReport(options.report, report);
} catch (error) {
  const code = error instanceof ObservableBuilderError ? error.code : "builder_internal_error";
  process.stderr.write(`${JSON.stringify({error: code})}\n`);
  process.exitCode = 1;
}
