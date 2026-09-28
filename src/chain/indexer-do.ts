// ChainIndexer: a single Durable Object that tails the Pixa chain.
//
// One named instance ("main") holds the block cursor and re-arms its own alarm. It reads only
// irreversible blocks (no reorg handling needed), picks top-level comment ops and marketplace
// custom_json ops out of each block, fetches the post's current state with get_content and
// upserts it. Everything else (votes, follows, transfers) is ignored.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { int } from "../env";
import { normalizeOp, type CommentOp, type CustomJsonOp } from "./rpc";
import { ingestPostRef, rpcFor } from "./ingest";
import { handleMarketOp, marketIds } from "./market";

interface IndexerState {
  running: boolean;
  cursor: number | null; // next block to process
  lastProcessed: number | null;
  lib: number | null;
  head: number | null;
  lastTickAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  postsSeen: number;
  ticks: number;
}

const DEFAULT_STATE: IndexerState = {
  running: false,
  cursor: null,
  lastProcessed: null,
  lib: null,
  head: null,
  lastTickAt: null,
  lastError: null,
  lastErrorAt: null,
  postsSeen: 0,
  ticks: 0,
};

export class ChainIndexer extends DurableObject<Env> {
  private async load(): Promise<IndexerState> {
    return { ...DEFAULT_STATE, ...((await this.ctx.storage.get<Partial<IndexerState>>("state")) ?? {}) };
  }

  private async save(s: IndexerState): Promise<void> {
    await this.ctx.storage.put("state", s);
  }

  // ---- control API (called by the Worker's admin routes) ------------------------

  async status(): Promise<IndexerState & { alarmAt: number | null }> {
    const s = await this.load();
    return { ...s, alarmAt: await this.ctx.storage.getAlarm() };
  }

  /** Start tailing. `from` replays from that block; otherwise continue, or begin at the irreversible head. */
  async start(from?: number): Promise<IndexerState> {
    const s = await this.load();
    if (typeof from === "number" && from > 0) s.cursor = from;
    if (s.cursor === null) {
      const dgp = await rpcFor(this.env).getDynamicGlobalProperties();
      s.cursor = dgp.last_irreversible_block_num;
    }
    s.running = true;
    s.lastError = null;
    await this.save(s);
    await this.ctx.storage.setAlarm(Date.now() + 10);
    return s;
  }

  async stop(): Promise<IndexerState> {
    const s = await this.load();
    s.running = false;
    await this.save(s);
    await this.ctx.storage.deleteAlarm();
    return s;
  }

  /** Watchdog: if running but the alarm is gone (it happens after failed deploys), re-arm it. */
  async ensureAlarm(): Promise<boolean> {
    const s = await this.load();
    if (!s.running) return false;
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 10);
      return true;
    }
    return false;
  }

  // ---- the loop ---------------------------------------------------------------------

  async alarm(): Promise<void> {
    const s = await this.load();
    if (!s.running || s.cursor === null) return;
    const perTick = int(this.env.TAIL_BLOCKS_PER_TICK, 200);
    const idleMs = int(this.env.TAIL_IDLE_SECONDS, 3) * 1000;
    const rpc = rpcFor(this.env);

    try {
      const dgp = await rpc.getDynamicGlobalProperties();
      s.lib = dgp.last_irreversible_block_num;
      s.head = dgp.head_block_number;
      s.ticks++;
      s.lastTickAt = Date.now();

      if (s.cursor > s.lib) {
        await this.save(s);
        await this.ctx.storage.setAlarm(Date.now() + idleMs);
        return;
      }

      const count = Math.min(perTick, s.lib - s.cursor + 1);
      const blocks = await rpc.getBlockRange(s.cursor, count);
      const posts = new Map<string, { author: string; permlink: string; block: number }>();
      const market: CustomJsonOp[] = [];
      const ids = marketIds(this.env);

      blocks.forEach((block, i) => {
        const blockNum = s.cursor! + i;
        for (const tx of block.transactions ?? []) {
          for (const raw of tx.operations ?? []) {
            const op = normalizeOp(raw);
            if (op.type === "comment") {
              const c = op.value as CommentOp;
              if (c.parent_author === "") posts.set(`${c.author}/${c.permlink}`, { author: c.author, permlink: c.permlink, block: blockNum });
            } else if (op.type === "delete_comment") {
              // Rare on Pixagram (posts are "deleted" by editing the body) but cheap to honour.
              const v = op.value as { author: string; permlink: string };
              posts.set(`${v.author}/${v.permlink}`, { author: v.author, permlink: v.permlink, block: blockNum });
            } else if (op.type === "custom_json" && ids.has((op.value as CustomJsonOp).id)) {
              market.push(op.value as CustomJsonOp);
            }
          }
        }
      });

      for (const ref of posts.values()) {
        const r = await ingestPostRef(this.env, ref.author, ref.permlink, ref.block, "tail");
        if (r.action === "missing") {
          // delete_comment on a post without votes really removes it from state.
          await this.env.DB.prepare("UPDATE posts SET deleted = 1 WHERE author = ? AND permlink = ?").bind(ref.author, ref.permlink).run();
        }
        s.postsSeen++;
      }
      for (const op of market) await handleMarketOp(this.env, op);

      s.lastProcessed = s.cursor + blocks.length - 1;
      s.cursor = s.cursor + blocks.length;
      s.lastError = null;
      await this.save(s);
      const behind = s.cursor <= s.lib;
      await this.ctx.storage.setAlarm(Date.now() + (behind ? 25 : idleMs));
    } catch (e) {
      s.lastError = e instanceof Error ? e.message : String(e);
      s.lastErrorAt = Date.now();
      await this.save(s);
      console.error("indexer tick failed", s.lastError);
      await this.ctx.storage.setAlarm(Date.now() + 10_000);
    }
  }
}

/** The single indexer instance. */
export function indexerStub(env: Env) {
  const id = env.INDEXER.idFromName("main");
  return env.INDEXER.get(id) as unknown as DurableObjectStub<ChainIndexer>;
}
