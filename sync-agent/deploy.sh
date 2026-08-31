#!/usr/bin/env bash
# Publish the sync agent to the separate, private, versioned release bucket.
# Each notebook receives a short-lived signed download URL through the
# authenticated machine API, verifies the Ed25519 signature and SHA-256 hash,
# then self-updates at the start of its next scheduled sync.
#
# This is an operator-side release action. It requires the write-scoped release
# token and signing key below; the dashboard only holds a separate read-scoped
# token and can never publish a release.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root — the paths below are repo-relative

python3 -m py_compile sync-agent/agent.py   # never ship a build that can't parse

# The transport tests, when the agent's virtualenv is present. This script is
# the LAST gate before the whole fleet self-updates, and py_compile only proves
# the build parses. The venv is gitignored, so a fresh checkout may not have one
# — that case is announced rather than passed over silently, because "the tests
# were skipped" and "the tests passed" must never look the same here.
# The installer suite runs here too, because it is the only gate that checks
# installer/release.json still pins THIS agent.py. That pin is what a fresh
# notebook installs before its first self-update, and it silently drifted four
# versions behind while only the transport tests guarded releases.
if [ -x sync-agent/.venv/bin/python3 ]; then
  sync-agent/.venv/bin/python3 sync-agent/tests/test_ingest_transport.py
  sync-agent/.venv/bin/python3 sync-agent/tests/test_installers.py
else
  echo "WARNING: sync-agent/.venv is missing — agent tests NOT run" >&2
fi

: "${AGENT_RELEASE_ENDPOINT:?Set the S3-compatible endpoint of the release bucket}"
: "${AGENT_RELEASE_BUCKET:?Set the separate agent release bucket name}"
: "${AGENT_RELEASE_WRITE_ACCESS_KEY_ID:?Set the write-scoped release access key}"
: "${AGENT_RELEASE_WRITE_SECRET_ACCESS_KEY:?Set the write-scoped release secret}"
: "${AGENT_RELEASE_SIGNING_KEY_FILE:?Set the Ed25519 signing-key PEM path}"

python3 sync-agent/publish_release.py sync-agent/agent.py
