import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api/client";
import type { AdminApi, Membership, RouteSummary } from "../api/types";
import { ErrorState, formatDate, formatRevisionName, LoadingState, RevisionBadge } from "./Shared";

interface RoutesViewProps {
  api: AdminApi;
  membership: Membership;
  refreshKey: number;
  onImport: () => void;
  onOpenRoute: (routeId: string) => void;
  onUnauthorized: () => void;
}

type RoutesState =
  | { status: "loading" }
  | { status: "ready"; routes: RouteSummary[] }
  | { status: "error"; error: ApiError };

export function RoutesView({
  api,
  membership,
  refreshKey,
  onImport,
  onOpenRoute,
  onUnauthorized,
}: RoutesViewProps) {
  const [state, setState] = useState<RoutesState>({ status: "loading" });
  const canImport = membership.capabilities
    ? membership.capabilities.includes("ROUTE_DRAFT_EDIT")
    : membership.role === "ADMIN";

  const loadRoutes = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const routes = await api.listRoutes(membership.crewId);
      setState({ status: "ready", routes });
    } catch (caught) {
      const error =
        caught instanceof ApiError ? caught : new ApiError(0, "No fue posible cargar las rutas.");
      if (error.status === 401) {
        onUnauthorized();
        return;
      }
      setState({ status: "error", error });
    }
  }, [api, membership.crewId, onUnauthorized]);

  useEffect(() => {
    void refreshKey;
    void loadRoutes();
  }, [loadRoutes, refreshKey]);

  return (
    <>
      <header className="page-heading page-heading--actions">
        <div>
          <p className="eyebrow">{membership.crewName}</p>
          <h1>Rutas y revisiones</h1>
          <p>Administra la geografía reusable que luego se asignará a una campaña.</p>
        </div>
        {canImport ? (
          <button className="button button--primary" type="button" onClick={onImport}>
            Nueva ruta desde CSV
          </button>
        ) : null}
      </header>

      {state.status === "loading" ? <LoadingState label="Cargando rutas…" /> : null}

      {state.status === "error" && state.error.status === 403 ? (
        <ErrorState status={403} title="Acceso restringido" message={state.error.message} />
      ) : null}

      {state.status === "error" && state.error.status !== 403 ? (
        <ErrorState
          status={state.error.status}
          title="No pudimos cargar las rutas"
          message={state.error.message}
          onRetry={() => void loadRoutes()}
        />
      ) : null}

      {state.status === "ready" && state.routes.length === 0 ? (
        <section className="state-panel">
          <span className="empty-mark" aria-hidden="true">
            +
          </span>
          <h2>Aún no hay rutas</h2>
          <p>Importa un CSV para crear la primera revisión en borrador.</p>
          {canImport ? (
            <button className="button button--primary" type="button" onClick={onImport}>
              Importar primera ruta
            </button>
          ) : null}
        </section>
      ) : null}

      {state.status === "ready" && state.routes.length > 0 ? (
        <div className="table-container">
          <table className="data-table">
            <caption className="sr-only">Rutas de {membership.crewName}</caption>
            <thead>
              <tr>
                <th scope="col">Ruta</th>
                <th scope="col">Última revisión</th>
                <th scope="col">Puntos</th>
                <th scope="col">Actualizada</th>
                <th scope="col">
                  <span className="sr-only">Acción</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {state.routes.map((route) => (
                <tr key={route.id}>
                  <td>
                    <strong>{route.name}</strong>
                    <small>{route.sectorName}</small>
                  </td>
                  <td>
                    <span className="revision-cell">
                      {formatRevisionName(route.latestRevision)}
                      <RevisionBadge status={route.latestRevision.status} />
                    </span>
                  </td>
                  <td>{route.latestRevision.pointCount}</td>
                  <td>{formatDate(route.updatedAt)}</td>
                  <td>
                    <button
                      className="button button--secondary"
                      type="button"
                      onClick={() => onOpenRoute(route.id)}
                      aria-label={`Ver detalle de ${route.name}`}
                    >
                      Ver detalle
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
