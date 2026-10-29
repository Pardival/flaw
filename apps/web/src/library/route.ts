import { useEffect, useState } from "react";

/**
 * Routes de l'app. Les URL ne portent que des UUID, jamais de titre (SEC-CLI-01).
 * L'éditeur est une route : le retour du navigateur ramène à la liste.
 */
export type Route = { name: "list" } | { name: "create" } | { name: "text"; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRoute(pathname: string): Route {
  if (pathname === "/nouveau") {
    return { name: "create" };
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
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const update = () => {
      setRoute(parseRoute(window.location.pathname));
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
