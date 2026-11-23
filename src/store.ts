/**
 * QMD Store - Core data access and retrieval functions
 *
 * This module provides all database operations, search functions, and document
 * retrieval for QMD. It returns raw data structures that can be formatted by
 * CLI or MCP consumers.
 *
 * Usage:
 *   const store = createStore("/path/to/db.sqlite");
 *   // or use default path:
 *   const store = createStore();
 */

import { openDatabase, loadSqliteVec } from "./db.js";
// The embed lock is the one crash-safe cross-process domain for embedding this
// index; store.ts is where every embed entry point (SDK, CLI, direct calls)
// funnels through, so it joins that domain here rather than in each caller.
import {
  acquireEmbedLock,
  embedLockPathForDb,
  type EmbedLockBusyReason,
  type EmbedLockHandle,
} from "./cli/embed-lock.js";
import {
  PartitionWriter,
  VEC_COLLECTION_IDS_TABLE,
  VEC_ROWS_TABLE,
  VEC_TABLE,
  activeCollectionsOfHash,
  allocateCollectionId,
  createPartitionedVecTable,
  createVectorMetadataTables,
  deleteCollectionId,
  deletePartitionRows,
  deletePartitionRowsOfHash,
  hasVectorIndex,
  missingPartitionRows,
  partitionRowKey,
  renameCollectionId,
  resolveCollectionId,
  resolveCollectionIds,
  rowidList,
  storedEmbeddingLookup,
  upsertPartitionVector,
  vecInteger,
  vecLayout,
  vecTableReadable,
  type MissingPartitionRow,
  type VecLayout,
} from "./vec-layout.js";
import {
  FTS_SYNC_TRIGGERS_VERSION,
  getUserVersion,
  migrateVectorLayout,
  runStoreMigrations,
  VECTOR_PARTITION_VERSION,
  type VectorMigrationProgress,
} from "./store-migrations.js";
import type { Database, SQLiteValue } from "./db.js";
import picomatch from "picomatch";
import { isNarrowing, matchesPaths, type DocumentFilter } from "./filters.js";
import { createHash } from "crypto";
import { readFileSync, realpathSync, statSync, mkdirSync } from "node:fs";
// Note: node:path resolve is not imported — we export our own cross-platform resolve()
import fastGlob from "fast-glob";
import { AsyncLocalStorage } from "node:async_hooks";
import { qmdHomedir } from "./paths.js";
import { containsHangul, estimateCharsPerToken, hangulBigramTail, hangulMixedQuery, hangulTermQuery, stripHangulNegation } from "./hangul.js";
import { formatRerankDoc, formatRerankQuery, INTENT_WEIGHT_CHUNK, selectRerankChunk, type RerankChunk } from "./rerank-input.js";
import {
  LlamaCpp,
  getDefaultLlamaCpp,
  formatQueryForEmbedding,
  formatDocForEmbedding,
  withLLMSessionForLlm,
  DEFAULT_EMBED_MODEL_URI,
  DEFAULT_RERANK_MODEL_URI,
  DEFAULT_GENERATE_MODEL_URI,
  normalizeRerankMaxDocTokens,
  type RerankDocument,
  type ILLMSession,
} from "./llm.js";
import type {
  NamedCollection,
  Collection,
  CollectionConfig,
  ContextMap,
} from "./collections.js";
import { METADATA_EXTRACTION_VERSION, type DocumentMetadata } from "./metadata.js";
import { copyCommandProcessorSpec, snapshotProcessor, type DocumentProcessor } from "./processors.js";
import { initializeProcessorSchema, requireProcessor, reindexProcessedFiles, removeProcessorState, renameProcessorState } from "./processor-store.js";
import { compileMetadataFilter, type MetadataFilter } from "./metadata-filter.js";
import {
  initializeMetadataSchema,
  syncDocumentMetadata,
  countDocumentsPendingMetadata,
  getMetadataByFilepath,
  listMetadataCollectionSummaries,
  parseMetadataJson,
  type MetadataKeyOverview,
} from "./metadata-store.js";

// =============================================================================
// Configuration
// =============================================================================

export const DEFAULT_EMBED_MODEL = DEFAULT_EMBED_MODEL_URI;
export const DEFAULT_RERANK_MODEL = DEFAULT_RERANK_MODEL_URI;
export const DEFAULT_QUERY_MODEL = DEFAULT_GENERATE_MODEL_URI;
export const DEFAULT_GLOB = "**/*.md";

/**
 * Split a collection glob mask into fast-glob patterns.
 *
 * `--mask "a.md,*.txt"` is a comma-separated union (issue #557), but
 * fast-glob treats a comma outside `{...}` as a literal character, so
 * the joined string matches nothing. Brace form `{a.md,*.txt}` is
 * already valid glob syntax and is left intact.
 *
 * Commas inside `{...}` or `[...]` are not separators. Empty segments
 * after the split are dropped.
 */
export function splitGlobMask(mask: string): string[] {
  const parts: string[] = [];
  let current = "";
  let braceDepth = 0;
  let bracketDepth = 0;

  for (const ch of mask) {
    if (ch === "{") {
      braceDepth++;
      current += ch;
    } else if (ch === "}" && braceDepth > 0) {
      braceDepth--;
      current += ch;
    } else if (ch === "[") {
      bracketDepth++;
      current += ch;
    } else if (ch === "]" && bracketDepth > 0) {
      bracketDepth--;
      current += ch;
    } else if (ch === "," && braceDepth === 0 && bracketDepth === 0) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = "";
    } else {
      current += ch;
    }
  }

  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);
  return parts.length > 0 ? parts : [mask];
}

export const DEFAULT_MULTI_GET_MAX_BYTES = 64 * 1024; // 64KB

/**
 * Characters of a document body that search results, the vector body lookup
 * and getHashesForEmbedding return (SQLite's substr counts characters), so one
 * very large document cannot put its whole text on the heap per result.
 */
const BODY_CAP_CHARS = 262_144;

/**
 * SQL for the first BODY_CAP_CHARS characters of a body column. substr()
 * stops at an embedded NUL, so a body whose UTF-8 encoding fits the cap is
 * returned whole and only a longer one goes through substr().
 */
function cappedBodySql(column: string): string {
  return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${BODY_CAP_CHARS} THEN ${column} ELSE substr(${column}, 1, ${BODY_CAP_CHARS}) END`;
}
export const DEFAULT_EMBED_MAX_DOCS_PER_BATCH = 64;
export const DEFAULT_EMBED_MAX_BATCH_BYTES = 64 * 1024 * 1024; // 64MB
export const DEFAULT_EMBED_MAX_DURATION_MS = 30 * 60 * 1000; // 30 minutes; see EmbedOptions.maxDurationMs

const EMBED_FINGERPRINT_PROBE_QUERY = "__qmd_embedding_query_probe__";
const EMBED_FINGERPRINT_PROBE_TITLE = "__qmd_embedding_title_probe__";
const EMBED_FINGERPRINT_PROBE_DOC = "__qmd_embedding_document_probe__";

// Chunking: 900 tokens per chunk with 15% overlap
// Increased from 800 to accommodate smart chunking finding natural break points
export const CHUNK_SIZE_TOKENS = 900;
export const CHUNK_OVERLAP_TOKENS = Math.floor(CHUNK_SIZE_TOKENS * 0.15);  // 135 tokens (15% overlap)
// Fallback char-based approximation for sync chunking (~4 chars per token)
export const CHUNK_SIZE_CHARS = CHUNK_SIZE_TOKENS * 4;  // 3600 chars
export const CHUNK_OVERLAP_CHARS = CHUNK_OVERLAP_TOKENS * 4;  // 540 chars
// Search window for finding optimal break points (in tokens, ~200 tokens)
export const CHUNK_WINDOW_TOKENS = 200;
export const CHUNK_WINDOW_CHARS = CHUNK_WINDOW_TOKENS * 4;  // 800 chars

export function getEmbeddingFingerprint(model: string = DEFAULT_EMBED_MODEL): string {
  const significant = [
    `model:${model}`,
    `query:${formatQueryForEmbedding(EMBED_FINGERPRINT_PROBE_QUERY, model)}`,
    `doc:${formatDocForEmbedding(EMBED_FINGERPRINT_PROBE_DOC, EMBED_FINGERPRINT_PROBE_TITLE, model)}`,
    `chunk_tokens:${CHUNK_SIZE_TOKENS}`,
    `chunk_overlap_tokens:${CHUNK_OVERLAP_TOKENS}`,
    // v2: first-pass chunk sizing derives chars/token from script
    // composition (estimateCharsPerToken) instead of the fixed 3.0.
    `chunk_chars_estimator:2`,
  ].join("\n");
  const digest = createHash("sha256").update(significant).digest("hex");
  return model.startsWith("remote-openai:") ? digest : digest.slice(0, 6);
}

/**
 * Get the LlamaCpp instance for a store — prefers the store's own instance,
 * falls back to the global singleton.
 */
function getLlm(store: Store): LlamaCpp {
  return store.llm ?? getDefaultLlamaCpp();
}

// =============================================================================
// Smart Chunking - Break Point Detection
// =============================================================================

/**
 * A potential break point in the document with a base score indicating quality.
 */
export interface BreakPoint {
  pos: number;    // character position
  score: number;  // base score (higher = better break point)
  type: string;   // for debugging: 'h1', 'h2', 'blank', etc.
}

/**
 * A region where a code fence exists (between ``` markers).
 * We should never split inside a code fence.
 */
export interface CodeFenceRegion {
  start: number;  // position of opening ```
  end: number;    // position of closing ``` (or document end if unclosed)
}

/**
 * Patterns for detecting break points in markdown documents.
 * Higher scores indicate better places to split.
 * Scores are spread wide so headings decisively beat lower-quality breaks.
 * Order matters for scoring - more specific patterns first.
 */
export const BREAK_PATTERNS: [RegExp, number, string][] = [
  [/\n#{1}(?!#)/g, 100, 'h1'],     // # but not ##
  [/\n#{2}(?!#)/g, 90, 'h2'],      // ## but not ###
  [/\n#{3}(?!#)/g, 80, 'h3'],      // ### but not ####
  [/\n#{4}(?!#)/g, 70, 'h4'],      // #### but not #####
  [/\n#{5}(?!#)/g, 60, 'h5'],      // ##### but not ######
  [/\n#{6}(?!#)/g, 50, 'h6'],      // ######
  [/\n```/g, 80, 'codeblock'],     // code block boundary (same as h3)
  [/\n(?:---|\*\*\*|___)\s*\n/g, 60, 'hr'],  // horizontal rule
  [/\n\n+/g, 20, 'blank'],         // paragraph boundary
  [/\n[-*]\s/g, 5, 'list'],        // unordered list item
  [/\n\d+\.\s/g, 5, 'numlist'],    // ordered list item
  [/\n/g, 1, 'newline'],           // minimal break
];

/**
 * Scan text for all potential break points.
 * Returns sorted array of break points with higher-scoring patterns taking precedence
 * when multiple patterns match the same position.
 */
export function scanBreakPoints(text: string): BreakPoint[] {
  const points: BreakPoint[] = [];
  const seen = new Map<number, BreakPoint>();  // pos -> best break point at that pos

  for (const [pattern, score, type] of BREAK_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const pos = match.index!;
      const existing = seen.get(pos);
      // Keep higher score if position already seen
      if (!existing || score > existing.score) {
        const bp = { pos, score, type };
        seen.set(pos, bp);
      }
    }
  }

  // Convert to array and sort by position
  for (const bp of seen.values()) {
    points.push(bp);
  }
  return points.sort((a, b) => a.pos - b.pos);
}

/**
 * Find all code fence regions in the text.
 * Code fences are delimited by ``` and we should never split inside them.
 */
export function findCodeFences(text: string): CodeFenceRegion[] {
  const regions: CodeFenceRegion[] = [];
  const fencePattern = /\n```/g;
  let inFence = false;
  let fenceStart = 0;

  for (const match of text.matchAll(fencePattern)) {
    if (!inFence) {
      fenceStart = match.index!;
      inFence = true;
    } else {
      regions.push({ start: fenceStart, end: match.index! + match[0].length });
      inFence = false;
    }
  }

  // Handle unclosed fence - extends to end of document
  if (inFence) {
    regions.push({ start: fenceStart, end: text.length });
  }

  return regions;
}

/**
 * Check if a position is inside a code fence region.
 */
export function isInsideCodeFence(pos: number, fences: CodeFenceRegion[]): boolean {
  return fences.some(f => pos > f.start && pos < f.end);
}

/**
 * Find the best cut position using scored break points with distance decay.
 *
 * Uses squared distance for gentler early decay - headings far back still win
 * over low-quality breaks near the target.
 *
 * @param breakPoints - Pre-scanned break points from scanBreakPoints()
 * @param targetCharPos - The ideal cut position (e.g., maxChars boundary)
 * @param windowChars - How far back to search for break points (default ~200 tokens)
 * @param decayFactor - How much to penalize distance (0.7 = 30% score at window edge)
 * @param codeFences - Code fence regions to avoid splitting inside
 * @returns The best position to cut at
 */
export function findBestCutoff(
  breakPoints: BreakPoint[],
  targetCharPos: number,
  windowChars: number = CHUNK_WINDOW_CHARS,
  decayFactor: number = 0.7,
  codeFences: CodeFenceRegion[] = []
): number {
  const windowStart = targetCharPos - windowChars;
  let bestScore = -1;
  let bestPos = targetCharPos;

  for (const bp of breakPoints) {
    if (bp.pos < windowStart) continue;
    if (bp.pos > targetCharPos) break;  // sorted, so we can stop

    // Skip break points inside code fences
    if (isInsideCodeFence(bp.pos, codeFences)) continue;

    const distance = targetCharPos - bp.pos;
    // Squared distance decay: gentle early, steep late
    // At target: multiplier = 1.0
    // At 25% back: multiplier = 0.956
    // At 50% back: multiplier = 0.825
    // At 75% back: multiplier = 0.606
    // At window edge: multiplier = 0.3
    const normalizedDist = distance / windowChars;
    const multiplier = 1.0 - (normalizedDist * normalizedDist) * decayFactor;
    const finalScore = bp.score * multiplier;

    if (finalScore > bestScore) {
      bestScore = finalScore;
      bestPos = bp.pos;
    }
  }

  return bestPos;
}

// =============================================================================
// Chunk Strategy
// =============================================================================

export type ChunkStrategy = "auto" | "regex";

/**
 * Merge two sets of break points (e.g. regex + AST), keeping the highest
 * score at each position. Result is sorted by position.
 */
export function mergeBreakPoints(a: BreakPoint[], b: BreakPoint[]): BreakPoint[] {
  const seen = new Map<number, BreakPoint>();
  for (const bp of a) {
    const existing = seen.get(bp.pos);
    if (!existing || bp.score > existing.score) {
      seen.set(bp.pos, bp);
    }
  }
  for (const bp of b) {
    const existing = seen.get(bp.pos);
    if (!existing || bp.score > existing.score) {
      seen.set(bp.pos, bp);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.pos - b.pos);
}

/**
 * True if `pos` sits between a UTF-16 high surrogate (at pos-1) and a low
 * surrogate (at pos) — i.e. slicing at `pos` would split an astral-plane
 * character (emoji, etc.) into two unpaired surrogates.
 */
function isSurrogatePairBoundary(content: string, pos: number): boolean {
  if (pos <= 0 || pos >= content.length) return false;
  const high = content.charCodeAt(pos - 1);
  const low = content.charCodeAt(pos);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

/**
 * Nudges `pos` off a surrogate-pair boundary so a slice ending or starting
 * at `pos` never contains an unpaired surrogate. Prefers retreating by one
 * code unit (excludes the pair from this slice, deferring it to the next
 * chunk); when that would violate forward progress (`pos - 1 <= floor`,
 * the caller-supplied lower bound, e.g. the previous chunk's start),
 * advances by one code unit instead (includes the whole pair in this
 * slice, slightly exceeding the caller's target width).
 *
 * Advancing is always safe: `isSurrogatePairBoundary` only returns true
 * for `pos < content.length`, so `pos + 1 <= content.length`; and every
 * call site already guarantees `pos > floor` before calling this function,
 * so `pos + 1 > floor` too. This means a surrogate pair is never split —
 * unlike a plain "give up and leave pos unchanged" fallback, which would
 * let recursive re-chunking (e.g. chunkDocumentByTokens shrinking maxChars
 * toward 1 for astral-dense content) reproduce the exact bug this exists
 * to prevent.
 */
function adjustSurrogateBoundary(content: string, pos: number, floor: number): number {
  if (!isSurrogatePairBoundary(content, pos)) return pos;
  const retreat = pos - 1;
  return retreat > floor ? retreat : pos + 1;
}

/**
 * Core chunk algorithm that operates on precomputed break points and code fences.
 * This is the shared implementation used by both regex-only and AST-aware chunking.
 */
export function chunkDocumentWithBreakPoints(
  content: string,
  breakPoints: BreakPoint[],
  codeFences: CodeFenceRegion[],
  maxChars: number = CHUNK_SIZE_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  windowChars: number = CHUNK_WINDOW_CHARS
): { text: string; pos: number }[] {
  if (content.length <= maxChars) {
    return [{ text: content, pos: 0 }];
  }

  const chunks: { text: string; pos: number }[] = [];
  let charPos = 0;

  while (charPos < content.length) {
    const targetEndPos = Math.min(charPos + maxChars, content.length);
    let endPos = targetEndPos;

    if (endPos < content.length) {
      const bestCutoff = findBestCutoff(
        breakPoints,
        targetEndPos,
        windowChars,
        0.7,
        codeFences
      );

      if (bestCutoff > charPos && bestCutoff <= targetEndPos) {
        endPos = bestCutoff;
      }
    }

    if (endPos <= charPos) {
      endPos = Math.min(charPos + maxChars, content.length);
    }

    // Never slice through the middle of a surrogate pair (e.g. an emoji) —
    // an unpaired surrogate in the chunk text breaks JSON serialization for
    // remote embedding APIs.
    endPos = adjustSurrogateBoundary(content, endPos, charPos);

    chunks.push({ text: content.slice(charPos, endPos), pos: charPos });

    if (endPos >= content.length) {
      break;
    }
    charPos = endPos - overlapChars;
    const lastChunkPos = chunks.at(-1)!.pos;
    if (charPos <= lastChunkPos) {
      charPos = endPos;
    }
    charPos = adjustSurrogateBoundary(content, charPos, lastChunkPos);
  }

  return chunks;
}

// Hybrid query: strong BM25 signal detection thresholds
// Skip expensive LLM expansion when top result is strong AND clearly separated from runner-up
export const STRONG_SIGNAL_MIN_SCORE = 0.85;
export const STRONG_SIGNAL_MIN_GAP = 0.15;
// Max candidates to pass to reranker — balances quality vs latency.
// 40 keeps rank 31-40 visible to the reranker (matters for recall on broad queries).
export const RERANK_CANDIDATE_LIMIT = 40;

/**
 * A typed query expansion result. Decoupled from llm.ts internal Queryable —
 * same shape, but store.ts owns its own public API type.
 *
 * - lex: keyword variant → routes to FTS only
 * - vec: semantic variant → routes to vector only
 * - hyde: hypothetical document → routes to vector only
 */
export type ExpandedQuery = {
  type: 'lex' | 'vec' | 'hyde';
  query: string;
  /** Optional line number for error reporting (CLI parser) */
  line?: number;
};

// =============================================================================
// Path utilities
// =============================================================================

export function homedir(): string {
  return qmdHomedir();
}

/**
 * Check if a path is absolute.
 * Supports:
 * - Unix paths: /path/to/file
 * - Windows native: C:\path or C:/path
 * - Git Bash: /c/path or /C/path (C-Z drives, excluding A/B floppy drives)
 * 
 * Note: /c without trailing slash is treated as Unix path (directory named "c"),
 * while /c/ or /c/path are treated as Git Bash paths (C: drive).
 */
export function isAbsolutePath(path: string): boolean {
  if (!path) return false;
  
  // Unix absolute path
  if (path.startsWith('/')) {
    // Check if it's a Git Bash style path like /c/ or /c/Users (C-Z only, not A or B)
    // Requires path[2] === '/' to distinguish from Unix paths like /c or /cache
    // Skipped on WSL where /c/ is a valid drvfs mount point, not a drive letter
    if (!isWSL() && path.length >= 3 && path[2] === '/') {
      const driveLetter = path[1];
      if (driveLetter && /[c-zC-Z]/.test(driveLetter)) {
        return true;
      }
    }
    // Any other path starting with / is Unix absolute
    return true;
  }
  
  // Windows native path: C:\ or C:/ (any letter A-Z)
  if (path.length >= 2 && /[a-zA-Z]/.test(path[0]!) && path[1] === ':') {
    return true;
  }
  
  return false;
}

/**
 * Normalize path separators to forward slashes.
 * Converts Windows backslashes to forward slashes.
 */
export function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Detect if running inside WSL (Windows Subsystem for Linux).
 * On WSL, paths like /c/work/... are valid drvfs mount points, not Git Bash paths.
 */
function isWSL(): boolean {
  return !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

/**
 * Get the relative path from a prefix.
 * Returns null if path is not under prefix.
 * Returns empty string if path equals prefix.
 */
export function getRelativePathFromPrefix(path: string, prefix: string): string | null {
  // Empty prefix is invalid
  if (!prefix) {
    return null;
  }
  
  const normalizedPath = normalizePathSeparators(path);
  const normalizedPrefix = normalizePathSeparators(prefix);
  
  // Ensure prefix ends with / for proper matching
  const prefixWithSlash = !normalizedPrefix.endsWith('/') 
    ? normalizedPrefix + '/' 
    : normalizedPrefix;
  
  // Exact match
  if (normalizedPath === normalizedPrefix) {
    return '';
  }
  
  // Check if path starts with prefix
  if (normalizedPath.startsWith(prefixWithSlash)) {
    return normalizedPath.slice(prefixWithSlash.length);
  }
  
  return null;
}

export function resolve(...paths: string[]): string {
  if (paths.length === 0) {
    throw new Error("resolve: at least one path segment is required");
  }
  
  // Normalize all paths to use forward slashes
  const normalizedPaths = paths.map(normalizePathSeparators);
  
  let result = '';
  let windowsDrive = '';
  
  // Check if first path is absolute
  const firstPath = normalizedPaths[0]!;
  if (isAbsolutePath(firstPath)) {
    result = firstPath;
    
    // Extract Windows drive letter if present
    if (firstPath.length >= 2 && /[a-zA-Z]/.test(firstPath[0]!) && firstPath[1] === ':') {
      windowsDrive = firstPath.slice(0, 2);
      result = firstPath.slice(2);
    } else if (!isWSL() && firstPath.startsWith('/') && firstPath.length >= 3 && firstPath[2] === '/') {
      // Git Bash style: /c/ -> C: (C-Z drives only, not A or B)
      // Skipped on WSL where /c/ is a valid drvfs mount point, not a drive letter
      const driveLetter = firstPath[1];
      if (driveLetter && /[c-zC-Z]/.test(driveLetter)) {
        windowsDrive = driveLetter.toUpperCase() + ':';
        result = firstPath.slice(2);
      }
    }
  } else {
    // Start with PWD or cwd, then append the first relative path
    const pwd = normalizePathSeparators(process.env.PWD || process.cwd());
    
    // Extract Windows drive from PWD if present
    if (pwd.length >= 2 && /[a-zA-Z]/.test(pwd[0]!) && pwd[1] === ':') {
      windowsDrive = pwd.slice(0, 2);
      result = pwd.slice(2) + '/' + firstPath;
    } else {
      result = pwd + '/' + firstPath;
    }
  }
  
  // Process remaining paths
  for (let i = 1; i < normalizedPaths.length; i++) {
    const p = normalizedPaths[i]!;
    if (isAbsolutePath(p)) {
      // Absolute path replaces everything
      result = p;
      
      // Update Windows drive if present
      if (p.length >= 2 && /[a-zA-Z]/.test(p[0]!) && p[1] === ':') {
        windowsDrive = p.slice(0, 2);
        result = p.slice(2);
      } else if (!isWSL() && p.startsWith('/') && p.length >= 3 && p[2] === '/') {
        // Git Bash style (C-Z drives only, not A or B)
        // Skipped on WSL where /c/ is a valid drvfs mount point, not a drive letter
        const driveLetter = p[1];
        if (driveLetter && /[c-zC-Z]/.test(driveLetter)) {
          windowsDrive = driveLetter.toUpperCase() + ':';
          result = p.slice(2);
        } else {
          windowsDrive = '';
        }
      } else {
        windowsDrive = '';
      }
    } else {
      // Relative path - append
      result = result + '/' + p;
    }
  }
  
  // Normalize . and .. components
  const parts = result.split('/').filter(Boolean);
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      normalized.pop();
    } else if (part !== '.') {
      normalized.push(part);
    }
  }
  
  // Build final path
  const finalPath = '/' + normalized.join('/');
  
  // Prepend Windows drive if present
  if (windowsDrive) {
    return windowsDrive + finalPath;
  }
  
  return finalPath;
}

// Flag to indicate production mode (set by qmd.ts at startup)
let _productionMode = false;

export function enableProductionMode(): void {
  _productionMode = true;
}

/** Reset production mode flag — only for testing. */
export function _resetProductionModeForTesting(): void {
  _productionMode = false;
}

export function getDefaultDbPath(indexName: string = "index"): string {
  // Always allow override via INDEX_PATH (for testing)
  if (process.env.INDEX_PATH) {
    return process.env.INDEX_PATH;
  }

  // In non-production mode (tests), require explicit path
  if (!_productionMode) {
    throw new Error(
      "Database path not set. Tests must set INDEX_PATH env var or use createStore() with explicit path. " +
      "This prevents tests from accidentally writing to the global index."
    );
  }

  const cacheDir = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");
  const qmdCacheDir = resolve(cacheDir, "qmd");
  try { mkdirSync(qmdCacheDir, { recursive: true }); } catch { }
  return resolve(qmdCacheDir, `${indexName}.sqlite`);
}

export function getPwd(): string {
  return process.env.PWD || process.cwd();
}

export function getRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * True if `target` is `dir` or a descendant, after resolving symlinks.
 * Used to keep indexing and qmd:// filesystem resolution inside a collection.
 */
export function isPathInsideDir(dir: string, target: string): boolean {
  const realDir = getRealPath(dir);
  try {
    return getRelativePathFromPrefix(realpathSync(target), realDir) !== null;
  } catch {
    // Unreadable or dangling: realpath fails. Compare lexically so a mode-0
    // file inside the collection is not treated as an escape (macOS /var vs
    // /private/var). Readable out-of-tree symlinks still hit the try path.
    return getRelativePathFromPrefix(resolve(target), resolve(dir)) !== null;
  }
}


// =============================================================================
// Virtual Path Utilities (qmd://)
// =============================================================================

export type VirtualPath = {
  collectionName: string;
  path: string;  // relative path within collection
  indexName?: string;
};

/**
 * Normalize explicit virtual path formats to standard qmd:// format.
 * Only handles paths that are already explicitly virtual:
 * - qmd://collection/path.md (already normalized)
 * - qmd:////collection/path.md (extra slashes - normalize)
 * - //collection/path.md (missing qmd: prefix - add it)
 *
 * Does NOT handle:
 * - collection/path.md (bare paths - could be filesystem relative)
 * - :linenum suffix (should be parsed separately before calling this)
 */
export function normalizeVirtualPath(input: string): string {
  let path = input.trim();

  // Handle qmd:// with extra slashes: qmd:////collection/path -> qmd://collection/path
  if (path.startsWith('qmd:')) {
    // Remove qmd: prefix and normalize slashes
    path = path.slice(4);
    // Remove leading slashes and re-add exactly two
    path = path.replace(/^\/+/, '');
    return `qmd://${path}`;
  }

  // Handle //collection/path (missing qmd: prefix)
  if (path.startsWith('//')) {
    path = path.replace(/^\/+/, '');
    return `qmd://${path}`;
  }

  // Return as-is for other cases (filesystem paths, docids, bare collection/path, etc.)
  return path;
}

/**
 * Parse a virtual path like "qmd://collection-name/path/to/file.md"
 * into its components.
 * Also supports collection root: "qmd://collection-name/" or "qmd://collection-name"
 */
export function parseVirtualPath(virtualPath: string): VirtualPath | null {
  // Normalize the path first
  const normalized = normalizeVirtualPath(virtualPath);
  const [pathPart = normalized, queryString = ""] = normalized.split("?");

  // Match: qmd://collection-name[/optional-path]
  // Allows: qmd://name, qmd://name/, qmd://name/path
  const match = pathPart.match(/^qmd:\/\/([^\/]+)\/?(.*)$/);
  if (!match?.[1]) return null;
  const indexName = new URLSearchParams(queryString).get("index")?.trim() || undefined;
  return {
    collectionName: match[1],
    path: match[2] ?? '',  // Empty string for collection root
    ...(indexName ? { indexName } : {}),
  };
}

/**
 * Build a virtual path from collection name and relative path.
 */
export function buildVirtualPath(collectionName: string, path: string, indexName?: string): string {
  const base = `qmd://${collectionName}/${path}`;
  return indexName ? `${base}?index=${encodeURIComponent(indexName)}` : base;
}

/**
 * Check if a path is explicitly a virtual path.
 * Only recognizes explicit virtual path formats:
 * - qmd://collection/path.md
 * - //collection/path.md
 *
 * Does NOT consider bare collection/path.md as virtual - that should be
 * handled separately by checking if the first component is a collection name.
 */
export function isVirtualPath(path: string): boolean {
  const trimmed = path.trim();

  // Explicit qmd:// prefix (with any number of slashes)
  if (trimmed.startsWith('qmd:')) return true;

  // //collection/path format (missing qmd: prefix)
  if (trimmed.startsWith('//')) return true;

  return false;
}

/**
 * Resolve a virtual path to absolute filesystem path.
 */
export function resolveVirtualPath(db: Database, virtualPath: string): string | null {
  const parsed = parseVirtualPath(virtualPath);
  if (!parsed) return null;

  const coll = getCollectionByName(db, parsed.collectionName);
  if (!coll) return null;

  const resolved = resolve(coll.pwd, parsed.path);
  if (!isPathInsideDir(coll.pwd, resolved)) return null;
  return resolved;
}

/**
 * Convert an absolute filesystem path to a virtual path.
 * Returns null if the file is not in any indexed collection.
 */
export function toVirtualPath(db: Database, absolutePath: string): string | null {
  // Get all collections from DB
  const collections = getStoreCollections(db);

  // Find which collection this absolute path belongs to
  for (const coll of collections) {
    if (absolutePath.startsWith(coll.path + '/') || absolutePath === coll.path) {
      // Extract relative path
      const relativePath = absolutePath.startsWith(coll.path + '/')
        ? absolutePath.slice(coll.path.length + 1)
        : '';

      // Verify this document exists in the database
      const doc = db.prepare(`
        SELECT d.path
        FROM documents d
        WHERE d.collection = ? AND d.path = ? AND d.active = 1
        LIMIT 1
      `).get(coll.name, relativePath) as { path: string } | null;

      if (doc) {
        return buildVirtualPath(coll.name, relativePath);
      }
    }
  }

  return null;
}

// =============================================================================
// Database initialization
// =============================================================================


function createSqliteVecUnavailableError(reason: string): Error {
  return new Error(
    "sqlite-vec extension is unavailable. " +
    `${reason}. ` +
    "Install Homebrew SQLite so the sqlite-vec extension can be loaded, " +
    "and set BREW_PREFIX if Homebrew is installed in a non-standard location."
  );
}

let _sqliteVecUnavailableReason: string | null = null;

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function verifySqliteVecLoaded(db: Database): void {
  try {
    const row = db.prepare(`SELECT vec_version() AS version`).get() as { version?: string } | null;
    if (!row?.version || typeof row.version !== "string") {
      throw new Error("vec_version() returned no version");
    }
  } catch (err) {
    const message = getErrorMessage(err);
    throw createSqliteVecUnavailableError(`sqlite-vec probe failed (${message})`);
  }
}

let _sqliteVecAvailable: boolean | null = null;

const CJK_CHAR_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RUN_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const FTS_CJK_NORMALIZED_VERSION = "2"; // ko-qmd: "2" adds Hangul bigrams

/**
 * FTS5's unicode61 tokenizer does not segment CJK text into searchable words.
 * Normalize CJK runs by spacing every character so exact CJK queries can be
 * translated into phrase queries while Latin text keeps the default tokenizer.
 */
export function normalizeCjkForFTS(text: string): string {
  // ko-qmd: indexed text also carries Hangul syllable bigrams at the end
  const bigrams = hangulBigramTail(text);
  return bigrams ? `${spaceCjkRuns(text)} ${bigrams}` : spaceCjkRuns(text);
}

function spaceCjkRuns(text: string): string {
  return text.replace(CJK_RUN_PATTERN, run => ` ${Array.from(run).join(' ')} `);
}

function containsCjk(text: string): boolean {
  return CJK_CHAR_PATTERN.test(text);
}

function sanitizeFTS5Phrase(phrase: string): string {
  // A quoted phrase is matched against tokens the porter unicode61 tokenizer
  // produced, and that tokenizer splits document text on every separator.
  // Deleting the separators here instead would collapse "1.0.21" to "1021" and
  // "PIO-1384" to "pio1384", tokens no document holds, so the query returns
  // nothing with no error (#757 for dots, #916 for the rest). Split on the same
  // separators the tokenizer does and emit the parts as adjacent phrase terms.
  // ko-qmd: query phrases use character tokens only, not the bigram tail.
  return spaceCjkRuns(phrase)
    .split(/\s+/)
    .flatMap(t => splitFTS5CompoundTerm(t))
    .join(' ');
}

// FTS sync triggers keep documents_fts current for callers that write directly
// to documents (production indexing rebuilds FTS in TypeScript to normalize CJK
// first). The bodies use DROP+CREATE rather than CREATE IF NOT EXISTS so a
// changed body propagates to existing databases. DROP and CREATE are separate
// autocommit statements, so concurrent opens of one database interleave across
// connections (A drops, B drops, A creates, B creates -> "trigger already
// exists"); busy_timeout serializes individual statements but not the pair.
// runStoreMigrations gates the work behind PRAGMA user_version and applies it
// inside one IMMEDIATE transaction: the DROP+CREATE pair is atomic across
// connections, and a double-checked read skips it once any process has
// stamped the version. A ko-qmd trigger body change bumps KO_FTS_TRIGGERS_REVISION
// (applyKoFtsSyncTriggers) instead, so existing databases reinstall it on the next open.
function installFtsSyncTriggers(db: Database): void {
  db.exec(`DROP TRIGGER IF EXISTS documents_ai`);
  db.exec(`
    CREATE TRIGGER documents_ai AFTER INSERT ON documents
    WHEN new.active = 1
    BEGIN
      INSERT INTO documents_fts(rowid, filepath, title, body)
      SELECT
        new.id,
        new.collection || '/' || new.path,
        new.title,
        (SELECT doc FROM content WHERE hash = new.hash)
      WHERE new.active = 1;
    END
  `);

  db.exec(`DROP TRIGGER IF EXISTS documents_ad`);
  db.exec(`
    CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
      DELETE FROM documents_fts WHERE rowid = old.id;
    END
  `);

  db.exec(`DROP TRIGGER IF EXISTS documents_au`);
  // Scoped to the FTS-visible columns EXCEPT title. Title-only writes
  // (updateDocumentTitle) sync the FTS title explicitly and must not pay for
  // a full raw row rewrite here; every title mutator (updateDocumentTitle,
  // updateDocument, insertDocument's upsert) handles FTS itself. Touches to
  // title-unrelated columns (e.g. modified_at) correctly skip FTS work since
  // the FTS row holds no such columns.
  db.exec(`
    CREATE TRIGGER documents_au AFTER UPDATE OF collection, path, hash, active ON documents
    BEGIN
      -- Delete from FTS if no longer active
      DELETE FROM documents_fts WHERE rowid = old.id AND new.active = 0;

      -- Update FTS if still/newly active
      INSERT OR REPLACE INTO documents_fts(rowid, filepath, title, body)
      SELECT
        new.id,
        new.collection || '/' || new.path,
        new.title,
        (SELECT doc FROM content WHERE hash = new.hash)
      WHERE new.active = 1;
    END
  `);
}

/** Progress of the one-time vector layout upgrade, on stderr. */
function vectorMigrationReporter(): (progress: VectorMigrationProgress) => void {
  let startedAt: number | null = null;
  const tty = Boolean(process.stderr.isTTY);
  return ({ phase, copied, total }) => {
    if (startedAt === null) {
      startedAt = Date.now();
      process.stderr.write(`Moving ${total} vectors to the per-collection index layout (one-time upgrade)...\n`);
    }
    if (phase === "copy") {
      if (tty) process.stderr.write(`\r  copied ${copied}/${total}`);
      return;
    }
    if (tty) process.stderr.write("\r");
    if (phase === "verify") process.stderr.write(`  copied ${copied}/${total}; verifying...\n`);
    else if (phase === "flip") process.stderr.write(`  dropping the old vector table...\n`);
    else if (phase === "vacuum") process.stderr.write(`  vacuuming the index (minutes on a large index)...\n`);
    else process.stderr.write(`  vector index upgraded in ${Math.round((Date.now() - startedAt) / 1000)}s\n`);
  };
}

/**
 * True when documents_fts is the current standalone (filepath, title, body)
 * table. Older schemas used fts5(name, body, content='documents'), and
 * CREATE VIRTUAL TABLE IF NOT EXISTS will not replace them. A CJK rebuild
 * then runs `DELETE FROM documents_fts`, which FTS5 compiles against the
 * external content table as `SELECT T.name FROM documents AS T` — documents
 * has no `name` column, so open throws `no such column: T.name` (#792).
 *
 * sqlite_master.sql is the usual signal, but PRAGMA table_info is the live
 * virtual-table schema: a leftover `name` column with no `filepath` is never
 * current, even if CREATE IF NOT EXISTS rewrote the sql text.
 */
function documentsFtsColumnNames(db: Database): string[] {
  try {
    const cols = db.prepare(`PRAGMA table_info(documents_fts)`).all() as { name?: string }[];
    return cols.map(c => (c.name ?? "").toLowerCase()).filter(Boolean);
  } catch {
    return [];
  }
}

function documentsFtsSchemaIsCurrent(db: Database): boolean {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'documents_fts'`
  ).get() as { sql?: string } | undefined | null;
  const sql = (row?.sql ?? "").toLowerCase().replace(/\s+/g, "");
  if (!sql.includes("filepath") || !sql.includes("title") || sql.includes("content=")) {
    return false;
  }
  const names = new Set(documentsFtsColumnNames(db));
  return names.has("filepath") && names.has("title") && names.has("body") && !names.has("name");
}

function isAlreadyExistsError(err: unknown): boolean {
  return /already exists/i.test(getErrorMessage(err));
}

function documentsFtsExists(db: Database): boolean {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'documents_fts'`
  ).get() as { name?: string } | undefined | null;
  return Boolean(row?.name);
}

// FTS5 CREATE VIRTUAL TABLE IF NOT EXISTS is not atomic across WAL connections.
// Two first-open processes can both observe a missing table on their schema
// snapshot; the loser then throws `table documents_fts already exists`
// (Bun/macOS CI). IF NOT EXISTS still helps the uncontended path, and a
// concurrent "already exists" is treated as success when the table is present.
const DOCUMENTS_FTS_DDL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
    filepath, title, body,
    tokenize='porter unicode61'
  )
`;

function createDocumentsFtsTable(db: Database): void {
  try {
    db.exec(DOCUMENTS_FTS_DDL);
  } catch (err) {
    if (!isAlreadyExistsError(err) || !documentsFtsExists(db)) throw err;
  }
}

function recreateDocumentsFts(db: Database): void {
  db.exec(`DROP TRIGGER IF EXISTS documents_ai`);
  db.exec(`DROP TRIGGER IF EXISTS documents_ad`);
  db.exec(`DROP TRIGGER IF EXISTS documents_au`);
  db.exec(`DROP TABLE IF EXISTS documents_fts`);
  createDocumentsFtsTable(db);
  db.exec(`DELETE FROM store_config WHERE key = 'fts_cjk_normalized_version'`);
}

// ko-qmd: documents_au is scoped to the FTS-visible columns, a body revision after
// upstream's FTS_SYNC_TRIGGERS_VERSION 1. Upstream owns PRAGMA user_version (its version 2
// is the vector partition step), so ko-qmd tracks its trigger revision in store_config,
// where no upstream step can collide with it. An index an earlier ko-qmd build stamped
// user_version 2 already has these triggers; it still holds the legacy vector table, which
// runStoreMigrations copies as a stamped-store repair.
const KO_FTS_TRIGGERS_KEY = "ko_fts_sync_triggers";
const KO_FTS_TRIGGERS_REVISION = "2";

function koFtsTriggersRevision(db: Database): string | undefined {
  const row = db.prepare(`SELECT value FROM store_config WHERE key = ?`).get(KO_FTS_TRIGGERS_KEY) as { value: string } | undefined;
  return row?.value;
}

/**
 * ko-qmd: an index an earlier ko-qmd build opened is stamped user_version 2,
 * which upstream reads as "vectors already partitioned". Such an index still
 * holds the legacy vector table, so runStoreMigrations would convert it on its
 * stamped-store repair path, where a failure (busy lock, full disk) is only a
 * warning and vector search goes quiet. Rewinding the stamp to the FTS step
 * sends the conversion down the first-upgrade path, where a failure stops the
 * open. Only an index this build has never opened (no ko trigger revision yet)
 * is rewound; FTS_SYNC_TRIGGERS_VERSION is the step both numberings share.
 */
function rewindKoSchemaStamp(db: Database): void {
  const isKoEraStamp = () =>
    koFtsTriggersRevision(db) === undefined
    && getUserVersion(db) === VECTOR_PARTITION_VERSION
    && vecLayout(db).kind === "legacy";
  if (!isKoEraStamp()) return;
  db.exec(`BEGIN IMMEDIATE`);
  try {
    if (isKoEraStamp()) db.exec(`PRAGMA user_version = ${FTS_SYNC_TRIGGERS_VERSION}`);
    db.exec(`COMMIT`);
  } catch (err) {
    db.exec(`ROLLBACK`);
    throw err;
  }
}

/** Reinstall the ko-qmd trigger bodies once per database, with applyVersionedStep's double-checked IMMEDIATE write. */
function applyKoFtsSyncTriggers(db: Database): void {
  if (koFtsTriggersRevision(db) === KO_FTS_TRIGGERS_REVISION) return;
  db.exec(`BEGIN IMMEDIATE`);
  try {
    if (koFtsTriggersRevision(db) !== KO_FTS_TRIGGERS_REVISION) {
      installFtsSyncTriggers(db);
      db.prepare(`INSERT INTO store_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(KO_FTS_TRIGGERS_KEY, KO_FTS_TRIGGERS_REVISION);
    }
    db.exec(`COMMIT`);
  } catch (err) {
    db.exec(`ROLLBACK`);
    throw err;
  }
}

// Missing-table create and legacy-schema repair share one IMMEDIATE
// transaction with a double-checked read, matching applyVersionedStep:
// the DROP+CREATE (or first CREATE) is atomic across connections, and
// losers skip once any process has published the current table.
function ensureDocumentsFtsSchema(db: Database): void {
  if (documentsFtsSchemaIsCurrent(db)) return;
  db.exec(`BEGIN IMMEDIATE`);
  try {
    if (!documentsFtsSchemaIsCurrent(db)) {
      if (documentsFtsExists(db)) {
        recreateDocumentsFts(db);
        // recreateDocumentsFts dropped the sync triggers. runStoreMigrations
        // only reinstalls them when user_version is stale, so a DB that already
        // has the current user_version would otherwise be left untriggered.
        if (getUserVersion(db) >= FTS_SYNC_TRIGGERS_VERSION) {
          installFtsSyncTriggers(db);
        }
      } else {
        createDocumentsFtsTable(db);
      }
    }
    db.exec(`COMMIT`);
  } catch (err) {
    db.exec(`ROLLBACK`);
    throw err;
  }
}

function cjkRebuildVersion(db: Database): string | undefined {
  const version = db.prepare(`SELECT value FROM store_config WHERE key = 'fts_cjk_normalized_version'`).get() as { value?: string } | undefined;
  return version?.value;
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function dropTableIfExists(db: Database, tableName: string): void {
  db.exec(`DROP TABLE IF EXISTS ${quoteSqlIdentifier(tableName)}`);
}

/** A document id the publish step must re-read from the documents table. */
type FtsRefreshId = { id: number };

/**
 * Rewrite the FTS rows of documents the shadow published stale, from the
 * documents table as it is inside the publish transaction — the exact state
 * that commits. A document that is no longer active ends up with no row.
 */
function refreshFtsRowsFromDocuments(db: Database, ...idSets: readonly FtsRefreshId[][]): void {
  const selectDoc = db.prepare(`
    SELECT d.collection AS collection, d.path AS path, d.title AS title, content.doc AS body
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE d.id = ? AND d.active = 1
  `);
  const deleteRow = db.prepare(`DELETE FROM documents_fts WHERE rowid = ?`);
  const insertRow = db.prepare(`INSERT INTO documents_fts(rowid, filepath, title, body) VALUES (?, ?, ?, ?)`);

  for (const ids of idSets) {
    for (const { id } of ids) {
      deleteRow.run(id);
      // One document at a time: bodies are large and independently capped, so
      // a corpus-wide change set never builds one huge JS array here.
      const doc = selectDoc.get(id) as { collection: string; path: string; title: string; body: string } | undefined;
      if (!doc) continue;
      insertRow.run(
        id,
        normalizeCjkForFTS(`${doc.collection}/${doc.path}`),
        normalizeCjkForFTS(doc.title),
        normalizeCjkForFTS(doc.body)
      );
    }
  }
}

/**
 * Test-only seam between the shadow build and its publish. A regression test
 * needs another connection to commit in exactly that window, which nothing
 * in-process can interleave with because the rebuild is synchronous.
 * Production never installs a hook.
 */
let _ftsRebuildBeforePublishHook: ((db: Database) => void) | null = null;

/** @internal Install the rebuild publish-race seam; pass null to clear it. */
export function _setFtsRebuildBeforePublishHookForTesting(
  hook: ((db: Database) => void) | null
): void {
  _ftsRebuildBeforePublishHook = hook;
}

function rebuildFTSForCjkNormalization(db: Database): void {
  // Repair leftover content-external FTS *before* the version check or the
  // later `DELETE FROM documents_fts`. A stamped CJK version with a legacy
  // `name` column would otherwise skip the rebuild, and DELETE still compiles
  // as SELECT T.name FROM documents (#792).
  ensureDocumentsFtsSchema(db);
  if (cjkRebuildVersion(db) === FTS_CJK_NORMALIZED_VERSION) return;

  // Clean up the legacy fixed-name shadow table left by an interrupted older
  // rebuild implementation. New concurrent rebuilds use per-process names below.
  dropTableIfExists(db, "documents_fts_rebuild");

  // Stream rows from disk and build into a per-process shadow FTS table plus a
  // per-row identity snapshot. A fixed shadow name made concurrent cold opens
  // collide (`database is locked`, then `no such table: documents_fts_rebuild`)
  // before the schema version could be stamped. Publishing runs in one
  // BEGIN IMMEDIATE with a double-checked version read, so only one process
  // installs the rebuild, and it reconciles the snapshot's changes first.
  const BATCH_SIZE = 500;
  const rebuildSuffix = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const rebuildTable = `documents_fts_rebuild_${rebuildSuffix}`;
  const snapshotTable = `documents_fts_snapshot_${rebuildSuffix}`;
  const quotedRebuildTable = quoteSqlIdentifier(rebuildTable);
  const quotedSnapshotTable = quoteSqlIdentifier(snapshotTable);

  try {
    db.exec(`
      CREATE VIRTUAL TABLE ${quotedRebuildTable} USING fts5(
        filepath, title, body,
        tokenize='porter unicode61'
      )
    `);

    // Identity of every shadow row as it was read: a plain table keyed by
    // document id, so publishing can diff it against documents in SQL instead
    // of re-reading bodies or holding the writer lock during the build.
    db.exec(`
      CREATE TABLE ${quotedSnapshotTable} (
        id INTEGER PRIMARY KEY,
        hash TEXT NOT NULL,
        filepath TEXT NOT NULL,
        title TEXT NOT NULL
      )
    `);

    type FtsRow = { id: number; collection: string; path: string; title: string; body: string; hash: string };

    const insert = db.prepare(`INSERT INTO ${quotedRebuildTable}(rowid, filepath, title, body) VALUES (?, ?, ?, ?)`);
    const insertSnapshot = db.prepare(`INSERT INTO ${quotedSnapshotTable}(id, hash, filepath, title) VALUES (?, ?, ?, ?)`);

    // The transaction closes over a mutable `batch` buffer rather than taking the
    // batch as an argument: the wrapper's transaction() type only accepts scalar
    // SQLiteValue args, and we want each commit to wrap a bounded set of inserts.
    let batch: FtsRow[] = [];
    const flushBatch = db.transaction(() => {
      for (const row of batch) {
        const filepath = `${row.collection}/${row.path}`;
        insert.run(
          row.id,
          normalizeCjkForFTS(filepath),
          normalizeCjkForFTS(row.title),
          normalizeCjkForFTS(row.body)
        );
        insertSnapshot.run(row.id, row.hash, filepath, row.title);
      }
    });

    // Pull bounded batches and finalize each SELECT before starting the insert
    // transaction. Holding a better-sqlite3 iterator open while beginning a
    // transaction on the same connection raises "database is busy".
    const selectBatch = db.prepare(`
      SELECT d.id, d.hash, d.collection, d.path, d.title, content.doc as body
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE d.active = 1
        AND d.id > ?
      ORDER BY d.id
      LIMIT ?
    `);

    let lastId = 0;
    for (;;) {
      batch = selectBatch.all(lastId, BATCH_SIZE) as FtsRow[];
      if (batch.length === 0) break;
      flushBatch();
      lastId = batch[batch.length - 1]!.id;
    }

    // Both the shadow and its identity snapshot are complete; a concurrent
    // writer may commit from here on and is reconciled by the publish.
    _ftsRebuildBeforePublishHook?.(db);

    // Atomic publish. The shadow was read without the writer lock, so another
    // connection may have committed documents after their shadow row was read
    // (`qmd update`, an MCP write, a cold open in another process). A blind
    // DELETE+INSERT would then publish the corpus as of the read — a document
    // committed after it keeps no row, and one updated after it gets its old
    // text back — and the stamp would make that permanent.
    //
    // The copy therefore runs in the same IMMEDIATE transaction as a set diff
    // between the identity recorded for every shadow row and the documents
    // table at commit time: a row whose document is inactive or gone is not
    // published, a row whose document changed content/path/title is re-read
    // with CJK normalization, and a document the shadow never saw is added the
    // same way. The diff compares ids and hashes, so it never re-reads an
    // unchanged body and the lock covers only the copy plus the changed set.
    // If another process won the race while this one was building its shadow,
    // skip the publish and only drop this process's private tables.
    db.exec(`BEGIN IMMEDIATE`);
    try {
      if (cjkRebuildVersion(db) !== FTS_CJK_NORMALIZED_VERSION) {
        // Same id, different identity: the document was rewritten (or
        // deactivated/removed) after its shadow row was read, so that row is
        // stale and must not be published by the bulk copy below.
        const changedRows = db.prepare(`
          SELECT s.id AS id
          FROM ${quotedSnapshotTable} s
          LEFT JOIN documents d ON d.id = s.id
          WHERE d.id IS NULL
            OR d.active = 0
            OR d.hash <> s.hash
            OR s.filepath <> d.collection || '/' || d.path
            OR s.title <> d.title
        `).all() as FtsRefreshId[];
        // Documents committed after the shadow's last batch read, plus
        // documents that were inactive when their id was passed and are active
        // now.
        const unseenRows = db.prepare(`
          SELECT d.id AS id
          FROM documents d
          LEFT JOIN ${quotedSnapshotTable} s ON s.id = d.id
          WHERE d.active = 1 AND s.id IS NULL
        `).all() as FtsRefreshId[];

        // Bulk copy first: one statement and no per-row JS for the (normally
        // overwhelming) part of the corpus that did not change mid-rebuild.
        db.exec(`DELETE FROM documents_fts`);
        db.exec(
          `INSERT INTO documents_fts(rowid, filepath, title, body)
           SELECT rowid, filepath, title, body FROM ${quotedRebuildTable}`
        );

        if (changedRows.length > 0 || unseenRows.length > 0) {
          refreshFtsRowsFromDocuments(db, changedRows, unseenRows);
        }

        db.prepare(`
          INSERT OR REPLACE INTO store_config(key, value)
          VALUES ('fts_cjk_normalized_version', ?)
        `).run(FTS_CJK_NORMALIZED_VERSION);
      }
      db.exec(`COMMIT`);
    } catch (err) {
      db.exec(`ROLLBACK`);
      throw err;
    }
  } finally {
    dropTableIfExists(db, rebuildTable);
    dropTableIfExists(db, snapshotTable);
  }
}

function initializeDatabase(db: Database): void {
  try {
    loadSqliteVec(db);
    verifySqliteVecLoaded(db);
    _sqliteVecAvailable = true;
    _sqliteVecUnavailableReason = null;
  } catch (err) {
    // sqlite-vec is optional — vector search won't work but FTS is fine
    _sqliteVecAvailable = false;
    _sqliteVecUnavailableReason = getErrorMessage(err);
    console.warn(_sqliteVecUnavailableReason);
  }
  db.exec("PRAGMA foreign_keys = ON");

  // Drop legacy tables that are now managed in YAML
  db.exec(`DROP TABLE IF EXISTS path_contexts`);
  db.exec(`DROP TABLE IF EXISTS collections`);

  // Content-addressable storage - the source of truth for document content
  db.exec(`
    CREATE TABLE IF NOT EXISTS content (
      hash TEXT PRIMARY KEY,
      doc TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Documents table - file system layer mapping virtual paths to content hashes
  // Collections are now managed in ~/.config/qmd/index.yml
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (hash) REFERENCES content(hash) ON DELETE CASCADE,
      UNIQUE(collection, path)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection, active)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(hash)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path, active)`);

  // Cache table for LLM API calls
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_cache (
      hash TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Content vectors. Avoid PRAGMA schema probes during startup; legacy vector
  // columns are repaired lazily when a vector/embedding query first needs them.
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_vectors (
      hash TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      pos INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL,
      embed_fingerprint TEXT NOT NULL DEFAULT '',
      total_chunks INTEGER NOT NULL DEFAULT 1,
      embedded_at TEXT NOT NULL,
      PRIMARY KEY (hash, seq)
    )
  `);

  ensureContentVectorsStatusIndex(db);
  createVectorMetadataTables(db);

  // Document metadata — extraction state plus normalized value rows for
  // metadata filtering. Keyed by document identity, not content hash.
  initializeMetadataSchema(db);
  initializeProcessorSchema(db);

  // Store collections — makes the DB self-contained (no external config needed)
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_collections (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      pattern TEXT NOT NULL DEFAULT '**/*.md',
      ignore_patterns TEXT,
      include_by_default INTEGER DEFAULT 1,
      update_command TEXT,
      context TEXT
    )
  `);

  // Store config — key-value metadata (e.g. config_hash for sync optimization)
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // File sync state — mtime+size fast-path.
  // Inspired by qmd-py incremental sync.
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_sync_state (
      collection    TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      mtime_ms      INTEGER NOT NULL,
      size          INTEGER NOT NULL,
      content_hash  TEXT NOT NULL,
      document_id   INTEGER NOT NULL,
      PRIMARY KEY (collection, relative_path)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_file_sync_state_collection ON file_sync_state(collection)`);

  // FTS - index filepath (collection/path), title, and content.
  // Do not CREATE VIRTUAL TABLE here as an autocommit statement: FTS5
  // IF NOT EXISTS races under WAL (see createDocumentsFtsTable).
  ensureDocumentsFtsSchema(db);
  rewindKoSchemaStamp(db);
  runStoreMigrations(db, {
    installFtsSyncTriggers,
    sqliteVecAvailable: _sqliteVecAvailable === true,
    onProgress: vectorMigrationReporter(),
  });
  applyKoFtsSyncTriggers(db);

  rebuildFTSForCjkNormalization(db);
}

// =============================================================================
// Store Collections — DB accessor functions
// =============================================================================

type StoreCollectionRow = {
  name: string;
  path: string;
  pattern: string;
  ignore_patterns: string | null;
  include_by_default: number;
  update_command: string | null;
  context: string | null;
};

function rowToNamedCollection(row: StoreCollectionRow, db: Database): NamedCollection {
  const spec = db.prepare("SELECT spec FROM processor_specs WHERE collection = ?").get(row.name) as { spec: string } | undefined;
  return {
    name: row.name,
    ...(spec ? { processor: copyCommandProcessorSpec(JSON.parse(spec.spec)) } : {}),
    path: row.path,
    pattern: row.pattern,
    ...(row.ignore_patterns ? { ignore: JSON.parse(row.ignore_patterns) as string[] } : {}),
    ...(row.include_by_default === 0 ? { includeByDefault: false } : {}),
    ...(row.update_command ? { update: row.update_command } : {}),
    ...(row.context ? { context: JSON.parse(row.context) as ContextMap } : {}),
  };
}

export function getStoreCollections(db: Database): NamedCollection[] {
  const rows = db.prepare(`SELECT * FROM store_collections`).all() as StoreCollectionRow[];
  return rows.map(row => rowToNamedCollection(row, db));
}

export function getStoreCollection(db: Database, name: string): NamedCollection | null {
  const row = db.prepare(`SELECT * FROM store_collections WHERE name = ?`).get(name) as StoreCollectionRow | null | undefined;
  if (row == null) return null;
  return rowToNamedCollection(row, db);
}

export function getStoreGlobalContext(db: Database): string | undefined {
  const row = db.prepare(`SELECT value FROM store_config WHERE key = 'global_context'`).get() as { value: string } | null | undefined;
  if (row == null) return undefined;
  return row.value || undefined;
}

export function getStoreContexts(db: Database): Array<{ collection: string; path: string; context: string }> {
  const results: Array<{ collection: string; path: string; context: string }> = [];

  // Global context
  const globalCtx = getStoreGlobalContext(db);
  if (globalCtx) {
    results.push({ collection: "*", path: "/", context: globalCtx });
  }

  // Collection contexts
  const rows = db.prepare(`SELECT name, context FROM store_collections WHERE context IS NOT NULL`).all() as { name: string; context: string }[];
  for (const row of rows) {
    const ctxMap = JSON.parse(row.context) as ContextMap;
    for (const [path, context] of Object.entries(ctxMap)) {
      results.push({ collection: row.name, path, context });
    }
  }

  return results;
}

export function upsertStoreCollection(db: Database, name: string, collection: Omit<Collection, 'pattern'> & { pattern?: string }): void {
  const spec = collection.processor === undefined ? undefined : copyCommandProcessorSpec(collection.processor);
  if (spec) {
    db.prepare(`INSERT INTO processor_specs(collection, spec) VALUES (?, ?)
      ON CONFLICT(collection) DO UPDATE SET spec = excluded.spec`).run(name, JSON.stringify(spec));
  } else db.prepare("DELETE FROM processor_specs WHERE collection = ?").run(name);
  db.prepare(`
    INSERT INTO store_collections (name, path, pattern, ignore_patterns, include_by_default, update_command, context)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      path = excluded.path,
      pattern = excluded.pattern,
      ignore_patterns = excluded.ignore_patterns,
      include_by_default = excluded.include_by_default,
      update_command = excluded.update_command,
      context = excluded.context
  `).run(
    name,
    collection.path,
    collection.pattern || '**/*.md',
    collection.ignore ? JSON.stringify(collection.ignore) : null,
    collection.includeByDefault === false ? 0 : 1,
    collection.update || null,
    collection.context ? JSON.stringify(collection.context) : null,
  );
}

export function deleteStoreCollection(db: Database, name: string): boolean {
  const result = db.prepare(`DELETE FROM store_collections WHERE name = ?`).run(name);
  return result.changes > 0;
}

export function renameStoreCollection(db: Database, oldName: string, newName: string): boolean {
  // Check target doesn't exist
  const existing = db.prepare(`SELECT name FROM store_collections WHERE name = ?`).get(newName) as { name: string } | null | undefined;
  if (existing != null) {
    throw new Error(`Collection '${newName}' already exists`);
  }

  const result = db.prepare(`UPDATE store_collections SET name = ? WHERE name = ?`).run(newName, oldName);
  return result.changes > 0;
}

export function updateStoreContext(db: Database, collectionName: string, path: string, text: string): boolean {
  const row = db.prepare(`SELECT context FROM store_collections WHERE name = ?`).get(collectionName) as { context: string | null } | null | undefined;
  if (row == null) return false;

  const ctxMap: ContextMap = row.context ? JSON.parse(row.context) : {};
  ctxMap[path] = text;
  db.prepare(`UPDATE store_collections SET context = ? WHERE name = ?`).run(JSON.stringify(ctxMap), collectionName);
  return true;
}

export function removeStoreContext(db: Database, collectionName: string, path: string): boolean {
  const row = db.prepare(`SELECT context FROM store_collections WHERE name = ?`).get(collectionName) as { context: string | null } | null | undefined;
  if (row == null) return false;
  if (!row.context) return false;

  const ctxMap: ContextMap = JSON.parse(row.context);
  if (!(path in ctxMap)) return false;

  delete ctxMap[path];
  const newCtx = Object.keys(ctxMap).length > 0 ? JSON.stringify(ctxMap) : null;
  db.prepare(`UPDATE store_collections SET context = ? WHERE name = ?`).run(newCtx, collectionName);
  return true;
}

export function setStoreGlobalContext(db: Database, value: string | undefined): void {
  if (value === undefined) {
    db.prepare(`DELETE FROM store_config WHERE key = 'global_context'`).run();
  } else {
    db.prepare(`INSERT INTO store_config (key, value) VALUES ('global_context', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(value);
  }
}

/**
 * Clear the stored config hash so the next sync re-derives `store_collections`
 * from the configuration instead of trusting a hash that was stamped before a
 * direct database write. Every mirror of a configuration mutation uses it: the
 * rows and the hash must not certify different documents.
 */
export function invalidateConfigHash(db: Database): void {
  db.prepare(`DELETE FROM store_config WHERE key = 'config_hash'`).run();
}

/**
 * Sync external config (YAML/inline) into SQLite store_collections.
 * External config always wins. Skips sync if config hash hasn't changed.
 *
 * The whole mirror is one immediate transaction, so a reader never observes a
 * half-applied config and the hash commits with the rows it certifies. Callers
 * that read the config from a file must read it under the file's lock and call
 * this while still holding it — see `CollectionConfigScope.withLockedConfig` —
 * otherwise a mutation another process published between the read and this
 * call is deleted from `store_collections` and the stale hash is stamped over
 * it. Cross-resource atomicity is not claimed: a crash between the file
 * publish and this commit leaves the database behind the file, and the
 * `config_hash` mismatch makes the next sync repair it.
 */
export function syncConfigToDb(db: Database, config: CollectionConfig): void {
  // Config sync is also used on externally seeded databases before Store opens.
  initializeProcessorSchema(db);
  const configJson = JSON.stringify(config);
  const hash = createHash('sha256').update(configJson).digest('hex');

  const apply = (): void => {
    // Check config hash — skip sync if unchanged
    const existingHash = db.prepare(`SELECT value FROM store_config WHERE key = 'config_hash'`).get() as { value: string } | null | undefined;
    if (existingHash != null && existingHash.value === hash) {
      return; // Config unchanged, skip sync
    }

    // Sync collections
    const configNames = new Set(Object.keys(config.collections));

    for (const [name, coll] of Object.entries(config.collections)) {
      upsertStoreCollection(db, name, coll);
    }

    // Delete collections not in config
    const dbCollections = db.prepare(`SELECT name FROM store_collections`).all() as { name: string }[];
    for (const row of dbCollections) {
      if (!configNames.has(row.name)) {
        db.prepare(`DELETE FROM store_collections WHERE name = ?`).run(row.name);
      }
    }

    // Sync global context
    if (config.global_context !== undefined) {
      setStoreGlobalContext(db, config.global_context);
    } else {
      setStoreGlobalContext(db, undefined);
    }

    // Save config hash last: a crash before it leaves the rows uncertified.
    db.prepare(`INSERT INTO store_config (key, value) VALUES ('config_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(hash);
  };

  // Already inside a caller's transaction: join it instead of opening one.
  if (db.inTransaction) apply();
  else db.transaction(apply).immediate();
}


export function isSqliteVecAvailable(): boolean {
  return _sqliteVecAvailable === true;
}

/**
 * Drop the vec0 table and empty its rowid map in one commit. vector_rows ids
 * are reused once the map is empty, so a map emptied without the drop hands
 * new rows rowids that surviving vec0 rows still hold, and every later insert
 * fails on the vec0 primary key.
 */
function dropVectorIndex(db: Database): void {
  db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS ${VEC_TABLE}`);
    db.exec(`DELETE FROM ${VEC_ROWS_TABLE}`);
  }).immediate();
}

function ensureVecTableInternal(db: Database, dimensions: number): void {
  if (!_sqliteVecAvailable) {
    throw createSqliteVecUnavailableError(
      _sqliteVecUnavailableReason ?? "vector operations require a SQLite build with extension loading support"
    );
  }
  let layout = vecLayout(db);
  if (layout.kind === "legacy") {
    migrateVectorLayout(db, { sqliteVecAvailable: true, onProgress: vectorMigrationReporter() });
    layout = vecLayout(db);
  }
  if (layout.kind === "partitioned") {
    if (layout.dimensions === dimensions) return;
    if (layout.dimensions !== null) {
      throw new Error(
        `Embedding dimension mismatch: existing vectors are ${layout.dimensions}d but the current model produces ${dimensions}d. ` +
        `Run 'qmd embed -f' to re-embed with the new model.`
      );
    }
    dropVectorIndex(db);
  }
  createPartitionedVecTable(db, dimensions);
}

// =============================================================================
// Store Factory
// =============================================================================

export type Store = {
  db: Database;
  dbPath: string;
  /** Optional LlamaCpp instance for this store (overrides the global singleton) */
  llm?: LlamaCpp;
  close: () => void;
  ensureVecTable: (dimensions: number) => void;

  // Index health
  getHashesNeedingEmbedding: (model?: string) => number;
  getIndexHealth: (model?: string) => IndexHealthInfo;
  getStatus: (model?: string) => IndexStatus;
  getStatusSummary: (model?: string) => IndexStatusSummary;

  // Caching
  getCacheKey: typeof getCacheKey;
  getCachedResult: (cacheKey: string) => string | null;
  setCachedResult: (cacheKey: string, result: string) => void;
  clearCache: () => void;

  // Cleanup and maintenance
  deleteLLMCache: () => number;
  deleteInactiveDocuments: () => number;
  cleanupOrphanedContent: () => number;
  cleanupOrphanedVectors: () => number;
  vacuumDatabase: () => void;

  // Context
  getContextForFile: (filepath: string) => string | null;
  getContextForPath: (collectionName: string, path: string) => string | null;
  getCollectionByName: (name: string) => { name: string; pwd: string; glob_pattern: string } | null;
  getCollectionsWithoutContext: () => { name: string; pwd: string; doc_count: number }[];
  getTopLevelPathsWithoutContext: (collectionName: string) => string[];

  // Virtual paths
  parseVirtualPath: typeof parseVirtualPath;
  buildVirtualPath: typeof buildVirtualPath;
  isVirtualPath: typeof isVirtualPath;
  resolveVirtualPath: (virtualPath: string) => string | null;
  toVirtualPath: (absolutePath: string) => string | null;

  // Search
  searchFTS: (query: string, limit?: number, collectionName?: string | readonly string[], filter?: MetadataFilter, scope?: DocumentFilter, onScanCapped?: () => void) => SearchResult[];
  searchVec: (query: string, model: string, limit?: number, collectionName?: string | readonly string[], session?: ILLMSession, precomputedEmbedding?: number[], filter?: MetadataFilter, scope?: DocumentFilter) => Promise<SearchResult[]>;

  // Query expansion & reranking
  /** `onModelReady` fires once the generation model is loaded (not at all on a cache hit). */
  expandQuery: (query: string, model?: string, options?: { onModelReady?: () => void }) => Promise<ExpandedQuery[]>;
  /** Drop the cached expansion for a query so the next call regenerates. */
  invalidateExpansionCache: (query: string) => void;
  rerank: (query: string, documents: { file: string; text: string }[], model?: string, intent?: string, options?: StoreRerankOptions) => Promise<{ file: string; score: number }[]>;

  // Document retrieval
  findDocument: (filename: string, options?: { includeBody?: boolean }) => DocumentResult | DocumentLookupError;
  getDocumentBody: (doc: DocumentResult | { filepath: string }, fromLine?: number, maxLines?: number) => string | null;
  findDocuments: (pattern: string, options?: { includeBody?: boolean; maxBytes?: number }) => { docs: MultiGetResult[]; errors: string[] };

  // Fuzzy matching and docid lookup
  findSimilarFiles: (query: string, maxDistance?: number, limit?: number) => string[];
  matchFilesByGlob: (pattern: string) => { filepath: string; displayPath: string; bodyLength: number }[];
  findDocumentByDocid: (docid: string) => { filepath: string; hash: string } | null;

  // Document indexing operations
  insertContent: (hash: string, content: string, createdAt: string) => void;
  insertDocument: (collectionName: string, path: string, title: string, hash: string, createdAt: string, modifiedAt: string) => number;
  findActiveDocument: (collectionName: string, path: string) => { id: number; hash: string; title: string } | null;
  findOrMigrateLegacyDocument: (collectionName: string, path: string) => { id: number; hash: string; title: string } | null;
  updateDocumentTitle: (documentId: number, title: string, modifiedAt: string) => void;
  updateDocument: (documentId: number, title: string, hash: string, modifiedAt: string) => void;
  deactivateDocument: (collectionName: string, path: string) => void;
  getActiveDocumentPaths: (collectionName: string) => string[];

  // Vector/embedding operations
  getHashesForEmbedding: () => { hash: string; body: string; path: string }[];
  clearAllEmbeddings: () => void;
  insertEmbedding: (hash: string, seq: number, pos: number, embedding: Float32Array, model: string, embeddedAt: string, totalChunks?: number, fingerprint?: string) => void;
};

// =============================================================================
// Reindex & Embed — pure-logic functions for SDK and CLI
// =============================================================================

function fsErrorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "ERROR";
}

export type ReindexProgress = {
  file: string;
  current: number;
  total: number;
};

export type ReindexSkippedFile = {
  file: string;
  code: string;
};

export type ReindexResult = {
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
  orphanedCleaned: number;
  skipped: number;
  skippedFiles: ReindexSkippedFile[];
  /** Documents whose qmd.metadata frontmatter failed extraction this pass. */
  metadataErrors: number;
};

/**
 * The files a collection is made of, relative to its root: the glob, minus dependency and
 * build directories, minus the collection's own ignore patterns, minus anything hidden.
 * One definition, because the daemon's refresh has to see exactly the set that
 * reindexCollection indexes or it would decide staleness about different files.
 */
export async function listCollectionFiles(
  collectionPath: string,
  globPattern: string,
  ignorePatterns?: string[],
): Promise<string[]> {
  const excludeDirs = ["node_modules", ".git", ".cache", "vendor", "dist", "build"];
  const allIgnore = [
    ...excludeDirs.map(d => `**/${d}/**`),
    ...(ignorePatterns || []),
  ];
  const allFiles: string[] = await fastGlob(splitGlobMask(globPattern), {
    cwd: collectionPath,
    onlyFiles: true,
    followSymbolicLinks: false,
    dot: false,
    ignore: allIgnore,
  });
  // Filter hidden files/folders
  return allFiles.filter(file => {
    const parts = file.split("/");
    return !parts.some(part => part.startsWith("."));
  });
}

/**
 * File sync state row — mtime+size fast-path cache.
 * Inspired by qmd-py incremental sync.
 */
type FileSyncStateRow = {
  relative_path: string;
  mtime_ms: number;
  size: number;
  content_hash: string;
  document_id: number;
  /** 1 when the document has a metadata extraction at the current version. */
  metadata_current: number;
};

function getFileSyncStateMap(db: Database, collectionName: string): Map<string, FileSyncStateRow> {
  try {
    // A row is trusted only while its document is still the active row for
    // this collection, path and content. Removing a collection, or renaming it
    // away, leaves rows behind; trusting those would count a file that has no
    // active document as unchanged. A distrusted row is rewritten on reindex.
    const stmt = db.prepare(`
      SELECT s.relative_path, s.mtime_ms, s.size, s.content_hash, s.document_id,
        COALESCE(dm.extraction_version = ?, 0) AS metadata_current
      FROM file_sync_state s
      JOIN documents d ON d.id = s.document_id
      LEFT JOIN document_metadata dm ON dm.document_id = s.document_id
      WHERE s.collection = ?
        AND d.active = 1
        AND d.collection = s.collection
        AND d.path = s.relative_path
        AND d.hash = s.content_hash
    `);
    const map = new Map<string, FileSyncStateRow>();
    // Large-result query: use iterate() to stream rows instead of .all() materializing at once
    for (const r of stmt.iterate(METADATA_EXTRACTION_VERSION, collectionName) as IterableIterator<FileSyncStateRow>) {
      map.set(r.relative_path, r);
    }
    return map;
  } catch {
    // Table may not exist yet on legacy DBs — initializeDatabase creates it on next open,
    // but guard here for safety.
    return new Map();
  }
}

function upsertFileSyncState(db: Database, collectionName: string, relPath: string, mtimeMs: number, size: number, contentHash: string, documentId: number): void {
  try {
    db.prepare(`
      INSERT INTO file_sync_state(collection, relative_path, mtime_ms, size, content_hash, document_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(collection, relative_path) DO UPDATE SET
        mtime_ms = excluded.mtime_ms,
        size = excluded.size,
        content_hash = excluded.content_hash,
        document_id = excluded.document_id
    `).run(collectionName, relPath, Math.floor(mtimeMs), size, contentHash, documentId);
  } catch {
    // Legacy DB without table — will be created on next open; skip caching this run
  }
}

function deleteFileSyncStateForCollection(db: Database, collectionName: string, relPath: string): void {
  try {
    db.prepare(`DELETE FROM file_sync_state WHERE collection = ? AND relative_path = ?`).run(collectionName, relPath);
  } catch {}
}

/**
 * A file modified within this long of the stat that read it gets its sync row
 * stored with UNTRUSTED_SYNC_MTIME, which the fast path never matches. On a
 * filesystem whose mtime granule is 1-2 s (HFS+, FAT, some network mounts), a
 * same-size rewrite in that window would keep both mtime and size, and the
 * fast path would skip it for good. The next update reads such a file once
 * more and trusts it once its mtime is older: git's "racily clean" rule.
 */
const RACY_SYNC_WINDOW_MS = 2000;
const UNTRUSTED_SYNC_MTIME = -1;

/**
 * Maximum file size to index — prevents OOM on accidental binary inclusion.
 */
export const REINDEX_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Deactivate a previously indexed file that can no longer be indexed (it
 * became empty or grew past REINDEX_MAX_FILE_SIZE) and drop its sync row, so
 * its old content stops being searchable.
 */
function retireIndexedFile(
  db: Database,
  collectionName: string,
  path: string,
  livePaths: ReadonlySet<string>,
  syncStateMap: Map<string, FileSyncStateRow>,
): void {
  if (!findOrMigrateLegacyDocument(db, collectionName, path, livePaths)) return;
  deactivateDocument(db, collectionName, path);
  deleteFileSyncStateForCollection(db, collectionName, path);
  syncStateMap.delete(path);
}

/**
 * Lifecycle of the write transaction a scan batch owns:
 *
 *   idle --next()--> open --commit()/rollback()--> idle
 *
 * `commit()` returns the batch to `idle` instead of closing it, so callers can
 * release the transaction between files (and must, before awaiting).
 *
 * One SQLite connection holds at most one transaction, and three guards follow
 * from that: `next()` refuses to begin while `db.inTransaction` (which covers
 * every writer on the connection, batched or not); the registry below
 * identifies the batch that owns the open transaction, so a second batch can
 * never commit or roll back somebody else's rows; and `next()` re-checks the
 * lease every file, so a transaction that user code (`onProgress`, a processor)
 * ended fails the scan instead of degrading it to one autocommit per file.
 *
 * Writers that bypass `scanWriteBatch` (`db.transaction(...)`, a bare
 * `insertEmbedding`, …) are not tracked here. Isolation from them rests on the
 * rule above: an open batch transaction never spans an `await`, so every other
 * writer runs in a task where no batch transaction is open. Synchronous SQL run
 * by a callback the scan itself invokes joins the batch by design.
 */
type WriteBatchPhase = "idle" | "open";

const writeBatchOwners = new WeakMap<Database, symbol>();

/**
 * Groups the per-file writes of a collection scan into short transactions.
 * Committed one by one, a first index of a large collection writes a content
 * row, a document, its metadata and a sync row per file, each its own WAL
 * commit: 20,000 files took about 176 s that way. A batch closes after
 * `maxFiles` files or `maxMs`, so other writers never wait longer than that.
 *
 * An open transaction must never outlive the synchronous stretch that opened
 * it: while the batch is suspended on an `await`, any other writer's statements
 * would execute inside this transaction. `commit()` before awaiting.
 */
export function scanWriteBatch(db: Database, maxFiles: number = 500, maxMs: number = 250) {
  const token = Symbol("scanWriteBatch");
  let phase: WriteBatchPhase = "idle";
  let files = 0;
  let startedAt = 0;

  const assertOwnsOpenTransaction = (action: string): void => {
    const owner = writeBatchOwners.get(db);
    if (owner === token) return;
    throw new Error(
      owner
        ? `scanWriteBatch: cannot ${action} — another write batch owns this connection's transaction; serialize writers that share one store`
        : `scanWriteBatch: cannot ${action} — this batch's transaction was closed outside the batch`
    );
  };

  const openTransaction = (): void => {
    if (db.inTransaction) {
      throw new Error(
        "scanWriteBatch: cannot BEGIN — the connection already has an open transaction; " +
          "serialize writers that share one store instead of interleaving their scans"
      );
    }
    if (writeBatchOwners.has(db)) {
      // An owner with no transaction holds nothing: it was committed or rolled
      // back outside its batch. Reclaim the connection instead of failing every
      // later scan on it.
      writeBatchOwners.delete(db);
    }
    db.exec("BEGIN");
    writeBatchOwners.set(db, token);
    phase = "open";
    files = 0;
    startedAt = Date.now();
  };

  const closeTransaction = (statement: "COMMIT" | "ROLLBACK"): void => {
    assertOwnsOpenTransaction(statement === "COMMIT" ? "commit" : "roll back");
    if (!db.inTransaction) {
      // The transaction went away behind the batch's back. Reporting a commit
      // here would claim writes that no longer exist, so it fails; a rollback
      // has nothing left to undo.
      writeBatchOwners.delete(db);
      phase = "idle";
      if (statement === "COMMIT") {
        throw new Error("scanWriteBatch: cannot commit — this batch's transaction was closed outside the batch");
      }
      return;
    }
    db.exec(statement);
    writeBatchOwners.delete(db);
    phase = "idle";
  };

  return {
    /** Call before a file's writes; closes the batch when it is full or old. */
    next(): void {
      if (phase === "open") {
        if (!db.inTransaction) {
          // User code that runs inside the batch - a progress callback, a
          // processor - or anything else on the connection ended the
          // transaction. Writing on would autocommit every file, so fail here
          // with the cause instead of losing atomicity silently.
          writeBatchOwners.delete(db);
          phase = "idle";
          throw new Error("scanWriteBatch: the batch's transaction was closed while the batch was open");
        }
        if (files < maxFiles && Date.now() - startedAt < maxMs) {
          files++;
          return;
        }
        closeTransaction("COMMIT");
      }
      openTransaction();
      files = 1;
    },
    commit(): void {
      if (phase === "idle") return;
      closeTransaction("COMMIT");
    },
    rollback(): void {
      if (phase === "idle") return;
      closeTransaction("ROLLBACK");
    },
  };
}

/**
 * `reindexCollection` is async (globbing, processors) while a store owns a
 * single connection whose scan batch cannot be shared: two overlapping calls
 * would nest `BEGIN` (which throws) and either call's `ROLLBACK` could discard
 * files the other had already written. Reindexes on one connection are queued
 * FIFO instead, so each one still commits only its own batch.
 */
const reindexQueues = new WeakMap<Database, Promise<void>>();

/**
 * The connection whose scan is currently driving an in-process processor.
 * `AsyncLocalStorage` confines it to that processor's own promise chain, so an
 * independent caller - another collection's update, an MCP request - does not
 * inherit it and is queued by `withExclusiveReindex` instead of being mistaken
 * for a nested call. Only a scan started from inside the processor is rejected,
 * because it would wait on the slot its own caller holds.
 */
const processorCallContext = new AsyncLocalStorage<Database>();

async function withExclusiveReindex<T>(db: Database, run: () => Promise<T>): Promise<T> {
  if (processorCallContext.getStore() === db) {
    throw new Error(
      "reindexCollection: cannot start a scan from inside a processor of the scan that is running on this store"
    );
  }
  const predecessor = reindexQueues.get(db) ?? Promise.resolve();
  // Resolve-only: a failing reindex must not reject the wait of its successor.
  const released = Promise.withResolvers<void>();
  const tail = predecessor.then(() => released.promise);
  reindexQueues.set(db, tail);
  try {
    await predecessor;
    return await run();
  } finally {
    released.resolve();
    if (reindexQueues.get(db) === tail) reindexQueues.delete(db);
  }
}

/**
 * Re-index a single collection by scanning the filesystem and updating the database.
 * Uses mtime+size fast-path (file_sync_state) to avoid re-reading unchanged files.
 * Pure function — no console output, no db lifecycle management.
 *
 * Fast-path: stat mtime_ms+size against cached row to skip file read.
 * If mtime changed but content hash identical, only mtime cache is updated.
 * Skips >10MB and empty files, cleans sync table entry on orphan removal.
 */
export async function reindexCollection(
  store: Store,
  collectionPath: string,
  globPattern: string,
  collectionName: string,
  options?: {
    ignorePatterns?: string[];
    processor?: DocumentProcessor;
    signal?: AbortSignal;
    /**
     * Called synchronously from inside the scan's write-batch transaction.
     * Statements it runs join that transaction by design (they commit or roll
     * back with the scan), so it must not commit or roll it back, and it must
     * not start another scan of this store. It must return synchronously: work
     * it defers can land in a later batch's transaction.
     */
    onProgress?: (info: ReindexProgress) => void;
  }
): Promise<ReindexResult> {
  const processor = options?.processor ? snapshotProcessor(options.processor) : undefined;
  requireProcessor(store.db, collectionName, !!getStoreCollection(store.db, collectionName)?.processor, processor);
  return withExclusiveReindex(store.db, async () => {
    const batch = scanWriteBatch(store.db);
    try {
      const result = await reindexCollectionIn(batch, store, collectionPath, globPattern, collectionName, processor ? { ...options, processor } : options);
      batch.commit();
      return result;
    } catch (err) {
      try {
        batch.rollback();
      } catch (rollbackError) {
        // A batch that no longer owns the transaction cannot undo its own
        // writes; report both failures instead of hiding the original one.
        throw new AggregateError([err, rollbackError], "reindexCollection failed and its write batch could not be rolled back");
      }
      throw err;
    }
  });
}

async function reindexCollectionIn(
  batch: ReturnType<typeof scanWriteBatch>,
  store: Store,
  collectionPath: string,
  globPattern: string,
  collectionName: string,
  options?: {
    ignorePatterns?: string[];
    processor?: DocumentProcessor;
    signal?: AbortSignal;
    onProgress?: (info: ReindexProgress) => void;
  }
): Promise<ReindexResult> {
  const db = store.db;
  const now = new Date().toISOString();
  // A missing root (unmounted drive, offline share, deleted folder) globs to
  // an empty list, which the deactivation pass below would read as "every
  // file was deleted". Leave the index alone and report the root instead.
  let rootIsDirectory = false;
  try {
    rootIsDirectory = statSync(collectionPath).isDirectory();
  } catch (error) {
    const code = fsErrorCode(error);
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  if (!rootIsDirectory) {
    return {
      indexed: 0, updated: 0, unchanged: 0, removed: 0, orphanedCleaned: 0,
      skipped: 1,
      skippedFiles: [{ file: collectionPath, code: "ROOT_MISSING" }],
      metadataErrors: 0,
    };
  }
  const files = await listCollectionFiles(collectionPath, globPattern, options?.ignorePatterns);

  if (options?.processor) {
    // A processor is arbitrary in-process code. A scan it starts on this store
    // would wait for the slot this one holds, so it is rejected - but only that
    // processor's own call chain carries the context; independent callers queue.
    const processor = options.processor;
    return await processorCallContext.run(db, () =>
      reindexProcessedFiles(db, batch, collectionPath, collectionName, files.map(normalizePathSeparators), processor, options)
    );
  }

  const total = files.length;
  let indexed = 0, updated = 0, unchanged = 0, processed = 0, metadataErrors = 0;
  const skippedFiles: ReindexSkippedFile[] = [];
  const seenPaths = new Set<string>();
  const livePaths = new Set(files.map(f => normalizePathSeparators(f)));

  // Load file_sync_state for this collection (mtime+size fast-path)
  const syncStateMap = getFileSyncStateMap(db, collectionName);

  for (const relativeFile of files) {
    batch.next();
    const path = normalizePathSeparators(relativeFile);
    const filepath = getRealPath(resolve(collectionPath, relativeFile));
    if (!isPathInsideDir(collectionPath, filepath)) {
      processed++;
      skippedFiles.push({ file: relativeFile, code: "OUTSIDE_COLLECTION" });
      options?.onProgress?.({ file: relativeFile, current: processed, total });
      continue;
    }
    seenPaths.add(path);

    // Stat first — mtime+size fast-path (no read)
    let stat: ReturnType<typeof statSync> | null = null;
    const statTimeMs = Date.now();
    try {
      stat = statSync(filepath);
    } catch (err) {
      processed++;
      skippedFiles.push({ file: relativeFile, code: fsErrorCode(err) });
      options?.onProgress?.({ file: relativeFile, current: processed, total });
      continue;
    }

    if (!stat) {
      processed++;
      options?.onProgress?.({ file: relativeFile, current: processed, total });
      continue;
    }

    const mtimeMs = stat.mtimeMs;
    const size = stat.size;
    const syncMtimeMs = statTimeMs - mtimeMs < RACY_SYNC_WINDOW_MS ? UNTRUSTED_SYNC_MTIME : mtimeMs;

    // Skip large files (>10MB) — prevents OOM
    if (size > REINDEX_MAX_FILE_SIZE) {
      retireIndexedFile(db, collectionName, path, livePaths, syncStateMap);
      processed++;
      skippedFiles.push({ file: relativeFile, code: "FILE_TOO_LARGE" });
      options?.onProgress?.({ file: relativeFile, current: processed, total });
      continue;
    }

    // Fast-path: stat matches cached sync state — skip read entirely
    const cached = syncStateMap.get(path);
    // Missing or stale metadata (an index from before the metadata schema, or
    // an extraction-version bump) needs the content, so such a file is read and
    // re-extracted through the hash-match branch below.
    if (cached && cached.mtime_ms === Math.floor(mtimeMs) && cached.size === size && cached.metadata_current) {
      unchanged++;
      processed++;
      options?.onProgress?.({ file: relativeFile, current: processed, total });
      // Still need to ensure document exists (might have been deactivated externally)
      // But we count as unchanged and avoid expensive read+hash+metadata sync.
      // Note: metadata sync for unchanged is skipped in fast-path; if needed, disable fast-path or force re-read.
      continue;
    }

    // Need to read file
    let content: string;
    try {
      content = readFileSync(filepath, "utf-8");
    } catch (err) {
      processed++;
      skippedFiles.push({ file: relativeFile, code: fsErrorCode(err) });
      options?.onProgress?.({ file: relativeFile, current: processed, total });
      continue;
    }

    if (!content.trim()) {
      // An emptied file has no indexable content: unmark it seen so the
      // not-seen pass below deactivates it exactly like a removed file.
      // (Unreadable files above stay seen — a transient read error must not
      // wipe the row; empty content is a confirmed state, not an error.)
      seenPaths.delete(path);
      processed++;
      options?.onProgress?.({ file: relativeFile, current: processed, total });
      continue;
    }

    // Synchronous on purpose: hashing is CPU work, and awaiting it here would
    // suspend the scan with this batch's transaction open, letting a concurrent
    // writer (a second scan, an embedding batch) collide with or join it.
    const hash = hashContentSync(content);

    // Hash matches cached sync state but mtime differed (clock skew, backup restore) — only update mtime cache
    if (cached && cached.content_hash === hash) {
      // Update sync state mtime/size only
      upsertFileSyncState(db, collectionName, path, syncMtimeMs, size, hash, cached.document_id);
      unchanged++;
      processed++;
      // Keep content in memory for metadata sync if needed? For speed, skip metadata sync on hash-match fast-path.
      // Existing behavior for hash-same was to still do metadata backfill; we preserve it by loading documentId from cache.
      // However we already have content here, so do metadata backfill for hash-match case.
      const existingForMeta = findOrMigrateLegacyDocument(db, collectionName, path, livePaths);
      if (existingForMeta) {
        const extraction = syncDocumentMetadata(db, existingForMeta.id, content, path, { onlyIfStale: true });
        if (extraction?.error) metadataErrors++;
      }
      options?.onProgress?.({ file: relativeFile, current: processed, total });
      continue;
    }

    const title = extractTitle(content, relativeFile);
    const existing = findOrMigrateLegacyDocument(db, collectionName, path, livePaths);

    let documentId: number;
    let contentChanged = true;

    if (existing) {
      documentId = existing.id;
      if (existing.hash === hash) {
        contentChanged = false;
        if (existing.title !== title) {
          updateDocumentTitle(db, existing.id, title, now);
          updated++;
        } else {
          unchanged++;
        }
      } else {
        insertContent(db, hash, content, now);
        updateDocument(db, existing.id, title, hash, new Date(stat.mtime).toISOString());
        updated++;
      }
    } else {
      insertContent(db, hash, content, now);
      documentId = insertDocument(db, collectionName, path, title, hash,
        stat ? new Date(stat.birthtime).toISOString() : now,
        new Date(stat.mtime).toISOString());
      indexed++;
    }

    // Upsert sync state after successful indexing
    upsertFileSyncState(db, collectionName, path, syncMtimeMs, size, hash, documentId);

    // Metadata extraction
    const extraction = syncDocumentMetadata(db, documentId, content, path,
      contentChanged ? undefined : { onlyIfStale: true });
    if (extraction?.error) metadataErrors++;

    processed++;
    options?.onProgress?.({ file: relativeFile, current: processed, total });
  }

  // Deactivate documents that no longer exist + cleanup sync_state
  const allActive = getActiveDocumentPaths(db, collectionName);
  let removed = 0;
  for (const path of allActive) {
    if (!seenPaths.has(path)) {
      batch.next();
      deactivateDocument(db, collectionName, path);
      deleteFileSyncStateForCollection(db, collectionName, path);
      removed++;
    }
  }

  batch.commit();

  const orphanedCleaned = cleanupOrphanedContent(db);

  return { indexed, updated, unchanged, removed, orphanedCleaned, skipped: skippedFiles.length, skippedFiles, metadataErrors };
}

export type EmbedFailure = {
  path: string;
  hash: string;
  seq: number;
  attempts: number;
  reason: string;
};

export type EmbedProgress = {
  chunksEmbedded: number;
  totalChunks: number;
  bytesProcessed: number;
  totalBytes: number;
  /** Active failed chunks still awaiting a successful retry. */
  errors: number;
  failures?: EmbedFailure[];
};

export type EmbedResult = {
  docsProcessed: number;
  chunksEmbedded: number;
  /** Chunks copied into the partition of a collection that gained an already-embedded hash. */
  chunksCopied: number;
  /** Active failed chunks that did not recover after retries. */
  errors: number;
  failures?: EmbedFailure[];
  durationMs: number;
  /**
   * True when this run found no documents waiting for embeddings, so a caller
   * can report "everything is already embedded" instead of a zero-chunk run.
   *
   * This is answered inside the embed lock on purpose: probing for pending work
   * before taking the lock can see another run's in-flight state, and taking
   * the lock to probe and then taking it again would reintroduce the very
   * double acquisition the lock exists to prevent. Callers that want their
   * "no work" message to be authoritative must use this flag — a zero
   * docsProcessed alone also covers runs whose documents were all empty.
   */
  nothingToDo: boolean;
};

/**
 * Thrown when an embed run cannot start because another run already owns this
 * index's embed lock — another process (CLI, SDK, or a direct
 * generateEmbeddings call), or a run this process already has in flight.
 *
 * Embedding is exclusive per index. Two runs embedding the same hashes
 * interleave their partial-chunk cleanup and their vector publication, so each
 * can delete what the other just completed and the index can be left with
 * chunks no run believes it wrote (#825). Ownership is a sidecar SQLite write
 * transaction next to the index (`cli/embed-lock.ts`), so a crashed holder can
 * never leave the lock stuck.
 *
 * The CLI reports this as "Another embed process is already running.
 * Skipping."; library callers can catch it to back off or ask the user to wait
 * for the running embed to finish.
 */
export class EmbedLockBusyError extends Error {
  /** Sidecar lock path that another run owns. */
  readonly lockPath: string;
  /** Which artifact made this attempt lose (current sidecar or legacy pidfile). */
  readonly reason: EmbedLockBusyReason;

  constructor(lockPath: string, reason: EmbedLockBusyReason) {
    super(
      reason.kind === "legacy"
        ? `Another qmd process (pid ${reason.pid}) is already embedding this index: ${lockPath}`
        : `Another embed run already owns this index: ${lockPath}`
    );
    this.name = "EmbedLockBusyError";
    this.lockPath = lockPath;
    this.reason = reason;
  }
}

export type EmbedOptions = {
  signal?: AbortSignal;
  force?: boolean;
  model?: string;
  /**
   * Restrict embedding to documents in a single collection.
   * When omitted, all pending documents across every collection are embedded.
   */
  collection?: string;
  maxDocsPerBatch?: number;
  maxBatchBytes?: number;
  chunkStrategy?: ChunkStrategy;
  /**
   * Max wall-clock duration for the whole embed session, in milliseconds. When the
   * cap is reached, remaining document batches are skipped (re-run `qmd embed` to
   * continue). A value <= 0 disables the cap. Defaults to
   * {@link DEFAULT_EMBED_MAX_DURATION_MS} (30 minutes).
   */
  maxDurationMs?: number;
  onProgress?: (info: EmbedProgress) => void;
};

type PendingEmbeddingDoc = {
  hash: string;
  path: string;
  bytes: number;
};

type EmbeddingDoc = PendingEmbeddingDoc & {
  body: string;
};

type ChunkItem = {
  hash: string;
  path: string;
  title: string;
  text: string;
  seq: number;
  pos: number;
  tokens: number;
  bytes: number;
  expectedTotalChunks: number;
};

function validatePositiveIntegerOption(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/** Batch sizing validated from EmbedOptions, shared by the embed run. */
type ResolvedEmbedBatchOptions = Required<Pick<EmbedOptions, "maxDocsPerBatch" | "maxBatchBytes">>;

function resolveEmbedOptions(options?: EmbedOptions): ResolvedEmbedBatchOptions {
  return {
    maxDocsPerBatch: validatePositiveIntegerOption("maxDocsPerBatch", options?.maxDocsPerBatch, DEFAULT_EMBED_MAX_DOCS_PER_BATCH),
    maxBatchBytes: validatePositiveIntegerOption("maxBatchBytes", options?.maxBatchBytes, DEFAULT_EMBED_MAX_BATCH_BYTES),
  };
}

const CONTENT_VECTOR_DESIRED_COLUMNS: { name: string; definition: string }[] = [
  { name: "seq", definition: "INTEGER NOT NULL DEFAULT 0" },
  { name: "pos", definition: "INTEGER NOT NULL DEFAULT 0" },
  { name: "model", definition: "TEXT NOT NULL DEFAULT ''" },
  { name: "embed_fingerprint", definition: "TEXT NOT NULL DEFAULT ''" },
  { name: "total_chunks", definition: "INTEGER NOT NULL DEFAULT 1" },
  { name: "embedded_at", definition: "TEXT NOT NULL DEFAULT ''" },
];

function isContentVectorColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!/(no such column|has no column named)/i.test(message)) {
    return false;
  }
  return CONTENT_VECTOR_DESIRED_COLUMNS.some(col => message.includes(col.name));
}

/**
 * Covering index for the embedding-status aggregations over content_vectors
 * (getHashesNeedingEmbedding and the legacy-fingerprint scans). Without it,
 * SQLite materializes a transient "automatic covering index" over the whole
 * table on every execution — measured at ~3.3s per call on an 81k-row index,
 * and the MCP server runs that query synchronously inside every `initialize`.
 * Legacy databases can predate the (model, embed_fingerprint, total_chunks)
 * columns: skip creation there so startup stays probe-free, and let
 * runContentVectorColumnRepairs() add the index right after it adds the
 * missing columns.
 */
function ensureContentVectorsStatusIndex(db: Database): void {
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_content_vectors_model_fingerprint
      ON content_vectors(model, embed_fingerprint, hash, total_chunks)
    `);
  } catch (error) {
    if (!isContentVectorColumnError(error)) {
      throw error;
    }
  }
}

function runContentVectorColumnRepairs(db: Database): void {
  for (const column of CONTENT_VECTOR_DESIRED_COLUMNS) {
    try {
      db.exec(`ALTER TABLE content_vectors ADD COLUMN ${column.name} ${column.definition}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The repair series is intentionally idempotent: most columns should
      // already exist, and another caller may have repaired a missing column
      // between the failed query and this ALTER series.
      if (!message.includes("duplicate column name")) {
        throw error;
      }
    }
  }
  ensureContentVectorsStatusIndex(db);
}

function withLazyContentVectorMigration<T>(db: Database, operation: () => T): T {
  let repaired = false;
  while (true) {
    try {
      return operation();
    } catch (error) {
      if (repaired || !isContentVectorColumnError(error)) {
        throw error;
      }
      runContentVectorColumnRepairs(db);
      repaired = true;
    }
  }
}

function getPendingEmbeddingDocs(db: Database, collection?: string, model: string = DEFAULT_EMBED_MODEL): PendingEmbeddingDoc[] {
  const collectionFilter = collection ? `AND d.collection = ?` : ``;
  const fingerprint = getEmbeddingFingerprint(model);
  return withLazyContentVectorMigration(db, () => {
    const stmt = db.prepare(`
      SELECT d.hash, MIN(d.path) as path, length(CAST(c.doc AS BLOB)) as bytes
      FROM documents d
      JOIN content c ON d.hash = c.hash
      LEFT JOIN (
        SELECT hash, model, COUNT(*) AS chunk_count, MAX(total_chunks) AS expected_chunks
        FROM content_vectors
        WHERE model = ? AND embed_fingerprint = ?
        GROUP BY hash, model, embed_fingerprint
      ) v ON d.hash = v.hash
      WHERE d.active = 1
        AND (v.hash IS NULL OR v.chunk_count < v.expected_chunks)
        ${collectionFilter}
      GROUP BY d.hash
      ORDER BY MIN(d.path)
    `);
    // Large-result query (up to 9k docs): stream via iterate() instead of .all() to bound V8 heap
    const results: PendingEmbeddingDoc[] = [];
    const iter = collection
      ? stmt.iterate(model, fingerprint, collection)
      : stmt.iterate(model, fingerprint);
    for (const row of iter as IterableIterator<PendingEmbeddingDoc>) {
      results.push(row);
    }
    return results;
  });
}

function buildEmbeddingBatches(
  docs: PendingEmbeddingDoc[],
  maxDocsPerBatch: number,
  maxBatchBytes: number,
): PendingEmbeddingDoc[][] {
  const batches: PendingEmbeddingDoc[][] = [];
  let currentBatch: PendingEmbeddingDoc[] = [];
  let currentBytes = 0;

  for (const doc of docs) {
    const docBytes = Math.max(0, doc.bytes);
    const wouldExceedDocs = currentBatch.length >= maxDocsPerBatch;
    const wouldExceedBytes = currentBatch.length > 0 && (currentBytes + docBytes) > maxBatchBytes;

    if (wouldExceedDocs || wouldExceedBytes) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }

    currentBatch.push(doc);
    currentBytes += docBytes;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

function getEmbeddingDocsForBatch(db: Database, batch: PendingEmbeddingDoc[]): EmbeddingDoc[] {
  if (batch.length === 0) return [];

  const placeholders = batch.map(() => "?").join(",");
  // Bounded: batch size max 64 (maxDocsPerBatch), so IN list max 64 hashes.
  // Use iterate() to stream rows instead of materializing all at once, nicer for large batches.
  const stmt = db.prepare(`
    SELECT hash, doc as body
    FROM content
    WHERE hash IN (${placeholders})
  `);
  const bodyByHash = new Map<string, string>();
  for (const row of stmt.iterate(...batch.map(doc => doc.hash)) as IterableIterator<{ hash: string; body: string }>) {
    bodyByHash.set(row.hash, row.body);
  }

  return batch.map((doc) => ({
    ...doc,
    body: bodyByHash.get(doc.hash) ?? "",
  }));
}

/**
 * The on-disk file behind this connection's main database, or null when it has
 * none (a true in-memory or temp database). `PRAGMA database_list` reports the
 * file SQLite actually opened, so a plain path and any `file:` URI alias for
 * the same index resolve to one lock instead of two, and a URI that names a
 * shared on-disk database is still serialized. `realpathSync` collapses the
 * remaining spellings (relative vs absolute, symlinks) once the file exists.
 */
function mainDatabaseFilePath(db: Database): string | null {
  const rows = db.prepare(`PRAGMA database_list`).all() as { name?: string; file?: string }[];
  const main = rows.find(row => row.name === "main");
  const file = main?.file;
  if (!file) return null;
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

/**
 * Take the index's exclusive embed lock for one run over `db`, or null when the
 * connection has no shared on-disk database (a true in-memory or temp
 * database, which no other process can be embedding).
 *
 * Every run takes its own ownership: there is no way for a caller to hand one
 * in, because a stale or unrelated handle would silently disable the mutual
 * exclusion that keeps two runs from deleting each other's chunks. A caller
 * that already holds the lock (an embedding run clearing its own vectors for
 * `force`) calls the `...WithIndexLockHeld` body instead of re-acquiring here.
 */
function acquireEmbedLockForDb(db: Database): EmbedLockHandle | null {
  const file = mainDatabaseFilePath(db);
  if (!file) return null;
  const lockPath = embedLockPathForDb(file);
  const result = acquireEmbedLock(lockPath);
  if (result.status === "busy") throw new EmbedLockBusyError(lockPath, result.reason);
  return result.handle;
}

/**
 * Generate vector embeddings for documents that need them.
 * Pure function — no console output, no db lifecycle management.
 * Uses the store's LlamaCpp instance if set, otherwise the global singleton.
 *
 * Exclusive per index: the run holds the sidecar embed lock from before it
 * clears, copies or reads pending vectors until after its last publication, so
 * a concurrent CLI/SDK/direct run cannot interleave partial-chunk cleanup and
 * vector writes with this one. Rejects with {@link EmbedLockBusyError} when
 * another run already owns the lock; the lock is released on success, error
 * and cancellation. A `force` clear goes through the lock-held body: this run
 * already owns the lock and must not try to acquire it again.
 */
export async function generateEmbeddings(
  store: Store,
  options?: EmbedOptions
): Promise<EmbedResult> {
  // Reject invalid batch options before taking the lock, so a caller with a bad
  // option sees that error rather than a "busy" from someone else's run.
  const batchOptions = resolveEmbedOptions(options);
  const lock = acquireEmbedLockForDb(store.db);
  try {
    return await embedWithIndexLockHeld(store, batchOptions, options);
  } finally {
    // Success, failure or cancellation: the next run must be able to start.
    lock?.release();
  }
}

/** The embedding run itself; generateEmbeddings() owns the index lock. */
async function embedWithIndexLockHeld(
  store: Store,
  batchOptions: ResolvedEmbedBatchOptions,
  options?: EmbedOptions
): Promise<EmbedResult> {
  const { maxDocsPerBatch, maxBatchBytes } = batchOptions;
  const db = store.db;
  const llm = getLlm(store);
  const model = options?.model ?? llm.embedModelName ?? DEFAULT_EMBED_MODEL;
  const fingerprint = getEmbeddingFingerprint(model);
  const now = new Date().toISOString();
  const encoder = new TextEncoder();

  if (options?.force) {
    clearEmbeddingsWithIndexLockHeld(db, options?.collection);
  }

  const chunksCopied = copyVectorsToNewCollections(db, options?.collection).copied;
  const docsToEmbed = getPendingEmbeddingDocs(db, options?.collection, model);

  if (docsToEmbed.length === 0) {
    return { docsProcessed: 0, chunksEmbedded: 0, chunksCopied, errors: 0, durationMs: 0, nothingToDo: true };
  }
  const totalBytes = docsToEmbed.reduce((sum, doc) => sum + Math.max(0, doc.bytes), 0);
  const startTime = Date.now();

  // Use store's LlamaCpp or global singleton, wrapped in a session
  const embedModelUri = model;

  // Create a session manager for this llm instance
  const result = await withLLMSessionForLlm(llm, async (session) => {
    let chunksEmbedded = 0;
    let bytesProcessed = 0;
    let totalChunks = 0;
    let docsProcessed = 0;
    let vectorTableInitialized = false;
    const BATCH_SIZE = 32;
    const RETRY_AFTER_SUCCESSFUL_CHUNKS = 64;
    const MAX_RETRY_ATTEMPTS = 3;
    // Chunk retry lifecycle. A failed chunk starts `retryable`; each attempt
    // spends one of MAX_RETRY_ATTEMPTS; the transition to `exhausted` is what
    // removes a chunk from the retry pass and lets the forced pass terminate.
    // A model whose batch call is one bounded attempt (remote) starts exhausted,
    // so its failures are reported but never retried individually.
    type RetryPhase = "retryable" | "exhausted";
    type FailedChunk = { chunk: ChunkItem; attempts: number; phase: RetryPhase; reason: string };
    const failuresAreRetryable = !model.startsWith("remote-openai:");
    const failedChunks = new Map<string, FailedChunk>();
    let successesSinceRetry = 0;
    // Set when the 80%-error-rate abort trips: it stops the whole run, not
    // just the current 32-chunk window, and suppresses the force-retry that
    // would otherwise re-embed the just-aborted chunks.
    let errorRateAborted = false;

    const failureList = (): EmbedFailure[] =>
      [...failedChunks.values()].map(({ chunk, attempts, reason }) => ({
        path: chunk.path,
        hash: chunk.hash,
        seq: chunk.seq,
        attempts,
        reason,
      }));
    const activeErrorCount = () => failedChunks.size;
    const chunkKey = (chunk: ChunkItem) => `${chunk.hash}:${chunk.seq}`;
    const reasonFromError = (error: unknown) => {
      const raw = error instanceof Error ? error.message : String(error);
      return raw.length > 180 ? `${raw.slice(0, 177)}...` : raw;
    };
    const retryableChunks = (): FailedChunk[] =>
      [...failedChunks.values()].filter((state) => state.phase === "retryable");
    const recordFailure = (chunk: ChunkItem, reason: string) => {
      const key = chunkKey(chunk);
      const attempts = (failedChunks.get(key)?.attempts ?? 0) + 1;
      const phase: RetryPhase = failuresAreRetryable && attempts < MAX_RETRY_ATTEMPTS ? "retryable" : "exhausted";
      failedChunks.set(key, { chunk, attempts, phase, reason });
    };
    const clearFailure = (chunk: ChunkItem) => {
      failedChunks.delete(chunkKey(chunk));
    };
    // This writer expects to own every transaction it writes in; an open one
    // belongs to another writer on the shared connection, and embedding rows
    // written now would be committed or rolled back with that writer's work.
    // The chunk fails instead, so the loss shows up as a retryable error.
    const assertNoForeignTransaction = (): void => {
      if (db.inTransaction) {
        throw new Error("connection is inside another writer's transaction");
      }
    };
    const tryEmbedChunk = async (chunk: ChunkItem): Promise<boolean> => {
      try {
        const text = formatDocForEmbedding(chunk.text, chunk.title, embedModelUri);
        const result = await session.embed(text, { model });
        if (!result) {
          recordFailure(chunk, "embedding returned no vector");
          return false;
        }
        assertNoForeignTransaction();
        insertEmbedding(db, chunk.hash, chunk.seq, chunk.pos, new Float32Array(result.embedding), model, now, chunk.expectedTotalChunks, fingerprint);
        chunksEmbedded++;
        successesSinceRetry++;
        clearFailure(chunk);
        return true;
      } catch (error) {
        recordFailure(chunk, reasonFromError(error));
        return false;
      }
    };
    const retryFailedChunks = async (force = false) => {
      if (!session.isValid) return;
      if (!force && successesSinceRetry < RETRY_AFTER_SUCCESSFUL_CHUNKS) return;
      if (retryableChunks().length === 0) return;
      successesSinceRetry = 0;

      // Normal mode: one retry pass after enough unrelated chunks succeeded.
      // Force mode: we have run out of other chunks for this batch, so keep
      // retrying what is still retryable until it recovers or is exhausted.
      do {
        let retried = 0;
        for (const state of retryableChunks()) {
          retried++;
          await tryEmbedChunk(state.chunk);
        }
        if (!force || retried === 0) break;
      } while (session.isValid && retryableChunks().length > 0);
    };
    const batches = buildEmbeddingBatches(docsToEmbed, maxDocsPerBatch, maxBatchBytes);

    for (const batchMeta of batches) {
      // Abort early if session has been invalidated
      if (!session.isValid) {
        console.warn(`⚠ Session expired — skipping remaining document batches`);
        break;
      }
      // The 80%-error-rate abort below stops the whole run: the remaining
      // doc-batches would fail the same way, so don't start them.
      if (errorRateAborted) {
        break;
      }

      const batchDocs = getEmbeddingDocsForBatch(db, batchMeta);
      const batchChunks: ChunkItem[] = [];
      const expectedChunksByHash = new Map<string, number>();
      const batchBytes = batchMeta.reduce((sum, doc) => sum + Math.max(0, doc.bytes), 0);

      for (const doc of batchDocs) {
        if (!doc.body.trim()) continue;

        const title = extractTitle(doc.body, doc.path);
        const chunks = await chunkDocumentByTokensWithLlm(
          llm,
          doc.body,
          undefined, undefined, undefined,
          doc.path,
          options?.chunkStrategy,
          session.signal,
        );

        for (let seq = 0; seq < chunks.length; seq++) {
          batchChunks.push({
            hash: doc.hash,
            path: doc.path,
            title,
            text: chunks[seq]!.text,
            seq,
            pos: chunks[seq]!.pos,
            tokens: chunks[seq]!.tokens,
            bytes: encoder.encode(chunks[seq]!.text).length,
            expectedTotalChunks: chunks.length,
          });
        }
        expectedChunksByHash.set(doc.hash, chunks.length);
        // Stale rows from a previous chunking generation (seq >= new count)
        // must go BEFORE inserting: removeIncompleteEmbeddings counts rows
        // per hash regardless of fingerprint, so leftover higher-seq rows
        // would make it wipe this hash's fresh rows and force a second
        // embed run to converge.
        pruneStaleChunkVectors(db, doc.hash, model, chunks.length);
      }

      totalChunks += batchChunks.length;

      if (batchChunks.length === 0) {
        bytesProcessed += batchBytes;
        options?.onProgress?.({ chunksEmbedded, totalChunks, bytesProcessed, totalBytes, errors: activeErrorCount(), failures: failureList() });
        continue;
      }

      if (!vectorTableInitialized) {
        const firstChunk = batchChunks[0]!;
        const firstText = formatDocForEmbedding(firstChunk.text, firstChunk.title, embedModelUri);
        const firstResult = await session.embed(firstText, { model });
        if (!firstResult) {
          throw new Error("Failed to get embedding dimensions from first chunk");
        }
        store.ensureVecTable(firstResult.embedding.length);
        vectorTableInitialized = true;
      }

      const totalBatchChunkBytes = batchChunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
      let batchChunkBytesProcessed = 0;
      let batchCompleted = true;

      for (let batchStart = 0; batchStart < batchChunks.length; batchStart += BATCH_SIZE) {
        // Abort early if session has been invalidated (e.g. max duration exceeded)
        if (!session.isValid) {
          const remainingChunks = batchChunks.slice(batchStart);
          for (const chunk of remainingChunks) recordFailure(chunk, "LLM session expired before embedding chunk");
          console.warn(`⚠ Session expired — skipping ${remainingChunks.length} remaining chunks`);
          batchCompleted = false;
          break;
        }

        // Abort early if active error rate is too high (>80% of attempted chunks failed)
        const processed = chunksEmbedded + activeErrorCount();
        if (processed >= BATCH_SIZE && activeErrorCount() > processed * 0.8) {
          const remainingChunks = batchChunks.slice(batchStart);
          for (const chunk of remainingChunks) recordFailure(chunk, "embedding aborted because error rate was too high");
          console.warn(`⚠ Error rate too high (${activeErrorCount()}/${processed}) — aborting embedding`);
          batchCompleted = false;
          errorRateAborted = true;
          break;
        }

        const batchEnd = Math.min(batchStart + BATCH_SIZE, batchChunks.length);
        const chunkBatch = batchChunks.slice(batchStart, batchEnd);
        const texts = chunkBatch.map(chunk => formatDocForEmbedding(chunk.text, chunk.title, embedModelUri));

        try {
          const embeddings = await session.embedBatch(texts, { model });
          // One IMMEDIATE transaction per batch: every chunk writes several
          // rows across three tables, and a kill mid-batch must not leave
          // them out of step. Failure bookkeeping runs after the commit.
          // Checked after the await, immediately before the write, because the
          // transaction this writer opens must be its own.
          assertNoForeignTransaction();
          const stored: ChunkItem[] = [];
          const unembedded: ChunkItem[] = [];
          db.transaction(() => {
            for (let i = 0; i < chunkBatch.length; i++) {
              const chunk = chunkBatch[i]!;
              const embedding = embeddings[i];
              if (embedding) {
                insertEmbedding(db, chunk.hash, chunk.seq, chunk.pos, new Float32Array(embedding.embedding), model, now, chunk.expectedTotalChunks, fingerprint);
                stored.push(chunk);
              } else {
                unembedded.push(chunk);
              }
            }
          }).immediate();
          for (const chunk of stored) {
            chunksEmbedded++;
            successesSinceRetry++;
            clearFailure(chunk);
          }
          for (const chunk of unembedded) recordFailure(chunk, "batch embedding returned no vector");
          batchChunkBytesProcessed += chunkBatch.reduce((sum, chunk) => sum + chunk.bytes, 0);
          await retryFailedChunks();
        } catch (error) {
          // Batch failed — try individual embeddings as fallback. If an
          // individual retry succeeds, any prior failure for that chunk is
          // cleared, so the visible error count reflects outstanding failures.
          const batchReason = reasonFromError(error);
          if (db.inTransaction) {
            // The per-batch transaction is this writer's own and is always
            // closed by the time the catch runs, so an open one belongs to
            // another writer. Individual retries would write their rows into
            // that transaction and be committed or rolled back with it, so the
            // batch fails instead of writing outside its own transaction.
            for (const chunk of chunkBatch) recordFailure(chunk, `batch failed: ${batchReason}`);
            batchChunkBytesProcessed += chunkBatch.reduce((sum, c) => sum + c.bytes, 0);
          } else if (!session.isValid || !failuresAreRetryable) {
            // A remote batch is one bounded attempt; malformed/partial responses
            // must not be rescued by individual HTTP calls.
            for (const chunk of chunkBatch) recordFailure(chunk, `batch failed: ${batchReason}`);
            batchChunkBytesProcessed += chunkBatch.reduce((sum, c) => sum + c.bytes, 0);
          } else {
            for (const chunk of chunkBatch) {
              await tryEmbedChunk(chunk);
              batchChunkBytesProcessed += chunk.bytes;
              await retryFailedChunks();
            }
          }
        }

        const proportionalBytes = totalBatchChunkBytes === 0
          ? batchBytes
          : Math.min(batchBytes, Math.round((batchChunkBytesProcessed / totalBatchChunkBytes) * batchBytes));
        options?.onProgress?.({
          chunksEmbedded,
          totalChunks,
          bytesProcessed: bytesProcessed + proportionalBytes,
          totalBytes,
          errors: activeErrorCount(),
          failures: failureList(),
        });
      }

      // After an 80%-error-rate abort the failures are systemic, not
      // transient: retrying them (here or in later batches) just burns
      // embedding calls, so skip the force-retry pass entirely.
      if (!errorRateAborted) {
        await retryFailedChunks(true);
      }

      const removedPartialChunks = removeIncompleteEmbeddings(db, expectedChunksByHash, model);
      if (removedPartialChunks > 0) {
        chunksEmbedded = Math.max(0, chunksEmbedded - removedPartialChunks);
      }
      // Only batches that ran to completion count toward docsProcessed, so an
      // early session-expiry (or error-rate abort) break reports the docs
      // actually embedded instead of the full pending snapshot.
      if (batchCompleted) {
        docsProcessed += expectedChunksByHash.size;
      }

      bytesProcessed += batchBytes;
      options?.onProgress?.({ chunksEmbedded, totalChunks, bytesProcessed, totalBytes, errors: activeErrorCount(), failures: failureList() });
    }

    return { chunksEmbedded, docsProcessed, errors: activeErrorCount(), failures: failureList() };
  }, { maxDuration: options?.maxDurationMs ?? DEFAULT_EMBED_MAX_DURATION_MS, signal: options?.signal, name: 'generateEmbeddings' });

  return {
    docsProcessed: result.docsProcessed,
    chunksEmbedded: result.chunksEmbedded,
    chunksCopied,
    errors: result.errors,
    failures: result.failures,
    durationMs: Date.now() - startTime,
    nothingToDo: false,
  };
}

/**
 * Create a new store instance with the given database path.
 * If no path is provided, uses the default path (~/.cache/qmd/index.sqlite).
 *
 * @param dbPath - Path to the SQLite database file
 * @returns Store instance with all methods bound to the database
 */
export function createStore(dbPath?: string): Store {
  const resolvedPath = dbPath || getDefaultDbPath();
  const db = openDatabase(resolvedPath);
  initializeDatabase(db);
  const rerankCacheDb = openRerankCache(process.env.QMD_RERANK_CACHE);

  const store: Store = {
    db,
    dbPath: resolvedPath,
    close: () => {
      rerankCacheDb?.close();
      db.close();
    },
    ensureVecTable: (dimensions: number) => ensureVecTableInternal(db, dimensions),

    // Index health
    getHashesNeedingEmbedding: (model?: string) => getHashesNeedingEmbedding(db, undefined, model ?? store.llm?.embedModelName ?? DEFAULT_EMBED_MODEL),
    getIndexHealth: (model?: string) => getIndexHealth(db, model ?? store.llm?.embedModelName ?? DEFAULT_EMBED_MODEL),
    getStatus: (model?: string) => getStatus(db, model ?? store.llm?.embedModelName ?? DEFAULT_EMBED_MODEL),
    getStatusSummary: (model?: string) => getStatusSummary(db, model ?? store.llm?.embedModelName ?? DEFAULT_EMBED_MODEL),

    // Caching
    getCacheKey,
    getCachedResult: (cacheKey: string) => getCachedResult(db, cacheKey),
    setCachedResult: (cacheKey: string, result: string) => setCachedResult(db, cacheKey, result),
    clearCache: () => clearCache(db),

    // Cleanup and maintenance
    deleteLLMCache: () => deleteLLMCache(db),
    deleteInactiveDocuments: () => deleteInactiveDocuments(db),
    cleanupOrphanedContent: () => cleanupOrphanedContent(db),
    cleanupOrphanedVectors: () => cleanupOrphanedVectors(db),
    vacuumDatabase: () => vacuumDatabase(db),

    // Context
    getContextForFile: (filepath: string) => getContextForFile(db, filepath),
    getContextForPath: (collectionName: string, path: string) => getContextForPath(db, collectionName, path),
    getCollectionByName: (name: string) => getCollectionByName(db, name),
    getCollectionsWithoutContext: () => getCollectionsWithoutContext(db),
    getTopLevelPathsWithoutContext: (collectionName: string) => getTopLevelPathsWithoutContext(db, collectionName),

    // Virtual paths
    parseVirtualPath,
    buildVirtualPath,
    isVirtualPath,
    resolveVirtualPath: (virtualPath: string) => resolveVirtualPath(db, virtualPath),
    toVirtualPath: (absolutePath: string) => toVirtualPath(db, absolutePath),

    // Search
    searchFTS: (query: string, limit?: number, collectionName?: string | readonly string[], filter?: MetadataFilter, scope?: DocumentFilter, onScanCapped?: () => void) => searchFTS(db, query, limit, collectionName, filter, scope, onScanCapped),
    searchVec: (query: string, model: string, limit?: number, collectionName?: string | readonly string[], session?: ILLMSession, precomputedEmbedding?: number[], filter?: MetadataFilter, scope?: DocumentFilter) => searchVec(db, query, model, limit, collectionName, session, precomputedEmbedding, getLlm(store), filter, scope),

    // Query expansion & reranking
    expandQuery: (query: string, model?: string, options?: { onModelReady?: () => void }) =>
      expandQuery(query, model ?? store.llm?.generateModelName ?? DEFAULT_QUERY_MODEL, db, store.llm, options),
    invalidateExpansionCache: (query: string) => deleteExpansionCacheEntry(db, query, store.llm?.generateModelName ?? DEFAULT_QUERY_MODEL),
    rerank: (query: string, documents: { file: string; text: string }[], model?: string, intent?: string, options?: StoreRerankOptions) => {
      // Cache keys must use the resolved rerank model (store.llm or the global
      // singleton from models.rerank). Falling back to DEFAULT_RERANK_MODEL when
      // store.llm is unset made keys stable across config swaps (#764).
      const llm = getLlm(store);
      return rerank(query, documents, model ?? llm.rerankModelName ?? DEFAULT_RERANK_MODEL, rerankCacheDb ?? db, intent, llm, options);
    },

    // Document retrieval
    findDocument: (filename: string, options?: { includeBody?: boolean }) => findDocument(db, filename, options),
    getDocumentBody: (doc: DocumentResult | { filepath: string }, fromLine?: number, maxLines?: number) => getDocumentBody(db, doc, fromLine, maxLines),
    findDocuments: (pattern: string, options?: { includeBody?: boolean; maxBytes?: number }) => findDocuments(db, pattern, options),

    // Fuzzy matching and docid lookup
    findSimilarFiles: (query: string, maxDistance?: number, limit?: number) => findSimilarFiles(db, query, maxDistance, limit),
    matchFilesByGlob: (pattern: string) => matchFilesByGlob(db, pattern),
    findDocumentByDocid: (docid: string) => findDocumentByDocid(db, docid),

    // Document indexing operations
    insertContent: (hash: string, content: string, createdAt: string) => insertContent(db, hash, content, createdAt),
    insertDocument: (collectionName: string, path: string, title: string, hash: string, createdAt: string, modifiedAt: string) => insertDocument(db, collectionName, path, title, hash, createdAt, modifiedAt),
    findActiveDocument: (collectionName: string, path: string) => findActiveDocument(db, collectionName, path),
    findOrMigrateLegacyDocument: (collectionName: string, path: string) => findOrMigrateLegacyDocument(db, collectionName, path),
    updateDocumentTitle: (documentId: number, title: string, modifiedAt: string) => updateDocumentTitle(db, documentId, title, modifiedAt),
    updateDocument: (documentId: number, title: string, hash: string, modifiedAt: string) => updateDocument(db, documentId, title, hash, modifiedAt),
    deactivateDocument: (collectionName: string, path: string) => deactivateDocument(db, collectionName, path),
    getActiveDocumentPaths: (collectionName: string) => getActiveDocumentPaths(db, collectionName),

    // Vector/embedding operations
    getHashesForEmbedding: () => getHashesForEmbedding(db),
    clearAllEmbeddings: () => clearAllEmbeddings(db),
    insertEmbedding: (hash: string, seq: number, pos: number, embedding: Float32Array, model: string, embeddedAt: string, totalChunks?: number, fingerprint?: string) => insertEmbedding(db, hash, seq, pos, embedding, model, embeddedAt, totalChunks, fingerprint),
  };

  return store;
}

// =============================================================================
// Core Document Type
// =============================================================================

/**
 * Unified document result type with all metadata.
 * Body is optional - use getDocumentBody() to load it separately if needed.
 */
export type DocumentResult = {
  filepath: string;           // Full filesystem path
  displayPath: string;        // Short display path (e.g., "docs/readme.md")
  title: string;              // Document title (from first heading or filename)
  context: string | null;     // Folder context description if configured
  hash: string;               // Content hash for caching/change detection
  docid: string;              // Short docid (first 6 chars of hash) for quick reference
  collectionName: string;     // Parent collection name
  modifiedAt: string;         // Last modification timestamp
  bodyLength: number;         // Body length in bytes (useful before loading)
  body?: string;              // Document body (optional, load with getDocumentBody)
};

/**
 * Extract short docid from a full hash (first 6 characters).
 */
export function getDocid(hash: string): string {
  return hash.slice(0, 6);
}

/**
 * Handelize a filename to be more token-friendly.
 * - Convert triple underscore `___` to `/` (folder separator)
 * - Replace sequences of non-word chars (except /) with single dash
 * - Remove leading/trailing dashes from path segments
 * - Preserve folder structure (a/b/c/d.md stays structured)
 * - Preserve file extension
 * - Preserve original case (important for case-sensitive filesystems)
 */
/** Replace emoji/symbol codepoints with their hex representation (e.g. 🐘 → 1f418) */
function emojiToHex(str: string): string {
  return str.replace(/(?:\p{So}\p{Mn}?|\p{Sk})+/gu, (run) => {
    // Split the run into individual emoji and convert each to hex, dash-separated
    return [...run].filter(c => /\p{So}|\p{Sk}/u.test(c))
      .map(c => c.codePointAt(0)!.toString(16)).join('-');
  });
}

export function handelize(path: string): string {
  if (!path || path.trim() === '') {
    throw new Error('handelize: path cannot be empty');
  }

  // Allow route-style "$" filenames while still rejecting paths with no usable content.
  // Emoji (\p{So}) counts as valid content — they get converted to hex codepoints below.
  const segments = path.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1] || '';
  const filenameWithoutExt = lastSegment.replace(/\.[^.]+$/, '');
  const hasValidContent = /[\p{L}\p{N}\p{So}\p{Sk}$]/u.test(filenameWithoutExt);
  if (!hasValidContent) {
    throw new Error(`handelize: path "${path}" has no valid filename content`);
  }

  const result = path
    .replace(/___/g, '/')       // Triple underscore becomes folder separator
    .split('/')
    .map((segment, idx, arr) => {
      const isLastSegment = idx === arr.length - 1;

      // Convert emoji to hex codepoints before cleaning
      segment = emojiToHex(segment);

      if (isLastSegment) {
        // For the filename (last segment), preserve the extension
        const extMatch = segment.match(/(\.[a-z0-9]+)$/i);
        const ext = extMatch ? extMatch[1] : '';
        const nameWithoutExt = ext ? segment.slice(0, -ext.length) : segment;

        const cleanedName = nameWithoutExt
          .replace(/[^\p{L}\p{N}$]+/gu, '-')  // Keep letters, numbers, "$"; dash-separate rest (including dots)
          .replace(/^-+|-+$/g, ''); // Remove leading/trailing dashes

        return cleanedName + ext;
      } else {
        // For directories, just clean normally
        return segment
          .replace(/[^\p{L}\p{N}$]+/gu, '-')
          .replace(/^-+|-+$/g, '');
      }
    })
    .filter(Boolean)
    .join('/');

  if (!result) {
    throw new Error(`handelize: path "${path}" resulted in empty string after processing`);
  }

  return result;
}

/**
 * Search result extends DocumentResult with score and source info
 */
export type SearchResult = DocumentResult & {
  metadata: DocumentMetadata;
  score: number;              // Relevance score (0-1)
  source: "fts" | "vec";      // Search source (full-text or vector)
  matchMode?: "all" | "any";  // ko-qmd: "any" marks a relaxed FTS retry (weaker evidence)
  chunkPos?: number;          // Character position of matching chunk (for vector search)
};

/**
 * Ranked result for RRF fusion (simplified, used internally)
 */
export type RankedResult = {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  score: number;
};

export type RRFContributionTrace = {
  listIndex: number;
  source: "fts" | "vec";
  queryType: "original" | "lex" | "vec" | "hyde";
  query: string;
  rank: number;            // 1-indexed rank within list
  weight: number;
  multiplier?: number; // per-document coverage multiplier (1.0 when none)
  backendScore: number;    // Backend-normalized score before fusion
  rrfContribution: number; // weight * multiplier / (k + rank)
};

export type RRFScoreTrace = {
  contributions: RRFContributionTrace[];
  baseScore: number;       // Sum of reciprocal-rank contributions
  topRank: number;         // Best (lowest) rank seen across lists
  topRankBonus: number;    // +0.05 for rank 1, +0.02 for rank 2-3
  totalScore: number;      // baseScore + topRankBonus
};

export type HybridQueryExplain = {
  ftsScores: number[];
  vectorScores: number[];
  rrf: {
    rank: number;          // Rank after RRF fusion (1-indexed)
    positionScore: number; // 1 / rank used in position-aware blending
    weight: number;        // Position-aware RRF weight (0.75 / 0.60 / 0.40)
    baseScore: number;
    topRankBonus: number;
    totalScore: number;
    contributions: RRFContributionTrace[];
  };
  rerankScore: number;
  blendedScore: number;
};

/**
 * Error result when document is not found
 */
export type DocumentNotFound = {
  error: "not_found";
  query: string;
  similarFiles: string[];
};

export type DocumentExcludedByIgnore = {
  error: "excluded_by_ignore";
  query: string;
  collection: string;
  path: string;
  rule: string;
};

export type DocumentLookupError = DocumentNotFound | DocumentExcludedByIgnore;

/**
 * Result from multi-get operations
 */
export type MultiGetResult = {
  doc: DocumentResult;
  skipped: false;
} | {
  doc: Pick<DocumentResult, "filepath" | "displayPath">;
  skipped: true;
  skipReason: string;
};

export type CollectionInfo = {
  name: string;
  path: string | null;
  pattern: string | null;
  documents: number;
  lastUpdated: string;
  /** Distinct metadata keys declared in this collection. */
  metadataKeyCount: number;
  /**
   * The most covered metadata keys in this collection, with coverage and
   * types, by coverage. Windowed to STATUS_METADATA_KEY_LIMIT; `listMetadata`
   * pages through the rest.
   */
  metadataKeys: MetadataKeyOverview[];
};

/** Keys a status view names per collection before pointing at discovery. */
export const STATUS_METADATA_KEY_LIMIT = 10;

export type IndexStatus = {
  totalDocuments: number;
  needsEmbedding: number;
  hasVectorIndex: boolean;
  /** Active documents without current, error-free metadata extraction. */
  pendingMetadata: number;
  collections: CollectionInfo[];
};

/** Index facts for initialization, without computing unused metadata overviews. */
export type IndexStatusSummary = Omit<IndexStatus, "collections"> & {
  collections: Omit<CollectionInfo, "metadataKeyCount" | "metadataKeys">[];
};

// =============================================================================
// Index health
// =============================================================================

export type EmbeddingVectorSample = {
  hash: string;
  seq: number;
  pos: number;
  body: string;
  path: string;
};

export function getEmbeddingVectorSamples(db: Database, model: string, fingerprint: string, sampleSize: number = 3): EmbeddingVectorSample[] {
  // Limit chunk identities before reading bodies. Joining bodies to every chunk
  // and duplicate path can make a three-row sample sort gigabytes of text.
  return db.prepare(`
    WITH sampled AS MATERIALIZED (
      SELECT cv.hash, cv.seq, cv.pos
      FROM content_vectors cv
      JOIN content c ON c.hash = cv.hash
      WHERE cv.model = ? AND cv.embed_fingerprint = ?
        AND EXISTS (
          SELECT 1 FROM documents d WHERE d.hash = cv.hash AND d.active = 1
        )
      ORDER BY random()
      LIMIT ?
    )
    SELECT sampled.hash, sampled.seq, sampled.pos, c.doc AS body,
      (SELECT MIN(d.path) FROM documents d
       WHERE d.hash = sampled.hash AND d.active = 1) AS path
    FROM sampled
    JOIN content c ON c.hash = sampled.hash
  `).all<EmbeddingVectorSample>(model, fingerprint, sampleSize);
}

export function getHashesNeedingEmbedding(db: Database, collection?: string, model: string = DEFAULT_EMBED_MODEL): number {
  const collectionFilter = collection ? `AND d.collection = ?` : ``;
  const fingerprint = getEmbeddingFingerprint(model);
  return withLazyContentVectorMigration(db, () => {
    const stmt = db.prepare(`
      SELECT COUNT(DISTINCT d.hash) as count
      FROM documents d
      LEFT JOIN (
        SELECT hash, model, COUNT(*) AS chunk_count, MAX(total_chunks) AS expected_chunks
        FROM content_vectors
        WHERE model = ? AND embed_fingerprint = ?
        GROUP BY hash, model, embed_fingerprint
      ) v ON d.hash = v.hash
      WHERE d.active = 1
        AND (v.hash IS NULL OR v.chunk_count < v.expected_chunks)
        ${collectionFilter}
    `);
    const result = (collection ? stmt.get(model, fingerprint, collection) : stmt.get(model, fingerprint)) as { count: number };
    return result.count;
  });
}

export type IndexHealthInfo = {
  needsEmbedding: number;
  totalDocs: number;
  daysStale: number | null;
};

export type LegacyFingerprintAdoptionResult = {
  checked: boolean;
  adopted: number;
  reason: string;
};

export async function maybeAdoptLegacyEmbeddingFingerprint(store: Store, model: string = DEFAULT_EMBED_MODEL): Promise<LegacyFingerprintAdoptionResult> {
  const db = store.db;
  const fingerprint = getEmbeddingFingerprint(model);
  const legacyCount = withLazyContentVectorMigration(db, () => {
    const row = db.prepare(`SELECT COUNT(DISTINCT hash) AS count FROM content_vectors WHERE model = ? AND embed_fingerprint = ''`).get(model) as { count: number };
    return row.count;
  });
  if (legacyCount === 0) {
    return { checked: false, adopted: 0, reason: "no legacy empty-fingerprint embeddings" };
  }

  // Pick the sample through indexes, then read one body by rowid; a join that
  // carries c.doc costs one body copy per legacy chunk × active path. Both
  // EXISTS filters depend only on hash, so this is still the lowest (hash, seq).
  // One read transaction keeps the pick and the load on the same snapshot.
  const sample = withLazyContentVectorMigration(db, () => {
    const pickSample = db.prepare(`
      SELECT cv.rowid AS rid
      FROM content_vectors cv
      WHERE cv.model = ? AND cv.embed_fingerprint = ''
        AND cv.hash = (
          SELECT l.hash
          FROM content_vectors l
          WHERE l.model = ? AND l.embed_fingerprint = ''
            AND EXISTS (SELECT 1 FROM documents d WHERE d.hash = l.hash AND d.active = 1)
            AND EXISTS (SELECT 1 FROM content c WHERE c.hash = l.hash)
          ORDER BY l.hash
          LIMIT 1
        )
      ORDER BY cv.seq
      LIMIT 1
    `);
    const loadSample = db.prepare(`
      SELECT cv.hash, cv.seq, cv.pos, cv.total_chunks, c.doc AS body,
        (SELECT MIN(d.path) FROM documents d WHERE d.hash = cv.hash AND d.active = 1) AS path
      FROM content_vectors cv
      JOIN content c ON c.hash = cv.hash
      WHERE cv.rowid = ?
    `);
    return db.transaction(() => {
      const pick = pickSample.get(model, model) as { rid: number } | null | undefined;
      return pick ? loadSample.get(pick.rid) : undefined;
    })() as { hash: string; seq: number; pos: number; total_chunks: number; body: string; path: string } | null | undefined;
  });

  if (!sample) {
    return { checked: false, adopted: 0, reason: `${legacyCount} legacy docs have no active sample` };
  }

  if (!hasVectorIndex(db)) {
    return { checked: false, adopted: 0, reason: "vector index is missing" };
  }

  const expectedHashSeq = `${sample.hash}_${sample.seq}`;
  const title = extractTitle(sample.body, sample.path);
  const llm = getLlm(store);

  return await withLLMSessionForLlm(llm, async (session) => {
    const chunks = await chunkDocumentByTokensWithLlm(
      llm,
      sample.body,
      undefined,
      undefined,
      undefined,
      sample.path,
      undefined,
      session.signal,
    );
    const chunk = chunks[sample.seq];
    if (!chunk) {
      return { checked: true, adopted: 0, reason: `sample chunk ${expectedHashSeq} no longer exists` };
    }

    const result = await session.embed(formatDocForEmbedding(chunk.text, title, model), { model });
    if (!result) {
      return { checked: true, adopted: 0, reason: "failed to embed legacy sample" };
    }

    const nearest = db.prepare(`
      SELECT rowid, distance
      FROM ${VEC_TABLE}
      WHERE embedding MATCH ? AND k = 1
    `).get(new Float32Array(result.embedding)) as { rowid: number; distance: number } | undefined;
    const nearestKey = nearest ? partitionRowKey(db, nearest.rowid) : undefined;

    if (!nearest || !nearestKey) {
      return { checked: true, adopted: 0, reason: "legacy sample vector not found" };
    }

    const threshold = 0.0001;
    const nearestHashSeq = `${nearestKey.hash}_${nearestKey.seq}`;
    if (nearestHashSeq !== expectedHashSeq || nearest.distance > threshold) {
      return { checked: true, adopted: 0, reason: `legacy sample differs from current fingerprint (nearest ${nearestHashSeq}, distance ${nearest.distance.toFixed(6)})` };
    }

    const update = withLazyContentVectorMigration(db, () => db.prepare(`UPDATE content_vectors SET embed_fingerprint = ? WHERE model = ? AND embed_fingerprint = ''`).run(fingerprint, model));
    return { checked: true, adopted: update.changes, reason: `sample ${expectedHashSeq} matched current fingerprint at distance ${nearest.distance.toFixed(6)}` };
  });
}

export function getIndexHealth(db: Database, model: string = DEFAULT_EMBED_MODEL): IndexHealthInfo {
  const needsEmbedding = getHashesNeedingEmbedding(db, undefined, model);
  const totalDocs = (db.prepare(`SELECT COUNT(*) as count FROM documents WHERE active = 1`).get() as { count: number }).count;

  const mostRecent = db.prepare(`SELECT MAX(modified_at) as latest FROM documents WHERE active = 1`).get() as { latest: string | null };
  let daysStale: number | null = null;
  if (mostRecent?.latest) {
    const lastUpdate = new Date(mostRecent.latest);
    daysStale = Math.floor((Date.now() - lastUpdate.getTime()) / (24 * 60 * 60 * 1000));
  }

  return { needsEmbedding, totalDocs, daysStale };
}

// =============================================================================
// Caching
// =============================================================================

export type CacheKeyBody = {
  query?: string;
  model?: string;
  chunk?: string;
  file?: string;
};

export function getCacheKey(url: string, body: CacheKeyBody): string {
  const hash = createHash("sha256");
  hash.update(url);
  hash.update(JSON.stringify(body));
  return hash.digest("hex");
}

export function getCachedResult(db: Database, cacheKey: string): string | null {
  const row = db.prepare(`SELECT result FROM llm_cache WHERE hash = ?`).get(cacheKey) as { result: string } | null;
  return row?.result ?? null;
}

// ko-qmd: rerank cache files opened from QMD_RERANK_CACHE, which are never trimmed.
const UNCAPPED_CACHE_DBS = new WeakSet<Database>();

/**
 * ko-qmd: open the rerank cache file named by QMD_RERANK_CACHE, or undefined when it is unset.
 * Rerank scores then live outside the index, so a rebuilt index (bench-ko starts from an empty
 * one every run) reuses them. Only rerank entries move; expansion stays in the index's cache.
 * The key carries the query, model, doc-token cap and chunk text, so the file is safe across index
 * rebuilds with the same reranker code — not across a change to how llm.ts scores a chunk
 * (template, context size, node-llama-cpp), which the key does not see. It is not trimmed to the
 * index cache's 1000 rows.
 */
const openRerankCache = (path: string | undefined): Database | undefined => {
  if (!path) return undefined;
  const cacheDb = openDatabase(path);
  cacheDb.exec(`CREATE TABLE IF NOT EXISTS llm_cache (hash TEXT PRIMARY KEY, result TEXT NOT NULL, created_at TEXT NOT NULL)`);
  UNCAPPED_CACHE_DBS.add(cacheDb);
  return cacheDb;
};

export function setCachedResult(db: Database, cacheKey: string, result: string): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT OR REPLACE INTO llm_cache (hash, result, created_at) VALUES (?, ?, ?)`).run(cacheKey, result, now);
  if (!UNCAPPED_CACHE_DBS.has(db) && Math.random() < 0.01) {
    db.exec(`DELETE FROM llm_cache WHERE hash NOT IN (SELECT hash FROM llm_cache ORDER BY created_at DESC LIMIT 1000)`);
  }
}

export function clearCache(db: Database): void {
  db.exec(`DELETE FROM llm_cache`);
}

// =============================================================================
// Cleanup and maintenance operations
// =============================================================================

/**
 * Delete cached LLM API responses.
 * Returns the number of cached responses deleted.
 */
export function deleteLLMCache(db: Database): number {
  const result = db.prepare(`DELETE FROM llm_cache`).run();
  return result.changes;
}

/**
 * Remove inactive document records (active = 0).
 * Returns the number of inactive documents deleted.
 */
export function deleteInactiveDocuments(db: Database): number {
  const result = db.prepare(`DELETE FROM documents WHERE active = 0`).run();
  return result.changes;
}

/**
 * Remove orphaned content hashes that are not referenced by any document.
 * Inactive documents are soft-deleted tombstones, so their content rows must
 * remain referenced until deleteInactiveDocuments() hard-deletes them.
 * Returns the number of orphaned content hashes deleted.
 */
export function cleanupOrphanedContent(db: Database): number {
  const result = db.prepare(`
    DELETE FROM content
    WHERE hash NOT IN (SELECT DISTINCT hash FROM documents)
  `).run();
  return result.changes;
}

/**
 * Count content hashes that would be unreferenced after inactive documents
 * are hard-deleted. Shared hashes still used by an active document are kept.
 */
export function countOrphanedContent(db: Database): number {
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM content
    WHERE hash NOT IN (SELECT DISTINCT hash FROM documents WHERE active = 1)
  `).get() as { c: number };
  return row.c;
}

const ORPHANED_VECTOR_COUNT_SQL = `
  SELECT COUNT(*) as c FROM content_vectors cv
  WHERE NOT EXISTS (
    SELECT 1 FROM documents d WHERE d.hash = cv.hash AND d.active = 1
  )
`;

/**
 * Count embedding chunks whose hash is not referenced by any active document.
 * Reads `content_vectors` only, so this works even when sqlite-vec is unavailable (#768).
 */
export function countOrphanedVectors(db: Database): number {
  try {
    return withLazyContentVectorMigration(db, () => {
      const row = db.prepare(ORPHANED_VECTOR_COUNT_SQL).get() as { c: number };
      return row.c;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message)) return 0;
    throw error;
  }
}

/**
 * Single gate shared by the orphan-vector preview and the run path, so
 * `previewCleanup` only promises removals `cleanupOrphanedVectors` can
 * deliver (#768 follow-up: dry-run promised N chunks while the run removed 0
 * with rows intact).
 *
 * sqlite-vec may not be loaded (e.g. Bun's bun:sqlite lacks loadExtension).
 * The vec0 table can appear in sqlite_master from a prior session, but
 * querying it without the module loaded would crash (#380). A legacy table
 * is the vector migration's to move, not cleanup's to prune.
 */
function isVectorCleanupActionable(db: Database): boolean {
  if (!isSqliteVecAvailable()) return false;
  const layout = vecLayout(db);
  return layout.kind === "partitioned" && vecTableReadable(db, layout);
}

/**
 * Remove vector rows whose (hash, collection) no active document references,
 * and the content_vectors rows of hashes no active document references at
 * all. Returns the number of orphaned chunks deleted.
 */
export function cleanupOrphanedVectors(db: Database): number {
  if (!isVectorCleanupActionable(db)) {
    return 0;
  }

  return withLazyContentVectorMigration(db, () => {
    // The count and both DELETEs share one transaction: an interruption
    // between them (crash, SQLITE_BUSY) would leave content_vectors claiming
    // chunks the index no longer holds, and a revived hash would then be
    // skipped by getHashesNeedingEmbedding and stay unsearchable. Run it
    // BEGIN IMMEDIATE: upgrading a deferred read snapshot under a concurrent
    // WAL writer fails with SQLITE_BUSY_SNAPSHOT instead of honoring the busy
    // timeout. Nested callers still get a savepoint.
    const cleanup = db.transaction(() => {
      const orphanRows = db.prepare(`
        SELECT vr.id FROM ${VEC_ROWS_TABLE} vr
        JOIN ${VEC_COLLECTION_IDS_TABLE} ci ON ci.id = vr.collection_id
        WHERE NOT EXISTS (
          SELECT 1 FROM documents d WHERE d.hash = vr.hash AND d.collection = ci.name AND d.active = 1
        )
      `).all() as { id: number }[];
      const orphanedChunks = (db.prepare(ORPHANED_VECTOR_COUNT_SQL).get() as { c: number }).c;
      if (orphanRows.length === 0 && orphanedChunks === 0) {
        return 0;
      }

      deletePartitionRows(db, orphanRows.map((row) => row.id));
      db.exec(`
        DELETE FROM content_vectors WHERE hash NOT IN (
          SELECT hash FROM documents WHERE active = 1
        )
      `);

      return Math.max(orphanRows.length, orphanedChunks);
    });

    return cleanup.immediate();
  });
}

/**
 * Repack the vector table when fewer than this share of its chunk reads hold
 * live rows. vec0 places an insert in the first free slot of its newest chunk
 * and reclaims a chunk only once it is empty, so a delete in any older chunk
 * leaves a hole that every brute-force scan still reads; at 36% occupancy a
 * scan took twice as long as on a packed copy of the same rows.
 */
const VEC_REPACK_BELOW_OCCUPANCY = 0.9;

/** Chunks filled below this share have their live rows moved to the tail. */
const VEC_REPACK_CHUNK_FILL = 0.9;

export type VectorTableLayout = {
  rows: number;
  chunks: number;
  /** Chunks a freshly packed table needs for the same rows. */
  neededChunks: number;
  /** neededChunks over chunks: the share of a scan's chunk reads that hold live rows. */
  occupancy: number;
};

interface VecChunkRow {
  chunkId: number;
  size: number;
  partition: number;
  validity: Uint8Array;
  rowids: Uint8Array;
}

/** A plan for repackVectors: the table's chunk layout and the chunks it would move. */
type VecRepackPlan = { layout: VectorTableLayout; sparse: number[] };

/** The partitioned vec0 table when sqlite-vec is loaded and the table answers; null otherwise. */
function readableVectorLayout(db: Database): Extract<VecLayout, { kind: "partitioned" }> | null {
  if (!isSqliteVecAvailable()) return null;
  const layout = vecLayout(db);
  return layout.kind === "partitioned" && vecTableReadable(db, layout) ? layout : null;
}

/**
 * Chunk layout of the vector table from vec0's shadow tables, and the chunks
 * a repack would move: those filled below VEC_REPACK_CHUNK_FILL, except each
 * partition's newest. Rows of different partitions never share a chunk, so a
 * packed table needs ceil(rows / chunk size) chunks in each partition. With
 * `dropOrphans` the plan is for the table as cleanupOrphanedVectors will
 * leave it; vec0 drops a chunk with its last row, so a chunk holding only
 * orphans is gone from that layout.
 */
function vectorRepackPlan(db: Database, dropOrphans: boolean = false): VecRepackPlan | null {
  const layout = readableVectorLayout(db);
  if (!layout) return null;
  const orphansByChunk = new Map<number, number>();
  if (dropOrphans) {
    const rows = db.prepare(`
      SELECT r.chunk_id AS chunkId, COUNT(*) AS n
      FROM ${VEC_ROWS_TABLE} vr
      JOIN ${VEC_COLLECTION_IDS_TABLE} ci ON ci.id = vr.collection_id
      JOIN ${layout.shadow.rowids} r ON r.rowid = vr.id
      WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.hash = vr.hash AND d.collection = ci.name AND d.active = 1)
      GROUP BY r.chunk_id
    `).all() as { chunkId: number; n: number }[];
    for (const row of rows) orphansByChunk.set(row.chunkId, row.n);
  }
  const chunks = (db.prepare(`SELECT chunk_id AS chunkId, size, partition00 AS partition, validity FROM ${layout.shadow.chunks} ORDER BY chunk_id`).all() as Omit<VecChunkRow, "rowids">[])
    .map((chunk) => ({ ...chunk, live: liveSlots(chunk).length - (orphansByChunk.get(chunk.chunkId) ?? 0) }))
    .filter((chunk) => chunk.live > 0);
  const rowsByPartition = new Map<number, number>();
  const newestByPartition = new Map<number, number>();
  for (const chunk of chunks) {
    rowsByPartition.set(chunk.partition, (rowsByPartition.get(chunk.partition) ?? 0) + chunk.live);
    newestByPartition.set(chunk.partition, chunk.chunkId);
  }
  let rows = 0;
  let neededChunks = 0;
  for (const chunk of chunks) {
    if (newestByPartition.get(chunk.partition) !== chunk.chunkId) continue;
    const partitionRows = rowsByPartition.get(chunk.partition)!;
    rows += partitionRows;
    neededChunks += Math.ceil(partitionRows / chunk.size);
  }
  const occupancy = chunks.length > 0 ? neededChunks / chunks.length : 1;
  const sparse = chunks
    .filter((chunk) => newestByPartition.get(chunk.partition) !== chunk.chunkId && chunk.live < chunk.size * VEC_REPACK_CHUNK_FILL)
    .map((chunk) => chunk.chunkId);
  return { layout: { rows, chunks: chunks.length, neededChunks, occupancy }, sparse };
}

/** Whether a plan is worth running: the table's scans read mostly holes and some chunk would move. */
function repackWanted(plan: VecRepackPlan | null): plan is VecRepackPlan {
  return plan !== null && plan.layout.occupancy < VEC_REPACK_BELOW_OCCUPANCY && plan.sparse.length > 0;
}

/** Chunk layout of the vector table from vec0's shadow tables, or null without a readable table. */
export function vectorTableLayout(db: Database): VectorTableLayout | null {
  return vectorRepackPlan(db)?.layout ?? null;
}

function liveSlots(chunk: { size: number; validity: Uint8Array }): number[] {
  const slots: number[] = [];
  for (let i = 0; i < chunk.size; i++) {
    if ((chunk.validity[i >> 3]! >> (i & 7)) & 1) slots.push(i);
  }
  return slots;
}

/**
 * Compact the vector table in place: the live rows of every chunk that is
 * mostly holes are deleted and re-inserted under their rowid and partition,
 * one chunk per IMMEDIATE transaction. vec0 puts each insert in the first
 * free slot of its partition's newest chunk and drops a chunk once it is
 * empty, so the moved rows fill that partition's tail and the emptied chunks
 * vanish; each partition's newest chunk is left alone because that is where
 * its rows land. A transaction holds the write lock for at most one chunk of
 * rows, so concurrent embed and update runs interleave with it, and an
 * interrupted run leaves a consistent table that the next cleanup finishes.
 */
export function repackVectors(db: Database, onChunk?: (moved: number, total: number) => void): VectorTableLayout | null {
  const layout = readableVectorLayout(db);
  const plan = vectorRepackPlan(db);
  if (!layout || !plan) return null;
  const chunkOf = db.prepare(`SELECT chunk_id AS chunkId, size, partition00 AS partition, validity, rowids FROM ${layout.shadow.chunks} WHERE chunk_id = ?`);
  const newestOf = db.prepare(`SELECT MAX(chunk_id) AS chunkId FROM ${layout.shadow.chunks} WHERE partition00 = ?`);
  const vectorOf = db.prepare(`SELECT embedding FROM ${layout.table} WHERE rowid = ?`);
  const remove = db.prepare(`DELETE FROM ${layout.table} WHERE rowid = ?`);
  const insert = db.prepare(`INSERT INTO ${layout.table} (rowid, collection_id, embedding) VALUES (?, ?, ?)`);
  plan.sparse.forEach((chunkId, i) => {
    db.transaction(() => {
      // Read the chunk again under the write lock: since the plan was made, a
      // concurrent embed or update may have emptied it, made it its
      // partition's newest, or deleted a row whose rowid now belongs to
      // another partition.
      const chunk = chunkOf.get(chunkId) as VecChunkRow | undefined;
      if (!chunk) return;
      if ((newestOf.get(chunk.partition) as { chunkId: number }).chunkId === chunkId) return;
      const rowids = new DataView(chunk.rowids.buffer, chunk.rowids.byteOffset, chunk.rowids.byteLength);
      for (const slot of liveSlots(chunk)) {
        const rowid = rowids.getBigInt64(slot * 8, true);
        const row = vectorOf.get(rowid) as { embedding: Uint8Array } | undefined;
        if (row === undefined) continue;
        remove.run(rowid);
        insert.run(rowid, vecInteger(chunk.partition), row.embedding);
      }
    }).immediate();
    onChunk?.(i + 1, plan.sparse.length);
  });
  return vectorTableLayout(db);
}

/**
 * Run VACUUM to reclaim unused space in the database.
 * This operation rebuilds the database file to eliminate fragmentation.
 */
export function vacuumDatabase(db: Database): void {
  db.exec(`VACUUM`);
}

/**
 * Merge FTS5 b-trees so deleted rows (deactivated / hard-deleted documents)
 * leave `documents_fts_data`. VACUUM alone does not compact FTS5 (#550).
 */
export function optimizeDocumentsFts(db: Database): void {
  try {
    db.exec(`INSERT INTO documents_fts(documents_fts) VALUES('optimize')`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message)) return;
    throw error;
  }
}

export type CleanupStats = {
  cacheCount: number;
  orphanedVectors: number;
  inactiveDocs: number;
  orphanedContent: number;
  /** Chunk layout of the vector table before any repack, null without a vector table. */
  vectorLayout: VectorTableLayout | null;
  /** True when the vector table was repacked (or, in a preview, would be). */
  vectorsRepacked: boolean;
};

/** Counts what `runCleanup` would remove, including content only held by inactive docs. */
export function previewCleanup(db: Database): CleanupStats {
  const cacheCount = (db.prepare(`SELECT COUNT(*) as c FROM llm_cache`).get() as { c: number }).c;
  // Gated on the same probe as cleanupOrphanedVectors: without an actionable
  // vec table the run removes 0, so the preview promises 0 too (#768).
  // The status diagnostic count still uses countOrphanedVectors.
  const orphanedVectors = isVectorCleanupActionable(db) ? countOrphanedVectors(db) : 0;
  const inactiveDocs = (db.prepare(`SELECT COUNT(*) as c FROM documents WHERE active = 0`).get() as { c: number }).c;
  const orphanedContent = countOrphanedContent(db);
  const plan = vectorRepackPlan(db, true);
  return { cacheCount, orphanedVectors, inactiveDocs, orphanedContent, vectorLayout: plan?.layout ?? null, vectorsRepacked: repackWanted(plan) };
}

export type CleanupHooks = {
  /** Called with the layout right before a vector repack starts. */
  onVectorRepack?: (layout: VectorTableLayout) => void;
};

/**
 * Full `qmd cleanup` sequence: drop cache, orphaned vectors, repack the vector
 * table when its chunks are mostly holes, inactive document rows, then the
 * content those rows were pinning, compact FTS5, vacuum.
 */
export function runCleanup(db: Database, hooks: CleanupHooks = {}): CleanupStats {
  const cacheCount = deleteLLMCache(db);
  const orphanedVectors = cleanupOrphanedVectors(db);
  const plan = vectorRepackPlan(db);
  const vectorsRepacked = repackWanted(plan);
  if (vectorsRepacked) {
    hooks.onVectorRepack?.(plan.layout);
    repackVectors(db);
  }
  const inactiveDocs = deleteInactiveDocuments(db);
  const orphanedContent = cleanupOrphanedContent(db);
  optimizeDocumentsFts(db);
  vacuumDatabase(db);
  return { cacheCount, orphanedVectors, inactiveDocs, orphanedContent, vectorLayout: plan?.layout ?? null, vectorsRepacked };
}

// =============================================================================
// Document helpers
// =============================================================================

/**
 * Synchronous core of {@link hashContent}. Callers that hash while their write
 * batch holds the connection's transaction (collection scans, the CLI index
 * loop) must use this: awaiting a hash hands that transaction to whatever else
 * runs during the suspension.
 */
export function hashContentSync(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function hashContent(content: string): Promise<string> {
  return hashContentSync(content);
}

const titleExtractors: Record<string, (content: string) => string | null> = {
  '.md': (content) => {
    const match = content.match(/^##?\s+(.+)$/m);
    if (match) {
      const title = (match[1] ?? "").trim();
      if (title === "📝 Notes" || title === "Notes") {
        const nextMatch = content.match(/^##\s+(.+)$/m);
        if (nextMatch?.[1]) return nextMatch[1].trim();
      }
      return title;
    }
    return null;
  },
  '.org': (content) => {
    const titleProp = content.match(/^#\+TITLE:\s*(.+)$/im);
    if (titleProp?.[1]) return titleProp[1].trim();
    const heading = content.match(/^\*+\s+(.+)$/m);
    if (heading?.[1]) return heading[1].trim();
    return null;
  },
};

export function extractTitle(content: string, filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  const extractor = titleExtractors[ext];
  if (extractor) {
    const title = extractor(content);
    if (title) return title;
  }
  return filename.replace(/\.[^.]+$/, "").split("/").pop() || filename;
}

// =============================================================================
// Document indexing operations
// =============================================================================

/**
 * Insert content into the content table (content-addressable storage).
 * Uses INSERT OR IGNORE so duplicate hashes are skipped.
 */
export function insertContent(db: Database, hash: string, content: string, createdAt: string): void {
  db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)`)
    .run(hash, content, createdAt);
}

function rebuildDocumentFTS(db: Database, documentId: number): void {
  const row = db.prepare(`
    SELECT d.id, d.collection, d.path, d.title, content.doc as body
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE d.id = ? AND d.active = 1
  `).get(documentId) as { id: number; collection: string; path: string; title: string; body: string } | undefined;

  db.prepare(`DELETE FROM documents_fts WHERE rowid = ?`).run(documentId);
  if (!row) return;

  db.prepare(`
    INSERT INTO documents_fts(rowid, filepath, title, body)
    VALUES (?, ?, ?, ?)
  `).run(
    row.id,
    normalizeCjkForFTS(`${row.collection}/${row.path}`),
    normalizeCjkForFTS(row.title),
    normalizeCjkForFTS(row.body)
  );
}

/**
 * Insert a new document into the documents table.
 * Returns the document's id so callers can attach document-scoped state.
 */
export function insertDocument(
  db: Database,
  collectionName: string,
  path: string,
  title: string,
  hash: string,
  createdAt: string,
  modifiedAt: string
): number {
  db.prepare(`
    INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(collection, path) DO UPDATE SET
      title = excluded.title,
      hash = excluded.hash,
      modified_at = excluded.modified_at,
      active = 1
  `).run(collectionName, path, title, hash, createdAt, modifiedAt);

  const row = db.prepare(`SELECT id FROM documents WHERE collection = ? AND path = ?`).get(collectionName, path) as { id: number } | undefined;
  if (!row) throw new Error(`Document row missing after insert: ${collectionName}/${path}`);

  rebuildDocumentFTS(db, row.id);
  return row.id;
}

/**
 * Find an active document by collection name and path.
 */
export function findActiveDocument(
  db: Database,
  collectionName: string,
  path: string
): { id: number; hash: string; title: string } | null {
  const row = db.prepare(`
    SELECT id, hash, title FROM documents
    WHERE collection = ? AND path = ? AND active = 1
  `).get(collectionName, path) as { id: number; hash: string; title: string } | undefined;
  return row ?? null;
}

/**
 * Find an active document, falling back to a legacy handalized-path match.
 * If found under the pre-2.6 slug, renames it in-place and rebuilds the
 * FTS entry. Embeddings are keyed by content hash, so the rename is
 * safe — no re-embedding required.
 *
 * `livePaths`, when given, is the set of literal paths of every file in the
 * current scan of this collection. A legacy row whose path is in that set
 * belongs to a *different* file that still exists on disk, so it must never be
 * adopted — renaming it would evict that file from the index (#717).
 *
 * @internal Used by reindexCollection and indexFiles during qmd update.
 * Returns null if the document does not exist under either path.
 */
export function findOrMigrateLegacyDocument(
  db: Database,
  collectionName: string,
  path: string,
  livePaths?: ReadonlySet<string>
): { id: number; hash: string; title: string } | null {
  const existing = findActiveDocument(db, collectionName, path);
  if (existing) return existing;

  // Do not use a case-insensitive fallback here. Case-sensitive filesystems can
  // contain distinct paths such as `README.md` and `readme.md`; collapsing them
  // makes one document disappear on every update. Legacy case-only migrations
  // require an explicit, operator-reviewed migration instead of implicit lookup.

  // Handalized-path match: existing DBs indexed with handelize() stored slugged paths
  // like "Budget-Revenue-Q4-2024.md" for a raw path like "Budget & Revenue (Q4) [2024].md".
  // Try matching the handalized form of the incoming raw path against the DB so that
  // qmd update on an old index can rename the row to the literal path.
  //
  // Many literal paths map onto the same slug ("a b.md", "a_b.md", "a-b.md"), so
  // a match is only evidence of a stale row when no live file already owns that
  // path. Without this guard, indexing "2026_06_16.md" next to an existing
  // "2026-06-16.md" renames the latter's row and the hyphenated file silently
  // disappears from the index (#717).
  type LegacyRow = { id: number; hash: string; title: string; path: string };
  let legacyHandalized: LegacyRow | undefined;
  try {
    const handleized = handelize(path);
    if (handleized !== path) {
      const row = db.prepare(`
        SELECT id, hash, title, path FROM documents
        WHERE collection = ? AND path = ? AND active = 1
        ORDER BY id
        LIMIT 1
      `).get(collectionName, handleized) as LegacyRow | undefined;
      if (row && !livePaths?.has(row.path)) legacyHandalized = row;
    }
  } catch {
    // handelize throws on invalid paths; just skip
  }

  const legacy = legacyHandalized;
  if (!legacy) return null;

  // Wrap rename + FTS rebuild in a transaction for atomicity.
  const migrate = db.transaction(() => {
    // Use OR IGNORE so a UNIQUE conflict (e.g. both "readme.md" and
    // "README.md" already exist) is a no-op rather than crashing.
    const result = db.prepare(
      `UPDATE OR IGNORE documents SET path = ? WHERE id = ? AND active = 1`
    ).run(path, legacy.id);

    if (result.changes === 0) return false;

    rebuildDocumentFTS(db, legacy.id);

    return true;
  });

  if (!migrate()) return null;

  return findActiveDocument(db, collectionName, path);
}

/**
 * Update the title and modified_at timestamp for a document.
 *
 * Title-only fast path: callers invoke this only when the content hash is
 * unchanged, so the body needs no re-tokenization. The documents_au sync
 * trigger is scoped to (collection, path, hash, active) and does not fire
 * for this write, so a single FTS title UPDATE preserves the existing
 * normalized filepath/body — skipping both the body re-normalization and
 * the redundant raw DELETE+INSERT rewrite (~5ms per 105KB document).
 * When no FTS row exists, fall back to a full rebuild so the title is still
 * indexed (and any orphan row is cleaned up, as before).
 */
export function updateDocumentTitle(
  db: Database,
  documentId: number,
  title: string,
  modifiedAt: string
): void {
  db.prepare(`UPDATE documents SET title = ?, modified_at = ? WHERE id = ?`)
    .run(title, modifiedAt, documentId);
  const updated = db.prepare(`UPDATE documents_fts SET title = ? WHERE rowid = ?`)
    .run(normalizeCjkForFTS(title), documentId);
  if (updated.changes === 0) {
    rebuildDocumentFTS(db, documentId);
  }
}

/**
 * Update an existing document's hash, title, and modified_at timestamp.
 * Used when content changes but the file path stays the same.
 */
export function updateDocument(
  db: Database,
  documentId: number,
  title: string,
  hash: string,
  modifiedAt: string
): void {
  db.prepare(`UPDATE documents SET title = ?, hash = ?, modified_at = ? WHERE id = ?`)
    .run(title, hash, modifiedAt, documentId);
  rebuildDocumentFTS(db, documentId);
}

/**
 * Deactivate a document (mark as inactive but don't delete).
 */
export function deactivateDocument(db: Database, collectionName: string, path: string): void {
  db.prepare(`UPDATE documents SET active = 0 WHERE collection = ? AND path = ? AND active = 1`)
    .run(collectionName, path);
}

/**
 * Get all active document paths for a collection.
 */
export function getActiveDocumentPaths(db: Database, collectionName: string): string[] {
  const stmt = db.prepare(`
    SELECT path FROM documents WHERE collection = ? AND active = 1
  `);
  // Large-result query (up to 5k per collection): use iterate() to bound heap
  const paths: string[] = [];
  for (const r of stmt.iterate(collectionName) as IterableIterator<{ path: string }>) {
    paths.push(r.path);
  }
  return paths;
}

export { formatQueryForEmbedding, formatDocForEmbedding };

/**
 * Chunk a document using regex-only break point detection.
 * This is the sync, backward-compatible API used by tests and legacy callers.
 */
export function chunkDocument(
  content: string,
  maxChars: number = CHUNK_SIZE_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  windowChars: number = CHUNK_WINDOW_CHARS
): { text: string; pos: number }[] {
  const breakPoints = scanBreakPoints(content);
  const codeFences = findCodeFences(content);
  return chunkDocumentWithBreakPoints(content, breakPoints, codeFences, maxChars, overlapChars, windowChars);
}

/**
 * Async AST-aware chunking. Detects language from filepath, computes AST
 * break points for supported code files, merges with regex break points,
 * and delegates to the shared chunk algorithm.
 *
 * Falls back to regex-only when strategy is "regex", filepath is absent,
 * or language is unsupported.
 */
export async function chunkDocumentAsync(
  content: string,
  maxChars: number = CHUNK_SIZE_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  windowChars: number = CHUNK_WINDOW_CHARS,
  filepath?: string,
  chunkStrategy: ChunkStrategy = "regex",
): Promise<{ text: string; pos: number }[]> {
  const regexPoints = scanBreakPoints(content);
  const codeFences = findCodeFences(content);

  let breakPoints = regexPoints;
  if (chunkStrategy === "auto" && filepath) {
    const { getASTBreakPoints } = await import("./ast.js");
    const astPoints = await getASTBreakPoints(content, filepath);
    if (astPoints.length > 0) {
      breakPoints = mergeBreakPoints(regexPoints, astPoints);
    }
  }

  return chunkDocumentWithBreakPoints(content, breakPoints, codeFences, maxChars, overlapChars, windowChars);
}

/**
 * Strips any unpaired surrogate at the start or end of `text`, so the
 * result is always well-formed UTF-16. Handles all four ways a lone
 * surrogate can sit at a boundary:
 *   - leading lone low surrogate (never valid as the first unit of a pair)
 *   - leading lone high surrogate NOT followed by a matching low surrogate
 *     (a leading high surrogate that IS followed by its low surrogate is a
 *     complete, valid pair and must be left alone)
 *   - trailing lone high surrogate (never valid as the last unit of a pair)
 *   - trailing lone low surrogate NOT preceded by a matching high surrogate
 *     (mirrors the leading-high case)
 *
 * Defense-in-depth for chunkDocumentByTokens: chunkDocumentWithBreakPoints
 * (via chunkDocument) never itself produces a split surrogate pair (see
 * adjustSurrogateBoundary), but a lone surrogate can already be present in
 * the source document (unrelated upstream encoding bug) and land at an
 * ordinary chunk boundary by coincidence, and the tokenizer's detokenize()
 * truncation fallback below reconstructs text from raw token IDs — a
 * different code path chunk-boundary adjustment doesn't cover, since a
 * tokenizer is free to encode a single astral-plane character as multiple
 * tokens and truncate between them.
 */
function stripUnpairedSurrogates(text: string): string {
  let start = 0;
  let end = text.length;
  if (end > 0) {
    const first = text.charCodeAt(0);
    const firstIsLow = first >= 0xdc00 && first <= 0xdfff;
    const firstIsHigh = first >= 0xd800 && first <= 0xdbff;
    if (firstIsLow) {
      start = 1;
    } else if (firstIsHigh) {
      const second = end > 1 ? text.charCodeAt(1) : NaN;
      const secondIsLow = second >= 0xdc00 && second <= 0xdfff;
      if (!secondIsLow) start = 1;
    }
  }
  if (end > start) {
    const last = text.charCodeAt(end - 1);
    const lastIsHigh = last >= 0xd800 && last <= 0xdbff;
    const lastIsLow = last >= 0xdc00 && last <= 0xdfff;
    if (lastIsHigh) {
      end -= 1;
    } else if (lastIsLow) {
      const prev = end - 1 > start ? text.charCodeAt(end - 2) : NaN;
      const prevIsHigh = prev >= 0xd800 && prev <= 0xdbff;
      if (!prevIsHigh) end -= 1;
    }
  }
  return start === 0 && end === text.length ? text : text.slice(start, end);
}

/**
 * Character budgets for one chunking pass, sized from the text's script makeup.
 * One definition so indexing and both search-path best-chunk selections stay in
 * lockstep — a drift here would desync reranker inputs from indexed chunks.
 *
 * `otherCharsPerToken` is the ratio the call site used before this became
 * script-aware, so non-CJK text keeps its old boundaries: indexing sized its
 * first pass at 3.0, the search paths at `CHUNK_SIZE_CHARS / CHUNK_SIZE_TOKENS`.
 *
 * Budgets are floored. `chunkDocumentWithBreakPoints` subtracts `overlapChars`
 * from a chunk end to get the next chunk's `pos`, and that `pos` is persisted
 * into `content_vectors.pos` (INTEGER affinity) and later used as a slice
 * offset by `extractSnippet`; a fractional budget would carry through as a
 * fractional offset. The pre-change budgets were always integers.
 */
function scriptAwareCharBudgets(
  content: string,
  maxTokens: number = CHUNK_SIZE_TOKENS,
  overlapTokens: number = CHUNK_OVERLAP_TOKENS,
  windowTokens: number = CHUNK_WINDOW_TOKENS,
  otherCharsPerToken?: number,
): { maxChars: number; overlapChars: number; windowChars: number } {
  const charsPerToken = estimateCharsPerToken(content, otherCharsPerToken);
  return {
    maxChars: Math.floor(maxTokens * charsPerToken),
    overlapChars: Math.floor(overlapTokens * charsPerToken),
    windowChars: Math.floor(windowTokens * charsPerToken),
  };
}

/** The chars/token the search-path best-chunk selection used before it became script-aware. */
const SEARCH_PATH_OTHER_CHARS_PER_TOKEN = CHUNK_SIZE_CHARS / CHUNK_SIZE_TOKENS;

/**
 * Chunk a document by actual token count using the LLM tokenizer.
 * More accurate than character-based chunking but requires async.
 *
 * When filepath and chunkStrategy are provided, uses AST-aware break points
 * for supported code files.
 */
async function chunkDocumentByTokensWithLlm(
  llm: LlamaCpp,
  content: string,
  maxTokens: number = CHUNK_SIZE_TOKENS,
  overlapTokens: number = CHUNK_OVERLAP_TOKENS,
  windowTokens: number = CHUNK_WINDOW_TOKENS,
  filepath?: string,
  chunkStrategy: ChunkStrategy = "regex",
  signal?: AbortSignal
): Promise<{ text: string; pos: number; tokens: number }[]> {
  if (llm.embedModelName?.startsWith("remote-openai:")) {
    signal?.throwIfAborted();
    // Fixed remote format v1: the existing surrogate-safe character chunker,
    // never a local tokenizer or token-truncation pass. Tokens are estimates.
    return chunkDocument(content, CHUNK_SIZE_CHARS, CHUNK_OVERLAP_CHARS, CHUNK_WINDOW_CHARS)
      .map(chunk => ({ ...chunk, tokens: Math.ceil(chunk.text.length / 4) }));
  }
  // Script-aware chars/token estimate from the document's own text: CJK prose
  // measures 1.64 chars/token on Qwen3-Embedding-0.6B-Q8_0 (2026-09-21, ko
  // 1380 chars / 842 tokens) while English measures 6.08 (2680 / 441) but
  // keeps the historical 3.0 so English chunk boundaries do not move. Chunks
  // still over the limit are re-split below with the actual ratio — that loop
  // is the safety net for documents the estimate got wrong.
  const { maxChars, overlapChars, windowChars } = scriptAwareCharBudgets(content, maxTokens, overlapTokens, windowTokens);

  // Chunk in character space with conservative estimate
  // Use AST-aware chunking for the first pass when filepath/strategy provided
  let charChunks = await chunkDocumentAsync(content, maxChars, overlapChars, windowChars, filepath, chunkStrategy);

  // Tokenize and split any chunks that still exceed limit
  const results: { text: string; pos: number; tokens: number }[] = [];
  const clampOverlapChars = (value: number, maxChars: number): number => {
    if (maxChars <= 1) return 0;
    return Math.max(0, Math.min(maxChars - 1, Math.floor(value)));
  };

  const pushChunkWithinTokenLimit = async (text: string, pos: number): Promise<void> => {
    if (signal?.aborted) return;

    const tokens = await llm.tokenize(text);
    if (tokens.length <= maxTokens || text.length <= 1) {
      // Safety net: text.length <= 1 can only legitimately be a single
      // BMP character (a well-formed astral character needs 2 code units),
      // so this only ever strips something for already-malformed input.
      const safeText = stripUnpairedSurrogates(text);
      if (safeText.length === 0) return;
      results.push({ text: safeText, pos, tokens: tokens.length });
      return;
    }

    const actualCharsPerToken = text.length / tokens.length;
    let safeMaxChars = Math.floor(maxTokens * actualCharsPerToken * 0.95);
    if (!Number.isFinite(safeMaxChars) || safeMaxChars < 1) {
      safeMaxChars = Math.floor(text.length / 2);
    }
    safeMaxChars = Math.max(1, Math.min(text.length - 1, safeMaxChars));

    let nextOverlapChars = clampOverlapChars(
      overlapChars * actualCharsPerToken / 2,
      safeMaxChars,
    );
    let nextWindowChars = Math.max(0, Math.floor(windowChars * actualCharsPerToken / 2));
    let subChunks = chunkDocument(text, safeMaxChars, nextOverlapChars, nextWindowChars);

    // Pathological single-line blobs can produce no meaningful breakpoint progress.
    // Fall back to a simple half split so every recursion step strictly shrinks.
    if (
      subChunks.length <= 1
      || subChunks[0]?.text.length === text.length
    ) {
      safeMaxChars = Math.max(1, Math.floor(text.length / 2));
      nextOverlapChars = 0;
      nextWindowChars = 0;
      subChunks = chunkDocument(text, safeMaxChars, nextOverlapChars, nextWindowChars);
    }

    if (
      subChunks.length <= 1
      || subChunks[0]?.text.length === text.length
    ) {
      const fallbackTokens = tokens.slice(0, Math.max(1, maxTokens));
      // Safety net: detokenize() reconstructs text from raw token IDs, and
      // a tokenizer can encode a single astral-plane character across
      // multiple tokens — truncating the token list can land mid-character.
      const truncatedText = stripUnpairedSurrogates(await llm.detokenize(fallbackTokens));
      if (truncatedText.length === 0) return;
      results.push({
        text: truncatedText,
        pos,
        tokens: fallbackTokens.length,
      });
      return;
    }

    for (const subChunk of subChunks) {
      await pushChunkWithinTokenLimit(text.slice(subChunk.pos, subChunk.pos + subChunk.text.length), pos + subChunk.pos);
    }
  };

  for (const chunk of charChunks) {
    await pushChunkWithinTokenLimit(chunk.text, chunk.pos);
  }

  return results;
}

export async function chunkDocumentByTokens(
  content: string,
  maxTokens: number = CHUNK_SIZE_TOKENS,
  overlapTokens: number = CHUNK_OVERLAP_TOKENS,
  windowTokens: number = CHUNK_WINDOW_TOKENS,
  filepath?: string,
  chunkStrategy: ChunkStrategy = "regex",
  signal?: AbortSignal,
): Promise<{ text: string; pos: number; tokens: number }[]> {
  return await chunkDocumentByTokensWithLlm(
    getDefaultLlamaCpp(),
    content,
    maxTokens,
    overlapTokens,
    windowTokens,
    filepath,
    chunkStrategy,
    signal,
  );
}

// =============================================================================
// Fuzzy matching
// =============================================================================

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost
      );
    }
  }
  return dp[m]![n]!;
}

/**
 * Normalize a docid input by stripping surrounding quotes and leading #.
 * Handles: "#abc123", 'abc123', "abc123", #abc123, abc123
 * Returns the bare hex string.
 */
export function normalizeDocid(docid: string): string {
  let normalized = docid.trim();

  // Strip surrounding quotes (single or double)
  if ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))) {
    normalized = normalized.slice(1, -1);
  }

  // Strip leading # if present
  if (normalized.startsWith('#')) {
    normalized = normalized.slice(1);
  }

  return normalized;
}

/**
 * Check if a string looks like a docid reference.
 * Accepts: #abc123, abc123, "#abc123", "abc123", '#abc123', 'abc123'
 * Returns true if the normalized form is a valid hex string of 6+ chars.
 */
export function isDocid(input: string): boolean {
  const normalized = normalizeDocid(input);
  // Must be at least 6 hex characters
  return normalized.length >= 6 && /^[a-f0-9]+$/i.test(normalized);
}

/**
 * Find a document by its short docid (first 6 characters of hash).
 * Returns the document's virtual path if found, null otherwise.
 * If multiple documents match the same short hash (collision), returns the first one.
 *
 * Accepts lenient input: #abc123, abc123, "#abc123", "abc123"
 */
export function findDocumentByDocid(db: Database, docid: string): { filepath: string; hash: string } | null {
  const shortHash = normalizeDocid(docid);

  if (shortHash.length < 1) return null;

  // Look up documents where hash starts with the short hash
  const doc = db.prepare(`
    SELECT 'qmd://' || d.collection || '/' || d.path as filepath, d.hash
    FROM documents d
    WHERE d.hash LIKE ? AND d.active = 1
    LIMIT 1
  `).get(`${shortHash}%`) as { filepath: string; hash: string } | null;

  return doc;
}

export function findSimilarFiles(db: Database, query: string, maxDistance: number = 3, limit: number = 5): string[] {
  const stmt = db.prepare(`
    SELECT d.path
    FROM documents d
    WHERE d.active = 1
  `);
  // Large-result query (all active docs, up to 9k): iterate to bound heap
  const queryLower = query.toLowerCase();
  const scored: { path: string; dist: number }[] = [];
  for (const f of stmt.iterate() as IterableIterator<{ path: string }>) {
    const dist = levenshtein(f.path.toLowerCase(), queryLower);
    if (dist <= maxDistance) scored.push({ path: f.path, dist });
  }
  return scored
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit)
    .map(f => f.path);
}

export function matchFilesByGlob(db: Database, pattern: string): { filepath: string; displayPath: string; bodyLength: number }[] {
  const stmt = db.prepare(`
    SELECT
      'qmd://' || d.collection || '/' || d.path as virtual_path,
      octet_length(content.doc) as body_length,
      d.path,
      d.collection
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE d.active = 1
  `);
  // Large-result query: iterate to bound heap (all active docs)
  const isMatch = picomatch(pattern);
  const results: { filepath: string; displayPath: string; bodyLength: number }[] = [];
  for (const f of stmt.iterate() as IterableIterator<{ virtual_path: string; body_length: number; path: string; collection: string }>) {
    if (isMatch(f.virtual_path) || isMatch(f.path) || isMatch(f.collection + '/' + f.path)) {
      results.push({
        filepath: f.virtual_path,
        displayPath: f.path,
        bodyLength: f.body_length,
      });
    }
  }
  return results;
}

// =============================================================================
// Context
// =============================================================================

/**
 * Get context for a file path using hierarchical inheritance.
 * Contexts are collection-scoped and inherit from parent directories.
 * For example, context at "/talks" applies to "/talks/2024/keynote.md".
 *
 * @param db Database instance (unused - kept for compatibility)
 * @param collectionName Collection name
 * @param path Relative path within the collection
 * @returns Context string or null if no context is defined
 */
export function getContextForPath(db: Database, collectionName: string, path: string): string | null {
  const coll = getStoreCollection(db, collectionName);

  if (!coll) return null;

  // Collect ALL matching contexts (global + all path prefixes)
  const contexts: string[] = [];

  // Add global context if present
  const globalCtx = getStoreGlobalContext(db);
  if (globalCtx) {
    contexts.push(globalCtx);
  }

  // Add all matching path contexts (from most general to most specific)
  if (coll.context) {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;

    // Collect all matching prefixes
    const matchingContexts: { prefix: string; context: string }[] = [];
    for (const [prefix, context] of Object.entries(coll.context)) {
      const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
      if (normalizedPath.startsWith(normalizedPrefix)) {
        matchingContexts.push({ prefix: normalizedPrefix, context });
      }
    }

    // Sort by prefix length (shortest/most general first)
    matchingContexts.sort((a, b) => a.prefix.length - b.prefix.length);

    // Add all matching contexts
    for (const match of matchingContexts) {
      contexts.push(match.context);
    }
  }

  // Join all contexts with double newline
  return contexts.length > 0 ? contexts.join('\n\n') : null;
}

/**
 * Get context for a file path (virtual or filesystem).
 * Resolves the collection and relative path from the DB store_collections table.
 */
export function getContextForFile(db: Database, filepath: string): string | null {
  // Handle undefined or null filepath
  if (!filepath) return null;

  // Get all collections from DB
  const collections = getStoreCollections(db);

  // Parse virtual path format: qmd://collection/path
  let collectionName: string | null = null;
  let relativePath: string | null = null;

  const parsedVirtual = filepath.startsWith('qmd://') ? parseVirtualPath(filepath) : null;
  if (parsedVirtual) {
    collectionName = parsedVirtual.collectionName;
    relativePath = parsedVirtual.path;
  } else {
    // Filesystem path: find which collection this absolute path belongs to
    for (const coll of collections) {
      // Skip collections with missing paths
      if (!coll || !coll.path) continue;

      if (filepath.startsWith(coll.path + '/') || filepath === coll.path) {
        collectionName = coll.name;
        // Extract relative path
        relativePath = filepath.startsWith(coll.path + '/')
          ? filepath.slice(coll.path.length + 1)
          : '';
        break;
      }
    }

    if (!collectionName || relativePath === null) return null;
  }

  // Get the collection from DB
  const coll = getStoreCollection(db, collectionName);
  if (!coll) return null;

  // Verify this document exists in the database
  const doc = db.prepare(`
    SELECT d.path
    FROM documents d
    WHERE d.collection = ? AND d.path = ? AND d.active = 1
    LIMIT 1
  `).get(collectionName, relativePath) as { path: string } | null;

  if (!doc) return null;

  // Collect ALL matching contexts (global + all path prefixes)
  const contexts: string[] = [];

  // Add global context if present
  const globalCtx = getStoreGlobalContext(db);
  if (globalCtx) {
    contexts.push(globalCtx);
  }

  // Add all matching path contexts (from most general to most specific)
  if (coll.context) {
    const normalizedPath = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;

    // Collect all matching prefixes
    const matchingContexts: { prefix: string; context: string }[] = [];
    for (const [prefix, context] of Object.entries(coll.context)) {
      const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
      if (normalizedPath.startsWith(normalizedPrefix)) {
        matchingContexts.push({ prefix: normalizedPrefix, context });
      }
    }

    // Sort by prefix length (shortest/most general first)
    matchingContexts.sort((a, b) => a.prefix.length - b.prefix.length);

    // Add all matching contexts
    for (const match of matchingContexts) {
      contexts.push(match.context);
    }
  }

  // Join all contexts with double newline
  return contexts.length > 0 ? contexts.join('\n\n') : null;
}

/**
 * Batch version of {@link getContextForFile}: one collections fetch, one
 * global-context fetch and one document-existence query for the whole batch
 * instead of three per file. Context assembly per file is identical.
 */
export function getContextsForFiles(db: Database, filepaths: string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const uniq = [...new Set(filepaths.filter(Boolean))];
  if (uniq.length === 0) return out;
  const collections = getStoreCollections(db);
  const byName = new Map(collections.map((c) => [c.name, c]));
  const globalCtx = getStoreGlobalContext(db);
  const parsed: { fp: string; cn: string; rp: string }[] = [];
  for (const fp of uniq) {
    const v = fp.startsWith("qmd://") ? parseVirtualPath(fp) : null;
    if (v) {
      parsed.push({ fp, cn: v.collectionName, rp: v.path });
      continue;
    }
    for (const coll of collections) {
      if (!coll || !coll.path) continue;
      if (fp === coll.path) {
        parsed.push({ fp, cn: coll.name, rp: "" });
        break;
      }
      if (fp.startsWith(coll.path + "/")) {
        parsed.push({ fp, cn: coll.name, rp: fp.slice(coll.path.length + 1) });
        break;
      }
    }
  }
  const existing = new Set<string>();
  // Chunked: --all can hand us a six-figure batch and SQLite caps bound parameters.
  for (let i = 0; i < parsed.length; i += 500) {
    const chunk = parsed.slice(i, i + 500);
    const rows = db.prepare(
      `SELECT collection, path FROM documents WHERE active = 1 AND (collection, path) IN (VALUES ${chunk.map(() => "(?, ?)").join(", ")})`,
    ).all(...chunk.flatMap((p) => [p.cn, p.rp])) as { collection: string; path: string }[];
    for (const r of rows) existing.add(`${r.collection}\n${r.path}`);
  }
  for (const p of parsed) {
    const contexts: string[] = [];
    const coll = byName.get(p.cn);
    if (coll && existing.has(`${p.cn}\n${p.rp}`)) {
      if (globalCtx) contexts.push(globalCtx);
      if (coll.context) {
        const normalizedPath = p.rp.startsWith("/") ? p.rp : `/${p.rp}`;
        const matching: { prefix: string; context: string }[] = [];
        for (const [prefix, context] of Object.entries(coll.context)) {
          const np = prefix.startsWith("/") ? prefix : `/${prefix}`;
          if (normalizedPath.startsWith(np)) matching.push({ prefix: np, context });
        }
        matching.sort((a, b) => a.prefix.length - b.prefix.length);
        for (const m of matching) contexts.push(m.context);
      }
    }
    out.set(p.fp, contexts.length > 0 ? contexts.join("\n\n") : null);
  }
  for (const fp of uniq) {
    if (!out.has(fp)) out.set(fp, null);
  }
  return out;
}

/**
 * Get collection by name from DB store_collections table.
 */
export function getCollectionByName(db: Database, name: string): { name: string; pwd: string; glob_pattern: string } | null {
  const collection = getStoreCollection(db, name);
  if (!collection) return null;

  return {
    name: collection.name,
    pwd: collection.path,
    glob_pattern: collection.pattern,
  };
}

/**
 * List all collections with document counts from database.
 * Merges store_collections config with database statistics.
 */
export function listCollections(db: Database): { name: string; pwd: string; glob_pattern: string; doc_count: number; active_count: number; last_modified: string | null; includeByDefault: boolean }[] {
  const collections = getStoreCollections(db);

  // Get document counts from database for each collection
  const result = collections.map(coll => {
    const stats = db.prepare(`
      SELECT
        COUNT(d.id) as doc_count,
        SUM(CASE WHEN d.active = 1 THEN 1 ELSE 0 END) as active_count,
        MAX(d.modified_at) as last_modified
      FROM documents d
      WHERE d.collection = ?
    `).get(coll.name) as { doc_count: number; active_count: number; last_modified: string | null } | null;

    return {
      name: coll.name,
      pwd: coll.path,
      glob_pattern: coll.pattern,
      doc_count: stats?.doc_count || 0,
      active_count: stats?.active_count || 0,
      last_modified: stats?.last_modified || null,
      includeByDefault: coll.includeByDefault !== false,
    };
  });

  return result;
}

/**
 * Drop a collection's vector partition and its id. With the vec0 table
 * present but sqlite-vec not loaded, the rows stay for cleanupOrphanedVectors
 * to remove once the extension loads, so the mapping never runs ahead of the
 * index.
 */
function deleteVectorPartition(db: Database, collectionName: string): void {
  const collectionId = resolveCollectionId(db, collectionName);
  if (collectionId === undefined) return;
  const layout = vecLayout(db);
  if (layout.kind === "legacy") return;
  if (layout.kind === "partitioned") {
    if (!isSqliteVecAvailable()) return;
    db.prepare(`DELETE FROM ${VEC_TABLE} WHERE collection_id = ?`).run(vecInteger(collectionId));
  }
  db.prepare(`DELETE FROM ${VEC_ROWS_TABLE} WHERE collection_id = ?`).run(collectionId);
  deleteCollectionId(db, collectionName);
}

/**
 * Whether the index holds documents under this collection name.
 *
 * A rename target that owns documents is a real collection, not a name a config
 * sync reserved from an already published file. See
 * {@link assertRenameTargetAvailable}.
 */
function hasCollectionDocuments(db: Database, name: string): boolean {
  // Loose comparison: bun:sqlite returns null for "no row" and better-sqlite3
  // returns undefined, so `!== undefined` reported every name as populated.
  return db.prepare(`SELECT 1 FROM documents WHERE collection = ? LIMIT 1`).get(name) != null;
}

/**
 * Whether the index still holds anything keyed by this collection name:
 * documents, sync rows, processor state or a vector partition.
 *
 * The store_collections row is deliberately excluded. A config sync writes that
 * row straight from the configuration, so a removal or rename whose index half
 * failed — or that crashed between publishing the file and moving the index —
 * leaves the state below under the old name while the row already reflects the
 * published file. Re-running the command finishes that state; see
 * {@link reconcilePublishedRename}.
 */
export function hasCollectionIndexState(db: Database, name: string): boolean {
  // Loose comparison again: null from bun:sqlite, undefined from
  // better-sqlite3 for "no row".
  const hasRow = (sql: string): boolean => db.prepare(sql).get(name) != null;
  return (
    hasCollectionDocuments(db, name)
    || hasRow(`SELECT 1 FROM file_sync_state WHERE collection = ? LIMIT 1`)
    || hasRow(`SELECT 1 FROM processor_specs WHERE collection = ? LIMIT 1`)
    || hasRow(`SELECT 1 FROM processor_modes WHERE collection = ? LIMIT 1`)
    || hasRow(`SELECT 1 FROM processor_outputs WHERE collection = ? LIMIT 1`)
    || hasRow(`SELECT 1 FROM processor_sources WHERE collection = ? LIMIT 1`)
    || resolveCollectionId(db, name) !== undefined
  );
}

/**
 * Refuse a rename whose target the index cannot take: a populated collection of
 * that name, or a removed collection of that name whose vector partition only a
 * sqlite-vec loaded build can drop.
 *
 * A caller that publishes the configuration before renaming the index calls
 * this first, so an ordinary refusal happens before the file changes. A target
 * row with no documents is not a refusal: a config sync writes rows from the
 * already published file, and {@link reconcilePublishedRename} finishes that
 * rename instead.
 */
export function assertRenameTargetAvailable(db: Database, newName: string): void {
  if (hasCollectionDocuments(db, newName)) {
    throw new Error(`Collection '${newName}' already exists`);
  }
  if (resolveCollectionId(db, newName) !== undefined && !isSqliteVecAvailable()) {
    throw new Error(
      `Cannot rename to '${newName}': a removed collection of that name still has a vector partition, which only qmd with sqlite-vec loaded can drop. ` +
      `Open qmd with sqlite-vec loaded and retry the rename.`
    );
  }
}

/**
 * Move every name-keyed index structure from `oldName` to `newName`:
 * documents, sync rows, the vector partition id and processor state.
 *
 * A removed collection keeps its id while sqlite-vec is not loaded to drop its
 * partition; the renamed collection's id cannot take that name.
 */
function moveCollectionNameInIndex(db: Database, oldName: string, newName: string): void {
  if (resolveCollectionId(db, newName) !== undefined) {
    deleteVectorPartition(db, newName);
    if (resolveCollectionId(db, newName) !== undefined) {
      throw new Error(
        `Cannot rename to '${newName}': a removed collection of that name still has a vector partition, which only qmd with sqlite-vec loaded can drop. ` +
        `Open qmd with sqlite-vec loaded and retry the rename.`
      );
    }
  }

  db.prepare(`UPDATE documents SET collection = ? WHERE collection = ?`).run(newName, oldName);
  // The documents keep their ids and paths, so their sync rows stay valid
  // under the new name. Rows already under it belong to no collection.
  db.prepare(`DELETE FROM file_sync_state WHERE collection = ?`).run(newName);
  db.prepare(`UPDATE file_sync_state SET collection = ? WHERE collection = ?`).run(newName, oldName);
  renameCollectionId(db, oldName, newName);
  renameProcessorState(db, oldName, newName);
}

/**
 * Remove a collection: its vector partition, its documents, the content no
 * active document references any more, and its store_collections row. Safe to
 * repeat: every step is keyed by the name, so finishing a removal that a
 * later config sync already dropped the row for still deletes what is left.
 */
export function removeCollection(db: Database, collectionName: string): { deletedDocs: number; cleanedHashes: number } {
  // One commit: a partition delete that lands without the documents delete
  // leaves the mapping and id row out of step with the vec0 table, and the
  // update-time orphan cleanup skips rows whose documents are still active.
  return db.transaction(() => {
    deleteVectorPartition(db, collectionName);

    // Statement.changes counts FTS trigger/shadow writes as well as the row
    // itself, so it cannot report document rows. Count them instead.
    const docsBefore = (db.prepare(`SELECT COUNT(*) as c FROM documents WHERE collection = ?`).get(collectionName) as { c: number }).c;

    db.prepare(`DELETE FROM documents WHERE collection = ?`).run(collectionName);
    db.prepare(`DELETE FROM file_sync_state WHERE collection = ?`).run(collectionName);
    removeProcessorState(db, collectionName);

    // Clean up orphaned content hashes with the same conservative predicate as
    // cleanupOrphanedContent(): only hashes with no remaining document rows —
    // including inactive tombstones — are removed. The old active-only filter
    // dropped content still pinned by other collections' tombstones, and the
    // content→documents FK CASCADE then hard-deleted those tombstone rows.
    // Counted, not read from Statement.changes, for the same reason as docsBefore.
    const contentCount = () => (db.prepare(`SELECT COUNT(*) as c FROM content`).get() as { c: number }).c;
    const contentBefore = contentCount();
    cleanupOrphanedContent(db);
    const cleanedHashes = contentBefore - contentCount();

    deleteStoreCollection(db, collectionName);

    const docsAfter = (db.prepare(`SELECT COUNT(*) as c FROM documents WHERE collection = ?`).get(collectionName) as { c: number }).c;

    return {
      deletedDocs: docsBefore - docsAfter,
      cleanedHashes,
    };
  }).immediate();
}

/**
 * Rename a collection: its documents, its vector partition id, and its
 * store_collections row. Throws when the target row already exists.
 */
export function renameCollection(db: Database, oldName: string, newName: string): void {
  // One commit: the vector id name is UNIQUE, so a rename that fails after
  // the documents moved would leave them under a name whose partition id
  // still belongs to the old one, and vector search would miss them.
  db.transaction(() => {
    renameStoreCollection(db, oldName, newName);
    moveCollectionNameInIndex(db, oldName, newName);
  }).immediate();
}

/**
 * Finish a rename whose configuration was already published: move whatever the
 * index still holds under `oldName` to `newName`.
 *
 * This is the recovery path for a rename interrupted after its file publish —
 * by a failed index commit or by a crash — and it is idempotent. The caller
 * must only invoke it with evidence of that specific rename (the configuration
 * scope's pending-rename marker, or the publication it just made): "the file no
 * longer lists the old name and lists another name" is not evidence, because
 * that other name may be an unrelated collection and moving documents into it
 * would corrupt its ownership.
 *
 * A config sync may already have written the target row from the published file
 * while the documents were still under the old name, so an existing target row
 * is not a conflict here; a target that owns documents is, and is refused
 * rather than merged. Returns whether the index held anything under either name.
 *
 * The configuration stays authoritative: if this throws, the file already
 * reflects the rename and re-running the same rename finishes it.
 */
export function reconcilePublishedRename(db: Database, oldName: string, newName: string): boolean {
  return db.transaction(() => {
    const target = getStoreCollection(db, newName);
    const touched =
      hasCollectionIndexState(db, oldName)
      || getStoreCollection(db, oldName) !== null
      || target !== null;

    if (target !== null) {
      // The target row is what the published file says; the old row is stale.
      if (hasCollectionDocuments(db, newName)) {
        throw new Error(`Collection '${newName}' already exists`);
      }
      deleteStoreCollection(db, oldName);
    } else {
      renameStoreCollection(db, oldName, newName);
    }

    moveCollectionNameInIndex(db, oldName, newName);
    return touched;
  }).immediate();
}

// =============================================================================
// Context Management Operations
// =============================================================================

/**
 * Insert or update a context for a specific collection and path prefix.
 *
 * `store_collections` is keyed by name (`TEXT PRIMARY KEY`), not an integer id.
 * #754 retargeted this query from the dropped `collections` table but left
 * `WHERE id = ?`, which throws `no such column: id`.
 */
export function insertContext(db: Database, collectionName: string, pathPrefix: string, context: string): void {
  const coll = db.prepare(`SELECT name FROM store_collections WHERE name = ?`).get(collectionName) as { name: string } | null;
  if (!coll) {
    throw new Error(`Collection '${collectionName}' not found`);
  }

  updateStoreContext(db, coll.name, pathPrefix, context);
}

/**
 * Check which collections don't have any context defined.
 * Returns collections that have no context entries at all (not even root context).
 */
export function getCollectionsWithoutContext(db: Database): { name: string; pwd: string; doc_count: number }[] {
  // Get all collections from DB
  const allCollections = getStoreCollections(db);

  // Filter to those without context
  const collectionsWithoutContext: { name: string; pwd: string; doc_count: number }[] = [];

  for (const coll of allCollections) {
    // Check if collection has any context
    if (!coll.context || Object.keys(coll.context).length === 0) {
      // Get doc count from database
      const stats = db.prepare(`
        SELECT COUNT(d.id) as doc_count
        FROM documents d
        WHERE d.collection = ? AND d.active = 1
      `).get(coll.name) as { doc_count: number } | null;

      collectionsWithoutContext.push({
        name: coll.name,
        pwd: coll.path,
        doc_count: stats?.doc_count || 0,
      });
    }
  }

  return collectionsWithoutContext.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get top-level directories in a collection that don't have context.
 * Useful for suggesting where context might be needed.
 */
export function getTopLevelPathsWithoutContext(db: Database, collectionName: string): string[] {
  // Get all paths in the collection from database
  const paths = db.prepare(`
    SELECT DISTINCT path FROM documents
    WHERE collection = ? AND active = 1
  `).all(collectionName) as { path: string }[];

  // Get existing contexts for this collection from DB
  const dbColl = getStoreCollection(db, collectionName);
  if (!dbColl) return [];

  const contextPrefixes = new Set<string>();
  if (dbColl.context) {
    for (const prefix of Object.keys(dbColl.context)) {
      contextPrefixes.add(prefix);
    }
  }

  // Extract top-level directories (first path component)
  const topLevelDirs = new Set<string>();
  for (const { path } of paths) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length > 1) {
      const dir = parts[0];
      if (dir) topLevelDirs.add(dir);
    }
  }

  // Filter out directories that already have context (exact or parent)
  const missing: string[] = [];
  for (const dir of topLevelDirs) {
    let hasContext = false;

    // Check if this dir or any parent has context
    for (const prefix of contextPrefixes) {
      if (prefix === '' || prefix === dir || dir.startsWith(prefix + '/')) {
        hasContext = true;
        break;
      }
    }

    if (!hasContext) {
      missing.push(dir);
    }
  }

  return missing.sort();
}

// =============================================================================
// FTS Search
// =============================================================================

export function sanitizeFTS5Term(term: string): string {
  return term.replace(/[^\p{L}\p{N}'_]/gu, '').toLowerCase();
}

/**
 * A run of characters the FTS tokenizer treats as a separator.
 *
 * `documents_fts` is tokenized with `porter unicode61`, which starts a new
 * token at every character that is not a letter or a digit. Underscore is one
 * of those, but it is deliberately kept here rather than split on: FTS5 applies
 * the same tokenizer to a quoted phrase, so leaving `apply_secrets` intact lets
 * it split symmetrically into `apply secrets` on both sides, and that is the
 * behaviour #305 shipped. The apostrophe is kept for the same reason.
 */
const FTS5_SEPARATOR_RUN = /[^\p{L}\p{N}'_]+/u;

/**
 * Split one query term the way the tokenizer split the document text, and
 * sanitize each part.
 *
 * `PIO-1384` becomes ["pio", "1384"], `src/lib/i18n.ts` becomes
 * ["src", "lib", "i18n", "ts"], and a term with no separator in it comes back
 * as a single part. Callers join the parts into an FTS5 phrase, which is what
 * makes the parts have to be adjacent in the document rather than merely all
 * present. Parts that sanitize to nothing are dropped, so a term that is all
 * punctuation yields an empty list and the caller skips it.
 */
function splitFTS5CompoundTerm(term: string): string[] {
  return term.split(FTS5_SEPARATOR_RUN).map(p => sanitizeFTS5Term(p)).filter(p => p);
}

/**
 * Parse lex query syntax into FTS5 query.
 *
 * Supports:
 * - Quoted phrases: "exact phrase" → "exact phrase" (exact match)
 * - Negation: -term or -"phrase" → uses FTS5 NOT operator
 * - Terms holding a separator: multi-agent, DEC-0054, gpt-4, 2026.4.10,
 *   src/lib/i18n.ts, @tobilu/qmd → treated as phrases over their parts
 * - Plain terms: term → "term"* (prefix match)
 *
 * FTS5 NOT is a binary operator: `term1 NOT term2` means "match term1 but not term2".
 * So `-term` only works when there are also positive terms.
 *
 * Hyphen disambiguation: `-sports` at a word boundary is negation, but `multi-agent`
 * (where `-` is between word characters) is treated as a hyphenated phrase.
 * When a leading `-` is followed by what looks like a hyphenated compound word
 * (e.g., `-multi-agent`), the entire token is treated as a negated phrase.
 *
 * Examples:
 *   performance -sports     → "performance"* NOT "sports"*
 *   "machine learning"      → "machine learning"
 *   multi-agent memory      → "multi agent" AND "memory"*
 *   DEC-0054               → "dec 0054"
 *   -multi-agent            → NOT "multi agent"
 *   "DEC-0054"              → "dec 0054"
 *   src/lib/i18n.ts         → "src lib i18n ts"
 */
/**
 * ko-qmd: how the positive terms are joined.
 *
 * "all" is the upstream behaviour (every term must appear). "any" is the relaxed retry that
 * searchFTS falls back to when "all" finds nothing — a Korean question is a sentence, and
 * requiring all of its words present means a natural long query returns zero documents.
 */
type TermJoin = "all" | "any";

function buildFTS5Query(query: string, join: TermJoin = "all"): string | null {
  const positive: string[] = [];
  const negative: string[] = [];

  let i = 0;
  const s = query.trim();

  while (i < s.length) {
    // Skip whitespace
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;

    // Check for negation prefix
    const negated = s[i] === '-';
    if (negated) i++;

    // Check for quoted phrase
    if (s[i] === '"') {
      const start = i + 1;
      i++;
      while (i < s.length && s[i] !== '"') i++;
      const phrase = s.slice(start, i).trim();
      i++; // skip closing quote
      if (phrase.length > 0) {
        const sanitized = sanitizeFTS5Phrase(phrase);
        if (sanitized) {
          const ftsPhrase = `"${sanitized}"`;  // Exact phrase, no prefix match
          if (negated) {
            negative.push(ftsPhrase);
          } else {
            positive.push(ftsPhrase);
          }
        }
      }
    } else {
      // Plain term (until whitespace or quote)
      const start = i;
      while (i < s.length && !/[\s"]/.test(s[i]!)) i++;
      const term = s.slice(start, i);

      // ko-qmd: script-mixed terms are split into runs first — the CJK branch below would
      // make the whole term one character phrase, losing particle stems, loanwords and
      // bigram weight for its Hangul run.
      const mixed = negated ? null : hangulMixedQuery(term);
      if (mixed) {
        positive.push(mixed);
      } else if (containsCjk(term)) {
        // ko-qmd: Hangul words query bigrams and their particle-stripped stem
        const hangul = negated ? null : hangulTermQuery(term);
        const sanitized = hangul ? null : sanitizeFTS5Phrase(term);
        if (hangul) {
          positive.push(hangul);
        } else if (sanitized) {
          const ftsPhrase = `"${sanitized}"`;  // CJK phrase over character tokens
          if (negated) {
            negative.push(ftsPhrase);
          } else {
            positive.push(ftsPhrase);
          }
        }
      } else {
        // Any separator inside the term (multi-agent, DEC-0054, 2026.4.10,
        // src/lib/i18n.ts, @tobilu/qmd) split it at index time too, so the term
        // has to be matched as the phrase those parts form. A term with no
        // separator is one part and keeps its prefix match, which is what makes
        // a plain word still match longer words that start with it.
        const parts = splitFTS5CompoundTerm(term);
        if (parts.length > 0) {
          const ftsTerm = parts.length > 1
            ? `"${parts.join(' ')}"`   // Phrase match (no prefix)
            : `"${parts[0]}"*`;        // Prefix match
          if (negated) {
            negative.push(ftsTerm);
          } else {
            positive.push(ftsTerm);
          }
        }
      }
    }
  }

  if (positive.length === 0 && negative.length === 0) return null;

  // If only negative terms, we can't search (FTS5 NOT is binary)
  if (positive.length === 0) return null;

  // ko-qmd: the relaxed retry needs at least three terms — with one or two, OR is close to
  // dropping the query's words rather than loosening them.
  if (join === "any" && positive.length < 3) return null;

  let result = join === "any" ? `(${positive.join(' OR ')})` : positive.join(' AND ');

  // Add NOT clause for negative terms
  for (const neg of negative) {
    result = `${result} NOT ${neg}`;
  }

  return result;
}

/**
 * Validate that a vec/hyde query doesn't use lex-only syntax.
 * Returns error message if invalid, null if valid.
 */
export function validateSemanticQuery(query: string): string | null {
  // Check for negation syntax — only at token boundaries (start of string or after whitespace).
  // Hyphenated words like "real-time" or "write-ahead" must not trigger this.
  if (/(^|\s)-[\w"]/.test(query)) {
    return 'Negation (-term) is not supported in vec/hyde queries. Use lex for exclusions.';
  }
  return null;
}

export function validateLexQuery(query: string): string | null {
  if (/[\r\n]/.test(query)) {
    return 'Lex queries must be a single line. Remove newline characters or split into separate lex: lines.';
  }
  const quoteCount = (query.match(/"/g) ?? []).length;
  if (quoteCount % 2 === 1) {
    return 'Lex query has an unmatched double quote ("). Add the closing quote or remove it.';
  }
  return null;
}

/** One collection, several (OR), or all (undefined). */
export type CollectionScope = string | readonly string[] | undefined;

function scopedCollectionNames(scope: CollectionScope): string[] | undefined {
  if (scope == null) return undefined;
  const names = (typeof scope === "string" ? [scope] : Array.from(scope))
    .map(n => n.trim())
    .filter(n => n.length > 0);
  return names.length > 0 ? names : undefined;
}

/**
 * Fewest documents a retrieval pass looks at, whatever `limit` the caller asked for.
 *
 * Keyword search fetches its candidate window from `limit`, a number the caller picked
 * for display, so a small `limit` leaves a pool that post-filtering can exhaust, and
 * `-n 5` was not the first five of `-n 20`. The CLI makes that visible: its default
 * limit is 20 for `--json`/`--files` and 5 otherwise (src/cli/qmd.ts), so the output
 * format changed which documents came back. README documents `limit` as "Max results"
 * and `candidateLimit` as the candidate knob; the floor is what makes that true.
 *
 * 20 is the breadth hybridQuery already passes explicitly on every one of its own
 * retrieval calls. Vector search needs no floor: its per-partition KNN is exact.
 */
const MIN_RETRIEVAL_BREADTH = 20;

/**
 * Candidate ceiling for a filtered FTS scan. High enough that a real query's whole match set
 * gets through — which is what stops a narrow filter from starving — and low enough that a
 * query matching most of a large index still terminates.
 *
 * A caller asking for more than this (today: `--all` at 100k) with a filter/scope in play
 * gets at most the cap's worth of candidates, and the excess is dropped before narrowing —
 * silently, unless the caller passes `onScanCapped` to `searchFTS`. Never raise this to
 * satisfy `--all`; it is a perf guard, not a result-size knob.
 */
export const FILTERED_FTS_SCAN_MAX = 50_000;

/** Bound list size when fetching document bodies — SQLite caps bound parameters. */
const CONTENT_HASH_IN_CHUNK = 400;

/**
 * How many active documents the filter leaves standing, and how many there were.
 *
 * An empty result list cannot tell a user whether nothing matched their words or whether
 * their filter removed the corpus first. Callers ask this only when they got nothing back,
 * so the scan costs nothing on the path that found something.
 */
export function countFilteredDocuments(
  db: Database,
  filter: DocumentFilter,
  collectionName?: string | readonly string[],
): { kept: number; total: number } {
  const names = scopedCollectionNames(collectionName);
  const params: string[] = [];
  let sql = `SELECT collection || '/' || path AS display_path, modified_at FROM documents WHERE active = 1`;
  if (names && names.length > 0) {
    sql += ` AND collection IN (${names.map(() => "?").join(",")})`;
    params.push(...names.map(String));
  }
  const rows = db.prepare(sql).all(...params) as { display_path: string; modified_at: string | null }[];
  const kept = rows.filter(row => {
    if (filter.sinceIso && !(row.modified_at && row.modified_at >= filter.sinceIso)) return false;
    if (filter.untilIso && !(row.modified_at && row.modified_at <= filter.untilIso)) return false;
    return matchesPaths(row.display_path, filter);
  }).length;
  return { kept, total: rows.length };
}

function compareFilepaths(a: { filepath: string }, b: { filepath: string }): number {
  return a.filepath < b.filepath ? -1 : a.filepath > b.filepath ? 1 : 0;
}

export function searchFTS(db: Database, query: string, limit: number = 20, collectionName?: string | readonly string[], filter?: MetadataFilter, scope?: DocumentFilter, onScanCapped?: () => void): SearchResult[] {
  const names = scopedCollectionNames(collectionName);
  // A collection scope narrows the corpus like a path or metadata filter does, so it scans
  // the whole match set rather than a top-N window of global hits, which returns false-empty
  // results whenever stronger out-of-scope matches fill it (#922). Because the scope sees
  // every match, one query over the whole collection list returns what a query per
  // collection merged by score would (#775, #946), and a large collection cannot crowd out
  // the rest. `filtered` is only the path/time/metadata part, the one FILTERED_FTS_SCAN_MAX caps.
  const filtered = isNarrowing(scope) || filter !== undefined;

  const ftsQuery = buildFTS5Query(query);
  if (!ftsQuery) return [];
  const runMatch = (match: string, matchMode: TermJoin): SearchResult[] => {

    // Use a CTE to force FTS5 to run first, then filter by collection.
    // Without the CTE, SQLite's query planner combines FTS5 MATCH with the
    // collection filter in a single WHERE clause, which can cause it to
    // abandon the FTS5 index and fall back to a full scan — turning an 8ms
    // query into a 17-second query on large collections.
    const params: (string | number)[] = [match];

    const breadth = Math.max(limit, MIN_RETRIEVAL_BREADTH);
    // A collection, path/time scope or metadata filter has to narrow the corpus, not the answer. Taking the top `ftsLimit`
    // and *then* dropping what the filter excludes is the starvation #791/#803 already cost
    // us: ask for `journals/**` and the top 200 global hits may hold none of it. So when a
    // filter is in play every FTS match is a candidate, capped only against a pathological
    // query, and the ORDER BY / LIMIT below picks the winners from the filtered set.
    // A collection scope alone is narrowed by SQL and capped by nothing but the caller's own
    // breadth, so `--all -c docs` still returns every match; the cap above guards only the
    // filters whose excess the caller cannot see.
    const ftsLimit = filtered
      ? FILTERED_FTS_SCAN_MAX
      : (names ? Math.max(FILTERED_FTS_SCAN_MAX, breadth) : breadth);

    let sql = `
      WITH fts_matches AS (
        SELECT rowid, bm25(documents_fts, 1.5, 4.0, 1.0) as bm25_score
        FROM documents_fts
        WHERE documents_fts MATCH ?
        ORDER BY bm25_score ASC
        LIMIT ${ftsLimit}
      )
      SELECT
        'qmd://' || d.collection || '/' || d.path as filepath,
        d.collection || '/' || d.path as display_path,
        d.title,
        d.hash,
        d.modified_at,
        fm.bm25_score,
        dm.metadata_json
      FROM fts_matches fm
      JOIN documents d ON d.id = fm.rowid
      LEFT JOIN document_metadata dm ON dm.document_id = d.id
      WHERE d.active = 1
    `;

    if (names) {
      sql += ` AND d.collection IN (SELECT value FROM json_each(?))`;
      params.push(JSON.stringify(names));
    }

    if (filter) {
      // Only documents with current, error-free extraction can match — an
      // unprocessed document must not accidentally satisfy `exists: false`.
      const compiledFilter = compileMetadataFilter(filter, "d");
      sql += ` AND dm.extraction_version = ${METADATA_EXTRACTION_VERSION} AND dm.extraction_error IS NULL AND ${compiledFilter.sql}`;
      params.push(...compiledFilter.params);
    }
    if (scope?.sinceIso) {
      sql += ` AND d.modified_at >= ?`;
      params.push(scope.sinceIso);
    }
    if (scope?.untilIso) {
      sql += ` AND d.modified_at <= ?`;
      params.push(scope.untilIso);
    }

    // bm25 lower is better; sort ascending, ties by filepath as in searchVec,
    // so the order of a collection list never decides a tie. Path globs are matched below rather than here:
    // `Database` spans better-sqlite3 and bun:sqlite, and neither shares a way to register
    // the picomatch predicate as a SQL function. Dropping the inner LIMIT above is what
    // keeps this from being a post-filter on a truncated pool.
    const matchingPaths = (scope?.paths?.length ?? 0) > 0;
    sql += ` ORDER BY fm.bm25_score ASC, filepath ASC`;
    if (!matchingPaths) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }

    type CandidateRow = { filepath: string; display_path: string; title: string; hash: string; modified_at: string; bm25_score: number; metadata_json: string | null };
    const candidates = db.prepare(sql).all(...params) as CandidateRow[];
    const rows = matchingPaths
      ? candidates.filter(row => matchesPaths(row.display_path, scope)).slice(0, limit)
      : candidates;
    if (onScanCapped && filtered && limit > FILTERED_FTS_SCAN_MAX && rows.length > 0) {
      // The CTE above keeps only the top FILTERED_FTS_SCAN_MAX matches *before* the
      // filter/scope narrows them, so anything past the cap is lost where no caller can
      // see it. A capped probe (OFFSET cap stops the walk after cap+1 rows) tells the
      // caller their request outran the guard. Gated on limit > cap so the hot path —
      // every normal filtered search — pays nothing extra; only --all-scale callers
      // probe. Probed per actually-executed match (strict, else relaxed), so the signal
      // describes the results being returned.
      const overflow = db.prepare(
        `SELECT 1 AS one FROM documents_fts WHERE documents_fts MATCH ? LIMIT 1 OFFSET ${FILTERED_FTS_SCAN_MAX}`,
      ).get(match);
      if (overflow) onScanCapped();
    }
    if (rows.length === 0) return [];

    // Bodies come second, for the winners only. The candidate pass above can be the whole
    // match set when a path filter is on, and `content.doc` for every one of those is text
    // we would read and discard.
    // Chunked because `--all` asks for a six-figure limit and SQLite caps bound parameters.
    const wantedHashes = [...new Set(rows.map(r => r.hash))];
    const bodyByHash = new Map<string, string>();
    for (let i = 0; i < wantedHashes.length; i += CONTENT_HASH_IN_CHUNK) {
      const chunk = wantedHashes.slice(i, i + CONTENT_HASH_IN_CHUNK);
      const bodyRows = db.prepare(
        `SELECT hash, ${cappedBodySql("doc")} AS doc FROM content WHERE hash IN (${chunk.map(() => "?").join(",")})`,
      ).all(...chunk) as { hash: string; doc: string }[];
      for (const r of bodyRows) bodyByHash.set(r.hash, r.doc);
    }

    // One batched context lookup for all winners (was one N+1 triple per row).
    const contexts = getContextsForFiles(db, rows.map((r) => r.filepath));

    return rows.map(row => {
      const collectionName = row.filepath.split('//')[1]?.split('/')[0] || "";
      // Convert bm25 (negative, lower is better) into a stable [0..1) score where higher is better.
      // FTS5 BM25 scores are negative (e.g., -10 is strong, -2 is weak).
      // |x| / (1 + |x|) maps: strong(-10)→0.91, medium(-2)→0.67, weak(-0.5)→0.33, none(0)→0.
      // Monotonic and query-independent — no per-query normalization needed.
      const score = Math.abs(row.bm25_score) / (1 + Math.abs(row.bm25_score));
      const body = bodyByHash.get(row.hash) ?? "";
      return {
        filepath: row.filepath,
        displayPath: row.display_path,
        title: row.title,
        hash: row.hash,
        docid: getDocid(row.hash),
        collectionName,
        modifiedAt: row.modified_at ?? "",
        bodyLength: body.length,
        body,
        context: contexts.get(row.filepath) ?? null,
        metadata: parseMetadataJson(row.metadata_json),
        score,
        source: "fts" as const,
        matchMode,
      };
    });
  };

  const strict = runMatch(ftsQuery, "all");
  if (strict.length > 0) return strict;
  // ko-qmd: a Korean question is a sentence, and ANDing its words means a natural long query
  // matches nothing at all. Retry the same terms ORed. Only reached when the strict query
  // already returned nothing, so this cannot dilute a result that existed.
  const relaxed = buildFTS5Query(query, "any");
  return relaxed ? runMatch(relaxed, "any") : [];
}

// =============================================================================
// Vector Search
// =============================================================================

/** sqlite-vec rejects k above this in MATCH queries (v0.1.9). */
const SQLITE_VEC_MAX_K = 4096;

interface VecMatch {
  rowid: number;
  distance: number;
}

/** One KNN scan target: a collection's partition, or the whole table when no scope is given. */
interface VecScanTarget {
  collectionId?: number;
}

/** The document behind a vector match, at its nearest chunk. */
interface VecDocumentMatch {
  rowid: number;
  hash: string;
  pos: number;
  filepath: string;
  display_path: string;
  title: string;
  metadata_json: string | null;
  distance: number;
}

/**
 * A metadata filter as SQL over a `document_metadata dm` join, admitting only
 * documents whose metadata extraction is current and error-free.
 */
function compileCurrentMetadataFilter(filter: MetadataFilter): { sql: string; params: SQLiteValue[] } {
  const compiled = compileMetadataFilter(filter, "d");
  return {
    sql: `dm.extraction_version = ${METADATA_EXTRACTION_VERSION} AND dm.extraction_error IS NULL AND ${compiled.sql}`,
    params: compiled.params,
  };
}

/**
 * Prepares an exact top-k cosine scan of the vector table, run once per
 * target with k in 1..SQLITE_VEC_MAX_K. vec0 evaluates the partition equality
 * inside the scan, so a small collection costs its own rows rather than the
 * whole index and is never crowded out by a larger one (#775, #791, #803). A
 * `rowid IN` restriction is applied inside the scan the same way, so a
 * selective metadata filter gets an exact top-k of its own rows instead of
 * whatever survives a post-filter of a larger top-k. The restriction is the
 * eligibility subquery itself rather than a bound list of rowids, so however
 * many rows a filter admits, none of them is read onto the heap.
 */
function knnVecScanner(db: Database, partitioned: boolean, narrowing: VecNarrowing): (embedding: Float32Array, k: number, target: VecScanTarget) => VecMatch[] {
  const conditions = ["embedding MATCH ?", "k = ?"];
  if (partitioned) conditions.push("collection_id = ?");
  const eligible = narrowsVecRows(narrowing) ? eligibleRowsSql(narrowing) : undefined;
  if (eligible) conditions.push(`rowid IN (SELECT vr.id ${eligible.sql}${partitioned ? " AND vr.collection_id = ?" : ""})`);
  const statement = db.prepare(`
    SELECT rowid, distance
    FROM ${VEC_TABLE}
    WHERE ${conditions.join(" AND ")}
  `);
  return (embedding, k, target) => {
    const params: SQLiteValue[] = [embedding, k];
    const partition = vecInteger(target.collectionId ?? 0);
    if (partitioned) params.push(partition);
    if (eligible) {
      params.push(...eligible.params);
      if (partitioned) params.push(partition);
    }
    return statement.all(...params) as VecMatch[];
  };
}

/**
 * What narrows a vector search below its collections: a metadata filter, and
 * (ko-qmd) the documents a path/time scope admits, as a JSON id list for
 * json_each. Picomatch globs have no SQL form, so the scope is resolved to
 * document ids up front; its cost follows the documents in scope, not their
 * chunk count.
 */
type VecNarrowing = { filter?: MetadataFilter; scopedDocIds?: string };

const narrowsVecRows = (narrowing: VecNarrowing): boolean =>
  narrowing.filter !== undefined || narrowing.scopedDocIds !== undefined;

/** The WHERE conditions on `d` (and `dm` when a filter is set) a narrowing adds. */
function narrowingConditions(narrowing: VecNarrowing): { joins: string; sql: string; params: SQLiteValue[] } {
  const conditions: string[] = [];
  const params: SQLiteValue[] = [];
  let joins = "";
  if (narrowing.filter) {
    const current = compileCurrentMetadataFilter(narrowing.filter);
    joins = `JOIN document_metadata dm ON dm.document_id = d.id`;
    conditions.push(current.sql);
    params.push(...current.params);
  }
  if (narrowing.scopedDocIds !== undefined) {
    conditions.push(`d.id IN (SELECT value FROM json_each(?))`);
    params.push(narrowing.scopedDocIds);
  }
  return { joins, sql: conditions.map(c => ` AND ${c}`).join(""), params };
}

/**
 * ko-qmd: ids of the active documents a path/time scope admits, as a JSON list,
 * or undefined when the scope does not narrow.
 */
function scopedDocumentIds(db: Database, scope: DocumentFilter | undefined, names: readonly string[] | undefined): string | undefined {
  if (!isNarrowing(scope)) return undefined;
  let sql = `SELECT id, collection || '/' || path AS display_path FROM documents WHERE active = 1`;
  const params: string[] = [];
  if (names) {
    sql += ` AND collection IN (SELECT value FROM json_each(?))`;
    params.push(JSON.stringify(names));
  }
  if (scope.sinceIso) {
    sql += ` AND modified_at >= ?`;
    params.push(scope.sinceIso);
  }
  if (scope.untilIso) {
    sql += ` AND modified_at <= ?`;
    params.push(scope.untilIso);
  }
  const ids: number[] = [];
  for (const row of db.prepare(sql).iterate(...params) as IterableIterator<{ id: number; display_path: string }>) {
    if (matchesPaths(row.display_path, scope)) ids.push(row.id);
  }
  return JSON.stringify(ids);
}

/**
 * FROM and WHERE clauses selecting, as `vr`, the vector rows of active
 * documents a narrowing admits. A row is eligible when any document of its
 * collection that holds the row's content passes the narrowing.
 */
function eligibleRowsSql(narrowing: VecNarrowing): { sql: string; params: SQLiteValue[] } {
  const narrowed = narrowingConditions(narrowing);
  return {
    sql: `
      FROM documents d
      ${narrowed.joins}
      JOIN ${VEC_COLLECTION_IDS_TABLE} ci ON ci.name = d.collection
      JOIN ${VEC_ROWS_TABLE} vr ON vr.hash = d.hash AND vr.collection_id = ci.id
      WHERE d.active = 1${narrowed.sql}`,
    params: narrowed.params,
  };
}

/**
 * Ids of the collections holding at least one vector row a narrowing admits.
 * The narrowing runs once per document and EXISTS probes for a row, so the
 * cost follows the documents in scope rather than their chunk count.
 */
function eligibleCollections(db: Database, narrowing: VecNarrowing): Set<number> {
  const narrowed = narrowingConditions(narrowing);
  const rows = db.prepare(`
    SELECT DISTINCT ci.id AS collectionId
    FROM documents d
    ${narrowed.joins}
    JOIN ${VEC_COLLECTION_IDS_TABLE} ci ON ci.name = d.collection
    WHERE d.active = 1${narrowed.sql}
      AND EXISTS (SELECT 1 FROM ${VEC_ROWS_TABLE} vr WHERE vr.hash = d.hash AND vr.collection_id = ci.id)
  `).all(...narrowed.params) as { collectionId: number }[];
  return new Set(rows.map(row => row.collectionId));
}

/**
 * Prepares step 2 of a vector search: the documents behind a set of vector
 * rows, one per file at its nearest chunk, nearest first. The rowids are bound
 * as one JSON parameter, so the statement text stays fixed and a match set up
 * to the 4096 k cap never meets SQLite's bound-parameter limit. Bodies are
 * left out: one long document can hold every match, and only the final results
 * load theirs.
 */
function vecDocumentResolver(db: Database, narrowing: VecNarrowing): (matches: readonly VecMatch[]) => VecDocumentMatch[] {
  // Re-apply the narrowing on the document join: vectors are content-scoped,
  // so one hash can belong to both matching and non-matching documents.
  const narrowed = narrowingConditions(narrowing);
  const statement = withLazyContentVectorMigration(db, () => db.prepare(`
    SELECT
      vr.id AS rowid,
      cv.hash,
      cv.pos,
      'qmd://' || d.collection || '/' || d.path as filepath,
      d.collection || '/' || d.path as display_path,
      d.title,
      dm.metadata_json
    FROM json_each(?) j
    JOIN ${VEC_ROWS_TABLE} vr ON vr.id = j.value
    JOIN ${VEC_COLLECTION_IDS_TABLE} ci ON ci.id = vr.collection_id
    JOIN content_vectors cv ON cv.hash = vr.hash AND cv.seq = vr.seq
    JOIN documents d ON d.hash = vr.hash AND d.collection = ci.name
    JOIN content ON content.hash = d.hash
    LEFT JOIN document_metadata dm ON dm.document_id = d.id
    WHERE d.active = 1${narrowed.sql}
  `));
  return (matches) => {
    if (matches.length === 0) return [];
    const distanceByRowid = new Map(matches.map(r => [r.rowid, r.distance]));
    const rows = statement.all(rowidList(matches.map(r => r.rowid)), ...narrowed.params) as Omit<VecDocumentMatch, "distance">[];
    const best = new Map<string, VecDocumentMatch>();
    for (const row of rows) {
      const distance = distanceByRowid.get(row.rowid) ?? 1;
      const existing = best.get(row.filepath);
      if (!existing || distance < existing.distance) best.set(row.filepath, { ...row, distance });
    }
    return Array.from(best.values()).sort((a, b) => a.distance - b.distance);
  };
}

/**
 * Nearest documents of one scan target. The first KNN asks for three chunks
 * per requested document. Chunks of one long document can still fill every
 * slot, so while the matches collapse into fewer than `limit` documents and
 * the target holds rows beyond them, k doubles, up to sqlite-vec's cap.
 */
function nearestVecDocuments(
  scan: ReturnType<typeof knnVecScanner>,
  resolve: ReturnType<typeof vecDocumentResolver>,
  queryVec: Float32Array,
  limit: number,
  target: VecScanTarget,
): VecDocumentMatch[] {
  for (let k = limit * 3; ; k *= 2) {
    const vecK = Math.max(1, Math.min(SQLITE_VEC_MAX_K, k));
    const matches = scan(queryVec, vecK, target);
    const documents = resolve(matches);
    if (documents.length >= limit || matches.length < vecK || vecK === SQLITE_VEC_MAX_K) return documents;
  }
}

/** Enforce remote spaces in KNN scope without changing local-to-local compatibility. */
function assertRemoteEmbeddingBoundary(db: Database, model: string, collectionName?: string | readonly string[], filter?: MetadataFilter): void {
  if (!hasVectorIndex(db)) return;
  const names = scopedCollectionNames(collectionName);
  const ids = names ? Array.from(resolveCollectionIds(db, names).values()) : undefined;
  if (ids?.length === 0) return;
  const eligible = filter ? eligibleRowsSql({ filter }) : undefined;
  const conditions: string[] = [];
  const params: SQLiteValue[] = [];
  if (ids) {
    conditions.push(`vr.collection_id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
  }
  if (eligible) {
    conditions.push(`vr.id IN (SELECT vr.id ${eligible.sql})`);
    params.push(...eligible.params);
  }
  conditions.push(`EXISTS (SELECT 1 FROM ${VEC_TABLE} v WHERE v.rowid = vr.id)`);
  if (model.startsWith("remote-openai:")) {
    conditions.push("(cv.model IS NULL OR cv.model != ? OR cv.embed_fingerprint != ?)");
    params.push(model, getEmbeddingFingerprint(model));
  } else {
    // Local labels and legacy fingerprints keep their existing semantics, but
    // a local query must never rank a remote embedding space (or load ML first).
    conditions.push("cv.model GLOB 'remote-openai:*'");
  }
  const foreign = withLazyContentVectorMigration(db, () => db.prepare(`
    SELECT 1 FROM ${VEC_ROWS_TABLE} vr
    LEFT JOIN content_vectors cv ON cv.hash = vr.hash AND cv.seq = vr.seq
    WHERE ${conditions.join(" AND ")} LIMIT 1
  `).get(...params));
  if (foreign) throw new Error("Vector space mismatch; re-embed the selected collections with the configured model");
}

export async function searchVec(db: Database, query: string, model: string, limit: number = 20, collectionName?: string | readonly string[], session?: ILLMSession, precomputedEmbedding?: number[], llm?: LlamaCpp, filter?: MetadataFilter, scope?: DocumentFilter): Promise<SearchResult[]> {
  if (!hasVectorIndex(db)) return [];
  // No read transaction spans HTTP. Fail before paying for a query, then
  // recheck after the await in the SAME snapshot as KNN and document resolution.
  assertRemoteEmbeddingBoundary(db, model, collectionName, filter);
  const embedding = precomputedEmbedding ?? await getEmbedding(query, model, true, session, llm);
  if (!embedding) return [];
  session?.signal.throwIfAborted();

  return db.transaction(() => {
    if (!hasVectorIndex(db)) return [];
    assertRemoteEmbeddingBoundary(db, model, collectionName, filter);
    return searchVecSnapshot(db, embedding, limit, collectionName, filter, scope);
  })();
}

/** Synchronous reads only; called inside the post-embedding read transaction. */
function searchVecSnapshot(db: Database, embedding: number[], limit: number, collectionName?: string | readonly string[], filter?: MetadataFilter, scope?: DocumentFilter): SearchResult[] {
  const names = scopedCollectionNames(collectionName);
  let collectionIds: number[] | undefined;
  if (names) {
    collectionIds = Array.from(resolveCollectionIds(db, names).values());
    if (collectionIds.length === 0) return [];
  }
  // ko-qmd: a path/time scope narrows the eligible rows exactly as a metadata
  // filter does, so a narrow scope gets an exact top-k of its own rows rather
  // than whatever a post-filter leaves of a larger one (#791, #803).
  const narrowing: VecNarrowing = { filter, scopedDocIds: scopedDocumentIds(db, scope, names) };
  const eligible = narrowsVecRows(narrowing) ? eligibleCollections(db, narrowing) : undefined;

  // IMPORTANT: We use a two-step query approach here because sqlite-vec virtual tables
  // hang indefinitely when combined with JOINs in the same query. Do NOT try to
  // "optimize" this by combining into a single query with JOINs - it will break.
  // See: https://github.com/tobi/qmd/pull/23

  // Step 1 gets vector matches from sqlite-vec (no JOINs allowed), one KNN per
  // collection in scope; step 2 resolves them to documents. One statement per
  // member rather than `collection_id IN (...)`: the IN form yields k rows per
  // value only because SQLite runs vec0's filter once per value, which is a
  // planner detail rather than a vec0 contract.
  const scanned = collectionIds && eligible ? collectionIds.filter(id => eligible.has(id)) : collectionIds;
  const scanTargets: VecScanTarget[] = scanned ? scanned.map(collectionId => ({ collectionId })) : eligible?.size === 0 ? [] : [{}];
  if (scanTargets.length === 0) return [];
  const scan = knnVecScanner(db, collectionIds !== undefined, narrowing);
  const resolve = vecDocumentResolver(db, narrowing);
  const queryVec = new Float32Array(embedding);
  // Bodies are capped at BODY_CAP_CHARS, as in searchFTS, so a large document cannot
  // put its whole text on the heap for each result.
  const bodyOf = db.prepare(`SELECT ${cappedBodySql("doc")} AS doc FROM content WHERE hash = ?`);

  // Each target yields its own nearest `limit` documents (or all it holds), so
  // merging them by distance gives the scope's exact nearest `limit`. Ties go
  // to the smaller filepath, as in searchFTS.
  const winners = scanTargets
    .flatMap(target => nearestVecDocuments(scan, resolve, queryVec, limit, target))
    .sort((a, b) => a.distance - b.distance || compareFilepaths(a, b))
    .slice(0, limit);
  // One batched context lookup for all winners (was one N+1 triple per row).
  const vecContexts = getContextsForFiles(db, winners.map(row => row.filepath));
  return winners.flatMap((row): SearchResult[] => {
    // Body, vector, metadata and context reads share the search snapshot.
    const content = bodyOf.get(row.hash) as { doc: string } | null | undefined;
    if (content == null) return [];
    const body = content.doc;
    const collectionName = row.filepath.split('//')[1]?.split('/')[0] || "";
    return [{
      filepath: row.filepath,
      displayPath: row.display_path,
      title: row.title,
      hash: row.hash,
      docid: getDocid(row.hash),
      collectionName,
      modifiedAt: "",  // Not available in vec query
      bodyLength: body.length,
      body,
      context: vecContexts.get(row.filepath) ?? null,
      metadata: parseMetadataJson(row.metadata_json),
      score: 1 - row.distance,  // Cosine similarity = 1 - cosine distance
      source: "vec" as const,
      chunkPos: row.pos,
    }];
  });
}

// =============================================================================
// Embeddings
// =============================================================================

async function getEmbedding(text: string, model: string, isQuery: boolean, session?: ILLMSession, llmOverride?: LlamaCpp): Promise<number[] | null> {
  // Format text using the appropriate prompt template
  const formattedText = isQuery ? formatQueryForEmbedding(text, model) : formatDocForEmbedding(text, undefined, model);
  const result = session
    ? await session.embed(formattedText, { model, isQuery })
    : await (llmOverride ?? getDefaultLlamaCpp()).embed(formattedText, { model, isQuery });
  return result?.embedding || null;
}

/**
 * Get all unique content hashes that need embeddings (from active documents).
 * Returns hash, document body, and a sample path for display purposes.
 */
export function getHashesForEmbedding(db: Database, model: string = DEFAULT_EMBED_MODEL): { hash: string; body: string; path: string }[] {
  const fingerprint = getEmbeddingFingerprint(model);
  return withLazyContentVectorMigration(db, () => {
    const stmt = db.prepare(`
    SELECT d.hash, ${cappedBodySql("c.doc")} as body, MIN(d.path) as path
    FROM documents d
    JOIN content c ON d.hash = c.hash
    LEFT JOIN (
      SELECT hash, model, COUNT(*) AS chunk_count, MAX(total_chunks) AS expected_chunks
      FROM content_vectors
      WHERE model = ? AND embed_fingerprint = ?
      GROUP BY hash, model, embed_fingerprint
    ) v ON d.hash = v.hash
    WHERE d.active = 1
      AND (v.hash IS NULL OR v.chunk_count < v.expected_chunks)
    GROUP BY d.hash
  `);
    // Large-result query (up to 9k): use iterate() to stream, bound heap
    const results: { hash: string; body: string; path: string }[] = [];
    for (const row of stmt.iterate(model, fingerprint) as IterableIterator<{ hash: string; body: string; path: string }>) {
      results.push(row);
    }
    return results;
  });
}

/**
 * Clear embeddings for the whole index, or just for one collection.
 *
 * Takes the index's exclusive embed lock, like an embedding run, because a
 * clear and a run both delete vector rows: a whole-index clear drops the vec0
 * table under a run that is publishing chunks into it, and a scoped clear that
 * commits between a run's pending-vector read and its writes can resurrect
 * vectors the user asked to delete. Throws {@link EmbedLockBusyError} instead
 * of interleaving. An embedding run clearing its own vectors for `force` calls
 * the lock-held body, since it already owns the lock.
 *
 * When `collection` is omitted the content_vectors and vector_rows tables are
 * emptied and the vec0 table is dropped (it is recreated with the right
 * dimensions on the next embed run).
 *
 * When `collection` is provided, only chunks whose hash is referenced
 * exclusively by active documents in that collection are removed, from that
 * collection's partition and from content_vectors. Hashes shared with active
 * documents in other collections are left in place so vector search keeps
 * working there (content_vectors is keyed globally by content hash; identical
 * document bodies across collections share a row). The vec0 table is dropped
 * only when the scoped clear empties content_vectors entirely, so the next
 * embed can recreate it with the current dimensions.
 */
export function clearAllEmbeddings(db: Database, collection?: string): void {
  const lock = acquireEmbedLockForDb(db);
  try {
    clearEmbeddingsWithIndexLockHeld(db, collection);
  } finally {
    // Success or failure: the next run or clear must be able to start.
    lock?.release();
  }
}

/** The clear itself; clearAllEmbeddings() owns the index lock. */
function clearEmbeddingsWithIndexLockHeld(db: Database, collection?: string): void {
  if (!collection) {
    db.transaction(() => {
      db.exec(`DELETE FROM content_vectors`);
      dropVectorIndex(db);
    }).immediate();
    return;
  }

  const exclusiveHashesQuery = `
    SELECT DISTINCT d.hash
    FROM documents d
    WHERE d.collection = ? AND d.active = 1
      AND NOT EXISTS (
        SELECT 1 FROM documents d2
        WHERE d2.hash = d.hash
          AND d2.active = 1
          AND d2.collection != d.collection
      )
  `;
  const collectionId = resolveCollectionId(db, collection);

  withLazyContentVectorMigration(db, () => db.transaction(() => {
    if (collectionId !== undefined) {
      const rows = db.prepare(`
        SELECT id FROM ${VEC_ROWS_TABLE}
        WHERE collection_id = ? AND hash IN (${exclusiveHashesQuery})
      `).all(collectionId, collection) as { id: number }[];
      deletePartitionRows(db, rows.map((row) => row.id));
    }

    db.prepare(`
      DELETE FROM content_vectors
      WHERE hash IN (${exclusiveHashesQuery})
    `).run(collection);

    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM content_vectors`)
      .get() as { n: number };
    if (remaining.n === 0) dropVectorIndex(db);
  }).immediate());
}

/** Partition rows written per commit by copyVectorsToNewCollections. */
export const VECTOR_COPY_BATCH_ROWS = 1000;

/**
 * Give every active (hash, collection) pair whose chunks are embedded a row
 * in that collection's partition, copied from any partition that holds the
 * chunk, so a hash that gains a collection is searchable there without
 * another model call. A chunk no partition holds is queued for embedding by
 * deleting its hash's rows, which the pending detector then picks up.
 *
 * Rows commit in batches of VECTOR_COPY_BATCH_ROWS so a collection that gains
 * thousands of embedded hashes does not hold the write lock for the whole
 * copy; an interrupted run resumes from whatever missingPartitionRows still
 * reports.
 */
export function copyVectorsToNewCollections(db: Database, collection?: string): { copied: number; queued: number } {
  const layout = vecLayout(db);
  if (layout.kind === "legacy" || !isSqliteVecAvailable()) return { copied: 0, queued: 0 };
  return withLazyContentVectorMigration(db, () => {
    const missing = missingPartitionRows(db, collection);
    if (missing.length === 0) return { copied: 0, queued: 0 };
    const writer = layout.kind === "partitioned" ? new PartitionWriter(db) : null;
    const storedVector = writer ? storedEmbeddingLookup(db) : null;
    const deleteChunks = db.prepare(`DELETE FROM content_vectors WHERE hash = ?`);
    const queued = new Set<string>();
    let copied = 0;
    const copyBatch = (rows: MissingPartitionRow[]) => {
      const queuedNow: string[] = [];
      for (const row of rows) {
        if (queued.has(row.hash)) continue;
        const vector = storedVector?.(row.hash, row.seq);
        if (!vector || !writer) {
          queued.add(row.hash);
          queuedNow.push(row.hash);
          continue;
        }
        if (writer.writeToCollection(row.hash, row.seq, row.collection, vector)) copied++;
      }
      // Deleting by hash also removes rows an earlier batch already committed
      // for it; the run-level set keeps a later batch from copying it again.
      for (const hash of queuedNow) {
        deletePartitionRowsOfHash(db, hash);
        deleteChunks.run(hash);
      }
    };
    for (let start = 0; start < missing.length; start += VECTOR_COPY_BATCH_ROWS) {
      const batch = missing.slice(start, start + VECTOR_COPY_BATCH_ROWS);
      db.transaction(() => copyBatch(batch)).immediate();
    }
    return { copied, queued: queued.size };
  });
}

/**
 * Insert a single embedding: the content_vectors row plus one row in the
 * partition of every active collection that holds the hash, in one
 * transaction so a crash cannot leave the tables out of step. A hash with no
 * active document gets its content_vectors row only.
 *
 * IMMEDIATE (not deferred): the reserved lock must be taken up front —
 * upgrading a deferred read snapshot under a concurrent WAL writer fails with
 * SQLITE_BUSY_SNAPSHOT instead of honoring busy_timeout. Readers still proceed
 * under WAL; writers queue via busy_timeout. Never EXCLUSIVE. The migration
 * wrapper stays outside: a column repair (ALTER TABLE) must not run inside the
 * chunk txn — on a column-miss the txn body throws, rolls back, the repair
 * runs, and the retry re-enters a fresh txn.
 */
export function insertEmbedding(
  db: Database,
  hash: string,
  seq: number,
  pos: number,
  embedding: Float32Array,
  model: string,
  embeddedAt: string,
  totalChunks: number = 1,
  fingerprint: string = getEmbeddingFingerprint(model)
): void {
  withLazyContentVectorMigration(db, () => {
    db.transaction(() => {
      db.prepare(`INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embed_fingerprint, total_chunks, embedded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(hash, seq, pos, model, fingerprint, totalChunks, embeddedAt);
      for (const collection of activeCollectionsOfHash(db, hash)) {
        upsertPartitionVector(db, hash, seq, allocateCollectionId(db, collection), embedding);
      }
    }).immediate();
  });
}

function pruneStaleChunkVectors(db: Database, hash: string, model: string, keepChunks: number): void {
  withLazyContentVectorMigration(db, () => {
    const stale = db.prepare(
      `SELECT seq FROM content_vectors WHERE hash = ? AND model = ? AND seq >= ?`,
    ).all(hash, model, keepChunks) as { seq: number }[];
    if (stale.length === 0) return;

    const partitionRowsOf = db.prepare(`SELECT id FROM ${VEC_ROWS_TABLE} WHERE hash = ? AND seq = ?`);
    const deleteContentStmt = db.prepare(`DELETE FROM content_vectors WHERE hash = ? AND model = ? AND seq = ?`);
    for (const row of stale) {
      const rowids = (partitionRowsOf.all(hash, row.seq) as { id: number }[]).map(r => r.id);
      deletePartitionRows(db, rowids);
      deleteContentStmt.run(hash, model, row.seq);
    }
  });
}

function removeIncompleteEmbeddings(db: Database, expectedChunksByHash: Map<string, number>, model: string): number {
  return withLazyContentVectorMigration(db, () => {
    let removed = 0;
    const rowsStmt = db.prepare(`SELECT seq FROM content_vectors WHERE hash = ? AND model = ?`);
    const deleteContentStmt = db.prepare(`DELETE FROM content_vectors WHERE hash = ? AND model = ?`);

    for (const [hash, expectedChunks] of expectedChunksByHash) {
      const rows = rowsStmt.all(hash, model) as { seq: number }[];
      if (rows.length === 0 || rows.length === expectedChunks) continue;

      deletePartitionRowsOfHash(db, hash);
      deleteContentStmt.run(hash, model);
      removed += rows.length;
    }

    return removed;
  });
}

// =============================================================================
// Query expansion
// =============================================================================

/**
 * Drop exact repeats. Every entry costs one FTS or vector search, and the
 * model can emit the same line many times (#921). vec and hyde entries with
 * the same text are both kept because they route to different searches.
 */
function uniqueExpansions(expansions: ExpandedQuery[]): ExpandedQuery[] {
  const seen = new Set<string>();
  return expansions.filter((e) => {
    const key = `${e.type}\n${e.query}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function expandQuery(query: string, model: string = DEFAULT_QUERY_MODEL, db: Database, llmOverride?: LlamaCpp, options: { onModelReady?: () => void } = {}): Promise<ExpandedQuery[]> {
  // Check cache first — stored as JSON preserving types. Intent is
  // deliberately absent from both the cache key and the generation call:
  // feeding caller intent to the expansion model contaminates sub-queries
  // with intent meta-language (see LlamaCpp.expandQuery), and keying the
  // cache by intent multiplied the poisoned entries per (query, intent) pair.
  const cacheKey = getCacheKey("expandQuery", { query, model });
  const cached = getCachedResult(db, cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as unknown;
      // Non-array valid JSON (poison row) falls through to re-expand like
      // invalid JSON below, letting the fresh result overwrite it.
      if (Array.isArray(parsed)) {
        const rows = parsed as Array<Record<string, unknown>>;
        // Migrate old cache format: { type, text } → { type, query }
        if (rows.length > 0 && typeof rows[0]?.query === "string") {
          return uniqueExpansions(rows.map((r) => ({ type: r.type as ExpandedQuery["type"], query: String(r.query) })));
        } else if (rows.length > 0 && typeof rows[0]?.text === "string") {
          return uniqueExpansions(rows.map((r) => ({ type: r.type as ExpandedQuery["type"], query: String(r.text) })));
        }
      }
    } catch {
      // Old cache format (pre-typed, newline-separated text) — re-expand
    }
  }

  const llm = llmOverride ?? getDefaultLlamaCpp();
  // Note: LlamaCpp uses hardcoded model, model parameter is ignored
  const results = await llm.expandQuery(query, { onModelReady: options.onModelReady });

  // Map Queryable[] → ExpandedQuery[] (same shape, decoupled from llm.ts internals).
  // Filter out entries that duplicate the original query text.
  const expanded = uniqueExpansions(results
    .filter(r => r.text !== query)
    .map(r => ({ type: r.type, query: r.text })));

  if (expanded.length > 0) {
    setCachedResult(db, cacheKey, JSON.stringify(expanded));
  }

  return expanded;
}

/**
 * Delete the cached expansion for a query. hybridQuery() calls this when an
 * expansion's sub-queries all came back empty — left in place, the dud entry
 * would replay the same misses on every warm repeat of the query.
 */
export function deleteExpansionCacheEntry(db: Database, query: string, model: string = DEFAULT_QUERY_MODEL): void {
  const cacheKey = getCacheKey("expandQuery", { query, model });
  db.prepare(`DELETE FROM llm_cache WHERE hash = ?`).run(cacheKey);
}

// =============================================================================
// Reranking
// =============================================================================

/**
 * Per-request rerank options. A 5th positional on Store.rerank keeps existing SDK callers working.
 * Upstream passes a bare AbortSignal in that position; ko-qmd takes it as `signal` here.
 */
export type StoreRerankOptions = {
  /** Doc token cap for this request; overrides QMD_RERANK_MAX_DOC_TOKENS. */
  maxDocTokens?: number;
  /** Called once the rerank model is loaded (not at all when every chunk is cached). */
  onModelReady?: () => void;
  /** Cancels a remote rerank; local scoring may finish before cancellation is observed. */
  signal?: AbortSignal;
};

export async function rerank(query: string, documents: { file: string; text: string }[], model: string = DEFAULT_RERANK_MODEL, db: Database, intent?: string, llmOverride?: LlamaCpp, options: StoreRerankOptions = {}): Promise<{ file: string; score: number }[]> {
  const signal = options.signal;
  signal?.throwIfAborted();
  // Snapshot cache inputs too: caller mutation during HTTP must not change keys.
  documents = documents.map(doc => ({ file: doc.file, text: doc.text }));
  const rerankQuery = formatRerankQuery(query, intent);
  const llm = llmOverride ?? getDefaultLlamaCpp();
  // Prefer the LLM instance's resolved identity so a models.rerank swap cannot
  // reuse another model's cache entries (#764).
  const cacheModel = llm.rerankModelName ?? model;
  // A capped rerank (per request, else QMD_RERANK_MAX_DOC_TOKENS) scores a different
  // text than the chunk in the key, so its scores must not mix with other caps.
  const requestMaxDocTokens = normalizeRerankMaxDocTokens(options.maxDocTokens);
  const maxDocTokens = requestMaxDocTokens ?? llm.rerankMaxDocTokens;
  const cacheTag = maxDocTokens ? `${cacheModel}#max${maxDocTokens}` : cacheModel;

  const cachedResults: Map<string, number> = new Map();
  const uncachedDocsByChunk: Map<string, RerankDocument> = new Map();

  // Check cache for each document
  // Cache key includes chunk text — different queries can select different chunks
  // from the same file, and the reranker score depends on which chunk was sent.
  // File path is excluded from the new cache key because the reranker score
  // depends on the chunk content, not where it came from.
  for (const doc of documents) {
    const cacheKey = getCacheKey("rerank", { query: rerankQuery, model: cacheTag, chunk: doc.text });
    const legacyCacheKey = getCacheKey("rerank", { query, file: doc.file, model: cacheTag, chunk: doc.text });
    const cached = getCachedResult(db, cacheKey) ?? getCachedResult(db, legacyCacheKey);
    if (cached !== null) {
      cachedResults.set(doc.text, parseFloat(cached));
    } else {
      uncachedDocsByChunk.set(doc.text, { file: doc.file, text: doc.text });
    }
  }

  // Rerank uncached documents using LlamaCpp
  if (uncachedDocsByChunk.size > 0) {
    const uncachedDocs = [...uncachedDocsByChunk.values()];
    const callOptions = {
      model: cacheModel,
      ...(requestMaxDocTokens ? { maxDocTokens: requestMaxDocTokens } : {}),
      onModelReady: options.onModelReady,
      ...(signal ? { signal } : {}),
    };
    const rerankResult = cacheModel.startsWith("remote-typesafe:")
      ? await withLLMSessionForLlm(llm, session => session.rerank(rerankQuery, uncachedDocs, callOptions), { signal, name: "rerank" })
      : await llm.rerank(rerankQuery, uncachedDocs, callOptions);
    signal?.throwIfAborted();

    // Cache results by chunk text so identical chunks across files are scored once.
    // A "fallback" result (no rerank context could be created) is a flat 0.5, not a score:
    // it is returned but never cached, so it cannot outlive the failure.
    // Complete scores arrive before any writes. Index, not file, identifies a
    // chunk: two different chunks can have the same file name.
    const cacheable = rerankResult.model !== "fallback";
    db.transaction(() => {
      for (const result of rerankResult.results) {
        signal?.throwIfAborted();
        const chunk = uncachedDocs[result.index]!.text;
        if (cacheable) {
          const cacheKey = getCacheKey("rerank", { query: rerankQuery, model: cacheTag, chunk });
          setCachedResult(db, cacheKey, result.score.toString());
        }
        cachedResults.set(chunk, result.score);
      }
      signal?.throwIfAborted();
    })();
  }

  // Return all results sorted by score, including a fully cached call.
  const results = documents
    .map(doc => ({ file: doc.file, score: cachedResults.get(doc.text) || 0 }))
    .sort((a, b) => b.score - a.score);
  signal?.throwIfAborted();
  return results;
}

// =============================================================================
// Reciprocal Rank Fusion
// =============================================================================

const COVERAGE_HANGUL_RUN_PATTERN = /\p{Script=Hangul}+/gu;
const COVERAGE_LATIN_RUN_PATTERN = /[a-z0-9]+/gi;

/**
 * Fraction of the query's units present in the document body, used to weight a
 * relaxed (any-word) FTS list per document instead of one global constant
 * (BASELINE.md 2026-10-09 follow-up: a global weight cannot split the mirrored
 * tie of `hmu-05` vs `sem-08`).
 *
 * Units mirror the rerank chunk scorer: one per Hangul run of two or more
 * syllables (a run of three or more also matches on any shared syllable
 * bigram, so a particle-suffixed word meets its stem), one per Latin/digit run
 * longer than two characters. Single syllables and short tokens carry no
 * signal and are skipped. A query with no units covers everything (1.0) so it
 * never punishes.
 */
export function relaxedDocCoverage(query: string, body: string): number {
  const lower = body.toLowerCase();
  let total = 0;
  let matched = 0;
  for (const token of query.toLowerCase().split(/\s+/)) {
    if (!token) continue;
    for (const run of token.match(COVERAGE_HANGUL_RUN_PATTERN) ?? []) {
      const syllables = Array.from(run);
      if (syllables.length < 2) continue;
      total++;
      if (lower.includes(run)) {
        matched++;
        continue;
      }
      if (syllables.length >= 3) {
        for (let i = 0; i + 1 < syllables.length; i++) {
          if (lower.includes(syllables[i]! + syllables[i + 1]!)) {
            matched++;
            break;
          }
        }
      }
    }
    for (const run of token.match(COVERAGE_LATIN_RUN_PATTERN) ?? []) {
      if (run.length <= 2) continue;
      total++;
      if (lower.includes(run)) matched++;
    }
  }
  return total === 0 ? 1 : matched / total;
}

/**
 * Per-document RRF multipliers, aligned with `rankedLists`: a relaxed list
 * scales each document by `0.5 + 0.5 × coverage`, every other list is untouched
 * (`undefined` entry = multiplier 1.0). The 0.5 floor keeps a zero-coverage
 * candidate in the pool instead of erasing it.
 */
export function rrfDocMultipliers(
  rankedLists: RankedResult[][],
  rankedListMeta: RankedListMeta[],
): Array<Map<string, number> | undefined> {
  return rankedLists.map((list, i) => {
    const meta = rankedListMeta[i];
    if (!meta?.relaxed) return undefined;
    const multipliers = new Map<string, number>();
    for (const r of list) {
      multipliers.set(r.file, 0.5 + 0.5 * relaxedDocCoverage(meta.query, r.body));
    }
    return multipliers;
  });
}

export function reciprocalRankFusion(
  resultLists: RankedResult[][],
  weights: number[] = [],
  k: number = 60,
  docMultipliers: Array<Map<string, number> | undefined> = [],
): RankedResult[] {
  const scores = new Map<string, { result: RankedResult; rrfScore: number; topRank: number }>();

  for (let listIdx = 0; listIdx < resultLists.length; listIdx++) {
    const list = resultLists[listIdx];
    if (!list) continue;
    const weight = weights[listIdx] ?? 1.0;
    const multipliers = docMultipliers[listIdx];

    for (let rank = 0; rank < list.length; rank++) {
      const result = list[rank];
      if (!result) continue;
      const multiplier = multipliers?.get(result.file) ?? 1.0;
      const rrfContribution = (weight * multiplier) / (k + rank + 1);
      const existing = scores.get(result.file);

      if (existing) {
        existing.rrfScore += rrfContribution;
        existing.topRank = Math.min(existing.topRank, rank);
      } else {
        scores.set(result.file, {
          result,
          rrfScore: rrfContribution,
          topRank: rank,
        });
      }
    }
  }

  // Top-rank bonus
  for (const entry of scores.values()) {
    if (entry.topRank === 0) {
      entry.rrfScore += 0.05;
    } else if (entry.topRank <= 2) {
      entry.rrfScore += 0.02;
    }
  }

  return Array.from(scores.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(e => ({ ...e.result, score: e.rrfScore }));
}

/**
 * Build per-document RRF contribution traces for explain/debug output.
 */
export function buildRrfTrace(
  resultLists: RankedResult[][],
  weights: number[] = [],
  listMeta: RankedListMeta[] = [],
  k: number = 60,
  docMultipliers: Array<Map<string, number> | undefined> = [],
): Map<string, RRFScoreTrace> {
  const traces = new Map<string, RRFScoreTrace>();

  for (let listIdx = 0; listIdx < resultLists.length; listIdx++) {
    const list = resultLists[listIdx];
    if (!list) continue;
    const weight = weights[listIdx] ?? 1.0;
    const multipliers = docMultipliers[listIdx];
    const meta = listMeta[listIdx] ?? {
      source: "fts",
      queryType: "original",
      query: "",
    } as const;

    for (let rank0 = 0; rank0 < list.length; rank0++) {
      const result = list[rank0];
      if (!result) continue;
      const rank = rank0 + 1; // 1-indexed rank for explain output
      const multiplier = multipliers?.get(result.file) ?? 1.0;
      const contribution = (weight * multiplier) / (k + rank);
      const existing = traces.get(result.file);

      const detail: RRFContributionTrace = {
        listIndex: listIdx,
        source: meta.source,
        queryType: meta.queryType,
        query: meta.query,
        rank,
        weight,
        multiplier,
        backendScore: result.score,
        rrfContribution: contribution,
      };

      if (existing) {
        existing.baseScore += contribution;
        existing.topRank = Math.min(existing.topRank, rank);
        existing.contributions.push(detail);
      } else {
        traces.set(result.file, {
          contributions: [detail],
          baseScore: contribution,
          topRank: rank,
          topRankBonus: 0,
          totalScore: 0,
        });
      }
    }
  }

  for (const trace of traces.values()) {
    let bonus = 0;
    if (trace.topRank === 1) bonus = 0.05;
    else if (trace.topRank <= 3) bonus = 0.02;
    trace.topRankBonus = bonus;
    trace.totalScore = trace.baseScore + bonus;
  }

  return traces;
}

// =============================================================================
// Document retrieval
// =============================================================================

type DbDocRow = {
  virtual_path: string;
  display_path: string;
  title: string;
  hash: string;
  collection: string;
  path: string;
  modified_at: string;
  body_length: number;
  body?: string;
};

function normalizeLookupPathForIgnore(path: string): string {
  let normalized = path.replace(/\\/g, '/').trim();
  if (normalized.startsWith('~/')) {
    normalized = homedir() + normalized.slice(1);
  }
  return normalized;
}

function matchesIgnoreRule(relativePath: string, rule: string): boolean {
  const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const normalizedRule = rule.replace(/\\/g, '/').replace(/^\/+/, '');
  const isMatch = picomatch(normalizedRule, { dot: true });
  return isMatch(normalizedPath);
}

function getIgnoredLookupMatch(db: Database, query: string): DocumentExcludedByIgnore | null {
  const normalizedQuery = normalizeLookupPathForIgnore(query);
  const parsedVirtual = isVirtualPath(normalizedQuery) ? parseVirtualPath(normalizedQuery) : null;
  const collections = getStoreCollections(db);

  for (const coll of collections) {
    if (!coll.ignore || coll.ignore.length === 0) continue;

    const candidates: string[] = [];

    if (parsedVirtual) {
      if (parsedVirtual.collectionName !== coll.name) continue;
      candidates.push(parsedVirtual.path);
    } else if (normalizedQuery.startsWith(coll.path + '/')) {
      candidates.push(normalizedQuery.slice(coll.path.length + 1));
    } else if (!normalizedQuery.startsWith('/')) {
      const collectionPrefix = `${coll.name}/`;
      if (normalizedQuery.startsWith(collectionPrefix)) {
        candidates.push(normalizedQuery.slice(collectionPrefix.length));
      } else {
        candidates.push(normalizedQuery);
      }
    }

    for (const candidate of candidates) {
      for (const rule of coll.ignore) {
        if (matchesIgnoreRule(candidate, rule)) {
          return {
            error: "excluded_by_ignore",
            query,
            collection: coll.name,
            path: candidate,
            rule,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Find a document by filename/path, docid (#hash), or path-boundary suffix.
 * Returns document metadata without body by default.
 *
 * Supports:
 * - Virtual paths: qmd://collection/path/to/file.md
 * - Absolute paths: /path/to/file.md
 * - Relative paths: path/to/file.md
 * - Short docid: #abc123 (first 6 chars of hash)
 */
export function findDocument(db: Database, filename: string, options: { includeBody?: boolean } = {}): DocumentResult | DocumentLookupError {
  let filepath = filename;
  const colonMatch = filepath.match(/:(\d+)$/);
  if (colonMatch) {
    filepath = filepath.slice(0, -colonMatch[0].length);
  }

  // Check if this is a docid lookup (#abc123, abc123, "#abc123", "abc123", etc.)
  // Docid wins when it hits, but a miss falls through to path resolution:
  // a real file with an isDocid-shaped bare name (e.g. `ab12cd`) must stay
  // reachable instead of 404ing here.
  if (isDocid(filepath)) {
    const docidMatch = findDocumentByDocid(db, filepath);
    if (docidMatch) {
      filepath = docidMatch.filepath;
    }
  }

  if (filepath.startsWith('~/')) {
    filepath = homedir() + filepath.slice(1);
  }

  const bodyCol = options.includeBody ? `, content.doc as body` : ``;

  // Build computed columns
  // Note: absoluteFilepath is computed from YAML collections after query
  const selectCols = `
    'qmd://' || d.collection || '/' || d.path as virtual_path,
    d.collection || '/' || d.path as display_path,
    d.title,
    d.hash,
    d.collection,
    d.modified_at,
    octet_length(content.doc) as body_length
    ${bodyCol}
  `;

  // Try to match by virtual path first
  let doc = db.prepare(`
    SELECT ${selectCols}
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE 'qmd://' || d.collection || '/' || d.path = ? AND d.active = 1
  `).get(filepath) as DbDocRow | null;

  // Path-boundary suffix match (mirrors resolveCommaListName tier 3, #759):
  // only `.../name` matches, so a mid-filename fragment like `NTAX.md`
  // can no longer silently fetch `SYNTAX.md`. Multiple hits return
  // not_found with the candidates (instead of an arbitrary LIMIT 1).
  if (!doc && !filepath.startsWith('qmd://')) {
    const fuzzy = db.prepare(`
      SELECT ${selectCols}
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE 'qmd://' || d.collection || '/' || d.path LIKE ? ESCAPE '#' AND d.active = 1
      ORDER BY d.collection, d.path
    `).all(`%/${escapeLikePattern(filepath)}`) as DbDocRow[];
    if (fuzzy.length > 1) {
      return {
        error: "not_found",
        query: filename,
        similarFiles: fuzzy.map((r) => r.virtual_path),
      };
    }
    doc = fuzzy[0] ?? null;
  }

  // Try to match by absolute path (requires looking up collection paths from DB)
  if (!doc && !filepath.startsWith('qmd://')) {
    const collections = getStoreCollections(db);
    for (const coll of collections) {
      let relativePath: string | null = null;

      // If filepath is absolute and starts with collection path, extract relative part
      if (filepath.startsWith(coll.path + '/')) {
        relativePath = filepath.slice(coll.path.length + 1);
      }
      // Otherwise treat filepath as relative to collection
      else if (!filepath.startsWith('/')) {
        relativePath = filepath;
      }

      if (relativePath) {
        doc = db.prepare(`
          SELECT ${selectCols}
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.collection = ? AND d.path = ? AND d.active = 1
        `).get(coll.name, relativePath) as DbDocRow | null;
        if (doc) break;
      }
    }
  }

  if (!doc) {
    const ignored = getIgnoredLookupMatch(db, filepath);
    if (ignored) return ignored;

    const similar = findSimilarFiles(db, filepath, 5, 5);
    return { error: "not_found", query: filename, similarFiles: similar };
  }

  // Get context using virtual path
  const virtualPath = doc.virtual_path || `qmd://${doc.collection}/${doc.display_path}`;
  const context = getContextForFile(db, virtualPath);

  return {
    filepath: virtualPath,
    displayPath: doc.display_path,
    title: doc.title,
    context,
    hash: doc.hash,
    docid: getDocid(doc.hash),
    collectionName: doc.collection,
    modifiedAt: doc.modified_at,
    bodyLength: doc.body_length,
    ...(options.includeBody && doc.body !== undefined && { body: doc.body }),
  };
}

/**
 * Get the body content for a document
 * Optionally slice by line range
 */
export function getDocumentBody(db: Database, doc: DocumentResult | { filepath: string }, fromLine?: number, maxLines?: number): string | null {
  const filepath = doc.filepath;

  // Try to resolve document by filepath (absolute or virtual)
  let row: { body: string } | null = null;

  // Try virtual path first
  if (filepath.startsWith('qmd://')) {
    row = db.prepare(`
      SELECT content.doc as body
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE 'qmd://' || d.collection || '/' || d.path = ? AND d.active = 1
    `).get(filepath) as { body: string } | null;
  }

  // Try absolute path by looking up in DB store_collections
  if (!row) {
    const collections = getStoreCollections(db);
    for (const coll of collections) {
      if (filepath.startsWith(coll.path + '/')) {
        const relativePath = filepath.slice(coll.path.length + 1);
        row = db.prepare(`
          SELECT content.doc as body
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.collection = ? AND d.path = ? AND d.active = 1
        `).get(coll.name, relativePath) as { body: string } | null;
        if (row) break;
      }
    }
  }

  if (!row) return null;

  let body = row.body;
  if (fromLine !== undefined || maxLines !== undefined) {
    const lines = body.split('\n');
    const start = Math.max(0, (fromLine || 1) - 1);
    const end = maxLines !== undefined ? start + maxLines : lines.length;
    body = lines.slice(start, end).join('\n');
  }

  return body;
}


/**
 * Escape a user-supplied string so it is matched literally by SQLite LIKE.
 * Uses '#' as the ESCAPE character (avoids quote-escaping pitfalls with '\\').
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/#/g, "##").replace(/%/g, "#%").replace(/_/g, "#_");
}

export type CommaListMatch = {
  collection: string;
  path: string;
  virtualPath: string;
  bodyLength: number;
};

export type CommaListResolve =
  | { ok: true; match: CommaListMatch }
  | { ok: false; error: string };

type CommaListRow = {
  collection: string;
  path: string;
  virtual_path: string;
  body_length: number;
};

function commaListSelect(db: Database, whereSql: string, params: string[]): CommaListRow[] {
  return db.prepare(`
    SELECT
      d.collection,
      d.path,
      'qmd://' || d.collection || '/' || d.path as virtual_path,
      octet_length(content.doc) as body_length
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE d.active = 1 AND (${whereSql})
    ORDER BY d.collection, d.path
  `).all(...params) as CommaListRow[];
}

function finishCommaListResolve(db: Database, name: string, rows: CommaListRow[]): CommaListResolve {
  if (rows.length === 1) {
    const row = rows[0]!;
    return {
      ok: true,
      match: {
        collection: row.collection,
        path: row.path,
        virtualPath: row.virtual_path,
        bodyLength: row.body_length,
      },
    };
  }
  if (rows.length > 1) {
    return {
      ok: false,
      error: `Ambiguous path ${name}: ${rows.map(r => r.virtual_path).join(", ")}`,
    };
  }
  const similar = findSimilarFiles(db, name, 5, 3);
  let msg = `File not found: ${name}`;
  if (similar.length > 0) {
    msg += ` (did you mean: ${similar.join(", ")}?)`;
  }
  return { ok: false, error: msg };
}

/**
 * Resolve one comma-list name for multi-get (shared by CLI and SDK/MCP).
 *
 * Match order: docid / qmd:// URI (exact only), then exact collection-prefixed
 * path, then exact document path, then a path-boundary suffix (`.../name`).
 * Unanchored LIKE is never used, so a fragment like `NTAX.md` cannot silently
 * fetch `SYNTAX.md`. Multiple hits at the same tier error with the candidate
 * list instead of `LIMIT 1` (#759).
 */
export function resolveCommaListName(db: Database, name: string): CommaListResolve {
  const trimmed = name.trim();
  if (!trimmed) {
    return { ok: false, error: `File not found: ${name}` };
  }

  // Docid wins when it hits; a miss falls through to the path tiers below
  // so a real file with an isDocid-shaped bare name (e.g. `ab12cd`) stays
  // reachable instead of 404ing (and suggesting itself) here.
  if (isDocid(trimmed)) {
    const docidMatch = findDocumentByDocid(db, trimmed);
    if (docidMatch) {
      const rows = commaListSelect(
        db,
        `'qmd://' || d.collection || '/' || d.path = ?`,
        [docidMatch.filepath],
      );
      return finishCommaListResolve(db, trimmed, rows);
    }
  }

  if (isVirtualPath(trimmed)) {
    const parsed = parseVirtualPath(trimmed);
    if (!parsed) return finishCommaListResolve(db, trimmed, []);
    const rows = commaListSelect(
      db,
      `d.collection = ? AND d.path = ?`,
      [parsed.collectionName, parsed.path],
    );
    return finishCommaListResolve(db, trimmed, rows);
  }

  // 1. Exact collection-prefixed path (collection/relpath)
  let rows = commaListSelect(db, `d.collection || '/' || d.path = ?`, [trimmed]);
  if (rows.length > 0) return finishCommaListResolve(db, trimmed, rows);

  // 2. Exact document path
  rows = commaListSelect(db, `d.path = ?`, [trimmed]);
  if (rows.length > 0) return finishCommaListResolve(db, trimmed, rows);

  // 3. Path-boundary suffix: matches `dir/name`, not mid-filename fragments
  rows = commaListSelect(
    db,
    `d.path LIKE ? ESCAPE '#'`,
    [`%/${escapeLikePattern(trimmed)}`],
  );
  return finishCommaListResolve(db, trimmed, rows);
}

/**
 * Find multiple documents by glob pattern or comma-separated list
 * Returns documents without body by default (use getDocumentBody to load)
 */
export function findDocuments(
  db: Database,
  pattern: string,
  options: { includeBody?: boolean; maxBytes?: number } = {}
): { docs: MultiGetResult[]; errors: string[] } {
  const isCommaSeparated = pattern.includes(',') && !pattern.includes('*') && !pattern.includes('?') && !pattern.includes('{');
  const isSingleDocid = isDocid(pattern);
  const errors: string[] = [];
  const maxBytes = options.maxBytes ?? DEFAULT_MULTI_GET_MAX_BYTES;

  const bodyCol = options.includeBody ? `, content.doc as body` : ``;
  const selectCols = `
    'qmd://' || d.collection || '/' || d.path as virtual_path,
    d.collection || '/' || d.path as display_path,
    d.title,
    d.hash,
    d.collection,
    d.modified_at,
    octet_length(content.doc) as body_length
    ${bodyCol}
  `;

  let fileRows: DbDocRow[];

  if (isCommaSeparated || isSingleDocid) {
    const names = isCommaSeparated
      ? pattern.split(',').map(s => s.trim()).filter(Boolean)
      : [pattern.trim()].filter(Boolean);
    fileRows = [];
    for (const name of names) {
      const resolved = resolveCommaListName(db, name);
      if (!resolved.ok) {
        errors.push(resolved.error);
        continue;
      }
      const doc = db.prepare(`
        SELECT ${selectCols}
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE d.collection = ? AND d.path = ? AND d.active = 1
      `).get(resolved.match.collection, resolved.match.path) as DbDocRow | null;
      if (doc) {
        fileRows.push(doc);
      } else {
        errors.push(`File not found: ${name}`);
      }
    }
  } else {
    // Glob pattern match
    const matched = matchFilesByGlob(db, pattern);
    if (matched.length === 0) {
      errors.push(`No files matched pattern: ${pattern}`);
      return { docs: [], errors };
    }
    const virtualPaths = matched.map(m => m.filepath);
    const placeholders = virtualPaths.map(() => '?').join(',');
    fileRows = db.prepare(`
      SELECT ${selectCols}
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE 'qmd://' || d.collection || '/' || d.path IN (${placeholders}) AND d.active = 1
    `).all(...virtualPaths) as DbDocRow[];
  }

  const results: MultiGetResult[] = [];

  // One batched context lookup for all rows (was one N+1 triple per row).
  const mgContexts = getContextsForFiles(
    db,
    fileRows.map((row) => row.virtual_path || `qmd://${row.collection}/${row.display_path}`),
  );

  for (const row of fileRows) {
    // Get context using virtual path
    const virtualPath = row.virtual_path || `qmd://${row.collection}/${row.display_path}`;
    const context = mgContexts.get(virtualPath) ?? null;

    if (row.body_length > maxBytes) {
      results.push({
        doc: { filepath: virtualPath, displayPath: row.display_path },
        skipped: true,
        skipReason: `File too large (${Math.round(row.body_length / 1024)}KB > ${Math.round(maxBytes / 1024)}KB)`,
      });
      continue;
    }

    results.push({
      doc: {
        filepath: virtualPath,
        displayPath: row.display_path,
        title: row.title || row.display_path.split('/').pop() || row.display_path,
        context,
        hash: row.hash,
        docid: getDocid(row.hash),
        collectionName: row.collection,
        modifiedAt: row.modified_at,
        bodyLength: row.body_length,
        ...(options.includeBody && row.body !== undefined && { body: row.body }),
      },
      skipped: false,
    });
  }

  return { docs: results, errors };
}

// =============================================================================
// Status
// =============================================================================

export function getStatus(db: Database, model: string = DEFAULT_EMBED_MODEL): IndexStatus {
  const statusSummary = getStatusSummary(db, model);
  const metadataOverviews = listMetadataCollectionSummaries(db, STATUS_METADATA_KEY_LIMIT);
  return {
    ...statusSummary,
    collections: statusSummary.collections.map(collection => {
      const metadataOverview = metadataOverviews.get(collection.name);
      return { ...collection, metadataKeyCount: metadataOverview?.totalKeys ?? 0, metadataKeys: metadataOverview?.keys ?? [] };
    }),
  };
}

export function getStatusSummary(db: Database, model: string = DEFAULT_EMBED_MODEL): IndexStatusSummary {
  // DB is source of truth for collections — config provides supplementary metadata
  const dbCollections = db.prepare(`
    SELECT
      collection as name,
      COUNT(*) as active_count,
      MAX(modified_at) as last_doc_update
    FROM documents
    WHERE active = 1
    GROUP BY collection
  `).all() as { name: string; active_count: number; last_doc_update: string | null }[];

  // Build a lookup from store_collections for path/pattern metadata
  const storeCollections = getStoreCollections(db);
  const configLookup = new Map(storeCollections.map(c => [c.name, { path: c.path, pattern: c.pattern }]));

  const collections: IndexStatusSummary["collections"] = dbCollections.map(row => {
    const config = configLookup.get(row.name);
    return {
      name: row.name,
      path: config?.path ?? null,
      pattern: config?.pattern ?? null,
      documents: row.active_count,
      lastUpdated: row.last_doc_update || new Date().toISOString(),
    };
  });

  // Sort by last update time (most recent first)
  collections.sort((a, b) => {
    if (!a.lastUpdated) return 1;
    if (!b.lastUpdated) return -1;
    return new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime();
  });

  const totalDocs = (db.prepare(`SELECT COUNT(*) as c FROM documents WHERE active = 1`).get() as { c: number }).c;
  const needsEmbedding = getHashesNeedingEmbedding(db, undefined, model);
  const hasVectors = hasVectorIndex(db);

  return {
    totalDocuments: totalDocs,
    needsEmbedding,
    hasVectorIndex: hasVectors,
    pendingMetadata: countDocumentsPendingMetadata(db),
    collections,
  };
}

// =============================================================================
// Snippet extraction
// =============================================================================

export type SnippetResult = {
  line: number;           // 1-indexed line number of best match
  snippet: string;        // The snippet text with diff-style header
  linesBefore: number;    // Lines in document before snippet
  linesAfter: number;     // Lines in document after snippet
  snippetLines: number;   // Number of lines in snippet
};

/** Weight for intent terms relative to query terms (1.0) in snippet scoring */
export const INTENT_WEIGHT_SNIPPET = 0.3;

export { INTENT_WEIGHT_CHUNK };

// Common stop words filtered from intent strings before tokenization.
// Seeded from finetune/reward.py KEY_TERM_STOPWORDS, extended with common
// 2-3 char function words so the length threshold can drop to >1 and let
// short domain terms (API, SQL, LLM, CPU, CDN, …) survive.
const INTENT_STOP_WORDS = new Set([
  // 2-char function words
  "am", "an", "as", "at", "be", "by", "do", "he", "if",
  "in", "is", "it", "me", "my", "no", "of", "on", "or", "so",
  "to", "up", "us", "we",
  // 3-char function words
  "all", "and", "any", "are", "but", "can", "did", "for", "get",
  "has", "her", "him", "his", "how", "its", "let", "may", "not",
  "our", "out", "the", "too", "was", "who", "why", "you",
  // 4+ char common words
  "also", "does", "find", "from", "have", "into", "more", "need",
  "show", "some", "tell", "that", "them", "this", "want", "what",
  "when", "will", "with", "your",
  // Search-context noise
  "about", "looking", "notes", "search", "where", "which",
]);

/**
 * Extract meaningful terms from an intent string, filtering stop words and punctuation.
 * Uses Unicode-aware punctuation stripping so domain terms like "API" survive.
 * Returns lowercase terms suitable for text matching.
 */
export function extractIntentTerms(intent: string): string[] {
  return intent.toLowerCase().split(/\s+/)
    .map(t => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(t => t.length > 1 && !INTENT_STOP_WORDS.has(t));
}

/**
 * Count '\n' chars in `text` before index `end`. Identical to
 * `text.slice(0, end).split('\n').length - 1` without allocating the array.
 */
function countNewlinesBefore(text: string, end: number): number {
  let count = 0;
  let idx = text.indexOf('\n');
  while (idx !== -1 && idx < end) {
    count++;
    idx = text.indexOf('\n', idx + 1);
  }
  return count;
}

export function extractSnippet(body: string, query: string, maxLen = 500, chunkPos?: number, chunkLen?: number, intent?: string): SnippetResult {
  // Single split of the full body, reused as the search lines whenever no
  // chunk window is active (previously totalLines + lines split it twice).
  const allLines = body.split('\n');
  const totalLines = allLines.length;
  let searchBody = body;
  let lineOffset = 0;
  let lines: string[] = allLines;

  if (chunkPos !== undefined && chunkPos >= 0) {
    // Search within the chunk region, with some padding for context
    // Use provided chunkLen or fall back to max chunk size (covers variable-length chunks)
    const searchLen = chunkLen || CHUNK_SIZE_CHARS;
    const contextStart = Math.max(0, chunkPos - 100);
    const contextEnd = Math.min(body.length, chunkPos + searchLen + 100);
    searchBody = body.slice(contextStart, contextEnd);
    if (contextStart > 0) {
      lineOffset = countNewlinesBefore(body, contextStart);
    }
    lines = searchBody.split('\n');
  }
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
  const intentTerms = intent ? extractIntentTerms(intent) : [];
  let bestLine = 0, bestScore = -1;

  for (let i = 0; i < lines.length; i++) {
    const lineLower = (lines[i] ?? "").toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (lineLower.includes(term)) score += 1.0;
    }
    for (const term of intentTerms) {
      if (lineLower.includes(term)) score += INTENT_WEIGHT_SNIPPET;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }

  if (chunkPos !== undefined && chunkPos >= 0 && bestScore <= 0) {
    if (chunkPos === 0) {
      // chunkPos=0 may be the chunk selector's initialization default for queries
      // where lexical chunk scoring found no winner (e.g. tokens filtered to empty
      // by the length>2 guard). Retry with full body so the real match isn't missed.
      return extractSnippet(body, query, maxLen, undefined, undefined, intent);
    }
    // For chunkPos > 0 the reranker actively picked this chunk. Tokens failing to
    // match literally is most likely a tokenizer limitation (quoted phrases, FTS5
    // syntax, HYDE passages, semantic hits), so anchor on the chunk start rather
    // than disregarding the reranker's pick.
    const contextStart = Math.max(0, chunkPos - 100);
    bestLine = chunkPos > contextStart
      ? countNewlinesBefore(searchBody, chunkPos - contextStart)
      : 0;
  }

  const start = Math.max(0, bestLine - 1);
  const end = Math.min(lines.length, bestLine + 3);
  const snippetLines = lines.slice(start, end);
  let snippetText = snippetLines.join('\n');

  // If we focused on a chunk window and it produced an empty/whitespace-only snippet,
  // fall back to a full-document snippet so we always show something useful.
  if (chunkPos && chunkPos > 0 && snippetText.trim().length === 0) {
    return extractSnippet(body, query, maxLen, undefined, undefined, intent);
  }

  if (snippetText.length > maxLen) snippetText = snippetText.substring(0, maxLen - 3) + "...";

  const absoluteStart = lineOffset + start + 1; // 1-indexed
  const snippetLineCount = snippetLines.length;
  const linesBefore = absoluteStart - 1;
  const linesAfter = totalLines - (absoluteStart + snippetLineCount - 1);

  // Format with diff-style header: @@ -start,count @@ (linesBefore before, linesAfter after)
  const header = `@@ -${absoluteStart},${snippetLineCount} @@ (${linesBefore} before, ${linesAfter} after)`;
  const snippet = `${header}\n${snippetText}`;

  return {
    line: lineOffset + bestLine + 1,
    snippet,
    linesBefore,
    linesAfter,
    snippetLines: snippetLineCount,
  };
}

// =============================================================================
// Shared helpers (used by both CLI and MCP)
// =============================================================================

/**
 * Add line numbers to text content.
 * Each line becomes: "{lineNum}: {content}"
 */
export function addLineNumbers(text: string, startLine: number = 1): string {
  const lines = text.split('\n');
  return lines.map((line, i) => `${startLine + i}: ${line}`).join('\n');
}

// =============================================================================
// Shared search orchestration
//
// hybridQuery() and vectorSearchQuery() are standalone functions (not Store
// methods) because they are orchestration over primitives — same rationale as
// reciprocalRankFusion(). They take a Store as first argument so both CLI
// and MCP can share the identical pipeline.
// =============================================================================

/**
 * Optional progress hooks for search orchestration.
 * CLI wires these to stderr for user feedback; MCP leaves them unset.
 */
export interface SearchHooks {
  /** BM25 probe found strong signal — expansion will be skipped */
  onStrongSignal?: (topScore: number) => void;
  /** Query expansion starting */
  onExpandStart?: () => void;
  /** Query expansion complete. Empty array = strong signal skip. elapsedMs = time taken. */
  onExpand?: (original: string, expanded: ExpandedQuery[], elapsedMs: number) => void;
  /** Embedding starting (vec/hyde queries) */
  onEmbedStart?: (count: number) => void;
  /** Embedding complete */
  onEmbedDone?: (elapsedMs: number) => void;
  /** Every BM25 lookup of the search finished; elapsedMs is their total */
  onFtsDone?: (elapsedMs: number) => void;
  /** Every sqlite-vec lookup of the search finished (embedding excluded); elapsedMs is their total */
  onVecDone?: (elapsedMs: number) => void;
  /** Candidates were chunked and each one's best chunk picked (runs with or without rerank) */
  onChunkDone?: (elapsedMs: number) => void;
  /**
   * A stage went without its LLM (expansion: original query only, rerank: RRF order). elapsedMs is
   * how long it was waited on after its model loaded; undefined when it was skipped outright because
   * an earlier call of that stage, abandoned at its deadline, is still running.
   */
  onDeadline?: (stage: DeadlineStage, elapsedMs?: number) => void;
  /** The stage's model finished loading (cold start or reload after idle unload); elapsedMs is the wait */
  onModelLoad?: (stage: DeadlineStage, elapsedMs: number) => void;
  /** Reranking is about to start */
  onRerankStart?: (chunkCount: number) => void;
  /** Reranking finished */
  onRerankDone?: (elapsedMs: number) => void;
}

export interface HybridQueryOptions {
  signal?: AbortSignal;
  collection?: string | readonly string[];
  filter?: MetadataFilter;  // metadata filter applied to every retrieval call
  limit?: number;           // default 10
  minScore?: number;        // default 0
  candidateLimit?: number;  // default RERANK_CANDIDATE_LIMIT
  rerankMaxDocTokens?: number;  // per-request rerank doc token cap
  explain?: boolean;        // include backend/RRF/rerank score traces
  intent?: string;          // domain intent hint for disambiguation
  skipRerank?: boolean;     // skip LLM reranking, use only RRF scores
  rerankDeadlineMs?: number; // past this, answer in RRF order (unset or 0 = wait for the reranker)
  expandDeadlineMs?: number; // past this, search the original query only (unset or 0 = wait)
  chunkStrategy?: ChunkStrategy;
  scope?: DocumentFilter;   // narrow the corpus by path glob and modified_at
  hooks?: SearchHooks;
}

export interface HybridQueryResult {
  file: string;             // internal filepath (qmd://collection/path)
  displayPath: string;
  title: string;
  body: string;             // full document body (for snippet extraction)
  bestChunk: string;        // best chunk text
  bestChunkPos: number;     // char offset of best chunk in body
  score: number;            // blended score (full precision)
  context: string | null;   // user-set context
  docid: string;            // content hash prefix (6 chars)
  metadata: DocumentMetadata; // indexed qmd.metadata for the document
  explain?: HybridQueryExplain;
}

/**
 * Attach canonical metadata to final search results with one batch query.
 * Runs after RRF/reranking so metadata is never duplicated through the
 * intermediate ranked lists.
 */
function attachResultMetadata<T extends { file: string }>(
  db: Database,
  results: T[],
): (T & { metadata: DocumentMetadata })[] {
  const metadataByFilepath = getMetadataByFilepath(db, results.map(r => r.file));
  return results.map(r => ({ ...r, metadata: metadataByFilepath.get(r.file) ?? {} }));
}

export type RankedListMeta = {
  source: "fts" | "vec";
  queryType: "original" | "lex" | "vec" | "hyde";
  query: string;
  relaxed?: boolean;  // ko-qmd: list came from the relaxed (ORed) FTS retry
  // ko-qmd: index of the subquery that produced this list. structuredSearch merges each
  // subquery's per-collection fan-out into one list tagged with its subquery, so positional
  // weight follows caller-ordered subqueries, not -c order. Absent (older callers) = position.
  searchIndex?: number;
};

/**
 * ko-qmd: vector lists count half against lex lists in RRF.
 *
 * RRF at k=60 makes a rank-1 vector hit worth almost exactly what a rank-1 lex hit is worth,
 * so on a query whose words are literally in the document the vector list pulls weaker
 * candidates past the right answer. Measured on 232 Korean wiki documents, 240 exact-phrase
 * queries: hybrid recall@5 0.9167 at full weight, 0.9542 at half — above lex alone (0.9333).
 * The 30-query paraphrase goldset, where lex scores 0.0000 and vector carries the whole
 * result, is unchanged at 0.8333 for every weight down to 0.25, so this buys the exact-query
 * case without spending the semantic one. Dropping vector to 0 does cost it (0.7667).
 */
const VEC_LIST_WEIGHT = 0.5;

/**
 * ko-qmd: weight of an FTS list that came from the relaxed retry (searchFTS `matchMode: "any"`).
 * Halving it keeps the fallback from taking over a paraphrase query, where partial word overlap
 * is the only thing it has and the vector list is the better evidence.
 */
const RELAXED_LIST_WEIGHT = 0.5;

/**
 * ko-qmd: weight of an expansion-derived list, lowered from upstream's 1.0.
 *
 * Halving the vector lists (VEC_LIST_WEIGHT) would otherwise put the original query's vector
 * list level with a lex expansion, and upstream's rule — original-query evidence outranks
 * anything the expander invented — would decide by insertion order instead of by weight.
 */
const EXPANSION_LIST_WEIGHT = 0.75;

/**
 * RRF list weights for hybridQuery.
 *
 * Original-query retrieval paths are the primary evidence and get 2x weight:
 * - original FTS
 * - original vector search
 *
 * Expansion-derived lists (lex/vec/hyde) stay at 1x regardless of list order,
 * so a lex expansion inserted before original vector search cannot steal the
 * original vector boost.
 */
export function getHybridRrfWeights(rankedListMeta: RankedListMeta[]): number[] {
  return rankedListMeta.map(meta => {
    const base = meta.queryType === "original" ? 2.0 : EXPANSION_LIST_WEIGHT;
    const weight = meta.source === "vec" ? base * VEC_LIST_WEIGHT : base;
    // A relaxed list only says "some of the words appear", so it must not outrank a vector
    // list that matched the whole question.
    return meta.relaxed ? weight * RELAXED_LIST_WEIGHT : weight;
  });
}

/**
 * RRF list weights for structuredSearch: lists from the first subquery get 2x (the caller
 * ordered subqueries by importance), the rest 1x. Lists sharing a searchIndex are one
 * subquery fanned out across collections, so they share its weight — `-c a -c b` and
 * `-c b -c a` fuse identically. Meta without searchIndex falls back to list position.
 *
 * ko-qmd: a relaxed FTS list counts half here too, as in getHybridRrfWeights. At a flat 2.0 a
 * lex line that only matched some of a question's words outranked the vector list, and a decoy
 * sharing a few of those words took rank 1 (test/fixtures/ko-vault/BASELINE.md 2026-09-27).
 * ko-qmd: a relaxed first-subquery list forfeits the positional boost and halves again
 * (0.25) — even halved, its rank 1 still tied a vector rank 1 with a lex rank 4
 * (hmu-05, 2026-10-09 probe).
 */
const RELAXED_FIRST_LIST_WEIGHT = 0.25;
export function getStructuredRrfWeights(rankedListMeta: RankedListMeta[]): number[] {
  const firstKey = rankedListMeta[0]?.searchIndex ?? 0;
  return rankedListMeta.map((meta, i) => {
    const isFirst = (meta.searchIndex ?? i) === firstKey;
    if (meta.relaxed) return isFirst ? RELAXED_FIRST_LIST_WEIGHT : RELAXED_LIST_WEIGHT;
    return isFirst ? 2.0 : 1.0;
  });
}

/**
 * How much of the blended score the retrieval position is worth. The reranker
 * decides; position only separates documents it scores alike.
 */
const POSITION_TIEBREAK_WEIGHT = 0.1;

/**
 * Blend a reranker score with a linear retrieval-position tiebreak.
 *
 * The position term used to be 1/rrfRank under rank-gated weights (0.75/0.60/0.40).
 * That score drops 50% between rank 1 and rank 2 — a gap of 0.375 at weight 0.75,
 * larger than the 0.25 the whole reranker term could ever contribute — so no
 * reranker score could displace the top retrieval hit, and the reranker was inert
 * exactly where it decided the answer. A linear decay over the candidate window
 * separates adjacent ranks by a constant the reranker can overcome.
 *
 * Measured 2026-09-18 on one fixed candidate dump per goldset, so every formula was
 * scored against identical retrieval (scripts/bench-dump-candidates.ts feeding
 * scripts/bench-blend-sweep.mjs):
 *
 *                 alias (n=223)         paraphrase (n=30)
 *   1/rrfRank     r@1 .713  mrr .808    r@1 .467  mrr .664
 *   this          r@1 .874  mrr .927    r@1 .867  mrr .903
 *
 * On both goldsets the old blend's r@1 equalled retrieval-only r@1 to three
 * decimals, which is what "the reranker cannot move rank 1" looks like as a number.
 */
export function blendRerankScore(rrfRank: number, rerankScore: number, candidateLimit: number): number {
  const positionScore = 1 - (rrfRank - 1) / candidateLimit;
  return (1 - POSITION_TIEBREAK_WEIGHT) * rerankScore + POSITION_TIEBREAK_WEIGHT * positionScore;
}

type RerankCandidate = { file: string; displayPath: string; title: string; body: string };
type CandidateChunks = { chunks: RerankChunk[]; bestIdx: number };

const TIMED_OUT = Symbol("timed out");

/**
 * The promise's value, or TIMED_OUT once `deadlineMs` passes (unset or 0 = no deadline). The
 * promise is not cancelled: a late rerank still lands in the rerank cache for the next query.
 */
async function withDeadline<T>(promise: Promise<T>, deadlineMs: number | undefined): Promise<T | typeof TIMED_OUT> {
  if (!deadlineMs || deadlineMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), deadlineMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export type DeadlineStage = "expand" | "rerank";

/** The store an LLM stage runs for. Abandoned-call counts key on its identity; every stage owner can rerank. */
type DeadlineOwner = Pick<Store, "rerank">;

/**
 * LLM calls abandoned at their deadline and still running, per store and stage. While one runs, the
 * next call of that stage would only queue behind it on the same model and time out too, so it is
 * skipped instead: this caps the backlog at one abandoned call per stage instead of one per query.
 */
const abandoned = new WeakMap<DeadlineOwner, Record<DeadlineStage, { running: number; warned: boolean }>>();

/**
 * Bound on the model-load wait inside runWithDeadline: a load that never
 * reports ready must not hang the query. QMD_LLM_LOAD_TIMEOUT_MS sets it
 * (positive ms, 0 = wait forever, anything else = the default).
 */
export const DEFAULT_LOAD_TIMEOUT_MS = 120_000;

/** Load-timeout resolver for runWithDeadline; exported for tests. */
export function resolveLoadTimeoutMs(): number {
  const raw = process.env.QMD_LLM_LOAD_TIMEOUT_MS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_LOAD_TIMEOUT_MS;
  return /^\d+$/.test(raw) ? Number(raw) : DEFAULT_LOAD_TIMEOUT_MS;
}

/**
 * Run one LLM stage under a deadline. The clock starts once the stage's model is loaded
 * (`onModelReady`): the deadline bounds computation, not a cold load, which is reported through
 * `onModelLoad`. The load wait itself is bounded separately by resolveLoadTimeoutMs, so a load
 * that never reports ready times out instead of hanging. TIMED_OUT when either bound passes,
 * or at once while an earlier abandoned call of the stage is still running.
 * Unset or 0 deadline = plain await (still under the load bound).
 */
async function runWithDeadline<T>(
  store: DeadlineOwner,
  stage: DeadlineStage,
  deadlineMs: number | undefined,
  hooks: SearchHooks | undefined,
  start: (onModelReady: () => void) => Promise<T>,
): Promise<T | typeof TIMED_OUT> {
  const started = Date.now();
  let loadedAt: number | undefined;
  const reportLoad = () => { if (loadedAt !== undefined) hooks?.onModelLoad?.(stage, loadedAt - started); };

  const byStage = abandoned.get(store) ?? { expand: { running: 0, warned: false }, rerank: { running: 0, warned: false } };
  abandoned.set(store, byStage);
  const state = byStage[stage];
  const abandon = () => {
    state.running++;
    const settle = () => {
      state.running--;
      if (state.running === 0) state.warned = false;
    };
    pending.then(settle, settle);
  };
  if (deadlineMs && deadlineMs > 0 && state.running > 0) {
    if (!state.warned) {
      state.warned = true;
      process.stderr.write(`qmd: a ${stage} abandoned at its deadline is still running — answering without ${stage} until it finishes\n`);
    }
    hooks?.onDeadline?.(stage);
    return TIMED_OUT;
  }

  let markReady = () => {};
  const ready = new Promise<void>((resolve) => { markReady = () => { loadedAt = Date.now(); resolve(); }; });
  const pending = start(markReady);
  // Bound the load wait itself: neither a stuck load nor a call that finishes
  // without reporting ready may hold the query past the load timeout. The
  // timer is cleared on every settle so idle processes keep no handle.
  const loadTimeoutMs = resolveLoadTimeoutMs();
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  const loadTimedOut = new Promise<"load-timeout">((resolve) => {
    if (loadTimeoutMs > 0) {
      loadTimer = setTimeout(() => resolve("load-timeout"), loadTimeoutMs);
      loadTimer.unref?.();
    }
  });
  const settled = await Promise.race([
    ready.then(() => "ready" as const),
    loadTimedOut,
    pending.then(() => "done" as const, () => "done" as const),
  ]);
  clearTimeout(loadTimer);
  if (settled === "load-timeout") {
    abandon();
    hooks?.onModelLoad?.(stage, Date.now() - started);
    hooks?.onDeadline?.(stage, Date.now() - started);
    return TIMED_OUT;
  }
  reportLoad();
  if (settled === "done") return pending;
  if (!deadlineMs || deadlineMs <= 0) return pending;

  const result = await withDeadline(pending, deadlineMs);
  if (result === TIMED_OUT) {
    abandon();
    hooks?.onDeadline?.(stage, Date.now() - (loadedAt ?? started));
  }
  return result;
}

/** Rerank `chunks`, or null when the reranker misses `deadlineMs` (the caller then answers in RRF order). */
export const RERANK_CASCADE_FIRST_BATCH = 8;
/** Skip the tail past the first batch when the top-2 rerank margin reaches this. */
export const RERANK_CASCADE_MARGIN = 0.08;

/** First-batch size, overridable for tuning via `QMD_RERANK_FIRST_BATCH`. */
export function rerankCascadeFirstBatch(): number {
  const raw = Number(process.env.QMD_RERANK_FIRST_BATCH);
  return Number.isInteger(raw) && raw > 1 ? raw : RERANK_CASCADE_FIRST_BATCH;
}

/** Tail-skip margin, overridable for tuning via `QMD_RERANK_MARGIN`. */
export function rerankCascadeMargin(): number {
  const raw = process.env.QMD_RERANK_MARGIN?.trim();
  if (raw === undefined || raw === "") return RERANK_CASCADE_MARGIN;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : RERANK_CASCADE_MARGIN;
}

/**
 * QMD_RERANK_CASCADE=0 (or false/off/no) restores single-batch rerank;
 * anything else (including unset) cascades. Kill switch for measurement and
 * operations; exported for tests.
 */
export function isRerankCascadeEnabled(): boolean {
  const raw = process.env.QMD_RERANK_CASCADE?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

/**
 * True when the first cascade batch's top-2 margin is too tight to skip the
 * tail: a contested top means an unscored document could still win the blend.
 * A batch of fewer than two holds nothing to contest.
 */
export function cascadeNeedsSecondBatch(
  sortedScores: number[],
  margin: number = rerankCascadeMargin(),
): boolean {
  if (sortedScores.length < 2) return false;
  const [top, second] = [sortedScores[0]!, sortedScores[1]!];
  if (!Number.isFinite(top) || !Number.isFinite(second)) return true;
  return top - second < margin;
}

export async function rerankWithDeadline(
  store: DeadlineOwner,
  query: string,
  chunks: { file: string; text: string }[],
  intent: string | undefined,
  options: { rerankMaxDocTokens?: number; rerankDeadlineMs?: number; hooks?: SearchHooks; signal?: AbortSignal } | undefined,
): Promise<{ file: string; score: number; unscored?: boolean }[] | null> {
  const hooks = options?.hooks;
  hooks?.onRerankStart?.(chunks.length);
  const start = Date.now();
  const scoreBatch = (
    docs: { file: string; text: string }[],
    deadlineMs: number | undefined,
  ) =>
    runWithDeadline(store, "rerank", deadlineMs, hooks, (onModelReady) =>
      store.rerank(query, docs, undefined, intent, { maxDocTokens: options?.rerankMaxDocTokens, onModelReady, signal: options?.signal }));
  // Cascade: score the RRF head first. On a decisive top margin the tail keeps
  // score 0 (RRF position tiebreak only) instead of paying for 25 more
  // cross-encoder pairs; a contested top scores everything, as before.
  // Tail placeholders are marked unscored: the minScore filter exempts them,
  // since a 0 placeholder was never measured and must not read as "scored 0".
  if (isRerankCascadeEnabled() && chunks.length > rerankCascadeFirstBatch()) {
    const first = chunks.slice(0, rerankCascadeFirstBatch());
    const rest = chunks.slice(rerankCascadeFirstBatch());
    const firstScored = await scoreBatch(first, options?.rerankDeadlineMs);
    if (firstScored === TIMED_OUT) return null;
    const headroom = [...firstScored].sort((a, b) => b.score - a.score).map((r) => r.score);
    if (!cascadeNeedsSecondBatch(headroom)) {
      hooks?.onRerankDone?.(Date.now() - start);
      return [...firstScored, ...rest.map((d) => ({ file: d.file, score: 0, unscored: true as const }))];
    }
    // The second batch shares the caller's deadline: it gets only the remaining
    // budget, so the worst case stays one deadline, not two. An exhausted budget
    // is the same as a timeout — the caller falls back to RRF order.
    // Same "no deadline" rule as runWithDeadline: unset or <= 0 waits unbounded.
    const deadlineMs = options?.rerankDeadlineMs;
    const remaining = deadlineMs && deadlineMs > 0 ? deadlineMs - (Date.now() - start) : undefined;
    if (remaining !== undefined && remaining <= 0) {
      hooks?.onDeadline?.("rerank", Date.now() - start);
      return null;
    }
    const restScored = await scoreBatch(rest, remaining);
    if (restScored === TIMED_OUT) return null;
    hooks?.onRerankDone?.(Date.now() - start);
    return [...firstScored, ...restScored];
  }
  const reranked = await scoreBatch(chunks, options?.rerankDeadlineMs);
  if (reranked === TIMED_OUT) return null;
  hooks?.onRerankDone?.(Date.now() - start);
  return reranked;
}

/**
 * Cut each candidate into chunks and pick the one to rerank (`selectRerankChunk`). A document
 * with no chunks is left out of the map.
 */
const chunkCandidatesForRerank = async (
  candidates: RerankCandidate[],
  query: string,
  intent: string | undefined,
  chunkStrategy: ChunkStrategy | undefined,
  signal?: AbortSignal,
): Promise<Map<string, CandidateChunks>> => {
  const intentTerms = intent ? extractIntentTerms(intent) : [];
  const docChunkMap = new Map<string, CandidateChunks>();
  for (const cand of candidates) {
    // Same script-aware ratio the indexer uses, so a Korean body does not
    // arrive at the reranker as one ~3600-char (≈2× English) chunk.
    const { maxChars, overlapChars, windowChars } = scriptAwareCharBudgets(
      cand.body,
      CHUNK_SIZE_TOKENS,
      CHUNK_OVERLAP_TOKENS,
      CHUNK_WINDOW_TOKENS,
      SEARCH_PATH_OTHER_CHARS_PER_TOKEN,
    );
    signal?.throwIfAborted();
    const chunks = await chunkDocumentAsync(cand.body, maxChars, overlapChars, windowChars, cand.file, chunkStrategy);
    signal?.throwIfAborted();
    if (chunks.length === 0) continue;
    docChunkMap.set(cand.file, { chunks, bestIdx: selectRerankChunk(chunks, query, intentTerms) });
  }
  return docChunkMap;
};

/** The reranker's documents, in candidate order: `formatRerankDoc` over each selected chunk. */
const rerankDocuments = (
  candidates: RerankCandidate[],
  docChunkMap: Map<string, CandidateChunks>,
): { file: string; text: string }[] =>
  candidates.flatMap((cand) => {
    const chunkInfo = docChunkMap.get(cand.file);
    return chunkInfo ? [{ file: cand.file, text: formatRerankDoc(chunkInfo.chunks[chunkInfo.bestIdx]!.text, cand) }] : [];
  });

/**
 * Hybrid search: BM25 + vector + query expansion + RRF + chunked reranking.
 *
 * Pipeline:
 * 1. BM25 probe → skip expansion if strong signal
 * 2. expandQuery() → typed query variants (lex/vec/hyde)
 * 3. Type-routed search: original→vector, lex→FTS, vec/hyde→vector
 * 4. RRF fusion → slice to candidateLimit
 * 5. chunkDocument() + keyword-best-chunk selection
 * 6. rerank on chunks (NOT full bodies — O(tokens) trap)
 * 7. Position-aware score blending (RRF rank × reranker score)
 * 8. Dedup by file, filter by minScore, slice to limit
 */
export async function hybridQuery(
  store: Store,
  rawQuery: string,
  options?: HybridQueryOptions
): Promise<HybridQueryResult[]> {
  const signal = options?.signal;
  signal?.throwIfAborted();
  // ko-qmd: "X 말고 Y" names X to exclude — every list and the reranker see only Y.
  // (Tried demoting X with lex -terms: falsified 2026-10-09 — the expected note
  // often discusses X itself, e.g. bm25-ranking.md mentions TF-IDF, so NOT
  // removes the answer along with the decoy.)
  const query = stripHangulNegation(rawQuery);
  const limit = options?.limit ?? 10;
  const minScore = options?.minScore ?? 0;
  // Floor at 1: a zero/negative limit inverts the position score
  // (1-(rank-1)/candidateLimit grows with rank) and makes slice(0, limit)
  // drop trailing candidates. NaN passes through unchanged (out of scope).
  const candidateLimit = Math.max(1, options?.candidateLimit ?? RERANK_CANDIDATE_LIMIT);
  const collection = options?.collection;
  const filter = options?.filter;
  const explain = options?.explain ?? false;
  const intent = options?.intent;
  const skipRerank = options?.skipRerank ?? false;
  const scope = options?.scope;
  const hooks = options?.hooks;

  const rankedLists: RankedResult[][] = [];
  const rankedListMeta: RankedListMeta[] = [];
  const docidMap = new Map<string, string>(); // filepath -> docid
  const hasVectors = hasVectorIndex(store.db);

  // Step 1: BM25 probe — strong signal skips expensive LLM expansion
  // When intent is provided, disable strong-signal bypass — the obvious BM25
  // match may not be what the caller wants (e.g. "performance" with intent
  // "web page load times" should NOT shortcut to a sports-performance doc).
  // Pass collection and metadata filter directly into FTS query (filter at
  // SQL level, not post-hoc) — the strong-signal decision must be based only
  // on eligible documents.
  let ftsStart = Date.now();
  const initialFts = store.searchFTS(query, 20, collection, filter, scope);
  let ftsMs = Date.now() - ftsStart;
  const topScore = initialFts[0]?.score ?? 0;
  const secondScore = initialFts[1]?.score ?? 0;
  // ko-qmd: a relaxed match is never a strong signal — it did not match all the words.
  const hasStrongSignal = !intent && initialFts.length > 0 && initialFts[0]?.matchMode !== "any"
    && topScore >= STRONG_SIGNAL_MIN_SCORE
    && (topScore - secondScore) >= STRONG_SIGNAL_MIN_GAP;

  if (hasStrongSignal) hooks?.onStrongSignal?.(topScore);

  // Step 2: Expand query (or skip if strong signal or Hangul)
  // ko-qmd: a query with any Hangul is never expanded. On the ko-vault goldset the expansion model
  // wrote English templates and stray Chinese around Korean questions, its sampling alone moved hard
  // rank 1 by up to five of 30 queries between runs, and it cost ~1 s per query
  // (test/fixtures/ko-vault/BASELINE.md 2026-09-26).
  const skipsExpansion = hasStrongSignal || containsHangul(query);
  hooks?.onExpandStart?.();
  signal?.throwIfAborted();
  const expandStart = Date.now();
  const expansion = skipsExpansion
    ? []
    : await runWithDeadline(store, "expand", options?.expandDeadlineMs, hooks, (onModelReady) =>
        store.expandQuery(query, undefined, { onModelReady }));
  const expanded = expansion === TIMED_OUT ? [] : expansion;
  signal?.throwIfAborted();

  hooks?.onExpand?.(query, expanded, Date.now() - expandStart);
  signal?.throwIfAborted();

  // Seed with initial FTS results (avoid re-running original query FTS)
  if (initialFts.length > 0) {
    for (const r of initialFts) docidMap.set(r.filepath, r.docid);
    rankedLists.push(initialFts.map(r => ({
      file: r.filepath, displayPath: r.displayPath,
      title: r.title, body: r.body || "", score: r.score,
    })));
    rankedListMeta.push({
      source: "fts", queryType: "original", query,
      relaxed: initialFts[0]?.matchMode === "any",
    });
  }

  // Step 3: Route searches by query type
  //
  // Strategy: run all FTS queries immediately (they're sync/instant), then
  // batch-embed all vector queries in one embedBatch() call, then run
  // sqlite-vec lookups with pre-computed embeddings.

  // 3a: Run FTS for all lex expansions right away (no LLM needed)
  ftsStart = Date.now();
  for (const q of expanded) {
    if (q.type === 'lex') {
      const ftsResults = store.searchFTS(q.query, 20, collection, filter, scope);
      if (ftsResults.length > 0) {
        for (const r of ftsResults) docidMap.set(r.filepath, r.docid);
        rankedLists.push(ftsResults.map(r => ({
          file: r.filepath, displayPath: r.displayPath,
          title: r.title, body: r.body || "", score: r.score,
        })));
        rankedListMeta.push({
          source: "fts", queryType: "lex", query: q.query,
          relaxed: ftsResults[0]?.matchMode === "any",
        });
      }
    }
  }
  hooks?.onFtsDone?.(ftsMs + Date.now() - ftsStart);

  // 3b: Collect all texts that need vector search (original query + vec/hyde expansions)
  if (hasVectors) {
    const vecQueries: { text: string; queryType: "original" | "vec" | "hyde" }[] = [
      { text: query, queryType: "original" },
    ];
    for (const q of expanded) {
      if (q.type === 'vec' || q.type === 'hyde') {
        vecQueries.push({ text: q.query, queryType: q.type });
      }
    }

    // Batch embed all vector queries in a single call
    const llm = getLlm(store);
    const embedModel = llm.embedModelName;
    assertRemoteEmbeddingBoundary(store.db, embedModel, collection, filter);
    const textsToEmbed = vecQueries.map(q => formatQueryForEmbedding(q.text, embedModel));
    hooks?.onEmbedStart?.(textsToEmbed.length);
    const embedStart = Date.now();
    signal?.throwIfAborted();
    const embeddings = await llm.embedBatch(textsToEmbed, signal ? { signal } : undefined);
    signal?.throwIfAborted();
    hooks?.onEmbedDone?.(Date.now() - embedStart);
    signal?.throwIfAborted();

    // Run sqlite-vec lookups with pre-computed embeddings
    const vecStart = Date.now();
    for (let i = 0; i < vecQueries.length; i++) {
      const embedding = embeddings[i]?.embedding;
      if (!embedding) continue;

      const vecResults = await store.searchVec(
        vecQueries[i]!.text, embedModel, 20, collection,
        undefined, embedding, filter, scope
      );
      signal?.throwIfAborted();
      if (vecResults.length > 0) {
        for (const r of vecResults) docidMap.set(r.filepath, r.docid);
        rankedLists.push(vecResults.map(r => ({
          file: r.filepath, displayPath: r.displayPath,
          title: r.title, body: r.body || "", score: r.score,
        })));
        rankedListMeta.push({
          source: "vec",
          queryType: vecQueries[i]!.queryType,
          query: vecQueries[i]!.text,
        });
      }
    }
    hooks?.onVecDone?.(Date.now() - vecStart);
  }

  // Step 3c: drop a cached expansion whose sub-queries all came back empty —
  // the dud is cached per (query, model), so left in place it deterministically
  // replays the same misses on every warm repeat. Only judge sub-queries the
  // store could actually run: on FTS-only stores, vec/hyde expansions never
  // execute and say nothing about the expansion's quality.
  signal?.throwIfAborted();
  if (expanded.length > 0) {
    const runnable = expanded.filter(q => q.type === "lex" || hasVectors);
    const expansionContributed = rankedListMeta.some(m => m.queryType !== "original");
    if (runnable.length > 0 && !expansionContributed) {
      store.invalidateExpansionCache(query);
    }
  }

  // Step 4: RRF fusion — original-query FTS and vector lists get 2x weight;
  // expansion-derived lists stay at 1x independent of insertion order.
  // A relaxed list additionally scales each document by its query coverage.
  const weights = getHybridRrfWeights(rankedListMeta);
  const docMultipliers = rrfDocMultipliers(rankedLists, rankedListMeta);
  const fused = reciprocalRankFusion(rankedLists, weights, 60, docMultipliers);
  const rrfTraceByFile = explain ? buildRrfTrace(rankedLists, weights, rankedListMeta, 60, docMultipliers) : null;
  const candidates = fused.slice(0, candidateLimit);

  if (candidates.length === 0) return [];

  // One batched context lookup for all candidates (was one N+1 triple per row
  // in both assembly branches below — every assembled file comes from candidates).
  const contexts = getContextsForFiles(store.db, candidates.map((c) => c.file));

  // Step 5: Chunk documents, pick best chunk per doc for reranking.
  // Reranking full bodies is O(tokens) — the critical perf lesson that motivated this refactor.
  const chunkStart = Date.now();
  const docChunkMap = await chunkCandidatesForRerank(candidates, query, intent, options?.chunkStrategy, signal);
  hooks?.onChunkDone?.(Date.now() - chunkStart);

  // Step 6: Rerank chunks (NOT full bodies). No reranker, or one past its deadline, means RRF order.
  const reranked = skipRerank
    ? null
    : await rerankWithDeadline(store, query, rerankDocuments(candidates, docChunkMap), intent, options);
  signal?.throwIfAborted();

  if (reranked === null) {
    // Skip LLM reranking — return candidates scored by RRF only
    const seenFiles = new Set<string>();
    const rrfResults = candidates
      .map((cand, i) => {
        const chunkInfo = docChunkMap.get(cand.file);
        const bestIdx = chunkInfo?.bestIdx ?? 0;
        const bestChunk = chunkInfo?.chunks[bestIdx]?.text || cand.body || "";
        const bestChunkPos = chunkInfo?.chunks[bestIdx]?.pos || 0;
        const rrfRank = i + 1;
        const rrfScore = 1 / rrfRank;
        const trace = rrfTraceByFile?.get(cand.file);
        const explainData: HybridQueryExplain | undefined = explain ? {
          ftsScores: trace?.contributions.filter(c => c.source === "fts").map(c => c.backendScore) ?? [],
          vectorScores: trace?.contributions.filter(c => c.source === "vec").map(c => c.backendScore) ?? [],
          rrf: {
            rank: rrfRank,
            positionScore: rrfScore,
            weight: 1.0,
            baseScore: trace?.baseScore ?? 0,
            topRankBonus: trace?.topRankBonus ?? 0,
            totalScore: trace?.totalScore ?? 0,
            contributions: trace?.contributions ?? [],
          },
          rerankScore: 0,
          blendedScore: rrfScore,
        } : undefined;

        return {
          file: cand.file,
          displayPath: cand.displayPath,
          title: cand.title,
          body: cand.body,
          bestChunk,
          bestChunkPos,
          score: rrfScore,
          context: contexts.get(cand.file) ?? null,
          docid: docidMap.get(cand.file) || "",
          ...(explainData ? { explain: explainData } : {}),
        };
      })
      .filter(r => {
        if (seenFiles.has(r.file)) return false;
        seenFiles.add(r.file);
        return true;
      })
      // minScore is a threshold on blended rerank scores; a deadline fallback's 1/rank scores would
      // cut a 0.5 threshold to two results, so only a caller that skipped rerank gets it applied here.
      .filter(r => !skipRerank || r.score >= minScore)
      .slice(0, limit);
    const results = attachResultMetadata(store.db, rrfResults);
    signal?.throwIfAborted();
    return results;
  }


  // Step 7: Blend RRF position score with reranker score
  // Position-aware weights: top retrieval results get more protection from reranker disagreement
  const candidateMap = new Map(candidates.map(c => [c.file, {
    displayPath: c.displayPath, title: c.title, body: c.body,
  }]));
  const rrfRankMap = new Map(candidates.map((c, i) => [c.file, i + 1]));
  // Cascade-tail placeholders were never scored: exempt them from the minScore
  // filter below, or a decisive head would silently drop the whole tail.
  const unscoredFiles = new Set(reranked.filter(r => r.unscored).map(r => r.file));

  const blended = reranked.map(r => {
    const rrfRank = rrfRankMap.get(r.file) || candidateLimit;
    const rrfScore = 1 - (rrfRank - 1) / candidateLimit;
    const blendedScore = blendRerankScore(rrfRank, r.score, candidateLimit);

    const candidate = candidateMap.get(r.file);
    const chunkInfo = docChunkMap.get(r.file);
    const bestIdx = chunkInfo?.bestIdx ?? 0;
    const bestChunk = chunkInfo?.chunks[bestIdx]?.text || candidate?.body || "";
    const bestChunkPos = chunkInfo?.chunks[bestIdx]?.pos || 0;
    const trace = rrfTraceByFile?.get(r.file);
    const explainData: HybridQueryExplain | undefined = explain ? {
      ftsScores: trace?.contributions.filter(c => c.source === "fts").map(c => c.backendScore) ?? [],
      vectorScores: trace?.contributions.filter(c => c.source === "vec").map(c => c.backendScore) ?? [],
      rrf: {
        rank: rrfRank,
        positionScore: rrfScore,
        weight: POSITION_TIEBREAK_WEIGHT,
        baseScore: trace?.baseScore ?? 0,
        topRankBonus: trace?.topRankBonus ?? 0,
        totalScore: trace?.totalScore ?? 0,
        contributions: trace?.contributions ?? [],
      },
      rerankScore: r.score,
      blendedScore,
    } : undefined;

    return {
      file: r.file,
      displayPath: candidate?.displayPath || "",
      title: candidate?.title || "",
      body: candidate?.body || "",
      bestChunk,
      bestChunkPos,
      score: blendedScore,
      context: contexts.get(r.file) ?? null,
      docid: docidMap.get(r.file) || "",
      ...(explainData ? { explain: explainData } : {}),
    };
  }).sort((a, b) => b.score - a.score);

  // Step 8: Dedup by file (safety net — prevents duplicate output)
  const seenFiles = new Set<string>();
  const finalResults = blended
    .filter(r => {
      if (seenFiles.has(r.file)) return false;
      seenFiles.add(r.file);
      return true;
    })
    .filter(r => unscoredFiles.has(r.file) || r.score >= minScore)
    .slice(0, limit);
  const results = attachResultMetadata(store.db, finalResults);
  signal?.throwIfAborted();
  return results;
}

export interface VectorSearchOptions {
  collection?: string | readonly string[];
  filter?: MetadataFilter;  // metadata filter applied to every retrieval call
  limit?: number;           // default 10
  minScore?: number;        // default 0.3
  intent?: string;          // domain intent hint for disambiguation
  scope?: DocumentFilter;   // narrow the corpus by path glob and modified_at
  hooks?: Pick<SearchHooks, 'onExpand'>;
}

export interface VectorSearchResult {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  score: number;
  context: string | null;
  docid: string;
  metadata: DocumentMetadata;
}

/**
 * Vector-only semantic search with query expansion.
 *
 * Pipeline:
 * 1. expandQuery() → typed variants, filter to vec/hyde only (lex irrelevant here)
 * 2. searchVec() for original + vec/hyde variants (sequential — node-llama-cpp embed limitation)
 * 3. Dedup by filepath (keep max score)
 * 4. Sort by score descending, filter by minScore, slice to limit
 */
export async function vectorSearchQuery(
  store: Store,
  query: string,
  options?: VectorSearchOptions
): Promise<VectorSearchResult[]> {
  const limit = options?.limit ?? 10;
  const minScore = options?.minScore ?? 0.3;
  const collection = options?.collection;
  const filter = options?.filter;
  const intent = options?.intent;
  const scope = options?.scope;

  const hasVectors = hasVectorIndex(store.db);
  if (!hasVectors) return [];

  // Expand query — filter to vec/hyde only (lex queries target FTS, not vector)
  const expandStart = Date.now();
  const allExpanded = await store.expandQuery(query);
  const vecExpanded = allExpanded.filter(q => q.type !== 'lex');
  options?.hooks?.onExpand?.(query, vecExpanded, Date.now() - expandStart);

  // Run original + vec/hyde expanded through vector, sequentially — concurrent embed() hangs
  const embedModel = getLlm(store).embedModelName;
  const queryTexts = [query, ...vecExpanded.map(q => q.query)];
  const allResults = new Map<string, VectorSearchResult>();
  for (const q of queryTexts) {
    const vecResults = await store.searchVec(q, embedModel, limit, collection, undefined, undefined, filter, scope);
    for (const r of vecResults) {
      const existing = allResults.get(r.filepath);
      if (!existing || r.score > existing.score) {
        allResults.set(r.filepath, {
          file: r.filepath,
          displayPath: r.displayPath,
          title: r.title,
          body: r.body || "",
          score: r.score,
          // Context is filled in one batch below (was one N+1 triple per row here).
          context: null,
          docid: r.docid,
          metadata: r.metadata,
        });
      }
    }
  }

  const final = Array.from(allResults.values())
    .sort((a, b) => b.score - a.score)
    .filter(r => r.score >= minScore)
    .slice(0, limit);
  // One batched context lookup for the final rows.
  const contexts = getContextsForFiles(store.db, final.map((r) => r.file));
  return final.map((r) => ({ ...r, context: contexts.get(r.file) ?? null }));
}

// =============================================================================
// Structured search — pre-expanded queries from LLM
// =============================================================================

/**
 * A single sub-search in a structured search request.
 * Matches the format used in QMD training data.
 */
export interface StructuredSearchOptions {
  signal?: AbortSignal;
  collections?: string[];   // Filter to specific collections (OR match)
  filter?: MetadataFilter;  // metadata filter applied to every retrieval call
  limit?: number;           // default 10
  minScore?: number;        // default 0
  candidateLimit?: number;  // default RERANK_CANDIDATE_LIMIT
  rerankMaxDocTokens?: number;  // per-request rerank doc token cap
  explain?: boolean;        // include backend/RRF/rerank score traces
  /** Domain intent hint for disambiguation — steers reranking and chunk selection */
  intent?: string;
  /** Skip LLM reranking, use only RRF scores */
  skipRerank?: boolean;
  rerankDeadlineMs?: number; // past this, answer in RRF order (unset or 0 = wait for the reranker)
  chunkStrategy?: ChunkStrategy;
  /** Narrow the corpus by path glob and modified_at before anything is ranked */
  scope?: DocumentFilter;
  hooks?: SearchHooks;
}

/**
 * Structured search: execute pre-expanded queries without LLM query expansion.
 *
 * Designed for LLM callers (MCP/HTTP) that generate their own query expansions.
 * Skips the internal expandQuery() step — goes directly to:
 *
 * Pipeline:
 * 1. Route searches: lex→FTS, vec/hyde→vector (batch embed)
 * 2. RRF fusion across all result lists
 * 3. Chunk documents + keyword-best-chunk selection
 * 4. Rerank on chunks
 * 5. Position-aware score blending
 * 6. Dedup, filter, slice
 *
 * This is the recommended endpoint for capable LLMs — they can generate
 * better query variations than our small local model, especially for
 * domain-specific or nuanced queries.
 */
export async function structuredSearch(
  store: Store,
  rawSearches: ExpandedQuery[],
  options?: StructuredSearchOptions
): Promise<HybridQueryResult[]> {
  const signal = options?.signal;
  signal?.throwIfAborted();
  const limit = options?.limit ?? 10;
  const minScore = options?.minScore ?? 0;
  // Floor at 1: see hybridQuery — a zero/negative limit inverts the position
  // score and makes slice(0, limit) drop trailing candidates.
  const candidateLimit = Math.max(1, options?.candidateLimit ?? RERANK_CANDIDATE_LIMIT);
  const explain = options?.explain ?? false;
  const intent = options?.intent;
  const skipRerank = options?.skipRerank ?? false;
  const filter = options?.filter;
  const hooks = options?.hooks;

  const collections = options?.collections;
  const scope = options?.scope;

  if (rawSearches.length === 0) return [];

  // -C is documented as "Max candidates to rerank": the fusion pool must be
  // able to fill it. The historic per-list breadth was a hardcoded 20, so the
  // pool capped at 20×lists no matter what -C asked for. Grow the per-list
  // breadth only above the default candidateLimit — at or below the default
  // the fetch is byte-for-byte the old one, so default output is unchanged.
  const breadth = candidateLimit > RERANK_CANDIDATE_LIMIT ? candidateLimit : 20;

  // Validate queries before executing
  for (const search of rawSearches) {
    const location = search.line ? `Line ${search.line}` : 'Structured search';
    if (/[\r\n]/.test(search.query)) {
      throw new Error(`${location} (${search.type}): queries must be single-line. Remove newline characters.`);
    }
    if (search.type === 'lex') {
      const error = validateLexQuery(search.query);
      if (error) {
        throw new Error(`${location} (lex): ${error}`);
      }
    } else if (search.type === 'vec' || search.type === 'hyde') {
      const error = validateSemanticQuery(search.query);
      if (error) {
        throw new Error(`${location} (${search.type}): ${error}`);
      }
    }
  }

  // ko-qmd: "X 말고 Y" names X to exclude — lex and vec lines, and the rerank query taken from
  // them, keep only Y. A hyde line is a passage, not a query, and stays as written.
  const searches = rawSearches.map((search) =>
    search.type === 'hyde' ? search : { ...search, query: stripHangulNegation(search.query) }
  );

  const rankedLists: RankedResult[][] = [];
  const rankedListMeta: RankedListMeta[] = [];
  const docidMap = new Map<string, string>(); // filepath -> docid
  const hasVectors = hasVectorIndex(store.db);

  // Each search yields ONE ranked list over the union of the named collections
  // (undefined = all). searchFTS/searchVec merge per-collection results by score,
  // so the RRF weight below boosts the first search, not the first collection.

  // Step 1: Run FTS for all lex searches (sync, instant).
  const ftsStart = Date.now();
  for (let si = 0; si < searches.length; si++) {
    const search = searches[si]!;
    if (search.type !== 'lex') continue;
    const ftsResults = store.searchFTS(search.query, breadth, collections, filter, scope);
    if (ftsResults.length === 0) continue;
    for (const r of ftsResults) docidMap.set(r.filepath, r.docid);
    rankedLists.push(ftsResults.map(r => ({
      file: r.filepath, displayPath: r.displayPath,
      title: r.title, body: r.body || "", score: r.score,
    })));
    rankedListMeta.push({
      source: "fts",
      queryType: "lex",
      query: search.query,
      relaxed: ftsResults[0]?.matchMode === "any",
      searchIndex: si,
    });
  }
  if (searches.some(s => s.type === 'lex')) hooks?.onFtsDone?.(Date.now() - ftsStart);

  // Step 2: Batch embed and run vector searches for vec/hyde
  if (hasVectors) {
    const vecSearches = searches
      .map((s, searchIndex) => ({ s, searchIndex }))
      .filter(
        (e): e is { s: ExpandedQuery & { type: 'vec' | 'hyde' }; searchIndex: number } =>
          e.s.type === 'vec' || e.s.type === 'hyde'
      );
    if (vecSearches.length > 0) {
      const llm = getLlm(store);
      const embedModel = llm.embedModelName;
      assertRemoteEmbeddingBoundary(store.db, embedModel, collections, filter);
      const textsToEmbed = vecSearches.map(e => formatQueryForEmbedding(e.s.query, embedModel));
      hooks?.onEmbedStart?.(textsToEmbed.length);
      const embedStart = Date.now();
      signal?.throwIfAborted();
      const embeddings = await llm.embedBatch(textsToEmbed, signal ? { signal } : undefined);
      signal?.throwIfAborted();
      hooks?.onEmbedDone?.(Date.now() - embedStart);
      signal?.throwIfAborted();

      const vecStart = Date.now();
      for (let i = 0; i < vecSearches.length; i++) {
        const embedding = embeddings[i]?.embedding;
        if (!embedding) continue;

        const entry = vecSearches[i]!;
        const vecResults = await store.searchVec(
          entry.s.query, embedModel, breadth, collections,
          undefined, embedding, filter, scope
        );
        signal?.throwIfAborted();
        if (vecResults.length === 0) continue;
        for (const r of vecResults) docidMap.set(r.filepath, r.docid);
        rankedLists.push(vecResults.map(r => ({
          file: r.filepath, displayPath: r.displayPath,
          title: r.title, body: r.body || "", score: r.score,
        })));
        rankedListMeta.push({
          source: "vec",
          queryType: entry.s.type,
          query: entry.s.query,
          searchIndex: entry.searchIndex,
        });
      }
      hooks?.onVecDone?.(Date.now() - vecStart);
    }
  }

  if (rankedLists.length === 0) return [];

  // Step 3: RRF fusion — first subquery's lists get 2x weight (assume caller ordered by
  // importance), a relaxed FTS list half of its slot's weight, scaled per document by query coverage
  const weights = getStructuredRrfWeights(rankedListMeta);
  const docMultipliers = rrfDocMultipliers(rankedLists, rankedListMeta);
  const fused = reciprocalRankFusion(rankedLists, weights, 60, docMultipliers);
  const rrfTraceByFile = explain ? buildRrfTrace(rankedLists, weights, rankedListMeta, 60, docMultipliers) : null;
  const candidates = fused.slice(0, candidateLimit);

  if (candidates.length === 0) return [];

  // One batched context lookup for all candidates (was one N+1 triple per row
  // in both assembly branches below — every assembled file comes from candidates).
  const contexts = getContextsForFiles(store.db, candidates.map((c) => c.file));

  hooks?.onExpand?.("", [], 0); // Signal no expansion (pre-expanded)
  signal?.throwIfAborted();

  // Step 4: Chunk documents, pick best chunk per doc for reranking
  // Use first lex query as the "query" for keyword matching, or first vec if no lex
  const primaryQuery = searches.find(s => s.type === 'lex')?.query
    || searches.find(s => s.type === 'vec')?.query
    || searches[0]?.query || "";
  const chunkStart = Date.now();
  const docChunkMap = await chunkCandidatesForRerank(candidates, primaryQuery, intent, options?.chunkStrategy, signal);
  hooks?.onChunkDone?.(Date.now() - chunkStart);

  // Step 5: Rerank chunks. No reranker, or one past its deadline, means RRF order.
  const reranked = skipRerank
    ? null
    : await rerankWithDeadline(store, primaryQuery, rerankDocuments(candidates, docChunkMap), intent, options);
  signal?.throwIfAborted();

  if (reranked === null) {
    // Skip LLM reranking — return candidates scored by RRF only
    const seenFiles = new Set<string>();
    const rrfResults = candidates
      .map((cand, i) => {
        const chunkInfo = docChunkMap.get(cand.file);
        const bestIdx = chunkInfo?.bestIdx ?? 0;
        const bestChunk = chunkInfo?.chunks[bestIdx]?.text || cand.body || "";
        const bestChunkPos = chunkInfo?.chunks[bestIdx]?.pos || 0;
        const rrfRank = i + 1;
        const rrfScore = 1 / rrfRank;
        const trace = rrfTraceByFile?.get(cand.file);
        const explainData: HybridQueryExplain | undefined = explain ? {
          ftsScores: trace?.contributions.filter(c => c.source === "fts").map(c => c.backendScore) ?? [],
          vectorScores: trace?.contributions.filter(c => c.source === "vec").map(c => c.backendScore) ?? [],
          rrf: {
            rank: rrfRank,
            positionScore: rrfScore,
            weight: 1.0,
            baseScore: trace?.baseScore ?? 0,
            topRankBonus: trace?.topRankBonus ?? 0,
            totalScore: trace?.totalScore ?? 0,
            contributions: trace?.contributions ?? [],
          },
          rerankScore: 0,
          blendedScore: rrfScore,
        } : undefined;

        return {
          file: cand.file,
          displayPath: cand.displayPath,
          title: cand.title,
          body: cand.body,
          bestChunk,
          bestChunkPos,
          score: rrfScore,
          context: contexts.get(cand.file) ?? null,
          docid: docidMap.get(cand.file) || "",
          ...(explainData ? { explain: explainData } : {}),
        };
      })
      .filter(r => {
        if (seenFiles.has(r.file)) return false;
        seenFiles.add(r.file);
        return true;
      })
      // minScore is a threshold on blended rerank scores; a deadline fallback's 1/rank scores would
      // cut a 0.5 threshold to two results, so only a caller that skipped rerank gets it applied here.
      .filter(r => !skipRerank || r.score >= minScore)
      .slice(0, limit);
    const results = attachResultMetadata(store.db, rrfResults);
    signal?.throwIfAborted();
    return results;
  }


  // Step 6: Blend RRF position score with reranker score
  const candidateMap = new Map(candidates.map(c => [c.file, {
    displayPath: c.displayPath, title: c.title, body: c.body,
  }]));
  const rrfRankMap = new Map(candidates.map((c, i) => [c.file, i + 1]));
  // Cascade-tail placeholders were never scored: exempt them from the minScore
  // filter below, or a decisive head would silently drop the whole tail.
  const unscoredFiles = new Set(reranked.filter(r => r.unscored).map(r => r.file));

  const blended = reranked.map(r => {
    const rrfRank = rrfRankMap.get(r.file) || candidateLimit;
    const rrfScore = 1 - (rrfRank - 1) / candidateLimit;
    const blendedScore = blendRerankScore(rrfRank, r.score, candidateLimit);

    const candidate = candidateMap.get(r.file);
    const chunkInfo = docChunkMap.get(r.file);
    const bestIdx = chunkInfo?.bestIdx ?? 0;
    const bestChunk = chunkInfo?.chunks[bestIdx]?.text || candidate?.body || "";
    const bestChunkPos = chunkInfo?.chunks[bestIdx]?.pos || 0;
    const trace = rrfTraceByFile?.get(r.file);
    const explainData: HybridQueryExplain | undefined = explain ? {
      ftsScores: trace?.contributions.filter(c => c.source === "fts").map(c => c.backendScore) ?? [],
      vectorScores: trace?.contributions.filter(c => c.source === "vec").map(c => c.backendScore) ?? [],
      rrf: {
        rank: rrfRank,
        positionScore: rrfScore,
        weight: POSITION_TIEBREAK_WEIGHT,
        baseScore: trace?.baseScore ?? 0,
        topRankBonus: trace?.topRankBonus ?? 0,
        totalScore: trace?.totalScore ?? 0,
        contributions: trace?.contributions ?? [],
      },
      rerankScore: r.score,
      blendedScore,
    } : undefined;

    return {
      file: r.file,
      displayPath: candidate?.displayPath || "",
      title: candidate?.title || "",
      body: candidate?.body || "",
      bestChunk,
      bestChunkPos,
      score: blendedScore,
      context: contexts.get(r.file) ?? null,
      docid: docidMap.get(r.file) || "",
      ...(explainData ? { explain: explainData } : {}),
    };
  }).sort((a, b) => b.score - a.score);

  // Step 7: Dedup by file
  const seenFiles = new Set<string>();
  const finalResults = blended
    .filter(r => {
      if (seenFiles.has(r.file)) return false;
      seenFiles.add(r.file);
      return true;
    })
    .filter(r => unscoredFiles.has(r.file) || r.score >= minScore)
    .slice(0, limit);
  const results = attachResultMetadata(store.db, finalResults);
  signal?.throwIfAborted();
  return results;
}
