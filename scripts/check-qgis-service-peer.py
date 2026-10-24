"""Exercise an administered OpenGeo service through QGIS' native OAPIF provider."""

from __future__ import annotations

import gc
import json
import os
import stat
import sys
from pathlib import Path
from urllib.parse import urlsplit

from qgis.core import (
    Qgis,
    QgsApplication,
    QgsDataSourceUri,
    QgsFeatureRequest,
    QgsHttpHeaders,
    QgsNetworkAccessManager,
    QgsRectangle,
    QgsVectorLayer,
)

EXPECTED_VERSION = "3.44.12-Solothurn"
SAVED_CONNECTION_VERSION = "3.44.14-Solothurn"
SAVED_CONNECTION_NAME = "OpenGeo administered saved-auth peer"
USER_AGENT = "OpenGeo-QGIS-Service-Peer/1.0"


def source_uri(base_url: str, headers: dict[str, str]) -> str:
    uri = QgsDataSourceUri()
    uri.setParam("url", base_url)
    uri.setParam("typename", "roads")
    uri.setParam("pagingEnabled", "true")
    uri.setParam("pageSize", "1")
    uri.setParam("restrictToRequestBBOX", "1")
    uri.setHttpHeaders(QgsHttpHeaders(headers))
    return uri.uri(False)


def layer_error(layer: QgsVectorLayer) -> str:
    error = layer.error()
    return error.summary() or error.message()


def saved_connection_paths(input_path: Path) -> tuple[Path, Path]:
    """Refuse an inherited desktop profile or authentication database."""
    if os.environ.get("QGIS_AUTH_DB_URI") or os.environ.get("QGIS_AUTH_PASSWORD_FILE"):
        raise RuntimeError("saved connection requires an isolated local authentication database")
    directory = input_path.parent
    paths = []
    for key in ("QGIS_CUSTOM_CONFIG_PATH", "QGIS_AUTH_DB_DIR_PATH"):
        value = os.environ.get(key)
        if not value:
            raise RuntimeError(f"{key} must select a private temporary directory")
        path = Path(value)
        if not path.is_absolute() or path.resolve() != path:
            raise RuntimeError("saved connection paths must be absolute without symlinks")
        if path == directory or not path.is_relative_to(directory):
            raise RuntimeError("saved connection paths must belong to the auth input directory")
        paths.append(path)
    for path in (directory, *paths):
        metadata = path.lstat()
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_mode & 0o777 != 0o700
            or metadata.st_uid != os.geteuid()
        ):
            raise RuntimeError("saved connection directories must be owned private directories")
    return paths[0], paths[1]


def saved_connection_uri(auth_input: dict, phase: str, auth_directory: Path):
    """Use QGIS' stock dialog and encrypted authentication manager, never a hook."""
    from qgis.core import QgsAuthMethodConfig, QgsOwsConnection, QgsSettings
    from qgis.gui import QgsNewHttpConnection
    from qgis.PyQt.QtWidgets import QComboBox, QDialog, QLineEdit, QTabWidget

    manager = QgsApplication.authManager()
    if manager.isDisabled():
        raise RuntimeError("QGIS authentication manager is unavailable")
    database = Path(manager.authenticationDatabasePath()).resolve()
    if database.parent != auth_directory:
        raise RuntimeError("QGIS selected an authentication database outside the temporary directory")
    if "APIHeader" not in manager.authMethodsKeys():
        raise RuntimeError("QGIS APIHeader authentication method is unavailable")
    if not manager.setMasterPassword(auth_input["masterPassword"], True):
        raise RuntimeError("QGIS could not unlock the isolated authentication database")

    if phase == "save":
        if SAVED_CONNECTION_NAME in QgsOwsConnection.connectionList("WFS"):
            raise RuntimeError("saved connection already exists; committed setup must not be replayed")
        config = QgsAuthMethodConfig("APIHeader")
        config.setVersion(manager.authMethod("APIHeader").version())
        config.setName(SAVED_CONNECTION_NAME)
        config.setUri(auth_input["baseUrl"])
        config.setConfigMap({
            "Authorization": f"Bearer {auth_input['token']}",
            "X-OpenGeo-Organization": auth_input["organizationId"],
        })
        stored, config = manager.storeAuthenticationConfig(config)
        if not stored or not config.id():
            raise RuntimeError("QGIS could not save encrypted APIHeader configuration")
        dialog = QgsNewHttpConnection(
            None, QgsNewHttpConnection.ConnectionWfs, "qgis/connections-wfs/"
        )
        for name, value in (
            ("txtName", SAVED_CONNECTION_NAME), ("txtUrl", auth_input["baseUrl"])
        ):
            widget = dialog.findChild(QLineEdit, name)
            if widget is None:
                raise RuntimeError("stock QGIS connection dialog has an unexpected layout")
            widget.setText(value)
        version = dialog.findChild(QComboBox, "cmbVersion")
        authentication = dialog.findChild(QComboBox, "cmbConfigSelect")
        if version is None or authentication is None:
            raise RuntimeError("stock QGIS connection dialog lacks protocol/authentication controls")
        version.setCurrentIndex(QgsNewHttpConnection.WFS_VERSION_API_FEATURES_1_0)
        config_index = authentication.findData(config.id())
        if config_index < 0:
            raise RuntimeError("stock QGIS connection dialog did not list the auth configuration")
        authentication.setCurrentIndex(config_index)
        for tabs in dialog.findChildren(QTabWidget):
            for index in range(tabs.count()):
                if tabs.widget(index).isAncestorOf(authentication):
                    tabs.setCurrentIndex(index)
        if authentication.currentData() != config.id():
            raise RuntimeError("stock QGIS connection dialog did not select the auth configuration")
        dialog.accept()
        if dialog.result() != QDialog.Accepted:
            raise RuntimeError("stock QGIS connection dialog did not save the connection")
        dialog = None
        QgsSettings().sync()

    if SAVED_CONNECTION_NAME not in QgsOwsConnection.connectionList("WFS"):
        raise RuntimeError("stock QGIS saved connection was not found")
    uri = QgsOwsConnection("WFS", SAVED_CONNECTION_NAME).uri()
    authcfg = uri.authConfigId()
    if uri.param("url") != auth_input["baseUrl"] or not authcfg:
        raise RuntimeError("stock QGIS saved connection changed URL or lost authentication")
    if uri.param("version") != "OGC_API_FEATURES":
        raise RuntimeError("stock QGIS saved connection did not retain OGC API Features selection")
    config = QgsAuthMethodConfig()
    loaded, config = manager.loadAuthenticationConfig(authcfg, config, True)
    if not loaded or config.method() != "APIHeader":
        raise RuntimeError("stock QGIS saved connection did not load encrypted APIHeader configuration")
    headers = config.configMap()
    bearer = headers.get("Authorization", "")
    if (
        not bearer.startswith("Bearer ")
        or len(bearer) <= len("Bearer ")
        or headers.get("X-OpenGeo-Organization") != auth_input["organizationId"]
    ):
        raise RuntimeError("saved APIHeader configuration lacks the required authority")
    if phase == "save" and bearer != f"Bearer {auth_input['token']}":
        raise RuntimeError("saved APIHeader configuration changed the supplied authority")
    uri.setParam("typename", "roads")
    uri.setParam("pagingEnabled", "true")
    uri.setParam("pageSize", "1")
    uri.setParam("restrictToRequestBBOX", "1")
    uri.setHttpHeaders(QgsHttpHeaders({"User-Agent": USER_AGENT}))
    encoded = uri.uri(False)
    secrets = (bearer, bearer.removeprefix("Bearer "), auth_input["masterPassword"])
    if any(secret in encoded for secret in secrets):
        raise RuntimeError("saved connection URI contains a plaintext secret")
    return encoded, authcfg, secrets


def scan_saved_connection_files(directories: tuple[Path, Path], secrets: tuple[str, ...]) -> int:
    """Check the actual closed profile/authentication files, including SQLite bytes."""
    files = set()
    total_bytes = 0
    for directory in directories:
        for path in directory.rglob("*"):
            if path.is_symlink():
                raise RuntimeError("saved connection profile contains a symlink")
            if path.is_file():
                files.add(path)
    for path in files:
        total_bytes += path.stat().st_size
        if len(files) > 128 or total_bytes > 32 * 1024 * 1024:
            raise RuntimeError("saved connection secret scan exceeded its bounded profile size")
        contents = path.read_bytes()
        if any(
            secret.encode(encoding) in contents
            for secret in secrets for encoding in ("utf8", "utf-16-le")
        ):
            raise RuntimeError("saved connection profile contains a plaintext secret")
    return len(files)


def main() -> None:
    phase = None
    if len(sys.argv) == 3 and sys.argv[2] in (
        "--saved-connection=save", "--saved-connection=reopen"
    ):
        phase = sys.argv[2].split("=", 1)[1]
    elif len(sys.argv) != 2:
        raise SystemExit(
            "usage: check-qgis-service-peer.py AUTH_INPUT [--saved-connection=save|reopen]"
        )
    input_path = Path(sys.argv[1]).resolve()
    if input_path.stat().st_mode & 0o777 != 0o600:
        raise RuntimeError("QGIS auth input must have mode 0600")
    auth_input = json.loads(input_path.read_text(encoding="utf8"))
    base_url = auth_input["baseUrl"]
    token = auth_input.get("token") if phase else auth_input["token"]
    organization_id = auth_input["organizationId"]
    project_id = auth_input["projectId"]
    feature_id = auth_input["featureId"]
    split_url = urlsplit(base_url)
    trusted_prefix = f"{split_url.scheme}://{split_url.netloc}/projects/{project_id}/"

    saved_paths = None
    if phase:
        if (
            Path(sys.argv[1]).is_symlink()
            or input_path.stat().st_uid != os.geteuid()
            or not isinstance(auth_input.get("masterPassword"), str)
            or len(auth_input["masterPassword"]) < 16
            or (phase == "save" and (not isinstance(token, str) or not token))
            or (phase == "reopen" and "token" in auth_input)
        ):
            raise RuntimeError("saved connection requires private phase-specific authentication input")
        if (
            split_url.scheme != "http" or split_url.hostname != "127.0.0.1"
            or split_url.username or split_url.password or split_url.query or split_url.fragment
            or not split_url.path.startswith(f"/projects/{project_id}/")
        ):
            raise RuntimeError("saved connection peer must target its exact loopback project")
        saved_paths = saved_connection_paths(input_path)
        os.umask(0o077)
    app = QgsApplication([], bool(phase), str(saved_paths[0])) if phase else QgsApplication([], False)
    if saved_paths:
        QgsApplication.setAuthDatabaseDirPath(str(saved_paths[1]))
    app.initQgis()
    unauthenticated = None
    layer = None
    filtered_layer = None
    features = []
    preprocessor_id = None
    network_manager = None
    result = None
    saved_secrets = ()
    try:
        expected_version = SAVED_CONNECTION_VERSION if phase else EXPECTED_VERSION
        if Qgis.QGIS_VERSION != expected_version:
            raise RuntimeError(
                f"expected QGIS {expected_version}, observed {Qgis.QGIS_VERSION}"
            )

        unauthenticated = QgsVectorLayer(
            source_uri(base_url, {"User-Agent": USER_AGENT}),
            "OpenGeo administered service unauthenticated",
            "OAPIF",
        )
        if unauthenticated.isValid():
            raise RuntimeError(
                "QGIS unexpectedly opened the administered service without shared authentication"
            )

        def authorize_request(network_request) -> None:
            request_url = network_request.url().toString()
            if request_url == base_url or request_url.startswith(trusted_prefix):
                network_request.setRawHeader(
                    b"Authorization", f"Bearer {token}".encode()
                )
                network_request.setRawHeader(
                    b"X-OpenGeo-Organization", organization_id.encode()
                )
                network_request.setRawHeader(b"User-Agent", USER_AGENT.encode())

        if phase:
            authenticated_uri, authcfg, saved_secrets = saved_connection_uri(
                auth_input, phase, saved_paths[1]
            )
        else:
            network_manager = QgsNetworkAccessManager.instance()
            preprocessor_id = network_manager.setRequestPreprocessor(authorize_request)
            authenticated_uri = source_uri(base_url, {})
        layer = QgsVectorLayer(
            authenticated_uri,
            "OpenGeo administered roads",
            "OAPIF",
        )
        if not layer.isValid():
            raise RuntimeError(f"QGIS OAPIF discovery failed: {layer_error(layer)}")
        fields = [field.name() for field in layer.fields()]

        filtered_layer = QgsVectorLayer(
            authenticated_uri,
            "OpenGeo administered roads filtered",
            "OAPIF",
        )
        if not filtered_layer.isValid():
            raise RuntimeError(
                f"QGIS OAPIF filtered layer failed: {layer_error(filtered_layer)}"
            )
        requested_bbox = QgsRectangle(-77.11, 38.79, -76.89, 39.01)
        request = QgsFeatureRequest().setFilterRect(requested_bbox)
        features = list(filtered_layer.getFeatures(request))
        if len(features) != 1:
            raise RuntimeError(f"expected one QGIS feature, observed {len(features)}")
        feature = features[0]
        geometry = json.loads(feature.geometry().asJson(12))
        if geometry["type"] != "LineString":
            raise RuntimeError(f"expected LineString, observed {geometry['type']}")
        observed_id = str(feature["id"]) if "id" in fields else None
        if observed_id is not None and observed_id != feature_id:
            raise RuntimeError(f"expected feature {feature_id}, observed {observed_id}")

        result = {
            "client": {
                "product": "QGIS native OGC API Features provider",
                "providerKey": layer.providerType(),
                "version": Qgis.QGIS_VERSION,
            },
            "discovery": {
                "collection": "roads",
                "fields": fields,
                "geometryType": geometry["type"],
            },
            "read": {
                "featureId": observed_id,
                "expectedFeatureId": feature_id,
                "name": str(feature["name"]),
                "surveyed": bool(feature["surveyed"]),
                "geometry": geometry,
            },
            "security": {
                "unauthenticatedRejected": True,
                "credentialsPersisted": False,
                "authInputMode": "0600",
                "requestScope": trusted_prefix,
            },
        }
        if phase:
            result["security"].update({
                "credentialsPersisted": True,
                "plaintextCredentialsPersisted": False,
            })
            del result["security"]["requestScope"]
            result["savedConnection"] = {
                "phase": phase,
                "name": SAVED_CONNECTION_NAME,
                "authcfg": authcfg,
                "authMethod": "APIHeader",
                "stockConnectionDialog": True,
                "processLocalHeaderInjection": False,
                "encryptedAuthPersisted": True,
                "plaintextSecretsFound": False,
                "authDatabaseIsolated": True,
                "tokenSuppliedInInput": phase == "save",
                "limitations": [
                    "Stock APIHeader adds credentials whenever its authcfg is supplied; it does not enforce a destination allowlist. Use only a trusted service and trusted discovery/redirect links.",
                    "This manually supplied static local bearer has no sign-in or token refresh integration. Expired credentials require deliberate replacement; human GUI and deployed TLS acceptance remain open.",
                ],
            }
    finally:
        features.clear()
        filtered_layer = None
        layer = None
        unauthenticated = None
        gc.collect()
        if network_manager is not None and preprocessor_id is not None:
            network_manager.removeRequestPreprocessor(preprocessor_id)
        app.processEvents()
        gc.collect()
        app.exitQgis()
    if result is not None and phase:
        result["savedConnection"]["scannedFiles"] = scan_saved_connection_files(
            saved_paths, saved_secrets
        )
    if result is not None:
        print(json.dumps(result, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    if not os.environ.get("QGIS_CUSTOM_CONFIG_PATH"):
        raise SystemExit("QGIS_CUSTOM_CONFIG_PATH must select an ephemeral profile")
    main()
