# Base de datos de dominio

Las migraciones PostgreSQL viven en `migrations/` y se aplican en orden con
`migrateDatabase()` desde `@rutacuadrilla/domain`.

- `001_foundation.sql` crea identidad, sesiones, tenancy, capacidades,
  geografía reutilizable, importaciones y auditoría.
- `002_immutability.sql` protege revisiones publicadas, asociaciones, versiones
  de puntos y auditoría.
- `003_draft_revision_edit.sql` añade recibos idempotentes para corregir un
  borrador, registra la procedencia de nuevas versiones y vuelve inmutable la
  identidad estable de cada punto de servicio.
- `004_route_geography.sql` añade área versionada, segmentos de calle,
  asociaciones por revisión y recibos idempotentes para cambios espaciales e
  importaciones OSM pegadas. Las protecciones mantienen inmutables las
  versiones publicadas y la identidad estable de los segmentos.
- `005_sync.sql` incorpora el contexto operativo técnico: campaña y asociación
  de ruta sintéticas, proyección de puntos por contexto, eventos de estado,
  secuencia por tripulación, recibos idempotentes y change-log para pull por
  cursor.
- `006_route_segment_service_side.sql` congela en cada revisión si un tramo
  atiende `LEFT`, `RIGHT` o `BOTH`. Los registros anteriores se interpretan
  como ambos lados; izquierda/derecha depende del orden de coordenadas.
- `007_campaign_multiroute_vehicle.sql` incorpora vehículos por tripulación y
  campañas comerciales multirruta. Cada asignación congela revisión y camión,
  materializa puntos y reclama lados físicos por fuente/identificador externo
  normalizado. Restricciones por campaña impiden repetir ruta, camión,
  `service_point_id` o `source + external_id normalizado + lado`; no deducen
  identidad por domicilio/coordenadas. Las campañas técnicas heredadas
  conservan compatibilidad explícita.
- `008_campaign_composition_integrity.sql` liga cada punto a la identidad
  compuesta de su campaña y asignación, y exige que tanto el origen como el
  destino de cualquier cambio de composición sigan en `DRAFT`.
- `009_work_sessions.sql` separa la asignación geográfica de su ejecución:
  incorpora jornadas `ACTIVE → FINISHED`, participantes y dispositivos,
  recibos idempotentes de inicio/unión/finalización y liga los nuevos eventos
  de punto y recibos de sincronización a una jornada activa. La historia previa
  conserva `work_session_id = NULL` de forma explícita y no se reatribuye.
- `010_simple_online.sql` materializa la experiencia canónica en línea:
  asigna una ruta activa por usuario, conserva el avance versionado por punto
  y registra cada cambio como un evento append-only e idempotente.
- `011_initial_provision_lock.sql` crea la fila de exclusión que serializa el
  alta del primer administrador y evita dos bootstrap simultáneos.

No hay contraseñas, hashes ni tokens de demostración dentro de SQL. El seed se
ejecuta mediante `seedDemoData(database, options)`, que recibe las contraseñas en
memoria, aplica scrypt con sal aleatoria y usa consultas parametrizadas.

PGlite valida las migraciones estructurales en tests. Antes de producción se
deben repetir en la versión PostgreSQL objetivo, porque PGlite no acredita
concurrencia, roles ni privilegios de runtime.

Las tablas de `005_sync.sql`, ampliadas por `007` y `009`, sostienen la vertical
de referencia, la composición de campañas y una jornada operativa mínima.
`technical_fixture` distingue los contextos sintéticos heredados de las
campañas comerciales. Todavía no existen reconciliación/checkpoints, eventos
tardíos, cierre financiero ni GPS. La persistencia local del cliente vive en
SQLite Wasm/OPFS y no forma parte de estas migraciones PostgreSQL.

La demo pública usa las tablas de `010_simple_online.sql`; las tablas de
sincronización y campañas permanecen como investigación explícita y no forman
parte del perfil predeterminado de la API.
