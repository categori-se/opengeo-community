import sys
import unittest
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from controller import LANES, Observation, Stack, Window, WindowUnsafe, advance


class WindowTests(unittest.TestCase):
    def setUp(self):
        self.window = Window(
            "test-window", 100, 1900, 2800, "endpoint-hash", "worker-hash"
        )
        self.endpoint = Stack(
            "endpoint-arn", "CREATE_COMPLETE", "endpoint-hash", "test-window"
        )
        self.worker = Stack(
            "worker-arn", "CREATE_COMPLETE", "worker-hash", "test-window"
        )

    def observation(self, **changes):
        return replace(
            Observation(
                110,
                self.endpoint,
                self.worker,
                (0, 0, 0),
                (0, 0, 0),
                {lane: 0 for lane in LANES},
                True,
                0,
            ),
            **changes,
        )

    def test_full_activation_drain_and_cleanup(self):
        w = self.window
        first = advance(w, self.observation(endpoints=None, worker=None), now=110)
        self.assertEqual(first.command.kind, "endpoints")
        self.assertTrue(first.window.endpoint_requested)
        w = advance(first.window, self.observation(worker=None), now=110).window
        self.assertEqual(w.phase, "worker")
        step = advance(w, self.observation(worker=None), now=110)
        self.assertEqual(step.command.kind, "worker")
        self.assertTrue(step.window.worker_requested)
        w = advance(step.window, self.observation(), now=110).window
        self.assertEqual(w.phase, "processing")
        w = advance(w, self.observation(), now=110).window
        self.assertEqual(w.outcome, "drained")
        step = advance(w, self.observation(), now=110)
        self.assertEqual(
            (step.command.kind, step.command.operation, step.command.stack_id),
            ("worker", "remove", self.worker.id),
        )
        self.assertIsNone(
            advance(
                w,
                self.observation(
                    worker=replace(self.worker, status="DELETE_IN_PROGRESS")
                ),
                now=110,
            ).command
        )
        w = advance(w, self.observation(worker=None), now=110).window
        step = advance(w, self.observation(worker=None), now=110)
        self.assertEqual(
            (step.command.kind, step.command.operation), ("endpoints", "remove")
        )
        w = advance(w, self.observation(worker=None, endpoints=None), now=110).window
        self.assertEqual(w.phase, "complete")

    def test_queue_approximation_does_not_hide_durable_work(self):
        w = replace(self.window, phase="processing")
        for lane in LANES:
            jobs = {name: int(name == lane) for name in LANES}
            self.assertEqual(
                advance(w, self.observation(unfinished=jobs), now=110).waiting,
                "processing",
            )
        for change in [
            {"unfinished": None},
            {"unfinished": {}},
            {"unfiltered": False},
            {"queue": None},
            {"queue": (0, 1, 0)},
            {"queue": (0, 0, 1)},
            {"dead_letters": (1, 0, 0)},
            {"worker_tasks": None},
        ]:
            result = advance(w, self.observation(**change), now=110)
            if "worker_tasks" not in change:
                self.assertEqual(result.waiting, "processing")

    def test_pmtiles_isolated_drain_requires_exact_v2_lane_and_empty_queue(self):
        observation = self.observation(unfinished={"pmtiles": 0}, lanes=frozenset({"pmtiles"}))
        self.assertTrue(observation.drained())
        for changes in (
            {"unfinished": {"pmtiles": 1}},
            {"unfinished": {"pmtiles": 0, "ingest": 0}},
            {"lanes": LANES},
            {"queue": (0, 1, 0)},
            {"dead_letters": (1, 0, 0)},
        ):
            self.assertFalse(replace(observation, **changes).drained())

    def test_work_arriving_during_drain_resumes_same_window(self):
        w = replace(self.window, phase="remove-worker", outcome="drained")
        step = advance(w, self.observation(queue=(1, 0, 0)), now=110)
        self.assertEqual(step.window.phase, "processing")
        self.assertEqual(step.window.deadline, w.deadline)
        self.assertIsNone(step.command)

    def test_deadline_aborts_without_claiming_drain_or_extending_budget(self):
        w = replace(self.window, phase="processing")
        obs = self.observation(observed_at=1901, queue=(5, 1, 0))
        step = advance(w, obs, now=1901)
        self.assertEqual(step.window.outcome, "deadline-abort")
        self.assertEqual(step.command.operation, "remove")
        self.assertEqual(step.window.cleanup_deadline, 2800)
        with self.assertRaisesRegex(WindowUnsafe, "cleanup_deadline"):
            advance(step.window, replace(obs, observed_at=2800), now=2800)

    def test_lost_create_response_reuses_token_and_reconciles_before_cleanup(self):
        obs = self.observation(worker=None, endpoints=None)
        first = advance(self.window, obs, now=110)
        again = advance(first.window, obs, now=110)
        self.assertEqual(first.command, again.command)
        after_deadline = replace(obs, observed_at=1901)
        step = advance(first.window, after_deadline, now=1901)
        step = advance(step.window, after_deadline, now=1901)
        self.assertEqual(step.waiting, "endpoint_creation_reconciliation")
        self.assertNotEqual(step.window.phase, "complete")

    def test_late_cleanup_receipt_can_finish_without_mutation_or_extended_budget(self):
        window = replace(
            self.window, phase="remove-endpoints", outcome="drained",
            endpoint_requested=True, worker_requested=True,
            endpoint_id=self.endpoint.id, worker_id=self.worker.id,
        )
        absent = self.observation(observed_at=2900, worker=None, endpoints=None)
        result = advance(window, absent, now=2900)
        self.assertEqual(result.window, replace(window, phase="complete"))
        self.assertIsNone(result.command)
        shared = replace(self.endpoint, template_hash="coordinator-hash", owner=None)
        shared_window = replace(window, shared_endpoint_id=shared.id,
                                shared_endpoint_hash=shared.template_hash)
        result = advance(shared_window, replace(absent, endpoints=shared), now=2900)
        self.assertEqual(result.window, replace(shared_window, phase="complete"))
        self.assertIsNone(result.command)
        # A late observation cannot turn unknown submission or unfinished cleanup
        # into success, nor bypass existing ownership/identity checks.
        for unsafe_window, observation in [
            (window, replace(absent, worker_tasks=1)),
            (window, replace(absent, worker_tasks=None)),
            (window, replace(absent, endpoints=self.endpoint)),
            (replace(window, worker_id=None), absent),
            (replace(window, endpoint_id=None), absent),
            (shared_window, absent),
            (shared_window, replace(absent, endpoints=self.endpoint)),
            (window, replace(absent, endpoints=replace(self.endpoint, owner="other"))),
        ]:
            with (
                self.subTest(window=unsafe_window, observation=observation),
                self.assertRaises(WindowUnsafe),
            ):
                advance(unsafe_window, observation, now=2900)

    def test_shared_coordinator_is_restored_never_deleted(self):
        shared = replace(self.endpoint, template_hash="coordinator-hash", owner=None)
        w = replace(
            self.window,
            shared_endpoint_id=shared.id,
            shared_endpoint_hash=shared.template_hash,
        )
        step = advance(w, self.observation(endpoints=shared, worker=None), now=110)
        self.assertEqual(step.command.operation, "activate")
        self.assertEqual(step.command.stack_id, shared.id)
        w = replace(step.window, phase="remove-endpoints", worker_id=self.worker.id)
        step = advance(w, self.observation(worker=None), now=110)
        self.assertEqual(step.command.operation, "restore")
        final = advance(w, self.observation(endpoints=shared, worker=None), now=110)
        self.assertEqual(final.window.phase, "complete")

    def test_stale_or_changed_boundaries_never_mutate(self):
        w = replace(self.window, phase="remove-worker", worker_id=self.worker.id)
        bad = [
            self.observation(observed_at=90),
            self.observation(worker=replace(self.worker, id="another-stack")),
            self.observation(worker=replace(self.worker, owner="other-window")),
            self.observation(worker=replace(self.worker, template_hash="changed")),
            self.observation(worker=replace(self.worker, status="DELETE_FAILED")),
            self.observation(worker=replace(self.worker, importers=("consumer",))),
        ]
        for observation in bad:
            with self.assertRaises(WindowUnsafe):
                advance(w, observation, now=110)
        with self.assertRaisesRegex(WindowUnsafe, "exports_in_use"):
            advance(
                replace(w, phase="remove-endpoints"),
                self.observation(
                    worker=None, endpoints=replace(self.endpoint, importers=("other",))
                ),
                now=110,
            )
        with self.assertRaisesRegex(WindowUnsafe, "not_removed"):
            advance(
                replace(w, phase="remove-endpoints"),
                self.observation(worker=None, worker_tasks=1),
                now=110,
            )


if __name__ == "__main__":
    unittest.main()
