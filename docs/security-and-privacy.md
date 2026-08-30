# Seguridad y privacidad

## Modelo de datos mínimo

Un punto representa un lugar de trabajo, no un perfil de una persona. El flujo
principal no requiere nombre, RUT, teléfono, conversación ni monto asociado a
una vivienda.

Los fixtures públicos son sintéticos. Una instalación real debe definir
finalidad, base legal, acceso, retención y eliminación antes de incorporar
direcciones o coordenadas operacionales.

## Controles implementados

- contraseñas derivadas con `scrypt` y salt aleatorio;
- sesiones firmadas, con vencimiento y revocación;
- limitación de intentos de inicio de sesión;
- aislamiento por equipo y usuario en API y base de datos;
- validación estructural de entradas;
- consultas SQL parametrizadas;
- idempotencia y control optimista de versiones;
- redacción de autorización, cookies y contraseñas en logs;
- CORS con orígenes exactos;
- contenedores sin privilegios, filesystem de solo lectura y red de base de
  datos no publicada en la configuración de despliegue.

## Riesgos que debe cerrar un despliegue real

- gestión y rotación de secretos;
- TLS, proxy confiable y cabeceras del dominio final;
- backups cifrados y restauraciones ensayadas;
- monitoreo, alertas y respuesta a incidentes;
- retención y borrado de estados ligados a ubicaciones;
- términos del proveedor de mapas y atribución;
- revisión de permisos y pruebas de penetración independientes.
- separación entre el rol PostgreSQL propietario/migrador y el rol DML de la
  API; la referencia Compose actual aún comparte la credencial de bootstrap.

Consulta [`SECURITY.md`](../SECURITY.md) para reportar vulnerabilidades.
