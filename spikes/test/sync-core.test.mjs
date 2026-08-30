import assert from "node:assert/strict";
import test from "node:test";

import {
  DeviceOutbox,
  ReconciliationBarrier,
  SyncServer,
  splitClp,
  validateClosure,
} from "../src/sync-core.mjs";

test("dos acciones offline causales del mismo teléfono no crean conflicto falso", () => {
  const server = new SyncServer({ initialPoints: { "point-1": "SIN_VISITAR" } });
  const device = new DeviceOutbox({ crewId: "crew-1", deviceId: "phone-a" });

  device.mark({ aggregateId: "point-1", toState: "VOLVER", operationId: "op-101" });
  device.mark({ aggregateId: "point-1", toState: "APORTO", operationId: "op-102" });

  const results = server.processBatch(device.pending);

  assert.deepEqual(results.map((result) => result.status), ["APPLIED", "APPLIED"]);
  assert.equal(server.getPoint("point-1").state, "APORTO");
  assert.equal(server.getPoint("point-1").version, 2);
});

test("un reintento con igual operationId y payload no duplica el efecto", () => {
  const server = new SyncServer();
  const operation = {
    crewId: "crew-1",
    deviceId: "phone-a",
    operationId: "same-op",
    aggregateId: "point-1",
    baseVersion: 0,
    toState: "VOLVER",
  };

  const first = server.processOperation(operation);
  const replay = server.processOperation(structuredClone(operation));

  assert.equal(first.status, "APPLIED");
  assert.equal(replay.status, "APPLIED");
  assert.equal(replay.replayed, true);
  assert.equal(server.events.length, 1);
  assert.equal(server.getPoint("point-1").version, 1);
});

test("reutilizar operationId con otro payload se rechaza", () => {
  const server = new SyncServer();
  const original = {
    crewId: "crew-1",
    operationId: "same-op",
    aggregateId: "point-1",
    baseVersion: 0,
    toState: "VOLVER",
  };
  server.processOperation(original);

  const result = server.processOperation({ ...original, toState: "APORTO" });

  assert.equal(result.status, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(server.events.length, 1);
});

test("dos teléfonos con la misma versión base producen un conflicto visible", () => {
  const server = new SyncServer();
  const first = server.processOperation({
    crewId: "crew-1",
    operationId: "phone-a-1",
    aggregateId: "point-1",
    baseVersion: 0,
    toState: "APORTO",
  });
  const second = server.processOperation({
    crewId: "crew-1",
    operationId: "phone-b-1",
    aggregateId: "point-1",
    baseVersion: 0,
    toState: "NO_PARTICIPA",
  });

  assert.equal(first.status, "APPLIED");
  assert.equal(second.status, "CONFLICT");
  assert.equal(second.canonicalState, "APORTO");
  assert.equal(server.conflicts.length, 1);
});

test("el perfil lógico de 100 operaciones no pierde ni duplica efectos", () => {
  const server = new SyncServer();
  const phoneA = Array.from({ length: 50 }, (_, index) => ({
    crewId: "crew-1",
    deviceId: "phone-a",
    operationId: `phone-a-${index + 1}`,
    aggregateId: `point-${index + 1}`,
    baseVersion: 0,
    toState: "VOLVER",
  }));
  const phoneB = Array.from({ length: 50 }, (_, index) => ({
    crewId: "crew-1",
    deviceId: "phone-b",
    operationId: `phone-b-${index + 1}`,
    aggregateId: `point-${index + 50}`,
    baseVersion: 0,
    toState: "APORTO",
  }));

  const firstResults = [
    ...server.processBatch(phoneA),
    ...server.processBatch(phoneB),
  ];
  const replayResults = [
    ...server.processBatch(phoneA),
    ...server.processBatch(phoneB),
  ];

  assert.equal(firstResults.filter((result) => result.status === "APPLIED").length, 99);
  assert.equal(firstResults.filter((result) => result.status === "CONFLICT").length, 1);
  assert.equal(replayResults.filter((result) => result.replayed).length, 100);
  assert.equal(server.processed.size, 100);
  assert.equal(server.events.length, 99);
  assert.equal(new Set(server.events.map((event) => event.operationId)).size, 99);
  assert.equal(server.conflicts.length, 1);
});

test("la outbox sobrevive una serialización equivalente a reinicio", () => {
  const beforeRestart = new DeviceOutbox({ crewId: "crew-1", deviceId: "phone-a" });
  beforeRestart.mark({ aggregateId: "point-1", toState: "VOLVER" });
  const persistedJson = JSON.stringify(beforeRestart.snapshot());

  const afterRestart = new DeviceOutbox({ snapshot: JSON.parse(persistedJson) });

  assert.equal(afterRestart.pending.length, 1);
  assert.equal(afterRestart.pending[0].toState, "VOLVER");
  assert.equal(afterRestart.deviceId, "phone-a");
});

test("una operación nueva recibida tras el cierre queda en cuarentena", () => {
  const server = new SyncServer();
  server.finishSession();
  server.beginReconciliation();
  server.closeSession();

  const result = server.processOperation({
    crewId: "crew-1",
    operationId: "late-op",
    aggregateId: "point-1",
    baseVersion: 0,
    toState: "VOLVER",
  });

  assert.equal(result.status, "LATE_AFTER_CLOSE");
  assert.equal(server.events.length, 0);
  assert.equal(server.quarantine.length, 1);
});

test("la barrera impide cerrar si falta o está pendiente un dispositivo", () => {
  const barrier = new ReconciliationBarrier(["phone-a", "phone-b"]);
  barrier.checkpoint({
    deviceId: "phone-a",
    pendingCount: 0,
    projectionHash: "hash-1",
    cursor: 20,
  });
  assert.deepEqual(barrier.status().missing, ["phone-b"]);
  assert.equal(barrier.status().canClose, false);

  barrier.checkpoint({
    deviceId: "phone-b",
    pendingCount: 2,
    projectionHash: "hash-1",
    cursor: 20,
  });
  assert.deepEqual(barrier.status().dirty, ["phone-b"]);
  assert.equal(barrier.status().canClose, false);

  barrier.checkpoint({
    deviceId: "phone-b",
    pendingCount: 0,
    projectionHash: "hash-1",
    cursor: 20,
  });
  assert.equal(barrier.status().canClose, true);
});

test("la barrera exige que las proyecciones converjan", () => {
  const barrier = new ReconciliationBarrier(["phone-a", "phone-b"]);
  barrier.checkpoint({
    deviceId: "phone-a",
    pendingCount: 0,
    projectionHash: "hash-a",
    cursor: 20,
  });
  barrier.checkpoint({
    deviceId: "phone-b",
    pendingCount: 0,
    projectionHash: "hash-b",
    cursor: 20,
  });

  assert.equal(barrier.status().projectionsConverged, false);
  assert.equal(barrier.status().canClose, false);
});

test("el reparto CLP asigna el resto por orden y conserva el total exacto", () => {
  const distributions = splitClp(10_000n, ["ana", "beto", "carla"]);

  assert.deepEqual(distributions, [
    { participantId: "ana", amount: 3_334n },
    { participantId: "beto", amount: 3_333n },
    { participantId: "carla", amount: 3_333n },
  ]);
  assert.deepEqual(
    validateClosure({ gross: 10_000n, currency: "CLP", distributions }),
    { distributed: 10_000n, difference: 0n, valid: true },
  );
});

test("un cierre con diferencia no puede considerarse válido", () => {
  const result = validateClosure({
    gross: 10_000n,
    currency: "CLP",
    distributions: [
      { participantId: "ana", amount: 5_000n },
      { participantId: "beto", amount: 4_999n },
    ],
  });

  assert.equal(result.valid, false);
  assert.equal(result.difference, 1n);
});
