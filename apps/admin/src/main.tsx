import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHttpAdminApi } from "./api/client";
import { SimpleAdminApp } from "./SimpleAdminApp";
import "./styles.css";
import "./simple-admin.css";

async function bootstrap() {
  const rootElement = document.getElementById("root");
  if (!rootElement) {
    throw new Error("No se encontró el contenedor principal.");
  }

  const api = createHttpAdminApi();
  const demoMode = import.meta.env.VITE_DEMO_MODE?.trim().toLocaleLowerCase("en") === "true";
  createRoot(rootElement).render(
    <StrictMode>
      <SimpleAdminApp api={api} demoMode={demoMode} />
    </StrictMode>,
  );
}

void bootstrap();
