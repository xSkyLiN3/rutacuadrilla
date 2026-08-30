import type { LocalOperation } from "../types";

export type ConnectionPhase = "attention" | "offline" | "online" | "syncing";

export function syncStatusLabel(phase: ConnectionPhase, operations: LocalOperation[]): string {
  const attention = operations.filter((operation) =>
    ["CONFLICT", "REJECTED"].includes(operation.state),
  ).length;
  if (attention > 0) {
    return `Requiere atención · ${attention} conflicto${attention === 1 ? "" : "s"}/rechazo${attention === 1 ? "" : "s"}`;
  }
  if (phase === "attention") return "Requiere atención";
  const pending = operations.filter((operation) =>
    ["PENDING", "SENDING"].includes(operation.state),
  ).length;
  if (phase === "syncing") return "Sincronizando";
  if (phase === "offline") return `Sin conexión · ${pending} pendiente${pending === 1 ? "" : "s"}`;
  return pending === 0 ? "Sincronizado" : `${pending} pendiente${pending === 1 ? "" : "s"}`;
}
