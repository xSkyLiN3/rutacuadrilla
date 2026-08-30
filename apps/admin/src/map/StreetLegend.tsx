export function StreetLegend() {
  return (
    <fieldset className="route-map__service-legend">
      <legend>Lado atendido según el sentido del tramo</legend>
      <ul>
        <li>
          <span
            className="route-map__service-mark route-map__service-mark--left"
            aria-hidden="true"
          />
          Izquierdo
        </li>
        <li>
          <span
            className="route-map__service-mark route-map__service-mark--right"
            aria-hidden="true"
          />
          Derecho
        </li>
        <li>
          <span
            className="route-map__service-mark route-map__service-mark--both"
            aria-hidden="true"
          />
          Ambos lados
        </li>
      </ul>
      <ul aria-label="Leyenda de sentido del componente">
        <li>
          <span
            className="route-map__direction-mark route-map__direction-mark--start"
            aria-hidden="true"
          />
          Inicio del componente
        </li>
        <li>
          <span
            className="route-map__direction-mark route-map__direction-mark--end"
            aria-hidden="true"
          />
          Fin del componente
        </li>
      </ul>
    </fieldset>
  );
}
