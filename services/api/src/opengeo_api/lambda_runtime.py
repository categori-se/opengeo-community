import importlib
import json
import os
import re
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, cast
from urllib.request import Request, urlopen

_RUNTIME_VERSION = "2018-06-01"
_HANDLER_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_.]*\.[A-Za-z_][A-Za-z0-9_]*\Z")
_MAX_INVOCATION_BYTES = 1_048_576
_MAX_RESPONSE_BYTES = 6_000_000


@dataclass(frozen=True, slots=True)
class LambdaRuntimeContext:
    aws_request_id: str
    deadline_ms: int
    invoked_function_arn: str

    def get_remaining_time_in_millis(self) -> int:
        import time

        return max(0, self.deadline_ms - round(time.time() * 1000))


def resolve_handler(reference: str) -> Callable[[Mapping[str, Any], object], Any]:
    if not _HANDLER_PATTERN.fullmatch(reference):
        raise ValueError("Lambda handler reference is invalid")
    module_name, function_name = reference.rsplit(".", 1)
    handler = getattr(importlib.import_module(module_name), function_name, None)
    if not callable(handler):
        raise ValueError("Lambda handler is not callable")
    return cast(Callable[[Mapping[str, Any], object], Any], handler)


def main() -> None:
    runtime_api = os.environ.get("AWS_LAMBDA_RUNTIME_API")
    if not runtime_api or not re.fullmatch(r"[A-Za-z0-9.:-]{1,512}", runtime_api):
        raise RuntimeError("Lambda runtime API is unavailable")
    if len(sys.argv) != 2:
        raise RuntimeError("Lambda handler argument is required")
    invocation_handler = resolve_handler(sys.argv[1])
    base_url = f"http://{runtime_api}/{_RUNTIME_VERSION}/runtime"

    while True:
        with urlopen(f"{base_url}/invocation/next") as response:
            request_id = response.headers.get("Lambda-Runtime-Aws-Request-Id", "")
            deadline = response.headers.get("Lambda-Runtime-Deadline-Ms", "0")
            invoked_arn = response.headers.get("Lambda-Runtime-Invoked-Function-Arn", "")
            trace_id = response.headers.get("Lambda-Runtime-Trace-Id")
            raw_event = response.read(_MAX_INVOCATION_BYTES + 1)
        if trace_id:
            os.environ["_X_AMZN_TRACE_ID"] = trace_id
        try:
            if len(raw_event) > _MAX_INVOCATION_BYTES:
                raise ValueError("Lambda invocation exceeds the runtime boundary")
            event = json.loads(raw_event)
            if not isinstance(event, dict) or not request_id:
                raise ValueError("Lambda invocation is invalid")
            context = LambdaRuntimeContext(request_id, int(deadline), invoked_arn)
            result = invocation_handler(event, context)
            payload = json.dumps(result, separators=(",", ":")).encode()
            if len(payload) > _MAX_RESPONSE_BYTES:
                raise ValueError("Lambda response exceeds the runtime boundary")
        except Exception as error:
            error_payload = json.dumps(
                {
                    "errorMessage": "Unhandled invocation error",
                    "errorType": type(error).__name__,
                    "stackTrace": [],
                },
                separators=(",", ":"),
            ).encode()
            _post(f"{base_url}/invocation/{request_id}/error", error_payload)
        else:
            _post(f"{base_url}/invocation/{request_id}/response", payload)


def _post(url: str, payload: bytes) -> None:
    request = Request(url, data=payload, headers={"content-type": "application/json"})
    with urlopen(request, timeout=10):
        pass


if __name__ == "__main__":
    main()
