import { createRoot, type Root } from "react-dom/client";
import { SimpleFieldApp } from "./SimpleFieldApp";
import "./styles.css";
import "./simple-field.css";

export function mountField(root = document.getElementById("root")): Root {
  if (!root) throw new Error("ROOT_ELEMENT_NOT_FOUND");

  const demoMode = import.meta.env.VITE_DEMO_MODE?.trim().toLocaleLowerCase("en") === "true";
  const reactRoot = createRoot(root);
  reactRoot.render(<SimpleFieldApp demoMode={demoMode} />);
  return reactRoot;
}
