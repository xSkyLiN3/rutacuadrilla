import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PointFeedback } from "../pointStates";
import type { FieldPoint, PointState } from "../types";

const originalRequestFullscreen = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "requestFullscreen",
);
const originalFullscreenElement = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
const originalExitFullscreen = Object.getOwnPropertyDescriptor(document, "exitFullscreen");
const originalFullscreenEnabled = Object.getOwnPropertyDescriptor(document, "fullscreenEnabled");
const originalVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");

type MapTestEvent = {
  features?: Array<{ properties?: Record<string, unknown> }>;
  originalEvent?: Event;
  point: { x: number; y: number };
  points: Array<{ x: number; y: number }>;
};

const mapState = vi.hoisted(() => ({
  easeCalls: [] as Array<Record<string, unknown>>,
  filters: [] as Array<{ filter: unknown; layer: string }>,
  handlers: new Map<string, (event: MapTestEvent) => void>(),
  layers: new Set<string>(),
  resizeCalls: 0,
  sources: new Map<string, ReturnType<typeof vi.fn>>(),
}));

vi.mock("maplibre-gl", () => {
  class MockMap {
    private readonly canvas = document.createElement("canvas");
    private readonly sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();

    constructor(options: { container: HTMLElement }) {
      options.container.append(this.canvas);
    }

    addControl() {}
    addLayer(layer: { id: string }) {
      mapState.layers.add(layer.id);
    }
    easeTo(options: Record<string, unknown>) {
      mapState.easeCalls.push(options);
    }
    fitBounds() {}
    getCanvas() {
      return this.canvas;
    }
    getLayer(id: string) {
      return mapState.layers.has(id) ? { id } : undefined;
    }
    getSource(id: string) {
      return this.sources.get(id);
    }
    addSource(id: string) {
      const setData = vi.fn();
      this.sources.set(id, { setData });
      mapState.sources.set(id, setData);
    }
    once(event: string, callback: () => void) {
      if (event === "load") callback();
    }
    on(
      event: string,
      layerOrHandler: string | ((event: MapTestEvent) => void),
      maybeHandler?: (event: MapTestEvent) => void,
    ) {
      const layer = typeof layerOrHandler === "string" ? layerOrHandler : "";
      const handler = typeof layerOrHandler === "function" ? layerOrHandler : maybeHandler;
      if (handler) mapState.handlers.set(layer ? `${event}:${layer}` : event, handler);
    }
    project([x, y]: [number, number]) {
      return { x, y };
    }
    remove() {}
    resize() {
      mapState.resizeCalls += 1;
    }
    setFilter(layer: string, filter: unknown) {
      mapState.filters.push({ filter, layer });
    }
  }

  return {
    Map: MockMap,
    NavigationControl: class {},
    setWorkerUrl: vi.fn(),
  };
});

import { FieldMap } from "./FieldMap";

const point: FieldPoint = {
  id: "624ef6ad-9cc0-44fd-a725-95c7a5ac6c71",
  displayOrder: 0,
  externalId: "synthetic/dwelling/001",
  latitude: 10,
  longitude: 10,
  number: "120",
  pointType: "DWELLING",
  state: "SIN_VISITAR",
  street: "Pasaje Aurora Cero",
  version: 0,
};

interface HarnessProps {
  initiallySelected?: boolean;
  onClear?: () => void;
  onSelection?: (pointId: string) => void;
  onSetState?: (point: FieldPoint, state: PointState) => void;
  saving?: boolean;
}

function Harness({
  initiallySelected = false,
  onClear,
  onSelection,
  onSetState = vi.fn(),
  saving = false,
}: HarnessProps = {}) {
  const [selectedPointId, setSelectedPointId] = useState(initiallySelected ? point.id : "");
  const selectPoint = (pointId: string) => {
    onSelection?.(pointId);
    setSelectedPointId(pointId);
  };
  const clearPoint = () => {
    onClear?.();
    setSelectedPointId("");
  };
  const feedback: PointFeedback | null = saving
    ? { kind: "saving", message: "Guardando aportó…", pointId: point.id }
    : null;
  return (
    <FieldMap
      feedback={feedback}
      online
      onClearSelection={clearPoint}
      onSelect={selectPoint}
      onSetPointState={onSetState}
      points={[point]}
      savingPointId={saving ? point.id : undefined}
      savingState={saving ? "APORTO" : null}
      segments={[]}
      selectedPointId={selectedPointId || undefined}
    />
  );
}

function mapEvent(x: number, y: number): MapTestEvent {
  return { point: { x, y }, points: [] };
}

beforeEach(() => {
  mapState.easeCalls.length = 0;
  mapState.filters.length = 0;
  mapState.handlers.clear();
  mapState.layers.clear();
  mapState.resizeCalls = 0;
  mapState.sources.clear();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "geolocation");
  if (originalRequestFullscreen) {
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", originalRequestFullscreen);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
  }
  if (originalFullscreenElement) {
    Object.defineProperty(document, "fullscreenElement", originalFullscreenElement);
  } else {
    Reflect.deleteProperty(document, "fullscreenElement");
  }
  if (originalExitFullscreen) {
    Object.defineProperty(document, "exitFullscreen", originalExitFullscreen);
  } else {
    Reflect.deleteProperty(document, "exitFullscreen");
  }
  if (originalFullscreenEnabled) {
    Object.defineProperty(document, "fullscreenEnabled", originalFullscreenEnabled);
  } else {
    Reflect.deleteProperty(document, "fullscreenEnabled");
  }
  if (originalVisualViewport) {
    Object.defineProperty(window, "visualViewport", originalVisualViewport);
  } else {
    Reflect.deleteProperty(window, "visualViewport");
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FieldMap map interaction", () => {
  it("abre un panel centrado dentro del mapa al pulsar una vivienda con UUID", async () => {
    render(<Harness />);
    await waitFor(() => expect(mapState.handlers.get("click")).toBeTypeOf("function"));

    act(() => mapState.handlers.get("click")?.(mapEvent(11, 11)));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeVisible();
    expect(dialog.closest(".field-map__panel-layer")).not.toBeNull();
    expect(dialog.closest(".field-map__viewport")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Pasaje Aurora Cero 120" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Aportó/u })).toBeVisible();
    expect(mapState.layers.has("field-parcel-fills")).toBe(true);
    expect(mapState.layers.has("field-parcel-outlines")).toBe(true);
    expect(mapState.layers.has("field-parcel-selected-fill")).toBe(true);
    expect(mapState.layers.has("field-parcel-selected-outline")).toBe(true);
    expect(mapState.layers.has("field-dwelling-fills")).toBe(true);
    expect(mapState.layers.has("field-dwelling-outlines")).toBe(true);
    expect(mapState.layers.has("field-dwelling-selected-fill")).toBe(true);
    expect(mapState.layers.has("field-dwelling-selected-outline")).toBe(true);
    expect(mapState.filters).toContainEqual({
      filter: ["==", ["get", "pointId"], point.id],
      layer: "field-point-selection",
    });
  });

  it("un clic del mapa cierra el panel sin seleccionar otra casa y el siguiente vuelve a abrir", async () => {
    const onClear = vi.fn();
    const onSelection = vi.fn();
    render(<Harness onClear={onClear} onSelection={onSelection} />);
    await waitFor(() => expect(mapState.handlers.get("click")).toBeTypeOf("function"));

    act(() => mapState.handlers.get("click")?.(mapEvent(10, 10)));
    expect(await screen.findByRole("dialog")).toBeVisible();

    act(() => mapState.handlers.get("click")?.(mapEvent(200, 200)));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onClear).toHaveBeenCalledOnce();
    expect(onSelection).toHaveBeenCalledTimes(1);

    act(() => mapState.handlers.get("click")?.(mapEvent(10, 10)));
    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(onSelection).toHaveBeenCalledTimes(2);
  });

  it("no cierra al usar las opciones internas y cierra por X o Escape", async () => {
    const onClear = vi.fn();
    const onSetState = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(
      <Harness initiallySelected onClear={onClear} onSetState={onSetState} />,
    );

    await user.click(await screen.findByRole("button", { name: "Aportó" }));
    expect(onSetState).toHaveBeenCalledWith(point, "APORTO");
    expect(screen.getByRole("dialog")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(onClear).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    unmount();
    render(<Harness initiallySelected onClear={onClear} onSetState={onSetState} />);
    await user.keyboard("{Escape}");
    expect(onClear).toHaveBeenCalledTimes(2);
  });

  it("acepta un toque con leve movimiento y elimina el clic sintético duplicado", async () => {
    const onSelection = vi.fn();
    render(<Harness onSelection={onSelection} />);
    await waitFor(() => expect(mapState.handlers.get("touchend")).toBeTypeOf("function"));

    act(() => {
      mapState.handlers.get("touchstart")?.({
        point: { x: 10, y: 10 },
        points: [{ x: 10, y: 10 }],
      });
      mapState.handlers.get("touchmove")?.({
        point: { x: 14, y: 13 },
        points: [{ x: 14, y: 13 }],
      });
      mapState.handlers.get("touchend")?.({
        point: { x: 14, y: 13 },
        points: [{ x: 14, y: 13 }],
      });
      mapState.handlers.get("click")?.(mapEvent(14, 13));
    });

    expect(onSelection).toHaveBeenCalledOnce();
    expect(onSelection).toHaveBeenCalledWith(point.id);
    expect(await screen.findByRole("dialog")).toBeVisible();
  });

  it("un toque visible cierra una sola vez y un paneo no cierra", async () => {
    const onClear = vi.fn();
    render(<Harness initiallySelected onClear={onClear} />);
    await waitFor(() => expect(mapState.handlers.get("touchend")).toBeTypeOf("function"));

    act(() => {
      mapState.handlers.get("touchstart")?.({
        point: { x: 100, y: 100 },
        points: [{ x: 100, y: 100 }],
      });
      mapState.handlers.get("touchmove")?.({
        point: { x: 118, y: 100 },
        points: [{ x: 118, y: 100 }],
      });
      mapState.handlers.get("touchend")?.({
        point: { x: 118, y: 100 },
        points: [{ x: 118, y: 100 }],
      });
    });
    expect(onClear).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeVisible();

    act(() => {
      mapState.handlers.get("touchstart")?.({
        point: { x: 100, y: 100 },
        points: [{ x: 100, y: 100 }],
      });
      mapState.handlers.get("touchend")?.({
        point: { x: 103, y: 102 },
        points: [{ x: 103, y: 102 }],
      });
      mapState.handlers.get("click")?.(mapEvent(103, 102));
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("mantiene el panel abierto durante un guardado", async () => {
    const onClear = vi.fn();
    const user = userEvent.setup();
    render(<Harness initiallySelected onClear={onClear} saving />);
    await waitFor(() => expect(mapState.handlers.get("click")).toBeTypeOf("function"));

    act(() => mapState.handlers.get("click")?.(mapEvent(200, 200)));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cerrar" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onClear).not.toHaveBeenCalled();
  });

  it("muestra dirección y halo al pasar el puntero de escritorio", async () => {
    render(<Harness />);
    const move = "mousemove:field-point-hit-targets";
    await waitFor(() => expect(mapState.handlers.get(move)).toBeTypeOf("function"));

    act(() =>
      mapState.handlers.get(move)?.({
        features: [{ properties: { address: "Los Aromos 120", pointId: point.id } }],
        point: { x: 40, y: 45 },
        points: [],
      }),
    );

    expect(screen.getByRole("tooltip")).toHaveTextContent("Los Aromos 120");
    expect(mapState.filters).toContainEqual({
      filter: ["==", ["get", "pointId"], point.id],
      layer: "field-point-hover",
    });

    act(() => mapState.handlers.get("mouseleave:field-point-hit-targets")?.(mapEvent(0, 0)));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("sigue la ubicación solo en memoria, muestra precisión y usa el zoom de viviendas", async () => {
    let reportPosition: PositionCallback = () => undefined;
    const clearWatch = vi.fn();
    const watchPosition = vi.fn(
      (success: PositionCallback, _error: PositionErrorCallback, options?: PositionOptions) => {
        reportPosition = success;
        expect(options).toEqual({
          enableHighAccuracy: true,
          maximumAge: 1_000,
          timeout: 15_000,
        });
        return 17;
      },
    );
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { clearWatch, getCurrentPosition: vi.fn(), watchPosition },
    });
    vi.stubGlobal("isSecureContext", true);
    const user = userEvent.setup();
    const { unmount } = render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Mostrar mi ubicación" }));
    expect(watchPosition).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Buscando ubicación" })).toBeDisabled();

    act(() =>
      reportPosition({
        coords: {
          accuracy: 9,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          latitude: -0.4489,
          longitude: -0.6693,
          speed: null,
          toJSON: () => ({}),
        },
        timestamp: 123,
        toJSON: () => ({}),
      }),
    );

    expect(await screen.findByText(/Siguiendo en tiempo real · precisión ±9 m/u)).toBeVisible();
    expect(screen.getByText(/RutaCuadrilla no guarda ni envía tu GPS/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "Centrar y seguir mi ubicación" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(mapState.easeCalls.at(-1)).toMatchObject({
      center: [-0.6693, -0.4489],
      duration: 800,
      zoom: 18.25,
    });
    expect(mapState.layers.has("field-location-accuracy")).toBe(false);
    expect(mapState.layers.has("field-location-halo")).toBe(false);
    expect(mapState.layers.has("field-location-position")).toBe(true);
    await waitFor(() =>
      expect(mapState.sources.get("field-location")).toHaveBeenLastCalledWith(
        expect.objectContaining({ features: expect.arrayContaining([expect.any(Object)]) }),
      ),
    );

    act(() =>
      reportPosition({
        coords: {
          accuracy: 6,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          latitude: -0.4488,
          longitude: -0.6692,
          speed: null,
          toJSON: () => ({}),
        },
        timestamp: 456,
        toJSON: () => ({}),
      }),
    );
    expect(await screen.findByText(/Siguiendo en tiempo real · precisión ±6 m/u)).toBeVisible();
    const secondEase = mapState.easeCalls.at(-1);
    expect(secondEase).toMatchObject({
      center: [-0.6692, -0.4488],
      zoom: 18.25,
    });
    expect(secondEase?.duration).toEqual(expect.any(Number));
    expect(secondEase?.duration).toBeGreaterThanOrEqual(220);
    expect(secondEase?.duration).toBeLessThanOrEqual(850);
    expect(secondEase?.easing).toEqual(expect.any(Function));

    act(() => mapState.handlers.get("dragstart")?.(mapEvent(0, 0)));
    expect(screen.getByText(/Toca el botón para volver a centrar/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "Centrar y seguir mi ubicación" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await user.click(screen.getByRole("button", { name: "Centrar y seguir mi ubicación" }));
    expect(screen.getByRole("button", { name: "Centrar y seguir mi ubicación" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    act(() =>
      mapState.handlers.get("zoomstart")?.({
        ...mapEvent(0, 0),
        originalEvent: new Event("wheel"),
      }),
    );
    expect(screen.getByRole("button", { name: "Centrar y seguir mi ubicación" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    unmount();
    expect(clearWatch).toHaveBeenCalledWith(17);
  });

  it("explica un permiso GPS denegado, limpia la medición y permite reintentar", async () => {
    const locationErrors: PositionErrorCallback[] = [];
    const clearWatch = vi.fn();
    const watchPosition = vi.fn((_success: PositionCallback, error: PositionErrorCallback) => {
      locationErrors.push(error);
      return 16 + locationErrors.length;
    });
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { clearWatch, getCurrentPosition: vi.fn(), watchPosition },
    });
    vi.stubGlobal("isSecureContext", true);
    const user = userEvent.setup();
    const { unmount } = render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Mostrar mi ubicación" }));
    act(() =>
      locationErrors[0]?.({
        code: 1,
        message: "Permission denied",
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("ubicación está bloqueada");
    expect(clearWatch).toHaveBeenCalledWith(17);
    await user.click(screen.getByRole("button", { name: "Mostrar mi ubicación" }));
    expect(watchPosition).toHaveBeenCalledTimes(2);
    unmount();
    expect(clearWatch).toHaveBeenCalledWith(18);
  });

  it("usa la pantalla completa nativa, redimensiona el mapa y restaura el documento", async () => {
    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement,
    });
    const requestFullscreen = vi.fn(function (this: HTMLElement) {
      fullscreenElement = this;
      document.dispatchEvent(new Event("fullscreenchange"));
      return Promise.resolve();
    });
    const exitFullscreen = vi.fn(() => {
      fullscreenElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
      return Promise.resolve();
    });
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: exitFullscreen,
    });
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Abrir mapa en pantalla completa" }));
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Salir de pantalla completa" })).toBeVisible();
    await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));
    await waitFor(() => expect(mapState.resizeCalls).toBeGreaterThan(0));

    await user.click(screen.getByRole("button", { name: "Salir de pantalla completa" }));
    expect(exitFullscreen).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Salir de pantalla completa" }),
      ).not.toBeInTheDocument(),
    );
    expect(document.body.style.overflow).toBe("");
  });

  it("ofrece pantalla completa CSS si la API móvil la rechaza y permite salir con Escape", async () => {
    const requestFullscreen = vi.fn().mockRejectedValue(new Error("Not supported"));
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Abrir mapa en pantalla completa" }));
    expect(requestFullscreen).toHaveBeenCalledOnce();
    const exitButton = screen.getByRole("button", { name: "Salir de pantalla completa" });
    expect(exitButton.closest(".field-map--fullscreen")).not.toBeNull();
    await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Salir de pantalla completa" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Abrir mapa en pantalla completa" })).toBeVisible();
    expect(document.body.style.overflow).toBe("");
  });

  it("usa el viewport visible y bloquea el desplazamiento en el fallback para iPhone", async () => {
    const requestFullscreen = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    Object.defineProperty(document, "fullscreenEnabled", {
      configurable: true,
      value: false,
    });
    const visualViewport = Object.assign(new EventTarget(), {
      height: 700,
      offsetLeft: 0,
      offsetTop: 18,
      width: 390,
    }) as VisualViewport;
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Abrir mapa en pantalla completa" }));

    expect(requestFullscreen).not.toHaveBeenCalled();
    const fullscreenSection = screen
      .getByRole("button", { name: "Salir de pantalla completa" })
      .closest(".field-map--fullscreen") as HTMLElement;
    expect(fullscreenSection.style.height).toBe("700px");
    expect(fullscreenSection.style.width).toBe("390px");
    expect(fullscreenSection.style.top).toBe("18px");
    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(document.body.style.position).toBe("fixed");

    Object.defineProperties(visualViewport, {
      height: { configurable: true, value: 390 },
      offsetTop: { configurable: true, value: 0 },
      width: { configurable: true, value: 700 },
    });
    visualViewport.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(fullscreenSection.style.height).toBe("390px"));
    expect(fullscreenSection.style.width).toBe("700px");
    await waitFor(() => expect(mapState.resizeCalls).toBeGreaterThan(0));

    await user.click(screen.getByRole("button", { name: "Salir de pantalla completa" }));
    expect(fullscreenSection.style.height).toBe("");
    expect(document.documentElement.style.overflow).toBe("");
    expect(document.body.style.position).toBe("");
  });

  it("activa el fallback cuando la promesa nativa resuelve sin entrar realmente", async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: null,
    });
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Abrir mapa en pantalla completa" }));

    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Salir de pantalla completa" })).toBeVisible();
    expect(document.body.style.position).toBe("fixed");
  });

  it("expande de inmediato si un WebView deja pendiente la promesa nativa", async () => {
    let resolveRequest: (() => void) | undefined;
    const requestFullscreen = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Abrir mapa en pantalla completa" }));

    expect(screen.getByRole("button", { name: "Salir de pantalla completa" })).toBeVisible();
    expect(document.body.style.position).toBe("fixed");
    await user.click(screen.getByRole("button", { name: "Salir de pantalla completa" }));
    resolveRequest?.();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Salir de pantalla completa" }),
      ).not.toBeInTheDocument(),
    );
  });
});
