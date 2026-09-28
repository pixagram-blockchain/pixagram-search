import { describe, expect, it } from "vitest";
import { fixtureJson } from "./helpers";
import { appAllowed, classify, extractImage, normalizeTags, parseJsonMetadata, parsePost } from "../src/chain/parse";
import { chainTime, normalizeOp, parseAsset } from "../src/chain/rpc";
import { stripMarkdown } from "../src/db/posts";

const fx = fixtureJson("posts.json");

describe("parsePost on real Pixagram posts", () => {
  it("classifies an artwork and finds the WebP payload in the body", () => {
    const p = parsePost(fx.artwork_small);
    expect(p.type).toBe("artwork");
    expect(p.image?.mime).toBe("image/webp");
    expect(p.image?.supported).toBe(true);
    expect(p.image?.base64.length).toBeGreaterThan(1000);
    expect(p.body).toBe(""); // artwork bodies are not stored
    expect(p.tags).toContain("anonymous");
    expect(p.author).toBe("matias");
    expect(p.nsfw).toBe(false);
    expect(p.aiTraining).toBe(true);
    expect(p.royaltyPct).toBe(5);
    expect(p.created).toBeGreaterThan(1_700_000_000);
    expect(p.payout).toBeGreaterThanOrEqual(0);
  });

  it("classifies a markdown post as blog and keeps its body", () => {
    const p = parsePost(fx.markdown);
    expect(p.type).toBe("blog");
    expect(p.image).toBeNull();
    expect(p.body.length).toBeGreaterThan(100);
    expect(p.tags).toEqual(expect.arrayContaining(["dpf", "proposal", "governance"]));
    expect(p.category).toBe("dpf");
  });

  it("recognises the 'deleted' body convention", () => {
    const p = parsePost(fx.deleted);
    expect(p.deleted).toBe(true);
    expect(p.image).toBeNull();
    expect(p.type).toBe("artwork"); // format field still says image
  });

  it("accepts json_metadata as an object (bridge API) or string (condenser API)", () => {
    expect(parseJsonMetadata('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonMetadata({ a: 1 })).toEqual({ a: 1 });
    expect(parseJsonMetadata("not json")).toEqual({});
    expect(parseJsonMetadata("[1,2]")).toEqual({});
  });
});

describe("extractImage", () => {
  it("handles a whole-body data URI, an embedded one, and svg as unsupported", () => {
    const b64 = "UklGRoA9AABXRUJQVlA4";
    expect(extractImage(`data:image/webp;base64,${b64}`)).toMatchObject({ mime: "image/webp", base64: b64, supported: true });
    expect(extractImage(`  data:image/png;base64,${b64}\n`)).toMatchObject({ mime: "image/png", supported: true });
    expect(extractImage(`Look: ![x](data:image/webp;base64,${b64}) nice`)).toMatchObject({ mime: "image/webp", base64: b64 });
    expect(extractImage(`data:image/svg+xml;base64,${b64}`)).toMatchObject({ mime: "image/svg+xml", supported: false });
    expect(extractImage("just text")).toBeNull();
    expect(extractImage("")).toBeNull();
  });
});

describe("classify / tags / app", () => {
  it("format wins, body image is the fallback", () => {
    expect(classify({ format: "image" }, null)).toBe("artwork");
    expect(classify({ format: "markdown" }, null)).toBe("blog");
    expect(classify({}, { mime: "image/webp", base64: "x", supported: true })).toBe("artwork");
    expect(classify({}, null)).toBe("blog");
  });

  it("normalises tags", () => {
    expect(normalizeTags(["  Bird", "#bird", "swan ", "", 5, "x".repeat(100)], "bird")).toEqual(["bird", "swan", "x".repeat(64)]);
    expect(normalizeTags("a, b c", null)).toEqual(["a", "b", "c"]);
    expect(normalizeTags(undefined, "cat")).toEqual(["cat"]);
  });

  it("filters by app prefix", () => {
    expect(appAllowed("pixagram/3.0.2", ["pixagram"])).toBe(true);
    expect(appAllowed("peakd/2024", ["pixagram"])).toBe(false);
    expect(appAllowed(null, [])).toBe(true);
    expect(appAllowed(null, ["pixagram"])).toBe(false);
  });
});

describe("rpc helpers", () => {
  it("parses assets and chain time", () => {
    expect(parseAsset("14.469 PXS")).toBeCloseTo(14.469);
    expect(parseAsset(undefined)).toBe(0);
    expect(parseAsset(3)).toBe(3);
    expect(chainTime("2026-09-27T18:03:12")).toBe(Math.floor(Date.parse("2026-09-27T18:03:12Z") / 1000));
  });

  it("normalises both operation encodings", () => {
    expect(normalizeOp({ type: "comment_operation", value: { a: 1 } })).toEqual({ type: "comment", value: { a: 1 } });
    expect(normalizeOp(["comment", { a: 1 }])).toEqual({ type: "comment", value: { a: 1 } });
  });
});

describe("stripMarkdown", () => {
  it("removes links, images, data URIs and markup", () => {
    const s = stripMarkdown("# Title\n\nSome **bold** [link](http://x.y) ![img](data:image/webp;base64,AAAA) `code`\n\n- item");
    expect(s).toBe("Title Some bold link code item");
  });
});
