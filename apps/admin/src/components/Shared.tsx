import type { ReactNode } from "react";
import { useId } from "react";
import type {
  PointSource,
  PointType,
  RevisionStatus,
  RoutePoint,
  RouteRevision,
} from "../api/types";

export function LoadingState({ label = "Cargando…" }: { label?: string }) {
  return (
    <div className="state-panel" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

interface ErrorStateProps {
  title: string;
  message: string;
  status?: number;
  onRetry?: () => void;
  action?: ReactNode;
}

export function ErrorState({ title, message, status, onRetry, action }: ErrorStateProps) {
  return (
    <section className="state-panel state-panel--error" role="alert">
      <span className="state-code" aria-hidden="true">
        {status === 401 || status === 403 ? status : "!"}
      </span>
      <h2>{title}</h2>
      <p>{message}</p>
      <div className="button-row button-row--center">
        {onRetry ? (
          <button className="button button--secondary" type="button" onClick={onRetry}>
            Reintentar
          </button>
        ) : null}
        {action}
      </div>
    </section>
  );
}

const revisionLabels: Record<RevisionStatus, string> = {
  DRAFT: "Borrador",
  PUBLISHED: "Publicada",
  SUPERSEDED: "Reemplazada",
  ARCHIVED: "Archivada",
};

export function formatPointAddress(point: Pick<RoutePoint, "street" | "number">): string {
  const street = point.street?.trim() || "Calle no informada";
  return `${street} ${point.number?.trim() || "S/N"}`;
}

const pointTypeLabels: Record<PointType, string> = {
  DWELLING: "Vivienda",
  BUILDING_ENTRANCE: "Entrada de edificio",
  COMPLEX_ACCESS: "Acceso de conjunto",
  SPECIAL: "Punto especial",
};

const pointSourceLabels: Record<PointSource, string> = {
  MANUAL: "Manual",
  CSV: "CSV",
  OSM: "OpenStreetMap",
  GEOJSON: "GeoJSON",
};

export function formatPointType(value: PointType): string {
  return pointTypeLabels[value];
}

export function formatPointSource(value: PointSource): string {
  return pointSourceLabels[value];
}

export function formatRevisionName(revision: Pick<RouteRevision, "number" | "status">): string {
  if (revision.status === "DRAFT") {
    return revision.number === null
      ? "Borrador"
      : `Borrador (número provisional ${revision.number})`;
  }
  return revision.number === null ? "Revisión sin número" : `Revisión ${revision.number}`;
}

export function RevisionBadge({ status }: { status: RevisionStatus }) {
  return (
    <span className={`revision-badge revision-badge--${status.toLocaleLowerCase("en")}`}>
      {revisionLabels[status]}
    </span>
  );
}

export function formatDate(value?: string): string {
  if (!value) {
    return "—";
  }
  return new Intl.DateTimeFormat("es-CL", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

interface SchematicMapProps {
  points: Array<Pick<RoutePoint, "id" | "street" | "number" | "latitude" | "longitude">>;
  title?: string;
}

export function SchematicMap({
  points,
  title = "Mapa esquemático de los puntos",
}: SchematicMapProps) {
  const titleId = useId();
  const descriptionId = useId();

  if (points.length === 0) {
    return (
      <div className="map-empty" role="img" aria-label="Sin puntos para representar">
        <strong>Sin puntos</strong>
        <span>Agrega coordenadas válidas para generar la vista.</span>
      </div>
    );
  }

  const latitudes = points.map((point) => point.latitude);
  const longitudes = points.map((point) => point.longitude);
  const minLatitude = Math.min(...latitudes);
  const maxLatitude = Math.max(...latitudes);
  const minLongitude = Math.min(...longitudes);
  const maxLongitude = Math.max(...longitudes);
  const latitudeRange = maxLatitude - minLatitude || 0.001;
  const longitudeRange = maxLongitude - minLongitude || 0.001;
  const positioned = points.map((point, index) => ({
    ...point,
    x: 46 + ((point.longitude - minLongitude) / longitudeRange) * 508,
    y: 314 - ((point.latitude - minLatitude) / latitudeRange) * 268,
    label: String(index + 1),
  }));

  return (
    <div className="schematic-map">
      <svg viewBox="0 0 600 360" role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
        <title id={titleId}>{title}</title>
        <desc id={descriptionId}>
          Distribución relativa de {points.length} puntos a partir de sus coordenadas. No representa
          calles ni distancias reales.
        </desc>
        <rect className="map-background" x="1" y="1" width="598" height="358" rx="8" />
        {[100, 200, 300, 400, 500].map((x) => (
          <line className="map-grid" key={`x-${x}`} x1={x} y1="24" x2={x} y2="330" />
        ))}
        {[80, 150, 220, 290].map((y) => (
          <line className="map-grid" key={`y-${y}`} x1="28" y1={y} x2="572" y2={y} />
        ))}
        <path className="map-road" d="M20 285 C130 220, 250 265, 360 185 S520 90, 590 120" />
        <path className="map-road" d="M70 20 C170 110, 250 100, 315 190 S430 315, 570 300" />
        {positioned.map((point) => (
          <g key={point.id} transform={`translate(${point.x} ${point.y})`}>
            <circle className="map-point" r="16" />
            <text className="map-point-label" textAnchor="middle" dominantBaseline="central">
              {point.label}
            </text>
          </g>
        ))}
        <text className="map-axis-label" x="30" y="348">
          {minLongitude.toFixed(5)}
        </text>
        <text className="map-axis-label" x="570" y="348" textAnchor="end">
          {maxLongitude.toFixed(5)}
        </text>
      </svg>
      <ol className="map-point-key" aria-label="Puntos del mapa">
        {positioned.map((point) => (
          <li key={point.id}>
            <span aria-hidden="true">{point.label}</span>
            {formatPointAddress(point)} · {point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}
          </li>
        ))}
      </ol>
    </div>
  );
}
