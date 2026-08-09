import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Plain Node: the services take their dependencies as arguments, so none of
    // this needs workerd or an R2 emulation. Node 18+ supplies Request/Response,
    // CompressionStream and DecompressionStream natively.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
