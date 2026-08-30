# Operación y despliegue

La carpeta `deploy/` contiene una referencia operativa con controles de
contenedor para PostgreSQL, API y Caddy. Todos los nombres de host, rutas y
secretos son parámetros; el repositorio no documenta la topología de una
instalación viva. No debe interpretarse como una configuración productiva de
mínimo privilegio.

## Principios

- TLS termina en el proxy del host o en la capa indicada por el operador.
- PostgreSQL permanece en una red interna sin puerto público.
- Los secretos se montan desde archivos fuera de la imagen.
- API y edge usan filesystem de solo lectura, `tmpfs`, capacidades mínimas y
  `no-new-privileges`.
- Los backups se validan y una restauración usa una base candidata antes del
  cambio definitivo.

## Antes de desplegar

1. copia `deploy/.env.example` a un archivo local ignorado;
2. crea secretos aleatorios siguiendo `deploy/secrets/README.md`;
3. define un host propio y orígenes CORS exactos;
4. construye las imágenes desde un commit verificado;
5. ejecuta pruebas de salud, backup y restauración;
6. revisa privacidad, proveedor de mapas y retención de datos.

La configuración es una referencia técnica, no autorización para desplegar
datos del piloto privado.

### Límite actual del rol PostgreSQL

La composición mantiene un único rol para migraciones y runtime. Al crearlo
mediante `POSTGRES_USER`, la imagen oficial le concede privilegios de
superusuario. La red interna evita publicarlo, pero no sustituye el principio
de mínimo privilegio: si la API fuera comprometida, esa credencial tendría más
alcance del necesario dentro del clúster.

Antes de usar esta referencia con datos sensibles se deben separar un rol
propietario/migrador y un rol de aplicación `NOSUPERUSER`, `NOCREATEDB`,
`NOCREATEROLE` y `NOREPLICATION`, conceder solo `CONNECT`, `USAGE` y DML sobre
tablas/secuencias, desactivar migraciones automáticas en el proceso web y
probar esos privilegios en CI. Esa migración también necesita un procedimiento
explícito para volúmenes ya inicializados; esta versión no pretende resolverlo.

## Aprovisionamiento inicial

El bootstrap crea una sola cuadrilla y su primer administrador, únicamente si
la base está vacía. Es idempotente para la misma identidad y contraseña; ante
estado parcial, datos previos o una contraseña distinta se detiene sin
insertar ni sobrescribir datos de identidad.

El comando aplica primero todas las migraciones pendientes y solo después
inspecciona si el estado permite crear la identidad. Por tanto, una ejecución
que termina en `INITIAL_ADMIN_STATE_CONFLICT` puede haber actualizado el
esquema, aunque no haya creado usuarios, cuadrillas ni membresías. Se requiere
el mismo backup y revisión de migraciones que para cualquier despliegue.

La transacción que inspecciona y crea la identidad toma el bloqueo exclusivo
`INITIAL_ADMIN_PROVISION` de `system_lock`; dos intentos simultáneos no pueden
crear administradores duplicados. El ejecutor de migraciones no tiene un lock
global entre procesos: durante una actualización con migraciones pendientes se
debe lanzar una sola instancia del comando. Los reintentos concurrentes se
consideran seguros solo después de que el esquema esté completamente migrado.
La conexión PostgreSQL vence a los 10 segundos y una espera por locks a los 30
segundos; un timeout aborta el intento sin convertirlo en éxito y se debe revisar
la instancia que mantiene el bloqueo antes de reintentar.

En desarrollo se puede ejecutar contra PGlite con una ruta absoluta:

```bash
npm run provision:initial-admin -- \
  --database-dir /ruta/absoluta/rutacuadrilla-db \
  --email admin@example.com \
  --display-name "Administración inicial" \
  --crew-name "Cuadrilla inicial" \
  --crew-slug cuadrilla-inicial \
  --password-file /ruta/absoluta/initial_admin_password
```

En producción no se pasa la URL PostgreSQL ni la contraseña en la línea de
comandos. `deploy/compose.provision.yml` reutiliza el secreto
`database_url`, monta temporalmente `initial_admin_password` y conecta el
proceso de una sola ejecución solo a la red interna `backend`:

```bash
sudo docker compose --env-file deploy/.env \
  -f deploy/compose.vps.yml up -d db
sudo docker compose --env-file deploy/.env \
  -f deploy/compose.vps.yml -f deploy/compose.provision.yml \
  run --rm provision
```

El resultado esperado es `PROVISIONED`; repetir exactamente el mismo comando
devuelve `ALREADY_PROVISIONED`. Después se elimina del host el archivo temporal
`deploy/secrets/initial_admin_password`, conservando la contraseña en el gestor
de secretos del operador. No se debe ejecutar el bootstrap para crear cuentas
adicionales.

La CI levanta un servicio desechable `postgres:18.6-bookworm` y ejecuta
`npm run test:postgres:provision` para validar migraciones, dos intentos
concurrentes, repetición idempotente y lectura posterior con el adaptador
PostgreSQL real. También valida con `docker compose config -q` el merge de la
composición base y el one-shot, construye la imagen de API y comprueba desde el
usuario sin privilegios que los secretos estén montados como archivos legibles,
sin imprimir su contenido. En una máquina sin Docker/PostgreSQL la prueba real
queda omitida; el resto de la suite continúa usando PGlite. La variable de prueba
solo acepta `localhost` o `127.0.0.1` y una base llamada exactamente
`rutacuadrilla_test` para reducir el riesgo de apuntarla a datos persistentes.
