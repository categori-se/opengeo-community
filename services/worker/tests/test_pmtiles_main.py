import json
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID

import pytest

from opengeo_worker.models import QueueMessage
from opengeo_worker.pmtiles_main import PmtilesWorkerProcessor

JOB_ID = UUID("b9000000-0000-4000-8000-000000000001")


def processor(body: str) -> PmtilesWorkerProcessor:
    instance = object.__new__(PmtilesWorkerProcessor)
    instance._settings = SimpleNamespace(visibility_seconds=900, max_message_bytes=262144)
    instance._queue = Mock()
    instance._queue.receive.return_value = QueueMessage("message", "receipt", body, 1)
    instance._process_pmtiles_derivative = Mock(return_value="completed")
    return instance


@pytest.mark.parametrize(
    "body",
    [
        "not-json",
        json.dumps({"schema": "opengeo.render.command.v1", "render_job_id": str(JOB_ID)}),
        json.dumps({"Records": [{"eventSource": "aws:s3"}]}),
        json.dumps(
            {
                "schema": "opengeo.pmtiles-derivative.command.v1",
                "pmtiles_derivative_job_id": str(JOB_ID),
                "recipe": "gdal-pmtiles-v2",
            }
        ),
    ],
)
def test_isolated_worker_preserves_other_lane_and_extra_field_messages(body: str) -> None:
    instance = processor(body)
    assert instance.process_once() == "retry"
    instance._process_pmtiles_derivative.assert_not_called()
    instance._queue.delete.assert_not_called()
    instance._queue.change_visibility.assert_called_once_with("receipt", 30)


@pytest.mark.parametrize("outcome", ["completed", "discarded", "retry"])
def test_isolated_worker_reuses_claim_and_acknowledges_only_terminal_outcome(outcome: str) -> None:
    instance = processor(
        json.dumps(
            {
                "schema": "opengeo.pmtiles-derivative.command.v1",
                "pmtiles_derivative_job_id": str(JOB_ID),
            }
        )
    )
    instance._process_pmtiles_derivative.return_value = outcome
    assert instance.process_once() == outcome
    instance._process_pmtiles_derivative.assert_called_once_with(
        JOB_ID, instance._queue.receive.return_value
    )
    if outcome == "retry":
        instance._queue.delete.assert_not_called()
    else:
        instance._queue.delete.assert_called_once_with("receipt")
