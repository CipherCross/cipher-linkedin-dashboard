# Local API-backed UI fixture harness

`frontend/scripts/ui-fixture-dev.mjs` starts the unchanged SPA through Vercel's
local runtime. It creates a temporary project root under `/tmp`, copies the
frontend source and public assets, symlinks the installed dependencies, and generates temporary Vercel
function wrappers for synthetic identity and dashboard reads. The temporary
root has no `.env` or linked `.vercel` project, and the child process receives
only fixture variables and an isolated Vercel global config. It receives no
provider credentials.

From `frontend/`:

```bash
node scripts/ui-fixture-dev.mjs populated-admin
node scripts/ui-fixture-dev.mjs --check
```

Open `http://127.0.0.1:4300/#/`. The fixture uses `VITE_AUTH_PATH=identity` and
returns a deterministic synthetic active actor, so the real `AuthContext`,
`AuthGate`, `DataContext`, `Layout`, and routed pages execute unchanged.

Available scenarios:

- `populated-admin`
- `populated-member`
- `empty-admin`
- `empty-member`
- `error`
- `read-error` (identity succeeds; dashboard reads return HTTP 503)

Change the scenario without restarting by opening:

```text
http://127.0.0.1:4300/api/ui-fixture?scenario=empty-admin
```

Reload the route after changing it. The fixture read endpoint implements only
the path lookup, bootstrap, route snapshot, the three narrow Overview reads,
the default Leads page and text no-match query, daily series, and roster
projection needed by the initial shell and first route checks. Other Leads
filters and unknown operations return HTTP 501 with an explicit error. The known
product mutation endpoints (`pipeline`, `import`, `playbook`, `coach`, review,
classify, briefing, and notification) are temporary read-only wrappers
returning HTTP 403. POST requests to identity and dashboard reads also return
HTTP 403. A scenario switch changes only the temporary scenario file.

`--check` does not start a server. It checks the syntax of every generated
module, verifies that the scenario file contains a real newline, then invokes
the fixture handlers to check admin/member identity, populated/empty Overview
and Leads reads, a text no-match, and mutation refusal. For local HTTP smoke
after starting the server, verify `/src/main.tsx` returns JavaScript (the
temporary Vercel config must not rewrite Vite modules to HTML), switch a
scenario through `/api/ui-fixture`, and reload the route. The control response
reports the new scenario. Use the manual UI checklist for actual route layout,
keyboard, and viewport checks; the handler check alone does not prove rendering.

This is local synthetic rendering evidence only. It does not prove provider,
database, production authentication, or downstream behavior. No sign-in,
save, import, publish, review, pipeline, follow-up, or drag/drop mutation is
performed; sign-in and mutation requests are refused by the fixture.
