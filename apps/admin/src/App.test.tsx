import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "./App";
import { createDemoAdminApi } from "./api/demo";

async function login(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("heading", { name: "Iniciar sesión" });
  await user.click(screen.getByRole("button", { name: "Ingresar" }));
  await screen.findByRole("heading", { name: "Elige una tripulación" });
}

describe("consola administrativa", () => {
  it("abre la gestión de campañas desde la navegación autenticada", async () => {
    const user = userEvent.setup();
    render(<App api={createDemoAdminApi({ delayMs: 0 })} demoMode />);

    await login(user);
    await user.click(screen.getByRole("button", { name: /Los Halcones/ }));
    await screen.findByRole("heading", { name: "Rutas y revisiones" });
    await user.click(screen.getByRole("button", { name: "Campañas" }));

    expect(await screen.findByRole("heading", { name: "Campañas y camiones" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Campañas" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("America/Santiago")).toBeVisible();
    expect(screen.getByText("CLP")).toBeVisible();
  });

  it("completa login, selección de crew, importación, borrador y publicación", async () => {
    const user = userEvent.setup();
    render(<App api={createDemoAdminApi({ delayMs: 0 })} demoMode />);

    await login(user);
    await user.click(screen.getByRole("button", { name: /Los Halcones/ }));
    await screen.findByRole("heading", { name: "Rutas y revisiones" });

    await user.click(screen.getByRole("button", { name: "Nueva ruta desde CSV" }));
    await screen.findByRole("heading", { name: "Nueva ruta desde CSV" });
    await user.click(screen.getByRole("button", { name: "Cargar ejemplo demo" }));

    expect(screen.getByText("4 filas válidas · 0 errores")).toBeVisible();
    expect(screen.getByRole("img", { name: /Vista previa de coordenadas CSV/ })).toBeVisible();

    const createButton = screen.getByRole("button", {
      name: "Crear revisión en borrador",
    });
    expect(createButton).toBeEnabled();
    await user.click(createButton);

    await screen.findByRole("heading", { name: "Ruta Sector C" });
    expect(screen.getAllByText("Borrador").length).toBeGreaterThan(0);
    const publishTrigger = screen.getByRole("button", { name: "Revisar publicación" });
    await user.click(publishTrigger);

    let dialog = screen.getByRole("alertdialog");
    const cancelPublish = within(dialog).getByRole("button", { name: "Cancelar" });
    const confirmPublish = within(dialog).getByRole("button", { name: "Confirmar y publicar" });
    expect(cancelPublish).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirmPublish).toHaveFocus();
    await user.tab();
    expect(cancelPublish).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(publishTrigger).toHaveFocus();

    await user.click(publishTrigger);
    dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/quedará inmutable/i)).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Confirmar y publicar" }));

    expect((await screen.findAllByText("Publicada")).length).toBeGreaterThan(0);
    const receipt = screen.getByText("Revisión 1 publicada.").closest('[role="status"]');
    expect(receipt).toHaveTextContent("Identificador / hash");
    expect(receipt).toHaveTextContent("demo-content:");
    expect(screen.queryByRole("button", { name: "Revisar publicación" })).not.toBeInTheDocument();
  });

  it("presenta el estado 401 ante credenciales incorrectas", async () => {
    const user = userEvent.setup();
    render(<App api={createDemoAdminApi({ delayMs: 0 })} demoMode />);

    await screen.findByRole("heading", { name: "Iniciar sesión" });
    const password = screen.getByLabelText("Contraseña");
    await user.clear(password);
    await user.type(password, "incorrecta");
    await user.click(screen.getByRole("button", { name: "Ingresar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("401");
    expect(screen.getByRole("alert")).toHaveTextContent("Correo o contraseña incorrectos");
  });

  it("muestra el estado vacío de una tripulación sin rutas", async () => {
    const user = userEvent.setup();
    render(<App api={createDemoAdminApi({ delayMs: 0 })} demoMode />);

    await login(user);
    await user.click(screen.getByRole("button", { name: /Tripulación sin rutas/ }));

    expect(await screen.findByRole("heading", { name: "Aún no hay rutas" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Importar primera ruta" })).toBeEnabled();
  });

  it("corrige los puntos de un DRAFT desde un CSV canónico precargado", async () => {
    const user = userEvent.setup();
    render(<App api={createDemoAdminApi({ delayMs: 0 })} demoMode />);

    await login(user);
    await user.click(screen.getByRole("button", { name: /Los Halcones/ }));
    await screen.findByRole("heading", { name: "Rutas y revisiones" });
    await user.click(screen.getByRole("button", { name: "Ver detalle de Ruta Sector A" }));
    await screen.findByRole("heading", { name: "Ruta Sector A" });

    const editTrigger = screen.getByRole("button", { name: "Corregir puntos CSV" });
    await user.click(editTrigger);
    let editor = screen.getByLabelText("CSV corregido") as HTMLTextAreaElement;
    expect(editor).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancelar corrección" }));
    const restoredEditTrigger = screen.getByRole("button", { name: "Corregir puntos CSV" });
    expect(restoredEditTrigger).toHaveFocus();

    await user.click(restoredEditTrigger);
    editor = screen.getByLabelText("CSV corregido") as HTMLTextAreaElement;
    expect(editor).toHaveFocus();
    expect(editor.value).toContain(
      "external_id,street,number,latitude,longitude,point_type,source",
    );
    expect(editor.value).toContain("home-a-001,Los Aromos,120");
    expect(screen.queryByRole("button", { name: "Revisar publicación" })).not.toBeInTheDocument();

    fireEvent.change(editor, {
      target: {
        value: editor.value.replace("home-a-001,Los Aromos,120", "home-a-001,Los Aromos,121"),
      },
    });
    expect(screen.getByText("4 filas válidas · 0 errores")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Guardar puntos corregidos" }));

    expect(
      await screen.findByText("4 puntos corregidos y guardados en el borrador."),
    ).toBeVisible();
    expect(screen.getAllByText("Los Aromos 121").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("CSV corregido")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Corregir puntos CSV" })).toHaveFocus();
  });

  it("no ofrece publicar una revisión que ya está publicada", async () => {
    const user = userEvent.setup();
    render(<App api={createDemoAdminApi({ delayMs: 0 })} demoMode />);

    await login(user);
    await user.click(screen.getByRole("button", { name: /Los Halcones/ }));
    await screen.findByRole("heading", { name: "Rutas y revisiones" });
    await user.click(screen.getByRole("button", { name: "Ver detalle de Ruta Sector B" }));

    await screen.findByRole("heading", { name: "Ruta Sector B" });
    expect(screen.getAllByText("Publicada").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Revisar publicación" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Corregir puntos CSV" })).not.toBeInTheDocument();
  });

  it("permite visualizar una revisión reemplazada pero no volver a publicarla", async () => {
    const user = userEvent.setup();
    render(<App api={createDemoAdminApi({ delayMs: 0 })} demoMode />);

    await login(user);
    await user.click(screen.getByRole("button", { name: /Los Halcones/ }));
    await screen.findByRole("heading", { name: "Rutas y revisiones" });
    await user.click(screen.getByRole("button", { name: "Ver detalle de Ruta Sector A" }));
    await screen.findByRole("heading", { name: "Ruta Sector A" });

    await user.click(screen.getByRole("button", { name: "Revisar publicación" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Confirmar y publicar",
      }),
    );
    const replacedRevision = await screen.findByRole("button", {
      name: /Revisión 1.*Reemplazada/i,
    });
    await user.click(replacedRevision);

    expect(screen.getAllByText("Reemplazada").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Revisar publicación" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Corregir puntos CSV" })).not.toBeInTheDocument();
  });

  it("muestra una revisión archivada como solo lectura", async () => {
    const user = userEvent.setup();
    render(<App api={createDemoAdminApi({ delayMs: 0 })} demoMode />);

    await login(user);
    await user.click(screen.getByRole("button", { name: /Cuadrilla Costa/ }));
    await screen.findByRole("heading", { name: "Rutas y revisiones" });
    await user.click(screen.getByRole("button", { name: "Ver detalle de Ruta Costanera" }));

    await screen.findByRole("heading", { name: "Ruta Costanera" });
    expect(screen.getAllByText("Archivada").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Revisar publicación" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Corregir puntos CSV" })).not.toBeInTheDocument();
  });

  it("distingue 403 de un error temporal recuperable", async () => {
    const user = userEvent.setup();
    const api = createDemoAdminApi({ delayMs: 0 });
    const { unmount } = render(<App api={api} demoMode />);

    await login(user);
    await user.click(screen.getByRole("button", { name: /Acceso restringido/ }));
    expect(await screen.findByRole("heading", { name: "Acceso restringido" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("403");

    unmount();
    window.sessionStorage.clear();
    const secondUser = userEvent.setup();
    render(<App api={createDemoAdminApi({ delayMs: 0 })} demoMode />);
    await login(secondUser);
    await secondUser.click(screen.getByRole("button", { name: /Servidor inestable/ }));

    expect(
      await screen.findByRole("heading", { name: "No pudimos cargar las rutas" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeEnabled();
  });

  it("no expone controles de datos demo si el modo no está habilitado", async () => {
    const user = userEvent.setup();
    render(<App api={createDemoAdminApi({ delayMs: 0 })} demoMode={false} />);

    await screen.findByRole("heading", { name: "Iniciar sesión" });
    await user.type(screen.getByLabelText("Correo"), "admin@demo.cl");
    await user.type(screen.getByLabelText("Contraseña"), "demo1234");
    await user.click(screen.getByRole("button", { name: "Ingresar" }));
    await screen.findByRole("heading", { name: "Elige una tripulación" });
    await user.click(screen.getByRole("button", { name: /Los Halcones/ }));
    await screen.findByRole("heading", { name: "Rutas y revisiones" });
    await user.click(screen.getByRole("button", { name: "Nueva ruta desde CSV" }));

    expect(screen.queryByRole("button", { name: "Cargar ejemplo demo" })).not.toBeInTheDocument();
    expect(screen.queryByText("Modo demostración")).not.toBeInTheDocument();
  });
});
