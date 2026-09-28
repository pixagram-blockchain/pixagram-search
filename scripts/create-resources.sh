#!/usr/bin/env bash
# One-time creation of the Cloudflare resources used by wrangler.jsonc.
# Requires: wrangler logged in (npx wrangler login) on a Workers Paid account.
set -euo pipefail
cd "$(dirname "$0")/.."

EMBED_DIM="${EMBED_DIM:-768}"   # must match hf/handler.py MODEL_ID (768 for siglip-base multilingual)

echo "== D1"
npx wrangler d1 create pixagram-search || true
echo "   -> paste the database_id into wrangler.jsonc (d1_databases[0].database_id)"

echo "== KV"
npx wrangler kv namespace create CACHE || true
echo "   -> paste the id into wrangler.jsonc (kv_namespaces[0].id)"

echo "== R2"
npx wrangler r2 bucket create pixagram-art || true

echo "== Queues"
npx wrangler queues create pixagram-enrich || true
npx wrangler queues create pixagram-enrich-dlq || true

echo "== Vectorize (dimension $EMBED_DIM, cosine)"
npx wrangler vectorize create pixagram-art --dimensions="$EMBED_DIM" --metric=cosine || true
# Metadata indexes must exist BEFORE vectors are inserted (max 10).
for spec in author:string primary_color:string size_class:string created:number color_count:number nsfw:boolean listed:boolean ai_training:boolean; do
  name="${spec%%:*}"; type="${spec##*:}"
  npx wrangler vectorize create-metadata-index pixagram-art --property-name="$name" --type="$type" || true
done

echo "== Secrets"
echo "   npx wrangler secret put ADMIN_TOKEN"
echo "   npx wrangler secret put HF_TOKEN        # once the HF endpoint exists"
echo
echo "Then: npm run db:migrate && npm run deploy"
