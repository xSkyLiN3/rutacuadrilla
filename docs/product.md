# Producto

## Problema

Los equipos que recorren un sector suelen coordinar personas, rutas y avance
con mapas separados, mensajes y planillas. Eso dificulta saber qué recorrido
tiene cada integrante, qué puntos ya fueron atendidos y dónde existen
conflictos o trabajo pendiente.

RutaCuadrilla concentra ese flujo en dos interfaces:

- **Administración:** crea usuarios, importa y publica rutas, asigna un
  recorrido activo y consulta el avance agregado.
- **Campo:** muestra solo la ruta asignada a la persona autenticada y permite
  registrar uno de seis resultados por punto.

## Alcance demostrable

La edición pública implementa:

- autenticación y sesiones revocables;
- aislamiento por equipo y por usuario;
- una ruta activa por operador;
- importación CSV idempotente;
- asignación exclusiva de puntos y lados de calle;
- mapa y lista adaptados a móvil;
- control de versión optimista al actualizar estados;
- avance agregado para administración;
- persistencia PostgreSQL y migraciones versionadas.

## Estados de una visita

- Sin visitar.
- Sobre entregado.
- Volver.
- Sin respuesta.
- Aportó.
- No participa.

## Límites honestos

RutaCuadrilla es un prototipo funcional y un caso de estudio de ingeniería. No
se presenta como SaaS, aplicación certificada, optimizador de rutas ni sistema
validado para operación masiva. La variante local-first y los experimentos de
sincronización no forman parte de la experiencia principal.

El piloto privado utilizó un inventario territorial real. El repositorio y la
demostración pública usan exclusivamente información sintética; consulta
[`DATA_SOURCES.md`](../DATA_SOURCES.md).
