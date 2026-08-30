# ADR-002: Simple Online como producto canónico

## Estado

Aceptada para la edición pública de portafolio.

## Contexto

El repositorio investigó campañas, jornadas y sincronización local-first. Esa
superficie superaba la funcionalidad validada y competía con un flujo online
más pequeño que ya resuelve usuarios, rutas, asignaciones y avance.

## Decisión

La experiencia principal usa `SimpleAdminApp`, `SimpleFieldApp` y el perfil de
API `simple`. El perfil `full` expone rutas adicionales de la API para pruebas
del código investigativo, pero no cambia los entrypoints web ni se presenta
como una variante terminada del producto.

## Consecuencias

- La documentación y la demo pueden describir exactamente lo que ejecutan.
- La superficie pública de API disminuye.
- El trabajo offline conserva valor experimental sin ampliar las promesas del
  producto.
- Una futura reintroducción offline exige evidencia E2E y una ADR nueva.
