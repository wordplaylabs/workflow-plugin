// Before each test file, in its worker: no WORKFLOW_* variable from the chat that
// runs the tests (an executor's carries WORKFLOW_EXECUTOR), the run's folder from
// test/global-setup.ts kept for the next file of a reused worker, and that folder as
// TMPDIR, which os.tmpdir() reads at each call and the spawned hooks inherit, with the
// plugin's data folder, the plans command's folder and the transcripts' in it, so no
// test reads the machine's usage.json or sessions, or writes to its home folder. A test
// file's own WORKFLOW_* settings come after this and stay.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.WORKFLOW_TESTS_TMPDIR;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("WORKFLOW_") && key !== "WORKFLOW_TESTS_TMPDIR") delete process.env[key];
}
if (dir) {
  process.env.TMPDIR = dir;
  for (const [key, name] of [
    ["WORKFLOW_DATA", "data"],
    ["WORKFLOW_BIN", "bin"],
    ["WORKFLOW_PROJECTS", "projects"],
  ]) {
    process.env[key] = join(dir, name);
    mkdirSync(process.env[key], { recursive: true });
  }
}
