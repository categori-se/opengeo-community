"""One durable step of the activation-only GIS processing lifecycle.

The caller must hold a durable lease for the window, reserve its cumulative
budget before activation, persist each returned state, and execute commands
with the returned stable token. This module never accepts a queue payload as
configuration and cannot target Foundation or application data.
"""

from dataclasses import dataclass, replace
from typing import Literal

Phase = Literal[
    "endpoints", "worker", "processing", "remove-worker", "remove-endpoints", "complete"
]
Kind = Literal["endpoints", "worker"]
Operation = Literal["activate", "remove", "restore"]
LANES = frozenset(
    {
        "ingest",
        "render",
        "coverage",
        "pmtiles",
        "coverage-reclamation",
        "tile-reclamation",
    }
)
READY = frozenset({"CREATE_COMPLETE", "UPDATE_COMPLETE"})


class WindowUnsafe(RuntimeError):
    """A changed boundary requires operator recovery, never a guessed deletion."""


@dataclass(frozen=True)
class Stack:
    id: str
    status: str
    template_hash: str
    owner: str | None
    importers: tuple[str, ...] = ()


@dataclass(frozen=True)
class Observation:
    observed_at: int
    endpoints: Stack | None
    worker: Stack | None
    queue: tuple[int, int, int] | None = None  # visible, in-flight, delayed
    dead_letters: tuple[int, int, int] | None = None
    unfinished: dict[str, int] | None = None
    unfiltered: bool = False
    worker_tasks: int | None = None
    lanes: frozenset[str] = LANES

    def drained(self) -> bool:
        return (
            self.queue == (0, 0, 0)
            and self.dead_letters == (0, 0, 0)
            and self.unfiltered is True
            and isinstance(self.unfinished, dict)
            and self.lanes in {LANES, frozenset({"pmtiles"}), frozenset({"analysis"})}
            and self.unfinished.keys() == self.lanes
            and all(
                type(count) is int and count == 0 for count in self.unfinished.values()
            )
        )


@dataclass(frozen=True)
class Window:
    id: str
    started_at: int
    deadline: int
    cleanup_deadline: int
    endpoint_hash: str
    worker_hash: str
    phase: Phase = "endpoints"
    endpoint_id: str | None = None
    worker_id: str | None = None
    # A shared coordinator's exact pre-window stack must survive cleanup.
    shared_endpoint_id: str | None = None
    shared_endpoint_hash: str | None = None
    outcome: str | None = None
    endpoint_requested: bool = False
    worker_requested: bool = False
    worker_service_name: str | None = None


@dataclass(frozen=True)
class Command:
    kind: Kind
    operation: Operation
    token: str
    stack_id: str | None


@dataclass(frozen=True)
class Step:
    window: Window
    command: Command | None = None
    waiting: str | None = None


def advance(window: Window, observation: Observation, *, now: int) -> Step:
    """Plan at most one idempotent operation from fresh, complete observations."""
    if (
        not window.id
        or not window.started_at < window.deadline < window.cleanup_deadline
    ):
        raise WindowUnsafe("invalid_window_bounds")
    if (
        not window.started_at <= observation.observed_at <= now
        or now - observation.observed_at > 30
    ):
        raise WindowUnsafe("stale_runtime_observation")
    if bool(window.shared_endpoint_id) != bool(window.shared_endpoint_hash):
        raise WindowUnsafe("incomplete_shared_endpoint_baseline")
    if window.phase == "complete":
        return Step(window)
    endpoint = observation.endpoints
    worker = observation.worker
    for kind, stack, recorded_id, expected_hash in (
        (
            "endpoints",
            endpoint,
            window.endpoint_id or window.shared_endpoint_id,
            window.endpoint_hash,
        ),
        ("worker", worker, window.worker_id, window.worker_hash),
    ):
        if stack is None:
            continue
        if recorded_id and stack.id != recorded_id:
            raise WindowUnsafe(f"{kind}_identity_changed")
        shared_baseline = (
            kind == "endpoints"
            and stack.id == window.shared_endpoint_id
            and stack.template_hash == window.shared_endpoint_hash
        )
        if not shared_baseline and (
            stack.owner != window.id or stack.template_hash != expected_hash
        ):
            raise WindowUnsafe(f"{kind}_ownership_or_template_changed")
        if "FAILED" in stack.status:
            raise WindowUnsafe(f"{kind}_operation_failed")
    # Adopt only this window's exact pinned outputs after a lost create response.
    if endpoint and not window.endpoint_id:
        window = replace(window, endpoint_id=endpoint.id)
    if worker and not window.worker_id:
        window = replace(window, worker_id=worker.id)

    if now >= window.cleanup_deadline:
        # A delayed terminal event may arrive after successful removal. Finishing
        # that receipt needs no cloud mutation and does not extend the budget.
        # Unknown create responses and remaining resources still require recovery.
        worker_removed = (
            (worker is None or worker.status == "DELETE_COMPLETE")
            and observation.worker_tasks == 0
            and (not window.worker_requested or window.worker_id is not None)
        )
        if window.shared_endpoint_id:
            endpoints_finished = (
                endpoint is not None
                and endpoint.status in READY
                and endpoint.template_hash == window.shared_endpoint_hash
            )
        else:
            endpoints_finished = (
                (endpoint is None or endpoint.status == "DELETE_COMPLETE")
                and (not window.endpoint_requested or window.endpoint_id is not None)
            )
        if window.phase == "remove-endpoints" and worker_removed and endpoints_finished:
            return Step(replace(window, phase="complete"))
        # Never silently open another window or reset the spend ceiling.
        raise WindowUnsafe("cleanup_deadline_exceeded")

    if now >= window.deadline and window.phase in {"endpoints", "worker", "processing"}:
        window = replace(window, phase="remove-worker", outcome="deadline-abort")

    def command(kind: Kind, operation: Operation, stack_id: str | None) -> Step:
        state = window
        if operation == "activate":
            state = replace(
                window,
                **{f"{kind[:-1] if kind == 'endpoints' else kind}_requested": True},
            )
        return Step(
            state, Command(kind, operation, f"{window.id}-{kind}-{operation}", stack_id)
        )

    if window.phase == "endpoints":
        if endpoint is None:
            if window.shared_endpoint_id:
                raise WindowUnsafe("shared_endpoints_missing")
            return command("endpoints", "activate", None)
        if endpoint.status not in READY:
            return Step(window, waiting="endpoint_operation")
        if endpoint.template_hash != window.endpoint_hash:
            return command("endpoints", "activate", endpoint.id)
        return Step(replace(window, phase="worker"))

    if window.phase == "worker":
        if (
            endpoint is None
            or endpoint.status not in READY
            or endpoint.template_hash != window.endpoint_hash
        ):
            raise WindowUnsafe("worker_endpoint_boundary_unavailable")
        if worker is None:
            return command("worker", "activate", None)
        if worker.status not in READY:
            return Step(window, waiting="worker_operation")
        return Step(replace(window, phase="processing"))

    if window.phase == "processing":
        if worker is None or endpoint is None:
            raise WindowUnsafe("active_runtime_missing")
        if worker.status not in READY or endpoint.status not in READY:
            return Step(window, waiting="runtime_operation")
        if not observation.drained():
            return Step(window, waiting="processing")
        return Step(replace(window, phase="remove-worker", outcome="drained"))

    if window.phase == "remove-worker":
        if worker is None and window.worker_requested and not window.worker_id:
            return Step(window, waiting="worker_creation_reconciliation")
        if worker is not None and worker.status != "DELETE_COMPLETE":
            if worker.status not in READY and worker.status != "ROLLBACK_COMPLETE":
                return Step(window, waiting="worker_operation")
            if worker.importers:
                raise WindowUnsafe("worker_exports_in_use")
            # New work may arrive between the prior drain and this step. Resume
            # the same bounded window; never lose it or declare it completed.
            if window.outcome == "drained" and not observation.drained():
                if now < window.deadline:
                    return Step(replace(window, phase="processing", outcome=None))
                window = replace(window, outcome="deadline-abort")
            return command("worker", "remove", worker.id)
        if observation.worker_tasks != 0:
            return Step(window, waiting="worker_tasks")
        return Step(replace(window, phase="remove-endpoints"))

    if window.phase == "remove-endpoints":
        if (
            worker is not None
            and worker.status != "DELETE_COMPLETE"
            or observation.worker_tasks != 0
        ):
            raise WindowUnsafe("worker_not_removed")
        if window.shared_endpoint_id:
            if endpoint is None:
                raise WindowUnsafe("shared_endpoints_missing")
            if endpoint.status not in READY:
                return Step(window, waiting="endpoint_operation")
            if endpoint.template_hash == window.shared_endpoint_hash:
                return Step(replace(window, phase="complete"))
            return command("endpoints", "restore", endpoint.id)
        if endpoint is None and window.endpoint_requested and not window.endpoint_id:
            return Step(window, waiting="endpoint_creation_reconciliation")
        if endpoint is None or endpoint.status == "DELETE_COMPLETE":
            return Step(replace(window, phase="complete"))
        if endpoint.status not in READY and endpoint.status != "ROLLBACK_COMPLETE":
            return Step(window, waiting="endpoint_operation")
        if endpoint.importers:
            raise WindowUnsafe("endpoint_exports_in_use")
        return command("endpoints", "remove", endpoint.id)
    raise WindowUnsafe("unknown_window_phase")
