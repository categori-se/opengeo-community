import asyncio
import json
from dataclasses import replace
from urllib.parse import parse_qs
from uuid import UUID

import pytest
from pydantic import ValidationError

from opengeo_api.analysis_jobs import (
    AnalysisAccessDenied,
    AnalysisConfiguration,
    AnalysisConflict,
    PostgresAnalysisJobRepository,
    parse_runtime_profiles,
)
from opengeo_api.app import create_app
from opengeo_api.cognito_provisioning import IdentityProvisioningUnavailable
from opengeo_api.config import Settings
from opengeo_api.processing_dispatch import AwsSqsAnalysisDispatcher, ProcessingDispatchUnavailable
from opengeo_api.s3_downloads import DownloadTicket
from opengeo_api.s3_uploads import StoredObject, UploadForm, UploadObjectNotFound
from opengeo_api.tenant_database import TenantContext
from opengeo_api.user_dataset_verification_runtime import DatasetVerificationDependencyUnavailable
from test_connection_routes import (
    NOW,
    ORG_ID,
    PROJECT_ID,
    USER_ID,
    FakeConnectionRepository,
    api_app,
    headers,
)
from test_connection_routes import inline_threadpool as inline_threadpool
from test_connection_routes import (
    request as base_request,
)
from test_processing_dispatch import Credentials, Transport, settings

JOB = UUID("01740000-0000-4000-8000-000000000001")
KEY = UUID("01740000-0000-4000-8000-000000000002")
DATASET = UUID("01740000-0000-4000-8000-000000000003")
PATH = f"/projects/{PROJECT_ID}/analysis"
SHA = "a" * 64
PREFIX = f"organizations/{ORG_ID}/projects/{PROJECT_ID}/analysis/{JOB}/"
PROFILES = {
    "schemaVersion": 1,
    "architecture": "amd64",
    "profiles": {
        "python": {"image": "sha256:" + "b" * 64, "interpreter": "/usr/bin/python3"},
        "javascript": {"image": "sha256:" + "c" * 64, "interpreter": "/usr/bin/node"},
        "bash": {"image": "sha256:" + "d" * 64, "interpreter": "/bin/bash"},
    },
}
CONFIG = AnalysisConfiguration(
    True, "https://sqs.us-east-1.amazonaws.com/111111111111/analysis", PROFILES
)
CONTROLLER = "arn:aws:lambda:us-east-1:111111111111:function:opengeo-dev-analysis-controller"


def managed_settings():
    return Settings.model_validate({
        **settings().model_dump(),
        "analysis_enabled": True,
        "analysis_queue_url": CONFIG.queue_url,
        "analysis_runtime_profiles": json.dumps(PROFILES),
        "analysis_controller_function_arn": CONTROLLER,
        "application_bucket": "opengeo-analysis-application-test",
    })


class WakeTransport:
    def __init__(self, responses=None):
        self.responses = list(responses or [(202, {}, b"")])
        self.calls = []

    def call(self, method, url, headers, body, timeout, maximum_bytes):
        self.calls.append((method, url, headers, body, timeout, maximum_bytes))
        result = self.responses.pop(0)
        if isinstance(result, BaseException):
            raise result
        return result


def request(app, method, path, **kwargs):
    route, _, query = path.partition("?")

    async def with_query(scope, receive, send):
        await app({**scope, "query_string": query.encode()}, receive, send)

    return base_request(with_query, method, route, **kwargs)


def payload():
    return {
        "request_key": str(KEY),
        "language": "python",
        "snapshot": {"size_bytes": 1234, "checksum_sha256": SHA},
        "layer_ids": ["selected"],
        "source_bindings": [{"layer_id": "selected", "dataset_id": str(DATASET)}],
    }


def row(state="awaiting_upload"):
    return {
        "job_id": str(JOB),
        "request_key": str(KEY),
        "state": state,
        "language": "python",
        "snapshot": {
            "bucket": "analysis-test",
            "key": PREFIX + "snapshot.json",
            "size_bytes": 1234,
            "checksum_sha256": SHA,
        },
        "cleanup": {"cleanup_required": False, "container_removed": True, "staging_removed": True},
    }


class Store:
    def __init__(self):
        self.calls = []
        self.row = row()
        self.revoked = False
        self.error = None

    async def capabilities(self, *args):
        self.calls.append(("capabilities", *args))
        return {
            "configured": args[-1].configured,
            "available": args[-1].configured,
            "can_submit": True,
            "state": "asleep",
        }

    async def create(self, *args):
        self.calls.append(("create", *args))
        return self.row

    async def find(self, *args):
        self.calls.append(("find", *args))
        return await self.get(*args)

    async def get(self, *args):
        self.calls.append(("get", *args))
        if self.revoked:
            raise AnalysisAccessDenied()
        return self.row

    async def submit(self, *args):
        self.calls.append(("submit", *args))
        if self.error:
            raise self.error
        self.row = {**self.row, "state": "dispatch_pending"}
        return self.row

    async def dispatched(self, *args):
        self.calls.append(("dispatched", *args))
        self.row = {**self.row, "state": "pending"}
        return self.row

    async def cancel(self, *args):
        self.calls.append(("cancel", *args))
        return {"job_id": str(JOB), "state": "cancel_requested", "cleanup_required": True}


class Storage:
    bucket = "analysis-test"

    def __init__(self):
        self.forms = []
        self.heads = []
        self.downloads = []
        self.stored = StoredObject(
            self.bucket,
            PREFIX + "snapshot.json",
            "immutable-v1",
            "etag",
            "application/json",
            1234,
            SHA,
        )

    async def create_upload_form(self, spec):
        self.forms.append(spec)
        return UploadForm("https://analysis-test.s3.amazonaws.com/", "POST", {"key": spec.key}, NOW)

    async def inspect_object(self, key):
        self.heads.append(key)
        if self.stored is None:
            raise UploadObjectNotFound()
        return self.stored

    async def create_download_url(self, spec):
        self.downloads.append(spec)
        return DownloadTicket(
            "https://analysis-test.s3.amazonaws.com/result.json?signed", "GET", NOW
        )


class Dispatcher:
    available = True
    fail = False

    def __init__(self):
        self.calls = []

    async def dispatch_analysis(self, identity):
        self.calls.append(identity)
        if self.fail:
            raise ProcessingDispatchUnavailable()


def setup(configured=True):
    app = api_app(FakeConnectionRepository())
    store, storage, dispatcher = Store(), Storage(), Dispatcher()
    app.state.analysis_job_repository = store
    app.state.analysis_configuration = (
        CONFIG if configured else AnalysisConfiguration(False, None, None)
    )
    app.state.analysis_dispatcher = dispatcher
    app.state.analysis_upload_storage = storage
    app.state.analysis_download_storage = storage
    return app, store, storage, dispatcher


def test_default_off_stops_mutations_before_database_storage_and_dispatch_but_reads_work():
    app, store, storage, dispatcher = setup(False)
    assert request(app, "GET", PATH + "/capabilities").status_code == 401
    for suffix in ("/jobs", f"/jobs/{JOB}/submit"):
        assert (
            request(
                app, "POST", PATH + suffix, request_headers=headers(), json_body=payload()
            ).status_code
            == 503
        )
    assert not store.calls and not storage.forms and not storage.heads and not dispatcher.calls
    store.row = row("succeeded")
    response = request(app, "GET", PATH + f"/jobs/{JOB}", request_headers=headers())
    assert response.status_code == 200
    assert (
        request(app, "GET", PATH + "/capabilities", request_headers=headers()).json()["configured"]
        is False
    )
    assert all(call[1] == TenantContext(USER_ID, ORG_ID) for call in store.calls)


@pytest.mark.parametrize(
    "change",
    [
        {"code": "do not execute in API"},
        {"image": "sha256:" + SHA},
        {"layer_ids": ["selected", "selected"]},
        {"source_bindings": [{"layer_id": "unselected", "dataset_id": str(DATASET)}]},
        {
            "source_bindings": [
                {"layer_id": "selected", "dataset_id": str(DATASET), "source_version": True}
            ]
        },
    ],
)
def test_api_accepts_only_small_closed_metadata_descriptors(change):
    app, store, storage, _ = setup()
    response = request(
        app, "POST", PATH + "/jobs", request_headers=headers(), json_body={**payload(), **change}
    )
    assert response.status_code == 422
    assert not store.calls and not storage.forms


def test_oversize_descriptor_rejected_before_store_and_recovery_reuses_only_upload_ticket():
    app, store, storage, dispatcher = setup()
    too_large = {**payload(), "code": "x" * 17000}
    assert (
        request(
            app, "POST", PATH + "/jobs", request_headers=headers(), json_body=too_large
        ).status_code
        == 413
    )
    assert not store.calls
    created = request(app, "POST", PATH + "/jobs", request_headers=headers(), json_body=payload())
    recovered = request(app, "GET", PATH + f"/jobs?request_key={KEY}", request_headers=headers())
    assert created.json()["upload"] == recovered.json()["upload"]
    assert len(storage.forms) == 2 and storage.forms[0] == storage.forms[1]
    assert storage.forms[0].key == PREFIX + "snapshot.json"
    assert storage.forms[0].checksum_sha256 == SHA and storage.forms[0].size_bytes == 1234
    polled = request(app, "GET", PATH + f"/jobs/{JOB}", request_headers=headers()).json()
    assert "upload" not in polled and "snapshot" not in polled
    assert not storage.heads and not dispatcher.calls
    assert len([call for call in store.calls if call[0] == "create"]) == 1


@pytest.mark.parametrize(
    "change",
    [{"version_id": "null"}, {"checksum_sha256": "e" * 64}, {"size_bytes": 1235}, {"key": "other"}],
)
def test_submit_rejects_unversioned_or_mismatched_objects_before_reservation(change):
    app, store, storage, dispatcher = setup()
    storage.stored = replace(storage.stored, **change)
    response = request(app, "POST", PATH + f"/jobs/{JOB}/submit", request_headers=headers())
    assert response.status_code == 409 and response.json()["detail"] == "analysis_snapshot_mismatch"
    assert not dispatcher.calls and not any(call[0] == "submit" for call in store.calls)


def test_unknown_upload_and_dispatch_recovery_do_not_repeat_head_snapshot_or_new_job():
    app, store, storage, dispatcher = setup()
    saved = storage.stored
    storage.stored = None
    response = request(app, "POST", PATH + f"/jobs/{JOB}/submit", request_headers=headers())
    assert (
        response.status_code == 409
        and response.json()["detail"] == "analysis_snapshot_not_uploaded"
    )
    storage.stored = saved
    dispatcher.fail = True
    first = request(app, "POST", PATH + f"/jobs/{JOB}/submit", request_headers=headers())
    assert first.status_code == 202 and first.json()["dispatch_pending"] is True
    dispatcher.fail = False
    second = request(app, "POST", PATH + f"/jobs/{JOB}/submit", request_headers=headers())
    assert second.json()["state"] == "pending" and dispatcher.calls == [JOB, JOB]
    assert len(storage.heads) == 2  # one missing upload, one immutable freeze
    assert len([call for call in store.calls if call[0] == "submit"]) == 1
    assert not storage.forms


def test_cancel_remains_minimal_after_revocation_and_private_results_require_clean_cleanup():
    app, store, storage, _ = setup()
    store.revoked = True
    assert request(app, "GET", PATH + f"/jobs/{JOB}", request_headers=headers()).status_code == 403
    cancelled = request(app, "POST", PATH + f"/jobs/{JOB}/cancel", request_headers=headers())
    assert cancelled.status_code == 200 and cancelled.json()["cleanup_required"] is True
    assert "snapshot" not in cancelled.text and "provenance" not in cancelled.text
    store.revoked = False
    store.row = {
        **row("failed"),
        "result": {
            "bucket": storage.bucket,
            "key": PREFIX + "result.json",
            "version_id": "result-v1",
            "size_bytes": 100,
            "checksum_sha256": SHA,
        },
        "cleanup": {
            "cleanup_required": True,
            "container_removed": False,
            "staging_removed": False,
            "container_name": "private-host-name",
            "staging_directory": "/private/worker",
            "output_uncommitted": {"key": "private-object"},
        },
    }
    poll = request(app, "GET", PATH + f"/jobs/{JOB}", request_headers=headers())
    assert poll.json()["result_available"] is False and poll.json()["cleanup_required"] is True
    assert "private-" not in poll.text and "/private/" not in poll.text
    assert (
        request(app, "GET", PATH + f"/jobs/{JOB}/result", request_headers=headers()).status_code
        == 409
    )
    store.row["cleanup"] = row()["cleanup"]
    result = request(app, "GET", PATH + f"/jobs/{JOB}/result", request_headers=headers())
    assert result.status_code == 200 and result.json()["method"] == "GET"
    assert storage.downloads[0].version_id == "result-v1" and storage.downloads[0].ttl_seconds == 60


def test_profiles_are_operator_only_pinned_closed_and_queue_uses_uuid_only():
    assert parse_runtime_profiles(json.dumps(PROFILES)) == PROFILES
    for invalid in (
        {**PROFILES, "shell": "anything"},
        {**PROFILES, "architecture": "anything"},
        {**PROFILES, "profiles": {"python": {"image": "latest", "interpreter": "bash"}}},
    ):
        with pytest.raises(ValueError):
            parse_runtime_profiles(json.dumps(invalid))
    configured = managed_settings()
    transport = Transport()
    wake = WakeTransport()
    dispatcher = AwsSqsAnalysisDispatcher(
        configured, credentials=Credentials(), transport=transport,
        wake_transport=wake, now=lambda: NOW,
    )
    asyncio.run(dispatcher.dispatch_analysis(JOB))
    message = json.loads(parse_qs(transport.calls[0][2].decode())["MessageBody"][0])
    assert message == {"schemaVersion": "opengeo.analysis.command.1", "analysis_job_id": str(JOB)}
    assert len(transport.calls) == 1
    assert len(wake.calls) == 1
    method, url, signed, body, timeout, maximum = wake.calls[0]
    assert method == "POST"
    assert url == (
        "https://lambda.us-east-1.amazonaws.com/2015-03-31/functions/"
        "arn%3Aaws%3Alambda%3Aus-east-1%3A111111111111%3Afunction%3A"
        "opengeo-dev-analysis-controller/invocations"
    )
    assert json.loads(body) == {"schema": "opengeo.analysis-runtime.wake.1"}
    assert signed["x-amz-invocation-type"] == "Event"
    assert "/us-east-1/lambda/aws4_request" in signed["authorization"]
    assert "x-amz-invocation-type" in signed["authorization"]
    assert (timeout, maximum) == (5.0, 4096)


def test_managed_wake_requires_complete_default_off_operator_configuration():
    configured = managed_settings()
    assert configured.analysis_dispatch_configured
    for missing in (
        "analysis_controller_function_arn", "analysis_queue_url", "analysis_runtime_profiles",
    ):
        incomplete = configured.model_copy(update={missing: None})
        assert not incomplete.analysis_dispatch_configured
        assert not AnalysisConfiguration.from_settings(incomplete).configured
        with pytest.raises(ValueError, match="must be configured"):
            AwsSqsAnalysisDispatcher(incomplete)
    assert not settings().analysis_dispatch_configured
    assert not configured.model_copy(
        update={"analysis_enabled": False}
    ).analysis_dispatch_configured
    for stage in ("dev", "staging", "demo", "production"):
        value = Settings.model_validate({
            **configured.model_dump(),
            "analysis_controller_function_arn": CONTROLLER.replace("-dev-", f"-{stage}-"),
        })
        assert value.analysis_dispatch_configured


def test_analysis_storage_uses_application_bucket_and_missing_bucket_disables_jobs(monkeypatch):
    def no_network(*args, **kwargs):
        raise AssertionError("Application construction must not access credentials or the network")

    monkeypatch.setattr("socket.create_connection", no_network)
    monkeypatch.setattr("opengeo_api.cognito_provisioning.AwsCredentialProvider.load", no_network)
    configured = managed_settings()
    app = create_app(settings=configured)
    assert app.state.analysis_configuration.configured
    assert app.state.analysis_upload_storage.bucket == configured.application_bucket
    assert app.state.analysis_download_storage._bucket == configured.application_bucket
    assert app.state.download_storage._bucket == configured.geodata_bucket
    assert app.state.ingestion_repository._storage.bucket == configured.geodata_bucket
    assert configured.application_bucket != configured.geodata_bucket
    missing = configured.model_copy(update={"application_bucket": None})
    assert not missing.analysis_dispatch_configured
    unavailable = create_app(settings=missing)
    assert not unavailable.state.analysis_configuration.configured
    assert not unavailable.state.analysis_dispatcher.available
    with pytest.raises(ValidationError, match="application_bucket is invalid"):
        Settings.model_validate({**configured.model_dump(), "application_bucket": ""})


@pytest.mark.parametrize("change", [
    {"analysis_controller_function_arn": CONTROLLER.replace("111111111111", "222222222222")},
    {"analysis_controller_function_arn": CONTROLLER.replace("us-east-1", "us-west-2")},
    {"analysis_controller_function_arn": CONTROLLER + ":latest"},
    {"analysis_controller_function_arn": CONTROLLER.replace(
        "analysis-controller", "worker-controller",
    )},
    {"analysis_controller_function_arn": CONTROLLER.replace("-dev-", "-*-")},
    {"analysis_queue_url": None},
])
def test_wake_target_rejects_other_accounts_regions_or_unbounded_functions(change):
    with pytest.raises(ValidationError, match="same-account regional analysis controller"):
        Settings.model_validate({**managed_settings().model_dump(), **change})


def test_failed_queue_send_never_wakes_and_construction_does_no_io():
    transport, wake = Transport(status=503), WakeTransport()
    dispatcher = AwsSqsAnalysisDispatcher(managed_settings(), credentials=Credentials(),
                                         transport=transport, wake_transport=wake)
    assert dispatcher.available and not transport.calls and not wake.calls
    with pytest.raises(ProcessingDispatchUnavailable):
        asyncio.run(dispatcher.dispatch_analysis(JOB))
    assert len(transport.calls) == 1 and not wake.calls


@pytest.mark.parametrize("response", [
    (200, {}, b""), (503, {}, b""), (202, {}, b"x" * 4097),
    (202, {"X-Amz-Function-Error": "rejected"}, b""),
    TimeoutError("uncertain"), DatasetVerificationDependencyUnavailable("unreachable"),
])
def test_wake_rejection_or_uncertainty_is_not_retried(response):
    transport, wake = Transport(), WakeTransport([response])
    dispatcher = AwsSqsAnalysisDispatcher(managed_settings(), credentials=Credentials(),
                                         transport=transport, wake_transport=wake)
    with pytest.raises(ProcessingDispatchUnavailable, match="managed analysis wake"):
        asyncio.run(dispatcher.dispatch_analysis(JOB))
    assert len(transport.calls) == len(wake.calls) == 1


def test_wake_credential_failure_retains_sent_job_without_another_request():
    class FailingCredentials:
        loads = 0

        def load(self):
            self.loads += 1
            if self.loads > 1:
                raise IdentityProvisioningUnavailable("unavailable")
            return Credentials().load()

    transport, wake, credentials = Transport(), WakeTransport(), FailingCredentials()
    dispatcher = AwsSqsAnalysisDispatcher(managed_settings(), credentials=credentials,
                                         transport=transport, wake_transport=wake)
    with pytest.raises(ProcessingDispatchUnavailable, match="managed analysis wake"):
        asyncio.run(dispatcher.dispatch_analysis(JOB))
    assert len(transport.calls) == 1 and not wake.calls and credentials.loads == 2


def test_explicit_retry_after_wake_failure_reuses_frozen_job_and_read_cancel_do_not_wake():
    app, store, storage, _ = setup()
    transport, wake = Transport(), WakeTransport([(503, {}, b""), (202, {}, b"")])
    app.state.analysis_dispatcher = AwsSqsAnalysisDispatcher(
        managed_settings(), credentials=Credentials(), transport=transport, wake_transport=wake,
    )
    first = request(app, "POST", PATH + f"/jobs/{JOB}/submit", request_headers=headers())
    assert first.status_code == 202 and first.json()["state"] == "dispatch_pending"
    assert first.json()["dispatch_pending"] is True
    assert not any(call[0] == "dispatched" for call in store.calls)
    second = request(app, "POST", PATH + f"/jobs/{JOB}/submit", request_headers=headers())
    assert second.json()["state"] == "pending"
    assert len(transport.calls) == len(wake.calls) == 2
    assert len(storage.heads) == 1 and not storage.forms
    assert len([call for call in store.calls if call[0] == "submit"]) == 1
    assert not any(call[0] == "create" for call in store.calls)
    for queue, invocation in zip(transport.calls, wake.calls, strict=True):
        message = json.loads(parse_qs(queue[2].decode())["MessageBody"][0])
        assert message["analysis_job_id"] == str(JOB)
        assert json.loads(invocation[3]) == {"schema": "opengeo.analysis-runtime.wake.1"}
    request(app, "GET", PATH + "/capabilities", request_headers=headers())
    request(app, "GET", PATH + f"/jobs/{JOB}", request_headers=headers())
    request(app, "POST", PATH + f"/jobs/{JOB}/cancel", request_headers=headers())
    assert len(transport.calls) == len(wake.calls) == 2


def test_repository_keeps_tenant_context_and_maps_sql_authority_errors():
    class Transaction:
        def __init__(self):
            self.result = {"error": "analysis_forbidden"}
            self.calls = []

        async def fetch_one(self, sql, parameters=()):
            self.calls.append((sql, parameters))
            return (self.result,)

    class Executor:
        tx = Transaction()

        async def run(self, context, operation):
            assert context == TenantContext(USER_ID, ORG_ID)
            return await operation(self.tx)

    executor = Executor()
    repo = PostgresAnalysisJobRepository(executor)
    with pytest.raises(AnalysisAccessDenied):
        asyncio.run(repo.get(TenantContext(USER_ID, ORG_ID), PROJECT_ID, JOB))
    assert executor.tx.calls == [("SELECT app.read_analysis_job(%s,%s)", (PROJECT_ID, JOB))]
    executor.tx.result = {"error": "analysis_request_conflict"}
    with pytest.raises(AnalysisConflict, match="analysis_request_conflict"):
        asyncio.run(repo.find(TenantContext(USER_ID, ORG_ID), PROJECT_ID, KEY))
