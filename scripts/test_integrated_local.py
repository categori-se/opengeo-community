"""Check initialization and cleanup without starting containers."""

import importlib.util
import asyncio
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location(
    "integrated_pilot", Path(__file__).with_name("run-integrated-pilot-local.py")
)
pilot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pilot)

STUDIO_SPEC = importlib.util.spec_from_file_location(
    "integrated_studio", Path(__file__).with_name("run-integrated-studio-local.py")
)
studio = importlib.util.module_from_spec(STUDIO_SPEC)
STUDIO_SPEC.loader.exec_module(studio)

PUBLICATION_SPEC = importlib.util.spec_from_file_location(
    "local_publication_bridge", Path(__file__).with_name("local-publication-bridge.py")
)
publication = importlib.util.module_from_spec(PUBLICATION_SPEC)
PUBLICATION_SPEC.loader.exec_module(publication)


class PmtilesRuntimeTests(unittest.TestCase):
    def building_input_preview_state(self, directory, tree="a" * 64):
        root, work, helper = self.building_review_state(directory)
        path = root / ".local-archives/baseline-intelligence-20261023/admission.json"
        document = json.loads(path.read_text())
        document["batches"].append({"id": "BI-02-retained-building-input-preview", "inventory": {"appTree": tree}, "limits": {
            "localAccountApiRequests": 80, "localAccountMillisecondsIncludingShutdown": 120_000,
            "localAccountWorkMilliseconds": 110_000, "localAccountInitialAttempts": 1, "localAccountMaximumAttempts": 2,
            "catalogWrites": 0, "projectWrites": 0, "originalUploads": 0, "workerBatches": 0, "nativeComputations": 0,
            "exactOriginalReadbacks": 6, "exactOriginalBytes": 20_000, "automaticRetries": 0, "AWSAccountCalls": 0,
            "SecretsDataApiKmsCalls": 0, "GitHubAccountApiCalls": 0, "Actions": 0, "providerRequests": 0,
            "applicationBuilds": 1, "newDependencies": 0, "newInfrastructure": 0, "newAnalysisRuntimes": 0}})
        path.write_text(json.dumps(document))
        pins = {"source": ("2b53931f-1c74-4190-9174-56b502b65a3b", "0db0f821-65a0-4846-9204-6cffd0f0bead"),
                "comparison": ("466da7fc-36ce-4b9c-8909-c1292c2deaf3", "d5f6c478-7a4e-4c3a-86c3-554e29ede4ac"),
                "output": ("fd40ec51-601c-4180-b235-070fb2be186f", "4b711032-952d-411f-9cf1-ddf4ca6d3a1f")}
        records = {key: {"datasetId": dataset, "datasetVersionId": version, "versionNumber": 1,
                         "uploadCompleted": True, "retainedHistory": {"oldAttempt": True}}
                   for key, (dataset, version) in pins.items()}
        project_id, map_id = "1938b127-af37-4c1e-8a90-c1d12282a172", "e4df81ea-9cac-4809-ad80-87a391ce9dd5"
        accepted = {"status": "pass", "projectId": project_id, "mapId": map_id, "records": records,
                    "map": {"id": map_id, "project_id": project_id, "version": 3, "definition": {"layers": [
                        {"datasetId": dataset, "datasetVersionId": version} for dataset, version in pins.values()]}},
                    "mapSaved": True, "mapReopened": True, "exactFeaturesReopened": True, "archiveVerified": True,
                    "apiRequestAttempts": 144, "activeMilliseconds": 52_049}
        (work / "building-review-progress.json").write_text(json.dumps(accepted, indent=2) + "\n")
        for name in ("stac-items-progress.json", "stac-items-profile.json", "building-review-browser-result.json",
                     "receptor-screening-browser-result.json", "raster-catalog-browser-result.json", "raster-validation-browser-result.json"):
            (work / name).write_text("retained historical receipt\n")
        (work / "worker-command.json").write_text('["retained-worker-command"]\n')
        return root, work, helper, accepted

    def test_building_input_preview_cli_is_exclusive_and_requires_retained_development(self):
        selected = ["--development", "--state-directory", "/tmp/building-input-preview-state",
                    "--reuse-studio-tree", "a" * 64, "--building-input-preview-smoke"]
        self.assertTrue(studio.parse_args(selected).building_input_preview_smoke)
        self.assertEqual(studio.parse_args(selected + ["--building-input-preview-continuation-sha256", "b" * 64])
                         .building_input_preview_continuation_sha256, "b" * 64)
        for arguments in (["--building-input-preview-smoke"], selected + ["--stac-items-smoke"],
                          selected + ["--building-review-smoke"], selected + ["--rebuild-studio"],
                          selected + ["--analysis-only"], selected + ["--worker-image", "a" * 64],
                          ["--building-input-preview-continuation-sha256", "b" * 64]):
            with self.subTest(arguments=arguments), self.assertRaises(SystemExit), patch("sys.stderr", io.StringIO()):
                studio.parse_args(arguments)

    def test_building_input_preview_copies_exact_seed_and_preserves_prior_tree_and_receipts(self):
        with tempfile.TemporaryDirectory() as directory:
            root, work, _, accepted = self.building_input_preview_state(directory, tree="b" * 64)
            old_bytes = (work / "building-review-progress.json").read_bytes()
            (work / "built-studio/app/dist/index.html").write_text("accepted STAC tree")
            def stage(work, tree):
                (work / "built-studio/app/dist").mkdir(parents=True)
                (work / "studio-build-manifest.json").write_text(json.dumps({"artifactTree": {"digest": tree}}))
            with patch.object(studio, "ROOT", root), patch.object(studio, "stage_built_studio", side_effect=stage) as staging, \
                    patch.object(studio.subprocess, "run") as external:
                result = studio.stage_building_review(work, "b" * 64, building_input_preview=True)
                staging.assert_called_once_with(work, "b" * 64); external.assert_not_called()
            self.assertEqual((work / f"building-input-preview-prior-studio-{'a' * 64}/app/dist/index.html").read_text(), "accepted STAC tree")
            profile = json.loads((work / "building-input-preview-profile.json").read_text())
            self.assertEqual(profile["schemaVersion"], "opengeo.integrated-building-input-preview.1")
            self.assertEqual((profile["maximumApiRequests"], profile["maximumMilliseconds"], profile["maximumWorkMilliseconds"]), (80, 120_000, 110_000))
            self.assertEqual((profile["maximumOriginalUploads"], profile["maximumWorkerBatches"], profile["maximumNativeComputations"]), (0, 0, 0))
            self.assertEqual((profile["maximumOriginalReadbacks"], profile["maximumOriginalReadbackBytes"]), (6, 20_000))
            for key in ("projectId", "mapId", "map", "records"):
                self.assertEqual(result[key], accepted[key]); self.assertEqual(profile[key], accepted[key])
            self.assertEqual(result["acceptedBuildingReceiptSha256"], pilot.digest(old_bytes))
            self.assertEqual((work / "building-review-progress.json").read_bytes(), old_bytes)
            self.assertIn("stac-items-progress.json", result["preservedReceipts"])
            self.assertIn("worker-command.json", result["preservedReceipts"])
            self.assertEqual((work / "worker-command.json").read_text(), '["retained-worker-command"]\n')

    def test_building_input_preview_rejects_noncurrent_or_widened_admission_and_wrong_tree(self):
        for changed in ("tree", "native", "readbacks", "not-last"):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as directory:
                root, work, _, _ = self.building_input_preview_state(directory)
                admission = root / ".local-archives/baseline-intelligence-20261023/admission.json"
                data = json.loads(admission.read_text())
                if changed == "native": data["batches"][-1]["limits"]["nativeComputations"] = 1
                if changed == "readbacks": data["batches"][-1]["limits"]["exactOriginalReadbacks"] = 7
                if changed == "not-last": data["batches"].append({"id": "another-workflow"})
                admission.write_text(json.dumps(data))
                with patch.object(studio, "ROOT", root), patch.object(studio, "stage_built_studio") as stage, self.assertRaisesRegex(ValueError, "admitted|admission"):
                    studio.stage_building_review(work, "b" * 64 if changed == "tree" else "a" * 64, building_input_preview=True)
                stage.assert_not_called(); self.assertFalse((work / "building-input-preview-progress.json").exists())

    def test_building_input_preview_requires_successful_exact_building_record_and_map_pins(self):
        for changed in ("status", "version", "record", "map-pin"):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as directory:
                root, work, _, accepted = self.building_input_preview_state(directory)
                if changed == "status": accepted["status"] = "failed"
                if changed == "version": accepted["map"]["version"] = 4
                if changed == "record": accepted["records"]["source"]["datasetVersionId"] = "changed"
                if changed == "map-pin": accepted["map"]["definition"]["layers"].pop()
                (work / "building-review-progress.json").write_text(json.dumps(accepted))
                with patch.object(studio, "ROOT", root), self.assertRaisesRegex(ValueError, "accepted|identity|pins"):
                    studio.stage_building_review(work, "a" * 64, building_input_preview=True)
                self.assertFalse((work / "building-input-preview-progress.json").exists())

    def test_building_input_preview_continuation_preserves_costs_and_seed_and_requires_one_changed_helper(self):
        with tempfile.TemporaryDirectory() as directory:
            root, work, helper, accepted = self.building_input_preview_state(directory)
            with patch.object(studio, "ROOT", root):
                first = studio.stage_building_review(work, "a" * 64, building_input_preview=True)
                with self.assertRaisesRegex(ValueError, "diagnosis"):
                    studio.stage_building_review(work, "a" * 64, building_input_preview=True)
                first.update(apiRequestAttempts=34, activeMilliseconds=22_000, exactOriginalReadbacks=2, exactOriginalReadbackBytes=1040,
                             retainedProof={"source": True})
                path = work / "building-input-preview-progress.json"; path.write_text(json.dumps(first))
                helper.write_text("changed helper addressing the diagnosed rendering failure"); pin = pilot.digest(helper.read_bytes())
                bad = json.loads(path.read_text()); bad["records"]["source"]["retainedHistory"] = {}; path.write_text(json.dumps(bad))
                with self.assertRaisesRegex(ValueError, "seed changed"):
                    studio.stage_building_review(work, "a" * 64, pin, building_input_preview=True)
                path.write_text(json.dumps(first))
                resumed = studio.stage_building_review(work, "a" * 64, pin, building_input_preview=True)
                self.assertEqual((resumed["serviceAttempts"], resumed["apiRequestAttempts"], resumed["activeMilliseconds"]), (2, 34, 22_000))
                self.assertEqual((resumed["exactOriginalReadbacks"], resumed["exactOriginalReadbackBytes"]), (2, 1040))
                self.assertEqual(resumed["records"], accepted["records"]); self.assertTrue(resumed["retainedProof"]["source"])
                with self.assertRaisesRegex(ValueError, "budget"):
                    studio.stage_building_review(work, "a" * 64, pin, building_input_preview=True)

    def test_building_input_preview_rejects_queued_work_writes_and_exhausted_cumulative_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            root, work, helper, _ = self.building_input_preview_state(directory)
            with patch.object(studio, "ROOT", root):
                (work / "queue.json").write_text('[{"unrelated":"job"}]')
                with self.assertRaisesRegex(ValueError, "unrelated queued"):
                    studio.stage_building_review(work, "a" * 64, building_input_preview=True)
                (work / "queue.json").write_text("[]")
                first = studio.stage_building_review(work, "a" * 64, building_input_preview=True)
                helper.write_text("changed helper diagnosing cumulative closure"); pin = pilot.digest(helper.read_bytes())
                path = work / "building-input-preview-progress.json"
                for key, value in (("apiRequestAttempts", 80), ("activeMilliseconds", 110_000),
                                   ("exactOriginalReadbacks", 6), ("exactOriginalReadbackBytes", 20_000), ("catalogWrites", 1), ("workerBatches", 1)):
                    bad = {**first, key: value}; path.write_text(json.dumps(bad))
                    with self.subTest(key=key), self.assertRaisesRegex(ValueError, "budget|writes or jobs"):
                        studio.stage_building_review(work, "a" * 64, pin, building_input_preview=True)
                path.write_text(json.dumps(first)); (work / "pmtiles-v2.json").write_text('[{"unrelated":"job"}]')
                with self.assertRaisesRegex(ValueError, "unrelated queued"):
                    studio.stage_building_review(work, "a" * 64, pin, building_input_preview=True)

    def test_raster_catalog_requires_one_retained_exclusive_scope(self):
        selected = ["--development", "--state-directory", "/tmp/raster-catalog-state",
                    "--reuse-studio-tree", "a" * 64, "--raster-catalog-smoke"]
        self.assertTrue(studio.parse_args(selected).raster_catalog_smoke)
        self.assertEqual(studio.parse_args(selected + ["--raster-catalog-continuation-sha256", "b" * 64])
                         .raster_catalog_continuation_sha256, "b" * 64)
        for extra in (["--rebuild-studio"], ["--receptor-screening-smoke"], ["--building-review-smoke"],
                      ["--postgis-fixture"], ["--publication-only"], ["--print-smoke"], ["--analysis-only"],
                      ["--baseline-study", "/tmp/baseline.json"], ["--analysis-profile", "/tmp/profile.json"],
                      ["--raster-catalog-continuation-sha256", "unreviewed"]):
            with self.subTest(extra=extra), self.assertRaises(SystemExit), patch("sys.stderr", io.StringIO()):
                studio.parse_args(selected + extra)
        for arguments in (["--raster-catalog-smoke"], ["--raster-catalog-continuation-sha256", "b" * 64]):
            with self.assertRaises(SystemExit), patch("sys.stderr", io.StringIO()):
                studio.parse_args(arguments)

    def raster_catalog_state(self, directory):
        root, work, helper = self.receptor_screening_state(directory)
        admission = root / ".local-archives/baseline-intelligence-20261023/admission.json"
        document = json.loads(admission.read_text())
        document["batches"].append({"id": "BI-04-07-raster-output-catalog", "limits": {
            "localAccountApiRequestAttempts": 240, "localAccountCumulativeMillisecondsIncludingShutdown": 180_000,
            "localAccountServiceAttempts": 2, "initialLocalAccountAttempts": 1, "derivedOriginalUploads": 2,
            "ingestionJobs": 2, "workerBatches": 1, "nativeComputations": 0, "originalArchiveReadbacks": 2,
            "sourceExports": 0, "automaticRetries": 0, "newSourceTransfers": 0, "AWSAccountCalls": 0,
            "SecretsDataApiKmsCalls": 0, "GitHubCalls": 0, "Actions": 0, "providerCalls": 0,
            "metadataWebCalls": 0, "newDependencies": 0, "newInfrastructure": 0, "newAnalysisRuntimes": 0,
            "localRetainedCogRangeRequests": 8, "localRetainedCogRangeBytes": 6480,
            "localOriginalArchiveReadbackBytes": 4_400_000, "localOutputDisplayTickets": 4,
            "localOutputDisplayOriginalReads": 4, "localOutputDisplayBytes": 305_244}})
        admission.write_text(json.dumps(document))
        (work / "receptor-screening-progress.json").write_text("retained prior screening receipt")
        return root, work, helper

    def test_raster_catalog_preserves_source_history_and_cumulative_changed_helper_continuation(self):
        with tempfile.TemporaryDirectory() as directory:
            root, work, helper = self.raster_catalog_state(directory)
            source = {"datasetId": "exact-retained-source", "datasetVersionId": "exact-version", "dataObjectId": "exact-original"}
            with patch.object(studio, "ROOT", root), patch.object(studio, "retained_raster_catalog_source", return_value=source):
                first = studio.stage_raster_catalog(work, "a" * 64)
                profile = json.loads((work / "raster-catalog-profile.json").read_text())
                self.assertEqual(profile["maximumApiRequests"], 240)
                self.assertEqual(profile["maximumWorkMilliseconds"], 170_000)
                self.assertEqual(profile["maximumNativeComputations"], 0)
                self.assertEqual(profile["maximumWorkerBatches"], 1)
                self.assertEqual(profile["maximumCogRangeBytes"], 6480)
                self.assertEqual(profile["source"], source)
                self.assertIn("receptor-screening-progress.json", first["preservedReceipts"])
                with self.assertRaisesRegex(ValueError, "diagnosis"):
                    studio.stage_raster_catalog(work, "a" * 64)
                first.update(apiRequestAttempts=90, activeMilliseconds=35_000,
                             records={"comparison": {"datasetId": "derived", "uploadCompleted": True}})
                (work / "raster-catalog-progress.json").write_text(json.dumps(first))
                helper.write_text("changed helper addressing diagnosed raster failure")
                resumed = studio.stage_raster_catalog(work, "a" * 64, pilot.digest(helper.read_bytes()))
                self.assertEqual(resumed["serviceAttempts"], 2)
                self.assertEqual(resumed["apiRequestAttempts"], 90)
                self.assertEqual(resumed["activeMilliseconds"], 35_000)
                self.assertTrue(resumed["records"]["comparison"]["uploadCompleted"])
                self.assertEqual((work / "receptor-screening-progress.json").read_text(), "retained prior screening receipt")
                with self.assertRaisesRegex(ValueError, "exhausted"):
                    studio.stage_raster_catalog(work, "a" * 64, pilot.digest(helper.read_bytes()))

    def test_raster_catalog_rejects_widened_admission_and_unrelated_continuation_jobs(self):
        with tempfile.TemporaryDirectory() as directory:
            root, work, helper = self.raster_catalog_state(directory)
            with patch.object(studio, "ROOT", root), patch.object(studio, "retained_raster_catalog_source", return_value={"pin": "fixed"}):
                admission = root / ".local-archives/baseline-intelligence-20261023/admission.json"
                document = json.loads(admission.read_text())
                document["batches"][-1]["limits"]["nativeComputations"] = 1
                admission.write_text(json.dumps(document))
                with self.assertRaisesRegex(ValueError, "exact finite batch"):
                    studio.stage_raster_catalog(work, "a" * 64)
                self.assertFalse((work / "raster-catalog-progress.json").exists())
                document["batches"][-1]["limits"]["nativeComputations"] = 0
                admission.write_text(json.dumps(document))
                first = studio.stage_raster_catalog(work, "a" * 64)
                first["records"] = {"comparison": {"datasetId": "derived", "uploadCompleted": True}}
                (work / "raster-catalog-progress.json").write_text(json.dumps(first))
                helper.write_text("diagnosed changed raster helper")
                pin = pilot.digest(helper.read_bytes())
                message = lambda value: {"body": json.dumps({"Records": [{"s3": {"object": {"key": f"organizations/a/datasets/{value}/original"}}}]})}
                for queue in ([message("unrelated")], [message("derived"), message("derived")]):
                    (work / "queue.json").write_text(json.dumps(queue))
                    with self.assertRaisesRegex(ValueError, "unrelated or duplicate"):
                        studio.stage_raster_catalog(work, "a" * 64, pin)
                (work / "queue.json").write_text("[]")
                with patch.object(studio, "retained_raster_catalog_source", return_value={"pin": "changed"}):
                    with self.assertRaisesRegex(ValueError, "source changed"):
                        studio.stage_raster_catalog(work, "a" * 64, pin)
                for update in ({"status": "pass"}, {"apiRequestAttempts": 240}, {"activeMilliseconds": 170_000}):
                    (work / "raster-catalog-progress.json").write_text(json.dumps({**first, **update}))
                    with self.assertRaises(ValueError):
                        studio.stage_raster_catalog(work, "a" * 64, pin)

    def test_raster_catalog_source_requires_exact_owned_original_and_accepted_map_pins(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            native = b"retained native fixture"
            (work / "landcover.tif").write_bytes(native)
            (work / "baseline-progress.json").write_text(json.dumps({"status": "pass", "records": {"landcover": {}}}))
            with self.assertRaisesRegex(ValueError, "exact accepted source"):
                studio.retained_raster_catalog_source(work)
            (work / "landcover.tif").unlink()
            (work / "landcover.tif").symlink_to(work / "baseline-progress.json")
            with self.assertRaisesRegex(ValueError, "owned retained native"):
                studio.retained_raster_catalog_source(work)

    def test_receptor_screening_requires_one_retained_exclusive_scope(self):
        selected = ["--development", "--state-directory", "/tmp/receptor-screening-state",
                    "--reuse-studio-tree", "a" * 64, "--receptor-screening-smoke"]
        self.assertTrue(studio.parse_args(selected).receptor_screening_smoke)
        self.assertEqual(studio.parse_args(selected + ["--receptor-screening-continuation-sha256", "b" * 64])
                         .receptor_screening_continuation_sha256, "b" * 64)
        for arguments in (["--receptor-screening-smoke"], selected + ["--rebuild-studio"],
                          selected + ["--building-review-smoke"], selected + ["--postgis-fixture"],
                          selected + ["--publication-only"], selected + ["--print-smoke"],
                          selected + ["--baseline-study", "/tmp/baseline.json"],
                          selected + ["--analysis-profile", "/tmp/profile.json"],
                          selected + ["--receptor-screening-continuation-sha256", "unreviewed"],
                          ["--receptor-screening-continuation-sha256", "b" * 64]):
            with self.subTest(arguments=arguments), self.assertRaises(SystemExit), patch("sys.stderr", io.StringIO()):
                studio.parse_args(arguments)

    def receptor_screening_state(self, directory):
        root, work, helper = self.building_review_state(directory)
        admission = root / ".local-archives/baseline-intelligence-20261023/admission.json"
        document = json.loads(admission.read_text())
        document["batches"].append({"id": "BI-05-main-account-receptor-screening", "limits": {
            "apiRequestAttempts": 180, "cumulativeServiceMillisecondsIncludingShutdown": 180_000,
            "shutdownReserveMilliseconds": 10_000, "serviceAttempts": 2, "initialServiceAttempts": 1,
            "originalUploads": 4, "ingestionJobs": 4, "workerBatches": 2, "nativeClips": 2,
            "nativeCollections": 3, "originalArchiveReadbacks": 1, "syntheticProjects": 1, "syntheticMaps": 1,
            "AWSAccountCalls": 0, "SecretsDataApiKmsCalls": 0, "GitHubCalls": 0, "Actions": 0,
            "providerCalls": 0, "metadataWebCalls": 0, "newBuilds": 0, "downloads": 0,
            "installs": 0, "newDependencies": 0, "newInfrastructure": 0}})
        admission.write_text(json.dumps(document))
        for name in ("building-review-progress.json", "building-review-browser-result.json", "building-review-requests.json",
                     "building-review-saved-project-reopened.png", "browser-result.json", "requests.json", "development-smoke.json"):
            (work / name).write_text("retained historical receipt")
        return root, work, helper

    def test_receptor_profile_preserves_history_and_cumulative_changed_helper_continuation(self):
        with tempfile.TemporaryDirectory() as directory:
            root, work, helper = self.receptor_screening_state(directory)
            with patch.object(studio, "ROOT", root):
                first = studio.stage_receptor_screening(work, "a" * 64)
                profile = json.loads((work / "receptor-screening-profile.json").read_text())
                self.assertEqual(profile["schemaVersion"], "opengeo.integrated-receptor-screening.1")
                self.assertEqual(profile["maximumApiRequests"], 180)
                self.assertEqual(profile["maximumWorkMilliseconds"], 170_000)
                self.assertEqual(profile["maximumNativeClips"], 2)
                self.assertEqual(first["serviceAttempts"], 1)
                self.assertIn("building-review-saved-project-reopened.png", first["preservedReceipts"])
                with self.assertRaisesRegex(ValueError, "diagnosis"):
                    studio.stage_receptor_screening(work, "a" * 64)
                first.update(apiRequestAttempts=73, activeMilliseconds=24_000, nativePreviews={"footprint": {"retained": True}},
                             records={"receptors": {"datasetId": "owned-dataset", "uploadCompleted": True}})
                (work / "receptor-screening-progress.json").write_text(json.dumps(first))
                helper.write_text("changed helper addressing the diagnosed failure")
                resumed = studio.stage_receptor_screening(work, "a" * 64, pilot.digest(helper.read_bytes()))
                self.assertEqual(resumed["serviceAttempts"], 2)
                self.assertEqual(resumed["apiRequestAttempts"], 73)
                self.assertEqual(resumed["activeMilliseconds"], 24_000)
                self.assertEqual(resumed["nativePreviews"], {"footprint": {"retained": True}})
                self.assertTrue(resumed["records"]["receptors"]["uploadCompleted"])
                self.assertEqual((work / "building-review-progress.json").read_text(), "retained historical receipt")
                self.assertEqual((work / "publication-profile.json").read_text(), "retained")
                with self.assertRaisesRegex(ValueError, "budget"):
                    studio.stage_receptor_screening(work, "a" * 64, pilot.digest(helper.read_bytes()))

    def test_receptor_continuation_accepts_only_its_owned_nonduplicate_queue(self):
        with tempfile.TemporaryDirectory() as directory:
            root, work, helper = self.receptor_screening_state(directory)
            with patch.object(studio, "ROOT", root):
                first = studio.stage_receptor_screening(work, "a" * 64)
                first["records"] = {"receptors": {"datasetId": "owned-dataset", "uploadCompleted": True}}
                (work / "receptor-screening-progress.json").write_text(json.dumps(first))
                helper.write_text("changed queue continuation helper")
                pin = pilot.digest(helper.read_bytes())
                message = lambda dataset: {"body": json.dumps({"Records": [{"s3": {"object": {
                    "key": f"organizations/owner/projects/project/datasets/{dataset}/uploads/original.geojson"}}}]})}
                for messages in ([message("unrelated")], [message("owned-dataset"), message("owned-dataset")]):
                    (work / "queue.json").write_text(json.dumps(messages))
                    with self.assertRaisesRegex(ValueError, "unrelated or duplicate"):
                        studio.stage_receptor_screening(work, "a" * 64, pin)
                    self.assertEqual(json.loads((work / "receptor-screening-progress.json").read_text())["serviceAttempts"], 1)
                owned = [message("owned-dataset")]
                (work / "queue.json").write_text(json.dumps(owned))
                resumed = studio.stage_receptor_screening(work, "a" * 64, pin)
                self.assertEqual(resumed["serviceAttempts"], 2)
                self.assertEqual(json.loads((work / "queue.json").read_text()), owned)

    def test_receptor_admission_budget_and_success_cannot_be_silently_reset(self):
        with tempfile.TemporaryDirectory() as directory:
            root, work, helper = self.receptor_screening_state(directory)
            with patch.object(studio, "ROOT", root):
                admission = root / ".local-archives/baseline-intelligence-20261023/admission.json"
                original = json.loads(admission.read_text())
                changed = json.loads(admission.read_text());changed["batches"][-1]["limits"]["nativeClips"] = 3
                admission.write_text(json.dumps(changed))
                with self.assertRaisesRegex(ValueError, "finite batch admission"):
                    studio.stage_receptor_screening(work, "a" * 64)
                self.assertFalse((work / "receptor-screening-progress.json").exists())
                admission.write_text(json.dumps(original))
                progress = studio.stage_receptor_screening(work, "a" * 64)
                helper.write_text("diagnosed changed helper")
                pin = pilot.digest(helper.read_bytes())
                for field, value in (("apiRequestAttempts", 180), ("activeMilliseconds", 170_000)):
                    exhausted = {**progress, field: value}
                    (work / "receptor-screening-progress.json").write_text(json.dumps(exhausted))
                    with self.assertRaisesRegex(ValueError, "budget"):
                        studio.stage_receptor_screening(work, "a" * 64, pin)
                (work / "receptor-screening-progress.json").write_text(json.dumps({**progress, "status": "pass"}))
                with self.assertRaisesRegex(ValueError, "already passed"):
                    studio.stage_receptor_screening(work, "a" * 64, pin)

    def test_receptor_preserves_prior_studio_and_rejects_changed_building_receipts(self):
        with tempfile.TemporaryDirectory() as directory:
            root, work, helper = self.receptor_screening_state(directory)
            old = work / "built-studio/app/dist/index.html";old.write_text("retained prior Studio")
            with patch.object(studio, "ROOT", root), patch.object(studio, "stage_built_studio") as staged:
                studio.stage_receptor_screening(work, "b" * 64)
                staged.assert_called_once_with(work, "b" * 64)
                self.assertEqual((work / f"receptor-screening-prior-studio-{'a' * 64}/app/dist/index.html").read_text(), "retained prior Studio")
                self.assertTrue((work / "receptor-screening-prior-studio-manifest.json").is_file())
                (work / "building-review-progress.json").write_text("changed historical receipt")
                helper.write_text("changed reviewed helper")
                with self.assertRaisesRegex(ValueError, "unrelated receipt"):
                    studio.stage_receptor_screening(work, "b" * 64, pilot.digest(helper.read_bytes()))

    def real_building_state(self, directory):
        from uuid import NAMESPACE_URL, uuid5
        root, work, helper = self.building_review_state(directory)
        folder = Path(directory) / "inputs"
        folder.mkdir()
        entries = []
        for role in ("source", "comparison"):
            service = f"https://example.invalid/{role}/FeatureServer/0"
            original = {"type": "FeatureCollection", "features": [{"type": "Feature", "id": 1,
                "properties": {"fid": 1, "name": role, "missing": None},
                "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]], "crs": None}}]}
            native = json.loads(json.dumps(original))
            native["features"][0]["id"] = str(uuid5(NAMESPACE_URL, service + "#fid=1"))
            entry = {"role": role, "serviceUrl": service, "featureCount": 1}
            for kind, value in (("querySnapshot", original), ("nativeInput", native)):
                filename = f"{role}-{kind}.geojson"
                encoded = json.dumps(value).encode()
                (folder / filename).write_bytes(encoded)
                entry[kind] = {"path": filename, "bytes": len(encoded), "sha256": pilot.digest(encoded)}
            entry["nativeInput"]["featureIdentityMapping"] = [{"nativeFeatureId": native["features"][0]["id"],
                "providerFid": 1, "originalGeojsonId": 1}]
            entries.append(entry)
        manifest = folder / "input-pair.json"
        manifest.write_text(json.dumps({"inputs": entries, "AOI": [0, 0, 1, 1], "combinedFeatureCount": 2,
            "publicRedistributionApproved": False, "reviewPolicy": "Mechanical workflow acceptance only"}))
        pin = pilot.digest(manifest.read_bytes())
        (work / "building-review-progress.json").write_text(json.dumps({"status": "pass", "synthetic": True}))
        (work / "building-review-saved-project-reopened.png").write_bytes(b"retained synthetic screenshot")
        admission = root / ".local-archives/baseline-intelligence-20261023/admission.json"
        document = json.loads(admission.read_text())
        document["batches"].append({"id": "BI-02-07-real-building-account-review",
            "limits": document["batches"][0]["limits"], "inventory": {"inputPairSha256": pin, "appTree": "a" * 64}})
        admission.write_text(json.dumps(document))
        return root, work, helper, manifest, pin

    def test_real_building_inputs_preserve_provider_attributes_coordinates_and_null_crs(self):
        with tempfile.TemporaryDirectory() as directory:
            root, work, helper, manifest, pin = self.real_building_state(directory)
            profile = studio.retained_real_building_inputs(manifest, pin)
            for role in ("source", "comparison"):
                feature = profile["inputs"][role][0]
                self.assertEqual(feature["properties"], {"fid": 1, "name": role, "missing": None})
                self.assertEqual(feature["geometry"]["coordinates"], [[[0, 0], [1, 0], [1, 1], [0, 0]]])
                self.assertIsNone(feature["geometry"]["crs"])
                self.assertFalse(profile["provenance"][role]["publicRedistributionApproved"])

    def test_real_building_inputs_reject_changed_manifest_and_original_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root, work, helper, manifest, pin = self.real_building_state(directory)
            with self.assertRaisesRegex(ValueError, "manifest changed"):
                studio.retained_real_building_inputs(manifest, "b" * 64)
            entry = json.loads(manifest.read_text())["inputs"][0]
            path = manifest.parent / entry["querySnapshot"]["path"]
            path.write_bytes(path.read_bytes() + b" ")
            with self.assertRaisesRegex(ValueError, "checksum/size"):
                studio.retained_real_building_inputs(manifest, pin)

    def test_real_building_inputs_reject_path_traversal_and_symlink(self):
        for kind in ("traversal", "symlink"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root, work, helper, manifest, pin = self.real_building_state(directory)
                document = json.loads(manifest.read_text())
                path = manifest.parent / document["inputs"][0]["querySnapshot"]["path"]
                if kind == "traversal":
                    document["inputs"][0]["querySnapshot"]["path"] = "../unrelated.geojson"
                    manifest.write_text(json.dumps(document))
                    pin = pilot.digest(manifest.read_bytes())
                else:
                    target = path.with_suffix(".original")
                    path.rename(target)
                    path.symlink_to(target)
                with self.assertRaises(ValueError):
                    studio.retained_real_building_inputs(manifest, pin)

    def test_real_building_inputs_reject_false_provider_identity_mapping(self):
        with tempfile.TemporaryDirectory() as directory:
            root, work, helper, manifest, pin = self.real_building_state(directory)
            document = json.loads(manifest.read_text())
            document["inputs"][0]["nativeInput"]["featureIdentityMapping"][0]["originalGeojsonId"] = "changed"
            manifest.write_text(json.dumps(document))
            with self.assertRaisesRegex(ValueError, "identity mapping"):
                studio.retained_real_building_inputs(manifest, pilot.digest(manifest.read_bytes()))

    def test_real_building_profile_preserves_synthetic_and_cumulative_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            root, work, helper, manifest, pin = self.real_building_state(directory)
            before = (work / "building-review-progress.json").read_bytes()
            with patch.object(studio, "ROOT", root):
                progress = studio.stage_building_review(work, "a" * 64, building_inputs=manifest, building_inputs_sha256=pin)
                profile = json.loads((work / "building-real-review-profile.json").read_text())
                self.assertEqual(profile["admissionBatchId"], "BI-02-07-real-building-account-review")
                self.assertIn("building-review-saved-project-reopened.png", progress["preservedReceipts"])
                self.assertEqual((work / "building-review-progress.json").read_bytes(), before)
                progress.update(apiRequestAttempts=12, activeMilliseconds=1_000,
                    records={"source": {"datasetId": "committed", "uploadCompleted": True}})
                (work / "building-real-review-progress.json").write_text(json.dumps(progress))
                helper.write_text("changed helper addressing diagnosed failure")
                resumed = studio.stage_building_review(work, "a" * 64, pilot.digest(helper.read_bytes()),
                    building_inputs=manifest, building_inputs_sha256=pin)
                self.assertEqual(resumed["apiRequestAttempts"], 12)
                self.assertEqual(resumed["activeMilliseconds"], 1_000)
                self.assertEqual(resumed["records"]["source"]["datasetId"], "committed")
                self.assertEqual((work / "building-review-progress.json").read_bytes(), before)

    def test_real_building_arguments_require_scoped_journey_and_exact_pin(self):
        selected = ["--development", "--state-directory", "/tmp/real-buildings", "--reuse-studio-tree", "a" * 64,
                    "--building-review-smoke", "--building-review-inputs", "/tmp/pair.json", "--building-review-inputs-sha256", "b" * 64]
        self.assertEqual(studio.parse_args(selected).building_review_inputs, Path("/tmp/pair.json"))
        for arguments in (selected[:-2], selected + ["--stac-items-smoke"],
                          ["--building-review-inputs", "/tmp/pair.json", "--building-review-inputs-sha256", "b" * 64]):
            with self.subTest(arguments=arguments), self.assertRaises(SystemExit), patch("sys.stderr", io.StringIO()):
                studio.parse_args(arguments)

    def test_building_review_requires_one_persistent_sealed_scope(self):
        selected = ["--development", "--state-directory", "/tmp/building-review-state",
                    "--reuse-studio-tree", "a" * 64, "--building-review-smoke"]
        self.assertTrue(studio.parse_args(selected).building_review_smoke)
        for arguments in (["--building-review-smoke"], selected + ["--rebuild-studio"],
                          selected + ["--postgis-fixture"], selected + ["--publication-only"],
                          selected + ["--baseline-study", "/tmp/baseline.json"],
                          selected + ["--analysis-profile", "/tmp/profile.json"],
                          selected + ["--building-review-continuation-sha256", "unreviewed"]):
            with self.subTest(arguments=arguments), self.assertRaises(SystemExit), patch("sys.stderr", io.StringIO()):
                studio.parse_args(arguments)

    def building_review_state(self, directory):
        root, work = Path(directory) / "repo", Path(directory) / "state"
        work.mkdir()
        helper = root / "app/scripts/integrated-studio-analysis.mjs"
        helper.parent.mkdir(parents=True)
        helper.write_text("first reviewed helper")
        admission = root / ".local-archives/baseline-intelligence-20261023/admission.json"
        admission.parent.mkdir(parents=True)
        admission.write_text(json.dumps({"batches": [{"id": "BI-02-07-main-account-building-review", "limits": {
            "apiRequestAttempts": 160, "cumulativeServiceMillisecondsIncludingShutdown": 180_000,
            "originalUploads": 3, "ingestionJobs": 3,
            "AWSAccountCalls": 0, "GitHubCalls": 0, "providerCalls": 0, "newBuilds": 0}}]}))
        for name in ("development-state.json", "identities-seeded", "baseline-progress.json", "publication-profile.json"):
            (work / name).write_text("retained")
        (work / "queue.json").write_text("[]")
        (work / "studio-build-manifest.json").write_text(json.dumps({"artifactTree": {"digest": "a" * 64}}))
        (work / "built-studio/app/dist").mkdir(parents=True)
        return root, work, helper

    def test_building_review_preserves_receipts_and_requires_diagnosed_bounded_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            root, work, helper = self.building_review_state(directory)
            with patch.object(studio, "ROOT", root):
                first = studio.stage_building_review(work, "a" * 64)
                self.assertEqual(first["serviceAttempts"], 1)
                self.assertEqual((work / "publication-profile.json").read_text(), "retained")
                with self.assertRaisesRegex(ValueError, "diagnosis"):
                    studio.stage_building_review(work, "a" * 64)
                helper.write_text("changed helper addressing the diagnosed failure")
                resumed = studio.stage_building_review(work, "a" * 64, pilot.digest(helper.read_bytes()))
                self.assertEqual(resumed["serviceAttempts"], 2)
                with self.assertRaisesRegex(ValueError, "budget"):
                    studio.stage_building_review(work, "a" * 64, pilot.digest(helper.read_bytes()))

    def test_building_review_rejects_unrelated_queue_and_retains_prior_build(self):
        with tempfile.TemporaryDirectory() as directory:
            root, work, _ = self.building_review_state(directory)
            with patch.object(studio, "ROOT", root):
                (work / "queue.json").write_text('[{"unrelated":"committed"}]')
                with self.assertRaisesRegex(ValueError, "unrelated queued"):
                    studio.stage_building_review(work, "b" * 64)
                self.assertFalse((work / "building-review-progress.json").exists())
                (work / "queue.json").write_text("[]")
                old_artifact = work / "built-studio/app/dist/index.html"
                old_artifact.write_text("accepted prior artifact")
                with patch.object(studio, "stage_built_studio") as stage:
                    studio.stage_building_review(work, "b" * 64)
                stage.assert_called_once_with(work, "b" * 64)
                self.assertEqual((work / f"building-review-prior-studio-{'a' * 64}/app/dist/index.html").read_text(),
                                 "accepted prior artifact")

    def test_building_cleanup_removes_only_temporary_compute_with_bounded_waits(self):
        process = Mock()
        with patch.object(studio.subprocess, "run") as run:
            studio.cleanup_development_api("owned-api", "owned-worker", process, bounded=True)
        run.assert_called_once_with(["podman", "rm", "--force", "owned-api", "owned-worker"],
                                    capture_output=True, check=False, timeout=2)
        process.wait.assert_called_once_with(timeout=1)

    def test_print_acceptance_only_reopens_exact_retained_development_build(self):
        pin = "a" * 64
        selected = ["--development", "--state-directory", "/tmp/private-print-state",
                    "--reuse-studio-tree", pin, "--print-smoke"]
        self.assertTrue(studio.parse_args(selected).print_smoke)
        self.assertEqual(studio.parse_args(selected + ["--print-smoke-continuation-sha256", pin])
                         .print_smoke_continuation_sha256, pin)
        for arguments in (["--print-smoke"], selected + ["--rebuild-studio"],
                          selected + ["--postgis-fixture"], selected + ["--publication-only"],
                          selected + ["--analysis-profile", "/tmp/profile.json"]):
            with self.subTest(arguments=arguments), self.assertRaises(SystemExit), patch("sys.stderr", io.StringIO()):
                studio.parse_args(arguments)
        for arguments in (["--print-smoke-continuation-sha256", pin],
                          selected + ["--print-smoke-continuation-sha256", "unreviewed"]):
            with self.subTest(arguments=arguments), self.assertRaises(SystemExit), patch("sys.stderr", io.StringIO()):
                studio.parse_args(arguments)

    def profile(self):
        return {"imageDigest": "sha256:" + "a" * 64, "architecture": "arm64",
                "baseImage": pilot.PMTILES_BASE, "queueUrl": pilot.PMTILES_QUEUE_URL,
                "expectedOwner": "000000000000"}

    def test_dedicated_pmtiles_is_an_explicit_fresh_built_studio_option(self):
        pin = "a" * 64
        self.assertIsNone(studio.parse_args([]).pmtiles_worker_image)
        self.assertEqual(studio.parse_args(["--built-studio", "--pmtiles-worker-image", pin]).pmtiles_worker_image, pin)
        for arguments in (["--pmtiles-worker-image", pin],
                ["--built-studio", "--pmtiles-worker-image", "worker:latest"],
                ["--built-studio", "--restore-checkpoint", "--pmtiles-worker-image", pin],
                ["--development", "--state-directory", "/tmp/local-state", "--pmtiles-worker-image", pin]):
            with self.subTest(arguments=arguments), self.assertRaises(SystemExit), patch("sys.stderr", new=io.StringIO()):
                studio.parse_args(arguments)

    def test_dedicated_image_inspection_preserves_exact_small_base_and_architecture(self):
        labels = {"org.opencontainers.image.title": "GDAL osgeo/gdal:ubuntu-small",
                  "org.opencontainers.image.version": "3.13.1", "org.opencontainers.image.revision": "v3.13.1",
                  "org.opencontainers.image.source": "https://github.com/OSGeo/gdal"}
        image = {"Id": self.profile()["imageDigest"], "Architecture": "arm64", "Labels": labels}
        with patch.object(studio.subprocess, "run", return_value=Mock(stdout=json.dumps([image]).encode())) as run:
            self.assertEqual(studio.inspect_pmtiles_worker_image("a" * 64), self.profile())
            run.assert_called_once_with(["podman", "image", "inspect", self.profile()["imageDigest"]],
                                        capture_output=True, check=True, timeout=15)
        for changed in ({**image, "Id": "b" * 64}, {**image, "Architecture": "unknown"},
                {**image, "Labels": {**labels, "org.opencontainers.image.title": "GDAL osgeo/gdal:ubuntu-full"}}):
            with self.subTest(image=changed), patch.object(studio.subprocess, "run", return_value=Mock(stdout=json.dumps([changed]).encode())), self.assertRaises(ValueError):
                studio.inspect_pmtiles_worker_image("a" * 64)

    def test_local_binding_is_exact_and_cannot_replace_a_retained_control_ledger(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(pilot, "WORK", Path(temporary)):
            work = Path(temporary)
            init = work / "init"
            init.mkdir()
            studio.stage_pmtiles_runtime(work, init, self.profile())
            self.assertEqual(pilot.local_pmtiles_profile(), self.profile())
            self.assertEqual(stat.S_IMODE((work / "pmtiles-runtime.json").stat().st_mode), 0o640)
            sql = (init / "zzz-local-pmtiles-runtime.sql").read_text()
            self.assertIn("configuration='{\"enabled\":false}'::jsonb AND revision=0", sql)
            self.assertIn("AND starts_today=0 AND total_windows=0 AND reserved_seconds=0", sql)
            self.assertIn("RAISE EXCEPTION 'Local PMTiles requires pristine runtime control'", sql)
            self.assertNotIn("SET starts_today", sql)
            with self.assertRaisesRegex(ValueError, "once"):
                studio.stage_pmtiles_runtime(work, init, self.profile())
            for invalid in (None, {**self.profile(), "imageDigest": None},
                    {**self.profile(), "queueUrl": "https://other.invalid"}, {**self.profile(), "extra": True}):
                (work / "pmtiles-runtime.json").write_text(json.dumps(invalid))
                with self.subTest(profile=invalid), self.assertRaises(ValueError):
                    pilot.local_pmtiles_profile()

    def test_pmtiles_dispatch_is_separate_from_shared_render_and_legacy_work(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(pilot, "WORK", Path(temporary)):
            legacy = pilot.LocalDispatcher("legacy", "job_id")
            pmtiles = pilot.LocalDispatcher("opengeo.pmtiles-derivative.command.v1", "pmtiles_derivative_job_id",
                                            queue=pilot.PMTILES_QUEUE, recipe="gdal-pmtiles-v2")
            render = pilot.LocalDispatcher("opengeo.render.command.v1", "render_job_id")
            self.assertTrue(legacy.supports_recipe("gdal-pmtiles-v1"))
            self.assertFalse(legacy.supports_recipe("gdal-pmtiles-v2"))
            self.assertTrue(pmtiles.supports_recipe("gdal-pmtiles-v2"))
            self.assertFalse(pmtiles.supports_recipe("gdal-pmtiles-v1"))
            asyncio.run(pmtiles.dispatch_pmtiles_derivative("dedicated"))
            asyncio.run(render.dispatch_render("png"))
            self.assertEqual(json.loads(pilot.read_json("pmtiles-v2.json")[0]["body"])["pmtiles_derivative_job_id"], "dedicated")
            self.assertEqual(json.loads(pilot.read_json("queue.json")[0]["body"])["render_job_id"], "png")

    def test_dedicated_worker_keeps_nonroot_private_scratch_without_affecting_shared_command(self):
        shared = studio.container_command("database", "/tmp/work", "shared", "a" * 64,
                                          "python3", "scripts/run-integrated-pilot-local.py", "--stage", "worker")
        dedicated = studio.container_command("database", "/tmp/work", "pmtiles", "b" * 64,
                                             "python3", "scripts/run-integrated-pilot-local.py",
                                             "--stage", "worker-pmtiles", pmtiles_worker=True)
        self.assertIn("--user=0", shared)
        self.assertNotIn("--mount", shared)
        self.assertIn("--user=10001:10001", dedicated)
        self.assertIn("type=tmpfs,target=/tmp/opengeo-worker,tmpfs-size=1073741824,tmpfs-mode=0700,U=true,noexec,nosuid,nodev", dedicated)
        for option in ("--read-only", "--pull=never", "--cap-drop=all", "--security-opt=no-new-privileges"):
            self.assertIn(option, shared)
            self.assertIn(option, dedicated)

    def test_worker_stage_uses_dedicated_v2_and_keeps_shared_v1_settings(self):
        seen = []

        class Settings:
            def __init__(self, *args, **kwargs):
                self.arguments = args
                self.__dict__.update(kwargs)

        class Repository:
            def __init__(self, settings, *, pmtiles_profile):
                self.profile = pmtiles_profile

        class Shared:
            def __init__(self, settings, queue, repository, storage):
                self.queue = queue
                seen.append((type(self), settings, queue.name, repository.profile))

            def process_once(self):
                self.queue.delete(pilot.read_json(f"{self.queue.name}.json")[0]["id"])

        class Dedicated(Shared):
            pass

        modules = {"opengeo_worker.config": SimpleNamespace(Settings=Settings),
                   "opengeo_worker.processor": SimpleNamespace(WorkerProcessor=Shared),
                   "opengeo_worker.repository": SimpleNamespace(WorkerRepository=Repository),
                   "opengeo_worker.pmtiles_main": SimpleNamespace(PmtilesWorkerProcessor=Dedicated)}
        with tempfile.TemporaryDirectory() as temporary, patch.object(pilot, "WORK", Path(temporary)), patch.dict(sys.modules, modules):
            pilot.save_json("pmtiles-runtime.json", self.profile())
            pilot.LocalQueue(pilot.PMTILES_QUEUE).push({"pmtiles": True})
            pilot.LocalQueue().push({"png": True})
            with patch("sys.stdout", new=io.StringIO()):
                pilot.worker(pmtiles=True)
                self.assertEqual(len(pilot.read_json("queue.json")), 1)
                pilot.worker()
        self.assertEqual([(entry[0], entry[2], entry[3]) for entry in seen],
                         [(Dedicated, "pmtiles-v2", "v2"), (Shared, "queue", "v1")])
        self.assertEqual(seen[0][1].pmtiles_worker_image_digest, self.profile()["imageDigest"])
        self.assertEqual(seen[0][1].geodata_expected_owner, "000000000000")
        self.assertIsNone(seen[1][1].pmtiles_worker_image_digest)

    def test_local_settings_keep_intake_and_png_shared_with_exact_separate_pmtiles_binding(self):
        class Settings:
            def __init__(self, **values):
                self.processing_queue_url = None
                self.__dict__.update(values)

        modules = {"opengeo_api.app": SimpleNamespace(create_app=lambda **values: values),
                   "opengeo_api.auth_models": SimpleNamespace(VerifiedAccessToken=Mock()),
                   "opengeo_api.config": SimpleNamespace(Settings=Settings),
                   "pydantic": SimpleNamespace(SecretStr=lambda value: value)}
        with tempfile.TemporaryDirectory() as temporary, patch.object(pilot, "WORK", Path(temporary)), patch.dict(sys.modules, modules):
            default = pilot.local_app()
            self.assertEqual(default["settings"].worker_processing_mode, "shared")
            self.assertFalse(default["settings"].pmtiles_derivative_dispatch_configured)
            pilot.save_json("pmtiles-runtime.json", self.profile())
            configured = pilot.local_app()
            settings = configured["settings"]
            dispatcher = configured["pmtiles_derivative_dispatcher"]
            render = configured["render_dispatcher"]
            self.assertEqual(settings.worker_processing_mode, "shared")
            self.assertTrue(settings.pmtiles_derivative_dispatch_configured)
            self.assertEqual(render.queue, "queue")
            self.assertNotEqual(render.queue, dispatcher.queue)
            for target, field, changed in (
                    (settings, "worker_processing_mode", "pmtiles-v2"),
                    (settings, "pmtiles_worker_image_digest", "sha256:" + "b" * 64),
                    (settings, "pmtiles_derivative_queue_url", "https://other.invalid"),
                    (settings, "processing_queue_url", self.profile()["queueUrl"]),
                    (settings, "aws_region", "us-west-2"),
                    (dispatcher, "available", False), (dispatcher, "recipe", "gdal-pmtiles-v1"),
                    (dispatcher, "queue", "queue"), (dispatcher, "schema", "other"),
                    (dispatcher, "field", "other"), (render, "queue", pilot.PMTILES_QUEUE)):
                original = getattr(target, field)
                setattr(target, field, changed)
                with self.subTest(field=field, changed=changed):
                    self.assertFalse(settings.pmtiles_derivative_dispatch_configured)
                setattr(target, field, original)
            self.assertFalse(pilot.local_app(pmtiles_derivative_dispatcher=None)["settings"].pmtiles_derivative_dispatch_configured)


class InitializationTests(unittest.TestCase):
    def test_retained_publication_mode_reuses_development_without_an_application_build(self):
        args=studio.parse_args(["--development","--publication-only","--state-directory","/tmp/publication-state",
                                "--publication-compiler-digest","sha256:"+"a"*64])
        self.assertFalse(args.built_studio)
        self.assertEqual(studio.browser_command("/tmp/publication-state",development=True,publication_only=True),
                         ["node","app/scripts/check-integrated-studio.mjs","/tmp/publication-state","--development","--publication-only"])
        with self.assertRaises(SystemExit),patch("sys.stderr",new=io.StringIO()):
            studio.parse_args(["--development","--publication-only","--state-directory","/tmp/publication-state",
                               "--publication-compiler-digest","sha256:"+"a"*64,"--rebuild-studio"])

    def test_source_upload_custody_does_not_enqueue_gis_ingestion(self):
        identity = "10000000-0000-4000-8000-000000000001"
        prefix = f"organizations/{identity}/projects/{identity}/"
        for name in ["index.md", "index.html", "settings.json", "app.js", "figure.png"]:
            self.assertFalse(studio.is_dataset_upload(
                f"{prefix}source-projects/{identity}/uploads/{identity}/files/{name}"))
        self.assertTrue(studio.is_dataset_upload(
            f"{prefix}datasets/{identity}/uploads/{identity}/original/features.geojson"))

    def test_only_portable_intents_receive_the_opt_in_html_transport_limit(self):
        identity = "10000000-0000-4000-8000-000000000001"
        prefix = f"organizations/{identity}/projects/{identity}/"
        portable = f"{prefix}artifacts/{identity}/uploads/{identity}/map.html"
        self.assertEqual(studio.local_upload_body_limit(portable, publication_enabled=True),
                         4_194_304 + 65_536)
        self.assertEqual(studio.local_upload_body_limit(portable, publication_enabled=False),
                         1_048_576)
        self.assertFalse(studio.is_dataset_upload(portable))
        for key in [f"{prefix}datasets/{identity}/uploads/{identity}/original/map.html",
                    f"{prefix}source-projects/{identity}/uploads/{identity}/files/map.html",
                    portable + "/other", portable.replace("map.html", "map.js"),
                    portable.replace(identity, "x" * 36)]:
            self.assertEqual(studio.local_upload_body_limit(key, publication_enabled=True),
                             1_048_576)

    def test_publication_opt_in_requires_cached_exact_compiler_and_preserves_queues(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            pin = "sha256:" + "a" * 64
            with (patch.object(studio.subprocess, "run", return_value=Mock(returncode=0)) as inspect,
                  patch.object(studio, "publication_preview_origin", side_effect=["http://127.0.0.1:58000","http://127.0.0.1:58001"]),
                  patch.object(studio, "publication_signing_keys", return_value=("publication-preview-private.pem", "publication-preview-public.pem"))):
                studio.stage_publication_profile(work, pin)
            inspect.assert_called_once_with(["podman", "image", "exists", pin],
                                            capture_output=True, check=False, timeout=15)
            self.assertEqual(json.loads((work / "publication-profile.json").read_text()), {
                "compilerImageDigest": pin, "previewOrigin": "http://127.0.0.1:58000",
                "publicationOrigin": "http://127.0.0.1:58001",
                "publicationCanonicalOrigin": "https://publication.local.invalid",
                "previewKeyPairId": "LOCALPREVIEW123",
                "previewPrivateKeyPath": "publication-preview-private.pem",
                "previewPublicKeyPath": "publication-preview-public.pem"})
            (work / "observable-builds.json").write_text('[{"retained":true}]')
            studio.stage_publication_profile(work, None)
            self.assertFalse((work / "publication-profile.json").exists())
            self.assertEqual(json.loads((work / "observable-builds.json").read_text()), [{"retained": True}])
            with self.assertRaises(ValueError):
                studio.stage_publication_profile(work, "node:latest")
            with patch.object(studio.subprocess, "run", return_value=Mock(returncode=1)):
                with self.assertRaisesRegex(ValueError, "absent"):
                    studio.stage_publication_profile(work, pin)
            original = work / "retained-profile.json"
            original.write_text("retained configuration")
            (work / "publication-profile.json").symlink_to(original)
            with self.assertRaisesRegex(ValueError, "symlink"):
                studio.stage_publication_profile(work, None)
            self.assertEqual(original.read_text(), "retained configuration")

    def test_publication_keys_are_private_reused_and_reject_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            private_name, public_name = studio.publication_signing_keys(work)
            private, public = work / private_name, work / public_name
            self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(public.stat().st_mode), 0o600)
            original = private.read_bytes()
            self.assertEqual(studio.publication_signing_keys(work), (private_name, public_name))
            self.assertEqual(private.read_bytes(), original)
            public.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "0600"):
                studio.publication_signing_keys(work)
            public.unlink()
            public.symlink_to(private)
            with self.assertRaisesRegex(ValueError, "0600"):
                studio.publication_signing_keys(work)

    def test_publication_preview_port_is_loopback_and_explicit(self):
        listener = Mock()
        listener.getsockname.return_value = ("127.0.0.1", 58001)
        connection = Mock()
        connection.__enter__ = Mock(return_value=listener)
        connection.__exit__ = Mock(return_value=False)
        with patch.object(studio.socket, "socket", return_value=connection):
            self.assertEqual(studio.publication_preview_origin(0), "http://127.0.0.1:58001")
        listener.bind.assert_called_once_with(("127.0.0.1", 0))
        for port in [-1, 65536, True]:
            with self.assertRaises(ValueError):
                studio.publication_preview_origin(port)

    def test_publication_queue_is_separate_and_retains_unacknowledged_work(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(pilot, "WORK", Path(temporary)):
            pilot.LocalQueue().push({"gis": True})
            builds = pilot.LocalQueue("observable-builds")
            builds.push({"build": 1})
            builds.push({"build": 2})
            publications = pilot.LocalQueue("framework-publications")
            publications.push({"review_id": "retained-review"})
            first = pilot.read_json("observable-builds.json")[0]
            builds.delete(first["id"])
            self.assertEqual(json.loads(pilot.read_json("observable-builds.json")[0]["body"]), {"build": 2})
            self.assertEqual(json.loads(pilot.read_json("queue.json")[0]["body"]), {"gis": True})
            self.assertEqual(json.loads(pilot.read_json("framework-publications.json")[0]["body"]),
                             {"review_id": "retained-review"})

    def test_publication_output_reuses_exact_version_and_rejects_changed_bytes(self):
        import base64

        with tempfile.TemporaryDirectory() as temporary, patch.object(publication.pilot, "WORK", Path(temporary)):
            body = b"<!doctype html><title>Retained edition</title>"
            request = {"operation": "write", "bucket": pilot.BUCKET,
                       "objectKey": "organizations/example/builds/edition-one/output/index.html",
                       "contentType": "text/html", "checksumSha256": pilot.digest(body),
                       "body": base64.b64encode(body).decode()}
            original = publication.operate(request)
            self.assertEqual(publication.operate(request), original)
            read = publication.operate({"operation": "read", "bucket": pilot.BUCKET,
                                       "objectKey": request["objectKey"],
                                       "s3VersionId": original["version_id"], "maximumBytes": len(body)})
            self.assertEqual(base64.b64decode(read["body"]), body)
            changed = b"<!doctype html><title>Changed edition</title>"
            with self.assertRaisesRegex(ValueError, "collision"):
                publication.operate({**request, "body": base64.b64encode(changed).decode(),
                                     "checksumSha256": pilot.digest(changed)})
            self.assertEqual(len(publication.pilot.read_json("objects.json")), 1)
            with self.assertRaises(AssertionError):
                publication.operate({"operation": "read", "bucket": pilot.BUCKET,
                                     "objectKey": "different-edition", "s3VersionId": original["version_id"],
                                     "maximumBytes": len(body)})

    def test_development_requires_private_state_and_immutable_images(self):
        args = studio.parse_args(["--development", "--state-directory", "/tmp/community",
                                  "--api-image", "sha256:" + "a" * 64])
        self.assertTrue(args.built_studio)
        self.assertTrue(args.development)
        for extra in [[], ["--serve"], ["--service-clients"], ["--api-image", "latest"]]:
            argv = ["--development"] if not extra else ["--development", "--state-directory", "/tmp/community", *extra]
            with self.assertRaises(SystemExit), patch("sys.stderr", new=io.StringIO()):
                studio.parse_args(argv)
        with self.assertRaises(SystemExit), patch("sys.stderr", new=io.StringIO()):
            studio.parse_args(["--state-directory", "/tmp/community"])

    def test_development_reopen_preserves_data_and_rejects_schema_drift(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "schema.sql"
            source.write_text("original schema")
            with patch.object(studio, "ROOT", root), patch.object(studio, "database_initialization_sources", return_value=[source]):
                work, initial = studio.development_state(root / "state", "image")
                (work / "objects.json").write_text('{"preserved":true}')
                reopened, metadata = studio.development_state(work, "image")
                self.assertEqual(initial, metadata)
                self.assertEqual((reopened / "objects.json").read_text(), '{"preserved":true}')
                source.write_text("new schema")
                with self.assertRaisesRegex(ValueError, "review an upgrade"):
                    studio.development_state(work, "image")
                self.assertEqual((reopened / "objects.json").read_text(), '{"preserved":true}')

    def test_postgis_fixture_is_only_explicit_built_development_configuration(self):
        base = ["--development", "--state-directory", "/tmp/community"]
        self.assertFalse(studio.parse_args(base).postgis_fixture)
        configured = studio.parse_args([*base, "--postgis-fixture", "--reuse-studio-tree", "a" * 64])
        self.assertTrue(configured.postgis_fixture)
        self.assertTrue(configured.built_studio)
        for argv in (["--postgis-fixture"], ["--built-studio", "--postgis-fixture"],
                     [*base, "--postgis-fixture", "--analysis-profile", "/tmp/profile.json"],
                     [*base, "--postgis-fixture", "--publication-compiler-digest", "sha256:" + "a" * 64],
                     [*base, "--postgis-fixture", "--publication-only", "--publication-compiler-digest", "sha256:" + "a" * 64]):
            with self.subTest(argv=argv), self.assertRaises(SystemExit), patch("sys.stderr", new=io.StringIO()):
                studio.parse_args(argv)

    def test_postgis_fixture_requires_owned_state_and_omitted_opt_in_removes_activation(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            with self.assertRaisesRegex(ValueError, "development state marker"):
                studio.stage_postgis_fixture(work, True)
            marker = work / "development-state.json"
            marker.write_text(json.dumps({"schemaVersion": "opengeo.community-development.1",
                                          "database": "opengeo-community-" + "a" * 32}))
            (work / "objects.json").write_text('{"preserved":true}')
            studio.stage_postgis_fixture(work, True)
            profile = work / "postgis-fixture.json"
            self.assertEqual(json.loads(profile.read_text()), {"schemaVersion": "opengeo.local-postgis-fixture.1"})
            self.assertEqual(profile.stat().st_mode & 0o777, 0o600)
            studio.stage_postgis_fixture(work)
            self.assertFalse(profile.exists())
            self.assertEqual((work / "objects.json").read_text(), '{"preserved":true}')
            profile.symlink_to(marker)
            with self.assertRaisesRegex(ValueError, "symlink"):
                studio.stage_postgis_fixture(work, True)
            self.assertTrue(marker.is_file())

    def test_development_rejects_shared_or_symlink_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            shared = Path(temporary) / "shared"
            shared.mkdir(mode=0o755)
            with self.assertRaisesRegex(ValueError, "0700"):
                studio.development_state(shared, "image")
            link = Path(temporary) / "link"
            link.symlink_to(shared)
            with self.assertRaisesRegex(ValueError, "symlink"):
                studio.development_state(link, "image")

    def test_analysis_profile_is_explicit_private_and_cleared_without_opt_in(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            source = work / "operator.json"
            profile = {"profiles": {"python": {"image": "sha256:" + "a" * 64,
                                              "interpreter": "/usr/bin/python3"}}}
            source.write_text(json.dumps(profile))
            studio.stage_analysis_profile(work, source)
            staged = work / "analysis-profile.json"
            self.assertEqual(json.loads(staged.read_text()), {"enabled": True, **profile})
            self.assertEqual(stat.S_IMODE(staged.stat().st_mode), 0o600)
            studio.stage_analysis_profile(work)
            self.assertFalse(staged.exists())
            self.assertTrue(source.exists())
            args = studio.parse_args(["--development", "--state-directory", str(work),
                                      "--analysis-profile", str(source)])
            self.assertEqual(args.analysis_profile, source)
            with self.assertRaises(SystemExit), patch("sys.stderr", new=io.StringIO()):
                studio.parse_args(["--analysis-profile", str(source)])

    def test_analysis_profile_rejects_mutable_images_commands_and_widened_limits(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            source = work / "operator.json"
            good = {"profiles": {"bash": {"image": "sha256:" + "a" * 64, "interpreter": "/bin/bash"}}}
            bad = [dict(good, enabled=True), dict(good, timeoutSeconds=31), dict(good, memoryMiB=1024),
                   {"profiles": {"bash": {"image": "node:latest", "interpreter": "/bin/bash"}}},
                   {"profiles": {"bash": {"image": "sha256:" + "a" * 64, "interpreter": "/bin/sh"}}}]
            for value in bad:
                source.write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    studio.stage_analysis_profile(work, source)
            link = work / "linked.json"
            link.symlink_to(source)
            with self.assertRaises(ValueError):
                studio.stage_analysis_profile(work, link)
            self.assertFalse((work / "analysis-profile.json").exists())

    def test_local_queue_retains_jobs_added_during_processing(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(pilot, "WORK", Path(temporary)):
            queue = pilot.LocalQueue()
            queue.push({"first": True})
            first = pilot.read_json("queue.json")[0]["id"]
            queue.push({"second": True})
            queue.delete(first)
            messages = pilot.read_json("queue.json")
            self.assertEqual(len(messages), 1)
            self.assertEqual(json.loads(messages[0]["body"]), {"second": True})
            self.assertEqual(list(Path(temporary).glob("*.tmp")), [])

    def test_built_shell_is_an_explicit_independent_browser_mode(self):
        self.assertFalse(studio.parse_args([]).built_studio)
        self.assertTrue(studio.parse_args(["--built-studio"]).built_studio)
        pinned = "sha256:" + "b" * 64
        self.assertEqual(studio.parse_args(["--built-studio", "--api-image", pinned]).api_image, pinned)
        with self.assertRaises(SystemExit), patch("sys.stderr", new=io.StringIO()):
            studio.parse_args(["--built-studio", "--worker-image", "localhost/worker:latest"])
        self.assertTrue(
            studio.parse_args(["--built-studio", "--service-clients"]).service_clients
        )
        with self.assertRaises(SystemExit), patch("sys.stderr", new=io.StringIO()):
            studio.parse_args(["--service-clients"])
        self.assertTrue(
            studio.parse_args(
                ["--built-studio", "--restore-checkpoint"]
            ).restore_checkpoint
        )
        with self.assertRaises(SystemExit), patch("sys.stderr", new=io.StringIO()):
            studio.parse_args(["--restore-checkpoint"])
        with self.assertRaises(SystemExit), patch("sys.stderr", new=io.StringIO()):
            studio.parse_args(["--restored"])
        self.assertEqual(
            studio.browser_command("/tmp/work", built_studio=True),
            [
                "node",
                "app/scripts/check-integrated-studio.mjs",
                "/tmp/work",
                "--built-studio",
            ],
        )

    def test_build_staging_preserves_the_existing_artifacts(self):
        with tempfile.TemporaryDirectory(
            prefix="opengeo-build-stage-test-"
        ) as temporary:
            root = Path(temporary) / "source"
            work = Path(temporary) / "work"
            app = root / "app"
            for directory in (
                "src/.observablehq/cache",
                "scripts",
                "public-embeds",
                "vendor/workspace-contracts",
                "node_modules",
                "dist",
            ):
                (app / directory).mkdir(parents=True, exist_ok=True)
            for name in (
                "package.json",
                "package-lock.json",
                "observablehq.config.js",
                "src/workspaces.md",
                "src/.observablehq/cache/cached.js",
                "scripts/build-studio-site.mjs",
                "dist/rollback.html",
                "public-embeds/imagery-lab.retained.js",
                "vendor/workspace-contracts/LICENSE",
                "vendor/workspace-contracts/NOTICE",
            ):
                (app / name).write_text(name)

            build_sources = [
                "services/api/src/opengeo_api/project_module.py",
                "services/observable-builder/scripts/notebook-assets.mjs",
                "services/observable-builder/src/notebook-runtime.mjs",
                "services/observable-builder/src/portable-map-view.mjs",
                "services/observable-builder/src/legacy-notebook-runtime.mjs",
                "services/observable-builder/src/legacy-observable.mjs",
                "services/observable-builder/src/jupyter-notebook.mjs",
                "services/observable-builder/src/observable-notebook.mjs",
            ]
            for relative in build_sources:
                source = root / relative
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_text(relative)

            def complete_build(*args, **kwargs):
                # The normal builder reads the canonical native viewer outside
                # app/. It must exist before either build command runs.
                native_viewer = (kwargs["cwd"] / "scripts" /
                    "../../services/api/src/opengeo_api/project_module.py")
                self.assertEqual(
                    native_viewer.read_bytes(),
                    (root / "services/api/src/opengeo_api/project_module.py").read_bytes(),
                )
                generated = work / "built-studio/dist"
                generated.mkdir(exist_ok=True)
                (generated / "opengeo-studio-build.json").write_text("sealed-build")

            with (
                patch.object(studio, "ROOT", root),
                patch.object(
                    studio.subprocess, "run", side_effect=complete_build
                ) as run,
            ):
                studio.stage_built_studio(work)
            self.assertEqual(
                (app / "dist/rollback.html").read_text(), "dist/rollback.html"
            )
            self.assertEqual(
                (work / "built-studio/app/public-embeds/imagery-lab.retained.js").read_bytes(),
                (app / "public-embeds/imagery-lab.retained.js").read_bytes(),
            )
            self.assertEqual(
                (work / "built-studio/app/vendor/workspace-contracts/NOTICE").read_bytes(),
                (app / "vendor/workspace-contracts/NOTICE").read_bytes(),
            )
            for relative in build_sources:
                self.assertEqual((work / "built-studio" / relative).read_bytes(),
                                 (root / relative).read_bytes())
            self.assertEqual(
                (work / "built-studio/app/src/workspaces.md").read_bytes(),
                (app / "src/workspaces.md").read_bytes(),
            )
            self.assertTrue(
                (work / "built-studio/app/src/.observablehq/cache/cached.js").is_file()
            )
            self.assertEqual(
                (work / "built-studio/app/node_modules").resolve(), app / "node_modules"
            )
            self.assertEqual(
                (work / "studio-build-manifest.json").read_text(), "sealed-build"
            )
            self.assertEqual(
                [call.args[0] for call in run.call_args_list],
                [
                    ["node", "scripts/build-studio-site.mjs"],
                    ["node", "scripts/check-studio-build.mjs"],
                ],
            )
            self.assertTrue(
                all(
                    call.kwargs["cwd"] == work / "built-studio/app"
                    for call in run.call_args_list
                )
            )

    def test_missing_images_stop_before_staging_or_starting_a_database(self):
        with (
            patch.object(
                studio.subprocess, "run", return_value=Mock(returncode=1)
            ) as run,
            patch.object(studio.tempfile, "mkdtemp") as create,
            self.assertRaisesRegex(RuntimeError, "does not download or rebuild"),
        ):
            studio.orchestrate()
        create.assert_not_called()
        self.assertEqual(run.call_count, 3)
        for call in run.call_args_list:
            self.assertEqual(call.args[0][:3], ["podman", "image", "exists"])

    def test_cache_inspection_error_is_not_treated_as_absence_or_permission_to_pull(
        self,
    ):
        with (
            patch.object(studio.subprocess, "run", return_value=Mock(returncode=125)),
            self.assertRaisesRegex(RuntimeError, "Cannot inspect"),
        ):
            studio.verify_cached_images("pinned-database-image")

    def test_upgrade_stages_baseline_and_each_forward_migration_in_order(self):
        sources = [
            "database/baselines/0082_opengeo_schema.sql",
            "database/migrations/0083_user_dataset_connection_revision_read.sql",
            "database/migrations/0084_map_resource_version_bindings.sql",
            "database/migrations/0085_saved_map_render_jobs.sql",
        ]
        sources.extend(str(p.relative_to(studio.ROOT)) for p in studio.database_initialization_sources()[1:])
        with tempfile.TemporaryDirectory(prefix="opengeo-init-test-") as temporary:
            init = Path(temporary)
            studio.stage_database_initialization(init, upgrade_from_0082=True)
            staged = sorted(init.iterdir())
            self.assertEqual(
                [path.name for path in staged],
                [f"{i:03}.sql" for i in range(1, len(sources) + 1)],
            )
            for actual, relative in zip(staged, sources, strict=True):
                self.assertEqual(
                    actual.read_bytes(), (studio.ROOT / relative).read_bytes()
                )
                self.assertEqual(stat.S_IMODE(actual.stat().st_mode), 0o444)
            self.assertEqual(stat.S_IMODE(init.stat().st_mode), 0o755)

    def test_fresh_database_stages_baseline_and_all_forward_migrations(self):
        with tempfile.TemporaryDirectory(prefix="opengeo-init-test-") as temporary:
            init = Path(temporary)
            studio.stage_database_initialization(init)
            sources = studio.database_initialization_sources()
            self.assertGreater(len(sources), 1)
            self.assertEqual(len(list(init.iterdir())), len(sources))
            for index, source in enumerate(sources, 1):
                self.assertEqual((init / f"{index:03}.sql").read_bytes(), source.read_bytes())
            self.assertEqual(
                (init / "001.sql").read_bytes(), studio.pilot.BASELINE.read_bytes()
            )
            self.assertEqual(stat.S_IMODE((init / "001.sql").stat().st_mode), 0o444)


class FontModeTests(unittest.TestCase):
    def setUp(self):
        self.package = Path(
            self.enterContext(
                tempfile.TemporaryDirectory(prefix="opengeo-font-runtime-test-")
            )
        )
        self.manifest = b'{"schema":"opengeo.maplibre-package.1.0.0"}\n'
        (self.package / "runtime.json").write_bytes(self.manifest)
        self.checksum = pilot.digest(self.manifest)
        self.verified = {
            "architecture": "x86_64",
            "sandbox": {
                "kind": "user-mount-pid-net-pivot-landlock.v1",
                "launcher": "launch-maplibre.py",
            },
        }
        # The real complete verifier has owning tests with actual glyph assets.
        # These mocks isolate the host argument/launch ordering contract.
        self.verify = self.enterContext(
            patch.object(studio, "verify_runtime_package", return_value=self.verified)
        )
        self.bindings = self.enterContext(
            patch.object(studio, "verify_runtime_source_bindings")
        )

    def test_default_has_no_font_activation_or_payload_options(self):
        options = studio.parse_args([])
        self.assertFalse(options.pinned_map_fonts)
        self.assertIsNone(options.font_runtime_package)
        self.assertIsNone(options.font_runtime_manifest_sha256)
        self.assertEqual(
            studio.browser_command("/tmp/work"),
            ["node", "app/scripts/check-integrated-studio.mjs", "/tmp/work"],
        )

    def test_opt_in_requires_all_three_explicit_arguments(self):
        cases = [
            ["--pinned-map-fonts"],
            ["--pinned-map-fonts", "--font-runtime-package", str(self.package)],
            ["--pinned-map-fonts", "--font-runtime-manifest-sha256", self.checksum],
            ["--font-runtime-package", str(self.package)],
            ["--font-runtime-manifest-sha256", self.checksum],
        ]
        for arguments in cases:
            with (
                self.subTest(arguments=arguments),
                patch("sys.stderr", new=io.StringIO()),
                self.assertRaises(SystemExit),
            ):
                studio.parse_args(arguments)
        options = studio.parse_args(
            [
                "--pinned-map-fonts",
                "--font-runtime-package",
                str(self.package),
                "--font-runtime-manifest-sha256",
                self.checksum,
            ]
        )
        self.assertTrue(options.pinned_map_fonts)
        self.assertEqual(options.font_runtime_package, self.package)
        self.assertEqual(
            studio.browser_command("/tmp/work", pinned_map_fonts=True),
            [
                "node",
                "app/scripts/check-integrated-studio.mjs",
                "/tmp/work",
                "--pinned-map-fonts",
            ],
        )

    def test_payload_manifest_is_pinned_before_launch(self):
        expected = {
            "package_directory": str(self.package),
            "manifest_sha256": self.checksum,
            **self.verified,
        }
        self.assertEqual(
            studio.load_font_runtime(self.package, self.checksum), expected
        )
        self.verify.assert_called_once_with(self.package, self.checksum)
        self.bindings.assert_called_once_with(self.verified)
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            studio.load_font_runtime(self.package, "0" * 64)
        with self.assertRaisesRegex(ValueError, "lowercase"):
            studio.load_font_runtime(self.package, self.checksum.upper())
        (self.package / "runtime.json").write_bytes(self.manifest + b" ")
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            studio.load_font_runtime(self.package, self.checksum)

    def test_shared_package_rejection_precedes_database_and_container_creation(self):
        self.verify.side_effect = ValueError("package rejected")
        with (
            patch.object(studio.tempfile, "mkdtemp") as create,
            patch.object(studio, "verify_cached_worker_image") as inspect,
            self.assertRaisesRegex(ValueError, "package rejected"),
        ):
            studio.orchestrate(
                font_runtime={
                    "package_directory": str(self.package),
                    "manifest_sha256": self.checksum,
                }
            )
        create.assert_not_called()
        inspect.assert_not_called()

    def test_cached_worker_image_identity_and_architecture_are_checked_without_pulls(
        self,
    ):
        with patch.object(studio.subprocess, "run") as run:
            run.return_value = Mock(
                stdout=json.dumps(
                    [{"Id": pilot.WORKER_IMAGE, "Architecture": "amd64"}]
                ).encode()
            )
            studio.verify_cached_worker_image("x86_64")
            run.assert_called_once_with(
                ["podman", "image", "inspect", pilot.WORKER_IMAGE],
                capture_output=True,
                check=True,
            )
            with self.assertRaises(ValueError):
                studio.verify_cached_worker_image("aarch64")
            run.return_value = Mock(
                stdout=json.dumps([{"Id": "0" * 64, "Architecture": "amd64"}]).encode()
            )
            with self.assertRaises(ValueError):
                studio.verify_cached_worker_image("x86_64")

    def test_payload_root_and_manifest_cannot_be_symlinks_or_broad_paths(self):
        link = self.package / "alias"
        link.symlink_to(self.package, target_is_directory=True)
        for path in (link, Path("/tmp"), studio.ROOT, Path("relative-package")):
            with self.subTest(path=path), self.assertRaises(ValueError):
                studio.load_font_runtime(path, self.checksum)
        (self.package / "runtime.json").rename(self.package / "original.json")
        (self.package / "runtime.json").symlink_to(self.package / "original.json")
        with self.assertRaisesRegex(ValueError, "regular runtime.json"):
            studio.load_font_runtime(self.package, self.checksum)

    def test_opt_in_mount_and_api_gate_preserve_existing_isolation(self):
        arguments = (
            "database",
            Path("/tmp/work"),
            "worker",
            pilot.WORKER_IMAGE,
            "python3",
            "scripts/run-integrated-pilot-local.py",
            "--stage",
            "worker",
        )
        legacy = studio.container_command(*arguments)
        worker = studio.container_command(*arguments, font_runtime_package=self.package)
        api = studio.container_command(
            *arguments,
            enable_saved_map_gl=True,
            saved_map_gl_runtime={
                "manifest_sha256": self.checksum,
                "architecture": "x86_64",
            },
        )
        with self.assertRaisesRegex(ValueError, "runtime identity"):
            studio.container_command(*arguments, enable_saved_map_gl=True)
        self.assertIn(f"OPEN_GEO_SAVED_MAP_GL_RUNTIME_SHA256={self.checksum}", api)
        self.assertIn("OPEN_GEO_SAVED_MAP_GL_RUNTIME_ARCHITECTURE=x86_64", api)
        self.assertNotIn("OPEN_GEO_SAVED_MAP_GL_ENABLED=true", legacy)
        self.assertNotIn("OPEN_GEO_SAVED_MAP_GL_ENABLED=true", worker)
        self.assertIn("OPEN_GEO_SAVED_MAP_GL_ENABLED=true", api)
        self.assertNotIn(f"{self.package}:/opt/opengeo-maplibre:ro", api)
        self.assertIn(f"{self.package}:/opt/opengeo-maplibre:ro", worker)
        self.assertIn("--user=0", legacy)
        self.assertIn("--user=0", api)
        self.assertNotIn("--user=0", worker)
        self.assertIn("--user=10001:10001", worker)
        self.assertFalse(any(flag.startswith("--userns=") for flag in worker))
        for command in (legacy, worker, api):
            for flag in (
                "--read-only",
                "--cap-drop=all",
                "--security-opt=no-new-privileges",
                "--security-opt=label=disable",
                "--memory=3g",
                "--cpus=2",
                "--pids-limit=256",
                "--pull=never",
            ):
                self.assertIn(flag, command)
            self.assertEqual(
                command[command.index("--network") + 1], "container:database"
            )
            self.assertIn(pilot.WORKER_IMAGE, command)
            self.assertNotIn("--privileged", command)

    def test_scratch_acl_is_scoped_to_new_private_directory_in_existing_namespace(self):
        with (
            tempfile.TemporaryDirectory(
                prefix="opengeo-integrated-studio-"
            ) as temporary,
            patch.object(studio.subprocess, "run") as run,
        ):
            studio.prepare_worker_scratch(Path(temporary))
            run.assert_called_once_with(
                [
                    "podman",
                    "unshare",
                    "setfacl",
                    "--modify",
                    "u:10001:rwx,d:u::rwx,d:u:0:rwx,d:u:10001:rwx,d:g::---,d:m::rwx,d:o::---",
                    "--",
                    temporary,
                ],
                check=True,
                capture_output=True,
                timeout=15,
            )

    def test_scratch_rejects_existing_content_broad_paths_and_public_permissions(self):
        with (
            tempfile.TemporaryDirectory(
                prefix="opengeo-integrated-studio-"
            ) as temporary,
            patch.object(studio.subprocess, "run") as run,
        ):
            work = Path(temporary)
            for path in (Path("/tmp"), studio.ROOT, self.package):
                with self.assertRaises(ValueError):
                    studio.prepare_worker_scratch(path)
            work.chmod(0o755)
            with self.assertRaises(ValueError):
                studio.prepare_worker_scratch(work)
            work.chmod(0o700)
            (work / "existing.txt").write_text("preserve")
            with self.assertRaises(ValueError):
                studio.prepare_worker_scratch(work)
            self.assertEqual((work / "existing.txt").read_text(), "preserve")
            run.assert_not_called()

    @unittest.skipUnless(
        os.environ.get("OPEN_GEO_TEST_ROOTLESS_SCRATCH") == "1",
        "Requires an explicit local Podman rootless scratch check; no image or network",
    )
    def test_real_nonroot_worker_and_host_share_only_owned_synthetic_artifacts(self):
        with tempfile.TemporaryDirectory(
            prefix="opengeo-integrated-studio-"
        ) as temporary:
            work = Path(temporary)
            studio.prepare_worker_scratch(work)
            (work / "api-data.txt").write_text("API input")
            command = [
                "podman",
                "unshare",
                "setpriv",
                "--reuid=10001",
                "--regid=10001",
                "--clear-groups",
                "--bounding-set=-all",
                "--no-new-privs",
                "/usr/bin/python3",
                "-c",
                (
                    "from pathlib import Path; import sys; p=Path(sys.argv[1]); "
                    "assert (p/'api-data.txt').read_text() == 'API input'; "
                    "(p/'worker-output').mkdir(); "
                    "(p/'worker-output/result.txt').write_text('worker result'); "
                    "(p/'api-data.txt').write_text('worker update')"
                ),
                temporary,
            ]
            subprocess.run(command, check=True, capture_output=True, timeout=15)
            self.assertEqual((work / "api-data.txt").read_text(), "worker update")
            output = work / "worker-output/result.txt"
            self.assertEqual(output.read_text(), "worker result")
            output.write_text("host update")
            unrelated = [
                "podman",
                "unshare",
                "setpriv",
                "--reuid=10002",
                "--regid=10002",
                "--clear-groups",
                "--bounding-set=-all",
                "--no-new-privs",
                "/usr/bin/test",
                "-r",
                str(output),
            ]
            self.assertEqual(
                subprocess.run(
                    unrelated, check=False, capture_output=True, timeout=15
                ).returncode,
                1,
            )
            init = work / "init"
            init.mkdir()
            studio.stage_database_initialization(init)
            database_reader = [
                "podman",
                "unshare",
                "setpriv",
                "--reuid=999",
                "--regid=999",
                "--clear-groups",
                "--bounding-set=-all",
                "--no-new-privs",
                "/usr/bin/test",
                "-r",
                "001.sql",
            ]
            # The database's bind mount starts at init, not at private work.
            subprocess.run(
                database_reader, cwd=init, check=True, capture_output=True, timeout=15
            )

    def test_font_fingerprints_include_all_source_bytes_notices_and_engine(self):
        paths = studio.font_source_paths()
        self.assertEqual(len(paths), len(set(paths)))
        self.assertEqual(sum(path.suffix == ".pbf" for path in paths), 15)
        for name in ("manifest.json", "LICENSE.txt", "NOTICE.txt"):
            self.assertIn(studio.FONT_ASSET_ROOT / name, paths)
        for relative in (
            "app/node_modules/maplibre-gl/package.json",
            "app/node_modules/maplibre-gl/dist/maplibre-gl.js",
            "services/worker/scripts/render-maplibre.mjs",
        ):
            self.assertIn(studio.ROOT / relative, paths)


class RuntimeSourceBindingTests(unittest.TestCase):
    def test_payload_must_match_exact_current_font_notice_engine_and_worker_script(
        self,
    ):
        sources = [
            (f"fonts/{studio.FONT_DIRECTORY}/{source.name}", source)
            for source in studio.font_source_paths()
            if source.parent == studio.FONT_ASSET_ROOT
        ] + [
            (
                "rootfs/runtime/render-maplibre.mjs",
                studio.ROOT / "services/worker/scripts/render-maplibre.mjs",
            ),
        ]
        bundle = b"deterministic bundled MapLibre fixture"
        manifest = {
            "entrypoints": {
                "script": "runtime/render-maplibre.mjs",
                "bundle": "runtime/maplibre.js",
            },
            "fontRefs": [
                {
                    "id": "opengeo-open-sans-v1",
                    "version": 1,
                    "manifestChecksumSha256": pilot.digest(
                        (studio.FONT_ASSET_ROOT / "manifest.json").read_bytes()
                    ),
                }
            ],
            "inventory": [
                {
                    "path": relative,
                    "bytes": source.stat().st_size,
                    "sha256": pilot.digest(source.read_bytes()),
                }
                for relative, source in sources
            ],
        }
        manifest["inventory"].append(
            {
                "path": "rootfs/runtime/maplibre.js",
                "bytes": len(bundle),
                "sha256": pilot.digest(bundle),
            }
        )
        with patch.object(studio, "build_renderer_bundle", return_value=bundle):
            studio.verify_runtime_source_bindings(manifest)
        with (
            patch.object(
                studio, "build_renderer_bundle", return_value=b"different bundle"
            ),
            self.assertRaisesRegex(ValueError, "canonical source build"),
        ):
            studio.verify_runtime_source_bindings(manifest)
        notice = next(
            entry
            for entry in manifest["inventory"]
            if entry["path"].endswith("/NOTICE.txt")
        )
        notice["sha256"] = "0" * 64
        with (
            patch.object(studio, "build_renderer_bundle", return_value=bundle),
            self.assertRaisesRegex(ValueError, "source identity mismatch"),
        ):
            studio.verify_runtime_source_bindings(manifest)


class CleanupTests(unittest.TestCase):
    def test_postgis_api_stops_gracefully_before_removal_even_when_stop_times_out(self):
        process = Mock()
        for postgis, timeout in [(False, False), (True, False), (True, True)]:
            events = []

            def stop(command, **options):
                events.append(("stop", command, options))
                if timeout:
                    raise subprocess.TimeoutExpired(command, options["timeout"])

            with (
                self.subTest(postgis=postgis, timeout=timeout),
                patch.object(studio.subprocess, "run", side_effect=stop),
                patch.object(studio.pilot, "cleanup_resources", side_effect=lambda *args: events.append(("remove", args))),
            ):
                if timeout:
                    with self.assertRaises(subprocess.TimeoutExpired):
                        studio.cleanup_development_api("owned-api", "owned-worker", process, postgis_fixture=postgis)
                else:
                    studio.cleanup_development_api("owned-api", "owned-worker", process, postgis_fixture=postgis)
            self.assertEqual(events[-1], ("remove", (["owned-api", "owned-worker"], [], process)))
            if postgis:
                self.assertEqual(events[0], ("stop", ["podman", "stop", "--time=5", "owned-api"],
                                            {"capture_output": True, "check": False, "timeout": 10}))
            else:
                self.assertEqual(len(events), 1)

    def test_all_owned_resources_are_checked_after_an_earlier_failure(self):
        process = Mock()
        with (
            patch.object(
                pilot,
                "remove_container",
                side_effect=[RuntimeError("worker retained"), None, None],
            ) as remove,
            patch.object(
                pilot,
                "verify_volumes_removed",
                side_effect=[RuntimeError("volume retained"), None],
            ) as volumes,
        ):
            with self.assertRaisesRegex(
                RuntimeError, "worker retained; volume retained"
            ):
                pilot.cleanup_resources(
                    ["worker", "api", "database"], ["first", "second"], process
                )
            self.assertEqual(
                [call.args for call in remove.call_args_list],
                [("worker",), ("api",), ("database",)],
            )
            self.assertEqual(
                [call.args for call in volumes.call_args_list],
                [(["first"],), (["second"],)],
            )
            process.wait.assert_called_once_with(timeout=15)

    def test_success_requires_every_cleanup_check(self):
        with (
            patch.object(pilot, "remove_container") as remove,
            patch.object(pilot, "verify_volumes_removed") as volumes,
        ):
            pilot.cleanup_resources(["database"], ["volume"])
            remove.assert_called_once_with("database")
            volumes.assert_called_once_with(["volume"])


if __name__ == "__main__":
    unittest.main()
