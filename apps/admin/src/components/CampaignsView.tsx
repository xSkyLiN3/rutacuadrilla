import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api/client";
import type {
  AdminApi,
  CampaignDetail,
  CampaignStatus,
  Membership,
  RouteDetail,
  RouteRevision,
  Vehicle,
  WorkSession,
} from "../api/types";
import { ErrorState, LoadingState } from "./Shared";

interface CampaignsViewProps {
  api: AdminApi;
  membership: Membership;
  onUnauthorized: () => void;
}

type ReadyState = {
  campaigns: CampaignDetail[];
  routes: RouteDetail[];
  workSessions: Record<string, WorkSession | null>;
  vehicles: Vehicle[];
};

type ViewState =
  | { status: "loading" }
  | ({ status: "ready" } & ReadyState)
  | { status: "error"; error: ApiError };

type RevisionOption = {
  revision: RouteRevision;
  route: RouteDetail;
};

const campaignStatusLabels: Record<CampaignStatus, string> = {
  DRAFT: "Borrador",
  ACTIVE: "Activa",
  CLOSED: "Cerrada",
  ARCHIVED: "Archivada",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeText(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeCount(details: Record<string, unknown> | undefined): number {
  const value = details?.conflictCount;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
}

export function describeCampaignConflict(error: ApiError): string {
  const details = asRecord(error.details);
  const conflict = asRecord(details?.conflict);
  if (error.code === "CAMPAIGN_ROUTE_DUPLICATE") {
    const route = asRecord(conflict?.route);
    return `La ruta ${safeText(route, "name") ?? "seleccionada"} ya forma parte de esta campaña.`;
  }
  if (error.code === "CAMPAIGN_VEHICLE_DUPLICATE") {
    const vehicle = asRecord(conflict?.vehicle);
    const route = asRecord(conflict?.route);
    return `${safeText(vehicle, "name") ?? "El camión seleccionado"} ya está asignado a ${
      safeText(route, "name") ?? "otra ruta"
    } en esta campaña.`;
  }
  if (error.code === "CAMPAIGN_POINT_DUPLICATE") {
    const count = safeCount(details);
    return `Se detectaron ${count} ${count === 1 ? "punto con el mismo identificador estable" : "puntos con el mismo identificador estable"} entre las rutas. Revisa su reparto antes de continuar.`;
  }
  if (error.code === "CAMPAIGN_SEGMENT_SIDE_DUPLICATE") {
    const count = safeCount(details);
    return `Se detectaron ${count} ${count === 1 ? "lado de calle repetido" : "lados de calle repetidos"}. Cada lado físico solo puede pertenecer a un camión en la campaña.`;
  }
  if (error.code === "CAMPAIGN_SEGMENT_VERSION_AMBIGUOUS") {
    const count = safeCount(details);
    return `Hay ${count} ${count === 1 ? "calle cuya versión no coincide" : "calles cuyas versiones no coinciden"} entre lados opuestos. Actualiza las revisiones para comprobar que se trata del mismo tramo.`;
  }
  return error.message;
}

function formatCampaignDate(value?: string): string {
  if (!value) return "Sin definir";
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  return new Intl.DateTimeFormat("es-CL", { dateStyle: "medium" }).format(
    new Date(year, month - 1, day),
  );
}

function formatSessionDate(value: string): string {
  return new Intl.DateTimeFormat("es-CL", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function revisionLabel(option: RevisionOption): string {
  const number = option.revision.number === null ? "sin número" : String(option.revision.number);
  const state = option.revision.status === "PUBLISHED" ? "publicada" : "reemplazada";
  return `${option.route.name} · revisión ${number} (${state}) · ${option.revision.pointCount} puntos`;
}

export function CampaignsView({ api, membership, onUnauthorized }: CampaignsViewProps) {
  const [state, setState] = useState<ViewState>({ status: "loading" });
  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [vehicleName, setVehicleName] = useState("");
  const [vehicleRegistration, setVehicleRegistration] = useState("");
  const [vehicleBusy, setVehicleBusy] = useState(false);
  const [vehicleError, setVehicleError] = useState("");
  const [vehicleNotice, setVehicleNotice] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [campaignBusy, setCampaignBusy] = useState(false);
  const [campaignError, setCampaignError] = useState("");
  const [campaignNotice, setCampaignNotice] = useState("");
  const [selectedRevisionId, setSelectedRevisionId] = useState("");
  const [selectedVehicleId, setSelectedVehicleId] = useState("");
  const [assignmentBusy, setAssignmentBusy] = useState(false);
  const [assignmentError, setAssignmentError] = useState("");
  const [assignmentNotice, setAssignmentNotice] = useState("");
  const [removingId, setRemovingId] = useState("");
  const [confirmRemoveId, setConfirmRemoveId] = useState("");
  const [confirmingActivation, setConfirmingActivation] = useState(false);
  const [activating, setActivating] = useState(false);
  const activationDialogRef = useRef<HTMLElement>(null);
  const activationCancelRef = useRef<HTMLButtonElement>(null);
  const activationTriggerRef = useRef<HTMLButtonElement>(null);
  const campaignsHeadingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const [campaignSummaries, vehicles, routeSummaries] = await Promise.all([
        api.listCampaigns(membership.crewId),
        api.listVehicles(membership.crewId),
        api.listRoutes(membership.crewId),
      ]);
      const [campaigns, routes] = await Promise.all([
        Promise.all(
          campaignSummaries.map((campaign) => api.getCampaign(membership.crewId, campaign.id)),
        ),
        Promise.all(routeSummaries.map((route) => api.getRoute(membership.crewId, route.id))),
      ]);
      const workSessions = Object.fromEntries(
        await Promise.all(
          campaigns.flatMap((campaign) =>
            campaign.routes.map(async (assignment) => {
              if (!api.getCurrentWorkSession) return [assignment.id, null] as const;
              const response = await api.getCurrentWorkSession(membership.crewId, assignment.id);
              return [assignment.id, response.workSession] as const;
            }),
          ),
        ),
      );
      setState({ status: "ready", campaigns, routes, vehicles, workSessions });
      setSelectedCampaignId((current) =>
        campaigns.some((campaign) => campaign.id === current) ? current : (campaigns[0]?.id ?? ""),
      );
    } catch (caught) {
      const error =
        caught instanceof ApiError
          ? caught
          : new ApiError(0, "No fue posible cargar las campañas.");
      if (error.status === 401) {
        onUnauthorized();
        return;
      }
      setState({ status: "error", error });
    }
  }, [api, membership.crewId, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!confirmingActivation) return;
    const dialog = activationDialogRef.current;
    const focusable = () =>
      Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
    if (activationCancelRef.current?.disabled) dialog?.focus();
    else activationCancelRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !activating) {
        event.preventDefault();
        setConfirmingActivation(false);
        window.setTimeout(() => activationTriggerRef.current?.focus(), 0);
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (controls.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activating, confirmingActivation]);

  const ready = state.status === "ready" ? state : null;
  const selectedCampaign = ready?.campaigns.find((campaign) => campaign.id === selectedCampaignId);
  const revisionOptions = useMemo<RevisionOption[]>(
    () =>
      (ready?.routes ?? [])
        .flatMap((route) =>
          route.revisions
            .filter(
              (revision) => revision.status === "PUBLISHED" || revision.status === "SUPERSEDED",
            )
            .map((revision) => ({ route, revision })),
        )
        .sort((left, right) => revisionLabel(left).localeCompare(revisionLabel(right), "es")),
    [ready?.routes],
  );
  const activeVehicles = ready?.vehicles.filter((vehicle) => vehicle.status === "ACTIVE") ?? [];

  function updateCampaign(updated: CampaignDetail) {
    setState((current) =>
      current.status === "ready"
        ? {
            ...current,
            campaigns: current.campaigns.map((campaign) =>
              campaign.id === updated.id ? updated : campaign,
            ),
          }
        : current,
    );
  }

  function handleMutationError(caught: unknown, setMessage: (message: string) => void) {
    const error =
      caught instanceof ApiError
        ? caught
        : new ApiError(0, "No fue posible completar la operación.");
    if (error.status === 401) {
      onUnauthorized();
      return;
    }
    setMessage(error.status === 409 ? describeCampaignConflict(error) : error.message);
  }

  async function createVehicle(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setVehicleBusy(true);
    setVehicleError("");
    setVehicleNotice("");
    try {
      const vehicle = await api.createVehicle(membership.crewId, {
        name: vehicleName,
        ...(vehicleRegistration.trim() ? { registration: vehicleRegistration } : {}),
      });
      setState((current) =>
        current.status === "ready"
          ? { ...current, vehicles: [...current.vehicles, vehicle] }
          : current,
      );
      setVehicleName("");
      setVehicleRegistration("");
      setSelectedVehicleId(vehicle.id);
      setVehicleNotice(`${vehicle.name} quedó disponible para asignar.`);
    } catch (caught) {
      handleMutationError(caught, setVehicleError);
    } finally {
      setVehicleBusy(false);
    }
  }

  async function createCampaign(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCampaignError("");
    setCampaignNotice("");
    if (startsOn && endsOn && startsOn > endsOn) {
      setCampaignError("La fecha de término no puede ser anterior a la de inicio.");
      return;
    }
    setCampaignBusy(true);
    try {
      const campaign = await api.createCampaign(membership.crewId, {
        name: campaignName,
        timezone: "America/Santiago",
        currency: "CLP",
        ...(startsOn ? { startsOn } : {}),
        ...(endsOn ? { endsOn } : {}),
      });
      setState((current) =>
        current.status === "ready"
          ? { ...current, campaigns: [campaign, ...current.campaigns] }
          : current,
      );
      setSelectedCampaignId(campaign.id);
      setCampaignName("");
      setStartsOn("");
      setEndsOn("");
      setCampaignNotice(`Campaña ${campaign.name} creada en borrador.`);
    } catch (caught) {
      handleMutationError(caught, setCampaignError);
    } finally {
      setCampaignBusy(false);
    }
  }

  async function assignRoute(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCampaign || !selectedRevisionId || !selectedVehicleId) return;
    setAssignmentBusy(true);
    setAssignmentError("");
    setAssignmentNotice("");
    try {
      const result = await api.assignCampaignRoute(membership.crewId, selectedCampaign.id, {
        routeRevisionId: selectedRevisionId,
        vehicleId: selectedVehicleId,
      });
      const updated = await api.getCampaign(membership.crewId, selectedCampaign.id);
      updateCampaign(updated);
      setAssignmentNotice(
        result.created
          ? `${result.assignment.routeName} quedó asignada a ${result.assignment.vehicle.name}.`
          : "Esa asignación ya estaba guardada; no se duplicó.",
      );
      setSelectedRevisionId("");
      setSelectedVehicleId("");
    } catch (caught) {
      handleMutationError(caught, setAssignmentError);
    } finally {
      setAssignmentBusy(false);
    }
  }

  async function removeRoute(campaignRouteId: string) {
    if (!selectedCampaign) return;
    setRemovingId(campaignRouteId);
    setAssignmentError("");
    setAssignmentNotice("");
    try {
      const updated = await api.removeCampaignRoute(
        membership.crewId,
        selectedCampaign.id,
        campaignRouteId,
      );
      updateCampaign(updated);
      setConfirmRemoveId("");
      setAssignmentNotice("La ruta se retiró del borrador.");
    } catch (caught) {
      handleMutationError(caught, setAssignmentError);
    } finally {
      setRemovingId("");
    }
  }

  async function activateCampaign() {
    if (!selectedCampaign) return;
    setActivating(true);
    setAssignmentError("");
    try {
      const updated = await api.activateCampaign(membership.crewId, selectedCampaign.id);
      updateCampaign(updated);
      setConfirmingActivation(false);
      setCampaignNotice(`${updated.name} está activa y su composición quedó bloqueada.`);
      window.setTimeout(() => campaignsHeadingRef.current?.focus(), 0);
    } catch (caught) {
      handleMutationError(caught, setAssignmentError);
    } finally {
      setActivating(false);
    }
  }

  return (
    <>
      <header className="page-heading">
        <p className="eyebrow">{membership.crewName}</p>
        <h1>Campañas y camiones</h1>
        <p>
          Reparte rutas publicadas entre camiones. La comprobación evita repetir el mismo
          identificador estable de punto o el mismo lado declarado; no deduce coincidencias por
          dirección, coordenadas ni proximidad.
        </p>
      </header>

      {state.status === "loading" ? <LoadingState label="Cargando campañas…" /> : null}
      {state.status === "error" ? (
        <ErrorState
          status={state.error.status}
          title={
            state.error.status === 403 ? "Acceso restringido" : "No pudimos cargar las campañas"
          }
          message={state.error.message}
          onRetry={state.error.status === 403 ? undefined : () => void load()}
        />
      ) : null}

      {ready ? (
        <div className="campaign-admin-grid">
          <section className="campaign-setup" aria-labelledby="campaign-setup-title">
            <h2 id="campaign-setup-title">Preparación</h2>

            <form className="campaign-compact-form" onSubmit={(event) => void createVehicle(event)}>
              <div className="section-heading">
                <span className="section-number" aria-hidden="true">
                  1
                </span>
                <div>
                  <h3>Camiones</h3>
                  <p>{activeVehicles.length} activos</p>
                </div>
              </div>
              <div className="field">
                <label htmlFor="vehicle-name">Nombre visible</label>
                <input
                  id="vehicle-name"
                  value={vehicleName}
                  onChange={(event) => setVehicleName(event.target.value)}
                  required
                  maxLength={120}
                  placeholder="Ej.: Camión Norte"
                />
              </div>
              <div className="field">
                <label htmlFor="vehicle-registration">Patente o código (opcional)</label>
                <input
                  id="vehicle-registration"
                  value={vehicleRegistration}
                  onChange={(event) => setVehicleRegistration(event.target.value)}
                  maxLength={32}
                  placeholder="Ej.: RC-02"
                />
              </div>
              {vehicleError ? (
                <p className="form-error" role="alert">
                  {vehicleError}
                </p>
              ) : null}
              {vehicleNotice ? (
                <p className="notice notice--success" role="status">
                  {vehicleNotice}
                </p>
              ) : null}
              <button className="button button--secondary" type="submit" disabled={vehicleBusy}>
                {vehicleBusy ? "Guardando…" : "Agregar camión"}
              </button>
              {ready.vehicles.length > 0 ? (
                <ul className="vehicle-list" aria-label="Camiones registrados">
                  {ready.vehicles.map((vehicle) => (
                    <li key={vehicle.id}>
                      <span>
                        <strong>{vehicle.name}</strong>
                        {vehicle.registration ? <small>{vehicle.registration}</small> : null}
                      </span>
                      <span
                        className={`status-pill status-pill--${vehicle.status.toLocaleLowerCase("en")}`}
                      >
                        {vehicle.status === "ACTIVE" ? "Activo" : "Archivado"}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </form>

            <form
              className="campaign-compact-form"
              onSubmit={(event) => void createCampaign(event)}
            >
              <div className="section-heading">
                <span className="section-number" aria-hidden="true">
                  2
                </span>
                <div>
                  <h3>Nueva campaña</h3>
                  <p>Se creará como borrador editable.</p>
                </div>
              </div>
              <div className="field">
                <label htmlFor="campaign-name">Nombre</label>
                <input
                  id="campaign-name"
                  value={campaignName}
                  onChange={(event) => setCampaignName(event.target.value)}
                  required
                  maxLength={160}
                  placeholder="Ej.: Campaña primavera 2026"
                />
              </div>
              <div className="campaign-date-grid">
                <div className="field">
                  <label htmlFor="campaign-start">Inicio (opcional)</label>
                  <input
                    id="campaign-start"
                    type="date"
                    value={startsOn}
                    onChange={(event) => setStartsOn(event.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="campaign-end">Término (opcional)</label>
                  <input
                    id="campaign-end"
                    type="date"
                    min={startsOn || undefined}
                    value={endsOn}
                    onChange={(event) => setEndsOn(event.target.value)}
                  />
                </div>
              </div>
              <p className="campaign-fixed-values">
                Zona horaria: <strong>America/Santiago</strong> · Moneda: <strong>CLP</strong>
              </p>
              {campaignError ? (
                <p className="form-error" role="alert">
                  {campaignError}
                </p>
              ) : null}
              {campaignNotice ? (
                <p className="notice notice--success" role="status">
                  {campaignNotice}
                </p>
              ) : null}
              <button className="button button--primary" type="submit" disabled={campaignBusy}>
                {campaignBusy ? "Creando…" : "Crear campaña"}
              </button>
            </form>
          </section>

          <section className="campaign-workspace" aria-labelledby="campaign-workspace-title">
            <header className="section-heading section-heading--between">
              <div>
                <p className="eyebrow">Composición operativa</p>
                <h2 ref={campaignsHeadingRef} id="campaign-workspace-title" tabIndex={-1}>
                  Campañas
                </h2>
              </div>
              <button className="button button--quiet" type="button" onClick={() => void load()}>
                Actualizar
              </button>
            </header>

            {ready.campaigns.length === 0 ? (
              <div className="campaign-empty">
                <strong>Aún no hay campañas</strong>
                <span>Crea un borrador para comenzar a repartir rutas.</span>
              </div>
            ) : (
              <ul className="campaign-tabs" aria-label="Campañas disponibles">
                {ready.campaigns.map((campaign) => (
                  <li key={campaign.id}>
                    <button
                      type="button"
                      aria-pressed={campaign.id === selectedCampaignId}
                      onClick={() => {
                        setSelectedCampaignId(campaign.id);
                        setAssignmentError("");
                        setAssignmentNotice("");
                        setConfirmRemoveId("");
                      }}
                    >
                      <span>
                        <strong>{campaign.name}</strong>
                        <small>
                          {campaign.routeCount} rutas · {campaign.pointCount} puntos
                        </small>
                      </span>
                      <span
                        className={`status-pill status-pill--${campaign.status.toLocaleLowerCase("en")}`}
                      >
                        {campaignStatusLabels[campaign.status]}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {selectedCampaign ? (
              <div className="campaign-detail">
                <header className="campaign-detail__header">
                  <div>
                    <h3>{selectedCampaign.name}</h3>
                    <p>
                      {formatCampaignDate(selectedCampaign.startsOn)} —{" "}
                      {formatCampaignDate(selectedCampaign.endsOn)}
                      {" · "}
                      {selectedCampaign.timezone}
                      {" · "}
                      {selectedCampaign.currency}
                    </p>
                  </div>
                  <span
                    className={`status-pill status-pill--${selectedCampaign.status.toLocaleLowerCase("en")}`}
                  >
                    {campaignStatusLabels[selectedCampaign.status]}
                  </span>
                </header>

                {selectedCampaign.status === "DRAFT" ? (
                  <form
                    className="campaign-assignment-form"
                    onSubmit={(event) => void assignRoute(event)}
                  >
                    <h3>Asignar ruta y camión</h3>
                    <div className="campaign-assignment-grid">
                      <div className="field">
                        <label htmlFor="campaign-route-revision">Revisión publicada</label>
                        <select
                          id="campaign-route-revision"
                          value={selectedRevisionId}
                          onChange={(event) => setSelectedRevisionId(event.target.value)}
                          required
                        >
                          <option value="">Selecciona una ruta</option>
                          {revisionOptions.map((option) => (
                            <option key={option.revision.id} value={option.revision.id}>
                              {revisionLabel(option)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label htmlFor="campaign-vehicle">Camión activo</label>
                        <select
                          id="campaign-vehicle"
                          value={selectedVehicleId}
                          onChange={(event) => setSelectedVehicleId(event.target.value)}
                          required
                        >
                          <option value="">Selecciona un camión</option>
                          {activeVehicles.map((vehicle) => (
                            <option key={vehicle.id} value={vehicle.id}>
                              {vehicle.name}
                              {vehicle.registration ? ` · ${vehicle.registration}` : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {revisionOptions.length === 0 ? (
                      <p className="notice notice--warning">
                        Primero publica una revisión de ruta.
                      </p>
                    ) : null}
                    {activeVehicles.length === 0 ? (
                      <p className="notice notice--warning">Primero registra un camión activo.</p>
                    ) : null}
                    {assignmentError && !confirmingActivation ? (
                      <p className="form-error" role="alert">
                        {assignmentError}
                      </p>
                    ) : null}
                    {assignmentNotice ? (
                      <p className="notice notice--success" role="status">
                        {assignmentNotice}
                      </p>
                    ) : null}
                    <button
                      className="button button--secondary"
                      type="submit"
                      disabled={
                        assignmentBusy ||
                        revisionOptions.length === 0 ||
                        activeVehicles.length === 0
                      }
                    >
                      {assignmentBusy ? "Comprobando cobertura…" : "Asignar a la campaña"}
                    </button>
                  </form>
                ) : (
                  <p className="notice campaign-readonly" role="status">
                    La composición está en estado {campaignStatusLabels[selectedCampaign.status]}.
                    Sus rutas y camiones son de solo lectura para conservar la trazabilidad.
                  </p>
                )}

                <div className="campaign-routes-heading">
                  <div>
                    <h3>Rutas asignadas</h3>
                    <p>
                      {selectedCampaign.routeCount} rutas · {selectedCampaign.pointCount} puntos
                    </p>
                  </div>
                  {selectedCampaign.status === "DRAFT" ? (
                    <button
                      ref={activationTriggerRef}
                      className="button button--primary"
                      type="button"
                      disabled={selectedCampaign.routes.length === 0}
                      onClick={() => {
                        setAssignmentError("");
                        setConfirmingActivation(true);
                      }}
                    >
                      Activar campaña
                    </button>
                  ) : null}
                </div>

                {selectedCampaign.routes.length === 0 ? (
                  <div className="campaign-empty">
                    <strong>Sin rutas asignadas</strong>
                    <span>El borrador necesita al menos una ruta con camión para activarse.</span>
                  </div>
                ) : (
                  <ul
                    className="campaign-route-cards"
                    aria-label={`Rutas de ${selectedCampaign.name}`}
                  >
                    {selectedCampaign.routes.map((assignment) => (
                      <li key={assignment.id}>
                        <div>
                          <strong>{assignment.routeName}</strong>
                          <span>
                            {assignment.vehicle.name}
                            {assignment.vehicle.registration
                              ? ` · ${assignment.vehicle.registration}`
                              : ""}
                          </span>
                          <small>
                            {assignment.pointCount} puntos · {assignment.segmentSideClaimCount}{" "}
                            {assignment.segmentSideClaimCount === 1 ? "lado" : "lados"} de calle
                          </small>
                          {ready.workSessions[assignment.id] ? (
                            <div className="campaign-session-summary">
                              <span
                                className={`status-pill status-pill--${ready.workSessions[
                                  assignment.id
                                ]?.status.toLocaleLowerCase("en")}`}
                              >
                                {ready.workSessions[assignment.id]?.status === "ACTIVE"
                                  ? "Jornada activa"
                                  : "Jornada finalizada"}
                              </span>
                              <small>
                                {ready.workSessions[assignment.id]?.participants.length ?? 0}{" "}
                                {(ready.workSessions[assignment.id]?.participants.length ?? 0) === 1
                                  ? "participante"
                                  : "participantes"}
                                {" · "}
                                {ready.workSessions[assignment.id]?.status === "ACTIVE"
                                  ? `iniciada ${formatSessionDate(
                                      ready.workSessions[assignment.id]?.startedAt ?? "",
                                    )}`
                                  : "reconciliación y cierre aún no disponibles"}
                              </small>
                            </div>
                          ) : selectedCampaign.status === "ACTIVE" ? (
                            <div className="campaign-session-summary campaign-session-summary--empty">
                              <span>Sin jornada iniciada</span>
                              <small>Se inicia y se une desde Campo con conexión.</small>
                            </div>
                          ) : null}
                        </div>
                        {selectedCampaign.status === "DRAFT" ? (
                          confirmRemoveId === assignment.id ? (
                            <fieldset
                              className="campaign-remove-confirm"
                              aria-label={`Confirmar retiro de ${assignment.routeName}`}
                            >
                              <legend>¿Retirar?</legend>
                              <button
                                className="button button--quiet"
                                type="button"
                                onClick={() => setConfirmRemoveId("")}
                                disabled={removingId === assignment.id}
                              >
                                Cancelar
                              </button>
                              <button
                                className="button button--danger"
                                type="button"
                                onClick={() => void removeRoute(assignment.id)}
                                disabled={removingId === assignment.id}
                              >
                                {removingId === assignment.id ? "Retirando…" : "Sí, retirar"}
                              </button>
                            </fieldset>
                          ) : (
                            <button
                              className="button button--quiet"
                              type="button"
                              onClick={() => setConfirmRemoveId(assignment.id)}
                            >
                              Retirar
                            </button>
                          )
                        ) : (
                          <span className="status-pill status-pill--active">Confirmada</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {confirmingActivation && selectedCampaign ? (
        <div className="campaign-modal-backdrop">
          <section
            ref={activationDialogRef}
            tabIndex={-1}
            className="publish-confirmation campaign-activation-confirmation"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="activate-campaign-title"
            aria-describedby="activate-campaign-description"
          >
            <div>
              <p className="eyebrow">Bloqueo de composición</p>
              <h2 id="activate-campaign-title">¿Activar {selectedCampaign.name}?</h2>
              <p id="activate-campaign-description">
                Se habilitarán {selectedCampaign.routeCount} rutas para terreno. Ya no podrás
                cambiar sus camiones, puntos identificados ni lados de calle declarados.
              </p>
              {assignmentError ? (
                <p className="form-error" role="alert">
                  {assignmentError}
                </p>
              ) : null}
            </div>
            <div className="button-row">
              <button
                ref={activationCancelRef}
                className="button button--secondary"
                type="button"
                disabled={activating}
                onClick={() => {
                  setConfirmingActivation(false);
                  window.setTimeout(() => activationTriggerRef.current?.focus(), 0);
                }}
              >
                Cancelar
              </button>
              <button
                className="button button--primary"
                type="button"
                disabled={activating}
                onClick={() => void activateCampaign()}
              >
                {activating ? "Activando…" : "Confirmar y activar"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
