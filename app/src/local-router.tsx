import { useEffect, useRef, useState } from "react";
import {
  type RouteObject,
  Navigate,
  Outlet,
  useMatch,
} from "react-router-dom";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { NavSidebar } from "./components/NavSidebar";
import { MessagePane } from "./components/MessagePane";
import { RunsPage } from "./pages/RunsPage";
import { SearchPage } from "./pages/SearchPage";
import { SavedPage } from "./pages/SavedPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { SettingsPage } from "./pages/SettingsPage";
import { VerificationPage } from "./pages/VerificationPage";
import { EvaluationsPage } from "./pages/EvaluationsPage";
import { RouteError } from "./components/RouteError";
import { sendRunPhantomMessage, useRunPhantomConnected } from "./hooks/use-runphantom-ws";
import { useAgentUiCommands } from "./hooks/use-agent-ui-commands";
import { useDialogFocus } from "./hooks/use-dialog-focus";
import { safeDecodeParam } from "./utils/helpers";

const DISCONNECTED_NOTICE_DELAY_MS = 100;

function AppLayout() {
  const [showDisconnectedNotice, setShowDisconnectedNotice] = useState(false);
  const disconnectedDialogRef = useRef<HTMLDivElement>(null);
  const runMatch = useMatch({ path: "/runs/:runId", end: false });
  const activeRunId = runMatch?.params.runId
    ? safeDecodeParam(runMatch.params.runId)
    : null;
  const runPhantomConnected = useRunPhantomConnected();
  useAgentUiCommands();
  useDialogFocus(showDisconnectedNotice, disconnectedDialogRef);

  useEffect(() => {
    if (runPhantomConnected) {
      setShowDisconnectedNotice(false);
      return;
    }
    const timeout = window.setTimeout(() => {
      setShowDisconnectedNotice(true);
    }, DISCONNECTED_NOTICE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [runPhantomConnected]);

  useEffect(() => {
    sendRunPhantomMessage({ type: "ui_view", run_id: activeRunId });
  }, [activeRunId]);

  return (
    <SidebarProvider defaultOpen>
      <a href="#runphantom-main" className="skip-link">Skip to trace workspace</a>
      <NavSidebar />
      <SidebarInset id="runphantom-main" tabIndex={-1}>
        <div className="relative h-screen overflow-hidden">
          <SidebarTrigger className="absolute left-3 top-3 z-40 border border-[color:var(--rp-border)] bg-[color:var(--rp-surface)] text-[color:var(--rp-ink)] shadow-lg lg:hidden" />
          <div
            className={`flex h-full transition-opacity duration-200 ${showDisconnectedNotice ? "pointer-events-none select-none opacity-45" : ""}`}
            aria-hidden={showDisconnectedNotice}
          >
            <div className="flex-1 min-w-0 overflow-auto">
              <Outlet />
            </div>
            <MessagePane activeRunId={activeRunId} />
          </div>
          {showDisconnectedNotice && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-stone-900/20 px-6">
              <div
                ref={disconnectedDialogRef}
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="runphantom-disconnected-title"
                aria-describedby="runphantom-disconnected-description"
                tabIndex={-1}
                className="flex min-h-[180px] w-[520px] max-w-full flex-col items-center justify-center rounded-xl border border-[color:var(--rp-border)] bg-[color:var(--rp-surface)] px-9 py-6 text-center shadow-2xl"
              >
                <h1 id="runphantom-disconnected-title" className="text-lg font-semibold text-[color:var(--rp-ink-strong)]">Run Phantom isn&apos;t running.</h1>
                <div id="runphantom-disconnected-description" className="mt-4 text-[15px] leading-relaxed text-[color:var(--rp-ink-muted)]">
                  Run <code className="rounded bg-[color:var(--rp-ink-wash-strong)] px-1.5 py-0.5 font-mono text-[color:var(--rp-ink-strong)]">runphantom</code> from your terminal to resume.
                </div>
              </div>
            </div>
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

export const localRoutes: RouteObject[] = [
  {
    path: "/",
    element: <AppLayout />,
    // Child routes carry their own errorElement so a page-level throw keeps the nav
    // chrome mounted and every other trace reachable; this one is the last line of
    // defence for a throw in the layout itself.
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to="/runs" replace />, errorElement: <RouteError /> },
      { path: "runs", element: <RunsPage />, errorElement: <RouteError /> },
      { path: "runs/:runId/span/:spanId", element: <RunsPage />, errorElement: <RouteError /> },
      { path: "runs/:runId/spans", element: <RunsPage />, errorElement: <RouteError /> },
      { path: "runs/:runId/convo", element: <RunsPage />, errorElement: <RouteError /> },
      { path: "runs/:runId", element: <RunsPage />, errorElement: <RouteError /> },
      { path: "search/:runId/span/:spanId", element: <SearchPage />, errorElement: <RouteError /> },
      { path: "search/:runId/spans", element: <SearchPage />, errorElement: <RouteError /> },
      { path: "search/:runId/convo", element: <SearchPage />, errorElement: <RouteError /> },
      { path: "search/:runId", element: <SearchPage />, errorElement: <RouteError /> },
      { path: "search", element: <SearchPage />, errorElement: <RouteError /> },
      { path: "saved/:runId/span/:spanId", element: <SavedPage />, errorElement: <RouteError /> },
      { path: "saved/:runId/spans", element: <SavedPage />, errorElement: <RouteError /> },
      { path: "saved/:runId/convo", element: <SavedPage />, errorElement: <RouteError /> },
      { path: "saved/:runId", element: <SavedPage />, errorElement: <RouteError /> },
      { path: "saved", element: <SavedPage />, errorElement: <RouteError /> },
      { path: "settings", element: <SettingsPage />, errorElement: <RouteError /> },
      { path: "verification", element: <VerificationPage />, errorElement: <RouteError /> },
      { path: "evaluations", element: <EvaluationsPage />, errorElement: <RouteError /> },
      { path: "*", element: <NotFoundPage />, errorElement: <RouteError /> },
    ],
  },
];
