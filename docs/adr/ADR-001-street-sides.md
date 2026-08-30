# ADR-001: lados físicos de calle por ruta

## Estado

Aceptada.

## Contexto

Dos rutas pueden recorrer el mismo eje vial atendiendo lados opuestos. Inferir
la pertenencia por número par/impar o por cercanía produce asignaciones
ambiguas, especialmente en esquinas y segmentos curvos.

## Decisión

Cada segmento versionado declara `LEFT`, `RIGHT` o `BOTH` respecto al orden de
sus coordenadas. Los puntos se seleccionan explícitamente para una revisión de
ruta; el cliente no reasigna puntos de forma silenciosa.

## Consecuencias

- Invertir las coordenadas invierte izquierda y derecha.
- La interfaz debe mostrar el sentido del trazado.
- Lados complementarios pueden coexistir; repetir el mismo lado físico se
  rechaza.
- La preparación de una ruta requiere revisión humana, pero la ejecución es
  determinista y auditable.
