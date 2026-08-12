#!/usr/bin/env python3
"""Contract and safety tests for the macOS/Windows notebook installers."""

import hashlib
import importlib.util
import json
import os
import pathlib
import plistlib
import re
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest import mock


HERE = pathlib.Path(__file__).resolve().parent
AGENT_DIR = HERE.parent
INSTALLER_PATH = AGENT_DIR / "installer" / "install.py"

SPEC = importlib.util.spec_from_file_location("notebook_installer", INSTALLER_PATH)
installer = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = installer
SPEC.loader.exec_module(installer)


TOKEN = "lha.3f1a6c52-9b0e-4d7a-8c31-2e5f7a9d0b64." + ("a" * 43)


def successful_inspect():
    return installer.CommandResult(0, "database: /tmp/linked-helper-account-1-main/lh.db\n", "")


def successful_dry_run():
    return installer.CommandResult(
        0,
        """remote-config API failed (HTTPError) — using local config.yaml only

dry run for instance 'uitop-1' — nothing pushed

campaign                                    leads  invited  accepted  replied
----------------------------------------------------------------------------
Campaign A                                    100        80        20        5

1 campaigns, 100 leads, 20 messages, 3 steps. Compare against LH2's own numbers, then run `agent.py sync`.

ingest gateway — mode 'only', nothing sent
  credential  3f1a6c52-9b0e-4d7a-8c31-2e5f7a9d0b64
  parity      ok — every extracted row appears exactly once across the batches, with the same values
""",
        "",
    )


class ReleaseContractTest(unittest.TestCase):
    def test_release_metadata_matches_the_pinned_agent(self):
        release = json.loads((AGENT_DIR / "installer" / "release.json").read_text())
        data = (AGENT_DIR / "agent.py").read_bytes()
        expected = release["agent"]
        self.assertEqual(len(data), expected["bytes"])
        self.assertEqual(hashlib.sha256(data).hexdigest(), expected["sha256"])
        version = re.search(rb'^AGENT_VERSION = "([^"]+)"', data, re.MULTILINE)
        self.assertIsNotNone(version)
        self.assertEqual(version.group(1).decode(), expected["version"])
        self.assertIn(f"/{expected['commit']}/", expected["url"])
        self.assertNotIn("/main/", expected["url"])

    def test_release_verifier_rejects_each_changed_property(self):
        release = installer.release_metadata()["agent"]
        data = (AGENT_DIR / "agent.py").read_bytes()
        self.assertEqual(installer.verify_release_bytes(data, release), release["sha256"])
        with self.assertRaises(installer.InstallerError):
            installer.verify_release_bytes(data[:-1], release)
        changed_hash = dict(release, sha256="0" * 64)
        with self.assertRaises(installer.InstallerError):
            installer.verify_release_bytes(data, changed_hash)
        changed_version = dict(release, version="99.0.0")
        with self.assertRaises(installer.InstallerError):
            installer.verify_release_bytes(data, changed_version)


class ConfigAndSecretTest(unittest.TestCase):
    def test_rendered_config_is_json_yaml_and_contains_only_the_local_token(self):
        rendered = installer.render_config("uitop-1", "Ноутбук Івана", TOKEN)
        config = json.loads(rendered)
        self.assertEqual(config["instance_id"], "uitop-1")
        self.assertEqual(config["instance_label"], "Ноутбук Івана")
        self.assertEqual(config["ingest_mode"], "only")
        self.assertEqual(config["ingest_token"], TOKEN)
        self.assertNotIn("supabase_url", config)
        self.assertNotIn("supabase_service_key", config)
        self.assertEqual(rendered.count(TOKEN), 1)

    def test_template_has_no_tenant_secret_or_placeholder(self):
        template = (AGENT_DIR / "installer" / "config.template.json").read_text()
        self.assertNotIn("lha.", template)
        self.assertNotIn("ВСТАВЬТЕ", template)
        self.assertNotIn("supabase", template.lower())
        parsed = json.loads(template)
        self.assertFalse(parsed["sync_photos"])
        self.assertFalse(parsed["auto_update"])

    def test_token_validation_and_redaction(self):
        self.assertEqual(installer.validate_token(TOKEN), TOKEN)
        with self.assertRaises(installer.InstallerError):
            installer.validate_token(TOKEN[:-1])
        text = f"received {TOKEN} twice {TOKEN}"
        redacted = installer.redact(text)
        self.assertNotIn(TOKEN, redacted)
        self.assertEqual(redacted.count("<СКРЫТО>"), 2)

    def test_label_accepts_unicode_but_rejects_multiline_input(self):
        self.assertEqual(installer.validate_label(" Ноутбук Івана ", "fallback"), "Ноутбук Івана")
        self.assertEqual(installer.validate_label("", "uitop-1"), "uitop-1")
        with self.assertRaises(installer.InstallerError):
            installer.validate_label("Notebook\nInjected", "fallback")

    def test_state_writer_discards_secret_shaped_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            installer.write_state(root, {
                "instance_id": "uitop-1",
                "status": "ready_to_activate",
                "ingest_token": TOKEN,
                "credential": TOKEN,
            })
            state_text = (root / installer.STATE_NAME).read_text()
            self.assertNotIn(TOKEN, state_text)
            state = json.loads(state_text)
            self.assertEqual(state["instance_id"], "uitop-1")


class DryRunGateTest(unittest.TestCase):
    def test_clean_dry_run_is_ready_for_operator_review(self):
        result = installer.evaluate_dry_run(successful_inspect(), successful_dry_run())
        self.assertTrue(result.ok, result.reasons)
        self.assertEqual(result.campaigns, 1)
        self.assertEqual(result.leads, 100)

    def test_every_material_failure_blocks_activation(self):
        base = successful_dry_run().stdout
        cases = [
            (installer.CommandResult(1, "", "inspect failed"), successful_dry_run()),
            (installer.CommandResult(0, "No SQLite databases discovered\n", ""), successful_dry_run()),
            (successful_inspect(), installer.CommandResult(1, base, "failed")),
            (successful_inspect(), installer.CommandResult(0, base + "\nTraceback\n", "")),
            (successful_inspect(), installer.CommandResult(0, base.replace("parity      ok", "parity      1 PROBLEM(S)"), "")),
            (successful_inspect(), installer.CommandResult(0, base.replace("mode 'only'", "mode 'off'"), "")),
            (successful_inspect(), installer.CommandResult(0, base.replace("1 campaigns, 100 leads", "0 campaigns, 0 leads"), "")),
            (successful_inspect(), installer.CommandResult(0, base + "\nWARNING: a real sync would report status 'partial'\n", "")),
        ]
        for inspect, dry_run in cases:
            with self.subTest(output=dry_run.combined[-80:]):
                self.assertFalse(installer.evaluate_dry_run(inspect, dry_run).ok)

    def test_install_validation_runs_only_inspect_and_dry_run(self):
        calls = []

        def runner(args, cwd, timeout):
            calls.append(tuple(args))
            return successful_inspect() if args[-1] == "inspect" else successful_dry_run()

        with tempfile.TemporaryDirectory() as directory:
            result = installer.perform_validation(pathlib.Path(directory), runner)
            self.assertTrue(result.ok)
            self.assertEqual([call[-1] for call in calls], ["inspect", "--dry-run"])
            self.assertEqual(calls[1][-2:], ("sync", "--dry-run"))
            self.assertTrue((pathlib.Path(directory) / installer.INSPECT_NAME).is_file())
            self.assertTrue((pathlib.Path(directory) / installer.DRY_RUN_NAME).is_file())


class ActivationGateTest(unittest.TestCase):
    def setUp(self):
        self.state = {"instance_id": "uitop-1", "status": "ready_to_activate"}

    def test_wrong_confirmation_runs_nothing(self):
        runner = mock.Mock()
        scheduler = mock.Mock()
        updater = mock.Mock()
        with mock.patch.object(installer, "ensure_identity_unchanged"):
            with self.assertRaises(installer.InstallerError):
                installer.perform_activation(
                    pathlib.Path("/tmp/agent"), self.state, "yes", runner, scheduler,
                    mock.Mock(), updater
                )
        runner.assert_not_called()
        scheduler.assert_not_called()
        updater.assert_not_called()

    def test_failed_or_partial_sync_never_registers_schedule(self):
        scheduler = mock.Mock()
        for output in ("sync failed: HTTP 503\n", "sync partial: 12 rows delivered\n"):
            runner = mock.Mock(return_value=installer.CommandResult(0, output, ""))
            with self.subTest(output=output):
                with tempfile.TemporaryDirectory() as directory:
                    root = pathlib.Path(directory)
                    with mock.patch.object(installer, "ensure_identity_unchanged"):
                        with self.assertRaises(installer.InstallerError):
                            installer.perform_activation(
                                root, self.state, "ОДОБРЕНО uitop-1", runner, scheduler,
                                mock.Mock(), mock.Mock()
                            )
            scheduler.assert_not_called()

    def test_sync_ok_registers_schedule_after_the_live_run(self):
        events = []

        def runner(args, cwd, timeout):
            events.append("sync")
            return installer.CommandResult(0, "sync ok: 12 rows delivered\n", "")

        def scheduler(root):
            events.append("schedule")

        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(installer, "ensure_identity_unchanged"):
                result = installer.perform_activation(
                    pathlib.Path(directory), self.state, "ОДОБРЕНО uitop-1", runner, scheduler,
                    mock.Mock(), mock.Mock()
                )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(events, ["sync", "schedule"])

    def test_update_enable_failure_removes_the_verified_schedule(self):
        scheduler = mock.Mock()
        cleanup = mock.Mock()
        updater = mock.Mock(side_effect=[None, installer.InstallerError("cannot update config")])
        runner = mock.Mock(return_value=installer.CommandResult(0, "sync ok: 12 rows delivered\n", ""))
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            with mock.patch.object(installer, "ensure_identity_unchanged"):
                with self.assertRaises(installer.InstallerError):
                    installer.perform_activation(
                        root, self.state, "ОДОБРЕНО uitop-1", runner, scheduler,
                        cleanup, updater
                    )
        scheduler.assert_called_once_with(root)
        cleanup.assert_called_once_with(root)
        self.assertEqual(updater.call_args_list, [mock.call(root, False), mock.call(root, True)])


class SchedulerContractTest(unittest.TestCase):
    def test_launch_agent_uses_absolute_paths_and_30_minute_interval(self):
        root = pathlib.Path("/Users/test user/sync-agent")
        payload = plistlib.loads(installer.build_launch_agent(root))
        self.assertEqual(payload["Label"], installer.MACOS_LABEL)
        self.assertEqual(payload["StartInterval"], 1800)
        self.assertEqual(payload["WorkingDirectory"], str(root))
        self.assertEqual(payload["ProgramArguments"][-1], "sync")
        self.assertTrue(payload["ProgramArguments"][0].startswith("/"))
        self.assertNotIn("ingest_token", repr(payload))

    def test_windows_task_is_current_user_limited_and_non_overlapping(self):
        source = (AGENT_DIR / "install-windows.ps1").read_text(encoding="utf-8")
        for fragment in (
            "-WorkingDirectory $InstallRoot",
            "-RepetitionInterval (New-TimeSpan -Minutes 30)",
            "-MultipleInstances IgnoreNew",
            "-StartWhenAvailable",
            "-LogonType Interactive",
            "-RunLevel Limited",
        ):
            self.assertIn(fragment, source)
        self.assertNotIn("ingest_token", source)
        self.assertNotIn("lha.", source)

    def test_clickable_entrypoints_only_delegate_to_the_shared_engine(self):
        mac = (AGENT_DIR / "install-macos.command").read_text(encoding="utf-8")
        cmd = (AGENT_DIR / "install-windows.cmd").read_text(encoding="utf-8")
        ps1 = (AGENT_DIR / "install-windows.ps1").read_text(encoding="utf-8")
        self.assertIn("installer/install.py", mac)
        self.assertIn("install-windows.ps1", cmd)
        self.assertIn("installer\\install.py", ps1)
        for source in (mac, cmd, ps1):
            self.assertNotIn("lha.", source)

    def test_macos_entrypoint_parses_with_the_system_bash(self):
        result = subprocess.run(
            ["bash", "-n", str(AGENT_DIR / "install-macos.command")],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


class StateMachineTest(unittest.TestCase):
    def test_state_controls_the_visible_actions(self):
        self.assertEqual(installer.available_actions(None), ("install",))
        self.assertEqual(
            installer.available_actions({"status": "installing"}),
            ("install", "status"),
        )
        self.assertEqual(
            installer.available_actions({"status": "software_installed"}),
            ("recheck", "status"),
        )
        self.assertEqual(
            installer.available_actions({"status": "ready_to_activate"})[0],
            "activate",
        )
        self.assertEqual(
            installer.available_actions({"status": "active"}),
            ("status",),
        )

    def test_installer_owned_partial_state_can_resume(self):
        state = {
            "schema_version": 1,
            "instance_id": "uitop-1",
            "instance_label": "Notebook",
            "status": "installing",
        }
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            with mock.patch.object(installer, "create_virtualenv"), \
                    mock.patch.object(installer, "download_verified_agent", return_value="abc"), \
                    mock.patch.object(installer, "render_config", return_value="{}\n"), \
                    mock.patch.object(installer, "protect_secret_file"), \
                    mock.patch.object(installer, "recheck_action"):
                installer.complete_install(root, state, TOKEN)
            saved = json.loads((root / installer.STATE_NAME).read_text())
            self.assertEqual(saved["status"], "software_installed")
            self.assertEqual(saved["instance_id"], "uitop-1")
            self.assertEqual(saved["agent_sha256"], "abc")


class BundleTest(unittest.TestCase):
    def test_bundles_are_deterministic_complete_and_secret_free(self):
        builder = AGENT_DIR / "installer" / "build-bundles.py"
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory)
            first = subprocess.run(
                [sys.executable, str(builder), "--output", str(output)],
                capture_output=True,
                text=True,
            )
            self.assertEqual(first.returncode, 0, first.stderr)
            before = {
                path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                for path in output.glob("*.zip")
            }
            second = subprocess.run(
                [sys.executable, str(builder), "--output", str(output)],
                capture_output=True,
                text=True,
            )
            self.assertEqual(second.returncode, 0, second.stderr)
            after = {
                path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                for path in output.glob("*.zip")
            }
            self.assertEqual(before, after)
            self.assertEqual(set(before), {
                "lh2-sync-agent-macos.zip",
                "lh2-sync-agent-windows.zip",
            })

            for archive_path in output.glob("*.zip"):
                with zipfile.ZipFile(archive_path) as archive:
                    names = set(archive.namelist())
                    self.assertIn("installer/install.py", names)
                    self.assertIn("installer/release.json", names)
                    self.assertIn("installer/config.template.json", names)
                    self.assertIn("requirements.txt", names)
                    combined = b"".join(archive.read(name) for name in names)
                    self.assertNotIn(TOKEN.encode(), combined)
            with zipfile.ZipFile(output / "lh2-sync-agent-macos.zip") as archive:
                mode = archive.getinfo("install-macos.command").external_attr >> 16
                self.assertTrue(mode & 0o100)


if __name__ == "__main__":
    unittest.main()
