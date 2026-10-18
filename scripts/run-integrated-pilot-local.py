"""Exercise current API/SQL/worker code in an isolated local network namespace.

Only object/queue transport and token verification are local substitutes. This is
not S3, Cognito, Aurora, deployed-client or two-person acceptance evidence.
"""

import argparse
import asyncio
import fcntl
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

ROOT = Path(__file__).resolve().parents[1]
WORK = Path("/work")
BUCKET = "local-pilot.invalid"
ORG = "10000000-0000-4000-8000-000000000001"
OWNER = "20000000-0000-4000-8000-000000000001"
REVIEWER = "20000000-0000-4000-8000-000000000002"
PUBLICATION_ORIGIN = "30000000-0000-4000-8000-000000000001"
PUBLICATION_MOUNT = "30000000-0000-4000-8000-000000000002"
API_IMAGE = "e96f54edd237af0bb75f1803c9e444daa12b5f600dfe7229f0c79d398c52b5cb"
WORKER_IMAGE = "a830dae1cae3b4cbdd88cd44f702fd485e6d70d435557ea68d35df017a7fdb87"
BASELINE = ROOT / "database/baselines/0085_opengeo_schema.sql"
PMTILES_QUEUE = "pmtiles-v2"
PMTILES_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/000000000000/local-pmtiles-v2"
PMTILES_BASE = "ghcr.io/osgeo/gdal:ubuntu-small-3.13.1@sha256:836d1646ff9ab30d7db947c7b9690de55f34c2fd7cc5af6086a0854ccb378f59"


def read_json(name, default=None):
    path = WORK / name
    return json.loads(path.read_text()) if path.exists() else default


def save_json(name, value):
    temporary = WORK / f".{name}.{uuid4().hex}.tmp"
    temporary.write_text(json.dumps(value, indent=2, default=str) + "\n")
    temporary.replace(WORK / name)


def local_pmtiles_profile():
    path = WORK / "pmtiles-runtime.json"
    if path.is_symlink():
        raise ValueError("Local PMTiles profile must not be a symlink")
    if not path.exists():
        return None
    profile = read_json(path.name)
    if (not isinstance(profile, dict)
            or set(profile) != {"imageDigest", "architecture", "baseImage", "queueUrl", "expectedOwner"}
            or not isinstance(profile["imageDigest"], str)
            or re.fullmatch(r"sha256:[a-f0-9]{64}", profile["imageDigest"]) is None
            or profile["architecture"] not in ("amd64", "arm64")
            or profile["baseImage"] != PMTILES_BASE
            or profile["queueUrl"] != PMTILES_QUEUE_URL
            or profile["expectedOwner"] != "000000000000"):
        raise ValueError("Invalid isolated local PMTiles runtime binding")
    return profile


@contextmanager
def local_state_lock(name):
    with (WORK / f".{name}.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def digest(body):
    return hashlib.sha256(body).hexdigest()


def database_initialization_sources(baseline=None, root=None):
    root = root or ROOT
    baseline = baseline or BASELINE
    version = int(baseline.name.split("_", 1)[0])
    migrations = sorted(
        path for path in (root / "database/migrations").glob("[0-9][0-9][0-9][0-9]_*.sql")
        if int(path.name.split("_", 1)[0]) > version
    )
    return [baseline, *migrations]


def stage_database_initialization(init, sources=None):
    init.chmod(0o755)
    for index, source in enumerate(sources or database_initialization_sources(), 1):
        target = init / f"{index:03}.sql"
        shutil.copyfile(source, target)
        target.chmod(0o444)


def source_fingerprints():
    paths = [
        Path(__file__),
        *database_initialization_sources(),
        ROOT / "database/baselines/0082_opengeo_schema.sql",
        ROOT / "database/migrations/0083_user_dataset_connection_revision_read.sql",
        ROOT / "database/migrations/0084_map_resource_version_bindings.sql",
        ROOT / "database/migrations/0085_saved_map_render_jobs.sql",
        ROOT / "database/scripts/build_baseline.py",
        ROOT / "app/src/lib/mapDefinition.js",
        ROOT / "app/src/lib/spatialBody.js",
        *sorted((ROOT / "services/api/src").rglob("*.py")),
        *sorted((ROOT / "services/worker/src").rglob("*.py")),
    ]
    return {str(path.relative_to(ROOT)): digest(path.read_bytes()) for path in paths}


def remove_container(name):
    subprocess.run(
        ["podman", "rm", "--force", "--volumes", name],
        capture_output=True,
        check=False,
    )
    absent = subprocess.run(
        ["podman", "container", "exists", name], capture_output=True, check=False
    )
    if absent.returncode != 1:
        raise RuntimeError(
            f"Temporary container cleanup could not be confirmed: {name}"
        )


def database_volumes(name):
    inspection = subprocess.run(
        ["podman", "inspect", name], capture_output=True, check=True
    )
    return [
        mount["Name"]
        for mount in json.loads(inspection.stdout)[0]["Mounts"]
        if mount["Type"] == "volume"
    ]


def verify_volumes_removed(volumes):
    for name in volumes:
        result = subprocess.run(
            ["podman", "volume", "exists", name], capture_output=True, check=False
        )
        if result.returncode != 1:
            raise RuntimeError(f"Temporary database volume still exists: {name}")


def cleanup_resources(names, volumes, process=None):
    """Attempt every owned cleanup even when an earlier removal fails."""
    errors = []
    for name in names:
        try:
            remove_container(name)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            errors.append(error)
    if process is not None:
        try:
            process.wait(timeout=15)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            errors.append(error)
    for volume in volumes:
        try:
            verify_volumes_removed([volume])
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            errors.append(error)
    if errors:
        raise RuntimeError(
            "Local integration cleanup was incomplete: "
            + "; ".join(str(error) for error in errors)
        ) from errors[0]


class LocalObjects:
    bucket = BUCKET

    def put(self, key, body, content_type):
        version = str(uuid4())
        # Keys are metadata only; never use a caller's object key as a disk path.
        path = WORK / "objects" / version
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(body)
        record = {
            "bucket": BUCKET,
            "key": key,
            "version_id": version,
            "etag": hashlib.md5(body, usedforsecurity=False).hexdigest(),
            "content_type": content_type,
            "size_bytes": len(body),
            "checksum_sha256": digest(body),
        }
        with local_state_lock("objects"):
            index = read_json("objects.json", {})
            index[version] = record
            save_json("objects.json", index)
        return record

    def exact(self, bucket, key, version):
        record = read_json("objects.json", {})[version]
        assert (record["bucket"], record["key"]) == (bucket, key)
        body = (WORK / "objects" / str(UUID(version))).read_bytes()
        assert (
            len(body) == record["size_bytes"]
            and digest(body) == record["checksum_sha256"]
        )
        return record, body

    async def create_upload_form(self, spec):
        from opengeo_api.s3_uploads import UploadForm

        return UploadForm(
            "https://local-transport.invalid/upload",
            "POST",
            {"key": spec.key},
            datetime.now(UTC) + timedelta(minutes=15),
        )

    async def inspect_object(self, key):
        from opengeo_api.s3_uploads import StoredObject, UploadObjectNotFound

        records = [r for r in read_json("objects.json", {}).values() if r["key"] == key]
        if not records:
            raise UploadObjectNotFound("uploaded object does not exist")
        assert len(records) == 1
        record, _ = self.exact(BUCKET, key, records[0]["version_id"])
        return StoredObject(**record)

    async def read_exact_object(self, spec):
        from opengeo_api.s3_downloads import ExactObject

        record, body = self.exact(spec.bucket, spec.key, spec.version_id)
        assert len(body) == spec.size_bytes <= spec.maximum_bytes
        assert (
            record["content_type"] == spec.content_type
            and digest(body) == spec.checksum_sha256
        )
        return ExactObject(
            body, spec.content_type, len(body), digest(body), spec.version_id
        )

    async def create_download_url(self, spec):
        from opengeo_api.s3_downloads import DownloadTicket

        self.exact(spec.bucket, spec.key, spec.version_id)
        return DownloadTicket(
            f"https://local-transport.invalid/objects/{spec.version_id}",
            "GET",
            datetime.now(UTC) + timedelta(minutes=5),
        )

    def download_reference(self, reference, target):
        record, body = self.exact(
            reference.bucket, reference.object_key, reference.s3_version_id
        )
        assert record["size_bytes"] == reference.size_bytes
        assert record["checksum_sha256"] == reference.checksum_sha256
        assert record["etag"] == reference.etag
        target.write_bytes(body)

    download_pmtiles_source = download_reference
    download_coverage_source = download_reference

    def download(self, event, claim, target):
        record, body = self.exact(event.bucket, event.key, event.version_id)
        assert record["size_bytes"] == event.size_bytes and record["etag"] == event.etag
        assert record["checksum_sha256"] == claim.checksum_sha256
        target.write_bytes(body)

    def upload(self, artifact, *, output_prefix, artifact_id):
        return self.upload_pmtiles_derivative(
            artifact,
            object_key=f"{output_prefix.rstrip('/')}/{artifact.relative_key}",
            artifact_id=artifact_id,
        )

    def upload_pmtiles_derivative(self, artifact, *, object_key, artifact_id):
        from opengeo_worker.models import StoredArtifact

        record = self.put(object_key, artifact.path.read_bytes(), artifact.content_type)
        return StoredArtifact(
            artifact_id,
            artifact.role,
            BUCKET,
            object_key,
            record["version_id"],
            record["etag"],
            record["content_type"],
            record["size_bytes"],
            record["checksum_sha256"],
        )


class LocalQueue:
    def __init__(self, name="queue"):
        if name not in {"queue", "observable-builds", "framework-publications", PMTILES_QUEUE}:
            raise ValueError("Unknown local queue")
        self.name = name

    def push(self, payload):
        with local_state_lock(self.name):
            messages = read_json(f"{self.name}.json", [])
            messages.append({"id": str(uuid4()), "body": json.dumps(payload)})
            save_json(f"{self.name}.json", messages)

    def receive(self, visibility_seconds):
        from opengeo_worker.models import QueueMessage

        messages = read_json(f"{self.name}.json", [])
        if not messages:
            return None
        first = messages[0]
        return QueueMessage(first["id"], first["id"], first["body"], 1)

    def delete(self, receipt_handle):
        with local_state_lock(self.name):
            messages = read_json(f"{self.name}.json", [])
            assert messages[0]["id"] == receipt_handle
            save_json(f"{self.name}.json", messages[1:])

    def change_visibility(self, receipt_handle, visibility_seconds):
        assert any(m["id"] == receipt_handle for m in read_json(f"{self.name}.json", []))


class LocalDispatcher:
    available = True

    def __init__(self, schema, field, *, queue="queue", recipe="gdal-pmtiles-v1"):
        self.schema, self.field = schema, field
        self.queue, self.recipe = queue, recipe

    def supports_recipe(self, recipe):
        return recipe == self.recipe

    async def dispatch(self, job_id):
        LocalQueue(self.queue).push({"schema": self.schema, self.field: str(job_id)})

    dispatch_render = dispatch
    dispatch_pmtiles_derivative = dispatch

    async def dispatch_coverage_derivative(self, job_id):
        LocalQueue().push(
            {
                "schema": "opengeo.coverage-derivative.command.v1",
                "coverage_derivative_job_id": str(job_id),
            }
        )


class LocalObservableDispatcher:
    available = True

    async def dispatch_observable_build(self, job_id):
        LocalQueue("observable-builds").push({
            "schema": "opengeo.observable-build.command.1.0.0",
            "build_job_id": str(job_id),
        })


class LocalFrameworkPublicationDispatcher:
    available = True

    async def dispatch_framework_publication(self, review_id):
        LocalQueue("framework-publications").push({
            "schema": "opengeo.framework-publication.command.1.0.0",
            "review_id": str(review_id),
        })


def configure_local_publication(project_id, source_project_id):
    """Operator-only fixture grant; normal API still reviews/approves delivery."""
    import psycopg

    project_id, source_project_id = UUID(project_id), UUID(source_project_id)
    with psycopg.connect("postgresql://postgres@127.0.0.1/opengeo?sslmode=disable") as connection:
        owned = connection.execute(
            "SELECT 1 FROM app.observable_source_projects WHERE id=%s AND project_id=%s "
            "AND organization_id=%s AND owner_user_id=%s",
            (source_project_id, project_id, ORG, OWNER),
        ).fetchone()
        if owned is None:
            raise ValueError("Publication fixture must belong to the local owner")
        connection.execute("ALTER ROLE opengeo_framework_publisher LOGIN")
        connection.execute(
            "INSERT INTO app.framework_publication_origins "
            "(id,organization_id,hostname,bucket,distribution_id,origin_id,active_release_prefix,enabled,verified_by,verified_at) "
            "VALUES (%s,%s,'publication.local.invalid','local-publication.invalid','LOCALPUBLICATION',"
            "'local-publication','releases/bootstrap',true,%s,clock_timestamp()) ON CONFLICT(id) DO NOTHING",
            (PUBLICATION_ORIGIN, ORG, OWNER),
        )
        connection.execute(
            "INSERT INTO app.framework_publication_mounts "
            "(id,organization_id,project_id,source_project_id,origin_id,mount_path,enabled,verified_by,verified_at) "
            "VALUES (%s,%s,%s,%s,%s,'/',true,%s,clock_timestamp()) ON CONFLICT(id) DO NOTHING",
            (PUBLICATION_MOUNT, ORG, project_id, source_project_id, PUBLICATION_ORIGIN, OWNER),
        )
        mount = connection.execute(
            "SELECT project_id,source_project_id FROM app.framework_publication_mounts WHERE id=%s",
            (PUBLICATION_MOUNT,),
        ).fetchone()
        if mount != (project_id, source_project_id):
            raise ValueError("Retained publication mount belongs to another source")
    return {"originId": PUBLICATION_ORIGIN, "mountId": PUBLICATION_MOUNT,
            "canonicalOrigin": "https://publication.local.invalid", "mountPath": "/"}


def worker(pmtiles=False):
    from opengeo_worker.config import Settings
    from opengeo_worker.repository import WorkerRepository

    if pmtiles:
        from opengeo_worker.pmtiles_main import PmtilesWorkerProcessor as processor_type
    else:
        from opengeo_worker.processor import WorkerProcessor as processor_type

    class LocalSettings(Settings):
        def database_connection_kwargs(self):
            return {
                "host": "127.0.0.1",
                "dbname": "opengeo",
                "user": "opengeo_worker",
                "sslmode": "disable",
            }

    profile = local_pmtiles_profile() if pmtiles else None
    if pmtiles and profile is None:
        raise ValueError("The dedicated PMTiles worker requires an exact local binding")
    queue_name = PMTILES_QUEUE if pmtiles else "queue"
    settings = LocalSettings(
        "us-east-1",
        BUCKET,
        "local-only",
        profile["queueUrl"] if profile else "local-only",
        "127.0.0.1",
        5432,
        "opengeo",
        "opengeo_worker",
        "",
        "/unused",
        workspace_root=Path("/tmp/opengeo-worker" if pmtiles else "/tmp/opengeo-integrated-worker"),
        geodata_expected_owner=profile["expectedOwner"] if profile else None,
        pmtiles_worker_image_digest=profile["imageDigest"] if profile else None,
    )
    processor = processor_type(
        settings, LocalQueue(queue_name),
        WorkerRepository(settings, pmtiles_profile="v2" if pmtiles else "v1"), LocalObjects()
    )
    count = len(read_json(f"{queue_name}.json", []))
    assert count, "No generated work to execute"
    for _ in range(count):
        processor.process_once()
    assert not read_json(f"{queue_name}.json", []), (
        "Worker retained a retryable message; inspect the actual failure"
    )
    print(f"worker: consumed {count} real processing request(s)", flush=True)


def local_app(**overrides):
    from opengeo_api.app import create_app
    from opengeo_api.auth_models import VerifiedAccessToken
    from opengeo_api.config import Settings
    from pydantic import SecretStr

    class LocalSettings(Settings):
        def database_connection_kwargs(self):
            return {
                "conninfo": "postgresql://opengeo_runtime@127.0.0.1/opengeo",
                "sslmode": "disable",
            }

        @property
        def pmtiles_derivative_dispatch_configured(self):
            # This runner has two real file transports. The production mode
            # selects one cloud worker lane; ordinary local intake stays shared.
            # SQL admission still owns whether this configured lane is ready.
            return bool(
                pmtiles is not None
                and self.worker_processing_mode == "shared"
                and self.aws_region == "us-east-1"
                and self.pmtiles_worker_image_digest == pmtiles["imageDigest"]
                and self.pmtiles_derivative_queue_url == pmtiles["queueUrl"]
                and self.pmtiles_derivative_queue_url != self.processing_queue_url
                and isinstance(pmtiles_dispatcher, LocalDispatcher)
                and pmtiles_dispatcher.available
                and pmtiles_dispatcher.supports_recipe("gdal-pmtiles-v2")
                and pmtiles_dispatcher.queue == PMTILES_QUEUE
                and pmtiles_dispatcher.schema == "opengeo.pmtiles-derivative.command.v1"
                and pmtiles_dispatcher.field == "pmtiles_derivative_job_id"
                and isinstance(render_dispatcher, LocalDispatcher)
                and render_dispatcher.available
                and render_dispatcher.queue == "queue"
                and render_dispatcher.queue != pmtiles_dispatcher.queue
            )

    class LocalTokens:
        async def verify(self, token):
            # The actual browser session parser requires a three-part token.
            # These exact local sentinels are not signed or real Cognito tokens.
            actors = {
                "synthetic-local-owner": "owner",
                "synthetic-local-reviewer": "reviewer",
                "synthetic.local.owner": "owner",
                "synthetic.local.reviewer": "reviewer",
            }
            assert token in actors
            actor = actors[token]
            return VerifiedAccessToken(
                f"local-pilot-{actor}", "local-client", actor, (), ()
            )

    class LocalIdentities:
        async def ensure_user(self, email, display_name):
            from opengeo_api.cognito_provisioning import ProvisionedIdentity

            assert email == "reviewer@local.invalid"
            return ProvisionedIdentity("local-pilot-reviewer", email, display_name)

    publication = read_json("publication-profile.json", {})
    pmtiles = local_pmtiles_profile()
    pmtiles_dispatcher = overrides.get("pmtiles_derivative_dispatcher", LocalDispatcher(
        "opengeo.pmtiles-derivative.command.v1", "pmtiles_derivative_job_id",
        queue=PMTILES_QUEUE if pmtiles else "queue",
        recipe="gdal-pmtiles-v2" if pmtiles else "gdal-pmtiles-v1",
    ))
    render_dispatcher = overrides.get("render_dispatcher", LocalDispatcher(
        "opengeo.render.command.v1", "render_job_id"
    ))
    dependencies = {
        "settings": LocalSettings(
            env="test",
            log_level="WARNING",
            geodata_bucket=BUCKET,
            application_bucket=BUCKET,
            worker_processing_mode="shared",
            pmtiles_derivative_queue_url=pmtiles["queueUrl"] if pmtiles else None,
            pmtiles_worker_image_digest=pmtiles["imageDigest"] if pmtiles else None,
            observable_builder_image_digest=publication.get("compilerImageDigest"),
            observable_preview_origin=publication.get("previewOrigin"),
            portable_artifacts_enabled=bool(publication),
            publication_artifact_builds_enabled=bool(publication),
            aws_region="us-east-1",
            geodata_kms_key_arn="arn:aws:kms:us-east-1:000000000000:key/local-only",
            database_url=SecretStr("postgresql://opengeo_runtime@127.0.0.1/opengeo"),
        ),
        "token_verifier": LocalTokens(),
        "identity_provisioner": LocalIdentities(),
        "upload_storage": LocalObjects(),
        "download_storage": LocalObjects(),
        "page_source_upload_storage": LocalObjects(),
        "page_source_download_storage": LocalObjects(),
        "render_dispatcher": render_dispatcher,
        "pmtiles_derivative_dispatcher": pmtiles_dispatcher,
    }
    if publication:
        from opengeo_api.observable_previews import CloudFrontPreviewCookieSigner

        if publication["previewPrivateKeyPath"] != "publication-preview-private.pem":
            raise ValueError("Local publication signing key must use the profile-relative filename")
        private_key = WORK / publication["previewPrivateKeyPath"]
        if private_key.is_symlink() or not private_key.is_file() or (private_key.stat().st_mode & 0o777) != 0o600:
            raise ValueError("Local publication signing key must be a private file under the state directory")
        dependencies["observable_preview_cookie_signer"] = CloudFrontPreviewCookieSigner(
            publication["previewKeyPairId"], private_key.read_bytes(),
            allowed_origins=[publication["previewOrigin"]],
        )
        dependencies["observable_build_dispatcher"] = LocalObservableDispatcher()
        dependencies["framework_publication_dispatcher"] = LocalFrameworkPublicationDispatcher()
    dependencies.update(overrides)
    if publication and "render_repository" not in overrides:
        from opengeo_api.rendering import PostgresRenderRepository
        from opengeo_api.tenant_database import PostgresTenantQueryExecutor

        # Use the normal tenant-authorized repository with the same local
        # transports as source uploads. Never select AWS cleanup in this profile;
        # expired upload cleanup remains explicitly unconfigured.
        dependencies["render_repository"] = PostgresRenderRepository(
            PostgresTenantQueryExecutor(dependencies["settings"]),
            dependencies["download_storage"],
            artifact_uploads=dependencies["page_source_upload_storage"],
            artifact_downloads=dependencies["page_source_download_storage"],
        )
    return create_app(**dependencies)


async def api(stage):
    import httpx2
    import psycopg

    app = local_app()
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app), base_url="http://local.invalid"
    ) as client:

        async def request(method, path, data=None, expected=200, actor="owner"):
            response = await client.request(
                method,
                path,
                json=data,
                headers={
                    "Authorization": f"Bearer synthetic-local-{actor}",
                    "X-OpenGeo-Organization": ORG,
                },
            )
            assert response.status_code == expected, (
                f"{method} {path}: {response.status_code} {response.text[:2000]}"
            )
            value = response.json() if response.content else None
            print(f"api ({actor}): {method} {path} -> {expected}", flush=True)
            return value

        if stage == "upload":
            # Superuser access is only synthetic identity bootstrap, never workflow execution.
            with psycopg.connect(
                "postgresql://postgres@127.0.0.1/opengeo?sslmode=disable"
            ) as connection:
                connection.execute(
                    "INSERT INTO app.users(id,cognito_subject,email,display_name) VALUES (%s,%s,%s,%s)",
                    (
                        OWNER,
                        "local-pilot-owner",
                        "owner@local.invalid",
                        "Local pilot owner",
                    ),
                )
                connection.execute(
                    "INSERT INTO app.organizations(id,name,slug,created_by) VALUES (%s,%s,%s,%s)",
                    (ORG, "Isolated integration", "local-pilot", OWNER),
                )
                connection.execute(
                    "INSERT INTO app.organization_memberships(organization_id,user_id,role) VALUES (%s,%s,'admin')",
                    (ORG, OWNER),
                )
                connection.execute(
                    "INSERT INTO app.users(id,cognito_subject,email,display_name) VALUES (%s,%s,%s,%s)",
                    (
                        REVIEWER,
                        "local-pilot-reviewer",
                        "reviewer@local.invalid",
                        "Local pilot reviewer",
                    ),
                )
            with psycopg.connect(
                "postgresql://opengeo_runtime@127.0.0.1/opengeo?sslmode=disable"
            ) as connection:
                permissions = connection.execute(
                    "SELECT current_user, rolsuper, rolbypassrls, has_any_column_privilege(current_user, 'app.dataset_versions', 'UPDATE') FROM pg_roles WHERE rolname = current_user"
                ).fetchone()
                assert permissions == ("opengeo_runtime", False, False, False), (
                    permissions
                )
                save_json("runtime-permissions.json", permissions)
            project = await request(
                "POST",
                "/projects",
                {"name": "Local integrated pilot", "project_code": "LOCAL-PILOT"},
                201,
            )
            collection = {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"name": f"Watershed {i}", "value": i + 1},
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": [
                                [
                                    [x, 42],
                                    [x + 0.1, 42],
                                    [x + 0.1, 42.1],
                                    [x, 42.1],
                                    [x, 42],
                                ]
                            ],
                        },
                    }
                    for i, x in enumerate([-72.5, -72.2])
                ],
            }
            body = json.dumps(collection).encode()
            upload = await request(
                "POST",
                f"/projects/{project['id']}/uploads/request",
                {
                    "name": "Watersheds",
                    "description": "Two synthetic polygons",
                    "classification": "public",
                    "format": "geojson",
                    "filename": "watersheds.geojson",
                    "content_type": "application/geo+json",
                    "size_bytes": len(body),
                    "checksum_sha256": digest(body),
                    "tags": ["local-integration"],
                },
                201,
            )
            record = LocalObjects().put(
                upload["upload"]["fields"]["key"], body, "application/geo+json"
            )
            completion_path = (
                f"/projects/{project['id']}/uploads/{upload['upload_id']}/complete"
            )
            completion = await request("POST", completion_path)
            replay = await request("POST", completion_path)
            assert replay["processing_job_id"] == completion["processing_job_id"]
            assert replay["dataset_version_id"] == completion["dataset_version_id"]
            LocalQueue().push(
                {
                    "Records": [
                        {
                            "eventSource": "aws:s3",
                            "eventName": "ObjectCreated:Post",
                            "awsRegion": "us-east-1",
                            "s3": {
                                "bucket": {"name": BUCKET},
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
            save_json(
                "state.json",
                {
                    "project": project,
                    "upload": upload,
                    "completion": completion,
                    "input_sha256": digest(body),
                },
            )
        elif stage == "inspect":
            state = read_json("state.json")
            project_id, dataset_id = (
                state["project"]["id"],
                state["upload"]["dataset"]["id"],
            )
            dataset = await request(
                "GET", f"/projects/{project_id}/datasets/{dataset_id}"
            )
            save_json("dataset-result.json", dataset)
            assert dataset["status"] == "active" and dataset["feature_count"] == 2, (
                dataset
            )
            print(
                "Integrated managed upload: active dataset with two real features",
                flush=True,
            )
            base = f"/projects/{project_id}"
            version_id = state["completion"]["dataset_version_id"]
            versions = await request("GET", f"{base}/datasets/{dataset_id}/versions")
            version = next(v for v in versions if v["id"] == version_id)
            source_layers = version["schema_definition"]["layers"]
            assert len(source_layers) == 1
            derivative_path = f"{base}/datasets/{dataset_id}/versions/{version_id}/pmtiles-derivatives"
            derivative_draft = {
                "idempotency_key": str(uuid4()),
                "bounds": dataset["extent"],
                "min_zoom": 4,
                "max_zoom": 8,
                "source_layer": source_layers[0]["name"],
            }
            derivative = await request("POST", derivative_path, derivative_draft, 202)
            replay = await request("POST", derivative_path, derivative_draft, 202)
            assert derivative["job_id"] == replay["job_id"]

            def metadata(title):
                return {
                    "title": title,
                    "abstract": "Synthetic local integration data and publication",
                    "license": "CC-BY-4.0",
                    "attribution": "OpenGeo synthetic local integration",
                    "spatial_extent": dataset["extent"],
                    "language": "en",
                    "keywords": ["local-integration"],
                }

            async def publish_resource(resource):
                path = f"{base}/resources/{resource['id']}/transitions"
                review = await request(
                    "POST",
                    path,
                    {
                        "expected_version": resource["version_number"],
                        "target_state": "review",
                        "reason": "Local review",
                    },
                )
                return await request(
                    "POST",
                    path,
                    {
                        "expected_version": review["version_number"],
                        "target_state": "published",
                        "visibility": "public",
                        "reason": "Local publication",
                    },
                )

            resource = await request(
                "POST",
                f"{base}/resources",
                {
                    "kind": "dataset",
                    "slug": "watershed-data",
                    "dataset_id": dataset_id,
                    "metadata": metadata("Watershed observations"),
                    "provenance": {
                        "source": "managed_upload",
                        "datasetVersionId": version_id,
                    },
                },
                201,
            )
            resource = await publish_resource(resource)
            definition = read_json("map-template.json")
            definition["activeLayerId"] = "watersheds"
            definition["layers"] = [
                {
                    "layerId": "watersheds",
                    "datasetId": dataset_id,
                    "datasetVersionId": version_id,
                    "sourceVersion": 1,
                    "title": "Watersheds",
                    "sourceType": "governed-dataset",
                    "geometryType": "Polygon",
                    "visible": True,
                    "opacity": 0.85,
                    "order": 0,
                    "style": {"fill": "#2a9d8f", "stroke": "#155e63", "strokeWidth": 2},
                    "labels": {"enabled": True, "field": "name"},
                }
            ]
            map_record = await request(
                "POST",
                f"{base}/maps",
                {"name": "Watershed map", "definition": definition},
                201,
            )
            reopened = await request("GET", f"{base}/maps/{map_record['id']}")
            assert reopened["definition"]["layers"][0]["datasetVersionId"] == version_id
            # Map creation owns the canonical governed record. Reuse that
            # identity rather than attempting a second resource for the same map.
            map_resources = await request("GET", f"{base}/resources?kind=map")
            matching = [item for item in map_resources if item["map_id"] == map_record["id"]]
            assert len(matching) == 1
            map_resource = await request("GET", f"{base}/resources/{matching[0]['id']}")
            map_resource = await request(
                "PUT",
                f"{base}/resources/{map_resource['id']}",
                {
                    "expected_version": map_resource["version_number"],
                    "expected_map_version": reopened["version"],
                    "visibility": map_resource["visibility"],
                    "metadata": metadata("Watershed map"),
                    "content": map_resource["content"],
                    "provenance": map_resource["provenance"],
                    "change_message": "Prepare the retained canonical map for local publication",
                },
            )
            map_resource = await publish_resource(map_resource)
            story = await request(
                "POST",
                f"{base}/resources",
                {
                    "kind": "story",
                    "slug": "watershed-story",
                    "metadata": metadata("Watershed story"),
                    "content": {
                        "blocks": [
                            {
                                "id": "intro",
                                "type": "markdown",
                                "markdown": "# Watershed pilot\n\nReal synthetic data, preserved through the local production code paths.",
                            },
                            {
                                "id": "dataset",
                                "type": "dataset",
                                "resource_id": resource["id"],
                                "resource_version_number": resource["version_number"],
                                "caption": "Preserved observations",
                            },
                            {
                                "id": "map",
                                "type": "map",
                                "resource_id": map_resource["id"],
                                "resource_version_number": map_resource[
                                    "version_number"
                                ],
                                "caption": "Styled observations",
                            },
                        ]
                    },
                },
                201,
            )
            story = await publish_resource(story)
            resource_base = f"{base}/resources/{resource['id']}"
            metadata_export = await request(
                "GET", f"{resource_base}/metadata/export/ogc_records_1_0"
            )
            assert metadata_export["document"]["id"] == resource["id"]
            save_json("metadata-export.json", metadata_export)
            style = await request(
                "POST",
                f"{resource_base}/styles",
                {
                    "slug": "watershed-fill",
                    "title": "Watershed fill",
                    "format": "maplibre",
                    "definition": json.dumps(
                        {
                            "version": 8,
                            "sources": {},
                            "layers": [
                                {
                                    "id": "watershed-fill",
                                    "type": "fill",
                                    "paint": {
                                        "fill-color": "#2a9d8f",
                                        "fill-opacity": 0.85,
                                    },
                                }
                            ],
                        }
                    ),
                },
                201,
            )
            profile = await request(
                "POST",
                f"{resource_base}/render-profiles",
                {
                    "slug": "watershed-render",
                    "title": "Watershed render",
                    "style_id": style["id"],
                    "geometry_layer_id": "watershed-fill",
                    "include_legend": True,
                },
                201,
            )
            render = await request(
                "POST",
                f"{resource_base}/render-profiles/{profile['id']}/renders",
                {
                    "idempotency_key": str(uuid4()),
                    "bbox": dataset["extent"],
                    "crs": "CRS:84",
                    "width": 320,
                    "height": 240,
                    "format": "png",
                    "transparent": False,
                    "background_color": "#ffffff",
                },
                202,
            )
            state.update(
                dataset=dataset,
                derivative=derivative,
                resource=resource,
                map_resource=map_resource,
                story=story,
                style=style,
                render=render,
            )
            save_json("state.json", state)
        elif stage == "publish":
            from io import BytesIO
            from zipfile import ZipFile

            state = read_json("state.json")
            project_id, dataset_id = state["project"]["id"], state["dataset"]["id"]
            base = f"/projects/{project_id}"
            version_id = state["completion"]["dataset_version_id"]
            derivative = await request(
                "GET",
                f"{base}/datasets/{dataset_id}/versions/{version_id}/pmtiles-derivatives/{state['derivative']['job_id']}",
            )
            assert derivative["state"] == "completed", derivative
            versions = await request("GET", f"{base}/datasets/{dataset_id}/versions")
            version = next(v for v in versions if v["id"] == version_id)
            assert any(
                o["role"] == "original"
                and o["checksum_sha256"] == state["input_sha256"]
                for o in version["objects"]
            )
            assert any(
                o["role"] == "tile" and o["id"] == derivative["output_object_id"]
                for o in version["objects"]
            )
            lineage = await request(
                "GET", f"{base}/datasets/{dataset_id}/versions/{version_id}/lineage"
            )
            assert lineage["origins"][0]["kind"] == "managed_upload"
            assert (
                lineage["derivatives"][0]["output_object_id"]
                == derivative["output_object_id"]
            )
            resource_id = state["resource"]["id"]
            render = await request(
                "GET", f"{base}/resources/{resource_id}/renders/{state['render']['id']}"
            )
            assert render["state"] == "completed", render
            ticket = await request(
                "POST",
                f"{base}/resources/{resource_id}/renders/{render['id']}/download",
            )
            render_version = ticket["url"].rsplit("/", 1)[-1]
            render_bytes = (WORK / "objects" / str(UUID(render_version))).read_bytes()
            assert render_bytes.startswith(b"\x89PNG\r\n\x1a\n")
            site = await request(
                "POST",
                f"{base}/sites",
                {
                    "slug": "watershed-pilot",
                    "title": "Watershed pilot",
                    "theme": "atlas",
                    "pages": [
                        {
                            "slug": r["slug"],
                            "navigation_label": label,
                            "resource_id": r["id"],
                            "resource_version": r["version_number"],
                            "is_home": home,
                        }
                        for r, label, home in [
                            (state["story"], "Story", True),
                            (state["map_resource"], "Map", False),
                        ]
                    ],
                },
                201,
            )
            site_base = f"{base}/sites/{site['id']}"
            site = await request(
                "PUT",
                f"{site_base}/publication-destination",
                {
                    "expected_revision": site["publication_destination"]["revision"],
                    "reach": "listed",
                    "listed_slug": site["slug"],
                    "is_primary": False,
                },
            )
            await request("GET", base, expected=403, actor="reviewer")
            invitation = await request(
                "POST",
                "/organizations/current/invitations",
                {
                    "email": "reviewer@local.invalid",
                    "display_name": "Local pilot reviewer",
                    "organization_role": "guest",
                    "project_id": project_id,
                    "project_role": "editor",
                    "expires_in_days": 1,
                },
                201,
            )
            pending = await request("GET", "/auth/invitations", actor="reviewer")
            assert any(i["invitation_id"] == invitation["id"] for i in pending)
            accepted = await request(
                "POST", f"/auth/invitations/{invitation['id']}/accept", actor="reviewer"
            )
            assert (
                accepted["project_role"] == "editor"
                and accepted["project_id"] == project_id
            )
            await request("GET", base, actor="reviewer")
            edit = {
                key: site[key]
                for key in (
                    "title",
                    "description",
                    "language",
                    "theme",
                    "theme_options",
                    "print_layout",
                )
            }
            edit["pages"] = [
                {
                    **{
                        key: page[key]
                        for key in (
                            "slug",
                            "navigation_label",
                            "resource_id",
                            "is_home",
                        )
                    },
                    "resource_version": page["resource_version_number"],
                }
                for page in site["pages"]
            ]
            edit.update(
                expected_version=site["version_number"],
                change_message="Local reviewer edit",
                description="Persisted collaborator revision",
            )
            edited = await request("PUT", site_base, edit, actor="reviewer")
            assert edited["version_number"] == site["version_number"] + 1
            stale = await request("PUT", site_base, edit, expected=409)
            assert stale["detail"]["code"] == "site_version_conflict"
            review = await request(
                "POST",
                f"{site_base}/review",
                {
                    "expected_version": edited["version_number"],
                    "reason": "Local integrated review",
                },
            )
            publication_draft = {
                "expected_version": review["version_number"],
                "reason": "Local integrated publication",
                "map_snapshots": [
                    {"resource_id": resource_id, "render_job_id": render["id"]}
                ],
            }
            await request(
                "POST",
                f"{site_base}/publish",
                publication_draft,
                expected=403,
                actor="reviewer",
            )
            published = await request("POST", f"{site_base}/publish", publication_draft)
            assert (
                published["state"] == "published"
                and len(published["active_edition"]["manifest"]["pages"]) == 2
            )
            public_path = f"/public/organizations/{ORG}/projects/{project_id}/sites/{site['slug']}"
            html = await client.get(public_path)
            assert html.status_code == 200 and "Watershed pilot" in html.text, (
                html.text[:1000]
            )
            package = await client.get(f"{public_path}/export.zip")
            assert package.status_code == 200, package.text[:1000]
            with ZipFile(BytesIO(package.content)) as archive:
                assert archive.testzip() is None
                assert any(
                    archive.read(name) == render_bytes
                    for name in archive.namelist()
                    if name.endswith(".png")
                ), archive.namelist()
            (WORK / "publication.zip").write_bytes(package.content)
            await request(
                "POST",
                f"{site_base}/editions/{published['active_edition']['id']}/revoke",
            )
            assert (await client.get(public_path)).status_code == 404
            assert (await client.get(f"{public_path}/export.zip")).status_code == 404
            await request("DELETE", f"{base}/memberships/{REVIEWER}", expected=204)
            await request("GET", base, expected=404, actor="reviewer")
            await request(
                "DELETE", f"/organizations/current/memberships/{REVIEWER}", expected=204
            )
            await request("GET", base, expected=403, actor="reviewer")
            save_json(
                "result.json",
                {
                    "status": "pass",
                    "environment": "isolated-local",
                    "input_sha256": state["input_sha256"],
                    "feature_count": 2,
                    "pmtiles_job": derivative,
                    "render": render,
                    "publication_sha256": digest(package.content),
                    "edition_id": published["active_edition"]["id"],
                    "revocation_denies_html_and_export": True,
                    "synthetic_reviewer_invitation_edit_conflict_and_revocation": True,
                    "substitutions": [
                        "token verification and identity provisioning",
                        "S3 object transport",
                        "SQS delivery",
                        "direct PostgreSQL instead of Aurora Data API",
                    ],
                    "not_proven": [
                        "deployed clients",
                        "Cognito sign-in",
                        "S3/KMS",
                        "two-person acceptance",
                        "native ARM64",
                        "physical accessibility",
                        "scale",
                        "AWS cost",
                    ],
                },
            )
            print(
                "Integrated publication: real PMTiles and PNG, sealed two-page ZIP, anonymous reads and revocation pass",
                flush=True,
            )


def orchestrate():
    sys.path.insert(0, str(ROOT / "database/scripts"))
    from build_baseline import IMAGE, TemporaryDatabase

    started = datetime.now(UTC)
    source_hashes = source_fingerprints()
    work = Path(tempfile.mkdtemp(prefix="opengeo-integrated-pilot-"))
    init = work / "init"
    init.mkdir()
    stage_database_initialization(init)
    template = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            "import {emptyMapDefinition} from './app/src/lib/mapDefinition.js'; console.log(JSON.stringify(emptyMapDefinition()));",
        ],
        cwd=ROOT,
        capture_output=True,
        check=True,
    )
    (work / "map-template.json").write_bytes(template.stdout)
    print(f"Local evidence directory: {work}", flush=True)
    database = TemporaryDatabase("podman", init, "integrated-pilot")
    volumes = []
    try:
        with database:
            volumes = database_volumes(database.name)
            for index, (stage, image, executable) in enumerate(
                [
                    ("upload", API_IMAGE, "python"),
                    ("worker", WORKER_IMAGE, "python3"),
                    ("inspect", API_IMAGE, "python"),
                    ("worker", WORKER_IMAGE, "python3"),
                    ("publish", API_IMAGE, "python"),
                ]
            ):
                container_name = f"{database.name}-{index}-{stage}"
                command = [
                    "podman",
                    "run",
                    "--rm",
                    "--name",
                    container_name,
                    "--pull=never",
                    "--network",
                    f"container:{database.name}",
                    "--read-only",
                    "--cap-drop=all",
                    "--security-opt=no-new-privileges",
                    "--security-opt=label=disable",
                    "--memory=3g",
                    "--cpus=2",
                    "--pids-limit=256",
                    "--user=0",
                    "--tmpfs",
                    "/tmp:rw,size=1g",
                    "--volume",
                    f"{ROOT}:/repo:ro",
                    "--volume",
                    f"{work}:/work:rw",
                    "--env",
                    "PYTHONDONTWRITEBYTECODE=1",
                    "--env",
                    "PYTHONUNBUFFERED=1",
                    "--env",
                    "PYTHONPATH=/repo/services/api/src:/repo/services/worker/src:/opt/opengeo-python",
                    "--entrypoint",
                    executable,
                    image,
                    "/repo/scripts/run-integrated-pilot-local.py",
                    "--stage",
                    stage,
                ]
                try:
                    completed = subprocess.run(
                        command,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        timeout=300,
                        check=False,
                    )
                    (work / f"{index}-{stage}.log").write_bytes(completed.stdout)
                    print(
                        completed.stdout.decode("utf-8", "replace"), end="", flush=True
                    )
                    if completed.returncode:
                        logs = subprocess.run(
                            ["podman", "logs", database.name],
                            capture_output=True,
                            check=False,
                        )
                        (work / "database-failure.log").write_bytes(
                            logs.stdout + logs.stderr
                        )
                        print(
                            "\n".join(
                                (logs.stdout + logs.stderr)
                                .decode("utf-8", "replace")
                                .splitlines()[-40:]
                            ),
                            flush=True,
                        )
                    completed.check_returncode()
                finally:
                    remove_container(container_name)
    finally:
        # Also cover a failure inside TemporaryDatabase.__enter__.
        cleanup_resources([database.name], volumes)
    if source_fingerprints() != source_hashes:
        raise RuntimeError(
            "Source changed during the integrated run; no sealed result is available"
        )
    result = json.loads((work / "result.json").read_text())
    assert result["status"] == "pass"
    receipt = {
        "schema": "opengeo.integrated-pilot-local.1.0.0",
        "started_at": started.isoformat(),
        "finished_at": datetime.now(UTC).isoformat(),
        "elapsed_seconds": round((datetime.now(UTC) - started).total_seconds(), 3),
        "result": result,
        "api_image_id": API_IMAGE,
        "worker_image_id": WORKER_IMAGE,
        "database_image": IMAGE,
        "source_sha256": source_hashes,
        "artifacts": {
            p.name: digest(p.read_bytes())
            for p in sorted(work.iterdir())
            if p.is_file()
        },
        "all_temporary_containers_removed": True,
        "removed_database_volumes": volumes,
        "database_baseline": BASELINE.name,
        "external_network": False,
        "aws_calls": False,
    }
    (work / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(f"Verified local receipt: {work / 'receipt.json'}", flush=True)


if __name__ == "__main__":
    if not __debug__:
        raise SystemExit("Integration assertions must not be disabled")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", choices=["upload", "worker", "worker-pmtiles", "inspect", "publish"])
    args = parser.parse_args()
    if args.stage and ROOT != Path("/repo"):
        parser.error(
            "Internal stages must run through the isolated container orchestrator"
        )
    if args.stage in {"worker", "worker-pmtiles"}:
        worker(pmtiles=args.stage == "worker-pmtiles")
    elif args.stage:
        asyncio.run(api(args.stage))
    else:
        orchestrate()
