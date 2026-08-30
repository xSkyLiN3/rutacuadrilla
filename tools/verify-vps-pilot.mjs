import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = resolve(toolDirectory, "..");

const sourcePaths = {
  adminViteConfig: "apps/admin/vite.config.ts",
  apiConfig: "apps/api/src/config.ts",
  apiDockerfile: "deploy/Dockerfile.api",
  backupScript: "deploy/scripts/backup-postgres.sh",
  caddyfile: "deploy/Caddyfile",
  compose: "deploy/compose.vps.yml",
  provisionCompose: "deploy/compose.provision.yml",
  dockerignore: ".dockerignore",
  environmentExample: "deploy/.env.example",
  fieldServiceWorker: "apps/field/public/field-sw.js",
  nginxConfig: "deploy/nginx.rutacuadrilla.conf",
  restoreScript: "deploy/scripts/restore-postgres.sh",
  secretsReadme: "deploy/secrets/README.md",
  webDockerfile: "deploy/Dockerfile.web",
};

function occurrenceCount(value, fragment) {
  return value.split(fragment).length - 1;
}

function inspectVpsProductionSources(sources) {
  const issues = [];
  let checks = 0;
  const requireIncludes = (source, fragment, code) => {
    checks += 1;
    if (!source.includes(fragment)) issues.push(code);
  };
  const requireNotIncludes = (source, fragment, code) => {
    checks += 1;
    if (source.includes(fragment)) issues.push(code);
  };
  const requireMatches = (source, expression, code) => {
    checks += 1;
    if (!expression.test(source)) issues.push(code);
  };
  const requireNotMatches = (source, expression, code) => {
    checks += 1;
    if (expression.test(source)) issues.push(code);
  };
  const requireMinimumOccurrences = (source, fragment, minimum, code) => {
    checks += 1;
    if (occurrenceCount(source, fragment) < minimum) issues.push(code);
  };

  const {
    adminViteConfig,
    apiConfig,
    apiDockerfile,
    backupScript,
    caddyfile,
    compose,
    provisionCompose,
    dockerignore,
    environmentExample,
    fieldServiceWorker,
    nginxConfig,
    restoreScript,
    secretsReadme,
    webDockerfile,
  } = sources;

  requireIncludes(
    apiDockerfile,
    "FROM node:24.18.1-bookworm-slim",
    "VPS_API_NODE_IMAGE_NOT_PINNED",
  );
  requireIncludes(apiDockerfile, "USER node", "VPS_API_MUST_RUN_UNPRIVILEGED");
  requireIncludes(apiDockerfile, "COPY database ./database", "VPS_API_MIGRATIONS_MISSING");
  requireIncludes(
    apiDockerfile,
    'CMD ["node", "apps/api/dist/start.js"]',
    "VPS_API_COMMAND_INVALID",
  );
  requireIncludes(apiConfig, "DATABASE_URL_FILE", "VPS_API_DATABASE_URL_FILE_UNSUPPORTED");
  requireIncludes(
    apiConfig,
    "Set only one of DATABASE_URL or DATABASE_URL_FILE",
    "VPS_API_DATABASE_SOURCE_CONFLICT_UNGUARDED",
  );
  requireIncludes(
    apiConfig,
    "DATABASE_URL_FILE must be absolute in production",
    "VPS_API_DATABASE_SECRET_PATH_UNGUARDED",
  );

  requireIncludes(webDockerfile, "FROM caddy:2.11.4-alpine", "VPS_CADDY_IMAGE_NOT_PINNED");
  requireNotIncludes(webDockerfile, "FIELD_RELEASE", "VPS_LEGACY_FIELD_RELEASE_PRESENT");
  requireNotIncludes(webDockerfile, "H40", "VPS_LEGACY_H40_BUILD_PRESENT");
  requireMinimumOccurrences(webDockerfile, 'VITE_API_URL=""', 2, "VPS_WEB_CLIENTS_NOT_SAME_ORIGIN");
  requireIncludes(
    adminViteConfig,
    'command === "build" ? "/admin/" : "/"',
    "VPS_ADMIN_BUILD_BASE_INVALID",
  );
  requireMatches(compose, /^name:\s+rutacuadrilla\s*$/mu, "VPS_PROJECT_NAME_INVALID");
  requireMatches(compose, /^\s{2}db:\s*$/mu, "VPS_DATABASE_SERVICE_MISSING");
  requireMatches(compose, /^\s{2}api:\s*$/mu, "VPS_API_SERVICE_MISSING");
  requireMatches(compose, /^\s{2}edge:\s*$/mu, "VPS_EDGE_SERVICE_MISSING");
  requireIncludes(compose, "image: postgres:18.6-bookworm", "VPS_POSTGRES_IMAGE_NOT_PINNED");
  requireIncludes(
    compose,
    "POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password",
    "VPS_POSTGRES_PASSWORD_NOT_FILE_BACKED",
  );
  requireIncludes(
    compose,
    "POSTGRES_INITDB_ARGS: --auth-host=scram-sha-256 --data-checksums",
    "VPS_POSTGRES_INIT_NOT_HARDENED",
  );
  requireIncludes(
    compose,
    "postgres_data:/var/lib/postgresql",
    "VPS_POSTGRES_18_VOLUME_PATH_INVALID",
  );
  requireIncludes(compose, "pg_isready", "VPS_POSTGRES_HEALTHCHECK_MISSING");
  requireIncludes(
    compose,
    "DATABASE_URL_FILE: /run/secrets/database_url",
    "VPS_DATABASE_URL_NOT_FILE_BACKED",
  );
  requireMatches(compose, /^\s{6}APP_PROFILE:\s+simple\s*$/mu, "VPS_APP_PROFILE_NOT_SIMPLE");
  requireNotIncludes(compose, "DATABASE_DIR:", "VPS_PGLITE_DATABASE_CONFIGURATION_PRESENT");
  requireNotIncludes(compose, "PGlite", "VPS_PGLITE_CONTRACT_PRESENT");
  requireIncludes(compose, "CORS_ORIGIN: https://${APP_HOST", "VPS_SINGLE_ORIGIN_CORS_MISSING");
  requireIncludes(compose, 'TRUST_PROXY: "1"', "VPS_PROXY_HOP_NOT_RESTRICTED");
  requireIncludes(
    compose,
    "SESSION_SECRET_FILE: /run/secrets/session_secret",
    "VPS_SESSION_SECRET_NOT_FILE_BACKED",
  );
  requireIncludes(compose, "internal: true", "VPS_BACKEND_NETWORK_NOT_INTERNAL");
  requireMinimumOccurrences(
    compose,
    "condition: service_healthy",
    2,
    "VPS_HEALTH_DEPENDENCIES_MISSING",
  );
  requireIncludes(compose, "no-new-privileges:true", "VPS_NO_NEW_PRIVILEGES_MISSING");
  requireIncludes(compose, "cap_drop:\n      - ALL", "VPS_API_CAPABILITIES_NOT_DROPPED");
  requireMinimumOccurrences(compose, "read_only: true", 2, "VPS_FILESYSTEMS_NOT_READ_ONLY");
  requireIncludes(
    compose,
    `127.0.0.1:\${EDGE_HTTP_PORT:-8432}:80`,
    "VPS_EDGE_NOT_BOUND_TO_LOOPBACK",
  );
  requireNotIncludes(compose, '"4310:4310"', "VPS_API_PORT_MUST_NOT_BE_PUBLISHED");
  requireNotIncludes(compose, '"5432:5432"', "VPS_DATABASE_PORT_MUST_NOT_BE_PUBLISHED");
  requireNotIncludes(compose, '"80:80"', "VPS_EDGE_MUST_NOT_BYPASS_HOST_NGINX");
  requireNotIncludes(compose, '"443:443"', "VPS_EDGE_MUST_NOT_TERMINATE_HOST_TLS");
  requireIncludes(
    compose,
    "file: ./secrets/database_url",
    "VPS_DATABASE_URL_SECRET_SOURCE_MISSING",
  );
  requireIncludes(
    compose,
    "file: ./secrets/postgres_password",
    "VPS_POSTGRES_PASSWORD_SOURCE_MISSING",
  );
  requireIncludes(compose, "file: ./secrets/session_secret", "VPS_SESSION_SECRET_SOURCE_MISSING");
  requireIncludes(compose, "postgres_data: {}", "VPS_POSTGRES_VOLUME_MISSING");
  requireNotMatches(
    compose,
    /^\s*privileged:\s*true(?:\s+#.*)?\s*$/imu,
    "VPS_SERVICE_PRIVILEGED_MODE_PRESENT",
  );
  requireNotMatches(
    compose,
    /^\s*network_mode:\s*["']?host["']?(?:\s+#.*)?\s*$/imu,
    "VPS_SERVICE_HOST_NETWORK_PRESENT",
  );

  requireMatches(provisionCompose, /^\s{2}provision:\s*$/mu, "VPS_PROVISION_SERVICE_MISSING");
  requireIncludes(
    provisionCompose,
    "DATABASE_URL_FILE: /run/secrets/database_url",
    "VPS_PROVISION_DATABASE_URL_NOT_FILE_BACKED",
  );
  requireIncludes(
    provisionCompose,
    "RUTACUADRILLA_INITIAL_ADMIN_PASSWORD_FILE: /run/secrets/initial_admin_password",
    "VPS_PROVISION_PASSWORD_NOT_FILE_BACKED",
  );
  requireIncludes(
    provisionCompose,
    "tools/provision-initial-admin.mjs",
    "VPS_PROVISION_COMMAND_MISSING",
  );
  requireIncludes(
    provisionCompose,
    "condition: service_healthy",
    "VPS_PROVISION_DATABASE_HEALTH_DEPENDENCY_MISSING",
  );
  requireIncludes(provisionCompose, "- backend", "VPS_PROVISION_INTERNAL_NETWORK_MISSING");
  requireIncludes(provisionCompose, "read_only: true", "VPS_PROVISION_FILESYSTEM_NOT_READ_ONLY");
  requireIncludes(
    provisionCompose,
    "cap_drop:\n      - ALL",
    "VPS_PROVISION_CAPABILITIES_NOT_DROPPED",
  );
  requireIncludes(
    provisionCompose,
    "no-new-privileges:true",
    "VPS_PROVISION_NEW_PRIVILEGES_ALLOWED",
  );
  requireIncludes(
    provisionCompose,
    "file: ./secrets/initial_admin_password",
    "VPS_PROVISION_PASSWORD_SECRET_SOURCE_MISSING",
  );
  requireNotIncludes(
    provisionCompose,
    "--database-url",
    "VPS_PROVISION_DATABASE_URL_EXPOSED_IN_ARGUMENTS",
  );
  requireNotIncludes(provisionCompose, "--password", "VPS_PROVISION_PASSWORD_EXPOSED_IN_ARGUMENTS");
  requireNotMatches(
    provisionCompose,
    /^\s*privileged:\s*true(?:\s+#.*)?\s*$/imu,
    "VPS_PROVISION_PRIVILEGED_MODE_PRESENT",
  );
  requireNotMatches(
    provisionCompose,
    /^\s*network_mode:\s*["']?host["']?(?:\s+#.*)?\s*$/imu,
    "VPS_PROVISION_HOST_NETWORK_PRESENT",
  );

  requireIncludes(caddyfile, "auto_https off", "VPS_CADDY_TLS_MUST_BE_DISABLED");
  requireIncludes(caddyfile, "http://{$APP_HOST}", "VPS_SINGLE_APP_HOST_MISSING");
  requireMatches(
    caddyfile,
    /^\s*encode\s+zstd\s+gzip\s*$/mu,
    "VPS_STATIC_RESPONSE_COMPRESSION_MISSING",
  );
  requireNotIncludes(caddyfile, "{$ADMIN_HOST}", "VPS_LEGACY_ADMIN_HOST_PRESENT");
  requireNotIncludes(caddyfile, "{$FIELD_HOST}", "VPS_LEGACY_FIELD_HOST_PRESENT");
  requireIncludes(caddyfile, "reverse_proxy api:4310", "VPS_API_PROXY_MISSING");
  requireIncludes(
    caddyfile,
    "header_up X-Forwarded-For {http.request.header.X-Real-IP}",
    "VPS_FORWARDED_FOR_NOT_REPLACED",
  );
  requireIncludes(caddyfile, "Strict-Transport-Security", "VPS_HSTS_HEADER_MISSING");
  requireMinimumOccurrences(
    caddyfile,
    "Content-Security-Policy",
    2,
    "VPS_CONTENT_SECURITY_POLICIES_MISSING",
  );
  requireIncludes(
    caddyfile,
    'Permissions-Policy "camera=(), geolocation=(), microphone=()"',
    "VPS_ADMIN_GEOLOCATION_NOT_BLOCKED",
  );
  requireIncludes(
    caddyfile,
    'Permissions-Policy "camera=(), geolocation=(self), microphone=()"',
    "VPS_FIELD_GEOLOCATION_NOT_ALLOWED",
  );
  requireIncludes(caddyfile, "https://tile.openstreetmap.org", "VPS_FIELD_TILE_ORIGIN_NOT_ALLOWED");
  requireIncludes(
    caddyfile,
    'Referrer-Policy "strict-origin-when-cross-origin"',
    "VPS_FIELD_TILE_REFERRER_POLICY_INVALID",
  );
  requireIncludes(
    caddyfile,
    'Cross-Origin-Embedder-Policy "require-corp"',
    "VPS_FIELD_COEP_MISSING",
  );
  requireIncludes(caddyfile, 'Cross-Origin-Opener-Policy "same-origin"', "VPS_FIELD_COOP_MISSING");
  requireIncludes(
    caddyfile,
    'Cross-Origin-Resource-Policy "same-origin"',
    "VPS_FIELD_CORP_MISSING",
  );
  requireIncludes(caddyfile, "handle_path /admin/*", "VPS_ADMIN_PATH_HANDLER_MISSING");
  requireIncludes(caddyfile, "redir @adminExact /admin/ 308", "VPS_ADMIN_REDIRECT_MISSING");
  requireMatches(
    caddyfile,
    /handle\s+\/field-sw\.js\s*\{\s*root\s+\*\s+\/srv\/field\s*header\s+Cache-Control\s+"no-store, no-cache, must-revalidate, max-age=0"\s*file_server\s*\}/u,
    "VPS_FIELD_RETIREMENT_WORKER_ROUTE_MISSING",
  );
  requireNotIncludes(caddyfile, "respond /field-sw.js 404", "VPS_FIELD_RETIREMENT_WORKER_BLOCKED");
  requireIncludes(
    fieldServiceWorker,
    "self.registration.unregister()",
    "VPS_FIELD_RETIREMENT_WORKER_UNREGISTER_MISSING",
  );
  requireIncludes(
    fieldServiceWorker,
    'const FIELD_SHELL_CACHE_PREFIX = "rutacuadrilla-field-shell-"',
    "VPS_FIELD_RETIREMENT_WORKER_CACHE_CLEANUP_MISSING",
  );
  requireNotIncludes(
    fieldServiceWorker,
    'addEventListener("fetch"',
    "VPS_FIELD_RETIREMENT_WORKER_INTERCEPTS_FETCH",
  );
  requireNotIncludes(
    fieldServiceWorker,
    "addEventListener('fetch'",
    "VPS_FIELD_RETIREMENT_WORKER_INTERCEPTS_FETCH",
  );
  requireMatches(
    caddyfile,
    /handle_path\s+\/admin\/assets\/\*\s*\{\s*root\s+\*\s+\/srv\/admin\/assets\s*header\s+Cache-Control\s+"public, max-age=31536000, immutable"\s*file_server\s*\}/u,
    "VPS_ADMIN_IMMUTABLE_ASSET_CACHE_MISSING",
  );
  requireMatches(
    caddyfile,
    /handle\s+\/assets\/\*\s*\{\s*root\s+\*\s+\/srv\/field\s*header\s+Cache-Control\s+"public, max-age=31536000, immutable"\s*file_server\s*\}/u,
    "VPS_FIELD_IMMUTABLE_ASSET_CACHE_MISSING",
  );
  requireMatches(
    caddyfile,
    /^\s*@routeCatalog\s+path\s+\/demo-dwellings\.geojson\s+\/demo-parcels\.geojson\s*$/mu,
    "VPS_ROUTE_CATALOG_MATCHER_MISSING",
  );
  requireMatches(
    caddyfile,
    /handle\s+@routeCatalog\s*\{\s*root\s+\*\s+\/srv\/field\s*header\s+Cache-Control\s+"public, max-age=0, must-revalidate"\s*file_server\s*\}/u,
    "VPS_ROUTE_CATALOG_REVALIDATION_CACHE_MISSING",
  );
  requireMinimumOccurrences(
    caddyfile,
    "try_files {path} /index.html",
    2,
    "VPS_SPA_FALLBACKS_MISSING",
  );

  requireMatches(
    nginxConfig,
    /^\s*listen\s+80;\s*$/mu,
    "VPS_NGINX_HTTP_BOOTSTRAP_LISTENER_MISSING",
  );
  requireIncludes(nginxConfig, "server_name app.example.com;", "VPS_NGINX_SERVER_NAME_INVALID");
  requireIncludes(
    nginxConfig,
    "location ^~ /.well-known/acme-challenge/",
    "VPS_NGINX_ACME_LOCATION_MISSING",
  );
  requireIncludes(nginxConfig, "root /var/www/certbot;", "VPS_NGINX_CERTBOT_WEBROOT_MISSING");
  requireIncludes(
    nginxConfig,
    "proxy_pass http://127.0.0.1:8432;",
    "VPS_NGINX_LOOPBACK_PROXY_INVALID",
  );
  requireIncludes(nginxConfig, "proxy_set_header Host $host;", "VPS_NGINX_HOST_HEADER_MISSING");
  requireIncludes(
    nginxConfig,
    "proxy_set_header X-Real-IP $remote_addr;",
    "VPS_NGINX_REAL_IP_HEADER_MISSING",
  );
  requireIncludes(
    nginxConfig,
    "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "VPS_NGINX_FORWARDED_FOR_HEADER_MISSING",
  );
  requireIncludes(
    nginxConfig,
    "proxy_set_header X-Forwarded-Host $host;",
    "VPS_NGINX_FORWARDED_HOST_HEADER_MISSING",
  );
  requireIncludes(
    nginxConfig,
    "proxy_set_header X-Forwarded-Proto $scheme;",
    "VPS_NGINX_FORWARDED_PROTO_HEADER_MISSING",
  );

  requireMatches(
    environmentExample,
    /^APP_HOST=app\.example\.com$/mu,
    "VPS_APP_HOST_EXAMPLE_INVALID",
  );
  requireMatches(environmentExample, /^EDGE_HTTP_PORT=8432$/mu, "VPS_EDGE_PORT_EXAMPLE_INVALID");
  requireMatches(
    environmentExample,
    /^APP_RELEASE=[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/mu,
    "VPS_APP_RELEASE_EXAMPLE_INVALID",
  );
  requireNotIncludes(
    environmentExample,
    "FIELD_RELEASE",
    "VPS_LEGACY_FIELD_RELEASE_EXAMPLE_PRESENT",
  );
  for (const variableName of [
    "INITIAL_ADMIN_EMAIL",
    "INITIAL_ADMIN_DISPLAY_NAME",
    "INITIAL_CREW_NAME",
    "INITIAL_CREW_SLUG",
  ]) {
    requireMatches(
      environmentExample,
      new RegExp(`^${variableName}=.+$`, "mu"),
      `VPS_PROVISION_IDENTITY_EXAMPLE_MISSING:${variableName}`,
    );
  }

  requireIncludes(backupScript, "set -Eeuo pipefail", "VPS_BACKUP_STRICT_MODE_MISSING");
  requireIncludes(backupScript, "flock -n 9", "VPS_BACKUP_LOCK_MISSING");
  requireIncludes(backupScript, "pg_dump", "VPS_POSTGRES_BACKUP_TOOL_MISSING");
  requireIncludes(backupScript, "--format=custom", "VPS_POSTGRES_BACKUP_FORMAT_INVALID");
  requireIncludes(backupScript, "--no-owner", "VPS_POSTGRES_BACKUP_OWNER_PORTABILITY_MISSING");
  requireIncludes(
    backupScript,
    "pg_restore --list",
    "VPS_POSTGRES_BACKUP_CATALOG_VALIDATION_MISSING",
  );
  requireIncludes(backupScript, "sha256sum", "VPS_POSTGRES_BACKUP_CHECKSUM_MISSING");
  requireIncludes(backupScript, "mktemp -p", "VPS_POSTGRES_BACKUP_ATOMIC_WRITE_MISSING");
  requireNotIncludes(backupScript, "stop api", "VPS_POSTGRES_BACKUP_STOPS_API");

  requireIncludes(restoreScript, "set -Eeuo pipefail", "VPS_RESTORE_STRICT_MODE_MISSING");
  requireIncludes(restoreScript, "flock -n 9", "VPS_RESTORE_LOCK_MISSING");
  requireIncludes(restoreScript, "sha256sum", "VPS_RESTORE_CHECKSUM_MISSING");
  requireIncludes(restoreScript, "pg_restore --list", "VPS_RESTORE_CATALOG_VALIDATION_MISSING");
  requireIncludes(restoreScript, "--single-transaction", "VPS_RESTORE_NOT_TRANSACTIONAL");
  requireIncludes(
    restoreScript,
    "rutacuadrilla_restore_",
    "VPS_RESTORE_CANDIDATE_DATABASE_MISSING",
  );
  requireIncludes(restoreScript, `"\${compose[@]}" stop api`, "VPS_RESTORE_DOES_NOT_PAUSE_API");
  requireIncludes(
    restoreScript,
    "rutacuadrilla_pre_restore_",
    "VPS_RESTORE_PREVIOUS_DATABASE_NOT_PRESERVED",
  );
  requireIncludes(
    restoreScript,
    "011_initial_provision_lock.sql",
    "VPS_RESTORE_MIGRATION_VALIDATION_MISSING",
  );
  requireIncludes(
    restoreScript,
    "fetch('http://127.0.0.1:4310/ready')",
    "VPS_RESTORE_API_READINESS_MISSING",
  );
  requireIncludes(
    restoreScript,
    "rutacuadrilla_failed_restore_",
    "VPS_RESTORE_FAILED_CANDIDATE_NOT_PRESERVED",
  );

  for (const secretName of ["session_secret", "postgres_password", "database_url"]) {
    requireIncludes(
      secretsReadme,
      `\`${secretName}\``,
      `VPS_SECRET_DOCUMENTATION_MISSING:${secretName}`,
    );
  }
  requireIncludes(
    secretsReadme,
    "openssl rand -base64 48",
    "VPS_SESSION_SECRET_GENERATION_GUIDANCE_MISSING",
  );
  requireIncludes(
    secretsReadme,
    "openssl rand -hex 32",
    "VPS_DATABASE_SECRET_GENERATION_GUIDANCE_MISSING",
  );
  requireIncludes(secretsReadme, "bind mounts", "VPS_SECRET_BIND_MOUNT_GUIDANCE_MISSING");
  requireIncludes(
    secretsReadme,
    'test "$(id -u)" = 1000; test "$(id -g)" = 1000',
    "VPS_API_NUMERIC_IDENTITY_CHECK_MISSING",
  );
  requireIncludes(
    secretsReadme,
    "chown root:1000 deploy/secrets/session_secret deploy/secrets/database_url",
    "VPS_API_SECRET_GROUP_GUIDANCE_MISSING",
  );
  requireIncludes(
    secretsReadme,
    "chmod 0440 deploy/secrets/session_secret deploy/secrets/database_url",
    "VPS_API_SECRET_MODE_GUIDANCE_MISSING",
  );
  requireIncludes(
    secretsReadme,
    "chmod 0400 deploy/secrets/postgres_password",
    "VPS_POSTGRES_SECRET_MODE_GUIDANCE_MISSING",
  );
  requireIncludes(secretsReadme, "chmod 0700 deploy/secrets", "VPS_SECRET_DIRECTORY_MODE_MISSING");
  requireIncludes(secretsReadme, "ALTER ROLE", "VPS_DATABASE_SECRET_ROTATION_WARNING_MISSING");
  requireIncludes(dockerignore, "deploy/secrets/*", "VPS_DOCKER_CONTEXT_EXPOSES_SECRETS");

  return { checks, issues };
}

export async function readVpsPilotSources(workspaceRoot = defaultWorkspaceRoot) {
  const sources = {};
  const missing = [];
  for (const [name, relativePath] of Object.entries(sourcePaths)) {
    try {
      sources[name] = await readFile(resolve(workspaceRoot, relativePath), "utf8");
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") {
        missing.push(`VPS_REQUIRED_FILE_MISSING:${relativePath}`);
        sources[name] = "";
      } else {
        throw error;
      }
    }
  }
  return { missing, sources };
}

export function collectVpsPilotIssues(sources) {
  return inspectVpsProductionSources(sources).issues;
}

export async function verifyVpsPilot(workspaceRoot = defaultWorkspaceRoot) {
  const { missing, sources } = await readVpsPilotSources(workspaceRoot);
  const { checks, issues } = inspectVpsProductionSources(sources);
  const allIssues = [...missing, ...issues];
  if (allIssues.length > 0) throw new Error(allIssues.join("\n"));
  return { checks, status: "VPS_PRODUCTION_STATIC_VALID" };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  verifyVpsPilot()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      console.error(
        error instanceof Error ? error.message : "VPS_PRODUCTION_STATIC_VALIDATION_FAILED",
      );
      process.exitCode = 1;
    });
}
