# Secretos del despliegue VPS

Docker Compose monta los secretos con origen `file:` como **bind mounts** de los archivos del host.
No son secretos cifrados de Docker Swarm y Compose no traduce su propietario numérico para el
usuario del contenedor. Por eso el propietario, grupo y modo del archivo del host forman parte del
contrato de ejecución.

En particular, `deploy:deploy 0600` no sirve para los secretos de la API: la imagen ejecuta
`USER node` y, en la imagen actualmente fijada, ese usuario es `1000:1000`. El resultado de montar
un archivo `0600` perteneciente a `deploy` es `EACCES`. Tampoco se debe resolver haciendo los
secretos legibles para todos.

El despliegue normal requiere exactamente tres archivos:

- `session_secret`: entropía para firmar sesiones; mínimo 32 caracteres.
- `postgres_password`: contraseña del rol PostgreSQL `rutacuadrilla`.
- `database_url`: URL completa que usa la API para conectarse a `db:5432`.

El bootstrap inicial usa además `initial_admin_password` como secreto temporal.
Debe contener una contraseña de entre 12 y 256 caracteres, guardarse antes en el
gestor de secretos del operador y eliminarse del host después de obtener
`PROVISIONED` o `ALREADY_PROVISIONED`.

El lector elimina como máximo un terminador final `LF` o `CRLF`, habitual al
crear un archivo de texto. No recorta ningún otro carácter: espacios y
tabuladores son significativos y forman parte de la contraseña. Se rechazan
saltos de línea embebidos, bytes NUL, más de un terminador final y contraseñas
compuestas solo por whitespace.

## Creación inicial

Ejecutar desde la raíz del repositorio en la VPS como `root` o mediante `sudo`. Primero crear los
archivos cerrados, todavía sin conceder acceso al grupo de la API:

```bash
sudo install -d -o root -g root -m 0700 deploy/secrets
sudo sh -eu <<'EOF'
umask 077
openssl rand -base64 48 > deploy/secrets/session_secret
database_password="$(openssl rand -hex 32)"
printf '%s' "${database_password}" > deploy/secrets/postgres_password
printf 'postgresql://rutacuadrilla:%s@db:5432/rutacuadrilla' \
  "${database_password}" > deploy/secrets/database_url
unset database_password
chown root:root deploy/secrets/session_secret deploy/secrets/postgres_password \
  deploy/secrets/database_url
chmod 0400 deploy/secrets/session_secret deploy/secrets/postgres_password \
  deploy/secrets/database_url
EOF
```

## Verificar la identidad de la API antes de conceder acceso

El nombre `node` no garantiza por sí solo un UID/GID estable entre imágenes. Después de construir la
imagen y **antes** de aplicar el grupo `1000`, comprobar la identidad numérica real:

```bash
sudo docker compose --env-file deploy/.env -f deploy/compose.vps.yml build --pull api
sudo docker compose --env-file deploy/.env -f deploy/compose.vps.yml \
  run --rm --no-deps --entrypoint sh api -c \
  'printf "api uid=%s gid=%s\n" "$(id -u)" "$(id -g)"; test "$(id -u)" = 1000; test "$(id -g)" = 1000'
```

Si cualquiera de los dos valores no es `1000`, detener el despliegue y revisar la imagen y este
contrato; no aplicar a ciegas un grupo distinto. Esta comprobación debe repetirse al cambiar la
imagen base de la API.

Con la identidad `1000:1000` verificada, aplicar el contrato de producción:

```bash
sudo chown root:1000 deploy/secrets/session_secret deploy/secrets/database_url
sudo chmod 0440 deploy/secrets/session_secret deploy/secrets/database_url
sudo chown root:root deploy/secrets/postgres_password
sudo chmod 0400 deploy/secrets/postgres_password
sudo chown root:root deploy/secrets
sudo chmod 0700 deploy/secrets
```

El resultado esperado es:

- `deploy/secrets`: `root:root`, modo `0700`;
- `session_secret` y `database_url`: `root:1000`, modo `0440`, legibles por la API;
- `postgres_password`: `root:root`, modo `0400`, legible durante el arranque de PostgreSQL y no por
  la API.

Antes del aprovisionamiento inicial, crear el secreto temporal sin poner su
valor en el historial del shell y concederle el mismo acceso de solo lectura
que a los secretos consumidos por el usuario de la API:

```bash
sudo install -o root -g 1000 -m 0440 /ruta/segura/initial_admin_password \
  deploy/secrets/initial_admin_password
```

El comando de una sola ejecución está documentado en `docs/operations.md`. Al
terminar, eliminar `deploy/secrets/initial_admin_password`; no forma parte del
conjunto de secretos persistentes del servicio.

Comprobar solo rutas, propiedad, permisos y tamaño; no imprimir el contenido:

```bash
sudo stat -c '%n %U:%G %a %s bytes' deploy/secrets \
  deploy/secrets/session_secret \
  deploy/secrets/postgres_password \
  deploy/secrets/database_url
```

El directorio `0700` evita que el operador sin privilegios recorra los secretos. Por ello los
comandos de Docker Compose que consumen esta composición y los scripts de backup/restauración se
ejecutan mediante `sudo`; el daemon resuelve los bind mounts como `root`. Los archivos deben seguir
excluidos de Git y del contexto de build. No copiar el `.env` local de desarrollo a la VPS.

## Conservación y rotación

- Conservar `session_secret` en un gestor seguro externo. Rotarlo invalida todas las sesiones.
- Conservar juntos `postgres_password` y `database_url`: ambos representan la misma credencial.
- Cambiar los archivos después de inicializar el volumen **no cambia** la contraseña dentro de
  PostgreSQL. Una rotación requiere primero `ALTER ROLE`, después reemplazar ambos archivos y por
  último reiniciar la API.
- No incluir estos secretos en dumps, manifiestos, tickets, logs, comandos con valor literal ni
  archivos de release.
- La copia PostgreSQL contiene cuentas y actividad operativa; debe cifrarse antes de salir de la
  VPS y tener una retención explícita.

Nunca eliminar `postgres_data` para corregir una discrepancia de credenciales. Tampoco ejecutar
`docker compose down -v`: destruiría la base persistente.
