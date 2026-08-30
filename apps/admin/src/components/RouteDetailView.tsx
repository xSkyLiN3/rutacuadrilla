import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api/client";
import type { AdminApi, Membership, RouteDetail, RouteRevision } from "../api/types";
import type { RoutePackageStore } from "../local/routePackage";
import { RouteMap } from "../map/RouteMap";
import { DraftPointsEditor } from "./DraftPointsEditor";
import { DraftSpatialEditor } from "./DraftSpatialEditor";
import { RoutePackagePanel } from "./RoutePackagePanel";
import {
  ErrorState,
  formatDate,
  formatPointAddress,
  formatPointSource,
  formatPointType,
  formatRevisionName,
  LoadingState,
  RevisionBadge,
} from "./Shared";

interface RouteDetailViewProps {
  accountId: string;
  api: AdminApi;
  membership: Membership;
  routeId: string;
  onBack: () => void;
  onRouteChanged: () => void;
  onUnauthorized: () => void;
  routePackageStore: RoutePackageStore;
}

type DetailState =
  | { status: "loading" }
  | { status: "ready"; route: RouteDetail }
  | { status: "error"; error: ApiError };

export function RouteDetailView({
  accountId,
  api,
  membership,
  routeId,
  onBack,
  onRouteChanged,
  onUnauthorized,
  routePackageStore,
}: RouteDetailViewProps) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [selectedRevisionId, setSelectedRevisionId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState("");
  const [publishReceipt, setPublishReceipt] = useState<{
    identifier: string;
    revisionName: string;
  } | null>(null);
  const [editingPoints, setEditingPoints] = useState(false);
  const [editingSpatially, setEditingSpatially] = useState(false);
  const [editNotice, setEditNotice] = useState("");
  const publishTriggerRef = useRef<HTMLButtonElement>(null);
  const publishDialogRef = useRef<HTMLElement>(null);
  const publishCancelRef = useRef<HTMLButtonElement>(null);
  const publishReceiptRef = useRef<HTMLElement>(null);
  const editTriggerRef = useRef<HTMLButtonElement>(null);
  const spatialEditTriggerRef = useRef<HTMLButtonElement>(null);
  const wasEditingPoints = useRef(false);

  const loadRoute = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const route = await api.getRoute(membership.crewId, routeId);
      setState({ status: "ready", route });
      setSelectedRevisionId((current) => {
        if (route.revisions.some((revision) => revision.id === current)) {
          return current;
        }
        return (
          [...route.revisions].sort(
            (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
          )[0]?.id ?? ""
        );
      });
    } catch (caught) {
      const error =
        caught instanceof ApiError
          ? caught
          : new ApiError(0, "No fue posible cargar el detalle de la ruta.");
      if (error.status === 401) {
        onUnauthorized();
        return;
      }
      setState({ status: "error", error });
    }
  }, [api, membership.crewId, onUnauthorized, routeId]);

  useEffect(() => {
    void loadRoute();
  }, [loadRoute]);

  const selectedRevision = useMemo<RouteRevision | undefined>(() => {
    if (state.status !== "ready") {
      return undefined;
    }
    return state.route.revisions.find((revision) => revision.id === selectedRevisionId);
  }, [selectedRevisionId, state]);

  useEffect(() => {
    if (!confirming) {
      return;
    }

    const trigger = publishTriggerRef.current;
    publishCancelRef.current?.focus();

    function handleDialogKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setConfirming(false);
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const focusable = Array.from(
        publishDialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleDialogKeyDown);
    return () => {
      document.removeEventListener("keydown", handleDialogKeyDown);
      trigger?.focus();
    };
  }, [confirming]);

  useEffect(() => {
    if (editingPoints) {
      wasEditingPoints.current = true;
      return;
    }
    if (wasEditingPoints.current) {
      wasEditingPoints.current = false;
      editTriggerRef.current?.focus();
    }
  }, [editingPoints]);

  useEffect(() => {
    if (publishReceipt) {
      publishReceiptRef.current?.focus();
    }
  }, [publishReceipt]);

  async function publishRevision() {
    if (!selectedRevision) {
      return;
    }
    setPublishing(true);
    setPublishError("");
    try {
      const route = await api.publishRevision(membership.crewId, routeId, selectedRevision.id);
      setState({ status: "ready", route });
      const publishedRevision = route.revisions.find(
        (revision) => revision.id === selectedRevision.id,
      );
      setPublishReceipt({
        identifier: publishedRevision?.contentHash ?? publishedRevision?.id ?? selectedRevision.id,
        revisionName: publishedRevision
          ? formatRevisionName(publishedRevision)
          : formatRevisionName(selectedRevision),
      });
      setConfirming(false);
      setEditingPoints(false);
      setEditingSpatially(false);
      setEditNotice("");
      onRouteChanged();
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.status === 401) {
          onUnauthorized();
          return;
        }
        setPublishError(caught.message);
      } else {
        setPublishError("No fue posible publicar la revisión.");
      }
    } finally {
      setPublishing(false);
    }
  }

  if (state.status === "loading") {
    return <LoadingState label="Cargando detalle de la ruta…" />;
  }

  if (state.status === "error") {
    return (
      <ErrorState
        status={state.error.status}
        title={state.error.status === 403 ? "Acceso restringido" : "No pudimos abrir la ruta"}
        message={state.error.message}
        onRetry={state.error.status === 403 ? undefined : () => void loadRoute()}
        action={
          <button className="button button--quiet" type="button" onClick={onBack}>
            Volver a rutas
          </button>
        }
      />
    );
  }

  const route = state.route;
  const canPublish =
    (membership.capabilities
      ? membership.capabilities.includes("ROUTE_PUBLISH")
      : membership.role === "ADMIN") &&
    selectedRevision !== undefined &&
    selectedRevision.status === "DRAFT";
  const canEditPoints =
    (membership.capabilities
      ? membership.capabilities.includes("ROUTE_DRAFT_EDIT")
      : membership.role === "ADMIN") &&
    selectedRevision !== undefined &&
    selectedRevision.status === "DRAFT";

  return (
    <>
      <button className="back-button" type="button" onClick={onBack}>
        ← Volver a rutas
      </button>
      <header className="page-heading page-heading--actions">
        <div>
          <p className="eyebrow">{route.sectorName}</p>
          <h1>{route.name}</h1>
          <p>
            {route.revisions.length} revisión(es) · actualizada {formatDate(route.updatedAt)}
          </p>
        </div>
        {canPublish && !editingPoints && !editingSpatially ? (
          <button
            ref={publishTriggerRef}
            className="button button--primary"
            type="button"
            onClick={() => {
              setConfirming(true);
              setPublishError("");
            }}
          >
            Revisar publicación
          </button>
        ) : null}
      </header>

      {editNotice ? (
        <p className="notice notice--success" role="status" aria-live="polite">
          {editNotice}
        </p>
      ) : null}

      {publishReceipt ? (
        <section
          ref={publishReceiptRef}
          className="publish-receipt"
          role="status"
          aria-live="polite"
          tabIndex={-1}
        >
          <strong>{publishReceipt.revisionName} publicada.</strong>
          <span>Identificador / hash de contenido</span>
          <code>{publishReceipt.identifier}</code>
        </section>
      ) : null}

      <div className="detail-layout">
        <aside className="revision-list" aria-labelledby="revisions-title">
          <h2 id="revisions-title">Revisiones</h2>
          {route.revisions
            .slice()
            .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
            .map((revision) => (
              <button
                key={revision.id}
                type="button"
                className="revision-option"
                aria-pressed={revision.id === selectedRevisionId}
                onClick={() => {
                  setSelectedRevisionId(revision.id);
                  setConfirming(false);
                  setPublishError("");
                  setEditingPoints(false);
                  setEditingSpatially(false);
                  setEditNotice("");
                }}
              >
                <span>
                  <strong>{formatRevisionName(revision)}</strong>
                  <small>{formatDate(revision.createdAt)}</small>
                </span>
                <RevisionBadge status={revision.status} />
              </button>
            ))}
        </aside>

        <section className="revision-detail" aria-labelledby="revision-detail-title">
          {selectedRevision ? (
            <>
              <header className="section-heading section-heading--between">
                <div>
                  <p className="eyebrow">{formatRevisionName(selectedRevision)}</p>
                  <h2 id="revision-detail-title">{selectedRevision.pointCount} puntos</h2>
                </div>
                <div className="revision-actions">
                  <RevisionBadge status={selectedRevision.status} />
                  {canEditPoints && !editingPoints ? (
                    <button
                      ref={editTriggerRef}
                      className="button button--secondary"
                      type="button"
                      onClick={() => {
                        setEditingPoints(true);
                        setEditingSpatially(false);
                        setConfirming(false);
                        setPublishError("");
                        setPublishReceipt(null);
                        setEditNotice("");
                      }}
                    >
                      Corregir puntos CSV
                    </button>
                  ) : null}
                  {canEditPoints && !editingSpatially ? (
                    <button
                      ref={spatialEditTriggerRef}
                      className="button button--secondary"
                      type="button"
                      onClick={() => {
                        setEditingSpatially(true);
                        setEditingPoints(false);
                        setConfirming(false);
                        setPublishError("");
                        setPublishReceipt(null);
                        setEditNotice("");
                      }}
                    >
                      Editor espacial
                    </button>
                  ) : null}
                </div>
              </header>

              {editingPoints && selectedRevision.status === "DRAFT" ? (
                <DraftPointsEditor
                  key={selectedRevision.id}
                  api={api}
                  crewId={membership.crewId}
                  routeId={routeId}
                  revision={selectedRevision}
                  onCancel={() => setEditingPoints(false)}
                  onUnauthorized={onUnauthorized}
                  onSaved={(response) => {
                    setState({ status: "ready", route: response.route });
                    setSelectedRevisionId(response.revision.id);
                    setEditingPoints(false);
                    setEditNotice(
                      `${response.revision.pointCount} puntos corregidos y guardados en el borrador.`,
                    );
                    onRouteChanged();
                  }}
                />
              ) : null}

              {editingSpatially && selectedRevision.status === "DRAFT" ? (
                <DraftSpatialEditor
                  api={api}
                  membership={membership}
                  revisionId={selectedRevision.id}
                  routeId={routeId}
                  onUnauthorized={onUnauthorized}
                  onClose={() => {
                    setEditingSpatially(false);
                    window.setTimeout(() => spatialEditTriggerRef.current?.focus(), 0);
                  }}
                  onChanged={() => {
                    void loadRoute();
                    onRouteChanged();
                  }}
                />
              ) : null}

              {selectedRevision.status !== "DRAFT" ? (
                <dl className="revision-identifier">
                  <div>
                    <dt>Identificador / hash de contenido</dt>
                    <dd>
                      <code>{selectedRevision.contentHash ?? selectedRevision.id}</code>
                    </dd>
                  </div>
                </dl>
              ) : null}

              {selectedRevision.status !== "DRAFT" ? (
                <RoutePackagePanel
                  accountId={accountId}
                  api={api}
                  membership={membership}
                  revision={selectedRevision}
                  routeId={routeId}
                  store={routePackageStore}
                />
              ) : null}

              <RouteMap
                points={selectedRevision.points}
                title={`Coordenadas de ${formatRevisionName(selectedRevision)}`}
              />

              <div className="table-container">
                <table className="data-table data-table--compact">
                  <caption className="sr-only">
                    Puntos de {formatRevisionName(selectedRevision)}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">ID externo</th>
                      <th scope="col">Dirección</th>
                      <th scope="col">Tipo</th>
                      <th scope="col">Fuente</th>
                      <th scope="col">Latitud</th>
                      <th scope="col">Longitud</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedRevision.points.map((point) => (
                      <tr key={point.id}>
                        <td>
                          <code>{point.externalId}</code>
                        </td>
                        <td>{formatPointAddress(point)}</td>
                        <td>{formatPointType(point.pointType)}</td>
                        <td>{formatPointSource(point.source)}</td>
                        <td>{point.latitude}</td>
                        <td>{point.longitude}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p>No hay una revisión seleccionada.</p>
          )}
        </section>
      </div>

      {confirming && selectedRevision ? (
        <section
          ref={publishDialogRef}
          className="publish-confirmation"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="publish-title"
          aria-describedby="publish-description"
        >
          <div>
            <p className="eyebrow">Acción irreversible para esta revisión</p>
            <h2 id="publish-title">¿Publicar este borrador?</h2>
            <p id="publish-description">
              {formatRevisionName(selectedRevision)} quedará inmutable y disponible para asignarla a
              campañas. La revisión publicada anterior pasará a reemplazada.
            </p>
            {publishError ? (
              <p className="form-error" role="alert">
                {publishError}
              </p>
            ) : null}
          </div>
          <div className="button-row">
            <button
              ref={publishCancelRef}
              className="button button--secondary"
              type="button"
              onClick={() => setConfirming(false)}
              disabled={publishing}
            >
              Cancelar
            </button>
            <button
              className="button button--primary"
              type="button"
              onClick={() => void publishRevision()}
              disabled={publishing}
            >
              {publishing ? "Publicando…" : "Confirmar y publicar"}
            </button>
          </div>
        </section>
      ) : null}
    </>
  );
}
