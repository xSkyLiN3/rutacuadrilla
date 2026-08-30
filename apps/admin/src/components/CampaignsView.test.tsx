import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { createDemoAdminApi } from "../api/demo";
import type { AdminApi, Membership } from "../api/types";
import { CampaignsView, describeCampaignConflict } from "./CampaignsView";

const membership: Membership = {
  crewId: "crew-halcones",
  crewName: "Los Halcones",
  role: "ADMIN",
};

describe("CampaignsView", () => {
  it("crea un borrador, asigna ruta y camión, y confirma una activación accesible", async () => {
    const user = userEvent.setup();
    const api = createDemoAdminApi({ delayMs: 0 });
    await api.login("admin@demo.cl", "demo1234");
    render(<CampaignsView api={api} membership={membership} onUnauthorized={vi.fn()} />);

    await screen.findByRole("heading", { name: "Campañas y camiones" });
    expect(screen.getByText("Aún no hay campañas")).toBeVisible();
    await user.type(screen.getByLabelText("Nombre visible"), "Camión Sur");
    await user.type(screen.getByLabelText("Patente o código (opcional)"), "RC-02");
    await user.click(screen.getByRole("button", { name: "Agregar camión" }));
    expect(await screen.findByText("Camión Sur quedó disponible para asignar.")).toBeVisible();
    await user.type(
      screen.getByLabelText("Nombre", { selector: "#campaign-name" }),
      "Primavera 2026",
    );
    await user.type(screen.getByLabelText("Inicio (opcional)"), "2026-09-01");
    await user.type(screen.getByLabelText("Término (opcional)"), "2026-09-30");
    await user.click(screen.getByRole("button", { name: "Crear campaña" }));

    expect(await screen.findByRole("heading", { name: "Primavera 2026" })).toBeVisible();
    await user.selectOptions(screen.getByLabelText("Revisión publicada"), "revision-a-1");
    await user.selectOptions(
      screen.getByLabelText("Camión activo"),
      screen.getByRole("option", { name: "Camión Sur · RC-02" }),
    );
    await user.click(screen.getByRole("button", { name: "Asignar a la campaña" }));

    expect(await screen.findByText("Ruta Sector A quedó asignada a Camión Sur.")).toBeVisible();
    expect(screen.getByText("3 puntos · 1 lado de calle")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retirar" }));
    await user.click(
      within(screen.getByRole("group", { name: "Confirmar retiro de Ruta Sector A" })).getByRole(
        "button",
        { name: "Sí, retirar" },
      ),
    );
    expect(await screen.findByText("La ruta se retiró del borrador.")).toBeVisible();
    expect(screen.getByText("Sin rutas asignadas")).toBeVisible();

    await user.selectOptions(screen.getByLabelText("Revisión publicada"), "revision-a-1");
    await user.selectOptions(
      screen.getByLabelText("Camión activo"),
      screen.getByRole("option", { name: "Camión Sur · RC-02" }),
    );
    await user.click(screen.getByRole("button", { name: "Asignar a la campaña" }));
    await screen.findByText("Ruta Sector A quedó asignada a Camión Sur.");
    const activationTrigger = screen.getByRole("button", { name: "Activar campaña" });
    await user.click(activationTrigger);

    let dialog = screen.getByRole("alertdialog");
    const cancel = within(dialog).getByRole("button", { name: "Cancelar" });
    const confirm = within(dialog).getByRole("button", { name: "Confirmar y activar" });
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(activationTrigger).toHaveFocus();

    await user.click(activationTrigger);
    dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Confirmar y activar" }));
    expect(await screen.findByText(/está activa y su composición quedó bloqueada/)).toBeVisible();
    await vi.waitFor(() =>
      expect(screen.getByRole("heading", { name: /^Campañas$/u })).toHaveFocus(),
    );
    expect(screen.getByText(/Sus rutas y camiones son de solo lectura/)).toBeVisible();
    expect(screen.getByText("Sin jornada iniciada")).toBeVisible();
    expect(screen.getByText("Se inicia y se une desde Campo con conexión.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retirar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Asignar a la campaña" })).not.toBeInTheDocument();
  });

  it("propaga 401 al cierre de sesión y presenta 403 como estado definitivo", async () => {
    const onUnauthorized = vi.fn();
    const unauthenticatedApi = createDemoAdminApi({ delayMs: 0 });
    const { unmount } = render(
      <CampaignsView
        api={unauthenticatedApi}
        membership={membership}
        onUnauthorized={onUnauthorized}
      />,
    );
    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    unmount();

    const forbiddenApi = createDemoAdminApi({ delayMs: 0 });
    await forbiddenApi.login("admin@demo.cl", "demo1234");
    render(
      <CampaignsView
        api={forbiddenApi}
        membership={{ crewId: "crew-forbidden", crewName: "Acceso restringido", role: "MEMBER" }}
        onUnauthorized={vi.fn()}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Acceso restringido" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("403");
  });

  it("muestra una jornada activa como observación separada de la campaña", async () => {
    const api = createDemoAdminApi({ delayMs: 0 });
    await api.login("admin@demo.cl", "demo1234");
    const vehicle = (await api.listVehicles("crew-halcones"))[0];
    const campaign = await api.createCampaign("crew-halcones", { name: "Campaña con jornada" });
    const assigned = await api.assignCampaignRoute("crew-halcones", campaign.id, {
      routeRevisionId: "revision-a-1",
      vehicleId: vehicle.id,
    });
    await api.activateCampaign("crew-halcones", campaign.id);
    const observingApi: AdminApi = {
      ...api,
      getCurrentWorkSession: vi.fn().mockResolvedValue({
        workSession: {
          id: "work-session-1",
          campaignId: campaign.id,
          campaignRouteId: assigned.assignment.id,
          status: "ACTIVE",
          version: 1,
          startedAt: "2026-08-20T20:30:00.000Z",
          startedByDeviceId: "00000000-0000-4000-8000-000000000001",
          startedByMembershipId: "membership-1",
          participants: [
            {
              membershipId: "membership-1",
              displayName: "Camila Administradora",
              profile: "OTHER",
              joinedAt: "2026-08-20T20:30:00.000Z",
            },
          ],
          devices: [
            {
              deviceId: "00000000-0000-4000-8000-000000000001",
              membershipId: "membership-1",
              joinedAt: "2026-08-20T20:30:00.000Z",
            },
          ],
        },
      }),
    };

    render(<CampaignsView api={observingApi} membership={membership} onUnauthorized={vi.fn()} />);

    expect(await screen.findByText("Jornada activa")).toBeVisible();
    expect(screen.getByText(/1 participante · iniciada/u)).toBeVisible();
    expect(observingApi.getCurrentWorkSession).toHaveBeenCalledWith(
      "crew-halcones",
      assigned.assignment.id,
    );
  });

  it("convierte cada 409 de cobertura en un diagnóstico acotado", () => {
    expect(
      describeCampaignConflict(
        new ApiError(
          409,
          "conflicto",
          { conflictCount: 3, conflicts: [{ private: "no mostrar" }] },
          "CAMPAIGN_POINT_DUPLICATE",
        ),
      ),
    ).toBe(
      "Se detectaron 3 puntos con el mismo identificador estable entre las rutas. Revisa su reparto antes de continuar.",
    );
    expect(
      describeCampaignConflict(
        new ApiError(
          409,
          "conflicto",
          { conflictCount: 2, spatialInferenceUsed: false },
          "CAMPAIGN_SEGMENT_SIDE_DUPLICATE",
        ),
      ),
    ).toContain("2 lados de calle repetidos");
    expect(
      describeCampaignConflict(
        new ApiError(
          409,
          "conflicto",
          { conflictCount: 1, spatialInferenceUsed: false },
          "CAMPAIGN_SEGMENT_VERSION_AMBIGUOUS",
        ),
      ),
    ).toContain("1 calle cuya versión no coincide");
  });
});
