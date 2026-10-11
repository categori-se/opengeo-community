"""Check initialization and cleanup without starting containers."""

import importlib.util
import io
import json
import os
import stat
import subprocess
import tempfile
import unittest
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


class InitializationTests(unittest.TestCase):
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

            notebook_sources = [
                "services/observable-builder/scripts/notebook-assets.mjs",
                "services/observable-builder/src/notebook-runtime.mjs",
                "services/observable-builder/src/portable-map-view.mjs",
                "services/observable-builder/src/legacy-notebook-runtime.mjs",
                "services/observable-builder/src/legacy-observable.mjs",
                "services/observable-builder/src/jupyter-notebook.mjs",
                "services/observable-builder/src/observable-notebook.mjs",
            ]
            for relative in notebook_sources:
                source = root / relative
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_text(relative)

            def complete_build(*args, **kwargs):
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
            for relative in notebook_sources:
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
