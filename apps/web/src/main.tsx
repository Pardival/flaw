import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

import { App } from "./App.tsx";
import i18n from "./i18n/i18n.ts";
import { applyThemeChoice, browserPrefersDark, browserStorage, readChoice } from "./theme/theme.ts";
import "../../../assets/fonts/polices.css";
import "./theme/design-tokens.css";
import "./layout/layout.css";
import "./library/library.css";
import "./editor/editor.css";

applyThemeChoice(document.documentElement, readChoice(browserStorage()), browserPrefersDark());

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Élément #root absent.");
}

createRoot(root).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <App />
    </I18nextProvider>
  </StrictMode>,
);
