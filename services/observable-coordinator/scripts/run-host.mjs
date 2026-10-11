import {runHostQueue, productionDependencies, productionQueue} from "../src/runtime.mjs";

const controller = new AbortController();
for (const name of ["SIGINT", "SIGTERM"]) {
  process.once(name, () => controller.abort());
}

try {
  const result = await runHostQueue({
    queue: productionQueue(),
    dependencies: productionDependencies(),
    maximumIdleReceives: 0,
    signal: controller.signal
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: "failed",
    code: typeof error?.code === "string" ? error.code : "observable_coordinator_failed"
  })}\n`);
  process.exitCode = 1;
}
