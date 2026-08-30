import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldLocalDatabase } from "./database";

class FakeWorker extends EventTarget {
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("FieldLocalDatabase worker watchdog", () => {
  it("termina una inicializacion que no responde con recuperacion accionable", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const database = new FieldLocalDatabase({
      requestTimeoutMs: 25,
      worker: worker as unknown as Worker,
    });

    const assertion = expect(database.init()).rejects.toThrow(
      /LOCAL_DATABASE_WORKER_TIMEOUT.*OPFS y la outbox no se borraron/u,
    );
    await vi.advanceTimersByTimeAsync(25);

    await assertion;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rechaza todas las solicitudes si el worker emite messageerror", async () => {
    const worker = new FakeWorker();
    const database = new FieldLocalDatabase({
      requestTimeoutMs: 1_000,
      worker: worker as unknown as Worker,
    });
    const initialization = database.init();
    const history = database.listHistory("account", "crew", "session");

    worker.dispatchEvent(new MessageEvent("messageerror"));

    await expect(initialization).rejects.toThrow(/LOCAL_DATABASE_WORKER_MESSAGE_ERROR/u);
    await expect(history).rejects.toThrow(/LOCAL_DATABASE_WORKER_MESSAGE_ERROR/u);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
