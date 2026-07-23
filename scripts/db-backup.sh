#!/usr/bin/env bash
#
# db-backup.sh — PostgreSQL dump/restore over SFTP for the whisky-scrapper API.
#
# Subcommands:
#   backup            Dump the database, upload the dump to SFTP, prune old ones.
#                     This is the cron entry point.
#   restore <file>    Download <file> from SFTP, wipe the target database, and
#                     restore the dump into it.
#   list              List the dumps currently stored on SFTP (newest first).
#   prune             Apply the MAX_BACKUPS retention policy right now.
#
# Safety: --safe is the DEFAULT. In safe mode new data is written (dump +
# upload) but nothing is ever deleted or dropped — the destructive steps are
# only printed. Pass --safe=false to actually prune old dumps and, on restore,
# drop and recreate the target database.
#
# Configuration is read from a Bash config file (see db-backup.env.example);
# the default location is db-backup.env next to this script, overridable with
# `--config <path>` or the BACKUP_CONFIG environment variable.
#
# The script only shells out to the standard client tools — pg_dump, pg_restore,
# psql and OpenSSH's sftp — so it has no Node.js/pnpm dependency and runs
# cleanly from system cron. SFTP authentication is expected to be by SSH key,
# configured in ~/.ssh/config for the host in SFTP_TARGET.

set -euo pipefail

# --------------------------------------------------------------------------- #
# Paths and logging
# --------------------------------------------------------------------------- #

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# BE_DIR is exported so the config file can reuse the repo's .env, e.g.:
#   set -a; . "$BE_DIR/.env"; set +a
BE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
export SCRIPT_DIR BE_DIR

# All diagnostics go to stderr so that stdout stays clean for machine-readable
# command output (e.g. the file list printed by `list`).
log()  { printf '%s [db-backup] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; }
warn() { log "WARN: $*"; }
die()  { log "ERROR: $*"; exit 1; }

# Fail early and clearly when a required external command is missing.
need() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found on PATH: $1"
}

# --------------------------------------------------------------------------- #
# Argument parsing
# --------------------------------------------------------------------------- #

CONFIG_PATH="${BACKUP_CONFIG:-}"
FORCE=0
SAFE=1   # safe (dry-run for anything destructive) is the default
COMMAND=""
POSITIONAL=()

usage() {
  cat <<'EOF'
db-backup.sh — PostgreSQL dump/restore over SFTP.

Usage: db-backup.sh <command> [options]

Commands:
  backup            Dump the DB, upload it to SFTP, then prune old dumps.
  restore <file>    Download <file>, recreate the DB, and restore it.
  list              List stored dumps, newest first.
  prune             Apply the MAX_BACKUPS retention policy.

Options:
  --safe            Safe mode (DEFAULT): write new data but NEVER delete or
                    drop anything — destructive steps are only printed.
  --safe=false      Live mode: actually delete old dumps / drop & recreate the DB.
  --yes, --force    Skip the restore confirmation prompt (live mode only).
  --config <path>   Config file (default: db-backup.env beside this script,
                    or $BACKUP_CONFIG).
  -h, --help        Show this help.

SFTP auth is by SSH key (~/.ssh/config). See db-backup.env.example for config.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    backup|restore|list|prune)
      COMMAND="$1"
      ;;
    --config)
      shift || die "--config requires a path"
      CONFIG_PATH="$1"
      ;;
    --config=*)
      CONFIG_PATH="${1#*=}"
      ;;
    -y|--yes|--force)
      FORCE=1
      ;;
    --safe|--safe=true)
      SAFE=1
      ;;
    --safe=false)
      SAFE=0
      ;;
    --safe=*)
      die "invalid --safe value: '${1#*=}' (use --safe or --safe=false)"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while [ "$#" -gt 0 ]; do POSITIONAL+=("$1"); shift; done
      break
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      POSITIONAL+=("$1")
      ;;
  esac
  shift
done

[ -n "$COMMAND" ] || { usage; exit 1; }

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

# Default config file sits beside this script.
[ -n "$CONFIG_PATH" ] || CONFIG_PATH="$SCRIPT_DIR/db-backup.env"

if [ -f "$CONFIG_PATH" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG_PATH"
  log "loaded config: $CONFIG_PATH"
else
  warn "config file not found: $CONFIG_PATH (relying on the environment)"
fi

# Optional settings with sensible defaults.
: "${DB_HOST:=localhost}"
: "${DB_PORT:=5432}"
: "${MAX_BACKUPS:=14}"
: "${BACKUP_PREFIX:=${DB_NAME:-backup}}"
: "${SFTP_PORT:=}"
: "${PGDUMP_BIN:=pg_dump}"
: "${PGRESTORE_BIN:=pg_restore}"
: "${PSQL_BIN:=psql}"
# Restore recreates the whole database, which requires connecting to a separate
# maintenance database as a role allowed to DROP/CREATE it. Both default to the
# main credentials (the compose bootstrap DB_USER is a superuser).
: "${DB_MAINT:=postgres}"
: "${ADMIN_USER:=${DB_USER:-}}"
: "${ADMIN_PASS:=${DB_PASS:-}}"

# Required settings — fail before doing any work if they are missing.
require_config() {
  local missing=()
  local name
  for name in "$@"; do
    [ -n "${!name:-}" ] || missing+=("$name")
  done
  [ "${#missing[@]}" -eq 0 ] || die "missing required config: ${missing[*]}"
}

require_config SFTP_TARGET REMOTE_DIR DB_NAME DB_USER DB_PASS

# Whitelist every value that ends up inside an sftp command or an SQL statement.
# Restricting them to known-safe characters means a stray space, glob
# metacharacter (* ? [ ]), quote, semicolon or newline in the config can never
# widen a deletion (sftp still globs its `rm`/`ls` arguments even when quoted)
# nor inject SQL into the DROP/CREATE — regardless of how sftp or psql happen to
# quote things. This is the primary guard; the quoting downstream is secondary.
RE_DBID='^[A-Za-z0-9_-]+$'        # database / role names (also quoted in SQL)
RE_NAME='^[A-Za-z0-9._-]+$'       # file name / prefix (no slash, no glob)
RE_PATH='^[A-Za-z0-9._/-]+$'      # remote directory (no space, no glob)
RE_TARGET='^[A-Za-z0-9._@:-]+$'   # user@host or a ~/.ssh/config alias

check_value() {
  local value="$1" pattern="$2" label="$3"
  case "$value" in
    *[[:cntrl:]]*) die "unsafe $label: contains a control character or newline" ;;
  esac
  [[ "$value" =~ $pattern ]] \
    || die "unsafe $label: >>>$value<<< — allowed pattern is $pattern"
}

check_value "$SFTP_TARGET"   "$RE_TARGET" "SFTP_TARGET"
check_value "$REMOTE_DIR"    "$RE_PATH"   "REMOTE_DIR"
check_value "$BACKUP_PREFIX" "$RE_NAME"   "BACKUP_PREFIX"
check_value "$DB_NAME"       "$RE_DBID"   "DB_NAME"
check_value "$DB_USER"       "$RE_DBID"   "DB_USER"
check_value "$DB_MAINT"      "$RE_DBID"   "DB_MAINT"
check_value "$ADMIN_USER"    "$RE_DBID"   "ADMIN_USER"

if [ -n "$SFTP_PORT" ]; then
  case "$SFTP_PORT" in
    ''|*[!0-9]*) die "SFTP_PORT must be numeric, got: $SFTP_PORT" ;;
  esac
fi

case "$MAX_BACKUPS" in
  ''|*[!0-9]*) die "MAX_BACKUPS must be a positive integer, got: $MAX_BACKUPS" ;;
esac
# Refuse 0: after a backup, prune would delete every dump — including the one
# just uploaded — leaving no backups at all.
[ "$MAX_BACKUPS" -ge 1 ] || die "MAX_BACKUPS must be at least 1, got: $MAX_BACKUPS"

# Strip trailing slashes so "<dir>/<file>" is never built as "<dir>//<file>".
while [ "$REMOTE_DIR" != "${REMOTE_DIR%/}" ]; do
  REMOTE_DIR="${REMOTE_DIR%/}"
done
[ -n "$REMOTE_DIR" ] || die "REMOTE_DIR must not be empty or only slashes"

# --------------------------------------------------------------------------- #
# Postgres helpers
# --------------------------------------------------------------------------- #

# Each wrapper passes the password through the environment (PGPASSWORD) so it
# never appears in the process argument list. The binaries are overridable so
# they can point at a version-matched path (e.g. /usr/lib/postgresql/18/bin).
run_pg_dump() {
  PGPASSWORD="$DB_PASS" "$PGDUMP_BIN" -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$@"
}

run_pg_restore() {
  PGPASSWORD="$DB_PASS" "$PGRESTORE_BIN" -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$@"
}

# psql against the maintenance database as the admin role — used to terminate
# connections to the target database and to drop/recreate it during restore.
run_psql_admin() {
  PGPASSWORD="$ADMIN_PASS" "$PSQL_BIN" \
    -h "$DB_HOST" -p "$DB_PORT" -U "$ADMIN_USER" -d "$DB_MAINT" "$@"
}

# --------------------------------------------------------------------------- #
# SFTP helpers
# --------------------------------------------------------------------------- #

# Run a batch of sftp commands supplied on stdin. `-q` suppresses the banner and
# command echo; auth/host/port come from ~/.ssh/config (SFTP_PORT overrides).
sftp_conn() {
  if [ -n "$SFTP_PORT" ]; then
    sftp -q -P "$SFTP_PORT" -b - "$SFTP_TARGET"
  else
    sftp -q -b - "$SFTP_TARGET"
  fi
}

# Best-effort recursive mkdir of the remote directory. Every component is
# created with a leading `-` so sftp ignores "already exists" errors.
sftp_mkdir_p() {
  local dir="$1"
  local -a parts
  local acc="" comp batch=""
  IFS='/' read -ra parts <<< "$dir"
  for comp in "${parts[@]}"; do
    [ -z "$comp" ] && continue
    if [ -z "$acc" ]; then
      case "$dir" in
        /*) acc="/$comp" ;;
        *)  acc="$comp" ;;
      esac
    else
      acc="$acc/$comp"
    fi
    batch+="-mkdir \"$acc\""$'\n'
  done
  [ -n "$batch" ] && printf '%s' "$batch" | sftp_conn >/dev/null 2>&1 || true
}

# Print the basenames of stored dumps (unsorted, one per line). Lines that are
# not `<prefix>_*.dump` — the sftp banner, command echoes, errors — are dropped,
# so an empty or missing directory simply yields no output.
remote_list() {
  local raw line base
  raw="$(printf 'ls -1 "%s"\n' "$REMOTE_DIR" | sftp_conn 2>/dev/null || true)"
  printf '%s\n' "$raw" | while IFS= read -r line; do
    line="${line%$'\r'}"
    [ -z "$line" ] && continue
    base="$(basename "$line")"
    case "$base" in
      "${BACKUP_PREFIX}_"*.dump)
        # Surface only names built from safe characters, so a maliciously named
        # remote file (containing a space, quote or glob metacharacter) can
        # never reach a later `rm` and widen the deletion.
        if [[ "$base" =~ $RE_NAME ]]; then
          printf '%s\n' "$base"
        fi
        ;;
    esac
  done
}

# --------------------------------------------------------------------------- #
# Working directory (local scratch for the dump/download), auto-cleaned
# --------------------------------------------------------------------------- #

WORK_DIR=""
# Preserve the pending exit status: the EXIT trap's last command would
# otherwise become the script's exit code (e.g. a successful `rm` masking a
# failure, or an empty-WORK_DIR test returning 1 on an otherwise clean run).
cleanup() {
  local ec=$?
  [ -n "$WORK_DIR" ] && rm -rf "$WORK_DIR"
  return "$ec"
}
trap cleanup EXIT
make_workdir() { WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/db-backup.XXXXXX")"; }

# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #

# Delete the oldest dumps beyond MAX_BACKUPS. Deletions are best-effort (`-rm`)
# so a vanished/locked file never fails an otherwise-successful backup run.
cmd_prune() {
  need sftp
  local -a all=() doomed=()
  local line
  while IFS= read -r line; do
    [ -n "$line" ] && all+=("$line")
  done < <(remote_list | sort)

  local total="${#all[@]}"
  if [ "$total" -le "$MAX_BACKUPS" ]; then
    log "retention: $total/$MAX_BACKUPS kept, nothing to prune"
    return 0
  fi

  local drop=$((total - MAX_BACKUPS)) i
  for ((i = 0; i < drop; i++)); do
    doomed+=("${all[i]}")
  done

  local batch="" issued=0
  for line in "${doomed[@]}"; do
    # Re-assert safety at the point of deletion (remote_list already filters,
    # but never build an `rm` from anything outside the safe charset).
    if ! [[ "$line" =~ $RE_NAME ]]; then
      warn "skipping unsafe backup name: $line"
      continue
    fi
    if [ "$SAFE" -eq 1 ]; then
      log "[safe] would delete: $REMOTE_DIR/$line"
    else
      log "pruning old backup: $line"
      batch+="-rm \"$REMOTE_DIR/$line\""$'\n'
    fi
    issued=$((issued + 1))
  done

  if [ "$SAFE" -eq 1 ]; then
    log "[safe] retention: $total present, would keep $MAX_BACKUPS, would remove $issued (nothing deleted)"
    return 0
  fi
  if [ "$issued" -gt 0 ]; then
    printf '%s' "$batch" | sftp_conn >/dev/null 2>&1 || warn "prune reported errors"
  fi
  log "retention: kept $MAX_BACKUPS, removed $issued"
}

cmd_backup() {
  need "$PGDUMP_BIN"
  need "$PGRESTORE_BIN"
  need sftp
  make_workdir

  local stamp file local_path
  stamp="$(date -u '+%Y%m%d_%H%M%SZ')"
  file="${BACKUP_PREFIX}_${stamp}.dump"
  local_path="$WORK_DIR/$file"

  log "dumping database \"$DB_NAME\" from $DB_HOST:$DB_PORT ..."
  # -Fc: compressed custom format, restorable object-by-object via pg_restore.
  run_pg_dump -d "$DB_NAME" -Fc -f "$local_path"

  [ -s "$local_path" ] || die "dump is empty: $local_path"
  # Validate the archive locally before trusting/uploading it.
  run_pg_restore --list "$local_path" >/dev/null 2>&1 \
    || die "produced dump is not a valid pg_restore archive"
  log "dump OK: $file ($(du -h "$local_path" | cut -f1))"

  sftp_mkdir_p "$REMOTE_DIR"

  # Upload to a temporary name, then rename into place — a crash mid-transfer
  # leaves a `.partial` file that never looks like a finished backup.
  log "uploading to $SFTP_TARGET:$REMOTE_DIR/ ..."
  sftp_conn <<EOF
put "$local_path" "$REMOTE_DIR/$file.partial"
rename "$REMOTE_DIR/$file.partial" "$REMOTE_DIR/$file"
EOF
  log "upload complete: $REMOTE_DIR/$file"

  cmd_prune
  log "backup finished"
}

cmd_list() {
  need sftp
  local files
  files="$(remote_list | sort -r)"
  if [ -z "$files" ]; then
    log "no backups found in $REMOTE_DIR"
    return 0
  fi
  printf '%s\n' "$files"
}

cmd_restore() {
  need "$PGRESTORE_BIN"
  need "$PSQL_BIN"
  need sftp

  local file="${POSITIONAL[0]:-}"
  [ -n "$file" ] || die "restore requires a backup file name (see \`$0 list\`)"
  # Accept only a bare, safe file name — never a path or anything with a glob
  # metacharacter (sftp `get` globs too) or shell/SQL-hostile character.
  [ "$file" = "$(basename "$file")" ] || die "pass just the file name, not a path: $file"
  check_value "$file" "$RE_NAME" "restore file name"

  # Never recreate a system database, and make sure the target is not the very
  # database we connect to for the DROP/CREATE (a database cannot drop itself).
  case "$DB_NAME" in
    template0|template1) die "refusing to recreate the system database \"$DB_NAME\"" ;;
  esac
  [ "$DB_NAME" != "$DB_MAINT" ] \
    || die "DB_NAME equals DB_MAINT (\"$DB_NAME\"); set DB_MAINT to a different database"

  make_workdir
  local local_path="$WORK_DIR/$file"

  log "downloading $file ..."
  sftp_conn <<EOF
get "$REMOTE_DIR/$file" "$local_path"
EOF
  [ -s "$local_path" ] || die "downloaded file is empty or missing: $file"

  # Validate the archive BEFORE touching the database, so a corrupt or wrong
  # file can never destroy the current data.
  run_pg_restore --list "$local_path" >/dev/null 2>&1 \
    || die "not a valid pg_restore archive: $file"

  # The destructive statements, defined once so the safe-mode preview shows
  # exactly what the live run would execute.
  local term_sql="SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB_NAME' AND pid <> pg_backend_pid();"
  local drop_sql="DROP DATABASE IF EXISTS \"$DB_NAME\";"
  local create_sql="CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_USER\";"

  # Safe mode (default): the dump is already downloaded and validated; print the
  # commands the live run would execute and stop without changing anything.
  if [ "$SAFE" -eq 1 ]; then
    log "[safe] dump downloaded and validated; the database will NOT be changed."
    log "[safe] would connect to \"$DB_MAINT\" ($DB_HOST:$DB_PORT) as \"$ADMIN_USER\" and run:"
    log "[safe]   $term_sql"
    log "[safe]   $drop_sql"
    log "[safe]   $create_sql"
    log "[safe] would then restore \"$file\" into \"$DB_NAME\":"
    log "[safe]   pg_restore --no-owner --no-acl --single-transaction --exit-on-error -d \"$DB_NAME\""
    log "[safe] nothing changed. Re-run with --safe=false to execute the restore."
    return 0
  fi

  # --- live (destructive) path ---
  # Require explicit confirmation unless --yes was given. Confirmation is read
  # from the controlling terminal, so a non-interactive run (cron, redirected
  # stdin) cannot accidentally wipe the database — the read fails and aborts.
  if [ "$FORCE" -ne 1 ]; then
    warn "this will DROP AND RECREATE database \"$DB_NAME\" on $DB_HOST:$DB_PORT"
    warn "and restore it from \"$file\"."
    printf 'Type the database name (%s) to proceed: ' "$DB_NAME" >&2
    local reply=""
    if ! read -r reply < /dev/tty 2>/dev/null; then
      die "no terminal available for confirmation; re-run with --yes to allow the wipe"
    fi
    [ "$reply" = "$DB_NAME" ] || die "confirmation did not match; aborted"
  fi

  # Recreate the whole database, so nothing from the old contents (data,
  # objects, or default privileges) can survive. DROP/CREATE run against a
  # maintenance database because a database cannot be dropped while any session
  # — including this script — is connected to it. Terminate leftover sessions
  # first; the API should already be stopped (a live pool reconnects and would
  # block the drop).
  log "terminating open connections to \"$DB_NAME\" ..."
  run_psql_admin -v ON_ERROR_STOP=1 -q -tc "$term_sql" >/dev/null

  log "recreating database \"$DB_NAME\" (owner \"$DB_USER\") ..."
  run_psql_admin -v ON_ERROR_STOP=1 -q -c "$drop_sql"
  run_psql_admin -v ON_ERROR_STOP=1 -q -c "$create_sql"

  # Restore in a single transaction: on any error the whole thing rolls back,
  # leaving a clean empty database instead of a half-restored one.
  # --no-owner/--no-acl keep the restore portable across roles.
  log "restoring \"$file\" into \"$DB_NAME\" ..."
  run_pg_restore -d "$DB_NAME" --no-owner --no-acl --single-transaction \
    --exit-on-error "$local_path"

  log "restore finished"
}

# --------------------------------------------------------------------------- #
# Dispatch
# --------------------------------------------------------------------------- #

if [ "$SAFE" -eq 1 ]; then
  log "SAFE mode: data is written, but nothing is deleted or dropped."
  log "Pass --safe=false to actually prune dumps / recreate the database."
else
  log "LIVE mode (--safe=false): deletions and database drops are ENABLED."
fi

case "$COMMAND" in
  backup)  cmd_backup ;;
  restore) cmd_restore ;;
  list)    cmd_list ;;
  prune)   cmd_prune ;;
  *)       usage; exit 1 ;;
esac
