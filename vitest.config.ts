import { defineConfig } from "vitest/config";

// Unit tests cover the pure modules (colour, hashing, parsing, SQL building, fusion)
// and the WebP/PNG codecs in Node. Bindings (D1, Queues, Vectorize, AI) are exercised
// with `wrangler dev` against local resources — see README.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
  },
});
