#!/usr/bin/env node

import {spawnSync} from "node:child_process";
import {chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import path from "node:path";

const ACCOUNT_ID = "222222222222";
const USER_NAME = "OpenGeoDevBootstrapOperator";
const PROFILE_NAME = "opengeo-dev-bootstrap";
const EXPECTED_CALLER_ARN = `arn:aws:iam::${ACCOUNT_ID}:root`;

function aws(args) {
  const result = spawnSync("aws", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `aws ${args[0]} failed`);
  }
  return result.stdout;
}

function parseJson(output, operation) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}

function credentialsPath() {
  const configured = process.env.AWS_SHARED_CREDENTIALS_FILE;
  return configured ? path.resolve(configured) : path.join(homedir(), ".aws", "credentials");
}

function hasProfile(contents, profileName) {
  const escaped = profileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*\\[${escaped}\\]\\s*$`, "m").test(contents);
}

function storeProfile(accessKey) {
  const target = credentialsPath();
  const directory = path.dirname(target);
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (hasProfile(existing, PROFILE_NAME)) {
    throw new Error(`AWS profile ${PROFILE_NAME} already exists; refusing to overwrite it`);
  }

  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  const next = `${existing}${separator}\n[${PROFILE_NAME}]\naws_access_key_id = ${accessKey.AccessKeyId}\naws_secret_access_key = ${accessKey.SecretAccessKey}\n`;
  const temporary = path.join(directory, `.credentials.opengeo-bootstrap-${process.pid}`);
  try {
    writeFileSync(temporary, next, {encoding: "utf8", mode: 0o600, flag: "wx"});
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
}

function main() {
  const caller = parseJson(aws(["sts", "get-caller-identity", "--output", "json"]), "get-caller-identity");
  if (caller.Account !== ACCOUNT_ID || caller.Arn !== EXPECTED_CALLER_ARN) {
    throw new Error(`Expected one-time root bootstrap in account ${ACCOUNT_ID}; received ${caller.Arn || "unknown caller"}`);
  }

  const target = credentialsPath();
  const existingCredentials = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (hasProfile(existingCredentials, PROFILE_NAME)) {
    throw new Error(`AWS profile ${PROFILE_NAME} already exists; refusing to create another key`);
  }

  const current = parseJson(
    aws(["iam", "list-access-keys", "--user-name", USER_NAME, "--output", "json"]),
    "list-access-keys"
  );
  if ((current.AccessKeyMetadata || []).length !== 0) {
    throw new Error(`IAM user ${USER_NAME} already has an access key; refusing to create another`);
  }

  const created = parseJson(
    aws(["iam", "create-access-key", "--user-name", USER_NAME, "--output", "json"]),
    "create-access-key"
  );
  const accessKey = created.AccessKey;
  if (!accessKey?.AccessKeyId || !accessKey?.SecretAccessKey) {
    throw new Error("create-access-key did not return a complete credential");
  }

  try {
    storeProfile(accessKey);
  } catch (error) {
    try {
      aws(["iam", "delete-access-key", "--user-name", USER_NAME, "--access-key-id", accessKey.AccessKeyId]);
    } catch {
      throw new Error(`${error.message}; automatic AWS key rollback also failed`);
    }
    throw error;
  }

  process.stdout.write(`${JSON.stringify({
    accountId: ACCOUNT_ID,
    userName: USER_NAME,
    profile: PROFILE_NAME,
    accessKeySuffix: accessKey.AccessKeyId.slice(-4),
    credentialsMode: "0600",
    secretPrinted: false
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
