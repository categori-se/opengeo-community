#!/usr/bin/env python3
"""Deploy a standalone Community installation. Default is an offline plan.

Reuses the maintained CDK stacks, migration runner and sealed Studio publisher.
Each --apply step is explicit and checks the AWS account before any mutation.
No credentials or secret values are saved in deployment state.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
from uuid import UUID

ROOT = Path(__file__).resolve().parents[1]
STEPS = ("plan", "synth", "bootstrap", "web", "foundation", "images", "database", "runtime", "preview", "publication", "publication-origin", "github-build", "studio", "owner", "status", "rollback")


def load_config(path: Path) -> dict:
    cfg = json.loads(path.read_text())
    required = {"account", "region", "name", "profile", "budgetAlertEmail"}
    if not isinstance(cfg, dict) or not required <= cfg.keys() or cfg.keys() - (required | {"withWorker", "nativePreview", "nativePublication", "nativeGitHubBuild"}):
        raise ValueError("config requires account, region, name, profile, budgetAlertEmail; optional withWorker/nativePreview/nativePublication/nativeGitHubBuild")
    if not re.fullmatch(r"[0-9]{12}", str(cfg["account"])) or not isinstance(cfg["account"], str):
        raise ValueError("account must be an explicit 12-digit string")
    if cfg["region"] != "us-east-1":
        raise ValueError("this first deployment profile supports us-east-1")
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,22}[a-z0-9]", cfg["name"]):
        raise ValueError("name must be a 3–24 character lowercase DNS slug starting with a letter and ending alphanumeric")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", cfg["profile"]):
        raise ValueError("profile must name a local AWS CLI profile")
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", cfg["budgetAlertEmail"]):
        raise ValueError("budgetAlertEmail must be an email address")
    if type(cfg.get("withWorker", False)) is not bool:
        raise ValueError("withWorker must be a boolean")
    if "nativePreview" in cfg:
        preview = cfg["nativePreview"]
        fields = {"domainName", "certificateArn", "publicKeyPath", "privateKeySecretArn"}
        if (not isinstance(preview, dict) or not fields <= preview.keys()
                or preview.keys() - (fields | {"publicMapsDomainName"})
                or any(not isinstance(value, str) or not value or len(value) > 2048
                       or re.search(r"[\r\n]", value) for value in preview.values())):
            raise ValueError("nativePreview requires only domainName, certificateArn, publicKeyPath, privateKeySecretArn and optional publicMapsDomainName")
        for domain in (preview["domainName"], preview.get("publicMapsDomainName")):
            if domain is not None and (not re.fullmatch(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?", domain)
                    or domain == "opengeo.tools" or domain.endswith(".opengeo.tools")):
                raise ValueError("nativePreview requires independent DNS hostnames")
        if preview.get("publicMapsDomainName") == preview["domainName"]:
            raise ValueError("nativePreview profiles require distinct hostnames")
        if not re.fullmatch(r"arn:aws:acm:us-east-1:" + cfg["account"] + r":certificate/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", preview["certificateArn"]):
            raise ValueError("nativePreview certificate must belong to this account and us-east-1")
        if not re.fullmatch(r"arn:aws:secretsmanager:us-east-1:" + cfg["account"] + r":secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}", preview["privateKeySecretArn"]):
            raise ValueError("nativePreview signing secret must be a complete same-account us-east-1 ARN")
        cfg["nativePreview"] = {**preview, "publicKeyPath": str((path.parent / preview["publicKeyPath"]).resolve())}
    if "nativePublication" in cfg:
        publication = cfg["nativePublication"]
        if (not isinstance(publication, dict) or not {"publisherDatabaseSecretArn", "destinations"} <= publication.keys()
                or publication.keys() - {"publisherDatabaseSecretArn", "destinations", "enabled"}
                or type(publication.get("enabled", False)) is not bool
                or not isinstance(publication.get("publisherDatabaseSecretArn"), str)
                or not re.fullmatch(r"arn:aws:secretsmanager:us-east-1:" + cfg["account"] + r":secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}", publication["publisherDatabaseSecretArn"])):
            raise ValueError("nativePublication requires a dedicated complete same-account secret ARN, destinations and optional boolean enabled")
        targets = publication["destinations"]
        fields = {"hostname", "bucket", "distribution_id", "origin_id"}
        if not isinstance(targets, list) or not 1 <= len(targets) <= 12:
            raise ValueError("nativePublication requires 1–12 explicit destinations")
        for target in targets:
            if (not isinstance(target, dict) or not fields <= target.keys() or target.keys() - (fields | {"origin_access_control_id"})
                    or any(not isinstance(value, str) or not value or len(value) > 253 for value in target.values())
                    or not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?", target["hostname"])
                    or target["hostname"] == "opengeo.tools" or target["hostname"].endswith(".opengeo.tools")
                    or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", target["bucket"])
                    or not re.fullmatch(r"[A-Z0-9]{1,32}", target["distribution_id"])
                    or not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", target["origin_id"])
                    or ("origin_access_control_id" in target and not re.fullmatch(r"[A-Z0-9]{1,32}", target["origin_access_control_id"]))):
                raise ValueError("nativePublication destination identity is invalid")
        if len({target["hostname"] for target in targets}) != len(targets) or len({target["distribution_id"] for target in targets}) != len(targets):
            raise ValueError("nativePublication destinations require unique hosts and distributions")
        cfg["nativePublication"] = {**publication, "enabled": publication.get("enabled", False)}
    if "nativeGitHubBuild" in cfg:
        build = cfg["nativeGitHubBuild"]
        fields = {"githubAppSecretArn", "coordinatorDatabaseSecretArn", "repository", "runtimeSha", "connection"}
        optional = {"githubAppSecretKeyArn", "enabled", "freeExecutionVerified", "trustEvidencePath", "artifactInputOrganizations"}
        if (not isinstance(build, dict) or not fields <= build.keys() or build.keys() - fields - optional
                or any(type(build.get(key, False)) is not bool for key in ("enabled", "freeExecutionVerified"))):
            raise ValueError("nativeGitHubBuild requires closed identity/secret/connection configuration and explicit boolean admission")
        for key in ("githubAppSecretArn", "coordinatorDatabaseSecretArn"):
            if not isinstance(build[key], str) or not re.fullmatch(r"arn:aws:secretsmanager:us-east-1:" + cfg["account"] + r":secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}", build[key]):
                raise ValueError("nativeGitHubBuild secrets require complete same-account ARNs")
        if build["githubAppSecretArn"] == build["coordinatorDatabaseSecretArn"]:
            raise ValueError("nativeGitHubBuild requires separate App and coordinator secrets")
        if "githubAppSecretKeyArn" in build and (not isinstance(build["githubAppSecretKeyArn"], str) or not re.fullmatch(
                r"arn:aws:kms:us-east-1:" + cfg["account"] + r":key/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", build["githubAppSecretKeyArn"])):
            raise ValueError("nativeGitHubBuild App key requires an exact same-account KMS key ARN")
        repository = build["repository"]
        if (not isinstance(repository, dict) or repository.keys() != {"fullName", "id", "ownerId", "private"}
                or not isinstance(repository["fullName"], str)
                or not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}", repository["fullName"])
                or any(type(repository[key]) is not int or not 0 < repository[key] <= 9007199254740991 for key in ("id", "ownerId"))
                or type(repository["private"]) is not bool
                or not isinstance(build["runtimeSha"], str) or not re.fullmatch(r"[0-9a-f]{40}", build["runtimeSha"])):
            raise ValueError("nativeGitHubBuild requires exact immutable GitHub repository identity and runtime SHA")
        connection = build["connection"]
        if (not isinstance(connection, dict) or connection.keys() != {"id", "organizationId", "installationId", "workflowId"}
                or any(type(connection[key]) is not int or not 0 < connection[key] <= 9007199254740991 for key in ("installationId", "workflowId"))):
            raise ValueError("nativeGitHubBuild requires an exact existing-account connection identity")
        organizations = build.get("artifactInputOrganizations", [])
        if (not isinstance(organizations, list) or len(organizations) > 12
                or any(not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", value) for value in organizations)
                or len(set(organizations)) != len(organizations)):
            raise ValueError("nativeGitHubBuild permits at most twelve distinct Artifact account grants")
        for value in [connection["id"], connection["organizationId"], *organizations]:
            if not isinstance(value, str) or str(UUID(value)) != value:
                raise ValueError("nativeGitHubBuild account and connection IDs must be canonical UUIDs")
        if build.get("enabled", False) and (not build.get("freeExecutionVerified", False) or not build.get("trustEvidencePath")):
            raise ValueError("nativeGitHubBuild activation requires verified free capacity and exact trust evidence")
        if "trustEvidencePath" in build and (not isinstance(build["trustEvidencePath"], str) or not build["trustEvidencePath"]
                or len(build["trustEvidencePath"]) > 2048 or re.search(r"[\x00-\x1f\x7f]", build["trustEvidencePath"])):
            raise ValueError("nativeGitHubBuild trust evidence must be a local JSON path")
        cfg["nativeGitHubBuild"] = {**build, "enabled": build.get("enabled", False),
            "freeExecutionVerified": build.get("freeExecutionVerified", False), "artifactInputOrganizations": organizations,
            **({"trustEvidencePath": str((path.parent / build["trustEvidencePath"]).absolute())} if "trustEvidencePath" in build else {})}
    return cfg


def validate_github_trust(evidence, build):
    """Match the existing IAM trust verifier before admitting any stack change."""
    try:
        repository, oidc, environment, policies, ref = (evidence[key] for key in ("repository", "oidc", "environment", "policies", "ref"))
        expected = build["repository"]
        owner, name = expected["fullName"].split("/")
        sha = build["runtimeSha"]
        valid = (set(evidence) == {"repository", "oidc", "environment", "policies", "ref"}
            and type(repository["id"]) is int and repository["id"] == expected["id"]
            and type(repository["owner"]["id"]) is int and repository["owner"]["id"] == expected["ownerId"]
            and repository["full_name"] == expected["fullName"] and repository["private"] is expected["private"]
            and repository["archived"] is False and repository["disabled"] is False
            and oidc["use_default"] is True and oidc["use_immutable_subject"] is True
            and oidc["sub_claim_prefix"] == f"repo:{owner}@{expected['ownerId']}/{name}@{expected['id']}"
            and environment["name"] == "studio-framework-build"
            and environment["deployment_branch_policy"]["protected_branches"] is False
            and environment["deployment_branch_policy"]["custom_branch_policies"] is True
            and type(policies["total_count"]) is int and policies["total_count"] == 1
            and len(policies["branch_policies"]) == 1
            and policies["branch_policies"][0]["type"] == "branch"
            and policies["branch_policies"][0]["name"] == f"studio-runtime-{sha}"
            and ref["ref"] == f"refs/heads/studio-runtime-{sha}"
            and ref["object"]["type"] == "commit" and ref["object"]["sha"] == sha)
    except (KeyError, TypeError, AttributeError):
        valid = False
    if not valid:
        raise ValueError("nativeGitHubBuild requires exact repository, immutable subject, environment and pinned runtime ref evidence")
    # Keep only the verified public trust facts, never unrelated file contents.
    return {"repository": {"id": expected["id"], "owner": {"id": expected["ownerId"]},
                "full_name": expected["fullName"], "private": expected["private"], "archived": False, "disabled": False},
        "oidc": {"use_default": True, "use_immutable_subject": True,
            "sub_claim_prefix": f"repo:{owner}@{expected['ownerId']}/{name}@{expected['id']}"},
        "environment": {"name": "studio-framework-build",
            "deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True}},
        "policies": {"total_count": 1, "branch_policies": [{"type": "branch", "name": f"studio-runtime-{sha}"}]},
        "ref": {"ref": f"refs/heads/studio-runtime-{sha}", "object": {"type": "commit", "sha": sha}}}


def run(args: list[str], *, env: dict | None = None, cwd: Path = ROOT, capture=False, stdin=None, timeout=1800):
    result = subprocess.run(args, cwd=cwd, env=env, input=stdin, text=True,
                            stdout=subprocess.PIPE if capture else None, check=True, timeout=timeout)
    return result.stdout if capture else None


def write_json(path: Path, value: dict):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)


class Deployment:
    def __init__(self, cfg: dict, *, allow_preview_change=False, allow_publication_change=False, allow_github_build_change=False):
        self.cfg = cfg
        self.state = ROOT / ".opengeo" / "aws" / cfg["name"]
        self.prefix = f"OpenGeoCommunity-{cfg['name']}"
        # Private operator settings must not leak into the independent profile.
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("OPEN_GEO_", "CDK_"))}
        self.env.update({"AWS_PROFILE": cfg["profile"], "AWS_REGION": cfg["region"],
            "AWS_DEFAULT_REGION": cfg["region"], "AWS_PAGER": "", "AWS_MAX_ATTEMPTS": "2",
            "CDK_DEFAULT_ACCOUNT": cfg["account"], "CDK_DEFAULT_REGION": cfg["region"],
            "OPEN_GEO_COMMUNITY_ACCOUNT": cfg["account"], "OPEN_GEO_COMMUNITY_REGION": cfg["region"],
            "OPEN_GEO_COMMUNITY_NAME": cfg["name"], "OPEN_GEO_BUDGET_ALERT_EMAIL": cfg["budgetAlertEmail"]})
        marker = self.read("deployment.json")
        if marker and marker != {k: cfg[k] for k in ("account", "region", "name")}:
            raise ValueError("state directory belongs to another AWS deployment")
        web = self.read("web.outputs.json")
        if web:
            domain = web["StudioDistributionDomainName"]
            if not re.fullmatch(r"d[a-z0-9]{5,30}\.cloudfront\.net", domain):
                raise ValueError("invalid retained CloudFront domain")
            self.env["OPEN_GEO_COMMUNITY_WEB_ORIGIN"] = f"https://{domain}"
            if "StudioDistributionId" in web:
                if not re.fullmatch(r"[A-Z0-9]{1,32}", web["StudioDistributionId"]):
                    raise ValueError("invalid retained Studio distribution ID")
                self.env["OPEN_GEO_COMMUNITY_WEB_DISTRIBUTION_ID"] = web["StudioDistributionId"]
        images = self.read("images.json")
        for key, variable in (("api", "OPEN_GEO_API_IMAGE"), ("compiler", "OPEN_GEO_OBSERVABLE_BUILDER_IMAGE_DIGEST"), ("worker", "OPEN_GEO_WORKER_IMAGE")):
            if key in images and (key != "worker" or cfg.get("withWorker")):
                if not re.fullmatch(r"sha256:[0-9a-f]{64}", images[key]):
                    raise ValueError("retained image must be an immutable digest")
                self.env[variable] = images[key]
        api = self.read("api.outputs.json")
        if api:
            host = urlsplit(api["ApiEndpoint"]).hostname or ""
            if not re.fullmatch(r"[a-z0-9]{10}\.execute-api\.us-east-1\.amazonaws\.com", host):
                raise ValueError("invalid retained API endpoint")
            self.env["OPEN_GEO_COMMUNITY_API_ORIGIN_DOMAIN"] = host
        self.preview_manifest = None
        intent = self.read("preview.intent.json")
        if intent:
            current = self.prepare_preview()
            if not allow_preview_change and intent != current:
                raise ValueError("nativePreview differs from retained intent; use the explicit preview step to change it")
        self.publication_manifest = None
        intent = self.read("publication.intent.json")
        if intent:
            current = self.prepare_publication()
            matching = current == {key: intent.get(key) for key in current}
            if not allow_publication_change and not matching:
                raise ValueError("nativePublication differs from retained intent; use the explicit publication step to change it")
            self.publication_environment(matching and intent.get("databaseConfigured") is True)
        self.github_build_manifest = None
        intent = self.read("github-build.intent.json")
        if intent:
            current = self.prepare_github_build()
            matching = current == {key: intent.get(key) for key in current}
            if not allow_github_build_change and not matching:
                raise ValueError("nativeGitHubBuild differs from retained intent; use the explicit github-build step to change it")
            self.github_build_environment(matching and intent.get("complete") is True
                                          and intent.get("databaseConfigured") is True
                                          and intent.get("connectionConfigured") is True)

    def prepare_github_build(self):
        if self.github_build_manifest is not None:
            return self.github_build_manifest
        build = self.cfg.get("nativeGitHubBuild")
        if not build:
            raise ValueError("nativeGitHubBuild configuration is required; retained build resources cannot be silently removed")
        self.need("web.outputs.json")
        self.need("api.outputs.json")
        foundation = self.need("foundation.outputs.json")
        images = self.need("images.json")
        account = self.cfg["account"]
        cluster = foundation.get("DatabaseClusterArn", "")
        key = foundation.get("CommunityApplicationKmsKeyArn", "")
        if (not re.fullmatch(r"arn:aws:rds:us-east-1:" + account + r":cluster:[A-Za-z][A-Za-z0-9-]{0,62}", cluster)
                or not re.fullmatch(r"arn:aws:kms:us-east-1:" + account + r":key/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", key)):
            raise ValueError("nativeGitHubBuild requires retained same-account cluster/KMS outputs; refresh Foundation with this source")
        core_secrets = [foundation.get(name) for name in ("DatabaseSecretArn", "RuntimeDatabaseSecretArn", "WorkerDatabaseSecretArn")]
        if any(not isinstance(secret, str) or not re.fullmatch(r"arn:aws:secretsmanager:us-east-1:" + account + r":secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}", secret) for secret in core_secrets):
            raise ValueError("nativeGitHubBuild requires retained database role outputs")
        other_secrets = {*core_secrets, self.cfg.get("nativePublication", {}).get("publisherDatabaseSecretArn"),
                         self.cfg.get("nativePreview", {}).get("privateKeySecretArn")}
        if any(build[name] in other_secrets for name in ("coordinatorDatabaseSecretArn", "githubAppSecretArn")):
            raise ValueError("nativeGitHubBuild needs dedicated coordinator and App credentials")
        repository = f"{account}.dkr.ecr.us-east-1.amazonaws.com/opengeo/dev/observable-builder"
        buckets = {"ApplicationBucketName": f"{self.cfg['name']}-{account}-us-east-1-app",
                   "GeodataBucketName": f"{self.cfg['name']}-{account}-us-east-1-data"}
        if (foundation.get("ObservableBuilderRepositoryUri") != repository or not {"api", "compiler"} <= images.keys()
                or any(foundation.get(key) != value for key, value in buckets.items())):
            raise ValueError("nativeGitHubBuild requires the retained exact compiler repository and both immutable images")
        evidence = None
        if "trustEvidencePath" in build:
            path = Path(build["trustEvidencePath"])
            if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
                raise ValueError("nativeGitHubBuild trust evidence must be a bounded ordinary JSON file")
            evidence = json.loads(path.read_text())
        if evidence is not None or build["enabled"]:
            evidence = validate_github_trust(evidence, build)
        configuration = {name: value for name, value in build.items() if name not in {"connection", "trustEvidencePath"}}
        configuration.update({"databaseClusterArn": cluster, "kmsKeyArn": key,
                              "compilerRepositoryArn": f"arn:aws:ecr:us-east-1:{account}:repository/opengeo/dev/observable-builder"})
        if evidence is not None:
            configuration["githubEvidence"] = evidence
        self.github_build_manifest = {"schemaVersion": 1, "configuration": configuration, "connection": build["connection"],
            "apiOriginDomain": self.env["OPEN_GEO_COMMUNITY_API_ORIGIN_DOMAIN"],
            "compilerImageDigest": images["compiler"], "apiImageDigest": images["api"]}
        self.github_build_environment(False)
        return self.github_build_manifest

    def github_build_environment(self, configured):
        self.env["OPEN_GEO_COMMUNITY_GITHUB_BUILD_CONFIG"] = json.dumps({**self.github_build_manifest["configuration"],
            "enabled": configured and self.cfg["nativeGitHubBuild"]["enabled"]})

    def github_build_variables(self):
        build = self.cfg["nativeGitHubBuild"]
        foundation = self.need("foundation.outputs.json")
        configuration = self.github_build_manifest["configuration"]
        return {"STUDIO_INDEPENDENT_BUILD_CONFIG": json.dumps({"account": self.cfg["account"], "region": self.cfg["region"],
                    "repository": build["repository"]["fullName"], "repositoryId": build["repository"]["id"],
                    "ownerId": build["repository"]["ownerId"], "runtimeSha": build["runtimeSha"],
                    "compilerRepository": foundation["ObservableBuilderRepositoryUri"]}, separators=(",", ":")),
            "STUDIO_GITHUB_BUILDS_ENABLED": "false", "STUDIO_GITHUB_FREE_EXECUTION_VERIFIED": "false",
            "STUDIO_BUILD_STAGE": "dev", "STUDIO_BUILD_CLUSTER_ARN": configuration["databaseClusterArn"],
            "STUDIO_BUILD_DATABASE_SECRET_ARN": build["coordinatorDatabaseSecretArn"],
            "STUDIO_BUILD_BUCKET": f"{self.cfg['name']}-{self.cfg['account']}-us-east-1-app",
            "STUDIO_BUILD_ARCHIVE_BUCKET": f"{self.cfg['name']}-{self.cfg['account']}-us-east-1-data",
            "STUDIO_BUILD_KMS_KEY_ARN": configuration["kmsKeyArn"],
            "STUDIO_BUILD_ROLE_ARN": f"arn:aws:iam::{self.cfg['account']}:role/og-{self.cfg['name']}-github-framework-build",
            "STUDIO_COMPILER_ECR_REPOSITORY": foundation["ObservableBuilderRepositoryUri"],
            "STUDIO_COMPILER_IMAGE_DIGEST": self.github_build_manifest["compilerImageDigest"],
            "STUDIO_COMPILER_IMAGE_DIGESTS": self.github_build_manifest["compilerImageDigest"],
            "STUDIO_ARTIFACT_API_ORIGIN": f"https://{self.github_build_manifest['apiOriginDomain']}" if build["artifactInputOrganizations"] else ""}

    def install_github_build(self, config_path, email):
        current = self.github_build_manifest
        retained = self.read("github-build.intent.json")
        same = current == {key: retained.get(key) for key in current}
        if same and retained.get("complete") is True:
            print("Reused the completed GitHub build setup receipt; no resources or connection changed.")
            return
        role_fields = ("coordinatorDatabaseSecretArn", "databaseClusterArn")
        old_config = retained.get("configuration", {})
        role_ready = retained.get("databaseConfigured") is True and all(old_config.get(key) == current["configuration"][key] for key in role_fields)
        connection_fields = ("githubAppSecretArn", "githubAppSecretKeyArn", "repository", "runtimeSha")
        connection_ready = (retained.get("connectionConfigured") is True and retained.get("connection") == current["connection"]
            and all(old_config.get(key) == current["configuration"].get(key) for key in connection_fields))
        # A new execution admission needs current admin/App readback; unchanged
        # function-only role setup is still reused.
        if current["configuration"]["enabled"] and old_config.get("enabled") is not True:
            connection_ready = False
        if old_config.get("enabled") is True and (not role_ready or not connection_ready):
            raise ValueError("disable the admitted build configuration before changing its credentials or immutable connection")
        checkpoint = {**current, "infrastructureConfigured": same and retained.get("infrastructureConfigured") is True,
            "databaseConfigured": role_ready, "connectionConfigured": connection_ready, "complete": False}
        if connection_ready and "connectionReceipt" in retained:
            checkpoint["connectionReceipt"] = retained["connectionReceipt"]
        if role_ready and "roleReceipt" in retained:
            checkpoint["roleReceipt"] = retained["roleReceipt"]
        self.github_build_environment(False)
        self.save("github-build.intent.json", checkpoint)
        if not checkpoint["infrastructureConfigured"]:
            # Install dormant consumers and preserve all exports before API use.
            self.deploy("Foundation", "GitHubBuildAccess", "GitHubBuildController", "Api")
            checkpoint["infrastructureConfigured"] = True
            self.save("github-build.intent.json", checkpoint)
        if not role_ready:
            role = json.loads(run([sys.executable, "database/scripts/apply_migrations.py", "--apply", "--configure-observable-coordinator-only",
                 *self.database_args(include_runtime=False),
                 "--observable-coordinator-secret-arn", self.cfg["nativeGitHubBuild"]["coordinatorDatabaseSecretArn"]], env=self.env, capture=True, timeout=210))
            if (not isinstance(role, dict) or role.get("status") != "configured"
                    or role.get("configureObservableCoordinatorOnly") is not True
                    or role.get("databaseRoles") != ["opengeo_observable_coordinator"]
                    or role.get("passwordsExposed") is not False):
                raise ValueError("coordinator role setup requires its verified bounded receipt")
            checkpoint["databaseConfigured"] = True
            checkpoint["roleReceipt"] = role
            self.save("github-build.intent.json", checkpoint)
        if not connection_ready:
            result = json.loads(run([sys.executable, "database/scripts/bootstrap_github_build_connection.py",
                "--config", str(config_path.resolve()), "--email", email.strip().lower(), "--apply"], env=self.env, capture=True, timeout=300))
            binding = current["connection"]
            if (not isinstance(result, dict) or result.get("account") != self.cfg["account"]
                    or result.get("connectionId") != binding["id"] or result.get("organizationId") != binding["organizationId"]
                    or result.get("status") not in {"registered", "reused"}
                    or result.get("runtimeVerification") != "passed" or result.get("metadataChecks") != "passed"):
                raise ValueError("GitHub build connection needs authorized metadata/runtime readback; no success receipt recorded")
            checkpoint["connectionConfigured"] = True
            checkpoint["connectionReceipt"] = result
            self.save("github-build.intent.json", checkpoint)
        self.github_build_environment(True)
        self.deploy("GitHubBuildAccess", "GitHubBuildController", "Api")
        self.save("github-build.repository-variables.json", self.github_build_variables())
        checkpoint["complete"] = True
        self.save("github-build.intent.json", checkpoint)
        print("GitHub build setup retained. Repository-variable template is disabled; apply and review it explicitly before execution admission.")

    def prepare_publication(self):
        if self.publication_manifest is not None:
            return self.publication_manifest
        publication = self.cfg.get("nativePublication")
        if not publication:
            raise ValueError("nativePublication configuration is required; retained publication resources cannot be silently disabled")
        web = self.need("web.outputs.json")
        self.need("api.outputs.json")
        foundation = self.need("foundation.outputs.json")
        if not all(isinstance(foundation.get(key), str) and foundation[key] for key in
                   ("DatabaseClusterArn", "DatabaseSecretArn", "RuntimeDatabaseSecretArn", "WorkerDatabaseSecretArn")):
            raise ValueError("nativePublication requires retained database and role outputs")
        images = self.need("images.json")
        if not {"api", "compiler"} <= images.keys():
            raise ValueError("nativePublication requires both retained immutable images")
        distribution_id = web.get("StudioDistributionId")
        if not isinstance(distribution_id, str) or not re.fullmatch(r"[A-Z0-9]{1,32}", distribution_id):
            raise ValueError("nativePublication requires the retained Studio distribution ID")
        secret = publication["publisherDatabaseSecretArn"]
        if secret in {foundation.get(key) for key in ("DatabaseSecretArn", "RuntimeDatabaseSecretArn", "WorkerDatabaseSecretArn")}:
            raise ValueError("nativePublication requires a dedicated publisher credential")
        protected_hosts = {urlsplit(self.env["OPEN_GEO_COMMUNITY_WEB_ORIGIN"]).hostname,
                           self.env["OPEN_GEO_COMMUNITY_API_ORIGIN_DOMAIN"]}
        preview = self.cfg.get("nativePreview", {})
        protected_hosts.update(value for key, value in preview.items() if key in {"domainName", "publicMapsDomainName"})
        stem = f"{self.cfg['name']}-{self.cfg['account']}"
        protected_buckets = {f"{stem}-{self.cfg['region']}-{suffix}" for suffix in ("app", "data", "studio")}
        protected_buckets.add(stem + "-preview-shell")
        for target in publication["destinations"]:
            if target["hostname"] in protected_hosts or target["bucket"] in protected_buckets or target["distribution_id"] == distribution_id:
                raise ValueError("nativePublication cannot target Studio, API, preview or private data custody")
        budget_hosts = sorted(protected_hosts | {"studio.opengeo.tools", "preview.studio.opengeo.tools", "demo.studio.opengeo.tools"})
        if len(json.dumps(publication["destinations"], separators=(",", ":")).encode()) + len(json.dumps(budget_hosts, separators=(",", ":")).encode()) > 1800:
            raise ValueError("nativePublication destinations exceed the environment budget")
        self.publication_manifest = {"schemaVersion": 1, "configuration": publication,
            "studioOrigin": self.env["OPEN_GEO_COMMUNITY_WEB_ORIGIN"],
            "studioDistributionId": distribution_id, "apiOriginDomain": self.env["OPEN_GEO_COMMUNITY_API_ORIGIN_DOMAIN"],
            "databaseClusterArn": foundation["DatabaseClusterArn"]}
        self.publication_environment(False)
        return self.publication_manifest

    def publication_environment(self, database_configured):
        publication = self.cfg["nativePublication"]
        self.env["OPEN_GEO_COMMUNITY_PUBLICATION_CONFIG"] = json.dumps({**publication,
            "enabled": database_configured and publication["enabled"]})

    def register_publication_origin(self, config_path, registration_path, email):
        self.prepare_publication()
        if self.need("publication.intent.json").get("databaseConfigured") is not True:
            raise ValueError("finish dedicated publisher database setup before registering an origin")
        receipt = self.read("publication-origins.json") or {"account": self.cfg["account"], "origins": {}}
        if receipt.get("account") != self.cfg["account"]:
            raise ValueError("origin receipt belongs to another account")
        # The owning helper verifies account, hosting and existing membership once.
        result = json.loads(run([sys.executable, "database/scripts/bootstrap_publication_origin.py",
            "--config", str(config_path.resolve()), "--registration", str(registration_path.resolve()),
            "--email", email.strip().lower(), "--apply"], env=self.env, capture=True, timeout=300))
        if (not isinstance(result, dict) or result.get("account") != self.cfg["account"]
                or result.get("hostname") not in {item["hostname"] for item in self.cfg["nativePublication"]["destinations"]}
                or result.get("status") not in {"registered", "reused", "updated"}
                or result.get("runtimeVerification") != "passed" or result.get("metadataChecks") != "passed"
                or type(result.get("generation")) is not int or result["generation"] < 1
                or any(not isinstance(result.get(key), str) or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", result[key]) for key in ("originId", "organizationId"))):
            raise ValueError("origin registration needs verified readback; no receipt recorded")
        receipt["origins"][result["originId"]] = result
        self.save("publication-origins.json", receipt)
        print(json.dumps(result, indent=2))

    def prepare_preview(self):
        if self.preview_manifest is not None:
            return self.preview_manifest
        preview = self.cfg.get("nativePreview")
        if not preview:
            raise ValueError("nativePreview configuration is required; retained previews cannot be silently disabled")
        self.need("web.outputs.json")
        self.need("api.outputs.json")
        images = self.need("images.json")
        if not {"api", "compiler"} <= images.keys():
            raise ValueError("nativePreview requires both retained immutable images")
        studio = self.env["OPEN_GEO_COMMUNITY_WEB_ORIGIN"]
        if urlsplit(studio).hostname in {preview["domainName"], preview.get("publicMapsDomainName")}:
            raise ValueError("nativePreview must be separate from Studio")
        if self.env["OPEN_GEO_COMMUNITY_API_ORIGIN_DOMAIN"] in {preview["domainName"], preview.get("publicMapsDomainName")}:
            raise ValueError("nativePreview must be separate from the API")
        with Path(preview["publicKeyPath"]).open("rb") as source:
            header = source.readline(128)
            if header.rstrip(b"\r\n") != b"-----BEGIN PUBLIC KEY-----":
                raise ValueError("nativePreview accepts only a public SPKI PEM; private key values are never configured here")
            body = header + source.read(8193)
        if len(body) > 8192:
            raise ValueError("nativePreview public key exceeds 8192 bytes")
        pem = body.decode("ascii")
        if not re.fullmatch(r"-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?", pem):
            raise ValueError("nativePreview requires one public SPKI PEM")
        run(["node", "--input-type=module", "-e", "import {createPublicKey} from 'node:crypto';let p='';for await(const b of process.stdin)p+=b;const k=createPublicKey(p);if(k.asymmetricKeyType!=='rsa'||k.asymmetricKeyDetails.modulusLength<2048)throw Error('Preview requires RSA >=2048 bits');"],
            env=self.env, capture=True, stdin=pem, timeout=10)
        descriptor = {key: value for key, value in preview.items() if key != "publicKeyPath"}
        self.env["OPEN_GEO_COMMUNITY_PREVIEW_CONFIG"] = json.dumps({**descriptor, "publicKeyPem": pem})
        self.env["OPEN_GEO_OBSERVABLE_PREVIEW_ORIGIN"] = "https://" + preview["domainName"]
        if "publicMapsDomainName" in preview:
            self.env["OPEN_GEO_OBSERVABLE_PUBLIC_MAPS_PREVIEW_ORIGIN"] = "https://" + preview["publicMapsDomainName"]
        self.preview_manifest = {"schemaVersion": 1, "configuration": descriptor,
                                 "studioOrigin": studio, "apiOriginDomain": self.env["OPEN_GEO_COMMUNITY_API_ORIGIN_DOMAIN"],
                                 "publicKeySha256": hashlib.sha256(body).hexdigest()}
        return self.preview_manifest

    def preview_shell(self):
        studio = self.env["OPEN_GEO_COMMUNITY_WEB_ORIGIN"]
        files = {}
        types = {"index.html": "text/html; charset=utf-8", "draft.html": "text/html; charset=utf-8",
                 "preview-shell.js": "text/javascript; charset=utf-8", "style.css": "text/css; charset=utf-8"}
        for name, content_type in types.items():
            with (ROOT / "services/observable-preview/authorize" / name).open("rb") as source:
                body = source.read(65537)
            if len(body) > 65536:
                raise ValueError("Preview shell file exceeds 64 KiB")
            if name == "draft.html":
                original = b"['https://studio.opengeo.tools', 'https://demo.studio.opengeo.tools']"
                if body.count(original) != 1:
                    raise ValueError("Preview draft origin template changed; review before deployment")
                body = body.replace(original, json.dumps([studio]).encode())
            if name == "index.html":
                original = b"frame-ancestors https://studio.opengeo.tools;"
                if body.count(original) != 1:
                    raise ValueError("Preview shell origin template changed; review before deployment")
                body = body.replace(original, ("frame-ancestors " + studio + ";").encode())
            files[name] = {"body": body, "contentType": content_type, "sha256": hashlib.sha256(body).hexdigest()}
        return files

    def upload_preview_shell(self, files):
        foundation = self.need("foundation.outputs.json")
        bucket = foundation.get("CommunityPreviewShellBucketName")
        if bucket != f"{self.cfg['name']}-{self.cfg['account']}-preview-shell" or foundation.get("CommunityPreviewOrigin") != self.env["OPEN_GEO_OBSERVABLE_PREVIEW_ORIGIN"]:
            raise ValueError("Preview outputs differ from the configured destination")
        receipt = self.read("preview-shell.json")
        if receipt and (receipt.get("bucket") != bucket or receipt.get("account") != self.cfg["account"]):
            raise ValueError("Preview shell receipt belongs to a different destination")
        receipt = receipt or {"bucket": bucket, "account": self.cfg["account"], "files": {}}
        with tempfile.TemporaryDirectory(prefix="opengeo-preview-shell-") as directory:
            for name, item in files.items():
                previous = receipt["files"].get(name)
                if previous and previous.get("sha256") == item["sha256"] and previous.get("versionId"):
                    continue
                # Preserve an uncertain upload and resolve only that object before another write.
                if previous and previous.get("pending"):
                    result = subprocess.run(["aws", "s3api", "head-object", "--bucket", bucket, "--key", "authorize/" + name, "--checksum-mode", "ENABLED",
                        "--expected-bucket-owner", self.cfg["account"], "--profile", self.cfg["profile"], "--region", self.cfg["region"], "--output", "json"],
                        env=self.env, capture_output=True, text=True, timeout=120)
                    if result.returncode == 0:
                        actual = json.loads(result.stdout)
                        if actual.get("ChecksumSHA256") == base64.b64encode(hashlib.sha256(item["body"]).digest()).decode() and actual.get("Metadata", {}).get("opengeo-sha256") == item["sha256"] and actual.get("ContentLength") == len(item["body"]) and actual.get("ContentType") == item["contentType"] and actual.get("CacheControl") == "no-store, max-age=0" and actual.get("VersionId"):
                            receipt["files"][name] = {"sha256": item["sha256"], "versionId": actual["VersionId"]}
                            self.save("preview-shell.json", receipt)
                            continue
                        raise ValueError("Pending preview shell content differs; no write replayed")
                    elif "(404)" not in result.stderr and "(NoSuchKey)" not in result.stderr:
                        raise ValueError("Could not reconcile the pending preview shell upload; no write replayed")
                path = Path(directory) / name
                path.write_bytes(item["body"])
                path.chmod(0o600)
                receipt["files"][name] = {"sha256": item["sha256"], "pending": True}
                self.save("preview-shell.json", receipt)
                checksum = base64.b64encode(hashlib.sha256(item["body"]).digest()).decode()
                result = self.aws(["s3api", "put-object", "--bucket", bucket, "--key", "authorize/" + name,
                    "--body", str(path), "--expected-bucket-owner", self.cfg["account"], "--content-type", item["contentType"],
                    "--cache-control", "no-store, max-age=0", "--metadata", "opengeo-sha256=" + item["sha256"],
                    "--checksum-sha256", checksum])
                if result.get("ChecksumSHA256") != checksum or not result.get("VersionId"):
                    raise ValueError("Preview shell write needs readback; its pending receipt is preserved")
                receipt["files"][name] = {"sha256": item["sha256"], "versionId": result["VersionId"]}
                self.save("preview-shell.json", receipt)

    def read(self, name: str):
        path = self.state / name
        if path.is_symlink():
            raise ValueError("deployment state must not contain symlinks")
        return json.loads(path.read_text()) if path.exists() else {}

    def save(self, name: str, value: dict):
        if self.state.is_symlink():
            raise ValueError("deployment state must not be a symlink")
        write_json(self.state / name, value)

    def aws(self, args: list[str], *, capture=True):
        value = run(["aws", *args, "--profile", self.cfg["profile"], "--region", self.cfg["region"], "--output", "json"], env=self.env, capture=capture, timeout=120)
        return json.loads(value) if capture else None

    def identity(self):
        actual = self.aws(["sts", "get-caller-identity"])
        if actual.get("Account") != self.cfg["account"]:
            raise ValueError("AWS caller does not match the explicitly configured account; no changes made")
        self.save("deployment.json", {k: self.cfg[k] for k in ("account", "region", "name")})

    def outputs(self, kind: str) -> dict:
        response = self.aws(["cloudformation", "describe-stacks", "--stack-name", f"{self.prefix}-{kind}"])
        outputs = {o["OutputKey"]: o["OutputValue"] for o in response["Stacks"][0].get("Outputs", [])}
        self.save(f"{kind.lower()}.outputs.json", outputs)
        return outputs

    def cdk(self, *args: str):
        run([str(ROOT / "infrastructure/node_modules/.bin/cdk"), *args,
             "--app", "node --import tsx bin/opengeo-community.ts", "--profile", self.cfg["profile"]],
            env=self.env, cwd=ROOT / "infrastructure")

    def deploy(self, *kinds: str):
        self.cdk("deploy", *(f"{self.prefix}-{kind}" for kind in kinds), "--exclusively", "--require-approval", "broadening")
        for kind in kinds:
            self.outputs(kind)

    def need(self, file: str):
        value = self.read(file)
        if not value:
            raise ValueError(f"missing {file}; finish the preceding deployment step")
        return value

    def image(self, component: str):
        foundation = self.need("foundation.outputs.json")
        key, context, dockerfile, arch = {
            "api": ("ApiRepositoryUri", "services/api", "Dockerfile.lambda", "arm64"),
            "compiler": ("ObservableBuilderRepositoryUri", "services/observable-builder", "Dockerfile", "amd64"),
            "worker": ("WorkerRepositoryUri", "services/worker", "Dockerfile", "arm64"),
        }[component]
        uri = foundation[key]
        expected = f"{self.cfg['account']}.dkr.ecr.{self.cfg['region']}.amazonaws.com/"
        if not uri.startswith(expected) or not re.fullmatch(r"[a-z0-9/_-]+", uri[len(expected):]):
            raise ValueError("ECR output differs from expected account and region")
        repository = uri[len(expected):]
        source = ROOT / context
        digest = hashlib.sha256()
        # Build input identity includes Dockerfile, locks, source and vendored assets;
        # omit developer artifacts that are also excluded by container context rules.
        for path in sorted(source.rglob("*")):
            if not path.is_file() or path.is_symlink() or any(p in {"node_modules", ".venv", "__pycache__", ".pytest_cache", "dist", ".observablehq", ".test-tmp", ".test-tmp-auth"} for p in path.relative_to(source).parts):
                continue
            digest.update(str(path.relative_to(source)).encode() + b"\0" + path.read_bytes() + b"\0")
        tag = f"community-{digest.hexdigest()[:24]}"
        # Inspect only this exact image; auth/network errors must stop the step,
        # rather than being interpreted as permission to rebuild and push.
        lookup = subprocess.run(["aws", "ecr", "describe-images", "--repository-name", repository,
            "--image-ids", f"imageTag={tag}", "--profile", self.cfg["profile"], "--region", self.cfg["region"],
            "--output", "json"], env=self.env, text=True, capture_output=True, timeout=120, check=False)
        if lookup.returncode and "(ImageNotFoundException)" not in lookup.stderr:
            raise ValueError(f"ECR image lookup failed: {lookup.stderr.strip()}")
        found = [] if lookup.returncode else [json.loads(lookup.stdout)["imageDetails"][0]["imageDigest"]]
        if not found:
            image = f"{uri}:{tag}"
            run(["podman", "build", "--platform", f"linux/{arch}", "--tag", image, "--file", str(source / dockerfile), str(source)], env=self.env, timeout=3600)
            password = run(["aws", "ecr", "get-login-password", "--profile", self.cfg["profile"], "--region", self.cfg["region"]], env=self.env, capture=True, timeout=120)
            with tempfile.TemporaryDirectory(prefix="opengeo-ecr-") as directory:
                authfile = str(Path(directory) / "auth.json")
                run(["podman", "login", "--authfile", authfile, "--username", "AWS", "--password-stdin", uri.split("/")[0]], env=self.env, stdin=password)
                run(["podman", "push", "--authfile", authfile, image], env=self.env, timeout=1800)
            details = self.aws(["ecr", "describe-images", "--repository-name", repository, "--image-ids", f"imageTag={tag}"])
            found = [details["imageDetails"][0]["imageDigest"]]
        images = self.read("images.json")
        images[component] = found[0]
        self.save("images.json", images)
        print(f"Retained {component} image digest {found[0]}")

    def database_args(self, *, include_runtime=True):
        foundation = self.need("foundation.outputs.json")
        return ["--profile", self.cfg["profile"], "--region", self.cfg["region"], "--expected-account", self.cfg["account"],
            "--cluster-arn", foundation["DatabaseClusterArn"], "--admin-secret-arn", foundation["DatabaseSecretArn"],
            *(["--runtime-secret-arn", foundation["RuntimeDatabaseSecretArn"]] if include_runtime else [])]

    def studio_env(self):
        web = self.need("web.outputs.json")
        foundation = self.need("foundation.outputs.json")
        origin = f"https://{web['StudioDistributionDomainName']}"
        env = {**self.env, "OPEN_GEO_COMMUNITY_DEPLOYMENT": "true", "OPEN_GEO_STUDIO_ORIGIN": origin,
            "OPEN_GEO_WEB_ORIGIN": origin, "OPEN_GEO_STUDIO_EXPECTED_ACCOUNT": self.cfg["account"],
            "OPEN_GEO_STUDIO_BUCKET": web["StudioBucketName"], "OPEN_GEO_STUDIO_STACK_NAME": f"{self.prefix}-Web",
            "OPEN_GEO_STUDIO_DISTRIBUTION_ID": web["StudioDistributionId"], "OPEN_GEO_AWS_PROFILE": self.cfg["profile"],
            "OPEN_GEO_AWS_REGION": self.cfg["region"], "OPEN_GEO_COGNITO_REGION": self.cfg["region"],
            "OPEN_GEO_COGNITO_USER_POOL_ID": foundation["UserPoolId"], "OPEN_GEO_COGNITO_CLIENT_ID": foundation["UserPoolClientId"],
            "OPEN_GEO_COGNITO_HOSTED_UI_BASE_URL": foundation["CognitoHostedUiBaseUrl"],
            "OPEN_GEO_STUDIO_DEPLOY_MODE": "bootstrap", "OPEN_GEO_STUDIO_BOOTSTRAP_DOMAIN": web["StudioDistributionDomainName"],
            "OPEN_GEO_STUDIO_DEPLOYMENT_RECORD_PATH": str(self.state / "studio-deployment.json")}
        return env


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("step", choices=STEPS)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--with-preview", action="store_true", help="include configured previews in offline synthesis only")
    parser.add_argument("--with-publication", action="store_true", help="include configured on-demand publisher in offline synthesis only")
    parser.add_argument("--with-github-build", action="store_true", help="include configured dormant GitHub build components in offline synthesis only")
    parser.add_argument("--apply", action="store_true", help="execute this one step; otherwise print an offline plan")
    parser.add_argument("--component", choices=("api", "compiler", "worker", "all"), default="all")
    parser.add_argument("--execution-policy-arn", help="explicit managed CloudFormation execution policy for bootstrap")
    parser.add_argument("--email")
    parser.add_argument("--registration", type=Path, help="explicit publication-origin identity and address delegation file")
    parser.add_argument("--display-name")
    parser.add_argument("--organization-name", default="Community workspace")
    parser.add_argument("--organization-slug", default="community-workspace")
    parser.add_argument("--release-origin", help="exact previous /releases/opengeo-studio-* pointer for rollback")
    args = parser.parse_args(argv)
    if args.with_preview and args.step != "synth":
        raise ValueError("--with-preview belongs only to offline synth")
    if args.with_publication and args.step != "synth":
        raise ValueError("--with-publication belongs only to offline synth")
    if args.with_github_build and args.step != "synth":
        raise ValueError("--with-github-build belongs only to offline synth")
    deployment = Deployment(load_config(args.config), allow_preview_change=args.step == "preview" and args.apply,
                            allow_publication_change=args.step == "publication" and args.apply,
                            allow_github_build_change=args.step == "github-build" and args.apply)
    if args.step == "plan" or (not args.apply and args.step != "synth"):
        print(json.dumps({"mode": "offline-plan", "step": args.step, "account": deployment.cfg["account"],
            "region": deployment.cfg["region"], "name": deployment.cfg["name"], "withWorker": deployment.cfg.get("withWorker", False),
            "nativePreviewConfigured": "nativePreview" in deployment.cfg,
            "nativePublicationConfigured": "nativePublication" in deployment.cfg,
            "nativeGitHubBuildConfigured": "nativeGitHubBuild" in deployment.cfg,
            "order": ["synth", "bootstrap", "web", "foundation", "images", "database", "runtime", *(["preview"] if "nativePreview" in deployment.cfg else []), *(["publication"] if "nativePublication" in deployment.cfg else []), "web", "studio", "owner", *(["publication-origin"] if "nativePublication" in deployment.cfg else []), *(["github-build"] if "nativeGitHubBuild" in deployment.cfg else []), "status"],
            "next": "Read docs/community-aws.md; --apply runs only the named step. synth is offline."}, indent=2))
        return 0
    if args.step == "synth":
        if args.with_preview:
            deployment.prepare_preview()
        if args.with_publication:
            deployment.prepare_publication()
        if args.with_github_build:
            deployment.prepare_github_build()
            deployment.github_build_environment(False)
        # Invoke the app directly so synthesis cannot query AWS credentials/context.
        run(["node", "--import", "tsx", "bin/opengeo-community.ts"], env=deployment.env, cwd=ROOT / "infrastructure")
        print("Offline CloudFormation assembly written to infrastructure/cdk.out")
        return 0
    if args.step == "owner" and (not args.email or not args.display_name):
        raise ValueError("owner requires --email and --display-name; first invite the user and verify the email in your own Cognito pool")
    if args.step == "publication-origin":
        if not args.email or not args.registration:
            raise ValueError("publication-origin requires --registration and the existing account administrator's --email")
        deployment.register_publication_origin(args.config, args.registration, args.email)
        return 0
    if args.step == "bootstrap" and not re.fullmatch(r"arn:aws:iam::(?:aws|" + deployment.cfg["account"] + r"):policy/[A-Za-z0-9+=,.@_/-]+", args.execution_policy_arn or ""):
        raise ValueError("bootstrap requires an explicit --execution-policy-arn in your account or AWS managed policy")
    if args.step == "preview":
        preview_intent = deployment.prepare_preview()
        preview_files = deployment.preview_shell()
    if args.step == "publication":
        publication_intent = deployment.prepare_publication()
    if args.step == "github-build":
        if not args.email:
            raise ValueError("github-build requires the existing account administrator's --email")
        deployment.prepare_github_build()
    deployment.identity()
    if args.step == "bootstrap":
        deployment.cdk("bootstrap", f"aws://{deployment.cfg['account']}/{deployment.cfg['region']}", "--cloudformation-execution-policies", args.execution_policy_arn)
    elif args.step == "web":
        deployment.deploy("Web")
    elif args.step == "foundation":
        deployment.need("web.outputs.json")
        deployment.deploy("Foundation")
    elif args.step == "images":
        components = [args.component] if args.component != "all" else ["api", "compiler"] + (["worker"] if deployment.cfg.get("withWorker") else [])
        for component in components:
            deployment.image(component)
    elif args.step == "database":
        foundation = deployment.need("foundation.outputs.json")
        run([sys.executable, "database/scripts/apply_migrations.py", "--apply", *deployment.database_args(), "--worker-secret-arn", foundation["WorkerDatabaseSecretArn"]], env=deployment.env)
    elif args.step == "runtime":
        images = deployment.need("images.json")
        if not {"api", "compiler"} <= images.keys() or (deployment.cfg.get("withWorker") and "worker" not in images):
            raise ValueError("runtime requires all selected image digests from the images step")
        # The initial Foundation template has no runtime consumers. Re-deploy
        # it with the complete assembly to create their cross-stack exports.
        kinds = ["Foundation", "PrivateRuntimeEndpoints", "Worker", "Api"] if deployment.cfg.get("withWorker") else ["Foundation", "Api"]
        deployment.deploy(*kinds)
    elif args.step == "preview":
        # Save intent before the first stack change; continuation must retain it.
        deployment.save("preview.intent.json", preview_intent)
        deployment.deploy("Foundation", "Api", "Web")
        deployment.upload_preview_shell(preview_files)
    elif args.step == "publication":
        retained = deployment.read("publication.intent.json")
        ready = retained.get("databaseConfigured") is True and publication_intent == {key: retained.get(key) for key in publication_intent}
        if not ready:
            # Install a dormant consumer before configuring its function-only login.
            deployment.publication_environment(False)
            deployment.save("publication.intent.json", {**publication_intent, "databaseConfigured": False})
            deployment.deploy("Foundation", "FrameworkPublisher")
            run([sys.executable, "database/scripts/apply_migrations.py", "--apply", *deployment.database_args(),
                 "--worker-secret-arn", deployment.need("foundation.outputs.json")["WorkerDatabaseSecretArn"],
                 "--framework-publisher-secret-arn", deployment.cfg["nativePublication"]["publisherDatabaseSecretArn"]], env=deployment.env)
            deployment.save("publication.intent.json", {**publication_intent, "databaseConfigured": True})
        deployment.publication_environment(True)
        deployment.deploy("FrameworkPublisher", "Api")
    elif args.step == "github-build":
        deployment.install_github_build(args.config, args.email)
    elif args.step == "studio":
        deployment.need("api.outputs.json")
        env = deployment.studio_env()
        run(["npm", "--prefix", "app", "run", "prepare:studio"], env=env, timeout=600)
        run(["npm", "--prefix", "app", "run", "check:studio-release"], env=env, timeout=120)
        env["OPEN_GEO_STUDIO_BOOTSTRAP_DEPLOY_CONFIRM"] = f"deploy-{deployment.need('web.outputs.json')['StudioDistributionDomainName']}"
        run(["node", "app/scripts/deploy-studio-site.mjs"], env=env, timeout=1800)
    elif args.step == "rollback":
        if not re.fullmatch(r"/releases/opengeo-studio-[0-9]{14}-[0-9a-f]{12}", args.release_origin or ""):
            raise ValueError("rollback requires an exact --release-origin from the retained deployment record")
        env = deployment.studio_env()
        env["OPEN_GEO_STUDIO_ROLLBACK_ORIGIN"] = args.release_origin
        env["OPEN_GEO_STUDIO_BOOTSTRAP_ROLLBACK_CONFIRM"] = f"rollback-{deployment.need('web.outputs.json')['StudioDistributionDomainName']}"
        run(["node", "app/scripts/rollback-studio-site.mjs"], env=env, timeout=1800)
    elif args.step == "owner":
        pool = deployment.need("foundation.outputs.json")["UserPoolId"]
        user = deployment.aws(["cognito-idp", "admin-get-user", "--user-pool-id", pool, "--username", args.email])
        attrs = {a["Name"]: a["Value"] for a in user["UserAttributes"]}
        if attrs.get("email_verified") != "true" or attrs.get("email", "").lower() != args.email.lower() or not user.get("Enabled"):
            raise ValueError("owner must be an enabled principal with the exact verified email")
        run([sys.executable, "database/scripts/bootstrap_owner.py", "--apply", *deployment.database_args(),
            "--subject", attrs["sub"], "--email", args.email.lower(), "--display-name", args.display_name,
            "--organization-name", args.organization_name, "--organization-slug", args.organization_slug,
            "--project-name", "Community content", "--project-code", "community-content"], env=deployment.env)
    elif args.step == "status":
        for kind in ("Web", "Foundation", "Api", *(["FrameworkPublisher"] if deployment.publication_manifest else []),
                     *(["GitHubBuildAccess", "GitHubBuildController"] if deployment.github_build_manifest else [])):
            outputs = deployment.outputs(kind)
            print(json.dumps({"stack": f"{deployment.prefix}-{kind}", "outputs": outputs}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        print(f"community deployment stopped: {error}", file=sys.stderr)
        raise SystemExit(1)
