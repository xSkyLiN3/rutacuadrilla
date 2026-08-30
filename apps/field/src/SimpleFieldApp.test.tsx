import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PointFeedback } from "./pointStates";
import { FieldMapErrorFallback, FieldMapLoadingFallback, SimpleFieldApp } from "./SimpleFieldApp";
import type { SimpleFieldApiPort, SimpleFieldAssignment, SimpleFieldProgress } from "./simpleApi";
import type { FieldPoint, PointState } from "./types";

const fieldMapTestState = vi.hoisted(() => ({ renders: 0 }));

vi.mock("./map/FieldMap", () => ({
  FieldMap: ({
    feedback,
    onSelect,
    onSetPointState,
    points,
    selectedPointId,
  }: {
    feedback?: PointFeedback | null;
    onSelect(pointId: string): void;
    onSetPointState(point: FieldPoint, state: PointState): void;
    points: FieldPoint[];
    selectedPointId?: string;
  }) => {
    fieldMapTestState.renders += 1;
    const point = points[0];
    return (
      <section>
        <button onClick={() => onSelect("point-1")} type="button">
          Abrir vivienda del mapa
        </button>
        <output data-testid="map-point-state">{point?.state}</output>
        {point && selectedPointId === point.id ? (
          <div role="dialog">
            <span>Los Aromos 101</span>
            <button onClick={() => onSetPointState(point, "APORTO")} type="button">
              Aportó en el mapa
            </button>
            {feedback?.pointId === point.id ? <span>{feedback.message}</span> : null}
          </div>
        ) : null}
      </section>
    );
  },
}));

const progress: SimpleFieldProgress = {
  assignmentId: "assignment-1",
  routeId: "route-1",
  routeName: "Ruta Norte",
  states: {
    SIN_VISITAR: 1,
    SOBRE_ENTREGADO: 0,
    VOLVER: 0,
    SIN_RESPUESTA: 0,
    APORTO: 0,
    NO_PARTICIPA: 0,
  },
  total: 1,
  updatedAt: "2026-08-26T00:00:00.000Z",
  user: { id: "user-1", name: "Persona Uno" },
  visited: 0,
};

const assignment: SimpleFieldAssignment = {
  crew: { id: "crew-1", name: "Cuadrilla Centro" },
  id: "assignment-1",
  points: [
    {
      displayOrder: 0,
      externalId: "casa-001",
      id: "point-1",
      latitude: -0.4489,
      longitude: -0.6693,
      number: "101",
      pointType: "DWELLING",
      state: "SIN_VISITAR",
      street: "Los Aromos",
      version: 0,
    },
  ],
  progress,
  route: { id: "route-1", name: "Ruta Norte", revisionId: "revision-1" },
  segments: [],
};

function api(): SimpleFieldApiPort {
  return {
    assignment: vi.fn(async () => assignment),
    login: vi.fn(async () => ({
      expiresAt: "2026-08-26T08:00:00.000Z",
      memberships: [
        {
          crewId: "crew-1",
          crewName: "Cuadrilla Centro",
          membershipId: "membership-1",
          role: "MEMBER" as const,
        },
      ],
      token: "token",
      user: { email: "persona@example.test", id: "user-1", name: "Persona Uno" },
    })),
    logout: vi.fn(async () => undefined),
    me: vi.fn(async () => ({ memberships: [], user: { email: "", id: "", name: "" } })),
    setToken: vi.fn(),
    updatePoint: vi.fn(async () => ({
      point: { id: "point-1", state: "APORTO" as const, version: 1 },
      progress: {
        ...progress,
        states: { ...progress.states, SIN_VISITAR: 0, APORTO: 1 },
        visited: 1,
      },
      replayed: false,
    })),
  };
}

afterEach(() => {
  cleanup();
  fieldMapTestState.renders = 0;
  window.sessionStorage.clear();
});

describe("campo simple", () => {
  it("ofrece un estado de carga accesible para el mapa diferido", () => {
    render(<FieldMapLoadingFallback />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Cargando mapa…Mientras tanto, puedes usar la pestaña Lista.",
    );
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it("conserva una salida accesible hacia la lista si el mapa no carga", async () => {
    const onUseList = vi.fn();
    const user = userEvent.setup();
    render(<FieldMapErrorFallback onUseList={onUseList} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "La ruta y sus acciones siguen disponibles en la vista de lista.",
    );
    await user.click(screen.getByRole("button", { name: "Usar vista de lista" }));
    expect(onUseList).toHaveBeenCalledOnce();
  });

  it("mantiene visible el aviso demo y precarga las credenciales públicas", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
    const runtimeApi = api();
    const user = userEvent.setup();
    render(<SimpleFieldApp demoMode providedApi={runtimeApi} />);

    await screen.findByRole("heading", { name: "Iniciar sesión" });
    expect(
      screen.getByText("Demo pública · datos 100 % sintéticos · no usar en terreno"),
    ).toBeVisible();
    expect(screen.getByLabelText("Correo")).toHaveValue("miembro@demo.rutacuadrilla.local");
    expect(screen.getByLabelText("Contraseña")).toHaveValue("LocalDemoField-2026!");

    await user.click(screen.getByRole("button", { name: "Ingresar" }));
    expect(await screen.findByText("Ruta Norte")).toBeVisible();
    expect(runtimeApi.login).toHaveBeenCalledWith(
      "miembro@demo.rutacuadrilla.local",
      "LocalDemoField-2026!",
    );
    expect(
      screen.getByText("Demo pública · datos 100 % sintéticos · no usar en terreno"),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Salir" }));
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    expect(screen.getByLabelText("Correo")).toHaveValue("miembro@demo.rutacuadrilla.local");
    expect(screen.getByLabelText("Contraseña")).toHaveValue("LocalDemoField-2026!");
  });

  it("entra a la ruta, abre una vivienda y guarda uno de los seis estados en línea", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
    const runtimeApi = api();
    const user = userEvent.setup();
    render(<SimpleFieldApp providedApi={runtimeApi} />);

    await screen.findByRole("heading", { name: "Iniciar sesión" });
    await user.type(screen.getByLabelText("Correo"), "persona@example.test");
    await user.type(screen.getByLabelText("Contraseña"), "Usuario-Seguro-2026!");
    await user.click(screen.getByRole("button", { name: "Ingresar" }));

    expect(await screen.findByText("Ruta Norte")).toBeVisible();
    await user.click(await screen.findByRole("button", { name: "Abrir vivienda del mapa" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Los Aromos 101");
    await user.click(screen.getByRole("button", { name: "Aportó en el mapa" }));
    await waitFor(() =>
      expect(runtimeApi.updatePoint).toHaveBeenCalledWith(
        "point-1",
        expect.objectContaining({ expectedVersion: 0, state: "APORTO" }),
      ),
    );
    expect(await screen.findByText("Guardado: Aportó.")).toBeVisible();
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByTestId("map-point-state")).toHaveTextContent("APORTO");
    expect(screen.getByText("1 de 1 visitadas")).toBeVisible();
  });

  it("cierra la vivienda seleccionada al cambiar de mapa a lista", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
    const user = userEvent.setup();
    render(<SimpleFieldApp providedApi={api()} />);

    await screen.findByRole("heading", { name: "Iniciar sesión" });
    await user.type(screen.getByLabelText("Correo"), "persona@example.test");
    await user.type(screen.getByLabelText("Contraseña"), "Usuario-Seguro-2026!");
    await user.click(screen.getByRole("button", { name: "Ingresar" }));

    expect(await screen.findByText("Ruta Norte")).toBeVisible();
    await user.click(await screen.findByRole("button", { name: "Abrir vivienda del mapa" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Los Aromos 101");

    await user.click(screen.getByRole("tab", { name: "Lista" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Buscar vivienda")).toBeVisible();
  });

  it("no vuelve a renderizar el mapa si el polling conserva la asignación validada", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
    const runtimeApi = api();
    const user = userEvent.setup();
    render(<SimpleFieldApp providedApi={runtimeApi} />);

    await screen.findByRole("heading", { name: "Iniciar sesión" });
    await user.type(screen.getByLabelText("Correo"), "persona@example.test");
    await user.type(screen.getByLabelText("Contraseña"), "Usuario-Seguro-2026!");
    await user.click(screen.getByRole("button", { name: "Ingresar" }));
    expect(await screen.findByText("Ruta Norte")).toBeVisible();
    await screen.findByRole("button", { name: "Abrir vivienda del mapa" });
    const rendersAfterLoad = fieldMapTestState.renders;

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(runtimeApi.assignment).toHaveBeenCalledTimes(2));
    expect(fieldMapTestState.renders).toBe(rendersAfterLoad);
  });
});
