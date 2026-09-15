/** Team failures never link into or activate the local debugger shell. */
export function TeamRouteError() {
  return <main role="alert" className="mx-auto max-w-xl space-y-4 p-8 text-[color:var(--rp-ink)]"><h1 className="text-xl font-semibold">The team workspace could not be loaded</h1><p>Reload the page to try again, or return to your projects.</p><div className="flex flex-wrap gap-4"><a className="underline" href="/team">Return to projects</a><button type="button" className="underline" onClick={() => location.reload()}>Reload workspace</button></div></main>;
}
