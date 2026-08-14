#!/usr/bin/env bash
# C5 — the Vercel smoke for /api/identity.
#
# Run AFTER the four variables are set and the deployment is live:
#   IDENTITY_STORE_DATABASE_URL (pooled), IDENTITY_SESSION_SECRET,
#   IDENTITY_BASE_URL, NEON_DATABASE_URL (pooled).
#
# Usage:
#   BASE=https://your-deployment.example.com \
#   bash c5-vercel-smoke.sh
#
# Credentials come from ~/.config/neon-s17-first-admin.env and are never printed.
#
# What this DOES do to the live system: it signs the real admin in, which writes
# a real session row into the identity store and slides/creates nothing else. It
# signs out again at the end. No business data is touched.

set -u

BASE="${BASE:?set BASE to the deployment origin, e.g. https://deck.example.com}"
BASE="${BASE%/}"
CRED="$HOME/.config/neon-s17-first-admin.env"
JAR="$(mktemp -t c5jar)"
trap 'rm -f "$JAR"' EXIT

pass=0; fail=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s — %s\n' "$1" "$2"; fail=$((fail+1)); }
check() { [ "$2" = "$3" ] && ok "$1 → $2" || bad "$1" "expected $3, got $2"; }

url() { printf '%s/api/identity?op=%s' "$BASE" "$1"; }

echo "== C5 smoke against $BASE"

# ---------------------------------------------------------------------------
# 1. Anonymous session.current must be 401 — NOT 500.
#
# This is the single most informative check: 500 means the configuration is
# wrong, and the Vercel function log names the missing variable in plain text
# (IdentityConfigurationError logs its message; everything else logs name/code).
# ---------------------------------------------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' "$(url session.current)")
check "anonymous session.current" "$code" "401"
if [ "$code" = "500" ]; then
  echo "     → check the function log: it names the variable that is unset."
  echo "     → 'NeonConfigurationError' there means NEON_DATABASE_URL, not IDENTITY_*."
fi

# ---------------------------------------------------------------------------
# 2. A state-changing POST with no Origin must be refused. C1.
# ---------------------------------------------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -d '{}' "$(url session.signIn)")
check "signIn without Origin" "$code" "403"

# ---------------------------------------------------------------------------
# 3. A hostile Origin must be refused too.
# ---------------------------------------------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -H 'Origin: https://evil.example' \
  -d '{}' "$(url session.signIn)")
check "signIn from a hostile Origin" "$code" "403"

# ---------------------------------------------------------------------------
# 4. The real sign-in. 200 + Set-Cookie, and the cookie's own attributes.
# ---------------------------------------------------------------------------
if [ ! -f "$CRED" ]; then
  bad "sign-in" "no $CRED — cannot continue"
  echo; echo "$pass passed, $fail failed"; exit 1
fi
# shellcheck disable=SC1090
set -a; . "$CRED"; set +a

hdr="$(mktemp -t c5hdr)"; trap 'rm -f "$JAR" "$hdr"' EXIT
code=$(curl -s -o /dev/null -w '%{http_code}' -D "$hdr" -c "$JAR" -X POST \
  -H 'content-type: application/json' -H "Origin: $BASE" \
  --data "$(printf '{"email":"%s","password":"%s"}' "$FIRST_ADMIN_EMAIL" "$FIRST_ADMIN_PASSWORD")" \
  "$(url session.signIn)")
check "sign-in" "$code" "200"

# 200 and NOT a redirect — the SPA navigates itself (F11).
grep -qiE '^HTTP/[0-9.]+ 3[0-9][0-9]' "$hdr" \
  && bad "sign-in is not a redirect" "got a 3xx" \
  || ok "sign-in is not a redirect"

cookie_line=$(grep -i '^set-cookie:' "$hdr" | head -1)
if [ -z "$cookie_line" ]; then
  bad "Set-Cookie present" "no Set-Cookie header"
else
  ok "Set-Cookie present"
  for attr in HttpOnly 'SameSite=Lax' 'Path=/'; do
    printf '%s' "$cookie_line" | grep -qi -- "$attr" \
      && ok "cookie carries $attr" || bad "cookie carries $attr" "absent"
  done
  # Secure follows IDENTITY_BASE_URL's scheme, not NODE_ENV. On https it must be
  # there; over plain http it must NOT be, or the browser drops the cookie and
  # the next request is anonymous — F2's trap, in both directions.
  case "$BASE" in
    https://*)
      printf '%s' "$cookie_line" | grep -qi 'Secure' \
        && ok "cookie carries Secure (https origin)" \
        || bad "cookie carries Secure" "absent on an https origin — IDENTITY_BASE_URL is probably http://" ;;
    *)
      printf '%s' "$cookie_line" | grep -qi 'Secure' \
        && bad "cookie omits Secure" "present on a plain-http origin; the browser will drop it" \
        || ok "cookie omits Secure (http origin)" ;;
  esac
  # C4: deliberately pinned to 7 days rather than inherited from the candidate.
  printf '%s' "$cookie_line" | grep -qi 'Max-Age=604800' \
    && ok "cookie Max-Age is 7 days" \
    || bad "cookie Max-Age is 7 days" "expected Max-Age=604800 — expiresIn drifted"
fi

# ---------------------------------------------------------------------------
# 5. The signed-in read. This is the call S18's AuthContext makes on startup.
# ---------------------------------------------------------------------------
body=$(curl -s -b "$JAR" "$(url session.current)")
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$(url session.current)")
check "session.current with the cookie" "$code" "200"
printf '%s' "$body" | grep -q '"provider":"better-auth"' \
  && ok "provider is better-auth (not the transitional bearer)" \
  || bad "provider is better-auth" "got: $(printf '%s' "$body" | head -c 120)"
printf '%s' "$body" | grep -q '"role":"admin"' \
  && ok "role resolves to admin from the database" \
  || bad "role resolves to admin" "the resolver did not return admin"

# ---------------------------------------------------------------------------
# 6. The roster — S18's Team page and its display-name lookup.
# ---------------------------------------------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$(url team.roster)")
check "team.roster with the cookie" "$code" "200"

# ---------------------------------------------------------------------------
# 7. Sign out, and prove the session is gone.
# ---------------------------------------------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -c "$JAR" -X POST \
  -H 'content-type: application/json' -H "Origin: $BASE" -d '{}' "$(url session.signOut)")
check "sign-out" "$code" "200"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$(url session.current)")
check "session.current after sign-out" "$code" "401"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
