import importlib.util
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).parents[1] / "scripts/export_openapi.py"


def load_exporter():
    spec = importlib.util.spec_from_file_location("export_openapi", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def child_python(code: str, *, env: dict[str, str] | None = None):
    result = subprocess.run(
        [sys.executable, "-c", code, str(SCRIPT)],
        env=env,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return result


LOAD_EXPORTER = """
import importlib.util
import sys
spec = importlib.util.spec_from_file_location('export_openapi', sys.argv[1])
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)
"""


def test_cli_discards_inherited_configuration_before_loading_settings() -> None:
    environment = {
        **os.environ,
        "OPEN_GEO_PORT": "invalid-inherited-port",
        "OPEN_GEO_ENV": "production",
        "OPEN_GEO_DATA_API_CLUSTER_ARN": "synthetic-unusable-cluster",
        "AWS_PROFILE": "synthetic-unused-profile",
        "AWS_ACCESS_KEY_ID": "synthetic-unused-key",
        "AWS_SECRET_ACCESS_KEY": "synthetic-unused-secret",
    }
    result = child_python(
        LOAD_EXPORTER
        + """
def inspect_configuration():
    import os
    from opengeo_api.config import Settings
    assert dict(os.environ) == {}
    settings = Settings(env='test', expose_docs=False)
    assert settings.port == 8080
    assert not settings.expose_docs
    assert not settings.database_configured
    assert not settings.auth_configured
    assert not settings.upload_configured
    assert not settings.render_dispatch_configured
    return b'{}\\n'
exporter.render_contract = inspect_configuration
sys.argv = ['export_openapi.py', '--stdout']
assert exporter.main() == 0
""",
        env=environment,
    )
    assert result.stdout == "{}\n"
    assert result.stderr == ""


def test_offline_guard_blocks_network_audit_events_dns_and_process_operations() -> None:
    result = child_python(
        LOAD_EXPORTER
        + """
import socket
import subprocess
sys.addaudithook(exporter.prohibit_network)
operations = [
    # Exercise audit events without requiring kernel socket permission in CI.
    ('socket.connect', lambda: sys.audit('socket.connect', None, ('127.0.0.1', 9))),
    ('socket.bind', lambda: sys.audit('socket.bind', None, ('127.0.0.1', 0))),
    ('socket.getaddrinfo', lambda: socket.getaddrinfo('127.0.0.1', 9)),
    ('subprocess.Popen', lambda: subprocess.Popen([sys.executable, '-c', 'pass'])),
]
for event, operation in operations:
    try:
        operation()
    except RuntimeError as error:
        assert str(error) == f'Offline contract export blocked {event}'
    else:
        raise AssertionError(f'{event} escaped the offline guard')
print('blocked socket, DNS and process operations')
"""
    )
    assert result.stdout == "blocked socket, DNS and process operations\n"
    assert result.stderr == ""


def test_check_rejects_stale_contract_without_writing(tmp_path, monkeypatch) -> None:
    exporter = load_exporter()
    contract = tmp_path / "openapi.json"
    old_content = b'{"stale": true}\n'
    contract.write_bytes(old_content)
    calls = []

    def fresh_export(command, *, env, capture_output, timeout):
        assert command == [sys.executable, str(SCRIPT.resolve()), "--stdout"]
        assert env == {} and capture_output is True and timeout == 120
        calls.append(command)
        return SimpleNamespace(stdout=b"{}\n", stderr=b"", returncode=0)

    monkeypatch.setattr(exporter, "CONTRACT", contract)
    monkeypatch.setattr(exporter.subprocess, "run", fresh_export)
    monkeypatch.setattr(sys, "argv", [str(SCRIPT), "--check"])

    with pytest.raises(ValueError, match="Saved contract differs"):
        exporter.main()

    assert len(calls) == 2
    assert contract.read_bytes() == old_content
