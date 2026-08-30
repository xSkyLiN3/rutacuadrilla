import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteOutboxStore } from "../src/sqlite-store.mjs";

function withTemporaryDatabase(callback) {
  const directory = mkdtempSync(join(tmpdir(), "rutacuadrilla-sqlite-"));
  const filename = join(directory, "offline.db");
  try {
    callback(filename);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test("la proyección y la outbox sobreviven al cierre y reapertura de SQLite", () => {
  withTemporaryDatabase((filename) => {
    let store = new SqliteOutboxStore(filename);
    store.recordPointState({
      crewId: "crew-1",
      deviceId: "phone-a",
      deviceSequence: 1,
      operationId: "op-1",
      pointId: "point-1",
      toState: "VOLVER",
      payloadHash: "hash-1",
    });
    store.close();

    store = new SqliteOutboxStore(filename);
    assert.equal(store.getPoint("crew-1", "point-1").state, "VOLVER");
    assert.equal(store.listPending("crew-1").length, 1);
    assert.equal(store.listPending("crew-1")[0].operationId, "op-1");
    store.close();
  });
});

test("proyección y outbox cambian atómicamente o ambas hacen rollback", () => {
  withTemporaryDatabase((filename) => {
    const store = new SqliteOutboxStore(filename);
    store.recordPointState({
      crewId: "crew-1",
      deviceId: "phone-a",
      deviceSequence: 1,
      operationId: "op-1",
      pointId: "point-1",
      toState: "VOLVER",
      payloadHash: "hash-1",
    });

    assert.throws(() =>
      store.recordPointState({
        crewId: "crew-1",
        deviceId: "phone-a",
        deviceSequence: 2,
        operationId: "op-1",
        pointId: "point-1",
        toState: "APORTO",
        payloadHash: "different-hash",
      }),
    );

    assert.equal(store.getPoint("crew-1", "point-1").state, "VOLVER");
    assert.equal(store.listPending("crew-1").length, 1);
    store.close();
  });
});

test("las consultas locales están particionadas por tripulación", () => {
  withTemporaryDatabase((filename) => {
    const store = new SqliteOutboxStore(filename);
    store.recordPointState({
      crewId: "crew-1",
      deviceId: "phone-a",
      deviceSequence: 1,
      operationId: "op-1",
      pointId: "point-1",
      toState: "VOLVER",
      payloadHash: "hash-a",
    });
    store.recordPointState({
      crewId: "crew-2",
      deviceId: "phone-a",
      deviceSequence: 1,
      operationId: "op-1",
      pointId: "point-1",
      toState: "APORTO",
      payloadHash: "hash-b",
    });

    assert.equal(store.getPoint("crew-1", "point-1").state, "VOLVER");
    assert.equal(store.getPoint("crew-2", "point-1").state, "APORTO");
    assert.equal(store.listPending("crew-1").length, 1);
    assert.equal(store.listPending("crew-2").length, 1);
    store.close();
  });
});
