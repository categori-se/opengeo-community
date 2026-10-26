"""Run the actual Studio against isolated API/PostGIS/GIS-worker dependencies.

Only identity verification and cloud transports are substituted. No AWS calls,
published ports, remote browser services, or production credentials are used.
"""

import argparse
import asyncio
import base64
import fcntl
import importlib.util
import json
import os
import re
import shutil
import signal
import socket
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


def inspect_pmtiles_worker_image(image):
    """Select the existing dedicated image; never pull, build or infer host parity."""
    if not re.fullmatch(r"(?:sha256:)?[a-f0-9]{64}", image or ""):
        raise ValueError("PMTiles worker requires an exact cached image ID")
    pin = "sha256:" + image.removeprefix("sha256:")
    inspected = subprocess.run(["podman", "image", "inspect", pin],
                               capture_output=True, check=True, timeout=15)
    images = json.loads(inspected.stdout)
    if not isinstance(images, list) or len(images) != 1:
        raise ValueError("Expected one exact cached PMTiles worker image")
    selected = images[0]
    labels = selected.get("Labels") or {}
    if (selected.get("Id", "").removeprefix("sha256:") != pin.removeprefix("sha256:")
            or selected.get("Architecture") not in {"amd64", "arm64"}
            or labels.get("org.opencontainers.image.title") != "GDAL osgeo/gdal:ubuntu-small"
            or labels.get("org.opencontainers.image.version") != "3.13.1"
            or labels.get("org.opencontainers.image.revision") != "v3.13.1"
            or labels.get("org.opencontainers.image.source") != "https://github.com/OSGeo/gdal"):
        raise ValueError("PMTiles image must retain the dedicated GDAL ubuntu-small 3.13.1 identity")
    dockerfile = (ROOT / "services/worker/Dockerfile.pmtiles").read_text()
    if dockerfile.count("FROM " + pilot.PMTILES_BASE) != 2:
        raise ValueError("The maintained PMTiles Dockerfile base identity changed")
    return {"imageDigest": pin, "architecture": selected["Architecture"],
            "baseImage": pilot.PMTILES_BASE, "queueUrl": pilot.PMTILES_QUEUE_URL,
            "expectedOwner": "000000000000"}


def stage_pmtiles_runtime(work, init, profile):
    """Bind only a fresh disposable DB to its real dedicated local worker lane."""
    profile_path = work / "pmtiles-runtime.json"
    if profile_path.exists() or profile_path.is_symlink() or (init / "zzz-local-pmtiles-runtime.sql").exists():
        raise ValueError("Local PMTiles binding must be staged once in a fresh database")
    profile_path.write_text(json.dumps(profile))
    # The private directory's existing ACL grants UID 10001 read access to this
    # nonsecret binding; ordinary other users retain no directory access.
    profile_path.chmod(0o640)
    configuration = {
        "enabled": True, "pmtilesV2Ready": True,
        "pmtilesWorkerImageDigest": profile["imageDigest"], "pmtilesQueueUrl": profile["queueUrl"],
        "windowSeconds": 300, "cleanupSeconds": 300, "dailyWindows": 1, "totalWindows": 1,
        "scopeHash": pilot.digest(json.dumps({"work": str(work), "profile": profile}, sort_keys=True).encode()),
        "endpointHash": pilot.digest(str(work / f"{pilot.PMTILES_QUEUE}.json").encode()),
        "workerHash": pilot.digest(profile["imageDigest"].encode()),
    }
    encoded = json.dumps(configuration).replace("'", "''")
    target = init / "zzz-local-pmtiles-runtime.sql"
    target.write_text("DO $local$ BEGIN\n"
        "UPDATE app.worker_runtime_control SET configuration='" + encoded + "'::jsonb, revision=1 "
        "WHERE singleton AND configuration='{\"enabled\":false}'::jsonb AND revision=0 "
        "AND lease_token IS NULL AND lease_until IS NULL AND window_state IS NULL "
        "AND budget_day IS NULL AND starts_today=0 AND total_windows=0 AND reserved_seconds=0 AND last_result IS NULL;\n"
        "IF NOT FOUND THEN RAISE EXCEPTION 'Local PMTiles requires pristine runtime control'; END IF;\n"
        "END $local$;\n")
    target.chmod(0o444)


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
    publication_only=False,
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
        *(["--publication-only"] if publication_only else []),
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
        "services/api/src/opengeo_api/project_module.py",
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


def stage_print_template_studio(work, requested_tree, staged_manifest):
    """Copy one exact sealed frontend; retain the historical staged manifest."""
    receipt_path = work / "print-template-studio-staging.json"
    prior_path = work / "print-template-prior-studio-build-manifest.json"

    def owned_file(path):
        if path.is_symlink() or not path.is_file() or path.stat().st_uid != os.getuid():
            raise ValueError("Template staging requires owned regular private receipt files")

    if not re.fullmatch(r"[a-f0-9]{64}", requested_tree or ""):
        raise ValueError("Template staging requires an exact sealed Studio tree")
    if receipt_path.exists() or receipt_path.is_symlink():
        owned_file(receipt_path)
        receipt = json.loads(receipt_path.read_text())
        owned_file(prior_path)
        if (receipt.get("schemaVersion") != "opengeo.print-template-studio-staging.1"
                or receipt.get("requestedTreeDigest") != requested_tree
                or receipt.get("priorManifestSha256") != pilot.digest(prior_path.read_bytes())
                or receipt.get("status") != "copied-sealed-artifact"
                or staged_manifest.get("artifactTree", {}).get("digest") != requested_tree):
            raise ValueError("Template staging checkpoint is incomplete or belongs to another exact artifact")
        return receipt

    staged = work / "built-studio"
    if (staged.is_symlink() or not staged.is_dir() or staged.stat().st_uid != os.getuid()
            or staged.resolve().parent != work.resolve()):
        raise ValueError("Template staging may replace only its owned generated built-studio directory")
    inner_manifest = staged / "dist/opengeo-studio-build.json"
    outer_manifest = work / "studio-build-manifest.json"
    owned_file(inner_manifest);owned_file(outer_manifest)
    prior_bytes = outer_manifest.read_bytes()
    if inner_manifest.read_bytes() != prior_bytes:
        raise ValueError("Generated Studio manifest differs from its retained staging receipt")
    expected_files = {"dist/opengeo-studio-build.json"}
    for entry in staged_manifest["artifactTree"]["files"]:
        relative = Path(entry["path"])
        if relative.is_absolute() or any(part in {".", ".."} for part in relative.parts):
            raise ValueError("Unsafe retained artifact path")
        expected_files.add((Path("app/dist") / relative).as_posix())
    actual_files = set()
    for entry in staged.rglob("*"):
        info = entry.lstat()
        if entry.is_symlink() or info.st_uid != os.getuid() or not (entry.is_dir() or entry.is_file()):
            raise ValueError("Generated Studio replacement contains unowned or nonregular entries")
        if entry.is_file():
            actual_files.add(entry.relative_to(staged).as_posix())
    if actual_files != expected_files:
        raise ValueError("Template staging cannot remove files outside the exact generated artifact inventory")
    reuse_root = Path(os.environ.get("OPENGEO_STUDIO_REUSE_ROOT", str(ROOT))).resolve()
    source_manifest = reuse_root / "dist/opengeo-studio-build.json"
    owned_file(source_manifest)
    source_bytes = source_manifest.read_bytes()
    if json.loads(source_bytes).get("artifactTree", {}).get("digest") != requested_tree:
        raise ValueError("Requested template frontend is not the current sealed artifact")
    if prior_path.exists() or prior_path.is_symlink():
        raise ValueError("An unrecorded prior template manifest must be reviewed before replacement")
    with open(prior_path, "xb", opener=lambda path, flags: os.open(path, flags, 0o600)) as handle:
        handle.write(prior_bytes)
    receipt = {"schemaVersion": "opengeo.print-template-studio-staging.1", "status": "prepared",
               "priorTreeDigest": staged_manifest["artifactTree"]["digest"],
               "priorManifestSha256": pilot.digest(prior_bytes), "requestedTreeDigest": requested_tree,
               "sourceManifestSha256": pilot.digest(source_bytes), "rebuilt": False}
    with open(receipt_path, "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as handle:
        handle.write(json.dumps(receipt, indent=2) + "\n")
    started = time.monotonic()
    shutil.rmtree(staged)
    stage_built_studio(work, requested_tree)
    receipt.update(status="copied-sealed-artifact", elapsedSeconds=time.monotonic() - started)
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


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

    overrides, fixture_finalizer = {}, None
    if (pilot.WORK / "postgis-fixture.json").exists() and os.environ.get("OPENGEO_COMMUNITY_PRINT_SMOKE") != "1":
        from integrated_studio_postgis import prepare_local_postgis

        overrides, fixture_finalizer = asyncio.run(prepare_local_postgis(pilot))
    try:
        app = pilot.local_app(
            upload_storage=BrowserObjects(),
            download_storage=BrowserObjects(),
            page_source_upload_storage=BrowserObjects(),
            page_source_download_storage=BrowserObjects(),
            **overrides,
        )
    except BaseException:
        if fixture_finalizer is not None:
            asyncio.run(fixture_finalizer())
        raise

    async def upload(request: Request):
        assert request.method == "POST"
        assert not request.headers.get("authorization")
        publication_enabled = bool(pilot.read_json("publication-profile.json", {}))
        maximum = 4_259_840 if publication_enabled else 1_048_576
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            assert size <= maximum
            chunks.append(chunk)
        body = b"".join(chunks)
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
        assert len(body) <= local_upload_body_limit(
            fields["key"], publication_enabled=publication_enabled
        )
        issued = pilot.read_json("issued-uploads.json", {})
        ticket = issued.pop(fields["key"])
        assert fields == ticket["fields"] and len(files[0]) == ticket["size"]
        if len(body) > 1_048_576:
            assert fields["Content-Type"] == "text/html" and ticket["size"] <= 4_194_304
        assert (
            base64.b64encode(bytes.fromhex(pilot.digest(files[0]))).decode()
            == fields["x-amz-checksum-sha256"]
        )
        record = BrowserObjects().put(fields["key"], files[0], fields["Content-Type"])
        pilot.save_json("issued-uploads.json", issued)
        if is_dataset_upload(fields["key"]):
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
    from opengeo_api.body_limit import RequestBodyLimitMiddleware

    class LocalUploadBodyLimit(RequestBodyLimitMiddleware):
        async def __call__(self, scope, receive, send):
            if scope["type"] == "http" and scope["path"] == "/__local/upload":
                maximum = (4_259_840 if pilot.read_json("publication-profile.json", {})
                           else 1_048_576)
                await RequestBodyLimitMiddleware(self.app, max_bytes=maximum)(scope, receive, send)
            else:
                await super().__call__(scope, receive, send)

    # The synthetic object transport substitutes for S3 multipart, outside the
    # production JSON body boundary. Every ordinary API path keeps that boundary.
    for middleware in app.user_middleware:
        if middleware.cls is RequestBodyLimitMiddleware:
            middleware.cls = LocalUploadBodyLimit
    try:
        uvicorn.run(app, uds="/work/api.sock", access_log=False, log_level="warning")
    finally:
        if fixture_finalizer is not None:
            asyncio.run(fixture_finalizer())


def local_upload_body_limit(key, *, publication_enabled):
    # Only an exact, issued portable HTML intent gets the API's 4 MiB file
    # allowance plus bounded multipart fields. Dataset/source limits stay 1 MiB.
    identity = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
    portable = re.fullmatch(
        rf"organizations/{identity}/projects/{identity}/artifacts/{identity}/"
        rf"uploads/{identity}/map\.html", key
    )
    return 4_259_840 if publication_enabled and portable else 1_048_576


def is_dataset_upload(key):
    # Source project files include HTML, JS, JSON and images as well as Markdown.
    # Their custody identifies authored source; MIME type must not submit them to
    # the unrelated GIS ingestion worker.
    return re.fullmatch(
        r"organizations/[0-9a-f-]{36}/projects/[0-9a-f-]{36}/"
        r"datasets/[0-9a-f-]{36}/uploads/[0-9a-f-]{36}/original/.+", key
    ) is not None


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
    pmtiles_worker=False,
    print_smoke=False,
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
        *(["--user=10001:10001"] if font_runtime_package is not None or pmtiles_worker else ["--user=0"]),
        "--tmpfs",
        "/tmp:rw,size=1g",
        *(["--mount", "type=tmpfs,target=/tmp/opengeo-worker,tmpfs-size=1073741824,tmpfs-mode=0700,U=true,noexec,nosuid,nodev"]
          if pmtiles_worker else []),
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
        *(["--env", "OPENGEO_COMMUNITY_PRINT_SMOKE=1"] if print_smoke else []),
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


def load_ftw_query(source):
    """Admit one retained query before starting any local service or source read."""
    if source is None:
        return None
    source = Path(source).absolute()
    if (source.is_symlink() or not source.is_file() or source.stat().st_uid != os.getuid()
            or not 1 <= source.stat().st_size <= 2_097_152):
        raise ValueError("FTW acceptance requires one owned regular query JSON of at most 2 MiB")
    content = source.read_bytes()
    if len(content) > 2_097_152:
        raise ValueError("FTW query grew beyond the admitted 2 MiB")
    document = json.loads(content)
    if not isinstance(document, dict):
        raise ValueError("FTW query must contain the retained geojson and receipt objects")
    collection, receipt = document.get("geojson", {}), document.get("receipt", {})
    if not isinstance(collection, dict) or not isinstance(receipt, dict):
        raise ValueError("FTW query must contain the retained geojson and receipt objects")
    features = collection.get("features")
    if (set(document) != {"geojson", "receipt"} or collection.get("type") != "FeatureCollection"
            or not isinstance(features, list) or len(features) != 1
            or not isinstance(features[0], dict) or not isinstance(features[0].get("geometry"), dict)
            or not isinstance(features[0].get("properties"), dict)
            or features[0]["properties"].get("confidence", "absent") is not None
            or features[0].get("type") != "Feature"
            or features[0].get("geometry", {}).get("type") not in {"Polygon", "MultiPolygon"}
            or receipt.get("schemaVersion") != "opengeo.ftw-query.1.0.0"
            or receipt.get("status") != "complete"
            or receipt.get("query", {}).get("year") != 2024
            or receipt.get("source", {}).get("catalogUrl") != "https://data.source.coop/ftw/global-data/catalog.json"):
        raise ValueError("FTW acceptance requires the recognized retained one-polygon query shape")
    prior = {}
    for name, maximum in (("API_REQUESTS", 119), ("MILLISECONDS", 119_999)):
        value = os.environ.get("OPENGEO_FTW_PRIOR_" + name, "0")
        if not re.fullmatch(r"0|[1-9][0-9]*", value) or int(value) > maximum:
            raise ValueError("FTW prior usage must retain a nonnegative value within the remaining batch budget")
        prior[name] = int(value)
    return {"content": content, "sourceSha256": pilot.digest(content),
            "sourceFilename": source.name, "priorApiRequests": prior["API_REQUESTS"],
            "priorMilliseconds": prior["MILLISECONDS"]}


def load_managed_cog(source):
    """Preflight the retained native pilot and its complete knowledge before writes."""
    if source is None:
        return None
    source = Path(source).absolute()
    if source.name != "nearby-subset.tif":
        raise ValueError("Managed COG acceptance selects the retained nearby-subset.tif pilot only")

    def owned_bytes(path, maximum):
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or not 1 <= info.st_size <= maximum):
            raise ValueError("Managed COG inputs must be owned regular bounded files")
        value = path.read_bytes()
        if len(value) != info.st_size or len(value) > maximum:
            raise ValueError("A retained COG input changed during preflight")
        return value

    content = owned_bytes(source, 810)
    sidecar_bytes = owned_bytes(source.with_name("nearby-subset-metadata.json"), 49_152)
    inventory_bytes = owned_bytes(source.with_name("nearby-inventory.json"), 49_152)
    sidecar, inventory = json.loads(sidecar_bytes), json.loads(inventory_bytes)
    checksum = pilot.digest(content)
    provider = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N27E084_Map.tif"
    if (len(content) != 810 or checksum != "aba504f019cba40c9ee2846d13b4658986164996732364626a0a916306e8e6a6"
            or sidecar.get("schemaVersion") != "opengeo.native-baseline-subset-handoff.1.0.0"
            or sidecar.get("output", {}).get("sha256") != checksum
            or sidecar.get("source", {}).get("url") != provider
            or sidecar.get("source", {}).get("etag") != '"2fc1bebafb313302624ba67497976a52-13"'
            or sidecar.get("source", {}).get("observationPeriod") != {"start": "2021-01-01", "end": "2021-12-31"}
            or sidecar.get("request", {}).get("period") != {"start": "2024-01-01", "end": "2024-12-31"}
            or sidecar.get("grid", {}).get("width") != 13 or sidecar.get("grid", {}).get("height") != 13
            or sidecar.get("grid", {}).get("noData") != 0
            or sidecar.get("grid", {}).get("crs") != "EPSG:4326"
            or sidecar.get("grid", {}).get("affine") != [85.533, 1 / 12000, 0, 27.613, 0, -1 / 12000]
            or sidecar.get("verification", {}).get("comparedCells") != 169
            or sidecar.get("verification", {}).get("nativeClassCounts") != [{"code": 40, "cells": 169}]
            or inventory.get("schemaVersion") != "opengeo.cached-raster-baseline.1.1.0"
            or inventory.get("coverage", {}).get("totalCells") != 169
            or inventory.get("coverage", {}).get("touchedCells") != 147
            or inventory.get("coverage", {}).get("totalAreaSquareMeters") != 10956.070972506099
            or inventory.get("coverage", {}).get("outsideWindowAreaSquareMeters") != 0.006499084123788634):
        raise ValueError("The selected COG, source snapshot and retained AOI inventory do not match the accepted pilot")
    timestamp = datetime.now(UTC).isoformat()
    dataset_placeholder = "00000000-0000-4000-8000-000000000001"
    version_placeholder = "00000000-0000-4000-8000-000000000002"
    distribution = f"urn:opengeo:dataset:{dataset_placeholder}:version:{version_placeholder}:original"
    sidecar_id = f"urn:opengeo:retained-worldcover:sha256:{pilot.digest(sidecar_bytes)}"
    inventory_id = f"urn:opengeo:retained-worldcover:sha256:{pilot.digest(inventory_bytes)}"
    credit = sidecar["source"]["attribution"] + "; native pixel subset without resampling. Retained AOI summary: mean-sphere cell-corner/geodesic intersection; source 2021, requested period 2024."
    dct, prov = "http://purl.org/dc/terms/", "http://www.w3.org/ns/prov#"
    def claim(subject, property_uri, value):
        return {"subject": subject, "property": property_uri, "value": value,
                "provenance": "unknown" if value is None else "curator_asserted",
                "method": "retained_native_cog_output_review", "timestamp": timestamp}
    document = {"schemaVersion": "1.0.0",
        "distributions": [{"id": distribution, "custody": "derived", "format": "cog", "mediaType": "image/tiff; application=geotiff; profile=cloud-optimized"},
                          {"id": provider, "custody": "referenced", "format": "cog", "mediaType": "image/tiff"}],
        "metadata": {
            "source": [{"id": identifier, "sourceUrl": identifier, "retrievedAt": timestamp,
                        "mediaType": "application/json", "content": value.decode("utf-8")}
                       for identifier, value in ((sidecar_id, sidecar_bytes), (inventory_id, inventory_bytes))],
            "normalized": [
                {"subject": "resource", "property": prov + "wasGeneratedBy", "value": {
                    "schemaVersion": sidecar["schemaVersion"], "source": sidecar["source"],
                    "request": sidecar["request"], "grid": sidecar["grid"], "operation": sidecar["operation"],
                    "output": sidecar["output"], "verification": sidecar["verification"],
                    "localImport": {"kind": "retained-native-cog", "sha256": checksum, "sizeBytes": len(content),
                                    "importedAt": timestamp, "providerReverified": False}},
                 "provenance": "derived", "method": "retained_native_cog_handoff", "timestamp": timestamp, "evidence": [sidecar_id]},
                {"subject": "resource", "property": prov + "wasGeneratedBy", "value": inventory,
                 "provenance": "derived", "method": "categorical_cell_corner_area_inventory", "timestamp": timestamp, "evidence": [inventory_id]}],
            "curated": [claim("resource", dct + "title", "WorldCover native subset — source 2021 / study 2024"),
                        claim("resource", dct + "description", "Retained native 13 × 13 WorldCover 2021 v200 COG and separate cached AOI summary for a requested 2024 study. No current land use, crop, tenure, impact or complete AOI coverage claim."),
                        claim(distribution, dct + "license", None),
                        claim(distribution, "https://schema.org/creditText", credit),
                        claim(distribution, dct + "accessRights", None), claim(distribution, dct + "rights", None)],
            "inferred": []},
        "context": [{"resourceId": provider, "relationship": prov + "wasDerivedFrom", "evidence": [sidecar_id, inventory_id]}]}
    knowledge = json.dumps(document, ensure_ascii=False, allow_nan=False).encode("utf-8")
    if len(knowledge) > 49_152:
        raise ValueError(f"Managed COG knowledge is {len(knowledge)} bytes, exceeding 48 KiB before upload")
    prior = {}
    for name, maximum in (("API_REQUESTS", 119), ("MILLISECONDS", 119_999)):
        value = os.environ.get("OPENGEO_MANAGED_COG_PRIOR_" + name, "0")
        if not re.fullmatch(r"0|[1-9][0-9]*", value) or int(value) > maximum:
            raise ValueError("Managed COG prior usage must retain a nonnegative value within the remaining batch budget")
        prior[name] = int(value)
    print(f"Managed COG preflight: {len(content)} COG bytes; {len(knowledge)} knowledge bytes (48 KiB maximum)", flush=True)
    return {"content": content, "sourceSha256": checksum, "sourceFilename": source.name,
            "priorApiRequests": prior["API_REQUESTS"], "priorMilliseconds": prior["MILLISECONDS"],
            "knowledgeBytes": len(knowledge), "datasetPlaceholder": dataset_placeholder, "versionPlaceholder": version_placeholder,
            "stagedFiles": {"managed-cog.tif": content, "managed-cog-sidecar.json": sidecar_bytes,
                            "managed-cog-inventory.json": inventory_bytes, "managed-cog-knowledge.json": knowledge}}


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
    publication_only=False,
    publication_compiler_digest=None,
    pmtiles_worker_image=None,
    ftw_query=None,
    managed_cog_file=None,
):
    if ftw_query is not None and managed_cog_file is not None:
        raise ValueError("Choose one retained analysis input")
    ftw_input = load_ftw_query(ftw_query)
    cog_input = load_managed_cog(managed_cog_file)
    retained_input = ftw_input or cog_input
    retained_prefix = "managed-cog" if cog_input else "ftw"
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
    pmtiles = inspect_pmtiles_worker_image(pmtiles_worker_image) if pmtiles_worker_image else None
    if font_runtime is not None:
        verify_cached_worker_image(font_runtime["architecture"])
    work = Path(tempfile.mkdtemp(prefix="opengeo-integrated-studio-"))
    if ftw_input:
        query_path = work / "ftw-query.json"
        query_path.write_bytes(ftw_input["content"])
        query_path.chmod(0o400)
    if cog_input:
        for name, value in cog_input["stagedFiles"].items():
            (work / name).write_bytes(value)
            (work / name).chmod(0o400)
    if font_runtime is not None or pmtiles:
        prepare_worker_scratch(work)
    init = work / "init"
    init.mkdir()
    stage_database_initialization(init, upgrade_from_0082)
    if pmtiles:
        stage_pmtiles_runtime(work, init, pmtiles)
    database = TemporaryDatabase("podman", init, "integrated-studio")
    server_name = f"{database.name}-api"
    worker_name = f"{database.name}-worker"
    pmtiles_worker_name = f"{database.name}-pmtiles"
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
        ROOT / "app/scripts/integrated-studio-publication.mjs",
        ROOT / "scripts/local-publication-bridge.py",
        ROOT / "services/observable-coordinator/src/local-adapters.mjs",
        ROOT / "services/observable-preview/src/local-server.mjs",
        ROOT / "app/scripts/integrated-studio-conversion.mjs",
        ROOT / "app/scripts/integrated-studio-analysis.mjs",
        ROOT / "app/scripts/integrated-studio-analysis-runner.mjs",
        ROOT / "services/observable-coordinator/src/analysis-runner.mjs",
        ROOT / "services/observable-coordinator/src/podman-runner.mjs",
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
    if publication_only:
        stage_publication_profile(work, publication_compiler_digest)
    ftw_started = time.monotonic()
    ftw_alarm = None
    ftw_failure = None
    if retained_input:
        profile = {key: value for key, value in retained_input.items() if key not in {"content", "stagedFiles"}}
        profile.update(schemaVersion="opengeo.integrated-managed-cog.1" if cog_input else "opengeo.integrated-ftw.1", startedAtMilliseconds=int(time.time() * 1000),
                       maximumApiRequests=120, maximumMilliseconds=120_000)
        if cog_input:
            profile.update(closes="BI-01 managed native WorldCover COG upload, reviewed knowledge, render/identify and exact-version Project save/reopen blocker",
                           reuses="Retained nearby-subset.tif, its exact sidecar and nearby-inventory.json; existing upload/worker/Catalog/Project path and cached build/images",
                           limits={"apiRequests": 120, "serviceBrowserMilliseconds": 120_000, "uploads": 1, "workerRuns": 1, "catalogLayers": 1, "knowledgeBytes": 49_152,
                                   "localObjectRanges": 16, "maximumLocalObjectRangeBytes": 12_960,
                                   "providerRequests": 0, "AWS": 0, "GitHub": 0},
                           stop_condition="One exact native COG and reviewed knowledge survives real local managed rendering and Project reopen, or one diagnosed blocker within cumulative limits",
                           result={"status": "pending", "fullBaselineRowsClosed": 0})
        (work / f"{retained_prefix}-profile.json").write_text(json.dumps(profile, indent=2) + "\n")
        (work / f"{retained_prefix}-profile.json").chmod(0o400)
        def ftw_timeout(_signal, _frame):
            raise TimeoutError(f"{retained_prefix} cumulative local service/browser budget reached 120 seconds")
        ftw_alarm = signal.signal(signal.SIGALRM, ftw_timeout)
        signal.setitimer(signal.ITIMER_REAL, (120_000 - retained_input["priorMilliseconds"]) / 1000)
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
            if pmtiles:
                dedicated = container_command(database.name, work, pmtiles_worker_name,
                    pmtiles["imageDigest"], "python3", "scripts/run-integrated-pilot-local.py",
                    "--stage", "worker-pmtiles", pmtiles_worker=True)
                (work / "pmtiles-worker-command.json").write_text(json.dumps(dedicated))
            (work / "local-api-container.json").write_text(json.dumps(server_name))
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
                        publication_only=publication_only,
                    ),
                    cwd=ROOT,
                    check=True,
                    timeout=(max(1, (120_000 - retained_input["priorMilliseconds"]) / 1000
                                 - (time.monotonic() - ftw_started)) if retained_input
                             else 270 if publication_only else 600),
                )
    except Exception as error:
        ftw_failure = f"{type(error).__name__}: {error}"
        raise
    finally:
        if retained_input:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, ftw_alarm)
            progress_path = work / f"{retained_prefix}-progress.json"
            progress = json.loads(progress_path.read_text()) if progress_path.exists() else {}
            if ftw_failure:
                progress.update(status="failed", runnerError=ftw_failure[:4000])
            progress.update(sourceSha256=retained_input["sourceSha256"],
                            cumulativeApiRequestAttempts=progress.get("cumulativeApiRequestAttempts", retained_input["priorApiRequests"]),
                            cumulativeMilliseconds=retained_input["priorMilliseconds"] + round((time.monotonic() - ftw_started) * 1000))
            progress_path.write_text(json.dumps(progress, indent=2) + "\n")
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
                [*([pmtiles_worker_name] if pmtiles else []), worker_name, server_name, database.name], volumes, process
            )
            if cog_input:
                progress_path = work / "managed-cog-progress.json"
                progress = json.loads(progress_path.read_text())
                progress.update(allTemporaryContainersRemoved=True, removedDatabaseVolumes=volumes,
                                cleanupFinishedAt=datetime.now(UTC).isoformat())
                progress_path.write_text(json.dumps(progress, indent=2) + "\n")
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
    if pmtiles:
        receipt["pmtiles_runtime"] = {**pmtiles, "hostArchitecture": os.uname().machine,
            "transport": "isolated local file queue", "new_image_build": False}
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


def development_state(directory, database_image, pending_archive_tiff_upgrade=False):
    directory = development_directory(directory)
    marker = directory / "development-state.json"
    sources = {str(p.relative_to(ROOT)): pilot.digest(p.read_bytes())
               for p in database_initialization_sources()}
    if marker.exists():
        if marker.is_symlink():
            raise ValueError("Development state marker must not be a symlink")
        metadata = json.loads(marker.read_text())
        pending_path = "database/migrations/0177_observable_archive_tiff_preview_output.sql"
        pending_schema = (pending_archive_tiff_upgrade
                          and sources.get(pending_path) == "4fbbbb02cddddc7a5298e4c6f139130871f232aab950039ac79d5539e336d14a"
                          and metadata.get("schemaSources") == {key: value for key, value in sources.items() if key != pending_path})
        if (metadata.get("schemaVersion") != "opengeo.community-development.1"
                or not re.fullmatch(r"opengeo-community-[0-9a-f]{32}", metadata.get("database", ""))
                or metadata.get("databaseImage") != database_image
                or (metadata.get("schemaSources") != sources and not pending_schema)):
            raise ValueError("Development database identity/schema changed; retain this state and review an upgrade before reopening")
    else:
        if any(path.name != "development.lock" for path in directory.iterdir()):
            raise ValueError("A new development state directory must be empty")
        metadata = {"schemaVersion": "opengeo.community-development.1",
                    "database": f"opengeo-community-{uuid4().hex}",
                    "databaseImage": database_image, "schemaSources": sources}
        marker.write_text(json.dumps(metadata, indent=2) + "\n")
    return directory, metadata


def stage_baseline_study(work, source, tree_digest, continuation_sha256=None, compiler_digest=None):
    """Admit retained inputs before starting the persistent local services."""
    if source is None:
        return None
    source = Path(source).absolute()
    def owned(path, maximum):
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or not 0 < info.st_size <= maximum:
            raise ValueError("Baseline inputs must be owned regular bounded files")
        data = path.read_bytes()
        if len(data) != info.st_size:
            raise ValueError("A baseline input changed during preflight")
        return data
    config = json.loads(owned(source, 65_536))
    if (config.get("admissionBatchId") != "BI-01-private-baseline-publication"
            or set(config.get("inputs", {})) != {"fields", "landcover"}
            or config.get("limits", {}).get("apiRequests") != 220
            or config.get("limits", {}).get("milliseconds") != 180_000):
        raise ValueError("The baseline study requires its admitted finite profile")
    admission = json.loads((ROOT / ".local-archives/baseline-intelligence-20261023/admission.json").read_bytes())
    batch = next((item for item in admission["batches"] if item["id"] == config["admissionBatchId"]), None)
    if batch is None or not (
            (batch["limits"]["localApiRequests"] in {220, 280, 400} and batch["limits"]["serviceBrowserMilliseconds"] == 180_000)
            or (batch["limits"]["localApiRequests"] == 480 and batch["limits"]["serviceBrowserMilliseconds"] in {240_000, 280_000})):
        raise ValueError("The baseline batch admission changed")
    staged, identity = {}, {}
    for key, size, suffix in (("fields", 961, "geojson"), ("landcover", 810, "tif")):
        item = config["inputs"][key]
        data = owned(Path(item["file"]), size)
        if len(data) != size or item["sizeBytes"] != size or pilot.digest(data) != item["sha256"]:
            raise ValueError(f"The exact retained {key} bytes changed")
        document = json.loads(owned(Path(item["knowledge"]), 100_000))
        if item.get("knowledgeSelector"):
            if item["knowledgeSelector"] != "metadata.document":
                raise ValueError("Only the retained field knowledge wrapper is supported")
            document = document["metadata"]["document"]
        knowledge = json.dumps(document, ensure_ascii=False, allow_nan=False).encode()
        if document.get("schemaVersion") != "1.0.0" or len(knowledge) > 49_152:
            raise ValueError("Baseline knowledge must fit the existing 48 KiB resource contract")
        for field in ("baseDatasetId", "baseDatasetVersionId"):
            if not re.fullmatch(r"[a-f0-9-]{36}", item.get(field, "")):
                raise ValueError("The retained output identity must be explicit")
        distribution = f'urn:opengeo:dataset:{item["baseDatasetId"]}:version:{item["baseDatasetVersionId"]}:original'
        if not any(value.get("id") == distribution for value in document.get("distributions", [])):
            raise ValueError("The baseline knowledge does not name its exact retained version")
        filename, knowledge_name = item.get("filename", f"baseline-{key}.{suffix}"), f"baseline-{key}-knowledge.json"
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(?:geojson|tif)", filename):
            raise ValueError("The baseline upload filename must be an ordinary GeoJSON or TIFF name")
        staged[filename], staged[knowledge_name] = data, knowledge
        config["inputs"][key] = {**item, "file": filename, "knowledge": knowledge_name, "knowledgeSelector": None,
                                 "knowledgeSha256": pilot.digest(knowledge)}
        identity[key] = {"sha256": pilot.digest(data), "sizeBytes": size, "knowledgeSha256": pilot.digest(knowledge)}
    report_files = config.get("reportFiles", [])
    if not isinstance(report_files, list) or len(report_files) > 12:
        raise ValueError("The baseline publication has at most twelve files")
    total = 0
    for index, item in enumerate(report_files):
        relative = item.get("relativePath", "")
        if (not isinstance(relative, str) or not relative or len(relative) > 200
                or any(part in {"", ".", ".."} for part in relative.split("/")) or "\\" in relative):
            raise ValueError("Baseline report paths must be safe relative file names")
        if item.get("fromWork"):
            if item["path"] != "baseline-map.svg":
                raise ValueError("Only the deliberately captured baseline figure is generated in the state")
            continue
        data = owned(Path(item["path"]), 2_097_152)
        total += len(data)
        name = f"baseline-report-{index}"
        staged[name], item["path"] = data, str(work / name)
        item["sha256"], item["sizeBytes"] = pilot.digest(data), len(data)
    if total > 2_097_152:
        raise ValueError("The baseline publication inputs exceed 2 MiB")
    config["inputIdentity"] = identity
    encoded = json.dumps(config, ensure_ascii=False, allow_nan=False).encode()
    profile_sha = pilot.digest(encoded)
    progress_path = work / "baseline-progress.json"
    if progress_path.is_symlink():
        raise ValueError("Baseline progress must not be a symlink")
    progress = json.loads(owned(progress_path, 500_000)) if progress_path.exists() else {}
    if progress and progress.get("profileSha256") != profile_sha:
        raise ValueError("The retained baseline profile changed; preserve committed progress")
    retained_attempts = progress.get("serviceAttempts", 0)
    compiler_refresh = bool(continuation_sha256 and retained_attempts == 6)
    report_correction = bool(continuation_sha256 and retained_attempts == 7)
    preview_readback = bool(continuation_sha256 and retained_attempts == 8)
    helper = "integrated-studio-publication.mjs" if compiler_refresh or report_correction or preview_readback else "integrated-studio-analysis.mjs"
    helper_sha = pilot.digest((ROOT / "app/scripts" / helper).read_bytes())
    if continuation_sha256 and (retained_attempts not in {2, 3, 4, 5, 6, 7, 8}
            or continuation_sha256 != helper_sha or progress.get("helperSha256") == helper_sha):
        raise ValueError("Baseline continuation requires its diagnosed retained phase and reviewed changed helper SHA-256")
    refresh_phase = None
    if compiler_refresh:
        refresh_phase = next((item for item in batch.get("deliveryPhases", [])
                              if item.get("id") == "BI-01-tiff-compiler-refresh-preview"), None)
        refresh = refresh_phase.get("compilerRefresh", {}) if refresh_phase else {}
        publication = progress.get("publication", {})
        refresh_limits = refresh_phase.get("limits", {}) if refresh_phase else {}
        if (set(refresh) != {"oldDigest", "newDigest", "failedJobId", "sourceRevisionId", "sourceManifest",
                             "approvalReference", "sourceContractSha256"}
                or refresh.get("oldDigest") != "sha256:e6825d9f73a3bc0ac1514363a4778cd304c61f6a53ed841bd1f4b14a790be0d7"
                or not re.fullmatch(r"sha256:[a-f0-9]{64}", refresh.get("newDigest") or "")
                or refresh["newDigest"] == refresh["oldDigest"] or compiler_digest != refresh["newDigest"]
                or refresh.get("failedJobId") != publication.get("buildId")
                or refresh.get("sourceRevisionId") != publication.get("revisionId")
                or refresh.get("sourceManifest") != publication.get("sourceManifest")
                or not all(re.fullmatch(r"[a-f0-9-]{36}", value or "") for value in (
                    progress.get("projectId"), publication.get("sourceProjectId"), refresh.get("failedJobId"), refresh.get("sourceRevisionId")))
                or not re.fullmatch(r"[a-f0-9]{64}", refresh.get("sourceManifest") or "")
                or not isinstance(refresh.get("approvalReference"), str) or not 1 <= len(refresh["approvalReference"]) <= 512
                or refresh.get("sourceContractSha256") != pilot.digest((ROOT / "services/observable-builder/src/contract.mjs").read_bytes())
                or progress.get("status") != "failed" or progress.get("phase") != "baseline-data-ready"
                or not progress.get("mapSaved") or not progress.get("mapReopened") or progress.get("map", {}).get("version") != 3
                or progress.get("figure", {}).get("presentationReview", {}).get("status") != "accepted-local-visual"
                or not progress.get("figure", {}).get("output") or publication.get("revisionNumber") != 3
                or not publication.get("buildAttempted") or not publication.get("coordinatorAttempted")
                or publication.get("compilerOutcome") != "failed" or publication.get("compilerErrorCode") != "runner_container_failed"
                or publication.get("nativeCompilerInvocations") != 1 or progress.get("nativeBuildRequests") != 1
                or progress.get("apiRequestAttempts") != 395 or progress.get("activeMilliseconds") != 170_850
                or any(refresh_limits.get(key) != value for key, value in {
                    "serviceAttempts": 1, "automaticRetries": 0, "cumulativeLocalApiRequests": 480,
                    "priorLocalApiRequests": 395, "cumulativeServiceMilliseconds": 240_000, "priorServiceMilliseconds": 170_850,
                    "cumulativeNativeBuilds": 2, "priorFailedNativeBuilds": 1, "newSourceRevisions": 0,
                    "sourceUploads": 0, "newIngestions": 0, "newFigureCaptures": 0,
                    "AWSAccountCalls": 0, "GitHubCalls": 0, "providerCalls": 0}.items())
                or progress.get("compilerRefresh") not in (None, refresh)):
            raise ValueError("Compiler refresh must retain the exact diagnosed source3 failure and admitted changed-compiler scope")
        progress["compilerRefresh"] = refresh
    if report_correction:
        phase = next((item for item in batch.get("deliveryPhases", [])
                      if item.get("id") == "BI-01-tiff-report-archive-preview"), {})
        correction = phase.get("compilerReportCorrection", {})
        publication = progress.get("publication", {})
        if (set(correction) != {"failedJobId", "coordinatorContractSha256", "migrationSha256"}
                or correction.get("failedJobId") != "f146a70d-7ea4-4e6b-bcc1-05c0930ae07b"
                or correction["failedJobId"] != publication.get("buildId")
                or correction.get("coordinatorContractSha256") != pilot.digest((ROOT / "services/observable-coordinator/src/contracts.mjs").read_bytes())
                or correction.get("migrationSha256") != "4fbbbb02cddddc7a5298e4c6f139130871f232aab950039ac79d5539e336d14a"
                or progress.get("status") != "failed" or progress.get("phase") != "resume-saved-baseline-publication"
                or publication.get("compilerErrorCode") != "compiler_output_invalid" or publication.get("compilerOutcome") != "failed"
                or publication.get("nativeCompilerInvocations") != 2 or progress.get("nativeBuildRequests") != 2
                or progress.get("apiRequestAttempts") != 413 or progress.get("activeMilliseconds") != 197_195
                or progress.get("compilerRefreshTransition", {}).get("sequence") != 1
                or compiler_digest != progress.get("compilerRefresh", {}).get("newDigest")
                or publication.get("revisionId") != progress.get("compilerRefresh", {}).get("sourceRevisionId")
                or publication.get("sourceManifest") != progress.get("compilerRefresh", {}).get("sourceManifest")
                or publication.get("revisionNumber") != 3 or progress.get("map", {}).get("version") != 3
                or progress.get("figure", {}).get("presentationReview", {}).get("status") != "accepted-local-visual"
                or phase.get("limits") != {"serviceAttempts": 1, "automaticRetries": 0,
                    "cumulativeLocalApiRequests": 480, "priorLocalApiRequests": 413,
                    "cumulativeServiceMilliseconds": 240_000, "priorServiceMilliseconds": 197_195,
                    "cumulativeNativeBuilds": 3, "priorFailedNativeBuilds": 2,
                    "newSourceRevisions": 0, "sourceUploads": 0, "newIngestions": 0,
                    "newFigureCaptures": 0, "newCompilerImages": 0, "newCompilerTransitions": 0,
                    "AWSAccountCalls": 0, "GitHubCalls": 0, "providerCalls": 0}):
            raise ValueError("Report correction must preserve the exact second failure, source, transition and cumulative ceilings")
        progress["compilerReportCorrection"] = correction
    if preview_readback:
        phase = next((item for item in batch.get("deliveryPhases", [])
                      if item.get("id") == "BI-01-tiff-client-preview-readback"), {})
        readback = phase.get("previewReadback", {})
        publication = progress.get("publication", {})
        if (set(readback) != {"buildJobId", "studioTreeDigest", "clientSha256"}
                or readback.get("buildJobId") != "e2b3303b-0821-4940-a365-9ace13947d0a"
                or readback["buildJobId"] != publication.get("buildId")
                or readback.get("studioTreeDigest") != tree_digest
                or readback.get("clientSha256") != pilot.digest((ROOT / "app/src/lib/apiClient.js").read_bytes())
                or compiler_digest != progress.get("compilerRefresh", {}).get("newDigest")
                or progress.get("status") != "failed-stop" or progress.get("phase") != "resume-saved-baseline-publication"
                or progress.get("apiRequestAttempts") != 433 or progress.get("activeMilliseconds") != 240_551
                or progress.get("nativeBuildRequests") != 3 or publication.get("nativeCompilerInvocations") != 3
                or publication.get("compilerOutcome") != "succeeded" or not publication.get("exactOriginalOutputs")
                or publication.get("outputFiles") != 9 or publication.get("revisionNumber") != 3
                or progress.get("map", {}).get("version") != 3 or not progress.get("compilerReportMigration", {}).get("verified")
                or not progress.get("compilerReportMigration", {}).get("aclUnchanged")
                or phase.get("limits") != {"serviceAttempts": 1, "automaticRetries": 0,
                    "cumulativeLocalApiRequests": 480, "priorLocalApiRequests": 433,
                    "cumulativeServiceMilliseconds": 280_000, "priorServiceMilliseconds": 240_551,
                    "newNativeBuilds": 0, "newSourceRevisions": 0, "sourceUploads": 0,
                    "newIngestions": 0, "newCompilerImages": 0, "newCompilerTransitions": 0,
                    "newFigureCaptures": 0, "AWSAccountCalls": 0, "GitHubCalls": 0, "providerCalls": 0}):
            raise ValueError("Preview readback must reuse the exact successful build with only the reviewed client fix")
        progress["previewReadback"] = readback
    if continuation_sha256 and retained_attempts == 3 and (
            progress.get("status") != "failed" or progress.get("phase") != "add-exact-catalog-versions"
            or progress.get("mapSaved") or not progress.get("workerCompleted")
            or not all(progress.get("records", {}).get(key, {}).get("knowledgeReadback") for key in ("fields", "landcover"))):
        raise ValueError("The final changed-method continuation must reuse both committed originals and knowledge before map delivery")
    if continuation_sha256 and retained_attempts in {4, 5} and (
            progress.get("status") != "failed" or progress.get("phase") != (
                "baseline-data-ready" if retained_attempts == 4 else "reuse-committed-originals-and-knowledge")
            or not progress.get("mapSaved") or not progress.get("mapReopened") or progress.get("map", {}).get("version") != 2
            or progress.get("figure", {}).get("presentationReview", {}).get("status") != "needs-closer-extent"
            or progress.get("figure", {}).get("supersedes") or not progress.get("publication", {}).get("revisionId")
            or progress.get("publication", {}).get("revisionNumber") != 2 or progress.get("nativeBuildRequests", 0)
            or progress.get("publication", {}).get("nativeCompilerInvocations", 0)):
        raise ValueError("The presentation phase must preserve the accepted map/source revisions before its only native build")
    maximum_attempts = retained_attempts + 1 if continuation_sha256 else 2
    api_ceiling = 480 if compiler_refresh or report_correction or preview_readback else 400 if continuation_sha256 and retained_attempts in {4, 5} else 280 if continuation_sha256 and retained_attempts == 3 else 220
    milliseconds_ceiling = 280_000 if preview_readback else 240_000 if compiler_refresh or report_correction else 180_000
    if api_ceiling != batch["limits"]["localApiRequests"]:
        raise ValueError("The baseline continuation must match its recorded cumulative API ceiling")
    if progress.get("serviceAttempts", 0) >= maximum_attempts or progress.get("activeMilliseconds", 0) >= milliseconds_ceiling or progress.get("apiRequestAttempts", 0) >= api_ceiling:
        raise ValueError("The baseline cumulative service/browser budget is exhausted")
    if continuation_sha256:
        progress["changedMethodHelperSha256"] = continuation_sha256
    queue = json.loads((work / "queue.json").read_bytes()) if (work / "queue.json").exists() else []
    selected = {item.get("datasetId") for item in progress.get("records", {}).values()}
    for message in queue:
        payload = json.loads(message["body"])
        entries = payload.get("Records", [])
        if not entries or any(not any(f"/datasets/{identifier}/" in record.get("s3", {}).get("object", {}).get("key", "")
                for identifier in selected if identifier) for record in entries):
            raise ValueError("Reconcile unrelated retained ingestion jobs before the baseline worker batch")
    for name, data in staged.items():
        target = work / name
        if target.is_symlink():
            raise ValueError("A staged baseline input must not be a symlink")
        if target.exists():
            if owned(target, len(data)) != data:
                raise ValueError("A retained baseline input changed; preserve committed progress")
        else:
            target.write_bytes(data);target.chmod(0o400)
    profile = work / "baseline-profile.json"
    if profile.is_symlink():
        raise ValueError("Baseline profile must not be a symlink")
    if profile.exists():
        if owned(profile, len(encoded)) != encoded:
            raise ValueError("The retained baseline profile changed; preserve committed progress")
    else:
        profile.write_bytes(encoded);profile.chmod(0o400)
    # Reuse the exact sealed artifact before waking the database. No builder runs.
    manifest = work / "studio-build-manifest.json"
    if manifest.exists() and json.loads(manifest.read_bytes())["artifactTree"]["digest"] != tree_digest:
        staged_tree = work / "built-studio"
        if staged_tree.is_symlink() or staged_tree.resolve().parent != work.resolve():
            raise ValueError("Only the owned generated Studio tree may be restaged")
        (work / "baseline-prior-studio-manifest.json").write_bytes(manifest.read_bytes())
        if preview_readback:
            prior_tree = json.loads(manifest.read_bytes())["artifactTree"]["digest"]
            retained_tree = work / f"baseline-prior-studio-{prior_tree}"
            if retained_tree.exists() or retained_tree.is_symlink():
                raise ValueError("The previous Studio artifact is already retained; inspect before restaging")
            staged_tree.rename(retained_tree)
        else:
            shutil.rmtree(staged_tree)
        manifest.unlink()
    if not manifest.exists():
        stage_built_studio(work, tree_digest)
    progress.update(schemaVersion="opengeo.baseline-study.1", mode="baseline-intelligence", profileSha256=profile_sha,
                    serviceAttempts=progress.get("serviceAttempts", 0) + 1, status="running",
                    runnerStartedAtMilliseconds=int(time.time() * 1000), records=progress.get("records", {}),
                    helperSha256=helper_sha, apiRequestCeiling=api_ceiling,
                    cumulativeMillisecondsCeiling=milliseconds_ceiling)
    progress_path.write_text(json.dumps(progress, indent=2) + "\n");progress_path.chmod(0o600)
    return progress


def refresh_baseline_compiler_owner():
    """Service one admitted local Source through the existing owner-only function."""
    if ROOT != Path("/repo"):
        raise ValueError("Compiler policy servicing requires the isolated local container")
    import psycopg

    progress_path = pilot.WORK / "baseline-progress.json"
    progress = json.loads(progress_path.read_bytes())
    refresh, publication = progress["compilerRefresh"], progress["publication"]
    if (progress.get("serviceAttempts") != 7 or not progress.get("compilerRefreshTransition", {}).get("attempted")
            or progress.get("nativeBuildRequests") != 1 or publication.get("nativeCompilerInvocations") != 1
            or refresh["sourceRevisionId"] != publication["revisionId"] or publication["revisionNumber"] != 3
            or refresh["sourceManifest"] != publication["sourceManifest"] or refresh["failedJobId"] != publication["buildId"]):
        raise ValueError("The compiler policy transition must precede its one replacement build")
    scope = (pilot.ORG, progress["projectId"], publication["sourceProjectId"])
    with psycopg.connect("postgresql://postgres@127.0.0.1/opengeo?sslmode=disable") as connection:
        connection.execute("SET LOCAL statement_timeout = '5s'")
        source = connection.execute(
            """SELECT source.current_revision_id::text, source.current_revision_number,
                      revision.manifest_checksum_sha256,
                      app.observable_effective_compiler_digest(source.organization_id, source.id)
               FROM app.observable_source_projects source
               JOIN app.observable_source_revisions revision
                 ON revision.organization_id = source.organization_id
                AND revision.source_project_id = source.id AND revision.id = source.current_revision_id
               WHERE source.organization_id = %s AND source.project_id = %s AND source.id = %s
               FOR UPDATE OF source""", scope).fetchone()
        if source is None or tuple(source[:3]) != (refresh["sourceRevisionId"], 3, refresh["sourceManifest"]):
            raise ValueError("Compiler servicing must preserve the exact accepted source3 head and manifest")
        failed = connection.execute(
            """SELECT source_revision_id::text, source_revision_number, state::text,
                      error_code, attempt_count, request, request_checksum_sha256
               FROM app.observable_build_jobs
               WHERE organization_id = %s AND project_id = %s AND source_project_id = %s AND id = %s""",
            (*scope, refresh["failedJobId"])).fetchone()
        if (failed is None or tuple(failed[:5]) != (refresh["sourceRevisionId"], 3, "failed", "runner_container_failed", 1)
                or failed[5].get("compilerImageDigest") != refresh["oldDigest"]
                or failed[5].get("sourceRevisionId") != refresh["sourceRevisionId"]
                or failed[5].get("sourceManifestChecksumSha256") != refresh["sourceManifest"]):
            raise ValueError("The exact diagnosed compiler failure must remain unchanged")
        latest = connection.execute(
            """SELECT sequence, previous_digest, compiler_digest, approval_reference
               FROM app.observable_compiler_transitions
               WHERE organization_id = %s AND project_id = %s AND source_project_id = %s
               ORDER BY sequence DESC LIMIT 1""", scope).fetchone()
        reconciled = source[3] == refresh["newDigest"]
        if reconciled:
            if latest is None or tuple(latest[1:]) != (refresh["oldDigest"], refresh["newDigest"], refresh["approvalReference"]):
                raise ValueError("An existing compiler transition does not match the admitted servicing record")
            sequence = latest[0]
        else:
            if source[3] != refresh["oldDigest"]:
                raise ValueError("The effective compiler changed outside the admitted transition")
            sequence = connection.execute(
                "SELECT app.record_observable_compiler_transition(%s, %s, %s, %s, %s, %s)",
                (*scope, refresh["oldDigest"], refresh["newDigest"], refresh["approvalReference"])).fetchone()[0]
        readback = connection.execute(
            """SELECT source.current_revision_id::text, source.current_revision_number,
                      revision.manifest_checksum_sha256,
                      app.observable_effective_compiler_digest(source.organization_id, source.id)
               FROM app.observable_source_projects source
               JOIN app.observable_source_revisions revision
                 ON revision.organization_id = source.organization_id
                AND revision.source_project_id = source.id AND revision.id = source.current_revision_id
               WHERE source.organization_id = %s AND source.project_id = %s AND source.id = %s""", scope).fetchone()
        if tuple(readback or ()) != (refresh["sourceRevisionId"], 3, refresh["sourceManifest"], refresh["newDigest"]):
            raise ValueError("The exact compiler transition readback failed")
    # The database context committed first. An interrupted receipt write is
    # reconciled from the append-only transition rather than appended again.
    progress["compilerRefreshTransition"].update(
        sequence=sequence, effectiveDigest=refresh["newDigest"], reconciled=reconciled,
        sourceRevisionId=readback[0], revisionNumber=readback[1], sourceManifest=readback[2],
        failedJobId=refresh["failedJobId"], failedState=failed[2], failedErrorCode=failed[3],
        failedAttemptCount=failed[4], failedRequestChecksum=failed[6], verified=True)
    progress_path.write_text(json.dumps(progress, indent=2) + "\n")
    progress_path.chmod(0o600)


def stage_analysis_profile(work, source=None):
    """Explicit local opt-in only; never retain activation across an omitted flag."""
    target = work / "analysis-profile.json"
    if target.is_symlink():
        raise ValueError("Analysis profile must not be a symlink")
    if source is None:
        target.unlink(missing_ok=True)
        return
    source = Path(source)
    if source.is_symlink() or not source.is_file() or source.stat().st_uid != os.getuid() or source.stat().st_size > 16384:
        raise ValueError("Analysis profile must be a small owned regular JSON file")
    config = json.loads(source.read_text())
    if (not isinstance(config, dict) or set(config) - {"profiles", "timeoutSeconds", "memoryMiB"}
            or not isinstance(config.get("profiles"), dict) or not config["profiles"]):
        raise ValueError("Analysis profile has unsupported configuration")
    interpreters = {"python": {"/usr/bin/python3", "/usr/local/bin/python3", "/var/lang/bin/python3.14"},
                    "javascript": {"/usr/bin/node", "/usr/local/bin/node", "/nodejs/bin/node", "/var/lang/bin/node"},
                    "bash": {"/bin/bash", "/usr/bin/bash"}}
    for language, profile in config["profiles"].items():
        if (language not in interpreters or not isinstance(profile, dict) or set(profile) != {"image", "interpreter"}
                or not isinstance(profile["image"], str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", profile["image"])
                or not isinstance(profile["interpreter"], str) or profile["interpreter"] not in interpreters[language]):
            raise ValueError("Analysis requires exact cached image IDs and allowlisted native interpreters")
    timeout, memory = config.get("timeoutSeconds", 10), config.get("memoryMiB", 256)
    if type(timeout) is not int or not 1 <= timeout <= 30 or type(memory) is not int or memory not in (256, 512):
        raise ValueError("Analysis resource limits are outside the supported local profile")
    staged = work / f".analysis-profile-{uuid4().hex}.json"
    try:
        with open(staged, "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as handle:
            json.dump({"enabled": True, **config}, handle)
            handle.write("\n")
        staged.replace(target)
    finally:
        staged.unlink(missing_ok=True)


def stage_postgis_fixture(work, enabled=False):
    """Configure only the owned local fixture; omitted opt-in removes activation."""
    work = development_directory(work)
    target = work / "postgis-fixture.json"
    if target.is_symlink():
        raise ValueError("PostGIS fixture profile must not be a symlink")
    if not enabled:
        target.unlink(missing_ok=True)
        return
    marker = work / "development-state.json"
    if marker.is_symlink() or not marker.is_file() or marker.stat().st_uid != os.getuid():
        raise ValueError("PostGIS fixture requires an owned development state marker")
    metadata = json.loads(marker.read_text())
    if (metadata.get("schemaVersion") != "opengeo.community-development.1"
            or not re.fullmatch(r"opengeo-community-[0-9a-f]{32}", metadata.get("database", ""))):
        raise ValueError("PostGIS fixture requires the existing local development database")
    staged = work / f".postgis-fixture-{uuid4().hex}.json"
    try:
        with open(staged, "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as handle:
            json.dump({"schemaVersion": "opengeo.local-postgis-fixture.1"}, handle)
            handle.write("\n")
        staged.replace(target)
    finally:
        staged.unlink(missing_ok=True)


def cleanup_development_api(server_name, worker_name, process, *, postgis_fixture=False, bounded=False):
    if bounded:
        # The building journey reserves ten seconds for all shutdown/readback.
        # Remove only its two temporary containers; retain the database/volume.
        subprocess.run(["podman", "rm", "--force", server_name, worker_name],
                       capture_output=True, check=False, timeout=2)
        if process is not None:
            process.wait(timeout=1)
        return
    try:
        if postgis_fixture and process is not None:
            # Finish the fixture's metadata receipt while its database is alive.
            subprocess.run(["podman", "stop", "--time=5", server_name],
                           capture_output=True, check=False, timeout=10)
    finally:
        pilot.cleanup_resources([server_name, worker_name], [], process)


def retained_real_building_inputs(path, expected_sha256):
    """Read the finite local pair; never retrieve or silently replace an input."""
    from uuid import NAMESPACE_URL, uuid5

    def owned_bytes(target, maximum):
        target = Path(target).absolute()
        if (target.is_symlink() or target.resolve() != target or not target.is_file()
                or target.stat().st_uid != os.getuid() or target.stat().st_size > maximum):
            raise ValueError("Real building inputs require bounded owned regular files")
        return target.read_bytes()

    if not re.fullmatch(r"[a-f0-9]{64}", expected_sha256 or ""):
        raise ValueError("Real building inputs require the exact manifest SHA-256")
    path = Path(path).absolute()
    encoded = owned_bytes(path, 262_144)
    if pilot.digest(encoded) != expected_sha256:
        raise ValueError("The real building input manifest changed")
    manifest = json.loads(encoded)
    entries = manifest.get("inputs", [])
    if (len(entries) != 2 or {entry.get("role") for entry in entries} != {"source", "comparison"}
            or manifest.get("publicRedistributionApproved") is not False):
        raise ValueError("Real building acceptance requires the exact private two-inventory pair")
    inputs, provenance, total_bytes, total_features = {}, {}, 0, 0
    for entry in entries:
        documents = {}
        for kind in ("querySnapshot", "nativeInput"):
            reference = entry[kind]
            filename = reference["path"]
            if not isinstance(filename, str) or Path(filename).name != filename or not filename.endswith(".geojson"):
                raise ValueError("Building input paths must be plain GeoJSON filenames")
            data = owned_bytes(path.parent / filename, 2_097_152)
            total_bytes += len(data)
            if (len(data) != reference["bytes"] or pilot.digest(data) != reference["sha256"]
                    or total_bytes > 2_097_152):
                raise ValueError("A frozen building input checksum/size changed")
            documents[kind] = json.loads(data)
        original, native = documents["querySnapshot"], documents["nativeInput"]
        features = native.get("features", [])
        if (original.get("type") != "FeatureCollection" or native.get("type") != "FeatureCollection"
                or not features or len(features) != entry["featureCount"]
                or len(features) != len(original.get("features", []))):
            raise ValueError("A real building inventory is empty or changed")
        expected_mapping = []
        for before, after in zip(original["features"], features):
            if (before.get("geometry") != after.get("geometry") or before.get("properties") != after.get("properties")
                    or after.get("geometry", {}).get("type") not in ("Polygon", "MultiPolygon")
                    or after.get("id") != str(uuid5(NAMESPACE_URL, entry["serviceUrl"] + "#fid=" + str(after["properties"]["fid"])))):
                raise ValueError("Building normalization changed original geometry, attributes or identity")
            expected_mapping.append({"nativeFeatureId": after["id"], "providerFid": after["properties"]["fid"],
                                     "originalGeojsonId": before.get("id")})
        if entry["nativeInput"].get("featureIdentityMapping") != expected_mapping:
            raise ValueError("The retained provider/native identity mapping changed")
        if len({feature["id"] for feature in features}) != len(features):
            raise ValueError("Real building native identities must be unique")
        role = entry["role"]
        inputs[role] = features
        provenance[role] = {**entry, "AOI": manifest["AOI"], "reviewPolicy": manifest["reviewPolicy"],
                            "inputPairSha256": expected_sha256, "publicRedistributionApproved": False}
        total_features += len(features)
    if total_features != manifest.get("combinedFeatureCount") or not 2 <= total_features <= 1_000:
        raise ValueError("The real building feature budget changed")
    return {"inputs": inputs, "provenance": provenance,
            "titles": {"source": "NSDI buildings (capped source sample)",
                       "comparison": "NSDI building footprints (capped comparison sample)",
                       "project": "[Acceptance] Real NSDI building review", "map": "Capped NSDI building comparison",
                       "output": "NSDI building workflow selection"},
            "attribution": "Bhutan NSDI public services; exact query snapshots retained; dates, rights and reference quality unknown",
            "description": "Local workflow acceptance using two capped NSDI samples. Source-only selection is a mechanical policy; no expert validation, complete inventory or accuracy claim.",
            "reviewReason": "Workflow acceptance policy: retain source inventory footprints without changing coordinates. This mechanical choice does not establish dates, correctness, independent reference quality or a validated building total.",
            "mapView": {"center": [89.6385, 27.472], "zoom": 17}}


def stage_building_review(work, tree_digest, continuation_sha256=None, *, receptor_screening=False,
                          raster_catalog=False, raster_validation=False, stac_items=False, building_input_preview=False,
                          building_inputs=None, building_inputs_sha256=None):
    """Reuse the admitted local account, retaining unrelated data and receipts."""
    if building_input_preview and any((stac_items, raster_validation, raster_catalog, receptor_screening)):
        raise ValueError("Retained building input preview requires its own admitted journey")
    if stac_items and (raster_validation or raster_catalog or receptor_screening):
        raise ValueError("STAC Items requires its own admitted journey")
    if raster_validation and (raster_catalog or receptor_screening):
        raise ValueError("Raster validation requires its own admitted journey")
    real_buildings = building_inputs is not None
    if real_buildings and any((building_input_preview, stac_items, raster_validation, raster_catalog, receptor_screening)):
        raise ValueError("Real building inputs require their own admitted building journey")
    input_profile = retained_real_building_inputs(building_inputs, building_inputs_sha256) if real_buildings else None
    prefix = ("building-real-review" if real_buildings else "building-input-preview" if building_input_preview else "stac-items" if stac_items else "raster-validation" if raster_validation else "raster-catalog" if raster_catalog
              else "receptor-screening" if receptor_screening else "building-review")
    label = ("Retained building input preview" if building_input_preview else "STAC Items" if stac_items else "Raster validation" if raster_validation else "Raster Catalog" if raster_catalog
             else "Receptor screening" if receptor_screening else "Building review")
    api_limit, upload_limit = ((80, 0) if building_input_preview else (140, 0) if stac_items else (260, 1) if raster_validation else (240, 2) if raster_catalog
                               else (180, 4) if receptor_screening else (160, 3))
    work_limit, total_limit = (110_000, 120_000) if stac_items or building_input_preview else (170_000, 180_000)
    if stac_items and tree_digest != "ceb8a9d59c9be8f1490e9760d5001b3648dbf8e099c886bb18eb03c443fd9ddb":
        raise ValueError("STAC Items requires the exact admitted cached Studio tree")
    if not re.fullmatch(r"[a-f0-9]{64}", tree_digest or ""):
        raise ValueError("Building review requires an exact sealed Studio tree")
    for filename in ("development-state.json", "identities-seeded", "studio-build-manifest.json"):
        path = work / filename
        if path.is_symlink() or not path.is_file() or path.stat().st_uid != os.getuid():
            raise ValueError("Building review requires the owned retained local account")
    if any((work / filename).exists() for filename in ("analysis-profile.json", "postgis-fixture.json")):
        raise ValueError("Building review must not activate an unrelated analysis fixture")
    admission = json.loads((ROOT / ".local-archives/baseline-intelligence-20261023/admission.json").read_bytes())
    batch_id = ("BI-02-07-real-building-account-review" if real_buildings else "BI-02-retained-building-input-preview" if building_input_preview else "BI-03-external-stac-item-assets" if stac_items else "BI-07-stratified-validation" if raster_validation else "BI-04-07-raster-output-catalog" if raster_catalog
                else "BI-05-main-account-receptor-screening" if receptor_screening else "BI-02-07-main-account-building-review")
    batch = next((item for item in admission["batches"] if item["id"] == batch_id), None)
    limits = batch.get("limits", {}) if batch else {}
    if real_buildings and (admission["batches"][-1].get("id") != batch_id
            or batch.get("inventory", {}).get("inputPairSha256") != building_inputs_sha256
            or tree_digest != batch.get("inventory", {}).get("appTree")):
        raise ValueError("Real building review requires its exact current input/tree admission")
    if building_input_preview:
        required = {"localAccountApiRequests": 80, "localAccountMillisecondsIncludingShutdown": 120_000,
                    "localAccountWorkMilliseconds": 110_000, "localAccountInitialAttempts": 1, "localAccountMaximumAttempts": 2,
                    "catalogWrites": 0, "projectWrites": 0, "originalUploads": 0, "workerBatches": 0,
                    "nativeComputations": 0, "exactOriginalReadbacks": 6, "exactOriginalBytes": 20_000,
                    "automaticRetries": 0, "AWSAccountCalls": 0, "SecretsDataApiKmsCalls": 0,
                    "GitHubAccountApiCalls": 0, "Actions": 0, "providerRequests": 0, "applicationBuilds": 1,
                    "newDependencies": 0, "newInfrastructure": 0, "newAnalysisRuntimes": 0}
        if (not admission["batches"] or admission["batches"][-1].get("id") != batch_id
                or any(limits.get(key) != value for key, value in required.items())):
            raise ValueError("Retained building input preview requires its exact current finite batch admission")
        if tree_digest != batch.get("inventory", {}).get("appTree"):
            raise ValueError("Retained building input preview requires the exact admitted cached Studio tree")
    elif stac_items:
        required = {"localAccountApiRequests": 140, "localAccountMillisecondsIncludingShutdown": 120_000,
                    "localAccountInitialAttempts": 1, "localAccountMaximumAttempts": 3,
                    "newCatalogReferences": 1, "newProjectCompositions": 1, "ingestionJobs": 0,
                    "workerBatches": 0, "nativeComputations": 0, "sourceCopies": 0, "sourceExports": 0,
                    "automaticRetries": 0, "AWSAccountCalls": 0, "SecretsDataApiKmsCalls": 0,
                    "GitHubCalls": 0, "Actions": 0, "newDependencies": 0, "newInfrastructure": 0,
                    "newAnalysisRuntimes": 0, "localAccountRetainedRasterRanges": 6,
                    "localAccountRetainedRasterBytes": 1_769_472, "localAccountMetadataFixtureReplays": 2}
        if any(limits.get(key) != value for key, value in required.items()):
            raise ValueError("STAC Items requires its exact finite batch admission")
    elif raster_validation:
        required = {"localAccountApiRequestAttempts": 260, "localAccountCumulativeMillisecondsIncludingShutdown": 180_000,
                    "localAccountServiceAttempts": 2, "initialLocalAccountAttempts": 1, "derivedOriginalUploads": 1,
                    "ingestionJobs": 1, "workerBatches": 1, "nativeComputations": 0, "originalArchiveReadbacks": 1,
                    "sourceExports": 0, "automaticRetries": 0, "newSourceTransfers": 0, "AWSAccountCalls": 0,
                    "SecretsDataApiKmsCalls": 0, "GitHubCalls": 0, "Actions": 0, "providerDataCalls": 0,
                    "newDependencies": 0, "newInfrastructure": 0, "newAnalysisRuntimes": 0,
                    "localRetainedCogRangeRequests": 4, "localRetainedCogRangeBytes": 3240,
                    "localOriginalArchiveReadbackBytes": 1_048_576, "localOutputDisplayTickets": 2,
                    "localOutputDisplayOriginalReads": 2, "localOutputDisplayBytes": 2_097_152}
        if any(limits.get(key) != value for key, value in required.items()):
            raise ValueError("Raster validation requires its exact finite batch admission")
    elif raster_catalog:
        required = {"localAccountApiRequestAttempts": 240, "localAccountCumulativeMillisecondsIncludingShutdown": 180_000,
                    "localAccountServiceAttempts": 2, "initialLocalAccountAttempts": 1, "derivedOriginalUploads": 2,
                    "ingestionJobs": 2, "workerBatches": 1, "nativeComputations": 0, "originalArchiveReadbacks": 2,
                    "sourceExports": 0, "automaticRetries": 0, "newSourceTransfers": 0, "AWSAccountCalls": 0,
                    "SecretsDataApiKmsCalls": 0, "GitHubCalls": 0, "Actions": 0, "providerCalls": 0,
                    "metadataWebCalls": 0, "newDependencies": 0, "newInfrastructure": 0, "newAnalysisRuntimes": 0}
        required.update(localRetainedCogRangeRequests=8, localRetainedCogRangeBytes=6480,
                        localOriginalArchiveReadbackBytes=4_400_000, localOutputDisplayTickets=4,
                        localOutputDisplayOriginalReads=4, localOutputDisplayBytes=305_244)
        if any(limits.get(key) != value for key, value in required.items()):
            raise ValueError("Raster Catalog requires its exact finite batch admission")
    elif (limits.get("apiRequestAttempts") != api_limit
            or limits.get("cumulativeServiceMillisecondsIncludingShutdown") != 180_000
            or limits.get("originalUploads") != upload_limit or limits.get("ingestionJobs") != upload_limit
            or any(limits.get(key) != 0 for key in ("AWSAccountCalls", "GitHubCalls", "providerCalls", "newBuilds"))):
        raise ValueError("Building review requires its finite batch admission")
    if receptor_screening and any(limits.get(key) != value for key, value in {
            "shutdownReserveMilliseconds": 10_000, "serviceAttempts": 2, "initialServiceAttempts": 1,
            "workerBatches": 2, "nativeClips": 2, "nativeCollections": 3,
            "originalArchiveReadbacks": 1, "syntheticProjects": 1, "syntheticMaps": 1,
            "SecretsDataApiKmsCalls": 0, "Actions": 0, "metadataWebCalls": 0,
            "downloads": 0, "installs": 0, "newDependencies": 0, "newInfrastructure": 0}.items()):
        raise ValueError("Receptor screening requires its exact finite batch admission")
    progress_path, profile_path = work / f"{prefix}-progress.json", work / f"{prefix}-profile.json"
    for path in (progress_path, profile_path):
        if path.is_symlink():
            raise ValueError("Building review records must not be symlinks")
    progress = json.loads(progress_path.read_bytes()) if progress_path.exists() else {}
    if real_buildings and progress.get("inputPairSha256", building_inputs_sha256) != building_inputs_sha256:
        raise ValueError("Never replace real building inputs after a committed attempt")
    helper_sha = pilot.digest((ROOT / "app/scripts/integrated-studio-analysis.mjs").read_bytes())
    attempts = progress.get("serviceAttempts", 0)
    building_seed = None
    if building_input_preview:
        accepted_path = work / "building-review-progress.json"
        if accepted_path.is_symlink() or not accepted_path.is_file() or accepted_path.stat().st_uid != os.getuid():
            raise ValueError("Retained building input preview requires the owned accepted building receipt")
        accepted_bytes = accepted_path.read_bytes()
        accepted = json.loads(accepted_bytes)
        pins = {"source": ("2b53931f-1c74-4190-9174-56b502b65a3b", "0db0f821-65a0-4846-9204-6cffd0f0bead"),
                "comparison": ("466da7fc-36ce-4b9c-8909-c1292c2deaf3", "d5f6c478-7a4e-4c3a-86c3-554e29ede4ac"),
                "output": ("fd40ec51-601c-4180-b235-070fb2be186f", "4b711032-952d-411f-9cf1-ddf4ca6d3a1f")}
        records, saved_map = accepted.get("records", {}), accepted.get("map", {})
        if (accepted.get("status") != "pass" or not all(accepted.get(key) for key in (
                "mapSaved", "mapReopened", "exactFeaturesReopened", "archiveVerified"))
                or accepted.get("projectId") != "1938b127-af37-4c1e-8a90-c1d12282a172"
                or accepted.get("mapId") != "e4df81ea-9cac-4809-ad80-87a391ce9dd5"
                or saved_map.get("id") != accepted["mapId"] or saved_map.get("project_id") != accepted["projectId"]
                or saved_map.get("version") != 3 or set(records) != set(pins)):
            raise ValueError("Retained building input preview requires the exact accepted map v3 and three records")
        for key, (dataset_id, version_id) in pins.items():
            record = records[key]
            if (record.get("datasetId") != dataset_id or record.get("datasetVersionId") != version_id
                    or record.get("versionNumber") != 1 or not record.get("uploadCompleted")):
                raise ValueError("An accepted building input identity or committed version changed")
        map_pins = {(layer.get("datasetId"), layer.get("datasetVersionId")) for layer in saved_map.get("definition", {}).get("layers", [])}
        if map_pins != set(pins.values()):
            raise ValueError("The accepted building map no longer retains its exact three Layer pins")
        building_seed = {key: accepted[key] for key in ("projectId", "mapId", "map", "records")}
        building_seed["acceptedBuildingReceiptSha256"] = pilot.digest(accepted_bytes)
        if any((key in progress and progress[key] != value) or (attempts and key not in progress)
               for key, value in building_seed.items()):
            raise ValueError("The retained building preview seed changed; never reset committed preview progress")
        if any(progress.get(key, 0) for key in ("catalogWrites", "projectWrites", "originalUploads", "workerBatches", "nativeComputations")):
            raise ValueError("Retained building input preview cannot resume committed writes or jobs")
        if any(not isinstance(progress.get(key, 0), int) or progress.get(key, 0) < 0 or progress.get(key, 0) >= maximum
               for key, maximum in (("exactOriginalReadbacks", 6), ("exactOriginalReadbackBytes", 20_000))):
            raise ValueError("Retained building input preview readback budget is exhausted")
    stac_read_only = bool(stac_items and attempts == 2
        and batch.get("changedMethod", {}).get("readOnlyProjectRemainder")
        and progress.get("sourceVerified") and progress.get("catalogRaster")
        and progress.get("record", {}).get("datasetId") == "10ff7941-cdcc-4521-8445-c1fd8048ee5e"
        and progress.get("mapId") == "7d5b4d46-1fbd-491b-b90e-edd9d051d7d1"
        and progress.get("retainedRasterRanges") == 2 and not progress.get("initialProjectRaster"))
    maximum_attempts = 3 if stac_read_only else 2
    if progress.get("status") == "pass":
        raise ValueError(f"{label} already passed; reuse its retained receipts")
    if attempts >= maximum_attempts or progress.get("activeMilliseconds", 0) >= work_limit or progress.get("apiRequestAttempts", 0) >= api_limit:
        raise ValueError(f"{label} cumulative budget is exhausted")
    if attempts and (attempts != (2 if stac_read_only else 1) or continuation_sha256 != helper_sha
                     or continuation_sha256 == progress.get("helperSha256")):
        raise ValueError(f"A {prefix} retry requires the reviewed changed helper after diagnosis")
    if continuation_sha256 and not attempts:
        raise ValueError("A building continuation must reuse its failed checkpoint")
    if not attempts and any((work / name).exists() and json.loads((work / name).read_text()) != []
                            for name in ("queue.json", "pmtiles-v2.json")):
        raise ValueError("Reconcile unrelated queued work before the building journey")
    if real_buildings or receptor_screening or raster_catalog or raster_validation or stac_items or building_input_preview:
        for name in ("queue.json", "pmtiles-v2.json"):
            path = work / name
            if path.is_symlink():
                raise ValueError("Screening queue must not be a symlink")
            messages = json.loads(path.read_text()) if path.exists() else []
            if not isinstance(messages, list) or len(messages) > upload_limit or (name == "pmtiles-v2.json" and messages):
                raise ValueError("Reconcile unrelated queued work before screening continuation")
            admitted = progress.get("records", {})
            seen = set()
            for message in messages:
                if not isinstance(message, dict) or not isinstance(message.get("body"), str):
                    raise ValueError("Screening continuation queue contains an invalid job")
                entries = json.loads(message["body"]).get("Records", [])
                if not isinstance(entries, list) or any(not isinstance(entry, dict) for entry in entries):
                    raise ValueError("Screening continuation queue contains an invalid job")
                object_key = entries[0].get("s3", {}).get("object", {}).get("key", "") if len(entries) == 1 else ""
                keys = (("source", "comparison", "output") if real_buildings else ("validation",) if raster_validation else ("comparison", "patches") if raster_catalog
                        else ("receptors", "footprint", "influence", "output"))
                key = next((key for key in keys
                            if admitted.get(key, {}).get("datasetId")
                            and f"/datasets/{admitted[key]['datasetId']}/" in object_key), None)
                if key is None or key in seen:
                    raise ValueError("Screening continuation queue contains unrelated or duplicate jobs")
                seen.add(key)
    retained_names = ("baseline-profile.json", "baseline-progress.json", "baseline-browser-result.json",
                      "baseline-requests.json", "publication-profile.json", "publication-progress.json",
                      "browser-result.json", "requests.json", "development-smoke.json")
    if real_buildings or receptor_screening or raster_catalog or raster_validation or stac_items or building_input_preview:
        patterns = ("baseline-*.json", "publication-*.json", "building-review-*")
        if real_buildings or raster_catalog or raster_validation or stac_items or building_input_preview:
            patterns += ("receptor-screening-*",)
        if real_buildings or raster_validation or stac_items or building_input_preview:
            patterns += ("raster-catalog-*",)
        if real_buildings or stac_items or building_input_preview:
            patterns += ("raster-validation-*",)
        if real_buildings or building_input_preview:
            patterns += ("stac-items-*",)
        if building_input_preview:
            retained_names += ("worker-command.json",)
        retained_names += tuple(sorted({path.name for pattern in patterns
                                        for path in work.glob(pattern) if path.is_file()}))
    retained = progress.get("preservedReceipts")
    if retained is None:
        retained = {name: pilot.digest((work / name).read_bytes()) for name in retained_names if (work / name).exists()}
    for name, expected in retained.items():
        if (work / name).is_symlink() or pilot.digest((work / name).read_bytes()) != expected:
            raise ValueError(f"Building review changed an unrelated receipt: {name}")
    source = None
    if raster_catalog or raster_validation or stac_items:
        source = retained_raster_catalog_source(work)
        if progress.get("source") is not None and progress["source"] != source:
            raise ValueError("The retained raster source changed across continuation")
    fixture = retained_stac_items_fixture() if stac_items else None
    if stac_items:
        if progress.get("fixture") is not None and progress["fixture"] != fixture:
            raise ValueError("The retained STAC Item or raster evidence changed across continuation")
        if any(progress.get(key, 0) >= maximum for key, maximum in (
                ("retainedRasterRanges", 6), ("retainedRasterBytes", 1_769_472), ("metadataFixtureReplays", 2))):
            raise ValueError("The cumulative retained STAC transport budget is exhausted")
    manifest_path = work / "studio-build-manifest.json"
    prior_tree = json.loads(manifest_path.read_bytes())["artifactTree"]["digest"]
    if prior_tree != tree_digest:
        staged = work / "built-studio"
        retained_tree = work / f"{prefix}-prior-studio-{prior_tree}"
        if staged.is_symlink() or retained_tree.exists():
            raise ValueError("Preserve and inspect the prior Studio before restaging")
        shutil.copyfile(manifest_path, work / f"{prefix}-prior-studio-manifest.json")
        staged.rename(retained_tree)
        stage_built_studio(work, tree_digest)
    elif not (work / "built-studio/app/dist").is_dir():
        raise ValueError("The retained sealed Studio is missing")
    profile = {"schemaVersion": f"opengeo.integrated-{prefix}.1", "maximumApiRequests": api_limit,
               "maximumMilliseconds": total_limit, "priorMilliseconds": progress.get("activeMilliseconds", 0),
               "startedAtMilliseconds": round(time.time() * 1000), "admittedAttempt": attempts + 1,
               "appTree": tree_digest}
    if real_buildings:
        accepted = work / "building-review-progress.json"
        if accepted.is_symlink() or not accepted.is_file() or json.loads(accepted.read_bytes()).get("status") != "pass":
            raise ValueError("Real building review preserves the accepted synthetic receipt")
        profile.update(admissionBatchId=batch_id, inputPairSha256=building_inputs_sha256, inputProfile=input_profile,
                       acceptedSyntheticReceiptSha256=pilot.digest(accepted.read_bytes()), maximumWorkMilliseconds=170_000,
                       maximumOriginalUploads=3, maximumWorkerBatches=2, maximumNativeComparisons=1)
        progress["inputPairSha256"] = building_inputs_sha256
    if building_input_preview:
        profile.update(admissionBatchId=batch_id, maximumWorkMilliseconds=work_limit,
                       shutdownReserveMilliseconds=10_000, maximumOriginalUploads=0, maximumWorkerBatches=0,
                       maximumNativeComputations=0, maximumOriginalReadbacks=6, maximumOriginalReadbackBytes=20_000,
                       **building_seed)
        if not attempts:
            progress.update(building_seed)
        for key in ("apiRequestAttempts", "exactOriginalReadbacks", "exactOriginalReadbackBytes"):
            progress.setdefault(key, 0)
    if receptor_screening:
        profile.update(admissionBatchId=batch_id, maximumWorkMilliseconds=170_000,
                       maximumOriginalUploads=4, maximumWorkerBatches=2, maximumNativeClips=2,
                       maximumNativeCollections=3, maximumOriginalArchiveReadbacks=1)
    if raster_catalog or raster_validation:
        profile.update(admissionBatchId=batch_id, maximumWorkMilliseconds=170_000,
                       shutdownReserveMilliseconds=10_000, maximumOriginalUploads=upload_limit, maximumWorkerBatches=1,
                       maximumNativeComputations=0, maximumOriginalArchiveReadbacks=1 if raster_validation else 2,
                       maximumCogRangeRequests=4 if raster_validation else 8, maximumCogRangeBytes=3240 if raster_validation else 6480,
                       maximumArchiveReadbackBytes=1_048_576 if raster_validation else 4_400_000,
                       maximumOutputDisplayTickets=2 if raster_validation else 4,
                       maximumOutputDisplayOriginalReads=2 if raster_validation else 4,
                       maximumOutputDisplayBytes=2_097_152 if raster_validation else 305_244, source=source)
        if raster_validation:
            profile["maximumIngestionJobs"] = 1
        progress["source"] = source
    if stac_items:
        profile.update(admissionBatchId=batch_id, maximumWorkMilliseconds=work_limit,
                       shutdownReserveMilliseconds=10_000, maximumCatalogReferences=1,
                       maximumProjectCompositions=1, maximumIngestionJobs=0, maximumWorkerBatches=0,
                       maximumNativeComputations=0, maximumOriginalUploads=0, maximumOriginalArchiveReadbacks=0,
                       maximumRetainedRasterRanges=6, maximumRetainedRasterBytes=1_769_472,
                       maximumMetadataFixtureReplays=2, source=source, fixture=fixture,
                       readOnlyProjectRemainder=stac_read_only)
        if any(progress.get(key, source["projectId"]) != source["projectId"] for key in ("projectId", "sourceAccessProjectId")):
            raise ValueError("The STAC access workspace changed across continuation")
        progress.update(projectId=source["projectId"], sourceAccessProjectId=source["projectId"],
                        source=source, fixture=fixture)
        for key, value in {"records": {}, "attemptedWrites": {}, "apiRequestAttempts": 0,
                           "retainedRasterRanges": 0, "retainedRasterBytes": 0, "metadataFixtureReplays": 0,
                           "newCatalogReferences": 0, "newProjectCompositions": 0, "workerBatches": 0,
                           "ingestionJobs": 0, "nativeComputations": 0}.items():
            progress.setdefault(key, value)
    progress.update(serviceAttempts=attempts + 1, helperSha256=helper_sha,
                    preservedReceipts=retained, status="running", servicesStopped=False)
    profile_path.write_text(json.dumps(profile, indent=2) + "\n")
    progress_path.write_text(json.dumps(progress, indent=2) + "\n")
    profile_path.chmod(0o600)
    progress_path.chmod(0o600)
    return progress


def stage_receptor_screening(work, tree_digest, continuation_sha256=None):
    return stage_building_review(work, tree_digest, continuation_sha256, receptor_screening=True)


def retained_raster_catalog_source(work):
    """Pin the existing managed original; this performs no input acquisition."""
    for name in ("baseline-progress.json", "landcover.tif"):
        path = work / name
        if path.is_symlink() or not path.is_file() or path.stat().st_uid != os.getuid():
            raise ValueError("Raster Catalog requires its owned retained native source")
    baseline = json.loads((work / "baseline-progress.json").read_bytes())
    record, composition = baseline.get("records", {}).get("landcover", {}), baseline.get("map", {})
    expected = {"datasetId": "bbe00c6e-3dd2-4a85-a8a5-7f67abfc7cbb",
                "datasetVersionId": "0f996c11-e6db-4bce-9792-d2cd9659da28",
                "dataObjectId": "afb9bce8-88c2-4c78-a7c1-854f90238c82", "versionNumber": 1,
                "sizeBytes": 810, "checksumSha256": "aba504f019cba40c9ee2846d13b4658986164996732364626a0a916306e8e6a6"}
    if (any(record.get(key) != value for key, value in expected.items()) or not record.get("uploadCompleted")
            or not baseline.get("mapSaved") or not baseline.get("mapReopened") or baseline.get("status") != "pass"
            or composition.get("id") != "a807dce2-b7d3-4566-937b-ff092d89fbcc" or composition.get("version") != 3
            or composition.get("project_id") != baseline.get("projectId") or composition.get("id") != baseline.get("mapId")):
        raise ValueError("Raster Catalog requires the exact accepted source and baseline composition")
    layers = [layer for layer in composition["definition"]["layers"] if layer.get("datasetId") == expected["datasetId"]]
    if (len(layers) != 1 or layers[0].get("datasetVersionId") != expected["datasetVersionId"]
            or layers[0].get("objectId") != expected["dataObjectId"] or layers[0].get("sourceVersion") != 1
            or layers[0].get("sourceType") != "governed-dataset" or layers[0].get("geometryType") != "Raster"):
        raise ValueError("Raster Catalog source Layer pins are incomplete")
    native = (work / "landcover.tif").read_bytes()
    if len(native) != expected["sizeBytes"] or pilot.digest(native) != expected["checksumSha256"]:
        raise ValueError("Raster Catalog retained original bytes changed")
    return {**expected, "projectId": composition["project_id"], "mapId": composition["id"],
            "map": composition, "layer": layers[0]}


def stage_raster_catalog(work, tree_digest, continuation_sha256=None):
    return stage_building_review(work, tree_digest, continuation_sha256, raster_catalog=True)


def stage_raster_validation(work, tree_digest, continuation_sha256=None):
    return stage_building_review(work, tree_digest, continuation_sha256, raster_validation=True)


def retained_stac_items_fixture():
    """Reuse exact public observations without copying inputs or reading a provider."""
    directory = ROOT / ".local-archives/baseline-intelligence-20261023"
    files = {
        "stac-provider-search.json": "ec729260858e725a7cbf4192af5dbffac22cee738047ccb795c63d6b3102e937",
        "stac-provider-metadata-receipt.json": "a036603f832224ae4f6a28aa4735850113a053c2a9719aa821d80df916f92224",
        "stac-red-prefix.bin": "2a3322f18d7dc948248865a2a222ba67a4900bedfecfb9ab5d3a23e264197fde",
        "stac-red-prefix-receipt.json": "aa2e910d4a10f6ff8e8ca12ad634e014a71e7e8f3a19dc286d0553a2a4a5693c",
        "stac-red-overview.bin": "df9edb548d6e9aff5ab6a4c730f0cb00024e24f8885b038540b10670fa708676",
        "stac-red-overview-receipt.json": "ed21171eadba1f15d3545bd264d9fa5aabad72adcfe7d2770d5e1846df055bf6",
        "stac-red-block-tail.bin": "55466ce486d88a1f78dbe8b7005b3bb7967552a640a87fc277a267e7f6f55217",
        "stac-red-block-tail-receipt.json": "f72a270cdb9afeba6fd4d0af68031fe36c7f5e16efab99743a3ac3b9fb41710f",
    }
    for filename, expected in files.items():
        path = directory / filename
        if path.is_symlink() or not path.is_file() or path.stat().st_uid != os.getuid() or pilot.digest(path.read_bytes()) != expected:
            raise ValueError(f"The retained STAC observation changed: {filename}")
    return {"directory": str(directory), "files": files, "selectedAsset": "red", "knownSizeBytes": 178_976_119,
            "itemId": "S2B_45RUL_20211029_1_L2A", "query": {
                "endpoint": "https://earth-search.aws.element84.com/v1/search", "collections": ["sentinel-2-l2a"],
                "bbox": [85.533, 27.6119167, 85.5340833, 27.613], "start": "2021-10-01T00:00:00Z",
                "end": "2021-10-31T23:59:59.999Z", "limit": 1}}


def stage_stac_items(work, tree_digest, continuation_sha256=None):
    return stage_building_review(work, tree_digest, continuation_sha256, stac_items=True)


def development(args):
    """Retain local data; use the same built Studio, isolated API and worker seams."""
    sys.path.insert(0, str(ROOT / "database/scripts"))
    from build_baseline import IMAGE

    pilot.API_IMAGE = args.api_image or pilot.API_IMAGE
    pilot.WORKER_IMAGE = args.worker_image or pilot.WORKER_IMAGE
    print_template_smoke = getattr(args, "print_template_smoke", False)
    print_smoke = getattr(args, "print_smoke", False) or print_template_smoke
    receptor_smoke = getattr(args, "receptor_screening_smoke", False)
    raster_smoke = getattr(args, "raster_catalog_smoke", False)
    raster_validation_smoke = getattr(args, "raster_validation_smoke", False)
    stac_items_smoke = getattr(args, "stac_items_smoke", False)
    building_input_preview = getattr(args, "building_input_preview_smoke", False)
    real_building_inputs = getattr(args, "building_review_inputs", None)
    verify_cached_images(IMAGE)
    work = development_directory(args.state_directory)
    if (work / "development.lock").is_symlink():
        raise ValueError("Development lock must not be a symlink")
    with (work / "development.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("This development state is already open") from error
        if (args.baseline_study or stac_items_smoke or building_input_preview or real_building_inputs) and not (work / "development-state.json").is_file():
            raise ValueError("The scoped journey must reuse the selected persistent development database")
        work, metadata = development_state(work, IMAGE, pending_archive_tiff_upgrade=bool(
            args.baseline_study and args.baseline_study_continuation_sha256))
        baseline_progress = stage_baseline_study(work, args.baseline_study, args.reuse_studio_tree,
                                               args.baseline_study_continuation_sha256, args.publication_compiler_digest)
        building_prefix = ("building-real-review" if real_building_inputs else "building-input-preview" if building_input_preview else "stac-items" if stac_items_smoke else "raster-validation" if raster_validation_smoke else "raster-catalog" if raster_smoke
                           else "receptor-screening" if receptor_smoke else "building-review")
        building_progress = (stage_building_review(work, args.reuse_studio_tree,
                                 getattr(args, "building_input_preview_continuation_sha256", None), building_input_preview=True)
                             if building_input_preview else
                             stage_stac_items(work, args.reuse_studio_tree, getattr(args, "stac_items_continuation_sha256", None))
                             if stac_items_smoke else
                             stage_raster_validation(work, args.reuse_studio_tree, getattr(args, "raster_validation_continuation_sha256", None))
                             if raster_validation_smoke else
                             stage_raster_catalog(work, args.reuse_studio_tree, getattr(args, "raster_catalog_continuation_sha256", None))
                             if raster_smoke else
                             stage_receptor_screening(work, args.reuse_studio_tree, getattr(args, "receptor_screening_continuation_sha256", None))
                             if receptor_smoke else
                             stage_building_review(work, args.reuse_studio_tree, args.building_review_continuation_sha256,
                                 building_inputs=real_building_inputs,
                                 building_inputs_sha256=getattr(args, "building_review_inputs_sha256", None))
                             if args.building_review_smoke else None)
        building_started = time.monotonic()
        building_prior_ms = building_progress.get("activeMilliseconds", 0) if building_progress is not None else 0
        building_work_limit, building_total_limit = (110_000, 120_000) if stac_items_smoke or building_input_preview else (170_000, 180_000)
        baseline_started = time.monotonic()
        baseline_prior_ms = baseline_progress.get("activeMilliseconds", 0) if baseline_progress else 0
        baseline_ceiling_ms = baseline_progress.get("cumulativeMillisecondsCeiling", 180_000) if baseline_progress else 180_000
        if print_smoke:
            # Reuse the completed synthetic journey without changing its optional
            # profiles, identities or source data. No fixture may be created here.
            for filename in ("development-smoke.json", "identities-seeded", "studio-build-manifest.json"):
                path = work / filename
                if path.is_symlink() or not path.is_file() or path.stat().st_uid != os.getuid():
                    raise ValueError("Print acceptance requires the owned retained development journey")
            seed = json.loads((work / "development-smoke.json").read_text())
            if not seed.get("styledSaved") or not seed.get("reopened"):
                raise ValueError("Print acceptance requires the completed saved-map journey")
            for identity in (seed.get("project"), seed.get("map", {}).get("id"),
                             seed.get("datasetId"), seed.get("datasetVersionId")):
                if not isinstance(identity, str) or not re.fullmatch(r"[0-9a-f-]{36}", identity):
                    raise ValueError("Print acceptance requires retained canonical identities")
            staged_manifest = json.loads((work / "studio-build-manifest.json").read_text())
            if not print_template_smoke and args.reuse_studio_tree != staged_manifest.get("artifactTree", {}).get("digest"):
                raise ValueError("Print acceptance requires the exact retained Studio tree")
            if print_template_smoke:
                prior_print = work / "print-smoke.json"
                if prior_print.is_symlink() or not prior_print.is_file() or prior_print.stat().st_uid != os.getuid():
                    raise ValueError("Template acceptance requires the owned accepted Print checkpoint")
                accepted_print = json.loads(prior_print.read_text())
                if (not accepted_print.get("outputVerified") or accepted_print.get("savedMap") != seed.get("map")
                        or seed["map"].get("version") != 3
                        or len(seed["map"].get("definition", {}).get("extensions", {})
                               .get("opengeoPrintLayouts", {}).get("layouts", [])) != 1):
                    raise ValueError("Template acceptance requires the exact accepted revision-3 Print head")
                template_staging = stage_print_template_studio(work, args.reuse_studio_tree, staged_manifest)
        elif building_progress is None:
            stage_analysis_profile(work, args.analysis_profile)
            stage_publication_profile(work, args.publication_compiler_digest,
                                      args.publication_preview_port)
            stage_postgis_fixture(work, args.postgis_fixture)
        name = metadata["database"]
        server_name, worker_name = f"{name}-api", f"{name}-worker"
        process = None
        print_started, print_prior_seconds = time.monotonic(), 0
        baseline_alarm = None
        building_alarm = None
        if baseline_progress:
            def baseline_timeout(_signal, _frame):
                raise TimeoutError(f"Baseline cumulative services/browser budget reached {baseline_ceiling_ms} milliseconds")
            baseline_alarm = signal.signal(signal.SIGALRM, baseline_timeout)
            signal.setitimer(signal.ITIMER_REAL, (baseline_ceiling_ms - baseline_prior_ms) / 1000)
        if building_progress is not None:
            def building_timeout(_signal, _frame):
                raise TimeoutError("Building review work ceiling reached; ten seconds reserved for shutdown")
            building_alarm = signal.signal(signal.SIGALRM, building_timeout)
            signal.setitimer(signal.ITIMER_REAL, (building_work_limit - building_prior_ms) / 1000)
        if print_smoke or building_progress is not None:
            for disposable in (server_name, worker_name):
                check = subprocess.run(["podman", "container", "exists", disposable], check=False)
                if check.returncode != 1:
                    raise ValueError("Print acceptance requires its temporary API and worker names to be unused")
            inspected = subprocess.run(["podman", "inspect", "--format", "{{.State.Status}}", name],
                                       capture_output=True, check=True, text=True)
            if inspected.stdout.strip() != "exited":
                raise ValueError("Print acceptance requires the retained database to be stopped")
            subprocess.run(["podman", "volume", "exists", f"{name}-data"], check=True)
        if print_smoke:
            print_runner_path = work / ("print-template-runner-progress.json" if print_template_smoke else "print-runner-progress.json")
            if print_runner_path.is_symlink():
                raise ValueError("Print runner checkpoint must not be a symlink")
            print_runner = json.loads(print_runner_path.read_text()) if print_runner_path.exists() else {}
            print_prior_seconds = print_runner.get("activeSeconds", 0)
            if print_template_smoke and not print_runner.get("attempts", 0):
                # One-time artifact copying belongs to this increment's same
                # cumulative 180-second ceiling, before any service attempt.
                print_prior_seconds += template_staging.get("elapsedSeconds", 0)
            helper_sha = pilot.digest((ROOT / "app/scripts/integrated-studio-print.mjs").read_bytes())
            continuation_pin = getattr(args, "print_template_smoke_continuation_sha256" if print_template_smoke
                                       else "print_smoke_continuation_sha256", None)
            if print_template_smoke:
                if continuation_pin and (print_runner.get("attempts", 0) != 1 or continuation_pin != helper_sha
                        or print_runner.get("helperSha256") == helper_sha):
                    raise ValueError("Template continuation requires one diagnosed attempt and the exact changed helper")
                maximum_attempts = 2 if continuation_pin else 1
                historical = {}
                for filename in ("print-smoke.json", "print-runner-progress.json", "print-requests.json"):
                    receipt = work / filename
                    if receipt.is_symlink() or not receipt.is_file() or receipt.stat().st_uid != os.getuid():
                        raise ValueError("Template acceptance requires owned historical Print receipts")
                    historical[filename] = pilot.digest(receipt.read_bytes())
                historical_runner = json.loads((work / "print-runner-progress.json").read_text())
                carried = {"coreApiRequestAttempts": seed.get("apiRequestAttempts"),
                           "coreActiveMilliseconds": seed.get("activeMilliseconds"),
                           "printApiRequestAttempts": accepted_print.get("apiRequestAttempts"),
                           "printActiveMilliseconds": accepted_print.get("activeMilliseconds"),
                           "printServiceAttempts": historical_runner.get("attempts"),
                           "printServiceSeconds": historical_runner.get("activeSeconds"),
                           "studioBuildStaging": template_staging,
                           "historicalReceiptSha256": historical}
                if print_runner.get("priorAcceptance") not in (None, carried):
                    raise ValueError("Historical Print acceptance changed during the template increment")
                print_runner.update(mode="print-template", priorAcceptance=carried, helperSha256=helper_sha)
            else:
                if continuation_pin and (print_runner.get("attempts", 0) != 2 or continuation_pin != helper_sha):
                    raise ValueError("Print continuation requires the reviewed changed helper after exactly two retained attempts")
                maximum_attempts = 3 if continuation_pin else 2
            if print_runner.get("attempts", 0) >= maximum_attempts or print_prior_seconds >= 180:
                raise ValueError("Print acceptance cumulative runner budget is exhausted")
            if continuation_pin:
                print_runner["changedMethodHelperSha256"] = continuation_pin
            print_runner.update(attempts=print_runner.get("attempts", 0) + 1,
                                activeSeconds=print_prior_seconds, status="running")
            print_runner_path.write_text(json.dumps(print_runner, indent=2) + "\n")
            print_runner_path.chmod(0o600)
        try:
            # A retained development container owns a named volume. Neither is a
            # disposable acceptance resource, and cleanup never removes the volume.
            exists = subprocess.run(["podman", "container", "exists", name], check=False)
            if print_smoke or building_progress is not None:
                if exists.returncode != 0:
                    raise ValueError("Scoped acceptance cannot initialize a new database")
            if exists.returncode == 1:
                if baseline_progress:
                    subprocess.run(["podman", "volume", "exists", f"{name}-data"], check=True)
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
            deadline = time.monotonic() + (min(120, 180 - print_prior_seconds) if print_smoke else 120)
            while True:
                ready = subprocess.run(["podman", "exec", name, "pg_isready", "--username",
                                        "postgres", "--dbname", "opengeo"], capture_output=True)
                logs = subprocess.run(["podman", "logs", name], capture_output=True, check=True)
                if ready.returncode == 0 and b"PostgreSQL init process complete" in logs.stdout + logs.stderr:
                    break
                if time.monotonic() >= deadline:
                    raise TimeoutError("Development database did not become ready; retained data was not removed")
                time.sleep(0.2)
            if baseline_progress and baseline_progress.get("previewReadback"):
                # Only output readback remains: the accepted migration and
                # compiler transition must not run again.
                pass
            elif baseline_progress and baseline_progress.get("compilerReportCorrection"):
                migration = ROOT / "database/migrations/0177_observable_archive_tiff_preview_output.sql"
                if pilot.digest(migration.read_bytes()) != baseline_progress["compilerReportCorrection"]["migrationSha256"]:
                    raise ValueError("The admitted local forward migration changed")
                acl_query = "SELECT json_build_object('owner',proowner,'acl',proacl,'securityDefiner',prosecdef,'config',proconfig) FROM pg_proc WHERE oid='app.complete_observable_build(uuid,uuid,jsonb)'::regprocedure"
                psql = ["podman", "exec", "--interactive", name, "psql", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "--username", "postgres", "--dbname", "opengeo"]
                before = subprocess.run(psql + ["-c", acl_query], capture_output=True, check=True, timeout=5).stdout
                subprocess.run(psql, input=migration.read_bytes(), capture_output=True, check=True, timeout=5)
                after = subprocess.run(psql + ["-c", acl_query], capture_output=True, check=True, timeout=5).stdout
                if before != after:
                    raise ValueError("The local completion upgrade changed owner/access/security configuration")
                marker = work / "development-state.json"
                if not (work / "baseline-prior-development-state.json").exists():
                    (work / "baseline-prior-development-state.json").write_bytes(marker.read_bytes())
                metadata["schemaSources"] = {str(p.relative_to(ROOT)): pilot.digest(p.read_bytes()) for p in database_initialization_sources()}
                marker.write_text(json.dumps(metadata, indent=2) + "\n")
                baseline_progress["compilerReportMigration"] = {"verified": True, "aclUnchanged": True,
                    "sha256": baseline_progress["compilerReportCorrection"]["migrationSha256"]}
                (work / "baseline-progress.json").write_text(json.dumps(baseline_progress, indent=2) + "\n")
            elif baseline_progress and baseline_progress.get("compilerRefresh"):
                transition = baseline_progress.setdefault("compilerRefreshTransition", {})
                transition["attempted"] = True
                progress_path = work / "baseline-progress.json"
                progress_path.write_text(json.dumps(baseline_progress, indent=2) + "\n")
                progress_path.chmod(0o600)
                command = container_command(name, work, server_name, pilot.API_IMAGE,
                                            "python", "scripts/run-integrated-studio-local.py")
                command[-1:] = ["-c", "import runpy; runpy.run_path('/repo/scripts/run-integrated-studio-local.py')['refresh_baseline_compiler_owner']()"]
                subprocess.run(command, capture_output=True, check=True,
                               timeout=max(1, min(15, (baseline_ceiling_ms - baseline_prior_ms) / 1000
                                                  - (time.monotonic() - baseline_started))))
                baseline_progress = json.loads(progress_path.read_bytes())
            # Reuse a verified staged tree across restarts. Source changes need a
            # deliberate rebuild through the same maintained builder.
            if not baseline_progress and building_progress is None and not args.publication_only and (args.rebuild_studio or not (work / "studio-build-manifest.json").exists()):
                staged = work / "built-studio"
                if staged.is_symlink():
                    raise ValueError("The staged build must not be a symlink")
                if staged.exists():
                    shutil.rmtree(staged)
                stage_built_studio(work, args.reuse_studio_tree)
            with (work / "api.log").open("ab") as log:
                process = subprocess.Popen(container_command(name, work, server_name,
                    pilot.API_IMAGE, "python", "scripts/run-integrated-studio-local.py", "--serve",
                    *(["--restored"] if (work / "identities-seeded").exists() else []), print_smoke=print_smoke),
                    stdout=log, stderr=subprocess.STDOUT)
                wait_api_socket(work, process)
                if not building_input_preview:
                    (work / "identities-seeded").touch(mode=0o600)
                if not stac_items_smoke and not building_input_preview:
                    worker = container_command(name, work, worker_name, pilot.WORKER_IMAGE,
                        "python3", "scripts/run-integrated-pilot-local.py", "--stage", "worker")
                    (work / "worker-command.json").write_text(json.dumps(worker))
                (work / "local-api-container.json").write_text(json.dumps(server_name))
                print(f"LOCAL DEVELOPMENT ONLY: synthetic sign-in; private state {work}", flush=True)
                print("Closing Chromium stops compute and retains the database, files and queue.", flush=True)
                subprocess.run(browser_command(work, built_studio=not args.publication_only,
                    development=True, publication_only=args.publication_only), cwd=ROOT, check=True,
                    **({"env": {**os.environ, "OPENGEO_COMMUNITY_DEVELOPMENT_SMOKE": "1",
                                "OPENGEO_COMMUNITY_PRINT_SMOKE": "1",
                                **({"OPENGEO_COMMUNITY_PRINT_TEMPLATE_SMOKE": "1"} if print_template_smoke else {})},
                        "timeout": max(1, min(150, 180 - print_prior_seconds - (time.monotonic() - print_started)))}
                       if print_smoke else {"env": {**os.environ, "OPENGEO_BASELINE_STUDY": "1"},
                         "timeout": max(1, (baseline_ceiling_ms - baseline_prior_ms) / 1000 - (time.monotonic() - baseline_started))}
                       if baseline_progress else {"env": {**os.environ, ("OPEN_GEO_INTEGRATED_BUILDING_REAL_REVIEW" if real_building_inputs else "OPEN_GEO_INTEGRATED_BUILDING_INPUT_PREVIEW" if building_input_preview
                           else "OPEN_GEO_INTEGRATED_STAC_ITEMS" if stac_items_smoke
                           else "OPEN_GEO_INTEGRATED_RASTER_VALIDATION" if raster_validation_smoke
                           else "OPEN_GEO_INTEGRATED_RASTER_CATALOG" if raster_smoke else "OPEN_GEO_INTEGRATED_RECEPTOR_SCREENING"
                           if receptor_smoke else "OPEN_GEO_INTEGRATED_BUILDING_REVIEW"): "1"},
                         "timeout": max(1, (building_work_limit - building_prior_ms) / 1000 - (time.monotonic() - building_started))}
                       if building_progress is not None else {"timeout": 180} if args.publication_only else {}))
        finally:
            if baseline_progress:
                signal.setitimer(signal.ITIMER_REAL, 0)
                signal.signal(signal.SIGALRM, baseline_alarm)
            if building_progress is not None:
                signal.setitimer(signal.ITIMER_REAL, 0)
                signal.signal(signal.SIGALRM, building_alarm)
            building_cleanup_error = None
            try:
                cleanup_development_api(server_name, worker_name, process,
                                        postgis_fixture=args.postgis_fixture,
                                        bounded=building_progress is not None)
            except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                if building_progress is None:
                    raise
                building_cleanup_error = str(error)
            finally:
                if building_progress is None:
                    subprocess.run(["podman", "stop", "--time=10", name], capture_output=True, check=False)
                else:
                    try:
                        subprocess.run(["podman", "stop", "--time=1", name],
                                       capture_output=True, check=False, timeout=3)
                    except (OSError, subprocess.SubprocessError) as error:
                        building_cleanup_error = str(error)
                (work / "api.sock").unlink(missing_ok=True)
                if building_progress is not None:
                    api_absent, worker_absent, database_status = False, False, "unverified"
                    try:
                        api_absent = subprocess.run(["podman", "container", "exists", server_name],
                                                    capture_output=True, check=False, timeout=1).returncode == 1
                        worker_absent = subprocess.run(["podman", "container", "exists", worker_name],
                                                       capture_output=True, check=False, timeout=1).returncode == 1
                        database_status = subprocess.run(["podman", "inspect", "--format", "{{.State.Status}}", name],
                                                         capture_output=True, check=False, text=True, timeout=1).stdout.strip()
                    except (OSError, subprocess.SubprocessError) as error:
                        building_cleanup_error = str(error)
                    services_stopped = api_absent and worker_absent and database_status == "exited" and not building_cleanup_error
                    path = work / f"{building_prefix}-progress.json"
                    current = json.loads(path.read_bytes())
                    current.update(activeMilliseconds=building_prior_ms + round((time.monotonic() - building_started) * 1000),
                                   servicesStopped=services_stopped, databaseRetained=True, objectsRetained=True,
                                   cleanup={"apiAbsent": api_absent, "workerAbsent": worker_absent,
                                            "databaseStatus": database_status, "error": building_cleanup_error},
                                   stoppedAt=datetime.now(UTC).isoformat())
                    if not services_stopped:
                        current.update(status="failed-stop", runnerError="Building compute shutdown was not verified")
                    elif current["activeMilliseconds"] > building_total_limit:
                        current.update(status="failed-stop", runnerError="Cumulative building service ceiling exceeded including shutdown")
                    elif current.get("status") == "running":
                        current.update(status="failed-stop", runnerError="Building journey stopped before browser acceptance")
                    path.write_text(json.dumps(current, indent=2) + "\n")
                    for filename, expected in current["preservedReceipts"].items():
                        if pilot.digest((work / filename).read_bytes()) != expected:
                            raise ValueError(f"Building increment changed historical receipt: {filename}")
                if baseline_progress:
                    current = json.loads((work / "baseline-progress.json").read_bytes())
                    current.update(activeMilliseconds=baseline_prior_ms + round((time.monotonic() - baseline_started) * 1000),
                                   servicesStopped=True, databaseRetained=True, objectsRetained=True,
                                   stoppedAt=datetime.now(UTC).isoformat())
                    if current["activeMilliseconds"] > baseline_ceiling_ms:
                        current.update(status="failed-stop", runnerError="Baseline cumulative service/browser ceiling exceeded including shutdown")
                    (work / "baseline-progress.json").write_text(json.dumps(current, indent=2) + "\n")
                if print_smoke:
                    print_runner.update(activeSeconds=print_prior_seconds + time.monotonic() - print_started,
                                        status="stopped-retained-data")
                    print_runner_path.write_text(json.dumps(print_runner, indent=2) + "\n")
                    if print_template_smoke:
                        for filename, expected in historical.items():
                            if pilot.digest((work / filename).read_bytes()) != expected:
                                raise ValueError(f"Template increment changed historical receipt: {filename}")


def publication_preview_origin(port):
    if not isinstance(port, int) or isinstance(port, bool) or not 0 <= port <= 65535:
        raise ValueError("Publication preview port must be between 0 and 65535")
    # Choose before API startup. The preview listener later binds this exact
    # port and must fail on a conflict rather than selecting another origin.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", port))
        return f"http://127.0.0.1:{listener.getsockname()[1]}"


def publication_signing_keys(work):
    private = Path(work) / "publication-preview-private.pem"
    public = Path(work) / "publication-preview-public.pem"
    for path in (private, public):
        if path.is_symlink() or (path.exists() and (
            not path.is_file() or path.stat().st_uid != os.getuid()
            or stat.S_IMODE(path.stat().st_mode) != 0o600
        )):
            raise ValueError("Publication signing keys must be owned regular files with mode 0600")
    if private.exists() != public.exists():
        raise ValueError("Publication signing key pair is incomplete; retained keys were not replaced")
    # Node is already required by the local runner. Generate only when absent;
    # key bytes stay in this process's files and never enter arguments/output.
    script = """
      const {generateKeyPairSync,createPrivateKey,createPublicKey} = require('node:crypto');
      const {existsSync,writeFileSync,readFileSync} = require('node:fs');
      const [privatePath,publicPath] = process.argv.slice(1);
      if (!existsSync(privatePath)) {
        const {privateKey,publicKey} = generateKeyPairSync('rsa',{modulusLength:2048,
          privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
        writeFileSync(privatePath,privateKey,{flag:'wx',mode:0o600});
        writeFileSync(publicPath,publicKey,{flag:'wx',mode:0o600});
      }
      const privateKey = createPrivateKey(readFileSync(privatePath));
      const publicKey = createPublicKey(readFileSync(publicPath));
      if (privateKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails.modulusLength < 2048 ||
          !createPublicKey(privateKey).export({type:'spki',format:'der'}).equals(publicKey.export({type:'spki',format:'der'})))
        throw new Error('Invalid local publication signing keys');
    """
    subprocess.run(["node", "--eval", script, str(private), str(public)],
                   capture_output=True, check=True, timeout=30)
    return private.name, public.name


def stage_publication_profile(work, compiler_digest, preview_port=0):
    target = Path(work) / "publication-profile.json"
    if target.is_symlink():
        raise ValueError("Publication profile must not be a symlink")
    if compiler_digest is None:
        target.unlink(missing_ok=True)
        return
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", compiler_digest):
        raise ValueError("Publication compiler must be an exact cached image digest")
    available = subprocess.run(["podman", "image", "exists", compiler_digest],
                               capture_output=True, check=False, timeout=15)
    if available.returncode != 0:
        raise ValueError("Publication compiler is absent from the local cache; no image is downloaded")
    preview_origin = publication_preview_origin(preview_port)
    public_origin = publication_preview_origin(0)
    if public_origin == preview_origin:
        raise ValueError("Publication and private preview need distinct local ports")
    private, public = publication_signing_keys(work)
    target.write_text(json.dumps({"compilerImageDigest": compiler_digest,
                                 "previewOrigin": preview_origin,
                                 "publicationOrigin": public_origin,
                                 "publicationCanonicalOrigin": "https://publication.local.invalid",
                                 "previewKeyPairId": "LOCALPREVIEW123",
                                 "previewPrivateKeyPath": private,
                                 "previewPublicKeyPath": public}) + "\n")
    target.chmod(0o600)


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
    parser.add_argument("--ftw-query", type=Path)
    parser.add_argument("--managed-cog-file", type=Path)
    parser.add_argument("--baseline-study", type=Path)
    parser.add_argument("--baseline-study-continuation-sha256")
    parser.add_argument("--building-review-smoke", action="store_true")
    parser.add_argument("--building-review-continuation-sha256")
    parser.add_argument("--building-review-inputs", type=Path)
    parser.add_argument("--building-review-inputs-sha256")
    parser.add_argument("--building-input-preview-smoke", action="store_true")
    parser.add_argument("--building-input-preview-continuation-sha256")
    parser.add_argument("--receptor-screening-smoke", action="store_true")
    parser.add_argument("--receptor-screening-continuation-sha256")
    parser.add_argument("--raster-catalog-smoke", action="store_true")
    parser.add_argument("--raster-catalog-continuation-sha256")
    parser.add_argument("--raster-validation-smoke", action="store_true")
    parser.add_argument("--raster-validation-continuation-sha256")
    parser.add_argument("--stac-items-smoke", action="store_true")
    parser.add_argument("--stac-items-continuation-sha256")
    parser.add_argument("--publication-only", action="store_true")
    parser.add_argument("--reuse-studio-tree")
    parser.add_argument("--restored", action="store_true")
    parser.add_argument("--font-runtime-package", type=Path)
    parser.add_argument("--font-runtime-manifest-sha256")
    parser.add_argument("--development", action="store_true")
    parser.add_argument("--state-directory", type=Path)
    parser.add_argument("--analysis-profile", type=Path)
    parser.add_argument("--postgis-fixture", action="store_true")
    parser.add_argument("--print-smoke", action="store_true")
    parser.add_argument("--print-smoke-continuation-sha256")
    parser.add_argument("--print-template-smoke", action="store_true")
    parser.add_argument("--print-template-smoke-continuation-sha256")
    parser.add_argument("--publication-compiler-digest")
    parser.add_argument("--publication-preview-port", type=int, default=0)
    parser.add_argument("--api-image")
    parser.add_argument("--worker-image")
    parser.add_argument("--pmtiles-worker-image")
    parser.add_argument("--rebuild-studio", action="store_true")
    args = parser.parse_args(argv)
    if args.building_input_preview_smoke and (not args.development or not args.state_directory or not args.reuse_studio_tree
            or any((args.stac_items_smoke, args.stac_items_continuation_sha256,
                    args.raster_validation_smoke, args.raster_validation_continuation_sha256,
                    args.raster_catalog_smoke, args.raster_catalog_continuation_sha256,
                    args.building_review_smoke, args.building_review_continuation_sha256,
                    args.receptor_screening_smoke, args.receptor_screening_continuation_sha256,
                    args.baseline_study, args.baseline_study_continuation_sha256, args.publication_only,
                    args.print_smoke, args.print_smoke_continuation_sha256,
                    args.print_template_smoke, args.print_template_smoke_continuation_sha256,
                    args.analysis_profile, args.postgis_fixture, args.ftw_query, args.managed_cog_file,
                    args.rebuild_studio, args.publication_compiler_digest, args.publication_preview_port,
                    args.serve, args.restore_checkpoint, args.service_clients, args.wcs_only, args.analysis_only,
                    args.pinned_map_fonts, args.upgrade_from_0082, args.restored, args.font_runtime_package,
                    args.font_runtime_manifest_sha256, args.api_image, args.worker_image, args.pmtiles_worker_image))):
        parser.error("Retained building input preview requires only persistent development and its exact retained Studio tree/runtime")
    if args.building_input_preview_continuation_sha256 and (not args.building_input_preview_smoke
            or not re.fullmatch(r"[a-f0-9]{64}", args.building_input_preview_continuation_sha256)):
        parser.error("Building input preview continuation requires the exact reviewed changed helper SHA-256")
    if args.stac_items_smoke and (not args.development or not args.state_directory or not args.reuse_studio_tree
            or any((args.raster_validation_smoke, args.raster_validation_continuation_sha256,
                    args.raster_catalog_smoke, args.raster_catalog_continuation_sha256,
                    args.building_review_smoke, args.building_review_continuation_sha256,
                    args.receptor_screening_smoke, args.receptor_screening_continuation_sha256,
                    args.baseline_study, args.baseline_study_continuation_sha256, args.publication_only,
                    args.print_smoke, args.print_smoke_continuation_sha256,
                    args.print_template_smoke, args.print_template_smoke_continuation_sha256,
                    args.analysis_profile, args.postgis_fixture, args.ftw_query, args.managed_cog_file,
                    args.rebuild_studio, args.publication_compiler_digest, args.publication_preview_port,
                    args.serve, args.restore_checkpoint, args.service_clients, args.wcs_only, args.analysis_only,
                    args.pinned_map_fonts, args.upgrade_from_0082, args.restored, args.font_runtime_package,
                    args.font_runtime_manifest_sha256, args.api_image, args.worker_image, args.pmtiles_worker_image))):
        parser.error("STAC Items requires only persistent development and its exact retained Studio tree/runtime")
    if args.stac_items_continuation_sha256 and (not args.stac_items_smoke
            or not re.fullmatch(r"[a-f0-9]{64}", args.stac_items_continuation_sha256)):
        parser.error("STAC Items continuation requires the exact reviewed changed helper SHA-256")
    if args.raster_validation_smoke and (not args.development or not args.state_directory or not args.reuse_studio_tree
            or any((args.raster_catalog_smoke, args.raster_catalog_continuation_sha256,
                    args.building_review_smoke, args.building_review_continuation_sha256,
                    args.receptor_screening_smoke, args.receptor_screening_continuation_sha256,
                    args.baseline_study, args.baseline_study_continuation_sha256, args.publication_only,
                    args.print_smoke, args.print_template_smoke, args.analysis_profile, args.postgis_fixture,
                    args.ftw_query, args.managed_cog_file, args.rebuild_studio, args.publication_compiler_digest,
                    args.publication_preview_port, args.serve, args.restore_checkpoint, args.service_clients,
                    args.wcs_only, args.analysis_only, args.pinned_map_fonts))):
        parser.error("Raster validation requires only persistent development and an exact sealed Studio tree")
    if args.raster_validation_continuation_sha256 and (not args.raster_validation_smoke
            or not re.fullmatch(r"[a-f0-9]{64}", args.raster_validation_continuation_sha256)):
        parser.error("Raster validation continuation requires the exact reviewed changed helper SHA-256")
    if args.raster_catalog_smoke and (not args.development or not args.state_directory or not args.reuse_studio_tree
            or any((args.building_review_smoke, args.building_review_continuation_sha256,
                    args.receptor_screening_smoke, args.receptor_screening_continuation_sha256,
                    args.baseline_study, args.baseline_study_continuation_sha256, args.publication_only,
                    args.print_smoke, args.print_template_smoke, args.analysis_profile, args.postgis_fixture,
                    args.ftw_query, args.managed_cog_file, args.rebuild_studio, args.publication_compiler_digest,
                    args.publication_preview_port, args.serve, args.restore_checkpoint, args.service_clients,
                    args.wcs_only, args.analysis_only, args.pinned_map_fonts))):
        parser.error("Raster Catalog requires only persistent development and an exact sealed Studio tree")
    if args.raster_catalog_continuation_sha256 and (not args.raster_catalog_smoke
            or not re.fullmatch(r"[a-f0-9]{64}", args.raster_catalog_continuation_sha256)):
        parser.error("Raster continuation requires the exact reviewed changed helper SHA-256")
    if args.receptor_screening_smoke and (not args.development or not args.state_directory or not args.reuse_studio_tree
            or any((args.raster_catalog_smoke, args.raster_catalog_continuation_sha256,
                    args.building_review_smoke, args.building_review_continuation_sha256,
                    args.baseline_study, args.baseline_study_continuation_sha256, args.publication_only,
                    args.print_smoke, args.print_template_smoke, args.analysis_profile, args.postgis_fixture,
                    args.ftw_query, args.managed_cog_file, args.rebuild_studio, args.publication_compiler_digest,
                    args.publication_preview_port))):
        parser.error("Receptor screening requires only persistent development and an exact sealed Studio tree")
    if args.receptor_screening_continuation_sha256 and (not args.receptor_screening_smoke
            or not re.fullmatch(r"[a-f0-9]{64}", args.receptor_screening_continuation_sha256)):
        parser.error("Screening continuation requires the exact reviewed changed helper SHA-256")
    if (args.building_review_inputs is not None or args.building_review_inputs_sha256 is not None) and (
            not args.building_review_smoke or args.building_review_inputs is None
            or not re.fullmatch(r"[a-f0-9]{64}", args.building_review_inputs_sha256 or "")):
        parser.error("Real building inputs require only the building review journey and exact input manifest SHA-256")
    if args.building_review_smoke and (not args.development or not args.state_directory or not args.reuse_studio_tree
            or any((args.raster_catalog_smoke, args.raster_catalog_continuation_sha256,
                    args.baseline_study, args.baseline_study_continuation_sha256, args.publication_only,
                    args.receptor_screening_smoke, args.receptor_screening_continuation_sha256,
                    args.print_smoke, args.print_template_smoke, args.analysis_profile, args.postgis_fixture,
                    args.ftw_query, args.managed_cog_file, args.rebuild_studio, args.publication_compiler_digest,
                    args.publication_preview_port))):
        parser.error("Building review requires only persistent development and an exact sealed Studio tree")
    if args.building_review_continuation_sha256 and (not args.building_review_smoke
            or not re.fullmatch(r"[a-f0-9]{64}", args.building_review_continuation_sha256)):
        parser.error("Building continuation requires the exact reviewed changed helper SHA-256")
    if args.baseline_study and (not args.development or not args.state_directory or not args.reuse_studio_tree
            or not args.publication_compiler_digest or any((args.publication_only, args.print_smoke, args.print_template_smoke,
                args.analysis_profile, args.postgis_fixture, args.ftw_query, args.managed_cog_file, args.rebuild_studio))):
        parser.error("Baseline study requires only persistent development, an exact retained Studio tree and cached publication compiler")
    if args.baseline_study_continuation_sha256 and (not args.baseline_study
            or not re.fullmatch(r"[a-f0-9]{64}", args.baseline_study_continuation_sha256)):
        parser.error("Baseline continuation requires the exact reviewed changed helper SHA-256 and --baseline-study")
    if args.ftw_query and (not args.analysis_only or not args.built_studio or not args.reuse_studio_tree
                          or args.development or args.publication_only):
        parser.error("FTW query acceptance requires only --built-studio --analysis-only --reuse-studio-tree")
    if args.managed_cog_file and (not args.analysis_only or not args.built_studio or not args.reuse_studio_tree
                                 or args.development or args.publication_only or args.ftw_query):
        parser.error("Managed COG acceptance requires only --built-studio --analysis-only --reuse-studio-tree without FTW")
    if args.development:
        if not args.state_directory or any((args.serve, args.upgrade_from_0082, args.pinned_map_fonts,
                args.restore_checkpoint, args.service_clients, args.wcs_only, args.analysis_only, args.restored)):
            parser.error("Development requires --state-directory and excludes acceptance-only modes")
        args.built_studio = not args.publication_only
    elif args.state_directory or args.rebuild_studio or args.analysis_profile or ((args.publication_compiler_digest or args.publication_preview_port) and not args.publication_only):
        parser.error("State, analysis profile and frontend rebuild options belong only to --development")
    if args.postgis_fixture and (not args.development or args.publication_only
            or args.analysis_profile or args.publication_compiler_digest):
        parser.error("The PostGIS fixture requires only the existing built Studio development profile")
    if args.print_smoke and args.print_template_smoke:
        parser.error("Choose the original Print acceptance or the named-template increment")
    if (args.print_smoke or args.print_template_smoke) and (not args.development or not args.built_studio or not args.reuse_studio_tree
            or args.rebuild_studio or args.postgis_fixture or args.publication_only
            or args.analysis_profile or args.publication_compiler_digest):
        parser.error("Print acceptance requires only the exact retained built Studio development journey")
    if args.print_smoke_continuation_sha256 and (not args.print_smoke
            or not re.fullmatch(r"[a-f0-9]{64}", args.print_smoke_continuation_sha256)):
        parser.error("Print continuation requires the exact reviewed helper SHA-256 and --print-smoke")
    if args.print_template_smoke_continuation_sha256 and (not args.print_template_smoke
            or not re.fullmatch(r"[a-f0-9]{64}", args.print_template_smoke_continuation_sha256)):
        parser.error("Template continuation requires the exact changed helper SHA-256 and --print-template-smoke")
    if args.publication_compiler_digest and not re.fullmatch(r"sha256:[a-f0-9]{64}", args.publication_compiler_digest):
        parser.error("Publication compiler must be an exact cached sha256 digest")
    if not 0 <= args.publication_preview_port <= 65535 or (args.publication_preview_port and not args.publication_compiler_digest):
        parser.error("Publication preview port requires the compiler pin and must be between 0 and 65535")
    if args.serve and (args.api_image or args.worker_image):
        parser.error("Image overrides belong to the host orchestrator")
    for image in (args.api_image, args.worker_image):
        if image and not re.fullmatch(r"(?:sha256:)?[0-9a-f]{64}|[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[0-9a-f]{64}", image):
            parser.error("Image overrides require immutable local image IDs or digests")
    if args.pmtiles_worker_image and (
            not re.fullmatch(r"(?:sha256:)?[a-f0-9]{64}", args.pmtiles_worker_image)
            or not args.built_studio or any((args.serve, args.development, args.upgrade_from_0082,
                args.restore_checkpoint, args.wcs_only, args.analysis_only, args.publication_only))):
        parser.error("Dedicated PMTiles requires an exact cached image ID and the fresh built Studio journey")
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
    if args.publication_only and (args.built_studio or args.reuse_studio_tree or not args.publication_compiler_digest or any((args.serve,args.analysis_only,args.wcs_only,args.service_clients,args.restore_checkpoint,args.pinned_map_fonts,args.rebuild_studio,args.analysis_profile))):
        parser.error("Publication-only uses the existing source UI and exact compiler pin without other modes")
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
        publication_only=args.publication_only,
        publication_compiler_digest=args.publication_compiler_digest,
        pmtiles_worker_image=args.pmtiles_worker_image,
        ftw_query=args.ftw_query,
        managed_cog_file=args.managed_cog_file,
    )
