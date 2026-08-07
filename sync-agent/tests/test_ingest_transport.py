#!/usr/bin/env python3
"""Tests for the agent's second transport: the machine ingest gateway.

Run with the agent's own virtualenv, from anywhere:

    sync-agent/.venv/bin/python3 sync-agent/tests/test_ingest_transport.py

`agent.py` imports `requests` and `yaml` at module scope, so the host python
will not do. There is no pytest in that virtualenv and none is added: stdlib
`unittest` is enough, and a notebook's environment is not a place to grow
dependencies.

Three things are checked here that a single-language test could not:

  * The endpoint's caps, key pattern and **field names** are read out of
    `frontend/api/_lib/agent/ingest.ts` and compared against what the agent
    produces. The two halves of this contract are written in different
    languages and deployed independently, so the only thing that keeps them
    honest is a test that reads both.
  * Parity is checked by MUTATION as well as by agreement. A checker that
    reports "ok" on a faithful payload proves nothing until it also reports a
    problem on a payload with a row removed and on one with a value changed.
  * The rollout modes are checked by what they DO, not by what they return:
    'off' is proved by the transport never issuing a request at all.
"""

import base64
import copy
import json
import os
import py_compile
import re
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT_DIR = os.path.dirname(HERE)
REPO_DIR = os.path.dirname(AGENT_DIR)
INGEST_TS = os.path.join(REPO_DIR, "frontend", "api", "_lib", "agent", "ingest.ts")
CREDENTIALS_TS = os.path.join(REPO_DIR, "frontend", "api", "_lib", "agent",
                              "credentials.ts")
PIPELINE_TS = os.path.join(REPO_DIR, "frontend", "api", "pipeline.ts")

sys.path.insert(0, AGENT_DIR)
import agent  # noqa: E402


# --------------------------------------------------------------- helpers

def read_ts(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def ts_number(source, name):
    """Pull `const NAME = 1_234` out of a TypeScript file."""
    m = re.search(rf"\b{name}\s*=\s*([0-9_]+)", source)
    if not m:
        raise AssertionError(f"{name} not found in the TypeScript source")
    return int(m.group(1).replace("_", ""))


def ts_interface_fields(source, name):
    """Pull the `readonly <field>:` names out of `export interface NAME { … }`."""
    m = re.search(rf"export interface {name} \{{(.*?)\n\}}", source, re.S)
    if not m:
        raise AssertionError(f"interface {name} not found")
    return set(re.findall(r"readonly (\w+)", m.group(1)))


def a_token():
    """A REAL token, minted the way the endpoint mints one.

    S21 lost an hour to a token-format test written against a hand-typed
    literal: the separator was `_`, base64url's alphabet contains `_`, and the
    literal happened not to. A generated secret catches that class in one run."""
    secret = base64.urlsafe_b64encode(os.urandom(32)).decode("ascii").rstrip("=")
    return f"lha.3f1a6c52-9b0e-4d7a-8c31-2e5f7a9d0b64.{secret}"


def extraction(leads=3, messages=2, steps=2, campaigns=1, body="hello"):
    """A synthetic extraction in the exact row shapes `extract_local` returns."""
    now = "2026-08-07T00:00:00+00:00"
    cs = [{"id": f"nb:{i}", "instance_id": "nb", "lh_campaign_id": str(i),
           "name": f"Campaign {i}", "status": "active", "updated_at": now}
          for i in range(campaigns)]
    ls = []
    for i in range(leads):
        ls.append({
            "instance_id": "nb", "campaign_id": f"nb:{i % max(campaigns, 1)}",
            "profile_url": f"https://www.linkedin.com/in/person-{i}",
            "full_name": f"Person {i}", "headline": "Head", "company": "Co",
            "status": "invited",
            "invited_at": "2026-07-01T10:00:00+00:00",
            "connected_at": "2026-07-02T10:00:00+00:00" if i % 2 else None,
            "first_message_at": None,
            "replied_at": "2026-07-05T10:00:00+00:00" if i % 3 == 0 else None,
            "last_action_at": now, "added_at": "2026-06-30T10:00:00+00:00",
            "updated_at": now,
        })
    ms = []
    for i in range(messages):
        ms.append({
            "instance_id": "nb", "campaign_id": "nb:0",
            "profile_url": f"https://www.linkedin.com/in/person-{i}",
            "direction": "in" if i % 2 else "out", "body": f"{body} {i}",
            "sent_at": f"2026-07-0{(i % 8) + 1}T11:00:00+00:00",
            "content_hash": agent.content_hash(f"{body} {i}"),
        })
    ss = [{"campaign_id": "nb:0", "step_index": i, "step_label": f"Step {i}",
           "step_type": "InvitePerson", "template_body": "Hi {name}",
           "sent_count": 10 + i, "replied_count": i, "current_count": 2,
           "updated_at": now} for i in range(steps)]
    demo = {
        "edu_map": {ls[0]["profile_url"]: 2010} if ls else {},
        "job_map": {ls[0]["profile_url"]: 2014} if ls else {},
        "avatar_map": {},
    }
    return cs, ls, ms, ss, demo


def planned(cfg=None, **kwargs):
    """Build + chunk + verify one extraction, the way `cmd_sync` does."""
    cfg = dict({"instance_id": "nb", "instance_label": "Notebook"}, **(cfg or {}))
    cs, ls, ms, ss, demo = extraction(**kwargs)
    sent_messages = agent.dedupe_messages(ms)
    sent_events = agent.dedupe_events(agent.derive_events("nb", ls))
    payload = agent.build_ingest_payload(cfg, cs, ls, sent_messages, sent_events,
                                         ss, demo, "ok", "")
    chunks, problems = agent.plan_ingest(cfg, payload, cs, ls, sent_messages,
                                         sent_events, ss, demo, day="20260807")
    return cfg, payload, chunks, problems, (cs, ls, sent_messages, sent_events,
                                            ss, demo)


class Answer:
    """A stand-in for a `requests` response."""

    def __init__(self, status=200, body=None):
        self.status_code = status
        self._body = body if body is not None else {
            "ok": True, "replayed": False, "batch_id": None,
            "rows_written": 1, "row_counts": {},
        }

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            import requests
            raise requests.exceptions.HTTPError(
                f"{self.status_code}", response=self)


# --------------------------------------------------------------- the tests

class CompileTest(unittest.TestCase):
    def test_agent_compiles(self):
        """The grading criterion, and the one failure that bricks a notebook:
        `sync` self-updates before it runs, and a build that does not parse is
        rejected by the updater — but only if somebody checked before deploy."""
        py_compile.compile(os.path.join(AGENT_DIR, "agent.py"), doraise=True)


class ContractPinTest(unittest.TestCase):
    """The agent's constants against the endpoint's own, read from source."""

    def setUp(self):
        self.ingest = read_ts(INGEST_TS)
        self.credentials = read_ts(CREDENTIALS_TS)

    def test_caps_match_the_endpoint(self):
        self.assertEqual(agent.INGEST_MAX_BYTES,
                         ts_number(self.ingest, "MAX_INGEST_BYTES"))
        self.assertEqual(agent.INGEST_MAX_ROWS_PER_COLLECTION,
                         ts_number(self.ingest, "MAX_ROWS_PER_COLLECTION"))
        self.assertEqual(agent.INGEST_MAX_TOTAL_ROWS,
                         ts_number(self.ingest, "MAX_TOTAL_ROWS"))

    def test_chunk_limits_stay_under_the_caps(self):
        self.assertLess(agent.INGEST_CHUNK_ROWS,
                        agent.INGEST_MAX_ROWS_PER_COLLECTION)
        self.assertLess(agent.INGEST_CHUNK_BYTES, agent.INGEST_MAX_BYTES)

    def test_idempotency_key_pattern_matches_the_endpoint(self):
        m = re.search(r"IDEMPOTENCY_KEY_PATTERN = /(.+?)/\n", self.ingest)
        self.assertIsNotNone(m, "the endpoint's key pattern was not found")
        self.assertEqual(agent.INGEST_KEY_RE.pattern, m.group(1))

    def test_token_shape_matches_the_endpoint(self):
        self.assertIn("AGENT_TOKEN_PREFIX = 'lha'", self.credentials)
        self.assertIn("SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/", self.credentials)

    def test_payload_carries_exactly_the_contract_fields(self):
        _, payload, _, _, _ = planned()
        for collection, interface in (("campaigns", "CampaignRow"),
                                      ("campaign_steps", "CampaignStepRow"),
                                      ("leads", "LeadRow"),
                                      ("messages", "MessageRow")):
            expected = ts_interface_fields(self.ingest, interface)
            self.assertEqual(set(payload[collection][0]), expected,
                             f"{collection} does not match {interface}")
        # `events` is the one collection the agent sends short: `raw` exists on
        # the contract and `derive_events` has nothing to put in it, so the
        # endpoint's `row.raw ?? null` supplies the NULL.
        self.assertEqual(set(payload["events"][0]) | {"raw"},
                         ts_interface_fields(self.ingest, "EventRow"))

    def test_no_internal_columns_leak_into_the_payload(self):
        """`updated_at` and the per-row `instance_id` are PostgREST's needs, not
        the gateway's. A field the endpoint ignores must not be in the payload:
        the idempotency key is a digest of it, so an ignored field changing
        would mint a new key for data nobody stored differently."""
        _, payload, _, _, _ = planned()
        for collection in ("campaigns", "campaign_steps", "leads", "messages",
                           "events"):
            for row in payload[collection]:
                self.assertNotIn("updated_at", row)
                self.assertNotIn("instance_id", row)


class TokenTest(unittest.TestCase):
    def test_a_real_token_parses_to_its_credential_id(self):
        token = a_token()
        self.assertEqual(agent.parse_ingest_token(token),
                         "3f1a6c52-9b0e-4d7a-8c31-2e5f7a9d0b64")

    def test_generated_secrets_always_parse(self):
        """The regression S21 recorded: base64url emits `_` and `-`, so a token
        format that split on either refused roughly three tokens in four."""
        for _ in range(200):
            self.assertIsNotNone(agent.parse_ingest_token(a_token()))

    def test_malformed_tokens_are_refused(self):
        good = a_token()
        secret = good.rsplit(".", 1)[1]
        for bad in ("", None, "lha.not-a-uuid." + secret,
                    good.replace("lha.", "lh.", 1),
                    good[:-1],
                    good.replace(".", "_"),
                    f"lha.3f1a6c52-9b0e-4d7a-8c31-2e5f7a9d0b64.{secret}.extra"):
            self.assertIsNone(agent.parse_ingest_token(bad), repr(bad))


class RemoteConfigTest(unittest.TestCase):
    """The credential is local-only, and that is structural rather than said."""

    def test_the_two_key_sets_disagree_about_nothing_by_accident(self):
        self.assertTrue(agent.LOCAL_ONLY_CONFIG_KEYS & agent.REMOTE_CONFIG_KEYS
                        <= {"ingest_token", "supabase_url",
                            "supabase_service_key", "instance_id"})
        self.assertIn("ingest_token", agent.LOCAL_ONLY_CONFIG_KEYS)
        self.assertIn("release_public_key", agent.LOCAL_ONLY_CONFIG_KEYS)

    def test_remote_config_cannot_set_a_credential(self):
        local = {"instance_id": "nb", "supabase_url": "https://local",
                 "supabase_service_key": "local-key",
                 "ingest_token": "lha.local", "release_public_key": "local-key",
                 "ingest_mode": "off"}
        hostile = {"ingest_token": "lha.attacker", "release_public_key": "attacker",
                   "supabase_url": "https://attacker",
                   "supabase_service_key": "attacker-key",
                   "instance_id": "someone-else",
                   "ingest_mode": "dual", "ingest_url": "https://gateway"}
        with mock.patch.object(agent, "fetch_remote_config",
                               return_value=hostile):
            merged = agent.apply_remote_config(dict(local))
        # Refused.
        self.assertEqual(merged["ingest_token"], "lha.local")
        self.assertEqual(merged["release_public_key"], "local-key")
        self.assertEqual(merged["supabase_url"], "https://local")
        self.assertEqual(merged["supabase_service_key"], "local-key")
        self.assertEqual(merged["instance_id"], "nb")
        # Honoured — this is the rollout lever and it must still work.
        self.assertEqual(merged["ingest_mode"], "dual")
        self.assertEqual(merged["ingest_url"], "https://gateway")

    def test_the_dashboard_refuses_to_STORE_a_credential_either(self):
        """The other half of the same rule, in the other language.

        The agent already refuses to read a credential back out of the remote
        blob, so one stored there would be inert — but it would be a machine
        credential at rest in a row every admin can read, put there by somebody
        who believed it was being delivered. The writer strips it on the way in,
        and this is what keeps the two lists from drifting apart."""
        with open(PIPELINE_TS, encoding="utf-8") as f:
            source = f.read()
        m = re.search(r"FORBIDDEN_CONFIG_KEYS = new Set\(\[(.*?)\]\)", source, re.S)
        self.assertIsNotNone(m, "the dashboard's config denylist was not found")
        denied = set(re.findall(r"'([^']+)'", m.group(1)))
        self.assertIn("ingest_token", denied)
        self.assertNotIn("release_public_key", denied)

    def test_the_allowlist_subtraction_is_what_refuses_it(self):
        """Not the spelling of the allowlist: even if a later session adds the
        token to REMOTE_CONFIG_KEYS, the subtraction still drops it."""
        with mock.patch.object(agent, "REMOTE_CONFIG_KEYS",
                               agent.REMOTE_CONFIG_KEYS | {"ingest_token"}):
            with mock.patch.object(agent, "fetch_remote_config",
                                   return_value={"ingest_token": "lha.attacker"}):
                merged = agent.apply_remote_config({"instance_id": "nb",
                                                    "ingest_token": "lha.local"})
        self.assertEqual(merged["ingest_token"], "lha.local")


class S23MachineApiTest(unittest.TestCase):
    def test_one_configured_url_selects_each_authenticated_operation(self):
        cfg = {"ingest_url": "https://dash.example/api/import?op=agent.ingest"}
        self.assertEqual(
            agent.machine_api_url(cfg, "agent.config"),
            "https://dash.example/api/import?op=agent.config",
        )
        self.assertEqual(
            agent.machine_api_url(cfg, "agent.release"),
            "https://dash.example/api/import?op=agent.release",
        )

    def test_notify_failure_is_non_fatal_with_the_machine_credential(self):
        cfg = {"instance_id": "notebook-1",
               "notify_url": "https://dash.example/api/notify-replies",
               "ingest_token": a_token()}
        with mock.patch.object(agent.requests, "post",
                               side_effect=RuntimeError("network")):
            agent.notify_new_replies(cfg)


class ModeTest(unittest.TestCase):
    def test_known_modes(self):
        for mode in agent.INGEST_MODES:
            self.assertEqual(agent.resolve_ingest_mode({"ingest_mode": mode}), mode)
        self.assertEqual(agent.resolve_ingest_mode({"ingest_mode": " DUAL "}), "dual")

    def test_unset_and_unknown_are_off(self):
        """Fail closed: `ingest_mode` is remote-overridable, so a typo on the
        Health page must leave the notebook exactly as it was."""
        self.assertEqual(agent.resolve_ingest_mode({}), "off")
        self.assertEqual(agent.resolve_ingest_mode({"ingest_mode": "on"}), "off")
        self.assertEqual(agent.resolve_ingest_mode({"ingest_mode": None}), "off")


class IdempotencyKeyTest(unittest.TestCase):
    def test_the_same_extraction_produces_the_same_key(self):
        _, _, first, _, _ = planned()
        _, _, second, _, _ = planned()
        self.assertEqual([c["idempotency_key"] for c in first],
                         [c["idempotency_key"] for c in second])

    def test_a_changed_milestone_produces_a_different_key(self):
        _, _, before, _, _ = planned()
        _, payload, _, _, source = planned()
        payload["leads"][0]["replied_at"] = "2026-07-09T10:00:00+00:00"
        after = agent.chunk_ingest_payload(payload, day="20260807")
        self.assertNotEqual(before[0]["idempotency_key"],
                            after[0]["idempotency_key"])

    def test_a_new_lead_produces_a_different_key(self):
        _, _, three, _, _ = planned(leads=3)
        _, _, four, _, _ = planned(leads=4)
        self.assertNotEqual(three[0]["idempotency_key"],
                            four[0]["idempotency_key"])

    def test_the_key_satisfies_the_endpoint_pattern(self):
        _, _, chunks, _, _ = planned(leads=200, messages=200)
        for chunk in chunks:
            self.assertRegex(chunk["idempotency_key"], agent.INGEST_KEY_RE)

    def test_the_date_component_separates_days(self):
        _, payload, _, _, _ = planned()
        self.assertNotEqual(agent.ingest_idempotency_key(payload, "20260807"),
                            agent.ingest_idempotency_key(payload, "20260808"))

    def test_the_key_is_not_part_of_its_own_digest(self):
        _, payload, _, _, _ = planned()
        with_key = dict(payload, idempotency_key="sync.20260807.deadbeef")
        self.assertEqual(agent.ingest_idempotency_key(with_key, "20260807"),
                         agent.ingest_idempotency_key(payload, "20260807"))


class ChunkingTest(unittest.TestCase):
    def test_a_small_extraction_is_one_chunk(self):
        _, _, chunks, problems, _ = planned()
        self.assertEqual(len(chunks), 1)
        self.assertEqual(problems, [])

    def test_an_empty_extraction_still_produces_one_batch(self):
        """A quiet notebook must not look like a dead one: the instance row and
        the sync_run row are written by a batch."""
        _, _, chunks, problems, _ = planned(leads=0, messages=0, steps=0)
        self.assertEqual(len(chunks), 1)
        self.assertEqual(problems, [])
        self.assertEqual(chunks[0]["leads"], [])

    def test_a_large_extraction_splits_and_loses_nothing(self):
        cfg, payload, chunks, problems, source = planned(leads=2500,
                                                         messages=1500,
                                                         campaigns=4)
        self.assertGreater(len(chunks), 1)
        self.assertEqual(problems, [])
        self.assertEqual(sum(len(c["leads"]) for c in chunks), 2500)
        self.assertEqual(sum(len(c["messages"]) for c in chunks), 1500)
        for chunk in chunks:
            self.assertEqual(len(chunk["campaigns"]), 4,
                             "every chunk carries the full campaign list")
            self.assertLessEqual(agent.ingest_chunk_bytes(chunk),
                                 agent.INGEST_MAX_BYTES)
        self.assertEqual(len({c["idempotency_key"] for c in chunks}), len(chunks))

    def test_fat_rows_split_by_bytes_not_only_by_count(self):
        """Two thousand leads are small; two thousand two-kilobyte message
        bodies are not. Row count alone would send a batch the endpoint 413s."""
        cfg, payload, chunks, problems, _ = planned(leads=1, messages=1200,
                                                    body="x" * 1900)
        self.assertEqual(problems, [])
        self.assertGreater(len(chunks), 1)
        for chunk in chunks:
            self.assertLessEqual(agent.ingest_chunk_bytes(chunk),
                                 agent.INGEST_CHUNK_BYTES)

    def test_each_chunk_is_below_the_row_caps(self):
        _, _, chunks, _, _ = planned(leads=4000, messages=4000)
        for chunk in chunks:
            for name in ("campaigns",) + agent.INGEST_CHUNKABLE:
                self.assertLessEqual(len(chunk[name]),
                                     agent.INGEST_MAX_ROWS_PER_COLLECTION)


class ParityTest(unittest.TestCase):
    """Agreement first, then mutation — a checker that only ever says 'ok' is
    indistinguishable from one that says nothing."""

    def test_a_faithful_projection_has_no_problems(self):
        _, _, _, problems, _ = planned(leads=50, messages=40, campaigns=3)
        self.assertEqual(problems, [])

    def _mutate(self, mutate, leads=20, messages=10):
        cfg, payload, chunks, problems, source = planned(leads=leads,
                                                         messages=messages)
        cs, ls, ms, es, ss, demo = source
        self.assertEqual(problems, [], "the baseline must be clean")
        mutate(chunks, cs, ls, ms, es, ss, demo)
        return agent.verify_ingest_parity(chunks, cs, ls, ms, es, ss,
                                          demo["edu_map"], demo["job_map"])

    def test_a_dropped_lead_is_caught(self):
        problems = self._mutate(
            lambda chunks, cs, ls, ms, es, ss, demo: chunks[0]["leads"].pop())
        self.assertTrue(any("leads" in p for p in problems), problems)

    def test_a_dropped_message_is_caught(self):
        problems = self._mutate(
            lambda chunks, cs, ls, ms, es, ss, demo: chunks[0]["messages"].pop())
        self.assertTrue(any("messages" in p for p in problems), problems)

    def test_a_dropped_campaign_is_caught(self):
        problems = self._mutate(
            lambda chunks, cs, ls, ms, es, ss, demo: chunks[0]["campaigns"].pop())
        self.assertTrue(any("campaigns" in p for p in problems), problems)

    def test_a_changed_milestone_is_caught(self):
        def mutate(chunks, cs, ls, ms, es, ss, demo):
            chunks[0]["leads"][0]["replied_at"] = "2099-01-01T00:00:00+00:00"
        problems = self._mutate(mutate)
        self.assertTrue(any("replied_at" in p for p in problems), problems)

    def test_a_changed_step_counter_is_caught(self):
        def mutate(chunks, cs, ls, ms, es, ss, demo):
            chunks[0]["campaign_steps"][0]["sent_count"] += 1
        problems = self._mutate(mutate)
        self.assertTrue(any("sent_count" in p for p in problems), problems)

    def test_a_dropped_start_year_is_caught(self):
        """The one field the two transports carry differently — bucketed
        upserts there, inline here — so it is the one most able to drift."""
        def mutate(chunks, cs, ls, ms, es, ss, demo):
            chunks[0]["leads"][0]["education_start_year"] = None
        problems = self._mutate(mutate)
        self.assertTrue(any("education_start_year" in p for p in problems),
                        problems)

    def test_the_inline_years_equal_what_the_supabase_path_would_send(self):
        cfg, payload, chunks, problems, source = planned(leads=30)
        cs, ls, ms, es, ss, demo = source
        buckets = agent.build_year_updates(ls, demo["edu_map"], demo["job_map"])
        expected = {}
        for bucket in buckets:
            for row in bucket:
                expected[(row["campaign_id"], row["profile_url"])] = (
                    row.get("education_start_year"),
                    row.get("first_job_start_year"))
        for row in chunks[0]["leads"]:
            key = (row["campaign_id"], row["profile_url"])
            years = (row["education_start_year"], row["first_job_start_year"])
            self.assertEqual(years, expected.get(key, (None, None)), key)

    def test_a_duplicated_key_across_chunks_is_caught(self):
        cfg, payload, chunks, problems, source = planned(leads=2500)
        cs, ls, ms, es, ss, demo = source
        chunks[1]["idempotency_key"] = chunks[0]["idempotency_key"]
        problems = agent.verify_ingest_parity(chunks, cs, ls, ms, es, ss,
                                              demo["edu_map"], demo["job_map"])
        self.assertTrue(any("not unique" in p for p in problems), problems)

    def test_an_oversized_collection_is_caught(self):
        cfg, payload, chunks, problems, source = planned(leads=10)
        cs, ls, ms, es, ss, demo = source
        chunks[0]["leads"] = chunks[0]["leads"] * 600  # past the 5000-row cap
        problems = agent.verify_ingest_parity(chunks, cs, ls, ms, es, ss,
                                              demo["edu_map"], demo["job_map"])
        self.assertTrue(any("cap" in p for p in problems), problems)


class DeliveryTest(unittest.TestCase):
    def cfg(self, mode="dual", **extra):
        return dict({"instance_id": "nb", "instance_label": "Notebook",
                     "ingest_url": "https://dash.example/api/import?op=agent.ingest",
                     "ingest_token": a_token(), "ingest_mode": mode}, **extra)

    def test_a_first_attempt_and_its_replay_present_the_same_key(self):
        """The graded property. The gateway answers 'accepted' then 'replay',
        and what makes the second answer possible is that the agent presented
        the identical key for the identical extraction."""
        cfg = self.cfg()
        _, _, chunks, problems, _ = planned(cfg)
        sent = []

        def post(url, headers=None, data=None, timeout=None):
            body = json.loads(data)
            sent.append(body["idempotency_key"])
            if len(sent) == 1:
                return Answer(200, {"ok": True, "replayed": False,
                                    "batch_id": None, "rows_written": 7})
            return Answer(200, {"ok": True, "replayed": True,
                                "batch_id": "b-1", "rows_written": 7})

        with mock.patch.object(agent.requests, "post", side_effect=post):
            first_ok, _ = agent.push_ingest(cfg, "dual", chunks, problems)
            # A second sync over an unchanged notebook: re-planned from scratch,
            # not re-using the object, so the key survives a round trip through
            # the whole build.
            _, _, again, again_problems, _ = planned(cfg)
            second_ok, _ = agent.push_ingest(cfg, "dual", again, again_problems)

        self.assertTrue(first_ok)
        self.assertTrue(second_ok)
        self.assertEqual(len(sent), 2)
        self.assertEqual(sent[0], sent[1])

    def test_the_credential_travels_as_a_bearer_token_and_nowhere_else(self):
        cfg = self.cfg()
        _, _, chunks, problems, _ = planned(cfg)
        seen = {}

        def post(url, headers=None, data=None, timeout=None):
            seen["headers"] = headers
            seen["body"] = data.decode("utf-8")
            return Answer()

        with mock.patch.object(agent.requests, "post", side_effect=post):
            agent.push_ingest(cfg, "shadow", chunks, problems)
        self.assertEqual(seen["headers"]["Authorization"],
                         f"Bearer {cfg['ingest_token']}")
        self.assertNotIn(cfg["ingest_token"].rsplit(".", 1)[1], seen["body"])

    def test_a_dark_deployment_answering_503_is_a_note_not_a_crash(self):
        cfg = self.cfg()
        _, _, chunks, problems, _ = planned(cfg)
        with mock.patch.object(agent.requests, "post",
                               return_value=Answer(503, {"error": "not configured"})):
            with mock.patch.object(agent.time, "sleep"):
                ok, note = agent.push_ingest(cfg, "dual", chunks, problems)
        self.assertFalse(ok)
        self.assertIn("503", note)

    def test_a_401_is_not_retried(self):
        """A revoked or mistyped credential is an answer, not a blip. Retrying
        it only delays the log line that explains the run."""
        cfg = self.cfg()
        _, _, chunks, problems, _ = planned(cfg)
        with mock.patch.object(agent.requests, "post",
                               return_value=Answer(401, {"error": "Unauthorized"})) as post:
            ok, note = agent.push_ingest(cfg, "dual", chunks, problems)
        self.assertFalse(ok)
        self.assertEqual(post.call_count, 1)

    def test_a_500_is_retried_then_reported(self):
        cfg = self.cfg()
        _, _, chunks, problems, _ = planned(cfg)
        with mock.patch.object(agent.requests, "post",
                               return_value=Answer(500, {})) as post:
            with mock.patch.object(agent.time, "sleep"):
                ok, note = agent.push_ingest(cfg, "dual", chunks, problems)
        self.assertFalse(ok)
        self.assertEqual(post.call_count, 3)

    def test_a_missing_url_or_token_is_refused_before_any_request(self):
        _, _, chunks, problems, _ = planned()
        for cfg in (self.cfg(ingest_url=""), self.cfg(ingest_token="")):
            with mock.patch.object(agent.requests, "post") as post:
                ok, note = agent.push_ingest(cfg, "dual", chunks, problems)
            self.assertFalse(ok)
            self.assertIn("not configured", note)
            post.assert_not_called()

    def test_a_malformed_token_is_refused_before_any_request(self):
        cfg = self.cfg(ingest_token="lha.not-a-uuid.short")
        _, _, chunks, problems, _ = planned(cfg)
        with mock.patch.object(agent.requests, "post") as post:
            ok, note = agent.push_ingest(cfg, "dual", chunks, problems)
        self.assertFalse(ok)
        self.assertIn("malformed", note)
        post.assert_not_called()

    def test_a_parity_problem_refuses_the_delivery(self):
        """A number known to disagree with the authoritative store must not be
        written to a second one: wrong in two places is worse than missing in
        one."""
        cfg = self.cfg()
        _, _, chunks, _, _ = planned(cfg)
        with mock.patch.object(agent.requests, "post") as post:
            ok, note = agent.push_ingest(cfg, "dual", chunks,
                                         ["leads: 3 sent vs 4 extracted"])
        self.assertFalse(ok)
        self.assertIn("parity", note)
        post.assert_not_called()

    def test_a_partial_failure_reports_where_it_stopped(self):
        cfg = self.cfg()
        _, _, chunks, problems, _ = planned(cfg, leads=2500)
        self.assertGreater(len(chunks), 1)
        calls = []

        def post(url, headers=None, data=None, timeout=None):
            calls.append(1)
            return Answer() if len(calls) == 1 else Answer(400, {"error": "bad"})

        with mock.patch.object(agent.requests, "post", side_effect=post):
            ok, note = agent.push_ingest(cfg, "dual", chunks, problems)
        self.assertFalse(ok)
        self.assertIn(f"2/{len(chunks)}", note)

    def test_an_inconsistent_answer_is_flagged(self):
        """`replayed` and a non-NULL `batch_id` must agree — a first attempt's
        own batch row is written last and has no id to report."""
        cfg = self.cfg()
        _, _, chunks, problems, _ = planned(cfg)
        with mock.patch.object(agent.requests, "post",
                               return_value=Answer(200, {"ok": True,
                                                         "replayed": True,
                                                         "batch_id": None})):
            with mock.patch("builtins.print") as printed:
                ok, _ = agent.push_ingest(cfg, "dual", chunks, problems)
        self.assertTrue(ok)
        self.assertTrue(any("inconsistent" in str(c) for c in printed.call_args_list))


class DryRunTest(unittest.TestCase):
    def render(self, cfg, mode, chunks, problems):
        lines = []
        with mock.patch("builtins.print", side_effect=lambda *a, **k:
                        lines.append(" ".join(str(x) for x in a))):
            agent.print_ingest_dry_run(cfg, mode, chunks, problems)
        return "\n".join(lines)

    def test_it_prints_the_real_keys_and_sends_nothing(self):
        cfg = {"instance_id": "nb", "ingest_mode": "shadow",
               "ingest_url": "https://dash.example/api/import?op=agent.ingest",
               "ingest_token": a_token()}
        _, _, chunks, problems, _ = planned(cfg, leads=2500)
        with mock.patch.object(agent.requests, "post") as post:
            out = self.render(cfg, "shadow", chunks, problems)
        post.assert_not_called()
        for chunk in chunks:
            self.assertIn(chunk["idempotency_key"], out)
        self.assertIn("nothing sent", out)
        self.assertIn("parity      ok", out)

    def test_it_names_the_credential_and_never_the_secret(self):
        token = a_token()
        cfg = {"instance_id": "nb", "ingest_url": "https://dash.example/x",
               "ingest_token": token}
        _, _, chunks, problems, _ = planned(cfg)
        out = self.render(cfg, "shadow", chunks, problems)
        self.assertIn("3f1a6c52-9b0e-4d7a-8c31-2e5f7a9d0b64", out)
        self.assertNotIn(token.rsplit(".", 1)[1], out)

    def test_it_says_a_replay_is_not_knowable_from_a_dry_run(self):
        cfg = {"instance_id": "nb", "ingest_url": "https://x",
               "ingest_token": a_token()}
        _, _, chunks, problems, _ = planned(cfg)
        out = self.render(cfg, "shadow", chunks, problems)
        self.assertIn("replay", out)
        self.assertIn("cannot be", out)

    def test_it_reports_parity_problems_as_a_refusal(self):
        cfg = {"instance_id": "nb", "ingest_url": "https://x",
               "ingest_token": a_token()}
        _, _, chunks, _, _ = planned(cfg)
        out = self.render(cfg, "shadow", chunks, ["leads: 3 sent vs 4 extracted"])
        self.assertIn("PROBLEM", out)
        self.assertIn("refuse to deliver", out)

    def test_it_says_so_when_the_mode_is_off(self):
        cfg = {"instance_id": "nb", "ingest_url": "https://x",
               "ingest_token": a_token()}
        _, _, chunks, problems, _ = planned(cfg)
        out = self.render(cfg, "off", chunks, problems)
        self.assertIn("'off'", out)

    def test_an_unset_token_is_named_rather_than_crashed_on(self):
        cfg = {"instance_id": "nb"}
        _, _, chunks, problems, _ = planned(cfg)
        out = self.render(cfg, "off", chunks, problems)
        self.assertIn("ingest_token is not set", out)
        self.assertIn("ingest_url is not set", out)


class FakeSupabase:
    """Records what the old transport did, and answers exactly as PostgREST
    would for the two calls `cmd_sync` reads back from."""

    def __init__(self, cfg):
        self.upserts = []
        self.updates = []

    def upsert(self, table, rows, on_conflict=None):
        self.upserts.append((table, len(rows)))
        return len(rows)

    def insert(self, table, row, retriable=True):
        return {"id": "run-1"}

    def update(self, table, match, patch):
        self.updates.append((table, patch))


class CmdSyncWiringTest(unittest.TestCase):
    """`cmd_sync` end to end with the network replaced.

    The mode gate lives in `cmd_sync`, so testing `push_ingest` alone proves the
    transport works and says nothing about when it runs. These four cases are
    the ones the rollout depends on, and each is asserted on what was OBSERVED —
    requests issued, tables upserted, the status the run was recorded with — not
    on a return value."""

    def run_sync(self, mode, post=None, **extra):
        cfg = dict({
            "instance_id": "nb", "instance_label": "Notebook",
            "supabase_url": "https://sb.example",
            "supabase_service_key": "service-key",
            "ingest_url": "https://dash.example/api/import?op=agent.ingest",
            "ingest_token": a_token(), "ingest_mode": mode,
        }, **extra)
        cs, ls, ms, ss, demo = extraction(leads=5, messages=4)
        sb_holder = {}

        def make_sb(config):
            sb_holder["sb"] = FakeSupabase(config)
            return sb_holder["sb"]

        with mock.patch.object(agent, "load_config", return_value=cfg), \
                mock.patch.object(agent, "apply_remote_config", lambda c: c), \
                mock.patch.object(agent, "self_update", return_value=False), \
                mock.patch.object(agent, "extract_local",
                                  return_value=(cs, ls, ms, ss, {}, demo)), \
                mock.patch.object(agent, "Supabase", side_effect=make_sb), \
                mock.patch.object(agent, "notify_new_replies"), \
                mock.patch.object(agent.time, "sleep"), \
                mock.patch.object(agent.requests, "post",
                                  side_effect=post or (lambda *a, **k: Answer())) as posted:
            agent.cmd_sync(mock.Mock(dry_run=False))
        sb = sb_holder["sb"]
        run_patch = next(p for table, p in sb.updates if table == "sync_runs")
        return sb, posted, run_patch

    def test_off_pushes_to_supabase_and_never_reaches_the_gateway(self):
        sb, posted, run_patch = self.run_sync("off")
        ordered = [t for i, (t, _) in enumerate(sb.upserts)
                   if i == 0 or sb.upserts[i - 1][0] != t]
        self.assertEqual(ordered, ["instances", "campaigns", "leads", "events",
                                   "messages", "campaign_steps"])
        posted.assert_not_called()
        self.assertEqual(run_patch["status"], "ok")

    def test_shadow_delivers_and_a_failure_stays_off_the_run(self):
        sb, posted, run_patch = self.run_sync(
            "shadow", post=lambda *a, **k: Answer(503, {"error": "dark"}))
        self.assertTrue(posted.called)
        self.assertEqual(run_patch["status"], "ok")
        self.assertNotIn("error", run_patch)

    def test_dual_delivers_and_a_failure_marks_the_run_partial(self):
        sb, posted, run_patch = self.run_sync(
            "dual", post=lambda *a, **k: Answer(503, {"error": "dark"}))
        self.assertTrue(posted.called)
        self.assertEqual(run_patch["status"], "partial")
        self.assertIn("ingest", run_patch["error"])

    def test_a_successful_delivery_leaves_the_run_green(self):
        sb, posted, run_patch = self.run_sync("dual")
        self.assertEqual(posted.call_count, 1)
        self.assertEqual(run_patch["status"], "ok")

    def test_the_supabase_push_happens_before_the_gateway_ever_hears_of_it(self):
        """Ordering is the invariant: the authoritative store is written and the
        new one is offered the result. A gateway that hangs cannot delay it."""
        order = []
        cs, ls, ms, ss, demo = extraction(leads=5, messages=4)

        class Recording(FakeSupabase):
            def upsert(self, table, rows, on_conflict=None):
                order.append(f"supabase:{table}")
                return len(rows)

        cfg = {"instance_id": "nb", "supabase_url": "https://sb.example",
               "supabase_service_key": "k", "ingest_mode": "dual",
               "ingest_url": "https://dash.example/x", "ingest_token": a_token()}

        def post(*a, **k):
            order.append("gateway")
            return Answer()

        with mock.patch.object(agent, "load_config", return_value=cfg), \
                mock.patch.object(agent, "apply_remote_config", lambda c: c), \
                mock.patch.object(agent, "self_update", return_value=False), \
                mock.patch.object(agent, "extract_local",
                                  return_value=(cs, ls, ms, ss, {}, demo)), \
                mock.patch.object(agent, "Supabase", side_effect=Recording), \
                mock.patch.object(agent, "notify_new_replies"), \
                mock.patch.object(agent.requests, "post", side_effect=post):
            agent.cmd_sync(mock.Mock(dry_run=False))
        self.assertEqual(order[-1], "gateway")
        self.assertTrue(all(step.startswith("supabase:") for step in order[:-1]))

    def test_a_gateway_that_raises_cannot_fail_the_sync(self):
        """The one property everything here rests on: a green Supabase run stays
        green. `push_ingest` swallows, so the outer except is unreachable."""
        def explode(*a, **k):
            raise RuntimeError("gateway is on fire")

        sb, posted, run_patch = self.run_sync("dual", post=explode)
        self.assertEqual(run_patch["status"], "partial")
        self.assertIn("ingest", run_patch["error"])

    def test_a_dry_run_pushes_nothing_anywhere(self):
        cfg = {"instance_id": "nb", "supabase_url": "https://sb.example",
               "supabase_service_key": "k", "ingest_mode": "dual",
               "ingest_url": "https://dash.example/x", "ingest_token": a_token()}
        cs, ls, ms, ss, demo = extraction(leads=5, messages=4)
        with mock.patch.object(agent, "load_config", return_value=cfg), \
                mock.patch.object(agent, "apply_remote_config", lambda c: c), \
                mock.patch.object(agent, "self_update") as updated, \
                mock.patch.object(agent, "extract_local",
                                  return_value=(cs, ls, ms, ss, {}, demo)), \
                mock.patch.object(agent, "Supabase") as sb, \
                mock.patch.object(agent.requests, "post") as posted, \
                mock.patch("builtins.print"):
            agent.cmd_sync(mock.Mock(dry_run=True))
        sb.assert_not_called()
        posted.assert_not_called()
        updated.assert_not_called()


class SwallowTest(unittest.TestCase):
    """The swallow starts at the projection, not at the POST.

    `push_ingest` never raises, but the build and the chunking that feed it are
    ordinary code — a mapping producing a row shape nobody expected is the
    realistic failure — and an exception escaping THEM would reach `cmd_sync`'s
    outer handler and turn a completed Supabase push into a failed run."""

    def cfg(self):
        return {"instance_id": "nb", "ingest_url": "https://dash.example/x",
                "ingest_token": a_token(), "ingest_mode": "dual"}

    def test_a_broken_projection_is_a_note_not_an_exception(self):
        cs, ls, ms, ss, demo = extraction(leads=3)
        del ls[0]["profile_url"]  # the shape the projection assumes
        with mock.patch.object(agent.requests, "post") as post:
            ok, note = agent.run_ingest_transport(self.cfg(), "dual", cs, ls, ms,
                                                  [], ss, demo, "ok", "")
        self.assertFalse(ok)
        self.assertIn("transport error", note)
        post.assert_not_called()

    def test_a_broken_projection_leaves_the_supabase_run_green_ish(self):
        """'partial', because dual reports it — never 'error', which is what an
        escaping exception would have made it.

        The projection is made to raise directly rather than through a malformed
        row: a row malformed enough to break the projection breaks `derive_events`
        first, which is the OLD path and is correctly allowed to fail a sync. The
        claim under test is narrower — that a fault on the new path alone cannot."""
        cs, ls, ms, ss, demo = extraction(leads=3)
        cfg = dict(self.cfg(), supabase_url="https://sb.example",
                   supabase_service_key="k")
        holder = {}

        def make_sb(config):
            holder["sb"] = FakeSupabase(config)
            return holder["sb"]

        with mock.patch.object(agent, "load_config", return_value=cfg), \
                mock.patch.object(agent, "apply_remote_config", lambda c: c), \
                mock.patch.object(agent, "self_update", return_value=False), \
                mock.patch.object(agent, "extract_local",
                                  return_value=(cs, ls, ms, ss, {}, demo)), \
                mock.patch.object(agent, "Supabase", side_effect=make_sb), \
                mock.patch.object(agent, "notify_new_replies"), \
                mock.patch.object(agent, "build_ingest_payload",
                                  side_effect=TypeError("row shape changed")), \
                mock.patch.object(agent.requests, "post") as post:
            agent.cmd_sync(mock.Mock(dry_run=False))
        run_patch = next(p for t, p in holder["sb"].updates if t == "sync_runs")
        self.assertEqual(run_patch["status"], "partial")
        self.assertIn("transport error", run_patch["error"])
        post.assert_not_called()
        # And the old transport still did its whole job.
        self.assertIn("campaign_steps", [t for t, _ in holder["sb"].upserts])

    def test_a_broken_preview_does_not_take_the_dry_run_with_it(self):
        cs, ls, ms, ss, demo = extraction(leads=3)
        del ls[0]["profile_url"]
        lines = []
        with mock.patch("builtins.print",
                        side_effect=lambda *a, **k: lines.append(str(a))):
            agent.preview_ingest_transport(self.cfg(), "shadow", cs, ls, ms, [],
                                           ss, demo, "ok", "")
        self.assertTrue(any("preview failed" in line for line in lines), lines)


class SupabasePathTest(unittest.TestCase):
    """The old transport is preserved, and these are the ways that could stop
    being true without anybody noticing."""

    def test_the_supabase_class_is_untouched_by_the_new_transport(self):
        with open(os.path.join(AGENT_DIR, "agent.py"), encoding="utf-8") as f:
            source = f.read()
        body = source[source.index("class Supabase:"):source.index("RELEASE_PUBLIC_KEY_CONFIG")]
        self.assertNotIn("ingest", body)

    def test_dedupe_still_collapses_the_supabase_unique_keys(self):
        cs, ls, ms, ss, demo = extraction(messages=4)
        doubled = ms + copy.deepcopy(ms)
        self.assertEqual(len(agent.dedupe_messages(doubled)), len(ms))
        events = agent.derive_events("nb", ls)
        self.assertEqual(len(agent.dedupe_events(events + copy.deepcopy(events))),
                         len(agent.dedupe_events(events)))

    def test_the_payload_is_built_from_the_deduped_lists(self):
        """Parity would still pass if both sides deduped separately, and the two
        transports would still be able to disagree. They must be the same list."""
        cs, ls, ms, ss, demo = extraction(messages=4)
        sent = agent.dedupe_messages(ms + copy.deepcopy(ms))
        payload = agent.build_ingest_payload({"instance_id": "nb"}, cs, ls, sent,
                                             [], ss, demo, "ok", "")
        self.assertEqual(len(payload["messages"]), len(sent))


if __name__ == "__main__":
    unittest.main(verbosity=2)
