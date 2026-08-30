import { describe, expect, it, vi } from "vitest";
import { downloadRoutePackage, ROUTE_PACKAGE_ACCEPT } from "./routePackageClient";

const request = {
  baseUrl: "https://api.example.test/",
  crewId: "crew con espacio",
  revisionId: "revision/1",
  routeId: "route uno",
  token: "token-seguro",
};

function packageResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Length": String(new TextEncoder().encode(body).byteLength),
      "Content-Type": "application/vnd.rutacuadrilla.route-package+json; version=1",
      ETag: '"sha256-digest"',
      "X-Package-SHA256": "a".repeat(64),
    },
    status: 200,
  });
}

describe("downloadRoutePackage", () => {
  it("codifica IDs, autentica y conserva los bytes y metadatos de integridad", async () => {
    const body = JSON.stringify({ kind: "ROUTE_REVISION_PACKAGE", name: "Peñalolén" });
    const fetcher = vi.fn().mockResolvedValue(packageResponse(body));

    const result = await downloadRoutePackage(request, fetcher);

    expect(result).toEqual({
      download: {
        body,
        byteLength: new TextEncoder().encode(body).byteLength,
        etag: '"sha256-digest"',
        sha256: "a".repeat(64),
      },
      status: "DOWNLOADED",
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://api.example.test/api/crews/crew%20con%20espacio/routes/" +
        "route%20uno/revisions/revision%2F1/package",
    );
    const headers = init.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer token-seguro");
    expect(headers.get("Accept")).toBe(ROUTE_PACKAGE_ACCEPT);
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("omit");
  });

  it("usa If-None-Match y distingue una copia local vigente", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 304 }));

    await expect(
      downloadRoutePackage({ ...request, etag: '"sha256-existing"' }, fetcher),
    ).resolves.toEqual({ etag: '"sha256-existing"', status: "NOT_MODIFIED" });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Headers).get("If-None-Match")).toBe('"sha256-existing"');
  });

  it("rechaza respuestas sin tipo, hash o ETag antes de persistirlas", async () => {
    const missingType = vi.fn().mockResolvedValue(
      new Response("{}", {
        headers: { ETag: '"sha256-x"', "X-Package-SHA256": "a".repeat(64) },
      }),
    );
    await expect(downloadRoutePackage(request, missingType)).rejects.toMatchObject({
      code: "INVALID_PACKAGE_RESPONSE",
      status: 502,
    });

    const missingHash = vi.fn().mockResolvedValue(
      new Response("{}", {
        headers: {
          "Content-Type": "application/vnd.rutacuadrilla.route-package+json; version=1",
          ETag: '"sha256-x"',
        },
      }),
    );
    await expect(downloadRoutePackage(request, missingHash)).rejects.toMatchObject({
      code: "INVALID_PACKAGE_RESPONSE",
      status: 502,
    });
  });

  it("traduce errores sin mostrar el cuerpo del servidor", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: "PACKAGE_REQUIRES_PUBLISHED_REVISION", debug: "SQL" }), {
        headers: { "Content-Type": "application/json" },
        status: 409,
      }),
    );

    await expect(downloadRoutePackage(request, fetcher)).rejects.toMatchObject({
      code: "PACKAGE_REQUIRES_PUBLISHED_REVISION",
      message: "Solo puede prepararse una revisión publicada e inmutable.",
      status: 409,
    });
  });
});
