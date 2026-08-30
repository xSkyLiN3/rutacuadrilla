import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  etagMatches,
  representRoutePackage,
  routePackageHeaders,
  routePackageNotModifiedHeaders,
} from "../src/routes/package.js";

describe("representación HTTP del paquete de ruta", () => {
  it("calcula el hash y largo sobre los bytes UTF-8 exactos enviados", () => {
    const representation = representRoutePackage({ name: "Ruta Peñalolén", schemaVersion: 1 });
    const expected = createHash("sha256")
      .update(Buffer.from(representation.body, "utf8"))
      .digest("hex");

    expect(representation.sha256).toBe(expected);
    expect(representation.byteLength).toBe(Buffer.byteLength(representation.body, "utf8"));
    expect(representation.etag).toBe(`"sha256-${expected}"`);
    expect(routePackageHeaders(representation)).toMatchObject({
      "Cache-Control": "private, no-store",
      "Content-Length": String(representation.byteLength),
      ETag: representation.etag,
      Vary: "Authorization",
      "X-Package-SHA256": expected,
    });
    expect(routePackageNotModifiedHeaders(representation)).toEqual({
      "Cache-Control": "private, no-store",
      ETag: representation.etag,
      Vary: "Authorization",
    });
  });

  it("es determinista para el mismo objeto y cambia al cambiar el contenido", () => {
    const first = representRoutePackage({ points: [{ id: "p-1" }], schemaVersion: 1 });
    const replay = representRoutePackage({ points: [{ id: "p-1" }], schemaVersion: 1 });
    const changed = representRoutePackage({ points: [{ id: "p-2" }], schemaVersion: 1 });

    expect(replay).toEqual(first);
    expect(changed.sha256).not.toBe(first.sha256);
  });

  it("reconoce el validador exacto dentro de If-None-Match", () => {
    const etag = '"sha256-abc"';

    expect(etagMatches(undefined, etag)).toBe(false);
    expect(etagMatches('"otro", "sha256-abc"', etag)).toBe(true);
    expect(etagMatches("*", etag)).toBe(true);
    expect(etagMatches('W/"sha256-abc"', etag)).toBe(false);
  });

  it("rechaza valores que JSON no puede representar como cuerpo", () => {
    expect(() => representRoutePackage(undefined)).toThrow("must be JSON serializable");
  });
});
