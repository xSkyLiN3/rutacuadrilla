import { describe, expect, it } from "vitest";
import { demoFlagForRuntime, FIELD_DEV_HOST, FIELD_DEV_PORT, FIELD_ENV_DIR } from "./vite.config";

describe("configuración Vite de Campo", () => {
  it("lee el entorno raíz y conserva el puerto local", () => {
    expect(FIELD_ENV_DIR).toBe("../../");
    expect(FIELD_DEV_HOST).toBe("127.0.0.1");
    expect(FIELD_DEV_PORT).toBe(4312);
  });

  it("respeta .env en desarrollo y desactiva demo en un build normal", () => {
    expect(demoFlagForRuntime("serve", "development", " true ")).toBe("true");
    expect(demoFlagForRuntime("serve", "development", "false")).toBe("false");
    expect(demoFlagForRuntime("serve", "demo")).toBe("true");
    expect(demoFlagForRuntime("build", "production", "true")).toBe("false");
    expect(demoFlagForRuntime("build", "demo", "false")).toBe("true");
  });
});
