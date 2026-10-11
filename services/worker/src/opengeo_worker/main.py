import logging
import signal
import threading

from opengeo_worker.aws_clients import S3Storage, SqsQueue
from opengeo_worker.config import Settings
from opengeo_worker.models import TransientFailure
from opengeo_worker.processor import WorkerProcessor
from opengeo_worker.repository import WorkerRepository


def run() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    settings = Settings.from_env()
    stop = threading.Event()

    def request_stop(signum: int, frame: object) -> None:
        del signum, frame
        stop.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    processor = WorkerProcessor(
        settings,
        queue=SqsQueue(settings),
        repository=WorkerRepository(settings),
        storage=S3Storage(settings),
    )
    backoff_seconds = 1
    while not stop.is_set():
        try:
            processor.process_once()
            backoff_seconds = 1
        except TransientFailure as error:
            logging.getLogger(__name__).warning(
                "worker dependency unavailable error_code=%s", error.code
            )
            stop.wait(backoff_seconds)
            backoff_seconds = min(backoff_seconds * 2, 30)


if __name__ == "__main__":
    run()
