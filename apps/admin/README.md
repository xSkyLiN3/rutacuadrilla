# RutaCuadrilla Administración

Consola web para gestionar usuarios, importar y publicar rutas, asignarlas a
miembros de terreno y observar el avance agregado. La interfaz pública monta
`SimpleAdminApp` y se comunica con la API HTTP; no usa un backend simulado en
memoria.

## Desarrollo local

Desde la raíz del repositorio, con la API disponible en
`http://127.0.0.1:4310`:

```powershell
npm run dev:admin
```

Administración queda disponible en `http://127.0.0.1:4311`. Para crear las
cuentas y cargar la ruta sintética, sigue la [demo local reproducible](../../README.md#demo-local-reproducible).

Con `VITE_DEMO_MODE=true`, la pantalla identifica claramente la demo pública y
prellena credenciales exclusivamente locales. Un build normal fuerza ese modo
a `false`; habilitarlo en un build exige usar deliberadamente el modo Vite
`demo`.

## Flujo canónico

1. Iniciar sesión con una membresía administradora.
2. Crear o desactivar usuarios de Campo.
3. Importar un CSV y publicar su ruta mediante una operación idempotente.
4. Asignar una ruta activa a cada usuario.
5. Consultar el progreso total y por resultado operacional.

La pertenencia a la cuadrilla y las autorizaciones se vuelven a comprobar en
el servidor. Las vistas históricas de campañas se conservan como investigación
del perfil `full`, pero no forman parte de esta interfaz.

## Calidad

```powershell
npm run test --workspace=@rutacuadrilla/admin
npm run typecheck --workspace=@rutacuadrilla/admin
npm run build --workspace=@rutacuadrilla/admin
```
