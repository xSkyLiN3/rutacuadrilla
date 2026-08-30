import type { ConflictResolutionDecision, LocalOperation } from "./types";

interface HistoryPanelProps {
  busy: boolean;
  conflictReasons: Record<string, string>;
  history: LocalOperation[];
  workSessionId?: string;
  onReasonChange: (operationId: string, reason: string) => void;
  onResolve: (operation: LocalOperation, decision: ConflictResolutionDecision) => void;
}

function historyStateLabel(state: LocalOperation["state"]): string {
  const labels: Record<LocalOperation["state"], string> = {
    CONFIRMED: "Confirmado",
    CONFLICT: "Conflicto",
    PENDING: "Pendiente local",
    REJECTED: "Rechazado",
    SENDING: "Enviando",
    SUPERSEDED: "Reemplazado",
  };
  return labels[state];
}

function uniqueByOperationId(operations: LocalOperation[]): LocalOperation[] {
  const seen = new Set<string>();
  return operations.filter((operation) => {
    if (seen.has(operation.operationId)) return false;
    seen.add(operation.operationId);
    return true;
  });
}

export function selectHistorySections(history: LocalOperation[]): {
  attention: LocalOperation[];
  recent: LocalOperation[];
} {
  const attention = uniqueByOperationId(
    history.filter((operation) => operation.state === "CONFLICT" || operation.state === "REJECTED"),
  );
  const attentionIds = new Set(attention.map((operation) => operation.operationId));
  return {
    attention,
    recent: uniqueByOperationId(
      history.filter((operation) => !attentionIds.has(operation.operationId)),
    ).slice(0, 12),
  };
}

function ResolutionControls({
  busy,
  operation,
  reason,
  onReasonChange,
  onResolve,
  resolutionBlocked,
}: {
  busy: boolean;
  operation: LocalOperation;
  reason: string;
  onReasonChange: (reason: string) => void;
  onResolve: (decision: ConflictResolutionDecision) => void;
  resolutionBlocked: boolean;
}) {
  return (
    <div className="conflict-resolution">
      <p>
        El servidor confirma{" "}
        <strong>{operation.canonicalState?.replaceAll("_", " ") ?? "sin dato"}</strong>
        {operation.canonicalVersion !== undefined ? ` (versión ${operation.canonicalVersion})` : ""}
        . Tu decisión fue <strong>{operation.toState.replaceAll("_", " ")}</strong>.
      </p>
      {operation.conflictCode ? <small>Código: {operation.conflictCode}</small> : null}
      {resolutionBlocked ? (
        <p className="history-item__attention">
          Operación heredada conservada: no es atribuible a la jornada activa y no puede resolverse
          desde este flujo.
        </p>
      ) : null}
      <label>
        Motivo de la resolución
        <textarea
          maxLength={500}
          value={reason}
          onChange={(event) => onReasonChange(event.currentTarget.value)}
        />
      </label>
      <div className="conflict-resolution__actions">
        <button
          type="button"
          disabled={busy || resolutionBlocked || !reason.trim()}
          onClick={() => onResolve("ACCEPT_SERVER")}
        >
          Aceptar servidor
        </button>
        <button
          type="button"
          disabled={
            busy ||
            resolutionBlocked ||
            !reason.trim() ||
            operation.toState === operation.canonicalState
          }
          onClick={() => onResolve("REAPPLY_LOCAL")}
        >
          Reaplicar mi decisión
        </button>
      </div>
    </div>
  );
}

function HistoryOperationItem({
  busy,
  operation,
  reason,
  onReasonChange,
  onResolve,
  workSessionId,
}: {
  busy: boolean;
  operation: LocalOperation;
  reason: string;
  onReasonChange: (reason: string) => void;
  onResolve: (decision: ConflictResolutionDecision) => void;
  workSessionId?: string;
}) {
  const rejectedRetryCanBeResolved =
    operation.state === "REJECTED" && Boolean(operation.resolvesOperationId);
  const unresolvedDecision =
    !operation.resolutionDecision && (operation.state === "CONFLICT" || rejectedRetryCanBeResolved);

  return (
    <li className={operation.state === "CONFLICT" ? "history-item--conflict" : undefined}>
      <div className="history-item__summary">
        <span>{operation.toState.replaceAll("_", " ")}</span>
        <strong>{historyStateLabel(operation.state)}</strong>
      </div>
      {operation.resolutionDecision ? (
        <small>
          Resolución registrada: {operation.resolutionDecision.replaceAll("_", " ")} ·{" "}
          {operation.resolutionReason}
        </small>
      ) : null}
      {operation.resolutionConverged ? (
        <p className="history-item__attention">
          El servidor ya estaba en tu estado elegido. La cadena quedó cerrada como convergida, sin
          crear un evento remoto adicional.
        </p>
      ) : null}
      {operation.state === "REJECTED" && !operation.resolvesOperationId ? (
        <p className="history-item__attention">
          El servidor no aplicó esta operación
          {operation.conflictCode ? ` (${operation.conflictCode})` : ""}. No existe un estado
          canónico suficiente para resolverla como conflicto: sincroniza para actualizar el punto y
          vuelve a registrar la decisión si corresponde.
        </p>
      ) : null}
      {operation.resolutionDecision &&
      (operation.state === "CONFLICT" || operation.state === "REJECTED") ? (
        <p>
          {operation.resolutionOperationState === "CONFLICT" ||
          operation.resolutionOperationState === "REJECTED"
            ? "El reintento también requiere atención. Esta entrada se conserva; revisa la nueva decisión disponible."
            : "La elección ya fue guardada; sincroniza el nuevo intento."}
        </p>
      ) : null}
      {unresolvedDecision ? (
        <ResolutionControls
          busy={busy}
          operation={operation}
          reason={reason}
          onReasonChange={onReasonChange}
          onResolve={onResolve}
          resolutionBlocked={
            workSessionId !== undefined && operation.workSessionId !== workSessionId
          }
        />
      ) : null}
    </li>
  );
}

export function HistoryPanel({
  busy,
  conflictReasons,
  history,
  onReasonChange,
  onResolve,
  workSessionId,
}: HistoryPanelProps) {
  const { attention, recent } = selectHistorySections(history);
  const renderOperation = (operation: LocalOperation) => (
    <HistoryOperationItem
      key={operation.operationId}
      busy={busy}
      operation={operation}
      reason={conflictReasons[operation.operationId] ?? ""}
      onReasonChange={(reason) => onReasonChange(operation.operationId, reason)}
      onResolve={(decision) => onResolve(operation, decision)}
      workSessionId={workSessionId}
    />
  );

  return (
    <section className="history-panel" aria-labelledby="history-title">
      <h2 id="history-title">Historial local</h2>
      {attention.length > 0 ? (
        <section aria-labelledby="attention-title">
          <h3 id="attention-title">Atención ({attention.length})</h3>
          <ul aria-label="Operaciones que requieren atención">{attention.map(renderOperation)}</ul>
        </section>
      ) : null}
      <section aria-labelledby="recent-title">
        <h3 id="recent-title">Recientes</h3>
        <ul aria-label="Operaciones recientes">{recent.map(renderOperation)}</ul>
      </section>
    </section>
  );
}
