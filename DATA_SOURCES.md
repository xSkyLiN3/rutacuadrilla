# Procedencia y uso de datos

## Datos incluidos

La edición pública de RutaCuadrilla contiene únicamente fixtures geográficos
generados por código. Sus nombres, identificadores, coordenadas, polígonos y
relaciones son ficticios y no representan viviendas, residentes, clientes ni
recorridos reales.

El manifiesto del dataset declara `synthetic: true` y el generador utiliza una
semilla fija para que la salida sea reproducible sin acceso a red.

## Datos no incluidos

El piloto privado se construyó con insumos territoriales y validaciones de
operación que no se redistribuyen en este repositorio. Esta exclusión abarca
direcciones, coordenadas, geometrías catastrales, identificadores externos y
reglas específicas del recorrido.

La disponibilidad pública de una fuente no implica por sí sola permiso para
republicar una selección transformada ni elimina los riesgos de privacidad y
reidentificación. Por ese motivo, el caso de estudio describe el proceso y sus
restricciones sin entregar el inventario real.

## Mapas de terceros

La aplicación no configura un mapa base externo por defecto. Quien añada un
proveedor de estilos o teselas debe revisar sus términos, límites, atribución y
permisos de caché u operación offline. No se incluyen datos de OpenStreetMap en
el dataset sintético.

## Licencias

[`LICENSE`](LICENSE) cubre el código original del repositorio. No concede
derechos sobre servicios, marcas, mapas o datasets de terceros que una persona
configure por separado.
