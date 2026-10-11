"""Export/check the current FastAPI contract without credentials or network access."""

import argparse
import hashlib
import importlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
CONTRACT = ROOT / "docs/api/openapi.json"
EXAMPLES = ROOT / "docs/api/examples.json"
EXAMPLE_MODULES = {
    "CreateExternalSourceRequest": "external_source_routes",
    "ExternalSourceResponse": "external_source_routes",
    "CreateMapRequest": "workspace_routes",
    "UpdateMapRequest": "workspace_routes",
    "MapResponse": "workspace_routes",
    "PreparePublicationArtifactInputs": "observable_source_routes",
    "ReviewFrameworkPublicationRequest": "observable_source_routes",
    "FrameworkPublicationStatusResponse": "observable_source_routes",
}


def prohibit_network(event: str, _args: tuple[Any, ...]) -> None:
    # Install before application imports. A future eager integration fails closed.
    if event in {
        "socket.connect",
        "socket.bind",
        "socket.getaddrinfo",
        "socket.gethostbyname",
        "socket.gethostbyaddr",
        "socket.sendto",
        "socket.sendmsg",
        "subprocess.Popen",
        "os.system",
        "os.posix_spawn",
        "os.exec",
        "os.fork",
    }:
        raise RuntimeError(f"Offline contract export blocked {event}")


def validate_contract(document: dict[str, Any]) -> None:
    from fastapi.openapi.models import OpenAPI
    from openapi_schema_validator import OAS31Validator

    OpenAPI.model_validate(document)
    if document["openapi"] != "3.1.0":
        raise ValueError("Review validation tooling before changing the OpenAPI version")

    def check_refs(value: Any) -> None:
        if isinstance(value, dict):
            if "$ref" in value:
                ref = value["$ref"]
                if not isinstance(ref, str) or not ref.startswith("#/"):
                    raise ValueError(f"Non-local schema reference: {ref}")
                target: Any = document
                for token in ref[2:].split("/"):
                    target = target[token.replace("~1", "/").replace("~0", "~")]
            for child in value.values():
                check_refs(child)
        elif isinstance(value, list):
            for child in value:
                check_refs(child)

    check_refs(document)
    for schema in document["components"]["schemas"].values():
        OAS31Validator.check_schema(schema)
    operation_ids = [
        operation["operationId"]
        for path in document["paths"].values()
        for method, operation in path.items()
        if method in {"get", "put", "post", "delete", "patch", "options", "head", "trace"}
    ]
    if len(operation_ids) != len(set(operation_ids)):
        raise ValueError("Duplicate operationId")

    examples = json.loads(EXAMPLES.read_text())
    if set(examples) != set(EXAMPLE_MODULES):
        raise ValueError("Review model validation when changing the documented examples")
    for name, example in examples.items():
        module = importlib.import_module(f"opengeo_api.{EXAMPLE_MODULES[name]}")
        model = getattr(module, name)
        # extra='forbid' also catches typos in response examples whose models ignore extras.
        model.model_validate(example, extra="forbid")


def render_contract() -> bytes:
    from opengeo_api.app import create_app
    from opengeo_api.config import Settings

    # CLI clears the environment before importing the app or loading Settings.
    app = create_app(Settings(env="test", expose_docs=False))
    document = app.openapi()
    validate_contract(document)
    return (
        json.dumps(document, sort_keys=True, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    ).encode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check", action="store_true", help="Check two fresh exports and saved contract"
    )
    parser.add_argument("--stdout", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.check and args.stdout:
        parser.error("--check and --stdout are mutually exclusive")
    if args.check:
        command = [sys.executable, str(Path(__file__).resolve()), "--stdout"]
        exports = []
        for _ in range(2):
            result = subprocess.run(command, env={}, capture_output=True, timeout=120)
            if result.returncode:
                sys.stderr.buffer.write(result.stderr)
                return result.returncode
            exports.append(result.stdout)
        if exports[0] != exports[1]:
            raise ValueError("Fresh-process exports differ")
        if not CONTRACT.exists() or exports[0] != CONTRACT.read_bytes():
            raise ValueError(
                "Saved contract differs; review API changes and regenerate without --check"
            )
        document = json.loads(exports[0])
        print(
            json.dumps(
                {
                    "result": "pass",
                    "fresh_processes": 2,
                    "network": "blocked",
                    "credentials": "empty environment",
                    "openapi": document["openapi"],
                    "paths": len(document["paths"]),
                    "schemas": len(document["components"]["schemas"]),
                    "examples": len(EXAMPLE_MODULES),
                    "sha256": hashlib.sha256(exports[0]).hexdigest(),
                },
                sort_keys=True,
            )
        )
        return 0

    os.environ.clear()
    sys.addaudithook(prohibit_network)
    sys.path.insert(0, str(ROOT / "services/api/src"))
    content = render_contract()
    if args.stdout:
        sys.stdout.buffer.write(content)
    else:
        CONTRACT.parent.mkdir(parents=True, exist_ok=True)
        CONTRACT.write_bytes(content)
        print(f"Exported {CONTRACT.relative_to(ROOT)} ({len(content)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
