import type { PointState } from "./types";

export const POINT_STATE_OPTIONS: Array<{ label: string; state: PointState; symbol: string }> = [
  { label: "Sin visitar", state: "SIN_VISITAR", symbol: "○" },
  { label: "Sobre entregado", state: "SOBRE_ENTREGADO", symbol: "✓" },
  { label: "Volver", state: "VOLVER", symbol: "↩" },
  { label: "Sin respuesta", state: "SIN_RESPUESTA", symbol: "?" },
  { label: "Aportó", state: "APORTO", symbol: "$" },
  { label: "No participa", state: "NO_PARTICIPA", symbol: "×" },
];

export const POINT_STATE_LABELS: Record<PointState, string> = Object.fromEntries(
  POINT_STATE_OPTIONS.map((option) => [option.state, option.label]),
) as Record<PointState, string>;

export type PointFeedback = {
  kind: "error" | "saving" | "success";
  message: string;
  pointId: string;
};
