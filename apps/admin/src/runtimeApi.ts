import { createHttpAdminApi } from "./api/client";
import type { AdminApi } from "./api/types";

export interface RuntimeApi {
  api: AdminApi;
  demoMode: boolean;
}

export async function createRuntimeApi(): Promise<RuntimeApi> {
  const demoMode =
    !import.meta.env.PROD && import.meta.env.VITE_DEMO_MODE?.toLocaleLowerCase("en") === "true";

  if (demoMode) {
    const { createDemoAdminApi } = await import("./api/demo");
    return { api: createDemoAdminApi(), demoMode: true };
  }

  return { api: createHttpAdminApi(), demoMode: false };
}
