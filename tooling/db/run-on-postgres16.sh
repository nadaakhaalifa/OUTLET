#!/usr/bin/env bash
# Applies every migration to a REAL, throw-away PostgreSQL 16 cluster and checks
# the database-level guarantees with SQL (not PGlite).
#   tooling/db/run-on-postgres16.sh
# Env: PG_BIN (default Postgres.app 16), WORK_DIR (default mktemp), KEEP=1 keeps the cluster.
# The cluster listens on 127.0.0.1 only, trust auth, a random free port, and is
# stopped and deleted on exit.
set -u -o pipefail

PG_BIN="${PG_BIN:-/Applications/Postgres.app/Contents/Versions/16/bin}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS="$ROOT/packages/db/migrations"
WORK_DIR="${WORK_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/outlet-pg16.XXXXXX")}"
DATA="$WORK_DIR/data"
PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
PASS=0
FAIL=0

for b in initdb pg_ctl psql; do
  [ -x "$PG_BIN/$b" ] || { echo "missing $PG_BIN/$b"; exit 2; }
done

cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then echo "kept $WORK_DIR (port $PORT, server left running; stop with pg_ctl -D $DATA stop)"; return; fi
  "$PG_BIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

P() { "$PG_BIN/psql" -X -q -h 127.0.0.1 -p "$PORT" -U postgres "$@"; }
PA() { "$PG_BIN/psql" -X -q -At -h 127.0.0.1 -p "$PORT" -U postgres -d outlet "$@"; }

ok()   { PASS=$((PASS + 1)); echo "PASS  $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "FAIL  $1"; [ -n "${2:-}" ] && echo "      $2"; }

# expect_error LABEL REGEX SQL [psql args...]: the SQL must fail and the message must match REGEX.
expect_error() {
  local label="$1" re="$2" sql="$3"; shift 3
  local out
  out="$(printf '%s\n' "$sql" | P -d outlet "$@" -v ON_ERROR_STOP=1 2>&1)"
  if [ $? -ne 0 ] && printf '%s' "$out" | grep -Eqi "$re"; then ok "$label"; else bad "$label" "expected /$re/, got: $out"; fi
}
# expect_value LABEL EXPECTED SQL
expect_value() {
  local label="$1" want="$2" sql="$3" got
  got="$(PA -v ON_ERROR_STOP=1 -c "$sql" 2>&1)"
  if [ "$got" = "$want" ]; then ok "$label"; else bad "$label" "want '$want' got '$got'"; fi
}

echo "== cluster =="
"$PG_BIN/initdb" -D "$DATA" -U postgres --auth=trust --encoding=UTF8 --locale=C >/dev/null || exit 2
"$PG_BIN/pg_ctl" -D "$DATA" -o "-p $PORT -c listen_addresses=127.0.0.1 -c max_connections=300 -c unix_socket_directories=''" -w -l "$WORK_DIR/pg.log" start >/dev/null || { cat "$WORK_DIR/pg.log"; exit 2; }
P -d postgres -c 'CREATE DATABASE outlet' >/dev/null || exit 2
echo "server: $(PA -c 'SHOW server_version')  port $PORT"
case "$(PA -c 'SHOW server_version_num')" in 16*) ;; *) echo "not PostgreSQL 16"; exit 2 ;; esac

echo "== migrations =="
P -d outlet -c 'CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())' || exit 2
for f in $(ls "$MIGRATIONS"/*.sql | sort); do
  base="$(basename "$f")"
  ver=$((10#${base%%_*}))
  if grep -Eq '^--[[:space:]]*no-transaction[[:space:]]*$' "$f"; then
    mode="no-transaction (autocommit, CONCURRENTLY is real here)"
    P -d outlet -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>"$WORK_DIR/err" || { bad "migration $base" "$(cat "$WORK_DIR/err")"; continue; }
  else
    mode="single transaction"
    P -d outlet -v ON_ERROR_STOP=1 --single-transaction -f "$f" >/dev/null 2>"$WORK_DIR/err" || { bad "migration $base" "$(cat "$WORK_DIR/err")"; continue; }
  fi
  PA -c "INSERT INTO schema_migrations (version, name, checksum) VALUES ($ver, '${base%.sql}', 'psql')" >/dev/null
  ok "migration $base [$mode]"
done
echo "extensions installed: $(PA -c "SELECT string_agg(extname, ', ' ORDER BY extname) FROM pg_extension")"
echo "extensions available but absent from 0001: $(PA -c "SELECT coalesce(string_agg(n, ', '), 'none') FROM unnest(ARRAY['pgcrypto','pg_trgm','citext','vector','pg_cron']) n WHERE n NOT IN (SELECT extname FROM pg_extension)")"
expect_value "no invalid indexes after CONCURRENTLY build" "0" \
  "SELECT count(*) FROM pg_index WHERE NOT indisvalid"
expect_value "outbox due index exists and is valid" "1" \
  "SELECT count(*) FROM pg_indexes i JOIN pg_index x ON x.indexrelid = ('public.' || i.indexname)::regclass WHERE i.indexname = 'outbox_events_due_idx' AND x.indisvalid"
expect_value "ledger_accounts_type_fk validated" "t" \
  "SELECT convalidated FROM pg_constraint WHERE conname='ledger_accounts_type_fk'"
expect_value "17 account types seeded" "17" "SELECT count(*) FROM ledger_account_types"

echo "== ledger =="
PA -c "INSERT INTO ledger_accounts (type, owner_type, currency, sub_key) VALUES ('psp_clearing','platform','EGP','a'),('platform_commission','platform','EGP','b')" >/dev/null
A="$(PA -c "SELECT id FROM ledger_accounts WHERE sub_key='a'")"
B="$(PA -c "SELECT id FROM ledger_accounts WHERE sub_key='b'")"
expect_error "unknown account type rejected (FK)" "violates foreign key" \
  "INSERT INTO ledger_accounts (type, owner_type, currency) VALUES ('platform_comission','platform','EGP');"
expect_error "unbalanced entry rejected at COMMIT" "unbalanced" \
  "BEGIN; INSERT INTO journal_entries (id, kind, idempotency_key, occurred_at, ref_type, ref_id) VALUES ('00000000-0000-4000-8000-0000000000a1','t','unbal',now(),'o','1');
   INSERT INTO postings (entry_id, account_id, amount, currency) VALUES ('00000000-0000-4000-8000-0000000000a1','$A',100,'EGP'),('00000000-0000-4000-8000-0000000000a1','$B',-99,'EGP'); COMMIT;"
expect_value "unbalanced entry left no rows" "0" "SELECT count(*) FROM journal_entries WHERE idempotency_key='unbal'"
printf "BEGIN;\nINSERT INTO journal_entries (id, kind, idempotency_key, occurred_at, ref_type, ref_id) VALUES ('00000000-0000-4000-8000-0000000000b1','t','bal',now(),'o','1');\nINSERT INTO postings (entry_id, account_id, amount, currency) VALUES ('00000000-0000-4000-8000-0000000000b1','%s',100,'EGP'),('00000000-0000-4000-8000-0000000000b1','%s',-100,'EGP');\nCOMMIT;\n" "$A" "$B" | P -d outlet -v ON_ERROR_STOP=1 >/dev/null 2>&1 \
  && ok "balanced entry commits" || bad "balanced entry commits"
expect_error "UPDATE postings rejected" "append-only" "UPDATE postings SET amount = amount + 1;"
expect_error "DELETE postings rejected" "append-only" "DELETE FROM postings;"
expect_error "TRUNCATE postings rejected" "append-only" "TRUNCATE postings;"
expect_error "UPDATE journal_entries rejected" "append-only" "UPDATE journal_entries SET kind='x';"
expect_error "late posting (later transaction) rejected" "transaction that created" \
  "INSERT INTO postings (entry_id, account_id, amount, currency) VALUES ('00000000-0000-4000-8000-0000000000b1','$A',1,'EGP');"
expect_error "duplicate idempotency_key rejected" "duplicate key" \
  "BEGIN; INSERT INTO journal_entries (kind, idempotency_key, occurred_at, ref_type, ref_id) VALUES ('t','bal',now(),'o','1'); COMMIT;"
expect_value "trial balance is zero" "0" "SELECT coalesce(sum(total),0) FROM ledger_trial_balance"
expect_error "UPDATE ledger_accounts identity rejected" "immutable" "UPDATE ledger_accounts SET currency='USD' WHERE id='$A';"

echo "== outbox claim (SKIP LOCKED) =="
for i in 1 2 3 4; do
  PA -c "INSERT INTO outbox_events (id, occurred_at, aggregate_type, aggregate_id, event_type, payload, ordering_key) VALUES ('00000000-0000-4000-8000-00000000010$i', now() + ($i || ' ms')::interval, 'order', '00000000-0000-4000-8000-00000000020$i', 'order.placed', '{}', 'order:$i')" >/dev/null
done
CLAIM="SELECT id FROM outbox_events o
 WHERE o.published_at IS NULL AND o.dead_lettered_at IS NULL
   AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= now())
   AND NOT EXISTS (SELECT 1 FROM outbox_events e
                    WHERE e.ordering_key = o.ordering_key AND e.published_at IS NULL
                      AND (e.occurred_at, e.id) < (o.occurred_at, o.id)
                      AND (e.dead_lettered_at IS NOT NULL OR e.next_attempt_at > now()))
 ORDER BY o.occurred_at, o.id LIMIT 2 FOR UPDATE SKIP LOCKED"
( printf 'BEGIN;\n%s;\nSELECT pg_sleep(3);\nCOMMIT;\n' "$CLAIM" | P -d outlet -At > "$WORK_DIR/claim_a" 2>&1 ) &
BG=$!
sleep 1
printf 'BEGIN;\n%s;\nCOMMIT;\n' "$CLAIM" | P -d outlet -At > "$WORK_DIR/claim_b" 2>&1
wait "$BG"
CA="$(grep -E '^[0-9a-f-]{36}$' "$WORK_DIR/claim_a" | sort | tr '\n' ' ')"
CB="$(grep -E '^[0-9a-f-]{36}$' "$WORK_DIR/claim_b" | sort | tr '\n' ' ')"
NA=$(printf '%s' "$CA" | wc -w | tr -d ' '); NB=$(printf '%s' "$CB" | wc -w | tr -d ' ')
OVER="$(comm -12 <(printf '%s\n' $CA | sort) <(printf '%s\n' $CB | sort) | wc -l | tr -d ' ')"
if [ "$NA" = 2 ] && [ "$NB" = 2 ] && [ "$OVER" = 0 ]; then ok "two concurrent relays claim disjoint batches (2 + 2, no overlap)"; else bad "concurrent claim" "A=[$CA] B=[$CB] overlap=$OVER"; fi
PA -c "UPDATE outbox_events SET dead_lettered_at = now() WHERE id='00000000-0000-4000-8000-000000000101'" >/dev/null
PA -c "INSERT INTO outbox_events (id, occurred_at, aggregate_type, aggregate_id, event_type, payload, ordering_key) VALUES ('00000000-0000-4000-8000-000000000105', now(), 'order', '00000000-0000-4000-8000-000000000201', 'order.paid', '{}', 'order:1')" >/dev/null
expect_value "dead-lettered head blocks later event of same ordering_key" "0" \
  "SELECT count(*) FROM ($CLAIM) c WHERE id = '00000000-0000-4000-8000-000000000105'"
expect_error "outbox content immutable" "immutable" "UPDATE outbox_events SET payload='{\"x\":1}';"

echo "== audit hash chain =="
for a in a b c d; do PA -c "INSERT INTO audit_log (chain_id, actor_type, action, diff_redacted) VALUES ('c1','system','$a','{\"k\":1}')" >/dev/null; done
expect_value "clean chain verifies with no problems" "0" "SELECT count(*) FROM audit_log_verify('c1')"
expect_error "UPDATE audit_log rejected" "append-only" "UPDATE audit_log SET action='x';"
PA -c "ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable_trg; UPDATE audit_log SET action='forged' WHERE chain_id='c1' AND seq=2; ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable_trg" >/dev/null
expect_value "modified row detected" "t" "SELECT count(*) > 0 FROM audit_log_verify('c1') WHERE problem ~ 'modified'"
for a in a b c; do PA -c "INSERT INTO audit_log (chain_id, actor_type, action) VALUES ('c2','system','$a')" >/dev/null; done
PA -c "ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable_trg; DELETE FROM audit_log WHERE chain_id='c2' AND seq=2; ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable_trg" >/dev/null
expect_value "removed middle row detected" "t" "SELECT count(*) > 0 FROM audit_log_verify('c2') WHERE problem ~ 'gap'"
echo "-- concurrent appenders on one chain"
for i in 1 2 3 4 5 6; do
  ( for j in 1 2 3 4 5; do PA -c "INSERT INTO audit_log (chain_id, actor_type, action) VALUES ('c3','system','w$i-$j')" >/dev/null; done ) &
done
wait
expect_value "30 concurrent appends: contiguous seq 1..30, chain verifies" "30|30|0" \
  "SELECT count(*) || '|' || max(seq) || '|' || (SELECT count(*) FROM audit_log_verify('c3')) FROM audit_log WHERE chain_id='c3'"

echo "== RLS with a non-superuser role =="
P -d outlet -c "CREATE ROLE app_login LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE app_user" >/dev/null
PA -c "INSERT INTO users (id) VALUES ('00000000-0000-4000-8000-000000000a20'),('00000000-0000-4000-8000-000000000a21')" >/dev/null
# rls USER ROLE SQL: prints all output; scalar callers use rls1 (last line).
rls1() { rls "$@" | tail -1; }
rls() { # USER ROLE SQL
  printf "SET ROLE app_user;\nBEGIN;\nSELECT set_config('app.user_id','%s',true), set_config('app.role','%s',true);\n%s;\nCOMMIT;\n" "$1" "$2" "$3" \
    | "$PG_BIN/psql" -X -q -At -h 127.0.0.1 -p "$PORT" -U app_login -d outlet -v ON_ERROR_STOP=1 2>&1 
}
expect_value "app_login is not superuser and does not bypass RLS" "false|false" \
  "SELECT rolsuper || '|' || rolbypassrls FROM pg_roles WHERE rolname='app_login'"
[ "$(rls1 '' '' 'SELECT count(*) FROM users')" = "0" ] && ok "no identity: 0 users visible (deny by default)" || bad "no identity users" "$(rls1 '' '' 'SELECT count(*) FROM users')"
[ "$(rls1 00000000-0000-4000-8000-000000000a20 customer 'SELECT count(*) FROM users')" = "1" ] && ok "customer sees only own user row" || bad "customer scope"
[ "$(rls1 00000000-0000-4000-8000-000000000a20 support 'SELECT count(*) FROM users')" -ge 2 ] && ok "support sees all users" || bad "support scope"
[ "$(rls1 00000000-0000-4000-8000-000000000a20 customer 'SELECT count(*) FROM audit_log')" = "0" ] && ok "customer sees no audit_log rows" || bad "audit_log rls"
[ "$(rls1 00000000-0000-4000-8000-000000000a20 customer 'SELECT count(*) FROM ledger_accounts')" = "0" ] && ok "customer sees no platform ledger accounts" || bad "ledger rls"
OUT="$(rls 00000000-0000-4000-8000-000000000a20 customer 'UPDATE postings SET amount = 1')"
printf '%s' "$OUT" | grep -qi "permission denied" && ok "app_user cannot UPDATE postings (no grant)" || bad "postings grant"
[ "$(rls1 00000000-0000-4000-8000-000000000a20 customer 'SELECT count(*) FROM ledger_account_types')" = "17" ] && ok "app_user can read ledger_account_types" || bad "types grant"
OUT="$(rls 00000000-0000-4000-8000-000000000a20 customer "INSERT INTO ledger_accounts (type, owner_type, currency) VALUES ('psp_clearing','platform','EGP')")"
printf '%s' "$OUT" | grep -qi "row-level security" && ok "customer cannot insert ledger accounts (RLS WITH CHECK)" || bad "ledger insert rls"

echo "== concurrency and cross-module races (node-postgres Pool, real connections) =="
if command -v node >/dev/null 2>&1 && [ -f "$ROOT/apps/api/package.json" ] && [ "${SKIP_NODE_CHECKS:-0}" != "1" ]; then
  NODE_OUT="$(PGPORT_X="$PORT" API_PKG="$ROOT/apps/api/package.json" node "$ROOT/tooling/db/pg16-verify.mjs" 2>&1)"; NODE_RC=$?
  printf '%s\n' "$NODE_OUT"
  NP="$(printf '%s\n' "$NODE_OUT" | grep -c '^PASS')"; NF="$(printf '%s\n' "$NODE_OUT" | grep -c '^FAIL')"
  PASS=$((PASS + NP)); FAIL=$((FAIL + NF))
  [ "$NODE_RC" -ne 0 ] && [ "$NF" -eq 0 ] && bad "node checks exited $NODE_RC without a FAIL line"
else
  echo "skipped (node or apps/api missing, or SKIP_NODE_CHECKS=1)"
fi

echo
echo "migrations applied: $(PA -c 'SELECT count(*) FROM schema_migrations') (files present: $(ls "$MIGRATIONS"/*.sql | wc -l | tr -d ' '), last: $(PA -c 'SELECT max(name) FROM schema_migrations'))"
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
