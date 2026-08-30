# RutaCuadrilla Campo

Cliente web móvil para consultar una ruta asignada y registrar el resultado de
cada visita. La experiencia pública canónica es **Simple Online**: requiere
conexión con la API y valida pertenencia, versión y exclusividad en el servidor.

## Desarrollo local

Desde la raíz del repositorio, con la API disponible en
`http://127.0.0.1:4310`:

```powershell
npm run dev:field
```

Campo queda disponible en `http://127.0.0.1:4312`. Para preparar la demo
completa, sigue las instrucciones del [README principal](../../README.md#demo-local-reproducible).

## Datos y mapa

- La edición pública carga únicamente `demo-parcels.geojson` y
  `demo-dwellings.geojson`, ambos generados de forma determinista.
- Sin `VITE_MAP_STYLE_URL`, MapLibre muestra un fondo neutro y no solicita
  teselas a terceros.
- Configurar un proveedor externo exige revisar atribución, claves, límites,
  privacidad y licencia antes de desplegar.
- Los puntos pertenecen explícitamente a una ruta; la aplicación no asigna
  viviendas por cercanía ni por apariencia del mapa.

## Migración del cliente histórico

La aplicación actual no registra un service worker. Durante la transición,
`public/field-sw.js` se sirve sin caché únicamente para retirar el registro y
las cachés `rutacuadrilla-field-shell-*` del shell offline anterior. No
intercepta solicitudes ni elimina OPFS o IndexedDB.

Los módulos de SQLite Wasm, sincronización y jornadas permanecen como
investigación técnica bajo el perfil experimental `full`; no forman parte de
la interfaz pública ni de las promesas del producto.

## Calidad

```powershell
npm run test --workspace=@rutacuadrilla/field
npm run typecheck --workspace=@rutacuadrilla/field
npm run build --workspace=@rutacuadrilla/field
```

El benchmark local se puede ejecutar con:

```powershell
npm run benchmark:local-db --workspace=@rutacuadrilla/field
```

Es un detector de regresiones en Node, no una validación de rendimiento en un
teléfono ni una certificación para uso en terreno.
