// BackfillWorkflow: (re)ingest every top-level post of every account.
//
// database_api.list_comments is not enabled on the public Pixa nodes, so history is walked
// account by account through Hivemind's bridge.get_account_posts (20 posts per page).
// Each step is retried by Workflows on failure and returns only counters, so state stays tiny.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env";
import { ingestPost, rpcFor } from "./ingest";
import { setSetting } from "../db/posts";

export interface BackfillParams {
  /** Restrict to these accounts; default = every account on the chain. */
  authors?: string[];
  /** Free-text label for logs. */
  reason?: string;
}

interface Counters {
  authors: number;
  posts: number;
  inserted: number;
  updated: number;
  enqueued: number;
  skipped: number;
}

const AUTHORS_PER_STEP = 5;

export class BackfillWorkflow extends WorkflowEntrypoint<Env, BackfillParams> {
  async run(event: WorkflowEvent<BackfillParams>, step: WorkflowStep): Promise<Counters> {
    const params = event.payload ?? {};

    const authors = await step.do("list accounts", async () => {
      if (params.authors?.length) return params.authors;
      const rpc = rpcFor(this.env);
      const all: string[] = [];
      let start = "";
      for (;;) {
        const page = await rpc.lookupAccounts(start, 1000);
        for (const a of page) if (a !== start) all.push(a);
        if (page.length < 1000) break;
        start = page[page.length - 1];
        all.push(start);
      }
      return Array.from(new Set(all));
    });

    const total: Counters = { authors: authors.length, posts: 0, inserted: 0, updated: 0, enqueued: 0, skipped: 0 };

    for (let i = 0; i < authors.length; i += AUTHORS_PER_STEP) {
      const chunk = authors.slice(i, i + AUTHORS_PER_STEP);
      const c = await step.do(
        `authors ${i + 1}-${i + chunk.length}`,
        { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" },
        async () => {
          const rpc = rpcFor(this.env);
          const c: Counters = { authors: chunk.length, posts: 0, inserted: 0, updated: 0, enqueued: 0, skipped: 0 };
          for (const author of chunk) {
            let start: { author: string; permlink: string } | undefined;
            for (let page = 0; page < 5000; page++) {
              const posts = await rpc.getAccountPosts(author, start, 20);
              if (!posts.length) break;
              for (const p of posts) {
                if (p.author !== author) continue; // reblogs never appear with sort=posts, but be safe
                c.posts++;
                const r = await ingestPost(this.env, p, null, `backfill:${params.reason ?? event.instanceId}`);
                if (r.action === "inserted") c.inserted++;
                else if (r.action === "updated" || r.action === "deleted") c.updated++;
                else c.skipped++;
                if (r.enqueued) c.enqueued++;
              }
              if (posts.length < 20) break;
              const last = posts[posts.length - 1];
              start = { author: last.author, permlink: last.permlink };
            }
          }
          return c;
        },
      );
      total.posts += c.posts;
      total.inserted += c.inserted;
      total.updated += c.updated;
      total.enqueued += c.enqueued;
      total.skipped += c.skipped;
    }

    await step.do("record", async () => {
      await setSetting(this.env.DB, "backfill:last", JSON.stringify({ at: Date.now(), instance: event.instanceId, ...total }));
    });
    return total;
  }
}
