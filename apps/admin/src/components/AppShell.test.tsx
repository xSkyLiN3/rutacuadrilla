import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

const baseProps = {
  canChangeCrew: false,
  children: <p>Contenido</p>,
  currentPage: "routes" as const,
  demoMode: false,
  onChangeCrew: vi.fn(),
  onLogout: vi.fn(),
  onNavigate: vi.fn(),
  user: { email: "persona@example.cl", id: "user-1", name: "Persona" },
};

describe("AppShell authorization navigation", () => {
  it("shows Campaigns only when the effective membership can manage them", () => {
    const { rerender } = render(
      <AppShell
        {...baseProps}
        membership={{
          capabilities: ["ROUTE_VIEW"],
          crewId: "crew-1",
          crewName: "Tripulación",
          role: "MEMBER",
        }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Campañas" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Importar CSV" })).not.toBeInTheDocument();

    rerender(
      <AppShell
        {...baseProps}
        membership={{
          capabilities: ["ROUTE_VIEW", "ROUTE_DRAFT_EDIT", "CAMPAIGN_MANAGE"],
          crewId: "crew-1",
          crewName: "Tripulación",
          role: "MEMBER",
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Campañas" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Importar CSV" })).toBeVisible();
  });
});
