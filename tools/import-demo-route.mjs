import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const apiOrigin = process.env.RUTACUADRILLA_API_ORIGIN?.trim() || "http://127.0.0.1:4310";
const operationId = "44444444-4444-4444-8444-444444444444";

function parseArguments(argv) {
  const argumentsSet = new Set(argv);
  const unknown = [...argumentsSet].filter(
    (argument) => !["--apply", "--audit"].includes(argument),
  );
  if (unknown.length > 0) throw new Error(`Argumento desconocido: ${unknown.join(", ")}`);
  if (argumentsSet.has("--apply") && argumentsSet.has("--audit")) {
    throw new Error("Usa --audit o --apply, no ambos.");
  }
  return { apply: argumentsSet.has("--apply") };
}

function requiredMatch(text, pattern, label) {
  const match = text.match(pattern);
  if (!match?.[1]?.trim()) throw new Error(`No se encontró ${label}.`);
  return match[1].trim();
}

function localCredentials(text) {
  const [adminSection, fieldSection = ""] = text.split(/^Campo:/m);
  return {
    adminEmail: requiredMatch(adminSection, /^Correo:\s*(.+)$/m, "el correo administrador"),
    adminPassword: requiredMatch(
      adminSection,
      /^Contraseña:\s*(.+)$/m,
      "la contraseña administradora",
    ),
    fieldEmail: requiredMatch(fieldSection, /^Correo:\s*(.+)$/m, "el correo de Campo"),
    fieldPassword: requiredMatch(fieldSection, /^Contraseña:\s*(.+)$/m, "la contraseña de Campo"),
  };
}

async function readLocalCredentials() {
  if (process.env.RUTACUADRILLA_DEMO_ENV_ONLY !== "1") {
    try {
      return localCredentials(
        await readFile(resolve(projectRoot, ".local", "credenciales-locales.txt"), "utf8"),
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  try {
    process.loadEnvFile(resolve(projectRoot, ".env"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const adminPassword = process.env.DEMO_ADMIN_PASSWORD?.trim();
  const fieldPassword = process.env.DEMO_MEMBER_PASSWORD?.trim();
  if (!adminPassword || !fieldPassword) {
    throw new Error(
      "Faltan las credenciales locales. Ejecuta local:postgres:setup o crea .env desde .env.demo.example.",
    );
  }
  return {
    adminEmail: "admin@demo.rutacuadrilla.local",
    adminPassword,
    fieldEmail: "miembro@demo.rutacuadrilla.local",
    fieldPassword,
  };
}

function parseRouteCsv(csv) {
  const lines = csv.trim().split(/\r?\n/u);
  if (
    lines[0] !== "external_id,street,number,latitude,longitude,point_type,source" ||
    lines.length < 2
  ) {
    throw new Error("El CSV sintético no cumple el contrato público.");
  }
  const ids = lines.slice(1).map((line) => line.slice(0, line.indexOf(",")));
  if (ids.some((id) => !id.startsWith("synthetic/dwelling/"))) {
    throw new Error("El CSV contiene un identificador que no es sintético.");
  }
  if (new Set(ids).size !== ids.length) throw new Error("El CSV contiene IDs duplicados.");
  return ids;
}

async function request(path, { body, method = "GET", token } = {}) {
  const headers = new Headers({ Accept: "application/json" });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let response;
  try {
    response = await fetch(`${apiOrigin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(`No fue posible conectar con la API en ${apiOrigin}.`);
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`La API respondió contenido inválido (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const code = payload?.code || `HTTP_${response.status}`;
    throw new Error(`La API rechazó la operación (${code}).`);
  }
  return payload;
}

async function loadDemoArtifacts() {
  const [areaText, csv, manifestText, segmentsText] = await Promise.all([
    readFile(resolve(projectRoot, "demo", "area.geojson"), "utf8"),
    readFile(resolve(projectRoot, "demo", "route.csv"), "utf8"),
    readFile(resolve(projectRoot, "demo", "manifest.json"), "utf8"),
    readFile(resolve(projectRoot, "demo", "segments.json"), "utf8"),
  ]);
  const area = JSON.parse(areaText);
  const manifest = JSON.parse(manifestText);
  const segments = JSON.parse(segmentsText);
  const pointIds = parseRouteCsv(csv);
  if (
    manifest.synthetic !== true ||
    manifest.counts?.points !== pointIds.length ||
    manifest.counts?.segments !== segments.length ||
    manifest.files?.area !== "demo/area.geojson" ||
    manifest.files?.route !== "demo/route.csv" ||
    manifest.files?.segments !== "demo/segments.json" ||
    area?.type !== "MultiPolygon" ||
    !Array.isArray(area.coordinates) ||
    !Array.isArray(segments) ||
    segments.some(
      (segment) =>
        !segment.externalId?.startsWith("synthetic/segment/") ||
        !["LEFT", "RIGHT", "BOTH"].includes(segment.serviceSide) ||
        segment.source !== "GEOJSON",
    )
  ) {
    throw new Error("Los artefactos demo no coinciden con el manifiesto sintético.");
  }
  return { area, csv, manifest, pointIds, segments };
}

function comparableSegment(segment, displayOrder) {
  return {
    attribution: segment.attribution ?? null,
    displayOrder,
    externalId: segment.externalId,
    geometry: segment.geometry,
    name: segment.name ?? null,
    serviceSide: segment.serviceSide,
    source: segment.source,
    sourceVersion: segment.sourceVersion ?? null,
  };
}

async function applyDemo({ area, csv, manifest, pointIds, segments }) {
  const credentials = await readLocalCredentials();

  const login = await request("/api/auth/login", {
    method: "POST",
    body: { email: credentials.adminEmail, password: credentials.adminPassword },
  });
  const adminMembership = login.memberships.find((membership) => membership.role === "ADMIN");
  if (!adminMembership) throw new Error("La cuenta local no tiene una membresía administradora.");
  const { crewId } = adminMembership;
  const token = login.token;

  try {
    const overview = await request(
      `/api/simple/admin/crews/${encodeURIComponent(crewId)}/overview`,
      { token },
    );
    const fieldUser = overview.users.find(
      (user) => user.email === credentials.fieldEmail.toLocaleLowerCase("en"),
    );
    if (!fieldUser) throw new Error("No se encontró el usuario sintético de Campo.");

    const imported = await request(
      `/api/simple/admin/crews/${encodeURIComponent(crewId)}/routes/import`,
      {
        method: "POST",
        token,
        body: {
          area,
          csv,
          operationId,
          routeName: manifest.name,
          sectorName: manifest.sectorName,
          segments,
        },
      },
    );
    const routeId = imported.route?.id;
    if (!routeId) throw new Error("La API no devolvió la ruta demo publicada.");
    const publishedRevision = imported.route.revisions?.find(
      (revision) => revision.status === "PUBLISHED",
    );
    if (
      publishedRevision?.segmentCount !== segments.length ||
      publishedRevision.area?.type !== area.type ||
      JSON.stringify(publishedRevision.area.coordinates) !== JSON.stringify(area.coordinates)
    ) {
      throw new Error("Administración no publicó el área y los segmentos exactos de la demo.");
    }

    await request(
      `/api/simple/admin/crews/${encodeURIComponent(crewId)}/users/${encodeURIComponent(fieldUser.id)}/assignment`,
      { method: "PUT", token, body: { routeId } },
    );

    await request("/api/auth/logout", { method: "POST", token });
    const fieldLogin = await request("/api/auth/login", {
      method: "POST",
      body: { email: credentials.fieldEmail, password: credentials.fieldPassword },
    });
    try {
      const context = await request("/api/simple/field/assignment", { token: fieldLogin.token });
      const assignment = context?.assignment;
      const receivedIds = new Set(assignment?.points?.map((point) => point.externalId));
      const receivedSegments = (assignment?.segments ?? []).map((segment) =>
        comparableSegment(segment, segment.displayOrder),
      );
      const expectedSegments = segments.map(comparableSegment);
      if (
        assignment?.route?.name !== manifest.name ||
        receivedIds.size !== pointIds.length ||
        pointIds.some((id) => !receivedIds.has(id)) ||
        receivedSegments.length !== segments.length ||
        JSON.stringify(receivedSegments) !== JSON.stringify(expectedSegments)
      ) {
        throw new Error("Campo no recibió exactamente los puntos y segmentos de la ruta demo.");
      }
      return {
        area: true,
        points: pointIds.length,
        route: manifest.name,
        routeId,
        segments: segments.length,
        synthetic: true,
        verified: true,
      };
    } finally {
      await request("/api/auth/logout", { method: "POST", token: fieldLogin.token }).catch(
        () => undefined,
      );
    }
  } catch (error) {
    await request("/api/auth/logout", { method: "POST", token }).catch(() => undefined);
    throw error;
  }
}

const options = parseArguments(process.argv.slice(2));
const artifacts = await loadDemoArtifacts();
const result = options.apply
  ? await applyDemo(artifacts)
  : {
      action: "audit",
      area: true,
      applyRequired: "Inicia la API y vuelve a ejecutar con --apply.",
      points: artifacts.pointIds.length,
      route: artifacts.manifest.name,
      segments: artifacts.segments.length,
      synthetic: true,
      valid: true,
    };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
