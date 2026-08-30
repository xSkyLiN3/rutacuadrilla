import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticateUser,
  closeDatabase,
  createDatabase,
  type DomainDatabase,
  getMembershipForCrew,
  getMembershipsForUser,
  migrateDatabase,
  RouteService,
  seedDemoData,
} from "../src/index.js";
import { adminPassword, openMigratedDatabase, openSeededDatabase, validCsv } from "./helpers.js";

describe.sequential("database foundation", () => {
  let database: DomainDatabase | undefined;

  afterEach(async () => {
    if (database) {
      await closeDatabase(database);
      database = undefined;
    }
  });

  it("migrates a clean PostgreSQL database and is checksum-idempotent", async () => {
    database = await openMigratedDatabase();
    await migrateDatabase(database);

    const migrations = await database.query<{ name: string }>(
      "SELECT name FROM schema_migration ORDER BY name",
    );
    expect(migrations.rows.map((row) => row.name)).toEqual([
      "001_foundation.sql",
      "002_immutability.sql",
      "003_draft_revision_edit.sql",
      "004_route_geography.sql",
      "005_sync.sql",
      "006_route_segment_service_side.sql",
      "007_campaign_multiroute_vehicle.sql",
      "008_campaign_composition_integrity.sql",
      "009_work_sessions.sql",
      "010_simple_online.sql",
      "011_initial_provision_lock.sql",
    ]);
    const tables = await database.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        "app_user",
        "auth_session",
        "crew",
        "crew_membership",
        "membership_capability",
        "sector",
        "route",
        "route_revision",
        "service_point",
        "service_point_version",
        "route_revision_point",
        "route_revision_edit",
        "route_revision_change",
        "route_revision_area_version",
        "route_street_segment",
        "route_street_segment_version",
        "route_revision_segment",
        "campaign",
        "campaign_route",
        "campaign_point",
        "campaign_route_segment_side",
        "point_event",
        "sync_operation_receipt",
        "sync_change",
        "sync_sequence",
        "work_session",
        "session_participant",
        "session_device",
        "work_session_operation_receipt",
        "vehicle",
        "import_batch",
        "audit_event",
      ]),
    );
  });

  it("seeds two isolated crews with hashed credentials and normalized grants", async () => {
    const opened = await openSeededDatabase();
    database = opened.database;
    const { seed } = opened;

    const authenticated = await authenticateUser(
      database,
      seed.credentials.admin.email,
      adminPassword,
    );
    expect(authenticated).toMatchObject({ id: seed.userIds.admin });
    expect(await authenticateUser(database, seed.credentials.admin.email, "wrong")).toBeNull();

    const memberships = await getMembershipsForUser(database, seed.userIds.admin);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({
      crewId: seed.crewIds.primary,
      id: seed.membershipIds.admin,
    });
    expect(memberships[0]?.capabilities).toContain("ROUTE_PUBLISH");
    expect(
      await getMembershipForCrew(database, seed.userIds.admin, seed.crewIds.secondary),
    ).toBeNull();

    await database.query(
      `INSERT INTO sector
         (crew_id, id, name, created_by_membership_id)
       VALUES ($1, $2, 'Sector norte', $3)`,
      [seed.crewIds.primary, randomUUID(), seed.membershipIds.admin],
    );
    const northSector = await database.query<{ id: string }>(
      "SELECT id FROM sector WHERE crew_id = $1 LIMIT 1",
      [seed.crewIds.primary],
    );
    await expect(
      database.query(
        `INSERT INTO route
           (crew_id, id, sector_id, name, created_by_membership_id)
         VALUES ($1, $2, $3, 'Cruce prohibido', $4)`,
        [
          seed.crewIds.secondary,
          randomUUID(),
          northSector.rows[0]?.id,
          seed.membershipIds.outsider,
        ],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    const migrationSql = await readFile(
      fileURLToPath(new URL("../../../database/migrations/001_foundation.sql", import.meta.url)),
      "utf8",
    );
    expect(migrationSql).not.toMatch(/INSERT\s+INTO\s+app_user/iu);
    expect(migrationSql).not.toContain(adminPassword);
  });

  it("upgrades populated campaign data from migration 006 without losing its denominator", async () => {
    database = await createDatabase();
    const legacyMigrations = [
      "001_foundation.sql",
      "002_immutability.sql",
      "003_draft_revision_edit.sql",
      "004_route_geography.sql",
      "005_sync.sql",
      "006_route_segment_service_side.sql",
    ];
    for (const name of legacyMigrations) {
      await database.exec(
        await readFile(
          fileURLToPath(new URL(`../../../database/migrations/${name}`, import.meta.url)),
          "utf8",
        ),
      );
    }
    const seed = await seedDemoData(database, {
      adminPassword,
      memberPassword: "Demo-Member-Password-2026!",
      outsiderPassword: "Demo-Outsider-Password-2026!",
    });
    const imported = await new RouteService(database).importRoute({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      csv: validCsv,
      importKey: "migration-006-campaign",
      routeName: "Ruta previa a 007",
      sectorName: "Sector migración",
    });
    if (!imported.route || !imported.revision) throw new Error("Expected legacy route");
    await new RouteService(database).publishRevision({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      revisionId: imported.revision.id,
      routeId: imported.route.id,
    });
    const published = (
      await database.query<{ content_hash: string; point_count: number }>(
        `SELECT content_hash, point_count FROM route_revision
         WHERE crew_id = $1 AND id = $2`,
        [seed.crewIds.primary, imported.revision.id],
      )
    ).rows[0];
    if (!published) throw new Error("Expected published revision");
    const campaignId = randomUUID();
    const campaignRouteId = randomUUID();
    await database.query(
      `INSERT INTO campaign
         (crew_id, id, name, status, technical_fixture, created_by_membership_id)
       VALUES ($1, $2, 'Campaña heredada', 'DRAFT', false, $3)`,
      [seed.crewIds.primary, campaignId, seed.membershipIds.admin],
    );
    await database.query(
      `INSERT INTO campaign_route
         (crew_id, id, campaign_id, route_id, route_revision_id,
          route_content_hash, point_count, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`,
      [
        seed.crewIds.primary,
        campaignRouteId,
        campaignId,
        imported.route.id,
        imported.revision.id,
        published.content_hash,
        Number(published.point_count),
      ],
    );
    const legacyPoints = await database.query<{
      display_order: number;
      service_point_id: string;
      service_point_version_id: string;
    }>(
      `SELECT display_order, service_point_id, service_point_version_id
       FROM route_revision_point
       WHERE crew_id = $1 AND route_revision_id = $2`,
      [seed.crewIds.primary, imported.revision.id],
    );
    for (const point of legacyPoints.rows) {
      await database.query(
        `INSERT INTO campaign_point
           (crew_id, id, campaign_route_id, service_point_id,
            service_point_version_id, display_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          seed.crewIds.primary,
          randomUUID(),
          campaignRouteId,
          point.service_point_id,
          point.service_point_version_id,
          Number(point.display_order),
        ],
      );
    }

    await database.exec(
      await readFile(
        fileURLToPath(
          new URL(
            "../../../database/migrations/007_campaign_multiroute_vehicle.sql",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    );
    await database.exec(
      await readFile(
        fileURLToPath(
          new URL(
            "../../../database/migrations/008_campaign_composition_integrity.sql",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    );
    const upgraded = await database.query<{ campaign_id: string; count: string }>(
      `SELECT campaign_id, COUNT(*)::text AS count
       FROM campaign_point
       WHERE crew_id = $1 AND campaign_route_id = $2
       GROUP BY campaign_id`,
      [seed.crewIds.primary, campaignRouteId],
    );
    expect(upgraded.rows).toEqual([
      { campaign_id: campaignId, count: String(legacyPoints.rows.length) },
    ]);

    const legacyPoint = (
      await database.query<{ id: string }>(
        `SELECT id FROM campaign_point
         WHERE crew_id = $1 AND campaign_route_id = $2
         ORDER BY display_order LIMIT 1`,
        [seed.crewIds.primary, campaignRouteId],
      )
    ).rows[0];
    if (!legacyPoint) throw new Error("Expected legacy campaign point");
    const legacyEventId = randomUUID();
    const legacyOperationId = randomUUID();
    const legacyDeviceId = randomUUID();
    await database.query(
      `INSERT INTO point_event
         (crew_id, id, operation_id, campaign_point_id,
          actor_membership_id, device_id, event_type,
          base_version, applied_version, previous_state, next_state)
       VALUES ($1, $2, $3, $4, $5, $6, 'POINT_STATUS_CHANGED',
               0, 1, 'SIN_VISITAR', 'VOLVER')`,
      [
        seed.crewIds.primary,
        legacyEventId,
        legacyOperationId,
        legacyPoint.id,
        seed.membershipIds.admin,
        legacyDeviceId,
      ],
    );
    await database.query(
      `UPDATE campaign_point
       SET display_state = 'VOLVER', version = 1, last_event_id = $3
       WHERE crew_id = $1 AND id = $2`,
      [seed.crewIds.primary, legacyPoint.id, legacyEventId],
    );
    await database.query(
      `INSERT INTO sync_operation_receipt
         (crew_id, operation_id, payload_hash, campaign_point_id,
          device_id, status, result_json, event_id, change_sequence)
       VALUES ($1, $2, $3, $4, $5, 'APPLIED', $6::jsonb, $7, 1)`,
      [
        seed.crewIds.primary,
        legacyOperationId,
        "a".repeat(64),
        legacyPoint.id,
        legacyDeviceId,
        JSON.stringify({ operationId: legacyOperationId, status: "APPLIED" }),
        legacyEventId,
      ],
    );

    await database.exec(
      await readFile(
        fileURLToPath(
          new URL("../../../database/migrations/009_work_sessions.sql", import.meta.url),
        ),
        "utf8",
      ),
    );
    const migratedArtifacts = await database.query<{
      event_actor_membership_id: string;
      event_campaign_route_id: string;
      event_work_session_id: string | null;
      receipt_actor_membership_id: string | null;
      receipt_campaign_route_id: string;
      receipt_work_session_id: string | null;
    }>(
      `SELECT event.actor_membership_id AS event_actor_membership_id,
              event.campaign_route_id AS event_campaign_route_id,
              event.work_session_id AS event_work_session_id,
              receipt.actor_membership_id AS receipt_actor_membership_id,
              receipt.campaign_route_id AS receipt_campaign_route_id,
              receipt.work_session_id AS receipt_work_session_id
       FROM point_event AS event
       JOIN sync_operation_receipt AS receipt
         ON receipt.crew_id = event.crew_id
        AND receipt.operation_id = event.operation_id
       WHERE event.crew_id = $1 AND event.id = $2`,
      [seed.crewIds.primary, legacyEventId],
    );
    expect(migratedArtifacts.rows[0]).toEqual({
      event_actor_membership_id: seed.membershipIds.admin,
      event_campaign_route_id: campaignRouteId,
      event_work_session_id: null,
      receipt_actor_membership_id: null,
      receipt_campaign_route_id: campaignRouteId,
      receipt_work_session_id: null,
    });
    await expect(
      database.query(
        `UPDATE point_event SET next_state = 'APORTO'
         WHERE crew_id = $1 AND id = $2`,
        [seed.crewIds.primary, legacyEventId],
      ),
    ).rejects.toThrow(/IDEMPOTENCY_RECEIPT_APPEND_ONLY/u);
    await expect(
      database.query(
        `DELETE FROM sync_operation_receipt
         WHERE crew_id = $1 AND operation_id = $2`,
        [seed.crewIds.primary, legacyOperationId],
      ),
    ).rejects.toThrow(/IDEMPOTENCY_RECEIPT_APPEND_ONLY/u);
    await expect(database.exec("TRUNCATE session_participant CASCADE")).rejects.toThrow(
      /IDEMPOTENCY_RECEIPT_APPEND_ONLY/u,
    );
    await expect(database.exec("TRUNCATE session_device CASCADE")).rejects.toThrow(
      /IDEMPOTENCY_RECEIPT_APPEND_ONLY/u,
    );
  });
});
