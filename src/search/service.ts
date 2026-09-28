// Search orchestration: filters + FTS5 on D1, kNN on Vectorize, RRF in the Worker.

import type { Env } from "../env";
import { now } from "../env";
import { embedQueryCached, embeddingEnabled } from "../enrich/embed";
import { hamming } from "../enrich/phash";
import { requestKey, type SearchRequest } from "./params";
import { boost, reciprocalRankFusion, type Fused } from "./rrf";
import { browse, buildFilter, decodeCursor, encodeCursor, facetQueries, ftsCandidates, ftsQuery, hydrate, POST_SELECT, type Clause } from "./sql";

export const CANDIDATES = 100; // per ranked list; Vectorize returns at most 100

export interface SearchItem {
  id: number;
  author: string;
  permlink: string;
  path: string; // /@author/permlink
  type: "artwork" | "blog";
  title: string;
  description: string;
  category: string | null;
  tags: string[];
  app: string | null;
  created: number;
  updated: number;
  net_votes: number;
  payout: number;
  children: number;
  nsfw: boolean;
  ai_training: boolean | null;
  listed: boolean;
  price: number | null;
  price_symbol: string | null;
  artwork: ArtworkView | null;
  score?: { fused: number; ranks: Record<string, number> };
}

export interface ArtworkView {
  hash: string;
  mime: string;
  bytes: number;
  lossy: boolean;
  width: number | null;
  height: number | null;
  size_class: string | null;
  color_count: number | null;
  has_transparency: boolean | null;
  transparent_share: number | null;
  primary_color: string | null;
  background_hex: string | null;
  palette: Array<{ hex: string; share: number }>;
  buckets: Array<{ name: string; weight: number }>;
  phash: string | null;
  images: { original: string | null; upscaled: string | null };
  upscaled_size: { width: number; height: number; factor: number } | null;
  ai: { caption: string; subjects: string[]; tags: string[]; style: string | null; mood: string | null; text: string | null; nsfw: number | null } | null;
  stages: { stats: boolean; embed: boolean; describe: boolean };
}

export interface SearchResponse {
  query: string;
  mode: "browse" | "text" | "hybrid";
  items: SearchItem[];
  next_cursor: string | null;
  total_candidates?: number;
  facets?: Record<string, Array<{ key: string; n: number }>>;
  took_ms: number;
  notes?: string[];
}

type Row = Record<string, any>;

export function rowToItem(r: Row): SearchItem {
  const parseArr = (s: string | null): string[] => {
    if (!s) return [];
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const art: ArtworkView | null =
    r.type === "artwork" && r.content_hash
      ? {
          hash: r.content_hash,
          mime: r.mime,
          bytes: r.bytes,
          lossy: r.lossy === 1,
          width: r.width,
          height: r.height,
          size_class: r.size_class,
          color_count: r.color_count,
          has_transparency: r.has_transparency === null ? null : r.has_transparency === 1,
          transparent_share: r.transparent_share,
          primary_color: r.primary_color,
          background_hex: r.background_hex,
          palette: (parseArr(r.palette_json) as any[]).slice(0, 12).map((p) => ({ hex: p.hex, share: p.share })),
          buckets: parseArr(r.buckets_json) as any[],
          phash: r.phash,
          images: {
            original: r.r2_orig_key ? `/img/${r.r2_orig_key}` : null,
            upscaled: r.r2_up_key ? `/img/${r.r2_up_key}` : null,
          },
          upscaled_size: r.up_width ? { width: r.up_width, height: r.up_height, factor: r.up_factor } : null,
          ai: r.ai_caption
            ? { caption: r.ai_caption, subjects: parseArr(r.ai_subjects_json), tags: parseArr(r.ai_tags_json), style: r.ai_style, mood: r.ai_mood, text: r.ai_text, nsfw: r.ai_nsfw }
            : null,
          stages: { stats: !!r.stats_hash, embed: !!r.embed_hash && r.embed_hash === r.content_hash, describe: !!r.describe_hash && r.describe_hash === r.content_hash },
        }
      : null;
  return {
    id: r.id,
    author: r.author,
    permlink: r.permlink,
    path: `/@${r.author}/${r.permlink}`,
    type: r.type,
    title: r.title,
    description: r.description,
    category: r.category,
    tags: parseArr(r.tags_json),
    app: r.app,
    created: r.created,
    updated: r.updated,
    net_votes: r.net_votes,
    payout: r.payout,
    children: r.children,
    nsfw: r.nsfw === 1,
    ai_training: r.ai_training === null ? null : r.ai_training === 1,
    listed: r.listed === 1,
    price: r.price,
    price_symbol: r.price_symbol,
    artwork: art,
  };
}

async function runClause<T = Row>(db: D1Database, c: Clause): Promise<T[]> {
  const r = await db.prepare(c.sql).bind(...c.params).all<T>();
  return r.results ?? [];
}

/** Fetch and order rows for ids (order preserved). Rows failing the filters are dropped. */
export async function hydrateOrdered(db: D1Database, ids: number[], r: SearchRequest | null): Promise<SearchItem[]> {
  if (!ids.length) return [];
  const out: SearchItem[] = [];
  // D1 allows 100 bound parameters per statement; leave room for the filter params.
  const chunkSize = Math.max(10, 90 - (r ? buildFilter(r).params.length : 0));
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const rows = await runClause(db, hydrate(chunk, r));
    const byId = new Map(rows.map((row) => [row.id as number, row]));
    for (const id of chunk) {
      const row = byId.get(id);
      if (row) out.push(rowToItem(row));
    }
  }
  return out;
}

/** Vectorize metadata filter mirroring the SQL filters it can express. */
export function vectorFilter(r: SearchRequest): VectorizeVectorMetadataFilter | undefined {
  const f: Record<string, any> = {};
  if (r.authors.length) f.author = r.authors.length === 1 ? r.authors[0] : { $in: r.authors };
  if (r.colors.length) f.primary_color = r.colors.length === 1 ? r.colors[0] : { $in: r.colors };
  if (r.sizes.length) f.size_class = r.sizes.length === 1 ? r.sizes[0] : { $in: r.sizes };
  if (r.from !== null || r.to !== null) {
    const c: Record<string, number> = {};
    if (r.from !== null) c.$gte = r.from;
    if (r.to !== null) c.$lt = r.to;
    f.created = c;
  }
  if (r.minColors !== null || r.maxColors !== null) {
    const c: Record<string, number> = {};
    if (r.minColors !== null) c.$gte = r.minColors;
    if (r.maxColors !== null) c.$lte = r.maxColors;
    f.color_count = c;
  }
  if (r.nsfw === "exclude") f.nsfw = false;
  else if (r.nsfw === "only") f.nsfw = true;
  if (r.listed !== null) f.listed = r.listed;
  if (r.aiTraining !== null) f.ai_training = r.aiTraining;
  return Object.keys(f).length ? (f as VectorizeVectorMetadataFilter) : undefined;
}

export async function knn(env: Env, vector: number[], r: SearchRequest | null, topK: number): Promise<Array<{ id: number; score: number }>> {
  const res = await env.VEC.query(vector, { topK: Math.min(100, topK), filter: r ? vectorFilter(r) : undefined, returnValues: false, returnMetadata: "none" });
  return res.matches.map((m) => ({ id: Number(m.id), score: m.score })).filter((m) => Number.isFinite(m.id));
}

export async function search(env: Env, r: SearchRequest, ctx?: ExecutionContext): Promise<SearchResponse> {
  const t0 = Date.now();
  const notes: string[] = [];

  // ---- browse mode ----------------------------------------------------------------
  if (!r.q) {
    const cursor = decodeCursor(r.cursor);
    const rows = await runClause<{ id: number; sort_value: number }>(env.DB, browse(r, cursor, r.limit));
    const page = rows.slice(0, r.limit);
    const items = await hydrateOrdered(env.DB, page.map((x) => x.id), null);
    const last = page[page.length - 1];
    const next = rows.length > r.limit && last ? encodeCursor({ v: last.sort_value, id: last.id }) : null;
    const resp: SearchResponse = { query: "", mode: "browse", items, next_cursor: next, took_ms: Date.now() - t0 };
    if (r.facets) resp.facets = await facets(env, r, null);
    return resp;
  }

  // ---- text / hybrid mode ------------------------------------------------------------
  const cacheKey = `search:${requestKey(r)}`;
  let fused: Fused[] | null = (await env.CACHE.get(cacheKey, "json").catch(() => null)) as Fused[] | null;
  let mode: "text" | "hybrid" = "text";
  let matchExpr = ftsQuery(r.q, "and");

  if (!fused) {
    const lists = [];
    if (matchExpr) {
      let fts = await runClause<{ id: number; score: number }>(env.DB, ftsCandidates(r, matchExpr, CANDIDATES));
      if (fts.length < 5 && r.q.trim().split(/\s+/).length > 1) {
        const orExpr = ftsQuery(r.q, "or");
        if (orExpr && orExpr !== matchExpr) {
          const more = await runClause<{ id: number; score: number }>(env.DB, ftsCandidates(r, orExpr, CANDIDATES));
          const seen = new Set(fts.map((x) => x.id));
          fts = [...fts, ...more.filter((x) => !seen.has(x.id))];
          matchExpr = orExpr;
          notes.push("relaxed to OR matching");
        }
      }
      lists.push({ name: "fts", ids: fts.map((x) => x.id), weight: 1 });
    }
    if (r.semantic && r.type !== "blog" && embeddingEnabled(env)) {
      try {
        const vec = await embedQueryCached(env, r.q);
        const hits = await knn(env, vec, r, CANDIDATES);
        lists.push({ name: "vec", ids: hits.map((h) => h.id), weight: 1 });
        mode = "hybrid";
      } catch (e) {
        notes.push(`semantic search unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    fused = reciprocalRankFusion(lists);
    if (fused.length) ctx?.waitUntil(env.CACHE.put(cacheKey, JSON.stringify(fused), { expirationTtl: 60 }).catch(() => {}));
  } else {
    mode = fused.some((f) => f.ranks.vec) ? "hybrid" : "text";
  }

  // Hydrate everything (≤ 200 rows), re-applying filters, then shape and paginate.
  const items = await hydrateOrdered(env.DB, fused.map((f) => f.id), r);
  const byId = new Map(fused.map((f) => [f.id, f]));
  const nowUnix = now();
  for (const it of items) {
    const f = byId.get(it.id)!;
    it.score = { fused: r.sort === "relevance" ? boost(f.score, it.net_votes, it.created, nowUnix) : f.score, ranks: f.ranks };
  }
  if (r.sort === "relevance") items.sort((a, b) => b.score!.fused - a.score!.fused);
  else if (r.sort === "newest") items.sort((a, b) => b.created - a.created);
  else if (r.sort === "oldest") items.sort((a, b) => a.created - b.created);
  else if (r.sort === "votes") items.sort((a, b) => b.net_votes - a.net_votes);
  else if (r.sort === "payout") items.sort((a, b) => b.payout - a.payout);

  const offset = Math.max(0, parseInt(r.cursor ?? "0", 10) || 0);
  const page = items.slice(offset, offset + r.limit);
  const resp: SearchResponse = {
    query: r.q,
    mode,
    items: page,
    next_cursor: offset + r.limit < items.length ? String(offset + r.limit) : null,
    total_candidates: items.length,
    took_ms: Date.now() - t0,
  };
  if (notes.length) resp.notes = notes;
  if (r.facets) resp.facets = await facets(env, r, matchExpr);

  ctx?.waitUntil(
    env.DB.prepare("INSERT INTO query_log (q, filters, results, ms, at) VALUES (?, ?, ?, ?, ?)")
      .bind(r.q, requestKey(r), items.length, resp.took_ms, nowUnix)
      .run()
      .catch(() => {}),
  );
  return resp;
}

export async function facets(env: Env, r: SearchRequest, match: string | null): Promise<Record<string, Array<{ key: string; n: number }>>> {
  const q = facetQueries(r, match);
  const names = Object.keys(q) as Array<keyof typeof q>;
  const results = await env.DB.batch(names.map((n) => env.DB.prepare(q[n].sql).bind(...q[n].params)));
  const out: Record<string, Array<{ key: string; n: number }>> = {};
  names.forEach((n, i) => {
    out[n] = ((results[i].results ?? []) as Array<{ key: string; n: number }>).filter((x) => x.key !== null);
  });
  return out;
}

// ---- similar / duplicates ---------------------------------------------------------------------

export async function similar(env: Env, postId: number, limit: number, r: SearchRequest | null): Promise<{ items: SearchItem[]; method: "vector" | "phash" | "none" }> {
  const vec = await env.VEC.getByIds([String(postId)]).catch(() => []);
  if (vec[0]?.values) {
    const hits = await knn(env, vec[0].values as number[], r, Math.min(100, limit + 1));
    const ids = hits.filter((h) => h.id !== postId).slice(0, limit).map((h) => h.id);
    const items = await hydrateOrdered(env.DB, ids, r);
    const scores = new Map(hits.map((h) => [h.id, h.score]));
    for (const it of items) it.score = { fused: scores.get(it.id) ?? 0, ranks: { vec: ids.indexOf(it.id) + 1 } };
    return { items, method: "vector" };
  }
  const dup = await duplicates(env, postId, 16, limit);
  return { items: dup.items, method: dup.items.length ? "phash" : "none" };
}

export async function duplicates(env: Env, postId: number, maxDistance: number, limit: number): Promise<{ items: Array<SearchItem & { distance: number }>; phash: string | null }> {
  const me = await env.DB.prepare("SELECT phash FROM artworks WHERE post_id = ?").bind(postId).first<{ phash: string | null }>();
  if (!me?.phash) return { items: [], phash: null };
  return duplicatesOfHash(env, me.phash, maxDistance, limit, postId);
}

export async function duplicatesOfHash(env: Env, hash: string, maxDistance: number, limit: number, excludeId?: number): Promise<{ items: Array<SearchItem & { distance: number }>; phash: string }> {
  const chunks: number[] = [];
  for (let i = 0; i < 16; i += 2) chunks.push(parseInt(hash.slice(i, i + 2), 16));
  const where = chunks.map((_, i) => `(c.idx = ${i} AND c.val = ?)`).join(" OR ");
  const rows = await env.DB
    .prepare(`SELECT DISTINCT c.post_id AS id, a.phash FROM phash_chunks c JOIN artworks a ON a.post_id = c.post_id JOIN posts p ON p.id = c.post_id WHERE p.deleted = 0 AND (${where}) LIMIT 2000`)
    .bind(...chunks)
    .all<{ id: number; phash: string }>();
  const cands = (rows.results ?? [])
    .filter((x) => x.id !== excludeId && x.phash)
    .map((x) => ({ id: x.id, distance: hamming(hash, x.phash) }))
    .filter((x) => x.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
  const items = await hydrateOrdered(env.DB, cands.map((c) => c.id), null);
  const dist = new Map(cands.map((c) => [c.id, c.distance]));
  return { items: items.map((it) => ({ ...it, distance: dist.get(it.id)! })), phash: hash };
}

export async function getItem(env: Env, idOrRef: { id: number } | { author: string; permlink: string }): Promise<SearchItem | null> {
  const row =
    "id" in idOrRef
      ? await env.DB.prepare(`SELECT ${POST_SELECT} FROM posts p LEFT JOIN artworks a ON a.post_id = p.id WHERE p.id = ?`).bind(idOrRef.id).first<Row>()
      : await env.DB.prepare(`SELECT ${POST_SELECT} FROM posts p LEFT JOIN artworks a ON a.post_id = p.id WHERE p.author = ? AND p.permlink = ?`).bind(idOrRef.author, idOrRef.permlink).first<Row>();
  return row ? rowToItem(row) : null;
}
