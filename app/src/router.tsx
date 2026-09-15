import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate, type RouteObject } from "react-router-dom";
import { TeamRouteError } from "./team/TeamRouteError";

const TeamApp = lazy(() => import("./team/TeamApp"));
const teamRoute: RouteObject = {
  path: "/team/*",
  element: <Suspense fallback={<div role="status">Loading team workspace…</div>}><TeamApp /></Suspense>,
  errorElement: <TeamRouteError />,
};

// Local deep-link callbacks consume this live binding after bootstrap completes.
export let router: ReturnType<typeof createBrowserRouter>;
export async function createAppRouter() {
  if (location.pathname === "/team" || location.pathname.startsWith("/team/")) {
    router = createBrowserRouter([teamRoute, { path: "*", element: <Navigate to="/team" replace /> }]);
  } else {
    const { localRoutes } = await import("./local-router");
    router = createBrowserRouter([teamRoute, ...localRoutes]);
  }
  return router;
}
