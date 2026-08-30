import { createHash } from "node:crypto";

const FINAL_STATES = new Set(["APORTO", "NO_PARTICIPA"]);

function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function operationPayload(operation) {
  return {
    aggregateId: operation.aggregateId,
    baseVersion: operation.baseVersion,
    dependsOnOperationId: operation.dependsOnOperationId ?? null,
    toState: operation.toState,
  };
}

export function payloadHash(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export class SyncServer {
  constructor({ crewId = "crew-1", initialPoints = {} } = {}) {
    this.crewId = crewId;
    this.points = new Map(
      Object.entries(initialPoints).map(([id, state]) => [
        id,
        { id, state, version: 0 },
      ]),
    );
    this.processed = new Map();
    this.events = [];
    this.conflicts = [];
    this.quarantine = [];
    this.sessionState = "ACTIVE";
  }

  getPoint(id) {
    if (!this.points.has(id)) {
      this.points.set(id, { id, state: "SIN_VISITAR", version: 0 });
    }
    return this.points.get(id);
  }

  finishSession() {
    if (this.sessionState !== "ACTIVE") {
      throw new Error(`No se puede finalizar desde ${this.sessionState}`);
    }
    this.sessionState = "FINISHED";
  }

  beginReconciliation() {
    if (this.sessionState !== "FINISHED") {
      throw new Error(`No se puede reconciliar desde ${this.sessionState}`);
    }
    this.sessionState = "RECONCILING";
  }

  closeSession() {
    if (this.sessionState !== "RECONCILING") {
      throw new Error(`No se puede cerrar desde ${this.sessionState}`);
    }
    this.sessionState = "CLOSED";
  }

  processBatch(operations) {
    const pending = [...operations];
    const results = [];

    while (pending.length > 0) {
      let progressed = false;

      for (let index = 0; index < pending.length; index += 1) {
        const operation = pending[index];
        const dependency = operation.dependsOnOperationId;
        const dependencyStillPending = dependency
          ? pending.some((candidate) => candidate.operationId === dependency)
          : false;

        if (dependencyStillPending) {
          continue;
        }

        results.push(this.processOperation(operation));
        pending.splice(index, 1);
        index -= 1;
        progressed = true;
      }

      if (!progressed) {
        for (const operation of pending.splice(0)) {
          results.push(
            this.remember(operation, {
              operationId: operation.operationId,
              status: "REJECTED_DEPENDENCY_CYCLE",
            }),
          );
        }
      }
    }

    return results;
  }

  processOperation(operation) {
    if (operation.crewId !== this.crewId) {
      return {
        operationId: operation.operationId,
        status: "FORBIDDEN_CREW",
      };
    }

    const key = `${operation.crewId}:${operation.operationId}`;
    const hash = payloadHash(operationPayload(operation));
    const previous = this.processed.get(key);

    if (previous) {
      if (previous.hash !== hash) {
        return {
          operationId: operation.operationId,
          status: "IDEMPOTENCY_KEY_REUSED",
        };
      }
      return { ...previous.result, replayed: true };
    }

    if (this.sessionState === "CLOSED") {
      const result = {
        operationId: operation.operationId,
        status: "LATE_AFTER_CLOSE",
      };
      this.quarantine.push({ ...operation, reason: result.status });
      return this.remember(operation, result, hash);
    }

    const point = this.getPoint(operation.aggregateId);
    let expectedVersion = operation.baseVersion;

    if (operation.dependsOnOperationId) {
      const dependencyKey = `${operation.crewId}:${operation.dependsOnOperationId}`;
      const dependency = this.processed.get(dependencyKey);

      if (!dependency || dependency.result.status !== "APPLIED") {
        return this.remember(
          operation,
          {
            operationId: operation.operationId,
            status: "REJECTED_MISSING_DEPENDENCY",
          },
          hash,
        );
      }

      if (dependency.aggregateId !== operation.aggregateId) {
        return this.remember(
          operation,
          {
            operationId: operation.operationId,
            status: "REJECTED_WRONG_DEPENDENCY",
          },
          hash,
        );
      }

      expectedVersion = dependency.result.version;
    }

    if (point.version !== expectedVersion) {
      const result = {
        operationId: operation.operationId,
        status: "CONFLICT",
        canonicalState: point.state,
        canonicalVersion: point.version,
        requestedState: operation.toState,
      };
      this.conflicts.push({ ...operation, ...result });
      return this.remember(operation, result, hash);
    }

    point.state = operation.toState;
    point.version += 1;

    const result = {
      operationId: operation.operationId,
      status: "APPLIED",
      state: point.state,
      version: point.version,
    };
    this.events.push({
      crewId: operation.crewId,
      operationId: operation.operationId,
      pointId: operation.aggregateId,
      state: operation.toState,
      version: point.version,
      isFinal: FINAL_STATES.has(operation.toState),
    });
    return this.remember(operation, result, hash);
  }

  remember(operation, result, knownHash) {
    const key = `${operation.crewId}:${operation.operationId}`;
    this.processed.set(key, {
      aggregateId: operation.aggregateId,
      hash: knownHash ?? payloadHash(operationPayload(operation)),
      result,
    });
    return result;
  }
}

export class DeviceOutbox {
  constructor({ crewId, deviceId, snapshot } = {}) {
    this.crewId = crewId ?? snapshot?.crewId;
    this.deviceId = deviceId ?? snapshot?.deviceId;
    this.sequence = snapshot?.sequence ?? 0;
    this.pending = snapshot?.pending ? structuredClone(snapshot.pending) : [];
    this.lastOperationByAggregate = new Map(snapshot?.lastOperationByAggregate ?? []);
    this.knownVersions = new Map(snapshot?.knownVersions ?? []);
  }

  mark({ aggregateId, toState, operationId }) {
    this.sequence += 1;
    const dependency = this.lastOperationByAggregate.get(aggregateId) ?? null;
    const operation = {
      crewId: this.crewId,
      deviceId: this.deviceId,
      deviceSequence: this.sequence,
      operationId: operationId ?? `${this.deviceId}-${this.sequence}`,
      aggregateId,
      baseVersion: this.knownVersions.get(aggregateId) ?? 0,
      dependsOnOperationId: dependency,
      toState,
    };
    this.pending.push(operation);
    this.lastOperationByAggregate.set(aggregateId, operation.operationId);
    return operation;
  }

  acknowledge(results) {
    const resultById = new Map(results.map((result) => [result.operationId, result]));
    this.pending = this.pending.filter((operation) => {
      const result = resultById.get(operation.operationId);
      if (!result || (result.status !== "APPLIED" && !result.replayed)) {
        return true;
      }
      this.knownVersions.set(operation.aggregateId, result.version);
      if (this.lastOperationByAggregate.get(operation.aggregateId) === operation.operationId) {
        this.lastOperationByAggregate.delete(operation.aggregateId);
      }
      return false;
    });
  }

  snapshot() {
    return {
      crewId: this.crewId,
      deviceId: this.deviceId,
      sequence: this.sequence,
      pending: structuredClone(this.pending),
      lastOperationByAggregate: [...this.lastOperationByAggregate],
      knownVersions: [...this.knownVersions],
    };
  }
}

export class ReconciliationBarrier {
  constructor(requiredDeviceIds) {
    this.requiredDeviceIds = new Set(requiredDeviceIds);
    this.checkpoints = new Map();
  }

  checkpoint({ deviceId, pendingCount, projectionHash, cursor }) {
    if (!this.requiredDeviceIds.has(deviceId)) {
      throw new Error(`Dispositivo no participante: ${deviceId}`);
    }
    this.checkpoints.set(deviceId, { pendingCount, projectionHash, cursor });
  }

  status() {
    const missing = [...this.requiredDeviceIds].filter(
      (deviceId) => !this.checkpoints.has(deviceId),
    );
    const dirty = [...this.checkpoints]
      .filter(([, checkpoint]) => checkpoint.pendingCount !== 0)
      .map(([deviceId]) => deviceId);
    const hashes = new Set(
      [...this.checkpoints.values()].map((checkpoint) => checkpoint.projectionHash),
    );
    return {
      canClose: missing.length === 0 && dirty.length === 0 && hashes.size === 1,
      dirty,
      missing,
      projectionsConverged: hashes.size <= 1,
    };
  }
}

function requireClpAmount(value) {
  if (typeof value !== "bigint" || value < 0n) {
    throw new TypeError("El monto CLP debe ser un bigint no negativo");
  }
}

export function splitClp(gross, participantIds) {
  requireClpAmount(gross);
  if (!Array.isArray(participantIds) || participantIds.length === 0) {
    throw new TypeError("Se requiere al menos un participante");
  }
  if (new Set(participantIds).size !== participantIds.length) {
    throw new TypeError("Los participantes no pueden repetirse");
  }

  const count = BigInt(participantIds.length);
  const base = gross / count;
  const remainder = Number(gross % count);
  return participantIds.map((participantId, index) => ({
    participantId,
    amount: base + (index < remainder ? 1n : 0n),
  }));
}

export function validateClosure({ gross, currency, distributions }) {
  requireClpAmount(gross);
  if (currency !== "CLP") {
    throw new TypeError("El spike P0 solo acepta CLP");
  }
  if (!Array.isArray(distributions) || distributions.length === 0) {
    throw new TypeError("Se requiere distribución");
  }
  for (const distribution of distributions) {
    requireClpAmount(distribution.amount);
  }
  const distributed = distributions.reduce((sum, item) => sum + item.amount, 0n);
  return {
    distributed,
    difference: gross - distributed,
    valid: gross === distributed,
  };
}
