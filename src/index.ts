// Worker entry: HTTP API, queue consumer, cron, plus the Durable Object and Workflow classes.

import WEBP_DEC_WASM from "@jsquash/webp/codec/dec/webp_dec.wasm";
// @ts-expect-error the package ships a wasm-bindgen .d.ts for this file; wrangler turns the import into a WebAssembly.Module
import PNG_WASM from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm";
import { app } from "./api";
import type { Env, EnrichMessage } from "./env";
import { initCodecs } from "./enrich/decode";
import { handleEnrichBatch } from "./enrich/consumer";
import { indexerStub } from "./chain/indexer-do";
import { refreshCounters } from "./chain/refresh";

export { ChainIndexer } from "./chain/indexer-do";
export { BackfillWorkflow } from "./chain/backfill";

// Compile-once WASM codecs (WebP decode, PNG decode/encode) for this isolate.
initCodecs({ webpDecode: WEBP_DEC_WASM, png: PNG_WASM });

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<EnrichMessage>, env: Env): Promise<void> {
    await handleEnrichBatch(batch, env);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === "*/10 * * * *") {
      // Watchdog: a running indexer must always have an alarm armed.
      const rearmed = await indexerStub(env).ensureAlarm();
      if (rearmed) console.warn("indexer alarm re-armed by watchdog");
      return;
    }
    // Nightly: refresh votes/payout for posts still inside their payout window.
    ctx.waitUntil(refreshCounters(env));
  },
} satisfies ExportedHandler<Env, EnrichMessage>;
