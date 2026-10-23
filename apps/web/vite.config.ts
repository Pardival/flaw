import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/**
 * SEC-CLI-03 — le service worker ne met en Cache Storage aucune réponse /api/*.
 * Les ressources précachées sont les fichiers statiques du build.
 * Une navigation ou une requête sous /api/ part sur le réseau, sans cache.
 */
const apiPath = /\/api\//;

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Vitest laisse NODE_ENV=test. Sans ce mode, le plugin émet le service
      // worker de développement, pas celui du build.
      mode: "production",
      registerType: "autoUpdate",
      injectRegister: null,
      manifest: {
        name: "Flaw",
        short_name: "Flaw",
        lang: "fr",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#ffffff",
        theme_color: "#ffffff",
        icons: [
          {
            src: "favicon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
        ],
      },
      workbox: {
        mode: "production",
        inlineWorkboxRuntime: true,
        globPatterns: ["**/*.{js,css,html,ico,woff2}"],
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          { urlPattern: apiPath, handler: "NetworkOnly", method: "GET" },
          { urlPattern: apiPath, handler: "NetworkOnly", method: "POST" },
          { urlPattern: apiPath, handler: "NetworkOnly", method: "PUT" },
          { urlPattern: apiPath, handler: "NetworkOnly", method: "PATCH" },
          { urlPattern: apiPath, handler: "NetworkOnly", method: "DELETE" },
          { urlPattern: apiPath, handler: "NetworkOnly", method: "HEAD" },
        ],
      },
    }),
  ],
});
