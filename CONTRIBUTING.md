# Contribuir

## Requisitos

- Node.js 24 o superior.
- npm 11 o superior.
- PostgreSQL para las pruebas de integración que lo requieran; el desarrollo
  local también puede usar el adaptador embebido documentado en el proyecto.

## Flujo local

```bash
npm ci
npm run verify
```

Antes de proponer cambios:

1. crea una rama con un nombre descriptivo;
2. añade o actualiza pruebas para el comportamiento modificado;
3. ejecuta `npm run verify` desde una instalación limpia;
4. documenta decisiones y limitaciones relevantes en el pull request.

## Reglas de datos

No agregues datos reales de personas, viviendas, clientes, cuadrillas o
infraestructura. Los fixtures geográficos deben generarse de forma
determinista, declarar que son sintéticos y no derivarse mediante traslación,
rotación o deformación de un recorrido real.

Para una revisión local adicional, `RUTACUADRILLA_PRIVATE_DENYLIST_FILE` puede
apuntar a un archivo absoluto, externo al repositorio, con un marcador privado
por línea. `npm run secrets:check` informa únicamente el archivo público que
coincide; nunca imprime ni versiona los valores de esa lista.

## Seguridad

No publiques vulnerabilidades o secretos en issues. Sigue
[`SECURITY.md`](SECURITY.md) para reportarlos de forma privada.
