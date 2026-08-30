# Dataset público de demostración

Este directorio contiene una ruta completamente sintética para demostrar RutaCuadrilla sin
publicar ubicaciones, domicilios ni información operacional real.

- `route.csv`: 72 puntos ficticios importables.
- `segments.json`: 12 tramos ficticios con lados `LEFT`, `RIGHT` y `BOTH`.
- `area.geojson`: límite artificial centrado alrededor de `[0, 0]`.
- `manifest.json`: declaración de origen sintético, conteos y hashes SHA-256.

Los catálogos 1:1 de predios y huellas se publican como
`apps/field/public/demo-parcels.geojson` y `apps/field/public/demo-dwellings.geojson`.

Para regenerar todos los artefactos de forma determinística:

```console
node tools/generate-demo-route.mjs --write
```

Para comprobar que los archivos versionados corresponden exactamente al generador:

```console
node tools/generate-demo-route.mjs --check
node --test tools/demo-route-data.test.mjs
```
