#!/usr/bin/env bash
# Provision N overflow mail D1 databases at once.
#
#   ./scripts/provision-overflow.sh --count 5
#
# For each one it will:
#   1. wrangler d1 create orange-inbox-mail-<n>      (skipped if it exists)
#   2. apply db/mail-plane-bootstrap.sql to it       (idempotent — fails if
#                                                     tables already exist,
#                                                     so we use IF NOT EXISTS
#                                                     in practice via a probe
#                                                     before applying)
#   3. add the binding to web/wrangler.jsonc and email-worker/wrangler.jsonc
#   4. INSERT a row in the primary DB's mail_dbs table
#
# After all DBs are provisioned, run `npm run deploy` from web/ AND
# `wrangler deploy` from email-worker/ to pick up the new bindings — without
# the redeploy the runtime won't know about env.<binding> and writes will
# fail. The script reminds you at the end.
#
# Notes:
#  - Default soft / hard caps mirror the primary's: 8 GiB / 9.5 GiB.
#    Override with --soft-gb and --hard-gb if you want different caps.
#  - The script never deletes anything. Re-running with the same count is
#    a no-op; pass a higher --count to add more.
#  - Numbering picks up where the existing overflow set ends, so running
#    --count 3 twice gives you 6 overflow DBs total (1..6), not 1..3 twice.

set -euo pipefail

COUNT=1
SOFT_GB=8
HARD_GB=9.5

while [[ $# -gt 0 ]]; do
  case "$1" in
    --count) COUNT="$2"; shift 2 ;;
    --soft-gb) SOFT_GB="$2"; shift 2 ;;
    --hard-gb) HARD_GB="$2"; shift 2 ;;
    -h|--help)
      sed -n '1,30p' "$0"
      exit 0 ;;
    *) echo "unknown flag: $1"; exit 2 ;;
  esac
done

if ! [[ "$COUNT" =~ ^[0-9]+$ ]] || [[ "$COUNT" -lt 1 ]]; then
  echo "--count must be a positive integer"; exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_WRANGLER="$REPO_ROOT/web/wrangler.jsonc"
EMAIL_WRANGLER="$REPO_ROOT/email-worker/wrangler.jsonc"
BOOTSTRAP_SQL="$REPO_ROOT/db/mail-plane-bootstrap.sql"

# soft / hard cap in bytes (POSIX bash floats are awkward — use awk).
soft_bytes=$(awk -v g="$SOFT_GB" 'BEGIN{printf "%.0f", g*1024*1024*1024}')
hard_bytes=$(awk -v g="$HARD_GB" 'BEGIN{printf "%.0f", g*1024*1024*1024}')

# Find the highest existing overflow number so --count can be re-run safely.
existing=$(grep -oE 'orange-inbox-mail-[0-9]+' "$WEB_WRANGLER" 2>/dev/null \
            | sed 's/.*-//' | sort -n | tail -1)
start=$(( ${existing:-0} + 1 ))
end=$(( start + COUNT - 1 ))

echo "Provisioning overflow DBs $start..$end (soft=${SOFT_GB}GiB hard=${HARD_GB}GiB)"

for i in $(seq "$start" "$end"); do
  name="orange-inbox-mail-$i"
  binding="MAIL_DB_$i"
  echo
  echo "── #$i  name=$name  binding=env.$binding"

  # 1. Create the D1 (or read existing).
  echo "   wrangler d1 create $name"
  if ! create_out=$(npx wrangler d1 create "$name" 2>&1); then
    if echo "$create_out" | grep -q "already exists"; then
      echo "   → already exists, reusing"
    else
      echo "$create_out" >&2
      exit 1
    fi
  else
    echo "$create_out"
  fi

  # 2. Pull the database_id back out of `wrangler d1 list`.
  db_id=$(npx wrangler d1 list --json 2>/dev/null \
           | grep -A2 "\"name\": \"$name\"" \
           | grep -oE '"uuid"[^,]+' | head -1 | sed 's/.*"\([0-9a-f-]\{36\}\)".*/\1/')
  if [[ -z "$db_id" ]]; then
    echo "could not resolve database_id for $name"; exit 1
  fi
  echo "   database_id=$db_id"

  # 3. Apply mail-plane bootstrap. Idempotency probe: skip if `messages`
  #    table is already there.
  has_messages=$(npx wrangler d1 execute "$name" --remote \
    --command "SELECT name FROM sqlite_master WHERE name = 'messages'" --json 2>/dev/null \
    | grep -c '"messages"' || true)
  if [[ "$has_messages" -gt 0 ]]; then
    echo "   bootstrap already applied, skipping"
  else
    echo "   applying $BOOTSTRAP_SQL"
    npx wrangler d1 execute "$name" --remote --file "$BOOTSTRAP_SQL"
  fi

  # 4. Patch wrangler.jsonc — append a new binding to web AND email-worker.
  patch_wrangler() {
    local file="$1"
    if grep -q "\"binding\": \"$binding\"" "$file"; then
      echo "   binding already present in $(basename "$file")"
      return
    fi
    # Insert a new entry into the d1_databases array, just before its closing ].
    local snippet="    {\n      \"binding\": \"$binding\",\n      \"database_name\": \"$name\",\n      \"database_id\": \"$db_id\",\n      \"migrations_dir\": \"../db/migrations\"\n    }"
    # Find the line containing the closing `]` of the d1_databases block by
    # scanning for the marker comment we add below the array. We use awk so
    # we don't depend on jq for jsonc.
    awk -v snip="$snippet" '
      BEGIN { in_d1 = 0; depth = 0 }
      /\"d1_databases\"\s*:\s*\[/ { in_d1 = 1 }
      {
        if (in_d1 && /\]/) {
          # Print the snippet (with leading comma if this isn't the first entry).
          gsub(/[ \t]+$/, "", prev)
          if (prev ~ /\}\s*$/) { sub(/\}\s*$/, "},", prev) }
          if (prev != "") print prev
          print snip
          prev = $0
          in_d1 = 0
          next
        }
        if (prev != "") print prev
        prev = $0
      }
      END { if (prev != "") print prev }
    ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
    echo "   patched $(basename "$file")"
  }
  patch_wrangler "$WEB_WRANGLER"
  patch_wrangler "$EMAIL_WRANGLER"

  # 5. Register in the primary DB's mail_dbs table.
  display="Overflow $i"
  echo "   INSERT INTO mail_dbs ('mail_$i', '$binding', '$display', $soft_bytes, $hard_bytes)"
  npx wrangler d1 execute orange-inbox --remote --command "$(cat <<EOF
INSERT INTO mail_dbs (id, binding_name, display_name, soft_max_bytes, hard_max_bytes, active)
VALUES ('mail_$i', '$binding', '$display', $soft_bytes, $hard_bytes, 1)
ON CONFLICT (id) DO NOTHING;
EOF
)"

done

cat <<MSG

✅ Provisioned $COUNT overflow DB(s).

Next steps (REQUIRED — bindings won't take effect until you redeploy):
   cd web         && npm run deploy
   cd ../email-worker && npx wrangler deploy

The capacity bar in the sidebar will pick up the new DBs on the next refresh.
Until you redeploy, writes that would route to env.$binding will fail with
"wrangler binding env.$binding is not configured".
MSG
