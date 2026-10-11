import {chmod, readFile, rename, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";

const LOG_GROUP = /^\/opengeo\/(dev|staging|production)\/observable-coordinator$/;

export function parseEnvironmentFile(contents) {
  if (typeof contents !== "string" || Buffer.byteLength(contents) > 16_384) {
    throw new Error("observable coordinator environment file is invalid");
  }
  const values = Object.create(null);
  for (const line of contents.split("\n")) {
    if (line === "") continue;
    const match = /^([A-Z][A-Z0-9_]{0,127})=([^\r\n]{1,4096})$/.exec(line);
    if (!match || Object.hasOwn(values, match[1])) {
      throw new Error("observable coordinator environment file is invalid");
    }
    values[match[1]] = match[2];
  }
  return values;
}

export function cloudWatchAgentConfiguration(logGroupName) {
  if (!LOG_GROUP.test(logGroupName ?? "")) {
    throw new Error("observable coordinator log group is invalid");
  }
  return {
    agent: {metrics_collection_interval: 60, run_as_user: "root"},
    logs: {logs_collected: {files: {collect_list: [{
      file_path: "/var/log/opengeo/observable-coordinator.log",
      log_group_name: logGroupName,
      log_stream_name: "{instance_id}",
      timezone: "UTC",
      multi_line_start_pattern: "^{"
    }]}}}
  };
}

export async function configureHostLogs({
  environmentPath = "/etc/opengeo/observable-coordinator.env",
  outputPath = "/etc/opengeo/observable-cloudwatch-agent.json"
} = {}) {
  const environment = parseEnvironmentFile(await readFile(environmentPath, "utf8"));
  const configuration = cloudWatchAgentConfiguration(
    environment.OPEN_GEO_OBSERVABLE_LOG_GROUP_NAME
  );
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(configuration)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, outputPath);
  return configuration;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await configureHostLogs();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({status: "failed", code: "host_log_configuration_invalid"})}\n`);
    process.exitCode = 1;
  }
}
