// Query-string parsing for the search API. Every filter is optional; unknown values are dropped.

import { COLOR_NAMES } from "../enrich/color";
import { SIZE_CLASSES, type SizeClass } from "../enrich/stats";

export type SortKey = "relevance" | "newest" | "oldest" | "votes" | "payout";
export type NsfwMode = "exclude" | "include" | "only";

export interface SearchRequest {
  q: string;
  type: "artwork" | "blog" | null;
  authors: string[];
  tags: string[];
  /** primary colour in (...) */
  colors: string[];
  /** any palette bucket in (...) with weight >= minColorWeight */
  hasColors: string[];
  minColorWeight: number;
  sizes: SizeClass[];
  minColors: number | null;
  maxColors: number | null;
  minWidth: number | null;
  maxWidth: number | null;
  minHeight: number | null;
  maxHeight: number | null;
  /** unix seconds, inclusive / exclusive */
  from: number | null;
  to: number | null;
  transparent: boolean | null;
  nsfw: NsfwMode;
  listed: boolean | null;
  aiTraining: boolean | null;
  sort: SortKey;
  limit: number;
  /** keyset cursor (browse) or numeric offset (fused text search) */
  cursor: string | null;
  facets: boolean;
  /** use the SigLIP index when a query is present (default true) */
  semantic: boolean;
}

const COLOR_SET = new Set(COLOR_NAMES);
const SIZE_SET = new Set<string>(SIZE_CLASSES);
const SORTS = new Set<string>(["relevance", "newest", "oldest", "votes", "payout"]);

function multi(sp: URLSearchParams, key: string): string[] {
  const out: string[] = [];
  for (const v of sp.getAll(key)) for (const part of v.split(",")) {
    const s = part.trim().toLowerCase();
    if (s) out.push(s);
  }
  return [...new Set(out)];
}

function num(sp: URLSearchParams, key: string): number | null {
  const v = sp.get(key);
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function boolOrNull(sp: URLSearchParams, key: string): boolean | null {
  const v = sp.get(key);
  if (v === null || v === "") return null;
  if (/^(1|true|yes)$/i.test(v)) return true;
  if (/^(0|false|no)$/i.test(v)) return false;
  return null;
}

/** Accepts unix seconds, unix millis, or anything Date.parse understands (ISO dates). */
export function parseDate(v: string | null): number | null {
  if (!v) return null;
  const s = v.trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 1e11 ? Math.floor(n / 1000) : n; // millis vs seconds
  }
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

export function parseSearchRequest(sp: URLSearchParams): SearchRequest {
  const typeRaw = (sp.get("type") ?? "").toLowerCase();
  const type = typeRaw === "artwork" || typeRaw === "art" ? "artwork" : typeRaw === "blog" || typeRaw === "post" ? "blog" : null;
  const sortRaw = (sp.get("sort") ?? "").toLowerCase();
  const q = (sp.get("q") ?? "").trim().slice(0, 200);
  const nsfwRaw = (sp.get("nsfw") ?? "exclude").toLowerCase();
  const limitRaw = num(sp, "limit");
  const sizes = multi(sp, "size").filter((s) => SIZE_SET.has(s)) as SizeClass[];
  return {
    q,
    type,
    authors: multi(sp, "author").map((a) => a.replace(/^@/, "")).slice(0, 10),
    tags: multi(sp, "tag").slice(0, 10),
    colors: multi(sp, "color").filter((c) => COLOR_SET.has(c)).slice(0, 10),
    hasColors: multi(sp, "has_color").filter((c) => COLOR_SET.has(c)).slice(0, 10),
    minColorWeight: Math.min(1, Math.max(0, num(sp, "min_color_weight") ?? 0.08)),
    sizes,
    minColors: num(sp, "min_colors"),
    maxColors: num(sp, "max_colors"),
    minWidth: num(sp, "min_width"),
    maxWidth: num(sp, "max_width"),
    minHeight: num(sp, "min_height"),
    maxHeight: num(sp, "max_height"),
    from: parseDate(sp.get("from")),
    to: parseDate(sp.get("to")),
    transparent: boolOrNull(sp, "transparent"),
    nsfw: nsfwRaw === "include" || nsfwRaw === "only" ? (nsfwRaw as NsfwMode) : "exclude",
    listed: boolOrNull(sp, "listed"),
    aiTraining: boolOrNull(sp, "ai_training"),
    sort: SORTS.has(sortRaw) ? (sortRaw as SortKey) : q ? "relevance" : "newest",
    limit: Math.min(50, Math.max(1, Math.floor(limitRaw ?? 24))),
    cursor: sp.get("cursor"),
    facets: /^(1|true|yes)$/i.test(sp.get("facets") ?? ""),
    semantic: !/^(0|false|no)$/i.test(sp.get("semantic") ?? ""),
  };
}

/** Stable key for caching a request (excludes cursor). */
export function requestKey(r: SearchRequest): string {
  const { cursor: _c, ...rest } = r;
  return JSON.stringify(rest);
}
