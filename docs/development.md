# Desarrollo local

## Requisitos

- Node.js 24 o superior.
- npm 11 o superior.
- PostgreSQL 18 para reproducir el entorno de despliegue. El helper de Windows
  necesita `initdb.exe`, `pg_ctl.exe`, `psql.exe` y `createdb.exe` en
  `.local/postgresql-18/bin/` o en la ruta indicada por
  `RUTACUADRILLA_POSTGRES_HOME`.

## Instalación

```powershell
npm ci
Copy-Item .env.example .env
```

Reemplaza todos los valores de ejemplo de `.env`. El archivo real permanece
fuera de Git.

El repositorio no descarga PostgreSQL. Una vez disponibles esos binarios, el
helper inicializa y administra una instancia local aislada:

```powershell
npm run local:postgres:setup
```

El comando genera credenciales aleatorias dentro de `.local/`, que también
está excluido del repositorio.

## Servicios

Para la demo sintética completa en Windows o Bash:

```powershell
npm run demo:start
```

El comando conserva un `.env` existente: solo lo acepta si coincide exactamente
con `.env.demo.example`; si falta, crea esa copia localhost-only. Después
compila lo necesario, espera los tres servicios, importa la ruta de forma
idempotente y muestra URLs y credenciales. `Ctrl+C` cierra únicamente sus
procesos.

Para desarrollo manual, ejecuta cada proceso en una terminal:

```powershell
npm run dev:api
npm run dev:admin
npm run dev:field
```

- API: `http://127.0.0.1:4310/ready`
- Administración: `http://127.0.0.1:4311/`
- Campo: `http://127.0.0.1:4312/`

## Calidad

```powershell
npm run verify
npm audit --omit=dev --audit-level=high
```

`verify` ejecuta formato, lint, tipos, escaneo preventivo, pruebas y builds de
producción. La CI repite ese contrato en Ubuntu y Windows.

## Datos de desarrollo

Genera siempre los fixtures públicos mediante el script determinista descrito
en [`../demo/README.md`](../demo/README.md). Nunca copies un inventario real a
tests, capturas o issues.
