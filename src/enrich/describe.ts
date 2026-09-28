// AI description of an artwork via Workers AI. Two backends:
//   moondream  @cf/moondream/moondream3.1-9B-A2B   — small, fast, cheap; built for structured output
//   scout      @cf/meta/llama-4-scout-17b-16e-instruct — richer captions; OpenAI-style messages + json_schema
// Both receive the *upscaled* image as a PNG data URI and return the same JSON shape.

import type { Env } from "../env";

export interface Description {
  caption: string;
  subjects: string[];
  objects: string[];
  style: string;
  mood: string;
  text_in_image: string;
  tags: string[];
  nsfw: number; // 0..1
}

export const MOONDREAM_MODEL = "@cf/moondream/moondream3.1-9B-A2B";
export const SCOUT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["caption", "subjects", "objects", "style", "mood", "text_in_image", "tags", "nsfw"],
  properties: {
    caption: { type: "string", description: "One or two sentences describing what the image shows." },
    subjects: { type: "array", items: { type: "string" }, description: "Main subjects, e.g. 'girl', 'dragon', 'city skyline'." },
    objects: { type: "array", items: { type: "string" }, description: "Notable objects and elements." },
    style: { type: "string", description: "Art style beyond 'pixel art', e.g. 'portrait', 'isometric', 'retro game sprite', 'landscape', 'abstract'." },
    mood: { type: "string", description: "Overall mood in one or two words." },
    text_in_image: { type: "string", description: "Any legible text in the image, else empty string." },
    tags: { type: "array", items: { type: "string" }, description: "5-12 short lowercase search keywords." },
    nsfw: { type: "number", description: "Probability from 0 to 1 that the image is sexual or graphically violent." },
  },
} as const;

export function buildPrompt(ctx: { title?: string; tags?: string[]; description?: string }): string {
  const hints: string[] = [];
  if (ctx.title) hints.push(`Title: "${ctx.title.slice(0, 120)}"`);
  if (ctx.description) hints.push(`Author's description: "${ctx.description.slice(0, 300)}"`);
  if (ctx.tags?.length) hints.push(`Author's tags: ${ctx.tags.slice(0, 10).join(", ")}`);
  return [
    "This is a pixel-art image from a social network for pixel artists, shown upscaled so you can see it clearly.",
    "Do not comment on it being pixel art or low resolution; describe the content: who or what is depicted,",
    "the setting, notable objects, the artistic style (portrait, landscape, isometric, sprite, abstract...), the mood,",
    "and any legible text. Write in English even if the title is in another language.",
    hints.length ? `Context from the author (may help, may be wrong): ${hints.join("; ")}.` : "",
    "Respond with a single JSON object with exactly these keys:",
    '{"caption": string, "subjects": string[], "objects": string[], "style": string, "mood": string, "text_in_image": string, "tags": string[] (5-12 lowercase keywords), "nsfw": number 0..1}',
    "No markdown, no explanation, JSON only.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Pull the first JSON object out of a model reply (handles code fences and chatter). */
export function parseDescription(text: string): Description | null {
  if (!text) return null;
  let s = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  s = s.slice(start, end + 1);
  let obj: any;
  try {
    obj = JSON.parse(s);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const str = (v: unknown, max = 1000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const arr = (v: unknown, max = 24) =>
    Array.isArray(v)
      ? [...new Set(v.filter((x) => typeof x === "string").map((x: string) => x.trim().toLowerCase()).filter(Boolean))].slice(0, max)
      : [];
  const nsfw = typeof obj.nsfw === "number" ? Math.min(1, Math.max(0, obj.nsfw)) : typeof obj.nsfw === "boolean" ? (obj.nsfw ? 1 : 0) : 0;
  return {
    caption: str(obj.caption, 600),
    subjects: arr(obj.subjects),
    objects: arr(obj.objects),
    style: str(obj.style, 80).toLowerCase(),
    mood: str(obj.mood, 60).toLowerCase(),
    text_in_image: str(obj.text_in_image, 300),
    tags: arr(obj.tags, 16),
    nsfw,
  };
}

export type VlmBackend = "moondream" | "scout";

export async function describeImage(env: Env, backend: VlmBackend, pngDataUri: string, ctx: { title?: string; tags?: string[]; description?: string }): Promise<{ model: string; description: Description; raw: string }> {
  const prompt = buildPrompt(ctx);
  const ai = env.AI as unknown as { run: (model: string, input: unknown) => Promise<any> };
  if (backend === "moondream") {
    const r = await ai.run(MOONDREAM_MODEL, {
      task: "query",
      image: pngDataUri,
      question: prompt,
      reasoning: false,
      temperature: 0.2,
      max_tokens: 700,
    });
    const raw: string = typeof r === "string" ? r : r?.answer ?? r?.response ?? JSON.stringify(r);
    const d = parseDescription(raw);
    if (!d) throw new Error(`moondream returned non-JSON: ${raw.slice(0, 200)}`);
    return { model: MOONDREAM_MODEL, description: d, raw };
  }
  const r = await ai.run(SCOUT_MODEL, {
    messages: [
      { role: "system", content: "You describe images precisely and answer only with JSON." },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: pngDataUri } },
        ],
      },
    ],
    response_format: { type: "json_schema", json_schema: SCHEMA },
    max_tokens: 700,
    temperature: 0.2,
  });
  const raw: string = typeof r === "string" ? r : r?.response ?? r?.choices?.[0]?.message?.content ?? JSON.stringify(r);
  const d = parseDescription(raw);
  if (!d) throw new Error(`scout returned non-JSON: ${raw.slice(0, 200)}`);
  return { model: SCOUT_MODEL, description: d, raw };
}
