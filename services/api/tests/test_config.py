import pytest
from pydantic import SecretStr, ValidationError

from opengeo_api.app import create_app
from opengeo_api.cognito_provisioning import UnavailableIdentityProvisioner
from opengeo_api.config import Settings


def test_pmtiles_v2_requires_separate_queue_mode_and_final_image_pin() -> None:
    shared = "https://sqs.us-east-1.amazonaws.com/111111111111/shared"
    configured = dict(
        env="test",
        aws_region="us-east-1",
        processing_queue_url=shared,
        geodata_bucket="opengeo-pmtiles-test",
        geodata_kms_key_arn="arn:aws:kms:us-east-1:111111111111:key/test-key",
        pmtiles_derivative_queue_url=(
            "https://sqs.us-east-1.amazonaws.com/111111111111/pmtiles-v2"
        ),
        worker_processing_mode="pmtiles-v2",
        pmtiles_worker_image_digest="sha256:" + "d" * 64,
    )
    settings = Settings(**configured)
    assert settings.pmtiles_derivative_dispatch_configured
    assert not settings.render_dispatch_configured
    for override in (
        {"pmtiles_worker_image_digest": None},
        {"pmtiles_derivative_queue_url": shared},
        {"worker_processing_mode": "shared"},
        {"worker_processing_mode": "disabled"},
    ):
        assert not Settings(**(configured | override)).pmtiles_derivative_dispatch_configured
    with pytest.raises(ValidationError, match="pmtiles_worker_image_digest"):
        Settings(**(configured | {"pmtiles_worker_image_digest": "latest"}))


def test_artifact_view_origin_is_optional_and_keeps_the_configured_https_origin() -> None:
    assert Settings(env="test").artifact_view_origin is None
    assert (
        Settings(
            env="test", artifact_view_origin="https://studio.opengeo.tools"
        ).artifact_view_origin
        == "https://studio.opengeo.tools"
    )


@pytest.mark.parametrize(
    "origin",
    [
        "http://studio.opengeo.tools",
        "https://studio.opengeo.tools/",
        "https://studio.opengeo.tools/api",
        "https://studio.opengeo.tools?next=other",
        "https://studio.opengeo.tools#other",
        "https://user:password@studio.opengeo.tools",
        "https://studio.opengeo.tools:99999",
        "https://studio.opengeo.tools\\evil",
    ],
)
def test_artifact_view_origin_rejects_paths_credentials_and_non_https(origin) -> None:
    with pytest.raises(ValidationError, match="artifact_view_origin"):
        Settings(env="test", artifact_view_origin=origin)


def test_dev_may_start_without_database_for_liveness() -> None:
    settings = Settings(env="dev")

    assert settings.database_configured is False
    assert settings.database_connection_kwargs() is None


def test_network_link_transport_is_default_off_and_dev_requires_auth_and_database() -> None:
    assert Settings(env="test").kml_network_link_fetch_enabled is False
    assert Settings(env="test", kml_network_link_fetch_enabled=True).kml_network_link_fetch_enabled
    with pytest.raises(ValidationError, match="requires database and Cognito"):
        Settings(env="dev", kml_network_link_fetch_enabled=True)


def test_production_requires_database_configuration() -> None:
    with pytest.raises(ValidationError, match="database configuration is required"):
        Settings(env="production")


def test_database_fields_must_be_complete() -> None:
    with pytest.raises(ValidationError, match="must be configured together"):
        Settings(env="dev", db_host="database.internal")


def test_verify_full_requires_and_uses_a_root_certificate() -> None:
    with pytest.raises(ValidationError, match="db_sslrootcert is required"):
        Settings(
            env="dev",
            db_host="database.internal",
            db_user="opengeo_runtime",
            db_password=SecretStr("not-a-real-secret"),
            db_sslmode="verify-full",
        )

    settings = Settings(
        env="dev",
        db_host="database.internal",
        db_user="opengeo_runtime",
        db_password=SecretStr("not-a-real-secret"),
        db_sslmode="verify-full",
        db_sslrootcert="/etc/ssl/certs/aws-rds-global-bundle.pem",
    )
    assert settings.database_connection_kwargs() == {
        "host": "database.internal",
        "port": 5432,
        "dbname": "opengeo",
        "user": "opengeo_runtime",
        "password": "not-a-real-secret",
        "connect_timeout": 2,
        "sslmode": "verify-full",
        "sslrootcert": "/etc/ssl/certs/aws-rds-global-bundle.pem",
    }


def test_database_secret_is_not_exposed_by_settings_repr() -> None:
    password = "not-a-real-secret"
    settings = Settings(
        env="production",
        db_host="database.internal",
        db_user="opengeo_runtime",
        db_password=SecretStr(password),
        cognito_region="us-east-1",
        cognito_user_pool_id="us-east-1_example",
        cognito_client_id="client-123",
    )

    assert password not in repr(settings)
    assert settings.database_connection_kwargs() == {
        "host": "database.internal",
        "port": 5432,
        "dbname": "opengeo",
        "user": "opengeo_runtime",
        "password": password,
        "connect_timeout": 2,
        "sslmode": "require",
    }


def test_rds_data_api_is_a_complete_mutually_exclusive_database_backend() -> None:
    with pytest.raises(ValidationError, match="must be configured together"):
        Settings(env="test", data_api_region="us-east-1")

    settings = Settings(
        env="test",
        data_api_region="us-east-1",
        data_api_cluster_arn=("arn:aws:rds:us-east-1:111111111111:cluster:opengeo-serverless"),
        data_api_secret_arn=(
            "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/runtime-AbCd"
        ),
    )
    assert settings.database_configured is True
    assert settings.direct_database_configured is False
    assert settings.data_api_configured is True
    assert settings.database_connection_kwargs() is None

    with pytest.raises(ValidationError, match="not both"):
        Settings(
            env="test",
            database_url=SecretStr("postgresql://runtime:secret@database/opengeo"),
            data_api_region="us-east-1",
            data_api_cluster_arn=("arn:aws:rds:us-east-1:111111111111:cluster:opengeo-serverless"),
            data_api_secret_arn=(
                "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/runtime-AbCd"
            ),
        )


@pytest.mark.parametrize(
    ("cluster_arn", "secret_arn"),
    [
        (
            "arn:aws:rds:us-west-2:111111111111:cluster:opengeo-serverless",
            "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/runtime-AbCd",
        ),
        (
            "arn:aws:rds:us-east-1:111111111111:cluster:opengeo-serverless",
            "arn:aws:secretsmanager:us-east-1:222222222222:secret:opengeo/runtime-AbCd",
        ),
    ],
)
def test_rds_data_api_rejects_cross_region_or_account_arns(
    cluster_arn: str, secret_arn: str
) -> None:
    with pytest.raises(ValidationError, match="must share"):
        Settings(
            env="test",
            data_api_region="us-east-1",
            data_api_cluster_arn=cluster_arn,
            data_api_secret_arn=secret_arn,
        )


def test_production_requires_complete_cognito_configuration() -> None:
    with pytest.raises(ValidationError, match="Cognito configuration is required"):
        Settings(
            env="production",
            db_host="database.internal",
            db_user="opengeo_runtime",
            db_password=SecretStr("not-a-real-secret"),
        )


def test_cognito_issuer_and_jwks_url_are_derived_not_configured() -> None:
    settings = Settings(
        env="test",
        cognito_region="us-east-1",
        cognito_user_pool_id="us-east-1_example",
        cognito_client_id="client-123",
    )

    assert (
        settings.cognito_issuer == "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example"
    )
    assert settings.cognito_jwks_url == f"{settings.cognito_issuer}/.well-known/jwks.json"
    assert settings.cognito_provisioning_enabled is True
    assert settings.cognito_client_ids == ("client-123",)

    external_pool_settings = Settings(
        env="test",
        cognito_region="us-east-1",
        cognito_user_pool_id="us-east-1_example",
        cognito_client_id="client-123",
        cognito_provisioning_enabled=False,
    )
    assert external_pool_settings.auth_configured is True
    assert external_pool_settings.cognito_provisioning_enabled is False

    application = create_app(external_pool_settings)
    assert isinstance(
        application.state.membership_repository._identity_provisioner,
        UnavailableIdentityProvisioner,
    )


def test_cognito_client_allowlist_is_exact_bounded_and_unique() -> None:
    settings = Settings(
        env="test",
        cognito_region="us-east-1",
        cognito_user_pool_id="us-east-1_example",
        cognito_client_id="client-123",
        cognito_additional_client_ids="client-456,client-789",
    )
    assert settings.cognito_client_ids == ("client-123", "client-456", "client-789")

    for invalid in (
        "",
        "client-456, client-789",
        "client-456,client-456",
        "client-123",
        "one,two,three,four",
    ):
        with pytest.raises(ValidationError):
            Settings(
                env="test",
                cognito_region="us-east-1",
                cognito_user_pool_id="us-east-1_example",
                cognito_client_id="client-123",
                cognito_additional_client_ids=invalid,
            )

    with pytest.raises(ValidationError, match="complete Cognito configuration"):
        Settings(env="test", cognito_additional_client_ids="client-456")


def test_upload_storage_configuration_is_complete_scoped_and_bounded() -> None:
    with pytest.raises(ValidationError, match="required together"):
        Settings(env="test", geodata_bucket="opengeo-geodata")

    settings = Settings(
        env="test",
        aws_region="us-east-1",
        application_bucket="source.opengeo.tools",
        geodata_bucket="opengeo-geodata",
        geodata_kms_key_arn=(
            "arn:aws:kms:us-east-1:111111111111:key/12345678-1234-1234-1234-123456789012"
        ),
        upload_url_ttl_seconds=600,
        upload_max_bytes=1024,
    )
    assert settings.upload_configured is True
    assert settings.source_upload_configured is True
    assert settings.upload_url_ttl_seconds == 600
    assert settings.upload_max_bytes == 1024


def test_page_source_storage_requires_a_valid_application_bucket_and_common_key() -> None:
    with pytest.raises(ValidationError, match="required with application_bucket"):
        Settings(env="test", application_bucket="source.opengeo.tools")
    with pytest.raises(ValidationError, match="application_bucket is invalid"):
        Settings(
            env="test",
            aws_region="us-east-1",
            application_bucket="Bad_Source_Bucket",
            geodata_bucket="storage.opengeo.tools",
            geodata_kms_key_arn=(
                "arn:aws:kms:us-east-1:111111111111:key/12345678-1234-1234-1234-123456789012"
            ),
        )


def test_observable_builder_image_is_optional_but_must_be_checksum_pinned() -> None:
    assert Settings(env="test").observable_builder_image_digest is None
    digest = f"sha256:{'a' * 64}"
    assert (
        Settings(env="test", observable_builder_image_digest=digest).observable_builder_image_digest
        == digest
    )
    with pytest.raises(ValidationError, match="exact sha256 digest"):
        Settings(env="test", observable_builder_image_digest="opengeo-builder:latest")


def test_observable_preview_origin_is_optional_canonical_and_isolated() -> None:
    assert Settings(env="test").observable_preview_origin is None
    origin = "https://preview.studio.opengeo.tools"
    assert (
        Settings(env="test", observable_preview_origin=origin).observable_preview_origin == origin
    )
    for invalid in [
        "http://preview.studio.opengeo.tools",
        "https://preview.studio.opengeo.tools/",
        "https://studio.opengeo.tools",
    ]:
        with pytest.raises(ValidationError, match=r"canonical HTTPS|separate from Studio"):
            Settings(env="test", observable_preview_origin=invalid)


def test_public_maps_preview_requires_separate_origin_and_existing_private_preview() -> None:
    assert Settings(env="test").observable_public_maps_preview_origin is None
    origin = "https://maps-preview.studio.opengeo.tools"
    with pytest.raises(ValidationError, match="requires the private preview origin"):
        Settings(env="test", observable_public_maps_preview_origin=origin)
    common = {"env": "test", "observable_preview_origin": "https://preview.studio.opengeo.tools"}
    assert (
        Settings(
            **common, observable_public_maps_preview_origin=origin
        ).observable_public_maps_preview_origin
        == origin
    )
    for invalid in [
        "http://maps-preview.studio.opengeo.tools",
        "https://maps-preview.studio.opengeo.tools/",
        "https://preview.studio.opengeo.tools",
        "https://studio.opengeo.tools",
    ]:
        with pytest.raises(ValidationError, match=r"canonical HTTPS|separate"):
            Settings(**common, observable_public_maps_preview_origin=invalid)


def test_independent_installation_can_configure_exact_preview_origins() -> None:
    settings = Settings(
        env="test",
        observable_preview_origin="https://preview.customer.example:8443",
        observable_public_maps_preview_origin="https://maps.customer.example",
    )
    assert settings.observable_preview_origin == "https://preview.customer.example:8443"
    for invalid in [
        "https://preview.customer.example/path",
        "https://user@preview.customer.example",
        "https://preview.customer.example?next=x",
        "https://preview.customer.example#x",
        "https://preview.customer.example:0",
        "https://preview.customer.example\n",
        "HTTPS://preview.customer.example",
        "https://preview.customer.example:443",
        "http://127.0.0.1:80",
        "http://192.168.1.1:8080",
        "http://localhost.evil.example:8080",
    ]:
        with pytest.raises(ValidationError, match="canonical HTTPS"):
            Settings(env="test", observable_preview_origin=invalid)


@pytest.mark.parametrize("environment", ["dev", "test", "staging", "production"])
def test_plain_http_preview_is_confined_to_explicit_local_development(environment: str) -> None:
    origin = "http://127.0.0.1:8766"
    if environment in {"dev", "test"}:
        configured = Settings(env=environment, observable_preview_origin=origin)
        assert configured.observable_preview_origin == origin
    else:
        with pytest.raises(ValidationError, match="canonical HTTPS"):
            Settings(
                env=environment,
                observable_preview_origin=origin,
                database_url=SecretStr("postgresql://opengeo_runtime@database.internal/opengeo"),
                cognito_region="us-east-1",
                cognito_user_pool_id="us-east-1_test",
                cognito_client_id="preview-test-client",
            )


def test_observable_preview_signing_configuration_is_complete_and_region_scoped() -> None:
    with pytest.raises(ValidationError, match="required together"):
        Settings(env="test", observable_preview_key_pair_id="KEYPAIR123")
    common = {
        "env": "test",
        "aws_region": "us-east-1",
        "geodata_bucket": "storage.opengeo.tools",
        "geodata_kms_key_arn": (
            "arn:aws:kms:us-east-1:111111111111:key/12345678-1234-1234-1234-123456789012"
        ),
        "observable_preview_origin": "https://preview.studio.opengeo.tools",
        "observable_preview_key_pair_id": "KEYPAIR123",
        "observable_preview_private_key_secret_arn": (
            "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/preview-AbCd"
        ),
    }
    assert Settings(**common).observable_preview_signing_configured is True
    with pytest.raises(ValidationError, match="must be in aws_region"):
        Settings(
            **{
                **common,
                "observable_preview_private_key_secret_arn": (
                    "arn:aws:secretsmanager:us-west-2:111111111111:secret:opengeo/preview-AbCd"
                ),
            }
        )


@pytest.mark.parametrize(
    ("bucket", "key_arn"),
    [
        (
            "Bad_Bucket",
            "arn:aws:kms:us-east-1:111111111111:key/12345678-1234-1234-1234-123456789012",
        ),
        (
            "opengeo-geodata",
            "arn:aws:kms:us-west-2:111111111111:key/12345678-1234-1234-1234-123456789012",
        ),
        ("127.0.0.1", "arn:aws:kms:us-east-1:111111111111:key/key-id"),
    ],
)
def test_upload_storage_rejects_ambiguous_bucket_or_cross_region_key(
    bucket: str, key_arn: str
) -> None:
    with pytest.raises(ValidationError, match="geodata_"):
        Settings(
            env="test",
            aws_region="us-east-1",
            geodata_bucket=bucket,
            geodata_kms_key_arn=key_arn,
        )


def test_render_dispatch_queue_is_optional_and_must_match_the_aws_region() -> None:
    base = {
        "env": "test",
        "aws_region": "us-east-1",
        "geodata_bucket": "opengeo-geodata",
        "geodata_kms_key_arn": (
            "arn:aws:kms:us-east-1:111111111111:key/12345678-1234-1234-1234-123456789012"
        ),
    }
    settings = Settings(
        **base,
        processing_queue_url=(
            "https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-processing"
        ),
    )
    assert settings.render_dispatch_configured is True

    verification = Settings(
        **base,
        connection_verification_queue_url=(
            "https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-verification"
        ),
    )
    assert verification.connection_verification_dispatch_configured is True

    dataset_verification = Settings(
        **base,
        user_dataset_verification_queue_url=(
            "https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-dataset-verification"
        ),
    )
    assert dataset_verification.user_dataset_verification_dispatch_configured is True

    repository_browser = Settings(
        **base,
        user_dataset_repository_browser_function_name=(
            "opengeo-dev-user-dataset-repository-browser"
        ),
    )
    assert repository_browser.user_dataset_repository_browser_configured is True

    observable = Settings(
        **base,
        observable_build_queue_url=(
            "https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-observable-builds"
        ),
    )
    assert observable.observable_build_dispatch_configured is True

    source_snapshot = Settings(
        **base,
        external_source_snapshot_queue_url=(
            "https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-source-snapshots"
        ),
    )
    assert source_snapshot.external_source_snapshot_dispatch_configured is True
    assert source_snapshot.external_source_discovery_dispatch_configured is True

    with pytest.raises(ValidationError, match="SQS URL in aws_region"):
        Settings(
            **base,
            processing_queue_url=(
                "https://sqs.us-west-2.amazonaws.com/111111111111/opengeo-processing"
            ),
        )

    with pytest.raises(ValidationError, match="connection_verification_queue_url"):
        Settings(
            **base,
            connection_verification_queue_url=(
                "https://sqs.us-west-2.amazonaws.com/111111111111/opengeo-verification"
            ),
        )

    with pytest.raises(ValidationError, match="observable_build_queue_url"):
        Settings(
            **base,
            observable_build_queue_url=(
                "https://sqs.us-west-2.amazonaws.com/111111111111/opengeo-observable-builds"
            ),
        )

    with pytest.raises(ValidationError, match="user_dataset_verification_queue_url"):
        Settings(
            **base,
            user_dataset_verification_queue_url=(
                "https://sqs.us-west-2.amazonaws.com/111111111111/opengeo-dataset-verification"
            ),
        )

    with pytest.raises(ValidationError, match="external_source_snapshot_queue_url"):
        Settings(
            **base,
            external_source_snapshot_queue_url=(
                "https://sqs.us-west-2.amazonaws.com/111111111111/opengeo-source-snapshots"
            ),
        )

    with pytest.raises(ValidationError, match="requires aws_region"):
        Settings(
            env="test",
            user_dataset_repository_browser_function_name="opengeo-browser",
        )

    with pytest.raises(ValidationError, match="function_name is invalid"):
        Settings(
            **base,
            user_dataset_repository_browser_function_name="not/a/function",
        )


def test_wms_synchronous_wait_is_bounded_and_polling_cannot_exceed_it() -> None:
    settings = Settings(
        env="test",
        wms_sync_wait_seconds=12.0,
        wms_sync_poll_seconds=0.5,
    )
    assert settings.wms_sync_wait_seconds == 12.0
    assert settings.wms_sync_poll_seconds == 0.5

    with pytest.raises(ValidationError, match="cannot exceed"):
        Settings(
            env="test",
            wms_sync_wait_seconds=0.05,
            wms_sync_poll_seconds=0.1,
        )

    with pytest.raises(ValidationError):
        Settings(env="test", wms_sync_wait_seconds=15.01)


@pytest.mark.parametrize(
    ("discovery_queue", "snapshot_queue", "expected_discovery_queue"),
    [
        (None, None, None),
        (
            None,
            "https://sqs.us-east-1.amazonaws.com/111111111111/legacy-source",
            "https://sqs.us-east-1.amazonaws.com/111111111111/legacy-source",
        ),
        (
            "https://sqs.us-east-1.amazonaws.com/111111111111/discovery-only",
            None,
            "https://sqs.us-east-1.amazonaws.com/111111111111/discovery-only",
        ),
        (
            "https://sqs.us-east-1.amazonaws.com/111111111111/discovery-only",
            "https://sqs.us-east-1.amazonaws.com/111111111111/legacy-source",
            "https://sqs.us-east-1.amazonaws.com/111111111111/discovery-only",
        ),
    ],
)
def test_discovery_queue_selection_preserves_app_dispatch_boundaries(
    discovery_queue: str | None,
    snapshot_queue: str | None,
    expected_discovery_queue: str | None,
) -> None:
    configured = Settings(
        env="test",
        aws_region="us-east-1",
        geodata_bucket="opengeo-geodata",
        geodata_kms_key_arn=(
            "arn:aws:kms:us-east-1:111111111111:key/12345678-1234-1234-1234-123456789012"
        ),
        external_source_discovery_queue_url=discovery_queue,
        external_source_snapshot_queue_url=snapshot_queue,
    )
    assert configured.effective_external_source_discovery_queue_url == expected_discovery_queue
    assert configured.external_source_discovery_dispatch_configured is (
        expected_discovery_queue is not None
    )
    assert configured.external_source_snapshot_dispatch_configured is (snapshot_queue is not None)

    application = create_app(configured)
    assert application.state.external_source_discovery_dispatcher.available is (
        expected_discovery_queue is not None
    )
    assert application.state.external_source_snapshot_dispatcher.available is (
        snapshot_queue is not None
    )
    assert application.state.geonode_harvest_dispatcher.available is (snapshot_queue is not None)


@pytest.mark.parametrize(
    ("aws_region", "queue_url"),
    [
        ("us-east-1", "https://sqs.us-west-2.amazonaws.com/111111111111/discovery"),
        ("us-east-1", "https://example.invalid/discovery"),
        (None, "https://sqs.us-east-1.amazonaws.com/111111111111/discovery"),
    ],
)
def test_discovery_queue_requires_valid_same_region_sqs_url(
    aws_region: str | None, queue_url: str
) -> None:
    with pytest.raises(ValidationError, match="external_source_discovery_queue_url"):
        Settings(
            env="test",
            aws_region=aws_region,
            geodata_bucket="opengeo-geodata" if aws_region else None,
            geodata_kms_key_arn=(
                "arn:aws:kms:us-east-1:111111111111:key/12345678-1234-1234-1234-123456789012"
                if aws_region
                else None
            ),
            external_source_discovery_queue_url=queue_url,
        )


def test_discovery_queue_setting_loads_from_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    queue_url = "https://sqs.us-east-1.amazonaws.com/111111111111/discovery-only"
    monkeypatch.setenv("OPEN_GEO_EXTERNAL_SOURCE_DISCOVERY_QUEUE_URL", queue_url)
    configured = Settings(
        env="test",
        aws_region="us-east-1",
        geodata_bucket="opengeo-geodata",
        geodata_kms_key_arn=(
            "arn:aws:kms:us-east-1:111111111111:key/12345678-1234-1234-1234-123456789012"
        ),
        external_source_snapshot_queue_url=None,
    )
    assert configured.external_source_discovery_queue_url == queue_url
    assert configured.external_source_discovery_dispatch_configured is True
    assert configured.external_source_snapshot_dispatch_configured is False
