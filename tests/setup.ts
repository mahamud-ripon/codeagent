import { afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Module mocking survives individual tests' restoreAllMocks(). Both named and
// default imports resolve to the same per-test-file disposable home.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const filesystem = await import("node:fs");
  const paths = await import("node:path");
  const home = filesystem.mkdtempSync(paths.join(actual.tmpdir(), "codeagent-test-home-"));
  const homedir = () => home;
  return { ...actual, homedir, default: { ...actual.default, homedir } };
});
const home = os.homedir();
// An inherited runtime override must not point tests at real sessions either.
const originalRuntimeHome = process.env.CODEAGENT_RUNTIME_HOME;
process.env.CODEAGENT_RUNTIME_HOME = path.join(home, ".codeagent", "runtime", "v1");
afterAll(() => {
  if (originalRuntimeHome === undefined) delete process.env.CODEAGENT_RUNTIME_HOME;
  else process.env.CODEAGENT_RUNTIME_HOME = originalRuntimeHome;
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
