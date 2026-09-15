import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { createAppRouter } from "./router";
import { queryClient } from "./query-client";
// Self-hosted so the app makes no third-party request on load. The revamped
// type scale was measured against Inter specifically: it ships tabular figures
// and a slashed zero, which Avenir Next lacks, and trace ids and duration
// columns depend on both.
import "@fontsource-variable/inter/wght.css";
import "./index.css";
import { installNavModality } from "./utils/nav-modality";

installNavModality();

const root = createRoot(document.getElementById("root")!);
void createAppRouter().then(router => {
  root.render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}).catch(() => {
  root.render(<main role="alert" className="p-8"><h1>The workspace could not be loaded</h1><button type="button" onClick={() => location.reload()}>Reload workspace</button></main>);
});
