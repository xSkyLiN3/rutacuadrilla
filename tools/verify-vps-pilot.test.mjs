import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectVpsPilotIssues, readVpsPilotSources, verifyVpsPilot } from "./verify-vps-pilot.mjs";

describe("VPS production static verification", () => {
  it("accepts the checked-in PostgreSQL, Nginx and Caddy contract", async () => {
    assert.deepEqual(await verifyVpsPilot(), {
      checks: 138,
      status: "VPS_PRODUCTION_STATIC_VALID",
    });
  });

  it("detects documentation that would make file-backed secrets unreadable by the API", async () => {
    const { sources } = await readVpsPilotSources();
    const unsafeSecretsReadme = sources.secretsReadme
      .replaceAll("root:1000", "deploy:deploy")
      .replaceAll("0440", "0600")
      .replace('test "$(id -u)" = 1000; test "$(id -g)" = 1000', "true");
    const issues = collectVpsPilotIssues({ ...sources, secretsReadme: unsafeSecretsReadme });

    assert.ok(issues.includes("VPS_API_NUMERIC_IDENTITY_CHECK_MISSING"));
    assert.ok(issues.includes("VPS_API_SECRET_GROUP_GUIDANCE_MISSING"));
    assert.ok(issues.includes("VPS_API_SECRET_MODE_GUIDANCE_MISSING"));
  });

  it("detects public API and PostgreSQL ports", async () => {
    const { sources } = await readVpsPilotSources();
    const insecureCompose = `${sources.compose}\n    ports:\n      - "4310:4310"\n      - "5432:5432"\n    privileged: true\n    network_mode: "host"\n`;
    const issues = collectVpsPilotIssues({ ...sources, compose: insecureCompose });
    assert.ok(issues.includes("VPS_API_PORT_MUST_NOT_BE_PUBLISHED"));
    assert.ok(issues.includes("VPS_DATABASE_PORT_MUST_NOT_BE_PUBLISHED"));
    assert.ok(issues.includes("VPS_SERVICE_PRIVILEGED_MODE_PRESENT"));
    assert.ok(issues.includes("VPS_SERVICE_HOST_NETWORK_PRESENT"));
  });

  it("detects a regression from PostgreSQL to PGlite", async () => {
    const { sources } = await readVpsPilotSources();
    const regressedCompose = sources.compose
      .replace("image: postgres:18.6-bookworm", "image: legacy-pglite:latest")
      .replace(
        "DATABASE_URL_FILE: /run/secrets/database_url",
        "DATABASE_DIR: /var/lib/rutacuadrilla/PGlite",
      );
    const issues = collectVpsPilotIssues({ ...sources, compose: regressedCompose });
    assert.ok(issues.includes("VPS_POSTGRES_IMAGE_NOT_PINNED"));
    assert.ok(issues.includes("VPS_DATABASE_URL_NOT_FILE_BACKED"));
    assert.ok(issues.includes("VPS_PGLITE_DATABASE_CONFIGURATION_PRESENT"));
    assert.ok(issues.includes("VPS_PGLITE_CONTRACT_PRESENT"));
  });

  it("detects an unsafe or incomplete one-shot provisioner", async () => {
    const { sources } = await readVpsPilotSources();
    const unsafeProvision = sources.provisionCompose
      .replace("DATABASE_URL_FILE: /run/secrets/database_url", "DATABASE_URL: secret-in-command")
      .replace(
        "RUTACUADRILLA_INITIAL_ADMIN_PASSWORD_FILE: /run/secrets/initial_admin_password",
        "RUTACUADRILLA_INITIAL_ADMIN_PASSWORD: secret-in-environment",
      )
      .replace("read_only: true", "read_only: false")
      .concat(
        '\n# --database-url secret-in-process-list\n    privileged: true\n    network_mode: "host"\n',
      );
    const issues = collectVpsPilotIssues({ ...sources, provisionCompose: unsafeProvision });
    assert.ok(issues.includes("VPS_PROVISION_DATABASE_URL_NOT_FILE_BACKED"));
    assert.ok(issues.includes("VPS_PROVISION_PASSWORD_NOT_FILE_BACKED"));
    assert.ok(issues.includes("VPS_PROVISION_FILESYSTEM_NOT_READ_ONLY"));
    assert.ok(issues.includes("VPS_PROVISION_DATABASE_URL_EXPOSED_IN_ARGUMENTS"));
    assert.ok(issues.includes("VPS_PROVISION_PRIVILEGED_MODE_PRESENT"));
    assert.ok(issues.includes("VPS_PROVISION_HOST_NETWORK_PRESENT"));
  });

  it("detects an Nginx proxy that bypasses loopback or loses the real client IP", async () => {
    const { sources } = await readVpsPilotSources();
    const insecureNginx = sources.nginxConfig
      .replace("proxy_pass http://127.0.0.1:8432;", "proxy_pass http://0.0.0.0:8432;")
      .replace("proxy_set_header X-Real-IP $remote_addr;", "");
    const issues = collectVpsPilotIssues({ ...sources, nginxConfig: insecureNginx });
    assert.ok(issues.includes("VPS_NGINX_LOOPBACK_PROXY_INVALID"));
    assert.ok(issues.includes("VPS_NGINX_REAL_IP_HEADER_MISSING"));
  });

  it("detects loss of GPS and map tiles", async () => {
    const { sources } = await readVpsPilotSources();
    const regressedCaddy = sources.caddyfile
      .replace(
        'Permissions-Policy "camera=(), geolocation=(self), microphone=()"',
        'Permissions-Policy "camera=(), geolocation=(), microphone=()"',
      )
      .replaceAll("https://tile.openstreetmap.org", "");
    const issues = collectVpsPilotIssues({ ...sources, caddyfile: regressedCaddy });
    assert.ok(issues.includes("VPS_FIELD_GEOLOCATION_NOT_ALLOWED"));
    assert.ok(issues.includes("VPS_FIELD_TILE_ORIGIN_NOT_ALLOWED"));
  });

  it("detects a legacy profile, field release or blocked retirement worker", async () => {
    const { sources } = await readVpsPilotSources();
    const issues = collectVpsPilotIssues({
      ...sources,
      caddyfile: `${sources.caddyfile.replace(
        /handle \/field-sw\.js \{[\s\S]*?\n\t\}/u,
        "respond /field-sw.js 404",
      )}`,
      compose: sources.compose.replace("APP_PROFILE: simple", "APP_PROFILE: legacy"),
      environmentExample: `${sources.environmentExample}\nFIELD_RELEASE=legacy-field\n`,
      webDockerfile: `${sources.webDockerfile}\nARG FIELD_RELEASE\n# H40\n`,
    });
    assert.ok(issues.includes("VPS_APP_PROFILE_NOT_SIMPLE"));
    assert.ok(issues.includes("VPS_LEGACY_FIELD_RELEASE_PRESENT"));
    assert.ok(issues.includes("VPS_LEGACY_H40_BUILD_PRESENT"));
    assert.ok(issues.includes("VPS_FIELD_RETIREMENT_WORKER_ROUTE_MISSING"));
    assert.ok(issues.includes("VPS_FIELD_RETIREMENT_WORKER_BLOCKED"));
    assert.ok(issues.includes("VPS_LEGACY_FIELD_RELEASE_EXAMPLE_PRESENT"));
  });

  it("detects a retirement worker that keeps intercepting requests", async () => {
    const { sources } = await readVpsPilotSources();
    const issues = collectVpsPilotIssues({
      ...sources,
      fieldServiceWorker: `${sources.fieldServiceWorker}\nself.addEventListener("fetch", () => {});`,
    });

    assert.ok(issues.includes("VPS_FIELD_RETIREMENT_WORKER_INTERCEPTS_FETCH"));
  });

  it("detects regressions in compression and static resource cache policies", async () => {
    const { sources } = await readVpsPilotSources();
    const regressedCaddy = sources.caddyfile
      .replace("encode zstd gzip", "")
      .replace(
        'root * /srv/admin/assets\n\t\theader Cache-Control "public, max-age=31536000, immutable"',
        'root * /srv/admin/assets\n\t\theader Cache-Control "no-store"',
      )
      .replace(
        'header Cache-Control "public, max-age=0, must-revalidate"',
        'header Cache-Control "no-store"',
      );
    const issues = collectVpsPilotIssues({ ...sources, caddyfile: regressedCaddy });

    assert.ok(issues.includes("VPS_STATIC_RESPONSE_COMPRESSION_MISSING"));
    assert.ok(issues.includes("VPS_ADMIN_IMMUTABLE_ASSET_CACHE_MISSING"));
    assert.ok(issues.includes("VPS_ROUTE_CATALOG_REVALIDATION_CACHE_MISSING"));
  });

  it("detects backup and restore paths without integrity or rollback guards", async () => {
    const { sources } = await readVpsPilotSources();
    const weakBackup = sources.backupScript
      .replace("pg_restore --list", "removed-catalog-check")
      .replaceAll("sha256sum", "removed-checksum");
    const weakRestore = sources.restoreScript
      .replace("--single-transaction", "")
      .replace("011_initial_provision_lock.sql", "removed-latest-migration.sql")
      .replaceAll("rutacuadrilla_pre_restore_", "removed_previous_")
      .replaceAll("fetch('http://127.0.0.1:4310/ready')", "removed-readiness");
    const issues = collectVpsPilotIssues({
      ...sources,
      backupScript: weakBackup,
      restoreScript: weakRestore,
    });
    assert.ok(issues.includes("VPS_POSTGRES_BACKUP_CATALOG_VALIDATION_MISSING"));
    assert.ok(issues.includes("VPS_POSTGRES_BACKUP_CHECKSUM_MISSING"));
    assert.ok(issues.includes("VPS_RESTORE_NOT_TRANSACTIONAL"));
    assert.ok(issues.includes("VPS_RESTORE_MIGRATION_VALIDATION_MISSING"));
    assert.ok(issues.includes("VPS_RESTORE_PREVIOUS_DATABASE_NOT_PRESERVED"));
    assert.ok(issues.includes("VPS_RESTORE_API_READINESS_MISSING"));
  });
});
