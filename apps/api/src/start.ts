import { fileURLToPath } from "node:url";
import {
  CampaignService,
  closeDatabase,
  createDatabase,
  createPostgresDatabase,
  migrateDatabase,
  RouteService,
  SyncService,
  WorkSessionService,
  seedDemoData,
} from "@rutacuadrilla/domain";
import { loadConfig, shouldLoadLocalEnvironment } from "./config.js";
import { buildServer } from "./server.js";

function loadLocalEnvironment(): void {
  if (!shouldLoadLocalEnvironment(process.env)) return;
  try {
    process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function start(): Promise<void> {
  loadLocalEnvironment();
  const config = loadConfig();
  const database = config.databaseUrl
    ? createPostgresDatabase({ connectionString: config.databaseUrl })
    : await createDatabase({ dataDir: config.databaseDir });

  try {
    await migrateDatabase(database);
    const adminPassword = process.env.DEMO_ADMIN_PASSWORD;
    if (config.environment === "development" && adminPassword) {
      await seedDemoData(database, {
        adminPassword,
        ...(process.env.DEMO_MEMBER_PASSWORD
          ? { memberPassword: process.env.DEMO_MEMBER_PASSWORD }
          : {}),
        ...(process.env.DEMO_OUTSIDER_PASSWORD
          ? { outsiderPassword: process.env.DEMO_OUTSIDER_PASSWORD }
          : {}),
      });
    }

    const server = await buildServer({
      campaignService: new CampaignService(database),
      config,
      database,
      routeService: new RouteService(database),
      syncService: new SyncService(database),
      workSessionService: new WorkSessionService(database),
    });
    let stopping = false;
    const stop = async (signal: string) => {
      if (stopping) return;
      stopping = true;
      server.log.info({ signal }, "Deteniendo RutaCuadrilla API");
      await server.close();
      await closeDatabase(database);
    };
    process.once("SIGINT", () => void stop("SIGINT"));
    process.once("SIGTERM", () => void stop("SIGTERM"));

    await server.listen({ host: config.apiHost, port: config.apiPort });
  } catch (error) {
    await closeDatabase(database);
    throw error;
  }
}

start().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "API_START_FAILED");
  process.exitCode = 1;
});
