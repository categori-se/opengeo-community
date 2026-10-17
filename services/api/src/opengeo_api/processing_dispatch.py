import asyncio
import hashlib
import hmac
import json
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID
from xml.etree import ElementTree

from opengeo_api.cognito_provisioning import (
    AwsCredentialProvider,
    AwsCredentials,
    CredentialProvider,
    IdentityProvisioningUnavailable,
)
from opengeo_api.config import Settings
from opengeo_api.user_dataset_verification_runtime import (
    AwsJsonTransport,
    DatasetVerificationDependencyUnavailable,
    UrlAwsTransport,
    _signed_headers,
)


class ProcessingDispatchUnavailable(RuntimeError):
    pass


class RenderDispatcher(Protocol):
    async def dispatch_render(self, job_id: UUID) -> None: ...

    async def dispatch_coverage_derivative(self, job_id: UUID) -> None: ...

    async def dispatch_coverage_derivative_reclamation(self, reclamation_id: UUID) -> None: ...

    async def dispatch_tile_cache_reclamation(self, reclamation_id: UUID) -> None: ...


class ConnectionVerificationDispatcher(Protocol):
    @property
    def available(self) -> bool: ...

    async def dispatch_connection_verification(self, verification_id: UUID) -> None: ...

    @property
    def catalog_available(self) -> bool: ...

    async def dispatch_connection_catalog_discovery(self, discovery_id: UUID) -> None: ...


class UserDatasetVerificationDispatcher(Protocol):
    @property
    def available(self) -> bool: ...

    async def dispatch_user_dataset_verification(self, verification_id: UUID) -> None: ...


class AnalysisDispatcher(Protocol):
    @property
    def available(self) -> bool: ...

    async def dispatch_analysis(self, job_id: UUID) -> None: ...


class UnavailableAnalysisDispatcher:
    @property
    def available(self) -> bool:
        return False

    async def dispatch_analysis(self, job_id: UUID) -> None:
        del job_id
        raise ProcessingDispatchUnavailable("managed analysis dispatch is not configured")


class ObservableBuildDispatcher(Protocol):
    @property
    def available(self) -> bool: ...

    async def dispatch_observable_build(self, build_job_id: UUID) -> None: ...


class ExternalSourceSnapshotDispatcher(Protocol):
    @property
    def available(self) -> bool: ...

    async def dispatch_external_source_snapshot(self, snapshot_job_id: UUID) -> None: ...


class RepositoryObjectCopyDispatcher(Protocol):
    @property
    def available(self) -> bool: ...

    async def dispatch_repository_object_copy(self, copy_job_id: UUID) -> None: ...


class ExternalSourceDiscoveryDispatcher(Protocol):
    @property
    def available(self) -> bool: ...

    async def dispatch_external_source_discovery(self, discovery_job_id: UUID) -> None: ...


class GeoNodeHarvestDispatcher(Protocol):
    @property
    def available(self) -> bool: ...

    async def dispatch_geonode_harvest(self, harvest_job_id: UUID) -> None: ...


class PmtilesDerivativeDispatcher(Protocol):
    @property
    def available(self) -> bool: ...

    @property
    def v2_only(self) -> bool: ...

    def supports_recipe(self, recipe: str) -> bool: ...

    async def dispatch_pmtiles_derivative(self, pmtiles_job_id: UUID) -> None: ...


class UnavailableConnectionVerificationDispatcher:
    @property
    def catalog_available(self) -> bool:
        return False

    async def dispatch_connection_catalog_discovery(self, discovery_id: UUID) -> None:
        del discovery_id
        raise ProcessingDispatchUnavailable("connection catalog dispatch is not configured")

    @property
    def available(self) -> bool:
        return False

    async def dispatch_connection_verification(self, verification_id: UUID) -> None:
        del verification_id
        raise ProcessingDispatchUnavailable("connection verification dispatch is not configured")


class UnavailableUserDatasetVerificationDispatcher:
    @property
    def available(self) -> bool:
        return False

    async def dispatch_user_dataset_verification(self, verification_id: UUID) -> None:
        del verification_id
        raise ProcessingDispatchUnavailable("user dataset verification dispatch is not configured")


class UnavailableObservableBuildDispatcher:
    @property
    def available(self) -> bool:
        return False

    async def dispatch_observable_build(self, build_job_id: UUID) -> None:
        del build_job_id
        raise ProcessingDispatchUnavailable("Observable build dispatch is not configured")


class UnavailableExternalSourceSnapshotDispatcher:
    @property
    def available(self) -> bool:
        return False

    async def dispatch_external_source_snapshot(self, snapshot_job_id: UUID) -> None:
        del snapshot_job_id
        raise ProcessingDispatchUnavailable("external source snapshot dispatch is not configured")


class UnavailableRepositoryObjectCopyDispatcher:
    @property
    def available(self) -> bool:
        return False

    async def dispatch_repository_object_copy(self, copy_job_id: UUID) -> None:
        del copy_job_id
        raise ProcessingDispatchUnavailable("repository object copy dispatch is not configured")


class UnavailableExternalSourceDiscoveryDispatcher:
    @property
    def available(self) -> bool:
        return False

    async def dispatch_external_source_discovery(self, discovery_job_id: UUID) -> None:
        del discovery_job_id
        raise ProcessingDispatchUnavailable("external source discovery dispatch is not configured")


class UnavailableGeoNodeHarvestDispatcher:
    @property
    def available(self) -> bool:
        return False

    async def dispatch_geonode_harvest(self, harvest_job_id: UUID) -> None:
        del harvest_job_id
        raise ProcessingDispatchUnavailable("GeoNode harvest dispatch is not configured")


class UnavailablePmtilesDerivativeDispatcher:
    def supports_recipe(self, recipe: str) -> bool:
        del recipe
        return False

    @property
    def v2_only(self) -> bool:
        return False

    @property
    def available(self) -> bool:
        return False

    async def dispatch_pmtiles_derivative(self, pmtiles_job_id: UUID) -> None:
        del pmtiles_job_id
        raise ProcessingDispatchUnavailable("PMTiles derivative dispatch is not configured")


class UnavailableRenderDispatcher:
    async def dispatch_render(self, job_id: UUID) -> None:
        del job_id
        raise ProcessingDispatchUnavailable("render dispatch is not configured")

    async def dispatch_coverage_derivative(self, job_id: UUID) -> None:
        del job_id
        raise ProcessingDispatchUnavailable("coverage derivative dispatch is not configured")

    async def dispatch_coverage_derivative_reclamation(self, reclamation_id: UUID) -> None:
        del reclamation_id
        raise ProcessingDispatchUnavailable(
            "coverage derivative reclamation dispatch is not configured"
        )

    async def dispatch_tile_cache_reclamation(self, reclamation_id: UUID) -> None:
        del reclamation_id
        raise ProcessingDispatchUnavailable("tile cache reclamation dispatch is not configured")


class DispatchTransport(Protocol):
    def call(
        self,
        url: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout_seconds: float,
    ) -> tuple[int, bytes]: ...


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args: object, **kwargs: object) -> None:
        del args, kwargs
        return None


class UrlDispatchTransport:
    def __init__(self) -> None:
        self._opener = build_opener(_NoRedirect)

    def call(
        self,
        url: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout_seconds: float,
    ) -> tuple[int, bytes]:
        request = Request(url, data=body, headers=dict(headers), method="POST")
        try:
            with self._opener.open(request, timeout=timeout_seconds) as response:
                return response.status, response.read(65_537)
        except HTTPError as error:
            return error.code, error.read(65_537)
        except (URLError, TimeoutError, OSError) as error:
            raise ProcessingDispatchUnavailable("processing queue is unavailable") from error


class AwsSqsRenderDispatcher:
    """Send one bounded, identity-only render command to the existing idle SQS queue."""

    def __init__(
        self,
        settings: Settings,
        credentials: CredentialProvider | None = None,
        transport: DispatchTransport | None = None,
        now: Callable[[], datetime] | None = None,
        queue_url: str | None = None,
    ) -> None:
        selected_queue_url = queue_url or settings.processing_queue_url
        if settings.aws_region is None or selected_queue_url is None:
            raise ValueError("render dispatch must be configured")
        assert settings.aws_region is not None
        parsed = urlsplit(selected_queue_url)
        self._region = settings.aws_region
        self._url = selected_queue_url
        self._host = parsed.netloc
        self._path = parsed.path
        self._timeout = settings.cognito_http_timeout_seconds
        self._credentials = credentials or AwsCredentialProvider(
            timeout_seconds=settings.cognito_http_timeout_seconds
        )
        self._transport = transport or UrlDispatchTransport()
        self._now = now or (lambda: datetime.now(UTC))

    async def dispatch_render(self, job_id: UUID) -> None:
        await asyncio.to_thread(
            self._dispatch, "opengeo.render.command.v1", "render_job_id", job_id
        )

    async def dispatch_coverage_derivative(self, job_id: UUID) -> None:
        await asyncio.to_thread(
            self._dispatch,
            "opengeo.coverage-derivative.command.v1",
            "coverage_derivative_job_id",
            job_id,
        )

    async def dispatch_coverage_derivative_reclamation(self, reclamation_id: UUID) -> None:
        await asyncio.to_thread(
            self._dispatch,
            "opengeo.coverage-derivative-reclamation.command.v1",
            "coverage_derivative_reclamation_id",
            reclamation_id,
        )

    async def dispatch_tile_cache_reclamation(self, reclamation_id: UUID) -> None:
        await asyncio.to_thread(
            self._dispatch,
            "opengeo.render-cache-reclamation.command.v1",
            "render_cache_reclamation_id",
            reclamation_id,
        )

    def _dispatch(
        self, schema: str, identifier_key: str, job_id: UUID, schema_key: str = "schema"
    ) -> None:
        message = json.dumps(
            {schema_key: schema, identifier_key: str(job_id)},
            separators=(",", ":"),
            sort_keys=True,
        )
        root = self._queue_request({"Action": "SendMessage", "MessageBody": message})
        message_id = next(
            (
                element.text
                for element in root.iter()
                if element.tag.rsplit("}", 1)[-1] == "MessageId"
            ),
            None,
        )
        if not message_id or not 1 <= len(message_id) <= 128:
            raise ProcessingDispatchUnavailable("processing queue returned no message id")

    async def change_visibility(self, receipt_handle: str, seconds: int) -> None:
        if (
            not isinstance(receipt_handle, str)
            or not 1 <= len(receipt_handle) <= 4096
            or type(seconds) is not int
            or not 0 <= seconds <= 43200
        ):
            raise ValueError("invalid queue visibility request")
        await asyncio.to_thread(
            self._queue_request,
            {
                "Action": "ChangeMessageVisibility",
                "ReceiptHandle": receipt_handle,
                "VisibilityTimeout": str(seconds),
            },
        )

    async def dispatch_framework_publication(self, review_id: UUID) -> None:
        await asyncio.to_thread(
            self._dispatch, "opengeo.framework-publication.command.1.0.0", "review_id", review_id
        )

    async def dispatch_github_source_sync(self, revision_id: UUID) -> None:
        await asyncio.to_thread(
            self._dispatch,
            "opengeo.github-source-sync.command.1.0.0",
            "source_revision_id",
            revision_id,
        )

    def _queue_request(self, fields: dict[str, str]) -> ElementTree.Element:
        body = urlencode({**fields, "Version": "2012-11-05"}).encode()
        payload_hash = hashlib.sha256(body).hexdigest()
        timestamp = self._now().astimezone(UTC)
        amz_date = timestamp.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = timestamp.strftime("%Y%m%d")
        try:
            credentials = self._credentials.load()
        except IdentityProvisioningUnavailable as error:
            raise ProcessingDispatchUnavailable("AWS credentials are unavailable") from error
        canonical = {
            "content-type": "application/x-www-form-urlencoded; charset=utf-8",
            "host": self._host,
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": amz_date,
        }
        if credentials.session_token:
            canonical["x-amz-security-token"] = credentials.session_token
        signed_names = ";".join(sorted(canonical))
        canonical_headers = "".join(f"{name}:{canonical[name]}\n" for name in sorted(canonical))
        canonical_request = "\n".join(
            ["POST", self._path, "", canonical_headers, signed_names, payload_hash]
        )
        scope = f"{date_stamp}/{self._region}/sqs/aws4_request"
        string_to_sign = "\n".join(
            [
                "AWS4-HMAC-SHA256",
                amz_date,
                scope,
                hashlib.sha256(canonical_request.encode()).hexdigest(),
            ]
        )
        signature = hmac.new(
            self._signing_key(credentials, date_stamp),
            string_to_sign.encode(),
            hashlib.sha256,
        ).hexdigest()
        headers = {
            **canonical,
            "authorization": (
                "AWS4-HMAC-SHA256 "
                f"Credential={credentials.access_key_id}/{scope}, "
                f"SignedHeaders={signed_names}, Signature={signature}"
            ),
        }
        status, response = self._transport.call(self._url, headers, body, self._timeout)
        if status != 200 or len(response) > 65_536:
            raise ProcessingDispatchUnavailable("processing queue rejected the render command")
        try:
            root = ElementTree.fromstring(response)
        except ElementTree.ParseError as error:
            raise ProcessingDispatchUnavailable("processing queue returned invalid XML") from error
        return root

    def _signing_key(self, credentials: AwsCredentials, date_stamp: str) -> bytes:
        date_key = hmac.new(
            f"AWS4{credentials.secret_access_key}".encode(),
            date_stamp.encode(),
            hashlib.sha256,
        ).digest()
        region_key = hmac.new(date_key, self._region.encode(), hashlib.sha256).digest()
        service_key = hmac.new(region_key, b"sqs", hashlib.sha256).digest()
        return hmac.new(service_key, b"aws4_request", hashlib.sha256).digest()


class AwsSqsConnectionVerificationDispatcher:
    def __init__(
        self,
        settings: Settings,
        credentials: CredentialProvider | None = None,
        transport: DispatchTransport | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if not settings.connection_verification_dispatch_configured:
            raise ValueError("connection verification dispatch must be configured")
        assert settings.connection_verification_queue_url is not None
        self._catalog_available = settings.connection_catalog_discovery_enabled
        self._delegate = AwsSqsRenderDispatcher(
            settings,
            credentials=credentials,
            transport=transport,
            now=now,
            queue_url=settings.connection_verification_queue_url,
        )

    @property
    def available(self) -> bool:
        return True

    async def dispatch_connection_verification(self, verification_id: UUID) -> None:
        await asyncio.to_thread(
            self._delegate._dispatch,
            "opengeo.connection-verification.command.v1",
            "verification_id",
            verification_id,
        )

    @property
    def catalog_available(self) -> bool:
        return self._catalog_available

    async def dispatch_connection_catalog_discovery(self, discovery_id: UUID) -> None:
        if not self.catalog_available:
            raise ProcessingDispatchUnavailable("connection catalog dispatch is not configured")
        await asyncio.to_thread(
            self._delegate._dispatch,
            "opengeo.connection-catalog-discovery.command.v1",
            "discovery_id",
            discovery_id,
        )


class AwsSqsUserDatasetVerificationDispatcher:
    def __init__(
        self,
        settings: Settings,
        credentials: CredentialProvider | None = None,
        transport: DispatchTransport | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if not settings.user_dataset_verification_dispatch_configured:
            raise ValueError("user dataset verification dispatch must be configured")
        assert settings.user_dataset_verification_queue_url is not None
        self._delegate = AwsSqsRenderDispatcher(
            settings,
            credentials=credentials,
            transport=transport,
            now=now,
            queue_url=settings.user_dataset_verification_queue_url,
        )

    @property
    def available(self) -> bool:
        return True

    async def dispatch_user_dataset_verification(self, verification_id: UUID) -> None:
        await asyncio.to_thread(
            self._delegate._dispatch,
            "opengeo.user-dataset-verification.command.v1",
            "verification_id",
            verification_id,
        )


class AwsSqsAnalysisDispatcher:
    def __init__(self, settings: Settings, credentials: CredentialProvider | None = None,
                 transport: DispatchTransport | None = None,
                 now: Callable[[], datetime] | None = None,
                 wake_transport: AwsJsonTransport | None = None) -> None:
        if not settings.analysis_dispatch_configured:
            raise ValueError("managed analysis dispatch must be configured")
        assert settings.aws_region is not None
        assert settings.analysis_controller_function_arn is not None
        self._region = settings.aws_region
        self._function_arn = settings.analysis_controller_function_arn
        self._credentials = credentials or AwsCredentialProvider(timeout_seconds=5.0)
        self._now = now or (lambda: datetime.now(UTC))
        self._wake_transport = wake_transport or UrlAwsTransport()
        self._delegate = AwsSqsRenderDispatcher(settings, credentials=self._credentials,
            transport=transport, now=self._now, queue_url=settings.analysis_queue_url)

    @property
    def available(self) -> bool:
        return True

    async def dispatch_analysis(self, job_id: UUID) -> None:
        await asyncio.to_thread(self._delegate._dispatch,
                               "opengeo.analysis.command.1", "analysis_job_id", job_id,
                               "schemaVersion")
        # The SQL submission already froze and budgeted this exact job. Wake only
        # after its identity is queued; an uncertain response leaves dispatch_pending
        # for deliberate same-job recovery, never another snapshot or reservation.
        await asyncio.to_thread(self._wake)

    def _wake(self) -> None:
        body = b'{"schema":"opengeo.analysis-runtime.wake.1"}'
        host = f"lambda.{self._region}.amazonaws.com"
        function = quote(self._function_arn, safe="-_.~")
        path = f"/2015-03-31/functions/{function}/invocations"
        try:
            headers = _signed_headers(
                method="POST", canonical_uri=path, canonical_query="", host=host,
                region=self._region, service="lambda", credentials=self._credentials.load(),
                body=body, now=self._now(), extra_headers={
                    "content-type": "application/json", "x-amz-invocation-type": "Event",
                },
            )
            status, response_headers, response = self._wake_transport.call(
                "POST", f"https://{host}{path}", headers, body, 5.0, 4096,
            )
        except (IdentityProvisioningUnavailable, DatasetVerificationDependencyUnavailable,
                TimeoutError, OSError) as error:
            raise ProcessingDispatchUnavailable("managed analysis wake is unavailable") from error
        if (status != 202 or len(response) > 4096
                or "x-amz-function-error" in {key.lower() for key in response_headers}):
            raise ProcessingDispatchUnavailable("managed analysis wake was not accepted")


class AwsSqsObservableBuildDispatcher:
    def __init__(
        self,
        settings: Settings,
        credentials: CredentialProvider | None = None,
        transport: DispatchTransport | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if not settings.observable_build_dispatch_configured:
            raise ValueError("Observable build dispatch must be configured")
        assert settings.observable_build_queue_url is not None
        self._delegate = AwsSqsRenderDispatcher(
            settings,
            credentials=credentials,
            transport=transport,
            now=now,
            queue_url=settings.observable_build_queue_url,
        )

    @property
    def available(self) -> bool:
        return True

    async def dispatch_observable_build(self, build_job_id: UUID) -> None:
        await asyncio.to_thread(
            self._delegate._dispatch,
            "opengeo.observable-build.command.1.0.0",
            "build_job_id",
            build_job_id,
        )


class AwsSqsExternalSourceSnapshotDispatcher:
    def __init__(
        self,
        settings: Settings,
        credentials: CredentialProvider | None = None,
        transport: DispatchTransport | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if not settings.external_source_snapshot_dispatch_configured:
            raise ValueError("external source snapshot dispatch must be configured")
        assert settings.external_source_snapshot_queue_url is not None
        self._delegate = AwsSqsRenderDispatcher(
            settings,
            credentials=credentials,
            transport=transport,
            now=now,
            queue_url=settings.external_source_snapshot_queue_url,
        )

    @property
    def available(self) -> bool:
        return True

    async def dispatch_external_source_snapshot(self, snapshot_job_id: UUID) -> None:
        await asyncio.to_thread(
            self._delegate._dispatch,
            "opengeo.external-source-snapshot.command.1.0.0",
            "snapshot_job_id",
            snapshot_job_id,
        )


class AwsSqsRepositoryObjectCopyDispatcher:
    def __init__(
        self,
        settings: Settings,
        credentials: CredentialProvider | None = None,
        transport: DispatchTransport | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if not settings.repository_object_copy_dispatch_configured:
            raise ValueError("repository object copy dispatch must be configured")
        assert settings.repository_object_copy_queue_url is not None
        self._delegate = AwsSqsRenderDispatcher(
            settings,
            credentials=credentials,
            transport=transport,
            now=now,
            queue_url=settings.repository_object_copy_queue_url,
        )

    @property
    def available(self) -> bool:
        return True

    async def dispatch_repository_object_copy(self, copy_job_id: UUID) -> None:
        await asyncio.to_thread(
            self._delegate._dispatch,
            "opengeo.repository-object-copy.command.1.0.0",
            "copy_job_id",
            copy_job_id,
        )


class AwsSqsExternalSourceDiscoveryDispatcher:
    def __init__(
        self,
        settings: Settings,
        credentials: CredentialProvider | None = None,
        transport: DispatchTransport | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if not settings.external_source_discovery_dispatch_configured:
            raise ValueError("external source discovery dispatch must be configured")
        queue_url = settings.effective_external_source_discovery_queue_url
        assert queue_url is not None
        self._delegate = AwsSqsRenderDispatcher(
            settings,
            credentials=credentials,
            transport=transport,
            now=now,
            queue_url=queue_url,
        )

    @property
    def available(self) -> bool:
        return True

    async def dispatch_external_source_discovery(self, discovery_job_id: UUID) -> None:
        await asyncio.to_thread(
            self._delegate._dispatch,
            "opengeo.external-source-discovery.command.1.0.0",
            "discovery_job_id",
            discovery_job_id,
        )


class AwsSqsGeoNodeHarvestDispatcher:
    def __init__(
        self,
        settings: Settings,
        credentials: CredentialProvider | None = None,
        transport: DispatchTransport | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if not settings.external_source_snapshot_dispatch_configured:
            raise ValueError("GeoNode harvest dispatch must be configured")
        assert settings.external_source_snapshot_queue_url is not None
        self._delegate = AwsSqsRenderDispatcher(
            settings,
            credentials=credentials,
            transport=transport,
            now=now,
            queue_url=settings.external_source_snapshot_queue_url,
        )

    @property
    def available(self) -> bool:
        return True

    async def dispatch_geonode_harvest(self, harvest_job_id: UUID) -> None:
        await asyncio.to_thread(
            self._delegate._dispatch,
            "opengeo.geonode-harvest.command.1.0.0",
            "harvest_job_id",
            harvest_job_id,
        )


class AwsSqsPmtilesDerivativeDispatcher:
    def supports_recipe(self, recipe: str) -> bool:
        return recipe == "gdal-pmtiles-v2"

    @property
    def v2_only(self) -> bool:
        return True

    def __init__(
        self,
        settings: Settings,
        credentials: CredentialProvider | None = None,
        transport: DispatchTransport | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if not settings.pmtiles_derivative_dispatch_configured:
            raise ValueError("PMTiles derivative dispatch must be configured")
        self._delegate = AwsSqsRenderDispatcher(
            settings,
            credentials=credentials,
            transport=transport,
            now=now,
            queue_url=settings.pmtiles_derivative_queue_url,
        )

    @property
    def available(self) -> bool:
        return True

    async def dispatch_pmtiles_derivative(self, pmtiles_job_id: UUID) -> None:
        await asyncio.to_thread(
            self._delegate._dispatch,
            "opengeo.pmtiles-derivative.command.v1",
            "pmtiles_derivative_job_id",
            pmtiles_job_id,
        )
