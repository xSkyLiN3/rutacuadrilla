import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, shouldLoadLocalEnvironment } from "../src/config.js";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

const validEnvironment = {
  API_HOST: "127.0.0.1",
  API_PORT: "4310",
  CORS_ORIGIN: "http://127.0.0.1:4311,http://127.0.0.1:4312",
  DATABASE_DIR: ".local/test-db",
  NODE_ENV: "test",
  SESSION_SECRET: "test-only-secret-with-more-than-32-characters",
  SESSION_TTL_MINUTES: "30",
};

describe("API configuration", () => {
  it("parses explicit settings and normalizes numeric values", () => {
    const config = loadConfig(validEnvironment);
    expect(config.appProfile).toBe("simple");
    expect(config.apiPort).toBe(4310);
    expect(config.sessionTtlMinutes).toBe(30);
    expect(config.environment).toBe("test");
    expect(config.databaseDir).toBe(resolve(workspaceRoot, ".local/test-db"));
    expect(config.corsOrigins).toEqual(["http://127.0.0.1:4311", "http://127.0.0.1:4312"]);
    expect(config.trustProxy).toBe(0);
  });

  it("resolves a relative database directory from an explicit workspace root", () => {
    const databasePathBase = resolve("test-workspace-root");
    const config = loadConfig(validEnvironment, { databasePathBase });

    expect(config.databaseDir).toBe(resolve(databasePathBase, ".local/test-db"));
  });

  it("accepts the full profile only when it is explicit", () => {
    expect(loadConfig({ ...validEnvironment, APP_PROFILE: "full" }).appProfile).toBe("full");
    expect(() => loadConfig({ ...validEnvironment, APP_PROFILE: "legacy" })).toThrow();
  });

  it("refuses a weak session secret", () => {
    expect(() => loadConfig({ ...validEnvironment, SESSION_SECRET: "too-short" })).toThrow();
  });

  it("refuses a wildcard CORS origin", () => {
    expect(() => loadConfig({ ...validEnvironment, CORS_ORIGIN: "*" })).toThrow();
  });

  it("loads the session secret through an injected file reader", () => {
    const secretPath = "/run/secrets/session_secret";
    const fileSecret = "secret-loaded-from-file-with-more-than-32-characters";
    const config = loadConfig(
      {
        ...validEnvironment,
        SESSION_SECRET: undefined,
        SESSION_SECRET_FILE: secretPath,
      },
      {
        readSecretFile(path) {
          expect(path).toBe(secretPath);
          return `${fileSecret}\n`;
        },
      },
    );
    expect(config.sessionSecret).toBe(fileSecret);
  });

  it("requires exactly one session-secret source", () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        SESSION_SECRET: undefined,
        SESSION_SECRET_FILE: undefined,
      }),
    ).toThrow();
    expect(() =>
      loadConfig({ ...validEnvironment, SESSION_SECRET_FILE: "/run/secrets/session_secret" }),
    ).toThrow();
  });

  it("loads a PostgreSQL URL from an absolute secret file", () => {
    const databaseUrlPath = "/run/secrets/database_url";
    const databaseUrl = "postgresql://rutacuadrilla:secret@postgres:5432/rutacuadrilla";
    const config = loadConfig(
      {
        ...validEnvironment,
        DATABASE_URL_FILE: databaseUrlPath,
      },
      {
        readSecretFile(path) {
          expect(path).toBe(databaseUrlPath);
          return `${databaseUrl}\n`;
        },
      },
    );
    expect(config.databaseUrl).toBe(databaseUrl);
  });

  it("requires a single valid PostgreSQL URL source", () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        DATABASE_URL: "postgresql://rutacuadrilla:secret@postgres:5432/rutacuadrilla",
        DATABASE_URL_FILE: "/run/secrets/database_url",
      }),
    ).toThrow();
    expect(() => loadConfig({ ...validEnvironment, DATABASE_URL: "not-a-database-url" })).toThrow();
  });

  it("accepts a bounded proxy hop count or explicit CIDRs", () => {
    expect(loadConfig({ ...validEnvironment, TRUST_PROXY: "1" }).trustProxy).toBe(1);
    expect(
      loadConfig({
        ...validEnvironment,
        TRUST_PROXY: "127.0.0.0/8, ::1/128, 10.0.0.0/24",
      }).trustProxy,
    ).toEqual(["127.0.0.0/8", "::1/128", "10.0.0.0/24"]);
  });

  it.each(["true", "*", "127.0.0.1", "10.0.0.0/33", "::1/129", "256"])(
    "refuses unsafe or invalid TRUST_PROXY value %s",
    (trustProxy) => {
      expect(() => loadConfig({ ...validEnvironment, TRUST_PROXY: trustProxy })).toThrow();
    },
  );

  it("accepts a complete production configuration", () => {
    const config = loadConfig({
      ...validEnvironment,
      CORS_ORIGIN: "https://admin.rutacuadrilla.example,https://campo.rutacuadrilla.example",
      DATABASE_DIR: "/var/lib/rutacuadrilla/database",
      NODE_ENV: "production",
      SESSION_SECRET: "vps-production-entropy-4f4c51f03d6748d595df0738",
      TRUST_PROXY: "1",
    });
    expect(config.environment).toBe("production");
    expect(config.trustProxy).toBe(1);
  });

  it.each([
    "http://campo.rutacuadrilla.example",
    "https://campo.rutacuadrilla.example/path",
    "https://campo.rutacuadrilla.example/",
    "https://*.rutacuadrilla.example",
  ])("refuses non-HTTPS, non-origin-only, or wildcard production CORS value %s", (origin) => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        CORS_ORIGIN: origin,
        DATABASE_DIR: "/var/lib/rutacuadrilla/database",
        NODE_ENV: "production",
        SESSION_SECRET: "vps-production-entropy-4f4c51f03d6748d595df0738",
        TRUST_PROXY: "1",
      }),
    ).toThrow();
  });

  it("refuses incomplete or placeholder production settings", () => {
    const production = {
      ...validEnvironment,
      CORS_ORIGIN: "https://campo.rutacuadrilla.example",
      DATABASE_DIR: "/var/lib/rutacuadrilla/database",
      NODE_ENV: "production",
      SESSION_SECRET: "vps-production-entropy-4f4c51f03d6748d595df0738",
      TRUST_PROXY: "1",
    };
    expect(() => loadConfig({ ...production, TRUST_PROXY: undefined })).toThrow();
    expect(() => loadConfig({ ...production, DATABASE_DIR: ".local/database" })).toThrow();
    expect(() =>
      loadConfig({
        ...production,
        SESSION_SECRET: "change-me-change-me-change-me-change-me-now",
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...production,
        SESSION_SECRET: "replace-with-at-least-32-random-characters",
      }),
    ).toThrow();
    expect(() =>
      loadConfig(
        {
          ...production,
          SESSION_SECRET: undefined,
          SESSION_SECRET_FILE: "secrets/session_secret",
        },
        { readSecretFile: () => "file-production-entropy-83ae77c867044965a810" },
      ),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...production,
        DATABASE_URL_FILE: "secrets/database_url",
      }),
    ).toThrow();
  });

  it("does not load a local env file when production is already declared", () => {
    expect(shouldLoadLocalEnvironment({ NODE_ENV: "production" })).toBe(false);
    expect(shouldLoadLocalEnvironment({ NODE_ENV: "development" })).toBe(true);
    expect(shouldLoadLocalEnvironment({})).toBe(true);
  });
});
