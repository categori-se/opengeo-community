"""Focused guards for account-local deployment and resumable image publishing."""
import contextlib
import importlib.util
import io
import json
import hashlib
import base64
import shutil
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("community_aws", Path(__file__).with_name("community-aws.py"))
MODULE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(MODULE)
CONFIG = {"account": "123456789012", "region": "us-east-1", "name": "my-opengeo", "profile": "my-opengeo", "budgetAlertEmail": "operator@example.org", "withWorker": False}

PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuJfu2ecAHT63QJCZDiPm\nebjrZN1DuR0JsQ8TcvvSwQwS+IkMhfu4aZbkYi6e3hvoeJ5ge+qha9IwBHbphWzB\nmD0oqETjg097bOK7q2snroi5K/M3F51trbOl825HZ+J/xYvFI+2wdDpqbkTKSgQ5\nUet/JGPYTC4FbuPA615bOFnrbGLHtWFB2nCx5k1vZSyHnIQErDGilhXrpdoZ9Dhz\nDiByF+dBVrVlIij2cKFjcg5MkseX7xx2xl3n0DP5YQFcm3rkuzKFuwTf3u7OkU2Y\nNjC5GXwWakCV4kNady/TGxChSgoJLKYIl4cAxUMMePAZwuXSX2P3lSsWBXNk+xkj\nNQIDAQAB\n-----END PUBLIC KEY-----\n'
SOURCE_ROOT = MODULE.ROOT


class DeploymentGuards(unittest.TestCase):
    def config_file(self, root, **changes):
        path = root / "config.json"
        path.write_text(json.dumps({**CONFIG, **changes}))
        return path

    def test_default_plan_cannot_call_cloud_or_build(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)), patch.object(MODULE, "run", side_effect=AssertionError("external command")), contextlib.redirect_stdout(io.StringIO()) as output:
            cfg = self.config_file(Path(directory))
            self.assertEqual(MODULE.main(["studio", "--config", str(cfg)]), 0)
            self.assertEqual(json.loads(output.getvalue())["mode"], "offline-plan")
            self.assertFalse((Path(directory) / ".opengeo").exists())

    def test_account_mismatch_stops_before_writes(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            deployment = MODULE.Deployment(CONFIG)
            with patch.object(deployment, "aws", return_value={"Account": "999999999999"}), patch.object(deployment, "save") as save:
                with self.assertRaisesRegex(ValueError, "no changes made"):
                    deployment.identity()
                save.assert_not_called()

    def test_configuration_cannot_carry_credentials_or_change_region_silently(self):
        with tempfile.TemporaryDirectory() as directory:
            for changes in ({"accessKey": "private"}, {"region": "eu-west-1"}, {"account": 123456789012}, {"withWorker": "false"}):
                with self.subTest(changes=changes), self.assertRaises(ValueError):
                    MODULE.load_config(self.config_file(Path(directory), **changes))

    def test_original_operator_environment_is_excluded(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)), patch.dict(os.environ, {"OPEN_GEO_API_IMAGE": "private-image", "OPEN_GEO_APPLICATION_BUCKET": "private-bucket", "CDK_DEFAULT_ACCOUNT": "999999999999"}):
            deployment = MODULE.Deployment(CONFIG)
            self.assertNotIn("OPEN_GEO_API_IMAGE", deployment.env)
            self.assertNotIn("OPEN_GEO_APPLICATION_BUCKET", deployment.env)
            self.assertEqual(deployment.env["CDK_DEFAULT_ACCOUNT"], CONFIG["account"])

    def test_state_for_another_account_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            deployment = MODULE.Deployment(CONFIG)
            deployment.save("deployment.json", {"account": "999999999999", "region": "us-east-1", "name": CONFIG["name"]})
            with self.assertRaisesRegex(ValueError, "another AWS deployment"):
                MODULE.Deployment(CONFIG)

    def test_runtime_creates_required_foundation_exports_before_consumers(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            cfg = self.config_file(Path(directory))
            deployment = MODULE.Deployment(CONFIG)
            deployment.save("images.json", {"api": "sha256:" + "a" * 64, "compiler": "sha256:" + "b" * 64})
            with patch.object(MODULE.Deployment, "identity"), patch.object(MODULE.Deployment, "deploy") as deploy:
                MODULE.main(["runtime", "--config", str(cfg), "--apply"])
                deploy.assert_called_once_with("Foundation", "Api")

    def test_ecr_permission_failure_cannot_trigger_rebuild_or_push(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            deployment = MODULE.Deployment(CONFIG)
            deployment.save("foundation.outputs.json", {"ApiRepositoryUri": "123456789012.dkr.ecr.us-east-1.amazonaws.com/opengeo/dev/api"})
            response = subprocess.CompletedProcess([], 254, "", "An error occurred (AccessDeniedException)")
            with patch.object(MODULE.subprocess, "run", return_value=response) as execute:
                with self.assertRaisesRegex(ValueError, "ECR image lookup failed"):
                    deployment.image("api")
                self.assertEqual(execute.call_count, 1)
                self.assertEqual(execute.call_args.args[0][:3], ["aws", "ecr", "describe-images"])

    def native_deployment(self, root, **changes):
        (root / "public.pem").write_text(PUBLIC_KEY)
        preview = {"domainName": "preview.example.org", "certificateArn": "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555",
                   "publicKeyPath": "public.pem", "privateKeySecretArn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:community/preview-AbCdEf", **changes}
        config_file = self.config_file(root, nativePreview=preview)
        cfg = MODULE.load_config(config_file)
        deployment = MODULE.Deployment(cfg)
        deployment.save("web.outputs.json", {"StudioDistributionDomainName": "d123456789.cloudfront.net"})
        deployment.save("api.outputs.json", {"ApiEndpoint": "https://abcdefghij.execute-api.us-east-1.amazonaws.com"})
        deployment.save("images.json", {"api": "sha256:" + "a" * 64, "compiler": "sha256:" + "b" * 64})
        source = root / "services/observable-preview/authorize"
        source.mkdir(parents=True)
        for name in ("index.html", "draft.html", "preview-shell.js", "style.css"):
            shutil.copyfile(SOURCE_ROOT / "services/observable-preview/authorize" / name, source / name)
        return config_file, MODULE.Deployment(cfg)

    def test_native_config_is_closed_same_account_and_resolves_public_path(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            root = Path(directory)
            config_file, deployment = self.native_deployment(root)
            self.assertEqual(deployment.cfg["nativePreview"]["publicKeyPath"], str(root / "public.pem"))
            for change in ({"privateKeyPem": "do not accept"}, {"publicKeyPath": 1},
                           {"certificateArn": deployment.cfg["nativePreview"]["certificateArn"].replace("123456789012", "999999999999")},
                           {"privateKeySecretArn": "arn:aws:secretsmanager:us-east-1:999999999999:secret:preview-AbCdEf"},
                           {"privateKeySecretArn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:preview"},
                           {"domainName": "https://preview.example.org"}, {"domainName": "preview.studio.opengeo.tools"},
                           {"publicMapsDomainName": "preview.example.org"}, {"domainName": "preview.example.org; img-src *"}):
                cfg = {**CONFIG, "nativePreview": {**deployment.cfg["nativePreview"], **change}}
                config_file.write_text(json.dumps(cfg))
                with self.subTest(change=change), self.assertRaises(ValueError):
                    MODULE.load_config(config_file)

    def test_native_configuration_does_not_enable_preview_during_core_bootstrap(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            config_file, deployment = self.native_deployment(Path(directory))
            self.assertNotIn("OPEN_GEO_COMMUNITY_PREVIEW_CONFIG", deployment.env)
            with patch.object(MODULE, "run", side_effect=AssertionError("No external command in plan")), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(MODULE.main(["preview", "--config", str(config_file)]), 0)
            plan = json.loads(output.getvalue())
            self.assertTrue(plan["nativePreviewConfigured"])
            self.assertLess(plan["order"].index("runtime"), plan["order"].index("preview"))
            self.assertFalse((deployment.state / "preview.intent.json").exists())

    def test_offline_preview_synthesis_uses_existing_entrypoint_without_activation_or_cloud(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            config_file, deployment = self.native_deployment(Path(directory), publicMapsDomainName="maps-preview.example.org")
            with patch.object(MODULE, "run", return_value="") as execute, patch.object(MODULE.Deployment, "identity", side_effect=AssertionError("Cloud")), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(MODULE.main(["synth", "--with-preview", "--config", str(config_file)]), 0)
            self.assertEqual(execute.call_count, 2)  # Public key validation, then the existing CDK entrypoint.
            call = execute.call_args
            self.assertEqual(call.args[0], ["node", "--import", "tsx", "bin/opengeo-community.ts"])
            descriptor = json.loads(call.kwargs["env"]["OPEN_GEO_COMMUNITY_PREVIEW_CONFIG"])
            self.assertEqual(descriptor["publicKeyPem"], PUBLIC_KEY)
            self.assertNotIn("publicKeyPath", descriptor)
            self.assertFalse((deployment.state / "preview.intent.json").exists())

    def test_preview_preflight_rejects_missing_runtime_private_or_weak_key_before_cloud(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            config_file, deployment = self.native_deployment(Path(directory))
            for body in ("-----BEGIN PRIVATE KEY-----\nPRIVATE BODY MUST NOT ENTER CONFIG\n-----END PRIVATE KEY-----\n", PUBLIC_KEY + "-----BEGIN PRIVATE KEY-----\nprivate\n", "-----BEGIN PUBLIC KEY-----\n" + "a" * 8192):
                Path(deployment.cfg["nativePreview"]["publicKeyPath"]).write_text(body)
                with self.subTest(body=body[:28]), patch.object(MODULE.Deployment, "identity", side_effect=AssertionError("Cloud")), self.assertRaises(ValueError):
                    MODULE.main(["preview", "--apply", "--config", str(config_file)])
            Path(deployment.cfg["nativePreview"]["publicKeyPath"]).write_text(PUBLIC_KEY)
            (deployment.state / "api.outputs.json").unlink()
            with patch.object(MODULE.Deployment, "identity", side_effect=AssertionError("Cloud")), self.assertRaisesRegex(ValueError, "api.outputs.json"):
                MODULE.main(["preview", "--apply", "--config", str(config_file)])
            self.assertFalse((deployment.state / "preview.intent.json").exists())

    def test_intent_is_after_identity_before_deployment_and_survives_partial_failure(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            config_file, deployment = self.native_deployment(Path(directory))
            def identity(instance):
                self.assertFalse((instance.state / "preview.intent.json").exists())
            def failed_deploy(instance, *kinds):
                self.assertEqual(kinds, ("Foundation", "Api", "Web"))
                self.assertTrue((instance.state / "preview.intent.json").exists())
                self.assertIn("OPEN_GEO_COMMUNITY_PREVIEW_CONFIG", instance.env)
                raise RuntimeError("partial deployment")
            with patch.object(MODULE.Deployment, "identity", identity), patch.object(MODULE.Deployment, "deploy", failed_deploy), self.assertRaisesRegex(RuntimeError, "partial deployment"):
                MODULE.main(["preview", "--apply", "--config", str(config_file)])
            retained = MODULE.Deployment(MODULE.load_config(config_file))
            self.assertIn("OPEN_GEO_COMMUNITY_PREVIEW_CONFIG", retained.env)
            cfg = json.loads(config_file.read_text()); cfg.pop("nativePreview"); config_file.write_text(json.dumps(cfg))
            with self.assertRaisesRegex(ValueError, "silently disabled"):
                MODULE.Deployment(MODULE.load_config(config_file))

    def test_unverified_identity_cannot_persist_activation_intent(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            config_file, deployment = self.native_deployment(Path(directory))
            with patch.object(MODULE.Deployment, "identity", side_effect=ValueError("wrong account")), patch.object(MODULE.Deployment, "deploy") as deploy, self.assertRaisesRegex(ValueError, "wrong account"):
                MODULE.main(["preview", "--apply", "--config", str(config_file)])
            deploy.assert_not_called()
            self.assertFalse((deployment.state / "preview.intent.json").exists())

    def test_retained_intent_rejects_changed_settings_until_explicit_preview_step(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            config_file, deployment = self.native_deployment(Path(directory))
            deployment.save("preview.intent.json", deployment.prepare_preview())
            cfg = json.loads(config_file.read_text()); cfg["nativePreview"]["domainName"] = "another-preview.example.org"; config_file.write_text(json.dumps(cfg))
            with self.assertRaisesRegex(ValueError, "retained intent"):
                MODULE.Deployment(MODULE.load_config(config_file))
            changed = MODULE.Deployment(MODULE.load_config(config_file), allow_preview_change=True)
            self.assertEqual(changed.env["OPEN_GEO_OBSERVABLE_PREVIEW_ORIGIN"], "https://another-preview.example.org")

    def test_shell_render_preserves_protocol_and_rejects_foreign_message_origins(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            _, deployment = self.native_deployment(Path(directory))
            deployment.prepare_preview()
            files = deployment.preview_shell()
            self.assertEqual(set(files), {"index.html", "draft.html", "preview-shell.js", "style.css"})
            draft = files["draft.html"]["body"].decode()
            self.assertNotIn("studio.opengeo.tools", draft)
            self.assertIn('frame-ancestors https://d123456789.cloudfront.net;', files["index.html"]["body"].decode())
            program = """import assert from 'node:assert/strict';import {runInNewContext} from 'node:vm';let source='';for await(const b of process.stdin)source+=b;source=source.split('<script>')[1].split('</script>')[0];for(const origin of ['https://d123456789.cloudfront.net','https://studio.opengeo.tools','https://demo.studio.opengeo.tools','https://foreign.example.org']){let handler,ready=false;const parent={};runInNewContext(source,{parent,window:{addEventListener:(name,fn)=>handler=fn},document:{querySelector:()=>({})}});handler({origin,source:parent,data:'opengeo-framework-draft-connect',ports:[{postMessage:message=>{ready=message==='ready'}}]});assert.equal(ready,origin==='https://d123456789.cloudfront.net');}"""
            subprocess.run(["node", "--input-type=module", "-e", program], input=draft, text=True, check=True, capture_output=True, timeout=10)

    def test_shell_uploads_are_owner_checked_versioned_and_completed_writes_are_reused(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            _, deployment = self.native_deployment(Path(directory))
            deployment.prepare_preview()
            deployment.save("foundation.outputs.json", {"CommunityPreviewShellBucketName": "my-opengeo-123456789012-preview-shell", "CommunityPreviewOrigin": "https://preview.example.org"})
            files = deployment.preview_shell()
            calls = []
            def put(args):
                calls.append(args)
                self.assertEqual(args[:2], ["s3api", "put-object"])
                self.assertEqual(args[args.index("--expected-bucket-owner") + 1], CONFIG["account"])
                self.assertEqual(args[args.index("--cache-control") + 1], "no-store, max-age=0")
                name = args[args.index("--key") + 1].removeprefix("authorize/")
                self.assertIn(name, files)
                self.assertEqual(Path(args[args.index("--body") + 1]).read_bytes(), files[name]["body"])
                return {"ChecksumSHA256": args[args.index("--checksum-sha256") + 1], "VersionId": "version-" + name}
            with patch.object(deployment, "aws", side_effect=put):
                deployment.upload_preview_shell(files)
                deployment.upload_preview_shell(files)
            self.assertEqual(len(calls), 4)
            self.assertEqual(len(deployment.read("preview-shell.json")["files"]), 4)

    def test_pending_upload_readback_recovers_committed_write_without_replaying(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            _, deployment = self.native_deployment(Path(directory))
            deployment.prepare_preview()
            bucket = "my-opengeo-123456789012-preview-shell"
            deployment.save("foundation.outputs.json", {"CommunityPreviewShellBucketName": bucket, "CommunityPreviewOrigin": "https://preview.example.org"})
            item = deployment.preview_shell()["index.html"]
            deployment.save("preview-shell.json", {"bucket": bucket, "account": CONFIG["account"], "files": {"index.html": {"sha256": item["sha256"], "pending": True}}})
            actual = {"ChecksumSHA256": base64.b64encode(hashlib.sha256(item["body"]).digest()).decode(), "Metadata": {"opengeo-sha256": item["sha256"]}, "ContentLength": len(item["body"]), "ContentType": item["contentType"], "CacheControl": "no-store, max-age=0", "VersionId": "recovered-version"}
            with patch.object(MODULE.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps(actual), "")) as head, patch.object(deployment, "aws", side_effect=AssertionError("Must not replay committed put")):
                deployment.upload_preview_shell({"index.html": item})
            self.assertEqual(head.call_count, 1)
            self.assertIn("--expected-bucket-owner", head.call_args.args[0])
            self.assertEqual(deployment.read("preview-shell.json")["files"]["index.html"]["versionId"], "recovered-version")

    def test_pending_upload_auth_failure_never_triggers_write_and_wrong_outputs_stop(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            _, deployment = self.native_deployment(Path(directory))
            deployment.prepare_preview()
            bucket = "my-opengeo-123456789012-preview-shell"
            deployment.save("foundation.outputs.json", {"CommunityPreviewShellBucketName": bucket, "CommunityPreviewOrigin": "https://preview.example.org"})
            item = deployment.preview_shell()["index.html"]
            deployment.save("preview-shell.json", {"bucket": bucket, "account": CONFIG["account"], "files": {"index.html": {"pending": True, "sha256": item["sha256"]}}})
            with patch.object(MODULE.subprocess, "run", return_value=subprocess.CompletedProcess([], 254, "", "AccessDenied")), patch.object(deployment, "aws", side_effect=AssertionError("No replay")), self.assertRaisesRegex(ValueError, "no write replayed"):
                deployment.upload_preview_shell({"index.html": item})
            pending_before = deployment.read("preview-shell.json")
            with patch.object(MODULE.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps({"ContentLength": 1, "VersionId": "other-version"}), "")), patch.object(deployment, "aws", side_effect=AssertionError("No replay")), self.assertRaisesRegex(ValueError, "content differs; no write replayed"):
                deployment.upload_preview_shell({"index.html": item})
            self.assertEqual(deployment.read("preview-shell.json"), pending_before)
            deployment.save("foundation.outputs.json", {"CommunityPreviewShellBucketName": "wrong-bucket", "CommunityPreviewOrigin": "https://preview.example.org"})
            with patch.object(deployment, "aws", side_effect=AssertionError("No writes")), self.assertRaisesRegex(ValueError, "configured destination"):
                deployment.upload_preview_shell({"index.html": item})

    def publication_deployment(self, root, enabled=False):
        publication = {"publisherDatabaseSecretArn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:community/publisher-AbCdEf",
            "destinations": [{"hostname": "public.example.org", "bucket": "my-publication-pages", "distribution_id": "EPUBLIC",
                              "origin_id": "publication-pages", "origin_access_control_id": "EOAC"}], "enabled": enabled}
        config_file = self.config_file(root, nativePublication=publication)
        deployment = MODULE.Deployment(MODULE.load_config(config_file))
        deployment.save("web.outputs.json", {"StudioDistributionDomainName": "d123456789.cloudfront.net", "StudioDistributionId": "ESTUDIO"})
        deployment.save("api.outputs.json", {"ApiEndpoint": "https://abcdefghij.execute-api.us-east-1.amazonaws.com"})
        deployment.save("images.json", {"api": "sha256:" + "a" * 64, "compiler": "sha256:" + "b" * 64})
        deployment.save("foundation.outputs.json", {"DatabaseClusterArn": "arn:aws:rds:us-east-1:123456789012:cluster:community",
            **{key: f"arn:aws:secretsmanager:us-east-1:123456789012:secret:community/{key}-AbCdEf" for key in
               ("DatabaseSecretArn", "RuntimeDatabaseSecretArn", "WorkerDatabaseSecretArn")}})
        return config_file, MODULE.Deployment(deployment.cfg)

    def test_publication_config_is_closed_with_unique_explicit_destinations_and_dedicated_arn(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            root = Path(directory)
            config_file, deployment = self.publication_deployment(root)
            good = deployment.cfg["nativePublication"]
            for change in ({"enabled": "false"}, {"privateKey": "never"}, {"destinations": []},
                           {"publisherDatabaseSecretArn": good["publisherDatabaseSecretArn"].replace("123456789012", "999999999999")},
                           {"publisherDatabaseSecretArn": good["publisherDatabaseSecretArn"][:-7]},
                           {"destinations": good["destinations"] * 2},
                           *[{"destinations": [{**good["destinations"][0], **fields}]} for fields in
                             ({"hostname": "public.opengeo.tools"}, {"hostname": "public.example.org; img-src *"},
                              {"distribution_id": "*"}, {"origin_id": "../private"}, {"credential": "never"})]):
                config_file.write_text(json.dumps({**CONFIG, "nativePublication": {**good, **change}}))
                with self.subTest(change=change), self.assertRaises(ValueError):
                    MODULE.load_config(config_file)

    def test_publication_metadata_plan_and_offline_synth_do_not_enable_consumption(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            config_file, deployment = self.publication_deployment(Path(directory), enabled=True)
            self.assertNotIn("OPEN_GEO_COMMUNITY_PUBLICATION_CONFIG", deployment.env)
            with patch.object(MODULE, "run", side_effect=AssertionError("No external operation in plan")), contextlib.redirect_stdout(io.StringIO()) as output:
                MODULE.main(["publication", "--config", str(config_file)])
            self.assertTrue(json.loads(output.getvalue())["nativePublicationConfigured"])
            with patch.object(MODULE, "run", return_value="") as execute, patch.object(MODULE.Deployment, "identity", side_effect=AssertionError("No cloud")), contextlib.redirect_stdout(io.StringIO()):
                MODULE.main(["synth", "--with-publication", "--config", str(config_file)])
            execute.assert_called_once()
            descriptor = json.loads(execute.call_args.kwargs["env"]["OPEN_GEO_COMMUNITY_PUBLICATION_CONFIG"])
            self.assertFalse(descriptor["enabled"])
            self.assertEqual(execute.call_args.args[0], ["node", "--import", "tsx", "bin/opengeo-community.ts"])
            self.assertFalse((deployment.state / "publication.intent.json").exists())

    def test_publication_preflight_protects_private_custody_studio_distribution_and_credentials(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            config_file, deployment = self.publication_deployment(Path(directory))
            good = deployment.cfg["nativePublication"]
            invalid_targets = [{"hostname": "d123456789.cloudfront.net"}, {"distribution_id": "ESTUDIO"},
                               *[{"bucket": "my-opengeo-123456789012-" + suffix} for suffix in
                                 ("us-east-1-app", "us-east-1-data", "us-east-1-studio", "preview-shell")]]
            invalid = [{"destinations": [{**good["destinations"][0], **target}]} for target in invalid_targets]
            invalid.append({"publisherDatabaseSecretArn": deployment.read("foundation.outputs.json")["RuntimeDatabaseSecretArn"]})
            # This fits without the legacy protected hosts but exceeds the real Lambda budget.
            invalid.append({"destinations": [{"hostname": f"pub{i}." + ".".join(["x" * 60] * 3) + ".example.org",
                "bucket": "b" * 63, "distribution_id": f"E{i}" + "X" * 30, "origin_id": "o" * 128,
                "origin_access_control_id": "A" * 32} for i in range(3)]})
            for change in invalid:
                config_file.write_text(json.dumps({**CONFIG, "nativePublication": {**good, **change}}))
                with self.subTest(change=change), patch.object(MODULE.Deployment, "identity", side_effect=AssertionError("No cloud")), self.assertRaises(ValueError):
                    MODULE.main(["publication", "--apply", "--config", str(config_file)])
            self.assertFalse((deployment.state / "publication.intent.json").exists())

    def test_publication_identity_dormant_deploy_role_setup_then_explicit_activation(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            config_file, deployment = self.publication_deployment(Path(directory), enabled=True)
            events = []
            def identity(instance):
                self.assertFalse(instance.read("publication.intent.json"))
                events.append("identity")
            def deploy(instance, *kinds):
                intent = instance.read("publication.intent.json")
                enabled = json.loads(instance.env["OPEN_GEO_COMMUNITY_PUBLICATION_CONFIG"])["enabled"]
                events.append((kinds, intent["databaseConfigured"], enabled))
            def migrate(args, **kwargs):
                self.assertEqual(args[1], "database/scripts/apply_migrations.py")
                self.assertIn("--framework-publisher-secret-arn", args)
                self.assertEqual(args[-1], deployment.cfg["nativePublication"]["publisherDatabaseSecretArn"])
                self.assertFalse(json.loads(kwargs["env"]["OPEN_GEO_COMMUNITY_PUBLICATION_CONFIG"])["enabled"])
                events.append("role-verified")
            with patch.object(MODULE.Deployment, "identity", identity), patch.object(MODULE.Deployment, "deploy", deploy), patch.object(MODULE, "run", side_effect=migrate):
                MODULE.main(["publication", "--apply", "--config", str(config_file)])
            self.assertEqual(events, ["identity", (("Foundation", "FrameworkPublisher"), False, False), "role-verified", (("FrameworkPublisher", "Api"), True, True)])
            resumed = MODULE.Deployment(MODULE.load_config(config_file))
            self.assertTrue(json.loads(resumed.env["OPEN_GEO_COMMUNITY_PUBLICATION_CONFIG"])["enabled"])

    def test_publication_role_failure_preserves_dormant_intent_and_verified_retry_skips_role_write(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            config_file, deployment = self.publication_deployment(Path(directory), enabled=True)
            with patch.object(MODULE.Deployment, "identity"), patch.object(MODULE.Deployment, "deploy"), patch.object(MODULE, "run", side_effect=RuntimeError("role setup failed")), self.assertRaisesRegex(RuntimeError, "role setup failed"):
                MODULE.main(["publication", "--apply", "--config", str(config_file)])
            resumed = MODULE.Deployment(MODULE.load_config(config_file))
            self.assertFalse(resumed.read("publication.intent.json")["databaseConfigured"])
            self.assertFalse(json.loads(resumed.env["OPEN_GEO_COMMUNITY_PUBLICATION_CONFIG"])["enabled"])
            # A successful role setup is checkpointed before the final deployment.
            def fail_activation(instance, *kinds):
                if kinds == ("FrameworkPublisher", "Api"):
                    raise RuntimeError("activation deployment interrupted")
            with patch.object(MODULE.Deployment, "identity"), patch.object(MODULE.Deployment, "deploy", fail_activation), patch.object(MODULE, "run", return_value=""), self.assertRaisesRegex(RuntimeError, "activation deployment interrupted"):
                MODULE.main(["publication", "--apply", "--config", str(config_file)])
            self.assertTrue(resumed.read("publication.intent.json")["databaseConfigured"])
            with patch.object(MODULE.Deployment, "identity"), patch.object(MODULE.Deployment, "deploy") as deploy, patch.object(MODULE, "run", side_effect=AssertionError("No repeated role setup")):
                MODULE.main(["publication", "--apply", "--config", str(config_file)])
            deploy.assert_called_once_with("FrameworkPublisher", "Api")

    def test_publication_stays_disabled_by_default_and_configuration_changes_are_explicit(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            config_file, deployment = self.publication_deployment(Path(directory))
            with patch.object(MODULE.Deployment, "identity"), patch.object(MODULE.Deployment, "deploy"), patch.object(MODULE, "run", return_value=""):
                MODULE.main(["publication", "--apply", "--config", str(config_file)])
            resumed = MODULE.Deployment(MODULE.load_config(config_file))
            self.assertFalse(json.loads(resumed.env["OPEN_GEO_COMMUNITY_PUBLICATION_CONFIG"])["enabled"])
            for cfg in ({**CONFIG}, {**deployment.cfg, "nativePublication": {**deployment.cfg["nativePublication"], "enabled": True}}):
                config_file.write_text(json.dumps(cfg))
                with self.subTest(cfg=cfg), self.assertRaises(ValueError):
                    MODULE.Deployment(MODULE.load_config(config_file))

    def test_wrong_account_cannot_record_publication_intent_or_configure_role(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            config_file, deployment = self.publication_deployment(Path(directory))
            with patch.object(MODULE.Deployment, "aws", return_value={"Account": "999999999999"}), patch.object(MODULE.Deployment, "deploy", side_effect=AssertionError("No deploy")), patch.object(MODULE, "run", side_effect=AssertionError("No role configuration")), self.assertRaisesRegex(ValueError, "no changes made"):
                MODULE.main(["publication", "--apply", "--config", str(config_file)])
            self.assertFalse(deployment.read("publication.intent.json"))

    def test_origin_phase_plan_is_offline_and_follows_existing_owner_setup(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            config_file, deployment = self.publication_deployment(Path(directory))
            with patch.object(MODULE, "run", side_effect=AssertionError("No helper, cloud or build")), contextlib.redirect_stdout(io.StringIO()) as output:
                MODULE.main(["publication-origin", "--config", str(config_file)])
            order = json.loads(output.getvalue())["order"]
            self.assertGreater(order.index("publication-origin"), order.index("owner"))
            self.assertFalse(deployment.read("publication-origins.json"))

    def test_origin_phase_uses_single_owning_helper_and_records_only_verified_readback(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            root = Path(directory)
            config_file, deployment = self.publication_deployment(root)
            deployment.save("publication.intent.json", {**deployment.prepare_publication(), "databaseConfigured": True})
            registration = root / "origin.json"
            registration.write_text("{}")  # The owning helper validates this file.
            result = {"status": "registered", "account": CONFIG["account"], "hostname": "public.example.org",
                "originId": "10000000-0000-4000-8000-000000000001", "organizationId": "10000000-0000-4000-8000-000000000002",
                "generation": 1, "activeReleasePrefix": "releases/existing", "runtimeVerification": "passed", "metadataChecks": "passed"}
            with patch.object(MODULE, "run", return_value=json.dumps(result)) as execute, patch.object(MODULE.Deployment, "identity", side_effect=AssertionError("Helper owns STS")), contextlib.redirect_stdout(io.StringIO()):
                MODULE.main(["publication-origin", "--config", str(config_file), "--registration", str(registration), "--email", "OWNER@example.org", "--apply"])
            execute.assert_called_once()
            args = execute.call_args.args[0]
            self.assertEqual(args[1], "database/scripts/bootstrap_publication_origin.py")
            self.assertEqual(args[args.index("--email") + 1], "owner@example.org")
            self.assertEqual(execute.call_args.kwargs["timeout"], 300)
            self.assertEqual(deployment.read("publication-origins.json")["origins"][result["originId"]], result)

    def test_origin_phase_rejects_missing_role_and_failed_readback_without_receipt(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            root = Path(directory)
            config_file, deployment = self.publication_deployment(root)
            deployment.save("publication.intent.json", {**deployment.prepare_publication(), "databaseConfigured": False})
            with patch.object(MODULE, "run", side_effect=AssertionError("No helper before role setup")), self.assertRaisesRegex(ValueError, "publisher database setup"):
                deployment.register_publication_origin(config_file, root / "origin.json", "owner@example.org")
            deployment.save("publication.intent.json", {**deployment.prepare_publication(), "databaseConfigured": True})
            for result in ({"status": "registered", "runtimeVerification": "failed"}, {"account": "999999999999"}):
                with self.subTest(result=result), patch.object(MODULE, "run", return_value=json.dumps(result)), self.assertRaisesRegex(ValueError, "verified readback"):
                    deployment.register_publication_origin(config_file, root / "origin.json", "owner@example.org")
            self.assertFalse(deployment.read("publication-origins.json"))


if __name__ == "__main__":
    unittest.main()
