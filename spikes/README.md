# Spikes técnicos reproducibles

Experimentos aislados para reducir incertidumbre técnica. No forman parte del
producto canónico ni sustituyen pruebas de integración, seguridad o uso en un
dispositivo real.

## Ejecutar

```powershell
npm test --prefix spikes
npm run benchmark:map-data --prefix spikes
```

No requieren dependencias externas adicionales.

## Alcance

Las pruebas cubren escenarios sintéticos de:

- operaciones causales offline y reintentos idempotentes;
- conflictos concurrentes y persistencia de outbox;
- transacciones SQLite y partición local;
- barreras de reconciliación y cierre;
- preparación e indexación de hasta 10.000 puntos.

No demuestran comportamiento de PostgreSQL, renderizado MapLibre, consumo de
GPU, batería, GPS, redes móviles intermitentes, mapas offline ni rendimiento en
un teléfono. Los resultados de cada ejecución son evidencia de laboratorio y
no un KPI operacional.
