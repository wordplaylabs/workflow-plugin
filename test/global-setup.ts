// Once around the whole run: a temporary folder of its own, so two runs at once
// (two executors' worktrees, or the checkout and one) share no file. The workers
// find it by WORKFLOW_TESTS_TMPDIR and make it their TMPDIR (test/setup.ts); absolute,
// so a child started in a fixture's folder finds it too.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export default function setup() {
  const dir = mkdtempSync(join(resolve(tmpdir()), "workflow-tests-"));
  process.env.WORKFLOW_TESTS_TMPDIR = dir;
  return () => rmSync(dir, { recursive: true, force: true });
}
