// Queue consumer: per-artwork enrichment. Stages are idempotent and keyed on the content hash,
// so a retried message (or a re-run after a model change) only redoes what is missing.
//
//   decode ─► native stats (size, colours, palette, buckets, pHash) ─► D1
//          └► upscale (xBRZ) ─► PNG ─► R2 preview
//                                   ├► SigLIP image embedding ─► Vectorize
//                                   └► VLM description (JSON) ─► D1 + FTS

import type { Env, EnrichMessage, Stage } from "../env";
import { ALL_STAGES, bool, int, now } from "../env";
import { base64Decode, base64Encode, sha256Hex } from "../lib/bytes";
import { rpcFor } from "../chain/ingest";
import { parsePost } from "../chain/parse";
import { getArtwork, getPostById, setJob, updateSearchDocAi, type ArtworkRow } from "../db/posts";
import { decodeImage, encodePng, sniff, type RgbaImage } from "./decode";
import { computeStats } from "./stats";
import { phash, phashChunks } from "./phash";
import { factorFor, upscale, type Scaler } from "./upscale";
import { EmbedUnavailable, embedImages, embeddingEnabled } from "./embed";
import { describeImage, type VlmBackend } from "./describe";

export interface EnrichReport {
  postId: number;
  hash?: string;
  stats: "done" | "skipped" | "failed" | "unchanged";
  embed: "done" | "skipped" | "failed" | "unchanged" | "retry";
  describe: "done" | "skipped" | "failed" | "unchanged" | "retry";
  error?: string;
}

class Retry extends Error {
  constructor(msg: string, public readonly delaySeconds: number) {
    super(msg);
  }
}

export async function handleEnrichBatch(batch: MessageBatch<EnrichMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const report = await enrichOne(env, msg.body);
      console.log("enrich", JSON.stringify(report));
      msg.ack();
    } catch (e) {
      if (e instanceof Retry) {
        console.warn("enrich retry", msg.body.postId, e.message);
        msg.retry({ delaySeconds: Math.min(e.delaySeconds * Math.max(1, msg.attempts), 3600) });
      } else if (isPermanent(e)) {
        // Undecodable / unsupported image: recorded in `jobs`, no point retrying.
        console.error("enrich permanent failure", msg.body.postId, e instanceof Error ? e.message : e);
        msg.ack();
      } else {
        console.error("enrich failed", msg.body.postId, e instanceof Error ? e.stack ?? e.message : e);
        // Transient-looking errors get a retry with backoff; the rest go to the dead-letter queue via max_retries.
        msg.retry({ delaySeconds: Math.min(60 * Math.max(1, msg.attempts), 3600) });
      }
    }
  }
}

export async function enrichOne(env: Env, m: EnrichMessage): Promise<EnrichReport> {
  const stages = new Set<Stage>(m.stages?.length ? m.stages : ALL_STAGES);
  const report: EnrichReport = { postId: m.postId, stats: "skipped", embed: "skipped", describe: "skipped" };

  const post = await getPostById(env.DB, m.postId);
  if (!post || post.deleted || post.type !== "artwork") {
    for (const s of stages) await setJob(env.DB, m.postId, s, "skipped", "not an active artwork");
    return report;
  }

  // The image lives on chain: re-read the post (json_metadata is tiny, body is the data URI).
  const chainPost = await rpcFor(env).getContent(post.author, post.permlink);
  if (!chainPost) throw new Error(`post ${post.author}/${post.permlink} not found on chain`);
  const parsed = parsePost(chainPost);
  if (!parsed.image || !parsed.image.supported) {
    for (const s of stages) await setJob(env.DB, m.postId, s, "skipped", parsed.image ? `unsupported mime ${parsed.image.mime}` : "no image payload");
    return report;
  }

  const bytes = base64Decode(parsed.image.base64);
  const hash = await sha256Hex(bytes);
  report.hash = hash;
  const container = sniff(bytes);
  if (container.format === "unknown") {
    for (const s of stages) await setJob(env.DB, m.postId, s, "skipped", "unrecognised container");
    return report;
  }

  let art = await getArtwork(env.DB, m.postId);
  const t = now();
  let img: RgbaImage | null = null;

  // ---- stats ---------------------------------------------------------------------------
  if (stages.has("stats")) {
    if (!m.force && art && art.stats_hash === hash) {
      report.stats = "unchanged";
    } else {
      try {
        img = await decodeImage(bytes, container);
        const st = computeStats(img, { lossy: container.lossy });
        const ph = phash(img);
        const origKey = bool(env.STORE_IN_R2, true) ? `orig/${hash}.${container.format}` : null;
        await env.DB.batch([
          env.DB
            .prepare(
              `INSERT INTO artworks (post_id, content_hash, mime, bytes, lossy, width, height, pixels, size_class, color_count,
                 has_transparency, transparent_share, primary_color, background_hex, palette_json, buckets_json, phash, stats_hash, r2_orig_key, updated)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(post_id) DO UPDATE SET content_hash = excluded.content_hash, mime = excluded.mime, bytes = excluded.bytes,
                 lossy = excluded.lossy, width = excluded.width, height = excluded.height, pixels = excluded.pixels, size_class = excluded.size_class,
                 color_count = excluded.color_count, has_transparency = excluded.has_transparency, transparent_share = excluded.transparent_share,
                 primary_color = excluded.primary_color, background_hex = excluded.background_hex, palette_json = excluded.palette_json,
                 buckets_json = excluded.buckets_json, phash = excluded.phash, stats_hash = excluded.stats_hash,
                 r2_orig_key = COALESCE(excluded.r2_orig_key, artworks.r2_orig_key), updated = excluded.updated`,
            )
            .bind(
              m.postId, hash, container.mime, bytes.length, container.lossy ? 1 : 0, st.width, st.height, st.pixels, st.sizeClass, st.colorCount,
              st.hasTransparency ? 1 : 0, st.transparentShare, st.primaryColor, st.backgroundHex, JSON.stringify(st.palette), JSON.stringify(st.buckets),
              ph, hash, origKey, t,
            ),
          env.DB.prepare("DELETE FROM artwork_colors WHERE post_id = ?").bind(m.postId),
          ...st.buckets.map((b) => env.DB.prepare("INSERT INTO artwork_colors (post_id, bucket, weight) VALUES (?, ?, ?)").bind(m.postId, b.name, b.weight)),
          env.DB.prepare("DELETE FROM phash_chunks WHERE post_id = ?").bind(m.postId),
          ...phashChunks(ph).map((v, i) => env.DB.prepare("INSERT INTO phash_chunks (post_id, idx, val) VALUES (?, ?, ?)").bind(m.postId, i, v)),
        ]);
        if (origKey) {
          const head = await env.ART.head(origKey);
          if (!head) await env.ART.put(origKey, bytes, { httpMetadata: { contentType: container.mime, cacheControl: "public, max-age=31536000, immutable" } });
        }
        await setJob(env.DB, m.postId, "stats", "done");
        report.stats = "done";
      } catch (e) {
        await setJob(env.DB, m.postId, "stats", "failed", errMsg(e));
        report.stats = "failed";
        throw e; // nothing downstream makes sense without a decodable image
      }
    }
    art = await getArtwork(env.DB, m.postId);
  }

  const needEmbed = stages.has("embed") && embeddingEnabled(env) && (m.force || !art || art.embed_hash !== hash);
  const vlm = (env.VLM_BACKEND ?? "moondream").toLowerCase();
  const describeOn = vlm === "moondream" || vlm === "scout";
  const consentBlocked = bool(env.RESPECT_AI_TRAINING_FLAG, false) && post.ai_training === 0;
  const needDescribe = stages.has("describe") && describeOn && !consentBlocked && (m.force || !art || art.describe_hash !== hash);

  if (stages.has("embed") && !embeddingEnabled(env)) {
    await setJob(env.DB, m.postId, "embed", "skipped", "HF_EMBED_URL not configured");
  } else if (stages.has("embed") && !needEmbed) report.embed = "unchanged";
  if (stages.has("describe") && !describeOn) {
    await setJob(env.DB, m.postId, "describe", "skipped", "VLM_BACKEND off");
  } else if (stages.has("describe") && consentBlocked) {
    await setJob(env.DB, m.postId, "describe", "skipped", "ai-training=false and RESPECT_AI_TRAINING_FLAG");
  } else if (stages.has("describe") && !needDescribe) report.describe = "unchanged";

  if (!needEmbed && !needDescribe) return report;

  // ---- upscaled PNG (shared by embed + describe + preview) --------------------------------
  if (!img) img = await decodeImage(bytes, container);
  const factor = factorFor(img.width, img.height, int(env.UPSCALE_TARGET, 800));
  const scaler: Scaler = (env.SCALER ?? "xbrz") === "nearest" ? "nearest" : "xbrz";
  const up = upscale(img, factor, scaler);
  const png = await encodePng(up);
  const pngB64 = base64Encode(png);
  const upKey = bool(env.STORE_IN_R2, true) ? `up/${hash}.png` : null;
  if (upKey && !(await env.ART.head(upKey))) {
    await env.ART.put(upKey, png, { httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" } });
  }
  await env.DB
    .prepare("UPDATE artworks SET r2_up_key = COALESCE(?, r2_up_key), up_width = ?, up_height = ?, up_factor = ? WHERE post_id = ?")
    .bind(upKey, up.width, up.height, factor, m.postId)
    .run();
  art = art ?? (await getArtwork(env.DB, m.postId));

  // ---- embed -----------------------------------------------------------------------------
  let pendingRetry: Retry | null = null;
  if (needEmbed) {
    try {
      const r = await embedImages(env, [pngB64]);
      await env.VEC.upsert([{ id: String(m.postId), values: r.embeddings[0], metadata: vectorMetadata(post, art, hash) }]);
      await env.DB.prepare("UPDATE artworks SET embed_hash = ?, embed_model = ?, updated = ? WHERE post_id = ?").bind(hash, r.model, now(), m.postId).run();
      await setJob(env.DB, m.postId, "embed", "done");
      report.embed = "done";
    } catch (e) {
      await setJob(env.DB, m.postId, "embed", "failed", errMsg(e));
      if (e instanceof EmbedUnavailable && e.retryable) {
        report.embed = "retry";
        pendingRetry = new Retry(`embedding endpoint unavailable: ${e.message}`, 60);
      } else {
        report.embed = "failed";
        report.error = errMsg(e);
      }
    }
  }

  // ---- describe --------------------------------------------------------------------------
  if (needDescribe) {
    try {
      const { model, description } = await describeImage(env, vlm as VlmBackend, `data:image/png;base64,${pngB64}`, {
        title: post.title,
        tags: JSON.parse(post.tags_json || "[]"),
        description: post.description,
      });
      await env.DB
        .prepare(
          `UPDATE artworks SET describe_hash = ?, vlm_model = ?, ai_caption = ?, ai_subjects_json = ?, ai_tags_json = ?, ai_style = ?, ai_mood = ?,
             ai_text = ?, ai_nsfw = ?, updated = ? WHERE post_id = ?`,
        )
        .bind(
          hash, model, description.caption, JSON.stringify(description.subjects),
          JSON.stringify([...new Set([...description.tags, ...description.subjects, ...description.objects])].slice(0, 32)),
          description.style, description.mood, description.text_in_image, description.nsfw, now(), m.postId,
        )
        .run();
      await updateSearchDocAi(env.DB, m.postId, `${description.caption} ${description.style} ${description.mood} ${description.text_in_image}`.trim(), [
        ...description.tags,
        ...description.subjects,
        ...description.objects,
      ]);
      // Keep Vectorize metadata in step (nsfw estimate is filterable).
      if (art?.embed_hash === hash || report.embed === "done") {
        try {
          const vec = await env.VEC.getByIds([String(m.postId)]);
          if (vec[0]) await env.VEC.upsert([{ id: String(m.postId), values: vec[0].values as number[], metadata: { ...vectorMetadata(post, art, hash), ai_nsfw: description.nsfw } }]);
        } catch (e) {
          console.warn("vector metadata refresh failed", m.postId, errMsg(e));
        }
      }
      await setJob(env.DB, m.postId, "describe", "done");
      report.describe = "done";
    } catch (e) {
      const msg = errMsg(e);
      await setJob(env.DB, m.postId, "describe", "failed", msg);
      if (/429|capacity|timeout|temporar|overload|503|502/i.test(msg)) {
        report.describe = "retry";
        pendingRetry = pendingRetry ?? new Retry(`vlm transient failure: ${msg}`, 120);
      } else {
        report.describe = "failed";
        report.error = msg;
      }
    }
  }

  if (pendingRetry) throw pendingRetry;
  return report;
}

export function vectorMetadata(post: { author: string; permlink: string; created: number; nsfw: number; ai_training: number | null; listed: number }, art: ArtworkRow | null, hash: string): Record<string, string | number | boolean> {
  return {
    author: post.author,
    permlink: post.permlink,
    created: post.created,
    nsfw: post.nsfw === 1,
    ai_training: post.ai_training === null ? true : post.ai_training === 1,
    listed: post.listed === 1,
    primary_color: art?.primary_color ?? "",
    size_class: art?.size_class ?? "",
    color_count: art?.color_count ?? 0,
    hash,
  };
}

function isPermanent(e: unknown): boolean {
  return /unsupported image container|image too large|Decoding error|Encoding error|unrecognised container/i.test(errMsg(e));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
