import { useEffect, useMemo, useState } from "react";
import type { AdminApi, Membership, RouteRevision } from "../api/types";
import { prepareRoutePackage } from "../local/prepareRoutePackage";
import {
  LocalPackageError,
  type RoutePackageStore,
  type VerifiedRoutePackage,
} from "../local/routePackage";
import { formatDate, formatRevisionName } from "./Shared";

interface RoutePackagePanelProps {
  accountId: string;
  api: AdminApi;
  membership: Membership;
  revision: RouteRevision;
  routeId: string;
  store: RoutePackageStore;
}

export function RoutePackagePanel({
  accountId,
  api,
  membership,
  revision,
  routeId,
  store,
}: RoutePackagePanelProps) {
  const [verified, setVerified] = useState<VerifiedRoutePackage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [contextNotice, setContextNotice] = useState("");
  const canManageCampaigns = membership.capabilities
    ? membership.capabilities.includes("CAMPAIGN_MANAGE")
    : membership.role === "ADMIN";
  const scope = useMemo(
    () => ({
      accountId,
      crewId: membership.crewId,
      revisionId: revision.id,
      routeId,
    }),
    [accountId, membership.crewId, revision.id, routeId],
  );

  useEffect(() => {
    let active = true;
    void store
      .find(scope)
      .then((result) => {
        if (active) setVerified(result ?? null);
      })
      .catch((caught: unknown) => {
        if (active && caught instanceof LocalPackageError) setError(caught.message);
      });
    return () => {
      active = false;
    };
  }, [scope, store]);

  async function prepare() {
    if (!api.downloadRoutePackage) return;
    setBusy(true);
    setError("");
    try {
      const result = await prepareRoutePackage(store, scope, api.downloadRoutePackage.bind(api));
      setVerified(result);
      setOpen(true);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "No fue posible preparar la copia local.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function createContext() {
    setBusy(true);
    setError("");
    try {
      const response = await api.createTechnicalContext(membership.crewId, revision.id);
      setContextNotice(
        `${response.context.campaignName}: contexto técnico listo con ${response.context.pointCount.toLocaleString("es-CL")} puntos y ${response.context.segmentCount.toLocaleString("es-CL")} tramos.`,
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "No fue posible crear el contexto técnico.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="local-package" aria-labelledby={`local-package-${revision.id}`}>
      <div>
        <p className="eyebrow">Copia local verificable</p>
        <h3 id={`local-package-${revision.id}`}>{formatRevisionName(revision)}</h3>
        <p>
          Datos de ruta únicamente: sin mapa base, campaña, visitas ni capacidad de operar offline.
        </p>
        {verified ? (
          <p className="local-package__status" role="status">
            Verificada {formatDate(verified.record.verifiedAt)} ·{" "}
            {(verified.record.byteLength / 1024).toFixed(1)} KB · SHA-256{" "}
            <code>{verified.record.sha256.slice(0, 16)}…</code>
          </p>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {contextNotice ? (
          <p className="notice notice--success" role="status">
            {contextNotice}
          </p>
        ) : null}
      </div>
      <div className="button-row">
        <button
          type="button"
          className="button button--secondary"
          disabled={busy || !api.downloadRoutePackage}
          onClick={() => void prepare()}
        >
          {busy ? "Verificando…" : verified ? "Revalidar copia" : "Preparar copia local"}
        </button>
        {verified ? (
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "Cerrar copia" : "Abrir copia local"}
          </button>
        ) : null}
        {canManageCampaigns ? (
          <button
            type="button"
            className="button button--quiet"
            disabled={busy}
            onClick={() => void createContext()}
          >
            Preparar contexto de campo
          </button>
        ) : null}
      </div>
      {open && verified ? (
        <section
          className="local-package__content"
          aria-label="Contenido verificado de la copia local"
        >
          <dl>
            <div>
              <dt>Ruta</dt>
              <dd>{verified.package.route.name}</dd>
            </div>
            <div>
              <dt>Revisión</dt>
              <dd>{verified.package.revision.number}</dd>
            </div>
            <div>
              <dt>Puntos</dt>
              <dd>{verified.package.points.length.toLocaleString("es-CL")}</dd>
            </div>
            <div>
              <dt>Tramos por lado</dt>
              <dd>
                {verified.package.segments.length.toLocaleString("es-CL")} total ·{" "}
                {
                  verified.package.segments.filter((segment) => segment.serviceSide === "LEFT")
                    .length
                }{" "}
                izquierdo ·{" "}
                {
                  verified.package.segments.filter((segment) => segment.serviceSide === "RIGHT")
                    .length
                }{" "}
                derecho ·{" "}
                {
                  verified.package.segments.filter((segment) => segment.serviceSide === "BOTH")
                    .length
                }{" "}
                ambos
              </dd>
            </div>
            <div>
              <dt>Hash de contenido</dt>
              <dd>
                <code>{verified.package.revision.contentHash}</code>
              </dd>
            </div>
          </dl>
          {verified.package.attributions.map((attribution) => (
            <a key={attribution.url} href={attribution.url} target="_blank" rel="noreferrer">
              {attribution.label}
            </a>
          ))}
        </section>
      ) : null}
    </section>
  );
}
