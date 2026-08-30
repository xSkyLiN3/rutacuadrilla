import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AdminApi, Membership, RouteRevision } from "../api/types";
import { MemoryRoutePackagePersistence, RoutePackageStore } from "../local/routePackage";
import { RoutePackagePanel } from "./RoutePackagePanel";

const revision: RouteRevision = {
  id: "revision-1",
  number: 1,
  status: "PUBLISHED",
  contentHash: "a".repeat(64),
  pointCount: 1,
  points: [],
  segmentCount: 0,
  createdAt: "2026-08-13T12:00:00.000Z",
  publishedAt: "2026-08-13T12:05:00.000Z",
};

function renderPanel(membership: Membership) {
  render(
    <RoutePackagePanel
      accountId="account-1"
      api={{} as AdminApi}
      membership={membership}
      revision={revision}
      routeId="route-1"
      store={new RoutePackageStore(new MemoryRoutePackagePersistence())}
    />,
  );
}

describe("RoutePackagePanel", () => {
  it("muestra la preparación de Campo solo con la capacidad efectiva", () => {
    renderPanel({
      crewId: "crew-1",
      crewName: "Tripulación Norte",
      role: "MEMBER",
      capabilities: ["ROUTE_VIEW", "CAMPAIGN_MANAGE"],
    });

    expect(screen.getByRole("button", { name: "Preparar contexto de campo" })).toBeVisible();
  });

  it("no confunde el rol ADMIN con una capacidad revocada", () => {
    renderPanel({
      crewId: "crew-1",
      crewName: "Tripulación Norte",
      role: "ADMIN",
      capabilities: ["ROUTE_VIEW"],
    });

    expect(
      screen.queryByRole("button", { name: "Preparar contexto de campo" }),
    ).not.toBeInTheDocument();
  });
});
