import { useState } from "react";
import { ApiError } from "../api/client";
import type { AdminApi, LoginResponse } from "../api/types";

interface LoginViewProps {
  api: Pick<AdminApi, "login" | "setToken">;
  demoCredentials?: {
    email: string;
    password: string;
  };
  demoDescription?: string;
  demoMode: boolean;
  notice?: string;
  onAuthenticated: (response: LoginResponse) => void;
}

const LEGACY_DEMO_CREDENTIALS = {
  email: "admin@demo.cl",
  password: "demo1234",
};

export function LoginView({
  api,
  demoCredentials = LEGACY_DEMO_CREDENTIALS,
  demoDescription,
  demoMode,
  notice,
  onAuthenticated,
}: LoginViewProps) {
  const [email, setEmail] = useState(demoMode ? demoCredentials.email : "");
  const [password, setPassword] = useState(demoMode ? demoCredentials.password : "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ status?: number; message: string } | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await api.login(email, password);
      api.setToken(response.token);
      onAuthenticated(response);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError({ status: caught.status, message: caught.message });
      } else {
        setError({ message: "Ocurrió un error inesperado al iniciar sesión." });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main id="main-content" className="login-layout">
      <section className="login-intro" aria-labelledby="login-product-title">
        <p className="eyebrow">Consola administrativa</p>
        <h1 id="login-product-title">Asigna rutas y consulta el avance de cada vivienda.</h1>
        <p>
          Crea usuarios, carga las viviendas de cada ruta y revisa el avance desde una sola web.
        </p>
        <ul className="feature-list">
          <li>Un usuario, una ruta asignada</li>
          <li>Seis estados claros por vivienda</li>
          <li>Calles divididas por lado cuando corresponda</li>
        </ul>
      </section>

      <section className="login-panel" aria-labelledby="login-title">
        <div>
          <p className="eyebrow">RutaCuadrilla</p>
          <h2 id="login-title">Iniciar sesión</h2>
        </div>

        {notice ? (
          <p className="notice" role="status">
            {notice}
          </p>
        ) : null}

        {demoMode ? (
          <div className="demo-notice" role="note">
            <strong>Modo demostración</strong>
            <span>
              {demoDescription ??
                `Usa ${demoCredentials.email} y ${demoCredentials.password}. Ningún dato sale del navegador.`}
            </span>
          </div>
        ) : null}

        <form onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor="email">Correo</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="password">Contraseña</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          {error ? (
            <div className="form-error" role="alert">
              {error.status ? <strong>{error.status}</strong> : null}
              <span>{error.message}</span>
            </div>
          ) : null}

          <button
            className="button button--primary button--block"
            type="submit"
            disabled={submitting || !email.trim() || !password}
          >
            {submitting ? "Ingresando…" : "Ingresar"}
          </button>
        </form>
      </section>
    </main>
  );
}
