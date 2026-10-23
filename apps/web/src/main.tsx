import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import { App } from "./App.tsx";

registerSW({ immediate: true });

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Élément #root absent.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
