import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { applyThemeChoice, browserPrefersDark, browserStorage, readChoice } from "./theme/theme.ts";
import "./theme/design-tokens.css";
import "./layout/layout.css";

applyThemeChoice(document.documentElement, readChoice(browserStorage()), browserPrefersDark());

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Élément #root absent.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
