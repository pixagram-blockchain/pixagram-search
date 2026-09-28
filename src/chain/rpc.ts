// Minimal JSON-RPC client for the Pixa chain (Hive-compatible).
// Primary endpoint with fallbacks; retries on network errors and 5xx; no retry on RPC asserts.

export interface RpcOptions {
  url: string;
  fallbacks?: string[];
  timeoutMs?: number;
  retries?: number;
}

export class RpcError extends Error {
  constructor(
    message: string,
    public readonly method: string,
    public readonly code?: number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export class ChainRpc {
  private readonly urls: string[];
  private readonly timeoutMs: number;
  private readonly retries: number;
  private id = 1;

  constructor(opts: RpcOptions) {
    this.urls = [opts.url, ...(opts.fallbacks ?? [])].filter(Boolean);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.retries = opts.retries ?? 2;
  }

  async call<T = unknown>(method: string, params: unknown = []): Promise<T> {
    let lastErr: unknown;
    const attempts = this.retries + 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const url = this.urls[Math.min(attempt, this.urls.length - 1)];
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
        let res: Response;
        try {
          res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: this.id++, method, params }),
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(t);
        }
        if (res.status >= 500 || res.status === 429) {
          throw new Error(`HTTP ${res.status} from ${url}`);
        }
        const json = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
        if (json.error) {
          // Assert exceptions are deterministic; do not retry them.
          throw new RpcError(json.error.message, method, json.error.code, json.error.data);
        }
        return json.result as T;
      } catch (e) {
        if (e instanceof RpcError) throw e;
        lastErr = e;
        if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  // ---- typed helpers -------------------------------------------------------

  getDynamicGlobalProperties() {
    return this.call<DynamicGlobalProperties>("database_api.get_dynamic_global_properties", {});
  }

  /** Blocks [start, start+count) in the modern block_api shape. */
  async getBlockRange(startingBlockNum: number, count: number): Promise<Block[]> {
    const r = await this.call<{ blocks: Block[] }>("block_api.get_block_range", {
      starting_block_num: startingBlockNum,
      count,
    });
    return r.blocks ?? [];
  }

  /** Full current state of a post (json_metadata is a string here). */
  async getContent(author: string, permlink: string): Promise<CondenserPost | null> {
    const r = await this.call<CondenserPost>("condenser_api.get_content", [author, permlink]);
    if (!r || !r.author) return null; // Hive returns an empty object for unknown posts
    return r;
  }

  /** Account names after `start` (inclusive), up to `limit` (max 1000). */
  lookupAccounts(start: string, limit = 1000): Promise<string[]> {
    return this.call<string[]>("condenser_api.lookup_accounts", [start, limit]);
  }

  /**
   * An account's own top-level posts, newest first, 20 per page (Hivemind limit).
   * Pass the last item of the previous page as start_author/start_permlink; it is excluded.
   */
  getAccountPosts(account: string, start?: { author: string; permlink: string }, limit = 20) {
    return this.call<BridgePost[]>("bridge.get_account_posts", {
      sort: "posts",
      account,
      limit,
      ...(start ? { start_author: start.author, start_permlink: start.permlink } : {}),
    });
  }

  /** Newest posts chain-wide, 20 per page. Used by the watchdog to spot anything the tail missed. */
  getDiscussionsByCreated(start?: { author: string; permlink: string }, limit = 20) {
    return this.call<CondenserPost[]>("condenser_api.get_discussions_by_created", [
      { tag: "", limit, ...(start ? { start_author: start.author, start_permlink: start.permlink } : {}) },
    ]);
  }
}

// ---- chain types (subset) ----------------------------------------------------

export interface DynamicGlobalProperties {
  head_block_number: number;
  last_irreversible_block_num: number;
  time: string; // "2026-09-27T20:48:03"
}

export interface Block {
  block_id: string;
  previous: string;
  timestamp: string;
  witness: string;
  transactions: Transaction[];
  transaction_ids?: string[];
}

export interface Transaction {
  operations: Operation[];
}

/** block_api shape: { type: "comment_operation", value: {...} }. condenser shape: ["comment", {...}]. */
export type Operation = { type: string; value: Record<string, any> } | [string, Record<string, any>];

export interface CommentOp {
  parent_author: string;
  parent_permlink: string;
  author: string;
  permlink: string;
  title: string;
  body: string;
  json_metadata: string;
}

export interface CustomJsonOp {
  required_auths: string[];
  required_posting_auths: string[];
  id: string;
  json: string;
}

export interface CondenserPost {
  author: string;
  permlink: string;
  parent_author: string;
  parent_permlink: string;
  category?: string;
  title: string;
  body: string;
  body_length?: number;
  json_metadata: string | Record<string, unknown>;
  created: string;
  last_update?: string;
  updated?: string;
  depth: number;
  children: number;
  net_votes?: number;
  active_votes?: unknown[];
  pending_payout_value?: string; // "14.469 PXS"
  total_payout_value?: string;
  curator_payout_value?: string;
  author_payout_value?: string;
  payout?: number;
}

export type BridgePost = CondenserPost;

/** "14.469 PXS" -> 14.469 */
export function parseAsset(v: string | number | undefined | null): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === "number") return v;
  const n = Number.parseFloat(v.split(" ")[0]);
  return Number.isFinite(n) ? n : 0;
}

/** Chain timestamps are UTC without a zone suffix. */
export function chainTime(s: string | undefined): number {
  if (!s) return 0;
  const t = Date.parse(s.endsWith("Z") ? s : `${s}Z`);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

/** Normalise both operation encodings to { type, value } with the short type name. */
export function normalizeOp(op: Operation): { type: string; value: Record<string, any> } {
  if (Array.isArray(op)) return { type: op[0], value: op[1] };
  return { type: op.type.replace(/_operation$/, ""), value: op.value };
}
