#!/usr/bin/env python3
"""Contract and safety tests for the macOS/Windows notebook installers."""

import hashlib
import importlib.util
import json
import os
import pathlib
import plistlib
import re
import sqlite3
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

    def test_profile_config_pins_database_and_account_identity(self):
        rendered = installer.render_config(
            "uitop-1",
            "Win Erika — Alyona Kirilchenko",
            TOKEN,
            lh2_db_path=r"C:\Users\user\AppData\Roaming\linked-helper\Partitions\a\lh.db",
            account_name="Alyona Kirilchenko",
        )
        config = json.loads(rendered)
        self.assertEqual(config["account_name"], "Alyona Kirilchenko")
        self.assertTrue(config["lh2_db_path"].endswith(r"a\lh.db"))
        self.assertIn("action_results", config["mapping"]["leads"]["query"])
        self.assertNotIn("pic.invited_at", config["mapping"]["leads"]["query"])

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
            "[string]$TaskName",
            "[int]$StartOffsetMinutes",
            "AddMinutes(30 + $StartOffsetMinutes)",
        ):
            self.assertIn(fragment, source)
        self.assertNotIn("[System.IO.Path]::IsPathFullyQualified", source)
        self.assertIn("$isDriveAbsolute", source)
        self.assertIn("$isUncAbsolute", source)
        self.assertNotIn("ingest_token", source)
        self.assertNotIn("lha.", source)

    def test_two_windows_profiles_have_distinct_task_names_and_offsets(self):
        first, second = installer.WINDOWS_PROFILES
        self.assertEqual(installer.windows_task_name(first.instance_id), "LH2 Sync Agent -- uitop-1")
        self.assertEqual(installer.windows_task_name(second.instance_id), "LH2 Sync Agent -- uitop-2")
        self.assertEqual((first.schedule_offset_minutes, second.schedule_offset_minutes), (0, 15))

    def test_windows_powershell_wrapper_is_ascii_for_legacy_windows_powershell(self):
        # Windows PowerShell 5.1 treats UTF-8 without a BOM as the active ANSI
        # code page. Keep this small launcher ASCII-only so its quoted strings
        # cannot turn into parser tokens before the Unicode-aware Python UI runs.
        source = (AGENT_DIR / "install-windows.ps1").read_bytes()
        self.assertEqual(source.decode("ascii").encode("ascii"), source)

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


class MultiProfileDiscoveryTest(unittest.TestCase):
    @staticmethod
    def make_identity_db(root: pathlib.Path, folder: str, name: str) -> pathlib.Path:
        path = root / folder / "lh.db"
        path.parent.mkdir(parents=True)
        connection = sqlite3.connect(path)
        connection.execute("CREATE TABLE li_accounts (id INTEGER, full_name TEXT)")
        connection.execute("INSERT INTO li_accounts VALUES (1, ?)", (name,))
        connection.commit()
        connection.close()
        return path

    def test_two_databases_are_mapped_by_stored_name_not_path_order(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            katerina = self.make_identity_db(root, "linked-helper-account-462413-main", "Katerina Bulkina")
            alyona = self.make_identity_db(root, "linked-helper-account-518576-main", "Alyona Kirilchenko")
            found = installer.discover_windows_profile_databases(candidates=(katerina, alyona))
        self.assertEqual(found["uitop-1"], alyona)
        self.assertEqual(found["uitop-2"], katerina)

    def test_missing_duplicate_and_unexpected_identities_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            alyona = self.make_identity_db(root, "a", "Alyona Kirilchenko")
            duplicate = self.make_identity_db(root, "b", "Alyona Kirilchenko")
            unexpected = self.make_identity_db(root, "c", "Someone Else")
            with self.assertRaises(installer.InstallerError):
                installer.discover_windows_profile_databases(candidates=(alyona,))
            with self.assertRaises(installer.InstallerError):
                installer.discover_windows_profile_databases(candidates=(alyona, duplicate))
            with self.assertRaises(installer.InstallerError):
                installer.discover_windows_profile_databases(candidates=(alyona, unexpected))

    def test_owned_partial_uitop_1_is_moved_without_copying_its_secret(self):
        profile = installer.WINDOWS_PROFILES[0]
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            legacy = home / installer.LEGACY_INSTALL_DIR
            target = home / installer.WINDOWS_PROFILE_PARENT / profile.instance_id
            legacy.mkdir()
            installer.write_state(legacy, {
                "instance_id": profile.instance_id,
                "status": "software_installed",
            })
            (legacy / "config.yaml").write_text(f"ingest_token: {TOKEN}\n", encoding="utf-8")
            with mock.patch.object(pathlib.Path, "home", return_value=home):
                self.assertTrue(installer.migrate_legacy_windows_install(profile, target))
            self.assertFalse(legacy.exists())
            self.assertTrue((target / "config.yaml").is_file())
            self.assertEqual((target / "config.yaml").read_text().count(TOKEN), 1)

    def test_scheduler_commands_are_namespaced_per_profile(self):
        helper = installer.BUNDLE_ROOT / "install-windows.ps1"
        self.assertTrue(helper.is_file())
        for profile in installer.WINDOWS_PROFILES:
            calls = []

            def runner(args, cwd, timeout):
                calls.append(tuple(str(value) for value in args))
                return installer.CommandResult(0, "", "")

            with tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                installer.write_state(root, {
                    "instance_id": profile.instance_id,
                    "schedule_offset_minutes": profile.schedule_offset_minutes,
                })
                with mock.patch.object(installer, "config_instance_id", return_value=profile.instance_id):
                    installer.register_windows_schedule(root, runner=runner, verify=False)
            command = calls[0]
            self.assertIn(installer.windows_task_name(profile.instance_id), command)
            self.assertIn(str(profile.schedule_offset_minutes), command)

    def _schedule_calls(self, config, verify=False):
        calls = []

        def runner(args, cwd, timeout):
            calls.append(tuple(str(value) for value in args))
            return installer.CommandResult(0, "", "")

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            installer.write_state(root, {"instance_id": "notebook-1",
                                          "schedule_offset_minutes": 0})
            with mock.patch.object(installer, "config_instance_id", return_value="notebook-1"), \
                 mock.patch.object(installer, "load_local_config", return_value=config):
                installer.register_schedule(root, system="Windows", runner=runner, verify=verify)
        return calls

    def test_a_plain_notebook_gets_no_publish_worker(self):
        """Installing a notebook must not hand it a publish worker. The task
        follows the machine's own publish profile, not a separate list."""
        for config in (
            {},
            {"lh2_publish": {}},
            {"lh2_publish": {"enable_cdp_adapter": False}},
            {"lh2_publish": {"enable_cdp_adapter": "true"}},
            {"lh2_publish": "notebook-1"},
        ):
            flat = " ".join(" ".join(call) for call in self._schedule_calls(config))
            self.assertNotIn("-RegisterPublishSchedule", flat)
            self.assertNotIn("publish", flat.lower())

    def test_an_enabled_publish_profile_registers_the_namespaced_task(self):
        calls = self._schedule_calls({"lh2_publish": {"enable_cdp_adapter": True}})
        flat = [" ".join(call) for call in calls]
        self.assertTrue(any("-RegisterSchedule" in line for line in flat))
        publish = [line for line in flat if "-RegisterPublishSchedule" in line]
        self.assertEqual(len(publish), 1)
        self.assertIn(installer.windows_publish_task_name("notebook-1"), publish[0])
        # The publish task must be its own task, never the sync task renamed.
        self.assertNotEqual(installer.windows_publish_task_name("notebook-1"),
                            installer.windows_task_name("notebook-1"))

    def test_deactivation_removes_the_publish_task_even_without_a_profile(self):
        """A machine whose publish profile was removed first must not keep its
        task forever, so the removal is unconditional."""
        calls = []

        def runner(args, cwd, timeout):
            calls.append(" ".join(str(value) for value in args))
            return installer.CommandResult(0, "", "")

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            with mock.patch.object(installer, "config_instance_id", return_value="notebook-1"):
                installer.unregister_schedule(root, system="Windows", runner=runner)
        self.assertTrue(any("-UnregisterSchedule" in line for line in calls))
        self.assertTrue(any("-UnregisterPublishSchedule" in line for line in calls))



class CurrentLh2MappingTest(unittest.TestCase):
    def test_current_schema_mapping_derives_milestones_and_dedupes_slug(self):
        config = json.loads((AGENT_DIR / "installer" / "config.template.json").read_text())
        query = config["mapping"]["leads"]["query"]
        connection = sqlite3.connect(":memory:")
        connection.row_factory = sqlite3.Row
        connection.executescript("""
            CREATE TABLE person_in_campaigns_history (
              campaign_id INTEGER, person_id INTEGER, add_to_target_date TEXT
            );
            CREATE TABLE person_external_ids (
              person_id INTEGER, external_id TEXT, type_group TEXT
            );
            CREATE TABLE person_original_mini_profile (
              person_id INTEGER, full_name TEXT, headline TEXT
            );
            CREATE TABLE action_results (
              id INTEGER, action_version_id INTEGER, person_id INTEGER,
              result TEXT, created_at TEXT
            );
            CREATE TABLE action_versions (id INTEGER, action_id INTEGER, config_id INTEGER);
            CREATE TABLE actions (id INTEGER, campaign_id INTEGER);
            CREATE TABLE action_configs (id INTEGER, actionType TEXT);
            CREATE TABLE action_result_messages (
              action_result_id INTEGER, type TEXT
            );
            CREATE TABLE person_connect (person_id INTEGER, connected_at TEXT);
            INSERT INTO person_in_campaigns_history VALUES
              (7, 11, '2026-01-01T09:00:00Z'),
              (7, 11, '2026-01-02T09:00:00Z');
            INSERT INTO person_external_ids VALUES
              (11, 'ACopaque', 'public'), (11, 'alyona-lead', 'public');
            INSERT INTO person_original_mini_profile VALUES
              (11, 'Lead One', 'Founder');
            INSERT INTO action_configs VALUES (101, 'InvitePerson'), (102, 'CheckForReplies');
            INSERT INTO actions VALUES (201, 7), (202, 7);
            INSERT INTO action_versions VALUES (301, 201, 101), (302, 202, 102);
            INSERT INTO action_results VALUES
              (401, 301, 11, '0', '2026-01-03T10:00:00Z'),
              (402, 301, 11, '1', '2026-01-04T10:00:00Z'),
              (403, 302, 11, '1', '2026-01-10T10:00:00Z'),
              (404, 302, 11, '1', '2026-01-11T10:00:00Z');
            INSERT INTO action_result_messages VALUES (403, 'Replied'), (404, 'Replied');
            INSERT INTO person_connect VALUES (11, '2026-01-06T10:00:00Z');
        """)
        rows = connection.execute(query).fetchall()
        connection.close()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["profile_url"], "https://www.linkedin.com/in/alyona-lead")
        self.assertEqual(row["added_at"], "2026-01-01T09:00:00Z")
        self.assertEqual(row["invited_at"], "2026-01-04T10:00:00Z")
        self.assertEqual(row["connected_at"], "2026-01-06T10:00:00Z")
        self.assertEqual(row["replied_at"], "2026-01-10T10:00:00Z")
        self.assertEqual(row["last_action_at"], "2026-01-11T10:00:00Z")


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
