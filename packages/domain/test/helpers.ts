import {
  createDatabase,
  migrateDatabase,
  seedDemoData,
  type DemoSeedResult,
  type DomainDatabase,
} from "../src/index.js";

export const adminPassword = "Demo-Admin-Password-2026!";

export const validCsv = `external_id,street,number,latitude,longitude,point_type,source
home-001,Los Aromos,101,-0.4489,-0.6693,DWELLING,CSV
home-002,Los Aromos,103,-0.4490,-0.6694,BUILDING_ENTRANCE,CSV`;

export async function openMigratedDatabase(): Promise<DomainDatabase> {
  const database = await createDatabase();
  await migrateDatabase(database);
  return database;
}

export async function openSeededDatabase(): Promise<{
  database: DomainDatabase;
  seed: DemoSeedResult;
}> {
  const database = await openMigratedDatabase();
  const seed = await seedDemoData(database, {
    adminPassword,
    memberPassword: "Demo-Member-Password-2026!",
    outsiderPassword: "Demo-Outsider-Password-2026!",
  });
  return { database, seed };
}
