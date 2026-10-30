import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("version de bureau", () => {
  it("ouvre directement la bibliothèque, sans aucun écran de connexion", async () => {
    vi.stubEnv("VITE_FLAW_TARGET", "desktop");
    vi.resetModules();
    const { LOCAL_ONLY } = await import("./target.ts");
    const { App } = await import("../App.tsx");
    expect(LOCAL_ONLY).toBe(true);
    const page = renderToStaticMarkup(
      <App initialPhase={{ name: "connexion", notice: null }}>
        <p>texte local</p>
      </App>,
    );
    expect(page).toContain("texte local");
    expect(page).not.toContain('data-screen="connexion"');
  });

  it("la version serveur garde la connexion", async () => {
    vi.stubEnv("VITE_FLAW_TARGET", "");
    vi.resetModules();
    const { App } = await import("../App.tsx");
    const page = renderToStaticMarkup(
      <App initialPhase={{ name: "connexion", notice: null }}>
        <p>texte local</p>
      </App>,
    );
    expect(page).toContain('data-screen="connexion"');
    expect(page).not.toContain("texte local");
  });
});
