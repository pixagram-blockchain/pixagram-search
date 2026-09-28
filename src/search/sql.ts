// SQL building for D1. Filters and relevance are kept apart: filters become WHERE clauses over
// posts (p) LEFT JOIN artworks (a); relevance comes from FTS5 bm25 (here) and Vectorize (service).

import type { SearchRequest, SortKey } from "./params";

export interface Clause {
  sql: string;
  params: unknown[];
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** WHERE fragment (without the WHERE keyword) for everything except free text. */
export function buildFilter(r: SearchRequest): Clause {
  const w: string[] = ["p.deleted = 0"];
  const params: unknown[] = [];

  if (r.type) (w.push("p.type = ?"), params.push(r.type));
  if (r.authors.length) (w.push(`p.author IN (${placeholders(r.authors.length)})`), params.push(...r.authors));
  for (const tag of r.tags) (w.push("EXISTS (SELECT 1 FROM post_tags t WHERE t.post_id = p.id AND t.tag = ?)"), params.push(tag));
  if (r.colors.length) (w.push(`a.primary_color IN (${placeholders(r.colors.length)})`), params.push(...r.colors));
  if (r.hasColors.length) {
    w.push(`EXISTS (SELECT 1 FROM artwork_colors c WHERE c.post_id = p.id AND c.bucket IN (${placeholders(r.hasColors.length)}) AND c.weight >= ?)`);
    params.push(...r.hasColors, r.minColorWeight);
  }
  if (r.sizes.length) (w.push(`a.size_class IN (${placeholders(r.sizes.length)})`), params.push(...r.sizes));
  if (r.minColors !== null) (w.push("a.color_count >= ?"), params.push(r.minColors));
  if (r.maxColors !== null) (w.push("a.color_count <= ?"), params.push(r.maxColors));
  if (r.minWidth !== null) (w.push("a.width >= ?"), params.push(r.minWidth));
  if (r.maxWidth !== null) (w.push("a.width <= ?"), params.push(r.maxWidth));
  if (r.minHeight !== null) (w.push("a.height >= ?"), params.push(r.minHeight));
  if (r.maxHeight !== null) (w.push("a.height <= ?"), params.push(r.maxHeight));
  if (r.from !== null) (w.push("p.created >= ?"), params.push(r.from));
  if (r.to !== null) (w.push("p.created < ?"), params.push(r.to));
  if (r.transparent !== null) (w.push("a.has_transparency = ?"), params.push(r.transparent ? 1 : 0));
  if (r.nsfw === "exclude") w.push("p.nsfw = 0 AND COALESCE(a.ai_nsfw, 0) < 0.7");
  else if (r.nsfw === "only") w.push("(p.nsfw = 1 OR COALESCE(a.ai_nsfw, 0) >= 0.7)");
  if (r.listed !== null) (w.push("p.listed = ?"), params.push(r.listed ? 1 : 0));
  if (r.aiTraining !== null) (w.push(r.aiTraining ? "COALESCE(p.ai_training, 1) = 1" : "p.ai_training = 0"));

  return { sql: w.join(" AND "), params };
}

// ---- FTS -----------------------------------------------------------------------------

/** Turn free text into a safe FTS5 MATCH expression (implicit AND, prefix on the last token). */
export function ftsQuery(q: string, mode: "and" | "or" = "and"): string | null {
  const tokens = q
    .normalize("NFKC")
    .split(/\s+/)
    .map((t) => t.replace(/["*():^{}[\]\\<>~|&!?,;.]/g, "").trim())
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (!tokens.length) return null;
  const quoted = tokens.map((t, i) => `"${t.replace(/"/g, '""')}"${mode === "and" && i === tokens.length - 1 && t.length >= 2 ? "*" : ""}`);
  return quoted.join(mode === "and" ? " " : " OR ");
}

// column weights: title, description, body, tags, ai_caption, ai_tags, author
const BM25 = "bm25(posts_fts, 6.0, 3.0, 1.0, 4.0, 2.5, 3.0, 0.5)";

/** Top-N full-text candidates that also satisfy the filters. Lower score = better. */
export function ftsCandidates(r: SearchRequest, match: string, limit: number): Clause {
  const f = buildFilter(r);
  return {
    sql: `SELECT posts_fts.rowid AS id, ${BM25} AS score
          FROM posts_fts
          JOIN posts p ON p.id = posts_fts.rowid
          LEFT JOIN artworks a ON a.post_id = p.id
          WHERE posts_fts MATCH ? AND ${f.sql}
          ORDER BY score LIMIT ?`,
    params: [match, ...f.params, limit],
  };
}

// ---- browse (no text) -------------------------------------------------------------------

export interface KeysetCursor {
  v: number; // sort value
  id: number;
}

export function encodeCursor(c: KeysetCursor): string {
  return btoa(JSON.stringify(c)).replace(/=+$/, "");
}

export function decodeCursor(s: string | null): KeysetCursor | null {
  if (!s) return null;
  try {
    const o = JSON.parse(atob(s));
    return typeof o?.v === "number" && typeof o?.id === "number" ? { v: o.v, id: o.id } : null;
  } catch {
    return null;
  }
}

export function sortColumn(sort: SortKey): { col: string; dir: "ASC" | "DESC" } {
  switch (sort) {
    case "oldest":
      return { col: "p.created", dir: "ASC" };
    case "votes":
      return { col: "p.net_votes", dir: "DESC" };
    case "payout":
      return { col: "p.payout", dir: "DESC" };
    default:
      return { col: "p.created", dir: "DESC" };
  }
}

/** Keyset-paginated listing under the filters. Returns limit+1 rows so the caller can tell if there is more. */
export function browse(r: SearchRequest, cursor: KeysetCursor | null, limit: number): Clause {
  const f = buildFilter(r);
  const { col, dir } = sortColumn(r.sort);
  const cmp = dir === "DESC" ? "<" : ">";
  const params: unknown[] = [...f.params];
  let where = f.sql;
  if (cursor) {
    where += ` AND (${col} ${cmp} ? OR (${col} = ? AND p.id ${cmp} ?))`;
    params.push(cursor.v, cursor.v, cursor.id);
  }
  params.push(limit + 1);
  return {
    sql: `SELECT p.id, ${col} AS sort_value FROM posts p LEFT JOIN artworks a ON a.post_id = p.id
          WHERE ${where} ORDER BY ${col} ${dir}, p.id ${dir} LIMIT ?`,
    params,
  };
}

// ---- hydration ---------------------------------------------------------------------------

export const POST_SELECT = `
  p.id, p.author, p.permlink, p.type, p.title, p.description, p.category, p.tags_json, p.app, p.nsfw, p.ai_training,
  p.royalty_pct, p.created, p.updated, p.deleted, p.net_votes, p.payout, p.children, p.listed, p.price, p.price_symbol,
  a.content_hash, a.mime, a.bytes, a.lossy, a.width, a.height, a.size_class, a.color_count, a.has_transparency,
  a.transparent_share, a.primary_color, a.background_hex, a.palette_json, a.buckets_json, a.phash,
  a.ai_caption, a.ai_subjects_json, a.ai_tags_json, a.ai_style, a.ai_mood, a.ai_text, a.ai_nsfw,
  a.r2_orig_key, a.r2_up_key, a.up_width, a.up_height, a.up_factor, a.embed_hash, a.describe_hash, a.stats_hash`;

/** Fetch rows for a set of ids, re-applying the filters (Vectorize cannot express all of them). */
export function hydrate(ids: number[], r: SearchRequest | null): Clause {
  const f = r ? buildFilter(r) : { sql: "1 = 1", params: [] };
  return {
    sql: `SELECT ${POST_SELECT} FROM posts p LEFT JOIN artworks a ON a.post_id = p.id
          WHERE p.id IN (${placeholders(ids.length)}) AND ${f.sql}`,
    params: [...ids, ...f.params],
  };
}

// ---- facets ----------------------------------------------------------------------------

export interface FacetQueries {
  primary_color: Clause;
  has_color: Clause;
  size_class: Clause;
  type: Clause;
  author: Clause;
  tag: Clause;
  month: Clause;
  color_count: Clause;
  transparency: Clause;
}

export function facetQueries(r: SearchRequest, match: string | null): FacetQueries {
  const f = buildFilter(r);
  const base = match ? `${f.sql} AND p.id IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)` : f.sql;
  const params = match ? [...f.params, match] : f.params;
  const from = "FROM posts p LEFT JOIN artworks a ON a.post_id = p.id";
  const group = (keyExpr: string, extraFrom = "", extraWhere = "", extraParams: unknown[] = [], limit = 50): Clause => ({
    sql: `SELECT ${keyExpr} AS key, COUNT(*) AS n ${from} ${extraFrom} WHERE ${base} ${extraWhere} AND key IS NOT NULL GROUP BY key ORDER BY n DESC, key LIMIT ${limit}`,
    params: [...params, ...extraParams],
  });
  return {
    primary_color: group("a.primary_color"),
    has_color: {
      sql: `SELECT c.bucket AS key, COUNT(*) AS n ${from} JOIN artwork_colors c ON c.post_id = p.id WHERE ${base} AND c.weight >= ? GROUP BY key ORDER BY n DESC LIMIT 50`,
      params: [...params, r.minColorWeight],
    },
    size_class: group("a.size_class"),
    type: group("p.type"),
    author: group("p.author", "", "", [], 20),
    tag: {
      sql: `SELECT t.tag AS key, COUNT(*) AS n ${from} JOIN post_tags t ON t.post_id = p.id WHERE ${base} GROUP BY key ORDER BY n DESC LIMIT 40`,
      params,
    },
    month: {
      sql: `SELECT strftime('%Y-%m', p.created, 'unixepoch') AS key, COUNT(*) AS n ${from} WHERE ${base} GROUP BY key ORDER BY key DESC LIMIT 60`,
      params,
    },
    color_count: group(
      `CASE WHEN a.color_count IS NULL THEN NULL WHEN a.color_count <= 4 THEN '1-4' WHEN a.color_count <= 8 THEN '5-8' WHEN a.color_count <= 16 THEN '9-16'
            WHEN a.color_count <= 32 THEN '17-32' WHEN a.color_count <= 64 THEN '33-64' WHEN a.color_count <= 256 THEN '65-256' ELSE '257+' END`,
    ),
    transparency: group("CASE WHEN a.has_transparency IS NULL THEN NULL WHEN a.has_transparency = 1 THEN 'transparent' ELSE 'opaque' END"),
  };
}
