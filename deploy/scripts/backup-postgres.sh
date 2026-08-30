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
  fail "Uso: bash deploy/scripts/backup-postgres.sh /ruta/absoluta/a/backups"
fi

[[ -f "${COMPOSE_FILE}" ]] || fail "No existe deploy/compose.vps.yml"
[[ -f "${COMPOSE_ENV_FILE}" ]] || fail "No existe deploy/.env"
command -v docker >/dev/null 2>&1 || fail "Docker no está disponible"
command -v flock >/dev/null 2>&1 || fail "flock no está disponible"
command -v mktemp >/dev/null 2>&1 || fail "mktemp no está disponible"
command -v realpath >/dev/null 2>&1 || fail "realpath no está disponible"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum no está disponible"

case "$1" in
  /*) ;;
  *) fail "La ruta de backups debe ser absoluta" ;;
esac
[[ -d "$1" && ! -L "$1" ]] || fail "El directorio de backups debe existir y no ser un enlace simbólico"
readonly BACKUP_DIR="$(realpath -- "$1")"
[[ "${BACKUP_DIR}" != "/" ]] || fail "La raíz no puede ser el directorio de backups"
[[ -w "${BACKUP_DIR}" ]] || fail "El directorio de backups no es escribible"

# Backup y restauración comparten este bloqueo sin crear archivos dentro del repositorio.
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

readonly STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
readonly ARCHIVE_NAME="rutacuadrilla-${STAMP}.dump"
readonly ARCHIVE_PATH="${BACKUP_DIR}/${ARCHIVE_NAME}"
readonly CHECKSUM_PATH="${ARCHIVE_PATH}.sha256"
[[ ! -e "${ARCHIVE_PATH}" && ! -e "${CHECKSUM_PATH}" ]] || fail "Ya existe un backup con esta marca UTC"

umask 077
temporary_archive="$(mktemp -p "${BACKUP_DIR}" ".${ARCHIVE_NAME}.tmp.XXXXXX")"
temporary_checksum="$(mktemp -p "${BACKUP_DIR}" ".${ARCHIVE_NAME}.sha256.tmp.XXXXXX")"

cleanup() {
  local status=$?
  trap - EXIT
  [[ ! -e "${temporary_archive}" ]] || rm -f -- "${temporary_archive}"
  [[ ! -e "${temporary_checksum}" ]] || rm -f -- "${temporary_checksum}"
  exit "${status}"
}
trap cleanup EXIT

# pg_dump obtiene un snapshot transaccional consistente; no es necesario detener la API.
"${compose[@]}" exec -T db pg_dump \
  --username "${DATABASE_USER}" \
  --dbname "${DATABASE_NAME}" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges >"${temporary_archive}"

[[ -s "${temporary_archive}" ]] || fail "pg_dump produjo un archivo vacío"
"${compose[@]}" exec -T db pg_restore --list <"${temporary_archive}" >/dev/null

checksum="$(sha256sum -- "${temporary_archive}" | awk '{print $1}')"
[[ "${checksum}" =~ ^[0-9a-f]{64}$ ]] || fail "No se pudo calcular SHA-256"
printf '%s  %s\n' "${checksum}" "${ARCHIVE_NAME}" >"${temporary_checksum}"
chmod 600 -- "${temporary_archive}" "${temporary_checksum}"

mv -- "${temporary_archive}" "${ARCHIVE_PATH}"
mv -- "${temporary_checksum}" "${CHECKSUM_PATH}"

printf 'Backup PostgreSQL verificado: %s\n' "${ARCHIVE_PATH}"
printf 'SHA-256: %s\n' "${CHECKSUM_PATH}"
