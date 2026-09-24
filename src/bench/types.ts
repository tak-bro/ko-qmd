/**
 * Types for the QMD benchmark harness.
 *
 * A benchmark fixture defines queries with expected results.
 * The harness runs each query through multiple search backends
 * and measures precision, recall, MRR, and latency.
 */

export type BenchmarkQueryType = "exact" | "semantic" | "topical" | "cross-domain" | "alias"
  | "sem-hard" | "multi" | "neg";

/** Query types pooled into the hard `RESULT-HARD` gate line (bench-ko.sh / dogfood.sh). */
export const HARD_QUERY_TYPES: readonly BenchmarkQueryType[] = ["sem-hard", "multi", "neg"];

export interface BenchmarkQuery {
  /** Unique identifier for the query */
  id: string;
  /** The search query text */
  query: string;
  /** Query difficulty/type for grouping results */
  type: BenchmarkQueryType;
  /** Human-readable description of what this tests */
  description: string;
  /** File paths (relative to collection) that should appear in results */
  expected_files: string[];
  /** How many of expected_files should appear in top-k results */
  expected_in_top_k?: number;
  /** For `neg` queries: the named-but-excluded concept's path (fixture-test invariant only) */
  excluded?: string;
}

export interface BenchmarkFixture {
  /** Description of the benchmark */
  description: string;
  /** Fixture format version */
  version: number;
  /** Optional collection to search within */
  collection?: string;
  /** The test queries */
  queries: BenchmarkQuery[];
}

export interface BackendResult {
  /** Fraction of top-k results that are relevant */
  precision_at_k: number;
  /** Fraction of expected files found anywhere in results */
  recall: number;
  /** Fraction of expected files found in the first result */
  recall_at_1: number;
  /** Fraction of expected files found in the top 3 results */
  recall_at_3: number;
  /** Fraction of expected files found in the top 5 results */
  recall_at_5: number;
  /** Reciprocal rank of first relevant result (1/rank, 0 if not found) */
  mrr: number;
  /** Harmonic mean of precision_at_k and recall */
  f1: number;
  /** Number of expected files found in top-k */
  hits_at_k: number;
  /** Total expected files */
  total_expected: number;
  /** Wall-clock latency in milliseconds */
  latency_ms: number;
  /** Top result file paths (for inspection) */
  top_files: string[];
  /** Expected files that were found anywhere in the returned result set */
  matched_files: string[];
  /** Expected files missing from the returned result set */
  unmatched_expected_files: string[];
}

export interface QueryResult {
  id: string;
  query: string;
  type: string;
  backends: Record<string, BackendResult>;
}

/** Per-backend averages over a group of queries (the shape of summary[backend]). */
export interface BackendSummary {
  avg_precision: number;
  avg_recall: number;
  avg_recall_at_1: number;
  avg_recall_at_3: number;
  avg_recall_at_5: number;
  avg_mrr: number;
  avg_f1: number;
  avg_latency_ms: number;
}

/** Per-backend averages over one query type; count = queries of that type (the same for every backend). */
export type BackendSummaryByType = Record<string, Record<string, BackendSummary & { count: number }>>;

/** Count-weighted pool over the hard query types; nulls when no hard queries ran (printed as nan). */
export interface HardSummary {
  hybrid_r1: number | null;
  hybrid_mrr: number | null;
  full_r1: number | null;
  full_mrr: number | null;
  n: number;
}

export interface BenchmarkResult {
  timestamp: string;
  fixture: string;
  results: QueryResult[];
  summary: Record<string, BackendSummary>;
  summary_by_type: BackendSummaryByType;
  summary_hard: HardSummary;
}
