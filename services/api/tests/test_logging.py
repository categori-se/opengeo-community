import json
import logging

from opengeo_api.logging import JsonFormatter, configure_logging


def test_json_formatter_emits_structured_event_without_exception_text() -> None:
    record = logging.LogRecord(
        name="opengeo_api.test",
        level=logging.WARNING,
        pathname=__file__,
        lineno=10,
        msg="readiness.failed",
        args=(),
        exc_info=None,
    )
    record.check = "database"
    record.error_type = "OperationalError"

    payload = json.loads(JsonFormatter().format(record))

    assert payload["event"] == "readiness.failed"
    assert payload["check"] == "database"
    assert payload["error_type"] == "OperationalError"
    assert "exception" not in payload


def test_uvicorn_access_log_is_disabled() -> None:
    configure_logging("INFO")

    access_logger = logging.getLogger("uvicorn.access")
    assert access_logger.handlers == []
    assert access_logger.propagate is False
