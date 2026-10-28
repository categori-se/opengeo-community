import re
from functools import lru_cache
from typing import Any, Literal, Self
from urllib.parse import urlsplit

from pydantic import Field, PositiveFloat, PositiveInt, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from opengeo_api.render_runtime import RenderRuntimeReference

Environment = Literal["dev", "test", "staging", "production"]


def canonical_preview_origin(value: str, *, allow_loopback_http: bool = False) -> str:
    """Validate an explicitly configured isolated origin, never an arbitrary URL."""
    try:
        parsed = urlsplit(value)
        host, port = parsed.hostname, parsed.port
        labels = host.split(".") if host else []
        valid_host = (
            host is not None
            and bool(labels)
            and len(host) <= 253
            and all(
                re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels
            )
        )
        authority = host + (f":{port}" if port is not None else "") if host else ""
        valid = (
            isinstance(value, str)
            and all(32 < ord(character) < 127 for character in value)
            and valid_host
            and parsed.netloc == authority
            and value == f"{parsed.scheme}://{authority}"
            and (port is None or 1 <= port <= 65535)
            and (parsed.scheme, port) not in {("https", 443), ("http", 80)}
            and not (parsed.path or parsed.query or parsed.fragment)
            and (
                parsed.scheme == "https"
                or (allow_loopback_http and parsed.scheme == "http" and host == "127.0.0.1")
            )
        )
    except (TypeError, ValueError):
        valid = False
    if not valid:
        raise ValueError(
            "preview origin must be a canonical HTTPS origin; dev/test may use HTTP on 127.0.0.1"
        )
    return value


class Settings(BaseSettings):
    """Runtime settings loaded exclusively from explicit values or OPEN_GEO_* variables."""

    model_config = SettingsConfigDict(
        env_prefix="OPEN_GEO_",
        case_sensitive=False,
        extra="ignore",
    )

    env: Environment = "dev"
    service_name: str = "opengeo-api"
    host: str = "0.0.0.0"
    port: int = Field(default=8080, ge=1, le=65535)
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"
    expose_docs: bool = False

    database_url: SecretStr | None = None
    db_host: str | None = None
    db_port: int = Field(default=5432, ge=1, le=65535)
    db_name: str = "opengeo"
    db_user: str | None = None
    db_password: SecretStr | None = None
    db_sslmode: Literal["require", "verify-full"] = "require"
    db_sslrootcert: str | None = None
    db_connect_timeout_seconds: PositiveInt = 2
    readiness_timeout_seconds: PositiveFloat = 3.0
    database_query_timeout_seconds: PositiveFloat = 10.0
    data_api_resume_timeout_seconds: float = Field(default=12.0, ge=1.0, le=20.0)
    principal_lookup_timeout_seconds: float = Field(default=20.0, ge=1.0, le=20.0)
    data_api_region: str | None = None
    data_api_cluster_arn: str | None = None
    data_api_secret_arn: str | None = None

    cognito_region: str | None = None
    cognito_user_pool_id: str | None = None
    cognito_client_id: str | None = None
    cognito_additional_client_ids: str | None = None
    cognito_provisioning_enabled: bool = True
    cognito_jwks_cache_seconds: PositiveInt = 3600
    cognito_jwks_min_refresh_seconds: PositiveInt = 30
    cognito_http_timeout_seconds: PositiveFloat = 5.0
    jwt_leeway_seconds: int = Field(default=30, ge=0, le=300)

    mcp_resource_url: str | None = Field(default=None, max_length=1024)
    mcp_required_scopes: str = Field(default="openid", max_length=256)
    mcp_allowed_origins: str | None = Field(default=None, max_length=2048)

    aws_region: str | None = None
    application_bucket: str | None = None
    artifact_view_origin: str | None = Field(default=None, max_length=300)
    observable_builder_image_digest: str | None = None
    observable_preview_origin: str | None = None
    observable_public_maps_preview_origin: str | None = None
    observable_preview_key_pair_id: str | None = None
    observable_preview_private_key_secret_arn: str | None = None
    geodata_bucket: str | None = None
    geodata_kms_key_arn: str | None = None
    processing_queue_url: str | None = None
    analysis_enabled: bool = False
    analysis_queue_url: str | None = None
    analysis_controller_function_arn: str | None = None
    analysis_runtime_profiles: str | None = Field(default=None, max_length=8192)
    pmtiles_derivative_queue_url: str | None = None
    pmtiles_worker_image_digest: str | None = None
    pmtiles_input_formats: str = "geojson"
    worker_processing_mode: Literal["shared", "pmtiles-v2", "disabled"] = "shared"
    connection_verification_queue_url: str | None = None
    connection_catalog_discovery_enabled: bool = False
    connection_postgis_preview_enabled: bool = False
    connection_verification_function_name: str | None = None
    user_dataset_verification_queue_url: str | None = None
    user_dataset_repository_browser_function_name: str | None = None
    observable_build_queue_url: str | None = None
    framework_publication_queue_url: str | None = None
    framework_publication_public_bucket: str | None = Field(
        default=None, pattern=r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$"
    )
    framework_publication_distribution_id: str | None = Field(
        default=None, pattern=r"^[A-Z0-9]{1,32}$"
    )
    framework_publication_destinations: str | None = Field(default=None, max_length=8192)
    framework_publication_protected_hosts: str | None = Field(default=None, max_length=4096)
    observable_build_provider: Literal["private_worker", "github"] = "private_worker"
    github_app_secret_arn: str | None = Field(
        default=None,
        pattern=r"^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$",
    )
    external_source_snapshot_queue_url: str | None = None
    external_source_discovery_queue_url: str | None = None
    repository_object_copy_queue_url: str | None = None
    upload_url_ttl_seconds: int = Field(default=900, ge=60, le=3600)
    download_url_ttl_seconds: int = Field(default=300, ge=60, le=900)
    upload_max_bytes: int = Field(default=536_870_912, ge=1, le=5_368_709_120)
    wms_sync_wait_seconds: float = Field(default=8.0, ge=0.05, le=15.0)
    wms_sync_poll_seconds: float = Field(default=0.25, ge=0.01, le=1.0)
    kml_network_link_fetch_enabled: bool = False
    # Enable only alongside the reviewed worker image and immutable font assets.
    portable_artifacts_enabled: bool = False
    publication_artifact_builds_enabled: bool = False
    saved_map_gl_enabled: bool = False
    saved_map_gl_runtime_sha256: str | None = Field(
        default=None, min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$"
    )
    saved_map_gl_runtime_architecture: Literal["x86_64", "aarch64"] | None = None

    @model_validator(mode="after")
    def validate_artifact_view_origin(self) -> Self:
        if self.artifact_view_origin is not None:
            try:
                value = urlsplit(self.artifact_view_origin)
                valid = (
                    value.scheme == "https"
                    and value.hostname is not None
                    and re.fullmatch(r"[a-z0-9]+(?:[.-][a-z0-9]+)*", value.hostname) is not None
                    and value.netloc == value.hostname + (f":{value.port}" if value.port else "")
                    and not (value.path or value.query or value.fragment)
                    and value.username is None
                    and value.password is None
                )
            except ValueError:
                valid = False
            if not valid:
                raise ValueError("artifact_view_origin must be a canonical HTTPS origin")
        return self

    @property
    def saved_map_gl_runtime_reference(self) -> RenderRuntimeReference | None:
        if (
            self.saved_map_gl_runtime_sha256 is None
            or self.saved_map_gl_runtime_architecture is None
        ):
            return None
        return RenderRuntimeReference(
            self.saved_map_gl_runtime_sha256, self.saved_map_gl_runtime_architecture
        )

    @model_validator(mode="after")
    def validate_portable_storage(self) -> Self:
        if self.portable_artifacts_enabled and (
            not self.source_upload_configured or self.aws_region != "us-east-1"
        ):
            raise ValueError(
                "Portable Artifacts require configured application storage in us-east-1"
            )
        return self

    @model_validator(mode="after")
    def validate_saved_map_runtime(self) -> Self:
        present = (
            self.saved_map_gl_runtime_sha256 is not None,
            self.saved_map_gl_runtime_architecture is not None,
        )
        if (any(present) and not all(present)) or (self.saved_map_gl_enabled and not all(present)):
            raise ValueError(
                "Saved-font rendering requires an exact runtime checksum and architecture"
            )
        return self

    @model_validator(mode="after")
    def validate_database_configuration(self) -> Self:
        discrete_values = (self.db_host, self.db_user, self.db_password)
        has_any_discrete_value = any(value is not None for value in discrete_values)
        has_all_discrete_values = all(value is not None for value in discrete_values)

        if self.database_url is not None and has_any_discrete_value:
            raise ValueError("configure database_url or discrete database fields, not both")
        if has_any_discrete_value and not has_all_discrete_values:
            raise ValueError("db_host, db_user, and db_password must be configured together")
        data_api_values = (
            self.data_api_region,
            self.data_api_cluster_arn,
            self.data_api_secret_arn,
        )
        has_any_data_api_value = any(value is not None for value in data_api_values)
        if has_any_data_api_value and not self.data_api_configured:
            raise ValueError(
                "data_api_region, data_api_cluster_arn, and data_api_secret_arn "
                "must be configured together"
            )
        if self.direct_database_configured and self.data_api_configured:
            raise ValueError("configure a direct database or RDS Data API, not both")
        if self.data_api_configured:
            assert self.data_api_region is not None
            assert self.data_api_cluster_arn is not None
            assert self.data_api_secret_arn is not None
            if not re.fullmatch(r"[a-z]{2}(?:-gov)?-[a-z]+-\d", self.data_api_region):
                raise ValueError("data_api_region is invalid")
            cluster_match = re.fullmatch(
                r"arn:aws(?:-us-gov)?:rds:([^:]+):(\d{12}):cluster:[A-Za-z0-9][A-Za-z0-9-]{0,62}",
                self.data_api_cluster_arn,
            )
            secret_match = re.fullmatch(
                r"arn:aws(?:-us-gov)?:secretsmanager:([^:]+):(\d{12}):secret:[A-Za-z0-9/_+=.@-]+",
                self.data_api_secret_arn,
            )
            if (
                cluster_match is None
                or secret_match is None
                or cluster_match.group(1) != self.data_api_region
                or secret_match.group(1) != self.data_api_region
                or cluster_match.group(2) != secret_match.group(2)
            ):
                raise ValueError("RDS Data API ARNs must share data_api_region and account")
        if self.env in {"staging", "production"} and not self.database_configured:
            raise ValueError("database configuration is required outside dev and test")
        if (
            self.database_configured
            and self.db_sslmode == "verify-full"
            and self.db_sslrootcert is None
        ):
            raise ValueError("db_sslrootcert is required with verify-full")

        auth_values = (
            self.cognito_region,
            self.cognito_user_pool_id,
            self.cognito_client_id,
        )
        has_any_auth_value = any(value is not None for value in auth_values)
        if has_any_auth_value and not self.auth_configured:
            raise ValueError("Cognito region, user pool id, and client id are required together")
        if self.env in {"staging", "production"} and not self.auth_configured:
            raise ValueError("Cognito configuration is required outside dev and test")
        if (
            self.cognito_client_id is not None
            and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", self.cognito_client_id) is None
        ):
            raise ValueError("cognito_client_id is invalid")
        if self.cognito_additional_client_ids is not None:
            if not self.auth_configured:
                raise ValueError(
                    "additional Cognito client ids require complete Cognito configuration"
                )
            additional_client_ids = self.cognito_additional_client_ids.split(",")
            if not 1 <= len(additional_client_ids) <= 3 or any(
                re.fullmatch(r"[A-Za-z0-9_-]{1,128}", client_id) is None
                for client_id in additional_client_ids
            ):
                raise ValueError(
                    "cognito_additional_client_ids must contain 1 to 3 exact comma-separated ids"
                )
            if (
                len(set(additional_client_ids)) != len(additional_client_ids)
                or self.cognito_client_id in additional_client_ids
            ):
                raise ValueError("Cognito client ids must be unique")

        if self.mcp_resource_url is not None:
            if not self.auth_configured:
                raise ValueError("mcp_resource_url requires complete Cognito configuration")
            resource = urlsplit(self.mcp_resource_url)
            try:
                canonical_preview_origin(
                    f"{resource.scheme}://{resource.netloc}",
                    allow_loopback_http=self.env in {"dev", "test"},
                )
            except ValueError as error:
                raise ValueError("mcp_resource_url must use a canonical HTTPS origin") from error
            if (
                resource.path != "/mcp"
                or resource.query
                or resource.fragment
                or self.mcp_resource_url != f"{resource.scheme}://{resource.netloc}/mcp"
            ):
                raise ValueError("mcp_resource_url must be the exact canonical /mcp URL")
        scopes = self.mcp_required_scopes.split(" ")
        if (
            not 1 <= len(scopes) <= 8
            or len(set(scopes)) != len(scopes)
            or any(re.fullmatch(r"[A-Za-z0-9:/._-]{1,128}", scope) is None for scope in scopes)
        ):
            raise ValueError("mcp_required_scopes must contain exact space-separated scopes")
        if self.mcp_allowed_origins is not None:
            origins = self.mcp_allowed_origins.split(",")
            if not 1 <= len(origins) <= 10 or len(set(origins)) != len(origins):
                raise ValueError("mcp_allowed_origins must contain 1 to 10 unique exact origins")
            for origin in origins:
                try:
                    canonical_preview_origin(
                        origin, allow_loopback_http=self.env in {"dev", "test"}
                    )
                except ValueError as error:
                    raise ValueError("mcp_allowed_origins contains an invalid origin") from error

        upload_values = (self.aws_region, self.geodata_bucket, self.geodata_kms_key_arn)
        if any(value is not None for value in upload_values) and not self.upload_configured:
            raise ValueError(
                "AWS region, geodata bucket, and geodata KMS key ARN are required together"
            )
        if self.upload_configured:
            assert self.aws_region is not None
            assert self.geodata_bucket is not None
            assert self.geodata_kms_key_arn is not None
            if not re.fullmatch(r"[a-z]{2}(?:-gov)?-[a-z]+-\d", self.aws_region):
                raise ValueError("aws_region is invalid")
            if (
                not re.fullmatch(
                    r"(?=.{3,63}\Z)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?",
                    self.geodata_bucket,
                )
                or ".." in self.geodata_bucket
                or ".-" in self.geodata_bucket
                or "-." in self.geodata_bucket
                or re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", self.geodata_bucket)
            ):
                raise ValueError("geodata_bucket is invalid")
            kms_match = re.fullmatch(
                r"arn:aws(?:-us-gov)?:kms:([a-z]{2}(?:-gov)?-[a-z]+-\d):\d{12}:key/[A-Za-z0-9-]+",
                self.geodata_kms_key_arn,
            )
            if kms_match is None or kms_match.group(1) != self.aws_region:
                raise ValueError("geodata_kms_key_arn must be a key ARN in aws_region")
        if self.application_bucket is not None:
            if self.aws_region is None or self.geodata_kms_key_arn is None:
                raise ValueError(
                    "AWS region and geodata KMS key ARN are required with application_bucket"
                )
            if (
                not re.fullmatch(
                    r"(?=.{3,63}\Z)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?",
                    self.application_bucket,
                )
                or ".." in self.application_bucket
                or ".-" in self.application_bucket
                or "-." in self.application_bucket
                or re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", self.application_bucket)
            ):
                raise ValueError("application_bucket is invalid")
        if (
            self.observable_builder_image_digest is not None
            and re.fullmatch(r"sha256:[0-9a-f]{64}", self.observable_builder_image_digest) is None
        ):
            raise ValueError("observable_builder_image_digest must be an exact sha256 digest")
        for origin in (self.observable_preview_origin, self.observable_public_maps_preview_origin):
            if origin is not None:
                canonical_preview_origin(origin, allow_loopback_http=self.env in {"dev", "test"})
                if origin in {"https://studio.opengeo.tools", "https://demo.studio.opengeo.tools"}:
                    raise ValueError("preview must use an origin separate from Studio")
        if self.observable_public_maps_preview_origin is not None:
            if self.observable_preview_origin is None:
                raise ValueError("public maps preview requires the private preview origin")
            if self.observable_public_maps_preview_origin == self.observable_preview_origin:
                raise ValueError("public maps preview must use a separate origin")
        preview_signing_values = (
            self.observable_preview_key_pair_id,
            self.observable_preview_private_key_secret_arn,
        )
        if any(value is not None for value in preview_signing_values):
            if not self.observable_preview_signing_configured:
                raise ValueError(
                    "Observable preview origin, key pair id, and private key secret ARN "
                    "are required together"
                )
            assert self.observable_preview_key_pair_id is not None
            assert self.observable_preview_private_key_secret_arn is not None
            if re.fullmatch(r"[A-Z0-9]{8,32}", self.observable_preview_key_pair_id) is None:
                raise ValueError("observable_preview_key_pair_id is invalid")
            secret_match = re.fullmatch(
                r"arn:aws(?:-us-gov)?:secretsmanager:([^:]+):(\d{12}):"
                r"secret:[A-Za-z0-9/_+=.@-]+",
                self.observable_preview_private_key_secret_arn,
            )
            if (
                secret_match is None
                or self.aws_region is None
                or secret_match.group(1) != self.aws_region
            ):
                raise ValueError("observable_preview_private_key_secret_arn must be in aws_region")
        if (
            self.env == "production"
            and self.observable_preview_origin is not None
            and not self.observable_preview_signing_configured
        ):
            raise ValueError("production Observable preview signing must be configured")

        if (
            self.pmtiles_worker_image_digest is not None
            and re.fullmatch(r"sha256:[0-9a-f]{64}", self.pmtiles_worker_image_digest) is None
        ):
            raise ValueError("pmtiles_worker_image_digest must be an immutable sha256 digest")
        pmtiles_formats = self.pmtiles_input_formats.split(",")
        if (
            not pmtiles_formats
            or len(set(pmtiles_formats)) != len(pmtiles_formats)
            or not set(pmtiles_formats)
            <= {"geojson", "csv", "shapefile", "geopackage", "geoparquet"}
        ):
            raise ValueError("pmtiles_input_formats must list distinct supported vector formats")

        for queue_name, queue_url in (
            ("processing_queue_url", self.processing_queue_url),
            ("analysis_queue_url", self.analysis_queue_url),
            ("pmtiles_derivative_queue_url", self.pmtiles_derivative_queue_url),
            ("connection_verification_queue_url", self.connection_verification_queue_url),
            (
                "user_dataset_verification_queue_url",
                self.user_dataset_verification_queue_url,
            ),
            ("observable_build_queue_url", self.observable_build_queue_url),
            ("framework_publication_queue_url", self.framework_publication_queue_url),
            ("external_source_snapshot_queue_url", self.external_source_snapshot_queue_url),
            ("external_source_discovery_queue_url", self.external_source_discovery_queue_url),
            ("repository_object_copy_queue_url", self.repository_object_copy_queue_url),
        ):
            if queue_url is None:
                continue
            queue_match = re.fullmatch(
                r"https://sqs\.([a-z]{2}(?:-gov)?-[a-z]+-\d)\.amazonaws\.com/"
                r"\d{12}/[A-Za-z0-9_-]{1,80}",
                queue_url,
            )
            if (
                queue_match is None
                or self.aws_region is None
                or queue_match.group(1) != self.aws_region
            ):
                raise ValueError(f"{queue_name} must be an SQS URL in aws_region")

        for function_setting, function_name in (
            (
                "user_dataset_repository_browser_function_name",
                self.user_dataset_repository_browser_function_name,
            ),
            ("connection_verification_function_name", self.connection_verification_function_name),
        ):
            if function_name is not None:
                if self.aws_region is None:
                    raise ValueError(f"{function_setting} requires aws_region")
                if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", function_name) is None:
                    raise ValueError(f"{function_setting} is invalid")
        if (
            self.connection_postgis_preview_enabled
            and self.connection_verification_function_name is None
        ):
            raise ValueError("PostGIS preview requires connection_verification_function_name")

        if self.wms_sync_poll_seconds > self.wms_sync_wait_seconds:
            raise ValueError("wms_sync_poll_seconds cannot exceed wms_sync_wait_seconds")

        if (
            self.kml_network_link_fetch_enabled
            and self.env == "dev"
            and (not self.database_configured or not self.auth_configured)
        ):
            raise ValueError("dev NetworkLink fetch requires database and Cognito configuration")

        return self

    @property
    def database_configured(self) -> bool:
        return self.direct_database_configured or self.data_api_configured

    @property
    def direct_database_configured(self) -> bool:
        return self.database_url is not None or all(
            value is not None for value in (self.db_host, self.db_user, self.db_password)
        )

    @property
    def data_api_configured(self) -> bool:
        return all(
            value is not None
            for value in (
                self.data_api_region,
                self.data_api_cluster_arn,
                self.data_api_secret_arn,
            )
        )

    def database_connection_kwargs(self) -> dict[str, Any] | None:
        if self.database_url is not None:
            options: dict[str, Any] = {
                "conninfo": self.database_url.get_secret_value(),
                "connect_timeout": self.db_connect_timeout_seconds,
                "sslmode": self.db_sslmode,
            }
            if self.db_sslrootcert is not None:
                options["sslrootcert"] = self.db_sslrootcert
            return options
        if not self.direct_database_configured:
            return None

        assert self.db_host is not None
        assert self.db_user is not None
        assert self.db_password is not None
        options = {
            "host": self.db_host,
            "port": self.db_port,
            "dbname": self.db_name,
            "user": self.db_user,
            "password": self.db_password.get_secret_value(),
            "connect_timeout": self.db_connect_timeout_seconds,
            "sslmode": self.db_sslmode,
        }
        if self.db_sslrootcert is not None:
            options["sslrootcert"] = self.db_sslrootcert
        return options

    @property
    def auth_configured(self) -> bool:
        return all(
            value is not None
            for value in (
                self.cognito_region,
                self.cognito_user_pool_id,
                self.cognito_client_id,
            )
        )

    @property
    def cognito_client_ids(self) -> tuple[str, ...]:
        if not self.auth_configured or self.cognito_client_id is None:
            raise ValueError("Cognito is not configured")
        additional = (
            ()
            if self.cognito_additional_client_ids is None
            else tuple(self.cognito_additional_client_ids.split(","))
        )
        return (self.cognito_client_id, *additional)

    @property
    def upload_configured(self) -> bool:
        return all(
            value is not None
            for value in (self.aws_region, self.geodata_bucket, self.geodata_kms_key_arn)
        )

    @property
    def source_upload_configured(self) -> bool:
        return self.upload_configured and self.application_bucket is not None

    @model_validator(mode="after")
    def validate_analysis_profiles(self) -> Self:
        from opengeo_api.analysis_jobs import parse_runtime_profiles

        parse_runtime_profiles(self.analysis_runtime_profiles)
        if self.analysis_queue_url is not None and self.analysis_queue_url in {
            self.processing_queue_url,
            self.pmtiles_derivative_queue_url,
            self.observable_build_queue_url,
            self.framework_publication_queue_url,
        }:
            raise ValueError("managed analysis requires its own queue")
        if self.analysis_controller_function_arn is not None:
            controller = re.fullmatch(
                r"arn:aws:lambda:([a-z]{2}(?:-gov)?-[a-z]+-\d):(\d{12}):function:"
                r"opengeo-(?:dev|staging|demo|production)-analysis-controller",
                self.analysis_controller_function_arn,
            )
            queue_account = (
                urlsplit(self.analysis_queue_url).path.split("/")[1]
                if self.analysis_queue_url is not None
                else None
            )
            if (
                controller is None
                or controller.group(1) != self.aws_region
                or controller.group(2) != queue_account
            ):
                raise ValueError(
                    "analysis_controller_function_arn must identify the same-account regional "
                    "analysis controller as its queue"
                )
        return self

    @property
    def analysis_dispatch_configured(self) -> bool:
        return (
            self.analysis_enabled
            and self.analysis_queue_url is not None
            and self.analysis_controller_function_arn is not None
            and self.analysis_runtime_profiles is not None
            and self.aws_region is not None
            and self.source_upload_configured
        )

    @property
    def render_dispatch_configured(self) -> bool:
        return (
            self.worker_processing_mode == "shared"
            and self.processing_queue_url is not None
            and self.aws_region is not None
        )

    @property
    def pmtiles_derivative_dispatch_configured(self) -> bool:
        return (
            self.worker_processing_mode == "pmtiles-v2"
            and self.pmtiles_derivative_queue_url is not None
            and self.pmtiles_derivative_queue_url != self.processing_queue_url
            and self.pmtiles_worker_image_digest is not None
            and self.aws_region is not None
        )

    @property
    def connection_verification_dispatch_configured(self) -> bool:
        return self.connection_verification_queue_url is not None and self.aws_region is not None

    @property
    def user_dataset_verification_dispatch_configured(self) -> bool:
        return self.user_dataset_verification_queue_url is not None and self.aws_region is not None

    @property
    def user_dataset_repository_browser_configured(self) -> bool:
        return (
            self.user_dataset_repository_browser_function_name is not None
            and self.aws_region is not None
        )

    @property
    def observable_build_dispatch_configured(self) -> bool:
        return self.observable_build_queue_url is not None and self.aws_region is not None

    @property
    def external_source_snapshot_dispatch_configured(self) -> bool:
        return self.external_source_snapshot_queue_url is not None and self.aws_region is not None

    @property
    def effective_external_source_discovery_queue_url(self) -> str | None:
        return self.external_source_discovery_queue_url or self.external_source_snapshot_queue_url

    @property
    def external_source_discovery_dispatch_configured(self) -> bool:
        return (
            self.effective_external_source_discovery_queue_url is not None
            and self.aws_region is not None
        )

    @property
    def repository_object_copy_dispatch_configured(self) -> bool:
        return self.repository_object_copy_queue_url is not None and self.aws_region is not None

    @property
    def observable_preview_signing_configured(self) -> bool:
        return all(
            value is not None
            for value in (
                self.observable_preview_origin,
                self.observable_preview_key_pair_id,
                self.observable_preview_private_key_secret_arn,
            )
        )

    @property
    def cognito_issuer(self) -> str:
        if not self.auth_configured:
            raise ValueError("Cognito is not configured")
        return (
            f"https://cognito-idp.{self.cognito_region}.amazonaws.com/{self.cognito_user_pool_id}"
        )

    @property
    def cognito_jwks_url(self) -> str:
        return f"{self.cognito_issuer}/.well-known/jwks.json"


@lru_cache
def get_settings() -> Settings:
    return Settings()
