import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export const FIELD_ENV_DIR = "../../";
export const FIELD_DEV_HOST = "127.0.0.1";
export const FIELD_DEV_PORT = 4312;

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
    fileURLToPath(new URL(FIELD_ENV_DIR, import.meta.url)),
    "VITE_",
  );
  return {
    envDir: FIELD_ENV_DIR,
    define: {
      "import.meta.env.VITE_DEMO_MODE": JSON.stringify(
        demoFlagForRuntime(command, mode, environment.VITE_DEMO_MODE),
      ),
    },
    plugins: [react()],
    server: {
      host: FIELD_DEV_HOST,
      port: FIELD_DEV_PORT,
      strictPort: true,
      proxy: { "/api": "http://127.0.0.1:4310" },
    },
    preview: {
      host: FIELD_DEV_HOST,
      port: FIELD_DEV_PORT,
      strictPort: true,
      proxy: { "/api": "http://127.0.0.1:4310" },
    },
    test: {
      fileParallelism: false,
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
      css: true,
      testTimeout: 30_000,
    },
  };
});
