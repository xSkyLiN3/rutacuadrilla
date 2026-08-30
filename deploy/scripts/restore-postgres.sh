#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
readonly COMPOSE_FILE="${PROJECT_DIR}/deploy/compose.vps.yml"
readonly COMPOSE_ENV_FILE="${PROJECT_DIR}/deploy/.env"
readonly DATABASE_NAME="rutacuadrilla"
readonly DATABASE_USER="rutacuadrilla"

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

if [[ $# -ne 1 ]]; then
  fail "Uso: bash deploy/scripts/restore-postgres.sh /ruta/absoluta/rutacuadrilla-AAAAMMDDTHHMMSSZ.dump"
fi

[[ -f "${COMPOSE_FILE}" ]] || fail "No existe deploy/compose.vps.yml"
[[ -f "${COMPOSE_ENV_FILE}" ]] || fail "No existe deploy/.env"
command -v docker >/dev/null 2>&1 || fail "Docker no está disponible"
command -v flock >/dev/null 2>&1 || fail "flock no está disponible"
command -v realpath >/dev/null 2>&1 || fail "realpath no está disponible"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum no está disponible"

case "$1" in
  /*) ;;
  *) fail "La ruta del backup debe ser absoluta" ;;
esac
[[ -f "$1" && ! -L "$1" ]] || fail "El backup debe existir y no ser un enlace simbólico"
[[ -f "$1.sha256" && ! -L "$1.sha256" ]] || fail "Falta el SHA-256 contiguo o es un enlace simbólico"
readonly ARCHIVE_PATH="$(realpath -- "$1")"
readonly ARCHIVE_DIR="$(dirname -- "${ARCHIVE_PATH}")"
readonly ARCHIVE_NAME="$(basename -- "${ARCHIVE_PATH}")"
readonly CHECKSUM_PATH="${ARCHIVE_PATH}.sha256"
[[ "${ARCHIVE_DIR}" != "/" ]] || fail "La raíz no puede ser el directorio de restauración"
[[ "${ARCHIVE_NAME}" =~ ^rutacuadrilla-[0-9]{8}T[0-9]{6}Z\.dump$ ]] || fail "Nombre de backup inválido"

read -r expected_checksum checksum_name extra_checksum_field <"${CHECKSUM_PATH}"
[[ -z "${extra_checksum_field:-}" ]] || fail "El archivo SHA-256 tiene contenido inesperado"
[[ "${expected_checksum}" =~ ^[0-9a-f]{64}$ ]] || fail "El SHA-256 esperado no es válido"
[[ "${checksum_name}" == "${ARCHIVE_NAME}" ]] || fail "El SHA-256 no corresponde a este backup"
actual_checksum="$(sha256sum -- "${ARCHIVE_PATH}" | awk '{print $1}')"
[[ "${actual_checksum}" == "${expected_checksum}" ]] || fail "El backup no coincide con su SHA-256"

exec 9<"${COMPOSE_FILE}"
flock -n 9 || fail "Ya hay una operación PostgreSQL en curso"

compose=(
  docker compose
  --env-file "${COMPOSE_ENV_FILE}"
  -f "${COMPOSE_FILE}"
)
"${compose[@]}" config --quiet
"${compose[@]}" exec -T db pg_isready \
  --username "${DATABASE_USER}" \
  --dbname "${DATABASE_NAME}" >/dev/null || fail "PostgreSQL no está disponible"
"${compose[@]}" exec -T db pg_restore --list <"${ARCHIVE_PATH}" >/dev/null

readonly STAMP="$(date -u +%Y%m%d_%H%M%S)"
readonly CANDIDATE_DATABASE="rutacuadrilla_restore_${STAMP}"
readonly PREVIOUS_DATABASE="rutacuadrilla_pre_restore_${STAMP}"
readonly FAILED_DATABASE="rutacuadrilla_failed_restore_${STAMP}"

database_exists() {
  local database_name="$1"
  [[ "$("${compose[@]}" exec -T db psql \
    --username "${DATABASE_USER}" \
    --dbname postgres \
    --tuples-only \
    --no-align \
    --command "SELECT 1 FROM pg_database WHERE datname = '${database_name}'")" == "1" ]]
}

terminate_connections() {
  local database_name="$1"
  "${compose[@]}" exec -T db psql \
    --username "${DATABASE_USER}" \
    --dbname postgres \
    --set ON_ERROR_STOP=1 \
    --command "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database_name}' AND pid <> pg_backend_pid()" >/dev/null
}

rename_database() {
  local source_name="$1"
  local destination_name="$2"
  "${compose[@]}" exec -T db psql \
    --username "${DATABASE_USER}" \
    --dbname postgres \
    --set ON_ERROR_STOP=1 \
    --command "ALTER DATABASE ${source_name} RENAME TO ${destination_name}" >/dev/null
}

api_was_running=0
if "${compose[@]}" ps --status running --services | grep -Fxq api; then
  api_was_running=1
fi
candidate_created=0
api_paused=0
swap_completed=0

cleanup() {
  local status=$?
  trap - EXIT
  if [[ ${status} -ne 0 && ${candidate_created} -eq 1 && ${swap_completed} -eq 0 ]]; then
    terminate_connections "${CANDIDATE_DATABASE}" || true
    "${compose[@]}" exec -T db dropdb \
      --username "${DATABASE_USER}" \
      --if-exists "${CANDIDATE_DATABASE}" >/dev/null || true
  fi
  if [[ ${api_was_running} -eq 1 && ${api_paused} -eq 1 ]]; then
    "${compose[@]}" up -d --no-deps api >/dev/null || true
  fi
  exit "${status}"
}
trap cleanup EXIT

for database_name in "${CANDIDATE_DATABASE}" "${PREVIOUS_DATABASE}" "${FAILED_DATABASE}"; do
  if database_exists "${database_name}"; then
    fail "Ya existe la base temporal ${database_name}"
  fi
done

"${compose[@]}" exec -T db createdb \
  --username "${DATABASE_USER}" \
  --template template0 \
  --encoding UTF8 \
  "${CANDIDATE_DATABASE}"
candidate_created=1

"${compose[@]}" exec -T db pg_restore \
  --username "${DATABASE_USER}" \
  --dbname "${CANDIDATE_DATABASE}" \
  --exit-on-error \
  --single-transaction \
  --no-owner \
  --no-privileges <"${ARCHIVE_PATH}"

migration_ready="$("${compose[@]}" exec -T db psql \
  --username "${DATABASE_USER}" \
  --dbname "${CANDIDATE_DATABASE}" \
  --tuples-only \
  --no-align \
  --set ON_ERROR_STOP=1 \
  --command "SELECT count(*) FROM schema_migration WHERE name = '011_initial_provision_lock.sql'")"
[[ "${migration_ready}" == "1" ]] || fail "La base candidata no contiene la migración requerida"

if [[ ${api_was_running} -eq 1 ]]; then
  "${compose[@]}" stop api >/dev/null
  api_paused=1
fi
terminate_connections "${DATABASE_NAME}"
terminate_connections "${CANDIDATE_DATABASE}"
rename_database "${DATABASE_NAME}" "${PREVIOUS_DATABASE}"
if ! rename_database "${CANDIDATE_DATABASE}" "${DATABASE_NAME}"; then
  rename_database "${PREVIOUS_DATABASE}" "${DATABASE_NAME}"
  fail "No se pudo activar la base candidata; la base original fue repuesta"
fi
candidate_created=0
swap_completed=1

if [[ ${api_was_running} -eq 1 ]]; then
  api_ready=0
  if "${compose[@]}" up -d --no-deps api >/dev/null; then
    for ((attempt = 1; attempt <= 60; attempt += 1)); do
      if "${compose[@]}" exec -T api node -e \
        "fetch('http://127.0.0.1:4310/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" \
        >/dev/null 2>&1; then
        api_ready=1
        break
      fi
      sleep 2
    done
  fi

  if [[ ${api_ready} -ne 1 ]]; then
    "${compose[@]}" stop api >/dev/null || true
    api_paused=1
    terminate_connections "${DATABASE_NAME}"
    terminate_connections "${PREVIOUS_DATABASE}"
    rename_database "${DATABASE_NAME}" "${FAILED_DATABASE}"
    if ! rename_database "${PREVIOUS_DATABASE}" "${DATABASE_NAME}"; then
      rename_database "${FAILED_DATABASE}" "${DATABASE_NAME}" || true
      fail "La API falló y tampoco fue posible reponer automáticamente la base anterior"
    fi
    swap_completed=0
    if "${compose[@]}" up -d --no-deps api >/dev/null; then
      api_paused=0
    fi
    fail "La API no quedó lista; se repuso la base anterior y se preservó la restauración fallida"
  fi
  api_paused=0
fi

printf 'Restauración PostgreSQL activada desde: %s\n' "${ARCHIVE_PATH}"
printf 'Base anterior preservada como: %s\n' "${PREVIOUS_DATABASE}"
