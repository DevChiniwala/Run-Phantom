import { useEffect, useId, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type SelectHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Link } from "react-router-dom";
import { LoaderCircle } from "lucide-react";
import { Button } from "../components/ui/button";
import { RunPhantomMark } from "../components/RunPhantomMark";

export function Action({ children, primary, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return <Button type="button" {...props} className={`team-action ${primary ? "team-primary" : ""} ${props.className ?? ""}`}>{children}</Button>;
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="team-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
export function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <input {...props} className={`team-input ${props.className ?? ""}`} />; }
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) { return <select {...props} className={`team-input ${props.className ?? ""}`} />; }
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea {...props} className={`team-input team-textarea ${props.className ?? ""}`} />; }
export function ErrorNotice({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  return <div role="alert" className="team-error"><p>{error instanceof Error ? error.message : String(error)}</p>{retry && <Action onClick={retry}>Try again</Action>}</div>;
}
export function Loading({ text = "Loading workspace…" }: { text?: string }) { return <div role="status" className="team-loading"><LoaderCircle size={18} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />{text}</div>; }
export function Empty({ title, children }: { title: string; children: ReactNode }) { return <div className="team-empty"><h2>{title}</h2><div>{children}</div></div>; }
export function Heading({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) { return <header className="team-heading"><div><h1>{title}</h1>{children && <p>{children}</p>}</div>{action}</header>; }
export function Badge({ value }: { value: string }) { return <span className={`team-badge team-badge-${value}`}>{value}</span>; }
export function DateTime({ value }: { value: number | null }) { return value === null ? <>Unavailable</> : <time dateTime={new Date(value).toISOString()}>{new Date(value).toLocaleString()}</time>; }
export function duration(value: number | null) { return value === null ? "Unavailable" : value < 1000 ? `${Number(value.toFixed(2))} ms` : `${Number((value / 1000).toFixed(2))} s`; }
export function Evidence({ title, value, unavailable }: { title: string; value: unknown; unavailable?: boolean }) {
  const id = useId();
  const text = typeof value === "string" ? value : value == null ? null : JSON.stringify(value, null, 2);
  return <section className="team-evidence" aria-labelledby={id}><h3 id={id}>{title}</h3>{unavailable && <p className="team-muted">Evidence is unavailable or was redacted.</p>}{text === null ? <p className="team-muted">Not captured</p> : <pre tabIndex={0}>{text}</pre>}</section>;
}
export function More({ available, busy, onClick }: { available: boolean; busy: boolean; onClick: () => void }) { return available ? <Action disabled={busy} onClick={onClick}>{busy ? "Loading more…" : "Load more"}</Action> : null; }
export function TeamBrand() { return <Link className="team-brand" to="/team"><span className="team-brand-mark"><RunPhantomMark decorative size={28} /></span><span>Run Phantom<small>Team workspace</small></span></Link>; }
export function useTask() {
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null);
  const active = useRef(true); const generation = useRef(0);
  useEffect(() => () => { active.current = false; generation.current++; }, []);
  async function run<T>(work: () => Promise<T>, done?: (value: T) => void) {
    if (busy) return;
    const owner = ++generation.current; setBusy(true); setError(null);
    try { const value = await work(); if (active.current && generation.current === owner) done?.(value); }
    catch (cause) { if (active.current && generation.current === owner && !(cause instanceof DOMException && cause.name === "AbortError")) setError(cause); }
    finally { if (active.current && generation.current === owner) setBusy(false); }
  }
  return { busy, error, run };
}
export function useDebouncedValue<T>(value: T, milliseconds = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => { const timer = window.setTimeout(() => setSettled(value), milliseconds); return () => clearTimeout(timer); }, [value, milliseconds]);
  return settled;
}
