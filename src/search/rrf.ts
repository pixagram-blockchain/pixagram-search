// Reciprocal rank fusion: merges ranked lists from different scorers (BM25, cosine) without
// having to make their scores comparable. score(d) = Σ_lists w_list / (k + rank_list(d)).

export interface RankedList {
  name: string;
  ids: number[]; // best first
  weight?: number;
}

export interface Fused {
  id: number;
  score: number;
  ranks: Record<string, number>; // 1-based rank per list the id appeared in
}

export function reciprocalRankFusion(lists: RankedList[], k = 60): Fused[] {
  const acc = new Map<number, Fused>();
  for (const list of lists) {
    const w = list.weight ?? 1;
    list.ids.forEach((id, i) => {
      const rank = i + 1;
      let f = acc.get(id);
      if (!f) {
        f = { id, score: 0, ranks: {} };
        acc.set(id, f);
      }
      f.score += w / (k + rank);
      f.ranks[list.name] = rank;
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score || a.id - b.id);
}

/** Mild popularity/recency shaping applied after fusion; never overrides a strong relevance gap. */
export function boost(score: number, netVotes: number, createdUnix: number, nowUnix: number): number {
  const ageDays = Math.max(0, (nowUnix - createdUnix) / 86400);
  const popularity = 1 + 0.08 * Math.log1p(Math.max(0, netVotes));
  const recency = 1 + 0.06 * Math.exp(-ageDays / 120);
  return score * popularity * recency;
}
