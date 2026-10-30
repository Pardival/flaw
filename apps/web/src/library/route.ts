import { useEffect, useState } from "react";
import { flushSync } from "react-dom";

import { withViewTransition } from "../shell/presence.ts";

/**
 * Routes de l'app. Les URL ne portent que des UUID, jamais de titre (SEC-CLI-01).
 * L'éditeur est une route : le retour du navigateur ramène à la liste.
 */
export type Route = { name: "list" } | { name: "create" } | { name: "trash" } | { name: "text"; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRoute(pathname: string): Route {
  if (pathname === "/nouveau") {
    return { name: "create" };
  }
  if (pathname === "/corbeille") {
    return { name: "trash" };
  }
  const match = /^\/t\/([^/]+)$/.exec(pathname);
  if (match && UUID.test(match[1] as string)) {
    return { name: "text", id: (match[1] as string).toLowerCase() };
  }
  return { name: "list" };
}

export function routePath(route: Route): string {
  switch (route.name) {
    case "create":
      return "/nouveau";
    case "trash":
      return "/corbeille";
    case "text":
      if (!UUID.test(route.id)) {
        throw new Error("identifiant de texte invalide");
      }
      return `/t/${route.id}`;
    default:
      return "/";
  }
}

const ROUTE_EVENT = "flaw:route";

export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const path = routePath(route);
  if (window.location.pathname === path) {
    return;
  }
  if (options.replace) {
    window.history.replaceState(null, "", path);
  } else {
    window.history.pushState(null, "", path);
  }
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === "undefined" ? { name: "list" } : parseRoute(window.location.pathname),
  );
  useEffect(() => {
    const update = () => {
      const next = parseRoute(window.location.pathname);
      // Fondu enchaîné entre l'accueil, la création et un texte (entrée comme sortie).
      withViewTransition(() => {
        flushSync(() => setRoute(next));
      });
    };
    window.addEventListener("popstate", update);
    window.addEventListener(ROUTE_EVENT, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(ROUTE_EVENT, update);
    };
  }, []);
  return route;
}

/** Panneau à ouvrir à l'arrivée dans l'éditeur (menu ⋯ de la liste : Historique, Exporter). */
let pendingPanel: "history" | "export" | "cover" | null = null;

export function openTextWith(id: string, panel: "history" | "export" | "cover"): void {
  pendingPanel = panel;
  navigate({ name: "text", id });
}

export function takePendingPanel(): "history" | "export" | "cover" | null {
  const panel = pendingPanel;
  pendingPanel = null;
  return panel;
}
