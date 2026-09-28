// D1 access for posts, artworks, search docs and jobs. All writes are idempotent.

import type { Env, Stage } from "../env";
import { now } from "../env";
import type { ParsedPost } from "../chain/parse";

export interface PostRow {
  id: number;
  author: string;
  permlink: string;
  type: "artwork" | "blog";
  title: string;
  description: string;
  body: string;
  body_length: number;
  category: string | null;
  tags_json: string;
  app: string | null;
  nsfw: number;
  ai_training: number | null;
  license_json: string | null;
  royalty_pct: number | null;
  created: number;
  updated: number;
  block_num: number | null;
  deleted: number;
  net_votes: number;
  payout: number;
  children: number;
  listed: number;
  price: number | null;
  price_symbol: string | null;
  indexed_at: number;
}

export interface ArtworkRow {
  post_id: number;
  content_hash: string;
  mime: string;
  bytes: number;
  lossy: number;
  width: number | null;
  height: number | null;
  pixels: number | null;
  size_class: string | null;
  color_count: number | null;
  has_transparency: number | null;
  transparent_share: number | null;
  primary_color: string | null;
  background_hex: string | null;
  palette_json: string | null;
  buckets_json: string | null;
  phash: string | null;
  stats_hash: string | null;
  embed_hash: string | null;
  embed_model: string | null;
  describe_hash: string | null;
  vlm_model: string | null;
  ai_caption: string | null;
  ai_subjects_json: string | null;
  ai_tags_json: string | null;
  ai_style: string | null;
  ai_mood: string | null;
  ai_text: string | null;
  ai_nsfw: number | null;
  r2_orig_key: string | null;
  r2_up_key: string | null;
  up_width: number | null;
  up_height: number | null;
  up_factor: number | null;
  updated: number;
}

export interface UpsertResult {
  id: number;
  inserted: boolean;
  /** title/description/tags/body/deleted changed vs the stored row */
  textChanged: boolean;
  /** the post is an artwork whose image payload should be (re)processed */
  needsEnrich: boolean;
}

const BODY_FTS_LIMIT = 8000;

export async function getPostByRef(db: D1Database, author: string, permlink: string): Promise<PostRow | null> {
  return db.prepare("SELECT * FROM posts WHERE author = ? AND permlink = ?").bind(author, permlink).first<PostRow>();
}

export async function getPostById(db: D1Database, id: number): Promise<PostRow | null> {
  return db.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first<PostRow>();
}

export async function getArtwork(db: D1Database, postId: number): Promise<ArtworkRow | null> {
  return db.prepare("SELECT * FROM artworks WHERE post_id = ?").bind(postId).first<ArtworkRow>();
}

/**
 * Insert or update a post from chain state. Returns whether the enrichment pipeline should run.
 * Enrichment is keyed on the image payload; a title edit alone does not re-run the AI.
 */
export async function upsertPost(env: Env, p: ParsedPost, blockNum: number | null): Promise<UpsertResult> {
  const db = env.DB;
  const existing = await getPostByRef(db, p.author, p.permlink);
  const t = now();
  const tagsJson = JSON.stringify(p.tags);

  if (!existing) {
    const r = await db
      .prepare(
        `INSERT INTO posts (author, permlink, type, title, description, body, body_length, category, tags_json, app,
           nsfw, ai_training, license_json, royalty_pct, created, updated, block_num, deleted, net_votes, payout, children, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .bind(
        p.author, p.permlink, p.type, p.title, p.description, p.body, p.bodyLength, p.category, tagsJson, p.app,
        p.nsfw ? 1 : 0, p.aiTraining === null ? null : p.aiTraining ? 1 : 0, p.licenseJson, p.royaltyPct,
        p.created, p.updated, blockNum, p.deleted ? 1 : 0, p.netVotes, p.payout, p.children, t,
      )
      .first<{ id: number }>();
    const id = r!.id;
    await replaceTags(db, id, p.tags);
    await writeSearchDoc(db, id, { author: p.author, title: p.title, description: p.description, body: p.body, tags: p.tags });
    return { id, inserted: true, textChanged: true, needsEnrich: p.type === "artwork" && !p.deleted && !!p.image };
  }

  const textChanged =
    existing.title !== p.title ||
    existing.description !== p.description ||
    existing.body !== p.body ||
    existing.tags_json !== tagsJson ||
    existing.deleted !== (p.deleted ? 1 : 0) ||
    existing.type !== p.type;

  await db
    .prepare(
      `UPDATE posts SET type = ?, title = ?, description = ?, body = ?, body_length = ?, category = ?, tags_json = ?, app = ?,
         nsfw = ?, ai_training = ?, license_json = ?, royalty_pct = ?, updated = ?, block_num = COALESCE(?, block_num),
         deleted = ?, net_votes = ?, payout = ?, children = ?, indexed_at = ?
       WHERE id = ?`,
    )
    .bind(
      p.type, p.title, p.description, p.body, p.bodyLength, p.category, tagsJson, p.app,
      p.nsfw ? 1 : 0, p.aiTraining === null ? null : p.aiTraining ? 1 : 0, p.licenseJson, p.royaltyPct,
      Math.max(p.updated, existing.updated), blockNum, p.deleted ? 1 : 0, p.netVotes, p.payout, p.children, t,
      existing.id,
    )
    .run();

  if (textChanged) {
    await replaceTags(db, existing.id, p.tags);
    const art = await getArtwork(db, existing.id);
    await writeSearchDoc(db, existing.id, {
      author: p.author,
      title: p.title,
      description: p.description,
      body: p.body,
      tags: p.tags,
      aiCaption: art?.ai_caption ?? "",
      aiTags: art?.ai_tags_json ? (JSON.parse(art.ai_tags_json) as string[]) : [],
    });
  }

  if (p.deleted) {
    await removeFromIndexes(env, existing.id);
    return { id: existing.id, inserted: false, textChanged, needsEnrich: false };
  }

  // Image changed? Compare a cheap fingerprint (length + head/tail) before hashing in the consumer.
  let needsEnrich = false;
  if (p.type === "artwork" && p.image) {
    const art = await getArtwork(db, existing.id);
    needsEnrich = !art || art.stats_hash === null || art.bytes !== approxDecodedLength(p.image.base64) || existing.deleted === 1;
  }
  return { id: existing.id, inserted: false, textChanged, needsEnrich };
}

function approxDecodedLength(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

export async function replaceTags(db: D1Database, postId: number, tags: string[]): Promise<void> {
  const stmts = [db.prepare("DELETE FROM post_tags WHERE post_id = ?").bind(postId)];
  for (const tag of tags) stmts.push(db.prepare("INSERT OR IGNORE INTO post_tags (post_id, tag) VALUES (?, ?)").bind(postId, tag));
  await db.batch(stmts);
}

export interface SearchDocInput {
  author: string;
  title: string;
  description: string;
  body: string;
  tags: string[];
  aiCaption?: string;
  aiTags?: string[];
}

/** Upsert the row that feeds posts_fts (triggers keep the FTS index in sync). */
export async function writeSearchDoc(db: D1Database, postId: number, d: SearchDocInput): Promise<void> {
  const body = stripMarkdown(d.body).slice(0, BODY_FTS_LIMIT);
  await db
    .prepare(
      `INSERT INTO search_docs (post_id, title, description, body, tags, ai_caption, ai_tags, author)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(post_id) DO UPDATE SET title = excluded.title, description = excluded.description, body = excluded.body,
         tags = excluded.tags, ai_caption = excluded.ai_caption, ai_tags = excluded.ai_tags, author = excluded.author`,
    )
    .bind(postId, d.title, d.description, body, d.tags.join(" "), d.aiCaption ?? "", (d.aiTags ?? []).join(" "), d.author)
    .run();
}

/** Only the AI-derived columns of the search doc (called by the describe stage). */
export async function updateSearchDocAi(db: D1Database, postId: number, aiCaption: string, aiTags: string[]): Promise<void> {
  await db
    .prepare("UPDATE search_docs SET ai_caption = ?, ai_tags = ? WHERE post_id = ?")
    .bind(aiCaption, aiTags.join(" "), postId)
    .run();
}

export function stripMarkdown(md: string): string {
  if (!md) return "";
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#*_>`~|-]{1,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Soft-deleted or unindexable posts leave FTS, colour tables and Vectorize; the row itself stays. */
export async function removeFromIndexes(env: Env, postId: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM search_docs WHERE post_id = ?").bind(postId),
    env.DB.prepare("DELETE FROM artwork_colors WHERE post_id = ?").bind(postId),
    env.DB.prepare("DELETE FROM phash_chunks WHERE post_id = ?").bind(postId),
  ]);
  try {
    await env.VEC.deleteByIds([String(postId)]);
  } catch (e) {
    console.warn("vectorize delete failed", postId, e);
  }
}

export async function updateCounters(db: D1Database, postId: number, netVotes: number, payout: number, children: number): Promise<void> {
  await db.prepare("UPDATE posts SET net_votes = ?, payout = ?, children = ? WHERE id = ?").bind(netVotes, payout, children, postId).run();
}

export async function setJob(db: D1Database, postId: number, stage: Stage, status: "queued" | "done" | "failed" | "skipped", error?: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO jobs (post_id, stage, status, attempts, error, updated) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(post_id, stage) DO UPDATE SET status = excluded.status,
         attempts = jobs.attempts + CASE WHEN excluded.status IN ('done','failed') THEN 1 ELSE 0 END,
         error = excluded.error, updated = excluded.updated`,
    )
    .bind(postId, stage, status, status === "done" || status === "failed" ? 1 : 0, error ?? null, now())
    .run();
}

export async function getSetting(db: D1Database, k: string): Promise<string | null> {
  const r = await db.prepare("SELECT v FROM settings WHERE k = ?").bind(k).first<{ v: string }>();
  return r?.v ?? null;
}

export async function setSetting(db: D1Database, k: string, v: string): Promise<void> {
  await db.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, v).run();
}
