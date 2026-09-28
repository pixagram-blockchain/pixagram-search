// HTTP API (Hono). Public search routes + token-protected admin routes.

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { ALL_STAGES, bool, int, type Stage } from "./env";
import { parseSearchRequest } from "./search/params";
import { duplicates, duplicatesOfHash, getItem, hydrateOrdered, knn, search, similar } from "./search/service";
import { indexerStub } from "./chain/indexer-do";
import { ingestPostRef } from "./chain/ingest";
import { setJob } from "./db/posts";
import { base64Decode, base64Encode } from "./lib/bytes";
import { decodeImage, encodePng, sniff } from "./enrich/decode";
import { phash } from "./enrich/phash";
import { factorFor, upscale } from "./enrich/upscale";
import { embedImages, embeddingEnabled } from "./enrich/embed";
import { COLOR_NAMES, NAMED_COLORS } from "./enrich/color";
import { SIZE_CLASSES } from "./enrich/stats";

type Bindings = { Bindings: Env; Variables: { ctx: ExecutionContext } };

export const app = new Hono<Bindings>();

app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], maxAge: 86400 }));

app.onError((err, c) => {
  console.error("api error", err);
  return c.json({ error: err.message ?? "internal error" }, 500);
});

app.get("/", (c) =>
  c.json({
    name: "pixagram-search",
    endpoints: ["/search", "/similar/:id", "/duplicates/:id", "/search-by-image", "/posts/:id", "/posts/:author/:permlink", "/img/orig/:hash.:ext", "/img/up/:hash.png", "/vocab", "/healthz"],
  }),
);

app.get("/healthz", async (c) => {
  const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE deleted = 0").first<{ n: number }>();
  return c.json({ ok: true, posts: row?.n ?? 0, semantic: embeddingEnabled(c.env) });
});

/** The filter vocabularies the UI needs to render controls. */
app.get("/vocab", (c) =>
  c.json({
    colors: NAMED_COLORS.map((n) => ({ name: n.name, hex: n.hex })),
    size_classes: SIZE_CLASSES,
    sorts: ["relevance", "newest", "oldest", "votes", "payout"],
    nsfw: ["exclude", "include", "only"],
    params: {
      q: "free text (title, tags, description, AI caption; semantic when the embedding endpoint is on)",
      type: "artwork | blog",
      author: "comma list or repeated",
      tag: "comma list or repeated (AND)",
      color: `primary colour, one of ${COLOR_NAMES.join("|")}`,
      has_color: "any palette bucket with weight >= min_color_weight (default 0.08)",
      size: `one of ${SIZE_CLASSES.join("|")}`,
      min_colors: "number", max_colors: "number",
      min_width: "px", max_width: "px", min_height: "px", max_height: "px",
      from: "date or unix seconds (inclusive)", to: "date or unix seconds (exclusive)",
      transparent: "true|false", nsfw: "exclude|include|only", listed: "true|false", ai_training: "true|false",
      sort: "relevance|newest|oldest|votes|payout", limit: "1..50", cursor: "from next_cursor", facets: "1 to include facet counts", semantic: "0 to disable vector search",
    },
  }),
);

app.get("/search", async (c) => {
  const req = parseSearchRequest(new URL(c.req.url).searchParams);
  const res = await search(c.env, req, c.executionCtx as unknown as ExecutionContext);
  c.header("cache-control", "public, max-age=30");
  return c.json(res);
});

app.get("/similar/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const sp = new URL(c.req.url).searchParams;
  const req = parseSearchRequest(sp);
  const limit = Math.min(50, Math.max(1, int(sp.get("limit") ?? undefined, 24)));
  const r = await similar(c.env, id, limit, sp.toString() ? req : null);
  return c.json({ id, method: r.method, items: r.items });
});

app.get("/duplicates/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const sp = new URL(c.req.url).searchParams;
  const max = Math.min(20, Math.max(0, int(sp.get("max_distance") ?? undefined, 8)));
  const r = await duplicates(c.env, id, max, Math.min(100, int(sp.get("limit") ?? undefined, 20)));
  return c.json({ id, phash: r.phash, max_distance: max, items: r.items });
});

/**
 * Search by an uploaded image: multipart field "image", or JSON {"image": "<base64 or data URI>"}.
 * Returns semantic neighbours (when the embedding endpoint is on) and pHash near-duplicates.
 */
app.post("/search-by-image", async (c) => {
  let bytes: Uint8Array | null = null;
  const ct = c.req.header("content-type") ?? "";
  if (ct.includes("multipart/form-data")) {
    const form = await c.req.formData();
    const f = form.get("image");
    if (f && typeof f !== "string") bytes = new Uint8Array(await f.arrayBuffer());
  } else {
    const body = (await c.req.json().catch(() => null)) as { image?: string } | null;
    if (body?.image) bytes = base64Decode(body.image.replace(/^data:[^,]*,/, ""));
  }
  if (!bytes || bytes.length === 0) return c.json({ error: "no image" }, 400);
  if (bytes.length > 8 * 1024 * 1024) return c.json({ error: "image too large (8 MB max)" }, 413);
  const info = sniff(bytes);
  if (info.format === "unknown") return c.json({ error: "unsupported format (webp or png)" }, 415);
  const sp = new URL(c.req.url).searchParams;
  const req = parseSearchRequest(sp);
  const limit = Math.min(50, Math.max(1, int(sp.get("limit") ?? undefined, 24)));

  const img = await decodeImage(bytes, info);
  const ph = phash(img);
  const dup = await duplicatesOfHash(c.env, ph, Math.min(20, int(sp.get("max_distance") ?? undefined, 8)), 20);

  let items: Awaited<ReturnType<typeof hydrateOrdered>> = [];
  let method: "vector" | "none" = "none";
  let note: string | undefined;
  if (embeddingEnabled(c.env)) {
    try {
      const up = upscale(img, factorFor(img.width, img.height, int(c.env.UPSCALE_TARGET, 800)), (c.env.SCALER ?? "xbrz") === "nearest" ? "nearest" : "xbrz");
      const png = await encodePng(up);
      const emb = await embedImages(c.env, [base64Encode(png)]);
      const hits = await knn(c.env, emb.embeddings[0], req, limit);
      items = await hydrateOrdered(c.env.DB, hits.map((h) => h.id), req);
      const scores = new Map(hits.map((h) => [h.id, h.score]));
      for (const it of items) it.score = { fused: scores.get(it.id) ?? 0, ranks: { vec: hits.findIndex((h) => h.id === it.id) + 1 } };
      method = "vector";
    } catch (e) {
      note = `semantic search unavailable: ${e instanceof Error ? e.message : String(e)}`;
    }
  } else note = "semantic search disabled (HF_EMBED_URL not set)";
  return c.json({ method, phash: ph, width: img.width, height: img.height, items, duplicates: dup.items, note });
});

app.get("/posts/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const it = await getItem(c.env, { id });
  return it ? c.json(it) : c.json({ error: "not found" }, 404);
});

app.get("/posts/:author/:permlink", async (c) => {
  const it = await getItem(c.env, { author: c.req.param("author").replace(/^@/, ""), permlink: c.req.param("permlink") });
  return it ? c.json(it) : c.json({ error: "not found" }, 404);
});

/** Serve originals / upscaled previews from R2 (immutable, content-addressed). */
app.get("/img/:kind{orig|up}/:file", async (c) => {
  const key = `${c.req.param("kind")}/${c.req.param("file")}`;
  if (!/^(orig|up)\/[0-9a-f]{64}\.(webp|png)$/.test(key)) return c.json({ error: "bad key" }, 400);
  const obj = await c.env.ART.get(key);
  if (!obj) return c.json({ error: "not found" }, 404);
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("etag", obj.httpEtag);
  h.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(obj.body, { headers: h });
});

// ---- admin --------------------------------------------------------------------------

const admin = new Hono<Bindings>();

admin.use("*", async (c, next) => {
  const token = c.env.ADMIN_TOKEN;
  const auth = c.req.header("authorization") ?? "";
  if (!token) return c.json({ error: "ADMIN_TOKEN secret not set" }, 503);
  if (auth !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401);
  await next();
});

admin.get("/indexer", async (c) => c.json(await indexerStub(c.env).status()));
admin.post("/indexer/start", async (c) => {
  const from = Number(new URL(c.req.url).searchParams.get("from") ?? "");
  return c.json(await indexerStub(c.env).start(Number.isFinite(from) && from > 0 ? from : undefined));
});
admin.post("/indexer/stop", async (c) => c.json(await indexerStub(c.env).stop()));

admin.post("/backfill", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { authors?: string[]; reason?: string };
  const instance = await c.env.BACKFILL.create({ params: { authors: body.authors, reason: body.reason ?? "admin" } });
  return c.json({ id: instance.id, status: await instance.status() });
});
admin.get("/backfill/:id", async (c) => {
  const instance = await c.env.BACKFILL.get(c.req.param("id"));
  return c.json({ id: instance.id, status: await instance.status() });
});

/** Re-ingest one post from the chain (and enqueue enrichment if its image changed). */
admin.post("/ingest/:author/:permlink", async (c) => {
  const r = await ingestPostRef(c.env, c.req.param("author").replace(/^@/, ""), c.req.param("permlink"), null, "admin");
  return c.json(r);
});

/**
 * Re-run enrichment. Body: { "post_id": 1 } | { "author": "x" } | { "all": true }, plus optional
 * "stages": ["stats","embed","describe"] and "force": true (recompute even if the hash is unchanged).
 * Use after changing the embedding model (new Vectorize index) or the VLM.
 */
admin.post("/reindex", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { post_id?: number; author?: string; all?: boolean; stages?: Stage[]; force?: boolean };
  const stages = (body.stages ?? ALL_STAGES).filter((s): s is Stage => ALL_STAGES.includes(s));
  let rows: Array<{ id: number; author: string; permlink: string }>;
  if (body.post_id) rows = (await c.env.DB.prepare("SELECT id, author, permlink FROM posts WHERE id = ? AND type = 'artwork' AND deleted = 0").bind(body.post_id).all<any>()).results ?? [];
  else if (body.author) rows = (await c.env.DB.prepare("SELECT id, author, permlink FROM posts WHERE author = ? AND type = 'artwork' AND deleted = 0").bind(body.author).all<any>()).results ?? [];
  else if (body.all) rows = (await c.env.DB.prepare("SELECT id, author, permlink FROM posts WHERE type = 'artwork' AND deleted = 0 ORDER BY net_votes DESC, created DESC").all<any>()).results ?? [];
  else return c.json({ error: "give post_id, author or all:true" }, 400);
  for (let i = 0; i < rows.length; i += 100) {
    await c.env.ENRICH_QUEUE.sendBatch(rows.slice(i, i + 100).map((r) => ({ body: { postId: r.id, author: r.author, permlink: r.permlink, stages, force: !!body.force, reason: "reindex" } })));
  }
  for (const r of rows) for (const s of stages) await setJob(c.env.DB, r.id, s, "queued");
  return c.json({ enqueued: rows.length, stages, force: !!body.force });
});

admin.get("/stats", async (c) => {
  const [posts, jobs, art, last] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT type, deleted, COUNT(*) AS n FROM posts GROUP BY type, deleted"),
    c.env.DB.prepare("SELECT stage, status, COUNT(*) AS n FROM jobs GROUP BY stage, status"),
    c.env.DB.prepare("SELECT COUNT(*) AS n, SUM(embed_hash = content_hash) AS embedded, SUM(describe_hash = content_hash) AS described, SUM(lossy) AS lossy FROM artworks"),
    c.env.DB.prepare("SELECT v FROM settings WHERE k = 'backfill:last'"),
  ]);
  return c.json({
    posts: posts.results,
    jobs: jobs.results,
    artworks: art.results?.[0],
    backfill_last: last.results?.[0] ? JSON.parse((last.results[0] as any).v) : null,
    indexer: await indexerStub(c.env).status(),
    config: {
      semantic: embeddingEnabled(c.env), embed_model: c.env.EMBED_MODEL, embed_dim: int(c.env.EMBED_DIM, 768),
      vlm: c.env.VLM_BACKEND, scaler: c.env.SCALER, store_in_r2: bool(c.env.STORE_IN_R2, true), respect_ai_training: bool(c.env.RESPECT_AI_TRAINING_FLAG, false),
    },
  });
});

/** Queries with zero results in the last N days — the best guide to missing synonyms and tags. */
admin.get("/queries", async (c) => {
  const days = int(new URL(c.req.url).searchParams.get("days") ?? undefined, 7);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const zero = await c.env.DB.prepare("SELECT q, COUNT(*) AS n FROM query_log WHERE at >= ? AND results = 0 GROUP BY q ORDER BY n DESC LIMIT 100").bind(since).all();
  const top = await c.env.DB.prepare("SELECT q, COUNT(*) AS n, AVG(ms) AS avg_ms FROM query_log WHERE at >= ? GROUP BY q ORDER BY n DESC LIMIT 100").bind(since).all();
  return c.json({ days, zero_results: zero.results, top: top.results });
});

admin.get("/jobs/failed", async (c) => {
  const r = await c.env.DB.prepare("SELECT j.post_id, p.author, p.permlink, j.stage, j.attempts, j.error, j.updated FROM jobs j JOIN posts p ON p.id = j.post_id WHERE j.status = 'failed' ORDER BY j.updated DESC LIMIT 200").all();
  return c.json(r.results);
});

app.route("/admin", admin);
