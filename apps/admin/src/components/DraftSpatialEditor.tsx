import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api/client";
import type {
  AdminApi,
  DraftMapPointInput,
  DraftRevisionChange,
  Membership,
  OsmPreview,
  PointType,
  Position,
  RevisionFeaturePoint,
  RevisionFeatures,
  ServiceSide,
} from "../api/types";
import { formatServiceSide, normalizeServiceSide, SERVICE_SIDE_OPTIONS } from "../lib/serviceSide";
import { parseAreaGeometry, pointInArea } from "../map/geometry";
import { RouteMap } from "../map/RouteMap";

interface DraftSpatialEditorProps {
  api: AdminApi;
  membership: Membership;
  onChanged(): void;
  onClose(): void;
  onUnauthorized(): void;
  revisionId: string;
  routeId: string;
}

type PointForm = {
  externalId: string;
  latitude: string;
  longitude: string;
  number: string;
  pointType: PointType;
  street: string;
};

const emptyPoint = (): PointForm => ({
  externalId: `manual-${crypto.randomUUID()}`,
  latitude: "",
  longitude: "",
  number: "",
  pointType: "DWELLING",
  street: "",
});

function pointToForm(point: RevisionFeaturePoint): PointForm {
  return {
    externalId: point.externalId,
    latitude: String(point.latitude),
    longitude: String(point.longitude),
    number: point.number ?? "",
    pointType: point.pointType,
    street: point.street ?? "",
  };
}

function requiredCoordinate(value: string, kind: "latitude" | "longitude"): number {
  const parsed = Number(value);
  const minimum = kind === "latitude" ? -90 : -180;
  const maximum = kind === "latitude" ? 90 : 180;
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(
      kind === "latitude"
        ? "La latitud debe estar entre -90 y 90."
        : "La longitud debe estar entre -180 y 180.",
    );
  }
  return parsed;
}

function formatDirectionCoordinate([longitude, latitude]: Position): string {
  return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
}

export function DraftSpatialEditor({
  api,
  membership,
  onChanged,
  onClose,
  onUnauthorized,
  revisionId,
  routeId,
}: DraftSpatialEditorProps) {
  const [features, setFeatures] = useState<RevisionFeatures | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pointMode, setPointMode] = useState<"add" | "edit">("add");
  const [selectedPointId, setSelectedPointId] = useState("");
  const [pointForm, setPointForm] = useState<PointForm>(emptyPoint);
  const [areaText, setAreaText] = useState("");
  const [osmText, setOsmText] = useState("");
  const [osmPreview, setOsmPreview] = useState<OsmPreview | null>(null);
  const [selectedOsmPoints, setSelectedOsmPoints] = useState<Set<number>>(new Set());
  const [selectedOsmSegments, setSelectedOsmSegments] = useState<Set<number>>(new Set());
  const [confirmedOsmSegmentSides, setConfirmedOsmSegmentSides] = useState<Set<number>>(new Set());
  const [segmentSides, setSegmentSides] = useState<Record<string, ServiceSide>>({});
  const [osmSegmentSides, setOsmSegmentSides] = useState<Record<string, ServiceSide>>({});
  const pendingOperation = useRef<{ fingerprint: string; id: string } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const loadFeatures = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await api.getRevisionFeatures(membership.crewId, routeId, revisionId);
      setFeatures(response);
      setAreaText(response.area ? JSON.stringify(response.area, null, 2) : "");
      setSelectedPointId((current) =>
        response.points.some((point) => point.id === current) ? current : "",
      );
      setSegmentSides(
        Object.fromEntries(
          response.segments.map((segment) => [
            segment.id,
            normalizeServiceSide(segment.serviceSide),
          ]),
        ),
      );
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof Error ? caught.message : "No fue posible cargar las geometrías.");
    } finally {
      setLoading(false);
    }
  }, [api, membership.crewId, onUnauthorized, revisionId, routeId]);

  useEffect(() => {
    void loadFeatures();
    headingRef.current?.focus();
  }, [loadFeatures]);

  const selectedPoint = features?.points.find((point) => point.id === selectedPointId);
  const mapStreets = useMemo(
    () =>
      features?.segments.flatMap((segment) =>
        segment.geometry.coordinates.map((coordinates, index) => ({
          id: `${segment.id}:${index}`,
          externalId: segment.externalId,
          name: segment.name ?? "Calle sin nombre",
          serviceSide: normalizeServiceSide(segment.serviceSide),
          source: segment.source,
          coordinates,
        })),
      ) ?? [],
    [features],
  );

  const parsedLatitude = Number(pointForm.latitude);
  const parsedLongitude = Number(pointForm.longitude);
  const outsideArea =
    features && Number.isFinite(parsedLatitude) && Number.isFinite(parsedLongitude)
      ? pointInArea([parsedLongitude, parsedLatitude], features.area)
      : null;
  const hasUnconfirmedOsmSegment = [...selectedOsmSegments].some(
    (index) => !confirmedOsmSegmentSides.has(index),
  );

  async function applyChange(change: DraftRevisionChange, successMessage: string) {
    if (!features) return;
    const fingerprint = JSON.stringify({ baseDraftVersion: features.draftVersion, change });
    const operationId =
      pendingOperation.current?.fingerprint === fingerprint
        ? pendingOperation.current.id
        : crypto.randomUUID();
    pendingOperation.current = { fingerprint, id: operationId };
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await api.applyDraftChange(membership.crewId, routeId, revisionId, {
        operationId,
        baseDraftVersion: features.draftVersion,
        change,
      });
      pendingOperation.current = null;
      await loadFeatures();
      setNotice(successMessage);
      onChanged();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof Error ? caught.message : "No fue posible guardar el cambio.");
    } finally {
      setSaving(false);
    }
  }

  async function savePoint(event: FormEvent) {
    event.preventDefault();
    try {
      const latitude = requiredCoordinate(pointForm.latitude, "latitude");
      const longitude = requiredCoordinate(pointForm.longitude, "longitude");
      if (pointMode === "edit" && selectedPoint) {
        await applyChange(
          {
            type: "UPDATE_POINT",
            servicePointId: selectedPoint.id,
            expectedServicePointVersionId: selectedPoint.servicePointVersionId,
            point: {
              latitude,
              longitude,
              street: pointForm.street.trim() || undefined,
              number: pointForm.number.trim() || undefined,
              pointType: pointForm.pointType,
            },
          },
          "Punto corregido mediante una nueva versión; el historial publicado permanece intacto.",
        );
      } else {
        const point: DraftMapPointInput = {
          externalId: pointForm.externalId.trim(),
          latitude,
          longitude,
          street: pointForm.street.trim() || undefined,
          number: pointForm.number.trim() || undefined,
          pointType: pointForm.pointType,
          source: "MANUAL",
        };
        if (!point.externalId) throw new TypeError("El identificador externo es obligatorio.");
        await applyChange({ type: "ADD_POINT", point }, "Punto manual agregado al borrador.");
        setPointForm(emptyPoint());
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "El punto no es válido.");
    }
  }

  async function saveArea() {
    try {
      await applyChange(
        { type: "SET_AREA", geometry: parseAreaGeometry(areaText) },
        areaText.trim() ? "Área del borrador guardada." : "Área retirada del borrador.",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "El GeoJSON del área no es válido.");
    }
  }

  async function previewOsm() {
    let payload: unknown;
    try {
      payload = JSON.parse(osmText);
    } catch {
      setError("La exportación OSM/Overpass debe contener JSON válido.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await api.previewOsmExport(membership.crewId, routeId, revisionId, payload);
      setOsmPreview(response);
      setSelectedOsmPoints(new Set(response.points.map((_, index) => index)));
      setSelectedOsmSegments(new Set(response.segments.map((_, index) => index)));
      setConfirmedOsmSegmentSides(new Set());
      setOsmSegmentSides(
        Object.fromEntries(
          response.segments.map((segment, index) => [
            String(index),
            normalizeServiceSide(segment.serviceSide),
          ]),
        ),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible revisar la exportación.");
    } finally {
      setSaving(false);
    }
  }

  async function importOsmSelection() {
    if (!osmPreview) return;
    if (hasUnconfirmedOsmSegment) {
      setError("Confirma explícitamente el lado de cada calle OSM seleccionada.");
      return;
    }
    await applyChange(
      {
        type: "IMPORT_OSM_SELECTION",
        points: osmPreview.points.filter((_, index) => selectedOsmPoints.has(index)),
        segments: osmPreview.segments.flatMap((segment, index) =>
          selectedOsmSegments.has(index)
            ? [
                {
                  ...segment,
                  serviceSide:
                    osmSegmentSides[String(index)] ?? normalizeServiceSide(segment.serviceSide),
                },
              ]
            : [],
        ),
      },
      "Candidatos OSM seleccionados incorporados al borrador; aún no se publicaron.",
    );
    setOsmPreview(null);
    setOsmText("");
    setOsmSegmentSides({});
    setConfirmedOsmSegmentSides(new Set());
  }

  async function saveSegmentSides(event: FormEvent) {
    event.preventDefault();
    if (!features || features.segments.length === 0) return;
    await applyChange(
      {
        type: "REPLACE_SEGMENTS",
        segments: features.segments.map((segment) => ({
          externalId: segment.externalId,
          geometry: segment.geometry,
          serviceSide: segmentSides[segment.id] ?? normalizeServiceSide(segment.serviceSide),
          source: segment.source,
          ...(segment.name ? { name: segment.name } : {}),
          ...(segment.sourceVersion ? { sourceVersion: segment.sourceVersion } : {}),
          ...(segment.attribution ? { attribution: segment.attribution } : {}),
        })),
      },
      "Lados de atención guardados en una nueva versión del borrador.",
    );
  }

  function selectPoint(pointId: string) {
    const point = features?.points.find((candidate) => candidate.id === pointId);
    if (!point) return;
    setSelectedPointId(pointId);
    setPointMode("edit");
    setPointForm(pointToForm(point));
  }

  if (loading && !features) return <p role="status">Cargando editor espacial…</p>;

  return (
    <section className="spatial-editor" aria-labelledby="spatial-editor-title">
      <header className="section-heading section-heading--between">
        <div>
          <p className="eyebrow">Edición individual y geometrías WGS84</p>
          <h2 id="spatial-editor-title" ref={headingRef} tabIndex={-1}>
            Editor espacial
          </h2>
          <small>
            Versión de borrador {features?.draftVersion ?? "—"}. Solo las revisiones en borrador
            pueden cambiar.
          </small>
        </div>
        <button type="button" className="button button--quiet" onClick={onClose}>
          Cerrar editor
        </button>
      </header>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice notice--success" role="status">
          {notice}
        </p>
      ) : null}
      {features ? (
        <>
          <RouteMap
            boundary={features.area ?? undefined}
            points={features.points}
            streets={mapStreets}
            selectedPointId={selectedPointId}
            title="Editor cartográfico del borrador"
            onPointSelect={selectPoint}
            onMapClick={(longitude, latitude) =>
              setPointForm((current) => ({
                ...current,
                longitude: longitude.toFixed(6),
                latitude: latitude.toFixed(6),
              }))
            }
          />

          <div className="spatial-editor__grid">
            <form className="spatial-panel" onSubmit={(event) => void savePoint(event)}>
              <div className="section-heading section-heading--between">
                <h3>{pointMode === "add" ? "Agregar punto" : "Corregir punto"}</h3>
                <button
                  type="button"
                  className="button button--quiet"
                  onClick={() => {
                    setPointMode("add");
                    setSelectedPointId("");
                    setPointForm(emptyPoint());
                  }}
                >
                  Nuevo punto
                </button>
              </div>
              <label>
                Punto existente
                <select
                  value={selectedPointId}
                  onChange={(event) => selectPoint(event.currentTarget.value)}
                >
                  <option value="">— Seleccionar para corregir —</option>
                  {features.points.map((point) => (
                    <option key={point.id} value={point.id}>
                      {point.street || "Calle no informada"} {point.number || "S/N"} ·{" "}
                      {point.externalId}
                    </option>
                  ))}
                </select>
              </label>
              <div className="form-grid">
                <label>
                  ID externo
                  <input
                    value={pointForm.externalId}
                    disabled={pointMode === "edit"}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setPointForm((current) => ({
                        ...current,
                        externalId: value,
                      }));
                    }}
                  />
                </label>
                <label>
                  Tipo
                  <select
                    value={pointForm.pointType}
                    onChange={(event) => {
                      const value = event.currentTarget.value as PointType;
                      setPointForm((current) => ({
                        ...current,
                        pointType: value,
                      }));
                    }}
                  >
                    <option value="DWELLING">Vivienda</option>
                    <option value="BUILDING_ENTRANCE">Entrada de edificio</option>
                    <option value="COMPLEX_ACCESS">Acceso de conjunto</option>
                    <option value="SPECIAL">Especial</option>
                  </select>
                </label>
                <label>
                  Calle
                  <input
                    value={pointForm.street}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setPointForm((current) => ({ ...current, street: value }));
                    }}
                  />
                </label>
                <label>
                  Número
                  <input
                    value={pointForm.number}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setPointForm((current) => ({ ...current, number: value }));
                    }}
                  />
                </label>
                <label>
                  Latitud
                  <input
                    inputMode="decimal"
                    value={pointForm.latitude}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setPointForm((current) => ({
                        ...current,
                        latitude: value,
                      }));
                    }}
                  />
                </label>
                <label>
                  Longitud
                  <input
                    inputMode="decimal"
                    value={pointForm.longitude}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setPointForm((current) => ({
                        ...current,
                        longitude: value,
                      }));
                    }}
                  />
                </label>
              </div>
              {outsideArea === false ? (
                <p className="notice notice--warning" role="status">
                  Advertencia: el punto está fuera del área definida. Puedes guardarlo y revisarlo
                  antes de publicar.
                </p>
              ) : null}
              <div className="button-row">
                {pointMode === "edit" && selectedPoint ? (
                  <button
                    type="button"
                    className="button button--danger"
                    disabled={saving}
                    onClick={() =>
                      void applyChange(
                        { type: "REMOVE_POINT", servicePointId: selectedPoint.id },
                        "Punto excluido del borrador.",
                      )
                    }
                  >
                    Excluir punto
                  </button>
                ) : null}
                <button type="submit" className="button button--primary" disabled={saving}>
                  {saving
                    ? "Guardando…"
                    : pointMode === "add"
                      ? "Agregar punto"
                      : "Guardar nueva versión"}
                </button>
              </div>
            </form>

            <section className="spatial-panel" aria-labelledby="area-title">
              <h3 id="area-title">Área de la ruta</h3>
              <p>GeoJSON Polygon o MultiPolygon. El servidor valida cierre, rangos y tamaño.</p>
              <label>
                Geometría del área
                <textarea
                  rows={12}
                  value={areaText}
                  onChange={(event) => setAreaText(event.currentTarget.value)}
                  placeholder='{"type":"Polygon","coordinates":[...]}'
                />
              </label>
              <button
                type="button"
                className="button button--secondary"
                disabled={saving}
                onClick={() => void saveArea()}
              >
                Guardar área
              </button>
            </section>
          </div>

          <section className="spatial-panel" aria-labelledby="segment-side-title">
            <h3 id="segment-side-title">Calles y lado atendido</h3>
            <p>
              Izquierda y derecha se calculan siguiendo el orden de coordenadas de cada componente
              del tramo: desde su primera coordenada hacia la última. No se infieren por números de
              vivienda ni por cercanía.
            </p>
            <p className="notice notice--warning">
              <strong>Revisa el sentido del trazado:</strong> si se invierte el orden de sus
              coordenadas, también se intercambian los lados izquierdo y derecho. Cuando un tramo
              con un solo lado tiene varios componentes, cada componente debe continuar desde el
              final del anterior.
            </p>
            {features.segments.length > 0 ? (
              <form onSubmit={(event) => void saveSegmentSides(event)}>
                <ul className="segment-side-list">
                  {features.segments.map((segment) => {
                    const name = segment.name || segment.externalId;
                    const serviceSide =
                      segmentSides[segment.id] ?? normalizeServiceSide(segment.serviceSide);
                    return (
                      <li key={segment.id} className="segment-side-row">
                        <div>
                          <strong>{name}</strong>
                          <ol className="segment-component-directions">
                            {segment.geometry.coordinates.map((component, componentIndex) => {
                              const start = component[0];
                              const end = component.at(-1);
                              if (!start || !end) return null;
                              return (
                                <li key={`${segment.id}:${start.join(",")}>${end.join(",")}`}>
                                  Componente {componentIndex + 1}: Inicio{" "}
                                  <span>{formatDirectionCoordinate(start)}</span> → Fin{" "}
                                  <span>{formatDirectionCoordinate(end)}</span>
                                </li>
                              );
                            })}
                          </ol>
                        </div>
                        <label>
                          Lado atendido
                          <select
                            aria-label={`Lado atendido en ${name}`}
                            value={serviceSide}
                            onChange={(event) => {
                              const value = event.currentTarget.value as ServiceSide;
                              setSegmentSides((current) => ({
                                ...current,
                                [segment.id]: value,
                              }));
                            }}
                          >
                            {SERVICE_SIDE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                          <small>{formatServiceSide(serviceSide)}</small>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <button type="submit" className="button button--primary" disabled={saving}>
                  {saving ? "Guardando…" : "Guardar lados de las calles"}
                </button>
              </form>
            ) : (
              <p>
                Aún no hay tramos de calle. Incorpóralos desde OSM/Overpass o mediante el contrato
                de geometrías antes de asignar sus lados.
              </p>
            )}
          </section>

          <details className="spatial-panel osm-importer">
            <summary>Importación asistida OSM/Overpass</summary>
            <p>
              Pega una exportación JSON obtenida de una fuente permitida. No se consulta ningún
              servidor público desde esta aplicación; los candidatos se revisan antes de
              incorporarlos. Asigna el lado de atención de cada tramo seleccionado antes de
              guardarlo.
            </p>
            <label>
              Exportación Overpass JSON
              <textarea
                rows={10}
                value={osmText}
                onChange={(event) => setOsmText(event.currentTarget.value)}
              />
            </label>
            <button
              type="button"
              className="button button--secondary"
              disabled={saving || !osmText.trim()}
              onClick={() => void previewOsm()}
            >
              Revisar candidatos
            </button>
            {osmPreview ? (
              <div className="osm-preview">
                <p>
                  <strong>
                    {osmPreview.summary.candidatePoints} puntos y{" "}
                    {osmPreview.summary.candidateSegments} calles candidatas.
                  </strong>{" "}
                  OSM puede estar incompleto.
                </p>
                {osmPreview.warnings.map((warning) => (
                  <p key={warning} className="notice notice--warning">
                    {warning}
                  </p>
                ))}
                <div className="osm-preview__lists">
                  <fieldset>
                    <legend>Puntos</legend>
                    {osmPreview.points.map((point, index) => (
                      <label key={point.externalId}>
                        <input
                          type="checkbox"
                          checked={selectedOsmPoints.has(index)}
                          onChange={() =>
                            setSelectedOsmPoints((current) => {
                              const next = new Set(current);
                              if (next.has(index)) next.delete(index);
                              else next.add(index);
                              return next;
                            })
                          }
                        />
                        {point.street || "Calle no informada"} {point.number || "S/N"}
                      </label>
                    ))}
                  </fieldset>
                  <fieldset>
                    <legend>Calles</legend>
                    {osmPreview.segments.map((segment, index) => {
                      const name = segment.name || segment.externalId;
                      const selected = selectedOsmSegments.has(index);
                      const serviceSide =
                        osmSegmentSides[String(index)] ?? normalizeServiceSide(segment.serviceSide);
                      const components =
                        segment.geometry.type === "LineString"
                          ? [segment.geometry.coordinates]
                          : segment.geometry.coordinates;
                      return (
                        <div key={segment.externalId} className="osm-segment-choice">
                          <label className="osm-segment-choice__toggle">
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() =>
                                setSelectedOsmSegments((current) => {
                                  const next = new Set(current);
                                  if (next.has(index)) next.delete(index);
                                  else next.add(index);
                                  return next;
                                })
                              }
                            />
                            {name}
                          </label>
                          <ol
                            className="segment-component-directions"
                            aria-label={`Sentido de candidato ${name}`}
                          >
                            {components.map((component, componentIndex) => {
                              const start = component[0];
                              const end = component.at(-1);
                              if (!start || !end) return null;
                              return (
                                <li key={`${name}:${start.join(",")}>${end.join(",")}`}>
                                  Componente {componentIndex + 1}: Inicio (
                                  {formatDirectionCoordinate(start)}) → Fin (
                                  {formatDirectionCoordinate(end)})
                                </li>
                              );
                            })}
                          </ol>
                          <label>
                            Lado atendido
                            <select
                              aria-label={`Lado atendido en candidato ${name}`}
                              disabled={!selected}
                              value={serviceSide}
                              onChange={(event) => {
                                const value = event.currentTarget.value as ServiceSide;
                                setOsmSegmentSides((current) => ({
                                  ...current,
                                  [String(index)]: value,
                                }));
                                setConfirmedOsmSegmentSides((current) => {
                                  const next = new Set(current);
                                  next.delete(index);
                                  return next;
                                });
                              }}
                            >
                              {SERVICE_SIDE_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="osm-segment-choice__toggle">
                            <input
                              type="checkbox"
                              aria-label={`Confirmar lado atendido en candidato ${name}`}
                              disabled={!selected}
                              checked={confirmedOsmSegmentSides.has(index)}
                              onChange={(event) => {
                                const checked = event.currentTarget.checked;
                                setConfirmedOsmSegmentSides((current) => {
                                  const next = new Set(current);
                                  if (checked) next.add(index);
                                  else next.delete(index);
                                  return next;
                                });
                              }}
                            />
                            Confirmo que el camión atiende{" "}
                            {formatServiceSide(serviceSide).toLowerCase()} según el sentido Inicio →
                            Fin.
                          </label>
                        </div>
                      );
                    })}
                  </fieldset>
                </div>
                <p>
                  <a
                    href="https://www.openstreetmap.org/copyright"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {osmPreview.attribution}
                  </a>
                </p>
                {hasUnconfirmedOsmSegment ? (
                  <p className="notice notice--warning" role="status">
                    Confirma explícitamente el lado de cada calle seleccionada antes de
                    incorporarla.
                  </p>
                ) : null}
                <button
                  type="button"
                  className="button button--primary"
                  disabled={
                    saving ||
                    hasUnconfirmedOsmSegment ||
                    (selectedOsmPoints.size === 0 && selectedOsmSegments.size === 0)
                  }
                  onClick={() => void importOsmSelection()}
                >
                  Incorporar selección al borrador
                </button>
              </div>
            ) : null}
          </details>
        </>
      ) : (
        <button
          type="button"
          className="button button--secondary"
          onClick={() => void loadFeatures()}
        >
          Reintentar
        </button>
      )}
    </section>
  );
}
