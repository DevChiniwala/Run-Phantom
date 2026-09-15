import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useReplay } from "../src/hooks/use-replay";

type PendingReplay = { source: string; signal: AbortSignal; resolve: (response: Response) => void; stream?: ReadableStreamDefaultController<Uint8Array> };
const requests: PendingReplay[] = [];
const details: { id: string; resolve: (response: Response) => void }[] = [];
const callbacks: string[] = [];
let cancelledReaders = 0;
let listRequests = 0;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url === "/api/replay") return new Promise<Response>(resolve => requests.push({ source: JSON.parse(String(init?.body)).runId, signal: init?.signal as AbortSignal, resolve }));
  if (url === "/api/runs") { listRequests++; return json([{ id: "foreign-replay", event_name: "replay:other", last_updated_at: Date.now() }]); }
  if (url.endsWith("/foreign-replay")) return json({ run: { id: "foreign-replay" }, spans: [{ id: "foreign-span" }] });
  if (url.startsWith("/api/runs/detail/")) return new Promise<Response>(resolve => details.push({ id: decodeURIComponent(url.split("/").at(-1)!), resolve }));
  throw new Error(`Unexpected harness request: ${url}`);
};

Object.assign(window, { replayHarness: {
  requests, details, callbacks,
  get cancelledReaders() { return cancelledReaders; },
  get listRequests() { return listRequests; },
  open(index: number) {
    const request = requests[index];
    const stream = new ReadableStream<Uint8Array>({ start(controller) { request.stream = controller; }, cancel() { cancelledReaders++; } });
    request.resolve(new Response(stream, { headers: { "Content-Type": "text/event-stream" } }));
  },
  emit(index: number, event: unknown) { requests[index].stream!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); },
  end(index: number) { requests[index].stream!.close(); },
  detail(index: number, hasSpans = true) { const entry = details[index]; entry.resolve(json({ run: { id: entry.id }, spans: hasSpans ? [{ id: "own-span" }] : [] })); },
  fail(index: number) { requests[index].resolve(new Response("fixture rejected", { status: 503 })); },
} });

function ReplayHarness() {
  const replay = useReplay(id => callbacks.push(id));
  const [source, setSource] = useState("source-a");
  return <section>
    <label>Source <input value={source} onChange={event => setSource(event.target.value)} /></label>
    <button onClick={() => { void replay.startReplay({ runId: source }); }}>Start</button>
    <button onClick={replay.cancel}>Cancel</button>
    <button onClick={replay.reset}>Reset</button>
    <button onClick={() => replay.viewExisting("existing-run")}>Existing</button>
    <output data-testid="state">{replay.state}</output>
    <output data-testid="run">{replay.replayRunId ?? "none"}</output>
    <output data-testid="error">{replay.error ?? "none"}</output>
    <output data-testid="iteration">{replay.progress.iteration}</output>
  </section>;
}
function App() {
  const [mounted, setMounted] = useState(true);
  return <><button onClick={() => setMounted(!mounted)}>Toggle mount</button>{mounted && <ReplayHarness />}</>;
}
createRoot(document.getElementById("root")!).render(<App />);
