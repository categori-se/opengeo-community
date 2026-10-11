"""Run the actual Studio against isolated API/PostGIS/GIS-worker dependencies.

Only identity verification and cloud transports are substituted. No AWS calls,
published ports, remote browser services, or production credentials are used.
"""

import argparse
import base64
import fcntl
import importlib.util
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from uuid import uuid4
from contextlib import ExitStack
from datetime import UTC, datetime, timedelta
from email.parser import BytesParser
from email.policy import default
from pathlib import Path
from urllib.parse import quote, urlencode

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "integrated_pilot", ROOT / "scripts/run-integrated-pilot-local.py"
)
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)
UPLOAD_URL = "https://s3.us-east-1.amazonaws.com/local-pilot.invalid"
FONT_DIRECTORY = Path("opengeo-open-sans-v1/1")
FONT_ASSET_ROOT = ROOT / "app/src/assets/render-fonts" / FONT_DIRECTORY
FONT_RUNTIME_MOUNT = "/opt/opengeo-maplibre"


def verify_runtime_package(package, expected_manifest_sha256):
    sys.path.insert(0, str(ROOT / "services/worker/src"))
    from opengeo_worker.maplibre_package import verify_package

    return verify_package(package, expected_sha256=expected_manifest_sha256)


def verify_runtime_source_bindings(manifest):
    inventory = {entry["path"]: entry for entry in manifest["inventory"]}
    sources = [
        (
            f"rootfs/{manifest['entrypoints']['script']}",
            ROOT / "services/worker/scripts/render-maplibre.mjs",
        ),
        *(
            (f"fonts/{FONT_DIRECTORY}/{source.name}", source)
            for source in font_source_paths()
            if source.parent == FONT_ASSET_ROOT
        ),
    ]
    for relative, source in sources:
        content = source.read_bytes()
        entry = inventory.get(relative)
        if (
            entry is None
            or entry["bytes"] != len(content)
            or entry["sha256"] != pilot.digest(content)
        ):
            raise ValueError(f"Packaged runtime source identity mismatch: {relative}")
    bundle = build_renderer_bundle()
    bundle_entry = inventory[f"rootfs/{manifest['entrypoints']['bundle']}"]
    if bundle_entry["sha256"] != pilot.digest(bundle) or bundle_entry["bytes"] != len(
        bundle
    ):
        raise ValueError(
            "Packaged renderer bundle differs from the canonical source build"
        )
    source_manifest = FONT_ASSET_ROOT / "manifest.json"
    font_reference = {
        "id": "opengeo-open-sans-v1",
        "version": 1,
        "manifestChecksumSha256": pilot.digest(source_manifest.read_bytes()),
    }
    if font_reference not in manifest["fontRefs"]:
        raise ValueError("The runtime package does not declare the exact Studio font")


def build_renderer_bundle():
    generated = subprocess.run(
        ["node", "app/scripts/build-maplibre-render-bundle.mjs"],
        cwd=ROOT,
        capture_output=True,
        check=True,
        timeout=60,
    ).stdout
    if not 1 <= len(generated) <= 8_388_608:
        raise ValueError("Unexpected canonical renderer bundle size")
    return generated


def verify_cached_worker_image(architecture):
    inspected = subprocess.run(
        ["podman", "image", "inspect", pilot.WORKER_IMAGE],
        capture_output=True,
        check=True,
    )
    images = json.loads(inspected.stdout)
    if (
        not isinstance(images, list)
        or len(images) != 1
        or images[0].get("Id", "").removeprefix("sha256:") != pilot.WORKER_IMAGE
        or images[0].get("Architecture")
        != {"x86_64": "amd64", "aarch64": "arm64"}.get(architecture)
    ):
        raise ValueError(
            "The exact cached worker image and runtime architecture must match"
        )


def verify_cached_images(database_image):
    missing = []
    for image in (pilot.API_IMAGE, pilot.WORKER_IMAGE, database_image):
        result = subprocess.run(
            ["podman", "image", "exists", image],
            check=False,
            capture_output=True,
            timeout=15,
        )
        if result.returncode == 1:
            missing.append(image)
        elif result.returncode != 0:
            raise RuntimeError(
                "Cannot inspect the local container cache; no test was started"
            )
    if missing:
        raise RuntimeError(
            "Local Studio test images are missing: "
            + ", ".join(missing)
            + ". Restore the pinned test dependencies before retrying; "
            "this runner does not download or rebuild images."
        )


def load_font_runtime(package, expected_manifest_sha256):
    """Resolve an explicit local payload, never a package discovery/download."""
    if not re.fullmatch(r"[a-f0-9]{64}", expected_manifest_sha256 or ""):
        raise ValueError("Use an exact lowercase runtime manifest SHA-256")
    package = Path(package)
    if (
        not package.is_absolute()
        or any(character in str(package) for character in ":\n\r")
        or package.is_symlink()
        or not package.is_dir()
    ):
        raise ValueError(
            "Use an existing nonsymlink runtime package directory under /tmp"
        )
    resolved = package.resolve(strict=True)
    if (
        resolved != package
        or resolved == Path("/tmp")
        or not resolved.is_relative_to("/tmp")
    ):
        raise ValueError(
            "Use an exact runtime package directory under /tmp without symlinks"
        )
    manifest = package / "runtime.json"
    if (
        manifest.is_symlink()
        or not manifest.is_file()
        or manifest.stat().st_size > 4_194_304
    ):
        raise ValueError("The runtime package needs a bounded regular runtime.json")
    if pilot.digest(manifest.read_bytes()) != expected_manifest_sha256:
        raise ValueError("Runtime manifest SHA-256 mismatch")
    verified = verify_runtime_package(package, expected_manifest_sha256)
    verify_runtime_source_bindings(verified)
    return {
        "package_directory": str(package),
        "manifest_sha256": expected_manifest_sha256,
        "architecture": verified["architecture"],
        "sandbox": verified["sandbox"],
    }


def font_source_paths():
    manifest = json.loads((FONT_ASSET_ROOT / "manifest.json").read_bytes())
    ranges = [entry["range"] for entry in manifest["ranges"]]
    if not 1 <= len(ranges) <= 256 or any(
        not isinstance(value, str) or not re.fullmatch(r"[0-9]+-[0-9]+", value)
        for value in ranges
    ):
        raise ValueError("Unexpected font source range inventory")
    return [
        FONT_ASSET_ROOT / "manifest.json",
        FONT_ASSET_ROOT / "LICENSE.txt",
        FONT_ASSET_ROOT / "NOTICE.txt",
        *(FONT_ASSET_ROOT / f"{value}.pbf" for value in ranges),
        ROOT / "app/node_modules/maplibre-gl/package.json",
        *[
            ROOT / "app/node_modules/maplibre-gl/dist" / name
            for name in (
                ("maplibre-gl.mjs", "maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs")
                if json.loads((ROOT / "app/node_modules/maplibre-gl/package.json").read_bytes())["version"] == "6.0.0"
                else ("maplibre-gl.js",)
            )
        ],
        ROOT / "app/src/assets/maplibre-worker.js.js",
        ROOT / "app/node_modules/esbuild/package.json",
        ROOT / "app/scripts/build-maplibre-render-bundle.mjs",
        ROOT / "services/worker/scripts/render-maplibre.mjs",
    ]


def browser_command(
    work,
    pinned_map_fonts=False,
    built_studio=False,
    restore_checkpoint=False,
    service_clients=False,
    wcs_only=False,
    analysis_only=False,
    development=False,
):
    return [
        "node",
        "app/scripts/check-integrated-studio.mjs",
        str(work),
        *(["--pinned-map-fonts"] if pinned_map_fonts else []),
        *(["--built-studio"] if built_studio else []),
        *(["--restore-checkpoint"] if restore_checkpoint else []),
        *(["--service-clients"] if service_clients else []),
        *(["--wcs-only"] if wcs_only else []),
        *(["--analysis-only"] if analysis_only else []),
        *(["--development"] if development else []),
    ]


def stage_built_studio(work, reuse_tree=None):
    """Build in a new source copy; preserve existing build and rollback artifacts."""
    if reuse_tree is not None:
        if not re.fullmatch(r"[0-9a-f]{64}", reuse_tree):
            raise ValueError("Reuse requires an exact Studio tree SHA-256")
        reuse_root = Path(os.environ.get("OPENGEO_STUDIO_REUSE_ROOT", str(ROOT))).resolve()
        source_manifest = reuse_root / "dist/opengeo-studio-build.json"
        manifest = json.loads(source_manifest.read_bytes())
        if manifest["artifactTree"]["digest"] != reuse_tree:
            raise ValueError("Requested Studio artifact is not the current sealed tree")
        target = work / "built-studio/app/dist"
        target.mkdir(parents=True)
        for entry in manifest["artifactTree"]["files"]:
            relative = Path(entry["path"])
            if relative.is_absolute() or any(part in {".", ".."} for part in relative.parts):
                raise ValueError("Unsafe artifact path")
            source = reuse_root / "app/dist" / relative
            if source.is_symlink() or not source.resolve().is_relative_to((reuse_root / "app/dist").resolve()):
                raise ValueError("Artifact file must be within the sealed tree")
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        manifest_target = work / "built-studio/dist/opengeo-studio-build.json"
        manifest_target.parent.mkdir(parents=True)
        shutil.copyfile(source_manifest, manifest_target)
        subprocess.run(["node", "--input-type=module", "-e",
            "import {loadIntegratedStudioBuild} from './app/scripts/integrated-studio-built-shell.mjs'; await loadIntegratedStudioBuild(process.argv[1]);",
            str(work)], cwd=ROOT, check=True, timeout=30)
        shutil.copyfile(manifest_target, work / "studio-build-manifest.json")
        (work / "studio-build-reuse.json").write_text(json.dumps({
            "treeDigest": reuse_tree, "rebuilt": False,
            "sourceRelationship": "Previously sealed artifact; current source fingerprints describe the harness/backend, not rebuilt frontend bytes"
        }, indent=2) + "\n")
        return
    app = work / "built-studio/app"
    app.mkdir(parents=True)
    for directory in ("src", "scripts"):
        shutil.copytree(ROOT / "app" / directory, app / directory)
    if (ROOT / "app/public-embeds").is_dir():
        shutil.copytree(ROOT / "app/public-embeds", app / "public-embeds")
    if (ROOT / "app/vendor").is_dir():
        shutil.copytree(ROOT / "app/vendor", app / "vendor")
    for filename in ("package.json", "package-lock.json", "observablehq.config.js"):
        shutil.copyfile(ROOT / "app" / filename, app / filename)
    for relative in (
        "services/observable-builder/scripts/notebook-assets.mjs",
        "services/observable-builder/src/notebook-runtime.mjs",
        "services/observable-builder/src/portable-map-view.mjs",
        "services/observable-builder/src/legacy-notebook-runtime.mjs",
        "services/observable-builder/src/legacy-observable.mjs",
        "services/observable-builder/src/jupyter-notebook.mjs",
        "services/observable-builder/src/observable-notebook.mjs",
    ):
        target = work / "built-studio" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / relative, target)
    (app / "node_modules").symlink_to(
        ROOT / "app/node_modules", target_is_directory=True
    )
    environment = {**os.environ, "OBSERVABLE_TELEMETRY_DISABLE": "1"}
    with (work / "studio-build.log").open("wb") as log:
        for script in ("build-studio-site.mjs", "check-studio-build.mjs"):
            subprocess.run(
                ["node", f"scripts/{script}"],
                cwd=app,
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
                check=True,
                timeout=180,
            )
    shutil.copyfile(
        work / "built-studio/dist/opengeo-studio-build.json",
        work / "studio-build-manifest.json",
    )


def serve(restored=False):
    import psycopg
    import uvicorn
    from fastapi import Request, Response
    from opengeo_api.s3_uploads import UploadForm

    class BrowserObjects(pilot.LocalObjects):
        async def create_download_url(self, spec):
            from opengeo_api.s3_downloads import DownloadTicket

            record, _ = self.exact(spec.bucket, spec.key, spec.version_id)
            expires = datetime.now(UTC) + timedelta(minutes=5)
            query = urlencode({
                "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
                "X-Amz-Credential": "synthetic-local-only",
                "X-Amz-Date": datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"),
                "X-Amz-Expires": "300",
                "X-Amz-SignedHeaders": "host",
                "X-Amz-Signature": "0" * 64,
                "response-content-disposition": f'attachment; filename="{spec.filename}"',
                "versionId": spec.version_id,
            })
            url = f"{UPLOAD_URL}/{quote(spec.key, safe='/')}?{query}"
            issued = pilot.read_json("issued-downloads.json", {})
            issued[url] = {**record, "expires_at": expires.isoformat()}
            pilot.save_json("issued-downloads.json", issued)
            return DownloadTicket(url, "GET", expires)

        async def create_upload_form(self, spec):
            fields = {
                "key": spec.key,
                "Content-Type": spec.content_type,
                "x-amz-checksum-sha256": base64.b64encode(
                    bytes.fromhex(spec.checksum_sha256)
                ).decode(),
                "x-amz-server-side-encryption": "aws:kms",
                "x-amz-server-side-encryption-aws-kms-key-id": "local-only",
                "x-amz-algorithm": "AWS4-HMAC-SHA256",
                "x-amz-credential": "synthetic-local-only",
                "x-amz-date": "20260908T000000Z",
                "policy": "synthetic-local-only",
                "x-amz-signature": "synthetic-local-only",
            }
            issued = pilot.read_json("issued-uploads.json", {})
            # This named local acceptance fixture exercises expiry without DB bypass.
            short_lived = spec.key.endswith("/renewal-short-lived.geojson") and spec.key not in issued
            issued[spec.key] = {"fields": fields, "size": spec.size_bytes}
            pilot.save_json("issued-uploads.json", issued)
            return UploadForm(
                UPLOAD_URL, "POST", fields,
                datetime.now(UTC) + timedelta(seconds=2 if short_lived else 600),
            )

    # Fixture bootstrap only. All subsequent application actions use real roles.
    if not restored:
        bootstrap_browser_identities(psycopg)

    app = pilot.local_app(
        upload_storage=BrowserObjects(),
        download_storage=BrowserObjects(),
        page_source_upload_storage=BrowserObjects(),
        page_source_download_storage=BrowserObjects(),
    )

    async def upload(request: Request):
        assert request.method == "POST"
        assert not request.headers.get("authorization")
        body = await request.body()
        assert len(body) <= 1_048_576
        message = BytesParser(policy=default).parsebytes(
            b"Content-Type: "
            + request.headers["content-type"].encode()
            + b"\r\nMIME-Version: 1.0\r\n\r\n"
            + body
        )
        assert message.is_multipart()
        fields, files = {}, []
        for part in message.iter_parts():
            name = part.get_param("name", header="content-disposition")
            value = part.get_payload(decode=True)
            if name == "file":
                files.append(value)
            else:
                assert name not in fields
                fields[name] = value.decode()
        assert len(files) == 1
        issued = pilot.read_json("issued-uploads.json", {})
        ticket = issued.pop(fields["key"])
        assert fields == ticket["fields"] and len(files[0]) == ticket["size"]
        assert (
            base64.b64encode(bytes.fromhex(pilot.digest(files[0]))).decode()
            == fields["x-amz-checksum-sha256"]
        )
        record = BrowserObjects().put(fields["key"], files[0], fields["Content-Type"])
        pilot.save_json("issued-uploads.json", issued)
        if fields["Content-Type"] != "text/markdown":
            queue_ingestion(record, files[0])
        return Response(status_code=204)

    def queue_ingestion(record, body):
        pilot.LocalQueue().push(
            {
                "Records": [
                    {
                        "eventSource": "aws:s3",
                        "eventName": "ObjectCreated:Post",
                        "awsRegion": "us-east-1",
                        "s3": {
                            "bucket": {"name": pilot.BUCKET},
                            "object": {
                                "key": record["key"],
                                "versionId": record["version_id"],
                                "size": len(body),
                                "eTag": record["etag"],
                                "sequencer": "01",
                            },
                        },
                    }
                ]
            }
        )

    # Only this isolated harness exposes the local transport seam.
    app.add_api_route("/__local/upload", upload, methods=["POST"])
    uvicorn.run(app, uds="/work/api.sock", access_log=False, log_level="warning")


def bootstrap_browser_identities(psycopg):
    with psycopg.connect(
        "postgresql://postgres@127.0.0.1/opengeo?sslmode=disable"
    ) as connection:
        for actor, identity in [("owner", pilot.OWNER), ("reviewer", pilot.REVIEWER)]:
            connection.execute(
                "INSERT INTO app.users(id,cognito_subject,email,display_name) VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                (identity, f"local-pilot-{actor}", f"{actor}@local.invalid", actor),
            )
        connection.execute(
            "INSERT INTO app.organizations(id,name,slug,created_by) VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING",
            (pilot.ORG, "Local Studio integration", "local-studio", pilot.OWNER),
        )
        connection.execute(
            "INSERT INTO app.organization_memberships(organization_id,user_id,role) VALUES (%s,%s,'admin') ON CONFLICT DO NOTHING",
            (pilot.ORG, pilot.OWNER),
        )


def container_command(
    database,
    work,
    name,
    image,
    executable,
    script,
    *arguments,
    font_runtime_package=None,
    enable_saved_map_gl=False,
    saved_map_gl_runtime=None,
):
    if enable_saved_map_gl and (
        not isinstance(saved_map_gl_runtime, dict)
        or not re.fullmatch(
            r"[0-9a-f]{64}", saved_map_gl_runtime.get("manifest_sha256", "")
        )
        or saved_map_gl_runtime.get("architecture") not in ("x86_64", "aarch64")
    ):
        raise ValueError("Font activation requires the verified runtime identity")
    return [
        "podman",
        "run",
        "--rm",
        "--name",
        name,
        "--pull=never",
        "--network",
        f"container:{database}",
        "--read-only",
        "--cap-drop=all",
        "--security-opt=no-new-privileges",
        "--security-opt=label=disable",
        "--memory=3g",
        "--cpus=2",
        "--pids-limit=256",
        *(["--user=10001:10001"] if font_runtime_package is not None else ["--user=0"]),
        "--tmpfs",
        "/tmp:rw,size=1g",
        "--volume",
        f"{ROOT}:/repo:ro",
        "--volume",
        f"{work}:/work:rw",
        *(
            ["--volume", f"{font_runtime_package}:{FONT_RUNTIME_MOUNT}:ro"]
            if font_runtime_package is not None
            else []
        ),
        *(
            [
                "--env",
                "OPEN_GEO_SAVED_MAP_GL_ENABLED=true",
                "--env",
                f"OPEN_GEO_SAVED_MAP_GL_RUNTIME_SHA256={saved_map_gl_runtime['manifest_sha256']}",
                "--env",
                f"OPEN_GEO_SAVED_MAP_GL_RUNTIME_ARCHITECTURE={saved_map_gl_runtime['architecture']}",
            ]
            if enable_saved_map_gl
            else []
        ),
        "--env",
        "PYTHONDONTWRITEBYTECODE=1",
        "--env",
        "PYTHONUNBUFFERED=1",
        "--env",
        "PYTHONPATH=/repo/services/api/src:/repo/services/worker/src:/opt/opengeo-python",
        "--entrypoint",
        executable,
        image,
        f"/repo/{script}",
        *arguments,
    ]


def database_initialization_sources(upgrade_from_0082=False):
    baseline = (
        ROOT / "database/baselines/0082_opengeo_schema.sql"
        if upgrade_from_0082 else pilot.BASELINE
    )
    return pilot.database_initialization_sources(baseline, ROOT)


def stage_database_initialization(init, upgrade_from_0082=False):
    pilot.stage_database_initialization(init, database_initialization_sources(upgrade_from_0082))


def prepare_worker_scratch(work):
    """Share only this new synthetic transport directory with the nonroot worker.

    Resolve UID 10001 in Podman's existing rootless namespace. Do not remap or
    chown the image, repository, package or an existing work directory. Default
    ACLs let the host/API and worker read one another's newly created artifacts.
    """
    work = Path(work)
    if (
        work.parent != Path("/tmp")
        or not work.name.startswith("opengeo-integrated-studio-")
        or work.is_symlink()
        or not work.is_dir()
        or work.resolve(strict=True) != work
        or work.stat().st_uid != os.getuid()
        or stat.S_IMODE(work.stat().st_mode) != 0o700
        or any(work.iterdir())
    ):
        raise ValueError(
            "Worker scratch must be a new, owned, empty private Studio directory"
        )
    subprocess.run(
        [
            "podman",
            "unshare",
            "setfacl",
            "--modify",
            "u:10001:rwx,d:u::rwx,d:u:0:rwx,d:u:10001:rwx,d:g::---,d:m::rwx,d:o::---",
            "--",
            str(work),
        ],
        check=True,
        capture_output=True,
        timeout=15,
    )


def wait_api_socket(work, process):
    deadline = time.monotonic() + 30
    while not (work / "api.sock").exists():
        if process.poll() is not None or time.monotonic() > deadline:
            raise RuntimeError(f"Local API failed to become ready: {work / 'api.log'}")
        time.sleep(0.1)


def run_browser_with_restore(
    work, database, api_name, api_process, font_runtime, service_clients=False
):
    # A host-only test checkpoint. It is not an HTTP endpoint or production API.
    from integrated_studio_restore import restored_checkpoint

    browser = subprocess.Popen(
        browser_command(
            work,
            pinned_map_fonts=font_runtime is not None,
            built_studio=True,
            restore_checkpoint=True,
            service_clients=service_clients,
        ),
        cwd=ROOT,
        start_new_session=True,
    )
    restored = False
    try:
        with ExitStack() as recovery:
            deadline = time.monotonic() + 780
            while browser.poll() is None:
                request = work / "restore-request.json"
                if request.exists() and not restored:
                    if request.is_symlink() or json.loads(request.read_text()) != {
                        "checkpoint": "published-edition",
                        "version": 1,
                    }:
                        raise ValueError("Unexpected local restore checkpoint")
                    print(
                        "Studio: quiescent database/object backup and independent restore",
                        flush=True,
                    )
                    pilot.cleanup_resources([api_name], [], api_process)
                    target, target_work, _proof = recovery.enter_context(
                        restored_checkpoint(database, work, pilot)
                    )
                    restored_name = f"{target.name}-api"
                    log = recovery.enter_context((target_work / "api.log").open("wb"))
                    restored_api = subprocess.Popen(
                        container_command(
                            target.name,
                            target_work,
                            restored_name,
                            pilot.API_IMAGE,
                            "python",
                            "scripts/run-integrated-studio-local.py",
                            "--serve",
                            "--restored",
                            enable_saved_map_gl=font_runtime is not None,
                            saved_map_gl_runtime=font_runtime,
                        ),
                        stdout=log,
                        stderr=subprocess.STDOUT,
                    )
                    recovery.callback(
                        pilot.cleanup_resources, [restored_name], [], restored_api
                    )
                    wait_api_socket(target_work, restored_api)
                    (work / "restore-ready.json").write_text(
                        json.dumps(
                            {"status": "ready", "socketPath": "restored/api.sock"}
                        )
                        + "\n"
                    )
                    restored = True
                if time.monotonic() > deadline:
                    raise TimeoutError(
                        "The connected restore journey exceeded its deadline"
                    )
                time.sleep(0.1)
            if browser.returncode:
                raise subprocess.CalledProcessError(browser.returncode, browser.args)
            if not restored:
                raise RuntimeError(
                    "The browser never requested the required recovery checkpoint"
                )
    finally:
        if browser.poll() is None:
            os.killpg(browser.pid, signal.SIGTERM)
            try:
                browser.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(browser.pid, signal.SIGKILL)
                browser.wait(timeout=10)


def orchestrate(
    upgrade_from_0082=False,
    font_runtime=None,
    built_studio=False,
    restore_checkpoint=False,
    service_clients=False,
    reuse_studio_tree=None,
    wcs_only=False,
    analysis_only=False,
    api_image=None,
    worker_image=None,
):
    pilot.API_IMAGE = api_image or pilot.API_IMAGE
    pilot.WORKER_IMAGE = worker_image or pilot.WORKER_IMAGE
    sys.path.insert(0, str(ROOT / "database/scripts"))
    sys.path.insert(0, str(ROOT / "scripts"))
    from build_baseline import IMAGE, TemporaryDatabase

    if service_clients:
        qgis_version = subprocess.check_output(
            [
                "/usr/bin/python3",
                "-c",
                "from qgis.core import Qgis; print(Qgis.QGIS_VERSION)",
            ],
            text=True,
            timeout=30,
        ).strip()
        if qgis_version != "3.44.12-Solothurn":
            raise ValueError(
                "Service client acceptance requires the pinned local QGIS 3.44.12"
            )

    if font_runtime is not None:
        font_runtime = load_font_runtime(
            font_runtime["package_directory"], font_runtime["manifest_sha256"]
        )
    verify_cached_images(IMAGE)
    if font_runtime is not None:
        verify_cached_worker_image(font_runtime["architecture"])
    work = Path(tempfile.mkdtemp(prefix="opengeo-integrated-studio-"))
    if font_runtime is not None:
        prepare_worker_scratch(work)
    init = work / "init"
    init.mkdir()
    stage_database_initialization(init, upgrade_from_0082)
    database = TemporaryDatabase("podman", init, "integrated-studio")
    server_name = f"{database.name}-api"
    worker_name = f"{database.name}-worker"
    process = None
    volumes = []
    started = datetime.now(UTC).isoformat()
    paths = [
        *sorted(
            path
            for path in (ROOT / "app/src").rglob("*.js")
            if not any(part.startswith(".") for part in path.relative_to(ROOT).parts)
        ),
        ROOT / "app/src/style.css",
        ROOT / "app/scripts/check-integrated-studio.mjs",
        ROOT / "app/scripts/integrated-studio-conversion.mjs",
        ROOT / "app/scripts/integrated-studio-analysis.mjs",
        ROOT / "app/scripts/integrated-studio-renderers.mjs",
        ROOT / "app/scripts/integrated-studio-object-transport.mjs",
        ROOT / "app/scripts/integrated-studio-font-mode.mjs",
        ROOT / "app/scripts/integrated-studio-built-shell.mjs",
        ROOT / "scripts/integrated_studio_restore.py",
        ROOT / "scripts/integrated_studio_qgis.py",
        Path(__file__),
        *database_initialization_sources(upgrade_from_0082),
        *(font_source_paths() if font_runtime is not None else []),
    ]
    fingerprints = {
        **pilot.source_fingerprints(),
        **{str(p.relative_to(ROOT)): pilot.digest(p.read_bytes()) for p in paths},
    }
    if built_studio:
        for directory in ("app/src", "app/scripts"):
            for path in (ROOT / directory).rglob("*"):
                if path.is_file() and not any(
                    part.startswith(".") for part in path.relative_to(ROOT).parts
                ):
                    fingerprints[str(path.relative_to(ROOT))] = pilot.digest(
                        path.read_bytes()
                    )
        for name in ("package.json", "package-lock.json", "observablehq.config.js"):
            fingerprints[f"app/{name}"] = pilot.digest(
                (ROOT / "app" / name).read_bytes()
            )
    if font_runtime is not None:
        shutil.copyfile(
            Path(font_runtime["package_directory"]) / "runtime.json",
            work / "font-runtime-manifest.json",
        )
    print(f"Studio evidence directory: {work}", flush=True)
    if built_studio:
        print(
            "Studio: stage and verify the selected application before starting containers",
            flush=True,
        )
        stage_built_studio(work, reuse_studio_tree)
    try:
        with database, (work / "api.log").open("wb") as log:
            volumes = pilot.database_volumes(database.name)
            process = subprocess.Popen(
                container_command(
                    database.name,
                    work,
                    server_name,
                    pilot.API_IMAGE,
                    "python",
                    "scripts/run-integrated-studio-local.py",
                    "--serve",
                    enable_saved_map_gl=font_runtime is not None,
                    saved_map_gl_runtime=font_runtime,
                ),
                stdout=log,
                stderr=subprocess.STDOUT,
            )
            wait_api_socket(work, process)
            worker = container_command(
                database.name,
                work,
                worker_name,
                pilot.WORKER_IMAGE,
                "python3",
                "scripts/run-integrated-pilot-local.py",
                "--stage",
                "worker",
                font_runtime_package=font_runtime["package_directory"]
                if font_runtime is not None
                else None,
            )
            (work / "worker-command.json").write_text(json.dumps(worker))
            if restore_checkpoint:
                run_browser_with_restore(
                    work, database, server_name, process, font_runtime, service_clients
                )
            else:
                subprocess.run(
                    browser_command(
                        work,
                        pinned_map_fonts=font_runtime is not None,
                        built_studio=built_studio,
                        service_clients=service_clients,
                        wcs_only=wcs_only,
                        analysis_only=analysis_only,
                    ),
                    cwd=ROOT,
                    check=True,
                    timeout=600,
                )
    finally:
        try:
            # Preserve startup diagnostics even when __enter__ was interrupted.
            if not (work / "api.log").exists():
                diagnostic = subprocess.run(
                    ["podman", "logs", "--tail", "100", database.name],
                    capture_output=True, timeout=10, check=False,
                )
                (work / "database-readiness.log").write_bytes(diagnostic.stdout + diagnostic.stderr)
        finally:
            pilot.cleanup_resources(
                [worker_name, server_name, database.name], volumes, process
            )
    for path, expected in fingerprints.items():
        assert pilot.digest((ROOT / path).read_bytes()) == expected, path
    if font_runtime is not None:
        load_font_runtime(
            font_runtime["package_directory"], font_runtime["manifest_sha256"]
        )
    result = json.loads((work / "browser-result.json").read_text())
    assert result["status"] == "pass"
    receipt = {
        "schema": "opengeo.integrated-studio-local.1.0.0",
        "started_at": started,
        "finished_at": datetime.now(UTC).isoformat(),
        "result": result,
        "source_sha256": fingerprints,
        "all_temporary_containers_removed": True,
        "removed_database_volumes": volumes,
        "database_initialization": [str(p.relative_to(ROOT)) for p in database_initialization_sources(upgrade_from_0082)],
        "frontend_artifact_reused": reuse_studio_tree,
        "aws_calls": False,
        "api_image": pilot.API_IMAGE,
        "worker_image": pilot.WORKER_IMAGE,
        "artifacts": {
            p.name: pilot.digest(p.read_bytes())
            for p in sorted(work.iterdir())
            if p.is_file()
        },
    }
    if font_runtime is not None:
        assert result["pinnedMapFonts"]["enabled"] is True
        receipt["font_runtime"] = {
            "mode": "read-only staged runtime payload over cached worker image",
            "new_image_build": False,
            "worker_image": pilot.WORKER_IMAGE,
            "package_directory": font_runtime["package_directory"],
            "container_directory": FONT_RUNTIME_MOUNT,
            "package_mount": "read-only staged payload; no new worker image",
            "worker_identity": "10001:10001; default rootless mapping with ACLs on new synthetic scratch only",
            "manifest_sha256": font_runtime["manifest_sha256"],
            "architecture": font_runtime["architecture"],
            "sandbox": font_runtime["sandbox"],
            "saved_map_gl_enabled": True,
        }
    if restore_checkpoint:
        assert result["restoration"]["verified"] is True
        receipt["restoration"] = json.loads(
            (work / "restore-checkpoint-proof.json").read_text()
        )
        receipt["restoration"]["allTemporaryResourcesRemoved"] = True
    (work / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(f"Verified Studio receipt: {work / 'receipt.json'}", flush=True)


def development_directory(directory):
    """Open only a private, explicitly selected local development state directory."""
    directory = Path(directory).absolute()
    if directory.is_symlink():
        raise ValueError("Development state must not be a symlink")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.resolve() != directory or directory.stat().st_uid != os.getuid():
        raise ValueError("Development state must be an owned canonical directory")
    if stat.S_IMODE(directory.stat().st_mode) != 0o700:
        raise ValueError("Development state must have permissions 0700")
    return directory


def development_state(directory, database_image):
    directory = development_directory(directory)
    marker = directory / "development-state.json"
    sources = {str(p.relative_to(ROOT)): pilot.digest(p.read_bytes())
               for p in database_initialization_sources()}
    if marker.exists():
        if marker.is_symlink():
            raise ValueError("Development state marker must not be a symlink")
        metadata = json.loads(marker.read_text())
        if (metadata.get("schemaVersion") != "opengeo.community-development.1"
                or not re.fullmatch(r"opengeo-community-[0-9a-f]{32}", metadata.get("database", ""))
                or metadata.get("databaseImage") != database_image
                or metadata.get("schemaSources") != sources):
            raise ValueError("Development database identity/schema changed; retain this state and review an upgrade before reopening")
    else:
        if any(path.name != "development.lock" for path in directory.iterdir()):
            raise ValueError("A new development state directory must be empty")
        metadata = {"schemaVersion": "opengeo.community-development.1",
                    "database": f"opengeo-community-{uuid4().hex}",
                    "databaseImage": database_image, "schemaSources": sources}
        marker.write_text(json.dumps(metadata, indent=2) + "\n")
    return directory, metadata


def development(args):
    """Retain local data; use the same built Studio, isolated API and worker seams."""
    sys.path.insert(0, str(ROOT / "database/scripts"))
    from build_baseline import IMAGE

    pilot.API_IMAGE = args.api_image or pilot.API_IMAGE
    pilot.WORKER_IMAGE = args.worker_image or pilot.WORKER_IMAGE
    verify_cached_images(IMAGE)
    work = development_directory(args.state_directory)
    if (work / "development.lock").is_symlink():
        raise ValueError("Development lock must not be a symlink")
    with (work / "development.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("This development state is already open") from error
        work, metadata = development_state(work, IMAGE)
        name = metadata["database"]
        server_name, worker_name = f"{name}-api", f"{name}-worker"
        process = None
        try:
            # A retained development container owns a named volume. Neither is a
            # disposable acceptance resource, and cleanup never removes the volume.
            exists = subprocess.run(["podman", "container", "exists", name], check=False)
            if exists.returncode == 1:
                init = work / "init"
                init.mkdir(exist_ok=True)
                stage_database_initialization(init)
                subprocess.run(["podman", "run", "--detach", "--pull=never",
                                "--log-driver=k8s-file", "--name", name,
                                "--network=none", "--env", "POSTGRES_HOST_AUTH_METHOD=trust",
                                "--env", "POSTGRES_DB=opengeo", "--volume",
                                f"{init}:/docker-entrypoint-initdb.d:ro,Z", "--volume",
                                f"{name}-data:/var/lib/postgresql/data", IMAGE], check=True)
            elif exists.returncode == 0:
                subprocess.run(["podman", "start", name], check=True)
            else:
                raise RuntimeError("Could not inspect the retained development database")
            deadline = time.monotonic() + 120
            while True:
                ready = subprocess.run(["podman", "exec", name, "pg_isready", "--username",
                                        "postgres", "--dbname", "opengeo"], capture_output=True)
                logs = subprocess.run(["podman", "logs", name], capture_output=True, check=True)
                if ready.returncode == 0 and b"PostgreSQL init process complete" in logs.stdout + logs.stderr:
                    break
                if time.monotonic() >= deadline:
                    raise TimeoutError("Development database did not become ready; retained data was not removed")
                time.sleep(0.2)
            # Reuse a verified staged tree across restarts. Source changes need a
            # deliberate rebuild through the same maintained builder.
            if args.rebuild_studio or not (work / "studio-build-manifest.json").exists():
                staged = work / "built-studio"
                if staged.is_symlink():
                    raise ValueError("The staged build must not be a symlink")
                if staged.exists():
                    shutil.rmtree(staged)
                stage_built_studio(work, args.reuse_studio_tree)
            with (work / "api.log").open("ab") as log:
                process = subprocess.Popen(container_command(name, work, server_name,
                    pilot.API_IMAGE, "python", "scripts/run-integrated-studio-local.py", "--serve",
                    *(["--restored"] if (work / "identities-seeded").exists() else [])),
                    stdout=log, stderr=subprocess.STDOUT)
                wait_api_socket(work, process)
                (work / "identities-seeded").touch(mode=0o600)
                worker = container_command(name, work, worker_name, pilot.WORKER_IMAGE,
                    "python3", "scripts/run-integrated-pilot-local.py", "--stage", "worker")
                (work / "worker-command.json").write_text(json.dumps(worker))
                print(f"LOCAL DEVELOPMENT ONLY: synthetic sign-in; private state {work}", flush=True)
                print("Closing Chromium stops compute and retains the database, files and queue.", flush=True)
                subprocess.run(browser_command(work, built_studio=True, development=True), cwd=ROOT, check=True)
        finally:
            try:
                pilot.cleanup_resources([server_name, worker_name], [], process)
            finally:
                subprocess.run(["podman", "stop", "--time=10", name], capture_output=True, check=False)
                (work / "api.sock").unlink(missing_ok=True)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--upgrade-from-0082", action="store_true")
    parser.add_argument("--pinned-map-fonts", action="store_true")
    parser.add_argument("--built-studio", action="store_true")
    parser.add_argument("--restore-checkpoint", action="store_true")
    parser.add_argument("--service-clients", action="store_true")
    parser.add_argument("--wcs-only", action="store_true")
    parser.add_argument("--analysis-only", action="store_true")
    parser.add_argument("--reuse-studio-tree")
    parser.add_argument("--restored", action="store_true")
    parser.add_argument("--font-runtime-package", type=Path)
    parser.add_argument("--font-runtime-manifest-sha256")
    parser.add_argument("--development", action="store_true")
    parser.add_argument("--state-directory", type=Path)
    parser.add_argument("--api-image")
    parser.add_argument("--worker-image")
    parser.add_argument("--rebuild-studio", action="store_true")
    args = parser.parse_args(argv)
    if args.development:
        if not args.state_directory or any((args.serve, args.upgrade_from_0082, args.pinned_map_fonts,
                args.restore_checkpoint, args.service_clients, args.wcs_only, args.analysis_only, args.restored)):
            parser.error("Development requires --state-directory and excludes acceptance-only modes")
        args.built_studio = True
    elif args.state_directory or args.rebuild_studio:
        parser.error("State and frontend rebuild options belong only to --development")
    if args.serve and (args.api_image or args.worker_image):
        parser.error("Image overrides belong to the host orchestrator")
    for image in (args.api_image, args.worker_image):
        if image and not re.fullmatch(r"(?:sha256:)?[0-9a-f]{64}|[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[0-9a-f]{64}", image):
            parser.error("Image overrides require immutable local image IDs or digests")
    if args.serve and ROOT != Path("/repo"):
        parser.error("The local server must run in the isolated container orchestrator")
    if args.serve and args.upgrade_from_0082:
        parser.error("Upgrade selection belongs to the host orchestrator")
    if args.serve and args.built_studio:
        parser.error("Built Studio selection belongs to the host orchestrator")
    if args.restored and not args.serve:
        parser.error("Restored API selection belongs to the isolated container")
    if args.restore_checkpoint and (args.serve or not args.built_studio):
        parser.error("Restoration acceptance requires the built Studio host journey")
    if args.service_clients and (args.serve or not args.built_studio):
        parser.error("Service client acceptance requires the built Studio host journey")
    if args.reuse_studio_tree and (args.serve or not args.built_studio):
        parser.error("Artifact reuse requires the built Studio host journey")
    if args.wcs_only and (not args.built_studio or args.serve or args.service_clients or args.restore_checkpoint or args.pinned_map_fonts):
        parser.error("WCS-only requires built Studio without other journey modes")
    if args.analysis_only and (not args.built_studio or args.serve or args.service_clients or args.restore_checkpoint or args.pinned_map_fonts or args.wcs_only):
        parser.error("Analysis-only requires built Studio without other journey modes")
    runtime_options = (args.font_runtime_package, args.font_runtime_manifest_sha256)
    if args.pinned_map_fonts:
        if args.serve or not all(runtime_options):
            parser.error(
                "Pinned fonts require an explicit host package and manifest SHA-256"
            )
    elif any(value is not None for value in runtime_options):
        parser.error("Runtime package options require --pinned-map-fonts")
    return args


if __name__ == "__main__":
    if not __debug__:
        raise SystemExit("Integration assertions must not be disabled")
    args = parse_args()
    font_runtime = (
        load_font_runtime(args.font_runtime_package, args.font_runtime_manifest_sha256)
        if args.pinned_map_fonts
        else None
    )
    if args.development:
        development(args)
        raise SystemExit(0)
    serve(args.restored) if args.serve else orchestrate(
        args.upgrade_from_0082,
        font_runtime,
        args.built_studio,
        args.restore_checkpoint,
        args.service_clients,
        args.reuse_studio_tree,
        args.wcs_only,
        args.analysis_only,
        api_image=args.api_image,
        worker_image=args.worker_image,
    )
