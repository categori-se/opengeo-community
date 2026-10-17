"""Consume only canonical v2 PMTiles commands from the isolated PMTiles queue."""

import logging
import signal
import threading

from opengeo_worker.aws_clients import S3Storage, SqsQueue
from opengeo_worker.config import Settings
from opengeo_worker.events import parse_pmtiles_derivative_command
from opengeo_worker.models import TransientFailure, ValidationFailure, WorkerError
from opengeo_worker.processor import ProcessOutcome, WorkerProcessor
from opengeo_worker.repository import WorkerRepository

logger = logging.getLogger(__name__)


class PmtilesWorkerProcessor(WorkerProcessor):
    """The shared queue's ingestion/render/reclamation parsers are never reached."""

    def process_once(self) -> ProcessOutcome:
        message = self._queue.receive(self._settings.visibility_seconds)
        if message is None:
            return "empty"
        try:
            command = parse_pmtiles_derivative_command(
                message.body, max_message_bytes=self._settings.max_message_bytes
            )
        except ValidationFailure:
            command = None
        if command is None:
            # Preserve an unexpected command for the queue's bounded DLQ policy.
            # Never acknowledge a message belonging to another processing lane.
            self._queue.change_visibility(message.receipt_handle, 30)
            logger.warning("PMTiles queue contains an unsupported command")
            return "retry"
        outcome = self._process_pmtiles_derivative(command.pmtiles_derivative_job_id, message)
        if outcome != "retry":
            self._queue.delete(message.receipt_handle)
        return outcome


def run() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = Settings.from_env()
    if settings.pmtiles_worker_image_digest is None:
        raise WorkerError("pmtiles_worker_image_digest_required")
    stop = threading.Event()

    def request_stop(signum: int, frame: object) -> None:
        del signum, frame
        stop.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    processor = PmtilesWorkerProcessor(
        settings,
        queue=SqsQueue(settings),
        repository=WorkerRepository(settings, pmtiles_profile="v2"),
        storage=S3Storage(settings),
    )
    backoff_seconds = 1
    while not stop.is_set():
        try:
            processor.process_once()
            backoff_seconds = 1
        except TransientFailure as error:
            logger.warning("PMTiles dependency unavailable error_code=%s", error.code)
            stop.wait(backoff_seconds)
            backoff_seconds = min(backoff_seconds * 2, 30)


if __name__ == "__main__":
    run()
