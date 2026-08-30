import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export const ADMIN_ENV_DIR = "../../";
export const ADMIN_DEV_PORT = 4311;
export const adminBaseForCommand = (command: string) => (command === "build" ? "/admin/" : "/");
export const demoFlagForMode = (mode: string) => (mode === "demo" ? "true" : "false");
export function demoFlagForRuntime(
  command: string,
  mode: string,
  configuredValue?: string,
): "true" | "false" {
  if (command === "build" && mode !== "demo") return "false";
  if (mode === "demo") return "true";
  return configuredValue?.trim().toLocaleLowerCase("en") === "true" ? "true" : "false";
}

export default defineConfig(({ command, mode }) => {
  const environment = loadEnv(
    mode,
    fileURLToPath(new URL(ADMIN_ENV_DIR, import.meta.url)),
    "VITE_",
  );
  return {
    base: adminBaseForCommand(command),
    envDir: ADMIN_ENV_DIR,
    define: {
      "import.meta.env.VITE_DEMO_MODE": JSON.stringify(
        demoFlagForRuntime(command, mode, environment.VITE_DEMO_MODE),
      ),
    },
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: ADMIN_DEV_PORT,
      strictPort: true,
    },
    test: {
      fileParallelism: false,
      environment: "jsdom",
      globals: true,
      setupFiles: "./src/test/setup.ts",
      css: true,
      testTimeout: 30_000,
    },
  };
});
