import { useEffect, useId, useRef } from "react";
import { POINT_STATE_LABELS, POINT_STATE_OPTIONS, type PointFeedback } from "./pointStates";
import type { FieldPoint, PointState } from "./types";

interface PointStatePanelProps {
  className: string;
  feedback?: PointFeedback | null;
  online: boolean;
  onClose(): void;
  onSetState(point: FieldPoint, state: PointState): void;
  point: FieldPoint;
  savingState?: PointState | null;
}

function pointAddress(point: FieldPoint): string {
  return [point.street, point.number].filter(Boolean).join(" ") || point.externalId;
}

export function PointStatePanel({
  className,
  feedback,
  online,
  onClose,
  onSetState,
  point,
  savingState,
}: PointStatePanelProps) {
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const saving = feedback?.kind === "saving";

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  return (
    <section aria-busy={saving} aria-labelledby={titleId} className={className} role="dialog">
      <div className="simple-point-sheet__heading">
        <div>
          <p className="eyebrow">Vivienda</p>
          <h2 id={titleId} ref={titleRef} tabIndex={-1}>
            {pointAddress(point)}
          </h2>
          <span>{point.externalId}</span>
        </div>
        <button aria-label="Cerrar" disabled={saving} onClick={onClose} type="button">
          ×
        </button>
      </div>
      <p>
        Estado actual: <strong>{POINT_STATE_LABELS[point.state]}</strong>
      </p>
      {!online ? (
        <p className="simple-point-feedback simple-point-feedback--error" role="alert">
          Sin conexión. Conéctate para guardar.
        </p>
      ) : feedback ? (
        <p
          className={`simple-point-feedback simple-point-feedback--${feedback.kind}`}
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </p>
      ) : (
        <p className="simple-point-help">Elige un estado; se guardará sin salir del mapa.</p>
      )}
      <fieldset className="simple-point-actions">
        <legend className="sr-only">Cambiar estado de la vivienda</legend>
        {POINT_STATE_OPTIONS.map((option) => (
          <button
            aria-pressed={point.state === option.state}
            data-state={option.state}
            disabled={!online || saving}
            key={option.state}
            onClick={() => onSetState(point, option.state)}
            type="button"
          >
            <span aria-hidden="true">{option.symbol}</span>
            {saving && savingState === option.state ? "Guardando…" : option.label}
          </button>
        ))}
      </fieldset>
    </section>
  );
}
