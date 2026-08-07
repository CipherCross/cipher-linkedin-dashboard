#!/usr/bin/env python3
"""Publish one signed sync-agent release to the separate artifact bucket.

The dashboard only has a read-only bucket credential. This script is the
operator-side writer: it requires an AWS CLI-compatible S3 client and an
Ed25519 private-key file, writes immutable versioned objects first, and moves
the small current pointer last.
"""

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import tempfile
from datetime import datetime, timezone


VERSION_RE = re.compile(rb'AGENT_VERSION\s*=\s*"(\d{1,4}\.\d{1,4}\.\d{1,4})"')


def env(name):
    value = os.environ.get(name, '').strip()
    if not value:
        raise SystemExit(f'{name} is required to publish a release')
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('agent', help='path to the agent.py bytes to publish')
    args = parser.parse_args()

    with open(args.agent, 'rb') as handle:
        body = handle.read()
    match = VERSION_RE.search(body)
    if not match:
        raise SystemExit('agent.py has no valid AGENT_VERSION marker')
    version = match.group(1).decode('ascii')
    if len(body) < 10_000 or len(body) > 4 * 1024 * 1024:
        raise SystemExit('agent.py is outside the signed release size bounds')

    digest = hashlib.sha256(body).hexdigest()
    released_at = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    canonical = '\n'.join((
        'lh2-agent-release/1', version, digest, str(len(body)), released_at,
    )).encode('utf-8')

    with tempfile.TemporaryDirectory(prefix='lh2-release-publish-') as directory:
        message = os.path.join(directory, 'manifest.message')
        signature = os.path.join(directory, 'manifest.signature')
        with open(message, 'wb') as handle:
            handle.write(canonical)
        result = subprocess.run(
            ['openssl', 'pkeyutl', '-sign', '-inkey', env('AGENT_RELEASE_SIGNING_KEY_FILE'),
             '-rawin', '-in', message, '-out', signature],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            check=False,
        )
        if result.returncode != 0:
            raise SystemExit('openssl could not sign the release manifest')
        with open(signature, 'rb') as handle:
            encoded_signature = base64.b64encode(handle.read()).decode('ascii')

    manifest = {
        'version': version,
        'sha256': digest,
        'size_bytes': len(body),
        'released_at': released_at,
        'signature': encoded_signature,
    }
    pointer = {'version': version}
    bucket = env('AGENT_RELEASE_BUCKET')
    endpoint = env('AGENT_RELEASE_ENDPOINT')
    write_access_key = env('AGENT_RELEASE_WRITE_ACCESS_KEY_ID')
    write_secret = env('AGENT_RELEASE_WRITE_SECRET_ACCESS_KEY')
    aws = env('AWS_BIN') if os.environ.get('AWS_BIN') else 'aws'
    aws_environment = dict(
        os.environ,
        AWS_ACCESS_KEY_ID=write_access_key,
        AWS_SECRET_ACCESS_KEY=write_secret,
        AWS_DEFAULT_REGION=os.environ.get('AGENT_RELEASE_REGION', 'auto'),
    )

    def upload(source, key, content_type):
        command = [aws, 's3', 'cp', source, f's3://{bucket}/{key}',
                   '--endpoint-url', endpoint, '--content-type', content_type,
                   '--only-show-errors']
        subprocess.run(command, check=True, env=aws_environment)

    with tempfile.TemporaryDirectory(prefix='lh2-release-payload-') as directory:
        manifest_path = os.path.join(directory, 'manifest.json')
        pointer_path = os.path.join(directory, 'current.json')
        with open(manifest_path, 'w', encoding='utf-8') as handle:
            json.dump(manifest, handle, separators=(',', ':'), sort_keys=True)
        with open(pointer_path, 'w', encoding='utf-8') as handle:
            json.dump(pointer, handle, separators=(',', ':'), sort_keys=True)

        upload(args.agent, f'agent/{version}/agent.py', 'text/x-python')
        upload(manifest_path, f'agent/{version}/manifest.json', 'application/json')
        # The pointer is last, so a reader sees either the old complete release
        # or the new complete release, never a pointer to half a release.
        upload(pointer_path, 'agent/current.json', 'application/json')
    print(f'published signed agent release v{version}')


if __name__ == '__main__':
    main()
