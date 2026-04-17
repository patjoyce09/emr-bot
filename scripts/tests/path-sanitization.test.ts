import { resolve } from "node:path";
import { createArtifactPaths } from "../../src/core/artifacts.js";
import { normalizePathSegment } from "../../src/core/pathSafety.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

(async () => {
  const normalized = normalizePathSegment("../../Tenant A??/..", "tenant");
  assert(!normalized.includes("/"), "Normalized segment must not include slash");
  assert(!normalized.includes(".."), "Normalized segment must not include traversal sequence");

  const root = resolve("./artifacts-test");
  const paths = await createArtifactPaths(root, "../../Tenant A??/..", "pull_schedule_report", "run:123");

  assert(paths.runRoot.startsWith(root), "Run root must remain inside artifact root");
  assert(!paths.runRoot.includes("../"), "Run root must not include traversal");

  console.log("PASS path-sanitization.test");
})();
