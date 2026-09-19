#!/usr/bin/env bash
# Back up the source-built Compose deployment without exposing DB credentials.
set -euo pipefail
umask 077

usage() {
  cat <<'EOF'
Usage: backup-postgres.sh --backup-dir /absolute/directory [--deploy-dir /absolute/deploy]

Creates a PostgreSQL custom-format .dump archive with mode 600. The default
deployment directory is the repository's deploy/. Existing archives are never
overwritten. Only a complete, readable archive is published; stdout prints its
absolute path. No database is restored or modified by this command.
EOF
}

fail() { printf 'Backup failed: %s\n' "$*" >&2; exit 1; }
backup_dir=''
deploy_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../deploy" && pwd -P)"
while (($#)); do
  case "$1" in
    --backup-dir|--deploy-dir)
      if (($# < 2)) || [[ -z "$2" ]]; then usage >&2; exit 2; fi
      if [[ "$1" == --backup-dir ]]; then backup_dir="$2"; else deploy_dir="$2"; fi
      shift 2
      ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done
for directory in "$backup_dir" "$deploy_dir"; do
  [[ "$directory" == /* && "$directory" != *$'\n'* && "$directory" != *$'\r'* ]] ||
    fail 'Both directories must be absolute paths without line breaks.'
done
[[ -f "$deploy_dir/docker-compose.yml" ]] || fail 'The deployment has no docker-compose.yml.'
command -v docker >/dev/null || fail 'Docker Compose is required.'
deploy_dir="$(cd -- "$deploy_dir" && pwd -P)"
mkdir -p -- "$backup_dir"
backup_dir="$(cd -- "$backup_dir" && pwd -P)"
compose=(docker compose --project-directory "$deploy_dir" --file "$deploy_dir/docker-compose.yml")
temporary=''
cleanup() {
  if [[ -n "$temporary" ]]; then rm -f -- "$temporary"; fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

temporary="$(mktemp "$backup_dir/.subly-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
chmod 600 "$temporary"
# Custom format includes PostgreSQL compression; no pipeline can hide pg_dump's
# exit status. The tools run in the DB container and match its PostgreSQL version.
if ! "${compose[@]}" exec -T postgres pg_dump --username=postgres --dbname=subly \
  --format=custom --no-owner --no-privileges > "$temporary"; then
  fail 'pg_dump did not complete. No archive was published.'
fi
[[ -s "$temporary" ]] || fail 'pg_dump returned an empty archive.'
# Read every archive section into a SQL output sink. This checks the archive,
# including compressed data, without connecting to or modifying any database.
if ! "${compose[@]}" exec -T postgres pg_restore --no-owner --no-privileges \
  --file=/dev/null < "$temporary"; then
  fail 'pg_restore could not read the archive. No archive was published.'
fi
backup_name="${temporary##*/}"
final_path="$backup_dir/${backup_name#.}.dump"
# Same-directory hard linking publishes atomically and refuses an existing name.
# Keep backups on a filesystem that supports regular-file hard links.
ln -- "$temporary" "$final_path"
rm -- "$temporary"
temporary=''
printf '%s\n' "$final_path"
