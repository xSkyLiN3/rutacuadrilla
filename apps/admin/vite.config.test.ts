import { describe, expect, it } from "vitest";
import {
  ADMIN_DEV_PORT,
  ADMIN_ENV_DIR,
  adminBaseForCommand,
  demoFlagForMode,
  demoFlagForRuntime,
} from "./vite.config";

describe("configuración Vite de Admin", () => {
  it("lee el entorno raíz y coincide con el origen local documentado", () => {
    expect(ADMIN_ENV_DIR).toBe("../../");
    expect(ADMIN_DEV_PORT).toBe(4311);
  });

  it("habilita el modo demo explícito y conserva el helper histórico", () => {
    expect(demoFlagForMode("demo")).toBe("true");
    expect(demoFlagForMode("development")).toBe("false");
    expect(demoFlagForMode("production")).toBe("false");
  });

  it("respeta .env en desarrollo y desactiva demo en un build normal", () => {
    expect(demoFlagForRuntime("serve", "development", " true ")).toBe("true");
    expect(demoFlagForRuntime("serve", "development", "false")).toBe("false");
    expect(demoFlagForRuntime("serve", "demo")).toBe("true");
    expect(demoFlagForRuntime("build", "production", "true")).toBe("false");
    expect(demoFlagForRuntime("build", "demo", "false")).toBe("true");
  });

  it("publica Admin bajo /admin sin alterar la URL del servidor local", () => {
    expect(adminBaseForCommand("build")).toBe("/admin/");
    expect(adminBaseForCommand("serve")).toBe("/");
  });
});
