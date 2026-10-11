import asyncio
import hashlib
import hmac
import json
import os
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol, cast
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID, uuid4
from xml.etree import ElementTree

from opengeo_api.cognito_provisioning import (
    AwsCredentialProvider,
    AwsCredentials,
    CredentialProvider,
    IdentityProvisioningUnavailable,
)
from opengeo_api.config import Settings
from opengeo_api.rds_data import DataApiResult, RdsDataApiClient, RdsDataApiUnavailable
from opengeo_api.s3_endpoints import bucket_path, object_path, regional_s3_host

_COMMAND_SCHEMA = "opengeo.user-dataset-verification.command.v1"
_MAX_COMMAND_BYTES = 512
_INVALID_EXTERNAL_ID_CANARY = "opengeo-deny-canary-invalid-external-id-v1"
_ERROR_CODES = frozenset(
    {
        "assume_role_denied",
        "bucket_access_denied",
        "credentials_rejected",
        "deny_canary_failed",
        "object_access_denied",
        "region_mismatch",
        "secret_invalid",
        "verification_failed",
        "verification_timeout",
    }
)


class DatasetVerificationCommandInvalid(RuntimeError):
    pass


class DatasetVerificationDependencyUnavailable(RuntimeError):
    pass


class DatasetVerificationRejected(RuntimeError):
    def __init__(
        self,
        code: str,
        *,
        bucket_access_confirmed: bool = False,
        object_access_confirmed: bool = False,
        deny_canaries_confirmed: bool = False,
        objects_observed: int = 0,
    ) -> None:
        if code not in _ERROR_CODES:
            raise ValueError("unsupported dataset verification error code")
        self.code = code
        self.bucket_access_confirmed = bucket_access_confirmed
        self.object_access_confirmed = object_access_confirmed
        self.deny_canaries_confirmed = deny_canaries_confirmed
        self.objects_observed = objects_observed
        super().__init__(code)


class AssumeRoleDenied(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class DatasetVerificationCommand:
    verification_id: UUID


@dataclass(frozen=True, slots=True, repr=False)
class DatasetVerificationClaim:
    verification_id: UUID
    organization_id: UUID
    owner_user_id: UUID
    connection_id: UUID
    target_revision: int
    credential_revision: int
    bucket_name: str
    region_name: str
    object_prefix: str
    credential_mode: str
    role_arn: str | None
    secret_reference: str | None


@dataclass(frozen=True, slots=True, repr=False)
class DatasetConnectionCredentials:
    values: Mapping[str, str]


@dataclass(frozen=True, slots=True)
class DatasetVerificationOutcome:
    bucket_access_confirmed: bool
    object_access_confirmed: bool
    deny_canaries_confirmed: bool
    objects_observed: int
    sanitized_error_code: str | None
    duration_ms: int


@dataclass(frozen=True, slots=True)
class S3ProbeOutcome:
    bucket_access_confirmed: bool
    object_access_confirmed: bool
    deny_canary_confirmed: bool
    objects_observed: int


class DatasetVerificationCoordinator(Protocol):
    async def claim(
        self, verification_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> DatasetVerificationClaim | None: ...

    async def complete(
        self,
        verification_id: UUID,
        worker_token: UUID,
        outcome: DatasetVerificationOutcome,
    ) -> bool: ...

    async def release(
        self, verification_id: UUID, worker_token: UUID, max_attempts: int
    ) -> str: ...


class DatasetCredentialLoader(Protocol):
    async def load(self, claim: DatasetVerificationClaim) -> DatasetConnectionCredentials: ...


class RoleAssumer(Protocol):
    async def assume(self, role_arn: str, external_id: str) -> AwsCredentials: ...


class DatasetS3Probe(Protocol):
    async def probe(
        self,
        credentials: AwsCredentials,
        bucket: str,
        region: str,
        prefix: str,
        deny_prefix: str,
    ) -> S3ProbeOutcome: ...


@dataclass(frozen=True, slots=True)
class UserDatasetVerifierSettings:
    stage: str
    region: str
    database_cluster_arn: str
    database_secret_arn: str
    deny_prefix: str
    database_name: str = "opengeo"

    @classmethod
    def from_environment(
        cls, environment: Mapping[str, str] | None = None
    ) -> "UserDatasetVerifierSettings":
        values = environment if environment is not None else os.environ
        required = {
            "stage": values.get("OPEN_GEO_DATASET_VERIFIER_STAGE"),
            "region": values.get("OPEN_GEO_DATA_API_REGION"),
            "database_cluster_arn": values.get("OPEN_GEO_DATA_API_CLUSTER_ARN"),
            "database_secret_arn": values.get("OPEN_GEO_DATA_API_SECRET_ARN"),
            "deny_prefix": values.get("OPEN_GEO_DATASET_VERIFIER_DENY_PREFIX"),
        }
        if any(value is None for value in required.values()):
            raise DatasetVerificationDependencyUnavailable(
                "user dataset verifier configuration is incomplete"
            )
        stage = cast(str, required["stage"])
        region = cast(str, required["region"])
        cluster_arn = cast(str, required["database_cluster_arn"])
        secret_arn = cast(str, required["database_secret_arn"])
        deny_prefix = cast(str, required["deny_prefix"])
        database_name = values.get("OPEN_GEO_DB_NAME", "opengeo")
        cluster_match = re.fullmatch(
            r"arn:(aws(?:-us-gov)?):rds:([^:]+):(\d{12}):cluster:[A-Za-z0-9-]{1,63}",
            cluster_arn,
        )
        secret_match = re.fullmatch(
            r"arn:(aws(?:-us-gov)?):secretsmanager:([^:]+):(\d{12}):"
            r"secret:[A-Za-z0-9/_+=.@-]+",
            secret_arn,
        )
        if (
            stage not in {"dev", "demo", "staging", "production"}
            or re.fullmatch(r"[a-z]{2}(?:-gov)?-[a-z]+-\d", region) is None
            or cluster_match is None
            or secret_match is None
            or cluster_match.groups() != secret_match.groups()
            or cluster_match.group(2) != region
            or database_name != "opengeo"
            or not _safe_prefix(deny_prefix)
            or not deny_prefix
        ):
            raise DatasetVerificationDependencyUnavailable(
                "user dataset verifier configuration is invalid"
            )
        return cls(stage, region, cluster_arn, secret_arn, deny_prefix, database_name)

    @property
    def account_id(self) -> str:
        return self.database_secret_arn.split(":", 5)[4]

    @property
    def partition(self) -> str:
        return self.database_secret_arn.split(":", 2)[1]

    def data_api_settings(self) -> Settings:
        return Settings(
            env="test",
            data_api_region=self.region,
            data_api_cluster_arn=self.database_cluster_arn,
            data_api_secret_arn=self.database_secret_arn,
            db_name=self.database_name,
        )


class VerificationDataApi(Protocol):
    async def execute(
        self,
        statement: str,
        parameters: tuple[Any, ...] = (),
        transaction_id: str | None = None,
    ) -> DataApiResult: ...


class RdsDataUserDatasetVerificationCoordinator:
    def __init__(self, client: VerificationDataApi) -> None:
        self._client = client

    async def claim(
        self, verification_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> DatasetVerificationClaim | None:
        try:
            result = await self._client.execute(
                """
                SELECT claim_status, verification_id, organization_id, owner_user_id,
                       connection_id, target_revision, credential_revision,
                       bucket_name, region_name, object_prefix, credential_mode,
                       role_arn, secret_arn, attempt_count
                FROM app.claim_user_dataset_connection_verification(%s, %s, %s)
                """,
                (verification_id, worker_token, lease_seconds),
            )
        except RdsDataApiUnavailable as error:
            raise DatasetVerificationDependencyUnavailable(
                "user dataset verification claim is unavailable"
            ) from error
        if len(result.records) != 1 or len(result.records[0]) != 14:
            raise DatasetVerificationDependencyUnavailable(
                "user dataset verification claim returned an invalid result"
            )
        row = result.records[0]
        if row[0] != "claimed":
            return None
        try:
            return DatasetVerificationClaim(
                verification_id=_uuid(row[1]),
                organization_id=_uuid(row[2]),
                owner_user_id=_uuid(row[3]),
                connection_id=_uuid(row[4]),
                target_revision=_positive_int(row[5]),
                credential_revision=_non_negative_int(row[6]),
                bucket_name=_bucket(row[7]),
                region_name=_region(row[8]),
                object_prefix=_prefix(row[9]),
                credential_mode=_credential_mode(row[10]),
                role_arn=_optional_role_arn(row[11]),
                secret_reference=_optional_string(row[12], 2048),
            )
        except (TypeError, ValueError) as error:
            raise DatasetVerificationDependencyUnavailable(
                "user dataset verification claim is invalid"
            ) from error

    async def complete(
        self,
        verification_id: UUID,
        worker_token: UUID,
        outcome: DatasetVerificationOutcome,
    ) -> bool:
        try:
            result = await self._client.execute(
                """
                SELECT app.complete_user_dataset_connection_verification(
                  %s, %s, %s, %s, %s, %s, %s, %s
                )
                """,
                (
                    verification_id,
                    worker_token,
                    outcome.bucket_access_confirmed,
                    outcome.object_access_confirmed,
                    outcome.deny_canaries_confirmed,
                    outcome.objects_observed,
                    outcome.sanitized_error_code,
                    outcome.duration_ms,
                ),
            )
        except RdsDataApiUnavailable as error:
            raise DatasetVerificationDependencyUnavailable(
                "user dataset verification completion is unavailable"
            ) from error
        return bool(result.records and result.records[0] and result.records[0][0] is True)

    async def release(self, verification_id: UUID, worker_token: UUID, max_attempts: int) -> str:
        try:
            result = await self._client.execute(
                """
                SELECT app.release_user_dataset_connection_verification(%s, %s, %s)
                """,
                (verification_id, worker_token, max_attempts),
            )
        except RdsDataApiUnavailable as error:
            raise DatasetVerificationDependencyUnavailable(
                "user dataset verification release is unavailable"
            ) from error
        value = result.records[0][0] if result.records and result.records[0] else None
        if value not in {"queued", "failed", "unchanged"}:
            raise DatasetVerificationDependencyUnavailable(
                "user dataset verification release returned an invalid result"
            )
        return cast(str, value)


class AwsJsonTransport(Protocol):
    def call(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout_seconds: float,
        maximum_bytes: int,
    ) -> tuple[int, Mapping[str, str], bytes]: ...


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args: object, **kwargs: object) -> None:
        del args, kwargs
        return None


class UrlAwsTransport:
    def __init__(self) -> None:
        self._opener = build_opener(_NoRedirect)

    def call(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout_seconds: float,
        maximum_bytes: int,
    ) -> tuple[int, Mapping[str, str], bytes]:
        request = Request(
            url,
            data=body if method == "POST" else None,
            headers=dict(headers),
            method=method,
        )
        try:
            with self._opener.open(request, timeout=timeout_seconds) as response:
                response_body = b"" if method == "HEAD" else response.read(maximum_bytes + 1)
                if len(response_body) > maximum_bytes:
                    raise DatasetVerificationDependencyUnavailable(
                        "AWS response exceeded the verifier bound"
                    )
                return response.status, dict(response.headers.items()), response_body
        except HTTPError as error:
            body_value = b"" if method == "HEAD" else error.read(maximum_bytes + 1)
            if len(body_value) > maximum_bytes:
                body_value = b""
            return error.code, dict(error.headers.items()), body_value
        except (URLError, TimeoutError, OSError) as error:
            raise DatasetVerificationDependencyUnavailable(
                "AWS dependency could not be reached"
            ) from error


class AwsUserDatasetCredentialLoader:
    def __init__(
        self,
        settings: UserDatasetVerifierSettings,
        credentials: CredentialProvider | None = None,
        transport: AwsJsonTransport | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._settings = settings
        self._credentials = credentials or AwsCredentialProvider()
        self._transport = transport or UrlAwsTransport()
        self._now = now or (lambda: datetime.now(UTC))

    async def load(self, claim: DatasetVerificationClaim) -> DatasetConnectionCredentials:
        if claim.credential_mode == "workload_identity":
            return DatasetConnectionCredentials({})
        reference = claim.secret_reference
        if reference is None or not self._valid_reference(reference, claim):
            raise DatasetVerificationRejected("secret_invalid")
        payload = self._load_secret(reference)
        if claim.credential_mode == "assume_role":
            required = {"external_id"}
        elif claim.credential_mode == "access_key":
            required = {"access_key_id", "secret_access_key"}
            if "session_token" in payload:
                required.add("session_token")
        else:
            raise DatasetVerificationRejected("secret_invalid")
        if set(payload) != required or any(not _secret_value(value) for value in payload.values()):
            raise DatasetVerificationRejected("secret_invalid")
        return DatasetConnectionCredentials(cast(dict[str, str], payload))

    def _valid_reference(self, reference: str, claim: DatasetVerificationClaim) -> bool:
        expected = (
            f"arn:{self._settings.partition}:secretsmanager:{self._settings.region}:"
            f"{self._settings.account_id}:secret:opengeo/{self._settings.stage}/"
            f"user-connections/{claim.organization_id}/{claim.owner_user_id}/"
            f"{claim.connection_id}/"
        )
        return reference.startswith(expected) and bool(
            re.fullmatch(r"[A-Za-z0-9/_+=.@-]{1,2048}", reference.split(":secret:", 1)[1])
        )

    def _load_secret(self, reference: str) -> dict[str, Any]:
        body = json.dumps({"SecretId": reference}, separators=(",", ":")).encode()
        host = f"secretsmanager.{self._settings.region}.amazonaws.com"
        headers = _signed_headers(
            method="POST",
            canonical_uri="/",
            canonical_query="",
            host=host,
            region=self._settings.region,
            service="secretsmanager",
            credentials=self._credentials.load(),
            body=body,
            now=self._now(),
            extra_headers={
                "content-type": "application/x-amz-json-1.1",
                "x-amz-target": "secretsmanager.GetSecretValue",
            },
        )
        status, _, response = self._transport.call(
            "POST", f"https://{host}/", headers, body, 4.0, 65_536
        )
        if status >= 500:
            raise DatasetVerificationDependencyUnavailable("Secrets Manager is unavailable")
        if status != 200:
            raise DatasetVerificationRejected("secret_invalid")
        try:
            envelope = json.loads(response)
            payload = json.loads(envelope["SecretString"])
        except (KeyError, TypeError, ValueError) as error:
            raise DatasetVerificationRejected("secret_invalid") from error
        if not isinstance(payload, dict):
            raise DatasetVerificationRejected("secret_invalid")
        return cast(dict[str, Any], payload)


class AwsStsRoleAssumer:
    def __init__(
        self,
        region: str,
        credentials: CredentialProvider | None = None,
        transport: AwsJsonTransport | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._region = region
        self._credentials = credentials or AwsCredentialProvider()
        self._transport = transport or UrlAwsTransport()
        self._now = now or (lambda: datetime.now(UTC))

    async def assume(self, role_arn: str, external_id: str) -> AwsCredentials:
        return self._assume(role_arn, external_id)

    def _assume(self, role_arn: str, external_id: str) -> AwsCredentials:
        if _optional_role_arn(role_arn) is None or not _secret_value(external_id):
            raise DatasetVerificationRejected("credentials_rejected")
        parameters = {
            "Action": "AssumeRole",
            "DurationSeconds": "900",
            "ExternalId": external_id,
            "RoleArn": role_arn,
            "RoleSessionName": "opengeo-dataset-verifier",
            "Version": "2011-06-15",
        }
        body = _form_query(parameters).encode()
        host = f"sts.{self._region}.amazonaws.com"
        headers = _signed_headers(
            method="POST",
            canonical_uri="/",
            canonical_query="",
            host=host,
            region=self._region,
            service="sts",
            credentials=self._credentials.load(),
            body=body,
            now=self._now(),
            extra_headers={"content-type": "application/x-www-form-urlencoded; charset=utf-8"},
        )
        status, _, response = self._transport.call(
            "POST", f"https://{host}/", headers, body, 4.0, 65_536
        )
        if status in {400, 401, 403}:
            raise AssumeRoleDenied
        if status >= 500:
            raise DatasetVerificationDependencyUnavailable("STS is unavailable")
        if status != 200:
            raise DatasetVerificationDependencyUnavailable("STS returned an invalid status")
        try:
            root = ElementTree.fromstring(response)
            values = {
                element.tag.rsplit("}", 1)[-1]: element.text
                for element in root.iter()
                if element.text
            }
            access_key = values["AccessKeyId"]
            secret_key = values["SecretAccessKey"]
            session_token = values["SessionToken"]
        except (ElementTree.ParseError, KeyError, TypeError) as error:
            raise DatasetVerificationDependencyUnavailable(
                "STS returned invalid credentials"
            ) from error
        if not all(_secret_value(value) for value in (access_key, secret_key, session_token)):
            raise DatasetVerificationDependencyUnavailable("STS returned invalid credentials")
        return AwsCredentials(access_key, secret_key, session_token)


class AwsS3DatasetProbe:
    def __init__(
        self,
        transport: AwsJsonTransport | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._transport = transport or UrlAwsTransport()
        self._now = now or (lambda: datetime.now(UTC))

    async def probe(
        self,
        credentials: AwsCredentials,
        bucket: str,
        region: str,
        prefix: str,
        deny_prefix: str,
    ) -> S3ProbeOutcome:
        return self._probe(credentials, bucket, region, prefix, deny_prefix)

    def _probe(
        self,
        credentials: AwsCredentials,
        bucket: str,
        region: str,
        prefix: str,
        deny_prefix: str,
    ) -> S3ProbeOutcome:
        if _bucket(bucket) != bucket or _region(region) != region:
            raise DatasetVerificationRejected("bucket_access_denied")
        if not _safe_prefix(prefix) or not _safe_prefix(deny_prefix) or prefix == deny_prefix:
            raise DatasetVerificationRejected("deny_canary_failed")

        first = self._list(
            credentials,
            bucket,
            region,
            prefix,
            delimiter="/" if not prefix else None,
        )
        key = first[0]
        if key is None and first[1] is not None:
            key = self._list(credentials, bucket, region, first[1], delimiter=None)[0]
        if key is None:
            raise DatasetVerificationRejected("object_access_denied", bucket_access_confirmed=True)

        self._head(credentials, bucket, region, key)
        deny_status = self._list_status(credentials, bucket, region, deny_prefix, delimiter="/")
        if deny_status not in {401, 403}:
            raise DatasetVerificationRejected(
                "deny_canary_failed",
                bucket_access_confirmed=True,
                object_access_confirmed=True,
                objects_observed=1,
            )
        return S3ProbeOutcome(True, True, True, 1)

    def _list(
        self,
        credentials: AwsCredentials,
        bucket: str,
        region: str,
        prefix: str,
        delimiter: str | None,
    ) -> tuple[str | None, str | None]:
        status, _, body = self._list_response(credentials, bucket, region, prefix, delimiter)
        if status in {301, 307, 400}:
            raise DatasetVerificationRejected("region_mismatch")
        if status in {401, 403}:
            raise DatasetVerificationRejected("bucket_access_denied")
        if status >= 500:
            raise DatasetVerificationDependencyUnavailable("S3 is unavailable")
        if status != 200:
            raise DatasetVerificationRejected("bucket_access_denied")
        try:
            root = ElementTree.fromstring(body)
        except ElementTree.ParseError as error:
            raise DatasetVerificationDependencyUnavailable("S3 returned invalid XML") from error
        key = next(
            (element.text for element in root.iter() if element.tag.rsplit("}", 1)[-1] == "Key"),
            None,
        )
        common_prefix = next(
            (
                element.text
                for element in root.iter()
                if element.tag.rsplit("}", 1)[-1] == "Prefix"
                and element.text is not None
                and element.text != prefix
            ),
            None,
        )
        if key is not None and (not key.startswith(prefix) or len(key.encode()) > 1024):
            raise DatasetVerificationDependencyUnavailable("S3 returned an invalid object key")
        if common_prefix is not None and (
            not common_prefix.startswith(prefix) or not _safe_prefix(common_prefix)
        ):
            raise DatasetVerificationDependencyUnavailable("S3 returned an invalid prefix")
        return key, common_prefix

    def _list_status(
        self,
        credentials: AwsCredentials,
        bucket: str,
        region: str,
        prefix: str,
        delimiter: str | None,
    ) -> int:
        return self._list_response(credentials, bucket, region, prefix, delimiter)[0]

    def _list_response(
        self,
        credentials: AwsCredentials,
        bucket: str,
        region: str,
        prefix: str,
        delimiter: str | None,
    ) -> tuple[int, Mapping[str, str], bytes]:
        parameters = {"list-type": "2", "max-keys": "1", "prefix": prefix}
        if delimiter is not None:
            parameters["delimiter"] = delimiter
        return self._s3_request("GET", credentials, bucket, region, bucket_path(bucket), parameters)

    def _head(
        self,
        credentials: AwsCredentials,
        bucket: str,
        region: str,
        key: str,
    ) -> None:
        status, _, _ = self._s3_request(
            "HEAD", credentials, bucket, region, object_path(bucket, key), {}
        )
        if status in {301, 307, 400}:
            raise DatasetVerificationRejected(
                "region_mismatch", bucket_access_confirmed=True, objects_observed=1
            )
        if status in {401, 403, 404}:
            raise DatasetVerificationRejected(
                "object_access_denied", bucket_access_confirmed=True, objects_observed=1
            )
        if status >= 500:
            raise DatasetVerificationDependencyUnavailable("S3 is unavailable")
        if status != 200:
            raise DatasetVerificationRejected(
                "object_access_denied", bucket_access_confirmed=True, objects_observed=1
            )

    def _s3_request(
        self,
        method: str,
        credentials: AwsCredentials,
        bucket: str,
        region: str,
        path: str,
        parameters: Mapping[str, str],
    ) -> tuple[int, Mapping[str, str], bytes]:
        del bucket
        host = regional_s3_host(region)
        query = _form_query(parameters)
        headers = _signed_headers(
            method=method,
            canonical_uri=path,
            canonical_query=query,
            host=host,
            region=region,
            service="s3",
            credentials=credentials,
            body=b"",
            now=self._now(),
        )
        url = f"https://{host}{path}" + (f"?{query}" if query else "")
        return self._transport.call(method, url, headers, b"", 4.0, 65_536)


class UserDatasetAccessVerifier:
    def __init__(
        self,
        role_assumer: RoleAssumer,
        s3_probe: DatasetS3Probe,
        task_credentials: CredentialProvider,
        deny_prefix: str,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._role_assumer = role_assumer
        self._s3_probe = s3_probe
        self._task_credentials = task_credentials
        self._deny_prefix = deny_prefix
        self._monotonic = monotonic

    async def verify(
        self,
        claim: DatasetVerificationClaim,
        credentials: DatasetConnectionCredentials,
    ) -> DatasetVerificationOutcome:
        started = self._monotonic()
        try:
            if claim.credential_mode == "assume_role":
                if claim.role_arn is None:
                    raise DatasetVerificationRejected("credentials_rejected")
                external_id = credentials.values.get("external_id")
                if not external_id:
                    raise DatasetVerificationRejected("secret_invalid")
                try:
                    await self._role_assumer.assume(claim.role_arn, _INVALID_EXTERNAL_ID_CANARY)
                except AssumeRoleDenied:
                    pass
                else:
                    raise DatasetVerificationRejected("deny_canary_failed")
                try:
                    active = await self._role_assumer.assume(claim.role_arn, external_id)
                except AssumeRoleDenied as error:
                    raise DatasetVerificationRejected("assume_role_denied") from error
                external_deny_confirmed = True
            elif claim.credential_mode == "access_key":
                values = credentials.values
                try:
                    active = AwsCredentials(
                        values["access_key_id"],
                        values["secret_access_key"],
                        values.get("session_token"),
                    )
                except KeyError as error:
                    raise DatasetVerificationRejected("secret_invalid") from error
                external_deny_confirmed = True
            elif claim.credential_mode == "workload_identity":
                try:
                    active = self._task_credentials.load()
                except IdentityProvisioningUnavailable as error:
                    raise DatasetVerificationRejected("credentials_rejected") from error
                external_deny_confirmed = True
            else:
                raise DatasetVerificationRejected("credentials_rejected")

            probe = await self._s3_probe.probe(
                active,
                claim.bucket_name,
                claim.region_name,
                claim.object_prefix,
                self._deny_prefix,
            )
            if not probe.deny_canary_confirmed or not external_deny_confirmed:
                raise DatasetVerificationRejected("deny_canary_failed")
            return DatasetVerificationOutcome(
                probe.bucket_access_confirmed,
                probe.object_access_confirmed,
                True,
                probe.objects_observed,
                None,
                _duration_ms(started, self._monotonic()),
            )
        except DatasetVerificationRejected as error:
            return DatasetVerificationOutcome(
                error.bucket_access_confirmed,
                error.object_access_confirmed,
                error.deny_canaries_confirmed,
                error.objects_observed,
                error.code,
                _duration_ms(started, self._monotonic()),
            )


class UserDatasetVerificationProcessor:
    def __init__(
        self,
        coordinator: DatasetVerificationCoordinator,
        secret_loader: DatasetCredentialLoader,
        verifier: UserDatasetAccessVerifier,
    ) -> None:
        self._coordinator = coordinator
        self._secret_loader = secret_loader
        self._verifier = verifier

    async def process(self, command: DatasetVerificationCommand) -> bool:
        worker_token = uuid4()
        claim = await self._coordinator.claim(command.verification_id, worker_token, 30)
        if claim is None:
            return False
        try:
            credentials = await self._secret_loader.load(claim)
            outcome = await self._verifier.verify(claim, credentials)
            if not await self._coordinator.complete(claim.verification_id, worker_token, outcome):
                raise DatasetVerificationDependencyUnavailable(
                    "user dataset verification completion was rejected"
                )
            return outcome.sanitized_error_code is None
        except DatasetVerificationRejected as error:
            outcome = DatasetVerificationOutcome(
                error.bucket_access_confirmed,
                error.object_access_confirmed,
                error.deny_canaries_confirmed,
                error.objects_observed,
                error.code,
                0,
            )
            if not await self._coordinator.complete(claim.verification_id, worker_token, outcome):
                raise DatasetVerificationDependencyUnavailable(
                    "user dataset verification completion was rejected"
                ) from error
            return False
        except DatasetVerificationDependencyUnavailable:
            release = await self._coordinator.release(claim.verification_id, worker_token, 3)
            if release == "failed":
                return False
            raise
        except Exception as error:
            release = await self._coordinator.release(claim.verification_id, worker_token, 3)
            if release == "failed":
                return False
            raise DatasetVerificationDependencyUnavailable(
                "user dataset verifier failed unexpectedly"
            ) from error


def parse_user_dataset_verification_command(body: str) -> DatasetVerificationCommand:
    if not isinstance(body, str) or not 1 <= len(body.encode()) <= _MAX_COMMAND_BYTES:
        raise DatasetVerificationCommandInvalid("user_dataset_verification_command_invalid")
    try:
        payload = json.loads(body)
    except ValueError as error:
        raise DatasetVerificationCommandInvalid(
            "user_dataset_verification_command_invalid"
        ) from error
    if not isinstance(payload, dict) or set(payload) != {"schema", "verification_id"}:
        raise DatasetVerificationCommandInvalid("user_dataset_verification_command_invalid")
    if payload.get("schema") != _COMMAND_SCHEMA:
        raise DatasetVerificationCommandInvalid("user_dataset_verification_command_invalid")
    try:
        return DatasetVerificationCommand(_uuid(payload.get("verification_id")))
    except (TypeError, ValueError) as error:
        raise DatasetVerificationCommandInvalid(
            "user_dataset_verification_command_invalid"
        ) from error


async def handle_sqs_event(
    event: Mapping[str, Any], processor: UserDatasetVerificationProcessor
) -> dict[str, list[dict[str, str]]]:
    records = event.get("Records")
    if not isinstance(records, list) or not 1 <= len(records) <= 10:
        raise DatasetVerificationCommandInvalid("user_dataset_verification_event_invalid")
    failures: list[dict[str, str]] = []
    for record in records:
        message_id = record.get("messageId") if isinstance(record, dict) else None
        body = record.get("body") if isinstance(record, dict) else None
        if (
            not isinstance(message_id, str)
            or not 1 <= len(message_id) <= 128
            or not isinstance(body, str)
        ):
            raise DatasetVerificationCommandInvalid("user_dataset_verification_event_invalid")
        try:
            command = parse_user_dataset_verification_command(body)
            await processor.process(command)
        except (DatasetVerificationCommandInvalid, DatasetVerificationDependencyUnavailable):
            failures.append({"itemIdentifier": message_id})
    return {"batchItemFailures": failures}


_DEFAULT_PROCESSOR: UserDatasetVerificationProcessor | None = None


def default_processor() -> UserDatasetVerificationProcessor:
    global _DEFAULT_PROCESSOR
    if _DEFAULT_PROCESSOR is None:
        runtime = UserDatasetVerifierSettings.from_environment()
        task_credentials = AwsCredentialProvider()
        data_api = RdsDataApiClient(runtime.data_api_settings())
        _DEFAULT_PROCESSOR = UserDatasetVerificationProcessor(
            RdsDataUserDatasetVerificationCoordinator(data_api),
            AwsUserDatasetCredentialLoader(runtime, credentials=task_credentials),
            UserDatasetAccessVerifier(
                AwsStsRoleAssumer(runtime.region, credentials=task_credentials),
                AwsS3DatasetProbe(),
                task_credentials,
                runtime.deny_prefix,
            ),
        )
    return _DEFAULT_PROCESSOR


def handler(event: Mapping[str, Any], context: object) -> dict[str, list[dict[str, str]]]:
    del context
    return asyncio.run(handle_sqs_event(event, default_processor()))


def _signed_headers(
    *,
    method: str,
    canonical_uri: str,
    canonical_query: str,
    host: str,
    region: str,
    service: str,
    credentials: AwsCredentials,
    body: bytes,
    now: datetime,
    extra_headers: Mapping[str, str] | None = None,
) -> dict[str, str]:
    timestamp = now.astimezone(UTC)
    amz_date = timestamp.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = timestamp.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(body).hexdigest()
    canonical = {
        "host": host,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
        **(dict(extra_headers) if extra_headers else {}),
    }
    if credentials.session_token:
        canonical["x-amz-security-token"] = credentials.session_token
    signed_names = ";".join(sorted(canonical))
    serialized = "".join(f"{name}:{canonical[name].strip()}\n" for name in sorted(canonical))
    canonical_request = "\n".join(
        [method, canonical_uri, canonical_query, serialized, signed_names, payload_hash]
    )
    scope = f"{date_stamp}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_date,
            scope,
            hashlib.sha256(canonical_request.encode()).hexdigest(),
        ]
    )
    signature = hmac.new(
        _aws_signing_key(credentials.secret_access_key, date_stamp, region, service),
        string_to_sign.encode(),
        hashlib.sha256,
    ).hexdigest()
    return {
        **canonical,
        "authorization": (
            "AWS4-HMAC-SHA256 "
            f"Credential={credentials.access_key_id}/{scope}, "
            f"SignedHeaders={signed_names}, Signature={signature}"
        ),
    }


def _aws_signing_key(secret: str, date_stamp: str, region: str, service: str) -> bytes:
    date_key = hmac.new(f"AWS4{secret}".encode(), date_stamp.encode(), hashlib.sha256).digest()
    region_key = hmac.new(date_key, region.encode(), hashlib.sha256).digest()
    service_key = hmac.new(region_key, service.encode(), hashlib.sha256).digest()
    return hmac.new(service_key, b"aws4_request", hashlib.sha256).digest()


def _form_query(parameters: Mapping[str, str]) -> str:
    return "&".join(
        f"{quote(key, safe='-_.~')}={quote(value, safe='-_.~')}"
        for key, value in sorted(parameters.items())
    )


def _duration_ms(started: float, finished: float) -> int:
    return min(25_000, max(0, int((finished - started) * 1000)))


def _uuid(value: Any) -> UUID:
    if isinstance(value, UUID):
        return value
    if isinstance(value, str):
        parsed = UUID(value)
        if str(parsed) == value:
            return parsed
    raise ValueError("invalid UUID")


def _positive_int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("invalid positive integer")
    return value


def _non_negative_int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("invalid non-negative integer")
    return value


def _bucket(value: Any) -> str:
    if (
        not isinstance(value, str)
        or re.fullmatch(r"(?=.{3,63}\Z)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", value) is None
        or ".." in value
        or ".-" in value
        or "-." in value
        or re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", value)
    ):
        raise ValueError("invalid bucket")
    return value


def _region(value: Any) -> str:
    if (
        not isinstance(value, str)
        or re.fullmatch(r"[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d", value) is None
    ):
        raise ValueError("invalid region")
    return value


def _safe_prefix(value: Any) -> bool:
    return bool(
        isinstance(value, str)
        and len(value.encode()) <= 1024
        and not value.startswith(("/", "\\"))
        and "\\" not in value
        and all(ord(character) >= 32 and ord(character) != 127 for character in value)
    )


def _prefix(value: Any) -> str:
    if not _safe_prefix(value):
        raise ValueError("invalid prefix")
    return cast(str, value)


def _credential_mode(value: Any) -> str:
    if value not in {"workload_identity", "assume_role", "access_key"}:
        raise ValueError("invalid credential mode")
    return cast(str, value)


def _optional_role_arn(value: Any) -> str | None:
    if value is None:
        return None
    if (
        not isinstance(value, str)
        or re.fullmatch(r"arn:aws(?:-us-gov)?:iam::\d{12}:role/[A-Za-z0-9_+=,.@/-]+", value) is None
    ):
        raise ValueError("invalid role ARN")
    return value


def _optional_string(value: Any, maximum: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not 1 <= len(value) <= maximum:
        raise ValueError("invalid string")
    return value


def _secret_value(value: Any) -> bool:
    return bool(
        isinstance(value, str)
        and 1 <= len(value) <= 4096
        and value == value.strip()
        and all(ord(character) >= 32 and ord(character) != 127 for character in value)
    )
