#!/usr/bin/env bash
# Thin wrapper around the admin API.
#   BASE=https://pixagram-search.<you>.workers.dev ADMIN_TOKEN=... scripts/admin.sh stats
set -euo pipefail
BASE="${BASE:-http://127.0.0.1:8787}"
: "${ADMIN_TOKEN:?set ADMIN_TOKEN}"
H=(-H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json")

case "${1:-help}" in
  stats)          curl -s "${H[@]}" "$BASE/admin/stats" ;;
  indexer)        curl -s "${H[@]}" "$BASE/admin/indexer" ;;
  start)          curl -s "${H[@]}" -X POST "$BASE/admin/indexer/start${2:+?from=$2}" ;;   # start [from_block]
  stop)           curl -s "${H[@]}" -X POST "$BASE/admin/indexer/stop" ;;
  backfill)       curl -s "${H[@]}" -X POST "$BASE/admin/backfill" -d "{\"reason\":\"cli\"${2:+,\"authors\":[\"$2\"]}}" ;;  # backfill [author]
  backfill-status) curl -s "${H[@]}" "$BASE/admin/backfill/$2" ;;
  ingest)         curl -s "${H[@]}" -X POST "$BASE/admin/ingest/$2/$3" ;;                  # ingest author permlink
  reindex-all)    curl -s "${H[@]}" -X POST "$BASE/admin/reindex" -d "{\"all\":true,\"stages\":[${2:-\"stats\",\"embed\",\"describe\"}],\"force\":${3:-false}}" ;;
  reindex-post)   curl -s "${H[@]}" -X POST "$BASE/admin/reindex" -d "{\"post_id\":$2,\"force\":true}" ;;
  failed)         curl -s "${H[@]}" "$BASE/admin/jobs/failed" ;;
  queries)        curl -s "${H[@]}" "$BASE/admin/queries?days=${2:-7}" ;;
  *) echo "usage: admin.sh stats|indexer|start [from]|stop|backfill [author]|backfill-status id|ingest author permlink|reindex-all [\"stages\"] [force]|reindex-post id|failed|queries [days]" ;;
esac
echo
