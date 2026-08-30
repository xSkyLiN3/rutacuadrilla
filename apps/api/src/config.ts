import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

const environmentSchema = z
  .object({
    APP_PROFILE: z.enum(["simple", "full"]).default("simple"),
    API_HOST: z.string().min(1).default("127.0.0.1"),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(4310),
    CORS_ORIGIN: z.string().default("http://127.0.0.1:4311,http://127.0.0.1:4312"),
    DATABASE_DIR: z.string().min(1).default(".local/rutacuadrilla-db"),
    DATABASE_URL: z.string().min(1).optional(),
    DATABASE_URL_FILE: z.string().min(1).optional(),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    SESSION_SECRET: z.string().optional(),
    SESSION_SECRET_FILE: z.string().min(1).optional(),
    SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(10_080).default(480),
    TRUST_PROXY: z.string().optional(),
  })
  .superRefine((environment, context) => {
    if (!environment.SESSION_SECRET && !environment.SESSION_SECRET_FILE) {
      context.addIssue({
        code: "custom",
        message: "SESSION_SECRET or SESSION_SECRET_FILE is required",
        path: ["SESSION_SECRET"],
      });
    }
    if (environment.SESSION_SECRET && environment.SESSION_SECRET_FILE) {
      context.addIssue({
        code: "custom",
        message: "Set only one of SESSION_SECRET or SESSION_SECRET_FILE",
        path: ["SESSION_SECRET_FILE"],
      });
    }
    if (environment.DATABASE_URL && environment.DATABASE_URL_FILE) {
      context.addIssue({
        code: "custom",
        message: "Set only one of DATABASE_URL or DATABASE_URL_FILE",
        path: ["DATABASE_URL_FILE"],
      });
    }
    if (environment.NODE_ENV === "production") {
      if (environment.TRUST_PROXY === undefined) {
        context.addIssue({
          code: "custom",
          message: "TRUST_PROXY must be explicitly configured in production",
          path: ["TRUST_PROXY"],
        });
      }
      if (
        !environment.DATABASE_URL &&
        !environment.DATABASE_URL_FILE &&
        !isPortableAbsolutePath(environment.DATABASE_DIR)
      ) {
        context.addIssue({
          code: "custom",
          message: "DATABASE_DIR must be absolute in production",
          path: ["DATABASE_DIR"],
        });
      }
      if (
        environment.SESSION_SECRET_FILE &&
        !isPortableAbsolutePath(environment.SESSION_SECRET_FILE)
      ) {
        context.addIssue({
          code: "custom",
          message: "SESSION_SECRET_FILE must be absolute in production",
          path: ["SESSION_SECRET_FILE"],
        });
      }
      if (environment.DATABASE_URL_FILE && !isPortableAbsolutePath(environment.DATABASE_URL_FILE)) {
        context.addIssue({
          code: "custom",
          message: "DATABASE_URL_FILE must be absolute in production",
          path: ["DATABASE_URL_FILE"],
        });
      }
    }
  });

const sessionSecretSchema = z.string().min(32);

export type TrustProxyConfig = number | string[];

export type ApiConfig = {
  appProfile: "simple" | "full";
  apiHost: string;
  apiPort: number;
  corsOrigins: string[];
  databaseDir: string;
  databaseUrl?: string;
  environment: "development" | "test" | "production";
  sessionSecret: string;
  sessionTtlMinutes: number;
  trustProxy: TrustProxyConfig;
};

export type LoadConfigDependencies = {
  databasePathBase?: string;
  readSecretFile?: (path: string) => string;
};

function isPortableAbsolutePath(path: string): boolean {
  return isAbsolute(path) || posix.isAbsolute(path) || win32.isAbsolute(path);
}

function isPlaceholderSecret(secret: string): boolean {
  const normalized = secret.trim().toLowerCase();
  return (
    /^(change|replace)(?:[-_ ]?me|[-_ ]?with)\b/u.test(normalized) ||
    /^(example|placeholder|test[-_ ]?only)(\b|[-_ ])/u.test(normalized) ||
    normalized.includes("your-secret-here")
  );
}

function parseDatabaseUrl(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !url.hostname ||
    !url.username
  ) {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  return normalized;
}

function parseCorsOrigins(value: string, environment: ApiConfig["environment"]): string[] {
  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0) throw new Error("CORS_ORIGIN must contain exact origins");

  for (const origin of origins) {
    if (origin.includes("*")) throw new Error("CORS_ORIGIN must not contain wildcards");
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`Invalid CORS origin: ${origin}`);
    }
    if (url.origin !== origin) {
      throw new Error(`CORS origin must be an exact origin without a path: ${origin}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Unsupported CORS origin protocol: ${origin}`);
    }
    if (environment === "production" && url.protocol !== "https:") {
      throw new Error(`Production CORS origin must use HTTPS: ${origin}`);
    }
  }

  return [...new Set(origins)];
}

function parseTrustProxy(value: string | undefined): TrustProxyConfig {
  const normalized = value?.trim() ?? "0";
  if (/^\d+$/u.test(normalized)) {
    const hops = Number(normalized);
    if (Number.isSafeInteger(hops) && hops >= 0 && hops <= 255) return hops;
    throw new Error("TRUST_PROXY hop count must be between 0 and 255");
  }

  const cidrs = normalized
    .split(",")
    .map((cidr) => cidr.trim())
    .filter(Boolean);
  if (cidrs.length === 0) throw new Error("TRUST_PROXY must contain a hop count or CIDRs");
  for (const cidr of cidrs) {
    const separator = cidr.lastIndexOf("/");
    const address = separator === -1 ? "" : cidr.slice(0, separator);
    const prefixText = separator === -1 ? "" : cidr.slice(separator + 1);
    const version = isIP(address);
    const prefix = Number(prefixText);
    const maximumPrefix = version === 4 ? 32 : 128;
    if (
      version === 0 ||
      !/^\d+$/u.test(prefixText) ||
      !Number.isInteger(prefix) ||
      prefix < 0 ||
      prefix > maximumPrefix
    ) {
      throw new Error(`Invalid TRUST_PROXY CIDR: ${cidr}`);
    }
  }
  return cidrs;
}

export function shouldLoadLocalEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return environment.NODE_ENV !== "production";
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: LoadConfigDependencies = {},
): ApiConfig {
  const parsed = environmentSchema.parse(environment);
  const readSecretFile =
    dependencies.readSecretFile ?? ((path: string) => readFileSync(path, "utf8"));
  const secretSource = parsed.SESSION_SECRET_FILE
    ? readSecretFile(parsed.SESSION_SECRET_FILE).trim()
    : parsed.SESSION_SECRET;
  const sessionSecret = sessionSecretSchema.parse(secretSource);
  const databaseUrl = parseDatabaseUrl(
    parsed.DATABASE_URL_FILE
      ? readSecretFile(parsed.DATABASE_URL_FILE).trim()
      : parsed.DATABASE_URL,
  );
  if (parsed.NODE_ENV === "production" && isPlaceholderSecret(sessionSecret)) {
    throw new Error("SESSION_SECRET must not be a placeholder in production");
  }

  return {
    appProfile: parsed.APP_PROFILE,
    apiHost: parsed.API_HOST,
    apiPort: parsed.API_PORT,
    corsOrigins: parseCorsOrigins(parsed.CORS_ORIGIN, parsed.NODE_ENV),
    databaseDir: resolve(dependencies.databasePathBase ?? workspaceRoot, parsed.DATABASE_DIR),
    ...(databaseUrl ? { databaseUrl } : {}),
    environment: parsed.NODE_ENV,
    sessionSecret,
    sessionTtlMinutes: parsed.SESSION_TTL_MINUTES,
    trustProxy: parseTrustProxy(parsed.TRUST_PROXY),
  };
}
