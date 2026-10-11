"""Produce a local dry-run envelope; there is deliberately no remote-write option."""

import argparse
import json
import sys
from hashlib import sha256
from pathlib import Path
from typing import Any


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON keys are unsupported")
        result[key] = value
    return result


def _offline(event: str, _args: tuple[Any, ...]) -> None:
    if event.startswith("socket.") or event in {"subprocess.Popen", "os.system", "os.posix_spawn"}:
        raise RuntimeError("STAC-to-CKAN export is offline")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--output", type=Path, help="Local JSON envelope; defaults to stdout")
    args = parser.parse_args()
    sys.addaudithook(_offline)
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
    from opengeo_api.ckan_export import export_stac_ckan
    from opengeo_api.metadata_adapters import MetadataImportInvalid

    try:
        with args.input.open("rb") as source:
            raw = source.read(65_537)
        if len(raw) > 65_536:
            raise ValueError("input exceeds 65536 raw bytes")
        document = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object)
        if not isinstance(document, dict):
            raise ValueError("input must be a STAC Collection object")
        result = export_stac_ckan(document, namespace=args.namespace)
        result["source"]["rawFileSha256"] = sha256(raw).hexdigest()
        rendered = json.dumps(result, ensure_ascii=False, allow_nan=False, sort_keys=True, indent=2)
        if args.output:
            args.output.write_text(rendered + "\n", encoding="utf-8")
        else:
            print(rendered)
    except (OSError, UnicodeError, ValueError, MetadataImportInvalid, RecursionError):
        # Do not echo input, local paths or parser context that might contain secrets.
        print(
            "STAC-to-CKAN export rejected: unsupported, unsafe or unreadable input.",
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
