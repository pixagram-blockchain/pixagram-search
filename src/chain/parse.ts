// Turns a chain post into the shape the indexer stores.
//
// Verified against live posts on api.pixagram.com (Sept 2026):
//   json_metadata.format   "image" (artwork) | "markdown" (blog post)
//   artwork body           the whole body is a data URI: data:image/webp;base64,...  (WebP lossless; PNG possible)
//   json_metadata          { app, format, tags[], image, description, nsfw, license: { rightsConfiguration: { visitorRights: { "ai-training" } }, royaltyPercentage } }
//   deletion               the body is edited to the literal string "deleted" (no delete_comment op)

import { chainTime, parseAsset, type CondenserPost, type CommentOp } from "./rpc";

export type PostType = "artwork" | "blog";

export interface ImageRef {
  mime: string; // image/webp | image/png | image/svg+xml | ...
  base64: string;
  supported: boolean; // decodable by the enrichment pipeline
}

export interface ParsedPost {
  author: string;
  permlink: string;
  type: PostType;
  title: string;
  description: string;
  /** Markdown body for blog posts; '' for artworks (the data URI stays on chain). */
  body: string;
  bodyLength: number;
  category: string | null;
  tags: string[];
  app: string | null;
  nsfw: boolean;
  aiTraining: boolean | null;
  licenseJson: string | null;
  royaltyPct: number | null;
  created: number;
  updated: number;
  deleted: boolean;
  netVotes: number;
  payout: number;
  children: number;
  image: ImageRef | null;
}

const DATA_URI_WHOLE = /^\s*data:image\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+?)\s*$/i;
const DATA_URI_ANY = /data:image\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/i;
const SUPPORTED_MIME = new Set(["image/webp", "image/png"]);

export function parseJsonMetadata(jm: unknown): Record<string, any> {
  if (jm && typeof jm === "object") return jm as Record<string, any>;
  if (typeof jm !== "string" || jm.trim() === "") return {};
  try {
    const v = JSON.parse(jm);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Find the artwork payload in a body. Whole-body data URI first, embedded one as a fallback. */
export function extractImage(body: string): ImageRef | null {
  if (!body) return null;
  let m = DATA_URI_WHOLE.exec(body);
  if (!m && body.length < 4_000_000) m = DATA_URI_ANY.exec(body);
  if (!m) return null;
  const sub = m[1].toLowerCase();
  const mime = `image/${sub === "jpg" ? "jpeg" : sub}`;
  return { mime, base64: m[2].replace(/\s+/g, ""), supported: SUPPORTED_MIME.has(mime) };
}

export function normalizeTags(raw: unknown, category?: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: unknown) => {
    if (typeof t !== "string") return;
    const s = t.trim().toLowerCase().replace(/^#/, "").slice(0, 64);
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  if (Array.isArray(raw)) raw.forEach(push);
  else if (typeof raw === "string") raw.split(/[\s,]+/).forEach(push);
  if (category) push(category);
  return out.slice(0, 32);
}

export function isDeletedBody(body: string): boolean {
  return body.trim().toLowerCase() === "deleted";
}

/** Decide artwork vs blog. Explicit format field wins; a body that is an image is an artwork regardless. */
export function classify(jm: Record<string, any>, image: ImageRef | null): PostType {
  const f = typeof jm.format === "string" ? jm.format.toLowerCase() : "";
  if (f === "image" || f === "artwork") return "artwork";
  if (f === "markdown" || f === "html" || f === "text") return image ? "artwork" : "blog";
  return image ? "artwork" : "blog";
}

/**
 * Parse a post as returned by condenser_api.get_content / bridge.get_account_posts
 * (json_metadata may be a string or an object depending on the API).
 */
export function parsePost(p: CondenserPost): ParsedPost {
  const jm = parseJsonMetadata(p.json_metadata);
  const body = typeof p.body === "string" ? p.body : "";
  const deleted = isDeletedBody(body);
  const image = deleted ? null : extractImage(body);
  const type = classify(jm, image);
  const license = jm.license && typeof jm.license === "object" ? jm.license : null;
  const visitor = license?.rightsConfiguration?.visitorRights;
  const aiTraining = typeof visitor?.["ai-training"] === "boolean" ? visitor["ai-training"] : null;
  const royalty = typeof license?.royaltyPercentage === "number" ? license.royaltyPercentage : null;
  const category = (typeof p.category === "string" && p.category) || p.parent_permlink || null;
  const created = chainTime(p.created);
  const updated = chainTime(p.last_update ?? p.updated) || created;
  const payout =
    p.payout !== undefined
      ? parseAsset(p.payout)
      : parseAsset(p.pending_payout_value) + parseAsset(p.total_payout_value) + parseAsset(p.curator_payout_value);
  const netVotes =
    typeof p.net_votes === "number" ? p.net_votes : Array.isArray(p.active_votes) ? p.active_votes.length : 0;

  return {
    author: p.author,
    permlink: p.permlink,
    type,
    title: (p.title ?? "").slice(0, 512),
    description: typeof jm.description === "string" ? jm.description.slice(0, 4000) : "",
    body: type === "blog" && !deleted ? body : "",
    bodyLength: typeof p.body_length === "number" ? p.body_length : body.length,
    category,
    tags: normalizeTags(jm.tags, category),
    app: typeof jm.app === "string" ? jm.app.slice(0, 64) : null,
    nsfw: jm.nsfw === true || jm.nsfw === "true",
    aiTraining,
    licenseJson: license ? JSON.stringify(license) : null,
    royaltyPct: royalty,
    created,
    updated,
    deleted,
    netVotes,
    payout,
    children: typeof p.children === "number" ? p.children : 0,
    image: type === "artwork" ? image : null,
  };
}

/** Parse straight from a comment operation (no vote/payout data; those arrive via get_content). */
export function parseCommentOp(op: CommentOp, blockTime: string): ParsedPost {
  return parsePost({
    author: op.author,
    permlink: op.permlink,
    parent_author: op.parent_author,
    parent_permlink: op.parent_permlink,
    title: op.title,
    body: op.body,
    json_metadata: op.json_metadata,
    created: blockTime,
    last_update: blockTime,
    depth: 0,
    children: 0,
  });
}

export function appAllowed(app: string | null, prefixes: string[]): boolean {
  if (prefixes.length === 0) return true;
  if (!app) return false;
  const a = app.toLowerCase();
  return prefixes.some((p) => a.startsWith(p.toLowerCase()));
}
