import { StrictMode } from "react";
import { hideBootSplash } from "./shell/boot-splash.ts";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

import { App } from "./App.tsx";
import { LOCAL_ONLY } from "./platform/target.ts";
import i18n from "./i18n/i18n.ts";
import { applyThemeChoice, browserPrefersDark, browserStorage, readChoice } from "./theme/theme.ts";
import "../../../assets/fonts/polices.css";
import "./theme/design-tokens.css";
import "./layout/layout.css";
import "./library/library.css";
import "./editor/editor.css";
import "./layout/polish.css";

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

// Filet de sécurité : le logo de chargement ne reste jamais au-delà de 10 s.
window.setTimeout(hideBootSplash, 10_000);

// PWA installable (T-056) : le service worker n'est enregistré que dans la version construite.
// La version de bureau embarque déjà tous ses fichiers : pas de service worker.
if (import.meta.env.PROD && !LOCAL_ONLY && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  });
}
