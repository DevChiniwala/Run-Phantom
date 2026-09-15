export const RUN_COMPARISON_LIMITS = {
  spansPerRun: 2000, acquiredBytes: 8 * 1024 * 1024, fieldBytes: 64 * 1024,
  scalarBytes: 4096, previewBytes: 512, depth: 64, pageRows: 200, responseBytes: 1024 * 1024,
} as const;
export const COMPARISON_FIELDS = ["name", "span_type", "status", "model", "provider", "input_payload", "output_payload", "duration_ms", "input_tokens", "output_tokens"] as const;
export type ComparisonFieldName = typeof COMPARISON_FIELDS[number];
export type ComparisonState = "same" | "changed" | "unavailable";
export type ComparisonRowState = "changed" | "unchanged" | "unavailable" | "added" | "removed" | "ambiguous";
export interface CapturedComparisonSpan {
  id: string; run_id: string; parent_span_id: string | null; name: string; span_type: string | null; status: string | null;
  input_payload: string | null; output_payload: string | null; model: string | null; provider: string | null;
  start_time_ms: number | null; end_time_ms: number | null; duration_ms: number | null; input_tokens: number | null; output_tokens: number | null;
  attributes: string | null;
  input_oversized?: number; output_oversized?: number; attributes_oversized?: number;
}
export interface CapturedComparisonRun { id: string; name: string | null; spans: CapturedComparisonSpan[] }
export interface ComparisonValue {
  value: string | number | null;
  unavailable: "missing" | "oversized" | "redacted" | "incomplete" | "invalid" | null;
  previewTruncated: boolean;
}
export interface ComparisonField {
  name: ComparisonFieldName;
  state: ComparisonState;
  baseline: ComparisonValue;
  candidate: ComparisonValue;
  delta: number | null;
}
export interface ComparisonSpanLink { id: string; runId: string; name: string; href: string }
export interface ComparisonRow {
  id: string;
  state: ComparisonRowState;
  match: "unique sibling key" | "unique captured input" | null;
  reason: string | null;
  baseline: ComparisonSpanLink[];
  candidate: ComparisonSpanLink[];
  fields: ComparisonField[];
  reordered: boolean;
  orderAvailable: boolean;
}
export interface RunComparison {
  format: "runphantom-run-comparison/v1";
  baseline: { id: string; name: string; spanCount: number; complete: boolean; href: string };
  candidate: { id: string; name: string; spanCount: number; complete: boolean; href: string };
  counts: Record<ComparisonRowState, number> & { paired: number; ambiguousBaselineSpans: number; ambiguousCandidateSpans: number; unavailableFields: number };
  rows: ComparisonRow[];
  totalRows: number;
  offset: number;
  nextOffset: number | null;
  warnings: string[];
  equality: "exact captured text";
}
