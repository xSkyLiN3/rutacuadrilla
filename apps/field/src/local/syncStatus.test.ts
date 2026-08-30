import { describe, expect, it } from "vitest";
import type { LocalOperation } from "../types";
import { syncStatusLabel } from "./syncStatus";

const pending: LocalOperation = {
  accountId: "user-1",
  aggregateId: "point-1",
  baseVersion: 0,
  crewId: "crew-1",
  deviceId: "phone-1",
  deviceSequence: 1,
  operationId: "op-1",
  previousState: "SIN_VISITAR",
  state: "PENDING",
  toState: "VOLVER",
};

describe("syncStatusLabel", () => {
  it("distingue sincronizado, desconectado, sincronizando y atención", () => {
    expect(syncStatusLabel("online", [])).toBe("Sincronizado");
    expect(syncStatusLabel("offline", [pending])).toBe("Sin conexión · 1 pendiente");
    expect(syncStatusLabel("syncing", [pending])).toBe("Sincronizando");
    expect(syncStatusLabel("attention", [])).toBe("Requiere atención");
    expect(syncStatusLabel("online", [{ ...pending, state: "CONFLICT" }])).toBe(
      "Requiere atención · 1 conflicto/rechazo",
    );
  });
});
