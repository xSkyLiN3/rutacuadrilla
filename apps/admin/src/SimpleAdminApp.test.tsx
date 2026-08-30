import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SimpleAdminApi, SimpleOverview } from "./api/types";
import { SimpleAdminApp } from "./SimpleAdminApp";

const overview: SimpleOverview = {
  progress: [
    {
      assignmentId: "assignment-1",
      routeId: "route-1",
      routeName: "Ruta Norte",
      states: {
        SIN_VISITAR: 2,
        SOBRE_ENTREGADO: 1,
        VOLVER: 0,
        SIN_RESPUESTA: 0,
        APORTO: 1,
        NO_PARTICIPA: 0,
      },
      total: 4,
      updatedAt: "2026-08-26T00:00:00.000Z",
      user: { id: "user-1", name: "Persona Uno" },
      visited: 2,
    },
  ],
  routes: [
    {
      id: "route-1",
      name: "Ruta Norte",
      pointCount: 4,
      publishedRevisionId: "revision-1",
      sectorName: "Centro",
      updatedAt: "2026-08-26T00:00:00.000Z",
    },
  ],
  users: [
    {
      email: "persona@example.test",
      id: "user-1",
      name: "Persona Uno",
      status: "ACTIVE",
    },
  ],
};

function api(): SimpleAdminApi {
  return {
    assignSimpleRoute: vi.fn(async () => undefined),
    createSimpleUser: vi.fn(async (_crewId, input) => ({
      email: input.email,
      id: "created-user",
      name: input.displayName,
      status: "ACTIVE",
    })),
    getSimpleOverview: vi.fn(async () => overview),
    importSimpleRoute: vi.fn(async () => ({ route: {} as never })),
    login: vi.fn(async () => ({
      expiresAt: "2026-08-26T08:00:00.000Z",
      memberships: [{ crewId: "crew-1", crewName: "Cuadrilla Centro", role: "ADMIN" as const }],
      token: "token",
      user: { email: "admin@example.test", id: "admin-1", name: "Admin" },
    })),
    logout: vi.fn(async () => undefined),
    me: vi.fn(async () => ({ memberships: [], user: { email: "", id: "", name: "" } })),
    setToken: vi.fn(),
    unassignSimpleRoute: vi.fn(async () => undefined),
  };
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("administración simple", () => {
  it("mantiene visible el aviso demo y precarga las credenciales públicas", async () => {
    const runtimeApi = api();
    const user = userEvent.setup();
    render(<SimpleAdminApp api={runtimeApi} demoMode />);

    await screen.findByRole("heading", { name: "Iniciar sesión" });
    expect(
      screen.getByText("Demo pública · datos 100 % sintéticos · no usar en terreno"),
    ).toBeVisible();
    expect(screen.getByLabelText("Correo")).toHaveValue("admin@demo.rutacuadrilla.local");
    expect(screen.getByLabelText("Contraseña")).toHaveValue("LocalDemoAdmin-2026!");

    await user.click(screen.getByRole("button", { name: "Ingresar" }));
    expect(
      await screen.findByRole("heading", { name: "Usuarios y rutas asignadas" }),
    ).toBeVisible();
    expect(runtimeApi.login).toHaveBeenCalledWith(
      "admin@demo.rutacuadrilla.local",
      "LocalDemoAdmin-2026!",
    );
    expect(
      screen.getByText("Demo pública · datos 100 % sintéticos · no usar en terreno"),
    ).toBeVisible();
  });

  it("crea usuarios, asigna una ruta y muestra el avance sin roles avanzados", async () => {
    const runtimeApi = api();
    const user = userEvent.setup();
    render(<SimpleAdminApp api={runtimeApi} />);

    await screen.findByRole("heading", { name: "Iniciar sesión" });
    await user.type(screen.getByLabelText("Correo"), "admin@example.test");
    await user.type(screen.getByLabelText("Contraseña"), "Admin-Seguro-2026!");
    await user.click(screen.getByRole("button", { name: "Ingresar" }));

    expect(
      await screen.findByRole("heading", { name: "Usuarios y rutas asignadas" }),
    ).toBeVisible();
    expect(screen.queryByText("Campañas")).not.toBeInTheDocument();
    expect(screen.queryByText("Jornadas")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Nombre"), "Persona Nueva");
    await user.type(screen.getByLabelText("Correo"), "nueva@example.test");
    await user.type(screen.getByLabelText(/Contraseña inicial/), "Usuario-Seguro-2026!");
    await user.click(screen.getByRole("button", { name: "Crear usuario" }));
    await waitFor(() =>
      expect(runtimeApi.createSimpleUser).toHaveBeenCalledWith("crew-1", {
        displayName: "Persona Nueva",
        email: "nueva@example.test",
        password: "Usuario-Seguro-2026!",
      }),
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Ruta para Persona Uno" }),
      "route-1",
    );
    await user.click(screen.getByRole("button", { name: "Asignar" }));
    await waitFor(() =>
      expect(runtimeApi.assignSimpleRoute).toHaveBeenCalledWith("crew-1", "user-1", "route-1"),
    );

    await user.click(screen.getByRole("button", { name: "Avance" }));
    expect(screen.getByRole("heading", { name: "Avance por ruta" })).toBeVisible();
    expect(screen.getByText("2 de 4 viviendas visitadas")).toBeVisible();
    expect(screen.getByText("Aportó")).toBeVisible();
  });
});
