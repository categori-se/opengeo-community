"""One disposable CKAN create/read/purge journey; no pulls unless --allow-pull."""

import argparse
import concurrent.futures
import contextlib
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
IMAGES = {
    "ckan": "docker.io/ckan/ckan-base@sha256:"
    "49d527b4f5a08ae47a5e6a2f293daa1db49d08484d1a4383d072262e5746320c",
    "solr": "docker.io/ckan/ckan-solr@sha256:"
    "ef8e5d3e6be1678cfe50ceb14a8ebf16c36d44aac2de1086a285ce6807af64e6",
    "redis": "docker.io/library/redis@sha256:"
    "ca0acbb137c1dc3339c8b147a58fd6f42775d4599327b50e7b116c23de501af2",
    "postgres": "docker.io/postgis/postgis@sha256:"
    "8828b03e9a95269f808abe62aa83215b22a2d3710f54a55e8040327b7b5f9932",
}
COMPRESSED_NEW_LAYER_BYTES = 1_045_111_215


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-pull", action="store_true")
    parser.add_argument("--budget-seconds", type=int, default=600)
    parser.add_argument("--output", type=Path, default=ROOT / ".opengeo/ckan-roundtrip.json")
    args = parser.parse_args()
    if not 1 <= args.budget_seconds <= 600:
        parser.error("--budget-seconds must be between 1 and 600")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    log = args.output.with_suffix(".log")
    start = time.monotonic()
    cleanup_deadline = start + args.budget_seconds
    cleanup_reserve = min(60, args.budget_seconds / 4)
    deadline = cleanup_deadline - cleanup_reserve
    prefix = "opengeo-ckan-" + secrets.token_hex(5)
    names = {role: prefix + "-" + role for role in IMAGES}
    network = prefix + "-network"
    passwords = [secrets.token_urlsafe(32), secrets.token_urlsafe(32)]
    receipt: dict[str, Any] = {
        "result": "in_progress",
        "source_commit": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
        ).strip(),
        "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "limits": {
            "total_seconds": args.budget_seconds,
            "cleanup_reserved_seconds": cleanup_reserve,
            "pull_seconds": 240,
            "maximum_new_pulls": 3,
            "manifest_compressed_layer_bytes": COMPRESSED_NEW_LAYER_BYTES,
            "actual_wire_bytes": "unavailable",
            "fixture_count": 1,
        },
        "transport": "loopback HTTP and internal disposable Podman network",
        "authentication": "Real CKAN token for generated disposable local sysadmin; no Cognito",
        "destination_configuration": {"create_unowned_dataset": True, "plugins": ["envvars"]},
        "images": {},
        "assertions": [],
        "cleanup": {},
        "errors": [],
        "not_proven": [
            "CKAN UI",
            "harvesting",
            "synchronization",
            "cloud acceptance",
            "destination permission policy beyond synthetic sysadmin",
        ],
    }
    base_url = ""
    token = ""
    created_id = None
    purged = False
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def checkpoint() -> None:
        receipt["elapsed_seconds"] = round(time.monotonic() - start, 2)
        args.output.write_text(json.dumps(receipt, sort_keys=True, indent=2) + "\n")

    def run(
        command: list[str],
        *,
        env: dict[str, str] | None = None,
        secret_output: bool = False,
        limit: float = 60,
    ) -> str:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("workflow budget exhausted")
        completed = subprocess.run(
            command,
            cwd=ROOT,
            capture_output=True,
            text=True,
            env=env,
            timeout=min(limit, remaining),
            check=False,
        )
        if not secret_output:
            output = completed.stdout + completed.stderr
            for password in passwords:
                output = output.replace(password, "[redacted]")
            with log.open("a") as stream:
                stream.write(output)
        if completed.returncode:
            raise RuntimeError(f"{command[0]} {command[1]} failed ({completed.returncode})")
        return completed.stdout.strip()

    def assertion(name: str, condition: bool) -> None:
        if not condition:
            raise AssertionError(name)
        receipt["assertions"].append(name)

    def action(
        name: str, data: dict[str, Any], *, not_found: bool = False, cleanup: bool = False
    ) -> Any:
        remaining = (cleanup_deadline if cleanup else deadline) - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("action budget exhausted")
        request = urllib.request.Request(
            base_url + "/api/3/action/" + name,
            json.dumps(data).encode(),
            {"Content-Type": "application/json", "Authorization": token},
            method="POST",
        )
        try:
            with opener.open(request, timeout=min(10, remaining)) as response:
                status, raw = response.status, response.read(1_048_577)
        except urllib.error.HTTPError as error:
            status, raw = error.code, error.read(1_048_577)
        if len(raw) > 1_048_576:
            raise RuntimeError("CKAN response exceeds bound")
        body = json.loads(raw)
        if not_found:
            return status == 404 and body.get("success") is False
        if status != 200 or body.get("success") is not True:
            receipt["errors"].append(
                {
                    "action": name,
                    "status": status,
                    "error": body.get("error", {}).get("__type", "unknown"),
                }
            )
            raise RuntimeError("CKAN action failed: " + name)
        return body["result"]

    try:
        for role, image in IMAGES.items():
            probe = subprocess.run(
                ["podman", "image", "exists", image],
                capture_output=True,
                check=False,
                timeout=min(10, max(0.1, deadline - time.monotonic())),
            )
            if probe.returncode not in {0, 1}:
                raise RuntimeError("Podman image existence probe failed")
            cached = probe.returncode == 0
            receipt["images"][role] = {"reference": image, "cached_before": cached}
        missing = [role for role in IMAGES if not receipt["images"][role]["cached_before"]]
        if "postgres" in missing or (missing and not args.allow_pull):
            raise RuntimeError("Required images missing; --allow-pull permits three pinned pulls")
        if missing:
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
                futures = [
                    executor.submit(run, ["podman", "pull", IMAGES[role]], limit=240)
                    for role in missing
                ]
                for future in futures:
                    future.result()
        if time.monotonic() - start > 240:
            raise TimeoutError("pull budget exhausted")
        for role, image in IMAGES.items():
            details = json.loads(run(["podman", "image", "inspect", image], secret_output=True))[0]
            receipt["images"][role]["identity"] = {
                "id": details.get("Id") or details.get("ID"),
                "digests": details.get("RepoDigests", []),
            }
        run(["podman", "network", "create", "--internal", network])
        common = ["--detach", "--pull=never", "--network", network]
        env = {**os.environ, "POSTGRES_PASSWORD": passwords[0]}
        run(
            [
                "podman",
                "run",
                *common,
                "--name",
                names["postgres"],
                "--network-alias",
                "db",
                "--env",
                "POSTGRES_PASSWORD",
                "--env",
                "POSTGRES_USER=ckan",
                "--env",
                "POSTGRES_DB=ckan",
                IMAGES["postgres"],
            ],
            env=env,
        )
        run(
            [
                "podman",
                "run",
                *common,
                "--name",
                names["redis"],
                "--network-alias",
                "redis",
                IMAGES["redis"],
                "redis-server",
                "--save",
                "",
                "--appendonly",
                "no",
            ]
        )
        run(
            [
                "podman",
                "run",
                *common,
                "--name",
                names["solr"],
                "--network-alias",
                "solr",
                "--env",
                "SOLR_HEAP=512m",
                IMAGES["solr"],
            ]
        )
        local_settings = {
            "CKAN_SQLALCHEMY_URL": f"postgresql://ckan:{passwords[0]}@db/ckan",
            "CKAN_SOLR_URL": "http://solr:8983/solr/ckan",
            "CKAN_REDIS_URL": "redis://redis:6379/0",
            "CKAN__PLUGINS": "envvars",
            "CKAN__AUTH__CREATE_UNOWNED_DATASET": "true",
            "CKAN_SYSADMIN_NAME": "opengeo-roundtrip",
            "CKAN_SYSADMIN_PASSWORD": passwords[1],
            "CKAN_SYSADMIN_EMAIL": "roundtrip@example.test",
            "CKAN_SITE_URL": "http://127.0.0.1:5000",
        }
        env.update(local_settings)
        ckan_environment = [item for key in local_settings for item in ("--env", key)]
        # Official prerun initializes the DB before updating plugins. Configure core
        # settings first: its legacy connectivity-check env names are not INI keys.
        configure = (
            "import os,subprocess; "
            "pairs={'sqlalchemy.url':'CKAN_SQLALCHEMY_URL',"
            "'solr_url':'CKAN_SOLR_URL','ckan.redis.url':'CKAN_REDIS_URL',"
            "'ckan.site_url':'CKAN_SITE_URL','ckan.plugins':'CKAN__PLUGINS'}; "
            "[subprocess.run(['ckan','config-tool',os.environ['CKAN_INI'],"
            "key+' = '+os.environ[env]],check=True,stdout=subprocess.DEVNULL) "
            "for key,env in pairs.items()]; "
            "os.execv('/srv/app/start_ckan.sh',['/srv/app/start_ckan.sh'])"
        )
        run(
            [
                "podman",
                "run",
                *common,
                "--name",
                names["ckan"],
                "--publish",
                "127.0.0.1::5000",
                *ckan_environment,
                IMAGES["ckan"],
                "python",
                "-c",
                configure,
            ],
            env=env,
        )
        base_url = "http://" + run(["podman", "port", names["ckan"], "5000/tcp"])
        startup_deadline = min(deadline, time.monotonic() + 360)
        for _ in range(120):
            if time.monotonic() >= startup_deadline:
                raise TimeoutError("startup budget exhausted")
            try:
                with opener.open(base_url + "/api/3/action/status_show", timeout=2) as response:
                    status = json.load(response)
                if status.get("success"):
                    break
            except (OSError, ValueError):
                time.sleep(2)
        else:
            raise TimeoutError("CKAN startup did not become ready")
        assertion("actual CKAN version is 2.11.6", status["result"]["ckan_version"] == "2.11.6")
        token_output = run(
            [
                "podman",
                "exec",
                names["ckan"],
                "ckan",
                "-c",
                "/srv/app/ckan.ini",
                "user",
                "token",
                "add",
                "opengeo-roundtrip",
                "opengeo-local",
            ],
            secret_output=True,
        )
        token = re.search(r"eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", token_output)[0]
        passwords.append(token)
        sys.path.insert(0, str(ROOT / "services/api/src"))
        from opengeo_api.ckan_export import export_stac_ckan
        from opengeo_api.json_canonical import canonical_json_bytes

        fixture = ROOT / "docs/api/fixtures/stac-ckan-collection.json"
        raw_fixture = fixture.read_bytes()
        exported = export_stac_ckan(json.loads(raw_fixture), namespace="example.synthetic")
        payload = exported["payload"]
        receipt["payload_sha256"] = hashlib.sha256(canonical_json_bytes(payload)).hexdigest()
        receipt["source_sha256"] = exported["source"]["sourceSha256"]
        receipt["raw_fixture_sha256"] = hashlib.sha256(raw_fixture).hexdigest()
        created = action("package_create", payload)
        created_id = created["id"]
        receipt["fixture_id"] = created_id
        checkpoint()  # Never replay a committed create to repair later evidence.
        readback = action("package_show", {"id": created_id})
        receipt["ckan_defaults"] = {
            key: readback.get(key) for key in ("private", "state", "license_id", "owner_org")
        }
        receipt["selected_readback"] = {
            key: readback[key]
            for key in ("id", "name", "title", "notes", "url", "tags", "extras", "resources")
        }
        for field in ("name", "title", "notes", "url"):
            assertion("readback " + field + " matches payload", readback[field] == payload[field])
        assertion(
            "readback tags match payload",
            sorted(tag["name"] for tag in readback["tags"])
            == sorted(tag["name"] for tag in payload["tags"]),
        )
        expected_extras = {item["key"]: item["value"] for item in payload["extras"]}
        actual_extras = {item["key"]: item["value"] for item in readback["extras"]}
        assertion(
            "all provenance/publisher/extent/license/link extras match exactly",
            actual_extras == expected_extras,
        )
        assertion(
            "resource count matches payload",
            len(readback["resources"]) == len(payload["resources"]),
        )
        for expected, actual in zip(payload["resources"], readback["resources"], strict=True):
            assertion(
                "all declared resource reference fields match",
                all(actual[key] == value for key, value in expected.items()),
            )
        assertion(
            "CKAN creates its own resource and package IDs",
            bool(created_id) and all(resource["id"] for resource in readback["resources"]),
        )
        assertion(
            "payload contains no destination ownership, visibility, license ID or grants",
            not {"id", "owner_org", "private", "state", "license_id", "groups", "permissions"}
            & payload.keys(),
        )
        receipt["resource_ids"] = [resource["id"] for resource in readback["resources"]]
        action("package_delete", {"id": created_id})
        action("dataset_purge", {"id": created_id})
        assertion(
            "purged fixture returns actual HTTP 404",
            action("package_show", {"id": created_id}, not_found=True),
        )
        purged = True
        receipt["result"] = "pass_local_ckan_roundtrip"
    except Exception as error:
        receipt["result"] = "failed"
        receipt["errors"].append(
            {
                "type": type(error).__name__,
                "stage": "bounded local journey",
                "detail": str(error)
                if isinstance(error, (RuntimeError, AssertionError))
                else "redacted",
            }
        )
    finally:
        with contextlib.suppress(Exception):
            run(["podman", "logs", "--tail", "200", names["ckan"]], limit=10)
        if created_id and not purged:
            try:
                action("dataset_purge", {"id": created_id}, cleanup=True)
                receipt["cleanup"]["fixture_purged_after_failure"] = True
            except Exception:
                receipt["cleanup"]["fixture_purged_after_failure"] = False

        def cleanup_command(command: list[str]) -> int | None:
            try:
                remaining = cleanup_deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("cleanup budget exhausted")
                return subprocess.run(
                    command, capture_output=True, check=False, timeout=min(10, remaining)
                ).returncode
            except (OSError, subprocess.TimeoutExpired, TimeoutError) as error:
                receipt["errors"].append({"stage": "cleanup", "type": type(error).__name__})
                return None

        for role, name in reversed(list(names.items())):
            removed = cleanup_command(["podman", "rm", "--force", "--time", "0", "--volumes", name])
            absent = cleanup_command(["podman", "container", "exists", name])
            receipt["cleanup"][role + "_container_and_volumes_removed"] = (
                removed in {0, 1} and absent == 1
            )
        removed = cleanup_command(["podman", "network", "rm", network])
        absent = cleanup_command(["podman", "network", "exists", network])
        receipt["cleanup"]["network_removed"] = removed in {0, 1} and absent == 1
        if not all(receipt["cleanup"].values()):
            receipt["result"] = "failed_cleanup_unconfirmed"
        receipt["cleanup"]["new_images_retained_in_cache"] = True
        checkpoint()
    print(receipt["result"] + "; assertions=" + str(len(receipt["assertions"])))
    return 0 if receipt["result"] == "pass_local_ckan_roundtrip" else 1


if __name__ == "__main__":
    raise SystemExit(main())
