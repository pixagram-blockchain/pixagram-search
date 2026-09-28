import { describe, expect, it } from "vitest";
import { parseSearchRequest, parseDate } from "../src/search/params";
import { browse, buildFilter, decodeCursor, encodeCursor, facetQueries, ftsCandidates, ftsQuery, hydrate } from "../src/search/sql";
import { boost, reciprocalRankFusion } from "../src/search/rrf";
import { vectorFilter } from "../src/search/service";
import { parseDescription, buildPrompt } from "../src/enrich/describe";
import { bucketize, clusterPalette, deltaE2000, nearestNamed, rgbToLab } from "../src/enrich/color";
import { base64Decode, base64Encode } from "../src/lib/bytes";

const req = (qs: string) => parseSearchRequest(new URLSearchParams(qs));

describe("parseSearchRequest", () => {
  it("parses filters, drops unknown values, defaults sensibly", () => {
    const r = req("q=sad+robot&type=artwork&author=@matus,wang&tag=bird&color=blue,neon&has_color=red&size=large,giant&min_colors=4&from=2026-09-01&to=1760000000&nsfw=include&sort=votes&limit=500&facets=1");
    expect(r.q).toBe("sad robot");
    expect(r.type).toBe("artwork");
    expect(r.authors).toEqual(["matus", "wang"]);
    expect(r.tags).toEqual(["bird"]);
    expect(r.colors).toEqual(["blue"]);
    expect(r.hasColors).toEqual(["red"]);
    expect(r.sizes).toEqual(["large"]);
    expect(r.minColors).toBe(4);
    expect(r.from).toBe(Math.floor(Date.parse("2026-09-01T00:00:00Z") / 1000));
    expect(r.to).toBe(1760000000);
    expect(r.nsfw).toBe("include");
    expect(r.sort).toBe("votes");
    expect(r.limit).toBe(50);
    expect(r.facets).toBe(true);
  });

  it("defaults sort to newest without a query and relevance with one", () => {
    expect(req("").sort).toBe("newest");
    expect(req("q=x").sort).toBe("relevance");
    expect(req("").nsfw).toBe("exclude");
    expect(req("").limit).toBe(24);
  });

  it("parseDate accepts several forms", () => {
    expect(parseDate("1700000000")).toBe(1700000000);
    expect(parseDate("1700000000000")).toBe(1700000000);
    expect(parseDate("2026-01-02")).toBe(Math.floor(Date.parse("2026-01-02T00:00:00Z") / 1000));
    expect(parseDate("garbage")).toBeNull();
  });
});

describe("SQL building", () => {
  it("emits one clause per filter with matching params", () => {
    const r = req("type=artwork&author=a,b&tag=t1&tag=t2&color=red&has_color=blue,green&size=small&min_colors=2&max_colors=16&min_width=10&transparent=true&listed=false&ai_training=true&from=100&to=200");
    const f = buildFilter(r);
    expect(f.sql).toContain("p.deleted = 0");
    expect(f.sql).toContain("p.type = ?");
    expect(f.sql).toContain("p.author IN (?, ?)");
    expect((f.sql.match(/post_tags/g) ?? []).length).toBe(2);
    expect(f.sql).toContain("a.primary_color IN (?)");
    expect(f.sql).toContain("c.bucket IN (?, ?) AND c.weight >= ?");
    expect(f.sql).toContain("p.nsfw = 0");
    expect(f.params).toEqual(["artwork", "a", "b", "t1", "t2", "red", "blue", "green", 0.08, "small", 2, 16, 10, 100, 200, 1, 0]);
    expect((f.sql.match(/\?/g) ?? []).length).toBe(f.params.length);
  });

  it("nsfw modes", () => {
    expect(buildFilter(req("nsfw=only")).sql).toContain("p.nsfw = 1 OR");
    expect(buildFilter(req("nsfw=include")).sql).not.toContain("nsfw");
  });

  it("browse uses keyset pagination and returns limit+1", () => {
    const c = browse(req("sort=votes"), { v: 10, id: 5 }, 24);
    expect(c.sql).toContain("p.net_votes < ? OR (p.net_votes = ? AND p.id < ?)");
    expect(c.params.slice(-4)).toEqual([10, 10, 5, 25]);
    const c2 = browse(req("sort=oldest"), null, 10);
    expect(c2.sql).toContain("ORDER BY p.created ASC, p.id ASC");
  });

  it("cursor round-trips", () => {
    const c = { v: 1758990000, id: 42 };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor("nope")).toBeNull();
    expect(decodeCursor(null)).toBeNull();
  });

  it("fts candidates join filters and placeholders line up", () => {
    const c = ftsCandidates(req("q=swan&color=blue"), '"swan"*', 100);
    expect(c.sql).toContain("posts_fts MATCH ?");
    expect(c.sql).toContain("bm25(posts_fts");
    expect(c.params[0]).toBe('"swan"*');
    expect(c.params[c.params.length - 1]).toBe(100);
    expect((c.sql.match(/\?/g) ?? []).length).toBe(c.params.length);
  });

  it("hydrate re-applies filters", () => {
    const c = hydrate([1, 2, 3], req("color=red"));
    expect(c.sql).toContain("p.id IN (?, ?, ?)");
    expect(c.params).toEqual([1, 2, 3, "red"]);
  });

  it("facet queries all have balanced placeholders", () => {
    const q = facetQueries(req("q=x&author=a"), '"x"*');
    for (const [name, c] of Object.entries(q)) {
      expect((c.sql.match(/\?/g) ?? []).length, name).toBe(c.params.length);
      expect(c.sql).toContain("posts_fts MATCH ?");
    }
  });
});

describe("ftsQuery", () => {
  it("quotes tokens, strips operators, prefixes the last token", () => {
    expect(ftsQuery("sad robot")).toBe('"sad" "robot"*');
    expect(ftsQuery('a "b" (c) OR NOT *')).toBe('"a" "b" "c" "OR" "NOT"*');
    expect(ftsQuery("   ")).toBeNull();
    expect(ftsQuery("x")).toBe('"x"'); // single char: no prefix
    expect(ftsQuery("rêveuse", "or")).toBe('"rêveuse"');
    expect(ftsQuery("a b", "or")).toBe('"a" OR "b"');
  });
});

describe("RRF", () => {
  it("fuses ranks and prefers items present in both lists", () => {
    const fused = reciprocalRankFusion([
      { name: "fts", ids: [1, 2, 3] },
      { name: "vec", ids: [3, 4, 1] },
    ]);
    expect(fused[0].id).toBe(1);
    expect(fused.map((f) => f.id)).toEqual(expect.arrayContaining([1, 2, 3, 4]));
    expect(fused.find((f) => f.id === 1)!.ranks).toEqual({ fts: 1, vec: 3 });
    expect(fused.find((f) => f.id === 2)!.ranks).toEqual({ fts: 2 });
  });

  it("boost is mild and monotone", () => {
    const now = 2_000_000_000;
    expect(boost(1, 0, now, now)).toBeGreaterThan(1);
    expect(boost(1, 100, now, now)).toBeGreaterThan(boost(1, 0, now, now));
    expect(boost(1, 0, now - 365 * 86400, now)).toBeLessThan(boost(1, 0, now, now));
    expect(boost(1, 1000, now, now)).toBeLessThan(2);
  });
});

describe("vectorFilter", () => {
  it("mirrors the filters Vectorize can express", () => {
    const f = vectorFilter(req("author=a,b&color=red&from=10&to=20&min_colors=2&listed=true&nsfw=exclude&size=small")) as any;
    expect(f.author).toEqual({ $in: ["a", "b"] });
    expect(f.primary_color).toBe("red");
    expect(f.created).toEqual({ $gte: 10, $lt: 20 });
    expect(f.color_count).toEqual({ $gte: 2 });
    expect(f.listed).toBe(true);
    expect(f.nsfw).toBe(false);
    expect(f.size_class).toBe("small");
    expect(vectorFilter(req("nsfw=include"))).toBeUndefined();
  });
});

describe("VLM output parsing", () => {
  it("extracts JSON from fenced or chatty replies and normalises fields", () => {
    const raw = 'Sure! ```json\n{"caption":"A swan on a lake.","subjects":["Swan","swan"],"objects":["lake"],"style":"Portrait","mood":"Calm","text_in_image":"","tags":["swan","bird","lake"],"nsfw":0.01}\n```';
    const d = parseDescription(raw)!;
    expect(d.caption).toBe("A swan on a lake.");
    expect(d.subjects).toEqual(["swan"]);
    expect(d.style).toBe("portrait");
    expect(d.nsfw).toBeCloseTo(0.01);
    expect(parseDescription("no json here")).toBeNull();
    expect(parseDescription('{"caption":"x","nsfw":true}')!.nsfw).toBe(1);
    expect(buildPrompt({ title: "Swan", tags: ["bird"] })).toContain('Title: "Swan"');
  });
});

describe("colour", () => {
  it("names colours sensibly and ΔE2000 is zero for identical colours", () => {
    expect(nearestNamed(rgbToLab(255, 0, 0)).name).toBe("red");
    expect(nearestNamed(rgbToLab(0, 0, 0)).name).toBe("black");
    expect(nearestNamed(rgbToLab(255, 255, 255)).name).toBe("white");
    expect(nearestNamed(rgbToLab(30, 60, 200)).name).toBe("blue");
    expect(nearestNamed(rgbToLab(255, 200, 0)).name).toBe("yellow");
    expect(nearestNamed(rgbToLab(120, 70, 30)).name).toBe("brown");
    expect(deltaE2000(rgbToLab(10, 20, 30), rgbToLab(10, 20, 30))).toBe(0);
    expect(deltaE2000(rgbToLab(0, 0, 0), rgbToLab(255, 255, 255))).toBeGreaterThan(90);
  });

  it("clusters shades and buckets them", () => {
    const mk = (hex: string, share: number) => {
      const n = parseInt(hex.slice(1), 16);
      const lab = rgbToLab((n >> 16) & 255, (n >> 8) & 255, n & 255);
      return { hex, share, ...lab };
    };
    const clusters = clusterPalette([mk("#2a5fd1", 0.4), mk("#2f64d6", 0.3), mk("#d62828", 0.3)]);
    expect(clusters.length).toBe(2);
    const b = bucketize(clusters);
    expect(b[0].name).toBe("blue");
    expect(b[0].weight).toBeCloseTo(0.7, 5);
    expect(b[1].name).toBe("red");
  });
});

describe("base64", () => {
  it("round-trips bytes, tolerates whitespace and url-safe alphabets", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 7]);
    const s = base64Encode(bytes);
    expect(s).toBe(Buffer.from(bytes).toString("base64"));
    expect([...base64Decode(s)]).toEqual([...bytes]);
    expect([...base64Decode(s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""))]).toEqual([...bytes]);
    expect([...base64Decode(`${s.slice(0, 4)}\n ${s.slice(4)}`)]).toEqual([...bytes]);
    expect(base64Encode(new Uint8Array([1]))).toBe("AQ==");
    expect(base64Encode(new Uint8Array([1, 2]))).toBe("AQI=");
  });
});
