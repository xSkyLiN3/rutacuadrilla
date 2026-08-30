export const ROUTE_PACKAGE_KIND = "ROUTE_REVISION_PACKAGE" as const;
export const ROUTE_PACKAGE_SCHEMA_VERSION = 1 as const;
export const MAX_ROUTE_PACKAGE_BYTES = 25_000_000;

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export type ImmutableRevisionStatus = "PUBLISHED" | "SUPERSEDED" | "ARCHIVED";

export type RoutePackagePointV1 = {
  displayOrder: number;
  externalId: string;
  id: string;
  latitude: number;
  longitude: number;
  number?: string;
  pointType: "DWELLING" | "BUILDING_ENTRANCE" | "COMPLEX_ACCESS" | "SPECIAL";
  servicePointVersionId: string;
  source: "MANUAL" | "CSV" | "OSM" | "GEOJSON";
  street?: string;
};

export type RoutePackageSegmentV1 = {
  attribution?: string;
  displayOrder: number;
  externalId: string;
  geometry: {
    coordinates: Array<Array<[longitude: number, latitude: number]>>;
    type: "MultiLineString";
  };
  id: string;
  name?: string;
  serviceSide: "LEFT" | "RIGHT" | "BOTH";
  source: "MANUAL" | "OSM" | "GEOJSON";
  sourceVersion?: string;
  streetSegmentVersionId: string;
};

export type RoutePackageAreaV1 = {
  coordinates: Array<Array<Array<[longitude: number, latitude: number]>>>;
  type: "MultiPolygon";
};

export type RoutePackageAttributionV1 = {
  label: string;
  url: string;
};

export type RoutePackageBoundsV1 = {
  east: number;
  north: number;
  south: number;
  west: number;
};

export type RoutePackageV1 = {
  area: RoutePackageAreaV1 | null;
  attributions: RoutePackageAttributionV1[];
  bounds: RoutePackageBoundsV1;
  crewId: string;
  kind: typeof ROUTE_PACKAGE_KIND;
  points: RoutePackagePointV1[];
  revision: {
    contentHash: string;
    id: string;
    number: number;
    pointCount: number;
    publishedAt: string;
    status: ImmutableRevisionStatus;
  };
  route: {
    id: string;
    name: string;
    sectorName: string;
  };
  schemaVersion: typeof ROUTE_PACKAGE_SCHEMA_VERSION;
  segments: RoutePackageSegmentV1[];
};

export type RoutePackageScope = {
  accountId: string;
  crewId: string;
  revisionId: string;
  routeId: string;
};

export type RoutePackageDownload = {
  body: string;
  byteLength: number;
  etag: string;
  sha256: string;
};

export type StoredRoutePackage = RoutePackageScope & {
  body: string;
  byteLength: number;
  contentHash: string;
  etag: string;
  revisionNumber: number;
  routeName: string;
  schemaVersion: number;
  sha256: string;
  storedAt: string;
  verifiedAt: string;
};

export type VerifiedRoutePackage = {
  package: RoutePackageV1;
  record: StoredRoutePackage;
};

export class LocalPackageError extends Error {
  constructor(
    readonly code:
      | "LOCAL_PACKAGE_CORRUPT"
      | "LOCAL_PACKAGE_IDENTITY_CHANGED"
      | "LOCAL_PACKAGE_INVALID"
      | "LOCAL_PACKAGE_NOT_FOUND"
      | "LOCAL_STORAGE_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "LocalPackageError";
  }
}

export interface RoutePackagePersistence {
  clearAccount(accountId: string): Promise<void>;
  close(): void;
  delete(scope: RoutePackageScope): Promise<void>;
  get(scope: RoutePackageScope): Promise<StoredRoutePackage | undefined>;
  list(accountId: string, crewId: string): Promise<StoredRoutePackage[]>;
  put(record: StoredRoutePackage): Promise<void>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      `El paquete no contiene un valor válido para ${field}.`,
    );
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      `El paquete no contiene un número válido para ${field}.`,
    );
  }
  return value;
}

function requireInteger(value: unknown, field: string, minimum = 0): number {
  const parsed = requireNumber(value, field);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      `El paquete no contiene un entero válido para ${field}.`,
    );
  }
  return parsed;
}

function requireOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function requireIsoDate(value: unknown, field: string): string {
  const parsed = requireString(value, field);
  if (!Number.isFinite(Date.parse(parsed))) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      `El paquete no contiene una fecha válida para ${field}.`,
    );
  }
  return parsed;
}

function requireHttpsUrl(value: unknown, field: string): string {
  const parsed = requireString(value, field);
  try {
    if (new URL(parsed).protocol !== "https:") throw new Error("invalid protocol");
  } catch {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      `El paquete no contiene una URL HTTPS válida para ${field}.`,
    );
  }
  return parsed;
}

function parseBounds(value: unknown): RoutePackageBoundsV1 {
  if (!isObject(value)) {
    throw new LocalPackageError("LOCAL_PACKAGE_INVALID", "El paquete no contiene límites válidos.");
  }
  const bounds = {
    east: requireNumber(value.east, "bounds.east"),
    north: requireNumber(value.north, "bounds.north"),
    south: requireNumber(value.south, "bounds.south"),
    west: requireNumber(value.west, "bounds.west"),
  };
  if (
    bounds.west < -180 ||
    bounds.east > 180 ||
    bounds.south < -90 ||
    bounds.north > 90 ||
    bounds.west > bounds.east ||
    bounds.south > bounds.north
  ) {
    throw new LocalPackageError("LOCAL_PACKAGE_INVALID", "Los límites del paquete son inválidos.");
  }
  return bounds;
}

function parsePoint(value: unknown, expectedDisplayOrder: number): RoutePackagePointV1 {
  if (!isObject(value)) {
    throw new LocalPackageError("LOCAL_PACKAGE_INVALID", "El paquete contiene un punto inválido.");
  }
  const displayOrder = requireInteger(value.displayOrder, "points.displayOrder");
  if (displayOrder !== expectedDisplayOrder) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      "El orden de los puntos del paquete no es canónico.",
    );
  }
  const latitude = requireNumber(value.latitude, "points.latitude");
  const longitude = requireNumber(value.longitude, "points.longitude");
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      "El paquete contiene coordenadas fuera de rango.",
    );
  }
  const pointType = requireString(value.pointType, "points.pointType");
  if (!["DWELLING", "BUILDING_ENTRANCE", "COMPLEX_ACCESS", "SPECIAL"].includes(pointType)) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      "El paquete contiene un tipo de punto inválido.",
    );
  }
  const source = requireString(value.source, "points.source");
  if (!["MANUAL", "CSV", "OSM", "GEOJSON"].includes(source)) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      "El paquete contiene una fuente inválida.",
    );
  }
  return {
    displayOrder,
    externalId: requireString(value.externalId, "points.externalId"),
    id: requireString(value.id, "points.id"),
    latitude,
    longitude,
    pointType: pointType as RoutePackagePointV1["pointType"],
    servicePointVersionId: requireString(
      value.servicePointVersionId,
      "points.servicePointVersionId",
    ),
    source: source as RoutePackagePointV1["source"],
    ...(value.number === undefined
      ? {}
      : { number: requireOptionalString(value.number, "points.number") as string }),
    ...(value.street === undefined
      ? {}
      : { street: requireOptionalString(value.street, "points.street") as string }),
  };
}

function parseSegment(value: unknown, expectedDisplayOrder: number): RoutePackageSegmentV1 {
  if (!isObject(value)) {
    throw new LocalPackageError("LOCAL_PACKAGE_INVALID", "El paquete contiene un tramo inválido.");
  }
  const displayOrder = requireInteger(value.displayOrder, "segments.displayOrder");
  if (displayOrder !== expectedDisplayOrder) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      "El orden de los tramos del paquete no es canónico.",
    );
  }
  if (
    !isObject(value.geometry) ||
    value.geometry.type !== "MultiLineString" ||
    !Array.isArray(value.geometry.coordinates) ||
    value.geometry.coordinates.length === 0
  ) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      "El paquete contiene una geometría de tramo inválida.",
    );
  }
  const coordinates = value.geometry.coordinates.map((component, componentIndex) => {
    if (!Array.isArray(component) || component.length < 2) {
      throw new LocalPackageError(
        "LOCAL_PACKAGE_INVALID",
        "Cada componente de un tramo debe contener al menos dos coordenadas.",
      );
    }
    return component.map((position, positionIndex): [number, number] => {
      if (!Array.isArray(position) || position.length !== 2) {
        throw new LocalPackageError(
          "LOCAL_PACKAGE_INVALID",
          "El paquete contiene una coordenada de tramo inválida.",
        );
      }
      const coordinateField = `segments.geometry.coordinates.${componentIndex}.${positionIndex}`;
      const longitude = requireNumber(position[0], `${coordinateField}.longitude`);
      const latitude = requireNumber(position[1], `${coordinateField}.latitude`);
      if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
        throw new LocalPackageError(
          "LOCAL_PACKAGE_INVALID",
          "El paquete contiene coordenadas de tramo fuera de rango.",
        );
      }
      return [longitude, latitude];
    });
  });
  const serviceSide =
    value.serviceSide === undefined
      ? "BOTH"
      : requireString(value.serviceSide, "segments.serviceSide");
  if (!["LEFT", "RIGHT", "BOTH"].includes(serviceSide)) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      "El paquete contiene un lado atendido inválido.",
    );
  }
  const source = requireString(value.source, "segments.source");
  if (!["MANUAL", "OSM", "GEOJSON"].includes(source)) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      "El paquete contiene una fuente de tramo inválida.",
    );
  }
  return {
    displayOrder,
    externalId: requireString(value.externalId, "segments.externalId"),
    geometry: { type: "MultiLineString", coordinates },
    id: requireString(value.id, "segments.id"),
    serviceSide: serviceSide as RoutePackageSegmentV1["serviceSide"],
    source: source as RoutePackageSegmentV1["source"],
    streetSegmentVersionId: requireString(
      value.streetSegmentVersionId,
      "segments.streetSegmentVersionId",
    ),
    ...(value.attribution === undefined
      ? {}
      : {
          attribution: requireOptionalString(value.attribution, "segments.attribution") as string,
        }),
    ...(value.name === undefined
      ? {}
      : { name: requireOptionalString(value.name, "segments.name") as string }),
    ...(value.sourceVersion === undefined
      ? {}
      : {
          sourceVersion: requireOptionalString(
            value.sourceVersion,
            "segments.sourceVersion",
          ) as string,
        }),
  };
}

function parseArea(value: unknown): RoutePackageAreaV1 | null {
  if (value === undefined || value === null) return null;
  if (
    !isObject(value) ||
    value.type !== "MultiPolygon" ||
    !Array.isArray(value.coordinates) ||
    value.coordinates.length === 0
  ) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      "El paquete contiene un área MultiPolygon inválida.",
    );
  }
  const coordinates = value.coordinates.map((polygon, polygonIndex) => {
    if (!Array.isArray(polygon) || polygon.length === 0) {
      throw new LocalPackageError(
        "LOCAL_PACKAGE_INVALID",
        "Cada polígono del área debe contener al menos un anillo.",
      );
    }
    return polygon.map((ring, ringIndex) => {
      if (!Array.isArray(ring) || ring.length < 4) {
        throw new LocalPackageError(
          "LOCAL_PACKAGE_INVALID",
          "Cada anillo del área debe contener al menos cuatro coordenadas.",
        );
      }
      const positions = ring.map((position, positionIndex): [number, number] => {
        if (!Array.isArray(position) || position.length !== 2) {
          throw new LocalPackageError(
            "LOCAL_PACKAGE_INVALID",
            "El paquete contiene una coordenada de área inválida.",
          );
        }
        const coordinateField = `area.coordinates.${polygonIndex}.${ringIndex}.${positionIndex}`;
        const longitude = requireNumber(position[0], `${coordinateField}.longitude`);
        const latitude = requireNumber(position[1], `${coordinateField}.latitude`);
        if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
          throw new LocalPackageError(
            "LOCAL_PACKAGE_INVALID",
            "El paquete contiene coordenadas de área fuera de rango.",
          );
        }
        return [longitude, latitude];
      });
      const first = positions[0];
      const last = positions.at(-1);
      if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
        throw new LocalPackageError(
          "LOCAL_PACKAGE_INVALID",
          "Los anillos del área deben estar cerrados.",
        );
      }
      return positions;
    });
  });
  return { type: "MultiPolygon", coordinates };
}

function assertUniqueSegmentIdentities(segments: RoutePackageSegmentV1[]): void {
  const ids = new Set<string>();
  const externalIdentities = new Set<string>();
  const versionIds = new Set<string>();
  for (const segment of segments) {
    if (
      ids.has(segment.id) ||
      externalIdentities.has(`${segment.source}\u0000${segment.externalId}`) ||
      versionIds.has(segment.streetSegmentVersionId)
    ) {
      throw new LocalPackageError(
        "LOCAL_PACKAGE_INVALID",
        "El paquete contiene identidades de tramo duplicadas.",
      );
    }
    ids.add(segment.id);
    externalIdentities.add(`${segment.source}\u0000${segment.externalId}`);
    versionIds.add(segment.streetSegmentVersionId);
  }
}

export function parseRoutePackage(value: unknown): RoutePackageV1 {
  if (!isObject(value) || value.kind !== ROUTE_PACKAGE_KIND) {
    throw new LocalPackageError("LOCAL_PACKAGE_INVALID", "El archivo no es un paquete de ruta.");
  }
  if (value.schemaVersion !== ROUTE_PACKAGE_SCHEMA_VERSION) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      "La versión del paquete de ruta no es compatible.",
    );
  }
  if (!isObject(value.route) || !isObject(value.revision) || !Array.isArray(value.points)) {
    throw new LocalPackageError("LOCAL_PACKAGE_INVALID", "La estructura del paquete es inválida.");
  }

  const status = requireString(value.revision.status, "revision.status");
  if (!["PUBLISHED", "SUPERSEDED", "ARCHIVED"].includes(status)) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      "Solo una revisión inmutable puede almacenarse localmente.",
    );
  }
  const contentHash = requireString(value.revision.contentHash, "revision.contentHash");
  if (!SHA256_HEX_PATTERN.test(contentHash)) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      "El hash de la revisión no tiene formato SHA-256.",
    );
  }
  const pointCount = requireInteger(value.revision.pointCount, "revision.pointCount", 1);
  if (pointCount !== value.points.length) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      "La cantidad declarada de puntos no coincide con el contenido.",
    );
  }

  const area = parseArea(value.area);
  const points = value.points.map((point, index) => parsePoint(point, index));
  if (value.segments !== undefined && !Array.isArray(value.segments)) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      "La colección de tramos del paquete es inválida.",
    );
  }
  if (Array.isArray(value.segments) && value.segments.length > 10_000) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      "El paquete supera el máximo de 10.000 tramos.",
    );
  }
  const segments = (value.segments ?? []).map((segment, index) => parseSegment(segment, index));
  assertUniqueSegmentIdentities(segments);
  const bounds = parseBounds(value.bounds);
  for (const point of points) {
    if (
      point.longitude < bounds.west ||
      point.longitude > bounds.east ||
      point.latitude < bounds.south ||
      point.latitude > bounds.north
    ) {
      throw new LocalPackageError(
        "LOCAL_PACKAGE_INVALID",
        "Los límites declarados no contienen todos los puntos.",
      );
    }
  }
  for (const segment of segments) {
    for (const component of segment.geometry.coordinates) {
      for (const [longitude, latitude] of component) {
        if (
          longitude < bounds.west ||
          longitude > bounds.east ||
          latitude < bounds.south ||
          latitude > bounds.north
        ) {
          throw new LocalPackageError(
            "LOCAL_PACKAGE_INVALID",
            "Los límites declarados no contienen todos los tramos.",
          );
        }
      }
    }
  }
  if (area) {
    for (const polygon of area.coordinates) {
      for (const ring of polygon) {
        for (const [longitude, latitude] of ring) {
          if (
            longitude < bounds.west ||
            longitude > bounds.east ||
            latitude < bounds.south ||
            latitude > bounds.north
          ) {
            throw new LocalPackageError(
              "LOCAL_PACKAGE_INVALID",
              "Los límites declarados no contienen toda el área.",
            );
          }
        }
      }
    }
  }

  if (!Array.isArray(value.attributions)) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      "Las atribuciones del paquete son inválidas.",
    );
  }
  const attributions = value.attributions.map((attribution) => {
    if (!isObject(attribution)) {
      throw new LocalPackageError(
        "LOCAL_PACKAGE_INVALID",
        "El paquete contiene una atribución inválida.",
      );
    }
    return {
      label: requireString(attribution.label, "attributions.label"),
      url: requireHttpsUrl(attribution.url, "attributions.url"),
    };
  });
  if (
    (points.some((point) => point.source === "OSM") ||
      segments.some((segment) => segment.source === "OSM")) &&
    !attributions.some((attribution) => attribution.label.includes("OpenStreetMap"))
  ) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      "El paquete usa datos OSM sin conservar su atribución.",
    );
  }

  return {
    area,
    attributions,
    bounds,
    crewId: requireString(value.crewId, "crewId"),
    kind: ROUTE_PACKAGE_KIND,
    points,
    revision: {
      contentHash,
      id: requireString(value.revision.id, "revision.id"),
      number: requireInteger(value.revision.number, "revision.number", 1),
      pointCount,
      publishedAt: requireIsoDate(value.revision.publishedAt, "revision.publishedAt"),
      status: status as ImmutableRevisionStatus,
    },
    route: {
      id: requireString(value.route.id, "route.id"),
      name: requireString(value.route.name, "route.name"),
      sectorName: requireString(value.route.sectorName, "route.sectorName"),
    },
    schemaVersion: ROUTE_PACKAGE_SCHEMA_VERSION,
    segments,
  };
}

export async function sha256Hex(body: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new LocalPackageError(
      "LOCAL_STORAGE_UNAVAILABLE",
      "Este navegador no permite verificar criptográficamente el paquete.",
    );
  }
  const bytes = new TextEncoder().encode(body);
  if (bytes.byteLength > MAX_ROUTE_PACKAGE_BYTES) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      "El paquete supera el límite local de 25 MB.",
    );
  }
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateScope(scope: RoutePackageScope): void {
  requireString(scope.accountId, "accountId");
  requireString(scope.crewId, "crewId");
  requireString(scope.routeId, "routeId");
  requireString(scope.revisionId, "revisionId");
}

function packageMatchesScope(routePackage: RoutePackageV1, scope: RoutePackageScope): boolean {
  return (
    routePackage.crewId === scope.crewId &&
    routePackage.route.id === scope.routeId &&
    routePackage.revision.id === scope.revisionId
  );
}

function normalizeDigest(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA256_HEX_PATTERN.test(normalized)) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_INVALID",
      "El servidor no entregó un hash SHA-256 válido.",
    );
  }
  return normalized;
}

async function verifyBody(
  body: string,
  expectedDigest: string,
  expectedByteLength: number,
): Promise<void> {
  const bytes = new TextEncoder().encode(body);
  if (bytes.byteLength !== expectedByteLength) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_CORRUPT",
      "El tamaño del paquete no coincide con el manifestado.",
    );
  }
  if ((await sha256Hex(body)) !== expectedDigest) {
    throw new LocalPackageError(
      "LOCAL_PACKAGE_CORRUPT",
      "La verificación SHA-256 del paquete falló.",
    );
  }
}

export class RoutePackageStore {
  constructor(
    private readonly persistence: RoutePackagePersistence = new IndexedDbRoutePackagePersistence(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async save(
    scope: RoutePackageScope,
    download: RoutePackageDownload,
  ): Promise<VerifiedRoutePackage> {
    validateScope(scope);
    const sha256 = normalizeDigest(download.sha256);
    await verifyBody(download.body, sha256, download.byteLength);
    if (download.etag !== `"sha256-${sha256}"`) {
      throw new LocalPackageError(
        "LOCAL_PACKAGE_INVALID",
        "El identificador HTTP no coincide con el hash del paquete.",
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(download.body);
    } catch {
      throw new LocalPackageError("LOCAL_PACKAGE_INVALID", "El paquete no contiene JSON válido.");
    }
    const routePackage = parseRoutePackage(parsed);
    if (!packageMatchesScope(routePackage, scope)) {
      throw new LocalPackageError(
        "LOCAL_PACKAGE_INVALID",
        "La identidad del paquete no coincide con la ruta solicitada.",
      );
    }

    let previous: VerifiedRoutePackage | undefined;
    try {
      previous = await this.find(scope);
    } catch (error) {
      if (!(error instanceof LocalPackageError) || error.code !== "LOCAL_PACKAGE_CORRUPT") {
        throw error;
      }
    }
    if (previous && previous.package.revision.contentHash !== routePackage.revision.contentHash) {
      throw new LocalPackageError(
        "LOCAL_PACKAGE_IDENTITY_CHANGED",
        "Una revisión inmutable intentó cambiar su hash de contenido.",
      );
    }

    const timestamp = this.now().toISOString();
    const record: StoredRoutePackage = {
      ...scope,
      body: download.body,
      byteLength: download.byteLength,
      contentHash: routePackage.revision.contentHash,
      etag: download.etag,
      revisionNumber: routePackage.revision.number,
      routeName: routePackage.route.name,
      schemaVersion: routePackage.schemaVersion,
      sha256,
      storedAt: timestamp,
      verifiedAt: timestamp,
    };
    await this.persistence.put(record);
    return { package: routePackage, record };
  }

  async load(scope: RoutePackageScope): Promise<VerifiedRoutePackage> {
    validateScope(scope);
    const record = await this.persistence.get(scope);
    if (!record) {
      throw new LocalPackageError(
        "LOCAL_PACKAGE_NOT_FOUND",
        "No existe una copia local para esta revisión.",
      );
    }
    try {
      const digest = normalizeDigest(record.sha256);
      await verifyBody(record.body, digest, record.byteLength);
      const routePackage = parseRoutePackage(JSON.parse(record.body) as unknown);
      if (
        !packageMatchesScope(routePackage, scope) ||
        routePackage.revision.contentHash !== record.contentHash ||
        record.etag !== `"sha256-${digest}"`
      ) {
        throw new LocalPackageError(
          "LOCAL_PACKAGE_CORRUPT",
          "La identidad guardada del paquete no coincide con su contenido.",
        );
      }
      const verifiedAt = this.now().toISOString();
      const verifiedRecord = { ...record, verifiedAt };
      await this.persistence.put(verifiedRecord);
      return { package: routePackage, record: verifiedRecord };
    } catch (error) {
      if (error instanceof LocalPackageError) {
        if (error.code === "LOCAL_STORAGE_UNAVAILABLE") throw error;
        await this.persistence.delete(scope);
        throw error.code === "LOCAL_PACKAGE_INVALID"
          ? new LocalPackageError("LOCAL_PACKAGE_CORRUPT", error.message)
          : error;
      }
      await this.persistence.delete(scope);
      throw new LocalPackageError(
        "LOCAL_PACKAGE_CORRUPT",
        "La copia local está dañada y fue retirada.",
      );
    }
  }

  async find(scope: RoutePackageScope): Promise<VerifiedRoutePackage | undefined> {
    try {
      return await this.load(scope);
    } catch (error) {
      if (error instanceof LocalPackageError && error.code === "LOCAL_PACKAGE_NOT_FOUND") {
        return undefined;
      }
      throw error;
    }
  }

  async list(accountId: string, crewId: string): Promise<StoredRoutePackage[]> {
    requireString(accountId, "accountId");
    requireString(crewId, "crewId");
    return this.persistence.list(accountId, crewId);
  }

  clearAccount(accountId: string): Promise<void> {
    requireString(accountId, "accountId");
    return this.persistence.clearAccount(accountId);
  }

  close(): void {
    this.persistence.close();
  }
}

const DATABASE_NAME = "rutacuadrilla-local-v1";
const DATABASE_VERSION = 1;
const STORE_NAME = "route-packages";
const ACCOUNT_CREW_INDEX = "by-account-crew";
const ACCOUNT_INDEX = "by-account";

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function idbTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB failed"));
  });
}

function routePackageKey(scope: RoutePackageScope): IDBValidKey {
  return [scope.accountId, scope.crewId, scope.routeId, scope.revisionId];
}

export class IndexedDbRoutePackagePersistence implements RoutePackagePersistence {
  private databasePromise: Promise<IDBDatabase> | undefined;

  constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB) {}

  private open(): Promise<IDBDatabase> {
    if (!this.factory) {
      return Promise.reject(
        new LocalPackageError(
          "LOCAL_STORAGE_UNAVAILABLE",
          "Este navegador no ofrece almacenamiento local compatible.",
        ),
      );
    }
    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        const request = this.factory?.open(DATABASE_NAME, DATABASE_VERSION);
        if (!request) {
          reject(
            new LocalPackageError(
              "LOCAL_STORAGE_UNAVAILABLE",
              "No se pudo abrir el almacenamiento local.",
            ),
          );
          return;
        }
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(STORE_NAME)) {
            const store = database.createObjectStore(STORE_NAME, {
              keyPath: ["accountId", "crewId", "routeId", "revisionId"],
            });
            store.createIndex(ACCOUNT_CREW_INDEX, ["accountId", "crewId"], { unique: false });
            store.createIndex(ACCOUNT_INDEX, "accountId", { unique: false });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
        request.onblocked = () =>
          reject(
            new LocalPackageError(
              "LOCAL_STORAGE_UNAVAILABLE",
              "El almacenamiento local está bloqueado por otra pestaña.",
            ),
          );
      });
    }
    return this.databasePromise;
  }

  async get(scope: RoutePackageScope): Promise<StoredRoutePackage | undefined> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const completed = idbTransaction(transaction);
    const result = await idbRequest(
      transaction.objectStore(STORE_NAME).get(routePackageKey(scope)) as IDBRequest<
        StoredRoutePackage | undefined
      >,
    );
    await completed;
    return result;
  }

  async put(record: StoredRoutePackage): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const completed = idbTransaction(transaction);
    await idbRequest(transaction.objectStore(STORE_NAME).put(record));
    await completed;
  }

  async delete(scope: RoutePackageScope): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const completed = idbTransaction(transaction);
    await idbRequest(transaction.objectStore(STORE_NAME).delete(routePackageKey(scope)));
    await completed;
  }

  async list(accountId: string, crewId: string): Promise<StoredRoutePackage[]> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const completed = idbTransaction(transaction);
    const index = transaction.objectStore(STORE_NAME).index(ACCOUNT_CREW_INDEX);
    const result = await idbRequest(
      index.getAll(IDBKeyRange.only([accountId, crewId])) as IDBRequest<StoredRoutePackage[]>,
    );
    await completed;
    return result.sort((left, right) => right.storedAt.localeCompare(left.storedAt));
  }

  async clearAccount(accountId: string): Promise<void> {
    const database = await this.open();
    const readTransaction = database.transaction(STORE_NAME, "readonly");
    const readCompleted = idbTransaction(readTransaction);
    const records = await idbRequest(
      readTransaction
        .objectStore(STORE_NAME)
        .index(ACCOUNT_INDEX)
        .getAll(IDBKeyRange.only(accountId)) as IDBRequest<StoredRoutePackage[]>,
    );
    await readCompleted;
    if (records.length === 0) return;

    const writeTransaction = database.transaction(STORE_NAME, "readwrite");
    const completed = idbTransaction(writeTransaction);
    const store = writeTransaction.objectStore(STORE_NAME);
    await Promise.all(
      records.map((record) =>
        idbRequest(
          store.delete(
            routePackageKey({
              accountId: record.accountId,
              crewId: record.crewId,
              revisionId: record.revisionId,
              routeId: record.routeId,
            }),
          ),
        ),
      ),
    );
    await completed;
  }

  close(): void {
    if (!this.databasePromise) return;
    void this.databasePromise.then(
      (database) => database.close(),
      () => undefined,
    );
    this.databasePromise = undefined;
  }
}

export class MemoryRoutePackagePersistence implements RoutePackagePersistence {
  private readonly records: Map<string, StoredRoutePackage>;

  constructor(records: Map<string, StoredRoutePackage> = new Map()) {
    this.records = records;
  }

  private key(scope: RoutePackageScope): string {
    return JSON.stringify([scope.accountId, scope.crewId, scope.routeId, scope.revisionId]);
  }

  async get(scope: RoutePackageScope): Promise<StoredRoutePackage | undefined> {
    const record = this.records.get(this.key(scope));
    return record ? structuredClone(record) : undefined;
  }

  async put(record: StoredRoutePackage): Promise<void> {
    this.records.set(this.key(record), structuredClone(record));
  }

  async delete(scope: RoutePackageScope): Promise<void> {
    this.records.delete(this.key(scope));
  }

  async list(accountId: string, crewId: string): Promise<StoredRoutePackage[]> {
    return [...this.records.values()]
      .filter((record) => record.accountId === accountId && record.crewId === crewId)
      .sort((left, right) => right.storedAt.localeCompare(left.storedAt))
      .map((record) => structuredClone(record));
  }

  async clearAccount(accountId: string): Promise<void> {
    for (const [key, record] of this.records) {
      if (record.accountId === accountId) this.records.delete(key);
    }
  }

  close(): void {
    // La implementación en memoria no mantiene conexiones abiertas.
  }
}
