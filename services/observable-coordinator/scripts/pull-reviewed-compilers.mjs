import {execFileSync} from "node:child_process";
import {compilerPullTargets} from "../src/compiler-policy.mjs";
const targets = compilerPullTargets(process.env);
if (process.argv.length !== 3 || !["--check", "--pull"].includes(process.argv[2])) throw Error("Expected --check or --pull");
if (process.argv[2] === "--pull") {
  for (const target of targets) execFileSync("podman", ["pull", target], {stdio: "inherit", timeout: 600_000});
}
