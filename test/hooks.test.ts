// The design catalogue's hooks (docs/contributing.md):
// the edit-time context and the once-per-turn audit, run as the real scripts
// against a throwaway git repository.
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QUEUE_IGNORES, checkoutOf, executorsOf } from "../plugins/workflow/scripts/project.mjs";
import {
  listToJudge,
  recordTool,
  shellWrites,
  agentsChoice,
  reasonFor,
  treeFiles,
  untiered,
} from "../plugins/workflow/scripts/turn-audit.mjs";
import { costWords, measure, measureFile } from "../plugins/workflow/scripts/cost.mjs";
import {
  allowedWhileLocked,
  ceilingFor,
  ceilingsLine,
  REUSE_CAP,
  reuseInputs,
  transcriptsDir,
  REUSE_REFRESH,
  refreshLater,
  costCommand,
  hookRun,
  sharedTokens,
  lastFreshLines,
  tiredFor,
  usageWords,
  withShare,
  sweepTemp,
  ghCommand,
  appLine,
  webhookLine,
  unreadLines,
  behindOf,
  landsOf,
  landsWords,
  landsUnread,
  listenerOlder,
  secret,
  notesWaiting,
  marksReady,
  agentEffort,
  canStart,
  freeBriefs,
  checksVerdict,
  pullThenRun,
  decidePlannerStop,
  plannerPrompt,
  assistantPrompt,
  takeOverPrompt,
  startPrompt,
  freePlans,
  takerFor,
  githubPrompt,
  PLANNER_PROMPT,
  sessionsOf,
  statusOf,
  versionLine,
  cutoffEdit,
  decideEnd,
  endedEdit,
  goneEdit,
  decideStop,
  inThisRepo,
  lockHeldByOther,
  mayReuse,
  sessionUsage,
  transcriptOf,
  ownRows,
  takeLock,
  parseDay,
  pathsIn,
  openPulls,
  ownOf,
  plannerMayEdit,
  pushedBranches,
  relatedLines,
  relatedOf,
  relatedWork,
  fromOf,
  issueOf,
  firstOf,
  firstUnread,
  readyOf,
  carriesOf,
  carryOf,
  planTaken,
  readPlans,
  noteWritten,
  plannerContext,
  askingIn,
  buildingAdded,
  buildingBy,
  liveId,
  sameSession,
  editedText,
  ANSWER_WINDOW,
  describeSession,
  stopPlannersOn,
  stopRetiredPlanners,
  stopTakenPlanners,
  whoTook,
  resetTime,
  stateOf,
  today,
  unreadPlans,
  TAKEN_LOG,
  writtenAt,
  withoutStatus,
  noAppWords,
  noSecretWords,
  hasIssues,
  failedRunsOf,
  otherServices,
  nextName,
  startedConfirmed,
} from "../plugins/workflow/scripts/plan-queue.mjs";
import { statusFrom } from "../plugins/workflow/scripts/statusline.mjs";
import {
  briefPaths,
  noteSeen,
  seenFile,
  seenIn,
  seenOf,
} from "../plugins/workflow/scripts/seen.mjs";
import {
  appJwt,
  appLacks,
  appStanding,
  repoOfRemote,
} from "../plugins/workflow/scripts/github-app.mjs";
import { withAddresses } from "../plugins/workflow/scripts/github-attach.mjs";
import {
  WEBHOOK_EVENTS,
  closesOf,
  githubEvents,
  itemsOfDelivery,
  keeps,
  listen,
  noteFor,
  verifyDelivery,
} from "../plugins/workflow/scripts/github-webhook.mjs";

const here = new URL("../plugins/workflow/scripts/", import.meta.url).pathname;
const audit = join(here, "turn-audit.mjs");

// The plugin's `owner` option, as Claude Code exports it to a hook.
process.env.CLAUDE_PLUGIN_OPTION_OWNER = "Javi";
process.env.CLAUDE_PLUGIN_OPTION_MACHINE = "lab";
// The end timer and the stops are recorded here, so no hook a test runs
// leaves a timer sleeping for an hour (plans/idle-chats-end.md).
process.env.WORKFLOW_STOP_LOG = join(tmpdir(), `workflow-stops-hooks-${process.pid}.log`);

/** What the session's own Write tool did, as `PostToolUse` reports it. */
function wrote(sessionId: string, path: string) {
  run(audit, ["tool"], {
    session_id: sessionId,
    tool_name: "Write",
    tool_input: { file_path: join(repo, path) },
  });
}

let repo: string;

/**
 * Gives a test repository the `origin/<branch>` an executor's worktree is
 * made from: an empty commit, under the remote's name, once.
 */
/** The temporary folders and files the tests make, removed once they have all run. */
const made: string[] = [];
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});
/** A temporary folder, removed after the tests. */
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
/** git in `cwd`, as a user with a name, its output trimmed. */
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
/** A port the system says is free: listened on as port 0, read, closed. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
/** A session's queue state file. */
const stateFile = (id: string) => join(tmpdir(), `workflow-queue-${id}.json`);
/** A plan's dated header line. */
const headerLine = (day: string) => `Plan only, ${day}, for Javi; the executor builds it.`;
/** A plan's title and header paragraph. */
const header = (day: string) => `# A plan\n\n${headerLine(day)}\n\n`;
/** A project of its own: a repository with a project file naming it, `body` under it, and `plans/`. */
const fixture = (name: string, front = "", body = "") => {
  const dir = temp(`queue-${name.toLowerCase()}-`);
  g(dir, "init", "-q");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  mkdirSync(join(dir, "plans"), { recursive: true });
  writeFileSync(
    join(dir, ".claude", "workflow.md"),
    `---\nname: ${name}\nbranch: test\n${front}---\n${body}`,
  );
  return dir;
};
/**
 * A `claude` in place of the real one, `<dir>/claude`: `agents --json` prints
 * the rows in `rows` (`STUB_ROWS` when set), a `--bg` start adds its session
 * there, `<prefix>-<time>` (`<prefix>-<n>-<time>` when `numbered`), with
 * `status` when given, and says so; with
 * `STUB=untrusted` it fails as an untrusted folder does, and with
 * `STUB=backgrounded` it prints `claude --bg`'s confirmation and adds no row,
 * as a session `claude agents` does not list yet, after `STUB_WARNING` when
 * set and under `STUB_BG_NAME` when set, its id the one `STUB_BG_IDS` (a
 * JSON map) gives the name of the folder it runs in, else 1234abcd. With
 * `STUB_ROW_AFTER=<ms>` a `--bg` start adds its row that many milliseconds
 * later, its id the one `STUB_BG_IDS` gives the folder when set, quietly
 * when the folder is gone by then. With `STUB_SILENT` set a `--bg` start
 * prints no `Started` line, its row added as before, at once or
 * `STUB_ROW_AFTER` later. `calls` logs each call.
 */
const fakeClaude = (
  dir: string,
  {
    prefix = "stub",
    numbered = false,
    status = "",
    calls = "",
    rows = join(dir, "rows.json"),
  } = {},
) => {
  writeFileSync(rows, "[]");
  const script = join(dir, "claude");
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const rows = process.env.STUB_ROWS || ${JSON.stringify(rows)};
${calls ? `fs.appendFileSync(${JSON.stringify(calls)}, args.join(" ").slice(0, 80) + "\\n");` : ""}
if (args[0] === "agents") process.stdout.write(fs.readFileSync(rows, "utf8"));
else if (process.env.STUB === "untrusted") {
  console.error("Workspace not trusted. Run claude in " + process.cwd() + " once and accept the trust prompt, then retry.");
  process.exit(1);
} else if (process.env.STUB === "backgrounded") {
  if (process.env.STUB_WARNING) console.error(process.env.STUB_WARNING);
  const name = process.env.STUB_BG_NAME || args[args.indexOf("--name") + 1];
  const id = JSON.parse(process.env.STUB_BG_IDS || "{}")[require("node:path").basename(process.cwd())];
  console.log("backgrounded · " + (id || "1234abcd") + " · " + name);
} else if (args.includes("--bg")) {
  const name = args[args.indexOf("--name") + 1];
  const cwd = process.cwd();
  const add = () => {
    const all = JSON.parse(fs.readFileSync(rows, "utf8"));
    const id = JSON.parse(process.env.STUB_BG_IDS || "{}")[require("node:path").basename(cwd)];
    all.push({ sessionId: id || "${prefix}-" + ${numbered ? `all.length + "-" + ` : ""}Date.now(), name, kind: "background", ${status ? `status: "${status}", ` : ""}cwd });
    fs.writeFileSync(rows, JSON.stringify(all));
  };
  const after = Number(process.env.STUB_ROW_AFTER || 0);
  if (after)
    setTimeout(() => {
      try {
        add();
      } catch {
        // The test's folder is gone: nothing to list.
      }
    }, after);
  else add();
  if (!process.env.STUB_SILENT) console.log("Started " + name);
}
`,
  );
  chmodSync(script, 0o755);
  return script;
};

function withOrigin(dir: string, branch = "test") {
  try {
    g(dir, "rev-parse", "-q", "--verify", `refs/remotes/origin/${branch}`);
    return;
  } catch {
    // Not there yet.
  }
  g(dir, "commit", "-q", "--allow-empty", "-m", "start");
  g(dir, "update-ref", `refs/remotes/origin/${branch}`, "HEAD");
}

function run(script: string, args: string[], input: object, env: Record<string, string> = {}) {
  return execFileSync("node", [script, ...args], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo, ...env },
  });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "workflow-hooks-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(
    join(repo, ".claude", "workflow.md"),
    `---
name: Test
branch: test
run: image.yml
ui:
  - "apps/*/src/{components,app}/**"
  - "packages/{ui,editor,player}/src/**"
catalogue: docs/patterns
---

# Test
`,
  );
  mkdirSync(join(repo, "docs", "patterns"), { recursive: true });
  mkdirSync(join(repo, "packages", "player", "src", "components"), { recursive: true });
  mkdirSync(join(repo, "apps", "forum", "src", "components"), { recursive: true });
  writeFileSync(
    join(repo, "docs", "patterns", "chat.md"),
    `---
paths:
  - "packages/player/src/components/{ChatBox,Keypad}.tsx"
---

# The chat box and the calculator

- **The calculator opens in the field's place.** (Javi, 11 October) One place to work.
- **Keys are drawn as a grid.** (the agent's choice, 17 September)
- **The chat has a Stop button.** (as ChatGPT does, 1 October)
`,
  );
  writeFileSync(
    join(repo, "docs", "patterns", "buttons.md"),
    `# Buttons

- **Icon buttons carry a tooltip.** (Javi, 3 September)
`,
  );
  writeFileSync(
    join(repo, "docs", "patterns", "destructive.md"),
    `---
signals:
  - "\\bdelete\\b"
  - "<ConfirmButton\\b"
---

# Destructive actions

- **Deleting asks to confirm with the consequence named, through ConfirmButton.** (Javi, 3 September)
- **Undo where it is cheap.** (as Gmail does, 5 September)
`,
  );
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("turn-audit", () => {
  const session = { session_id: "t1" };

  it("lets a turn that changed one file stop, after it changed the catalogue too", () => {
    run(audit, ["prompt"], { ...session, prompt: "Fix the keypad" });
    writeFileSync(join(repo, "packages/player/src/components/Keypad.tsx"), "export {}\n");
    writeFileSync(
      join(repo, "docs/patterns/chat.md"),
      "# The chat box\n\n- **Keys are big.** (Javi, 15 October)\n",
    );
    wrote("t1", "packages/player/src/components/Keypad.tsx");
    wrote("t1", "docs/patterns/chat.md");
    const out = run(audit, ["stop"], {
      ...session,
      stop_hook_active: false,
      last_assistant_message: "Done.",
    });
    expect(JSON.parse(out).reason).toContain("changed 2 files");
    expect(JSON.parse(out).reason).not.toContain("nothing under docs/patterns");
  });

  it("refuses once when a UI file changed and the catalogue did not, then lets the second stop pass", () => {
    run(audit, ["prompt"], { session_id: "t2", prompt: "Make the chat box taller" });
    writeFileSync(join(repo, "packages/player/src/components/ChatBox.tsx"), "export {}\n");
    wrote("t2", "packages/player/src/components/ChatBox.tsx");
    const first = run(audit, ["stop"], {
      session_id: "t2",
      stop_hook_active: false,
      last_assistant_message: "Done.",
    });
    const reason = JSON.parse(first).reason as string;
    expect(reason).toContain("nothing under docs/patterns did");
    expect(reason).not.toContain("changed 1 files");
    expect(run(audit, ["stop"], { session_id: "t2", stop_hook_active: true })).toBe("");
    expect(run(audit, ["stop"], { session_id: "t2", stop_hook_active: false })).toBe("");
  });

  /**
   * **A catalogue is written to when an entry is** (plans/catalogue-hook-and-audit.md):
   * a frontmatter, heading or prose line is no decision; an entry added or
   * changed is.
   */
  it("refuses once a UI change whose catalogue edit touched only frontmatter or prose", () => {
    const file = join(repo, "docs/patterns/buttons.md");
    const before = readFileSync(file, "utf8");
    try {
      run(audit, ["prompt"], { session_id: "e1", prompt: "Widen the composer" });
      writeFileSync(join(repo, "apps/forum/src/components/Wide.tsx"), "export {}\n");
      writeFileSync(
        file,
        `---\npaths:\n  - "apps/**"\n---\n\n${before}\nA note on buttons, no rule.\n`,
      );
      wrote("e1", "apps/forum/src/components/Wide.tsx");
      wrote("e1", "docs/patterns/buttons.md");
      const out = run(audit, ["stop"], {
        session_id: "e1",
        stop_hook_active: false,
        last_assistant_message: "Done.",
      });
      expect(JSON.parse(out).reason).toContain("nothing under docs/patterns did");
    } finally {
      writeFileSync(file, before);
    }
  });

  it("lets a UI change stop whose catalogue edit added an entry or changed one's text", () => {
    const file = join(repo, "docs/patterns/buttons.md");
    const before = readFileSync(file, "utf8");
    try {
      for (const [id, after] of [
        ["e2", `${before}- **Text buttons say what they do.** (Javi, 2 November)\n`],
        ["e3", before.replace("carry a tooltip", "carry a short tooltip")],
      ]) {
        writeFileSync(file, before);
        run(audit, ["prompt"], { session_id: id, prompt: "Label the buttons" });
        writeFileSync(join(repo, `apps/forum/src/components/${id}.tsx`), "export {}\n");
        writeFileSync(file, after);
        wrote(id, `apps/forum/src/components/${id}.tsx`);
        wrote(id, "docs/patterns/buttons.md");
        const out = run(audit, ["stop"], {
          session_id: id,
          stop_hook_active: false,
          last_assistant_message: "Done.",
        });
        expect(out ? JSON.parse(out).reason : "", id).not.toContain("nothing under docs/patterns");
      }
    } finally {
      writeFileSync(file, before);
    }
  });

  it("never takes an edit of the catalogue itself for a change to record, though ui covers it", () => {
    const d = "plugins/docs/decisions.md";
    const reason = reasonFor([d], "Fix a typo in the intro", "Done.", {
      ui: [/^plugins\//],
      catalogue: d,
      texts: { [d]: "# Decisions\n\nThe intro, fixed.\n\n- **A rule.** (Javi, 2 November)\n" },
      entries: { [d]: ["- **A rule.** (Javi, 2 November)"] },
    });
    expect(reason).toBe("");
  });

  it("accepts a decisions: none line in the final message", () => {
    run(audit, ["prompt"], { session_id: "t3", prompt: "Fix a typo" });
    writeFileSync(join(repo, "apps/forum/src/components/Composer.tsx"), "export {}\n");
    wrote("t3", "apps/forum/src/components/Composer.tsx");
    const out = run(audit, ["stop"], {
      session_id: "t3",
      stop_hook_active: false,
      last_assistant_message: "decisions: none (a typo)",
    });
    expect(out).toBe("");
  });

  it("stays quiet for a turn that changed nothing", () => {
    run(audit, ["prompt"], { session_id: "t4", prompt: "Explain the keypad" });
    expect(run(audit, ["stop"], { session_id: "t4", stop_hook_active: false })).toBe("");
  });

  /**
   * **The agent's choice is retired** (plans/log-only-decisions-with-a-reason.md):
   * today's entry at it, bare or reasoned, is asked once to be taken out or
   * tiered by what it followed; one dated an earlier day is the check's, and
   * a person's or a product's passes.
   */
  it("asks once to take out or re-tier an entry at the agent's choice dated today", () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-reasons-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, ".claude"));
    mkdirSync(join(root, "docs", "patterns"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      '---\nname: Reasons\nui:\n  - "src/**"\ncatalogue: docs/patterns\n---\n',
    );
    const day = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long" });
    const file = join(root, "docs", "patterns", "words.md");
    const turn = (id: string, entry: string) => {
      run(
        audit,
        ["prompt"],
        { session_id: id, prompt: "Record the word" },
        { CLAUDE_PROJECT_DIR: root },
      );
      writeFileSync(file, `# Words\n\n${entry}\n`);
      run(
        audit,
        ["tool"],
        { session_id: id, tool_name: "Write", tool_input: { file_path: file } },
        { CLAUDE_PROJECT_DIR: root },
      );
      return run(
        audit,
        ["stop"],
        { session_id: id, stop_hook_active: false, last_assistant_message: "Done." },
        { CLAUDE_PROJECT_DIR: root },
      );
    };
    const id = `reasons-${process.pid}`;
    const first = turn(id, `- **Save, not Submit.** (the agent's choice, ${day})`);
    const refusal = (entry: string) =>
      `docs/patterns/words.md has 1 entry at the agent's choice dated today: "${entry}". The catalogue holds only well-formed opinions, a person's call or a product or source followed; a detail nobody decided is free, changed on sight and not recorded. Take the entry out, or tier it by what it followed (as <product> does, per <source>, observed in <x>).`;
    expect(JSON.parse(first).reason).toContain(
      refusal(`**Save, not Submit.** (the agent's choice, ${day})`),
    );
    expect(
      run(
        audit,
        ["stop"],
        { session_id: id, stop_hook_active: true },
        { CLAUDE_PROJECT_DIR: root },
      ),
    ).toBe("");
    expect(
      JSON.parse(
        turn(`${id}-tag`, `- **Save.** (the agent's choice, ${day}, GitHub and Gmail differ)`),
      ).reason,
    ).toContain(refusal(`**Save.** (the agent's choice, ${day}, GitHub and Gmail differ)`));
    expect(
      JSON.parse(turn(`${id}-after`, `- **Save.** (the agent's choice, ${day}) Gmail differs.`))
        .reason,
    ).toContain(refusal(`**Save.** (the agent's choice, ${day}) Gmail differs.`));
    expect(turn(`${id}-person`, `- **Save, not Submit.** (Javi, ${day})`)).toBe("");
    expect(turn(`${id}-product`, `- **Save, not Submit.** (as GitHub does, ${day})`)).toBe("");
    // Forty days back is never today.
    const earlier = new Date(Date.now() - 40 * 86_400_000).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
    });
    expect(turn(`${id}-old`, `- **Save, not Submit.** (the agent's choice, ${earlier})`)).toBe("");
    rmSync(root, { recursive: true, force: true });
    // Nineteen hook runs, each a node process.
  }, 40_000);
});

describe("agentsChoice", () => {
  const text = `# Words

- **Bare today.** (the agent's choice, 29 October)
- **With a clause.** (the agent's choice, 29 October, nothing found in GitHub or Gmail)
- **With a sentence.** (the agent's choice, 29 October) GitHub and Gmail differ.
- **Bare and older.** (the agent's choice, 2 May)
- **Bare in ISO.** (the agent's choice, 2026-10-29)
- **A person's, bare.** (Javi, 29 October)
- **A product's.** (as GitHub does, 29 October)
- **A source's.** (per GOV.UK, 29 October)
`;

  it("lists every entry at the retired tier, reasoned or not, never a person's or a product's", () => {
    expect(agentsChoice(text)).toEqual([
      "**Bare today.** (the agent's choice, 29 October)",
      "**With a clause.** (the agent's choice, 29 October, nothing found in GitHub or Gmail)",
      "**With a sentence.** (the agent's choice, 29 October) GitHub and Gmail differ.",
      "**Bare and older.** (the agent's choice, 2 May)",
      "**Bare in ISO.** (the agent's choice, 2026-10-29)",
    ]);
  });

  it("with a day, only those dated that day, in either way of writing it", () => {
    expect(agentsChoice(text, "29 October")).toEqual([
      "**Bare today.** (the agent's choice, 29 October)",
      "**With a clause.** (the agent's choice, 29 October, nothing found in GitHub or Gmail)",
      "**With a sentence.** (the agent's choice, 29 October) GitHub and Gmail differ.",
    ]);
    expect(agentsChoice(text, ["2 May", "2026-10-29"])).toEqual([
      "**Bare and older.** (the agent's choice, 2 May)",
      "**Bare in ISO.** (the agent's choice, 2026-10-29)",
    ]);
    const withYears =
      "- **This year.** (the agent's choice, 29 October 2026)\n- **Last year.** (the agent's choice, 29 October 2025, a reason)\n";
    expect(agentsChoice(withYears, ["29 October", "29 October 2026"])).toEqual([
      "**This year.** (the agent's choice, 29 October 2026)",
    ]);
    expect(agentsChoice(withYears, ["29 October 2025"])).toEqual([
      "**Last year.** (the agent's choice, 29 October 2025, a reason)",
    ]);
  });

  it("reads a rule's tier from its own tag, never from the struck-through rule kept under it", () => {
    const history = `- **Save, not Submit.** (Javi, 29 October)
  ~~**Submit.**~~ (the agent's choice, 1 January)
- **Over history.** (the agent's choice, 29 October)
  ~~**Older.**~~ (Javi, 1 January) He said so.
`;
    expect(agentsChoice(history)).toEqual([
      "**Over history.** (the agent's choice, 29 October) ~~**Older.**~~ (Javi, 1 January) He said so.",
    ]);
  });

  it("reads the tier only right after the bold statement or at the rule's end, never a parenthesis inside the statement or mid-body", () => {
    expect(
      agentsChoice("- **Per-step (per row) toggle.** (the agent's choice, 29 October)\n"),
    ).toEqual(["**Per-step (per row) toggle.** (the agent's choice, 29 October)"]);
    // A product's tag inside the statement does not make the tier.
    expect(
      agentsChoice(
        "- **Sorted (as GitHub does, 1 May) by date.** (the agent's choice, 29 October)\n",
      ),
    ).toEqual(["**Sorted (as GitHub does, 1 May) by date.** (the agent's choice, 29 October)"]);
    // Nor does the retired tag inside the statement or the body.
    expect(
      agentsChoice(
        "- **Grid (the agent's choice, 2 May) keys.** (Javi, 29 October)\n- **Rows.** (Javi, 29 October) Once (the agent's choice, 2 May).\n",
      ),
    ).toEqual([]);
    expect(untiered("- **X.** (as GitHub does, 29 October)\n")).toEqual([]);
    // A tag-shaped parenthesis in the body, or in the statement, is no tier.
    expect(
      untiered(
        "- **Rows toggle.** Each row (Javi, 29 October) has one.\n- **Per-step (per row, 2 May) toggle.**\n",
      ),
    ).toEqual([
      "**Rows toggle.** Each row (Javi, 29 October) has one.",
      "**Per-step (per row, 2 May) toggle.**",
    ]);
    // The tag that ends the rule is its tier.
    expect(untiered("- **Rows toggle.** Each row has one switch. (Javi, 21 October)\n")).toEqual(
      [],
    );
    expect(agentsChoice("- **Save.** Saves the draft. (the agent's choice, 29 October)\n")).toEqual(
      ["**Save.** Saves the draft. (the agent's choice, 29 October)"],
    );
    // A closed parenthesis inside a source's name is part of the tier.
    expect(
      untiered("- **Use sentence case.** (per Microsoft Writing Style Guide (2024), 29 October)\n"),
    ).toEqual([]);
  });

  it("reads no rule inside a fenced example, and reads the README's rules", () => {
    const readme =
      "# Decisions\n\nAn entry looks like this:\n\n```md\n- **Example.** (the agent's choice, 29 October)\n- **No tier.**\n```\n\n- **Real.** (the agent's choice, 29 October)\n";
    expect(agentsChoice(readme)).toEqual(["**Real.** (the agent's choice, 29 October)"]);
    expect(untiered(readme)).toEqual([]);
  });
});

/**
 * **A session answers only for its own writes** (docs/contributing.md): the
 * planner and the assistant read beside a building executor in one checkout,
 * and were asked about the executor's files.
 */
describe("turn-audit, whose files they are", () => {
  const fresh = () => ({ files: {}, wrote: [] as string[], shell: false });

  it("remembers the path an Edit wrote, relative to the project", () => {
    const state = recordTool(
      fresh(),
      { tool_name: "Edit", tool_input: { file_path: "/repo/apps/forum/src/a.ts" } },
      "/repo",
    );
    expect(state.wrote).toEqual(["apps/forum/src/a.ts"]);
    expect(state.shell).toBe(false);
  });

  it("takes a reading shell command as writing nothing", () => {
    const state = recordTool(fresh(), {
      tool_name: "Bash",
      tool_input: { command: "cat docs/editor.md | grep -n R3 && git diff --stat" },
    });
    expect(state.shell).toBe(false);
  });

  it("takes sed -i as writing the tree", () => {
    const state = recordTool(fresh(), {
      tool_name: "Bash",
      tool_input: { command: "sed -i 's/a/b/' apps/forum/src/a.ts" },
    });
    expect(state.shell).toBe(true);
  });

  it("judges nothing when its tools wrote nothing, though the tree changed", () => {
    const state = { ...fresh(), files: {} };
    expect(listToJudge(state, { "apps/forum/src/a.ts": [1, 1] })).toEqual([]);
  });

  it("judges only the changed files its editing tools wrote", () => {
    const state = { ...fresh(), wrote: ["a.ts"] };
    expect(listToJudge(state, { "a.ts": [1, 1], "b.ts": [1, 1] })).toEqual(["a.ts"]);
  });

  it("judges the whole tree after a writing shell command", () => {
    const state = { ...fresh(), shell: true };
    expect(listToJudge(state, { "a.ts": [1, 1], "b.ts": [1, 1] })).toEqual(["a.ts", "b.ts"]);
  });

  it("lets a stop pass for a session whose tools wrote nothing beside another's changes", () => {
    run(audit, ["prompt"], { session_id: "t5", prompt: "Plan the next change" });
    writeFileSync(join(repo, "apps/forum/src/components/Feed.tsx"), "export {}\n");
    writeFileSync(join(repo, "apps/forum/src/components/Nav.tsx"), "export {}\n");
    run(audit, ["tool"], {
      session_id: "t5",
      tool_name: "Bash",
      tool_input: { command: "git status --short" },
    });
    expect(run(audit, ["stop"], { session_id: "t5", stop_hook_active: false })).toBe("");
  });

  it("never audits the planner or the assistant", () => {
    for (const [id, agent] of [
      ["t6", "planner"],
      ["t6a", "assistant"],
    ]) {
      run(audit, ["prompt"], { session_id: id, prompt: "Write the plan", agent_type: agent });
      writeFileSync(join(repo, "apps/forum/src/components/Plan.tsx"), "export {}\n");
      wrote(id, "apps/forum/src/components/Plan.tsx");
      run(audit, ["tool"], {
        session_id: id,
        tool_name: "Bash",
        tool_input: { command: "npm run build" },
      });
      expect(run(audit, ["stop"], { session_id: id, stop_hook_active: false })).toBe("");
    }
  });

  it("takes tools run at once each into account", () => {
    run(audit, ["prompt"], { session_id: "t7", prompt: "Two files at once" });
    writeFileSync(join(repo, "apps/forum/src/components/One.tsx"), "export {}\n");
    writeFileSync(join(repo, "apps/forum/src/components/Two.tsx"), "export {}\n");
    wrote("t7", "apps/forum/src/components/One.tsx");
    wrote("t7", "apps/forum/src/components/Two.tsx");
    const out = run(audit, ["stop"], {
      session_id: "t7",
      stop_hook_active: false,
      last_assistant_message: "decisions: none (a test)",
    });
    expect(JSON.parse(out).reason).toContain("changed 2 files");
  });

  it("stays quiet for a tool event and a stop with no prompt before them", () => {
    wrote("t8", "apps/forum/src/components/Stray.tsx");
    expect(run(audit, ["stop"], { session_id: "t8", stop_hook_active: false })).toBe("");
  });
});

describe("plan-queue", () => {
  const plan = (path: string, extra: object = {}) => ({
    path,
    asks: false,
    ...extra,
  });

  describe("stateOf", () => {
    // plans/queue-reads-iso-dates.md: a plan or brief dated 2026-10-24 is listed.
    it("reads an ISO date like a written one", () => {
      const date = parseDay("24 October 2026");
      expect(stateOf(header("2026-10-24"))).toMatchObject({ state: "ready", date });
      expect(stateOf("# B\n\nBrief for the planner, 2026-10-24.\n")).toMatchObject({
        state: "brief",
        date,
      });
      expect(
        stateOf(`${header("2026-10-24")}## Built, 26 October 2026\n\nCommit 1234abcd.\n`),
      ).toMatchObject({ state: "built", date });
      expect(parseDay("2026-13-01")).toBeNaN();
      // Codex, 26 October: a date that does not parse is not ready.
      expect(stateOf(header("2026-13-01"))).toMatchObject({ state: "old" });
      expect(parseDay("2026-10-26x")).toBeNaN();
    });

    it("reads a brief, a ready plan and one that asks", () => {
      expect(stateOf("# B\n\nBrief for the planner, 24 October 2026.\n")).toMatchObject({
        state: "brief",
        stale: false,
        day: "24 October 2026",
      });
      expect(stateOf(header("24 October 2026"))).toMatchObject({ state: "ready", asks: false });
      const asking = `${header("24 October 2026")}## Decisions for Javi\n\n1. **The shape.** One or two.\n`;
      expect(stateOf(asking)).toMatchObject({ state: "ready", asks: true });
      expect(stateOf(`${asking}\n## Decided, 24 October 2026\n\n- One.\n`)).toMatchObject({
        asks: false,
      });
      expect(stateOf(`${header("24 October 2026")}## Decisions for Javi\n\nNone.\n`)).toMatchObject(
        { asks: false },
      );
    });

    it("reads a Building line as building only while its session lives", () => {
      const text = `${header("24 October 2026")}## Building, 24 October 2026, session abc\n`;
      expect(stateOf(text, { live: ["abc"] })).toMatchObject({ state: "building", session: "abc" });
      expect(stateOf(text, { live: null })).toMatchObject({ state: "building" });
      expect(stateOf(text, { live: ["xyz"] })).toMatchObject({ state: "ready", stale: true });
    });

    // plans/short-session-id-is-live.md: a line may name its session by a
    // unique start of eight characters or more, as git reads a short hash.
    const full = "abcd1234-0000-4000-8000-000000000001";
    const twin = "abcd1234-ffff-4000-8000-000000000002";
    const shortLine = (id: string) =>
      `${header("25 November 2026")}## Building, 25 November 2026, session ${id}\n`;

    it("a Building line naming a live session by its first eight characters is live", () => {
      expect(stateOf(shortLine("abcd1234"), { live: ["other", full] })).toMatchObject({
        state: "building",
        session: full,
      });
      expect(stateOf(shortLine("abcd1234-0000"), { live: [full] })).toMatchObject({
        state: "building",
        session: full,
      });
      expect(liveId("abcd1234", [full])).toBe(full);
    });

    it("a short id two live sessions begin with is nobody's", () => {
      expect(stateOf(shortLine("abcd1234"), { live: [full, twin] })).toMatchObject({
        state: "ready",
        stale: true,
      });
      expect(liveId("abcd1234", [full, twin])).toBe("");
      // The whole id stays its own, whatever else begins like it.
      expect(liveId(full, [full, twin])).toBe(full);
    });

    it("an id under eight characters is never matched", () => {
      expect(stateOf(shortLine("abcd123"), { live: [full] })).toMatchObject({
        state: "ready",
        stale: true,
      });
      expect(liveId("abcd123", [full])).toBe("");
    });

    it("a Planning line naming a live session by a short id is live", () => {
      const brief =
        "# B\n\n## Planning, 25 November 2026, session abcd1234\n\nBrief for the planner, 25 November 2026.\n";
      expect(stateOf(brief, { live: [full] })).toMatchObject({ state: "planning", session: full });
      expect(stateOf(brief, { live: [full, twin] })).toMatchObject({ state: "brief", stale: true });
    });

    it("with the sessions unread, a short id reads as live", () => {
      expect(stateOf(shortLine("abcd1234"), { live: null })).toMatchObject({
        state: "building",
        session: "abcd1234",
      });
      // And is its session's, where the callers compare it with a whole id.
      expect(sameSession("abcd1234", full)).toBe(true);
      expect(sameSession(full, full)).toBe(true);
      expect(sameSession("abcd123", full)).toBe(false);
      expect(sameSession("abcd1234", twin.slice(0, 7))).toBe(false);
    });

    it("a session's own short Building line is its own", () => {
      for (const written of ["abcd1234", "abcd1234-00", full])
        expect(buildingBy(full).test(shortLine(written))).toBe(true);
      for (const written of ["abcd123", "abcd1234-ffff", `${full}9`, "abcd1234x"])
        expect(buildingBy(full).test(shortLine(written))).toBe(false);
      // A session whose id is under eight characters is matched whole only.
      expect(buildingBy("abc").test(shortLine("abc"))).toBe(true);
      expect(buildingBy("abc").test(shortLine("ab"))).toBe(false);
    });

    // plans/dropped-plan-state.md: a plan or a brief dropped on Javi's word.
    it("reads a Dropped section as dropped, before Built, and not in a fenced example", () => {
      const dropped =
        "\n## Dropped, 30 October 2026\n\nDropped on Javi's word: #31 already decides\nit.\n";
      expect(stateOf(`${header("30 October 2026")}${dropped}`)).toMatchObject({
        state: "dropped",
        kind: "Plan only",
        droppedDay: "30 October 2026",
        why: "#31 already decides it",
      });
      expect(stateOf(`# B\n\nBrief for the planner, 30 October 2026.\n${dropped}`)).toMatchObject({
        state: "dropped",
        kind: "Brief",
        why: "#31 already decides it",
      });
      // Nobody writes both; the drop is the last word.
      expect(
        stateOf(
          `${header("30 October 2026")}${dropped}\n## Built, 30 October 2026\n\nCommit 1234abcd.\n`,
        ),
      ).toMatchObject({ state: "dropped" });
      // A plan that shows the section in a fenced example, or a heading that only starts with the word, is not.
      expect(
        stateOf(
          `${header("30 October 2026")}## The section\n\n\`\`\`\n## Dropped, 30 October 2026\n\`\`\`\n`,
        ),
      ).toMatchObject({ state: "ready" });
      // A tilde fence, and a four-backtick one holding three (Codex, 30 October).
      for (const fence of [
        "~~~markdown\n## Dropped, 30 October 2026\n~~~\n",
        "````\n```\n## Dropped, 30 October 2026\n```\n````\n",
      ])
        expect(
          stateOf(`${header("30 October 2026")}## The section\n\n${fence}`),
          fence,
        ).toMatchObject({ state: "ready" });
      expect(stateOf(`${header("30 October 2026")}## Dropped ideas\n\nNone.\n`)).toMatchObject({
        state: "ready",
      });
    });

    it("reads Built with its commit, an old plan, and nothing for a note", () => {
      const built = `${header("24 October 2026")}## Built, 24 October 2026\n\nOn branch x, commit 61c4a812.\n`;
      expect(stateOf(built)).toMatchObject({
        state: "built",
        sha: "61c4a812",
        builtDay: "24 October 2026",
      });
      const named = `${header("24 October 2026")}## Built, 24 October 2026\n\nExecutor [8411646d], commit 0d3505f8.\n`;
      expect(stateOf(named)).toMatchObject({ sha: "0d3505f8" });
      // plans/executor-over-ceiling-hands-on.md, part 4: the commit line, in
      // any case and at seven digits, before a session id later in the section.
      const at = (opening: string, rest = "") =>
        stateOf(`${header("5 November 2026")}## Built, 5 November 2026\n\n${opening}\n${rest}`);
      expect(
        at(
          "Commit 63708ca on branch `x`, pushed to `master` at 15:42.",
          "\n- Both earlier plans' `## Building … session 632d8f1c` lines removed.\n",
        ),
      ).toMatchObject({ sha: "63708ca" });
      expect(at("commit 63708ca8fa6ead31ac3fbabf76d62fc20e1d6418")).toMatchObject({
        sha: "63708ca8",
      });
      expect(at("Pushed to `master` as 744af17 from branch `x`.")).toMatchObject({
        sha: "744af17",
      });
      expect(at("by Docs Executor 3 (session 0858c8cd) as `15829f0`")).toMatchObject({
        sha: "15829f0",
      });
      // Codex, C1: a whole UUID, or one in backticks, is a session id too.
      expect(
        at("Executor (session 0858c8cd-1234-4567-89ab-0123456789ab) pushed as 15829f0."),
      ).toMatchObject({ sha: "15829f0" });
      expect(at("Executor (session `0858c8cd`), run 19123456789, as 15829f0.")).toMatchObject({
        sha: "15829f0",
      });
      expect(at("Executor [0858c8cd-1234-4567-89ab-0123456789ab] as 15829f0.")).toMatchObject({
        sha: "15829f0",
      });
      // /code-review: a bare UUID, a run written "Run:" or as a link, upper
      // case, and the opening's commit before a later merge's.
      expect(at("Executor 3 (0858c8cd-1234-4567-89ab-0123456789ab) pushed 744af17.")).toMatchObject(
        { sha: "744af17" },
      );
      expect(at("Run: 19123456789, pushed as 744af17.")).toMatchObject({ sha: "744af17" });
      expect(
        at("https://github.com/o/r/actions/runs/19123456789 green, pushed as 744af17."),
      ).toMatchObject({ sha: "744af17" });
      expect(at("Commit ABCDEF1 pushed.")).toMatchObject({ sha: "abcdef1" });
      expect(
        at(
          "Pull request #12 (https://github.com/o/r/pull/12) to test from branch x, commit 1234abcd; draft.",
          "\nMerged test 5 November, commit abcdef12: none.\n",
        ),
      ).toMatchObject({ sha: "1234abcd" });
      expect(stateOf(header("20 October 2026"))).toMatchObject({ state: "old" });
      expect(stateOf("# Notes\n\nSome notes.\n")).toBeNull();
    });

    it("reads a handed-over plan, and calls it stuck at six or twice at one step", () => {
      const handed = `${header("24 October 2026")}## Handing over, 24 October 2026\n\nStep in hand: 4\n\nOn branch \`queue-work\`.\n`;
      expect(stateOf(handed)).toMatchObject({
        state: "handed",
        step: "4",
        branch: "queue-work",
        stuck: false,
      });
      const resumed = (steps: string[]) =>
        steps.map((n, i) => `## Resumed, 24 October 2026, session s${i}, at step ${n}\n`).join("");
      expect(stateOf(handed + resumed(["1", "2", "3", "4", "5", "6"]))).toMatchObject({
        stuck: true,
      });
      expect(stateOf(handed + resumed(["1", "2", "3", "4", "5"]))).toMatchObject({ stuck: false });
      expect(stateOf(handed + resumed(["3", "3"]))).toMatchObject({ stuck: true });
      expect(stateOf(handed + resumed(["3", "4"]))).toMatchObject({ stuck: false });
    });

    // plans/handed-plan-stays-in-queue.md: a hand-over written between the
    // title and the header pushed the header past line 12, and the plan fell
    // out of every list.
    const handOver = [
      "## Handing over, 27 October 2026",
      "",
      "Step in hand: 1",
      "",
      "On branch `grip-work`, one work commit.",
      "Done: nothing yet.",
      "In progress: step 1, the store.",
      "What failed: the usage window ran out.",
      "Left: steps 2 to 5.",
      "Specs run: none.",
      "",
      "The task list was in the final message.",
      "Nothing pushed.",
      "",
    ].join("\n");
    const short =
      "Short plan, 27 October 2026, by the assistant with Javi; the executor builds\nit.\n\n## What was asked\n\nA thing.\n";

    it("reads a plan whose long Handing over section sits above its header as handed", () => {
      const text = `# A plan\n\n${handOver}${short}`;
      // The header is past the twelve lines the queue read before.
      expect(text.split("\n").findIndex((line) => line.startsWith("Short plan"))).toBe(15);
      expect(stateOf(text)).toMatchObject({
        state: "handed",
        kind: "Short plan",
        day: "27 October 2026",
        step: "1",
        branch: "grip-work",
      });
    });

    it("reads Building and Resumed lines above the header as building while live, handed once not", () => {
      const resumedHeading = handOver.replace(
        "## Handing over, 27 October 2026",
        "## Resumed, 28 October 2026, session r1, at step 1",
      );
      const text = `# A plan\n\n## Building, 28 October 2026, session abc\n\n${handOver}${resumedHeading}${short}`;
      expect(stateOf(text, { live: ["abc"] })).toMatchObject({
        state: "building",
        session: "abc",
        resumed: ["1"],
      });
      expect(stateOf(text, { live: [] })).toMatchObject({
        state: "handed",
        stale: true,
        step: "1",
      });
    });

    it("reads a brief with a Planning line still as a brief, and keeps a plan's Building it", () => {
      const brief =
        "# B\n\n## Planning, 28 October 2026, session p1\n\nBrief for the planner, 28 October 2026.\n";
      expect(stateOf(brief, { live: ["p1"] })).toMatchObject({ state: "planning", session: "p1" });
      expect(stateOf(brief, { live: [] })).toMatchObject({ state: "brief", stale: true });
      // "## Building it" is the plan's own section, not the queue's line.
      expect(withoutStatus(`${header("24 October 2026")}## Building it\n\n1. A step.\n`)).toContain(
        "1. A step.",
      );
    });

    // plans/plans-as-github-issues.md, part 3: a plan with an issue waits for Ready.
    it("reads a plan with an Issue line and no Ready as planned, and with one as ready", () => {
      const planned = `${header("3 November 2026")}Lands: topic t.\nIssue: #12.\n\n## What was asked\n`;
      expect(stateOf(planned)).toMatchObject({ state: "planned", issue: 12 });
      expect(issueOf(planned)).toBe(12);
      const ready = `${planned}\n## Ready, 4 November 2026\n\nReady on GitHub, 4 November.\nKeep the order on the phone (Henry, 4 November, comment on #12)\n`;
      expect(stateOf(ready)).toMatchObject({ state: "ready", issue: 12 });
      expect(readyOf(ready)).toEqual({
        readyDay: "4 November 2026",
        by: "github",
        lines: ["Keep the order on the phone (Henry, 4 November, comment on #12)"],
      });
      expect(
        readyOf(`${planned}\n## Ready, 4 November 2026\n\nReady on Javi's word, 4 November.\n`),
      ).toMatchObject({ by: "owner", lines: [] });
      // A brief carries its issue to the plan.
      expect(
        stateOf("# B\n\nBrief for the planner, 3 November 2026.\n\nIssue: #12.\n"),
      ).toMatchObject({ state: "brief", issue: 12 });
      // In a fenced example it is no line, and a Ready in a fence no section.
      const fenced = `${header("3 November 2026")}\`\`\`\nIssue: #12.\n\`\`\`\n\n## What was asked\n`;
      expect(issueOf(fenced)).toBe(0);
      expect(stateOf(fenced)).toMatchObject({ state: "ready", issue: 0 });
      expect(stateOf(`${planned}\n\`\`\`\n## Ready, 4 November 2026\n\`\`\`\n`)).toMatchObject({
        state: "planned",
      });
      // Built, building and dropped are read before planned.
      expect(stateOf(`${planned}\n## Built, 5 November 2026\n\nCommit 1234abcd.\n`)).toMatchObject({
        state: "built",
      });
    });
  });

  it("finds the paths a plan names, once each, and not inside an address", () => {
    const text =
      "Change `apps/forum/src/x.ts` and packages/editor/src/y.tsx, read docs/editor.md. " +
      "Again `docs/editor.md`; see https://example.org/docs/a.md.";
    expect(pathsIn(text)).toEqual([
      "apps/forum/src/x.ts",
      "packages/editor/src/y.tsx",
      "docs/editor.md",
    ]);
  });

  describe("checksVerdict", () => {
    const run = (status: string, conclusion = "") => ({
      __typename: "CheckRun",
      status,
      conclusion,
    });
    const context = (state: string) => ({ __typename: "StatusContext", state });
    it("is green for no checks and for passing ones", () => {
      expect(checksVerdict([])).toBe("green");
      expect(checksVerdict(null as never)).toBe("green");
      expect(
        checksVerdict([
          run("COMPLETED", "SUCCESS"),
          run("COMPLETED", "NEUTRAL"),
          run("COMPLETED", "SKIPPED"),
          context("SUCCESS"),
        ]),
      ).toBe("green");
    });
    it("is running for a queued or running check and a pending context", () => {
      expect(checksVerdict([run("QUEUED")])).toBe("running");
      expect(checksVerdict([run("COMPLETED", "SUCCESS"), run("IN_PROGRESS")])).toBe("running");
      expect(checksVerdict([context("PENDING")])).toBe("running");
      expect(checksVerdict([context("EXPECTED")])).toBe("running");
    });
    it("is red for a failed check or context, and red beats running", () => {
      for (const conclusion of ["FAILURE", "TIMED_OUT", "STARTUP_FAILURE"])
        expect(checksVerdict([run("COMPLETED", conclusion)]), conclusion).toBe("red");
      expect(checksVerdict([context("ERROR")])).toBe("red");
      expect(checksVerdict([context("FAILURE")])).toBe("red");
      expect(checksVerdict([run("IN_PROGRESS"), run("COMPLETED", "FAILURE")])).toBe("red");
      expect(checksVerdict([context("PENDING"), context("ERROR")])).toBe("red");
    });
    // plans/failed-runs-the-webhook-misses.md, part 3: one meaning of failed, the webhook's.
    it("is green for a cancelled, waiting or stale check: nobody's to fix", () => {
      for (const conclusion of ["CANCELLED", "ACTION_REQUIRED", "STALE"])
        expect(checksVerdict([run("COMPLETED", conclusion)]), conclusion).toBe("green");
    });
  });

  // plans/failed-runs-the-webhook-misses.md, part 4: what no Actions event carries.
  describe("otherServices", () => {
    it("keeps a status context and a check run that is no Actions run, and drops an Actions job", () => {
      const status = { __typename: "StatusContext", state: "FAILURE", context: "ci/external" };
      const app = {
        __typename: "CheckRun",
        status: "COMPLETED",
        conclusion: "FAILURE",
        detailsUrl: "https://app.example.com/checks/12",
      };
      const actions = {
        __typename: "CheckRun",
        status: "COMPLETED",
        conclusion: "FAILURE",
        detailsUrl: "https://github.com/o/r/actions/runs/5/job/6",
      };
      expect(otherServices([status, app, actions])).toEqual([status, app]);
      expect(otherServices(null as never)).toEqual([]);
      expect(checksVerdict(otherServices([actions]))).toBe("green");
    });
  });

  describe("decideStop", () => {
    const failed = { id: 7, status: "completed", conclusion: "failure", onHead: true };

    it("refuses on a red or unfinished run of this push, and ignores another sha", () => {
      expect(decideStop({ run: failed })).toMatchObject({ refuse: true });
      expect(decideStop({ run: failed })!.reason).toContain("(7) is failed");
      // A later turn's first stop refuses again: nothing remembers the run.
      expect(decideStop({ run: failed })).toMatchObject({ refuse: true });
      expect(
        decideStop({ run: { ...failed, status: "in_progress", conclusion: null } })!.reason,
      ).toContain("in progress");
      expect(decideStop({ run: { ...failed, onHead: false } })).toBeNull();
      expect(decideStop({ run: { ...failed, conclusion: "success" } })).toBeNull();
    });

    // plans/executor-never-watches-ci.md, part 4: failed checks only, never running ones.
    it("refuses on a pull request's failed checks with its own words, and lets a continued stop pass", () => {
      const pull = {
        id: "21@61c4a812",
        status: "completed",
        conclusion: "failure",
        onHead: true,
        pull: { number: 21, url: "https://github.com/o/r/pull/21" },
      };
      const first = decideStop({ run: pull });
      expect(first).toMatchObject({ refuse: true, runId: "21@61c4a812" });
      expect(first!.reason).toBe(
        "The checks on pull request #21 (https://github.com/o/r/pull/21) have failed, and no webhook brings that to the assistant here. Read the failed job's log (`gh run view <run id> --log-failed`, the id from `gh pr checks 21 --json link`), fix it and push the branch; the new checks are not waited on.",
      );
      // With a webhook listening, another service's check, in its own words
      // (plans/failed-runs-the-webhook-misses.md, part 4).
      expect(decideStop({ run: { ...pull, pull: { ...pull.pull, other: true } } })!.reason).toBe(
        "A check by another service on pull request #21 (https://github.com/o/r/pull/21) has failed, and the webhook brings only Actions runs to the assistant. Read it (`gh pr checks 21 --json name,state,link`), fix it and push the branch; the new checks are not waited on.",
      );
      // Checks still running are not waited on.
      expect(decideStop({ run: { ...pull, status: "in_progress", conclusion: null } })).toBeNull();
      expect(decideStop({ run: pull, continuing: true, refusedRun: "21@61c4a812" })).toBeNull();
      // Two pull requests not green: both named, and both in the id.
      const two = { ...pull, id: "21@61c4a812,22@0badc0de", pull: { ...pull.pull, also: [22] } };
      expect(decideStop({ run: two })!.reason).toContain(
        " Pull request #22 has failed checks too.",
      );
      const three = { ...two, pull: { ...pull.pull, also: [22, 23] } };
      expect(decideStop({ run: three })!.reason).toContain(
        " Pull requests #22 and #23 have failed checks too.",
      );
      // A project's run on a fix pushed straight rides along, in progress or failed, as before.
      const riding = pullThenRun(pull, {
        id: 9,
        status: "in_progress",
        conclusion: null,
        onHead: true,
        workflow: "Checks",
      });
      expect(decideStop({ run: riding })!.reason).toContain(
        "The Checks run on your push (9) is in progress too: `gh run watch 9 --exit-status`.",
      );
      expect(decideStop({ run: two, continuing: true, refusedRun: "21@61c4a812" })).toMatchObject({
        refuse: true,
      });
      // A push to the branch is a new commit, so a new id, asked about again.
      expect(
        decideStop({
          run: { ...pull, id: "21@0badc0de" },
          continuing: true,
          refusedRun: "21@61c4a812",
        }),
      ).toMatchObject({ refuse: true, runId: "21@0badc0de" });
    });

    // plans/simpler-agents.md, part 3: the state and the facts, no landing steps.
    it("names the waiting plan and no landing steps to an executor taking more", () => {
      const waiting = [plan("plans/a.md")];
      expect(decideStop({ waiting })!.reason).toBe(
        "A plan is waiting and this session can take it: plans/a.md (no context known). Build it next.",
      );
    });

    it("lets a continued stop pass the run it was refused for, and no other", () => {
      expect(decideStop({ run: failed })).toMatchObject({ refuse: true, runId: 7 });
      expect(decideStop({ run: failed, continuing: true, refusedRun: 7 })).toBeNull();
      // A new push in the continued turn: its run is asked about.
      expect(
        decideStop({ run: { ...failed, id: 8 }, continuing: true, refusedRun: 7 }),
      ).toMatchObject({ refuse: true, runId: 8 });
      const waiting = [plan("plans/a.md")];
      expect(decideStop({ run: failed, continuing: true, refusedRun: 7, waiting })).toMatchObject({
        refuse: true,
        told: ["plans/a.md"],
      });
    });

    it("names waiting plans to a fresh session, oldest first, and not twice", () => {
      const waiting = [plan("plans/a.md"), plan("plans/b.md", { asks: true })];
      const out = decideStop({ waiting });
      expect(out).toMatchObject({ refuse: true, told: ["plans/a.md", "plans/b.md"] });
      expect(out!.reason).toContain(
        'plans/a.md, plans/b.md (decisions unanswered: the recommended options, "Asked once")',
      );
      // Told and still waiting: not named twice, the session is retired on them
      // (plans/executor-takes-next-ready-plan.md, part 1).
      expect(decideStop({ waiting, told: ["plans/a.md", "plans/b.md"] })).toEqual({
        retire: true,
        declined: true,
        paths: ["plans/a.md", "plans/b.md"],
        why: "the plans named at the last stop are still waiting, untaken",
      });
      expect(decideStop({ waiting: [plan("plans/a.md")], told: ["plans/a.md"] })!.why).toBe(
        "the plan named at the last stop is still waiting, untaken",
      );
      expect(decideStop({})).toBeNull();
    });

    // plans/executor-takes-next-ready-plan.md: Executor 54 in a project was
    // named nine plans at 90k, built one, and stopped at 127k with eight
    // still ready; the hook passed, and they sat two hours.
    it("retires a session that stops with the plans it was named untaken, whatever its context", () => {
      const now = Date.now();
      const eight = ["topic-rename", "b", "c", "d", "e", "f", "g", "h"].map((x, i) =>
        plan(`plans/${x}.md`, i ? {} : { lands: { name: "topic-rename" } }),
      );
      const told = ["plans/ai-client-on-sdk.md", ...eight.map((one) => one.path)];
      const out = decideStop({
        waiting: eight,
        told,
        usage: { context: 127_000, at: now },
        fallback: 200_000,
        inputs: {},
        now,
      });
      expect(out).toMatchObject({
        retire: true,
        paths: eight.map((one) => one.path),
        why: "the plans named at the last stop are still waiting, untaken",
      });
    });

    // plans/parallel-executors.md, part 2: the stop names one plan, the first free.
    it(
      "hands Executor 54's first plan to a fresh executor at its stop, end to end",
      { timeout: 30_000 },
      () => {
        const dir = mkdtempSync(join(tmpdir(), "queue-declined-"));
        const id = "e5400000-0000-0000-0000-000000000000";
        try {
          execFileSync("git", ["init", "-q"], { cwd: dir });
          withOrigin(dir);
          mkdirSync(join(dir, ".claude"));
          mkdirSync(join(dir, "plans"));
          writeFileSync(
            join(dir, ".claude", "workflow.md"),
            "---\nname: Words\nbranch: test\n---\n",
          );
          const names = ["topic-rename", "b", "c", "d", "e", "f", "g", "h"];
          // Oldest first, by the files' times, the topic's plan the first.
          names.forEach((name, i) => {
            const file = join(dir, "plans", `${name}.md`);
            writeFileSync(
              file,
              `# ${name}\n\nPlan only, 6 November 2026, for Javi.\n${i ? "" : "\nLands: topic topic-rename.\n"}`,
            );
            const at = new Date(Date.now() - (10 - i) * 60_000);
            utimesSync(file, at, at);
          });
          const paths = names.map((name) => `plans/${name}.md`);
          writeFileSync(
            stateFile(id),
            JSON.stringify({ agent: "executor", told: ["plans/ai-client-on-sdk.md", ...paths] }),
          );
          const transcript = join(dir, "54.jsonl");
          writeFileSync(
            transcript,
            `${JSON.stringify({
              type: "assistant",
              timestamp: new Date().toISOString(),
              message: { usage: { input_tokens: 10, cache_read_input_tokens: 126_990 } },
            })}\n`,
          );
          const starts = join(dir, ".claude", "starts.log");
          const { WORKFLOW_LIVE: _, ...rest } = process.env;
          const said = execFileSync("node", [join(here, "plan-queue.mjs"), "stop"], {
            input: JSON.stringify({
              session_id: id,
              agent_type: "executor",
              transcript_path: transcript,
            }),
            encoding: "utf8",
            env: {
              ...rest,
              CLAUDE_PROJECT_DIR: dir,
              WORKFLOW_CLAUDE: "/bin/true",
              WORKFLOW_STARTS_LOG: starts,
              WORKFLOW_USAGE_FILE: join(dir, ".claude", "usage.json"),
            },
          });
          const context = JSON.parse(said).hookSpecificOutput.additionalContext;
          // The checkout's sync speaks between the two, as at any retirement.
          expect(context).toMatch(
            /^Retired: the plan named at the last stop is still waiting, untaken\. /,
          );
          expect(context).toContain(
            `Words Executor 1 (lab) was started on: ${paths[0]}, in executor-1.`,
          );
          const line = JSON.parse(readFileSync(starts, "utf8").trim());
          expect(line).toMatchObject({ name: "Words Executor 1 (lab)", paths: [paths[0]] });
          expect(line.why).toContain(
            "was retired: the plan named at the last stop is still waiting, untaken.",
          );
          expect(JSON.parse(readFileSync(stateFile(id), "utf8")).retired).toBe(true);
        } finally {
          rmSync(stateFile(id), { force: true });
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    it("passes a retired session", () => {
      expect(decideStop({ retired: true, waiting: [plan("plans/a.md")], run: failed })).toBeNull();
    });

    // plans/executor-over-ceiling-hands-on.md, part 1: a session named plans
    // at 187k and stopping at 202k is retired on them.
    it("retires a session over the ceiling on the plans it was told", () => {
      const now = Date.now();
      const at = (minutes: number, k: number) => ({
        context: k * 1000,
        at: now - minutes * 60_000,
      });
      const both = [plan("plans/a.md"), plan("plans/b.md")];
      const told = ["plans/a.md", "plans/b.md"];
      const fresh = decideStop({ waiting: [plan("plans/a.md")], usage: at(0, 300), now });
      expect(fresh).toMatchObject({ retire: true, paths: ["plans/a.md"] });
      expect(fresh!.why).toContain("over the ceiling of 200k (no history yet: today's numbers)");
      // Under the ceiling, told and still waiting: retired as declined.
      expect(decideStop({ waiting: both, told, usage: at(0, 187), now })).toMatchObject({
        retire: true,
        declined: true,
        paths: ["plans/a.md", "plans/b.md"],
      });
      const over = decideStop({ waiting: both, told, usage: at(0, 202), now });
      expect(over).toMatchObject({ retire: true, paths: ["plans/a.md", "plans/b.md"] });
      expect(over!.why).toContain("over the ceiling of 200k");
      const one = decideStop({
        waiting: both,
        told: ["plans/a.md"],
        usage: at(0, 150),
        now,
      });
      // a told and still waiting: b is not named, both go to a fresh executor.
      expect(one).toMatchObject({
        retire: true,
        paths: ["plans/a.md", "plans/b.md"],
        why: "the plan named at the last stop is still waiting, untaken",
      });
    });

    it("starts a handed plan whatever the count, and hands a stuck one to the assistant instead", () => {
      const handed = { path: "plans/h.md", stuck: false, resumed: [] };
      expect(decideStop({ handed: [handed], waiting: [plan("plans/a.md")] })).toEqual({
        handover: handed,
      });
      const stuck = { path: "plans/h.md", stuck: true, resumed: ["3", "3"] };
      const twice = decideStop({ handed: [stuck] })!.context!;
      expect(twice).toContain("handed over twice at step 3");
      const six = { ...stuck, resumed: ["1", "2", "3", "4", "5", "6"] };
      const often = decideStop({ handed: [six] })!.context!;
      expect(often).toContain("handed over 6 times");
      // plans/executor-never-waits.md: no executor asks the owner.
      for (const context of [twice, often]) {
        expect(context).not.toContain("question tool");
        expect(context).toContain("hand it to the assistant");
      }
    });

    it("neither hands more nor retires a session with a plan of its own still being built", () => {
      const current = { path: "plans/mine.md" };
      expect(decideStop({ current, waiting: [plan("plans/a.md")] })).toBeNull();
      expect(decideStop({ current, run: failed })).toMatchObject({ refuse: true });
    });

    it("while paused, refuses only on the run", () => {
      expect(decideStop({ paused: true, waiting: [plan("plans/a.md")] })).toBeNull();
      expect(decideStop({ paused: true, run: failed })).toMatchObject({ refuse: true });
      expect(
        decideStop({ paused: true, handed: [{ path: "plans/h.md", stuck: false, resumed: [] }] }),
      ).toBeNull();
    });
  });

  // plans/project-follow-ups-reach-the-project.md, part 4.
  describe("a brief for the project a plan came from", () => {
    const head = "# T\n\nPlan only, 31 October 2026, for Javi.\n";
    it("reads the From line, wrapped or not, past a status section and outside a fence", () => {
      const of = (line: string) => fromOf(`${head}${line}\n\n## What was asked\n`);
      expect(of("From: Docs, /workspaces/docs.")).toEqual({
        project: "Docs",
        path: "/workspaces/docs",
      });
      expect(of("From: Docs, /workspaces/docs")).toEqual({
        project: "Docs",
        path: "/workspaces/docs",
      });
      expect(of("From: Docs,\n/workspaces/docs.")).toEqual({
        project: "Docs",
        path: "/workspaces/docs",
      });
      expect(of("From: My-Docs, /home/u/a.b.")).toEqual({
        project: "My-Docs",
        path: "/home/u/a.b",
      });
      expect(of("From: my_docs, /Users/j/My Projects/docs.")).toEqual({
        project: "my_docs",
        path: "/Users/j/My Projects/docs",
      });
      expect(of("From: Docs, workspaces/docs.")).toBeNull();
      expect(of("")).toBeNull();
      expect(of("```\nFrom: Docs, /workspaces/docs.\n```")).toBeNull();
      expect(
        fromOf(
          `# T\n\n## Planning, 31 October 2026, session s\n\nPlan only, 31 October 2026, for Javi.\nFrom: Docs, /workspaces/docs.\n`,
        ),
      ).toEqual({ project: "Docs", path: "/workspaces/docs" });
      // A From line in the body is no header line.
      expect(fromOf(`${head}\n## Notes\n\nFrom: Docs, /workspaces/docs.\n`)).toBeNull();
    });
    it("reads every For section outside a fence, the file as written", () => {
      expect(carriesOf(`${head}\n## For Docs: plans/catalogue-sorted.md\n\nTitle: x.\n`)).toEqual([
        { project: "Docs", file: "plans/catalogue-sorted.md" },
      ]);
      expect(
        carriesOf(`${head}\n## For Docs: plans/a.md\n\n## For Docs: plans/b.md\n`).map(
          (c) => c.file,
        ),
      ).toEqual(["plans/a.md", "plans/b.md"]);
      expect(carriesOf(`${head}\n\`\`\`\n## For Docs: plans/a.md\n\`\`\`\n`)).toEqual([]);
      expect(carriesOf(head)).toEqual([]);
    });
    it("gives a plan its from and carries, and a brief neither", () => {
      const plan = stateOf(
        `${head}From: Docs, /workspaces/docs.\n\n## Built, 31 October 2026\n\nx\n\n## For Docs: plans/x.md\n`,
      )!;
      expect(plan.state).toBe("built");
      expect(plan.from).toEqual({ project: "Docs", path: "/workspaces/docs" });
      expect(plan.carries).toEqual([{ project: "Docs", file: "plans/x.md" }]);
      const brief = stateOf(
        "# B\n\nBrief for the planner, 31 October 2026.\n\n## For Docs: plans/x.md\n",
      )!;
      expect(brief).not.toHaveProperty("from");
      expect(brief).not.toHaveProperty("carries");
    });
    it("finds what each built plan owes: a brief there that names the plan, at its name or the next free one", () => {
      const files: Record<string, string> = {
        "/w/docs/plans/y.md": "# Y\n\nBrief for the planner, by E from /p/plans/a.md (commit 1).\n",
        "/w/docs/plans/z.md": "# Someone else's\n",
        "/w/docs/plans/z-2.md": "# Z\n\nfrom /p/plans/d.md\n",
      };
      const read = (at: string) => {
        if (!(at in files)) throw new Error("ENOENT");
        return files[at];
      };
      const plans = [
        {
          path: "plans/a.md",
          from: { project: "Docs", path: "/w/docs" },
          carries: [
            { project: "Docs", file: "plans/x.md" },
            { project: "Docs", file: "plans/y.md" },
          ],
        },
        { path: "plans/b.md", from: null, carries: [{ project: "Docs", file: "plans/z.md" }] },
        {
          path: "plans/c.md",
          from: { project: "Other", path: "/w/other" },
          carries: [{ project: "Docs", file: "plans/z.md" }],
        },
        {
          path: "plans/d.md",
          from: { project: "Docs", path: "/w/docs" },
          carries: [{ project: "Docs", file: "plans/z.md" }],
        },
        {
          path: "plans/e.md",
          from: { project: "Docs", path: "/w/docs" },
          carries: [{ project: "Docs", file: "plans/z.md" }],
        },
      ];
      expect(carryOf(plans, { read }).map((one) => [one.path, one.file, one.missing])).toEqual([
        ["plans/a.md", "plans/x.md", "file"],
        ["plans/a.md", "plans/y.md", ""],
        ["plans/b.md", "plans/z.md", "from"],
        ["plans/c.md", "plans/z.md", "from"],
        // Written as z-2.md, since z.md is another's.
        ["plans/d.md", "plans/z.md", ""],
        // Another's file of the name is no brief of this plan's.
        ["plans/e.md", "plans/z.md", "file"],
      ]);
      expect(carryOf(plans, { read })[0].checkout).toBe("/w/docs");
    });
    it("refuses the stop once per brief not written, after a red run and before anything else", () => {
      const owed = {
        path: "plans/a.md",
        project: "Docs",
        file: "plans/x.md",
        checkout: "/w/docs",
        missing: "file",
      };
      const first = decideStop({ carry: [owed] })!;
      expect(first).toMatchObject({ refuse: true, told: ["for:plans/a.md:plans/x.md"] });
      expect(first.reason).toBe(
        'plans/a.md leaves work for Docs (its section "For Docs: plans/x.md") and /w/docs/plans/x.md is not written. Write the brief there from the section, by your agent file, and start that queue: cd /w/docs && plans start --agent planner plans/x.md, or what its line says to do; then say so in "Built". A change the plugin leaves for the project it came from goes back as a brief.',
      );
      expect(decideStop({ carry: [owed], told: ["for:plans/a.md:plans/x.md"] })).toBeNull();
      const from = decideStop({ carry: [{ ...owed, checkout: "", missing: "from" }] })!;
      expect(from.reason).toContain("but names no checkout for it: no From line");
      expect(from.reason).toContain('Add "From: Docs, <path>."');
      expect(decideStop({ carry: [{ ...owed, missing: "" }] })).toBeNull();
      const failed = { id: 7, status: "completed", conclusion: "failure", onHead: true };
      expect(decideStop({ carry: [owed], run: failed })!.reason).toContain("(7) is failed");
      const second = { ...owed, file: "plans/y.md" };
      expect(decideStop({ carry: [owed, second] })!.told).toEqual(["for:plans/a.md:plans/x.md"]);
      expect(
        decideStop({ carry: [owed, second], told: ["for:plans/a.md:plans/x.md"] })!.told,
      ).toEqual(["for:plans/a.md:plans/y.md"]);
      // Before the waiting plans, which would retire or hand on the session.
      expect(decideStop({ carry: [owed], waiting: [{ path: "plans/w.md" }] })!.told).toEqual([
        "for:plans/a.md:plans/x.md",
      ]);
    });
  });

  describe("canStart", () => {
    const now = Date.UTC(2026, 9, 24, 12);
    const usage = (five: number, seven = 10) => ({
      at: now / 1000 - 60,
      five_hour: { used_percentage: five, resets_at: now / 1000 + 3600 },
      seven_day: { used_percentage: seven, resets_at: now / 1000 + 86400 },
    });

    it("refuses while paused, and while an executor holds the lock", () => {
      expect(canStart({ now, paused: "today", usage: usage(10) })).toMatchObject({ refuse: true });
      const lock = { sessionId: "abc", pid: 1, name: "Executor 2" };
      expect(canStart({ now, lock, alive: () => true, usage: usage(10) }).why).toContain(
        "Executor 2",
      );
      expect(
        canStart({ now, lock: { ...lock, released: 1 }, alive: () => true, usage: usage(10) }),
      ).toMatchObject({
        start: true,
      });
      expect(canStart({ now, lock, alive: () => false, usage: usage(10) })).toMatchObject({
        start: true,
      });
    });

    it("defers to the window's reset when usage is high", () => {
      expect(canStart({ now, usage: usage(81) })).toMatchObject({
        defer: true,
        until: now + 3600_000 + 120_000,
        why: "the five-hour window is at 81 percent",
      });
      expect(canStart({ now, usage: usage(10, 96) })).toMatchObject({
        defer: true,
        until: now + 86400_000 + 120_000,
      });
      expect(canStart({ now, usage: usage(80, 95) })).toMatchObject({ start: true });
    });

    it("ignores a high number written before its window reset", () => {
      const past = { ...usage(99), five_hour: { used_percentage: 99, resets_at: now / 1000 - 60 } };
      expect(canStart({ now, usage: past })).toMatchObject({ start: true });
    });

    it("starts and says so when usage is unknown", () => {
      expect(canStart({ now }).note).toContain("Usage unknown");
      expect(canStart({ now, usage: { ...usage(99), at: now / 1000 - 3600 } })).toMatchObject({
        start: true,
      });
    });

    it("refuses after a quick death, and names the next executor", () => {
      const last = { at: now - 5 * 60_000, name: "Executor 3" };
      expect(canStart({ now, log: [last], usage: usage(10) }).why).toBe(
        'The last executor (Executor 3) ended within ten minutes with nothing built, and usage was not the cause; starting another would repeat it. Javi decides: a yes starts one more, by plans start --owner-said "<the words>".',
      );
      expect(
        canStart({ now, log: [last], progressAt: now - 60_000, usage: usage(10) }),
      ).toMatchObject({
        start: true,
        name: "Executor 4",
      });
      expect(canStart({ now, usage: usage(10) })).toMatchObject({ name: "Executor 1" });
    });

    // plans/loop-guard-counts-failures.md, parts 1 and 2.
    describe("the loop guard counts five in a row with nothing done", () => {
      // As starts.log writes them, oldest first.
      const line = (minutesAgo: number, n: number, kind = "Executor") => ({
        at: now - minutesAgo * 60_000,
        name: `Executor ${n}`.replace("Executor", kind),
        paths: ["plans/x.md"],
        five: 10,
        seven: 10,
      });
      // Five within an hour, the newest twenty minutes old: no quick death.
      const five = [60, 50, 40, 30, 20].map((ago, i) => line(ago, i + 1));
      const looping = "The last five executors ended with nothing built; something is looping.";

      it("lets a day of executors that each built start a twenty-fifth", () => {
        const day = Array.from({ length: 24 }, (_, i) => line((24 - i) * 55, i + 1));
        expect(
          canStart({ now, log: day, progressAt: now - 60_000, usage: usage(10) }),
        ).toMatchObject({ start: true, name: "Executor 25" });
      });

      it("refuses five with nothing built since, and starts four", () => {
        expect(
          canStart({ now, log: five, progressAt: now - 2 * 3600_000, usage: usage(10) }),
        ).toEqual({
          refuse: true,
          why: `${looping} Javi decides: a yes starts one more, by plans start --owner-said "<the words>".`,
        });
        expect(canStart({ now, log: five.slice(1), usage: usage(10) })).toMatchObject({
          start: true,
        });
      });

      it("counts no start older than a day, and none before the newest progress", () => {
        // Four in the day and one older: the old one is not counted.
        const aged = [line(25 * 60, 1), ...five.slice(1)];
        expect(canStart({ now, log: aged, usage: usage(10) })).toMatchObject({ start: true });
        // Progress between the second and the third.
        expect(
          canStart({ now, log: five, progressAt: now - 45 * 60_000, usage: usage(10) }),
        ).toMatchObject({ start: true, name: "Executor 6" });
      });

      it("starts one more on the owner's word, past either refusal", () => {
        const said = "Yes, we should continue";
        expect(canStart({ now, log: five, said, usage: usage(10) })).toMatchObject({
          start: true,
          name: "Executor 6",
          past: looping,
        });
        const last = { at: now - 5 * 60_000, name: "Executor 3" };
        expect(canStart({ now, log: [last], said, usage: usage(10) })).toMatchObject({
          start: true,
          past: expect.stringMatching(/^The last executor \(Executor 3\) ended within ten minutes/),
        });
        // A start with nothing to pass carries no past.
        expect(canStart({ now, said, usage: usage(10) })).not.toHaveProperty("past");
      });

      it("passes nothing else: the pause, the usage windows and a live executor answer as before", () => {
        const said = "Yes, we should continue";
        expect(canStart({ now, log: five, said, paused: "today", usage: usage(10) })).toMatchObject(
          { refuse: true, why: expect.stringContaining("The queue is paused") },
        );
        expect(canStart({ now, log: five, said, usage: usage(81) })).toMatchObject({
          defer: true,
          why: "the five-hour window is at 81 percent",
        });
        const lock = { sessionId: "abc", pid: 1, name: "Executor 5" };
        expect(
          canStart({
            now,
            log: five,
            said,
            lock,
            alive: () => true,
            usage: usage(10),
            unread: true,
          }),
        ).toMatchObject({
          refuse: true,
          why: "An executor is alive: Executor 5 [abc], and the chats could not be read: start again once plans lists them.",
        });
      });

      it("counts a GitHub note an assistant handled as written, and not one with an event after", () => {
        const dir = mkdtempSync(join(tmpdir(), "written-notes-"));
        try {
          const none = join(dir, "decisions-taken.md");
          writeFileSync(
            join(dir, "40.md"),
            "# Pull request #40\n\ncomment, 15 November 2026 15:00, by a\n\n## Handled, 15 November 2026\n\nAnswered.\n",
          );
          const handled = statSync(join(dir, "40.md")).mtimeMs;
          expect(writtenAt([], none, dir)).toBe(handled);
          writeFileSync(
            join(dir, "40.md"),
            "# Pull request #40\n\n## Handled, 15 November 2026\n\nAnswered.\n\ncomment, 15 November 2026 16:00, by a\n",
          );
          expect(writtenAt([], none, dir)).toBe(0);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it("counts no planner still at work beside which the start goes", () => {
        const planners = [60, 50, 40, 30, 20].map((ago, i) => line(ago, i + 1, "Planner"));
        const busy = {
          sessionId: "p5",
          name: "Planner 5",
          status: "busy",
          usage: { context: 300_000 },
        };
        expect(canStart({ kind: "planner", now, log: planners, usage: usage(10) })).toMatchObject({
          refuse: true,
          why: expect.stringContaining(
            'The last five planners ended with nothing planned; something is looping. Javi decides: a yes starts one more, by plans start --agent planner --owner-said "<the words>".',
          ),
        });
        expect(
          canStart({
            kind: "planner",
            now,
            log: planners,
            sessions: [busy],
            brief: "plans/b.md",
            usage: usage(10),
          }),
        ).toMatchObject({ start: true, name: "Planner 6" });
      });
    });
  });

  it("lets only another live, unreleased session lock this one out, and reading through", () => {
    const lock = { sessionId: "other", pid: 5 };
    expect(lockHeldByOther(lock, "me", () => true)).toBe(true);
    expect(lockHeldByOther(lock, "me", () => false)).toBe(false);
    expect(lockHeldByOther({ ...lock, released: 1 }, "me", () => true)).toBe(false);
    expect(lockHeldByOther({ ...lock, sessionId: "me" }, "me", () => true)).toBe(false);
    expect(lockHeldByOther(null, "me", () => true)).toBe(false);
    expect(allowedWhileLocked("git status")).toBe(true);
    expect(allowedWhileLocked("plans")).toBe(true);
    expect(allowedWhileLocked("plans --all")).toBe(true);
    expect(allowedWhileLocked("plans start")).toBe(false);
    expect(allowedWhileLocked("npm run build")).toBe(false);
  });

  it("hands a cut-off plan over in place of its Building line, at the window's reset", () => {
    const text = `${header("24 October 2026")}## Building, 24 October 2026, session abc\n\n## What was asked\n`;
    const out = cutoffEdit(text, { sessionId: "abc", branch: "queue", day: "24 October 2026" });
    expect(out).not.toContain("## Building");
    expect(out).toContain("## Handing over, 24 October 2026, by the hook\n\nStep in hand: unknown");
    expect(out).toContain("branch `queue`");
    expect(stateOf(out)).toMatchObject({
      state: "handed",
      branch: "queue",
      step: expect.stringMatching(/^unknown/),
    });
    const high = {
      five_hour: { used_percentage: 100, resets_at: 2000 },
      seven_day: { used_percentage: 20, resets_at: 9000 },
    };
    expect(resetTime(high)).toBe(2000);
    expect(resetTime(null, '{"rate_limit_info":{"resetsAt":1500}}\n{"resetsAt":1700}')).toBe(1700);
  });

  // plans/handed-plan-stays-in-queue.md: the hook's hand-over goes after the
  // header paragraph, though the Building line sat between the title and the header.
  it("puts the hook's hand-over after the header paragraph, wherever the Building line was", () => {
    const options = { sessionId: "abc", branch: "queue", day: "24 October 2026" };
    const section = `## Handing over, 24 October 2026, by the hook\n\nStep in hand: unknown, the usage limit cut session abc off on branch \`queue\`. Read the branch's commits and the task list's state in the final messages above.\n`;
    const head = "Plan only, 24 October 2026, for Javi; the executor builds it.";
    const above = `# A plan\n\n## Building, 24 October 2026, session abc\n\n${head}\n\n## What was asked\n`;
    expect(cutoffEdit(above, options)).toBe(
      `# A plan\n\n${head}\n\n${section}\n## What was asked\n`,
    );
    // /code-review, 28 October: a heading straight under the header ends its paragraph.
    const tight = `# A plan\n\n${head}\n## Building, 24 October 2026, session abc\n\n## What was asked\n\nA thing.\n`;
    expect(cutoffEdit(tight, options)).toBe(
      `# A plan\n\n${head}\n\n${section}\n## What was asked\n\nA thing.\n`,
    );
    // No header found: the section takes the Building line's place.
    const headless = `# Notes\n\n## Building, 24 October 2026, session abc\n\nSome notes.\n`;
    expect(cutoffEdit(headless, options)).toBe(`# Notes\n\n${section}\nSome notes.\n`);
  });

  it("prints the status line and keeps the usage, or leaves it before the first call", () => {
    const input = {
      model: { display_name: "Opus" },
      context_window: { used_percentage: 41.6 },
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
        seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
      },
    };
    const { line, usage } = statusFrom(input, 1_000_000);
    expect(line).toBe("Opus · context 42% · 5h 24% · 7d 41%");
    expect(usage).toEqual({
      at: 1000,
      five_hour: input.rate_limits.five_hour,
      seven_day: input.rate_limits.seven_day,
    });
    expect(statusFrom({ model: { display_name: "Opus" } })).toEqual({ line: "Opus", usage: null });
  });

  it("writes the usage file from the status line script", () => {
    const file = join(repo, "usage.json");
    execFileSync("node", [join(here, "statusline.mjs")], {
      input: JSON.stringify({
        model: { display_name: "Opus" },
        rate_limits: { five_hour: { used_percentage: 5, resets_at: 9 } },
      }),
      encoding: "utf8",
      env: { ...process.env, WORKFLOW_USAGE_FILE: file },
    });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      five_hour: { used_percentage: 5 },
    });
  });

  it("puts a handed-over plan first, then the rest oldest first", () => {
    const dir = join(repo, "order-plans");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "later.md"), header("25 October 2026"));
    writeFileSync(join(dir, "earlier.md"), header("24 October 2026"));
    writeFileSync(
      join(dir, "handed.md"),
      `${header("26 October 2026")}## Handing over, 26 October 2026\n\nStep in hand: 2\n`,
    );
    expect(readPlans(dir).map((p) => p.path)).toEqual([
      "plans/handed.md",
      "plans/earlier.md",
      "plans/later.md",
    ]);
  });

  // plans/priority-queue.md, part 1.
  describe("a plan put first", () => {
    it("firstOf", () => {
      const head = "# P\n\nPlan only, 13 November 2026, for Javi.\n\n";
      const at = (h: number, m: number, sec = 0) =>
        Date.UTC(2026, 10, 13) + ((h * 60 + m) * 60 + sec) * 1000;
      const of = (line: string) => firstOf(`${head}${line}\n\n## What was asked\n`);
      expect(of("First: 13 November 2026 15:42:07.")).toEqual({
        day: "13 November 2026",
        time: "15:42",
        at: at(15, 42, 7),
      });
      expect(of("First: 13 November 2026, 15:42")).toEqual({
        day: "13 November 2026",
        time: "15:42",
        at: at(15, 42),
      });
      expect(of("First: 13 November 2026.")).toEqual({
        day: "13 November 2026",
        time: "",
        at: at(0, 0),
      });
      expect(of("First: 2026-11-13 9:05.")).toEqual({
        day: "2026-11-13",
        time: "09:05",
        at: at(9, 5),
      });
      // Past a status section, as the executor's lines sit above the header.
      expect(
        firstOf(
          "# P\n\n## Planning, 13 November 2026, session s1\n\nBrief for the planner, 13 November 2026.\n\nFirst: 13 November 2026 10:00.\n\n## What was asked\n",
        ),
      ).toMatchObject({ time: "10:00" });
      // Not in a fence, not below the first `## `.
      expect(of("```\nFirst: 13 November 2026 15:42.\n```")).toBeNull();
      expect(firstOf(`${head}## What was asked\n\nFirst: 13 November 2026 15:42.\n`)).toBeNull();
      expect(of("First: soon.")).toBeNull();
      expect(firstUnread(`${head}First: soon.\n\n## What was asked\n`)).toBe(true);
      expect(firstUnread(`${head}First: 13 November 2026 15:42.\n\n## What was asked\n`)).toBe(
        false,
      );
      expect(firstUnread(`${head}## What was asked\n`)).toBe(false);
      // A day the calendar does not have is no day, in both spellings (plans/put-first-review-fixes.md, part 2).
      expect(parseDay("31 February 2026")).toBeNaN();
      expect(parseDay("2026-02-31")).toBeNaN();
      expect(parseDay("29 February 2028")).toBe(Date.UTC(2028, 1, 29));
      expect(of("First: 31 February 2026 10:00.")).toBeNull();
      expect(of("First: 2026-02-31.")).toBeNull();
      expect(firstUnread(`${head}First: 31 February 2026 10:00.\n\n## What was asked\n`)).toBe(
        true,
      );
      expect(of("First: 29 February 2028 10:00.")).toMatchObject({ time: "10:00" });
    });

    it("stateOf, first", () => {
      const line = "First: 13 November 2026 15:42.\n\n";
      const plan = `# P\n\nPlan only, 13 November 2026, for Javi.\n\n${line}`;
      const brief = `# B\n\nBrief for the planner, 13 November 2026.\n\n${line}`;
      const first = (text: string, live: string[] | null = []) =>
        stateOf(text, { live })?.first?.time ?? null;
      expect(first(brief)).toBe("15:42");
      expect(
        first(
          `${brief.replace("# B\n\n", "# B\n\n## Planning, 13 November 2026, session p1\n\n")}`,
          ["p1"],
        ),
      ).toBe("15:42");
      expect(first(plan)).toBe("15:42");
      expect(first(`${plan.replace("for Javi.", "for Javi.\n\nIssue: #4.")}`)).toBe("15:42");
      expect(stateOf(`${plan.replace("for Javi.", "for Javi.\n\nIssue: #4.")}`)?.state).toBe(
        "planned",
      );
      expect(first(`${plan}## Handing over, 13 November 2026\n\nStep in hand: 2\n`)).toBe("15:42");
      expect(
        first(plan.replace("# P\n\n", "# P\n\n## Building, 13 November 2026, session b1\n\n"), [
          "b1",
        ]),
      ).toBeNull();
      expect(first(`${plan}## Built, 13 November 2026\n\nCommit 0123abcd.\n`)).toBeNull();
      expect(
        first(`${plan}## Dropped, 13 November 2026\n\nDropped on Javi's word: gone.\n`),
      ).toBeNull();
      expect(
        first(
          brief.replace("Brief for the planner", "Brief for the planner") +
            "## Dropped, 13 November 2026\n\nGone.\n",
        ),
      ).toBeNull();
      expect(first(plan.replace("13 November 2026, for", "20 October 2026, for"))).toBeNull();
    });

    it("readPlans, put first", () => {
      const dir = join(repo, "first-plans");
      mkdirSync(dir, { recursive: true });
      const first = (time: string) => `First: 13 November 2026 ${time}.\n\n`;
      writeFileSync(join(dir, "oldest.md"), header("10 November 2026"));
      writeFileSync(join(dir, "newer.md"), header("12 November 2026"));
      writeFileSync(join(dir, "b.md"), `${header("13 November 2026")}${first("15:42:07")}`);
      writeFileSync(join(dir, "c.md"), `${header("13 November 2026")}${first("16:05:00")}`);
      writeFileSync(
        join(dir, "handed.md"),
        `${header("11 November 2026")}## Handing over, 12 November 2026\n\nStep in hand: 2\n`,
      );
      expect(readPlans(dir).map((p) => p.path)).toEqual([
        "plans/handed.md",
        "plans/c.md",
        "plans/b.md",
        "plans/oldest.md",
        "plans/newer.md",
      ]);
    });
  });

  it("lists the queue under its headings, in order", () => {
    mkdirSync(join(repo, "plans"), { recursive: true });
    writeFileSync(join(repo, "plans", "ready.md"), header("24 October 2026"));
    writeFileSync(join(repo, "plans", "old.md"), header("20 October 2026"));
    writeFileSync(
      join(repo, "plans", "done.md"),
      `${header("24 October 2026")}## Built, ${new Date().getDate()} ${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][new Date().getMonth()]} ${new Date().getFullYear()}\n\nCommit 0123abcd.\n`,
    );
    const out = execFileSync("node", [join(here, "plan-queue.mjs"), "list"], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    });
    // plans/executor-takes-next-ready-plan.md, part 3: a plan ready, none alive.
    expect(out).toMatch(
      /^Plans on lab, .*The executor: none alive; \d+ plans? ready, and the next hook or timer starts one\./,
    );
    expect(out.indexOf("Ready, oldest first")).toBeLessThan(out.indexOf("Built today"));
    expect(out).toContain("plans/ready.md");
    expect(out).toContain("0123abcd");
    expect(out).toContain("Older, by path only: 1 plan dated");
    // plans/dropped-plan-state.md: on screen only on its day, every one with --all.
    expect(out).not.toContain("Dropped");
    writeFileSync(
      join(repo, "plans", "dropped.md"),
      `${header("24 October 2026")}## Dropped, ${today()}\n\nDropped on Javi's word: #31 already decides it.\n`,
    );
    writeFileSync(
      join(repo, "plans", "dropped-old.md"),
      `${header("24 October 2026")}## Dropped, 25 October 2026\n\nDropped on Javi's word: he no longer wants it.\n`,
    );
    try {
      const listed = (args: string[]) =>
        execFileSync("node", [join(here, "plan-queue.mjs"), ...args], {
          encoding: "utf8",
          env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
        });
      const day = today().replace(/ \d{4}$/, "");
      const shown = listed(["list"]);
      expect(shown.indexOf("Built today")).toBeLessThan(shown.indexOf("Dropped today"));
      expect(shown).toMatch(
        new RegExp(`plans/dropped\\.md +dropped, ${day}: #31 already decides it\\n`),
      );
      expect(shown).not.toContain("plans/dropped-old.md");
      // A drop dated in ISO is today's by the calendar day (Codex, 30 October).
      const now = new Date();
      const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      writeFileSync(
        join(repo, "plans", "dropped-iso.md"),
        `${header("24 October 2026")}## Dropped, ${iso}\n\nDropped on Javi's word: folded into plans/ready.md.\n`,
      );
      expect(listed(["list"])).toMatch(
        /plans\/dropped-iso\.md +dropped, .*: folded into plans\/ready\.md/,
      );
      expect(shown.slice(0, shown.indexOf("Dropped today"))).not.toContain("plans/dropped.md");
      const every = listed(["--all"]);
      expect(every).toMatch(/\nDropped\n/);
      expect(every).toMatch(/plans\/dropped-old\.md +dropped, 25 October: he no longer wants it/);
    } finally {
      rmSync(join(repo, "plans", "dropped.md"));
      rmSync(join(repo, "plans", "dropped-old.md"));
      rmSync(join(repo, "plans", "dropped-iso.md"), { force: true });
    }
    // plans/handed-plan-stays-in-queue.md: a file with no header and no brief line is said.
    expect(out).not.toContain("Not read by the queue");
    writeFileSync(join(repo, "plans", "x.md"), "# Notes\n\nSome notes, no header.\n");
    // Codex, 28 October: a file that cannot be read is said too (a directory
    // stands in for a file the user cannot read).
    mkdirSync(join(repo, "plans", "y.md"));
    try {
      const said = execFileSync("node", [join(here, "plan-queue.mjs"), "list"], {
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
      });
      expect(said).toContain("Not read by the queue (no header found): plans/x.md");
      expect(said).toContain("Not read by the queue (the file could not be read): plans/y.md");
      expect(said.indexOf("Older, by path only")).toBeLessThan(said.indexOf("Not read by"));
      expect(unreadPlans(join(repo, "plans"))).toEqual({
        headless: ["plans/x.md"],
        failed: ["plans/y.md"],
      });
    } finally {
      rmSync(join(repo, "plans", "x.md"));
      rmSync(join(repo, "plans", "y.md"), { recursive: true });
    }
  }, 30_000);

  // plans/executor-never-waits.md: the assistant's log of decisions taken is not a plan.
  it("leaves the log of decisions taken out of the files it cannot read", () => {
    mkdirSync(join(repo, "plans"), { recursive: true });
    writeFileSync(join(repo, "plans", "x.md"), "# Notes\n\nSome notes, no header.\n");
    writeFileSync(
      join(repo, "plans", "decisions-taken.md"),
      "# Decisions taken for Javi, for his review\n\nKept by the assistant.\n",
    );
    // A plan stuck at one step is the assistant's, not a question to the owner (Codex C3).
    writeFileSync(
      join(repo, "plans", "stuck.md"),
      `${header("24 October 2026")}## Handing over, 24 October 2026\n\nStep in hand: 3\n\n` +
        "## Resumed, 24 October 2026, session s1, at step 3\n## Resumed, 24 October 2026, session s2, at step 3\n",
    );
    try {
      const said = execFileSync("node", [join(here, "plan-queue.mjs"), "list"], {
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
      });
      expect(said).toMatch(/^Not read by the queue \(no header found\): plans\/x\.md$/m);
      expect(said).not.toContain("decisions-taken");
      expect(TAKEN_LOG).toBe("plans/decisions-taken.md");
      expect(unreadPlans(join(repo, "plans")).headless).toEqual(["plans/x.md"]);
      // An assistant that only logs a decision has written something (/code-review).
      const log = join(repo, TAKEN_LOG);
      expect(writtenAt([], log)).toBe(statSync(log).mtimeMs);
      expect(writtenAt([{ state: "built", mtime: 1 }], join(repo, "plans", "none.md"))).toBe(0);
      expect(writtenAt([{ state: "ready", mtime: 2 ** 50 }], log)).toBe(2 ** 50);
      expect(said).toMatch(/plans\/stuck\.md .*stuck, the assistant takes it/);
      expect(said).not.toContain("stuck, asks");
    } finally {
      rmSync(join(repo, "plans", "stuck.md"));
      rmSync(join(repo, "plans", "x.md"));
      rmSync(join(repo, "plans", "decisions-taken.md"));
    }
  }, 30_000);

  /**
   * **An executor in a worktree is alive** (plans/queue-sees-worktree-
   * executor.md): a background session is moved under `.claude/worktrees/`,
   * and the queue read it as gone.
   */
  describe("inThisRepo", () => {
    const paths = ["/w/project", "/w/project/.claude/worktrees/executor", "/w/sibling"];
    it("counts the checkout, its worktrees and their subdirectories", () => {
      expect(inThisRepo("/w/project", paths)).toBe(true);
      expect(inThisRepo("/w/project/.claude/worktrees/executor", paths)).toBe(true);
      expect(inThisRepo("/w/sibling", paths)).toBe(true);
      expect(inThisRepo("/w/project/.claude/worktrees/executor/apps/forum", paths)).toBe(true);
      expect(inThisRepo("/w/sibling/apps", paths)).toBe(true);
    });
    it("does not count a session with no working directory", () => {
      expect(inThisRepo(undefined, paths)).toBe(false);
      expect(inThisRepo("", paths)).toBe(false);
    });
    it("does not count another repository, or a path that only shares a prefix", () => {
      expect(inThisRepo("/w/elsewhere", paths)).toBe(false);
      expect(inThisRepo("/w/project-other", paths)).toBe(false);
    });
  });

  it("lists a live executor in a worktree as busy, its plan as building, and a worktree no executor's as left over", () => {
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base"],
      {
        cwd: repo,
      },
    );
    const tree = join(repo, ".claude", "worktrees", "executor-1");
    execFileSync("git", ["worktree", "add", "-q", "-b", "nine-work", tree, "HEAD"], { cwd: repo });
    const leftover = join(repo, ".claude", "worktrees", "leftover");
    execFileSync("git", ["worktree", "add", "-q", "--detach", leftover, "HEAD"], { cwd: repo });
    const session = "11111111-2222-3333-4444-555555555555";
    writeFileSync(
      join(repo, ".claude", "executor.1.lock"),
      JSON.stringify({ sessionId: session, name: "Executor 9", pid: process.pid }),
    );
    writeFileSync(
      join(repo, "plans", "busy.md"),
      `# Busy\n\n## Building, 26 October 2026, session ${session}\n\nPlan only, 26 October 2026.\n`,
    );
    const live = [
      { sessionId: session, name: "Executor 9", status: "busy", cwd: join(tree, "apps") },
    ];
    try {
      const out = listWith(live);
      expect(out).toMatch(
        /The executor: Executor 9 \[11111111\], busy, in executor-1 on nine-work, building plans\/busy\.md\./,
      );
      expect(out).toMatch(/\nBuilding\n  plans\/busy\.md +Executor 9, since 26 October 2026/);
      expect(out).not.toMatch(/busy\.md[^\n]*gone/);
      expect(out).toContain("Worktrees under .claude/worktrees: left over: leftover.");
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", tree], { cwd: repo });
      execFileSync("git", ["worktree", "remove", "--force", leftover], { cwd: repo });
      execFileSync("git", ["branch", "-D", "-q", "nine-work"], { cwd: repo });
      rmSync(join(repo, ".claude", "executor.1.lock"), { force: true });
      rmSync(join(repo, "plans", "busy.md"), { force: true });
    }
  });

  /**
   * **Any live executor counts** (plans/queue-counts-any-executor.md): the
   * executor line is read from the sessions, not from the lock.
   */
  describe("the executor line", () => {
    // plans/executor-takes-next-ready-plan.md, part 3.
    it("says with plans ready and none alive that the next hook or timer starts one, or why none does", () => {
      const dir = mkdtempSync(join(tmpdir(), "queue-none-alive-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: dir });
        mkdirSync(join(dir, ".claude"));
        mkdirSync(join(dir, "plans"));
        writeFileSync(join(dir, ".claude", "workflow.md"), "---\nname: Lines\nbranch: test\n---\n");
        expect(listIn(dir, [])).toContain("The executor: none alive.\n");
        for (const x of ["a", "b", "c", "d", "e", "f", "g", "h"])
          writeFileSync(join(dir, "plans", `${x}.md`), header("6 November 2026"));
        expect(listIn(dir, [])).toContain(
          "The executor: none alive; 8 plans ready, and the next hook or timer starts one.\n",
        );
        writeFileSync(join(dir, ".claude", "executor.pause"), JSON.stringify({ at: "23:10" }));
        expect(listIn(dir, [])).toContain(
          'The executor: none alive; 8 plans ready, but none starts: The queue is paused since 23:10 ("resume the queue" in any session lifts it).\n',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    const ids = {
      four: "44444444-0000-0000-0000-000000000000",
      five: "55555555-0000-0000-0000-000000000000",
      hand: "66666666-0000-0000-0000-000000000000",
      chat: "77777777-0000-0000-0000-000000000000",
    };
    afterAll(() => {
      for (const id of Object.values(ids)) rmSync(stateFile(id), { force: true });
      rmSync(join(repo, ".claude", "executor.1.lock"), { force: true });
    });

    it("lists an executor in the checkout with a released lock, and nothing more", () => {
      writeFileSync(
        join(repo, ".claude", "executor.1.lock"),
        JSON.stringify({ sessionId: ids.four, name: "Executor 4", released: 1 }),
      );
      const out = listWith([
        { sessionId: ids.four, name: "Executor 4", status: "busy", cwd: repo },
      ]);
      expect(out).toMatch(/The executor: Executor 4 \[44444444\], busy, in the checkout\.\n/);
    });

    it("says the executors, and retired on the retired one only", () => {
      writeFileSync(stateFile(ids.five), JSON.stringify({ retired: true }));
      const out = listWith([
        { sessionId: ids.four, name: "Executor 4", status: "idle", cwd: repo },
        { sessionId: ids.five, name: "Executor 5", status: "busy", cwd: repo },
      ]);
      expect(out).toMatch(
        /The executors: Executor 4 \[44444444\], idle, in the checkout; Executor 5 \[55555555\], busy, in the checkout, retired\./,
      );
    });

    it("says the plan a retired planner still holds, and the brief one is planning", () => {
      const p2 = "22222222-1111-0000-0000-000000000000";
      const p3 = "33333333-1111-0000-0000-000000000000";
      writeFileSync(
        stateFile(p2),
        JSON.stringify({ agent: "planner", retired: true, plans: ["plans/x.md"] }),
      );
      writeFileSync(stateFile(p3), JSON.stringify({ agent: "planner", brief: "plans/y.md" }));
      mkdirSync(join(repo, "plans"), { recursive: true });
      writeFileSync(
        join(repo, "plans", "y.md"),
        `# Y\n\nBrief for the planner, 26 October 2026.\n\n## Planning, 26 October 2026, session ${p3}\n`,
      );
      try {
        const out = listWith([
          { sessionId: p2, name: "Planner 2", status: "idle", cwd: repo, kind: "background" },
          { sessionId: p3, name: "Planner 3", status: "busy", cwd: repo, kind: "background" },
        ]);
        expect(out).toContain("Planner 2 [22222222], idle, retired, its plan plans/x.md");
        expect(out).toContain("Planner 3 [33333333], busy, planning plans/y.md");
      } finally {
        rmSync(stateFile(p2), { force: true });
        rmSync(stateFile(p3), { force: true });
        rmSync(join(repo, "plans", "y.md"), { force: true });
      }
    });

    it("counts a session its prompt hook marked, and not an ordinary chat", () => {
      writeFileSync(stateFile(ids.hand), JSON.stringify({ agent: "executor" }));
      const out = listWith([
        { sessionId: ids.hand, status: "busy", cwd: repo, kind: "interactive" },
        { sessionId: ids.chat, name: "Assistant", status: "busy", cwd: repo, kind: "interactive" },
      ]);
      expect(out).toMatch(/The executor: 66666666 \[66666666\], busy, in the checkout\./);
      expect(out).not.toContain("77777777");
    });

    it("leaves out the session being replaced and the retired ones when starting", () => {
      const live = [
        { sessionId: ids.four, name: "Executor 4", status: "busy", cwd: repo },
        { sessionId: ids.five, name: "Executor 5", status: "busy", cwd: repo },
      ];
      const states: Record<string, { retired?: boolean }> = { [ids.five]: { retired: true } };
      const all = sessionsOf("executor", live, [], {
        trees: [{ path: repo, branch: "" }],
        stateFor: (id) => states[id] || null,
      });
      expect(all.map((one) => [one.name, one.retired])).toEqual([
        ["Executor 4", false],
        ["Executor 5", true],
      ]);
      const blocking = all.filter((one) => one.sessionId !== ids.four && !one.retired);
      expect(blocking).toEqual([]);
    });
  });

  describe("starting beside a live executor", () => {
    const one = {
      kind: "executor" as const,
      sessionId: "aacbea39-0000-0000-0000-000000000000",
      id: "bg-123",
      name: "Executor 2",
      status: "busy",
      where: "public-sources-edits",
      branch: "codex-answers",
      holdsLock: false,
      retired: false,
      on: "",
    };
    it("refuses while one is alive, whatever the lock", () => {
      const decision = canStart({ sessions: [one], lock: null });
      expect(decision).toMatchObject({ refuse: true });
      expect("why" in decision && decision.why).toBe(
        "An executor is alive: Executor 2 [aacbea39], busy, in public-sources-edits on codex-answers. Have the assistant message it, or end it with plans end aacbea39 --now if it is stuck, then start again.",
      );
    });
    it("starts with none alive and a released lock", () => {
      const decision = canStart({
        sessions: [],
        lock: { sessionId: one.sessionId, released: 1 } as never,
      });
      expect(decision).toMatchObject({ start: true });
    });
    it("names plans end --now for a lock holder the chats were read without", () => {
      const lock = { sessionId: one.sessionId, pid: 1, name: "Executor 2" };
      const decision = canStart({ sessions: [], lock, alive: () => true });
      expect("why" in decision && decision.why).toBe(
        "An executor is alive: Executor 2 [aacbea39]. Have the assistant message it, or end it with plans end aacbea39 --now if it is stuck, then start again.",
      );
      expect(canStart({ sessions: [], lock, alive: () => true, unread: true })).toMatchObject({
        refuse: true,
        why: "An executor is alive: Executor 2 [aacbea39], and the chats could not be read: start again once plans lists them.",
      });
    });
  });

  /** **The checkout follows its branch**: `plans sync`. */
  describe("plans sync", () => {
    let origin: string;
    let clone: string;
    const syncIn = (cwd: string) =>
      execFileSync("node", [join(here, "plan-queue.mjs"), "sync"], {
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
      }).trim();
    let first: string;

    beforeAll(() => {
      origin = mkdtempSync(join(tmpdir(), "queue-origin-"));
      g(origin, "init", "-q", "--bare");
      clone = mkdtempSync(join(tmpdir(), "queue-clone-"));
      g(clone, "init", "-q");
      g(clone, "remote", "add", "origin", origin);
      writeFileSync(join(clone, "README"), "one\n");
      writeFileSync(join(clone, ".gitignore"), `${QUEUE_IGNORES.join("\n")}\n`);
      mkdirSync(join(clone, ".claude"), { recursive: true });
      writeFileSync(join(clone, ".claude", "workflow.md"), "---\nname: Clone\nbranch: test\n---\n");
      g(clone, "add", ".");
      g(clone, "commit", "-q", "-m", "one");
      first = g(clone, "rev-parse", "HEAD");
      mkdirSync(join(clone, "scripts", "hooks"), { recursive: true });
      writeFileSync(join(clone, "scripts", "hooks", "x.mjs"), "// two\n");
      g(clone, "add", ".");
      g(clone, "commit", "-q", "-m", "two");
      g(clone, "push", "-q", "origin", "HEAD:refs/heads/test");
    });
    afterAll(() => {
      rmSync(origin, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    });

    it("moves a clean checkout on a branch to origin/test, detached, and says one ahead", () => {
      // plans/executors-build-in-worktrees.md, part 5: nobody builds in the checkout.
      const on = g(clone, "symbolic-ref", "--short", "HEAD");
      const test = g(clone, "rev-parse", "origin/test");
      g(clone, "switch", "-q", "-c", "behind", first);
      expect(syncIn(clone)).toBe(`The checkout is at test, ${test.slice(0, 8)}.`);
      expect(g(clone, "rev-parse", "HEAD")).toBe(test);
      expect(() => g(clone, "symbolic-ref", "-q", "HEAD")).toThrow();
      g(clone, "switch", "-q", on);
      writeFileSync(join(clone, "README"), "ahead\n");
      g(clone, "commit", "-q", "-am", "ahead");
      expect(syncIn(clone)).toBe(
        "Not moved: the checkout is ahead of test; push or drop its commits first.",
      );
      g(clone, "reset", "-q", "--hard", test);
      g(clone, "branch", "-q", "-D", "behind");
    });
    it("names no queue in a project with no project file", () => {
      const bare = mkdtempSync(join(tmpdir(), "queue-bare-"));
      try {
        expect(listIn(bare, [])).toContain("No .claude/workflow.md here: plans init writes one.");
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    });
    it("refuses with a change, and when ahead", () => {
      g(clone, "fetch", "-q", "origin");
      g(clone, "checkout", "-q", "--detach", "origin/test");
      writeFileSync(join(clone, "README"), "other\n");
      g(clone, "commit", "-q", "-am", "other");
      expect(syncIn(clone)).toBe(
        "Not moved: the checkout is ahead of test; push or drop its commits first.",
      );
      g(clone, "checkout", "-q", "--detach", first);
      writeFileSync(join(clone, "README"), "changed\n");
      expect(syncIn(clone)).toBe(
        "Not moved: the checkout has changes; commit, stash or discard them first.",
      );
      g(clone, "checkout", "-q", "--", "README");
    });
    it("moves a clean detached checkout behind test, then says it is there", () => {
      const test = g(clone, "rev-parse", "origin/test");
      expect(syncIn(clone)).toBe(`The checkout is at test, ${test.slice(0, 8)}.`);
      expect(g(clone, "rev-parse", "HEAD")).toBe(test);
      expect(syncIn(clone)).toBe(`Already at test, ${test.slice(0, 8)}.`);
    });
    // plans/executor-over-ceiling-hands-on.md, part 3.
    it("moves past untracked files under plans/", () => {
      const test = g(clone, "rev-parse", "origin/test");
      mkdirSync(join(clone, "plans", "x"), { recursive: true });
      writeFileSync(join(clone, "plans", "x.md"), "# X\n");
      writeFileSync(join(clone, "plans", "x", "sketch.md"), "# Sketch\n");
      try {
        expect(syncIn(clone)).toBe(`Already at test, ${test.slice(0, 8)}.`);
        g(clone, "checkout", "-q", "--detach", first);
        expect(syncIn(clone)).toBe(`The checkout is at test, ${test.slice(0, 8)}.`);
        writeFileSync(join(clone, "plans", "my plan.md"), "# Mine\n");
        g(clone, "checkout", "-q", "--detach", first);
        expect(syncIn(clone)).toBe(`The checkout is at test, ${test.slice(0, 8)}.`);
      } finally {
        rmSync(join(clone, "plans"), { recursive: true, force: true });
      }
    });
    // plans/owners-untracked-files-left-alone.md: git carries an untracked
    // file across a detach unchanged, wherever it is.
    it("when the checkout holds an untracked .env and is behind test, then sync moves it and the .env is still there", () => {
      const test = g(clone, "rev-parse", "origin/test");
      g(clone, "checkout", "-q", "--detach", first);
      writeFileSync(join(clone, ".env"), "SECRET=mine\n");
      try {
        expect(syncIn(clone)).toBe(`The checkout is at test, ${test.slice(0, 8)}.`);
        expect(g(clone, "rev-parse", "HEAD")).toBe(test);
        expect(readFileSync(join(clone, ".env"), "utf8")).toBe("SECRET=mine\n");
        expect(g(clone, "status", "--porcelain")).toBe("?? .env");
      } finally {
        rmSync(join(clone, ".env"), { force: true });
      }
    });
    it("when an untracked file would be overwritten by the move, then sync does not move and names it", () => {
      g(clone, "checkout", "-q", "--detach", first);
      // test tracks scripts/hooks/x.mjs; here it is the owner's, untracked.
      mkdirSync(join(clone, "scripts", "hooks"), { recursive: true });
      writeFileSync(join(clone, "scripts", "hooks", "x.mjs"), "// mine\n");
      try {
        expect(syncIn(clone)).toBe(
          "Not moved: untracked files would be overwritten: scripts/hooks/x.mjs; move them first.",
        );
        expect(g(clone, "rev-parse", "HEAD")).toBe(first);
        expect(readFileSync(join(clone, "scripts", "hooks", "x.mjs"), "utf8")).toBe("// mine\n");
      } finally {
        rmSync(join(clone, "scripts"), { recursive: true, force: true });
      }
    });
    it("when an untracked directory sits where the move puts a file, then sync does not move and names it", () => {
      g(clone, "checkout", "-q", "--detach", first);
      // test tracks the file scripts/hooks/x.mjs; here x.mjs is the owner's directory.
      mkdirSync(join(clone, "scripts", "hooks", "x.mjs"), { recursive: true });
      writeFileSync(join(clone, "scripts", "hooks", "x.mjs", "ü.txt"), "mine\n");
      try {
        expect(syncIn(clone)).toBe(
          "Not moved: untracked files would be overwritten: scripts/hooks/x.mjs; move them first.",
        );
        expect(g(clone, "rev-parse", "HEAD")).toBe(first);
      } finally {
        rmSync(join(clone, "scripts"), { recursive: true, force: true });
      }
    });
    it("moves the primary checkout when run from a worktree, never the worktree", () => {
      g(clone, "checkout", "-q", "--detach", first);
      const tree = join(mkdtempSync(join(tmpdir(), "queue-tree-")), "w");
      g(clone, "worktree", "add", "-q", "--detach", tree, first);
      try {
        const test = g(clone, "rev-parse", "origin/test");
        expect(syncIn(tree)).toBe(`The checkout is at test, ${test.slice(0, 8)}.`);
        expect(g(clone, "rev-parse", "HEAD")).toBe(test);
        expect(g(tree, "rev-parse", "HEAD")).toBe(first);
      } finally {
        g(clone, "worktree", "remove", "--force", tree);
      }
    });
    it("ignores a kind of queue file the project's .gitignore lacks, then moves the checkout", () => {
      // A project set up before the third kind: its .gitignore lacks it.
      g(clone, "checkout", "-q", "--detach", "origin/test");
      writeFileSync(
        join(clone, ".gitignore"),
        ".claude/executor.*\n.claude/planner.*\n.claude/worktrees/\n.claude/app-token.*\n.claude/github-*\n.claude/webhook.*\n.claude/refreshes.*\n.claude/handover.*\n.claude/settings.local.json\n",
      );
      g(clone, "commit", "-q", "-am", "two kinds");
      const behind = g(clone, "rev-parse", "HEAD");
      writeFileSync(join(clone, "README"), "three\n");
      g(clone, "commit", "-q", "-am", "three");
      g(clone, "push", "-q", "origin", "HEAD:refs/heads/test");
      g(clone, "checkout", "-q", "--detach", behind);
      writeFileSync(join(clone, ".claude", "asking.deferred"), "{}\n");
      const exclude = join(clone, ".git", "info", "exclude");
      const before = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
      try {
        const test = g(clone, "rev-parse", "origin/test");
        expect(syncIn(clone)).toBe(
          `Added .claude/asking.*, .claude/handed.*, .claude/assistant.* to .git/info/exclude. The checkout is at test, ${test.slice(0, 8)}.`,
        );
        expect(g(clone, "rev-parse", "HEAD")).toBe(test);
        expect(g(clone, "status", "--porcelain")).toBe("");
        // The tracked .gitignore is left as it is; the line is added once.
        expect(g(clone, "diff", "--name-only")).toBe("");
        expect(syncIn(clone)).toBe(`Already at test, ${test.slice(0, 8)}.`);
        expect(readFileSync(exclude, "utf8").split("\n")).toContain(".claude/asking.*");
        // An assistant chat's start file too (plans/project-follow-ups-reach-the-project.md).
        expect(readFileSync(exclude, "utf8").split("\n")).toContain(".claude/assistant.*");
      } finally {
        rmSync(join(clone, ".claude", "asking.deferred"), { force: true });
        writeFileSync(exclude, before);
      }
    });
    it("ignores Claude Code's worktrees under .claude/, then moves the checkout", () => {
      // A project set up before: its .gitignore has the kinds, not the folder.
      g(clone, "checkout", "-q", "--detach", "origin/test");
      writeFileSync(
        join(clone, ".gitignore"),
        ".claude/executor.*\n.claude/planner.*\n.claude/asking.*\n.claude/handed.*\n.claude/assistant.*\n.claude/app-token.*\n.claude/github-*\n.claude/webhook.*\n.claude/refreshes.*\n.claude/handover.*\n.claude/settings.local.json\n",
      );
      g(clone, "commit", "-q", "-am", "three kinds");
      const behind = g(clone, "rev-parse", "HEAD");
      writeFileSync(join(clone, "README"), "four\n");
      g(clone, "commit", "-q", "-am", "four");
      g(clone, "push", "-q", "origin", "HEAD:refs/heads/test");
      g(clone, "checkout", "-q", "--detach", behind);
      mkdirSync(join(clone, ".claude", "worktrees", "x"), { recursive: true });
      writeFileSync(join(clone, ".claude", "worktrees", "x", "f"), "\n");
      try {
        const test = g(clone, "rev-parse", "origin/test");
        expect(syncIn(clone)).toBe(
          `Added .claude/worktrees/ to .git/info/exclude. The checkout is at test, ${test.slice(0, 8)}.`,
        );
        expect(g(clone, "rev-parse", "HEAD")).toBe(test);
        expect(g(clone, "status", "--porcelain")).toBe("");
        expect(syncIn(clone)).toBe(`Already at test, ${test.slice(0, 8)}.`);
      } finally {
        // The exclude keeps its lines: the tests after this one find
        // nothing to add, as origin/test's .gitignore lacks the folder.
        rmSync(join(clone, ".claude", "worktrees"), { recursive: true, force: true });
      }
    });
    it("says a failed fetch on every answer", () => {
      g(clone, "remote", "set-url", "origin", join(origin, "gone"));
      try {
        g(clone, "switch", "-q", "-c", "side");
        expect(syncIn(clone)).toMatch(
          /^git fetch failed \(.+\), so this is test as last fetched\. The checkout is at test, /,
        );
      } finally {
        g(clone, "checkout", "-q", "--detach", "origin/test");
        g(clone, "branch", "-D", "-q", "side");
        g(clone, "remote", "set-url", "origin", origin);
      }
    });
  });

  /** **The executors run at high effort** (part 4): the agent file's, on the command line. */
  it("passes the agent file's effort to a start, and none without one", () => {
    const agents = join(repo, "agents-fixture");
    mkdirSync(agents, { recursive: true });
    const env = {
      ...process.env,
      CLAUDE_PROJECT_DIR: repo,
      WORKFLOW_STARTS_LOG: join(repo, ".claude", "starts.log"),
      WORKFLOW_USAGE_FILE: join(repo, ".claude", "usage.json"),
    };
    const dry = () =>
      execFileSync("node", [join(here, "plan-queue.mjs"), "start", "--dry", "plans/x.md"], {
        encoding: "utf8",
        env,
      });
    try {
      // The plugin's own executor runs at high effort, scoped by the plugin's name.
      expect(dry()).toContain('"--agent" "workflow:executor" "--effort" "high"');
      writeFileSync(
        join(agents, "executor.md"),
        "---\nname: executor\neffort: high\n---\n\nBody.\n",
      );
      expect(agentEffort("executor", agents)).toBe("high");
      writeFileSync(join(agents, "executor.md"), "---\nname: executor\n---\n\neffort: low\n");
      expect(agentEffort("executor", agents)).toBe("");
    } finally {
      rmSync(agents, { recursive: true, force: true });
    }
  });
});

/**
 * **Briefs reach a fresh planner the way plans reach the executor**
 * (plans/planner-queue.md).
 */
describe("the planner queue", () => {
  const brief = (day: string, extra = "") =>
    `# A topic\n\nBrief for the planner, ${day}, by the assistant with Javi. The planner's plan replaces this file.\n${extra}\n## What was asked\n\nSomething.\n`;
  const ids = {
    p2: "22222222-aaaa-0000-0000-000000000000",
    gone: "99999999-aaaa-0000-0000-000000000000",
    javi: "33333333-aaaa-0000-0000-000000000000",
  };
  const plansDir = () => join(repo, "plans");
  const written: string[] = [];
  const put = (name: string, text: string) => {
    mkdirSync(plansDir(), { recursive: true });
    writeFileSync(join(plansDir(), name), text);
    written.push(join(plansDir(), name));
  };
  afterAll(() => {
    for (const file of written) rmSync(file, { force: true });
  });
  // An executor holds the lock, alive as this process, so a planner's or an
  // assistant's stop in this checkout of ready plans starts none
  // (plans/executor-takes-next-ready-plan.md, part 2); the release puts it back.
  const executorHeld = () => {
    const lock = join(repo, ".claude", "executor.1.lock");
    const before = existsSync(lock) ? readFileSync(lock, "utf8") : null;
    writeFileSync(lock, JSON.stringify({ sessionId: "held", pid: process.pid, released: false }));
    return () => (before === null ? rmSync(lock, { force: true }) : writeFileSync(lock, before));
  };

  // plans/one-assistant-chat.md, parts 1 and 2.
  it(
    "opens the one assistant chat on a built plan or on nothing, sends it the message when open, lists it, and hands it on past its ceiling",
    { timeout: 60_000 },
    () => {
      const live = (rows: object[]) => JSON.stringify(rows);
      const env = (rows: object[] = []) => ({
        ...process.env,
        CLAUDE_PROJECT_DIR: repo,
        CLAUDE_CODE_SESSION_ID: "",
        WORKFLOW_STARTS_LOG: join(repo, ".claude", "starts-assistant.log"),
        WORKFLOW_USAGE_FILE: join(repo, ".claude", "usage-assistant.json"),
        WORKFLOW_LIVE: live(rows),
      });
      const start = (path: string, rows: object[] = []) =>
        execFileSync(
          "node",
          [
            join(here, "plan-queue.mjs"),
            "start",
            "--agent",
            "assistant",
            "--dry",
            ...(path ? [path] : []),
          ],
          { encoding: "utf8", env: env(rows) },
        ).trim();
      put(
        "q-built.md",
        "# Built\n\nPlan only, 31 October 2026, for Javi.\n\n## Built, 31 October 2026\n\nPushed to test as commit 0123abcd.\n",
      );
      put("q-ready-a.md", "# Ready\n\nPlan only, 31 October 2026, for Javi.\n");
      put("q-brief-a.md", brief("31 October 2026"));
      // When none is listed: a chat named Test Assistant, with no number, on Built:.
      const out = start("plans/q-built.md");
      expect(out).toContain(
        'Would run: claude "--bg" "--remote-control" "Test Assistant" "--name" "Test Assistant" "--agent" "workflow:assistant" "--effort" "medium" "Built: plans/q-built.md."',
      );
      expect(out).toContain(JSON.stringify(assistantPrompt("plans/q-built.md")));
      // With no path: the opened prompt.
      expect(start("")).toContain(
        `"--name" "Test Assistant" "--agent" "workflow:assistant" "--effort" "medium" "Opened for Javi by a terminal: nothing is handed over. Say in a line that you are open, and wait for him."`,
      );
      for (const path of ["plans/q-ready-a.md", "plans/q-brief-a.md"])
        expect(start(path)).toBe(`${path} is not a built plan; plans shows the built plans.`);
      // With one listed, idle or busy: the line naming it and the message to send.
      const open = {
        sessionId: "44444444-bbbb-0000-0000-000000000000",
        name: "Test Assistant",
        status: "busy",
        kind: "interactive",
        cwd: repo,
      };
      expect(start("plans/q-built.md", [open])).toBe(
        "Test Assistant [44444444] is open: send it the message. Built: plans/q-built.md.",
      );
      expect(start("", [open])).toBe("Test Assistant [44444444] is open: send it the message.");
      // Not beside another project's, a numbered one, nor another machine's chat.
      for (const row of [
        {
          sessionId: "a2",
          name: "Other Assistant",
          status: "idle",
          kind: "interactive",
          cwd: repo,
        },
        {
          sessionId: "a4",
          name: "Test Assistant 2 (lab)",
          status: "idle",
          kind: "background",
          cwd: repo,
        },
        {
          sessionId: "a3",
          name: "Test Assistant",
          status: "idle",
          kind: "remote-control",
          cwd: repo,
        },
      ])
        expect(start("plans/q-built.md", [row])).toContain("Would run: claude");
      // The line, while the one chat is open.
      const chat = {
        sessionId: "44444444-aaaa-0000-0000-000000000000",
        name: "Test Assistant",
        status: "idle",
        kind: "background",
        cwd: repo,
      };
      expect(listWith([chat])).toMatch(/\nThe assistant: Test Assistant \[44444444\], idle\.\n/);
      expect(listWith([])).not.toContain("The assistant:");
      // A row of the name with no process is no open chat.
      expect(listWith([{ ...chat, status: undefined }])).not.toContain("The assistant:");
      // A quiet stop arms no end timer; past the ceiling the stop is held once,
      // and a later stop with the hand-over written arms it ten minutes on.
      const log = process.env.WORKFLOW_STOP_LOG!;
      rmSync(log, { force: true });
      const releaseHeld = executorHeld();
      const transcript = join(repo, ".claude", "assistant-transcript.jsonl");
      const context = (tokens: number) =>
        writeFileSync(
          transcript,
          `${JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { model: "claude-opus-5-5", usage: { input_tokens: tokens } } })}\n`,
        );
      const hook = (mode: string, extra: object = {}) =>
        execFileSync("node", [join(here, "plan-queue.mjs"), mode], {
          input: JSON.stringify({
            session_id: chat.sessionId,
            agent_type: "workflow:assistant",
            transcript_path: transcript,
            ...extra,
          }),
          encoding: "utf8",
          env: env([chat]),
        });
      const handover = join(plansDir(), "assistant-handover.md");
      rmSync(handover, { force: true });
      try {
        context(40_000);
        expect(hook("stop")).toBe("");
        context(160_000);
        expect(JSON.parse(hook("stop"))).toEqual({
          decision: "block",
          reason:
            'This chat is over its ceiling (160k of 150k): write plans/assistant-handover.md by "Handing the chat on", then stop; a fresh chat takes over once this one is quiet.',
        });
        // Held once: the stop the hold continued into, with nothing written, passes.
        expect(hook("stop", { stop_hook_active: true })).toBe("");
        expect(existsSync(log) ? readFileSync(log, "utf8") : "").not.toContain(chat.sessionId);
        writeFileSync(handover, "# Handing the assistant chat on\n\nOpen: nothing.\n");
        utimesSync(handover, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
        expect(hook("stop")).toBe("");
        const ends = readFileSync(log, "utf8");
        const at = Number(new RegExp(`end ${chat.sessionId} at (\\d+)`).exec(ends)?.[1]);
        expect(at).toBeGreaterThan(Date.now() + 9 * 60_000);
        expect(at).toBeLessThan(Date.now() + 11 * 60_000);
        expect(JSON.parse(readFileSync(stateFile(chat.sessionId), "utf8")).end.at).toBe(at);
        // A heartbeat leaves the timer; his message clears it.
        hook("prompt", { prompt: "Heartbeat." });
        expect(JSON.parse(readFileSync(stateFile(chat.sessionId), "utf8")).end).toBeDefined();
        hook("prompt", { prompt: "Anything new?" });
        expect(JSON.parse(readFileSync(stateFile(chat.sessionId), "utf8")).end).toBeUndefined();
        // The fresh chat's start, on the hand-over file, beside the one it replaces.
        expect(takeOverPrompt("Test Assistant")).toBe(
          "Taking over as Test Assistant: plans/assistant-handover.md.",
        );
        expect(start("plans/assistant-handover.md")).toContain(
          '"Taking over as Test Assistant: plans/assistant-handover.md."',
        );
        // The hand-over file is no plan of the queue's.
        expect(listWith([])).not.toContain("assistant-handover");
        // When the timer fires and no fresh chat would start (paused), the old one stays.
        writeFileSync(
          stateFile(chat.sessionId),
          JSON.stringify({ handing: { at: Date.now() - 20 * 60_000 } }),
        );
        const pause = join(repo, ".claude", "executor.pause");
        writeFileSync(pause, JSON.stringify({ at: "15:00" }));
        const armed = readFileSync(log, "utf8").length;
        try {
          execFileSync(
            "node",
            [join(here, "plan-queue.mjs"), "end", "--timer", String(Date.now()), chat.sessionId],
            { encoding: "utf8", env: env([chat]) },
          );
        } finally {
          rmSync(pause, { force: true });
        }
        expect(readFileSync(log, "utf8").split("\n")).not.toContain(chat.sessionId);
        // The timer is armed again ten minutes on (plans/one-assistant-after-handover.md, part 3).
        const again = Number(
          new RegExp(`end ${chat.sessionId} at (\\d+)`).exec(
            readFileSync(log, "utf8").slice(armed),
          )?.[1],
        );
        expect(again).toBeGreaterThan(Date.now() + 9 * 60_000);
        expect(again).toBeLessThan(Date.now() + 11 * 60_000);
      } finally {
        releaseHeld();
        rmSync(handover, { force: true });
        rmSync(transcript, { force: true });
        rmSync(stateFile(chat.sessionId), { force: true });
      }
      for (const name of ["q-built.md", "q-ready-a.md", "q-brief-a.md"])
        rmSync(join(plansDir(), name), { force: true });
      rmSync(join(repo, ".claude", "handover.told.json"), { force: true });
    },
  );

  // plans/one-assistant-after-handover.md: two rows named Test Assistant, the
  // older handed on, the newer the one the queue addresses.
  const oneChat = () => {
    const log = process.env.WORKFLOW_STOP_LOG!;
    const starts = join(repo, ".claude", "starts-one-chat.log");
    const env = (rows: object[]) => ({
      ...process.env,
      CLAUDE_PROJECT_DIR: repo,
      CLAUDE_CODE_SESSION_ID: "",
      WORKFLOW_STARTS_LOG: starts,
      WORKFLOW_USAGE_FILE: join(repo, ".claude", "usage-one-chat.json"),
      WORKFLOW_LIVE: JSON.stringify(rows),
    });
    // An executor holds the lock, so the sweep after an end starts none.
    const queue = (rows: object[], args: string[], extra: object = {}) => {
      const release = executorHeld();
      try {
        return execFileSync("node", [join(here, "plan-queue.mjs"), ...args], {
          encoding: "utf8",
          env: { ...env(rows), ...extra },
        });
      } finally {
        release();
      }
    };
    const row = (id: string, startedAt: number, status = "idle") => ({
      sessionId: id,
      name: "Test Assistant",
      kind: "background",
      status,
      pid: startedAt,
      startedAt,
      cwd: repo,
    });
    const old = row("81000000-aaaa-0000-0000-000000000000", 1000);
    const fresh = row("82000000-aaaa-0000-0000-000000000000", 2000);
    const lines = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n") : []);
    const startLines = () => (existsSync(starts) ? readFileSync(starts, "utf8").trim() : "");
    const clean = () => {
      for (const one of [old, fresh]) rmSync(stateFile(one.sessionId), { force: true });
      rmSync(log, { force: true });
      rmSync(starts, { force: true });
    };
    return { log, env, queue, row, old, fresh, lines, startLines, clean };
  };

  it("a handed-on assistant chat is ended, with no fresh start, once another is open", () => {
    const { queue, old, fresh, lines, startLines, clean } = oneChat();
    clean();
    try {
      writeFileSync(
        stateFile(old.sessionId),
        JSON.stringify({ agent: "assistant", handing: { at: Date.now() - 20 * 60_000 } }),
      );
      queue([old, fresh], ["end", "--timer", String(Date.now()), old.sessionId]);
      expect(lines()).toContain(old.sessionId);
      expect(lines()).not.toContain(fresh.sessionId);
      expect(lines().some((line) => line.startsWith(`end ${old.sessionId} at `))).toBe(false);
      expect(startLines()).toBe("");
      const state = JSON.parse(readFileSync(stateFile(old.sessionId), "utf8"));
      expect(state.handing).toBeUndefined();
      expect(state.end).toBeUndefined();
      expect(state.agent).toBe("assistant");
      // Its process gone, it is as quiet: ended the same way, not tried again (Codex C4).
      clean();
      writeFileSync(
        stateFile(old.sessionId),
        JSON.stringify({ agent: "assistant", handing: { at: Date.now() - 20 * 60_000 } }),
      );
      const gone = { ...old, pid: undefined, status: undefined };
      queue([gone, fresh], ["end", "--timer", String(Date.now()), old.sessionId]);
      // Nothing to stop (plans/assistant-takeover-never-leaves-none.md), its state cleared.
      expect(lines()).not.toContain(old.sessionId);
      expect(lines().some((line) => line.startsWith(`end ${old.sessionId} at `))).toBe(false);
      const cleared = JSON.parse(readFileSync(stateFile(old.sessionId), "utf8"));
      expect(cleared.handing).toBeUndefined();
      expect(cleared.end).toBeUndefined();
      // The other handed on too: no successor, so the fresh start is tried (paused here) and
      // neither is stopped (/code-review).
      clean();
      const handing = { agent: "assistant", handing: { at: Date.now() - 20 * 60_000 } };
      for (const one of [old, fresh])
        writeFileSync(stateFile(one.sessionId), JSON.stringify(handing));
      const pause = join(repo, ".claude", "executor.pause");
      writeFileSync(pause, JSON.stringify({ at: "15:00" }));
      try {
        queue([old, fresh], ["end", "--timer", String(Date.now()), old.sessionId]);
      } finally {
        rmSync(pause, { force: true });
      }
      expect(lines()).not.toContain(old.sessionId);
      expect(lines().some((line) => line.startsWith(`end ${old.sessionId} at `))).toBe(true);
    } finally {
      clean();
    }
  });

  it("the takeover's timer tries again until the handed-on chat is ended", () => {
    const { queue, row, old, fresh, lines, clean } = oneChat();
    const cases: [string, object[], object][] = [
      ["busy", [row(old.sessionId, 1000, "busy"), fresh], {}],
      [
        "a question open",
        [{ ...row(old.sessionId, 1000, "waiting"), waitingFor: "input needed" }, fresh],
        {},
      ],
      // claude agents cannot be read: a claude whose every call fails.
      ["unread", [], { WORKFLOW_LIVE: "", WORKFLOW_CLAUDE: "/bin/false" }],
    ];
    for (const [what, rows, extra] of cases) {
      clean();
      try {
        writeFileSync(
          stateFile(old.sessionId),
          JSON.stringify({ agent: "assistant", handing: { at: Date.now() - 20 * 60_000 } }),
        );
        queue(rows, ["end", "--timer", String(Date.now()), old.sessionId], extra);
        expect(lines(), what).not.toContain(old.sessionId);
        const at = Number(
          lines()
            .map((line) => new RegExp(`^end ${old.sessionId} at (\\d+)$`).exec(line)?.[1])
            .find(Boolean),
        );
        expect(at, what).toBeGreaterThan(Date.now() + 9 * 60_000);
        expect(at, what).toBeLessThan(Date.now() + 11 * 60_000);
        expect(JSON.parse(readFileSync(stateFile(old.sessionId), "utf8")).end.at, what).toBe(at);
      } finally {
        clean();
      }
    }
  });

  it("no assistant chat is opened when claude agents cannot be read", () => {
    const { queue, startLines, clean } = oneChat();
    const bin = mkdtempSync(join(tmpdir(), "unread-claude-"));
    const script = join(bin, "claude");
    writeFileSync(script, '#!/bin/sh\n[ "$1" = agents ] && exit 1\necho "Started $*"\n');
    chmodSync(script, 0o755);
    clean();
    try {
      expect(
        queue([], ["start", "--agent", "assistant"], {
          WORKFLOW_LIVE: "",
          WORKFLOW_CLAUDE: script,
        })
          .trim()
          .split("\n")
          .at(-1),
      ).toBe(
        "claude agents could not be read, so no assistant chat is opened: start again once plans lists the chats.",
      );
      expect(startLines()).toBe("");
    } finally {
      clean();
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("plans end --now ends an assistant chat named", () => {
    const { queue, old, fresh, lines, clean } = oneChat();
    clean();
    try {
      // Named without --now: refused, pointing to it.
      expect(queue([old, fresh], ["end", "81000000"])).toBe(
        "Not ended: Test Assistant [81000000], it is Javi's one chat: plans end 81000000 --now ends it.\n",
      );
      // Not named: left.
      queue([old, fresh], ["end"]);
      expect(lines()).not.toContain(old.sessionId);
      // Named with --now: stopped, another open.
      expect(queue([old, fresh], ["end", "81000000", "--now"])).toBe(
        "Ended Test Assistant [81000000]: idle.\n",
      );
      expect(lines()).toContain(old.sessionId);
      // The last one: stopped, and the line says none is open.
      expect(queue([fresh], ["end", "82000000", "--now"])).toBe(
        "Ended Test Assistant [82000000]: idle. No assistant chat is open: plans start --agent assistant opens one.\n",
      );
      expect(lines()).toContain(fresh.sessionId);
    } finally {
      clean();
    }
  });

  // plans/assistant-takeover-never-leaves-none.md: a project of its own with a
  // fake claude, no WORKFLOW_LIVE, the old chat handed on twenty minutes ago.
  const takeover = (first: string, claude?: (dir: string) => string) => {
    const dir = fixture("Test");
    withOrigin(dir);
    const script = claude ? claude(dir) : fakeClaude(dir, { status: "idle" });
    if (claude) writeFileSync(join(dir, "rows.json"), "[]");
    const rows = join(dir, "rows.json");
    const log = join(dir, "stops.log");
    const starts = join(dir, ".claude", "starts.log");
    const old = {
      sessionId: `${first}-aaaa-0000-0000-000000000000`,
      name: "Test Assistant",
      kind: "background",
      status: "idle",
      pid: 1000,
      startedAt: 1000,
      cwd: dir,
    };
    const state = stateFile(old.sessionId);
    const handOn = () =>
      writeFileSync(
        state,
        JSON.stringify({ agent: "assistant", handing: { at: Date.now() - 20 * 60_000 } }),
      );
    const queue = (args: string[], extra: Record<string, string> = {}) => {
      const { WORKFLOW_LIVE: _, ...rest } = process.env;
      return execFileSync("node", [join(here, "plan-queue.mjs"), ...args], {
        encoding: "utf8",
        env: {
          ...rest,
          CLAUDE_PROJECT_DIR: dir,
          CLAUDE_CODE_SESSION_ID: "",
          WORKFLOW_CLAUDE: script,
          WORKFLOW_STARTS_LOG: starts,
          WORKFLOW_USAGE_FILE: join(dir, ".claude", "usage.json"),
          WORKFLOW_STOP_LOG: log,
          ...extra,
        },
      });
    };
    const timer = (extra: Record<string, string> = {}) =>
      queue(["end", "--timer", String(Date.now()), old.sessionId], extra);
    const lines = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n") : []);
    const ends = () =>
      lines()
        .map((line) => Number(new RegExp(`^end ${old.sessionId} at (\\d+)$`).exec(line)?.[1]))
        .filter(Boolean);
    const startLines = () =>
      existsSync(starts) ? readFileSync(starts, "utf8").trim().split("\n").filter(Boolean) : [];
    const stateNow = () => JSON.parse(readFileSync(state, "utf8"));
    const clean = () => {
      rmSync(state, { force: true });
      rmSync(dir, { recursive: true, force: true });
    };
    return {
      dir,
      rows,
      old,
      state,
      handOn,
      queue,
      timer,
      lines,
      ends,
      startLines,
      stateNow,
      clean,
    };
  };

  it(
    "a takeover whose launch fails keeps the old chat, and the next timer opens the fresh one",
    { timeout: 60_000 },
    () => {
      const { rows, old, handOn, timer, lines, ends, startLines, stateNow, clean } =
        takeover("83000000");
      try {
        writeFileSync(rows, JSON.stringify([old]));
        handOn();
        timer({ STUB: "untrusted" });
        expect(lines()).not.toContain(old.sessionId);
        expect(ends()).toHaveLength(1);
        expect(ends()[0]).toBeGreaterThan(Date.now() + 9 * 60_000);
        expect(ends()[0]).toBeLessThan(Date.now() + 11 * 60_000);
        expect(startLines()).toEqual([]);
        expect(stateNow().handing).toBeDefined();
        // The next firing, the launch working: the fresh chat open, the old one stopped.
        timer();
        expect(startLines()).toHaveLength(1);
        expect(JSON.parse(startLines()[0]).paths).toEqual(["plans/assistant-handover.md"]);
        expect(lines().filter((line) => line === old.sessionId)).toHaveLength(1);
        expect(stateNow().handing).toBeUndefined();
        expect(stateNow().end).toBeUndefined();
      } finally {
        clean();
      }
    },
  );

  it(
    "a fresh chat confirmed but not listed leaves the old one running",
    { timeout: 60_000 },
    () => {
      // claude --bg's backgrounded line with no row: confirmed, but no other chat is open
      // (Codex C1).
      const { rows, old, handOn, timer, lines, ends, startLines, stateNow, clean } =
        takeover("89000000");
      try {
        writeFileSync(rows, JSON.stringify([old]));
        handOn();
        timer({ STUB: "backgrounded" });
        expect(startLines()).toHaveLength(1);
        expect(lines()).not.toContain(old.sessionId);
        expect(ends()).toHaveLength(1);
        expect(stateNow().handing).toBeDefined();
      } finally {
        clean();
      }
    },
  );

  it(
    "a handed-on chat with no process is replaced, with nothing stopped",
    { timeout: 60_000 },
    () => {
      for (const [what, first, listed] of [
        ["its row with no process", "84000000", true],
        ["no row", "85000000", false],
      ] as const) {
        const { rows, old, handOn, timer, lines, startLines, clean } = takeover(first);
        try {
          const { pid: _pid, status: _status, ...gone } = old;
          writeFileSync(rows, JSON.stringify(listed ? [gone] : []));
          handOn();
          timer();
          expect(startLines(), what).toHaveLength(1);
          expect(lines(), what).not.toContain(old.sessionId);
        } finally {
          clean();
        }
      }
    },
  );

  it("a chat that took a message during the takeover is kept", { timeout: 60_000 }, () => {
    // A claude whose `--bg` adds the fresh row, then marks the old row busy
    // (STUB_DO=busy) or takes his message, the prompt hook clearing `handing`
    // (STUB_DO=message, STUB_STATE the old one's state file).
    const claude = (dir: string) => {
      const script = join(dir, "claude");
      writeFileSync(
        script,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const rows = ${JSON.stringify(join(dir, "rows.json"))};
if (args[0] === "agents") process.stdout.write(fs.readFileSync(rows, "utf8"));
else if (args.includes("--bg")) {
  const name = args[args.indexOf("--name") + 1];
  const all = JSON.parse(fs.readFileSync(rows, "utf8"));
  if (process.env.STUB_DO === "busy") for (const row of all) row.status = "busy";
  if (process.env.STUB_DO === "message") {
    const { handing: _h, ...rest } = JSON.parse(fs.readFileSync(process.env.STUB_STATE, "utf8"));
    fs.writeFileSync(process.env.STUB_STATE, JSON.stringify(rest));
  }
  all.push({ sessionId: "fresh-" + Date.now(), name, kind: "background", status: "idle", pid: 2000, cwd: process.cwd() });
  fs.writeFileSync(rows, JSON.stringify(all));
  console.log("Started " + name);
}
`,
      );
      chmodSync(script, 0o755);
      return script;
    };
    for (const [what, first] of [
      ["busy", "86000000"],
      ["message", "87000000"],
    ] as const) {
      const { rows, old, state, handOn, timer, lines, ends, startLines, stateNow, clean } =
        takeover(first, claude);
      try {
        writeFileSync(rows, JSON.stringify([old]));
        handOn();
        timer({ STUB_DO: what, STUB_STATE: state });
        expect(startLines(), what).toHaveLength(1);
        expect(lines(), what).not.toContain(old.sessionId);
        if (what === "busy") {
          // Busy once the fresh one is up: tried again ten minutes on.
          expect(ends(), what).toHaveLength(1);
          expect(stateNow().handing, what).toBeDefined();
        } else {
          // His message kept it: no timer armed.
          expect(ends(), what).toHaveLength(0);
          expect(stateNow().handing, what).toBeUndefined();
        }
      } finally {
        clean();
      }
    }
  });

  it("an assistant chat is opened beside a row with no process", { timeout: 60_000 }, () => {
    const { rows, old, queue, startLines, clean } = takeover("88000000");
    try {
      const { pid: _pid, status: _status, ...gone } = old;
      writeFileSync(rows, JSON.stringify([gone]));
      const refused = queue(["start", "--agent", "assistant"], { STUB: "untrusted" });
      expect(refused).toContain("Test Assistant was not started: Workspace not trusted.");
      expect(startLines()).toEqual([]);
      expect(queue(["start", "--agent", "assistant"])).toContain(
        "Test Assistant was opened for Javi.",
      );
      expect(startLines()).toHaveLength(1);
    } finally {
      clean();
    }
  });

  it("startedConfirmed reads a start's line", () => {
    const started = "Test Assistant was started on: plans/github/1.md.";
    expect(startedConfirmed(started)).toBe(true);
    expect(startedConfirmed("Test Assistant was opened for Javi.")).toBe(true);
    expect(
      startedConfirmed(
        `${started} claude agents could not be read, so it is not confirmed; its output is in .claude/assistant.1.started.`,
      ),
    ).toBe(false);
    expect(startedConfirmed("Test Assistant [44444444] is open: send it the message.")).toBe(false);
    // A launcher's line quoted in a failed start says nothing of a start (Codex C5).
    expect(
      startedConfirmed(
        "Test Assistant was not started: Workspace not trusted. Run claude in /w/x was opened for y once; its output is in .claude/assistant.1.started.",
      ),
    ).toBe(false);
  });

  // plans/prs-close-their-issues.md, part 5.
  it("an assistant chat opened on a built plan is told once to read a hand-over no chat has read", () => {
    const told = join(repo, ".claude", "handover.told.json");
    const handover = join(plansDir(), "assistant-handover.md");
    const old = "55555555-aaaa-0000-0000-000000000000";
    const fresh = "66666666-aaaa-0000-0000-000000000000";
    const later = "77777777-aaaa-0000-0000-000000000000";
    const hook = (mode: string, sessionId: string, extra: object = {}) => {
      const out = execFileSync("node", [join(here, "plan-queue.mjs"), mode], {
        input: JSON.stringify({
          session_id: sessionId,
          agent_type: "workflow:assistant",
          ...extra,
        }),
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: repo,
          CLAUDE_CODE_SESSION_ID: "",
          WORKFLOW_STARTS_LOG: join(repo, ".claude", "starts-handover.log"),
          WORKFLOW_USAGE_FILE: join(repo, ".claude", "usage-handover.json"),
          WORKFLOW_LIVE: "[]",
        },
      });
      return out ? JSON.parse(out).hookSpecificOutput.additionalContext : "";
    };
    const prompt = (sessionId: string, text: string) => hook("prompt", sessionId, { prompt: text });
    const write = (at: number) => {
      writeFileSync(
        handover,
        "# Handing the assistant chat on\n\nWhen Javi answers, then plan it.\n",
      );
      utimesSync(handover, new Date(at), new Date(at));
      hook("wrote", old, { tool_name: "Write", tool_input: { file_path: handover } });
    };
    const built =
      '<cross-session-message from="uds:/tmp/x.sock" from-name="Executor">\nBuilt: plans/q.md.\n</cross-session-message>';
    mkdirSync(plansDir(), { recursive: true });
    rmSync(told, { force: true });
    try {
      // No file: nothing said.
      rmSync(handover, { force: true });
      expect(prompt(fresh, built)).toBe("");
      const at = new Date(2026, 10, 25, 23, 40).getTime();
      write(at);
      // The writer is never told of its own file.
      expect(prompt(old, "Anything new?")).toBe("");
      // A heartbeat does not spend it.
      expect(prompt(fresh, "Heartbeat.")).not.toContain("assistant-handover");
      // The chat opened on Built: is told once.
      expect(prompt(fresh, built)).toBe(
        'plans/assistant-handover.md was written 25 November 23:40 and no assistant chat has read it since: read it first, by "Staying ready" 4.',
      );
      expect(prompt(fresh, "And now?")).toBe("");
      // A second chat is not told.
      expect(prompt(later, built)).toBe("");
      // Told again after the file is written again, once.
      write(at + 60_000);
      expect(prompt(later, "GitHub: plans/github/4.md.")).toContain(
        "plans/assistant-handover.md was written 25 November 23:41",
      );
      expect(prompt(fresh, "Hello")).toBe("");
      // A chat opened on the file itself is recorded as told, and says nothing.
      write(at + 120_000);
      expect(prompt(later, "Taking over as Test Assistant: plans/assistant-handover.md.")).toBe("");
      expect(JSON.parse(readFileSync(told, "utf8"))).toMatchObject({ told: later });
      expect(prompt(fresh, built)).toBe("");
      // A file from before the record was kept is said once to the chat that speaks next.
      rmSync(told, { force: true });
      // A prompt that only begins as the take-over does is told (Codex C4).
      expect(prompt(old, "Taking over as lead today, Hi")).toContain(
        "plans/assistant-handover.md was written",
      );
      expect(prompt(fresh, "Hi")).toBe("");
      // A hand-over his message made out of date, the writer kept, is said to nobody (/code-review).
      write(at + 180_000);
      writeFileSync(stateFile(old), JSON.stringify({ handing: { at: at + 170_000 } }));
      expect(prompt(old, "Stay, one more thing.")).toBe("");
      expect(prompt(fresh, built)).toBe("");
    } finally {
      rmSync(handover, { force: true });
      rmSync(told, { force: true });
      for (const id of [old, fresh, later]) rmSync(stateFile(id), { force: true });
    }
  });

  // plans/simpler-agents.md, part 3: the agent file carries the workflow.
  describe("a start prompt names the work", () => {
    it("is one line: the path and what it is", () => {
      expect(plannerPrompt("plans/x.md")).toBe("Plan plans/x.md: it is a brief.");
      const plans = [
        { state: "ready", path: "plans/a.md" },
        { state: "ready", path: "plans/b.md" },
      ];
      // plans/parallel-executors.md, part 2: one plan a start.
      expect(startPrompt("plans/a.md", plans)).toBe("Build plans/a.md.");
      expect(startPrompt("plans/x.md", [{ state: "handed", path: "plans/x.md" }])).toBe(
        'Resume plans/x.md from its "Handing over" section.',
      );
      expect(assistantPrompt("plans/x.md")).toBe("Built: plans/x.md.");
      expect(githubPrompt("plans/github/4.md")).toBe("GitHub: plans/github/4.md.");
    });

    it("reads the planner's prompt inside a message's wrapper", () => {
      const wrapped = `<cross-session-message from="uds:/tmp/x.sock" from-name="Assistant">\n${plannerPrompt("plans/x.md")}\n</cross-session-message>`;
      expect(PLANNER_PROMPT.exec(wrapped)?.[1]).toBe("plans/x.md");
    });
  });

  it("has the executor send the Built: message the queue opens the assistant on", () => {
    const executor = readFileSync(join(here, "..", "agents", "executor.md"), "utf8");
    expect(executor.replace(/\s+/g, " ")).toContain(`\`${assistantPrompt("plans/<x>.md")}\``);
  });

  it("reads a brief being planned only while its session lives", () => {
    const text = brief(
      "26 October 2026",
      `\n## Planning, 26 October 2026 10:40, session ${ids.p2}\n`,
    );
    expect(stateOf(text, { live: [ids.p2] })).toMatchObject({
      state: "planning",
      session: ids.p2,
      since: "26 October 2026 10:40",
    });
    expect(stateOf(text, { live: ["other"] })).toMatchObject({ state: "brief", stale: true });
  });

  it("lists the briefs oldest first, and the queue's planner with its question", () => {
    put("q-old-brief.md", brief("24 October 2026"));
    put(
      "q-taken.md",
      brief("25 October 2026", `\n## Planning, 26 October 2026 10:40, session ${ids.p2}\n`),
    );
    put(
      "q-late.md",
      brief("26 October 2026", `\n## Planning, 26 October 2026 09:00, session ${ids.gone}\n`),
    );
    const out = listWith([
      {
        sessionId: ids.p2,
        name: "Planner 2",
        status: "waiting",
        waitingFor: "input needed",
        kind: "background",
        cwd: repo,
      },
      { sessionId: ids.javi, name: "Planner", status: "busy", kind: "interactive", cwd: repo },
    ]);
    expect(out).toMatch(
      /\nThe planner: Planner 2 \[22222222\], waiting for input, planning plans\/q-taken\.md\.\n/,
    );
    expect(out).not.toContain("33333333");
    const group = out.slice(out.indexOf("Briefs, oldest first"));
    expect(group.indexOf("q-old-brief.md")).toBeLessThan(group.indexOf("q-taken.md"));
    expect(group.indexOf("q-taken.md")).toBeLessThan(group.indexOf("q-late.md"));
    expect(group).toMatch(/q-old-brief\.md +brief, 24 October/);
    expect(group).toMatch(/q-taken\.md +Planner 2, since 26 October 2026 10:40/);
    expect(group).toMatch(
      /q-late\.md +brief, 26 October \(a Planning line from a session that is gone\)/,
    );
  });

  it("says none alive with no planner of the queue's", () => {
    expect(listWith([])).toMatch(/\nThe planner: none alive\.\n/);
  });

  it("names planners by their own count and refuses only beside an executor", () => {
    const log = [{ at: 0, name: "Executor 7" }];
    expect(canStart({ kind: "planner", log })).toMatchObject({ start: true, name: "Planner 1" });
    expect(canStart({ log })).toMatchObject({ start: true, name: "Executor 8" });
    const planner = {
      kind: "planner" as const,
      sessionId: "33330000-0000-0000-0000-000000000000",
      id: "",
      name: "Planner 3",
      status: "busy",
      where: "checkout",
      branch: "",
      holdsLock: false,
      retired: false,
      on: "plans/x.md",
    };
    // plans/briefs-reach-a-free-planner.md, part 2: a busy planner with room
    // takes the brief at its Stop hook, and nothing is sent.
    const now = Date.UTC(2026, 10, 6, 4, 25);
    const until = new Date(now + 30 * 60_000).toTimeString().slice(0, 5);
    expect(
      canStart({ kind: "planner", sessions: [planner], brief: "plans/next.md", now }),
    ).toMatchObject({
      wait: true,
      why: `Planner 3 [33330000] is busy, planning plans/x.md, with room for plans/next.md (no context known): its Stop hook names the next brief waiting, so nothing is sent. It has until ${until} to take it; then a fresh planner is started on it.`,
    });
    // An executor's lock does not hold a planner back.
    expect(
      canStart({ kind: "planner", lock: { sessionId: "e", released: false } as never }),
    ).toMatchObject({ start: true });
  });

  it("counts only planner starts for a planner's quick-death rule", () => {
    const now = Date.now();
    const log = [
      { at: now - 60_000, name: "Planner 2" },
      { at: now - 30_000, name: "Executor 9" },
    ];
    expect(canStart({ kind: "planner", log, now })).toMatchObject({ refuse: true });
    expect(canStart({ kind: "planner", log, now })).toMatchObject({
      why: expect.stringContaining("The last planner (Planner 2)"),
    });
    expect(canStart({ log: [{ at: now - 60_000, name: "Planner 2" }], now })).toMatchObject({
      start: true,
    });
  });

  it("starts a planner on the oldest brief at high effort, or says nothing waits", () => {
    const agents = join(repo, ".claude", "agents");
    mkdirSync(agents, { recursive: true });
    const env = {
      ...process.env,
      CLAUDE_PROJECT_DIR: repo,
      WORKFLOW_STARTS_LOG: join(repo, ".claude", "starts-planner.log"),
      WORKFLOW_USAGE_FILE: join(repo, ".claude", "usage.json"),
    };
    const dry = () =>
      execFileSync("node", [join(here, "plan-queue.mjs"), "start", "--agent", "planner", "--dry"], {
        encoding: "utf8",
        env,
      });
    try {
      writeFileSync(join(agents, "planner.md"), "---\nname: planner\neffort: high\n---\n\nBody.\n");
      put("q-old-brief.md", brief("24 October 2026"));
      const out = dry();
      expect(out).toContain('"--agent" "workflow:planner" "--effort" "high"');
      expect(out).toContain('"--bg" "--name" "Test Planner 1 (lab)"');
      expect(out).not.toContain('"--remote-control"');
      expect(out).toContain(JSON.stringify(plannerPrompt("plans/q-old-brief.md")));
      for (const name of ["q-old-brief.md", "q-taken.md", "q-late.md"])
        rmSync(join(plansDir(), name), { force: true });
      expect(dry().trim()).toBe("Nothing is waiting in the queue.");
      put("q-ready.md", "# Ready\n\nPlan only, 26 October 2026, for Javi.\n");
      const onPlan = execFileSync(
        "node",
        [join(here, "plan-queue.mjs"), "start", "--agent", "planner", "--dry", "plans/q-ready.md"],
        { encoding: "utf8", env },
      );
      expect(onPlan.trim()).toBe(
        "plans/q-ready.md is not a brief waiting for a planner; plans shows the briefs.",
      );
    } finally {
      rmSync(agents, { recursive: true, force: true });
    }
  });

  // plans/planner-continues.md, part 2: the executor's rule, for briefs.
  it("keeps a planner under its ceiling on the oldest waiting brief, one over it for a brief that shares nothing on the oldest it has room for, and retires a tired one", () => {
    const now = Date.now();
    const usage = (k: number) => ({ context: k * 1000, at: now });
    // A planner here: fresh start 35k, 70 turns, Fable (plans/adaptive-reuse.md).
    const inputs = {
      planner: { sessions: 21, start: 35_000, turns: 70, model: "claude-fable-5-1" },
    };
    const older = { path: "plans/older.md", shared: 0 };
    const newer = { path: "plans/newer.md", shared: 100_000 };
    expect(decidePlannerStop({ waiting: [older, newer] })).toMatchObject({
      refuse: true,
      told: ["plans/older.md"],
    });
    expect((decidePlannerStop({ waiting: [older, newer] }) as { reason: string }).reason).toContain(
      "A brief is waiting and this session can take it: plans/older.md (no context known).",
    );
    expect(
      decidePlannerStop({ waiting: [older, newer], usage: usage(200), now, inputs }),
    ).toMatchObject({ refuse: true, told: ["plans/newer.md"] });
    expect(decidePlannerStop({ waiting: [older], usage: usage(200), now, inputs })).toMatchObject({
      retire: true,
      why: expect.stringContaining("over the ceiling of 75k worked out here"),
    });
    expect(
      decidePlannerStop({ waiting: [older, newer], usage: usage(500), now, inputs }),
    ).toMatchObject({ retire: true });
    // Nothing waiting: alive, idle and unretired.
    expect(decidePlannerStop({ waiting: [] })).toBeNull();
    expect(decidePlannerStop({ waiting: [older], current: { path: "plans/x.md" } })).toBeNull();
    expect(decidePlannerStop({ waiting: [older], paused: true })).toBeNull();
    expect(decidePlannerStop({ waiting: [older], retired: true })).toBeNull();
    // A brief named once and not taken goes to a fresh planner at the next Stop.
    expect(decidePlannerStop({ waiting: [older], told: ["plans/older.md"] })).toEqual({
      retire: true,
      declined: true,
    });
  });

  // plans/collaborating-when-claude-writes-the-code.md, part 2.
  it("tells a planner what the brief it is handed looks related to, once", () => {
    const dir = mkdtempSync(join(tmpdir(), "planner-related-"));
    const id = `planner-related-${process.pid}`;
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      mkdirSync(join(dir, ".claude"), { recursive: true });
      mkdirSync(join(dir, "plans"), { recursive: true });
      writeFileSync(
        join(dir, ".claude", "workflow.md"),
        "---\nname: Rel\nbranch: test\nland: pull-request\n---\n",
      );
      writeFileSync(
        join(dir, "plans", "b.md"),
        brief("30 October 2026", "\nWhere to look: scripts/plan-queue.mjs.\n"),
      );
      // A plan of this queue's own holds topic shown, #24's head branch.
      writeFileSync(
        join(dir, "plans", "mine.md"),
        "# Mine\n\nPlan only, 30 October 2026, for Javi.\n\nLands: topic shown.\n\n## What was asked\n",
      );
      const bin = join(dir, ".bin");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "gh"),
        `#!/bin/sh\n[ -e "$(dirname "$0")/gh.off" ] && exit 1\necho '[{"number":31,"title":"Pictures kept","author":{"login":"anton"},"headRefName":"pictures","files":[{"path":"plugins/workflow/scripts/plan-queue.mjs"}]},{"number":24,"title":"Shown","author":{"login":"javi"},"headRefName":"shown","files":[{"path":"plugins/workflow/scripts/plan-queue.mjs"}]}]'\n`,
      );
      chmodSync(join(bin, "gh"), 0o755);
      const prompt = (text: string) =>
        execFileSync("node", [join(here, "plan-queue.mjs"), "prompt"], {
          input: JSON.stringify({ session_id: id, agent_type: "planner", prompt: text }),
          encoding: "utf8",
          env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: dir,
            WORKFLOW_LIVE: "[]",
            PATH: `${bin}:${process.env.PATH}`,
          },
        });
      // `gh` unread: nothing said, and the brief is looked up again on its next prompt.
      writeFileSync(join(bin, "gh.off"), "");
      expect(prompt(plannerPrompt("plans/b.md"))).not.toContain("The brief looks related to:");
      rmSync(join(bin, "gh.off"));
      const first = prompt(plannerPrompt("plans/b.md"));
      expect(first).toContain(
        'The brief looks related to:\\nlooks related to #31 \\"Pictures kept\\" (anton; both name plugins/workflow/scripts/plan-queue.mjs)',
      );
      // The queue's own pull request names its topic, which a `Lands` line needs to land in it.
      expect(first).toContain(
        'looks related to #24 \\"Shown\\" (this queue\'s, plans/mine.md, topic shown; both name plugins/workflow/scripts/plan-queue.mjs)',
      );
      // The table in the context reads nothing: the line is the brief's only.
      expect(first.match(/looks related to #31/g)).toHaveLength(1);
      expect(prompt(plannerPrompt("plans/b.md"))).not.toContain("The brief looks related to:");
      expect(prompt("How is it going?")).not.toContain("The brief looks related to:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stateFile(id), { force: true });
    }
  });

  it("a brief's paths take plans/ and .claude/; the executor's rule does not", () => {
    const own = "Read `scripts/hooks/plan-queue.mjs` and `.claude/agents/planner.md`.";
    expect(briefPaths(own)).toEqual(["scripts/hooks/plan-queue.mjs", ".claude/agents/planner.md"]);
    // A root file by its bare name (plans/shared-count-fixes.md, part 2); a
    // number or an abbreviation is not a name.
    expect(briefPaths("Read CLAUDE.md and README.md, e.g. the rules in 5.1.")).toEqual([
      "CLAUDE.md",
      "README.md",
    ]);
    // A root name of more than one dot, or a dotfile, whole (/code-review).
    expect(briefPaths("See vitest.config.ts, .mcp.json and tsconfig.base.json.")).toEqual([
      "vitest.config.ts",
      ".mcp.json",
      "tsconfig.base.json",
    ]);
    // The executor's rule stays narrow: plans/ and .claude/ are not its paths.
    expect(pathsIn("plans/a.md and .claude/agents/planner.md")).toEqual([]);
  });

  it("says what a planner holds", () => {
    const one = {
      kind: "planner" as const,
      sessionId: "53593045-0000",
      id: "",
      name: "Planner 7",
      status: "busy",
      where: "checkout",
      branch: "",
      holdsLock: false,
      retired: false,
      on: "plans/x.md",
      holds: ["plans/a.md", "plans/b.md"],
    };
    expect(describeSession(one)).toBe(
      "Planner 7 [53593045], busy, planning plans/x.md, holds plans/a.md and plans/b.md",
    );
    expect(describeSession({ ...one, on: "", holds: ["plans/a.md"] })).toBe(
      "Planner 7 [53593045], busy, holds plans/a.md",
    );
    expect(describeSession({ ...one, retired: true, status: "idle" })).toBe(
      "Planner 7 [53593045], idle, retired, its plans plans/a.md and plans/b.md",
    );
    expect(describeSession({ ...one, retired: true, holds: ["plans/a.md"] })).toBe(
      "Planner 7 [53593045], busy, retired, its plan plans/a.md",
    );
  });

  // plans/planner-open-decisions.md: a retired planner keeps one write.
  it("lets a retired planner edit its own plan and its sketch folder, and nothing else", () => {
    const base = "/repo";
    const may = (toolName: string, filePath: string, brief = "plans/x.md") =>
      plannerMayEdit({ plans: brief ? [brief] : [], toolName, filePath, base });
    // plans/planner-continues.md, part 5: any plan the planner wrote.
    const plans = ["plans/a.md", "plans/b.md"];
    expect(plannerMayEdit({ plans, toolName: "Edit", filePath: "plans/b.md", base })).toBe(true);
    expect(plannerMayEdit({ plans, toolName: "Write", filePath: "plans/a/s.svg", base })).toBe(
      true,
    );
    expect(plannerMayEdit({ plans, toolName: "Edit", filePath: "plans/c.md", base })).toBe(false);
    expect(may("Edit", "plans/x.md")).toBe(true);
    expect(may("Edit", "/repo/plans/x.md")).toBe(true);
    expect(may("Write", "plans/x/sketch.md")).toBe(true);
    expect(may("MultiEdit", "/repo/plans/x/a/b.svg")).toBe(true);
    expect(may("Edit", "plans/y.md")).toBe(false);
    expect(may("Edit", "plans/x.md.bak")).toBe(false);
    expect(may("Edit", "plans/xy/sketch.md")).toBe(false);
    expect(may("Edit", "docs/editor.md")).toBe(false);
    expect(may("Edit", "plans/x.md", "")).toBe(false);
    expect(may("Bash", "plans/x.md")).toBe(false);
  });

  // plans/no-agent-marks-ready.md: only the owner marks a pull request ready, on GitHub.
  it("refuses every session's `gh pr ready` without `--undo`, and no quoted mention of it", () => {
    for (const command of [
      "gh pr ready 12",
      "cd x && gh pr ready 12",
      // Compound commands, wrappers, a continued line and a comment (Codex, /code-review).
      "(gh pr ready 12)",
      "if true; then gh pr ready 12; fi",
      "for n in 12 13; do gh pr ready $n; done",
      "echo $(gh pr ready 12)",
      "env gh pr ready 12",
      "/usr/bin/gh pr ready 12",
      "gh pr \\\nready 12",
      "gh pr ready 12 # --undo is only for reverting",
      "cat > body.md <<EOF\nit's done\nEOF\ngh pr ready 12",
      "gh api graphql -f query='mutation{markPullRequestReadyForReview(input:{}){clientMutationId}}'",
    ])
      expect(marksReady(command), command).toBe(true);
    for (const command of [
      "gh pr ready 12 --undo",
      "gh pr ready 12 --undo=true",
      'git commit -m "never gh pr ready"',
      "gh pr view 12",
      "cat <<'EOF'\ngh pr ready 12\nEOF",
    ])
      expect(marksReady(command), command).toBe(false);
    const tool = (agent_type: string, command: string) =>
      run(join(here, "plan-queue.mjs"), ["tool"], {
        session_id: `ready-${agent_type}-${process.pid}`,
        agent_type,
        tool_name: "Bash",
        tool_input: { command },
      });
    for (const agent of ["executor", "assistant", "planner"]) {
      const refused = tool(agent, "cd x && gh pr ready 12");
      expect(refused).toContain('"permissionDecision":"deny"');
      expect(refused).toContain(
        "Marking a pull request ready for review is its owner's step on GitHub (the Ready for review button), never an agent's.",
      );
      expect(tool(agent, "gh pr ready 12 --undo")).not.toContain('"permissionDecision":"deny"');
    }
  });

  it("refuses a retired planner every write but an Edit of its own plan", () => {
    const id = `retired-planner-${process.pid}`;
    mkdirSync(join(repo, "plans"), { recursive: true });
    writeFileSync(
      join(repo, "plans", "late.md"),
      "# Late\n\nPlan only, 26 October 2026, for Javi.\n\n## Decisions for Javi\n\n1. **One.**\n",
    );
    const retire = (planned: boolean) =>
      writeFileSync(
        stateFile(id),
        JSON.stringify({
          agent: "planner",
          brief: "plans/late.md",
          retired: true,
          plans: planned ? ["plans/late.md"] : [],
        }),
      );
    retire(true);
    const tool = (tool_name: string, tool_input: object) =>
      run(join(here, "plan-queue.mjs"), ["tool"], {
        session_id: id,
        agent_type: "planner",
        tool_name,
        tool_input,
      });
    try {
      expect(tool("Edit", { file_path: join(repo, "plans", "late.md") })).toBe("");
      const other = tool("Edit", { file_path: join(repo, "plans", "other.md") });
      expect(other).toContain('"permissionDecision":"deny"');
      expect(other).toContain(
        "Only its own plan, plans/late.md, and its sketch folder may still be edited, until an executor starts it.",
      );
      const heredoc = tool("Bash", { command: "cat >> plans/late.md <<'EOF'\nDecided\nEOF" });
      expect(heredoc).toContain('"permissionDecision":"deny"');
      // Retired at a usage limit with the brief unfinished: the next
      // planner's plan is not this session's to write, even once it is a plan.
      retire(false);
      expect(tool("Edit", { file_path: join(repo, "plans", "late.md") })).toContain(
        '"permissionDecision":"deny"',
      );
      // plans/planner-talks-until-built.md: once an executor writes its
      // Building line, the plan is its, retired planner or not.
      retire(true);
      writeFileSync(
        join(repo, "plans", "late.md"),
        "# Late\n\n## Building, 26 October 2026, session abcdef12-0000\n\nPlan only, 26 October 2026, for Javi.\n",
      );
      const taken = tool("Edit", { file_path: join(repo, "plans", "late.md") });
      expect(taken).toContain('"permissionDecision":"deny"');
      expect(taken).toContain("the plan is the executor's now");
      expect(taken).toContain("plans/late.md was taken by session abcdef12 on 26 October 2026");
      // The state and the rule's heading in the agent file, nothing restated.
      expect(taken).toContain('(your agent file, \\"A change to a taken plan\\")');
      expect(taken).not.toContain("For the assistant's chat");
      writeFileSync(
        stateFile(id),
        JSON.stringify({ agent: "planner", brief: "plans/late.md", retired: false }),
      );
      const live = tool("Edit", { file_path: join(repo, "plans", "late.md") });
      expect(live).toContain("the plan is the executor's now");
      expect(live).toContain('(your agent file, \\"A change to a taken plan\\")');
      expect(live).not.toContain("For the assistant's chat");
    } finally {
      rmSync(stateFile(id), { force: true });
    }
  });

  it("refuses a retired planner that wrote no plan in one sentence", () => {
    const id = `retired-planner-none-${process.pid}`;
    writeFileSync(
      stateFile(id),
      JSON.stringify({ agent: "planner", brief: "plans/cut-off.md", retired: true, plans: [] }),
    );
    try {
      const out = run(join(here, "plan-queue.mjs"), ["tool"], {
        session_id: id,
        agent_type: "planner",
        tool_name: "Edit",
        tool_input: { file_path: join(repo, "plans", "cut-off.md") },
      });
      expect(JSON.parse(out).hookSpecificOutput.permissionDecisionReason).toBe(
        "This session is retired: its plans are in the queue. Do not plan again; say so, and stop.",
      );
    } finally {
      rmSync(stateFile(id), { force: true });
    }
  });

  it("lets a planner edit any plan it wrote and its sketch folders, and refuses the taken one only", () => {
    const id = `two-plans-${process.pid}`;
    mkdirSync(join(repo, "plans"), { recursive: true });
    put("mine.md", "# Mine\n\nPlan only, 27 October 2026, for Javi.\n");
    put(
      "gone-to-build.md",
      "# Gone\n\n## Building, 27 October 2026, session abcdef12-0000\n\nPlan only, 27 October 2026, for Javi.\n",
    );
    const tool = (file: string) =>
      run(join(here, "plan-queue.mjs"), ["tool"], {
        session_id: id,
        agent_type: "planner",
        tool_name: "Edit",
        tool_input: { file_path: join(repo, "plans", file) },
      });
    try {
      for (const retired of [false, true]) {
        writeFileSync(
          stateFile(id),
          JSON.stringify({
            agent: "planner",
            retired,
            plans: ["plans/mine.md", "plans/gone-to-build.md"],
          }),
        );
        expect(tool("mine.md")).toBe("");
        expect(tool("mine/sketch.svg")).toBe("");
        expect(tool("gone-to-build.md")).toContain("the plan is the executor's now");
      }
      expect(tool("someone-else.md")).toContain(
        "Only its own plans, plans/mine.md and plans/gone-to-build.md, and their sketch folders",
      );
      // A follow-up the planner writes itself joins its own plans as it is written.
      writeFileSync(
        stateFile(id),
        JSON.stringify({ agent: "planner", retired: false, plans: ["plans/gone-to-build.md"] }),
      );
      const write = run(join(here, "plan-queue.mjs"), ["tool"], {
        session_id: id,
        agent_type: "planner",
        tool_name: "Write",
        tool_input: {
          file_path: join(repo, "plans", "gone-to-build-follow-up.md"),
          content: "# More\n\nPlan only, 30 October 2026, for Javi.\n",
        },
      });
      expect(write).toBe("");
      expect(JSON.parse(readFileSync(stateFile(id), "utf8")).plans).toEqual([
        "plans/gone-to-build.md",
        "plans/gone-to-build-follow-up.md",
      ]);
      expect(tool("gone-to-build.md")).toContain(
        '(your agent file, \\"A change to a taken plan\\")',
      );
    } finally {
      rmSync(stateFile(id), { force: true });
    }
  });

  // Codex, 27 October: the brief named at Stop is the one in hand, so its plan joins the list.
  it("records the plan a planner writes over the brief its Stop hook named", () => {
    const id = `continuing-${process.pid}`;
    put("first-plan.md", "# First\n\nPlan only, 27 October 2026, for Javi.\n");
    put("next-brief.md", brief("27 October 2026"));
    writeFileSync(
      stateFile(id),
      JSON.stringify({ agent: "planner", brief: "plans/first-plan.md", plans: [] }),
    );
    const env = {
      WORKFLOW_LIVE: JSON.stringify([
        { sessionId: id, name: "Planner 9", kind: "background", cwd: repo },
      ]),
    };
    const stop = () =>
      run(join(here, "plan-queue.mjs"), ["stop"], { session_id: id, agent_type: "planner" }, env);
    const releaseHeld = executorHeld();
    try {
      const said = stop();
      expect(said).toContain('"decision":"block"');
      const named = /can take it: (plans\/[^\s]+\.md) \(/.exec(said)![1];
      let state = JSON.parse(readFileSync(stateFile(id), "utf8"));
      expect(state.plans).toEqual(["plans/first-plan.md"]);
      expect(state.brief).toBe(named);
      // The plan is written over the brief, its Planning line gone, before the next Stop.
      writeFileSync(join(repo, named), "# Next\n\nPlan only, 27 October 2026, for Javi.\n");
      stop();
      state = JSON.parse(readFileSync(stateFile(id), "utf8"));
      expect(state.plans).toEqual(["plans/first-plan.md", named]);
    } finally {
      releaseHeld();
      rmSync(stateFile(id), { force: true });
    }
  });

  // plans/brief-lease-per-brief.md, part 3: two planners never plan one brief.
  it("never names at a stop a brief sent by message to another live planner, and names it at the holder's", () => {
    const id = `stopping-${process.pid}`;
    const holder = `holding-${process.pid}`;
    const files = [id, holder].map((one) => stateFile(one));
    const deferred = join(repo, ".claude", "handed.deferred");
    put("own-plan.md", "# Own\n\nPlan only, 6 November 2026, for Javi.\n");
    put("sent-brief.md", brief("6 November 2026"));
    const fresh = () => {
      for (const file of files)
        writeFileSync(
          file,
          JSON.stringify({ agent: "planner", brief: "plans/own-plan.md", plans: [] }),
        );
    };
    const env = {
      WORKFLOW_LIVE: JSON.stringify([
        { sessionId: id, name: "Planner 9", kind: "background", cwd: repo },
        { sessionId: holder, name: "Planner 10", kind: "background", cwd: repo },
      ]),
    };
    const stop = (session: string) =>
      run(
        join(here, "plan-queue.mjs"),
        ["stop"],
        { session_id: session, agent_type: "planner" },
        env,
      );
    const named = (said: string) => /can take it: (plans\/[^\s]+\.md) \(/.exec(said)?.[1] || "";
    const releaseHeld = executorHeld();
    try {
      fresh();
      const first = named(stop(id));
      expect(first).not.toBe("");
      // The brief it would name is sent by message to the other planner.
      writeFileSync(
        deferred,
        JSON.stringify({
          until: Date.now() + ANSWER_WINDOW,
          pid: null,
          paths: [first],
          leases: {
            [first]: {
              until: Date.now() + ANSWER_WINDOW,
              why: "handed to Planner 10 [holding-] at 10:25 by message",
              holder,
              held: true,
            },
          },
        }),
      );
      fresh();
      expect(named(stop(id))).not.toBe(first);
      // The planner it was sent to takes it.
      fresh();
      expect(named(stop(holder))).toBe(first);
    } finally {
      releaseHeld();
      for (const file of [...files, deferred]) rmSync(file, { force: true });
    }
  });

  it("says a plan is taken by a Building, Built, Handing over or Resumed line", () => {
    const head = "# X\n\nPlan only, 26 October 2026, for Javi.\n\n";
    expect(planTaken(`# X\n\n## Building, 26 October 2026, session a\n\n${head}`)).toBe(true);
    expect(planTaken(`${head}## Built, 26 October 2026\n\nCommit 1234abcd.\n`)).toBe(true);
    expect(planTaken(`# X\n\n## Handing over, 26 October 2026\n\nStep in hand: 2\n`)).toBe(true);
    expect(planTaken(`# X\n\n## Resumed, 26 October 2026, session a, at step 2\n`)).toBe(true);
    expect(planTaken(head)).toBe(false);
    // Every plan has its own "Building it" section, which is not an executor's line.
    expect(planTaken(`${head}## Building it\n\nOne branch.\n\n## Built-in parts\n`)).toBe(false);
    expect(planTaken("# B\n\nBrief for the planner, 26 October 2026.\n")).toBe(false);
    expect(planTaken("")).toBe(false);
  });

  it("names who took a plan: the live executor, the session, or the built commit", () => {
    const building = "# X\n\n## Building, 26 October 2026, session b92bfc2b-9684\n";
    const live = [{ sessionId: "b92bfc2b-9684", name: "Executor 5" }];
    expect(whoTook(building, live)).toBe("Executor 5 [b92bfc2b] on 26 October 2026");
    expect(whoTook(building, [])).toBe("session b92bfc2b on 26 October 2026");
    // plans/short-session-id-is-live.md: a short line names the live executor too.
    const short = "# X\n\n## Building, 26 October 2026, session b92bfc2b\n";
    expect(whoTook(short, live)).toBe("Executor 5 [b92bfc2b] on 26 October 2026");
    expect(
      whoTook(
        "# X\n\nPlan only, 26 October 2026, for Javi.\n\n## Built, 26 October 2026\n\nBranch x, commit 1234abcd on `test`.\n",
      ),
    ).toBe("built, commit 1234abcd");
    expect(whoTook("# X\n\nPlan only, 26 October 2026.\n")).toBe("");
    expect(
      whoTook(
        "# X\n\nPlan only, 26 October 2026, for Javi.\n\n## Built, 28 October 2026\n\nPull request #21 (https://github.com/o/r/pull/21) to test from branch x, commit 61c4a812; open.\n",
      ),
    ).toBe("built, pull request #21");
    // plans/pull-requests-by-topic.md: a fix pushed straight, and a topic waiting.
    const head = "# X\n\nPlan only, 30 October 2026, for Javi.\n\n## Built, 30 October 2026\n\n";
    expect(
      whoTook(`${head}Pushed straight to test as a fix, commit 61c4a812; checks.yml green.\n`),
    ).toBe("built, straight to test");
    // The branch the Built line names, not the project file's today.
    expect(
      whoTook(`${head}Pushed straight to main as a fix, commit 61c4a812; no run to read.\n`),
    ).toBe("built, straight to main");
    expect(
      whoTook(
        `${head}On topic pictures, commit 61c4a812, branch pushed; its pull request waits.\n`,
      ),
    ).toBe("built, on topic pictures");
  });

  it("tells a planner where each of its plans stands", () => {
    const head = "# X\n\nPlan only, 26 October 2026, for Javi.\n";
    const texts: Record<string, string> = {
      "plans/own.md": head,
      "plans/taken.md": `# X\n\n## Building, 26 October 2026, session abcdef12\n${head}`,
      "plans/built.md": `${head}\n## Built, 26 October 2026\n\nCommit 1234abcd.\n`,
      "plans/dropped.md": `${head}\n## Dropped, 30 October 2026\n\nDropped on Javi's word: #31 already decides it.\n`,
      "plans/gone.md": "",
    };
    const said = plannerContext(
      { plans: Object.keys(texts), retired: false },
      null,
      (path) => texts[path],
    );
    // plans/simpler-agents.md, part 3: one line per plan, the state alone.
    const lines = said.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines).toContain("plans/own.md is in the queue and still yours.");
    expect(lines).toContain(
      "plans/taken.md was taken by session abcdef12 on 26 October 2026: it is the executor's.",
    );
    expect(said).toContain("plans/built.md is built, commit 1234abcd");
    expect(lines).toContain("plans/dropped.md is dropped (30 October 2026): nothing to build.");
    expect(lines).toContain("plans/gone.md is no longer in plans/.");
    for (const line of lines) expect(line.length).toBeLessThan(160);
    expect(said).not.toContain("This session may take the next brief");
    expect(said).not.toContain("a follow-up plan you write yourself");
    const retired = plannerContext({ plans: ["plans/own.md"], retired: true }, null, () => head);
    expect(retired).toBe(
      "plans/own.md is in the queue and still yours.\nThis session is retired: it plans nothing more.",
    );
  });

  // plans/agents-pass-messages-directly.md: the follow-up a planner writes itself is its own.
  it("adds a new plan a planner writes to its own, never a brief and never when retired", () => {
    const plan = "# Y\n\nPlan only, 30 October 2026, for Javi; the executor builds it.\n";
    const brief = "# Z\n\nBrief for the planner, 30 October 2026, by the assistant with Javi.\n";
    const state = { plans: ["plans/x.md"], brief: "", retired: false };
    expect(noteWritten(state, "plans/x-follow-up.md", plan)).toMatchObject({
      plans: ["plans/x.md", "plans/x-follow-up.md"],
    });
    expect(noteWritten(state, "plans/z.md", brief)).toBe(state);
    expect(noteWritten(state, "plans/x.md", plan)).toBe(state);
    expect(noteWritten(state, "", plan)).toBe(state);
    const retired = { ...state, retired: true };
    expect(noteWritten(retired, "plans/x-follow-up.md", plan)).toBe(retired);
  });

  it("stops the queue's retired planner of a taken plan, and no other chat", () => {
    const live = [
      { sessionId: "p2", name: "Planner 2", kind: "background" },
      { sessionId: "p4", name: "Planner 4", kind: "background" },
      { sessionId: "pj", name: "Planner", kind: "interactive" },
    ];
    const states: Record<string, object> = {
      p2: { agent: "planner", retired: true, plans: ["plans/x.md"] },
      p4: { agent: "planner", retired: true, plans: ["plans/y.md"] },
      pj: { agent: "planner", retired: true, plans: ["plans/x.md"] },
    };
    const stopped: string[] = [];
    const written: Record<string, { stopAsked?: number }> = {};
    const options = {
      stateFor: (id: string) => ({ ...states[id], ...written[id] }),
      stop: (id: string) => stopped.push(id),
      write: (path: string, value: object) => {
        written[basename(path).replace(/^workflow-queue-|\.json$/g, "")] = value;
      },
      now: 1_000_000,
    };
    stopPlannersOn("plans/x.md", live, options);
    expect(stopped).toEqual(["p2"]);
    // Asked once: the executor's sweep on its next stop does not ask again.
    stopPlannersOn("plans/x.md", live, options);
    expect(stopped).toEqual(["p2"]);
  });

  it("stops a retired planner only when every plan of its own is taken", () => {
    const live = [{ sessionId: "p7", name: "Planner 7", kind: "background" }];
    const taken = "# A\n\n## Building, 27 October 2026, session e\n";
    const own = "# B\n\nPlan only, 27 October 2026.\n";
    const run = (state: object, b: string) => {
      const stopped: string[] = [];
      stopPlannersOn("plans/a.md", live, {
        stateFor: () => state as never,
        textOf: (path: string) => (path === "plans/a.md" ? taken : b),
        stop: (id: string) => stopped.push(id),
        write: () => {},
        now: 1,
      });
      return stopped;
    };
    const two = { agent: "planner", plans: ["plans/a.md", "plans/b.md"] };
    expect(run({ ...two, retired: true }, own)).toEqual([]);
    expect(run({ ...two, retired: true }, taken)).toEqual(["p7"]);
    // plans/dropped-plan-state.md: a plan dropped on Javi's word is done with, as a taken one is.
    const dropped = `${own}\n## Dropped, 30 October 2026\n\nDropped on Javi's word: #31 already decides it.\n`;
    expect(run({ ...two, retired: true }, dropped)).toEqual(["p7"]);
    const sweep: string[] = [];
    stopTakenPlanners(live, {
      stateFor: () => ({ ...two, retired: true }) as never,
      textOf: (path: string) => (path === "plans/a.md" ? dropped : taken),
      stop: (id: string) => sweep.push(id),
      write: () => {},
      now: 1,
    });
    expect(sweep).toEqual(["p7"]);
    // An unretired planner is the warm context the next brief goes to.
    expect(run({ ...two, retired: false }, taken)).toEqual([]);
  });

  it("stops the retired planners when the next planner starts, and no one else", () => {
    const live = [
      { sessionId: "r1", name: "Planner 2", kind: "background" },
      { sessionId: "r2", name: "Planner 3", kind: "background" },
      { sessionId: "a1", name: "Planner 4", kind: "background" },
      { sessionId: "j1", name: "Planner", kind: "interactive" },
    ];
    const states: Record<string, object> = {
      r1: { agent: "planner", retired: true },
      r2: { agent: "planner", retired: true },
      a1: { agent: "planner" },
      j1: { agent: "planner", retired: true },
    };
    const stopped: string[] = [];
    stopRetiredPlanners(live, {
      except: "r2",
      stateFor: (id: string) => states[id] as never,
      stop: (id: string) => stopped.push(id),
    });
    expect(stopped).toEqual(["r1"]);
  });

  it("sweeps the retired planners whose plan is taken, by the hook's own rule", () => {
    const live = [
      { sessionId: "p5", name: "Planner 5", kind: "background" },
      { sessionId: "p6", name: "Planner 6", kind: "background" },
    ];
    const states: Record<string, object> = {
      p5: { agent: "planner", retired: true, plans: ["plans/a.md"] },
      p6: { agent: "planner", retired: true, plans: ["plans/b.md"] },
    };
    const texts: Record<string, string> = {
      "plans/a.md": "# A\n\n## Building, 26 October 2026, session e\n\n## Building it\n",
      "plans/b.md": "# B\n\nPlan only, 26 October 2026.\n\n## Building it\n",
    };
    const stopped: string[] = [];
    stopTakenPlanners(live, {
      stateFor: (id: string) => states[id] as never,
      textOf: (path: string) => texts[path],
      stop: (id: string) => stopped.push(id),
      write: () => {},
      now: 1,
    });
    expect(stopped).toEqual(["p5"]);
  });

  it("stops a retired planner when its executor writes the Building line", () => {
    const executor = `executor-wrote-${process.pid}`;
    const planner = `planner-wrote-${process.pid}`;
    const plannerState = stateFile(planner);
    const log = join(repo, ".claude", "stops.log");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    mkdirSync(join(repo, "plans"), { recursive: true });
    rmSync(log, { force: true });
    writeFileSync(
      plannerState,
      JSON.stringify({ agent: "planner", retired: true, plans: ["plans/taken.md"] }),
    );
    writeFileSync(
      join(repo, "plans", "taken.md"),
      `# T\n\n## Building, 26 October 2026, session ${executor}\n\nPlan only, 26 October 2026.\n`,
    );
    const env = {
      WORKFLOW_STOP_LOG: log,
      WORKFLOW_LIVE: JSON.stringify([
        { sessionId: planner, id: "bg-planner", name: "Planner 2", kind: "background", cwd: repo },
      ]),
    };
    const wrote = (file: string) =>
      run(
        join(here, "plan-queue.mjs"),
        ["wrote"],
        {
          session_id: executor,
          agent_type: "executor",
          tool_name: "Edit",
          tool_input: { file_path: join(repo, file) },
        },
        env,
      );
    try {
      expect(wrote("docs/editor.md")).toBe("");
      expect(existsSync(log)).toBe(false);
      expect(wrote("plans/taken.md")).toBe("");
      expect(readFileSync(log, "utf8")).toBe("bg-planner\n");
    } finally {
      rmSync(plannerState, { force: true });
      rmSync(log, { force: true });
    }
  });

  it("names the chats on an older Claude Code, and nothing when all match", () => {
    const rows = [
      { sessionId: "4bc43b44-0000", name: "Planner", pid: 1 },
      { sessionId: "14efb0df-0000", name: "project-b4", pid: 2 },
      { sessionId: "049920c4-0000", name: "Executor 4", pid: 3 },
      { sessionId: "deadbeef-0000", name: "Gone", pid: 4 },
    ];
    const versions: Record<number, string> = { 1: "2.1.306", 2: "2.1.306", 3: "2.1.310", 4: "" };
    const versionOf = (pid?: number) => versions[pid ?? 0] ?? "";
    expect(versionLine(rows, { installed: "2.1.310", versionOf })).toBe(
      "Claude Code 2.1.310 is installed; Planner [4bc43b44] and project-b4 [14efb0df] run 2.1.306: a chat picks the new version up when it is restarted (claude --resume <id>).",
    );
    expect(versionLine(rows.slice(2), { installed: "2.1.310", versionOf })).toBe("");
  });
});

/** `list()` in a child process, with `live` as the sessions. */
function listIn(dir: string, live: object[]): string {
  return execFileSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `import { list } from ${JSON.stringify(join(here, "plan-queue.mjs"))};
       console.log(list({ live: JSON.parse(process.env.LIVE) }));`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, LIVE: JSON.stringify(live) },
    },
  );
}

function listWith(live: object[]): string {
  return listIn(repo, live);
}

/**
 * **The faults the reviews found in the copied queue, closed**
 * (plans/queue-faults-carried-over.md), each against fixture projects.
 */
describe("the queue's faults, closed", () => {
  const pids: number[] = [];
  afterAll(() => {
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch {
        // Gone already.
      }
    }
  });
  const queue = "plan-queue.mjs";
  const runIn = (dir: string, args: string[], env: Record<string, string> = {}, input?: object) =>
    execFileSync("node", [join(here, queue), ...args], {
      input: input ? JSON.stringify(input) : "",
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, WORKFLOW_LIVE: "[]", ...env },
    });

  /**
   * **An unknown word fails** (plans/unknown-subcommand-fails.md): a step
   * written for a newer copy must not pass on an older one having run nothing.
   */
  describe("a word plans does not know", () => {
    const usageStart = "plans                 the queue";
    const spawnIn = (dir: string, args: string[], env: Record<string, string> = {}) =>
      spawnSync("node", [join(here, queue), ...args], {
        input: "",
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir, WORKFLOW_LIVE: "[]", ...env },
      });

    it("When plans nosuchword runs, then it exits 2, names the word on stderr and prints nothing on stdout", () => {
      const dir = fixture("Unknown");
      for (const word of ["nosuchword", ""]) {
        const done = spawnIn(dir, [word]);
        expect(done.status).toBe(2);
        expect(done.stdout).toBe("");
        const [first, second] = done.stderr.split("\n");
        expect(first).toBe(`plans: unknown command "${word}"`);
        expect(second.startsWith(usageStart)).toBe(true);
      }
    });

    it("When plans start --agent nobody runs, then it exits 2, names the agent on stderr and starts nothing", () => {
      const dir = fixture("Tester");
      writeFileSync(
        join(dir, "plans", "x.md"),
        "# X\n\nPlan only, 24 November 2026, for Javi; the executor builds it.\n",
      );
      const ran = join(dir, "ran");
      const stub = fakeClaude(temp("tester-claude-"), { calls: ran });
      const done = spawnIn(dir, ["start", "--agent", "nobody", "plans/x.md"], {
        WORKFLOW_CLAUDE: stub,
      });
      expect(done.status).toBe(2);
      expect(done.stdout).toBe("");
      expect(done.stderr.split("\n")[0]).toBe('plans: unknown agent "nobody"');
      expect(done.stderr).toContain(
        "plans start --agent planner <brief>   start a planner on a brief",
      );
      // A value left out or empty is not taken for the executor.
      for (const args of [
        ["start", "plans/x.md", "--agent"],
        ["start", "--agent", "", "plans/x.md"],
      ]) {
        const empty = spawnIn(dir, args, { WORKFLOW_CLAUDE: stub });
        expect(empty.status).toBe(2);
        expect(empty.stdout).toBe("");
        expect(empty.stderr.split("\n")[0]).toBe('plans: unknown agent ""');
      }
      expect(existsSync(ran)).toBe(false);
    });

    /** A project with a plan, a starts log holding one line and a claude that records any call. */
    const startable = (name: string) => {
      const dir = fixture(name);
      writeFileSync(
        join(dir, "plans", "x.md"),
        "# X\n\nPlan only, 24 November 2026, for Javi; the executor builds it.\n",
      );
      const log = join(dir, ".claude", "starts.log");
      writeFileSync(log, `${JSON.stringify({ at: 1, name: "Old Executor 1 (lab)" })}\n`);
      const ran = join(dir, "ran");
      const env = {
        WORKFLOW_CLAUDE: fakeClaude(temp(`${name.toLowerCase()}-claude-`), { calls: ran }),
        WORKFLOW_STARTS_LOG: log,
      };
      const before = readFileSync(log, "utf8");
      const nothingStarted = () => {
        expect(readFileSync(log, "utf8")).toBe(before);
        expect(existsSync(ran)).toBe(false);
      };
      return { dir, env, nothingStarted };
    };
    /** Exit 2, stdout empty, the line first on stderr and the usage after it. */
    const refused = (done: ReturnType<typeof spawnSync>, line: string) => {
      expect(done.status).toBe(2);
      expect(done.stdout).toBe("");
      const [first, second] = String(done.stderr).split("\n");
      expect(first).toBe(line);
      expect(second.startsWith(usageStart)).toBe(true);
    };

    it("When plans start --dryy runs, then it exits 2, names the option on stderr and starts nothing", () => {
      const { dir, env, nothingStarted } = startable("Option");
      for (const args of [
        ["start", "--dryy"],
        ["start", "--dryy", "plans/x.md"],
        ["start", "plans/x.md", "--dryy"],
      ])
        refused(spawnIn(dir, args, env), 'plans: unknown option "--dryy"');
      nothingStarted();
    });

    it("When plans start --owner-said has no words, or a path or a flag in their place, then it exits 2 and starts nothing", () => {
      const { dir, env, nothingStarted } = startable("Needs");
      for (const args of [
        ["start", "plans/x.md", "--owner-said"],
        ["start", "--owner-said", "  ", "plans/x.md"],
        ["start", "--owner-said", "--dry", "plans/x.md"],
        ["start", "--owner-said", "plans/x.md"],
        ["start", "--owner-said", "plans/my plan.md"],
      ])
        refused(
          spawnIn(dir, args, env),
          "plans: plans start --owner-said needs what Javi said, in quotes, before the path.",
        );
      nothingStarted();
    });

    it("When plans hold has no name, no -- and command, a --wait that is no number or a word too many, then it exits 2 saying which", () => {
      const dir = fixture("Hold");
      const ran = join(dir, "ran");
      const touch = ["--", "sh", "-c", `touch ${ran}`];
      for (const [args, line] of [
        [[], "plans: plans hold needs a resource's name."],
        [touch, "plans: plans hold needs a resource's name."],
        [["--wait", "5", ...touch], "plans: plans hold needs a resource's name."],
        [["Big", ...touch], "plans: plans hold needs a resource's name."],
        [["browser"], "plans: plans hold needs -- and the command to run."],
        [["browser", "--"], "plans: plans hold needs -- and the command to run."],
        [["browser", "sh", "-c", "true"], "plans: plans hold needs -- and the command to run."],
        [
          ["browser", "--wait", "soon", ...touch],
          "plans: plans hold --wait takes minutes, a number.",
        ],
        [["browser", "--wait", "", ...touch], "plans: plans hold --wait takes minutes, a number."],
        [["browser", "--wait"], "plans: plans hold --wait takes minutes, a number."],
        [
          ["browser", "--wait", "1e309", ...touch],
          "plans: plans hold --wait takes minutes, a number.",
        ],
        [["--wait", "browser", ...touch], "plans: plans hold --wait takes minutes, a number."],
        [["browser", "--", ""], "plans: plans hold needs -- and the command to run."],
        [["browser", "extra", ...touch], "plans: plans hold takes one resource's name before --."],
        [["browser", "--typo", ...touch], 'plans: unknown option "--typo"'],
      ] as [string[], string][])
        refused(spawnIn(dir, ["hold", ...args]), line);
      expect(existsSync(ran)).toBe(false);
      expect(readdirSync(join(dir, ".claude")).filter((f) => f.includes(".hold."))).toEqual([]);
    });

    it("When plans or plans help runs, then it exits 0 with the queue or the usage on stdout", () => {
      const dir = fixture("Known");
      const listed = spawnIn(dir, []);
      expect(listed.status).toBe(0);
      expect(listed.stdout).not.toBe("");
      expect(listed.stdout.startsWith(usageStart)).toBe(false);
      for (const word of ["help", "--help", "-h"]) {
        const done = spawnIn(dir, [word]);
        expect(done.status).toBe(0);
        expect(done.stdout.startsWith(usageStart)).toBe(true);
        expect(done.stderr).toBe("");
      }
    });
  });

  describe("the read-only list", () => {
    it("takes substitution, eval, sort -o, --output, git branch -D and node as writing", () => {
      for (const command of [
        "echo $(touch x)",
        "echo `rm x`",
        "git branch -D feat",
        "cat a | sort -o a",
        "git log --output=x",
        "eval ls",
        "node --input-type=module -e 1",
        "find . -execdir rm {} +",
      ])
        expect(shellWrites(command), command).toBe(true);
    });
    it("reads git with -C or --no-pager, and git branch listing", () => {
      for (const command of [
        "git -C sub status",
        "git --no-pager log",
        "git branch --show-current",
        "git branch -a",
        "git branch",
      ])
        expect(shellWrites(command), command).toBe(false);
    });

    // plans/collaborating-when-claude-writes-the-code.md, part 2 and its tests.
    it("ranks related work by files in common, a pull request first, three at most, by suffix", () => {
      const pull = (number: number, files: string[], headRefName = `h${number}`) => ({
        number,
        title: `P${number}`,
        author: "anton",
        headRefName,
        files,
      });
      const qs = "plugins/workflow/scripts/plan-queue.mjs";
      const doc = "plugins/workflow/docs/workflow.md";
      const found = relatedWork(["scripts/plan-queue.mjs", "docs/workflow.md"], {
        pulls: [pull(1, [doc]), pull(2, [qs, doc]), pull(3, ["README.md"]), pull(4, [qs])],
        branches: [
          { name: "b-two", author: "henry", title: "B", files: [qs, doc] },
          { name: "b-one", author: "henry", title: "C", files: [doc] },
        ],
      });
      expect(found.map((one) => one.number ?? one.name)).toEqual([2, "b-two", 1]);
      expect(found[0]).toMatchObject({ kind: "pull", files: [qs, doc], own: "" });
      expect(found[1]).toMatchObject({ kind: "branch", title: "B", author: "henry" });
      // Nothing in common: nothing.
      expect(relatedWork(["apps/x.tsx"], { pulls: [pull(1, [doc])] })).toEqual([]);
      // A named path is no suffix of a file it only ends like.
      expect(relatedWork(["workflow.md"], { pulls: [pull(1, ["docs/myworkflow.md"])] })).toEqual(
        [],
      );
      // This queue's, by number or by its topic's branch.
      const own = new Map<number | string, string>([
        [1, "plans/one.md"],
        ["h4", "plans/four.md"],
      ]);
      expect(
        relatedWork(["docs/workflow.md", "scripts/plan-queue.mjs"], {
          pulls: [pull(1, [doc]), pull(4, [qs])],
          own,
        }).map((one) => one.own),
      ).toEqual(["plans/one.md", "plans/four.md"]);
    });

    it("reads the Related line under the header, past a status section, and nowhere else", () => {
      const head = "# P\n\nPlan only, 30 October 2026, for Javi.\n\nLands: topic x.\n";
      const of = (line: string) => relatedOf(`${head}${line}\n\n## What was asked\n`);
      expect(of("Related: #31.")).toEqual([{ kind: "pull", number: 31 }]);
      expect(of("Related: #31 and branch a-b.")).toEqual([
        { kind: "pull", number: 31 },
        { kind: "branch", name: "a-b" },
      ]);
      expect(of("Related: branch a-b.")).toEqual([{ kind: "branch", name: "a-b" }]);
      expect(of("Related: #3, #4 and\nbranch a-b")).toHaveLength(3);
      // Another person's branch in Git's shape, the line's full stop not its name's.
      expect(of("Related: #31 and branch fix/pictures-v1.2.")).toEqual([
        { kind: "pull", number: 31 },
        { kind: "branch", name: "fix/pictures-v1.2" },
      ]);
      // A bare `Related:` does not take the next line's issue reference.
      expect(of("Related:\n#5 is another thing.")).toBeNull();
      expect(of("")).toBeNull();
      expect(
        relatedOf(
          `# P\n\n## Building, 30 October 2026, session abc\n\nPlan only, 30 October 2026.\n\nRelated: #31.\n`,
        ),
      ).toEqual([{ kind: "pull", number: 31 }]);
      expect(relatedOf(`${head}\n## What was asked\n\nRelated: #31.\n`)).toBeNull();
      expect(relatedOf(`${head}\n\`\`\`\nRelated: #31.\n\`\`\`\n\n## What was asked\n`)).toBeNull();
      // A brief's, under its header line.
      expect(
        stateOf(
          "# B\n\nBrief for the planner, 30 October 2026, by the assistant with Javi.\n\nRelated: #7.\n\n## What was asked\n",
        ),
      ).toMatchObject({ state: "brief", relatedTo: [{ kind: "pull", number: 7 }] });
    });

    it("words related lines with the queue's own, two files and the rest counted", () => {
      const plans = [
        { path: "plans/mine.md", state: "built", pr: 24, topic: "", lands: { name: "shown" } },
        { path: "plans/next.md", state: "ready", lands: { kind: "topic", name: "next" } },
      ];
      expect(ownOf(plans as never)).toEqual(
        new Map<number | string, string>([
          [24, "plans/mine.md"],
          ["shown", "plans/mine.md"],
          ["next", "plans/next.md"],
        ]),
      );
      const text = "Change a/x.mjs, a/y.mjs, a/z.mjs and b/w.md.";
      const lines = relatedLines(text, plans as never, {
        pulls: [
          {
            number: 31,
            title: "Pictures kept",
            author: "anton",
            headRefName: "pictures",
            files: ["a/x.mjs", "a/y.mjs", "a/z.mjs"],
          },
          { number: 24, title: "Shown", author: "javi", headRefName: "shown", files: ["b/w.md"] },
        ],
        branches: [{ name: "next", author: "javi", title: "Next step", files: ["b/w.md"] }],
      });
      // A plan's own topic is never related to it.
      expect(
        relatedLines(
          text,
          plans as never,
          {
            pulls: [],
            branches: [{ name: "next", author: "javi", title: "Next step", files: ["b/w.md"] }],
          },
          { topic: "next" },
        ),
      ).toEqual([]);
      expect(lines).toEqual([
        'looks related to #31 "Pictures kept" (anton; both name a/x.mjs, a/y.mjs and 1 more)',
        'looks related to #24 "Shown" (this queue\'s, plans/mine.md, topic shown; both name b/w.md)',
        'looks related to branch next, "Next step" (this queue\'s, plans/next.md; both name b/w.md)',
      ]);
      // The day's fixes pull request is the queue's own but no topic to land in.
      expect(
        relatedLines(text, [{ path: "plans/fix.md", state: "built", pr: 40 }] as never, {
          pulls: [
            {
              number: 40,
              title: "Fixes",
              author: "javi",
              headRefName: "fixes-2026-11-07",
              files: ["b/w.md"],
            },
          ],
        }),
      ).toEqual(['looks related to #40 "Fixes" (this queue\'s, plans/fix.md; both name b/w.md)']);
    });

    it("prints related lines under briefs and ready plans in the pull request mode only", () => {
      const write = (dir: string) => {
        writeFileSync(
          join(dir, "plans", "brief.md"),
          "# B\n\nBrief for the planner, 30 October 2026, by the assistant with Javi.\n\n## What was asked\n\nChange scripts/plan-queue.mjs.\n",
        );
        writeFileSync(
          join(dir, "plans", "ready.md"),
          "# R\n\nPlan only, 30 October 2026, for Javi.\n\nLands: topic shown.\nRelated: #31.\n\n## What was asked\n\nChange docs/workflow.md.\n",
        );
        writeFileSync(
          join(dir, "plans", "earlier.md"),
          "# E\n\nPlan only, 29 October 2026, for Javi.\n\nLands: topic earlier.\n\n## Built, 29 October 2026\n\nPull request #33 (https://github.com/o/r/pull/33) to test from branch earlier, commit 61c4a812; open.\n",
        );
      };
      const pulls = [
        {
          number: 31,
          title: "Pictures kept",
          author: "anton",
          headRefName: "pictures",
          files: ["plugins/workflow/scripts/plan-queue.mjs"],
        },
        {
          number: 32,
          title: "Shown",
          author: "javi",
          headRefName: "shown",
          files: ["plugins/workflow/docs/workflow.md"],
        },
        {
          number: 33,
          title: "Earlier",
          author: "javi",
          headRefName: "earlier",
          files: ["plugins/workflow/docs/workflow.md"],
        },
      ];
      const listed = (dir: string, readers: object | null, related = true) =>
        execFileSync(
          "node",
          [
            "--input-type=module",
            "-e",
            `import { list } from ${JSON.stringify(join(here, queue))};
             console.log(list({ live: [], related: ${related}, readers: JSON.parse(process.env.READERS) }));`,
          ],
          {
            encoding: "utf8",
            env: { ...process.env, CLAUDE_PROJECT_DIR: dir, READERS: JSON.stringify(readers) },
          },
        );
      const dir = fixture("Related", "land: pull-request\n");
      write(dir);
      const out = listed(dir, { pulls, branches: [] });
      expect(out).toMatch(
        /plans\/brief\.md +brief, 30 October\n    looks related to #31 "Pictures kept" \(anton; both name plugins\/workflow\/scripts\/plan-queue\.mjs\)\n/,
      );
      expect(out).toMatch(
        /plans\/ready\.md +Plan only, 30 October, topic shown, related: #31\n    looks related to #33 "Earlier" \(this queue's, plans\/earlier\.md, topic earlier; both name plugins\/workflow\/docs\/workflow\.md\)\n/,
      );
      // Its own topic's pull request is not related to it.
      expect(out).not.toContain("#32");
      // `gh` unread: said once, under the first row, and the branches still read.
      const unread = listed(dir, {
        pulls: null,
        branches: [{ name: "x-y", author: "henry", title: "T", files: ["docs/workflow.md"] }],
      });
      expect(unread.match(/related work not read \(gh\)/g)).toHaveLength(1);
      expect(unread).toMatch(/brief, 30 October\n    related work not read \(gh\)\n/);
      expect(unread).toContain(
        'looks related to branch x-y, "T" (henry; both name docs/workflow.md)',
      );
      // Off with related: false, and in the push mode.
      expect(listed(dir, { pulls, branches: [] }, false)).not.toContain("looks related");
      const pushMode = fixture("RelatedPush");
      write(pushMode);
      const pushed = listed(pushMode, { pulls, branches: [] });
      expect(pushed).not.toContain("looks related");
      expect(pushed).not.toContain("related: #31");
    });

    it("reads no related work in a hook's table", () => {
      const dir = fixture("RelatedHook", "land: pull-request\n");
      writeFileSync(
        join(dir, "plans", "ready.md"),
        "# R\n\nPlan only, 30 October 2026, for Javi.\n\n## What was asked\n\nChange docs/workflow.md.\n",
      );
      const bin = temp("queue-gh-related-");
      const log = join(bin, "calls.log");
      writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$*" >> ${log}\nexit 1\n`);
      chmodSync(join(bin, "gh"), 0o755);
      const env = { PATH: `${bin}:${process.env.PATH}` };
      const said = runIn(dir, ["prompt"], env, {
        session_id: `related-hook-${process.pid}`,
        agent_type: "executor",
        cwd: join(dir, ".claude", "worktrees", "executor-1"),
        prompt: "Build the plans.",
      });
      expect(said).toContain("plans/ready.md");
      expect(said).not.toContain("related work not read");
      expect(existsSync(log) ? readFileSync(log, "utf8") : "").not.toContain("files");
      // The command reads it.
      const listed = runIn(dir, ["list"], env);
      expect(listed).toContain("related work not read (gh)");
      expect(readFileSync(log, "utf8")).toContain("number,title,author,headRefName,files");
    });

    it("reads the open pull requests' files, and the pushed branches past the branch", () => {
      const calls: string[][] = [];
      expect(
        openPulls({
          run: ((_: string, args: string[]) => {
            calls.push(args);
            return JSON.stringify([
              {
                number: 31,
                title: "T",
                author: { login: "anton" },
                headRefName: "pictures",
                files: [{ path: "a/b.md", additions: 1 }],
              },
            ]);
          }) as never,
        }),
      ).toEqual([
        { number: 31, title: "T", author: "anton", headRefName: "pictures", files: ["a/b.md"] },
      ]);
      expect(calls[0]).toContain("number,title,author,headRefName,files");
      expect(
        openPulls({
          run: (() => {
            throw new Error("no gh");
          }) as never,
        }),
      ).toBeNull();
      const now = Date.UTC(2026, 9, 30);
      const day = 24 * 60 * 60;
      const at = (days: number) => String(now / 1000 - days * day);
      const refs = [
        `origin\tsha\t${at(0)}\tjavi\tHEAD`,
        `origin/test\tsha\t${at(0)}\tjavi\tthe branch`,
        `origin/main\tsha\t${at(0)}\tjavi\tmain`,
        `origin/pictures\tsha\t${at(1)}\tanton\ta pull request's head`,
        `origin/kept\tsha\t${at(2)}\tanton\tKept`,
        `origin/merged\tsha\t${at(3)}\tjavi\tMerged`,
        `origin/squashed\tc0ffee\t${at(2)}\tjavi\tSquashed`,
        `origin/old\tsha\t${at(31)}\thenry\tOld`,
        ...Array.from(
          { length: 25 },
          (_, i) => `origin/many-${i}\tsha\t${at(4)}\thenry\tMany ${i}`,
        ),
      ].join("\n");
      const seen: string[][] = [];
      const run = (args: string[]) => {
        seen.push(args);
        if (args[0] === "fetch") throw new Error("offline");
        if (args[0] === "for-each-ref") return refs;
        if (args[0] === "diff") return args[2].endsWith("/merged") ? "" : "docs/x.md\n";
        throw new Error(args.join(" "));
      };
      const merged = new Map([["squashed", "c0ffee"]]);
      const branches = pushedBranches({ run, base: "test", heads: ["pictures"], merged, now });
      expect(seen[0]).toEqual(["fetch", "--prune", "--quiet", "origin"]);
      expect(branches[0]).toEqual({
        name: "kept",
        author: "anton",
        title: "Kept",
        files: ["docs/x.md"],
      });
      const names = branches.map((one) => one.name);
      for (const gone of ["HEAD", "test", "main", "pictures", "merged", "squashed", "old"])
        expect(names).not.toContain(gone);
      // Twenty read, the merged one among them and dropped.
      expect(names).toHaveLength(19);
      expect(seen.filter((args) => args[0] === "diff")).toHaveLength(20);
      expect(seen.find((args) => args[0] === "diff")?.[2]).toBe("origin/test...origin/kept");
      // No fetch when asked, and nothing read past the deadline.
      seen.length = 0;
      pushedBranches({ run, base: "test", now, fetch: false });
      expect(seen[0][0]).toBe("for-each-ref");
      seen.length = 0;
      expect(pushedBranches({ run, base: "test", now, deadline: Date.now() - 1 })).toEqual([]);
      expect(seen.filter((args) => args[0] === "diff")).toHaveLength(0);
    });
  });

  it("snapshots a rename by its new path, with no cut-short entry", () => {
    const dir = temp("queue-rename-");
    g(dir, "init", "-q");
    writeFileSync(join(dir, "old-name.md"), "one\n");
    g(dir, "add", ".");
    g(dir, "commit", "-q", "-m", "one");
    g(dir, "mv", "old-name.md", "new-name.md");
    expect(Object.keys(treeFiles(dir))).toEqual(["new-name.md"]);
    // A rename in the worktree column: an intent-to-add file and its source deleted.
    g(dir, "reset", "-q", "--hard");
    g(dir, "mv", "old-name.md", "tmp.md");
    g(dir, "commit", "-q", "-m", "two");
    execFileSync("mv", ["tmp.md", "third.md"], { cwd: dir });
    g(dir, "add", "-N", "third.md");
    const paths = Object.keys(treeFiles(dir));
    expect(paths).toContain("third.md");
    expect(paths.every((path) => existsSync(join(dir, path)) || path === "tmp.md")).toBe(true);
  });

  describe("stateOf", () => {
    // plans/dropped-plan-state.md: the Lands line is read on a dropped plan too.
    it("reads a dropped plan with its Lands line", () => {
      const text =
        "# P\n\nPlan only, 30 October 2026, for Javi.\n\nLands: fix.\n\n## Dropped, 30 October 2026\n\nDropped on Javi's word: folded into plans/x.md.\n";
      expect(stateOf(text)).toMatchObject({
        state: "dropped",
        lands: { kind: "fix", now: false },
        droppedDay: "30 October 2026",
        why: "folded into plans/x.md",
      });
    });

    // plans/pull-requests-by-topic.md, part 1 and part 6.
    it("reads the Lands line under the header, and none as null", () => {
      const head = "# P\n\nPlan only, 30 October 2026, for Javi.\n\n";
      const lands = (line: string) => stateOf(`${head}${line}\n\n## What was asked\n`)?.lands;
      expect(lands("Lands: fix.")).toEqual({ kind: "fix", now: false });
      expect(lands("Lands: fix, now.")).toEqual({ kind: "fix", now: true });
      // plans/merged-pr-refreshes-the-rest.md, part 4.
      expect(landsOf(`${head}Lands: refresh.\n`)).toEqual({ kind: "refresh" });
      expect(landsWords({ kind: "refresh" })).toBe("a refresh");
      expect(landsUnread(`${head}Lands: refresh.\n`)).toBe(false);
      // plans/topic-opens-when-nothing-waits.md: a topic is its name, and the
      // marks written before 26 November are read and mean nothing.
      expect(lands("Lands: topic x.")).toEqual({ kind: "topic", name: "x" });
      expect(lands("Lands: topic x; lands in #7.")).toEqual({ kind: "topic", name: "x", into: 7 });
      expect(lands("Lands: topic x; stacked on #7.")).toEqual({
        kind: "topic",
        name: "x",
        stackedOn: 7,
      });
      expect(lands("Lands: topic x, waiting.")).toEqual({ kind: "topic", name: "x" });
      expect(lands("Lands: topic x, ready; lands in #7.")).toEqual({
        kind: "topic",
        name: "x",
        into: 7,
      });
      expect(lands("Lands: topic pictures, ready.")).toEqual({ kind: "topic", name: "pictures" });
      expect(landsWords({ kind: "topic", name: "x", into: 7 })).toBe("topic x, lands in #7");
      expect(lands("")).toBeNull();
      // Hand-wrapped, or with its full stop left off.
      expect(lands("Lands: topic pull-requests-by-topic,\nwaiting.")).toEqual({
        kind: "topic",
        name: "pull-requests-by-topic",
      });
      expect(lands("Lands: topic pull-requests-by-topic")).toEqual({
        kind: "topic",
        name: "pull-requests-by-topic",
      });
      expect(lands("Lands: fix")).toEqual({ kind: "fix", now: false });
      // plans/lands-line-suffix.md: the pull request it lands in, or is stacked
      // on, after the topic's name, where agents write it.
      expect(lands("Lands: topic headless-ui; lands in #52.")).toEqual({
        kind: "topic",
        name: "headless-ui",
        into: 52,
      });
      expect(lands("Lands: topic ai-client; stacked on #52.")).toEqual({
        kind: "topic",
        name: "ai-client",
        stackedOn: 52,
      });
      expect(lands("Lands: topic x, waiting; lands\nin #7")).toEqual({
        kind: "topic",
        name: "x",
        into: 7,
      });
      expect(lands("Lands: topic x, someday.")).toBeNull();
      expect(lands("Lands: topic Bad Name, ready.")).toBeNull();
      expect(lands("Lands: fix; lands in #52.")).toBeNull();
      // An example quoted in a fence is not the plan's line (/code-review).
      expect(lands("```\nLands: topic headless-ui.\n```")).toBeNull();
      // A Lands line inside a later section is not the plan's.
      expect(stateOf(`${head}## What was asked\n\nLands: fix.\n`)?.lands).toBeNull();
      // Past a status section written above the header.
      expect(
        stateOf(
          `# P\n\n## Building, 30 October 2026, session abc\n\nPlan only, 30 October 2026.\n\nLands: fix.\n`,
        )?.lands,
      ).toEqual({ kind: "fix", now: false });
    });

    it("reads a fix pushed straight, a topic waiting, and a pull request opened or joined later", () => {
      const head = "# P\n\nPlan only, 30 October 2026, for Javi.\n\n## Built, 30 October 2026\n\n";
      expect(
        stateOf(`${head}Pushed straight to test as a fix, commit 61c4a812; image.yml green.\n`),
      ).toMatchObject({ state: "built", fix: true, topic: "", sha: "61c4a812", pr: 0 });
      const waiting = `${head}On topic pictures, commit 61c4a812, branch pushed; its pull request waits.\n`;
      expect(stateOf(waiting)).toMatchObject({ fix: false, topic: "pictures", pr: 0 });
      expect(
        stateOf(
          waiting.replace(
            "waits.\n",
            "waits.\nPull request #22 (https://github.com/o/r/pull/22) opened 30 October 2026 with plans/x.md.\n",
          ),
        ),
      ).toMatchObject({ topic: "pictures", pr: 22 });
      expect(
        stateOf(
          `${head}Pull request #22 (https://github.com/o/r/pull/22) joined, commit 61c4a812; open.\n`,
        ),
      ).toMatchObject({ pr: 22, sha: "61c4a812" });
      expect(
        stateOf(
          `${head}Pull request #23 (https://github.com/o/r/pull/23) of the day's fixes, commit 61c4a812; open.\n`,
        ),
      ).toMatchObject({ pr: 23, sha: "61c4a812" });
    });

    it("reads the pull request a Built section names, and none as 0", () => {
      const head = "# P\n\nPlan only, 28 October 2026, for Javi.\n\n## Built, 28 October 2026\n\n";
      expect(
        stateOf(
          `${head}Pull request #21 (https://github.com/o/r/pull/21) to test from branch x, commit 61c4a812; open.\n`,
        ),
      ).toMatchObject({ state: "built", sha: "61c4a812", pr: 21 });
      expect(stateOf(`${head}Branch x, commit 61c4a812 on test.\n`)).toMatchObject({
        state: "built",
        sha: "61c4a812",
        pr: 0,
      });
    });

    it("reads a plan that names the brief it replaced as a plan", () => {
      const text =
        "# A plan\n\nPlan only, 27 October 2026, for Javi.\nIt replaces the brief (Brief for the planner, 27 October 2026).\n";
      expect(text.split("\n")[3]).toContain("Brief for the planner");
      expect(stateOf(text)).toMatchObject({ state: "ready" });
    });
    it("reads a handed-over branch name whole, dots and all", () => {
      const handed = (line: string) =>
        stateOf(
          `# P\n\n## Handing over, 27 October 2026\n\nStep in hand: 3\n\n${line}\n\nPlan only, 27 October 2026.\n`,
        );
      expect(handed("On branch `feat/v1.2`.")).toMatchObject({ branch: "feat/v1.2" });
      expect(handed("On branch feat/v1.2.")).toMatchObject({ branch: "feat/v1.2" });
      expect(handed("On branch feat/v1.2, then the push.")).toMatchObject({ branch: "feat/v1.2" });
      expect(handed("The work is on branch queue-faults")).toMatchObject({
        branch: "queue-faults",
      });
    });
  });

  it("refuses the first stop on a red run, and lets a continued stop pass", () => {
    const dir = fixture("Run", "run: checks.yml\n");
    writeFileSync(join(dir, "README"), "one\n");
    g(dir, "add", ".");
    g(dir, "commit", "-q", "-m", "one");
    const sha = g(dir, "rev-parse", "HEAD");
    const bin = temp("queue-gh-");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\necho '[{"databaseId":7,"status":"completed","conclusion":"failure","headSha":"${sha}"}]'\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const env = { PATH: `${bin}:${process.env.PATH}` };
    const stop = (active: boolean) =>
      runIn(dir, ["stop"], env, {
        session_id: `red-run-${process.pid}`,
        agent_type: "executor",
        stop_hook_active: active,
      });
    const first = stop(false);
    expect(first).toContain('"decision":"block"');
    expect(first).toContain("(7) is failed");
    expect(stop(true)).toBe("");
    // A later turn's first stop refuses again.
    expect(stop(false)).toContain("(7) is failed");
  });

  it("lists a plan built as a pull request by its number and state, and one pushed by its commit", () => {
    const dir = fixture("Listed", "land: pull-request\n");
    const day = today();
    writeFileSync(
      join(dir, "plans", "by-pull.md"),
      `# A\n\nPlan only, 28 October 2026, for Javi.\n\n## Built, ${day}\n\nPull request #21 (https://github.com/o/r/pull/21) to test from branch x, commit 61c4a812; draft.\n`,
    );
    // plans/owner-reviews-before-anyone-else.md: a draft waits on its owner, read off `isDraft`.
    writeFileSync(
      join(dir, "plans", "ready-pull.md"),
      `# C\n\nPlan only, 28 October 2026, for Javi.\n\n## Built, ${day}\n\nPull request #22 (https://github.com/o/r/pull/22) to test from branch z, commit 71c4a812; draft.\n`,
    );
    writeFileSync(
      join(dir, "plans", "merged-pull.md"),
      `# D\n\nPlan only, 28 October 2026, for Javi.\n\n## Built, ${day}\n\nPull request #23 (https://github.com/o/r/pull/23) to test from branch w, commit 81c4a812; draft.\n`,
    );
    writeFileSync(
      join(dir, "plans", "pushed.md"),
      `# B\n\nPlan only, 28 October 2026, for Javi.\n\n## Built, ${day}\n\nBranch y, commit 1234abcd on test.\n`,
    );
    const bin = temp("queue-gh-list-");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nif [ "$1 $2 $3 $4" = "pr list --state all" ]; then echo '[{"number":21,"state":"OPEN","isDraft":true},{"number":22,"state":"OPEN","isDraft":false},{"number":23,"state":"MERGED","isDraft":false}]'; else exit 1; fi\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const listed = runIn(dir, ["list"], { PATH: `${bin}:${process.env.PATH}` });
    expect(listed).toMatch(/plans\/by-pull\.md\s+#21, draft\n/);
    expect(listed).toMatch(/plans\/ready-pull\.md\s+#22, open\n/);
    expect(listed).toMatch(/plans\/merged-pull\.md\s+#23, merged\n/);
    expect(listed).toMatch(/plans\/pushed\.md\s+1234abcd, on test/);
    // No `gh` on the PATH: the number alone.
    const empty = temp("queue-no-gh-");
    for (const tool of ["git", "node"])
      execFileSync("ln", [
        "-s",
        execFileSync("which", [tool], { encoding: "utf8" }).trim(),
        join(empty, tool),
      ]);
    const bare = runIn(dir, ["list"], { PATH: empty });
    expect(bare).toMatch(/plans\/by-pull\.md\s+#21\n/);
  });

  // plans/topic-opens-when-nothing-waits.md, part 3: each topic waiting for a
  // pull request says why, and one with none to open is not listed.
  it("lists a fix pushed straight, a waiting topic and the Ready plans' landings", () => {
    const dir = fixture("Topics", "land: pull-request\n");
    const day = today();
    const built = (name: string, title: string, line: string) =>
      writeFileSync(
        join(dir, "plans", name),
        `# ${title}\n\nPlan only, 30 October 2026, for Javi.\n\n## Built, ${day}\n\n${line}\n`,
      );
    built("fix.md", "F", "Pushed straight to test as a fix, commit 61c4a812; checks.yml green.");
    built(
      "refresh.md",
      "R",
      "Refreshed: #43 at 1a2b3c4d, #44 at 2b3c4d5e; left: #38, another person's.",
    );
    built(
      "x.md",
      "X",
      "On topic pictures, commit 1234abcd, branch pushed; its pull request waits.",
    );
    built(
      "y.md",
      "Y",
      "On topic opened, commit 2234abcd, branch pushed; its pull request waits.\nPull request #22 (https://github.com/o/r/pull/22) opened 30 October 2026 with plans/z.md.",
    );
    const ready = (name: string, line: string) =>
      writeFileSync(
        join(dir, "plans", name),
        `# R\n\nPlan only, 30 October 2026, for Javi.\n\n${line}\n\n## What was asked\n`,
      );
    ready("ready-topic.md", "Lands: topic pictures.");
    ready("ready-fix.md", "Lands: fix, now.");
    ready("ready-refresh.md", "Lands: refresh.");
    ready("no-line.md", "");
    // Nothing queued for it, and the day's fixes.
    built("r.md", "C", "On topic colours, commit 5234abcd, branch pushed; its pull request waits.");
    built(
      "f.md",
      "D",
      "On topic fixes-2026-11-27, commit 6234abcd, branch pushed; its pull request waits.",
    );
    // A topic opened by the plan that opened it alone: its Lands line names it.
    writeFileSync(
      join(dir, "plans", "w.md"),
      `# W\n\nPlan only, 30 October 2026, for Javi.\n\n## Built, ${day}\n\nOn topic shown, commit 3234abcd, branch pushed; its pull request waits.\n`,
    );
    writeFileSync(
      join(dir, "plans", "v.md"),
      `# V\n\nPlan only, 30 October 2026, for Javi.\n\nLands: topic shown.\n\n## Built, ${day}\n\nPull request #24 (https://github.com/o/r/pull/24) to test from branch shown, commit 4234abcd; open.\n`,
    );
    const empty = temp("queue-no-gh-topics-");
    for (const tool of ["git", "node"])
      execFileSync("ln", [
        "-s",
        execFileSync("which", [tool], { encoding: "utf8" }).trim(),
        join(empty, tool),
      ]);
    const listed = runIn(dir, ["list"], { PATH: empty });
    expect(listed).toMatch(/plans\/fix\.md\s+61c4a812, on test, a fix\n/);
    expect(listed).toMatch(/plans\/refresh\.md\s+a refresh\n/);
    expect(listed).toMatch(/plans\/ready-refresh\.md\s+Plan only, 30 October, a refresh\n/);
    expect(listed).toMatch(/plans\/x\.md\s+topic pictures, its pull request waits\n/);
    expect(listed).toMatch(/plans\/y\.md\s+#22\n/);
    expect(listed).toContain("\nTopics waiting for a pull request\n");
    expect(listed).toContain(
      "\n  pictures: plans/x.md; opens once plans/ready-topic.md is built\n",
    );
    expect(listed).toContain(
      "\n  colours: plans/r.md; nothing is queued for it, so the next plan's start opens it\n",
    );
    expect(listed).toContain(
      "\n  fixes-2026-11-27: plans/f.md; the day's fixes, opened at a plan's start once its day has come",
    );
    expect(listed).not.toContain("opened: plans/y.md");
    expect(listed).not.toContain("shown: plans/w.md");
    expect(listed).toMatch(/plans\/no-line\.md\s+Plan only, 30 October, topic no-line\n/);
    expect(listed).toMatch(/plans\/ready-topic\.md\s+Plan only, 30 October, topic pictures\n/);
    expect(listed).toMatch(/plans\/ready-fix\.md\s+Plan only, 30 October, a fix, now\n/);
    expect(listed).not.toContain("Lands line not read");
    // plans/lands-line-suffix.md: the pull request after the state keeps the
    // topic, and a line the queue cannot read is said, not taken for the file.
    ready("headless-ui-controls.md", "Lands: topic headless-ui; lands in #52.");
    ready("ai-client-stack.md", "Lands: topic ai-client; stacked on #52.");
    ready("bad-name.md", "Lands: topic Bad Name.");
    const suffixed = runIn(dir, ["list"], { PATH: empty });
    // plans/related-plans-share-a-pull-request.md: the row says where it lands.
    expect(suffixed).toMatch(
      /plans\/headless-ui-controls\.md\s+Plan only, 30 October, topic headless-ui, lands in #52\n/,
    );
    expect(suffixed).toMatch(
      /plans\/ai-client-stack\.md\s+Plan only, 30 October, topic ai-client, stacked on #52\n/,
    );
    expect(suffixed).toContain("Lands line not read: plans/bad-name.md\n");
    expect(suffixed).not.toMatch(/Lands line not read: .*plans\/(?:headless|ai-client|ready)/);
    // Two queued: both named.
    ready("ready-topic-2.md", "Lands: topic pictures.");
    expect(runIn(dir, ["list"], { PATH: empty })).toContain(
      "  pictures: plans/x.md; opens once plans/ready-topic.md and plans/ready-topic-2.md are built\n",
    );
    // A topic with no pull request to open: its row says so, and it waits for nothing.
    built(
      "x.md",
      "X",
      "On topic pictures, commit 1234abcd, branch pushed; its pull request waits.\nNo pull request: branch pictures is gone from origin.",
    );
    const none = runIn(dir, ["list"], { PATH: empty });
    expect(none).toMatch(/plans\/x\.md\s+topic pictures, no pull request\n/);
    expect(none).not.toContain("  pictures: plans/x.md");
    // Outside the pull request mode the line means nothing, so it is not said (Codex).
    const pushMode = fixture("TopicsPush");
    writeFileSync(
      join(pushMode, "plans", "bad-name.md"),
      "# R\n\nPlan only, 30 October 2026, for Javi.\n\nLands: topic Bad Name.\n\n## What was asked\n",
    );
    expect(runIn(pushMode, ["list"], { PATH: empty })).not.toContain("Lands line not read");
  });

  // plans/topic-opens-when-nothing-waits.md, part 2: when the last queued plan
  // of a topic is built, then plans topic says its pull request opens with it;
  // with more of the topic queued, then what it waits for.
  it(
    "a topic's pull request opens once nothing else is queued for it",
    { timeout: 120_000 },
    () => {
      const dir = fixture("TopicQueued", "land: pull-request\n");
      const day = "26 November 2026";
      const live = "a0c0ffee-0000-4000-8000-000000000001";
      const write = (name: string, text: string) => writeFileSync(join(dir, "plans", name), text);
      const remove = (...names: string[]) =>
        names.forEach((name) => rmSync(join(dir, "plans", name), { force: true }));
      const planText = (lands: string, rest = "") =>
        `# A plan\n\nPlan only, ${day}, for Javi; the executor builds it.\n\n${lands}\n\n${rest}## What was asked\n`;
      const built = (lands: string) =>
        planText(
          lands,
          `## Built, ${day}\n\nOn topic t, commit 1234abcd, branch pushed; its pull request waits.\n\n`,
        );
      const env = {
        WORKFLOW_LIVE: JSON.stringify([
          { sessionId: live, name: "Topic Executor 1", kind: "background", cwd: dir },
        ]),
      };
      const topic = (path?: string, more: Record<string, string> = {}) => {
        const done = spawnSync("node", [join(here, queue), "topic", ...(path ? [path] : [])], {
          input: "",
          encoding: "utf8",
          env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env, ...more },
        });
        return { said: done.stdout, status: done.status };
      };
      // Earlier plans built under the old mark, none saying ready, and the plan
      // in hand being built.
      write("a.md", built("Lands: topic t, waiting."));
      write("b.md", built("Lands: topic t, waiting."));
      write(
        "c.md",
        planText("Lands: topic t, waiting.", `## Building, ${day}, session ${live}\n\n`),
      );
      const opens = {
        said: "Nothing else is queued for topic t: its pull request opens with plans/c.md.\n",
        status: 0,
      };
      expect(topic("plans/c.md")).toEqual(opens);
      expect(topic(join(dir, "plans", "c.md"))).toEqual(opens);
      // A second plan of the topic, ready, handed over, or being built by a live session.
      const waits = {
        said: "plans/d.md is still queued for topic t: its pull request waits for it.\n",
        status: 0,
      };
      write("d.md", planText("Lands: topic t."));
      expect(topic("plans/c.md")).toEqual(waits);
      write(
        "d.md",
        planText(
          "Lands: topic t.",
          `## Handing over, ${day}\n\nStep in hand: 2\n\nOn branch t.\n\n`,
        ),
      );
      expect(topic("plans/c.md")).toEqual(waits);
      // Being built by a live session, where the same plan with its session gone
      // is planned, held for its Ready (Codex C7).
      write("c.md", planText("Lands: topic t."));
      write(
        "d.md",
        planText("Lands: topic t.\nIssue: #12.", `## Building, ${day}, session ${live}\n\n`),
      );
      expect(topic("plans/c.md")).toEqual(waits);
      expect(topic("plans/c.md", { WORKFLOW_LIVE: "[]" })).toEqual(opens);
      write("d.md", planText("Lands: topic t.", `## Building, ${day}, session ${live}\n\n`));
      // Two queued.
      write("e.md", planText("Lands: topic t."));
      expect(topic("plans/c.md")).toEqual({
        said: "plans/d.md and plans/e.md are still queued for topic t: its pull request waits for them.\n",
        status: 0,
      });
      remove("d.md", "e.md");
      // Planned (an issue, no Ready), dropped, a brief, built, or on another topic: nothing held back.
      write("d.md", planText("Lands: topic t.\nIssue: #12."));
      write("e.md", planText("Lands: topic t.", `## Dropped, ${day}\n\nNot wanted.\n\n`));
      write("f.md", `# F\n\nBrief for the planner, ${day}.\n\nLands: topic t.\n`);
      write("g.md", built("Lands: topic t."));
      write("h.md", planText("Lands: topic other."));
      expect(topic("plans/c.md")).toEqual(opens);
      remove("d.md", "e.md", "f.md", "g.md", "h.md");
      // A plan with no Lands line is the topic named for its file.
      write("n.md", planText(""));
      expect(topic("plans/n.md")).toEqual({
        said: "Nothing else is queued for topic n: its pull request opens with plans/n.md.\n",
        status: 0,
      });
      write("m.md", planText("Lands: topic n."));
      expect(topic("plans/n.md")).toEqual({
        said: "plans/m.md is still queued for topic n: its pull request waits for it.\n",
        status: 0,
      });
      // A fix is no topic's; no path is refused.
      write("x.md", planText("Lands: fix."));
      expect(topic("plans/x.md")).toEqual({
        said: "plans/x.md is no topic's: it lands as a fix.\n",
        status: 0,
      });
      // A topic named fix is a topic, and a fix in a file named for it holds nothing back (Codex C5).
      remove("m.md", "n.md");
      write("y.md", planText("Lands: topic fix."));
      write("fix.md", planText("Lands: fix."));
      expect(topic("plans/y.md")).toEqual({
        said: "Nothing else is queued for topic fix: its pull request opens with plans/y.md.\n",
        status: 0,
      });
      // A dropped plan opens nothing (/code-review).
      write("z.md", planText("Lands: topic z.", `## Dropped, ${day}\n\nNot wanted.\n\n`));
      expect(topic("plans/z.md").status).toBe(1);
      expect(topic("plans/z.md").said).toMatch(/^plans\/z\.md is dropped/);
      expect(topic()).toEqual({
        said: "A path is needed: plans topic plans/<x>.md; plans shows the queue.\n",
        status: 1,
      });
    },
  );

  // plans/merged-pr-refreshes-the-rest.md, part 6: when Javi next writes in his own assistant
  // chat after a refresh was built, then its context names the refresh plan, once.
  it("tells the owner's own assistant chat once of a refresh plan built", () => {
    const dir = fixture("Refreshes", "land: pull-request\n");
    writeFileSync(
      join(dir, "plans", "refresh-after-41.md"),
      "# The queue's open pull requests carry test after #41\n\nShort plan, 15 November 2026, by the assistant with Javi; the executor builds it.\n\nLands: refresh.\n\n## Built, 15 November 2026\n\nRefreshed: #43 at 1a2b3c4d; left: #38, another person's.\n\n## What was asked\n",
    );
    const prompt = (text = "How are the pull requests?") =>
      runIn(
        dir,
        ["prompt"],
        { CLAUDE_PLUGIN_OPTION_OWNER: "Javi" },
        { session_id: `refreshes-${process.pid}`, agent_type: "assistant", prompt: text },
      );
    const told = join(dir, ".claude", "refreshes.told.json");
    // A heartbeat is not his message: nothing is told, and nothing is marked.
    expect(prompt("Heartbeat.")).not.toContain("Refreshed since");
    expect(existsSync(told)).toBe(false);
    const first = prompt();
    expect(JSON.parse(first).hookSpecificOutput.additionalContext).toBe(
      'Refreshed since Javi last wrote here: plans/refresh-after-41.md. Say to him first, in a line, which pull requests were brought up to date and which were left, from each plan\'s "Built".',
    );
    expect(prompt()).toBe("");
  });

  // plans/one-assistant-chat.md, part 2: when the assistant's prompt is
  // Heartbeat., then the prompt hook adds one line and not the queue's listing.
  it("answers the assistant's heartbeat with one line of the work under way, and the ceiling's", () => {
    const dir = fixture("Heartbeat", "land: pull-request\n");
    const transcript = join(dir, "transcript.jsonl");
    const context = (tokens: number) =>
      writeFileSync(
        transcript,
        `${JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { model: "claude-opus-5-5", usage: { input_tokens: tokens } } })}\n`,
      );
    // The building plan's executor is listed with no process: not running.
    const gone = "99999999-0000-0000-0000-000000000000";
    const rows = JSON.stringify([
      { sessionId: gone, name: "Heartbeat Executor 1", kind: "background", cwd: dir },
    ]);
    const said = (prompt = "Heartbeat.") => {
      const out = runIn(
        dir,
        ["prompt"],
        { CLAUDE_PLUGIN_OPTION_OWNER: "Javi", WORKFLOW_LIVE: rows },
        {
          session_id: `heartbeat-${process.pid}`,
          agent_type: "workflow:assistant",
          prompt,
          transcript_path: transcript,
        },
      );
      return out ? JSON.parse(out).hookSpecificOutput.additionalContext : "";
    };
    context(40_000);
    expect(said()).toBe("Nothing is under way.");
    writeFileSync(
      join(dir, "plans", "ready.md"),
      "# Ready\n\nPlan only, 24 November 2026, for Javi; the executor builds it.\n",
    );
    writeFileSync(
      join(dir, "plans", "building.md"),
      `# Building\n\nPlan only, 24 November 2026, for Javi; the executor builds it.\n\n## Building, 24 November 2026, session ${gone}\n`,
    );
    // A fault, in a clause.
    expect(said()).toBe(
      "Work under way: 1 building, 1 waiting, 0 asking; plans/building.md's executor is not running.",
    );
    expect(said()).not.toContain("Plans in the queue");
    context(160_000);
    expect(said()).toBe(
      "Work under way: 1 building, 1 waiting, 0 asking; plans/building.md's executor is not running.\nThis chat is over its ceiling (160k of 150k).",
    );
    // His own message gets the ceiling's line alone.
    expect(said("What is building?")).toBe("This chat is over its ceiling (160k of 150k).");
    // plans/open-assistant-reads-github-notes.md, part 3: when the heartbeat comes while a note
    // waits unhandled, then its line ends naming it, with or without plans under way.
    context(40_000);
    mkdirSync(join(dir, "plans", "github"));
    const note = join(dir, "plans", "github", "7.md");
    writeFileSync(
      note,
      "# GitHub #7: T\n\nfailed, 24 November 2026 15:00, Checks run 1 on 4f1c2b9a: https://github.com/o/r/actions/runs/1\n\n",
    );
    const old = (Date.now() - 11 * 60_000) / 1000;
    utimesSync(note, old, old);
    expect(said()).toBe(
      "Work under way: 1 building, 1 waiting, 0 asking; plans/building.md's executor is not running; plans/github/7.md from GitHub is not handled.",
    );
    rmSync(join(dir, "plans", "ready.md"));
    rmSync(join(dir, "plans", "building.md"));
    expect(said()).toBe(
      "Work under way: 0 building, 0 waiting, 0 asking; plans/github/7.md from GitHub is not handled.",
    );
    // A note under ten minutes old keeps the heartbeat, unnamed (Codex C7).
    utimesSync(note, new Date(), new Date());
    expect(said()).toBe("Work under way: 0 building, 0 waiting, 0 asking.");
    // The chat runs the assistant's agent: its state says so (part 1).
    const state = stateFile(`heartbeat-${process.pid}`);
    expect(JSON.parse(readFileSync(state, "utf8")).agent).toBe("assistant");
    rmSync(state, { force: true });
  });

  it("reads the run a fix pushed straight sets off after the pull requests' checks, in the pull request mode", () => {
    const dir = fixture("Straight", "land: pull-request\nrun: checks.yml\n");
    writeFileSync(join(dir, "README"), "one\n");
    g(dir, "add", ".");
    g(dir, "commit", "-q", "-m", "one");
    const sha = g(dir, "rev-parse", "HEAD");
    const bin = temp("queue-gh-straight-");
    const run = `echo '[{"databaseId":7,"status":"completed","conclusion":"failure","headSha":"${sha}"}]'`;
    // No pull request of this checkout: the run on the push is read.
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nif [ "$1 $2" = "pr list" ]; then echo '[]'; else ${run}; fi\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    // No webhook here, so the pull requests' failed checks are read.
    const env = { PATH: `${bin}:${process.env.PATH}`, WORKFLOW_SECRETS_FILE: "" };
    const stop = (active: boolean, id = "straight") =>
      runIn(dir, ["stop"], env, {
        session_id: `${id}-${process.pid}`,
        agent_type: "executor",
        stop_hook_active: active,
      });
    // HEAD is no fix this queue pushed straight (another person's merge, say): no run read.
    expect(stop(false, "straight-none")).toBe("");
    writeFileSync(
      join(dir, "plans", "fix.md"),
      `# F\n\nPlan only, 30 October 2026, for Javi.\n\nLands: fix, now.\n\n## Built, ${today()}\n\nPushed straight to test as a fix, commit ${sha.slice(0, 8)}; checks.yml green.\n`,
    );
    const first = stop(false);
    expect(first).toContain('"decision":"block"');
    expect(first).toContain("(7) is failed");
    expect(stop(true)).toBe("");
    // Both red: the pull request is named first.
    g(dir, "branch", "land-x");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nif [ "$1 $2" = "pr list" ]; then echo '[{"number":21,"url":"https://github.com/o/r/pull/21","headRefName":"land-x","headRefOid":"${sha}","statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"FAILURE"}]}]'; else ${run}; fi\n`,
    );
    // Both red: the pull request is named first, and the run with it.
    const both = stop(false, "straight-both");
    expect(both).toContain("pull request #21");
    expect(both.indexOf("pull request #21")).toBeLessThan(both.indexOf("(7) is failed"));
    expect(stop(true, "straight-both")).toBe("");
  });

  // plans/project-follow-ups-reach-the-project.md, part 4.
  it("holds the executor's stop once until a built plan's brief is in its project's plans", () => {
    const dir = fixture("Carrier");
    const docs = temp("queue-docs-");
    mkdirSync(join(docs, "plans"));
    const id = `carrier-${process.pid}`;
    const plan = (from: string) =>
      `# C\n\n## Building, 31 October 2026, session ${id}\n\nPlan only, 31 October 2026, for Javi.\n${from}\n## Built, 31 October 2026\n\nPushed to test as commit 0123abcd.\n\n## For Docs: plans/x.md\n\nTitle: X.\n`;
    writeFileSync(join(dir, "plans", "c.md"), plan(`From: Docs, ${docs}.\n`));
    const stop = () => runIn(dir, ["stop"], {}, { session_id: id, agent_type: "executor" });
    const first = stop();
    expect(first).toContain('"decision":"block"');
    expect(first).toContain(`${docs}/plans/x.md is not written`);
    expect(stop()).toBe("");
    const state = (sid: string) => JSON.parse(readFileSync(stateFile(sid), "utf8"));
    expect(state(id).told).toContain("for:plans/c.md:plans/x.md");
    // Written, a new session's stop passes.
    // Another's file of the name is no brief of this plan's.
    writeFileSync(join(docs, "plans", "x.md"), "# X\n");
    const other = `carrier-other-${process.pid}`;
    writeFileSync(join(dir, "plans", "c.md"), plan(`From: Docs, ${docs}.\n`).replace(id, other));
    expect(runIn(dir, ["stop"], {}, { session_id: other, agent_type: "executor" })).toContain(
      "is not written",
    );
    writeFileSync(
      join(docs, "plans", "x.md"),
      `# X\n\nBrief for the planner, from ${dir}/plans/c.md.\n`,
    );
    const again = `carrier-written-${process.pid}`;
    writeFileSync(join(dir, "plans", "c.md"), plan(`From: Docs, ${docs}.\n`).replace(id, again));
    expect(runIn(dir, ["stop"], {}, { session_id: again, agent_type: "executor" })).toBe("");
    // No From line: refused once with the From words.
    const bare = `carrier-bare-${process.pid}`;
    writeFileSync(join(dir, "plans", "c.md"), plan("").replace(id, bare));
    const told = runIn(dir, ["stop"], {}, { session_id: bare, agent_type: "executor" });
    expect(told).toContain("but names no checkout for it");
    expect(runIn(dir, ["stop"], {}, { session_id: bare, agent_type: "executor" })).toBe("");
    // The Building line taken out at "Built": the session's own record still holds the plan.
    const held = `carrier-held-${process.pid}`;
    rmSync(join(docs, "plans", "x.md"));
    writeFileSync(join(dir, "plans", "c.md"), plan(`From: Docs, ${docs}.\n`).replace(id, held));
    runIn(
      dir,
      ["wrote"],
      {},
      {
        session_id: held,
        agent_type: "executor",
        tool_name: "Write",
        tool_input: { file_path: join(dir, "plans", "c.md") },
      },
    );
    writeFileSync(
      join(dir, "plans", "c.md"),
      plan(`From: Docs, ${docs}.\n`).replace(/^## Building, [^\n]*\n\n/m, ""),
    );
    expect(runIn(dir, ["stop"], {}, { session_id: held, agent_type: "executor" })).toContain(
      "is not written",
    );
    // Another session that never held it is not asked.
    expect(
      runIn(
        dir,
        ["stop"],
        {},
        { session_id: `carrier-none-${process.pid}`, agent_type: "executor" },
      ),
    ).toBe("");
    for (const sid of [id, again, other, bare, held, `carrier-none-${process.pid}`])
      rmSync(stateFile(sid), { force: true });
  });

  it("refuses the first stop on a red pull request of this checkout, in the pull request mode", () => {
    const dir = fixture("Pull", "land: pull-request\nrun: checks.yml\n");
    writeFileSync(join(dir, "README"), "one\n");
    g(dir, "add", ".");
    g(dir, "commit", "-q", "-m", "one");
    g(dir, "branch", "land-x");
    const sha = g(dir, "rev-parse", "land-x");
    const bin = temp("queue-gh-pr-");
    // A `gh` that answers `pr list` only: the run list is not the mode's.
    const answer = (rollup: string) =>
      writeFileSync(
        join(bin, "gh"),
        `#!/bin/sh\nif [ "$1 $2" = "pr list" ]; then echo '[{"number":21,"url":"https://github.com/o/r/pull/21","headRefName":"land-x","headRefOid":"${sha}","statusCheckRollup":[${rollup}]}]'; else echo '[{"databaseId":7,"status":"completed","conclusion":"failure","headSha":"${sha}"}]'; fi\n`,
      );
    const actionsJob =
      '{"__typename":"CheckRun","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"https://github.com/o/r/actions/runs/7/job/8"}';
    answer(actionsJob);
    chmodSync(join(bin, "gh"), 0o755);
    // No webhook here, so the pull request's failed checks are read.
    const env = { PATH: `${bin}:${process.env.PATH}`, WORKFLOW_SECRETS_FILE: "" };
    const stop = (active: boolean) =>
      runIn(dir, ["stop"], env, {
        session_id: `red-pull-${process.pid}`,
        agent_type: "executor",
        stop_hook_active: active,
      });
    const first = stop(false);
    expect(first).toContain('"decision":"block"');
    expect(first).toContain("pull request #21");
    expect(first).not.toContain("(7) is failed");
    expect(first).toContain("have failed, and no webhook brings that to the assistant here.");
    expect(stop(true)).toBe("");
    // With a webhook listening the assistant has the failure: the stop passes
    // (plans/executor-never-watches-ci.md, part 4); a secret with no listener
    // alive still names the failure (/code-review).
    const hooked = (id: string) =>
      runIn(
        dir,
        ["stop"],
        { ...env, WORKFLOW_WEBHOOK_SECRET: "s3cret" },
        { session_id: `${id}-${process.pid}`, agent_type: "executor" },
      );
    expect(hooked("red-pull-down")).toContain("pull request #21");
    writeFileSync(
      join(dir, ".claude", "webhook.json"),
      JSON.stringify({ pid: process.pid, port: 1, at: Date.now() }),
    );
    expect(hooked("red-pull-hook")).toBe("");
    // Another service's check failed beside it: refused once, in its own words, while the
    // webhook listens (plans/failed-runs-the-webhook-misses.md, part 4).
    answer(
      `${actionsJob},{"__typename":"StatusContext","state":"FAILURE","context":"ci/external"}`,
    );
    const other = hooked("red-pull-other");
    expect(other).toContain('"decision":"block"');
    expect(other).toContain(
      "A check by another service on pull request #21 (https://github.com/o/r/pull/21) has failed, and the webhook brings only Actions runs to the assistant.",
    );
    expect(
      runIn(
        dir,
        ["stop"],
        { ...env, WORKFLOW_WEBHOOK_SECRET: "s3cret" },
        {
          session_id: `red-pull-other-${process.pid}`,
          agent_type: "executor",
          stop_hook_active: true,
        },
      ),
    ).toBe("");
    rmSync(join(dir, ".claude", "webhook.json"));
    // Checks still running are not waited on.
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nif [ "$1 $2" = "pr list" ]; then echo '[{"number":21,"url":"https://github.com/o/r/pull/21","headRefName":"land-x","headRefOid":"${sha}","statusCheckRollup":[{"__typename":"CheckRun","status":"IN_PROGRESS","conclusion":null}]}]'; else echo '[]'; fi\n`,
    );
    expect(
      runIn(dir, ["stop"], env, {
        session_id: `red-pull-running-${process.pid}`,
        agent_type: "executor",
      }),
    ).toBe("");
    // The branch moved on: the pull request's head is no longer this checkout's.
    g(dir, "checkout", "-q", "land-x");
    writeFileSync(join(dir, "README"), "two\n");
    g(dir, "commit", "-q", "-am", "two");
    expect(stop(false)).toBe("");
  });

  // plans/checks-read-with-the-app.md, part 1: when GitHub refuses the person's token a pull
  // request's checks and the project has an app that can read them, then the stop is refused as
  // it is today; with no app, the refusal is written down and plans says it.
  it("reads a pull request's checks with the app's token when the person's is refused", () => {
    const dir = fixture("Checks", "land: pull-request\nrun: checks.yml\n");
    writeFileSync(join(dir, "README"), "one\n");
    g(dir, "add", ".");
    g(dir, "commit", "-q", "-m", "one");
    g(dir, "branch", "land-x");
    g(dir, "remote", "add", "origin", "https://github.com/o/r.git");
    const sha = g(dir, "rev-parse", "land-x");
    const bin = temp("queue-gh-app-");
    const answer = (refuse: boolean) =>
      writeFileSync(
        join(bin, "gh"),
        `#!/bin/sh\ncase "$*" in *statusCheckRollup*) ${refuse ? `if [ "$GH_TOKEN" != "app-tok" ]; then echo "GraphQL: Resource not accessible by personal access token (repository.pullRequests.nodes.0)" >&2; exit 1; fi;; ` : ";;"} esac\nif [ "$1 $2" = "pr list" ]; then echo '[{"number":21,"url":"https://github.com/o/r/pull/21","headRefName":"land-x","headRefOid":"${sha}","statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"https://github.com/o/r/actions/runs/7/job/8"}]}]'; else echo '[]'; fi\n`,
      );
    answer(true);
    chmodSync(join(bin, "gh"), 0o755);
    writeFileSync(
      join(dir, ".claude", "app-token.json"),
      JSON.stringify({
        token: "app-tok",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        repo: "o/r",
        app: "12",
      }),
    );
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      GH_TOKEN: "person-tok",
      WORKFLOW_GH: "",
      WORKFLOW_SECRETS_FILE: "",
      WORKFLOW_WEBHOOK_SECRET: "",
    };
    const app = { ...env, WORKFLOW_APP_ID: "12", WORKFLOW_APP_KEY: "key" };
    const bare = { ...env, WORKFLOW_APP_ID: "", WORKFLOW_APP_KEY: "" };
    const stop = (extra: Record<string, string>, id: string) =>
      runIn(dir, ["stop"], extra, { session_id: `${id}-${process.pid}`, agent_type: "executor" });
    const seenFile = join(dir, ".claude", "github-seen.json");
    const seen = () => (existsSync(seenFile) ? JSON.parse(readFileSync(seenFile, "utf8")) : {});
    const refused = stop(app, "checks-app");
    expect(refused).toContain('"decision":"block"');
    expect(refused).toContain("pull request #21");
    expect(refused).toContain("have failed, and no webhook brings that to the assistant here.");
    expect(seen().checksUnread).toBeUndefined();
    // No app: the stop passes, and the refusal is written down and said.
    expect(stop(bare, "checks-bare")).toBe("");
    expect(seen().checksUnread.why).toBe(
      "GraphQL: Resource not accessible by personal access token",
    );
    expect(runIn(dir, ["list"], bare)).toMatch(
      /\nGitHub: the pull requests' checks could not be read at \d\d:\d\d \(GraphQL: Resource not accessible by personal access token\), so the Stop hook names no failed check; GH_TOKEN needs Checks and Commit statuses read\.\n/,
    );
    // A later stop whose token is answered takes it away.
    answer(false);
    expect(stop(bare, "checks-later")).toContain("pull request #21");
    expect(seen().checksUnread).toBeUndefined();
    expect(runIn(dir, ["list"], bare)).not.toContain("could not be read");
  });

  describe("the lock", () => {
    it.each([
      ["an empty lock", null],
      ["a released lock", { sessionId: "gone", released: 1 }],
    ])(
      "gives one of two prompt hooks racing for %s the lock, and blocks the other",
      async (_, old) => {
        const dir = fixture("Race");
        if (old) writeFileSync(join(dir, ".claude", "executor.1.lock"), JSON.stringify(old));
        const ids = [`race-a-${process.pid}`, `race-b-${process.pid}`];
        const live = JSON.stringify(
          ids.map((sessionId, i) => ({ sessionId, name: `Race Executor ${i + 1}`, cwd: dir })),
        );
        const prompt = (sessionId: string) =>
          new Promise<string>((done, fail) => {
            const child = spawn("node", [join(here, queue), "prompt"], {
              env: { ...process.env, CLAUDE_PROJECT_DIR: dir, WORKFLOW_LIVE: live },
            });
            let out = "";
            child.stdout.on("data", (chunk) => (out += chunk));
            child.on("error", fail);
            child.on("close", () => done(out));
            child.stdin.end(
              JSON.stringify({
                session_id: sessionId,
                agent_type: "executor",
                cwd: join(dir, ".claude", "worktrees", "executor-1"),
              }),
            );
          });
        const outs = await Promise.all(ids.map(prompt));
        const blocked = outs.filter((out) => out.includes("Another executor is building"));
        const answered = outs.filter((out) => out.includes("Plans in the queue"));
        expect(blocked).toHaveLength(1);
        expect(answered).toHaveLength(1);
        const lock = JSON.parse(readFileSync(join(dir, ".claude", "executor.1.lock"), "utf8"));
        expect(lock.sessionId).toBe(ids[outs.indexOf(answered[0])]);
        for (const id of ids) rmSync(stateFile(id), { force: true });
      },
    );
    it("takes a released lock and a dead holder's, and not a live one's", () => {
      const path = join(fixture("Lock"), ".claude", "executor.1.lock");
      writeFileSync(path, JSON.stringify({ sessionId: "old", released: 1 }));
      expect(takeLock("new", [], { path, alive: () => true })).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8")).sessionId).toBe("new");
      expect(existsSync(`${path}.stale`)).toBe(false);
      expect(takeLock("other", [], { path, alive: () => true })).toBe(false);
      expect(takeLock("other", [], { path, alive: () => false })).toBe(true);
      expect(takeLock("other", [], { path, alive: () => true })).toBe(true);
      expect(existsSync(`${path}.guard`)).toBe(false);
    });
  });

  it("holds a deferral through a pause, and re-arms it at the resume", () => {
    const dir = fixture("Pause");
    // A process with a deferral timer's command line, which the pause kills.
    const fake = join(dir, "plan-queue.mjs");
    writeFileSync(fake, "setTimeout(() => {}, 60000);\n");
    // Started through a shell, so once killed it is reaped and not left a zombie.
    const timer = {
      pid: Number(
        execFileSync("sh", ["-c", `node "${fake}" start --timer 1 >/dev/null 2>&1 & echo $!`], {
          encoding: "utf8",
        }),
      ),
    };
    pids.push(timer.pid);
    const file = join(dir, ".claude", "executor.deferred");
    const until = Date.now() + 3_600_000;
    writeFileSync(
      file,
      JSON.stringify({ until, why: "the five-hour window", paths: ["plans/p.md"], pid: timer.pid }),
    );
    const paused = runIn(dir, ["pause"]);
    expect(paused).toContain("Held: plans/p.md (until");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ pid: null, until });
    const alive = () => {
      try {
        process.kill(timer.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const by = Date.now() + 2000;
    while (alive() && Date.now() < by) execFileSync("sleep", ["0.05"]);
    expect(alive()).toBe(false);
    expect(runIn(dir, ["list"])).toContain("plans/p.md, held while the queue is paused");
    const resumed = runIn(dir, ["resume"]);
    expect(resumed).toContain("Re-armed: plans/p.md (until");
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.pid).toBeGreaterThan(0);
    pids.push(after.pid);
  });

  describe("two projects apart", () => {
    it("starts B beside A's live executor, A's lock and A's pause", () => {
      const a = fixture("A");
      const b = fixture("B");
      withOrigin(b);
      const log = join(temp("queue-log-"), "starts.log");
      writeFileSync(
        log,
        `${JSON.stringify({ at: Date.now() - 3_600_000, name: "A Executor 1" })}\n`,
      );
      writeFileSync(
        join(a, ".claude", "executor.1.lock"),
        JSON.stringify({ sessionId: "a-exec", pid: process.pid, released: false }),
      );
      const live = JSON.stringify([
        { sessionId: "a-exec", name: "A Executor 1", kind: "background", cwd: a },
      ]);
      const dry = () =>
        runIn(b, ["start", "--dry", "plans/x.md"], {
          WORKFLOW_LIVE: live,
          WORKFLOW_STARTS_LOG: log,
          WORKFLOW_USAGE_FILE: join(b, ".claude", "usage.json"),
        });
      const first = dry();
      expect(first).toContain(
        `Would run: claude "--add-dir" "${join(b, "plans")}" "--bg" "--name" "B Executor 1 (lab)"`,
      );
      // A session of the same name in another checkout still takes its number.
      const second = runIn(b, ["start", "--dry", "plans/x.md"], {
        WORKFLOW_LIVE: JSON.stringify([
          { sessionId: "elsewhere", name: "B Executor 1 (lab)", kind: "background", cwd: "/x" },
        ]),
        WORKFLOW_STARTS_LOG: log,
        WORKFLOW_USAGE_FILE: join(b, ".claude", "usage.json"),
      });
      expect(second).toContain('"--bg" "--name" "B Executor 2 (lab)"');
      // An executor is a background chat in no list of the owner's
      // (decisions.md#session-names).
      for (const line of [first, second]) expect(line).not.toContain('"--remote-control"');
      writeFileSync(join(a, ".claude", "executor.pause"), JSON.stringify({ at: "now" }));
      expect(dry()).toContain('"B Executor 1 (lab)"');
    });
    it("counts no session with no working directory, unless its own files name it", () => {
      expect(inThisRepo(undefined, ["/w/a"])).toBe(false);
      const rows = [{ sessionId: "lock-holder", name: "A Executor 1" }];
      expect(ownRows(rows, { paths: ["/w/a"], lockIds: ["lock-holder"] })).toEqual(rows);
      expect(ownRows(rows, { paths: ["/w/b"] })).toEqual([]);
      expect(ownRows(rows, { paths: ["/w/b"], named: ["lock-holder"] })).toEqual(rows);
      // plans/short-session-id-is-live.md: named by a start of eight or more.
      const held = [{ sessionId: "abcd1234-0000", name: "A Executor 2" }];
      expect(ownRows(held, { paths: ["/w/b"], named: ["abcd1234"] })).toEqual(held);
      expect(ownRows(held, { paths: ["/w/b"], named: ["abcd123"] })).toEqual([]);
    });
    it("stops nothing of A's from B's rows", () => {
      const rows = [
        { sessionId: "a-planner", name: "A Planner 1", kind: "background", cwd: "/w/a" },
      ];
      const stopped: string[] = [];
      stopRetiredPlanners(ownRows(rows, { paths: ["/w/b"] }), {
        stateFor: () => ({ agent: "planner", retired: true }),
        stop: (id: string) => stopped.push(id),
      });
      expect(stopped).toEqual([]);
    });
  });

  describe("a start sees its session, or says why not", () => {
    /** A `claude` in place of the real one: `agents --json` from a file, `--bg` by `STUB`. */
    const stub = () => {
      const dir = temp("queue-claude-");
      return { script: fakeClaude(dir), rows: join(dir, "rows.json") };
    };
    const startIn = (dir: string, env: Record<string, string>, args = ["plans/x.md"]) => {
      withOrigin(dir);
      const { WORKFLOW_LIVE: _, ...rest } = process.env;
      return execFileSync("node", [join(here, queue), "start", ...args], {
        encoding: "utf8",
        env: {
          ...rest,
          CLAUDE_PROJECT_DIR: dir,
          WORKFLOW_STARTS_LOG: join(dir, ".claude", "starts.log"),
          WORKFLOW_USAGE_FILE: join(dir, ".claude", "usage.json"),
          ...env,
        },
      });
    };

    it("says why an untrusted start did not start, and logs nothing", { timeout: 30_000 }, () => {
      const dir = fixture("Untrusted");
      const { script, rows } = stub();
      const said = startIn(dir, { WORKFLOW_CLAUDE: script, STUB_ROWS: rows, STUB: "untrusted" });
      expect(said).toMatch(
        /Untrusted Executor 1 \(lab\) was not started: Workspace not trusted\. .*, then retry; its output is in \.claude\/executor\.\d+\.started\./,
      );
      expect(existsSync(join(dir, ".claude", "starts.log"))).toBe(false);
    });
    it(
      "a start whose launcher prints a backgrounded line is said as started, though claude agents has no row yet",
      { timeout: 30_000 },
      () => {
        const dir = fixture("Backgrounded");
        const { script, rows } = stub();
        // A warning printed before the confirmation hides nothing (Codex C2).
        const said = startIn(dir, {
          WORKFLOW_CLAUDE: script,
          STUB_ROWS: rows,
          STUB: "backgrounded",
          STUB_WARNING: "A newer version is available.",
        });
        expect(said).not.toContain("was not started");
        expect(said).toContain("Backgrounded Executor 1 (lab) was started on: plans/x.md");
        expect(readFileSync(join(dir, ".claude", "starts.log"), "utf8")).toContain(
          '"name":"Backgrounded Executor 1 (lab)"',
        );
      },
    );
    it(
      "a backgrounded line naming another session is no confirmation of this start",
      { timeout: 30_000 },
      () => {
        // Another start's line in the same output file (Codex C1).
        const dir = fixture("Other");
        const { script, rows } = stub();
        const said = startIn(dir, {
          WORKFLOW_CLAUDE: script,
          STUB_ROWS: rows,
          STUB: "backgrounded",
          STUB_BG_NAME: "Other Executor 2 (lab)",
        });
        expect(said).toContain(
          "Other Executor 1 (lab) was not started: backgrounded · 1234abcd · Other Executor 2 (lab); its output is in .claude/executor.",
        );
        expect(existsSync(join(dir, ".claude", "starts.log"))).toBe(false);
      },
    );
    it("logs a start whose session appears", { timeout: 30_000 }, () => {
      const dir = fixture("Seen");
      const { script, rows } = stub();
      const said = startIn(dir, { WORKFLOW_CLAUDE: script, STUB_ROWS: rows });
      expect(said).toContain("Seen Executor 1 (lab) was started on: plans/x.md, in executor-1.");
      expect(readFileSync(join(dir, ".claude", "starts.log"), "utf8")).toContain(
        '"name":"Seen Executor 1 (lab)"',
      );
    });
    // plans/start-output-per-start.md: each start's output is its own file,
    // gone once the start is confirmed, kept and named when it is not.
    it("a confirmed start leaves no output file", { timeout: 60_000 }, () => {
      const outputs = (dir: string) =>
        readdirSync(join(dir, ".claude")).filter((file) => /^executor\.(.*\.)?started$/.test(file));
      const seen = fixture("Gone");
      const listed = stub();
      expect(startIn(seen, { WORKFLOW_CLAUDE: listed.script, STUB_ROWS: listed.rows })).toContain(
        "Gone Executor 1 (lab) was started on: plans/x.md, in executor-1.",
      );
      expect(outputs(seen)).toEqual([]);
      // Confirmed by claude --bg's line alone, as well.
      const printed = fixture("Printed");
      const bg = stub();
      expect(
        startIn(printed, { WORKFLOW_CLAUDE: bg.script, STUB_ROWS: bg.rows, STUB: "backgrounded" }),
      ).toContain("Printed Executor 1 (lab) was started on: plans/x.md");
      expect(outputs(printed)).toEqual([]);
    });
    it(
      "a start not confirmed for want of claude agents keeps its output file and names it",
      { timeout: 60_000 },
      () => {
        const dir = fixture("Unread");
        const script = join(temp("unread-claude-"), "claude");
        writeFileSync(
          script,
          `#!/usr/bin/env node\nif (process.argv[2] === "agents") process.exit(1);\nconsole.log("Starting.");\n`,
        );
        chmodSync(script, 0o755);
        const said = startIn(dir, { WORKFLOW_CLAUDE: script });
        const kept =
          /claude agents could not be read, so it is not confirmed; its output is in \.claude\/(executor\.\d+\.started)\./.exec(
            said,
          );
        expect(kept).not.toBeNull();
        expect(readFileSync(join(dir, ".claude", kept![1]), "utf8")).toContain("Starting.");
      },
    );
    // plans/loop-guard-counts-failures.md, parts 2 to 4.
    describe("the owner's word past five executors with nothing built", () => {
      const words = "Yes, we should continue";
      const looping = "The last five executors ended with nothing built; something is looping.";
      /** A project whose log holds five executors within the hour, none built anything. */
      const looped = (name: string) => {
        const dir = fixture(name);
        const now = Date.now();
        writeFileSync(
          join(dir, ".claude", "starts.log"),
          [60, 50, 40, 30, 20]
            .map(
              (ago, i) =>
                `${JSON.stringify({ at: now - ago * 60_000, name: `${name} Executor ${i + 1} (lab)`, paths: ["plans/x.md"], five: 10, seven: 10 })}\n`,
            )
            .join(""),
        );
        return dir;
      };

      it("a dry run prints the refusal, and with his words what it would start", () => {
        const dir = looped("Dry");
        const { script, rows } = stub();
        const env = { WORKFLOW_CLAUDE: script, STUB_ROWS: rows };
        expect(startIn(dir, env, ["--dry", "plans/x.md"])).toContain(
          `${looping} Javi decides: a yes starts one more, by plans start --owner-said "<the words>".`,
        );
        const said = startIn(dir, env, ["--dry", "--owner-said", words, "plans/x.md"]);
        expect(said).toMatch(/^Would run: claude .*"Dry Executor 6 \(lab\)"/m);
        expect(said).toContain(`Would start on Javi's word, past: ${looping}`);
      });

      it("starts one more on his words and logs them", { timeout: 30_000 }, () => {
        const dir = looped("Said");
        const { script, rows } = stub();
        const said = startIn(dir, { WORKFLOW_CLAUDE: script, STUB_ROWS: rows }, [
          "--owner-said",
          ` ${words}\n `,
          "plans/x.md",
        ]);
        const sentence = `Javi said to start it ("${words}"), past: ${looping}`;
        expect(said).toContain("Said Executor 6 (lab) was started on: plans/x.md, in executor-1.");
        expect(said).toContain(sentence);
        const last = JSON.parse(
          readFileSync(join(dir, ".claude", "starts.log"), "utf8")
            .trim()
            .split("\n")
            .at(-1)!,
        );
        expect(last).toMatchObject({ name: "Said Executor 6 (lab)", said: words });
        expect(last.why).toContain(sentence);
      });

      it("a start deferred by usage keeps his words for the timer", { timeout: 30_000 }, () => {
        const dir = looped("Later");
        const { script, rows } = stub();
        const now = Date.now() / 1000;
        writeFileSync(
          join(dir, ".claude", "usage.json"),
          JSON.stringify({
            at: now,
            five_hour: { used_percentage: 90, resets_at: now + 3600 },
          }),
        );
        const said = startIn(dir, { WORKFLOW_CLAUDE: script, STUB_ROWS: rows }, [
          "--owner-said",
          words,
          "plans/x.md",
        ]);
        expect(said).toContain("Deferred until");
        const file = join(dir, ".claude", "executor.deferred");
        const deferred = JSON.parse(readFileSync(file, "utf8"));
        const pids = [deferred.pid];
        const cmdline = (pid: number) => readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        try {
          expect(deferred).toMatchObject({ said: words, paths: ["plans/x.md"] });
          expect(cmdline(deferred.pid)).toEqual(expect.arrayContaining(["--owner-said", words]));
          // A second plan joins the deferral, and the word stays with it.
          startIn(dir, { WORKFLOW_CLAUDE: script, STUB_ROWS: rows }, ["plans/y.md"]);
          const both = JSON.parse(readFileSync(file, "utf8"));
          pids.push(both.pid);
          expect(both).toMatchObject({ said: words, paths: ["plans/x.md", "plans/y.md"] });
          // Started on his word with the window open again, x spends it: y
          // is left deferred without it, its timer re-armed with no word (Codex C2).
          writeFileSync(join(dir, ".claude", "usage.json"), JSON.stringify({ at: now }));
          expect(
            startIn(dir, { WORKFLOW_CLAUDE: script, STUB_ROWS: rows }, [
              "--owner-said",
              words,
              "plans/x.md",
            ]),
          ).toContain("Later Executor 6 (lab) was started on: plans/x.md, in executor-1.");
          const left = JSON.parse(readFileSync(file, "utf8"));
          pids.push(left.pid);
          expect(left.paths).toEqual(["plans/y.md"]);
          expect(left).not.toHaveProperty("said");
          expect(left.pid).not.toBe(both.pid);
          expect(cmdline(left.pid)).not.toContain("--owner-said");
          expect(cmdline(left.pid)).toContain("plans/y.md");
        } finally {
          for (const pid of pids)
            try {
              process.kill(pid);
            } catch {
              // Gone already.
            }
        }
      });
    });

    // plans/brief-lease-per-brief.md, part 1.
    it(
      "keeps a lease per brief: two entries, one timer at the earlier, and the file goes with the last",
      { timeout: 30_000 },
      () => {
        const dir = fixture("Leases");
        const file = join(dir, ".claude", "handed.deferred");
        const call = (code: string) =>
          execFileSync(
            "node",
            [
              "--input-type=module",
              "-e",
              `import * as q from ${JSON.stringify(join(here, queue))};\n${code}`,
            ],
            { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir } },
          );
        const timers: number[] = [];
        const read = () => {
          const table = JSON.parse(readFileSync(file, "utf8"));
          timers.push(table.pid);
          return table;
        };
        const armedAt = (pid: number) =>
          readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
        const now = Date.now();
        const b = { until: now + 40 * 60_000, why: "waiting for B", holder: "h-b", held: false };
        const c = { until: now + 35 * 60_000, why: "handed to C", holder: "h-c", held: true };
        try {
          expect(call("console.log(JSON.stringify(q.leases()));").trim()).toBe("{}");
          call(`q.lease("plans/b.md", ${JSON.stringify(b)});`);
          call(`q.lease("plans/c.md", ${JSON.stringify(c)});`);
          // leases() reads both, each with its own until, why, holder and held.
          expect(JSON.parse(call("console.log(JSON.stringify(q.leases()));"))).toEqual({
            "plans/b.md": b,
            "plans/c.md": c,
          });
          // One timer, at the earlier until.
          const both = read();
          expect(both.paths).toEqual(["plans/b.md", "plans/c.md"]);
          expect(both.until).toBe(c.until);
          if (existsSync("/proc")) expect(armedAt(both.pid)).toContain(`--timer ${c.until} `);
          // Releasing one leaves the other, its timer at its own time.
          call(`q.releaseLease(["plans/c.md"]);`);
          const one = read();
          expect(one.leases).toEqual({ "plans/b.md": b });
          expect(one.until).toBe(b.until);
          if (existsSync("/proc")) expect(armedAt(one.pid)).toContain(`--timer ${b.until} `);
          // The last one takes the file with it.
          call(`q.releaseLease(["plans/b.md"]);`);
          expect(existsSync(file)).toBe(false);
        } finally {
          for (const pid of timers)
            try {
              process.kill(pid);
            } catch {
              // Gone already.
            }
        }
      },
    );
    // plans/briefs-reach-a-free-planner.md, parts 3 and 4, and
    // plans/brief-lease-per-brief.md, parts 1 and 2.
    it(
      "leases a brief left with a busy planner, ends the lease at its Planning line, and starts a fresh planner at its end",
      { timeout: 90_000 },
      () => {
        const dir = fixture("Lease");
        const brief = (title: string) =>
          `# ${title}\n\nBrief for the planner, 6 November 2026, by the assistant with Javi.\n\nWhat.\n`;
        writeFileSync(join(dir, "plans", "b.md"), brief("B"));
        writeFileSync(join(dir, "plans", "c.md"), brief("C"));
        const projects = temp("queue-lease-projects-");
        const row = (n: number, status: object) => ({
          sessionId: `lease-planner-${n}`,
          name: `Lease Planner ${n} (lab)`,
          kind: "background",
          cwd: dir,
          ...status,
        });
        const deferred = join(dir, ".claude", "handed.deferred");
        const env = {
          WORKFLOW_PROJECTS: projects,
          WORKFLOW_STARTS_LOG: join(dir, ".claude", "starts.log"),
          WORKFLOW_USAGE_FILE: join(dir, ".claude", "usage.json"),
          WORKFLOW_LIVE: JSON.stringify([row(1, { status: "busy" })]),
        };
        const timers: number[] = [];
        const read = () => {
          const table = JSON.parse(readFileSync(deferred, "utf8"));
          timers.push(table.pid);
          return table;
        };
        const at = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
        const listed = () =>
          execFileSync(
            "node",
            [
              "--input-type=module",
              "-e",
              `import { list } from ${JSON.stringify(join(here, queue))};
             console.log(list({ live: [] }));`,
            ],
            { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env } },
          );
        // A lease's end brought forward, as the clock would bring it.
        const due = (path: string) => {
          const table = JSON.parse(readFileSync(deferred, "utf8"));
          table.leases[path].until = Date.now() - 1000;
          writeFileSync(deferred, JSON.stringify(table));
        };
        const { script, rows } = stub();
        const { WORKFLOW_LIVE: _, ...rest } = process.env;
        const timer = (paths: string[], live: object[]) => {
          writeFileSync(rows, JSON.stringify(live));
          return execFileSync(
            "node",
            [
              join(here, queue),
              "start",
              "--timer",
              String(Date.now() - 1000),
              "--agent",
              "planner",
              "--deferral",
              "handed",
              ...paths,
            ],
            {
              encoding: "utf8",
              env: {
                ...rest,
                ...env,
                WORKFLOW_LIVE: "",
                CLAUDE_PROJECT_DIR: dir,
                WORKFLOW_CLAUDE: script,
                STUB_ROWS: rows,
              },
            },
          );
        };
        try {
          // A dry run says the same line and writes nothing.
          const dry = runIn(dir, ["start", "--dry", "--agent", "planner", "plans/b.md"], env);
          expect(dry).toContain(
            "Lease Planner 1 (lab) [lease-pl] is busy, with room for plans/b.md (no context known): its Stop hook names the next brief waiting, so nothing is sent. It has until ",
          );
          expect(existsSync(deferred)).toBe(false);
          const before = Date.now();
          const said = runIn(dir, ["start", "--agent", "planner", "plans/b.md"], env);
          expect(said).toContain(
            "Lease Planner 1 (lab) [lease-pl] is busy, with room for plans/b.md",
          );
          const first = read();
          const b = first.leases["plans/b.md"];
          expect(first.paths).toEqual(["plans/b.md"]);
          expect(b).toMatchObject({ holder: "lease-planner-1", held: false });
          expect(b.why).toMatch(
            /^waiting for Lease Planner 1 \(lab\) \[lease-pl\] since \d\d:\d\d$/,
          );
          expect(b.until).toBeGreaterThanOrEqual(before + 30 * 60_000);
          expect(b.until).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
          expect(said).toContain(`It has until ${at(b.until)}`);
          // A second brief, left with a second planner, idle: its own lease,
          // held by message, beside the first.
          const two = {
            ...env,
            WORKFLOW_LIVE: JSON.stringify([row(1, { status: "busy" }), row(2, { status: "idle" })]),
          };
          const saidC = runIn(dir, ["start", "--agent", "planner", "plans/c.md"], two);
          expect(saidC).toContain(
            "Lease Planner 2 (lab) [lease-pl] is idle with room for plans/c.md",
          );
          const both = read();
          const c = both.leases["plans/c.md"];
          expect(both.paths).toEqual(["plans/b.md", "plans/c.md"]);
          expect(both.leases["plans/b.md"]).toEqual(b);
          expect(c).toMatchObject({ holder: "lease-planner-2", held: true });
          expect(c.why).toMatch(
            /^handed to Lease Planner 2 \(lab\) \[lease-pl\] at \d\d:\d\d by message$/,
          );
          expect(saidC).toContain(`It has until ${at(c.until)}`);
          expect(both.until).toBe(b.until);
          // A brief sent by message is its holder's: named by path, refused.
          expect(runIn(dir, ["start", "--agent", "planner", "plans/c.md"], two)).toContain(
            `plans/c.md was sent to Lease Planner 2 (lab) [lease-pl] at ${at(c.until - 30 * 60_000)} and is its until ${at(c.until)}; plans shows the briefs.\n`,
          );
          // `plans` says who holds each and until when, a line per brief.
          const lines = listed();
          expect(lines).toContain(`Deferred until ${at(b.until)}: ${b.why}; plans/b.md\n`);
          expect(lines).toContain(`Deferred until ${at(c.until)}: ${c.why}; plans/c.md\n`);
          // b's end: its planner waits on a question, so a fresh planner is
          // started beside it on b alone (numbered by the live and the log,
          // where the second is gone), and c keeps its own lease.
          due("plans/b.md");
          expect(
            timer(
              ["plans/b.md", "plans/c.md"],
              [row(1, { status: "waiting", waitingFor: "input needed", state: "blocked" })],
            ),
          ).toBe("");
          expect(readFileSync(join(dir, ".claude", "starts.log"), "utf8")).toContain(
            '"name":"Lease Planner 2 (lab)","paths":["plans/b.md"]',
          );
          // Seen, the start leaves no output file of its own.
          expect(
            readdirSync(join(dir, ".claude")).filter((file) =>
              /^planner\.(.*\.)?started$/.test(file),
            ),
          ).toEqual([]);
          const left = read();
          expect(left.leases).toEqual({ "plans/c.md": c });
          expect(left.until).toBe(c.until);
          // c's end with its holder busy with room: the lease renews thirty
          // minutes, the same words with the new time, and `plans` names it.
          due("plans/c.md");
          const renewing = Date.now();
          expect(timer(["plans/c.md"], [row(2, { status: "busy" })])).toBe("");
          const renewed = read().leases["plans/c.md"];
          expect(renewed).toMatchObject({ holder: "lease-planner-2", held: false });
          expect(renewed.until).toBeGreaterThanOrEqual(renewing + 30 * 60_000);
          expect(renewed.why).toBe(
            `waiting for Lease Planner 2 (lab) [lease-pl] since ${at(renewed.until - 30 * 60_000)}`,
          );
          expect(listed()).toContain(
            `Deferred until ${at(renewed.until)}: ${renewed.why}; plans/c.md\n`,
          );
          expect(readFileSync(join(dir, ".claude", "starts.log"), "utf8")).not.toContain(
            '"paths":["plans/c.md"]',
          );
          // Its Planning line on c ends c's lease, and the file with it.
          writeFileSync(
            join(dir, "plans", "c.md"),
            `## Planning, 6 November 2026, session lease-planner-2\n\n${brief("C")}`,
          );
          runIn(dir, ["wrote"], env, {
            session_id: "lease-planner-2",
            agent_type: "planner",
            tool_name: "Edit",
            tool_input: { file_path: join(dir, "plans", "c.md") },
          });
          expect(existsSync(deferred)).toBe(false);
        } finally {
          for (const pid of timers)
            try {
              process.kill(pid);
            } catch {
              // Gone already.
            }
          rmSync(projects, { recursive: true, force: true });
        }
      },
    );
  });
});

/** **The cache-aware queue** (plans/cache-aware-queue.md): reuse by context and the cache. */
describe("the cache-aware queue", () => {
  const MIN = 60_000;
  const now = Date.UTC(2026, 9, 27, 14, 0);
  const at = (minutes: number, k: number) => ({ context: k * 1000, at: now - minutes * MIN });

  it("mayReuse: by the ceiling and the cache, today's numbers with no history", () => {
    expect(mayReuse({ usage: at(1, 150), now })).toEqual({
      reuse: true,
      why: "its context is 150k tokens, under the ceiling of 200k (no history yet: today's numbers)",
    });
    expect(mayReuse({ usage: at(1, 250), now }).why).toBe(
      "its context is 250k tokens, over the ceiling of 200k (no history yet: today's numbers)",
    );
    expect(mayReuse({ usage: at(1, 150), now, fallback: 100_000 }).reuse).toBe(false);
    expect(mayReuse({ usage: at(70, 200), now }).why).toContain(
      "its cache has gone cold after 70 minutes idle",
    );
    expect(mayReuse({ usage: at(70, 40), now })).toMatchObject({ reuse: true });
    expect(mayReuse({})).toEqual({ reuse: true, why: "no context known" });
  });

  it("sessionUsage reads the last assistant turn's context and time, and null without a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-"));
    const file = join(dir, "t.jsonl");
    const turn = (n: number, time: string) =>
      JSON.stringify({
        type: "assistant",
        timestamp: time,
        message: {
          usage: {
            input_tokens: n,
            cache_read_input_tokens: 1000 * n,
            cache_creation_input_tokens: 10,
          },
        },
      });
    writeFileSync(
      file,
      [
        turn(1, "2026-10-27T13:00:00Z"),
        JSON.stringify({ type: "user", message: { content: "hi" } }),
        turn(2, "2026-10-27T13:30:00Z"),
        turn(3, "2026-10-27T13:59:00Z"),
        "",
      ].join("\n"),
    );
    try {
      expect(sessionUsage(file)).toEqual({
        context: 3 + 3000 + 10,
        at: Date.parse("2026-10-27T13:59:00Z"),
      });
      // Its model, for the ceiling's prices, when the turn names one.
      writeFileSync(
        file,
        `${JSON.stringify({ type: "assistant", timestamp: "2026-10-27T13:59:00Z", message: { model: "claude-fable-5-1", usage: { input_tokens: 5 } } })}\n`,
      );
      expect(sessionUsage(file)).toMatchObject({ context: 5, model: "claude-fable-5-1" });
      expect(sessionUsage(join(dir, "none.jsonl"))).toBeNull();
      expect(transcriptOf({ sessionId: "s1", cwd: "/home/v/.claude/x" }, "/p")).toBe(
        "/p/-home-v--claude-x/s1.jsonl",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("decideStop and decidePlannerStop retire with the ceiling's reason", () => {
    const waiting = [{ path: "plans/a.md", shared: 0, asks: false }];
    expect(decideStop({ waiting, usage: at(1, 300), now })).toMatchObject({
      retire: true,
      why: expect.stringContaining("over the ceiling of 200k"),
    });
    expect(decidePlannerStop({ waiting, usage: at(1, 500), now })).toMatchObject({
      retire: true,
      why: expect.stringContaining("over the ceiling of 160k"),
    });
    expect(decideStop({ waiting, usage: at(1, 100), now })).toMatchObject({ refuse: true });
  });

  const one = (status: string, k: number, kind = "executor", minutes = 1) => ({
    kind,
    sessionId: `${kind}-${status}-${k}`,
    id: "",
    name: `Test ${kind === "planner" ? "Planner" : "Executor"} 1`,
    status,
    usage: at(minutes, k),
    fallback: 200_000,
    where: "checkout",
    branch: "",
    holdsLock: false,
    retired: false,
    on: "",
  });

  it("canStart replaces a stale idle session, and refuses a busy or a reusable one", () => {
    const usage = {
      at: now / 1000,
      five_hour: { used_percentage: 10, resets_at: now / 1000 + 3600 },
    };
    const replaced = canStart({ now, usage, name: "Test", sessions: [one("idle", 300)] as never });
    expect(replaced).toMatchObject({ start: true, replace: [{ sessionId: "executor-idle-300" }] });
    expect(canStart({ now, usage, sessions: [one("busy", 300)] as never })).toMatchObject({
      refuse: true,
    });
    expect(canStart({ now, usage, sessions: [one("idle", 100)] as never }).why).toContain(
      "An executor is alive",
    );
    // A lock the replaced session holds does not refuse the start.
    expect(
      canStart({
        now,
        usage,
        alive: () => true,
        lock: { sessionId: "executor-idle-300", released: false } as never,
        sessions: [one("idle", 300)] as never,
      }),
    ).toMatchObject({ start: true });
  });

  it("canStart, unwatched, replaces an idle executor whatever its warmth, and never a busy one", () => {
    const usage = {
      at: now / 1000,
      five_hour: { used_percentage: 10, resets_at: now / 1000 + 3600 },
    };
    const warm = one("idle", 100);
    expect(
      canStart({ now, usage, name: "Test", sessions: [warm] as never, unwatched: true }),
    ).toMatchObject({
      start: true,
      replace: [
        {
          sessionId: "executor-idle-100",
          why: "idle while a plan's thirty minutes ran out, and the queue cannot message it",
        },
      ],
    });
    expect(
      canStart({ now, usage, sessions: [one("busy", 100)] as never, unwatched: true }),
    ).toMatchObject({ refuse: true });
    expect(
      canStart({ now, usage, sessions: [one("waiting for input", 300)] as never, unwatched: true }),
    ).toMatchObject({ refuse: true });
    // Watched, the warm idle one refuses as before.
    expect(canStart({ now, usage, sessions: [warm] as never }).why).toContain(
      "An executor is alive",
    );
  });

  it("canStart never replaces a session with a plan under way, and skips a synthetic turn", () => {
    const usage = {
      at: now / 1000,
      five_hour: { used_percentage: 10, resets_at: now / 1000 + 3600 },
    };
    const building = { ...one("idle", 300), on: "plans/a.md" };
    expect(canStart({ now, usage, sessions: [building] as never })).toMatchObject({ refuse: true });
    const dir = mkdtempSync(join(tmpdir(), "synthetic-"));
    try {
      const file = join(dir, "t.jsonl");
      writeFileSync(
        file,
        [
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-10-27T13:00:00Z",
            message: { usage: { input_tokens: 5, cache_read_input_tokens: 500_000 } },
          }),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-10-27T13:05:00Z",
            message: { model: "<synthetic>", usage: { input_tokens: 0 } },
          }),
          "",
        ].join("\n"),
      );
      expect(sessionUsage(file)?.context).toBe(500_005);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("canStart starts a planner beside a busy stale one, and waits for a busy one under the ceiling", () => {
    const usage = {
      at: now / 1000,
      five_hour: { used_percentage: 10, resets_at: now / 1000 + 3600 },
    };
    const beside = canStart({
      kind: "planner",
      now,
      usage,
      sessions: [one("busy", 300, "planner")] as never,
    });
    expect(beside).toMatchObject({ start: true });
    expect(beside.note).toContain("Started beside Test Planner 1");
    expect(beside.note).toContain("busy with a context of 300k (its context is 300k tokens");
    const waited = canStart({
      kind: "planner",
      now,
      usage,
      sessions: [one("busy", 100, "planner")] as never,
    });
    expect(waited).toMatchObject({ wait: true });
    expect(waited.why).toContain("its Stop hook names the next brief waiting, so nothing is sent");
  });

  it("describeSession shows the context and its warmth", () => {
    const warm = {
      ...one("busy", 618),
      fallback: 700_000,
      usage: { context: 618_000, at: Date.now() - 2 * MIN },
    };
    expect(describeSession(warm as never)).toContain("618k context, warm");
    const cold = { ...one("idle", 200), usage: { context: 200_000, at: Date.now() - 130 * MIN } };
    expect(describeSession(cold as never)).toContain("200k context, cold 130 min");
    expect(describeSession(one("idle", 300) as never)).toContain(", over its ceiling,");
  });

  // plans/adaptive-reuse.md: each agent's ceiling worked out from measured
  // inputs and raised by what the work shares with the chat.
  const inputs = {
    planner: { sessions: 21, start: 35_000, turns: 70, model: "claude-fable-5-1" },
    executor: { sessions: 39, start: 49_000, turns: 79, model: "claude-opus-5-5" },
  };
  const plannerUnder =
    "its context is 200k tokens, under the ceiling of 289k worked out here (fresh start 35k, 70 turns, 100k shared, Fable 5.1 prices)";
  const plannerOver =
    "its context is 200k tokens, over the ceiling of 75k worked out here (fresh start 35k, 70 turns, 0k shared, Fable 5.1 prices)";

  it("mayReuse with a context of 200k keeps a planner that shares 100k and retires one that shares nothing, and says why either way", () => {
    const usage = at(1, 200);
    expect(mayReuse({ usage, shared: 100_000, inputs, kind: "planner", now })).toEqual({
      reuse: true,
      why: plannerUnder,
    });
    expect(mayReuse({ usage, inputs, kind: "planner", now })).toEqual({
      reuse: false,
      why: plannerOver,
    });
    // Cold, the shared reading is written again: 135k cold, so 200k retires
    // with the cold words, and 100k is kept.
    expect(mayReuse({ usage: at(70, 200), shared: 100_000, inputs, kind: "planner", now })).toEqual(
      {
        reuse: false,
        why: "its cache has gone cold after 70 minutes idle, and rewriting 200k tokens costs more than a fresh start",
      },
    );
    expect(
      mayReuse({ usage: at(70, 100), shared: 100_000, inputs, kind: "planner", now }).reuse,
    ).toBe(true);
    // The session's own model sets the prices: Opus's for a planner gives a lower ceiling.
    expect(
      mayReuse({
        usage: { ...usage, model: "claude-opus-5-5" },
        shared: 100_000,
        inputs,
        kind: "planner",
        now,
      }).why,
    ).toContain("Opus 5.5 prices");
  });

  it("decidePlannerStop names the oldest brief it has room for with what it shares, and says why", () => {
    const older = { path: "plans/older.md", shared: 0 };
    const newer = { path: "plans/newer.md", shared: 100_000 };
    const kept = decidePlannerStop({ waiting: [older, newer], usage: at(1, 200), now, inputs });
    expect(kept).toMatchObject({
      refuse: true,
      told: ["plans/newer.md"],
      kept: { paths: ["plans/newer.md"], why: plannerUnder },
    });
    expect((kept as { reason: string }).reason).toContain(
      `A brief is waiting and this session can take it: plans/newer.md (${plannerUnder}).`,
    );
    expect(
      decidePlannerStop({ waiting: [older, newer], usage: at(1, 50), now, inputs }),
    ).toMatchObject({ refuse: true, told: ["plans/older.md"] });
    expect(decidePlannerStop({ waiting: [older], usage: at(1, 200), now, inputs })).toEqual({
      retire: true,
      why: plannerOver,
    });
  });

  it("decideStop takes the plans an executor has room for with what they share, and leaves the rest to a fresh executor", () => {
    const waiting = [
      { path: "plans/a.md", shared: 0, asks: false },
      { path: "plans/b.md", shared: 100_000, asks: false },
    ];
    const kept = decideStop({ waiting, usage: at(1, 200), now, inputs });
    expect(kept).toMatchObject({
      refuse: true,
      told: ["plans/b.md"],
      kept: { paths: ["plans/b.md"] },
    });
    expect((kept as { reason: string }).reason).toContain(
      "can take it: plans/b.md (its context is 200k tokens, under the ceiling of 224k worked out here (fresh start 49k, 79 turns, 100k shared, Opus 5.5 prices)).",
    );
    // At the next stop, b built, a goes to a fresh executor.
    expect(
      decideStop({ waiting: [waiting[0]], told: ["plans/b.md"], usage: at(1, 210), now, inputs }),
    ).toMatchObject({ retire: true, paths: ["plans/a.md"] });
    // b declined and still waiting: a is not held for it; both go to a fresh
    // executor (Javi, 5 November).
    expect(
      decideStop({ waiting, told: ["plans/b.md"], usage: at(1, 210), now, inputs }),
    ).toMatchObject({ retire: true, paths: ["plans/a.md", "plans/b.md"] });
    // Every plan named and b with room, still waiting: declined, a fresh
    // executor takes it (plans/executor-takes-next-ready-plan.md).
    expect(
      decideStop({ waiting: [waiting[1]], told: ["plans/b.md"], usage: at(1, 210), now, inputs }),
    ).toMatchObject({ retire: true, declined: true, paths: ["plans/b.md"] });
    // Under both, every plan, as before.
    expect(decideStop({ waiting, usage: at(1, 50), now, inputs })).toMatchObject({
      told: ["plans/a.md", "plans/b.md"],
    });
  });

  it("canStart waits for a busy planner at 250k for a brief that shares 100k, starts beside it for one that shares nothing, and replaces it idle", () => {
    const usage = {
      at: now / 1000,
      five_hour: { used_percentage: 10, resets_at: now / 1000 + 3600 },
    };
    const held = (status: string, shared: number) => ({
      ...one(status, 250, "planner"),
      holds: ["plans/own.md"],
      shared,
    });
    const messaged = canStart({
      kind: "planner",
      now,
      usage,
      name: "Test",
      brief: "plans/next.md",
      inputs,
      sessions: [held("busy", 100_000)] as never,
    });
    // Busy: nothing is sent; its Stop hook names the brief (plans/briefs-reach-a-free-planner.md).
    expect(messaged).toMatchObject({ wait: true });
    expect(messaged.why).toContain(
      "Test Planner 1 [planner-] is busy, with room for plans/next.md (its context is 250k tokens, under the ceiling of 289k worked out here (fresh start 35k, 70 turns, 100k shared, Fable 5.1 prices)): its Stop hook names the next brief waiting, so nothing is sent.",
    );
    expect(messaged.why).not.toContain("SendMessage");
    const beside = canStart({
      kind: "planner",
      now,
      usage,
      name: "Test",
      inputs,
      sessions: [held("busy", 0)] as never,
    });
    expect(beside).toMatchObject({ start: true });
    expect(beside.note).toContain("Started beside Test Planner 1");
    expect(
      canStart({
        kind: "planner",
        now,
        usage,
        name: "Test",
        inputs,
        sessions: [held("idle", 0)] as never,
      }),
    ).toMatchObject({
      start: true,
      replace: [
        {
          sessionId: "planner-idle-250",
          why: "its context is 250k tokens, over the ceiling of 75k worked out here (fresh start 35k, 70 turns, 0k shared, Fable 5.1 prices)",
        },
      ],
    });
  });

  it("canStart keeps an executor for plans that share enough with its batch (Codex C1)", () => {
    const usage = {
      at: now / 1000,
      five_hour: { used_percentage: 10, resets_at: now / 1000 + 3600 },
    };
    const idle = (shared: number) => ({ ...one("idle", 200), shared });
    expect(
      canStart({ now, usage, name: "Test", inputs, sessions: [idle(100_000)] as never }).why,
    ).toContain("An executor is alive");
    expect(
      canStart({ now, usage, name: "Test", inputs, sessions: [idle(0)] as never }),
    ).toMatchObject({ start: true, replace: [{ sessionId: "executor-idle-200" }] });
  });

  it("usageWords says over its ceiling, worked out with what the row shares, and never for an assistant", () => {
    const row = (k: number, shared = 0) => ({
      kind: "planner",
      inputs,
      shared,
      usage: { context: k * 1000, at: Date.now() - MIN },
    });
    expect(usageWords(row(300) as never)).toBe("300k context, warm, over its ceiling");
    expect(usageWords(row(200, 100_000) as never)).toBe("200k context, warm");
    expect(usageWords(row(50) as never)).toBe("50k context, warm");
    // No history: today's 160k for a planner.
    expect(usageWords({ ...row(150), inputs: {} } as never)).toBe("150k context, warm");
    expect(usageWords({ ...row(500), kind: "assistant" } as never)).toBe("500k context, warm");
    // The share, with the work it is judged against, after the warmth.
    const shares = (k: number, shared: number) => ({ ...row(k, shared), sharedWith: "plans/x.md" });
    expect(usageWords(shares(300, 13_000) as never)).toBe(
      "300k context, warm, shares 13k with plans/x.md, over its ceiling",
    );
    expect(usageWords(shares(200, 100_000) as never)).toBe(
      "200k context, warm, shares 100k with plans/x.md",
    );
    expect(usageWords(shares(50, 0) as never)).toBe("50k context, warm");
  });

  it("sweepTemp removes a dead session's temp files older than a day, and keeps a live one's, a fresh one and a folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "sweep-"));
    try {
      const now = Date.now();
      const old = (now - 2 * 24 * 60 * MIN) / 1000;
      const file = (name: string, aged = true) => {
        writeFileSync(join(dir, name), "x");
        if (aged) utimesSync(join(dir, name), old, old);
      };
      file("workflow-queue-dead.json");
      file("workflow-seen-dead.jsonl");
      file("workflow-turn-dead.tools");
      file("workflow-plain-words-live.json");
      file("workflow-queue-live.json");
      file("workflow-seen-fresh.jsonl", false);
      file("other-dead.json");
      // Another tool's file of the same prefix is not the plugin's (/code-review).
      file("workflow-run-dead.log");
      mkdirSync(join(dir, "workflow-hooks-dead.d"));
      utimesSync(join(dir, "workflow-hooks-dead.d"), old, old);
      expect(sweepTemp({ dir, live: ["live"], now })).toBe(3);
      expect(readdirSync(dir).sort()).toEqual([
        "other-dead.json",
        "workflow-hooks-dead.d",
        "workflow-plain-words-live.json",
        "workflow-queue-live.json",
        "workflow-run-dead.log",
        "workflow-seen-fresh.jsonl",
      ]);
      expect(sweepTemp({ dir: join(dir, "missing") })).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("withShare measures an executor against a handed plan before an older ready one", () => {
    const checkout = mkdtempSync(join(tmpdir(), "share-next-"));
    try {
      mkdirSync(join(checkout, "src"));
      writeFileSync(join(checkout, "src", "a.mjs"), "x".repeat(400_000));
      writeFileSync(join(checkout, "src", "b.mjs"), "x".repeat(400_000));
      const rows = [
        {
          sessionId: "e",
          kind: "executor",
          inputs,
          seen: { "src/a.mjs": 13_000, "src/b.mjs": 2_000 },
        },
      ];
      const ready = { path: "plans/old.md", state: "ready", text: "Changes `src/b.mjs`." };
      const handed = { path: "plans/handed.md", state: "handed", text: "Changes `src/a.mjs`." };
      // readPlans's order, handed first; the handed plan is what the queue starts next.
      const [row] = withShare(rows, "executor", [handed, ready], [], { checkout });
      expect(row).toMatchObject({ shared: 13_000, sharedWith: "plans/handed.md" });
      expect(
        usageWords({ ...row, usage: { context: 50_000, at: Date.now() - MIN } } as never),
      ).toBe("50k context, warm, shares 13k with plans/handed.md");
      // A handed plan asking the owner is not started, so not measured (/code-review).
      expect(
        withShare(rows, "executor", [{ ...handed, askingIn: 1 }, ready], [], { checkout })[0],
      ).toMatchObject({ sharedWith: "plans/old.md" });
      // With none handed, the oldest ready plan.
      expect(withShare(rows, "executor", [ready], [], { checkout })[0]).toMatchObject({
        shared: 2_000,
        sharedWith: "plans/old.md",
      });
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it("describeSession shows why a kept session was kept, and not once it is retired", () => {
    const kept = {
      ...one("busy", 180, "planner"),
      inputs,
      shared: 100_000,
      on: "plans/x.md",
      kept: { paths: ["plans/x.md"], why: plannerUnder },
    };
    expect(describeSession(kept as never)).toContain(
      `planning plans/x.md, kept for plans/x.md: ${plannerUnder}`,
    );
    expect(describeSession({ ...kept, retired: true } as never)).not.toContain("kept for");
    // Once the work it was kept for is done, the reason is stale.
    expect(describeSession({ ...kept, on: "" } as never)).not.toContain("kept for");
    const executor = {
      ...one("busy", 150),
      on: "plans/b.md",
      kept: {
        paths: ["plans/a.md", "plans/b.md"],
        why: "its context is 150k tokens, under the ceiling of 200k (no history yet: today's numbers)",
      },
    };
    expect(describeSession(executor as never)).toContain(
      "kept for plans/a.md and plans/b.md: its context is 150k tokens, under the ceiling of 200k (no history yet: today's numbers)",
    );
  });

  it("plans says the ceilings worked out here, or today's numbers with no history, and the last fresh start of each kind with why", () => {
    const reuse = { executor: 200_000, planner: 160_000 };
    expect(ceilingsLine(reuse)).toBe(
      "Ceilings: an executor retires past 200k and a planner past 160k (no history yet: today's numbers).",
    );
    const measured = { at: new Date(2026, 10, 6, 19, 0).getTime(), transcripts: 65 };
    expect(ceilingsLine(reuse, { ...inputs, measured })).toBe(
      "Ceilings: an executor retires past 74k (fresh start 49k, 79 turns, Opus 5.5 prices), a planner past 75k (fresh start 35k, 70 turns, Fable 5.1 prices), plus what a plan or brief shares with the chat; measured from 65 transcripts on 6 November.",
    );
    // A planner with too few sessions keeps today's number beside an executor worked out.
    expect(
      ceilingsLine(reuse, {
        executor: inputs.executor,
        planner: { ...inputs.planner, sessions: 4 },
      }),
    ).toBe(
      "Ceilings: an executor retires past 74k (fresh start 49k, 79 turns, Opus 5.5 prices), a planner past 160k (no history yet: today's numbers), plus what a plan or brief shares with the chat.",
    );
    const log = [
      { at: Date.UTC(2026, 10, 5, 9, 0), name: "Reuse Planner 1 (wp)", paths: ["plans/a.md"] },
      {
        at: new Date(2026, 10, 5, 12, 40).getTime(),
        name: "Reuse Planner 2 (wp)",
        paths: ["plans/x.md"],
        why: "Reuse Planner 1 (wp) [17515cb3] was retired: its context is 250k tokens, over the ceiling of 160k (no history yet: today's numbers).",
      },
      { at: now, name: "Other Executor 3 (wp)", paths: ["plans/b.md"], why: "Other." },
    ];
    expect(lastFreshLines(log, "Reuse")).toEqual([
      "Last fresh planner: Reuse Planner 2 (wp) at 12:40 on 5 November, on plans/x.md; Reuse Planner 1 (wp) [17515cb3] was retired: its context is 250k tokens, over the ceiling of 160k (no history yet: today's numbers).",
    ]);
    const repo = mkdtempSync(join(tmpdir(), "ceilings-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      mkdirSync(join(repo, ".claude"));
      writeFileSync(join(repo, ".claude", "workflow.md"), "---\nname: Reuse\nbranch: test\n---\n");
      writeFileSync(
        join(repo, ".claude", "starts.log"),
        log.map((line) => JSON.stringify(line)).join("\n") + "\n",
      );
      const out = execFileSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `import { list } from ${JSON.stringify(join(here, "plan-queue.mjs"))};
           console.log(list({ live: [] }));`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: repo,
            WORKFLOW_STARTS_LOG: join(repo, ".claude", "starts.log"),
          },
        },
      );
      expect(out).toContain(
        "The planner: none alive.\nCeilings: an executor retires past 200k and a planner past 160k (no history yet: today's numbers).\nLast fresh planner: Reuse Planner 2 (wp) at 12:40 on 5 November, on plans/x.md; Reuse Planner 1 (wp) [17515cb3] was retired:",
      );
      expect(out).not.toContain("Last fresh executor");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("tiredFor and the planner's prompt hook call a planner over its worked-out ceiling tired for a brief that shares too little, and say why", () => {
    const repo = mkdtempSync(join(tmpdir(), "tired-"));
    const id = `tired-${process.pid}`;
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      mkdirSync(join(repo, ".claude"));
      mkdirSync(join(repo, "plans"));
      writeFileSync(join(repo, ".claude", "workflow.md"), "---\nname: Tired\nbranch: test\n---\n");
      writeFileSync(
        join(repo, "plans", "own.md"),
        "# Own\n\nPlan only, 5 November 2026.\n\nChanges `src/a.mjs`.\n",
      );
      writeFileSync(
        join(repo, "plans", "other.md"),
        "# Other\n\nBrief for the planner, 5 November 2026, by the assistant with Javi.\n\nChanges `src/b.mjs`.\n",
      );
      writeFileSync(
        join(repo, "plans", "near.md"),
        "# Near\n\nBrief for the planner, 5 November 2026, by the assistant with Javi.\n\nChanges `src/a.mjs` again.\n",
      );
      // src/a.mjs, which near.md names and the planner read whole: 100k tokens.
      mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, "src", "a.mjs"), "x".repeat(400_000));
      const textOf = (path: string) => readFileSync(join(repo, path), "utf8");
      const state = { agent: "planner", plans: ["plans/own.md"], seen: { "src/a.mjs": 100_000 } };
      const usage = { context: 250_000, at: Date.now() - MIN };
      const options = { usage, textOf, inputs, checkout: repo };
      expect(tiredFor(state, "plans/other.md", options)).toBe(
        "its context is 250k tokens, over the ceiling of 75k worked out here (fresh start 35k, 70 turns, 0k shared, Fable 5.1 prices)",
      );
      expect(tiredFor(state, "plans/near.md", options)).toBe("");
      const transcript = join(repo, "t.jsonl");
      writeFileSync(
        transcript,
        `${JSON.stringify({
          type: "assistant",
          timestamp: new Date().toISOString(),
          message: { usage: { input_tokens: 10, cache_read_input_tokens: 250_000 } },
        })}\n`,
      );
      // The prompt hook reads the count from the log the tool hooks append to.
      const { seen, ...kept } = state;
      writeFileSync(stateFile(id), JSON.stringify(kept));
      noteSeen(id, seen);
      const out = execFileSync("node", [join(here, "plan-queue.mjs"), "prompt"], {
        input: JSON.stringify({
          session_id: id,
          agent_type: "planner",
          transcript_path: transcript,
          prompt: "Plan plans/other.md: it is a brief for the planner.",
        }),
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: repo,
          WORKFLOW_LIVE: "[]",
          WORKFLOW_STARTS_LOG: join(repo, ".claude", "starts.log"),
        },
      });
      expect(out).toContain(
        "This session is too full for plans/other.md (its context is 250k tokens, over the ceiling of 160k (no history yet: today's numbers)): do not plan it; say so and stop.",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateFile(id), { force: true });
      rmSync(seenFile(id), { force: true });
    }
  });

  it("a Stop hook's start deferred by usage keeps the retired session's why for the timer's start", () => {
    const repo = mkdtempSync(join(tmpdir(), "deferred-why-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      mkdirSync(join(repo, ".claude"));
      mkdirSync(join(repo, "plans"));
      writeFileSync(join(repo, ".claude", "workflow.md"), "---\nname: Later\nbranch: test\n---\n");
      // Paused, so the deferral is written and no timer runs.
      writeFileSync(join(repo, ".claude", "executor.pause"), JSON.stringify({ at: "12:00" }));
      execFileSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `import { start } from ${JSON.stringify(join(here, "plan-queue.mjs"))};
           console.log(start(["plans/x.md"], { replace: "old-session", at: Date.now() + 3_600_000, why: "its context is 250k tokens, over the reuse ceiling of 200k: every turn would re-read it" }));`,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, CLAUDE_PROJECT_DIR: repo, WORKFLOW_LIVE: "[]" },
        },
      );
      expect(
        JSON.parse(readFileSync(join(repo, ".claude", "executor.deferred"), "utf8")),
      ).toMatchObject({
        replace: "old-session",
        retired:
          "its context is 250k tokens, over the reuse ceiling of 200k: every turn would re-read it",
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("plans start --dry retires an idle executor whose transcript is over the ceiling", () => {
    const repo = mkdtempSync(join(tmpdir(), "reuse-"));
    const projects = mkdtempSync(join(tmpdir(), "reuse-projects-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      mkdirSync(join(repo, ".claude"));
      mkdirSync(join(repo, "plans"));
      writeFileSync(join(repo, ".claude", "workflow.md"), "---\nname: Reuse\nbranch: test\n---\n");
      const id = "old-executor";
      const slug = join(projects, repo.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(slug, { recursive: true });
      writeFileSync(
        join(slug, `${id}.jsonl`),
        `${JSON.stringify({
          type: "assistant",
          timestamp: new Date().toISOString(),
          message: { usage: { input_tokens: 10, cache_read_input_tokens: 400_000 } },
        })}\n`,
      );
      const out = execFileSync(
        "node",
        [join(here, "plan-queue.mjs"), "start", "--dry", "plans/x.md"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: repo,
            WORKFLOW_PROJECTS: projects,
            WORKFLOW_LIVE: JSON.stringify([
              {
                sessionId: id,
                name: "Reuse Executor 1",
                status: "idle",
                kind: "background",
                cwd: join(repo, ".claude", "worktrees", "executor-1"),
              },
            ]),
            WORKFLOW_STARTS_LOG: join(repo, ".claude", "starts.log"),
            WORKFLOW_USAGE_FILE: join(repo, ".claude", "usage.json"),
          },
        },
      );
      expect(out).toContain("Would run: claude");
      expect(out).toContain("Would retire Reuse Executor 1 [old-exec]: its context is 400k tokens");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(projects, { recursive: true, force: true });
    }
  });
});

/**
 * **A brief reaches a planner that can plan it now** (plans/briefs-reach-a-
 * free-planner.md): a planner is judged at `plans start` by what it can do
 * now, a busy one is never messaged, and a brief left with a live planner is
 * leased to it for thirty minutes.
 */
describe("a brief reaches a free planner", () => {
  const MIN = 60_000;
  const now = Date.UTC(2026, 10, 6, 4, 25);
  const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5);
  const until = hhmm(now + 30 * MIN);
  const usage = {
    at: now / 1000,
    five_hour: { used_percentage: 10, resets_at: now / 1000 + 3600 },
  };
  const fallback = 160_000;
  const planner = (
    n: number,
    status: string,
    k: number | null,
    { on = "", shared = 0, id = "" } = {},
  ) => ({
    kind: "planner",
    sessionId: id || `planner-${n}-0000`,
    id: "",
    name: `Docs Planner ${n}`,
    status,
    usage: k === null ? null : { context: k * 1000, at: now - MIN },
    fallback,
    where: "checkout",
    branch: "",
    holdsLock: false,
    retired: false,
    on,
    holds: [],
    shared,
  });
  const facts = (sessions: object[], brief: string, more: object = {}) => ({
    kind: "planner" as const,
    now,
    usage,
    name: "Docs",
    fallback,
    brief,
    sessions: sessions as never,
    taken: sessions.map((one) => (one as { name: string }).name),
    ...more,
  });
  const over230 =
    "its context is 230k tokens, over the ceiling of 160k (no history yet: today's numbers)";
  const blockedWhy =
    "a question or a prompt is open in its chat, and it takes nothing until Javi answers it";

  it("canStart starts beside a busy planner at 230k with a brief under way and a brief that shares nothing, saying why", () => {
    const busy = planner(34, "busy", 230, { on: "plans/own.md" });
    const decision = canStart(facts([busy], "plans/a.md"));
    expect(decision).toMatchObject({ start: true, name: "Docs Planner 35" });
    expect(decision.note).toBe(
      `Started beside Docs Planner 34 [planner-], which is busy with a context of 230k (${over230}).`,
    );
    expect(decision.replace).toBeUndefined();
  });

  it("canStart starts beside a planner waiting for input whatever its context, saying it waits for Javi's answer", () => {
    for (const k of [10, 230, null]) {
      for (const on of ["", "plans/own.md"]) {
        const blocked = planner(34, "waiting for input", k, { on, shared: 100_000 });
        const decision = canStart(facts([blocked], "plans/a.md"));
        expect(decision).toMatchObject({ start: true });
        expect(decision.note).toContain(
          `Started beside Docs Planner 34 [planner-], which is waiting for input with a context of ${k ?? 0}k (${blockedWhy}).`,
        );
        expect(decision.replace).toBeUndefined();
      }
    }
  });

  it("canStart waits for an idle planner with room: the message to send, and the time it has", () => {
    const idle = planner(35, "idle", 50);
    const decision = canStart(facts([idle], "plans/b.md"));
    expect(decision).toEqual({
      wait: true,
      why: `Docs Planner 35 [planner-] is idle with room for plans/b.md (its context is 50k tokens, under the ceiling of 160k (no history yet: today's numbers)): send it the brief with SendMessage, one message per brief: ${plannerPrompt("plans/b.md")} It has until ${until} to take it; then a fresh planner is started on it.`,
      lease: `handed to Docs Planner 35 [planner-] at ${hhmm(now)} by message`,
      holder: "planner-35-0000",
      until: now + 30 * MIN,
      held: true,
    });
  });

  it("canStart waits for a busy planner with room, and nothing is sent", () => {
    const busy = planner(35, "busy", null, { on: "plans/y.md" });
    const decision = canStart(facts([busy], "plans/b.md"));
    expect(decision).toEqual({
      wait: true,
      why: `Docs Planner 35 [planner-] is busy, planning plans/y.md, with room for plans/b.md (no context known): its Stop hook names the next brief waiting, so nothing is sent. It has until ${until} to take it; then a fresh planner is started on it.`,
      lease: `waiting for Docs Planner 35 [planner-] since ${hhmm(now)}, planning plans/y.md`,
      holder: "planner-35-0000",
      until: now + 30 * MIN,
      held: false,
    });
    expect(decision.why).not.toContain("SendMessage");
  });

  it("canStart, unwatched, replaces an idle planner under its ceiling and starts beside a blocked one", () => {
    const idle = planner(35, "idle", 50, { id: "planner-35-idle" });
    const blocked = planner(34, "waiting for input", 230, { id: "planner-34-blocked" });
    const decision = canStart(facts([blocked, idle], "plans/b.md", { unwatched: true }));
    expect(decision).toMatchObject({
      start: true,
      name: "Docs Planner 36",
      replace: [
        {
          sessionId: "planner-35-idle",
          why: "idle while a brief's thirty minutes ran out, and the queue cannot message it",
        },
      ],
    });
    expect(decision.note).toContain(
      `Started beside Docs Planner 34 [planner-], which is waiting for input with a context of 230k (${blockedWhy}).`,
    );
    // plans/brief-lease-per-brief.md (Decided): a busy planner with room keeps
    // the brief at the lease's end, and the lease renews.
    const busy = planner(37, "busy", 50, { id: "planner-37-busy", on: "plans/y.md" });
    expect(canStart(facts([blocked, idle, busy], "plans/b.md", { unwatched: true }))).toMatchObject(
      {
        wait: true,
        holder: "planner-37-busy",
        held: false,
        lease: `waiting for Docs Planner 37 [planner-] since ${hhmm(now)}, planning plans/y.md`,
      },
    );
  });

  // plans/brief-lease-per-brief.md, part 3: a brief sent by message is its
  // holder's for the lease; one waiting for a busy planner is anyone's.
  it("freeBriefs leaves out a brief held by message by another live planner, and keeps the rest", () => {
    const plans = ["a", "b", "c", "d", "e", "f"]
      .map((x) => ({ path: `plans/${x}.md`, state: "brief" }))
      .concat({ path: "plans/r.md", state: "ready" });
    const later = now + 30 * MIN;
    const table = {
      "plans/a.md": { until: later, why: "", holder: "other", held: true },
      "plans/b.md": { until: later, why: "", holder: "other", held: false },
      "plans/c.md": { until: later, why: "", holder: "self", held: true },
      "plans/d.md": { until: later, why: "", holder: "old", held: true },
      "plans/e.md": { until: later, why: "", holder: "gone", held: true },
      "plans/f.md": { until: now - MIN, why: "", holder: "other", held: true },
    };
    const live = ["other", "self", "old"].map((sessionId, n) => ({
      sessionId,
      name: `Docs Planner ${n + 1}`,
      kind: "background",
    }));
    const free = (stateFor: (id: string) => object) =>
      freeBriefs(plans, { live, self: "self", replace: "old", table, stateFor, now } as never).map(
        (p) => p.path,
      );
    expect(free(() => ({ agent: "planner" }))).toEqual([
      "plans/b.md",
      "plans/c.md",
      "plans/d.md",
      "plans/e.md",
      "plans/f.md",
    ]);
    // A retired holder holds nothing.
    expect(free((id) => ({ agent: "planner", retired: id === "other" }))).toContain("plans/a.md");
    // With the sessions unread, a held lease is kept until its timer settles it.
    expect(
      freeBriefs(plans, { live: null, self: "self", table, now } as never).map((p) => p.path),
    ).not.toContain("plans/e.md");
  });

  // plans/briefs-reach-a-free-planner-follow-up.md: "A chat holds every plan
  // it wrote until a Building line takes it", at the timer too.
  it("canStart, unwatched, starts beside an idle planner that holds a plan not yet building", () => {
    // plans/planner-holds-unread-plan.md: a plan the queue cannot read is held too.
    for (const stands of ["ready, for the executor", "not read by the queue"]) {
      const holding = {
        ...planner(35, "idle", 50, { id: "planner-35-holds" }),
        holds: ["plans/p.md"],
        standing: { "plans/p.md": stands },
      };
      const decision = canStart(facts([holding], "plans/b.md", { unwatched: true }));
      expect(decision).toMatchObject({ start: true, name: "Docs Planner 36" });
      expect(decision.replace).toBeUndefined();
      expect(decision.note).toBe(
        "Started beside Docs Planner 35 [planner-], which is idle with a context of 50k (idle while a brief's thirty minutes ran out, and the queue cannot message it).",
      );
    }
  });

  // plans/planner-holds-unread-plan.md: a held plan the queue cannot read is
  // told from one whose file is gone.
  it("says a held plan with no header is not read by the queue, and gone once deleted", () => {
    const dir = mkdtempSync(join(tmpdir(), "workflow-unread-held-"));
    mkdirSync(join(dir, "plans"));
    writeFileSync(join(dir, "plans", "h.md"), "# H\n\nNotes, the header misplaced.\n");
    const held = () =>
      describeSession(
        sessionsOf(
          "planner",
          [
            {
              sessionId: "p1000000-0000",
              name: "Docs Planner 1",
              kind: "background",
              status: "idle",
            },
          ],
          [],
          {
            trees: [],
            plans: [],
            checkout: dir,
            stateFor: () => ({ agent: "planner", plans: ["plans/h.md"] }),
            usageFor: () => null,
          } as never,
        )[0],
      );
    try {
      expect(held()).toContain("holds plans/h.md (not read by the queue)");
      // Built or dropped all the same, it is not held (/code-review).
      writeFileSync(join(dir, "plans", "h.md"), "# H\n\n## Built, 6 November 2026\n\nDone.\n");
      expect(held()).toContain("holds plans/h.md (built)");
      rmSync(join(dir, "plans", "h.md"));
      expect(held()).toContain("holds plans/h.md (gone)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("canStart, unwatched, replaces an idle planner whose only plan is built, building or gone", () => {
    for (const stands of ["built", "building, Docs Executor 3 (lab)", "gone", "dropped", "old"]) {
      const done = {
        ...planner(35, "idle", 50, { id: "planner-35-done" }),
        holds: ["plans/p.md"],
        standing: { "plans/p.md": stands },
      };
      const decision = canStart(facts([done], "plans/b.md", { unwatched: true }));
      expect(decision).toMatchObject({
        start: true,
        replace: [
          {
            sessionId: "planner-35-done",
            why: "idle while a brief's thirty minutes ran out, and the queue cannot message it",
          },
        ],
      });
    }
  });

  it("canStart starts beside an idle planner over its ceiling with a brief under way, and never retires it", () => {
    const idle = planner(34, "idle", 230, { on: "plans/own.md" });
    const decision = canStart(facts([idle], "plans/a.md"));
    expect(decision).toMatchObject({ start: true });
    expect(decision.replace).toBeUndefined();
    expect(decision.note).toContain("Started beside Docs Planner 34 [planner-], which is idle");
  });

  // The six steps of 6 November, replayed in order (part 6).
  it("replays 6 November: five briefs reach a planner that can plan them, none waits behind a question", () => {
    const p34 = planner(34, "busy", 230, {
      on: "plans/headless-ui-popovers.md",
      id: "8f8eb02c-0000",
    });
    // 1. Planner 34 mid-brief at 230k: a fresh planner beside it for brief a.
    const first = canStart(facts([p34], "plans/a.md"));
    expect(first).toMatchObject({ start: true, name: "Docs Planner 35" });
    expect(first.note).toBe(
      `Started beside Docs Planner 34 [8f8eb02c], which is busy with a context of 230k (${over230}).`,
    );
    // 2. Planner 35 alive and busy, no usage yet: brief b waits for it, nothing sent.
    const p35 = planner(35, "busy", null, { id: "35350000-0000" });
    const second = canStart(facts([p34, p35], "plans/b.md"));
    expect(second).toMatchObject({
      wait: true,
      lease: `waiting for Docs Planner 35 [35350000] since ${hhmm(now)}`,
    });
    expect(second.why).toBe(
      `Docs Planner 35 [35350000] is busy, with room for plans/b.md (no context known): its Stop hook names the next brief waiting, so nothing is sent. It has until ${until} to take it; then a fresh planner is started on it.`,
    );
    // 3. Planner 34 asks Javi: brief c still waits for Planner 35, which has room;
    // with Planner 35 gone, a fresh planner starts beside the blocked one.
    const asking = { ...p34, status: "waiting for input" };
    expect(canStart(facts([asking, p35], "plans/c.md"))).toMatchObject({
      wait: true,
      why: expect.stringContaining("Docs Planner 35 [35350000] is busy"),
    });
    const alone = canStart(facts([asking], "plans/c.md"));
    expect(alone).toMatchObject({ start: true, name: "Docs Planner 35" });
    expect(alone.note).toContain(
      `which is waiting for input with a context of 230k (${blockedWhy})`,
    );
    // 4. The lease's timer, unwatched: Planner 34 blocked, Planner 35 idle under
    // its ceiling: a fresh planner, Planner 35 replaced.
    const idle35 = { ...p35, status: "idle", usage: { context: 90_000, at: now - 2 * MIN } };
    const timer = canStart(facts([asking, idle35], "plans/b.md", { unwatched: true }));
    expect(timer).toMatchObject({
      start: true,
      name: "Docs Planner 36",
      replace: [
        {
          name: "Docs Planner 35",
          why: "idle while a brief's thirty minutes ran out, and the queue cannot message it",
        },
      ],
    });
    // 5. The fresh planner, after its first plan, with four briefs waiting
    // and none told: names the oldest.
    const waiting = ["b", "c", "d", "e"].map((x) => ({ path: `plans/${x}.md`, shared: 0 }));
    expect(
      decidePlannerStop({ waiting, usage: { context: 80_000, at: now - MIN }, now }),
    ).toMatchObject({ refuse: true, told: ["plans/b.md"] });
    // 6. Planner 34, its question answered, with the briefs all under way or planned.
    expect(
      decidePlannerStop({ waiting: [], usage: { context: 240_000, at: now - MIN }, now }),
    ).toBeNull();
  });
});

/**
 * **The ceiling is worked out from measured inputs** (plans/adaptive-reuse.md,
 * part 2): the wash of decisions.md#context-cost from the agent's fresh start
 * and turns here, raised by what the work shares, capped at 480k, and today's
 * numbers while the agent has under five sessions.
 */
describe("the ceiling is worked out from measured inputs", () => {
  const fable = { sessions: 21, start: 35_000, turns: 70, model: "claude-fable-5-1" };
  const inputs = { planner: fable };

  it("gives a planner's wash, warm and cold, and says what it rests on", () => {
    const warm = ceilingFor({ kind: "planner", inputs });
    expect(warm.wash).toBeCloseTo(75_000);
    expect(warm.ceiling).toBeCloseTo(75_000);
    expect(warm.why).toBe(
      "the ceiling of 75k worked out here (fresh start 35k, 70 turns, 0k shared, Fable 5.1 prices)",
    );
    const cold = ceilingFor({ kind: "planner", inputs, warm: false });
    expect(cold.wash).toBe(35_000);
    expect(cold.ceiling).toBe(35_000);
  });

  it("raises the ceiling by what is shared, times the warm factor, and caps it at 480k", () => {
    const shared = ceilingFor({ kind: "planner", inputs, shared: 100_000 });
    expect(Math.round(shared.ceiling / 1000)).toBe(289);
    expect(shared.why).toContain("the ceiling of 289k worked out here");
    expect(shared.why).toContain("100k shared");
    const capped = ceilingFor({ kind: "planner", inputs, shared: 600_000 });
    expect(capped.ceiling).toBe(480_000);
    expect(REUSE_CAP).toBe(480_000);
    expect(capped.why).toBe("the cap of 480k");
    // Cold, the shared reading is written again at the write price.
    expect(ceilingFor({ kind: "planner", inputs, shared: 100_000, warm: false }).ceiling).toBe(
      135_000,
    );
  });

  it("gives a larger project's fresh start a larger ceiling: twice the start, twice the wash", () => {
    const small = ceilingFor({ kind: "planner", inputs });
    const large = ceilingFor({ kind: "planner", inputs: { planner: { ...fable, start: 70_000 } } });
    expect(large.wash).toBeCloseTo(2 * small.wash);
  });

  it("gives today's number with under five sessions of the agent, and says so", () => {
    const few = ceilingFor({
      kind: "planner",
      inputs: { planner: { ...fable, sessions: 4 } },
      fallback: 160_000,
    });
    expect(few.ceiling).toBe(160_000);
    expect(few.why).toBe("the ceiling of 160k (no history yet: today's numbers)");
    expect(ceilingFor({ kind: "executor", inputs }).why).toBe(
      "the ceiling of 200k (no history yet: today's numbers)",
    );
    // Cold, today's 60k.
    expect(ceilingFor({ kind: "executor", warm: false }).ceiling).toBe(60_000);
  });

  it("sharedTokens counts what the chat holds of each file the text names, at most the file's size", () => {
    const checkout = mkdtempSync(join(tmpdir(), "shared-"));
    try {
      mkdirSync(join(checkout, "src"));
      writeFileSync(join(checkout, "src", "a.mjs"), "x".repeat(4000));
      writeFileSync(join(checkout, "src", "b.mjs"), "x".repeat(800));
      writeFileSync(join(checkout, "src", "c.mjs"), "x".repeat(4000));
      writeFileSync(join(checkout, "src", "d.mjs"), "x".repeat(4000));
      const seen = { "src/a.mjs": 300, "src/b.mjs": 5000, "src/gone.mjs": 100, "src/d.mjs": 900 };
      const text = "Change `src/a.mjs` and src/b.mjs, and src/gone.mjs; read src/c.mjs.";
      // a: 300 of its 1000 held; b: read whole, its 200; gone: missing; c: not
      // read; d: read, not named.
      expect(sharedTokens(text, seen, { checkout })).toBe(500);
      expect(sharedTokens(text, {}, { checkout })).toBe(0);
      expect(sharedTokens("Nothing named.", seen, { checkout })).toBe(0);
      // A root file by its bare name: 300 seen of its 200; a bare name with no file, nothing.
      writeFileSync(join(checkout, "NOTES.md"), "x".repeat(800));
      const root = { "NOTES.md": 300, "gone.md": 100 };
      expect(sharedTokens("Read NOTES.md.", root, { checkout })).toBe(200);
      expect(sharedTokens("Read gone.md.", root, { checkout })).toBe(0);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});

/**
 * **The tool hook counts what the chat holds of each file**
 * (plans/shared-file-share.md, part 1; plans/shared-count-fixes.md, part 1):
 * `seenIn`, this call's map from the hook's own input, characters over four;
 * `noteSeen` appends it to the session's log and `seenOf` sums the log.
 */
describe("the tool hook counts what the chat holds of each file", () => {
  let checkout = "";
  beforeAll(() => {
    checkout = mkdtempSync(join(tmpdir(), "seen-"));
    mkdirSync(join(checkout, "src"));
    writeFileSync(join(checkout, "src", "a.mjs"), "a\n");
    writeFileSync(join(checkout, "src", "b.mjs"), "b\n");
    writeFileSync(join(checkout, "CLAUDE.md"), "c\n");
  });
  afterAll(() => rmSync(checkout, { recursive: true, force: true }));
  const of = (input: object) => seenIn(input, { checkout });
  const chars = (n: number) => "x".repeat(n);

  it("a Read gives its text, an Edit its two strings, a MultiEdit its edits, a Write its content", () => {
    const read = of({
      tool_name: "Read",
      tool_input: { file_path: "src/a.mjs" },
      tool_response: { type: "text", file: { filePath: "src/a.mjs", content: chars(4000) } },
    });
    expect(read).toEqual({ "src/a.mjs": 1000 });
    // A response as plain text is counted as it is.
    expect(
      of({ tool_name: "Read", tool_input: { file_path: "src/a.mjs" }, tool_response: chars(400) }),
    ).toEqual({ "src/a.mjs": 100 });
    const edit = {
      tool_name: "Edit",
      tool_input: { file_path: "src/a.mjs", old_string: chars(400), new_string: chars(400) },
      tool_response: { originalFile: chars(100_000) },
    };
    expect(of(edit)).toEqual({ "src/a.mjs": 200 });
    const multi = {
      tool_name: "MultiEdit",
      tool_input: {
        file_path: "src/a.mjs",
        edits: [
          { old_string: chars(100), new_string: chars(300) },
          { old_string: chars(200), new_string: chars(200) },
        ],
      },
    };
    expect(of(multi)).toEqual({ "src/a.mjs": 200 });
    const write = {
      tool_name: "Write",
      tool_input: { file_path: "src/b.mjs", content: chars(2000) },
      tool_response: { filePath: "src/b.mjs", type: "create" },
    };
    expect(of(write)).toEqual({ "src/b.mjs": 500 });
  });

  it("seenOf sums the log's lines on one file, and passes over a line cut short", () => {
    const dir = mkdtempSync(join(tmpdir(), "seen-log-"));
    try {
      const id = "sum";
      noteSeen(id, { "src/a.mjs": 200 }, dir);
      noteSeen(id, { "src/a.mjs": 300, "src/b.mjs": 50 }, dir);
      noteSeen(id, {}, dir);
      expect(readFileSync(seenFile(id, dir), "utf8").split("\n")).toHaveLength(4);
      appendFileSync(seenFile(id, dir), '{"p":"src/b.mj');
      expect(seenOf(id, dir)).toEqual({ "src/a.mjs": 500, "src/b.mjs": 50 });
      expect(seenOf("none", dir)).toEqual({});
      // Nothing to append, no file.
      noteSeen("empty", {}, dir);
      expect(existsSync(seenFile("empty", dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a Bash command's output is split among the files of the checkout it names, and nothing else counts", () => {
    const bash = (command: string, stdout: string, stderr = "") => ({
      tool_name: "Bash",
      tool_input: { command },
      tool_response: { stdout, stderr, interrupted: false, isImage: false },
    });
    expect(of(bash("cat src/a.mjs src/b.mjs", chars(6000), chars(2000)))).toEqual({
      "src/a.mjs": 1000,
      "src/b.mjs": 1000,
    });
    expect(of(bash("npm test", chars(8000)))).toEqual({});
    // A folder, a ref and a file not there are passed over.
    expect(of(bash("ls src/ && git diff origin/test...HEAD src/gone.mjs", chars(800)))).toEqual({});
    expect(of(bash(`sed -n 1,9p ${join(checkout, "src", "a.mjs")}`, chars(400)))).toEqual({
      "src/a.mjs": 100,
    });
    // A root file by its bare name.
    expect(of(bash("cat CLAUDE.md", chars(400)))).toEqual({ "CLAUDE.md": 100 });
    expect(of({ tool_name: "Grep", tool_input: { path: "src/a.mjs" } })).toEqual({});
    // A relative path is the call's cwd's.
    mkdirSync(join(checkout, "src", "inner"), { recursive: true });
    writeFileSync(join(checkout, "src", "inner", "c.mjs"), "c\n");
    const inner = { ...bash("cat inner/c.mjs", chars(400)), cwd: join(checkout, "src") };
    expect(of(inner)).toEqual({ "src/inner/c.mjs": 100 });
  });

  it("a worktree's file counts under the path the plans name it by", () => {
    const tree = join(checkout, ".claude", "worktrees", "exec-1");
    mkdirSync(join(tree, "src"), { recursive: true });
    writeFileSync(join(tree, "src", "a.mjs"), "a\n");
    const edit = (path: string) => ({
      tool_name: "Edit",
      cwd: tree,
      tool_input: { file_path: path, old_string: chars(200), new_string: chars(200) },
    });
    expect(of(edit(join(tree, "src", "a.mjs")))).toEqual({ "src/a.mjs": 100 });
    expect(of(edit("src/a.mjs"))).toEqual({ "src/a.mjs": 100 });
  });

  it("an absolute path inside the checkout counts under its relative path; one outside does not", () => {
    const outside = mkdtempSync(join(tmpdir(), "seen-out-"));
    try {
      writeFileSync(join(outside, "c.mjs"), "c\n");
      const read = (file_path: string) => ({
        tool_name: "Read",
        tool_input: { file_path },
        tool_response: { file: { content: chars(400) } },
      });
      expect(of(read(join(checkout, "src", "b.mjs")))).toEqual({ "src/b.mjs": 100 });
      expect(of(read(join(outside, "c.mjs")))).toEqual({});
      expect(of(read(join(checkout, "src")))).toEqual({});
      // An image or a PDF read is not text the chat holds.
      const image = {
        tool_name: "Read",
        tool_input: { file_path: "src/a.mjs" },
        tool_response: { type: "image", file: { base64: chars(40_000), type: "image/png" } },
      };
      expect(of(image)).toEqual({});
      const pdf = {
        tool_name: "Read",
        tool_input: { file_path: "src/a.mjs" },
        tool_response: { type: "pdf", file: { base64: chars(40_000) } },
      };
      expect(of(pdf)).toEqual({});
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("counts a response of 400 KB in under 50 ms", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "cat src/a.mjs" },
      tool_response: { stdout: chars(400_000), stderr: "" },
    };
    const t0 = performance.now();
    const seen = of(input);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(seen).toEqual({ "src/a.mjs": 100_000 });
  });

  it("the executor's Stop hook says the share by what the chat holds, not the file's size", () => {
    const base = mkdtempSync(join(tmpdir(), "seen-stop-"));
    const ids: string[] = [];
    try {
      const dir = join(base, "checkout");
      mkdirSync(join(dir, ".claude"), { recursive: true });
      mkdirSync(join(dir, "plans"));
      mkdirSync(join(dir, "test"));
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, ".claude", "workflow.md"), "---\nname: Held\nbranch: test\n---\n");
      // A 332 KB test file, 83k tokens whole.
      writeFileSync(join(dir, "test", "hooks.test.ts"), "x".repeat(332_000));
      writeFileSync(
        join(dir, "plans", "p.md"),
        "# P\n\nPlan only, 6 November 2026, for Javi.\n\nChanges `test/hooks.test.ts`.\n",
      );
      // Five executors' transcripts, measured into the summary the hook reads.
      const projects = join(base, "projects");
      const data = join(base, "data");
      const folder = transcriptsDir(dir, projects);
      mkdirSync(folder, { recursive: true });
      for (const name of ["a", "b", "c", "d", "e"])
        writeFileSync(
          join(folder, `${name}.jsonl`),
          [
            JSON.stringify({ type: "agent-setting", agentSetting: "workflow:executor" }),
            ...Array.from({ length: 80 }, (_, i) =>
              JSON.stringify({
                type: "assistant",
                timestamp: new Date(Date.parse("2026-11-01T10:00:00Z") + i * 60_000).toISOString(),
                message: {
                  id: `m${i}`,
                  model: "claude-opus-5-5",
                  usage: { input_tokens: 0, cache_creation_input_tokens: 50_000 + i * 1000 },
                },
              }),
            ),
            "",
          ].join("\n"),
        );
      const inputs = reuseInputs({
        refresh: true,
        dir: folder,
        file: join(data, "reuse", `${basename(folder)}.json`),
      });
      // Under the ceiling with nothing shared, so both stops name the plan with why.
      const context = ceilingFor({ kind: "executor", inputs }).ceiling - 1000;
      const transcript = join(base, "t.jsonl");
      writeFileSync(
        transcript,
        `${JSON.stringify({
          type: "assistant",
          timestamp: new Date().toISOString(),
          message: { model: "claude-opus-5-5", usage: { input_tokens: context } },
        })}\n`,
      );
      const stop = (seen?: Record<string, number>[]) => {
        const id = `seen-stop-${ids.length}-${process.pid}`;
        ids.push(id);
        writeFileSync(stateFile(id), JSON.stringify({ agent: "executor" }));
        // The log's lines, as the tool hooks appended them.
        for (const map of seen || []) noteSeen(id, map);
        return execFileSync("node", [join(here, "plan-queue.mjs"), "stop"], {
          input: JSON.stringify({
            session_id: id,
            agent_type: "executor",
            transcript_path: transcript,
          }),
          encoding: "utf8",
          env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: dir,
            WORKFLOW_LIVE: "[]",
            WORKFLOW_PROJECTS: projects,
            WORKFLOW_DATA: data,
          },
        });
      };
      const held = stop([{ "test/hooks.test.ts": 5_000 }, { "test/hooks.test.ts": 8_000 }]);
      expect(held).toContain("can take it: plans/p.md");
      expect(held).toContain("13k shared");
      expect(held).not.toContain("83k shared");
      expect(stop()).toContain("0k shared");
    } finally {
      rmSync(base, { recursive: true, force: true });
      for (const id of ids)
        for (const file of [`workflow-queue-${id}.json`, `workflow-seen-${id}.jsonl`])
          rmSync(join(tmpdir(), file), { force: true });
    }
  });

  describe("the tool hooks", () => {
    const project = () => {
      const dir = fixture("Seen");
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "a.mjs"), "a\n");
      return dir;
    };
    const stateOf = (id: string) => {
      const file = stateFile(id);
      made.push(file);
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    };
    const logOf = (id: string) => {
      made.push(seenFile(id));
      return existsSync(seenFile(id)) ? seenOf(id) : null;
    };
    const env = (dir: string) => ({ ...process.env, CLAUDE_PROJECT_DIR: dir, WORKFLOW_LIVE: "[]" });
    const wrote = (dir: string, input: object) =>
      execFileSync("node", [join(here, "plan-queue.mjs"), "wrote"], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: env(dir),
      });
    const seen = (dir: string, input: object) =>
      execFileSync("node", [join(here, "seen.mjs")], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: env(dir),
      });
    const bash = { tool_name: "Bash", tool_input: { command: "cat src/a.mjs" } };
    const out = { tool_response: { stdout: "x".repeat(4000), stderr: "" } };
    const reading = (file_path: string, n = 4000) => ({
      tool_name: "Read",
      tool_input: { file_path },
      tool_response: { type: "text", file: { content: "x".repeat(n) } },
    });

    it("a planner's Read appends a line to its log; an assistant's and a subagent's append none", () => {
      const dir = project();
      const id = (who: string) => `seen-${who}-${process.pid}`;
      const read = reading("src/a.mjs");
      expect(
        seen(dir, { session_id: id("planner"), agent_type: "workflow:planner", ...read }),
      ).toBe("");
      expect(readFileSync(seenFile(id("planner")), "utf8")).toBe(
        `${JSON.stringify({ p: "src/a.mjs", t: 1000 })}\n`,
      );
      expect(logOf(id("planner"))).toEqual({ "src/a.mjs": 1000 });
      seen(dir, { session_id: id("assistant"), agent_type: "workflow:assistant", ...read });
      expect(logOf(id("assistant"))).toBeNull();
      seen(dir, { session_id: id("explore"), agent_type: "Explore", ...read });
      expect(logOf(id("explore"))).toBeNull();
      expect(stateOf(id("explore"))).toBeNull();
    });

    it("a planner's Bash through the wrote hook appends its lines and never writes the state", () => {
      const dir = project();
      const id = (who: string) => `seen-wrote-${who}-${process.pid}`;
      wrote(dir, { session_id: id("planner"), agent_type: "workflow:planner", ...bash, ...out });
      wrote(dir, { session_id: id("planner"), agent_type: "workflow:planner", ...bash, ...out });
      expect(logOf(id("planner"))).toEqual({ "src/a.mjs": 2000 });
      // The count never writes the state, so it never writes back over a field set meanwhile.
      expect(stateOf(id("planner"))?.seen).toBeUndefined();
      wrote(dir, {
        session_id: id("assistant"),
        agent_type: "workflow:assistant",
        ...bash,
        ...out,
      });
      expect(logOf(id("assistant"))).toBeNull();
      wrote(dir, { session_id: id("explore"), agent_type: "Explore", ...bash, ...out });
      expect(logOf(id("explore"))).toBeNull();
    });

    it("parallel tool hooks lose no count", async () => {
      const dir = project();
      const id = `seen-parallel-${process.pid}`;
      const names = Array.from({ length: 8 }, (_, i) => `src/f${i}.mjs`);
      for (const name of names) writeFileSync(join(dir, name), "x".repeat(4000));
      const run = (input: object) =>
        new Promise<void>((done, fail) => {
          const child = execFile("node", [join(here, "seen.mjs")], { env: env(dir) }, (error) =>
            error ? fail(error) : done(),
          );
          child.stdin?.end(JSON.stringify(input));
        });
      await Promise.all(
        names.map((name) =>
          run({ session_id: id, agent_type: "workflow:planner", ...reading(name) }),
        ),
      );
      expect(logOf(id)).toEqual(Object.fromEntries(names.map((name) => [name, 1000])));
    });

    it("a Read counts and takes nothing: no Building line is taken until the plan is edited", () => {
      const dir = project();
      const id = `seen-read-${process.pid}`;
      const plan = join(dir, "plans", "p.md");
      writeFileSync(
        plan,
        `# P\n\n## Building, 6 November 2026, session ${id}\n\nShort plan, 6 November 2026.\n`,
      );
      const read = { session_id: id, agent_type: "executor", ...reading(plan, 400) };
      expect(seen(dir, read)).toBe("");
      expect(logOf(id)).toEqual({ "plans/p.md": 100 });
      expect(stateOf(id)).toBeNull();
      // The same file edited is taken.
      wrote(dir, {
        ...read,
        tool_name: "Edit",
        tool_input: { file_path: plan, old_string: "a", new_string: "b" },
      });
      expect(stateOf(id).held).toEqual(["plans/p.md"]);
    });

    // Timed: tried up to three times, since a load spike rarely lasts three tries.
    it(
      "a Read of 400 KB costs a bare node start, and a 400 KB Bash response under 100 ms more than none",
      { retry: 2 },
      () => {
        const dir = project();
        const id = `seen-time-${process.pid}`;
        // A retry starts with no counts from the try before it.
        rmSync(seenFile(id), { force: true });
        rmSync(stateFile(id), { force: true });
        const best = (run: () => unknown) =>
          Math.min(
            ...[1, 2, 3, 4, 5].map(() => {
              const t0 = performance.now();
              run();
              return performance.now() - t0;
            }),
          );
        const node = best(() => execFileSync("node", ["-e", ""]));
        const read = best(() =>
          seen(dir, {
            session_id: id,
            agent_type: "workflow:planner",
            ...reading("src/a.mjs", 400_000),
          }),
        );
        // The wrote hook on the same output, with and without a file named: node,
        // the script's load and the stdin's parse, which every hook pays already.
        const bash = (command: string) => ({
          session_id: id,
          agent_type: "workflow:planner",
          tool_name: "Bash",
          tool_input: { command },
          tool_response: { stdout: "x".repeat(400_000), stderr: "" },
        });
        const bare = best(() => wrote(dir, bash("npm test")));
        const counted = best(() => wrote(dir, bash("cat src/a.mjs")));
        // Five Reads and five Bash runs, each adding the output's 100k tokens.
        expect(logOf(id)).toEqual({ "src/a.mjs": 1_000_000 });
        console.log(
          `seen.mjs on a 400 KB Read ${Math.round(read)} ms, node -e '' ${Math.round(node)} ms; wrote hook ${Math.round(counted)} ms counting, ${Math.round(bare)} ms not`,
        );
        expect(read - node).toBeLessThan(60);
        expect(counted - bare).toBeLessThan(100);
      },
    );
  });
});

/** **The cost report** (plans/reuse-ceiling-per-agent.md, part 6): `plans cost`'s numbers. */
describe("the cost report", () => {
  const turn = (id: string, at: string, u: object, extra: object = {}) =>
    JSON.stringify({
      type: "assistant",
      timestamp: at,
      message: { id, model: "claude-fable-5-1-20261001", usage: u },
      ...extra,
    });

  it("measures each transcript's main thread and prices it by agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "cost-"));
    try {
      // A planner: two turns, the second written twice (one message id), a
      // sidechain turn to skip, a synthetic one to skip, one compaction.
      writeFileSync(
        join(dir, "planner-1.jsonl"),
        [
          JSON.stringify({ type: "agent-setting", agentSetting: "workflow:planner" }),
          turn("m1", "2026-11-01T10:00:00Z", {
            input_tokens: 0,
            cache_creation_input_tokens: 50_000,
            cache_read_input_tokens: 0,
            output_tokens: 1000,
          }),
          // The turn's first entry, its output still streaming: the last entry counts.
          turn("m2", "2026-11-01T10:05:00Z", {
            input_tokens: 0,
            cache_creation_input_tokens: 150_000,
            cache_read_input_tokens: 50_000,
            output_tokens: 7,
          }),
          turn("m2", "2026-11-01T10:05:00Z", {
            input_tokens: 0,
            cache_creation_input_tokens: 150_000,
            cache_read_input_tokens: 50_000,
            output_tokens: 2000,
          }),
          turn(
            "side",
            "2026-11-01T10:06:00Z",
            { input_tokens: 0, cache_creation_input_tokens: 999_999, output_tokens: 1 },
            { isSidechain: true },
          ),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-11-01T10:07:00Z",
            message: { id: "syn", model: "<synthetic>", usage: { input_tokens: 0 } },
          }),
          JSON.stringify({ type: "system", subtype: "compact_boundary" }),
          "",
        ].join("\n"),
      );
      // An executor on Opus: one turn.
      writeFileSync(
        join(dir, "executor-1.jsonl"),
        [
          JSON.stringify({ type: "agent-setting", agentSetting: "workflow:executor" }),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-11-02T09:00:00Z",
            message: {
              id: "e1",
              model: "claude-opus-5-5",
              usage: {
                input_tokens: 0,
                cache_creation_input_tokens: 100_000,
                cache_read_input_tokens: 150_000,
                output_tokens: 5000,
              },
            },
          }),
          "",
        ].join("\n"),
      );
      // An older chat with no agent, and an unknown model.
      writeFileSync(
        join(dir, "chat-1.jsonl"),
        `${JSON.stringify({
          type: "assistant",
          timestamp: "2026-10-20T09:00:00Z",
          message: { id: "c1", model: "claude-other-1", usage: { input_tokens: 1_000_000 } },
        })}\n`,
      );
      const rows = measure(dir);
      expect(rows.map((row: { id: string }) => row.id)).toEqual([
        "chat-1",
        "planner-1",
        "executor-1",
      ]);
      expect(rows[1]).toMatchObject({
        agent: "workflow:planner",
        turns: 2,
        maxContext: 200_000,
        endContext: 200_000,
        write: 200_000,
        read: 50_000,
        output: 3000,
        compactions: 1,
      });
      const lines = costWords(rows, {
        reuse: {
          executor: { warm: { ceiling: 200_000 } },
          planner: { warm: { ceiling: 160_000 } },
        },
        machine: "wp",
        dir: "~/.claude/projects/x",
      });
      expect(lines[0]).toBe(
        "Cost of this queue's sessions on wp since 20 October 2026 (3 transcripts in ~/.claude/projects/x), at the prices read on 5 November 2026 from platform.claude.com/docs/en/about-claude/pricing: Fable 5.1 $10 input, $20 one-hour cache write, $0.25 cache read, $50 output a million tokens; Opus 5.5 $4, $8, $0.20, $20.",
      );
      // Planner: writes 200k x $20 = $4, reads 50k x $0.25 = $0.0125, output 3k x $50 = $0.15.
      expect(lines[1]).toBe(
        "Planners: 1 session, median 2 turns, median context at the end 200k, 1 ended over 160k, 1 compacted; $4.16, cache writes 96%, output 4%, cache reads 0%.",
      );
      // Executor: writes 100k x $8 = $0.80, reads 150k x $0.20 = $0.03, output 5k x $20 = $0.10.
      expect(lines[2]).toBe(
        "Executors: 1 session, median 1 turns, median context at the end 250k, 1 ended over 200k, none compacted; $0.93, cache writes 86%, output 11%, cache reads 3%.",
      );
      expect(lines[3]).toBe(
        "Other: 1 session (no agent setting); $4.00 (claude-other-1 priced as Opus 5.5).",
      );
      // Each turn at its own model's prices (Codex C2): $10 on Fable, then $4 on Opus.
      writeFileSync(
        join(dir, "switched-1.jsonl"),
        [
          JSON.stringify({ type: "agent-setting", agentSetting: "workflow:assistant" }),
          turn("s1", "2026-11-03T09:00:00Z", { input_tokens: 1_000_000 }),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-11-03T09:05:00Z",
            message: { id: "s2", model: "claude-opus-5-5", usage: { input_tokens: 1_000_000 } },
          }),
          "",
        ].join("\n"),
      );
      expect(costWords(measure(dir, { since: "2026-11-03" }))[1]).toBe(
        "Assistants: 1 session, median 2 turns, median context at the end 1000k, none compacted; $14, input 100%, cache writes 0%, output 0%.",
      );
      // With history, the inputs the ceiling is worked out from, after the agent's line.
      const worked = costWords(rows, {
        reuse: {
          planner: {
            sessions: 21,
            start: 35_000,
            turns: 70,
            warm: ceilingFor({
              kind: "planner",
              inputs: {
                planner: { sessions: 21, start: 35_000, turns: 70, model: "claude-fable-5-1" },
              },
            }),
            cold: ceilingFor({
              kind: "planner",
              warm: false,
              inputs: {
                planner: { sessions: 21, start: 35_000, turns: 70, model: "claude-fable-5-1" },
              },
            }),
          },
        },
      });
      expect(worked[1]).toContain("1 ended over 75k");
      expect(worked[2]).toBe(
        "Reuse inputs: fresh start 35k (median first turn of 21 sessions), 70 turns; the ceiling is 75k warm and 35k cold at Fable 5.1 prices, capped at 480k.",
      );
      // Without history, no inputs line.
      expect(lines.some((line: string) => line.startsWith("Reuse inputs"))).toBe(false);
      // Since a day: the older chat is left out.
      expect(measure(dir, { since: "2026-11-01" })).toHaveLength(3);
      expect(
        costWords(measure(dir, { since: "2026-11-02" }), { since: "2026-11-02" })[0],
      ).toContain("since 2 November 2026 (2 transcripts)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** plans/idle-chats-end.md: a finished chat ends an hour after it goes quiet. */
describe("a finished chat ends", () => {
  const MIN = 60_000;
  const now = Date.UTC(2026, 9, 27, 22, 0);
  const done = { kind: "background", state: "done", sessionId: "s", name: "Ends Executor 1" };
  const used = (minutes: number) => ({ context: 150_000, at: now - minutes * MIN });

  it("decideEnd: done, cold and nothing under way ends; anything else says why not", () => {
    expect(decideEnd({ row: done, usage: used(70), now })).toEqual({ end: true });
    expect(decideEnd({ row: done, usage: used(20), now })).toEqual({
      end: false,
      why: "its cache is still warm",
    });
    expect(decideEnd({ row: done, usage: used(20), now, force: true })).toEqual({ end: true });
    // plans/waiting-means-a-question.md: a blocked chat whose turn is over
    // with no prompt open is finished; one with a prompt open, or with no
    // process, is kept.
    const blocked = { ...done, state: "blocked" };
    expect(
      decideEnd({ row: { ...blocked, pid: 1, status: "idle" }, usage: used(70), now }),
    ).toEqual({ end: true });
    expect(
      decideEnd({ row: { ...blocked, pid: 1, status: "idle" }, usage: used(20), now }),
    ).toEqual({ end: false, why: "its cache is still warm" });
    expect(
      decideEnd({
        row: { ...blocked, pid: 1, status: "waiting", waitingFor: "input needed" },
        usage: used(70),
        now,
      }),
    ).toEqual({ end: false, why: "its state is blocked" });
    // One reading: a prompt `statusOf` reads standing keeps it, whatever `status` says.
    expect(
      decideEnd({
        row: { ...blocked, pid: 1, status: "idle", waitingFor: "permission prompt" },
        usage: used(70),
        now,
      }),
    ).toEqual({ end: false, why: "its state is blocked" });
    expect(decideEnd({ row: blocked, usage: used(70), now, force: true })).toEqual({
      end: false,
      why: "its state is blocked",
    });
    // plans/put-first-review-fixes.md, part 5: `done` with a prompt standing is never finished.
    const prompted = { ...done, pid: 1, status: "waiting", waitingFor: "permission prompt" };
    const open = { end: false, why: "a question or a prompt is open in it" };
    expect(decideEnd({ row: prompted, usage: used(70), now })).toEqual(open);
    expect(decideEnd({ row: prompted, usage: used(70), now, force: true })).toEqual(open);
    expect(decideEnd({ row: prompted, usage: used(70), now, immediate: true })).toEqual({
      end: true,
    });
    expect(decideEnd({ row: { ...done, state: "working" }, now, force: true })).toEqual({
      end: false,
      why: "its state is working",
    });
    expect(decideEnd({ row: done, usage: used(70), on: "plans/x.md", now })).toEqual({
      end: false,
      why: "it has plans/x.md under way",
    });
    expect(decideEnd({ row: { ...done, kind: "interactive" }, usage: used(70), now })).toEqual({
      end: false,
      why: "it is not a background session of the queue",
    });
    expect(decideEnd({ row: null, now })).toMatchObject({ end: false });
    // No usage known: the timer fired an hour after the Stop that armed it.
    expect(decideEnd({ row: done, now })).toEqual({ end: true });
    // A planner holding an untaken plan ends like the rest (Decided 1): nothing in the rule reads it.
    expect(decideEnd({ row: { ...done, name: "Ends Planner 1" }, usage: used(70), now })).toEqual({
      end: true,
    });
  });

  // plans/end-a-stuck-chat.md: `--now` ends a named chat whatever it is doing.
  it("decideEnd: immediate ends a working or warm one, and returns the plan it had under way", () => {
    const working = { ...done, state: "working" };
    expect(decideEnd({ row: working, now, force: true })).toEqual({
      end: false,
      why: "its state is working",
    });
    expect(decideEnd({ row: working, now, immediate: true })).toEqual({ end: true });
    expect(decideEnd({ row: { ...done, state: "blocked" }, now, immediate: true })).toEqual({
      end: true,
    });
    expect(decideEnd({ row: done, usage: used(5), now, immediate: true })).toEqual({ end: true });
    expect(decideEnd({ row: working, on: "plans/x.md", now, immediate: true })).toEqual({
      end: true,
      on: "plans/x.md",
    });
    // Still only the queue's background sessions: the owner's own chat is his.
    expect(
      decideEnd({ row: { ...done, kind: "interactive" }, now, immediate: true }),
    ).toMatchObject({ end: false });
  });

  it("endedEdit hands a plan over, and puts a brief back in the queue", () => {
    const plan =
      "# A plan\n\n## Building, 28 October 2026, session abc\n\nShort plan, 28 October 2026, by the assistant.\n\n## The change\n";
    const out = endedEdit(plan, {
      sessionId: "abc",
      branch: "fix",
      day: "28 October 2026",
    });
    expect(out).not.toContain("## Building");
    expect(out).toContain(
      "Short plan, 28 October 2026, by the assistant.\n\n## Handing over, 28 October 2026, ended with plans end --now\n\nStep in hand: unknown, session abc was ended with plans end --now on branch `fix` in the middle of its work. Read the branch's commits for what it did.\n",
    );
    expect(stateOf(out)).toMatchObject({
      state: "handed",
      branch: "fix",
      step: expect.stringMatching(/^unknown/),
    });
    const brief =
      "# A brief\n\n## Planning, 28 October 2026, session abc\n\nBrief for the planner, 28 October 2026.\n\nWhat to plan.\n";
    // A brief only loses its Planning line: a Handing over line would read as an executor's taking.
    const back = endedEdit(brief, { sessionId: "abc", day: "28 October 2026" });
    expect(back).toBe("# A brief\n\nBrief for the planner, 28 October 2026.\n\nWhat to plan.\n");
    expect(stateOf(back)).toMatchObject({ kind: "Brief", state: "brief" });
    // Another session's line, or none (it wrote Built while it was stopped), is left as it is.
    expect(endedEdit(plan, { sessionId: "other" })).toBe(plan);
  });

  // plans/short-session-id-is-live.md: `plans end --now` finds a plan by a
  // short line, so the line it ends is the short one too.
  it("endedEdit hands over a plan and frees a brief whose line names the session by a short id", () => {
    const id = "abcd1234-0000-4000-8000-000000000001";
    const plan = `# A plan\n\n## Building, 25 November 2026, session abcd1234\n\nShort plan, 25 November 2026, by the assistant.\n`;
    const out = endedEdit(plan, { sessionId: id, day: "25 November 2026" });
    expect(out).not.toContain("## Building");
    expect(stateOf(out)).toMatchObject({ state: "handed" });
    const brief = `# A brief\n\n## Planning, 25 November 2026, session abcd1234-00\n\nBrief for the planner, 25 November 2026.\n`;
    expect(endedEdit(brief, { sessionId: id })).toBe(
      "# A brief\n\nBrief for the planner, 25 November 2026.\n",
    );
    // Another session's start, or one under eight, is left as it is.
    const other = plan.replace("abcd1234", "abcd1239");
    expect(endedEdit(other, { sessionId: id })).toBe(other);
    const under = plan.replace("abcd1234", "abcd123");
    expect(endedEdit(under, { sessionId: id })).toBe(under);
  });

  // plans/waiting-means-a-question.md
  it("reads a chat as waiting for input only while a prompt stands", () => {
    const usage = {
      at: now / 1000,
      five_hour: { used_percentage: 10, resets_at: now / 1000 + 3600 },
    };
    const base = { name: "Ends Planner 1", kind: "background", cwd: "/x" };
    const read = (row: object, at = now - MIN, context = 300_000) =>
      sessionsOf("planner", [{ sessionId: "b1000000-0000", ...base, ...row }], [], {
        trees: [{ path: "/x", branch: "" }],
        stateFor: () => ({ agent: "planner", plans: [] }),
        usageFor: () => ({ context, at }),
      } as never)[0];
    const start = (one: unknown) =>
      canStart({ kind: "planner", now, usage, name: "Ends", sessions: [one] as never });
    // The example: its turn is over on a refused token, no question open.
    const example = { pid: 159062, status: "idle", state: "blocked" };
    const quiet = read(example);
    expect(quiet.status).toBe("idle");
    expect(describeSession(quiet)).toContain("Ends Planner 1 [b1000000], idle");
    expect(describeSession(quiet)).not.toContain("waiting for input");
    // Warm and under its ceiling, it is sent the brief like any idle planner.
    const warm = start(read(example, now - MIN, 100_000));
    expect(warm).toMatchObject({ wait: true, held: true });
    expect(JSON.stringify(warm)).not.toMatch(/answers it|question or a prompt/);
    // Cold and over its ceiling, it is replaced like any idle planner.
    const cold = start(read(example, now - 130 * MIN));
    expect(cold).toMatchObject({ start: true });
    expect(cold.replace).toEqual([expect.objectContaining({ name: "Ends Planner 1" })]);
    expect(JSON.stringify(cold)).not.toMatch(/answers it|question or a prompt/);
    // A question open, and a permission prompt: waiting, started beside, never replaced.
    const question = { pid: 1, status: "waiting", waitingFor: "input needed", state: "blocked" };
    const permission = {
      pid: 1,
      status: "waiting",
      waitingFor: "permission prompt",
      state: "blocked",
    };
    for (const [row, words] of [
      [question, "waiting for input"],
      [permission, "waiting for input, permission prompt"],
    ] as const) {
      const one = read(row, now - 130 * MIN);
      expect(one.status).toBe(words);
      expect(describeSession(one)).toContain(`Ends Planner 1 [b1000000], ${words}`);
      const beside = start(one);
      expect(beside).toMatchObject({ start: true });
      expect(beside).not.toHaveProperty("replace");
      expect(beside.note).toContain(
        "a question or a prompt is open in its chat, and it takes nothing until Javi answers it",
      );
    }
    // An interactive chat with the question tool open reads the same.
    expect(
      statusOf({
        sessionId: "i",
        kind: "interactive",
        pid: 2,
        status: "waiting",
        waitingFor: "input needed",
      }),
    ).toBe("waiting for input");
    // No process: not running, started beside, never replaced.
    const gone = read({ state: "blocked" }, now - 130 * MIN);
    expect(gone.status).toBe("not running");
    expect(describeSession(gone)).toContain("Ends Planner 1 [b1000000], not running");
    const besideGone = start(gone);
    expect(besideGone).toMatchObject({ start: true });
    expect(besideGone).not.toHaveProperty("replace");
    expect(besideGone.note).toContain("(its process is not running)");
    // An executor waiting on its owner refuses the start.
    const executor = { ...read(question), kind: "executor" as const };
    expect(canStart({ now, usage, name: "Ends", sessions: [executor] })).toMatchObject({
      refuse: true,
    });
    // plans/put-first-review-fixes.md, part 6: an executor with no process,
    // holding the lock with a plan under way, is not alive: the start replaces it.
    const goneId = "e1000000-0000";
    const lock = { sessionId: goneId, pid: 999_999, name: "Ends Executor 1" };
    const [goneExecutor] = sessionsOf(
      "executor",
      [{ sessionId: goneId, name: "Ends Executor 1", kind: "background", cwd: "/x" }],
      [lock],
      {
        trees: [{ path: "/x", branch: "" }],
        plans: [{ path: "plans/a.md", state: "building", session: goneId }],
        stateFor: () => ({ agent: "executor" }),
        usageFor: () => ({ context: 50_000, at: now - MIN }),
      } as never,
    );
    expect(goneExecutor).toMatchObject({
      status: "not running",
      on: "plans/a.md",
    });
    const takeOver = canStart({
      now,
      usage,
      name: "Ends",
      lock,
      alive: () => true,
      sessions: [goneExecutor],
    });
    expect(takeOver).toMatchObject({ start: true });
    expect(takeOver.replace).toEqual([
      expect.objectContaining({ name: "Ends Executor 1", why: "its process is not running" }),
    ]);
    // Beside a live executor still worth reusing, the start is refused as before.
    const liveOne = { ...goneExecutor, sessionId: "e2000000-0000", status: "busy", on: "" };
    expect(canStart({ now, usage, name: "Ends", sessions: [goneExecutor, liveOne] })).toMatchObject(
      { refuse: true },
    );
  });

  it("says when a chat ends, and where each plan a planner holds stands", () => {
    const at = Date.now() + 30 * MIN;
    const hhmm = new Date(at).toTimeString().slice(0, 5);
    const executor = {
      kind: "executor" as const,
      sessionId: "e1000000-0000",
      id: "",
      name: "Ends Executor 1",
      status: "idle",
      where: "checkout",
      branch: "",
      holdsLock: false,
      retired: false,
      on: "",
      endsAt: at,
    };
    expect(describeSession(executor)).toBe(
      `Ends Executor 1 [e1000000], idle, ends at ${hhmm} if left quiet, in the checkout`,
    );
    // A turn under way is not quiet.
    expect(describeSession({ ...executor, status: "busy" })).toBe(
      "Ends Executor 1 [e1000000], busy, in the checkout",
    );
    expect(describeSession({ ...executor, endsAt: Date.now() - MIN })).toBe(
      "Ends Executor 1 [e1000000], idle, in the checkout",
    );
    const live = [{ sessionId: "e1000000-0000", name: "Ends Executor 1" }];
    const plans = [
      { path: "plans/a.md", state: "ready" },
      { path: "plans/b.md", state: "ready", asks: true },
      { path: "plans/c.md", state: "built" },
      { path: "plans/d.md", state: "building", session: "e1000000-0000" },
    ];
    const [planner] = sessionsOf(
      "planner",
      [{ sessionId: "p1000000-0000", name: "Ends Planner 1", kind: "background", status: "idle" }],
      [],
      {
        trees: [],
        plans,
        stateFor: () => ({
          agent: "planner",
          plans: ["plans/a.md", "plans/b.md", "plans/c.md"],
          end: { pid: null, at },
        }),
        usageFor: () => null,
      } as never,
    );
    expect(describeSession(planner)).toBe(
      `Ends Planner 1 [p1000000], idle, ends at ${hhmm} if left quiet, holds plans/a.md (ready, for the executor), plans/b.md (unanswered, the executor decides) and plans/c.md (built)`,
    );
    // "Asked once": within thirty minutes of its question, the plan is this planner's.
    const last = Date.now() - 5 * MIN;
    const [asking] = sessionsOf(
      "planner",
      [{ sessionId: "p1000000-0000", name: "Ends Planner 1", kind: "background", status: "idle" }],
      [],
      {
        trees: [],
        plans,
        stateFor: () => ({
          agent: "planner",
          plans: ["plans/b.md"],
          asked: { "plans/b.md": last },
        }),
        usageFor: () => null,
      } as never,
    );
    expect(describeSession(asking)).toContain(
      `holds plans/b.md (asks Javi here until ${new Date(last + 30 * MIN).toTimeString().slice(0, 5)})`,
    );
    const [retired] = sessionsOf(
      "planner",
      [
        ...live,
        { sessionId: "p2000000-0000", name: "Ends Planner 2", kind: "background", status: "idle" },
      ],
      null,
      {
        trees: [],
        plans,
        stateFor: (id: string) =>
          id.startsWith("p2")
            ? { agent: "planner", retired: true, plans: ["plans/d.md", "plans/e.md"] }
            : { agent: "executor" },
        usageFor: () => null,
      } as never,
    );
    expect(describeSession(retired)).toBe(
      "Ends Planner 2 [p2000000], idle, retired, its plans plans/d.md (building, Ends Executor 1) and plans/e.md (gone)",
    );
  });

  describe("in a fixture", () => {
    let dir: string;
    let projects: string;
    let log: string;
    const exec = "e2000000-0000-0000-0000-000000000000";
    const planner = "p3000000-0000-0000-0000-000000000000";
    const asker = "p4000000-0000-0000-0000-000000000000";
    const lone = "p5000000-0000-0000-0000-000000000000";
    const tty = "e6000000-0000-0000-0000-000000000000";
    const rows = [
      {
        sessionId: exec,
        id: "bg-e",
        name: "Ends Executor 1",
        kind: "background",
        state: "done",
        status: "idle",
      },
      {
        sessionId: asker,
        id: "bg-a",
        pid: 4242,
        name: "Ends Planner 1",
        kind: "background",
        state: "blocked",
        status: "waiting",
        waitingFor: "input needed",
      },
      {
        sessionId: planner,
        id: "bg-p",
        name: "Ends Planner 2",
        kind: "background",
        state: "done",
        status: "idle",
      },
      {
        sessionId: tty,
        name: "Ends Executor 2",
        kind: "interactive",
        state: "done",
        status: "idle",
      },
      {
        sessionId: lone,
        id: "bg-l",
        name: "Ends Planner 3",
        kind: "background",
        // Its turn is over with no prompt open, read blocked from its text
        // (plans/waiting-means-a-question.md): a finished chat.
        state: "blocked",
        status: "idle",
      },
    ];
    const env = () => ({
      CLAUDE_PROJECT_DIR: dir,
      WORKFLOW_ROOT: dir,
      WORKFLOW_STOP_LOG: log,
      WORKFLOW_PROJECTS: projects,
      WORKFLOW_STARTS_LOG: join(dir, ".claude", "starts.log"),
      WORKFLOW_USAGE_FILE: join(dir, ".claude", "usage.json"),
      WORKFLOW_LIVE: JSON.stringify(rows.map((row) => ({ ...row, cwd: dir }))),
    });
    const queue = (args: string[], input: object = {}) =>
      execFileSync("node", [join(here, "plan-queue.mjs"), ...args], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: { ...process.env, ...env() },
      });
    const logged = () =>
      existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    const endAt = (line: string) => Number(/ at (\d+)$/.exec(line)![1]);

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "ends-"));
      projects = mkdtempSync(join(tmpdir(), "ends-projects-"));
      log = join(dir, "stops.log");
      execFileSync("git", ["init", "-q"], { cwd: dir });
      withOrigin(dir);
      mkdirSync(join(dir, ".claude"));
      mkdirSync(join(dir, "plans"));
      writeFileSync(join(dir, ".claude", "workflow.md"), "---\nname: Ends\nbranch: test\n---\n");
      writeFileSync(
        join(dir, "plans", "taken.md"),
        `# Taken\n\n## Building, 27 October 2026, session ${exec}\n\nPlan only, 27 October 2026, for Javi.\n`,
      );
      writeFileSync(
        stateFile(planner),
        JSON.stringify({ agent: "planner", plans: ["plans/taken.md"] }),
      );
      writeFileSync(
        stateFile(asker),
        JSON.stringify({ agent: "planner", plans: ["plans/asks.md"] }),
      );
      writeFileSync(stateFile(lone), JSON.stringify({ agent: "planner", plans: [] }));
    });
    // Each case starts with no name held by the case before it: a failed
    // start keeps its name for two minutes (plans/late-session-keeps-its-name.md).
    beforeEach(() => rmSync(join(dir, ".claude", "starts.log.names.json"), { force: true }));
    afterAll(() => {
      for (const id of [exec, planner, asker, lone, tty]) rmSync(stateFile(id), { force: true });
      rmSync(dir, { recursive: true, force: true });
      rmSync(projects, { recursive: true, force: true });
    });

    it("arms one end timer an hour on at each stop of an executor, and of a planner the queue gave work", () => {
      rmSync(log, { force: true });
      rmSync(stateFile(exec), { force: true });
      const before = Date.now();
      expect(queue(["stop"], { session_id: exec, agent_type: "executor" })).toBe("");
      const first = logged();
      expect(first).toHaveLength(1);
      expect(first[0]).toMatch(new RegExp(`^end ${exec} at \\d+$`));
      expect(Math.abs(endAt(first[0]) - (before + 60 * MIN))).toBeLessThan(MIN);
      expect(JSON.parse(readFileSync(stateFile(exec), "utf8")).end.at).toBe(endAt(first[0]));
      queue(["stop"], { session_id: exec, agent_type: "executor" });
      const second = logged();
      expect(second).toHaveLength(2);
      expect(endAt(second[1])).toBeGreaterThanOrEqual(endAt(second[0]));
      expect(JSON.parse(readFileSync(stateFile(exec), "utf8")).end.at).toBe(endAt(second[1]));
      // A planner with plans arms the same; one the queue gave nothing arms nothing.
      rmSync(log, { force: true });
      queue(["stop"], { session_id: planner, agent_type: "planner" });
      expect(logged()).toEqual([expect.stringMatching(new RegExp(`^end ${planner} at `))]);
      queue(["stop"], { session_id: lone, agent_type: "planner" });
      expect(logged()).toHaveLength(1);
      // The owner's interactive executor is never the queue's to end: no timer.
      queue(["stop"], { session_id: tty, agent_type: "executor" });
      expect(logged()).toHaveLength(1);
      // plans says when it ends.
      const hhmm = new Date(endAt(second[1])).toTimeString().slice(0, 5);
      expect(queue([])).toContain(
        `Ends Executor 1 [e2000000], idle, ends at ${hhmm} if left quiet`,
      );
    });

    it("arms it on the retire too", { timeout: 30_000 }, () => {
      rmSync(log, { force: true });
      const tired = "e3000000-0000-0000-0000-000000000000";
      writeFileSync(stateFile(tired), JSON.stringify({ agent: "executor" }));
      const transcript = join(dir, "tired.jsonl");
      writeFileSync(
        transcript,
        `${JSON.stringify({
          type: "assistant",
          timestamp: new Date().toISOString(),
          message: { usage: { input_tokens: 10, cache_read_input_tokens: 250_000 } },
        })}\n`,
      );
      writeFileSync(
        join(dir, "plans", "waiting.md"),
        "# Waiting\n\nPlan only, 27 October 2026, for Javi.\n",
      );
      // A start a minute ago with nothing built since: the next start is refused, so none launches.
      writeFileSync(
        join(dir, ".claude", "starts.log"),
        `${JSON.stringify({ at: Date.now() - MIN, name: "Ends Executor 1", paths: [] })}\n`,
      );
      try {
        const said = queue(["stop"], {
          session_id: tired,
          agent_type: "executor",
          transcript_path: transcript,
        });
        expect(said).toContain("Retired: its context is 250k tokens");
        expect(logged()).toEqual([expect.stringMatching(new RegExp(`^end ${tired} at `))]);
        expect(JSON.parse(readFileSync(stateFile(tired), "utf8")).retired).toBe(true);
      } finally {
        rmSync(stateFile(tired), { force: true });
        rmSync(transcript, { force: true });
        rmSync(join(dir, "plans", "waiting.md"), { force: true });
        rmSync(join(dir, ".claude", "starts.log"), { force: true });
      }
    });

    it("plans end ends the finished chats, says why not for the rest, and takes an id", () => {
      rmSync(log, { force: true });
      // The executor's Building line is gone, so nothing is under way.
      writeFileSync(
        join(dir, "plans", "taken.md"),
        `# Taken\n\n## Built, 27 October 2026\n\nCommit 1234abcd.\n\nPlan only, 27 October 2026, for Javi.\n`,
      );
      const out = queue(["end"]);
      expect(logged()).toEqual(["bg-e", "bg-p", "bg-l"]);
      expect(out).toContain("Ended Ends Executor 1 [e2000000]: done.");
      expect(out).toContain("Ended Ends Planner 2 [p3000000]: done.");
      expect(out).toContain("Ended Ends Planner 3 [p5000000]: idle.");
      expect(out).toContain("Not ended: Ends Planner 1 [p4000000], its state is blocked.");
      expect(out).toContain(
        "Not ended: Ends Executor 2 [e6000000], it is not a background session of the queue.",
      );
      expect(out).not.toContain("Nothing to end");
      expect(JSON.parse(readFileSync(stateFile(exec), "utf8"))).not.toHaveProperty("end");
      rmSync(log, { force: true });
      expect(queue(["end", "p3000000"])).toBe("Ended Ends Planner 2 [p3000000]: done.\n");
      expect(logged()).toEqual(["bg-p"]);
      expect(queue(["end", "bg-e"])).toBe("Ended Ends Executor 1 [e2000000]: done.\n");
      expect(queue(["end", "deadbeef"])).toBe(
        "deadbeef is no live session of this queue; plans lists them.\n",
      );
    });

    it("never signals a pid that is not the session's timer, and keeps the timer when the stop fails", async () => {
      // Codex, 27 October: a timer gone leaves its pid to be reused.
      writeFileSync(
        join(dir, "plans", "taken.md"),
        "# Taken\n\n## Built, 27 October 2026\n\nCommit 1234abcd.\n\nPlan only, 27 October 2026, for Javi.\n",
      );
      const other = spawn("sleep", ["30"], { stdio: "ignore" });
      try {
        writeFileSync(
          stateFile(exec),
          JSON.stringify({ agent: "executor", end: { pid: other.pid, at: Date.now() } }),
        );
        queue(["stop"], { session_id: exec, agent_type: "executor" });
        await new Promise((done) => setTimeout(done, 300));
        expect(other.exitCode).toBeNull();
        expect(other.signalCode).toBeNull();
      } finally {
        other.kill();
      }
      const kept = { pid: 1, at: Date.now() + 60 * MIN };
      writeFileSync(stateFile(exec), JSON.stringify({ agent: "executor", end: kept }));
      const failed = execFileSync("node", [join(here, "plan-queue.mjs"), "end", "bg-e"], {
        encoding: "utf8",
        env: { ...process.env, ...env(), WORKFLOW_STOP_LOG: "", WORKFLOW_CLAUDE: "/bin/false" },
      });
      expect(failed).toBe("Not ended: Ends Executor 1 [e2000000], claude stop failed.\n");
      expect(JSON.parse(readFileSync(stateFile(exec), "utf8")).end).toEqual(kept);
    });

    it("the timer ends the session when it fires, by the same rule", () => {
      rmSync(log, { force: true });
      expect(queue(["end", "--timer", String(Date.now() - 1), exec])).toBe("");
      expect(logged()).toEqual(["bg-e"]);
      queue(["end", "--timer", String(Date.now() - 1), asker]);
      expect(logged()).toEqual(["bg-e"]);
    });

    // plans/end-a-stuck-chat.md
    it(
      "plans end --now ends a named chat whatever it is doing, its plan handed over first",
      { timeout: 30_000 },
      () => {
        rmSync(log, { force: true });
        expect(queue(["end", "--now"])).toBe(
          "Not ended: name the chat to end now (plans end <id> --now); plans lists them.\n",
        );
        expect(logged()).toEqual([]);
        // Blocked: refused without --now, ended with it, and its subagents' tmux server too.
        expect(queue(["end", "bg-a"])).toBe(
          "Not ended: Ends Planner 1 [p4000000], its state is blocked.\n",
        );
        expect(queue(["end", "bg-a", "--now"])).toBe("Ended Ends Planner 1 [p4000000]: blocked.\n");
        expect(logged()).toEqual(["bg-a", "tmux claude-swarm-4242"]);
        // A plan under way is refused without --now, and handed over with it.
        rmSync(log, { force: true });
        const taken = join(dir, "plans", "taken.md");
        writeFileSync(
          taken,
          `# Taken\n\n## Building, 28 October 2026, session ${exec}\n\nPlan only, 28 October 2026, for Javi.\n\n## The change\n`,
        );
        expect(queue(["end", "bg-e"])).toBe(
          "Not ended: Ends Executor 1 [e2000000], it has plans/taken.md under way.\n",
        );
        // The queue resumes it now: a fresh executor started in its place (WORKFLOW_CLAUDE stands in).
        const ended = execFileSync("node", [join(here, "plan-queue.mjs"), "end", "--now", "bg-e"], {
          encoding: "utf8",
          env: { ...process.env, ...env(), WORKFLOW_CLAUDE: "/bin/true" },
        });
        expect(ended).toMatch(
          /^Ended Ends Executor 1 \[e2000000\]: done\. plans\/taken\.md is handed over\.\n/,
        );
        // start's own answer follows: the owner's chat in the checkout is no
        // executor's number (plans/parallel-executors.md), so a fresh one is started.
        expect(ended).toContain("Ends Executor 3 (lab) was started");
        expect(logged()).toEqual(["bg-e"]);
        const text = readFileSync(taken, "utf8");
        expect(text).not.toContain("## Building");
        expect(text).toMatch(
          /^## Handing over, [^,\n]+, ended with plans end --now\n\nStep in hand: unknown, session [^\n]+ was ended with plans end --now[^\n]* in the middle of its work\. Read the branch's commits for what it did\.$/m,
        );
        expect(stateOf(text)).toMatchObject({ state: "handed" });
        // A failed stop leaves the plan as it was.
        const before = `# Taken\n\n## Building, 28 October 2026, session ${exec}\n\nPlan only, 28 October 2026, for Javi.\n`;
        writeFileSync(taken, before);
        const failed = execFileSync(
          "node",
          [join(here, "plan-queue.mjs"), "end", "bg-e", "--now"],
          {
            encoding: "utf8",
            env: { ...process.env, ...env(), WORKFLOW_STOP_LOG: "", WORKFLOW_CLAUDE: "/bin/false" },
          },
        );
        expect(failed).toBe("Not ended: Ends Executor 1 [e2000000], claude stop failed.\n");
        expect(readFileSync(taken, "utf8")).toBe(before);
      },
    );

    // plans/put-first-review-fixes.md, part 6.
    it("plans start hands a plan over from an executor with no process, and starts a fresh one on it", () => {
      const gone = "e7000000-0000-0000-0000-000000000000";
      const plan = join(dir, "plans", "gone.md");
      const lockFile = join(dir, ".claude", "executor.1.lock");
      const building = `# Gone\n\n## Building, 13 November 2026, session ${gone}\n\nPlan only, 13 November 2026, for Javi.\n\n## The change\n`;
      writeFileSync(plan, building);
      writeFileSync(stateFile(gone), JSON.stringify({ agent: "executor" }));
      writeFileSync(
        lockFile,
        JSON.stringify({ sessionId: gone, pid: 999_999, name: "Ends Executor 7", at: Date.now() }),
      );
      const goneRows = [
        // In its worktree, executor-1, whose lock it holds (plans/parallel-executors.md).
        {
          sessionId: gone,
          id: "bg-g",
          name: "Ends Executor 7",
          kind: "background",
          cwd: join(dir, ".claude", "worktrees", "executor-1"),
        },
        // A planner with no process is still started beside, not touched.
        {
          sessionId: lone,
          id: "bg-l",
          name: "Ends Planner 3",
          kind: "background",
          state: "blocked",
          cwd: dir,
        },
      ];
      // A stand-in for claude: `agents` lists the rows, `--bg` adds the chat it starts.
      const rowsFile = join(dir, "gone-rows.json");
      const script = join(dir, "gone-claude.js");
      writeFileSync(rowsFile, JSON.stringify(goneRows));
      writeFileSync(
        script,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "agents") process.stdout.write(fs.readFileSync(${JSON.stringify(rowsFile)}, "utf8"));
else if (args.includes("--bg")) {
  const all = JSON.parse(fs.readFileSync(${JSON.stringify(rowsFile)}, "utf8"));
  all.push({ sessionId: "gone-next", name: args[args.indexOf("--name") + 1], kind: "background", cwd: process.cwd() });
  fs.writeFileSync(${JSON.stringify(rowsFile)}, JSON.stringify(all));
}
`,
      );
      chmodSync(script, 0o755);
      const { WORKFLOW_LIVE: _, ...rest } = { ...process.env, ...env() };
      try {
        // A refused start writes nothing: the hand-over goes with the retirement (/code-review).
        const paused = { ...rest, WORKFLOW_CLAUDE: script };
        execFileSync("node", [join(here, "plan-queue.mjs"), "pause"], { env: paused });
        expect(
          execFileSync("node", [join(here, "plan-queue.mjs"), "start"], {
            encoding: "utf8",
            env: paused,
          }),
        ).toContain("The queue is paused");
        execFileSync("node", [join(here, "plan-queue.mjs"), "resume"], { env: paused });
        expect(readFileSync(plan, "utf8")).toBe(building);
        // A launch that fails gives the plan back with the lock and the state (Codex C1).
        const silent = join(dir, "gone-silent.js");
        writeFileSync(
          silent,
          `#!/usr/bin/env node\nif (process.argv[2] === "agents") process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(rowsFile)}, "utf8"));\n`,
        );
        chmodSync(silent, 0o755);
        const failed = execFileSync("node", [join(here, "plan-queue.mjs"), "start"], {
          encoding: "utf8",
          env: { ...rest, WORKFLOW_CLAUDE: silent },
        });
        expect(failed).toContain("has not appeared in claude agents");
        // Not seen, the start keeps its own output file and names it.
        const kept = /its output is in \.claude\/(executor\.\d+\.started)\./.exec(failed);
        expect(kept).not.toBeNull();
        expect(existsSync(join(dir, ".claude", kept![1]))).toBe(true);
        expect(readFileSync(plan, "utf8")).toBe(building);
        expect(JSON.parse(readFileSync(lockFile, "utf8")).released).toBeFalsy();
        expect(JSON.parse(readFileSync(stateFile(gone), "utf8")).retired).toBeFalsy();
        rmSync(silent, { force: true });
        // A dry start says what a real one would do, and writes nothing (Codex C2).
        const dry = execFileSync("node", [join(here, "plan-queue.mjs"), "start", "--dry"], {
          encoding: "utf8",
          env: { ...rest, WORKFLOW_CLAUDE: script },
        });
        expect(dry).toContain("plans/gone.md");
        expect(dry).toContain(
          "Would retire Ends Executor 7 [e7000000]: its process is not running.",
        );
        expect(readFileSync(plan, "utf8")).toBe(building);
        const started = execFileSync("node", [join(here, "plan-queue.mjs"), "start"], {
          encoding: "utf8",
          env: { ...rest, WORKFLOW_CLAUDE: script },
        });
        expect(started).not.toContain("An executor is alive");
        expect(started).toContain(
          "Ends Executor 7 [e7000000] was retired: its process is not running.",
        );
        const text = readFileSync(plan, "utf8");
        expect(text).not.toContain("## Building");
        expect(text).toMatch(
          /^Plan only, 13 November 2026, for Javi\.\n\n## Handing over, [^,\n]+, by the queue\n\nStep in hand: unknown, session e7000000-0000-0000-0000-000000000000's process was not running when a start looked, on branch `[^`]+` in worktree `executor-1`\. Read the branch's commits for what it did\.\n/m,
        );
        expect(stateOf(text)).toMatchObject({ state: "handed" });
        expect(JSON.parse(readFileSync(lockFile, "utf8")).released).toBeTruthy();
        expect(JSON.parse(readFileSync(stateFile(gone), "utf8")).retired).toBe(true);
        const starts = readFileSync(join(dir, ".claude", "starts.log"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const last = starts.at(-1);
        expect(last.paths[0]).toBe("plans/gone.md");
        expect(last.why).toContain(
          "Ends Executor 7 [e7000000] was retired: its process is not running.",
        );
        expect(JSON.parse(readFileSync(stateFile(lone), "utf8")).retired).toBeFalsy();
      } finally {
        rmSync(plan, { force: true });
        rmSync(lockFile, { force: true });
        rmSync(stateFile(gone), { force: true });
        rmSync(rowsFile, { force: true });
        rmSync(script, { force: true });
      }
    }, 40_000);

    it("goneEdit writes the queue's hand-over in place of the Building line", () => {
      const text =
        "# A plan\n\n## Building, 13 November 2026, session abc\n\nShort plan, 13 November 2026, by the assistant.\n\n## The change\n";
      expect(goneEdit(text, { sessionId: "abc", branch: "fix", day: "14 November 2026" })).toBe(
        "# A plan\n\nShort plan, 13 November 2026, by the assistant.\n\n## Handing over, 14 November 2026, by the queue\n\nStep in hand: unknown, session abc's process was not running when a start looked, on branch `fix`. Read the branch's commits for what it did.\n\n## The change\n",
      );
      expect(goneEdit(text, { sessionId: "abc", branch: "", day: "14 November 2026" })).toContain(
        "Step in hand: unknown, session abc's process was not running when a start looked. Read the branch's commits",
      );
    });
  });
});

/** plans/owner-questions-plain-and-once.md, part 1: a plan that asks stays with its planner. */
describe("asked once", () => {
  const MIN = 60_000;
  const now = Date.UTC(2026, 9, 28, 12, 0);
  const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5);
  const head = "# X\n\nPlan only, 28 October 2026, for Javi; the executor builds it.\n";
  const asks = `${head}\n## Decisions for Javi\n\n1. **The shape.** One (Recommended) or two.\n`;
  const ids = {
    planner: "a1000000-0000-0000-0000-000000000000",
    other: "a2000000-0000-0000-0000-000000000000",
    exec: "a3000000-0000-0000-0000-000000000000",
  };
  const row = {
    sessionId: ids.planner,
    name: "Asks Planner 3",
    kind: "background",
    status: "waiting",
    waitingFor: "input needed",
    state: "blocked",
  };
  const ready = (path: string) => ({ path, ...stateOf(asks) });
  /** The planner asked `minutesAgo` (none with null), as its tool hook records it. */
  const options = (minutesAgo: number | null, state: object = {}) => ({
    stateFor: () => ({
      agent: "planner",
      brief: "plans/asks.md",
      plans: [],
      ...(minutesAgo === null ? {} : { asked: { "plans/asks.md": now - minutesAgo * MIN } }),
      ...state,
    }),
    now,
  });

  it("askingIn: the live planner whose brief or plans name the plan, within thirty minutes of its question", () => {
    expect(ANSWER_WINDOW).toBe(30 * MIN);
    const held = askingIn(ready("plans/asks.md"), [row], options(5));
    expect(held).toMatchObject({ row: { sessionId: ids.planner }, until: now + 25 * MIN });
    expect(
      askingIn(ready("plans/asks.md"), [row], options(5, { brief: "", plans: ["plans/asks.md"] })),
    ).toMatchObject({ until: now + 25 * MIN });
    // A plan that does not ask; a planner not live; one naming another path;
    // a question past the window; a planner that never asked.
    expect(askingIn({ path: "plans/asks.md", ...stateOf(head) }, [row], options(5))).toBeNull();
    expect(askingIn(ready("plans/asks.md"), [], options(5))).toBeNull();
    expect(askingIn(ready("plans/asks.md"), [row], options(5, { brief: "plans/x.md" }))).toBeNull();
    expect(askingIn(ready("plans/asks.md"), [row], options(31))).toBeNull();
    expect(askingIn(ready("plans/asks.md"), [row], options(null))).toBeNull();
    // A planned plan (plans/plans-as-github-issues.md) asks as a ready one does (/code-review).
    const planned = stateOf(asks.replace("builds it.\n", "builds it.\n\nIssue: #12.\n"));
    expect(planned).toMatchObject({ state: "planned", asks: true });
    expect(askingIn({ path: "plans/asks.md", ...planned }, [row], options(5))).toMatchObject({
      until: now + 25 * MIN,
    });
    // A built or building plan; an owner's interactive planner, which the queue gave nothing.
    expect(
      askingIn({ path: "plans/asks.md", state: "building", asks: true }, [row], options(5)),
    ).toBeNull();
    expect(
      askingIn({ path: "plans/asks.md", state: "built", asks: true }, [row], options(5)),
    ).toBeNull();
    expect(
      askingIn(ready("plans/asks.md"), [{ ...row, kind: "interactive" }], options(5)),
    ).toBeNull();
    // Talking does not restart the window: a question long ago holds nothing,
    // however recent the planner's last turn (askingIn reads no transcript).
    expect(askingIn(ready("plans/asks.md"), [row], options(45))).toBeNull();
    expect(askingIn(ready("plans/asks.md"), [row], options(30))).toBeNull();
    // Each plan has its own question: another plan's does not hold this one.
    expect(
      askingIn(ready("plans/asks.md"), [row], {
        ...options(null),
        stateFor: () => ({
          agent: "planner",
          plans: ["plans/asks.md", "plans/b.md"],
          asked: { "plans/b.md": now - MIN },
        }),
      }),
    ).toBeNull();
    // Before its question, a plan is held from when it was written: the
    // planner writes the plan, then asks.
    expect(
      askingIn({ ...ready("plans/asks.md"), mtime: now - 2 * MIN }, [row], options(null)),
    ).toMatchObject({ until: now + 28 * MIN });
    expect(
      askingIn({ ...ready("plans/asks.md"), mtime: now - 40 * MIN }, [row], options(null)),
    ).toBeNull();
    // The question, once asked, is what counts, however recent the last edit.
    expect(
      askingIn({ ...ready("plans/asks.md"), mtime: now - MIN }, [row], options(40)),
    ).toBeNull();
  });

  it("plannerContext says how long the plan is held", () => {
    const texts: Record<string, string> = { "plans/asks.md": asks };
    const within = plannerContext(
      { plans: ["plans/asks.md"], retired: false },
      [row],
      (path) => texts[path],
      options(5),
    );
    expect(within).toBe(
      `plans/asks.md is in the queue and still yours. It asks Javi until ${hhmm(now + 25 * MIN)}.`,
    );
    const past = plannerContext(
      { plans: ["plans/asks.md"], retired: false },
      [row],
      (path) => texts[path],
      options(40),
    );
    expect(past).toBe(
      "plans/asks.md is in the queue and still yours. Its question went unanswered for thirty minutes.",
    );
  });

  describe("in a fixture", () => {
    let dir: string;
    let projects: string;
    const live = [
      { ...row, cwd: "" },
      {
        sessionId: ids.exec,
        name: "Asks Executor 1",
        kind: "background",
        status: "idle",
        state: "done",
      },
    ];
    /** The planner's question, `minutes` ago, in its state as its tool hook writes it. */
    const asked = (minutes: number) => {
      const at = Date.now() - minutes * MIN;
      writeFileSync(
        stateFile(ids.planner),
        JSON.stringify({
          agent: "planner",
          brief: "plans/asks.md",
          plans: [],
          asked: { "plans/asks.md": at },
        }),
      );
      return at;
    };
    const queue = (args: string[], input: object = {}, rows: object[] = live) =>
      execFileSync("node", [join(here, "plan-queue.mjs"), ...args], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: dir,
          WORKFLOW_ROOT: dir,
          WORKFLOW_PROJECTS: projects,
          WORKFLOW_STARTS_LOG: join(dir, ".claude", "starts.log"),
          WORKFLOW_USAGE_FILE: join(dir, ".claude", "usage.json"),
          WORKFLOW_LIVE: JSON.stringify(rows.map((one) => ({ ...one, cwd: dir }))),
        },
      });
    // With no executor alive, so a start is not refused beside one.
    const start = (...paths: string[]) => queue(["start", "--dry", ...paths], {}, [live[0]]);

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "asks-"));
      projects = mkdtempSync(join(tmpdir(), "asks-projects-"));
      execFileSync("git", ["init", "-q"], { cwd: dir });
      mkdirSync(join(dir, ".claude"));
      mkdirSync(join(dir, "plans"));
      writeFileSync(join(dir, ".claude", "workflow.md"), "---\nname: Asks\nbranch: test\n---\n");
      writeFileSync(join(dir, "plans", "asks.md"), asks);
      writeFileSync(join(dir, "plans", "plain.md"), head);
      writeFileSync(
        join(dir, "plans", "topic.md"),
        "# T\n\nBrief for the planner, 28 October 2026.\n",
      );
      writeFileSync(
        stateFile(ids.planner),
        JSON.stringify({ agent: "planner", brief: "plans/asks.md", plans: [] }),
      );
    });
    afterAll(() => {
      for (const id of Object.values(ids)) rmSync(stateFile(id), { force: true });
      rmSync(dir, { recursive: true, force: true });
      rmSync(projects, { recursive: true, force: true });
    });

    it("lists a held plan under Asking Javi, and past the window under Ready", () => {
      const at = asked(5);
      const out = queue(["list"]);
      // The headings in order: Briefs, Asking, Ready.
      expect(out.indexOf("Briefs, oldest first")).toBeGreaterThan(0);
      expect(out.indexOf("Briefs, oldest first")).toBeLessThan(
        out.indexOf("Asking Javi, oldest first"),
      );
      expect(out.indexOf("Asking Javi, oldest first")).toBeLessThan(
        out.indexOf("Ready, oldest first"),
      );
      expect(out).toMatch(
        new RegExp(
          `plans/asks\\.md +Plan only, 28 October, in Asks Planner 3 \\[a1000000\\], waiting for input, the executor decides at ${hhmm(at + 30 * MIN)}`,
        ),
      );
      expect(out.slice(out.indexOf("Ready, oldest first"))).not.toContain("plans/asks.md");
      asked(40);
      const later = queue(["list"]);
      expect(later).not.toContain("Asking Javi");
      expect(later).toMatch(
        /plans\/asks\.md +Plan only, 28 October, unanswered, the executor decides/,
      );
    });

    it("plans start leaves a held plan out, refuses it by path, and starts it past the window", () => {
      const at = asked(5);
      const all = start();
      expect(all).toContain("plans/plain.md");
      expect(all).not.toContain("plans/asks.md");
      expect(start("plans/asks.md").trim()).toBe(
        `plans/asks.md asks Javi through the assistant chat until ${hhmm(at + 30 * MIN)}: he answers in the assistant chat, or the executor takes it then and decides by the recommended options.`,
      );
      // Refused whole, with another plan beside it.
      expect(start("plans/plain.md", "plans/asks.md")).not.toContain("Would run");
      // A deferred start, which nobody watches, starts the rest (/code-review).
      const deferred = execFileSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `import { start } from ${JSON.stringify(join(here, "plan-queue.mjs"))};
           console.log(start(["plans/plain.md", "plans/asks.md"], { dry: true, timer: true }));`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: dir,
            WORKFLOW_ROOT: dir,
            WORKFLOW_PROJECTS: projects,
            WORKFLOW_STARTS_LOG: join(dir, ".claude", "starts.log"),
            WORKFLOW_USAGE_FILE: join(dir, ".claude", "usage.json"),
            WORKFLOW_LIVE: JSON.stringify([{ ...live[0], cwd: dir }]),
          },
        },
      );
      expect(deferred).toContain("Would run: claude");
      expect(deferred).toContain("plans/plain.md");
      expect(deferred).not.toContain("plans/asks.md");
      asked(40);
      expect(start("plans/asks.md")).toContain("Would run: claude");
    });

    const deferredFile = () => join(dir, ".claude", "asking.deferred");
    /** The deferral the hook wrote, its timer killed so nothing fires after the test. */
    const takeDeferral = () => {
      const written = JSON.parse(readFileSync(deferredFile(), "utf8"));
      try {
        process.kill(written.pid);
      } catch {
        // Gone already.
      }
      rmSync(deferredFile(), { force: true });
      return written;
    };
    // plans/one-assistant-chat.md, part 3: the question is a message to the assistant chat.
    const question = (
      state: { brief?: string; asked?: object },
      message = `Question for Javi: ${state.brief || "plans/asks.md"}.\nThe header; the question.`,
    ) => {
      writeFileSync(
        stateFile(ids.planner),
        JSON.stringify({ agent: "planner", plans: [], ...state }),
      );
      const before = Date.now();
      const out = queue(["tool"], {
        session_id: ids.planner,
        agent_type: "workflow:planner",
        tool_name: "SendMessage",
        tool_input: { to: "Test Assistant", message },
      });
      return { out, before, state: JSON.parse(readFileSync(stateFile(ids.planner), "utf8")) };
    };

    it("the planner's Question for message records its time and defers a start of the plan it asks about", () => {
      rmSync(deferredFile(), { force: true });
      // A usage limit's deferral stands apart: the question neither moves nor merges it.
      const usageDeferral = join(dir, ".claude", "executor.deferred");
      const usage = { until: Date.now() + 5 * MIN, why: "the usage limit", paths: ["plans/x.md"] };
      writeFileSync(usageDeferral, JSON.stringify({ ...usage, pid: null }));
      const { out, before, state } = question({ brief: "plans/asks.md" });
      expect(out).toBe("");
      const at = state.asked["plans/asks.md"];
      expect(at).toBeGreaterThanOrEqual(before);
      // Then plans lists it under Asking Javi until thirty minutes on, and no executor takes it.
      expect(queue(["list"])).toMatch(
        new RegExp(
          `Asking Javi, oldest first\\n {2}plans/asks\\.md .*decides at ${hhmm(at + 30 * MIN)}`,
        ),
      );
      expect(start("plans/asks.md")).not.toContain("Would run");
      const written = takeDeferral();
      expect(written.paths).toEqual(["plans/asks.md"]);
      expect(written.why).toBe("Javi has thirty minutes to answer");
      expect(written.until).toBeGreaterThanOrEqual(at + 30 * MIN);
      expect(written.until).toBeLessThanOrEqual(at + 30 * MIN + 10_000);
      expect(written.pid).toBeGreaterThan(0);
      expect(JSON.parse(readFileSync(usageDeferral, "utf8"))).toMatchObject(usage);
      rmSync(usageDeferral);
      // A question about a plan that asks nothing, or before any plan: nothing held.
      const plain = question({ brief: "plans/plain.md" });
      expect(plain.out).toBe("");
      expect(plain.state.asked).toBeUndefined();
      expect(existsSync(deferredFile())).toBe(false);
      expect(question({ brief: "" }).state.asked).toBeUndefined();
      expect(existsSync(deferredFile())).toBe(false);
      // Another message, or one naming a plan the planner does not hold: nothing held.
      expect(
        question({ brief: "plans/asks.md" }, "Planned: plans/asks.md.").state.asked,
      ).toBeUndefined();
      expect(
        question({ brief: "plans/plain.md" }, "Question for Javi: plans/asks.md.").state.asked,
      ).toBeUndefined();
      expect(existsSync(deferredFile())).toBe(false);
      // A plan whose window ran out is not held again by a later question.
      const late = question({
        brief: "plans/asks.md",
        asked: { "plans/asks.md": Date.now() - 40 * MIN },
      });
      expect(late.state.asked["plans/asks.md"]).toBeLessThan(late.before);
      expect(existsSync(deferredFile())).toBe(false);
      // A second round inside the window holds it from the new question.
      const second = question({
        brief: "plans/asks.md",
        asked: { "plans/asks.md": Date.now() - 10 * MIN },
      });
      expect(second.state.asked["plans/asks.md"]).toBeGreaterThanOrEqual(second.before);
      takeDeferral();
      // The executor's message is never refused by the lock.
      writeFileSync(
        join(dir, ".claude", "executor.1.lock"),
        JSON.stringify({ sessionId: ids.other, pid: process.pid, released: false }),
      );
      try {
        expect(
          queue(["tool"], {
            session_id: ids.exec,
            agent_type: "workflow:executor",
            tool_name: "SendMessage",
            tool_input: { to: "Test Assistant", message: "Built: plans/x.md." },
          }),
        ).toBe("");
      } finally {
        rmSync(join(dir, ".claude", "executor.1.lock"), { force: true });
      }
    });

    /**
     * **A plan leaves the asking deferral once it is decided or taken**
     * (plans/research-order-and-asking-cleared.md): the planner's write of a
     * full "Decided", then an executor's Building line, in either path form.
     */
    it("a decided plan, then a taken one, leaves the asking deferral", () => {
      const plan = (name: string, text: string) =>
        writeFileSync(join(dir, "plans", `${name}.md`), text);
      writeFileSync(
        deferredFile(),
        JSON.stringify({
          until: Date.now() + 30 * MIN,
          why: "Javi has thirty minutes to answer",
          paths: ["plans/decided.md", "plans/taken.md"],
          pid: null,
        }),
      );
      const paths = () => JSON.parse(readFileSync(deferredFile(), "utf8")).paths;
      const planner = (file: string) =>
        queue(["wrote"], {
          session_id: ids.planner,
          agent_type: "workflow:planner",
          tool_name: "Edit",
          tool_input: { file_path: file },
        });
      // Still asking: it stays.
      plan("decided", asks.replace("# X", "# Decided"));
      planner(join(dir, "plans", "decided.md"));
      expect(paths()).toEqual(["plans/decided.md", "plans/taken.md"]);
      // Decided, by an absolute path: it goes, and the other stays.
      plan(
        "decided",
        `${asks.replace("# X", "# Decided")}\n## Decided, 28 October 2026\n\n1. One.\n`,
      );
      planner(join(dir, "plans", "decided.md"));
      expect(paths()).toEqual(["plans/taken.md"]);
      // An executor's Building line, by a relative path: the last one goes, and the file.
      plan("taken", `${head}\n## Building, 28 October 2026, session ${ids.exec}\n`);
      queue(["wrote"], {
        session_id: ids.exec,
        agent_type: "workflow:executor",
        tool_name: "Edit",
        tool_input: { file_path: "plans/taken.md" },
      });
      expect(existsSync(deferredFile())).toBe(false);
      // A shell command names no file: every plan the deferral holds is read.
      writeFileSync(
        deferredFile(),
        JSON.stringify({ until: Date.now() + 30 * MIN, why: "w", paths: ["plans/decided.md"] }),
      );
      queue(["wrote"], {
        session_id: ids.planner,
        agent_type: "workflow:planner",
        tool_name: "Bash",
        tool_input: { command: "cat >> plans/decided.md" },
      });
      expect(existsSync(deferredFile())).toBe(false);
      rmSync(join(dir, "plans", "decided.md"));
      rmSync(join(dir, "plans", "taken.md"));
      rmSync(stateFile(ids.exec), { force: true });
    });

    /**
     * **A dropped plan is never started** (plans/dropped-plan-state.md): left
     * out with no path, refused by path, dropped by a timer, and out of the
     * asking deferral the moment the planner writes the section.
     */
    it("a dropped plan is never started, and its drop takes it out of the asking deferral", () => {
      const file = join(dir, "plans", "dropped.md");
      writeFileSync(
        file,
        `${asks.replace("# X", "# Dropped")}\n## Dropped, 30 October 2026\n\nDropped on Javi's word: #31 already decides it.\n`,
      );
      try {
        expect(start()).not.toContain("plans/dropped.md");
        expect(start("plans/dropped.md").trim()).toBe(
          "plans/dropped.md is dropped (30 October 2026): nothing to build.",
        );
        // Refused whole, with another plan beside it.
        expect(start("plans/plain.md", "plans/dropped.md")).not.toContain("Would run");
        // The same path in another spelling (Codex, 30 October).
        for (const spelled of ["./plans/dropped.md", file])
          expect(start(spelled).trim(), spelled).toBe(
            "plans/dropped.md is dropped (30 October 2026): nothing to build.",
          );
        const timer = execFileSync(
          "node",
          [
            "--input-type=module",
            "-e",
            `import { start } from ${JSON.stringify(join(here, "plan-queue.mjs"))};
             console.log(start(["plans/dropped.md"], { dry: true, timer: true }));`,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              CLAUDE_PROJECT_DIR: dir,
              WORKFLOW_ROOT: dir,
              WORKFLOW_PROJECTS: projects,
              WORKFLOW_STARTS_LOG: join(dir, ".claude", "starts.log"),
              WORKFLOW_USAGE_FILE: join(dir, ".claude", "usage.json"),
              WORKFLOW_LIVE: JSON.stringify([{ ...live[0], cwd: dir }]),
            },
          },
        );
        expect(timer.trim()).toBe("Nothing is waiting in the queue.");
        writeFileSync(
          deferredFile(),
          JSON.stringify({
            until: Date.now() + 30 * MIN,
            why: "Javi has thirty minutes to answer",
            paths: ["plans/dropped.md", "plans/asks.md"],
            pid: null,
          }),
        );
        queue(["wrote"], {
          session_id: ids.planner,
          agent_type: "workflow:planner",
          tool_name: "Edit",
          tool_input: { file_path: file },
        });
        expect(JSON.parse(readFileSync(deferredFile(), "utf8")).paths).toEqual(["plans/asks.md"]);
        // The assistant drops a plan too: its write takes it out the same way (/code-review).
        writeFileSync(
          deferredFile(),
          JSON.stringify({
            until: Date.now() + 30 * MIN,
            why: "w",
            paths: ["plans/dropped.md", "plans/asks.md"],
            pid: null,
          }),
        );
        queue(["wrote"], {
          session_id: ids.planner,
          agent_type: "workflow:assistant",
          tool_name: "Edit",
          tool_input: { file_path: "plans/dropped.md" },
        });
        expect(JSON.parse(readFileSync(deferredFile(), "utf8")).paths).toEqual(["plans/asks.md"]);
        // An executor's Building line on it is refused, with the start's words (/code-review).
        const building = queue(["tool"], {
          session_id: ids.exec,
          agent_type: "workflow:executor",
          tool_name: "Edit",
          tool_input: {
            file_path: file,
            old_string: "# Dropped\n",
            new_string: `# Dropped\n\n## Building, 30 October 2026, session ${ids.exec}\n`,
          },
        });
        expect(JSON.parse(building).hookSpecificOutput.permissionDecisionReason).toBe(
          "plans/dropped.md is dropped (30 October 2026): nothing to build.",
        );
      } finally {
        rmSync(deferredFile(), { force: true });
        rmSync(file, { force: true });
        rmSync(stateFile(ids.exec), { force: true });
      }
    });

    // plans/plans-as-github-issues.md, part 3: a planned plan waits for Ready.
    it("a planned plan is skipped by the default pick, refused by path and listed with its issue", () => {
      const file = join(dir, "plans", "planned.md");
      const planned = `${head.replace("# ", "# Planned ")}\nIssue: #12.\n\n## What was asked\n`;
      writeFileSync(file, planned);
      const words =
        'plans/planned.md is planned and waits on GitHub (#12): it is built once the issue is labelled status: ready, or Javi says so in the assistant\'s chat, which writes its "Ready" section.';
      try {
        expect(start()).not.toContain("plans/planned.md");
        expect(start("plans/planned.md").trim()).toBe(words);
        expect(start("plans/plain.md", "plans/planned.md")).not.toContain("Would run");
        const out = queue(["list"]);
        expect(out).toMatch(
          /\nPlanned, waiting on GitHub\n {2}plans\/planned\.md +#12, since \d+ [A-Z][a-z]+\n/,
        );
        expect(out.slice(out.indexOf("Ready, oldest first"))).not.toContain("plans/planned.md");
        // An executor's Building line on it is refused, with the start's words.
        const building = queue(["tool"], {
          session_id: ids.exec,
          agent_type: "workflow:executor",
          tool_name: "Write",
          tool_input: {
            file_path: file,
            content: planned.replace(
              "\n## What was asked",
              `\n## Building, 3 November 2026, session ${ids.exec}\n\n## What was asked`,
            ),
          },
        });
        expect(JSON.parse(building).hookSpecificOutput.permissionDecisionReason).toBe(words);
        // Ready on GitHub: it is a plan like any other.
        writeFileSync(
          file,
          `${planned}\n## Ready, 4 November 2026\n\nReady on GitHub, 4 November.\n`,
        );
        expect(start("plans/planned.md")).toContain("Would run");
      } finally {
        rmSync(file, { force: true });
        rmSync(stateFile(ids.exec), { force: true });
      }
    });

    it("a timer whose plans were cleared leaves a newer deferral standing", () => {
      const newer = { until: Date.now() + 30 * MIN, why: "w", paths: ["plans/b.md"], pid: 1 };
      writeFileSync(deferredFile(), JSON.stringify(newer));
      // The old timer fires at once on a plan that is gone, and starts nothing.
      const out = queue(
        ["start", "--timer", String(Date.now()), "--deferral", "asking", "plans/gone.md"],
        {},
        [live[0]],
      );
      expect(out).toBe("");
      expect(JSON.parse(readFileSync(deferredFile(), "utf8"))).toEqual(newer);
      rmSync(deferredFile());
    });

    it("plans prints the window's deferral beside the Asking row, from the same question", () => {
      rmSync(deferredFile(), { force: true });
      const { state } = question({ brief: "plans/asks.md" });
      const at = state.asked["plans/asks.md"];
      const out = queue(["list"]);
      takeDeferral();
      expect(out).toContain(
        `Deferred until ${hhmm(at + 30 * MIN + 5000)}: Javi has thirty minutes to answer; plans/asks.md`,
      );
      expect(out).toContain(`the executor decides at ${hhmm(at + 30 * MIN)}`);
    });

    it("a timer's start takes only what is still waiting, and the window's replaces an idle executor", () => {
      const timerStart = (paths: string[], deferral = "asking") =>
        execFileSync(
          "node",
          [
            "--input-type=module",
            "-e",
            `import { start } from ${JSON.stringify(join(here, "plan-queue.mjs"))};
             console.log(start(${JSON.stringify(paths)}, { dry: true, timer: true, deferral: ${JSON.stringify(deferral)} }));`,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              CLAUDE_PROJECT_DIR: dir,
              WORKFLOW_ROOT: dir,
              WORKFLOW_PROJECTS: projects,
              WORKFLOW_STARTS_LOG: join(dir, ".claude", "starts.log"),
              WORKFLOW_USAGE_FILE: join(dir, ".claude", "usage.json"),
              // The executor in its worktree, executor-1 (plans/parallel-executors.md).
              WORKFLOW_LIVE: JSON.stringify(
                live.map((one) => ({
                  ...one,
                  cwd: /Executor/.test(one.name)
                    ? join(dir, ".claude", "worktrees", "executor-1")
                    : dir,
                })),
              ),
            },
          },
        );
      asked(40);
      writeFileSync(
        join(dir, "plans", "built.md"),
        `${head}\n## Built, 28 October 2026\n\nCommit \`0123abcd\`.\n`,
      );
      writeFileSync(
        join(dir, "plans", "taken.md"),
        `${head}\n## Building, 28 October 2026, session ${ids.exec}\n`,
      );
      writeFileSync(stateFile(ids.exec), JSON.stringify({ agent: "executor" }));
      try {
        expect(timerStart(["plans/built.md", "plans/taken.md"]).trim()).toBe(
          "Nothing is waiting in the queue.",
        );
        rmSync(join(dir, "plans", "taken.md"));
        const out = timerStart(["plans/built.md", "plans/asks.md"]);
        expect(out).toContain("Would run: claude");
        expect(out).toContain("Build plans/asks.md.");
        expect(out).toContain(
          "Would retire Asks Executor 1 [a3000000]: idle while a plan's thirty minutes ran out, and the queue cannot message it.",
        );
        // A usage limit's timer refuses beside the live executor, as before.
        expect(timerStart(["plans/asks.md"], "")).toContain("An executor is alive");
        // A plan dated before the queue, deferred by path, is kept.
        writeFileSync(
          join(dir, "plans", "older.md"),
          "# O\n\nPlan only, 20 October 2026, for Javi.\n",
        );
        expect(timerStart(["plans/built.md", "plans/older.md"])).toContain("Build plans/older.md.");
      } finally {
        rmSync(join(dir, "plans", "older.md"), { force: true });
        rmSync(join(dir, "plans", "built.md"), { force: true });
        rmSync(join(dir, "plans", "taken.md"), { force: true });
        rmSync(stateFile(ids.exec), { force: true });
      }
    });

    it("a question does not hold a plan written over thirty minutes ago and never asked", () => {
      rmSync(deferredFile(), { force: true });
      const file = join(dir, "plans", "asks.md");
      const long = (Date.now() - 40 * MIN) / 1000;
      utimesSync(file, long, long);
      try {
        const { state } = question({ brief: "plans/asks.md" });
        expect(state.asked).toBeUndefined();
        expect(existsSync(deferredFile())).toBe(false);
      } finally {
        const fresh = Date.now() / 1000;
        utimesSync(file, fresh, fresh);
      }
    });

    it("the window's start, deferred by usage, stays the window's", () => {
      rmSync(deferredFile(), { force: true });
      asked(40);
      const usageFile = join(dir, ".claude", "usage.json");
      const now = Date.now() / 1000;
      writeFileSync(
        usageFile,
        JSON.stringify({ at: now, five_hour: { used_percentage: 90, resets_at: now + 3600 } }),
      );
      try {
        execFileSync(
          "node",
          [
            "--input-type=module",
            "-e",
            `import { start } from ${JSON.stringify(join(here, "plan-queue.mjs"))};
             console.log(start(["plans/asks.md"], { timer: true, deferral: "asking" }));`,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              CLAUDE_PROJECT_DIR: dir,
              WORKFLOW_ROOT: dir,
              WORKFLOW_USAGE_FILE: usageFile,
              WORKFLOW_STARTS_LOG: join(dir, ".claude", "starts.log"),
              WORKFLOW_LIVE: JSON.stringify([{ ...live[0], cwd: dir }]),
            },
          },
        );
        expect(existsSync(join(dir, ".claude", "executor.deferred"))).toBe(false);
        expect(takeDeferral()).toMatchObject({
          paths: ["plans/asks.md"],
          why: "the five-hour window is at 90 percent",
        });
      } finally {
        rmSync(usageFile, { force: true });
      }
    });

    it("a window's timer that finds its plan asked again re-arms it at the new window", () => {
      rmSync(deferredFile(), { force: true });
      const at = asked(5);
      const out = execFileSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `import { start } from ${JSON.stringify(join(here, "plan-queue.mjs"))};
           console.log(start(["plans/asks.md"], { timer: true, deferral: "asking" }));`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: dir,
            WORKFLOW_ROOT: dir,
            WORKFLOW_LIVE: JSON.stringify([{ ...live[0], cwd: dir }]),
          },
        },
      );
      expect(out).toContain("plans/asks.md asks Javi through the assistant chat until");
      const written = takeDeferral();
      expect(written.paths).toEqual(["plans/asks.md"]);
      expect(written.until).toBe(at + 30 * MIN + 5000);
    });

    describe("the executor's Building line on a held plan", () => {
      const file = () => join(dir, "plans", "asks.md");
      const line = `## Building, 28 October 2026, session ${ids.exec}`;
      const exec = (mode: string, tool_name: string, tool_input: object) =>
        queue([mode], {
          session_id: ids.exec,
          agent_type: "workflow:executor",
          cwd: join(dir, ".claude", "worktrees", "executor-1"),
          tool_name,
          tool_input,
        });
      const edit = (new_string: string) =>
        exec("tool", "Edit", {
          file_path: file(),
          old_string: "## Decisions for Javi",
          new_string,
        });
      const denied = (out: string) =>
        out ? JSON.parse(out).hookSpecificOutput?.permissionDecisionReason || "" : "";
      const words = (at: number) =>
        `plans/asks.md is still asking Javi (its planner's until ${hhmm(at + 30 * MIN)}): build the other plans first, and come back to it after ${hhmm(at + 30 * MIN)}, or once its "Decided" says Javi wants it built now.`;
      afterAll(() => {
        writeFileSync(file(), asks);
        rmSync(stateFile(ids.exec), { force: true });
      });

      it("the tool hook refuses it by Edit, MultiEdit or Write while the plan asks, with the words", () => {
        const at = asked(5);
        expect(denied(edit(`${line}\n\n## Decisions for Javi`))).toBe(words(at));
        expect(
          denied(
            exec("tool", "MultiEdit", {
              file_path: file(),
              edits: [{ old_string: "# X\n", new_string: `# X\n\n${line}\n` }],
            }),
          ),
        ).toBe(words(at));
        expect(
          denied(exec("tool", "Write", { file_path: file(), content: `${line}\n\n${asks}` })),
        ).toBe(words(at));
      });

      it("lets it through past the window, with a Decided, or with the planner gone", () => {
        asked(40);
        expect(edit(`${line}\n\n## Decisions for Javi`)).toBe("");
        asked(5);
        // Javi said in the executor's chat to build it now: his word in Decided, first or with the line.
        expect(
          edit(
            `${line}\n\n## Decided, 28 October 2026\n\nJavi said in the executor's chat to build it now.\n\n## Decisions for Javi`,
          ),
        ).toBe("");
        writeFileSync(file(), `${asks}\n## Decided, 28 October 2026\n\nBuild it now (Javi).\n`);
        try {
          expect(edit(`${line}\n\n## Decisions for Javi`)).toBe("");
        } finally {
          writeFileSync(file(), asks);
        }
        expect(
          queue(
            ["tool"],
            {
              session_id: ids.exec,
              agent_type: "workflow:executor",
              tool_name: "Edit",
              tool_input: {
                file_path: file(),
                old_string: "## Decisions for Javi",
                new_string: `${line}\n\n## Decisions for Javi`,
              },
            },
            [live[1]],
          ),
        ).toBe("");
      });

      it("lets the executor's other edits to the held plan through, and its edits elsewhere", () => {
        asked(5);
        expect(edit("A note.\n\n## Decisions for Javi")).toBe("");
        // A Building line already there is not added by an edit beside it.
        writeFileSync(file(), `${asks}\n${line}\n`);
        try {
          expect(edit("A note.\n\n## Decisions for Javi")).toBe("");
        } finally {
          writeFileSync(file(), asks);
        }
        expect(
          exec("tool", "Write", {
            file_path: join(dir, ".claude", "worktrees", "executor-1", "notes.md"),
            content: `${line}\n`,
          }),
        ).toBe("");
      });

      it("the wrote hook takes a line a shell wrote out again, and leaves one past the window", () => {
        const at = asked(5);
        rmSync(stateFile(ids.exec), { force: true });
        writeFileSync(file(), asks.replace("\n## Decisions", `\n${line}\n\n## Decisions`));
        const out = JSON.parse(exec("wrote", "Bash", { command: "sed -i ... plans/asks.md" }));
        expect(out.decision).toBe("block");
        expect(out.reason).toBe(`${words(at)} Its Building line was taken out.`);
        expect(readFileSync(file(), "utf8")).not.toContain("## Building, ");
        asked(40);
        writeFileSync(file(), asks.replace("\n## Decisions", `\n${line}\n\n## Decisions`));
        expect(exec("wrote", "Bash", { command: "sed -i ... plans/asks.md" })).toBe("");
        expect(readFileSync(file(), "utf8")).toContain(line);
        // Let through once, it is not judged again, a new question or not.
        expect(JSON.parse(readFileSync(stateFile(ids.exec), "utf8")).taken).toEqual([
          "plans/asks.md",
        ]);
        asked(5);
        expect(exec("wrote", "Bash", { command: "true" })).toBe("");
        expect(readFileSync(file(), "utf8")).toContain(line);
        // A plan whose line is gone drops from the list, and is judged afresh.
        writeFileSync(file(), asks);
        expect(exec("wrote", "Bash", { command: "true" })).toBe("");
        expect(JSON.parse(readFileSync(stateFile(ids.exec), "utf8")).taken).toEqual([]);
      });

      it("before any question, a shell's line is judged by the plan's time before the command", () => {
        // The planner wrote the plan just now and has not asked yet (Codex).
        writeFileSync(
          stateFile(ids.planner),
          JSON.stringify({ agent: "planner", brief: "plans/asks.md", plans: [] }),
        );
        rmSync(stateFile(ids.exec), { force: true });
        writeFileSync(file(), asks);
        const before = statSync(file()).mtimeMs;
        expect(exec("tool", "Bash", { command: "sed -i 's/x/y/' plans/asks.md" })).toBe("");
        expect(JSON.parse(readFileSync(stateFile(ids.exec), "utf8")).plansAt).toMatchObject({
          "plans/asks.md": before,
        });
        writeFileSync(file(), asks.replace("\n## Decisions", `\n${line}\n\n## Decisions`));
        const out = JSON.parse(exec("wrote", "Bash", { command: "sed -i 's/x/y/' plans/asks.md" }));
        expect(out.reason).toBe(`${words(before)} Its Building line was taken out.`);
        expect(readFileSync(file(), "utf8")).not.toContain("## Building, ");
        writeFileSync(file(), asks);
      });

      it("an Edit let through with no sessions read is judged again at the next command (Codex)", () => {
        asked(5);
        rmSync(stateFile(ids.exec), { force: true });
        const input = {
          session_id: ids.exec,
          agent_type: "workflow:executor",
          tool_name: "Edit",
          tool_input: {
            file_path: file(),
            old_string: "## Decisions for Javi",
            new_string: `${line}\n\n## Decisions for Javi`,
          },
        };
        const blind = execFileSync("node", [join(here, "plan-queue.mjs"), "tool"], {
          input: JSON.stringify(input),
          encoding: "utf8",
          env: { ...process.env, CLAUDE_PROJECT_DIR: dir, WORKFLOW_LIVE: "null" },
        });
        expect(blind).toBe("");
        expect(existsSync(stateFile(ids.exec))).toBe(false);
        writeFileSync(file(), asks.replace("\n## Decisions", `\n${line}\n\n## Decisions`));
        expect(JSON.parse(exec("wrote", "Bash", { command: "true" })).decision).toBe("block");
        expect(readFileSync(file(), "utf8")).not.toContain("## Building, ");
        writeFileSync(file(), asks);
      });
    });

    it("editedText and buildingAdded read an edit's result", () => {
      expect(editedText("Edit", { old_string: "a", new_string: "b" }, "aa")).toBe("ba");
      expect(
        editedText("Edit", { old_string: "a", new_string: "b", replace_all: true }, "aa"),
      ).toBe("bb");
      expect(editedText("Edit", { old_string: "z", new_string: "b" }, "aa")).toBe("aa");
      expect(editedText("Edit", { old_string: "", new_string: "new" }, "")).toBe("new");
      expect(editedText("Write", { content: "c" }, "aa")).toBe("c");
      expect(
        editedText(
          "MultiEdit",
          {
            edits: [
              { old_string: "a", new_string: "b" },
              { old_string: "b", new_string: "$&c" },
            ],
          },
          "a",
        ),
      ).toBe("$&c");
      const building = "## Building, 28 October 2026, session x";
      expect(buildingAdded("# X\n", `# X\n${building}\n`)).toEqual([building]);
      expect(buildingAdded(`${building}\n`, `${building}\nmore\n`)).toEqual([]);
      expect(buildingAdded("# X\n## Building it\n", "# X\n## Building it\n1.\n")).toEqual([]);
    });

    it("the executor's Stop hook names a held plan only past the window, or with its planner gone", () => {
      asked(5);
      rmSync(stateFile(ids.exec), { force: true });
      const reason = () =>
        JSON.parse(queue(["stop"], { session_id: ids.exec, agent_type: "executor" })).reason;
      const within = reason();
      expect(within).toContain("plans/plain.md");
      expect(within).not.toContain("plans/asks.md");
      // One plan a stop (plans/parallel-executors.md, part 2): plain.md set
      // aside, the held plan is the first free once it may be named.
      const plain = join(dir, "plans", "plain.md");
      const aside = join(dir, "plans", "plain.txt");
      renameSync(plain, aside);
      try {
        asked(40);
        rmSync(stateFile(ids.exec), { force: true });
        expect(reason()).toContain(
          'plans/asks.md (decisions unanswered: the recommended options, "Asked once")',
        );
        // The planner's chat gone: the plan is the executor's at once.
        asked(5);
        rmSync(stateFile(ids.exec), { force: true });
        const gone = JSON.parse(
          queue(["stop"], { session_id: ids.exec, agent_type: "executor" }, [live[1]]),
        ).reason;
        expect(gone).toContain("plans/asks.md (decisions unanswered");
      } finally {
        renameSync(aside, plain);
      }
    });
  });
});

// plans/plans-as-github-issues.md, part 1: the queue writes on GitHub as the project's own app.
describe("github-app", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("signs a JWT with RS256, issued by the app's id, ending ten minutes out", () => {
    const now = Date.UTC(2026, 10, 3, 12);
    const jwt = appJwt("123", pem, now);
    const [head, body, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    expect(claims).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 600, iss: "123" });
    expect(
      createVerify("RSA-SHA256")
        .update(`${head}.${body}`)
        .verify(publicKey, signature, "base64url"),
    ).toBe(true);
    // A key whose line ends came as `\n` escapes signs the same.
    expect(appJwt("123", pem.replace(/\n/g, "\\n"), now)).toBe(jwt);
  });

  // plans/app-old-registration-said.md, part 1: what the app has, asked of GitHub.
  const answering =
    (answers: Record<string, [number, object]>, asked: string[] = []) =>
    async (url: string) => {
      const path = new URL(url).pathname;
      asked.push(path);
      const [status, body] = answers[path] || [404, { message: "Not Found" }];
      return new Response(JSON.stringify(body), { status });
    };

  it("appStanding reads the registration and the installation, and throws GitHub's message", async () => {
    const asked: string[] = [];
    const fetch = answering(
      {
        "/app": [200, { slug: "docs-claude", permissions: { actions: "write" }, events: ["push"] }],
        "/repos/o/r/installation": [
          200,
          {
            id: 7,
            permissions: { issues: "write" },
            events: ["issues"],
            html_url: "https://github.com/settings/installations/7",
          },
        ],
      },
      asked,
    );
    const standing = await appStanding({ owner: "o", repo: "r", id: "1", key: pem, fetch });
    expect(standing).toEqual({
      slug: "docs-claude",
      app: { permissions: { actions: "write" }, events: ["push"] },
      installation: {
        permissions: { issues: "write" },
        events: ["issues"],
        url: "https://github.com/settings/installations/7",
      },
    });
    expect(asked).toEqual(["/app", "/repos/o/r/installation"]);
    const missing = answering({ "/app": [200, { slug: "s" }] });
    await expect(
      appStanding({ owner: "o", repo: "r", id: "1", key: pem, fetch: missing }),
    ).rejects.toThrow("GET /repos/o/r/installation answered 404: Not Found");
  });

  it("appLacks says where a failed run cannot come from, and what is missing", () => {
    const none = { permissions: {}, events: [] };
    const both = { permissions: { actions: "read" }, events: ["workflow_run"] };
    const url = "https://github.com/settings/installations/7";
    expect(appLacks({ slug: "s", app: none, installation: { ...both, url } })).toEqual({
      where: "app",
      what: ["Actions read and write", "the Workflow run event"],
      slug: "s",
    });
    expect(appLacks({ slug: "s", app: both, installation: { ...both, url } })).toBeNull();
    expect(appLacks({ slug: "s", app: both, installation: { ...none, url } })).toEqual({
      where: "installation",
      what: ["Actions read and write", "the Workflow run event"],
      slug: "s",
      url,
    });
    const write = { permissions: { actions: "write" }, events: ["workflow_run"] };
    expect(appLacks({ slug: "s", app: write, installation: { ...write, url } })).toBeNull();
    expect(
      appLacks({ slug: "s", app: { ...write, events: [] }, installation: { ...write, url } }),
    ).toEqual({ where: "app", what: ["the Workflow run event"], slug: "s" });
  });

  it("reads the repository from a GitHub remote, https or ssh", () => {
    expect(repoOfRemote("https://github.com/o/r.git\n")).toBe("o/r");
    expect(repoOfRemote("git@github.com:o/r")).toBe("o/r");
    expect(repoOfRemote("https://example.org/o/r.git")).toBeNull();
  });
});

describe("plans gh", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const env = { PATH: process.env.PATH || "", WORKFLOW_APP_ID: "123", WORKFLOW_APP_KEY: pem };
  const now = Date.UTC(2026, 10, 3, 12);
  /** GitHub, as far as the token goes: the calls counted, each token an hour long from `now`. */
  const github = () => {
    const calls: string[] = [];
    const fetch = async (url: string, init: { method: string }) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      const body = url.endsWith("/installation")
        ? { id: 77 }
        : { token: `t${calls.length}`, expires_at: new Date(now + 3600_000).toISOString() };
      return { ok: true, status: 200, json: async () => body };
    };
    return { calls, fetch };
  };
  /** `gh`, as far as its calls go: their words and the token each was given. */
  const gh = () => {
    const runs: { args: string[]; token?: string }[] = [];
    const run = (_bin: string, args: string[], options: { env?: Record<string, string> }) => {
      runs.push({ args, token: options.env?.GH_TOKEN });
      return { status: 0, stdout: "", stderr: "" };
    };
    return { runs, run };
  };
  const cache = () => join(mkdtempSync(join(tmpdir(), "app-token-")), "app-token.json");

  it("with no app here, says what to register and runs nothing", async () => {
    const { runs, run } = gh();
    const { calls, fetch } = github();
    const done = await ghCommand(["issue", "list"], {
      env: { PATH: env.PATH },
      run,
      fetch,
      repo: "o/r",
      cacheFile: cache(),
    });
    expect(done).toEqual({
      said: "The project's Claude has no GitHub App here: register one on GitHub (Settings, Developer settings, GitHub Apps; Issues, Pull requests and Actions read and write; the events Issues, Issue comment, Pull request, Pull request review, Pull request review comment and Workflow run), install it on o/r, and set WORKFLOW_APP_ID and WORKFLOW_APP_KEY where GH_TOKEN is set, or in the file WORKFLOW_SECRETS_FILE names.",
      status: 1,
    });
    expect(runs).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("in a container setup made, names the host's file and the rebuild", () => {
    const mounted = { WORKFLOW_SECRETS_FILE: "/run/secrets/workflow.env" };
    expect(noAppWords("o/r", mounted, "Docs")).toBe(
      "The project's Claude has no GitHub App here: register one on GitHub (Settings, Developer settings, GitHub Apps; Issues, Pull requests and Actions read and write; the events Issues, Issue comment, Pull request, Pull request review, Pull request review comment and Workflow run), install it on o/r, and set WORKFLOW_APP_ID and WORKFLOW_APP_KEY in ~/.config/workflow/docs.env on the host, then rebuild the container.",
    );
    expect(noSecretWords(mounted, "Docs")).toBe(
      "The project's Claude has no webhook secret here: turn the webhook on in the app's settings on GitHub, subscribed to the events Issues, Issue comment, Pull request, Pull request review, Pull request review comment and Workflow run, with the address routed to this container and a secret, and set WORKFLOW_WEBHOOK_SECRET and WORKFLOW_WEBHOOK_PORT in ~/.config/workflow/docs.env on the host, then rebuild the container.",
    );
    expect(noAppWords("o/r", mounted, "My Docs")).toContain("~/.config/workflow/my-docs.env");
  });

  it("with any other secrets file, says where GH_TOKEN is set as before", () => {
    const other = { WORKFLOW_SECRETS_FILE: ".secrets/workflow.env" };
    expect(noAppWords("o/r", other, "Docs")).toBe(
      "The project's Claude has no GitHub App here: register one on GitHub (Settings, Developer settings, GitHub Apps; Issues, Pull requests and Actions read and write; the events Issues, Issue comment, Pull request, Pull request review, Pull request review comment and Workflow run), install it on o/r, and set WORKFLOW_APP_ID and WORKFLOW_APP_KEY where GH_TOKEN is set, or in the file WORKFLOW_SECRETS_FILE names.",
    );
    expect(noSecretWords(other, "Docs")).toBe(
      "The project's Claude has no webhook secret here: turn the webhook on in the app's settings on GitHub, subscribed to the events Issues, Issue comment, Pull request, Pull request review, Pull request review comment and Workflow run, with the address routed to this container and a secret, and set WORKFLOW_WEBHOOK_SECRET and WORKFLOW_WEBHOOK_PORT where GH_TOKEN is set, or in the file WORKFLOW_SECRETS_FILE names.",
    );
  });

  it("refuses gh pr ready as the hook does, and allows --undo", async () => {
    const { runs, run } = gh();
    const { fetch } = github();
    const options = { env, run, fetch, repo: "o/r", now, cacheFile: cache() };
    const refused = await ghCommand(["pr", "ready", "12"], options);
    expect(refused.status).toBe(1);
    expect(refused.said).toContain("never an agent's");
    expect(runs).toEqual([]);
    expect(await ghCommand(["pr", "ready", "--undo", "12"], options)).toEqual({
      said: "",
      status: 0,
    });
    expect(runs).toEqual([{ args: ["pr", "ready", "--undo", "12"], token: "t2" }]);
    // The tool hook reads `plans gh` as `gh`.
    expect(marksReady("plans gh pr ready 12")).toBe(true);
    expect(marksReady("plans gh pr ready --undo 12")).toBe(false);
  });

  // plans/screenshots-by-owners-login.md: the pictures go up with the owner's
  // login, the text is posted as the app.
  describe("with --attach", () => {
    const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const address = (n: number) => `https://github.com/user-attachments/assets/u${n}`;
    /** A folder with the pictures and a body file in it, the working directory of the call. */
    const folder = () => {
      const dir = mkdtempSync(join(tmpdir(), "attach-"));
      writeFileSync(join(dir, "a.png"), PNG);
      writeFileSync(join(dir, "b.png"), PNG);
      writeFileSync(join(dir, "e.png"), "");
      writeFileSync(join(dir, "a.txt"), "words");
      writeFileSync(join(dir, "body.md"), "Look:\n\n![The bar](./a.png)\n");
      return dir;
    };
    type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };
    /** GitHub: the app's token, the repositories' ids, and the uploads as `upload` answers them. */
    const github = (upload: (n: number) => Response | Promise<Response> = () => null as never) => {
      const calls: Call[] = [];
      let uploads = 0;
      const fetch = async (url: string, init: Omit<Call, "url">) => {
        calls.push({ url, ...init });
        const { host, pathname } = new URL(url);
        if (host === "uploads.github.com") {
          uploads += 1;
          return (
            (await upload(uploads)) ||
            new Response(JSON.stringify({ url: address(uploads) }), { status: 201 })
          );
        }
        const body = pathname.endsWith("/installation")
          ? { id: 77 }
          : pathname === "/repos/o/r"
            ? { id: 42 }
            : pathname === "/repos/o2/r2"
              ? { id: 43 }
              : { token: "app-token", expires_at: new Date(now + 3600_000).toISOString() };
        return new Response(JSON.stringify(body), { status: 200 });
      };
      const sent = () => calls.filter((call) => call.url.startsWith("https://uploads.github.com/"));
      return { calls, fetch, sent };
    };
    /** gh: `auth token` answered as given, every other call ending with `status`. */
    const gh = (
      login: { status: number; stdout: string } = { status: 0, stdout: "owner-token\n" },
      status = 0,
    ) => {
      const runs: { args: string[]; token?: string; cwd?: string; env?: Record<string, string> }[] =
        [];
      const run = (
        _bin: string,
        args: string[],
        options: { env?: Record<string, string>; cwd?: string },
      ) => {
        runs.push({ args, token: options.env?.GH_TOKEN, cwd: options.cwd, env: options.env });
        return args[0] === "auth" ? { ...login, stderr: "" } : { status, stdout: "", stderr: "" };
      };
      return { runs, run };
    };
    const options = (cwd: string, run: unknown, fetch: unknown) => ({
      env,
      run,
      fetch,
      repo: "o/r",
      now,
      cacheFile: cache(),
      cwd,
    });
    const words = (cause: string) =>
      `Screenshots not uploaded, so nothing was posted: ${cause}. Post it once more without --attach; the pictures stay where they are.`;

    it("plans gh uploads a picture with the owner's login and posts as the app", async () => {
      const dir = folder();
      const { calls, fetch, sent } = github();
      const { runs, run } = gh();
      const done = await ghCommand(
        ["pr", "create", "--title", "T", "--body-file", "body.md", "--attach", "a.png"],
        options(dir, run, fetch),
      );
      expect(done).toEqual({ said: "", status: 0 });
      expect(sent()).toHaveLength(1);
      const [upload] = sent();
      expect(upload.url).toBe(
        "https://uploads.github.com/user-attachments/assets?name=a.png&content_type=image%2Fpng&repository_id=42",
      );
      expect(upload.method).toBe("POST");
      expect(upload.headers.Authorization).toBe("token owner-token");
      expect(upload.headers["Content-Type"]).toBe("application/octet-stream");
      expect(Buffer.from(upload.body as Buffer).equals(PNG)).toBe(true);
      for (const call of calls.filter((call) => call !== upload))
        expect(call.headers.Authorization).toMatch(/^Bearer /);
      expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toContain(
        "GET /repos/o/r",
      );
      // The owner's login asked of gh with the environment as it is.
      expect(runs[0].args).toEqual(["auth", "token", "--hostname", "github.com"]);
      expect(runs[0].token).toBeUndefined();
      expect(runs).toHaveLength(2);
      expect(runs[1]).toMatchObject({
        args: ["pr", "create", "--title", "T", "--body", `Look:\n\n![The bar](${address(1)})\n`],
        token: "app-token",
        cwd: dir,
      });
    });

    it("a picture no reference names is appended with its alt text", async () => {
      const dir = folder();
      writeFileSync(join(dir, "my.shot.png"), PNG);
      const { fetch, sent } = github();
      const { runs, run } = gh();
      await ghCommand(
        ["issue", "comment", "3", "--body", "Text", "--attach", "b.png#Menu open"],
        options(dir, run, fetch),
      );
      expect(runs[1].args).toEqual([
        "issue",
        "comment",
        "3",
        "--body",
        `Text\n\n![Menu open](${address(1)})`,
      ]);
      // Without #, the alt is the base name, its dots spaces; a file named twice is sent once.
      const again = github();
      const second = gh();
      await ghCommand(
        [
          "pr",
          "comment",
          "3",
          "-b",
          "Text",
          "--attach",
          "b.png",
          "--attach=my.shot.png",
          "--attach",
          join(dir, "b.png"),
        ],
        options(dir, second.run, again.fetch),
      );
      expect(again.sent()).toHaveLength(2);
      expect(sent()).toHaveLength(1);
      expect(second.runs[1].args).toEqual([
        "pr",
        "comment",
        "3",
        "--body",
        `Text\n\n![b](${address(1)})\n\n![my shot](${address(2)})`,
      ]);
    });

    it("plans gh posts nothing when a picture does not go up", async () => {
      const refused = words(
        "GitHub refused a.png with the login gh has here (404: that login cannot push to o/r, or the upload does not take its token)",
      );
      const cases: (() => Response | Promise<Response>)[] = [
        () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
        () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }),
        () => new Response(JSON.stringify({ message: "Bad size" }), { status: 422 }),
        () => new Response("", { status: 500 }),
        () => Promise.reject(new Error("socket hang up")),
      ];
      const said = [
        refused,
        words("GitHub refused a.png with the login gh has here (401: that login has ended)"),
        words("GitHub refused a.png with the login gh has here (422: Bad size)"),
        words("GitHub refused a.png with the login gh has here (500: no reason given)"),
        words("a.png could not be sent (socket hang up)"),
      ];
      for (const [i, answer] of cases.entries()) {
        const dir = folder();
        const { fetch, sent } = github((n) => (n === 1 ? answer() : (null as never)));
        const { runs, run } = gh();
        const done = await ghCommand(
          ["pr", "create", "--body-file", "body.md", "--attach", "a.png", "--attach", "b.png"],
          options(dir, run, fetch),
        );
        expect(done).toEqual({ said: said[i], status: 1 });
        expect(runs.map((r) => r.args[0])).toEqual(["auth"]);
        // The second file is never sent.
        expect(sent()).toHaveLength(1);
      }
    });

    it("plans gh posts nothing with no login to upload with", async () => {
      for (const login of [
        { status: 1, stdout: "" },
        { status: 0, stdout: "\n" },
      ]) {
        const dir = folder();
        const { calls, fetch } = github();
        const { runs, run } = gh(login);
        expect(
          await ghCommand(
            ["pr", "create", "--body", "x", "--attach", "a.png"],
            options(dir, run, fetch),
          ),
        ).toEqual({ said: words("gh has no login here to upload them with"), status: 1 });
        expect(calls.filter((call) => call.url.includes("uploads.github.com"))).toEqual([]);
        expect(runs.map((r) => r.args[0])).toEqual(["auth"]);
      }
    });

    it("plans gh checks the files and the body before any upload", async () => {
      const cases: [string[], string][] = [
        [["--body", "x", "--attach", "c.png"], "c.png is not there"],
        [["--body", "x", "--attach", "e.png"], "e.png is empty"],
        [
          ["--body", "x", "--attach", "a.txt"],
          "a.txt is not an image GitHub takes (png, jpg, jpeg, gif, webp or svg)",
        ],
        [["--attach", "a.png"], "the command has no --body-file or --body for them to go in"],
        [
          ["--body-file", "-", "--attach", "a.png"],
          "the text is read from stdin (--body-file -), which plans gh does not read: give it as a file",
        ],
        [["--body-file", "gone.md", "--attach", "a.png"], "gone.md is not there"],
      ];
      for (const [tail, cause] of cases) {
        const dir = folder();
        const { calls, fetch } = github();
        const { runs, run } = gh();
        expect(await ghCommand(["pr", "create", ...tail], options(dir, run, fetch))).toEqual({
          said: words(cause),
          status: 1,
        });
        expect(calls).toEqual([]);
        expect(runs).toEqual([]);
      }
    });

    it("a gh that fails after the upload says nothing more", async () => {
      const dir = folder();
      const { calls, fetch } = github();
      const { run } = gh(undefined, 4);
      expect(
        await ghCommand(
          ["issue", "create", "--body-file", "body.md", "--attach=a.png"],
          options(dir, run, fetch),
        ),
      ).toEqual({ said: "", status: 4 });
      expect(calls.map((call) => new URL(call.url).pathname)).not.toContain("/app");
    });

    it("plans gh without --attach asks for no login", async () => {
      const dir = folder();
      const { calls, fetch } = github();
      const { runs, run } = gh();
      await ghCommand(["pr", "create", "--body", "x"], options(dir, run, fetch));
      // `plans gh api` is untouched, --attach or not.
      await ghCommand(["api", "repos/o/r", "--attach", "a.png"], options(dir, run, fetch));
      expect(runs.map((r) => r.args[0])).toEqual(["pr", "api"]);
      expect(runs[1].args).toEqual(["api", "repos/o/r", "--attach", "a.png"]);
      expect(calls.filter((call) => call.url.includes("uploads.github.com"))).toEqual([]);
    });

    it("withAddresses", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "attach-cwd-"));
      const dir = mkdtempSync(join(tmpdir(), "attach-dir-"));
      const files = [
        { path: join(dir, "a.png"), alt: "a", url: "u-dir" },
        { path: join(cwd, "a.png"), alt: "a", url: "u-cwd" },
        { path: join(cwd, "my shot.png"), alt: "my shot", url: "u-shot" },
      ];
      // The body file's folder wins over the working directory's.
      expect(withAddresses("![x](./a.png)", files.slice(0, 2), dir, cwd)).toBe(
        "![x](u-dir)\n\n![a](u-cwd)",
      );
      // Angle brackets off and percent signs decoded; a title kept.
      expect(
        withAddresses('![y](<./my shot.png>) ![z](my%20shot.png "t")', files.slice(2), dir, cwd),
      ).toBe('![y](u-shot) ![z](u-shot "t")');
      // One inside a fenced block stays; the file is appended, its alt escaped.
      const fenced = "```md\n![x](./a.png)\n```\n";
      expect(withAddresses(fenced, [{ ...files[0], alt: "a [b]\nc" }], dir, cwd)).toBe(
        `${fenced.trimEnd()}\n\n![a \\[b\\] c](u-dir)`,
      );
      expect(
        withAddresses("~~~\n![x](./a.png)\n~~~\n![x](./a.png)", files.slice(0, 1), dir, cwd),
      ).toBe("~~~\n![x](./a.png)\n~~~\n![x](u-dir)");
      // Codex C3: parentheses in a destination; a code span stays as written (code-review).
      const paren = [{ path: join(dir, "chart(1).png"), alt: "chart(1)", url: "u-paren" }];
      expect(withAddresses("![Chart](./chart(1).png)", paren, dir, cwd)).toBe("![Chart](u-paren)");
      expect(withAddresses("![Chart](./chart\\(1\\).png)", paren, dir, cwd)).toBe(
        "![Chart](u-paren)",
      );
      expect(withAddresses("`![x](./a.png)` and ![x](./a.png)", files.slice(0, 1), dir, cwd)).toBe(
        "`![x](./a.png)` and ![x](u-dir)",
      );
      // -R o2/r2 sends o2/r2's id.
      const folderOf = folder();
      const { fetch, sent } = github();
      const { runs, run } = gh();
      await ghCommand(
        ["pr", "comment", "3", "-R", "o2/r2", "--body", "x", "--attach", "a.png"],
        options(folderOf, run, fetch),
      );
      expect(sent()[0].url).toContain("&repository_id=43");
      expect(runs[1].args).toEqual([
        "pr",
        "comment",
        "3",
        "-R",
        "o2/r2",
        "--body",
        `x\n\n![a](${address(1)})`,
      ]);
      // Codex C1: -R HOST/OWNER/REPO, an issue's address, or GH_REPO names the repository.
      const targets: [string[], Record<string, string>, number][] = [
        [["-R", "github.com/o2/r2"], {}, 43],
        [["https://github.com/o2/r2/issues/3"], {}, 43],
        [[], { GH_REPO: "o2/r2" }, 43],
        [[], {}, 42],
      ];
      for (const [extra, more, id] of targets) {
        const other = github();
        const second = gh();
        await ghCommand(["issue", "comment", ...extra, "--body", "x", "--attach", "a.png"], {
          ...options(folderOf, second.run, other.fetch),
          env: { ...env, ...more },
        });
        expect(other.sent()[0].url).toContain(`&repository_id=${id}`);
      }
    });

    // Codex C5 and C6.
    it("plans gh reads --attach only as the flag, and says a body file it cannot read", async () => {
      const dir = folder();
      const { calls, fetch } = github();
      const { runs, run } = gh();
      expect(
        await ghCommand(["issue", "comment", "12", "--body", "--attach"], options(dir, run, fetch)),
      ).toEqual({ said: "", status: 0 });
      expect(runs.map((r) => r.args[0])).toEqual(["issue"]);
      expect(calls.filter((call) => call.url.includes("uploads.github.com"))).toEqual([]);
      if (process.getuid?.() === 0) return;
      chmodSync(join(dir, "body.md"), 0o000);
      const done = await ghCommand(
        ["pr", "create", "--body-file", "body.md", "--attach", "a.png"],
        options(dir, run, fetch),
      );
      expect(done.status).toBe(1);
      expect(done.said).toMatch(
        /^Screenshots not uploaded, so nothing was posted: body\.md could not be read \(EACCES: .*\)\. Post it once more without --attach; the pictures stay where they are\.$/,
      );
    });
  });

  it("mints the token once and reuses it until five minutes before it ends", async () => {
    const { runs, run } = gh();
    const { calls, fetch } = github();
    const cacheFile = cache();
    const at = (minutes: number) => ({
      env,
      run,
      fetch,
      repo: "o/r",
      cacheFile,
      now: now + minutes * 60_000,
    });
    await ghCommand(["issue", "list"], at(0));
    await ghCommand(["issue", "list"], at(30));
    await ghCommand(["issue", "list"], at(54));
    expect(calls).toEqual([
      "GET /repos/o/r/installation",
      "POST /app/installations/77/access_tokens",
    ]);
    await ghCommand(["issue", "list"], at(56));
    expect(calls).toHaveLength(4);
    expect(runs.map((one) => one.token)).toEqual(["t2", "t2", "t2", "t4"]);
    // Another repository's token is never reused.
    await ghCommand(["issue", "list"], { ...at(57), repo: "o/other" });
    expect(calls).toHaveLength(6);
  });

  it("says GitHub's answer when no token can be minted", async () => {
    const { runs, run } = gh();
    const fetch = async () => ({
      ok: false,
      status: 404,
      json: async () => ({ message: "Not Found" }),
    });
    const done = await ghCommand(["issue", "list"], {
      env,
      run,
      fetch,
      repo: "o/r",
      now,
      cacheFile: cache(),
    });
    expect(done).toEqual({
      said: "The project's Claude could not get a token from GitHub: GET /repos/o/r/installation answered 404: Not Found.",
      status: 1,
    });
    expect(runs).toEqual([]);
  });

  it("says so when gh cannot be run", async () => {
    const { fetch } = github();
    const run = () => ({ status: null, error: new Error("spawnSync gh ENOENT") });
    expect(
      await ghCommand(["issue", "list"], { env, run, fetch, repo: "o/r", now, cacheFile: cache() }),
    ).toEqual({ said: "The project's Claude could not run gh: spawnSync gh ENOENT.", status: 1 });
  });

  it("as a command, prints the refusal and starts no gh", () => {
    const marker = join(mkdtempSync(join(tmpdir(), "gh-ran-")), "ran");
    const fake = join(mkdtempSync(join(tmpdir(), "fake-gh-")), "gh");
    writeFileSync(fake, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(fake, 0o755);
    const done = spawnSync("node", [join(here, "plan-queue.mjs"), "gh", "issue", "list"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH || "", WORKFLOW_ROOT: repo, WORKFLOW_GH: fake },
    });
    expect(done.status).toBe(1);
    expect(done.stderr).toMatch(/^The project's Claude has no GitHub App here: /);
    expect(existsSync(marker)).toBe(false);
  });
});

// plans/secrets-from-a-file.md: the app's key and the webhook's secret from a private file.
describe("secrets from a file", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const names = ["WORKFLOW_APP_ID", "WORKFLOW_APP_KEY", "WORKFLOW_WEBHOOK_SECRET"];
  const file = (text: string) => {
    const path = join(mkdtempSync(join(tmpdir(), "secrets-")), "workflow.env");
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  };

  it("reads the app's id, key and the webhook's secret from the file when the environment has none", () => {
    const path = file(
      `# The queue's secrets\nexport WORKFLOW_APP_ID=123 # the app's\nWORKFLOW_APP_KEY="${pem}"\nWORKFLOW_WEBHOOK_SECRET='s3 cret' # the webhook's\n`,
    );
    const env = { PATH: "", WORKFLOW_SECRETS_FILE: path };
    expect(secret("WORKFLOW_APP_ID", env)).toBe("123");
    expect(secret("WORKFLOW_APP_KEY", env)).toBe(pem);
    expect(secret("WORKFLOW_WEBHOOK_SECRET", env)).toBe("s3 cret");
    // A value that begins with `#` is the value, as Compose reads it.
    const hashed = file("WORKFLOW_WEBHOOK_SECRET=#Xk9#2\n");
    expect(secret("WORKFLOW_WEBHOOK_SECRET", { WORKFLOW_SECRETS_FILE: hashed })).toBe("#Xk9#2");
  });

  it("reads a relative path from the checkout's root, wherever the command runs", () => {
    const checkout = mkdtempSync(join(tmpdir(), "secrets-root-"));
    mkdirSync(join(checkout, ".devcontainer"));
    writeFileSync(join(checkout, ".devcontainer", "workflow.env"), "WORKFLOW_APP_ID=123\n");
    const source = `import { secret } from ${JSON.stringify(join(here, "plan-queue.mjs"))}; process.stdout.write(secret("WORKFLOW_APP_ID"));`;
    const done = spawnSync("node", ["--input-type=module", "-e", source], {
      cwd: tmpdir(),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH || "",
        WORKFLOW_ROOT: checkout,
        WORKFLOW_SECRETS_FILE: ".devcontainer/workflow.env",
      },
    });
    rmSync(checkout, { recursive: true, force: true });
    expect(done.stdout).toBe("123");
  });

  it("reads a key spanning lines in one double-quoted value whole, and a key with \\n escapes signs the same", () => {
    const now = Date.UTC(2026, 10, 6, 12);
    const spanning = file(`WORKFLOW_APP_KEY="${pem}"\nWORKFLOW_APP_ID=123\n`);
    const escaped = file(`WORKFLOW_APP_KEY=${pem.replace(/\n/g, "\\n")}\n`);
    const quoted = file(`WORKFLOW_APP_KEY="${pem.replace(/\n/g, "\\n")}"\n`);
    const key = (path: string) => secret("WORKFLOW_APP_KEY", { WORKFLOW_SECRETS_FILE: path });
    expect(key(spanning)).toBe(pem);
    expect(secret("WORKFLOW_APP_ID", { WORKFLOW_SECRETS_FILE: spanning })).toBe("123");
    expect(appJwt("123", key(escaped), now)).toBe(appJwt("123", pem, now));
    expect(appJwt("123", key(quoted), now)).toBe(appJwt("123", pem, now));
  });

  it("lets a name set in the environment win over the file", () => {
    const path = file("WORKFLOW_APP_ID=123\nWORKFLOW_WEBHOOK_SECRET=from-file\n");
    const env = { WORKFLOW_SECRETS_FILE: path, WORKFLOW_APP_ID: "456" };
    expect(secret("WORKFLOW_APP_ID", env)).toBe("456");
    expect(secret("WORKFLOW_WEBHOOK_SECRET", env)).toBe("from-file");
  });

  it("reads a missing or unreadable file as unset, and the refusals name the file", async () => {
    const missing = join(tmpdir(), "no-such-secrets.env");
    const unreadable = file("WORKFLOW_APP_ID=123\n");
    chmodSync(unreadable, 0o000);
    // Root reads a file whatever its mode, so the unreadable one counts only for others.
    const asRoot = process.getuid?.() === 0;
    const folder = mkdtempSync(join(tmpdir(), "secrets-dir-"));
    for (const path of [missing, folder, ...(asRoot ? [] : [unreadable])]) {
      for (const name of names) expect(secret(name, { WORKFLOW_SECRETS_FILE: path })).toBe("");
    }
    const ran: string[][] = [];
    const done = await ghCommand(["issue", "list"], {
      env: { PATH: "", WORKFLOW_SECRETS_FILE: missing },
      run: (_bin: string, args: string[]) => {
        ran.push(args);
        return { status: 0, stdout: "", stderr: "" };
      },
      repo: "o/r",
    });
    expect(done).toEqual({
      said: "The project's Claude has no GitHub App here: register one on GitHub (Settings, Developer settings, GitHub Apps; Issues, Pull requests and Actions read and write; the events Issues, Issue comment, Pull request, Pull request review, Pull request review comment and Workflow run), install it on o/r, and set WORKFLOW_APP_ID and WORKFLOW_APP_KEY where GH_TOKEN is set, or in the file WORKFLOW_SECRETS_FILE names.",
      status: 1,
    });
    expect(ran).toEqual([]);
  });

  it("plans gh mints from the file's key and leaves none of the three in process.env", async () => {
    const path = file(
      `WORKFLOW_APP_ID=123\nWORKFLOW_APP_KEY="${pem}"\nWORKFLOW_WEBHOOK_SECRET=s3cret\n`,
    );
    const before = names.map((name) => process.env[name]);
    for (const name of names) delete process.env[name];
    const now = Date.UTC(2026, 10, 6, 12);
    const fetch = async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith("/installation")
          ? { id: 77 }
          : { token: "t", expires_at: new Date(now + 3600_000).toISOString() },
    });
    const runs: Record<string, string>[] = [];
    try {
      const done = await ghCommand(["issue", "list"], {
        env: { ...process.env, WORKFLOW_SECRETS_FILE: path },
        run: (_bin: string, _args: string[], options: { env: Record<string, string> }) => {
          runs.push(options.env);
          return { status: 0, stdout: "", stderr: "" };
        },
        fetch,
        repo: "o/r",
        now,
        cacheFile: join(mkdtempSync(join(tmpdir(), "app-token-")), "app-token.json"),
      });
      expect(done).toEqual({ said: "", status: 0 });
      expect(runs[0].GH_TOKEN).toBe("t");
      for (const name of names) {
        expect(process.env[name]).toBeUndefined();
        expect(runs[0][name]).toBeUndefined();
      }
    } finally {
      names.forEach((name, i) => {
        if (before[i] !== undefined) process.env[name] = before[i];
      });
    }
  });
});

// plans/github-watched.md: what people write on GitHub reaches the queue on its own.
describe("github webhook", () => {
  const sign = (secret: string, body: string) =>
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  it("verifyDelivery accepts a body signed with the secret and refuses a wrong one, none and sha1", () => {
    const body = '{"zen":"Keep it logically awesome."}';
    expect(verifyDelivery("s3cret", body, sign("s3cret", body))).toBe(true);
    expect(verifyDelivery("s3cret", body, sign("other", body))).toBe(false);
    expect(verifyDelivery("s3cret", `${body} `, sign("s3cret", body))).toBe(false);
    expect(verifyDelivery("s3cret", body, undefined)).toBe(false);
    const sha1 = `sha1=${createHmac("sha1", "s3cret").update(body).digest("hex")}`;
    expect(verifyDelivery("s3cret", body, sha1)).toBe(false);
    expect(verifyDelivery("", body, sign("", body))).toBe(false);
  });

  it("WEBHOOK_EVENTS names every event itemsOfDelivery branches on, each giving an item", () => {
    // One sample delivery a listed event; each gives the queue an item.
    const repository = { full_name: "o/r" };
    const samples: Record<string, object> = {
      issues: { action: "opened", issue: { number: 1, title: "T", user: { login: "a" } } },
      issue_comment: { action: "created", issue: { number: 1 }, comment: { body: "b" } },
      pull_request: { action: "closed", pull_request: { number: 2, merged: true } },
      pull_request_review: { action: "submitted", pull_request: { number: 2 }, review: {} },
      pull_request_review_comment: { action: "created", pull_request: { number: 2 }, comment: {} },
      workflow_run: {
        action: "completed",
        repository,
        workflow_run: { id: 9, conclusion: "failure", head_repository: repository },
      },
    };
    const listed = WEBHOOK_EVENTS.map((e) => e.event);
    for (const event of listed) {
      expect(samples[event], event).toBeDefined();
      expect(itemsOfDelivery(event, samples[event], "d"), event).toHaveLength(1);
    }
    // An event the parser compares against and the list lacks fails here. Every use of `event` in
    // its body is `event === "<name>"`, so a branch written another way fails too, until this
    // test reads it (/code-review).
    const source = String(itemsOfDelivery);
    const body = source.slice(source.indexOf("{")).replace(/\/\/.*$/gm, "");
    const uses = body.match(/(?<![.\w])event\b/g) || [];
    const branched = [...body.matchAll(/(?<![.\w])event === "(\w+)"/g)].map((m) => m[1]);
    expect(uses.length).toBe(branched.length);
    expect(new Set(branched)).toEqual(new Set(listed));
    // The handbook's rule names the same events, as the two lines do (/code-review).
    const labels = WEBHOOK_EVENTS.map((e) => e.label);
    const handbook = readFileSync(
      new URL("../plugins/workflow/docs/workflow.md", import.meta.url),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(handbook).toContain(
      `subscribed to the events the webhook reads: ${labels.slice(0, -1).join(", ")} and ${labels.at(-1)};`,
    );
    expect(WEBHOOK_EVENTS.map((e) => e.label)).toEqual([
      "Issues",
      "Issue comment",
      "Pull request",
      "Pull request review",
      "Pull request review comment",
      "Workflow run",
    ]);
  });

  const at = (minute: number) => `2026-11-03T21:${String(minute).padStart(2, "0")}:00Z`;
  const user = (login: string) => ({ login });
  const deliveries: [string, string, object][] = [
    [
      "d1",
      "issues",
      {
        action: "labeled",
        label: { name: "status: planning" },
        issue: {
          number: 20,
          title: "Reorder",
          labels: [{ name: "status: planning" }],
          updated_at: at(1),
          html_url: "u20",
        },
        sender: user("henry"),
      },
    ],
    [
      "d2",
      "issue_comment",
      {
        action: "created",
        issue: { number: 12, title: "Series", labels: [] },
        comment: {
          body: "@docs-claude can this also keep the order on the phone?",
          user: user("henry"),
          created_at: at(2),
          html_url: "c2",
        },
      },
    ],
    [
      "d3",
      "issue_comment",
      {
        action: "created",
        issue: { number: 12, title: "Series", labels: [] },
        comment: { body: "Nice!", user: user("reader"), created_at: at(3), html_url: "c3" },
      },
    ],
    [
      "d4",
      "pull_request_review_comment",
      {
        action: "created",
        pull_request: { number: 40, title: "Series", head: { ref: "series-order" }, labels: [] },
        comment: { body: "Rename this.", user: user("anton"), created_at: at(4), html_url: "r4" },
      },
    ],
    [
      "d5",
      "pull_request",
      {
        action: "closed",
        pull_request: {
          number: 41,
          title: "Small",
          merged: true,
          merged_at: at(5),
          body: "For #12.\n\n## Changes\n",
          head: { ref: "x" },
          labels: [],
        },
        sender: user("javi"),
      },
    ],
    [
      "d6",
      "issues",
      {
        action: "labeled",
        label: { name: "status: ready" },
        issue: {
          number: 12,
          title: "Series",
          labels: [{ name: "status: ready" }],
          updated_at: at(6),
        },
        sender: user("anton"),
      },
    ],
    [
      "d7",
      "issue_comment",
      {
        action: "created",
        issue: { number: 12, title: "Series", labels: [] },
        comment: {
          body: "Answered from the plan.",
          user: user("docs-claude[bot]"),
          created_at: at(7),
        },
      },
    ],
  ];
  const items = deliveries.flatMap(([id, event, payload]) => itemsOfDelivery(event, payload, id));
  const seen = {
    deliveries: [],
    issues: {},
    pulls: {},
    permissions: { henry: "write", anton: "write", javi: "admin", reader: "read" },
    readAt: "",
  };
  const context = {
    carried: [12],
    planned: [12],
    own: [40, "series-order"],
    slug: "docs-claude",
  };

  it("githubEvents returns the five events of seven deliveries, none for a reader's or the app's", () => {
    const { events } = githubEvents(seen, items, context);
    expect(events.map((one) => [one.kind, one.number, one.by])).toEqual([
      ["plan", 20, "henry"],
      ["mention", 12, "henry"],
      ["review", 40, "anton"],
      ["merged", 41, "javi"],
      ["ready", 12, "anton"],
    ]);
    expect(events[3]).toMatchObject({ issues: [12], head: "x" });
    // The same delivery twice is one event: GitHub's redelivery is safe.
    const twice = githubEvents(seen, [items[1], items[1]], context);
    expect(twice.events).toHaveLength(1);
    expect(githubEvents(twice.seen, [items[1]], context).events).toEqual([]);
  });

  it("an issue opened with the planning label is one plan event, and a read's label counts once", () => {
    const issue = {
      number: 21,
      title: "New",
      labels: [{ name: "status: planning" }],
      created_at: at(8),
      updated_at: at(8),
    };
    const both = [
      ...itemsOfDelivery(
        "issues",
        { action: "opened", issue: { ...issue, user: user("henry") } },
        "o1",
      ),
      ...itemsOfDelivery(
        "issues",
        { action: "labeled", label: { name: "status: planning" }, issue, sender: user("henry") },
        "o2",
      ),
    ];
    const first = githubEvents(seen, both, context);
    expect(first.events.map((one) => one.kind)).toEqual(["plan"]);
    expect(first.seen.labeled).toEqual(["21:status: planning"]);
  });

  // plans/people-comments-reach-the-queue.md, part 2: a named person's comment is an event
  // wherever it is written; another writer's stays where it was.
  const named = { ...context, people: ["Henry", "reader"] };
  const onIssue = (id: string, login: string, number = 30) =>
    itemsOfDelivery(
      "issue_comment",
      {
        action: "created",
        issue: { number, title: "Loose", labels: [], html_url: `u${number}` },
        comment: { body: "Could the list sort by date?", user: user(login), created_at: at(9) },
      },
      id,
    );
  const theirPull = { number: 50, title: "Theirs", head: { ref: "their-branch" }, labels: [] };
  const onPull = (id: string, login: string, body = "Rename this.") => [
    ...itemsOfDelivery(
      "issue_comment",
      {
        action: "created",
        issue: { number: 50, title: "Theirs", labels: [], pull_request: {} },
        comment: { body, user: user(login), created_at: at(10), html_url: `${id}a` },
      },
      `${id}a`,
    ),
    ...itemsOfDelivery(
      "pull_request_review_comment",
      {
        action: "created",
        pull_request: theirPull,
        comment: { body, user: user(login), created_at: at(11), html_url: `${id}b` },
      },
      `${id}b`,
    ),
    ...itemsOfDelivery(
      "pull_request_review",
      {
        action: "submitted",
        pull_request: theirPull,
        review: { body, user: user(login), submitted_at: at(12), html_url: `${id}c` },
      },
      `${id}c`,
    ),
  ];

  it("a named person's comment on an issue no plan carries is a comment event, with its note", () => {
    const { events } = githubEvents(seen, onIssue("p1", "henry"), named);
    expect(events.map((one) => [one.kind, one.number, one.by])).toEqual([["comment", 30, "henry"]]);
    expect(noteFor(events[0], { first: true })).toMatch(
      /^# GitHub #30: Loose\n\ncomment, 3 November 2026 \d\d:09, by henry \(write\): u30\n {4}Could the list sort by date\?\n\n$/,
    );
  });

  it("a named person's comment on a pull request not the queue's own is a review event", () => {
    const { events } = githubEvents(seen, onPull("p2", "henry"), named);
    expect(events.map((one) => [one.kind, one.number, one.by, one.url])).toEqual([
      ["review", 50, "henry", "p2a"],
      ["review", 50, "henry", "p2b"],
      ["review", 50, "henry", "p2c"],
    ]);
    // One that names the app is a mention there, as anywhere.
    const mention = githubEvents(seen, onPull("p3", "henry", "@docs-claude rename this."), named);
    expect(mention.events.map((one) => one.kind)).toEqual(["mention", "mention", "mention"]);
  });

  it("a writer People does not name, a named reader and a review with no words are no events there", () => {
    const anton = [...onIssue("p4", "anton"), ...onPull("p5", "anton")];
    expect(githubEvents(seen, anton, named).events).toEqual([]);
    const reader = [...onIssue("p6", "reader"), ...onPull("p7", "reader")];
    expect(githubEvents(seen, reader, named).events).toEqual([]);
    const silent = onPull("p8", "henry", "  ").slice(1);
    expect(githubEvents(seen, silent, named).events).toEqual([]);
    // Without `people`, henry's comments there are no events either.
    expect(
      githubEvents(seen, [...onIssue("p9", "henry"), ...onPull("p10", "henry")], context).events,
    ).toEqual([]);
  });

  // plans/catch-up-read-misses-no-comment.md, parts 1 and 2: what was seen is kept by GitHub's id
  // of each comment and review, so a comment the webhook missed is found by a read whatever was
  // heard on its thread since.
  it("itemsOfDelivery gives a comment, a review and an inline comment GitHub's id of it", () => {
    const comment = itemsOfDelivery(
      "issue_comment",
      { action: "created", issue: { number: 30 }, comment: { node_id: "IC_a", body: "b" } },
      "i1",
    );
    const review = itemsOfDelivery(
      "pull_request_review",
      { action: "submitted", pull_request: theirPull, review: { node_id: "PRR_a", body: "b" } },
      "i2",
    );
    const inline = itemsOfDelivery(
      "pull_request_review_comment",
      { action: "created", pull_request: theirPull, comment: { node_id: "PRRC_a", body: "b" } },
      "i3",
    );
    expect([comment, review, inline].map((one) => one[0].id)).toEqual(["IC_a", "PRR_a", "PRRC_a"]);
  });

  // A read's item: no deliveryId, GitHub's id in `id`.
  const readItem = (id: string, kind: string, number: number, login: string, minute: number) => ({
    number,
    title: "Loose",
    labels: [],
    url: `u${number}`,
    pull: number === 50,
    kind,
    id,
    author: login,
    at: at(minute),
    text: "Could the list sort by date?",
  });
  const heard = (delivery: string, id: string, number: number, login: string, minute: number) =>
    itemsOfDelivery(
      "issue_comment",
      {
        action: "created",
        issue: {
          number,
          title: "Loose",
          labels: [],
          ...(number === 50 ? { pull_request: {} } : {}),
        },
        comment: { node_id: id, body: "Thanks.", user: user(login), created_at: at(minute) },
      },
      delivery,
    );

  it("githubEvents sees an item once by its id, whatever was heard on its thread since", () => {
    // The webhook missed henry's comment on #30 and his review on #50, then heard anton on both.
    const later = githubEvents(
      seen,
      [...heard("h1", "IC_b", 30, "anton", 10), ...heard("h2", "IC_c", 50, "anton", 10)],
      named,
    );
    expect(later.events).toEqual([]);
    const read = [
      readItem("IC_a", "comment", 30, "henry", 9),
      readItem("PRR_a", "review", 50, "henry", 9),
      readItem("IC_b", "comment", 30, "anton", 10),
      readItem("IC_c", "comment", 50, "anton", 10),
    ];
    const caught = githubEvents(later.seen, read, named);
    expect(caught.events.map((one) => [one.kind, one.number, one.by])).toEqual([
      ["comment", 30, "henry"],
      ["review", 50, "henry"],
    ]);
    expect(caught.seen.items).toEqual(["IC_b", "IC_c", "IC_a", "PRR_a"]);
    // A delivery of what the read told is no second note.
    expect(githubEvents(caught.seen, heard("h3", "IC_a", 30, "henry", 9), named).events).toEqual(
      [],
    );
    // A second pass over the same items makes none.
    expect(githubEvents(caught.seen, read, named).events).toEqual([]);
  });

  it("an issue's opening is seen once by its number, a delivery's or a read's", () => {
    const issue = { number: 31, title: "New", labels: [], created_at: at(8), updated_at: at(8) };
    const delivered = itemsOfDelivery(
      "issues",
      { action: "opened", issue: { ...issue, user: user("henry") } },
      "n1",
    );
    const read = { ...delivered[0], deliveryId: "" };
    const first = githubEvents(seen, delivered, context);
    expect(first.events.map((one) => [one.kind, one.number])).toEqual([["issue", 31]]);
    expect(first.seen.items).toEqual(["opened:31"]);
    expect(githubEvents(first.seen, [read], context).events).toEqual([]);
    // The other way round: the read first, then the delivery.
    const readFirst = githubEvents(seen, [read], context);
    expect(readFirst.events).toHaveLength(1);
    expect(githubEvents(readFirst.seen, delivered, context).events).toEqual([]);
  });

  it("a time per thread from an older seen file still hides what was told before ids were kept", () => {
    const older = { ...seen, issues: { 30: at(11) } };
    expect(
      githubEvents(older, [readItem("IC_d", "comment", 30, "henry", 9)], named).events,
    ).toEqual([]);
    const newer = githubEvents(older, [readItem("IC_e", "comment", 30, "henry", 12)], named);
    expect(newer.events.map((one) => [one.kind, one.number, one.by])).toEqual([
      ["comment", 30, "henry"],
    ]);
    // The old time rides along unchanged until a read whose line moved drops it.
    expect(newer.seen.issues).toEqual({ 30: at(11) });
  });

  // plans/catch-up-read-complete.md, part 1: an item whose author's permission could not be read
  // is not judged, so the next read judges it.
  it("githubEvents leaves an item whose author's permission is unknown unseen, and names the author", () => {
    const unknown = { ...seen, permissions: { anton: "write" } };
    const left = githubEvents(unknown, heard("u1", "IC_u", 30, "henry", 9), named);
    expect(left.events).toEqual([]);
    expect(left.seen.items).not.toContain("IC_u");
    expect(left.seen.deliveries).not.toContain("u1");
    expect(left.unjudged).toEqual(["henry"]);
    // A second item of the same author names them once.
    const twice = githubEvents(
      unknown,
      [readItem("IC_v", "comment", 30, "henry", 9), readItem("IC_w", "comment", 30, "henry", 10)],
      named,
    );
    expect(twice.unjudged).toEqual(["henry"]);
    // Once known, the same delivery is judged and told.
    const known = githubEvents(
      { ...left.seen, permissions: { ...left.seen.permissions, henry: "write" } },
      heard("u1", "IC_u", 30, "henry", 9),
      named,
    );
    expect(known.events.map((one) => [one.kind, one.number, one.by])).toEqual([
      ["comment", 30, "henry"],
    ]);
    // A bot is no person: seen, and named nowhere.
    const bot = githubEvents(unknown, heard("u2", "IC_x", 30, "github-actions[bot]", 9), named);
    expect(bot.events).toEqual([]);
    expect(bot.seen.items).toEqual(["IC_x"]);
    expect(bot.seen.deliveries).toEqual(["u2"]);
    expect(bot.unjudged).toEqual([]);
  });

  // plans/catch-up-read-complete.md, part 3: a label is told again when put on after it was last
  // told, so the seen file keeps when.
  it("githubEvents keeps when a label was told", () => {
    const label = (delivery: string, minute: number) =>
      itemsOfDelivery(
        "issues",
        {
          action: "labeled",
          label: { name: "status: ready" },
          issue: {
            number: 12,
            title: "Series",
            labels: [{ name: "status: ready" }],
            updated_at: at(minute),
          },
          sender: user("anton"),
        },
        delivery,
      );
    const first = githubEvents(seen, label("r1", 5), context);
    expect(first.events.map((one) => one.kind)).toEqual(["ready"]);
    expect(first.seen.labeled).toEqual(["12:status: ready"]);
    expect(first.seen.labeledAt).toEqual({ "12:status: ready": at(5) });
    // Put back later: told again, and the time moves.
    const again = githubEvents(first.seen, label("r2", 9), context);
    expect(again.events.map((one) => one.kind)).toEqual(["ready"]);
    expect(again.seen.labeledAt).toEqual({ "12:status: ready": at(9) });
    // One putting on, brought again by a read or a delivery, is told once, and an older time
    // never moves the kept one back (/code-review).
    const older = githubEvents(again.seen, label("r3", 7), context);
    expect(older.events).toEqual([]);
    expect(older.seen.labeledAt).toEqual({ "12:status: ready": at(9) });
    expect(githubEvents(again.seen, label("r4", 9), context).events).toEqual([]);
  });

  it("notesWaiting lists the notes with an event after their last Handled line, oldest first", () => {
    const dir = mkdtempSync(join(tmpdir(), "notes-"));
    writeFileSync(
      join(dir, "12.md"),
      "# GitHub #12: S\n\nmention, 3 November 2026 21:02, by henry (write): u\n",
    );
    writeFileSync(
      join(dir, "13.md"),
      "# GitHub #13: S\n\ncomment, 3 November 2026 21:02, by henry (write): u\n\n## Handled, 3 November 2026, session x\n",
    );
    expect(notesWaiting(dir)).toEqual(["plans/github/12.md"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("noteFor writes the note's heading once, then the event and its text indented", () => {
    const { events } = githubEvents(seen, [items[1]], context);
    const note = noteFor(events[0], { first: true });
    expect(note).toMatch(
      /^# GitHub #12: Series\n\nmention, 3 November 2026 \d\d:02, by henry \(write\): c2\n {4}@docs-claude can this also keep the order on the phone\?\n\n$/,
    );
    expect(noteFor(events[0])).not.toContain("# GitHub");
  });

  // plans/github-note-crlf.md: a comment written with CRLF line endings is noted line by line.
  it("a CRLF comment's note keeps no carriage return", () => {
    const [, event, payload] = deliveries[1] as [string, string, { comment: object }];
    const crlf = { ...payload, comment: { ...payload.comment, body: "first\r\nsecond" } };
    const { events } = githubEvents(seen, itemsOfDelivery(event, crlf, "d2"), context);
    const note = noteFor(events[0]);
    expect(note).toContain("\n    first\n    second\n");
    expect(note).not.toContain("\r");
  });

  // plans/merged-pr-refreshes-the-rest.md, parts 1 to 3: a merge is one event, noted with what it
  // leaves behind, and a delivery the queue takes nothing from is not kept.
  describe("a merge", () => {
    const merged = JSON.parse(
      readFileSync(new URL("./pull-request-merged.json", import.meta.url), "utf8"),
    );
    const mergedItem = () => itemsOfDelivery("pull_request", merged, "m1");

    it("itemsOfDelivery gives one closed item, merged, with its base and head", () => {
      const items = mergedItem();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "closed",
        merged: true,
        number: 41,
        base: "test",
        head: "series-order",
        author: "javi",
      });
    });

    it("githubEvents makes one merged event, told once, issues on or off, whoever merged", () => {
      const fresh = { deliveries: [], issues: {}, pulls: {}, permissions: {}, readAt: "" };
      const on = githubEvents(fresh, mergedItem(), { own: [], carried: [12] });
      expect(on.events).toHaveLength(1);
      expect(on.events[0]).toMatchObject({
        kind: "merged",
        number: 41,
        issues: [12],
        base: "test",
        head: "series-order",
        by: "javi",
      });
      expect(on.seen.merges).toEqual([41]);
      const off = githubEvents(fresh, mergedItem(), { issuesOff: true });
      expect(off.events.map((one) => [one.kind, one.number, one.issues])).toEqual([
        ["merged", 41, []],
      ]);
      // The same merge twice, or by a delivery and then a read, is one event.
      expect(githubEvents(fresh, [...mergedItem(), ...mergedItem()], {}).events).toHaveLength(1);
      const read = { ...mergedItem()[0], deliveryId: "", at: "2026-11-15T10:27:00Z" };
      expect(githubEvents(on.seen, [read], {}).events).toEqual([]);
      expect(githubEvents(fresh, [read], {}).events).toHaveLength(1);
      // A comment seen after the merge does not hide a merge the webhook missed (Codex).
      const later = { ...fresh, pulls: { 41: "2026-11-15T11:00:00Z" } };
      expect(githubEvents(later, [read], {}).events.map((one) => one.kind)).toEqual(["merged"]);
    });

    it("behindOf sorts the queue's open pull requests into behind, stacked and another person's", () => {
      const event = { number: 41, base: "test", head: "series-order" };
      const pulls = [
        { number: 40, headRefName: "a", baseRefName: "test", author: { login: "javi" } },
        {
          number: 43,
          headRefName: "b",
          baseRefName: "test",
          author: { login: "app/docs-claude", is_bot: true },
        },
        { number: 44, headRefName: "c", baseRefName: "series-order", author: { login: "javi" } },
        { number: 38, headRefName: "d", baseRefName: "test", author: { login: "anton" } },
        { number: 50, headRefName: "e", baseRefName: "test", author: { login: "javi" } },
      ];
      const own = [40, "b", 44, 38];
      expect(behindOf(event, pulls, own, "javi")).toEqual({
        own: [
          { number: 40, head: "a", login: "javi" },
          { number: 43, head: "b", login: "app/docs-claude" },
        ],
        stacked: [{ number: 44, head: "c", login: "javi" }],
        theirs: [{ number: 38, head: "d", login: "anton" }],
      });
      // The token's login unread: every person's is left.
      expect(behindOf(event, pulls, own, "")).toEqual({
        own: [{ number: 43, head: "b", login: "app/docs-claude" }],
        stacked: [],
        theirs: [
          { number: 40, head: "a", login: "javi" },
          { number: 44, head: "c", login: "javi" },
          { number: 38, head: "d", login: "anton" },
        ],
      });
    });

    // plans/prs-close-their-issues.md, part 3: the merge closes every issue the description closes.
    it("closesOf reads every Closes line and an older For line", () => {
      expect(
        closesOf(
          "Closes #161.\nCloses #163\nFor #160.\nCloses #161.\nRelated: #162.\nCloses #9. in a line\n\n## Changes\n",
        ),
      ).toEqual([161, 163, 160]);
      expect(closesOf("For #12.\n\n## Changes\n")).toEqual([12]);
      // Only the opening block, where the template puts them, and never inside a fence (Codex C2).
      expect(
        closesOf(
          "```\nCloses #88.\n```\nCloses #4.\n\n## To try it\n\n```\nCloses #89.\n```\nCloses #90.\n",
        ),
      ).toEqual([4]);
      expect(closesOf("Related: #162.\n")).toEqual([]);
      expect(closesOf("")).toEqual([]);
      expect(closesOf()).toEqual([]);
    });

    // plans/closes-skips-comments-and-crlf.md: nothing in an HTML comment is read, a `## ` in it
    // included, and CRLF line endings read as LF.
    it("closesOf reads no line inside an HTML comment and reads CRLF lines", () => {
      expect(closesOf("<!-- Closes #160. -->\nCloses #161.\n\n## Changes")).toEqual([161]);
      expect(closesOf("<!--\nCloses #160.\n## x\n-->\nCloses #161.\n## Changes")).toEqual([161]);
      expect(closesOf("Closes #161.\r\nCloses #163.\r\n\r\n## Changes\r\n")).toEqual([161, 163]);
      expect(
        closesOf("Closes #5. <!-- the login bug -->\n<!-- x --> <!-- y\nCloses #6.\n-->\n"),
      ).toEqual([5]);
      // A `<!--` in a code span, in indented code or on a fence's line opens no comment, and an
      // empty comment closes at once (Codex C1 and C2, /code-review).
      expect(
        closesOf("Use `<!--` to open a comment.\n\n## Changes\n\nUse `-->`.\n\nCloses #42."),
      ).toEqual([]);
      expect(closesOf("Closes #5.\nThe marker `<!--` hides text.\nCloses #6.\n")).toEqual([5, 6]);
      expect(closesOf("~~~ example <!--\nCloses #91.\n~~~\nCloses #42.\n## Changes")).toEqual([42]);
      expect(closesOf("<!-- x -->```\nCloses #9.\n")).toEqual([9]);
      expect(closesOf("<!---->\n<!--->\n<!-->\nCloses #8.\n")).toEqual([8]);
      expect(closesOf("    <!-- x\nCloses #3.\n-->\n")).toEqual([3]);
      expect(closesOf("Closes #5.\rCloses #7.\r")).toEqual([5, 7]);
    });

    // plans/closes-reads-comments-as-github.md: each answer is what GitHub's renderer shows.
    it("closesOf reads a comment and a fence as GitHub's page shows them", () => {
      const cases: [string, number[]][] = [
        // A sentence that mentions `<!--` hides nothing below it.
        ["The template uses <!-- for notes.\n\nCloses #6.", [6]],
        ["Fixes it <!-- see\n## Changes\n-->\nCloses #8.", []],
        ["Some paragraph\n    <!-- x\nCloses #3.\n-->\n", []],
        ["- item\n\n    <!-- x\nCloses #3.\n-->\n", []],
        ["- item\n\n    <!-- x\n    Closes #3.\n    -->\nCloses #4.", [4]],
        ["<!-- x -->## Changes\nCloses #4.", [4]],
        ["> text <!-- a\n\nCloses #5.", [5]],
        ["> <!-- a\n\nCloses #5.", []],
        ["```js\ncode\n```js\nCloses #9.\n```\nCloses #5.", [5]],
        ["Fixes it <!-- see\nCloses #7.\n-->\nCloses #8.", [8]],
        ["Fixes it <!-- see\n\nCloses #7.\n\n-->\n\nCloses #8.", [7, 8]],
        ["a <!-- b --> c <!-- d\nCloses #5.\n\nCloses #6.", [5, 6]],
        ["text <!-- a\n```\n-->\n```\nCloses #2.", [2]],
        ["```a`b\nCloses #1.\n```\nCloses #2.\n```\nCloses #3.", [1, 3]],
        ["<!-- which issue -->Closes #5.\n<!-- and --> Closes #6.", [5, 6]],
        ["text <!-- ` --> b ` c\nCloses #5.\n` Closes", []],
        ["Closes #1.\n   ## Changes\nCloses #5.", [1]],
        ["Clo<!-- a\nb -->ses #5.\nCloses #6.", [5, 6]],
        ["Closes #5. <!--->\nCloses #6. <!-->\ntext <!---> <!-- a\n\nCloses #7.", [5, 6, 7]],
        // Codex C1 to C6 and /code-review, each checked on GitHub's renderer: what ends a
        // paragraph, a quote's paragraph, a fence a container holds, and backslash escapes.
        ["Notes <!--\n2. Example\nCloses #5.\n-->\nCloses #6.", [6]],
        ["Notes <!--\n01. x\nCloses #5.\n-->", [5]],
        ["> Notes <!--\nCloses #5.\n> -->\nCloses #6.", [6]],
        ["Notes <!--\n\u00a0\nCloses #5.\n-->\nCloses #6.", [6]],
        ["Notes <!--\n***\nCloses #5.\n-->", [5]],
        ["Note <!-- x\n<details>\nCloses #5.\n-->", [5]],
        ["10. Example\n    ```\n    <!--\n    ```\n\nCloses #5.", [5]],
        ["- item\n\n    ```\n    <!-- x\n    ```\n\nCloses #5.", [5]],
        ["- ```\n  <!-- x\n- b\n\nCloses #5.", [5]],
        ["> ```\n> <!-- x\n> ```\n\nCloses #5.", [5]],
        ["> ```\n> <!-- x\n\nCloses #5.", [5]],
        ["Notes \\`\nCloses #5.\nend `", [5]],
        ["Notes \\<!--\nCloses #5.\n-->", [5]],
        ["Notes \\\\`a <!-- b` -->\nCloses #5.", [5]],
      ];
      for (const [text, closes] of cases) expect(closesOf(text), text).toEqual(closes);
    });

    // Each is a limit decisions.md#closes-its-issues names, with what GitHub's page shows in the
    // comment: a change that mends one updates the entry and this test together.
    it("closesOf's known limits read as decisions.md#closes-its-issues says", () => {
      const cases: [string, number[]][] = [
        // A second `<!--` after a comment's close on its line: GitHub hides the rest.
        ["<!-- x --> <!-- y\nCloses #6.\n-->\nCloses #7.", [7]],
        // A comment that outlasts its list item: GitHub hides the rest.
        ["1. item\n\n    <!-- x\nCloses #3.\n-->\nCloses #4.", [4]],
        // A `<!--` inside `<details>`, first on its line: GitHub hides the rest.
        ["<details>\n<!-- x\n</details>\n\nCloses #5.\n-->\nCloses #6.", [6]],
        // A `<!--` further along a line of an HTML block: GitHub hides the rest.
        ["<details><summary>s</summary> <!-- a\n</details>\n\nCloses #5.", [5]],
        // Code indented inside a list item, read as the item's text: GitHub shows #5.
        ["- item\n\n      <!-- x\n\nCloses #5.", []],
      ];
      for (const [text, closes] of cases) expect(closesOf(text), text).toEqual(closes);
    });

    it("githubEvents gives a merge no issues with issues off", () => {
      const body = { ...merged.pull_request, body: "Closes #12.\nCloses #13.\n" };
      const items = itemsOfDelivery("pull_request", { ...merged, pull_request: body }, "m2");
      expect(githubEvents({}, items, { issuesOff: true }).events[0].issues).toEqual([]);
      expect(githubEvents({}, items, { own: ["series-order"] }).events[0].issues).toEqual([12, 13]);
      // Another person's pull request closes the same way (checked with the planner).
      expect(githubEvents({}, items, { own: [40] }).events[0].issues).toEqual([12, 13]);
    });

    // plans/prs-close-their-issues.md, part 4.
    it("plans says issues are off when a plan carries an Issue line and the project file has no Issues heading", () => {
      const listOf = (dir: string) =>
        execFileSync(
          "node",
          [
            "--input-type=module",
            "-e",
            `import { list } from ${JSON.stringify(join(here, "plan-queue.mjs"))};
             console.log(list({ live: [] }));`,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              CLAUDE_PROJECT_DIR: dir,
              WORKFLOW_ROOT: dir,
              WORKFLOW_STARTS_LOG: join(dir, ".claude", "starts.log"),
              WORKFLOW_WEBHOOK_SECRET: "",
              WORKFLOW_SECRETS_FILE: "",
            },
          },
        );
      const carrying = (n: number) =>
        `${header("26 November 2026")}Issue: #${n}.\n\n## What was asked\n`;
      const off = fixture("Off", "land: pull-request\n", "\n# Off\n");
      const on = fixture("On", "land: pull-request\n", "\n# On\n\n## Issues\n\nTopics.\n");
      try {
        writeFileSync(join(off, "plans", "a.md"), carrying(1));
        expect(listOf(off)).toContain(
          "Issues are off here: .claude/workflow.md has no Issues heading, but 1 plan carries an Issue line (plans/a.md). No comment on their issues reaches the queue and no merge closes one; /workflow:setup turns issues on.",
        );
        for (const [name, n] of [
          ["b", 2],
          ["c", 3],
          ["d", 4],
        ] as const)
          writeFileSync(join(off, "plans", `${name}.md`), carrying(n));
        writeFileSync(
          join(off, "plans", "e.md"),
          `${carrying(5)}\n## Built, 26 November 2026\n\nPushed.\n`,
        );
        writeFileSync(join(off, "plans", "f.md"), `${carrying(6)}\n## Dropped\n\nNot needed.\n`);
        expect(listOf(off)).toMatch(
          /Issues are off here: \.claude\/workflow\.md has no Issues heading, but 4 plans carry an Issue line \((plans\/[a-d]\.md, ){3}and 1 more\)\./,
        );
        writeFileSync(join(on, "plans", "a.md"), carrying(1));
        expect(listOf(on)).not.toContain("Issues are off here");
      } finally {
        rmSync(off, { recursive: true, force: true });
        rmSync(on, { recursive: true, force: true });
      }
    });

    it("noteFor writes the merged line and what it left behind, and notesWaiting lists it", () => {
      const [event] = githubEvents({}, mergedItem(), { issuesOff: true }).events;
      const note = noteFor(
        {
          ...event,
          behind: {
            own: [
              { number: 40, head: "series-order", login: "javi" },
              { number: 43, head: "search-shortcut", login: "javi" },
            ],
            stacked: [{ number: 44, head: "series-order-phone", login: "javi" }],
            theirs: [{ number: 38, head: "block-commands", login: "anton" }],
          },
        },
        { first: true },
      );
      expect(note).toMatch(
        /^# GitHub #41: Series keep their order on the phone\n\nmerged, 15 November 2026 \d\d:26, into test by javi: https:\/\/github\.com\/o\/r\/pull\/41\n {4}behind: #40 series-order, #43 search-shortcut\n {4}stacked on it: #44 series-order-phone\n {4}another person's, left: #38 block-commands \(anton\)\n\n$/,
      );
      expect(noteFor({ ...event, behind: { unread: true } })).toMatch(
        /^merged, .*\n {4}behind: not read\n\n$/,
      );
      const dir = mkdtempSync(join(tmpdir(), "notes-merged-"));
      writeFileSync(join(dir, "41.md"), note);
      expect(notesWaiting(dir)).toEqual(["plans/github/41.md"]);
      rmSync(dir, { recursive: true, force: true });
    });

    // plans/merge-close-retried.md, part 2.
    it("noteFor writes an issue a merge did not close", () => {
      const [event] = githubEvents({}, mergedItem(), { issuesOff: true }).events;
      const unclosed = { ...event, kind: "unclosed", issue: 13, why: "HTTP 502: Bad Gateway" };
      expect(noteFor(unclosed, { first: true })).toMatch(
        /^# GitHub #41: Series keep their order on the phone\n\nunclosed, 15 November 2026 \d\d:26, issue #13: https:\/\/github\.com\/o\/r\/pull\/41\n {4}HTTP 502: Bad Gateway\n\n$/,
      );
      expect(noteFor(unclosed)).toMatch(
        /^unclosed, 15 November 2026 \d\d:26, issue #13: https:\/\/github\.com\/o\/r\/pull\/41\n {4}HTTP 502: Bad Gateway\n\n$/,
      );
      const dir = mkdtempSync(join(tmpdir(), "notes-unclosed-"));
      writeFileSync(join(dir, "41.md"), noteFor(unclosed, { first: true }));
      expect(notesWaiting(dir)).toEqual(["plans/github/41.md"]);
      rmSync(dir, { recursive: true, force: true });
    });

    it("keeps only a delivery the queue takes something from", () => {
      const body = JSON.stringify(merged);
      expect(keeps("pull_request", body)).toBe(true);
      expect(keeps("workflow_job", JSON.stringify({ action: "completed", workflow_job: {} }))).toBe(
        false,
      );
      expect(
        keeps("workflow_run", JSON.stringify({ action: "requested", workflow_run: { id: 1 } })),
      ).toBe(false);
      expect(keeps("pull_request", JSON.stringify({ ...merged, action: "synchronize" }))).toBe(
        false,
      );
      expect(keeps("pull_request", "{not json")).toBe(false);
      expect(keeps("pull_request", "null")).toBe(false);
    });

    it("the listener answers a delivery it keeps nothing of, and runs nothing for it", async () => {
      const port = await new Promise<number>((done) => {
        const probe = createServer();
        probe.listen(0, "127.0.0.1", () => {
          const { port } = probe.address() as { port: number };
          probe.close(() => done(port));
        });
      });
      const kept: string[] = [];
      let heard = 0;
      let after = 0;
      const server = listen({
        port,
        secret: "s3cret",
        keep: (id: string) => kept.push(id),
        heard: () => heard++,
        after: () => after++,
      });
      try {
        await new Promise((done) => setTimeout(done, 100));
        const post = (event: string, body: string, id: string) =>
          fetch(`http://127.0.0.1:${port}/`, {
            method: "POST",
            body,
            headers: {
              "X-Hub-Signature-256": sign("s3cret", body),
              "X-GitHub-Event": event,
              "X-GitHub-Delivery": id,
            },
          });
        const job = JSON.stringify({ action: "completed", workflow_job: { id: 1 } });
        expect((await post("workflow_job", job, "j1")).status).toBe(202);
        await new Promise((done) => setTimeout(done, 50));
        expect(kept).toEqual([]);
        expect(after).toBe(0);
        expect(heard).toBe(1);
        expect((await post("pull_request", JSON.stringify(merged), "m1")).status).toBe(202);
        await new Promise((done) => setTimeout(done, 50));
        expect(kept).toEqual(["m1"]);
        expect(after).toBe(1);
        expect(heard).toBe(2);
      } finally {
        await new Promise((done) => server.close(done));
      }
    });

    describe("in a project", () => {
      let stub: string;
      const project = (issues: boolean) => {
        const dir = fixture(
          "Runs",
          "land: pull-request\n",
          `\n# Runs\n${issues ? "\n## Issues\n\nTopics here are GitHub issues.\n" : ""}`,
        );
        // The app's close needs the repository; a start with no origin fetches nothing.
        if (issues) g(dir, "remote", "add", "origin", "https://github.com/o/r.git");
        mkdirSync(join(dir, ".claude", "github-inbox"), { recursive: true });
        for (const [name, number, branch] of [
          ["search-shortcut", 43, "search-shortcut"],
          ["series-order-phone", 44, "series-order-phone"],
        ] as const)
          writeFileSync(
            join(dir, "plans", `${name}.md`),
            `# ${name}\n\nPlan only, 14 November 2026, for Javi.\n\n## Built, 14 November 2026\n\nPull request #${number} (https://github.com/o/r/pull/${number}) to test from branch ${branch}, commit 4f1c2b9a; draft.\n`,
          );
        return dir;
      };
      const run = (dir: string, args: string[], extra: Record<string, string> = {}) =>
        spawnSync("node", [join(here, "plan-queue.mjs"), ...args], {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH || "",
            WORKFLOW_ROOT: dir,
            CLAUDE_PROJECT_DIR: dir,
            WORKFLOW_GH: join(stub, "gh"),
            WORKFLOW_CLAUDE: join(stub, "claude"),
            STUB_ROWS: join(stub, "rows.json"),
            STUB_ASKED: join(dir, "asked.log"),
            WORKFLOW_STARTS_LOG: join(stub, "starts.log"),
            WORKFLOW_USAGE_FILE: join(stub, "usage.json"),
            WORKFLOW_WEBHOOK_SECRET: "",
            WORKFLOW_SECRETS_FILE: "",
            WORKFLOW_APP_ID: "",
            WORKFLOW_APP_KEY: "",
            CLAUDE_PLUGIN_OPTION_OWNER: "Javi",
            CLAUDE_PLUGIN_OPTION_MACHINE: "lab",
            ...extra,
          },
        }).stdout;
      const deliver = (dir: string, id: string, body: object) =>
        writeFileSync(
          join(dir, ".claude", "github-inbox", `${id}.json`),
          JSON.stringify({ id, event: "pull_request", body: JSON.stringify(body) }),
        );
      beforeAll(() => {
        stub = mkdtempSync(join(tmpdir(), "merged-stub-"));
        fakeClaude(stub);
        writeFileSync(
          join(stub, "gh"),
          `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_ASKED, args.join(" ") + "\\n");
const say = (value) => process.stdout.write(JSON.stringify(value));
if (args[0] === "pr" && args.includes("merged"))
  say(process.env.STUB_MERGED ? JSON.parse(process.env.STUB_MERGED) : []);
else if (args[0] === "pr" && args.includes("open") && !args.join(" ").includes("baseRefName,author")) say([]);
else if (args[0] === "pr" && args.includes("open"))
  say([
    { number: 43, headRefName: "search-shortcut", baseRefName: "test", author: { login: "javi" } },
    { number: 44, headRefName: "series-order-phone", baseRefName: "series-order", author: { login: "javi" } },
    { number: 38, headRefName: "block-commands", baseRefName: "test", author: { login: "anton" } },
  ]);
else if (args[0] === "api" && args[1] === "user") {
  if (process.env.STUB_NO_LOGIN) process.exit(1);
  process.stdout.write("javi\\n");
}
else if (args[0] === "api" && /collaborators/.test(args[1])) process.stdout.write("write");
else if (args[0] === "api" && /\\/issues\\/\\d+$/.test(args[1]))
  process.stdout.write(
    String((process.env.STUB_PULLS || "").split(",").includes(args[1].split("/").pop())) + "\\n",
  );
else if (args[0] === "issue" && args[1] === "close" && args[2] === process.env.STUB_NOT_CLOSED) {
  process.stderr.write("GraphQL: Resource not accessible by integration (closeIssue)\\n");
  process.exit(1);
}
else say([]);
`,
        );
        chmodSync(join(stub, "claude"), 0o755);
        chmodSync(join(stub, "gh"), 0o755);
      });
      afterAll(() => rmSync(stub, { recursive: true, force: true }));

      it(
        "notes a merge with what it left behind and starts the assistant",
        { timeout: 30_000 },
        () => {
          const dir = project(false);
          try {
            deliver(dir, "m1", merged);
            const said = run(dir, ["github", "--inbox"]);
            expect(said).toMatch(
              /^GitHub: #41 merged into test, noted: 2 behind; assistant started\. /,
            );
            expect(readFileSync(join(dir, "plans", "github", "41.md"), "utf8")).toMatch(
              /\nmerged, 15 November 2026 \d\d:26, into test by javi: https:\/\/github\.com\/o\/r\/pull\/41\n {4}behind: #43 search-shortcut\n {4}stacked on it: #44 series-order-phone\n\n$/,
            );
            // With issues off a waiting note is still listed.
            writeFileSync(join(stub, "rows.json"), "[]");
            expect(run(dir, ["list"], { WORKFLOW_LIVE: "[]" })).toContain(
              "From GitHub, not handled\n  plans/github/41.md",
            );
            // A merge into a branch none of the queue's own is on: one line, no note.
            deliver(dir, "m2", {
              ...merged,
              pull_request: {
                ...merged.pull_request,
                number: 45,
                base: { ref: "main" },
                head: { ref: "other" },
              },
            });
            expect(run(dir, ["github", "--inbox"]).trim()).toBe(
              "GitHub: #45 merged into main: none of the queue's own is behind.",
            );
            expect(existsSync(join(dir, "plans", "github", "45.md"))).toBe(false);
            // The project's branch merged into another (a release): nothing is stacked on it.
            deliver(dir, "m3", {
              ...merged,
              pull_request: {
                ...merged.pull_request,
                number: 47,
                base: { ref: "main" },
                head: { ref: "test" },
              },
            });
            expect(run(dir, ["github", "--inbox"]).trim()).toBe(
              "GitHub: #47 merged into main: none of the queue's own is behind.",
            );
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      );

      // Codex: a login not read leaves no person's pull request out; the merge is noted unread.
      it(
        "notes a merge as not read when the token's login cannot be read",
        { timeout: 30_000 },
        () => {
          const dir = project(false);
          try {
            deliver(dir, "m1", merged);
            expect(run(dir, ["github", "--inbox"], { STUB_NO_LOGIN: "1" })).toMatch(
              /^GitHub: #41 merged into test, noted: behind not read[.;]/,
            );
            expect(readFileSync(join(dir, "plans", "github", "41.md"), "utf8")).toMatch(
              /\n {4}behind: not read\n\n$/,
            );
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      );

      it(
        "plans github reads the merges since its last read, none on a first read",
        { timeout: 30_000 },
        () => {
          const dir = project(false);
          try {
            const STUB_MERGED = JSON.stringify([
              {
                number: 46,
                title: "Other",
                url: "https://github.com/o/r/pull/46",
                body: "",
                mergedAt: new Date(Date.now() - 60_000).toISOString(),
                mergedBy: { login: "javi" },
                headRefName: "other",
                baseRefName: "main",
              },
            ]);
            expect(run(dir, ["github"], { STUB_MERGED })).not.toContain("#46");
            const seenFile = join(dir, ".claude", "github-seen.json");
            const seen = JSON.parse(readFileSync(seenFile, "utf8"));
            writeFileSync(
              seenFile,
              JSON.stringify({ ...seen, readAt: new Date(Date.now() - 3_600_000).toISOString() }),
            );
            expect(run(dir, ["github"], { STUB_MERGED })).toContain(
              "GitHub: #46 merged into main: none of the queue's own is behind.",
            );
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      );

      it(
        "with issues on, a merge whose body names an issue still closes it",
        { timeout: 30_000 },
        () => {
          const dir = project(true);
          try {
            writeFileSync(
              join(dir, ".claude", "app-token.json"),
              JSON.stringify({
                token: "app-tok",
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                repo: "o/r",
                app: "12",
              }),
            );
            deliver(dir, "m1", merged);
            const said = run(dir, ["github", "--inbox"], {
              WORKFLOW_APP_ID: "12",
              WORKFLOW_APP_KEY: "key",
            });
            expect(said).toContain("GitHub: #12 closed, merged as #41.");
            expect(said).toContain("GitHub: #41 merged into test, noted: 2 behind");
            expect(readFileSync(join(dir, "asked.log"), "utf8")).toContain(
              "issue close 12 --reason completed --comment Merged as #41.",
            );
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      );

      // plans/prs-close-their-issues.md, part 3.
      it(
        "a merged pull request closes every issue its description closes, and none it names as related",
        { timeout: 30_000 },
        () => {
          const dir = project(true);
          try {
            writeFileSync(
              join(dir, ".claude", "app-token.json"),
              JSON.stringify({
                token: "app-tok",
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                repo: "o/r",
                app: "12",
              }),
            );
            deliver(dir, "m1", {
              ...merged,
              pull_request: {
                ...merged.pull_request,
                body: "Closes #12.\nCloses #13.\nRelated: #14.\n\n## Changes\n",
              },
            });
            const said = run(dir, ["github", "--inbox"], {
              WORKFLOW_APP_ID: "12",
              WORKFLOW_APP_KEY: "key",
            });
            expect(said).toContain("GitHub: #12 closed, merged as #41.");
            expect(said).toContain("GitHub: #13 closed, merged as #41.");
            const asked = readFileSync(join(dir, "asked.log"), "utf8");
            expect(asked).toContain("issue close 12 --reason completed --comment Merged as #41.");
            expect(asked).toContain("issue close 13 --reason completed --comment Merged as #41.");
            expect(asked).not.toContain("issue close 14");
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      );

      // plans/merge-close-retried.md, part 2: a failed close is a note for the assistant.
      const closesTwo = {
        ...merged,
        pull_request: { ...merged.pull_request, body: "Closes #12.\nCloses #13.\n\n## Changes\n" },
      };
      const appToken = (dir: string) =>
        writeFileSync(
          join(dir, ".claude", "app-token.json"),
          JSON.stringify({
            token: "app-tok",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            repo: "o/r",
            app: "12",
          }),
        );
      it(
        "a merged pull request whose close of one issue fails closes the other at once and notes the failed one for the assistant",
        { timeout: 60_000 },
        () => {
          const dir = project(true);
          try {
            appToken(dir);
            const app = { WORKFLOW_APP_ID: "12", WORKFLOW_APP_KEY: "key", STUB_NOT_CLOSED: "13" };
            deliver(dir, "m1", closesTwo);
            const said = run(dir, ["github", "--inbox"], app);
            expect(said).toContain("GitHub: #12 closed, merged as #41.");
            expect(said).toMatch(
              /^GitHub: #13 was not closed, merged as #41, noted: GraphQL: Resource not accessible by integration \(closeIssue\)/m,
            );
            const file = join(dir, "plans", "github", "41.md");
            expect(readFileSync(file, "utf8")).toMatch(
              /^# GitHub #41: .*\n\nunclosed, 15 November 2026 \d\d:26, issue #13: https:\/\/github\.com\/o\/r\/pull\/41\n {4}GraphQL: Resource not accessible by integration \(closeIssue\)\n\nmerged, /,
            );
            writeFileSync(join(stub, "rows.json"), "[]");
            expect(run(dir, ["list"], { WORKFLOW_LIVE: "[]" })).toContain(
              "From GitHub, not handled\n  plans/github/41.md",
            );
            // A redelivery of the merge, still failing: tried once, said once.
            deliver(dir, "m2", closesTwo);
            run(dir, ["github", "--inbox"], app);
            expect(readFileSync(file, "utf8").match(/^unclosed, /gm)).toHaveLength(1);
            const asked = readFileSync(join(dir, "asked.log"), "utf8");
            expect(asked.match(/^issue close 13 /gm)).toHaveLength(1);
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      );

      // plans/merge-closes-no-pull-request.md: a Closes line naming a pull request closes nothing.
      it(
        "a merge whose description closes a pull request's number closes nothing for it",
        { timeout: 60_000 },
        () => {
          const dir = project(true);
          try {
            appToken(dir);
            deliver(dir, "m1", closesTwo);
            const said = run(dir, ["github", "--inbox"], {
              WORKFLOW_APP_ID: "12",
              WORKFLOW_APP_KEY: "key",
              STUB_PULLS: "13",
            });
            expect(said).toContain("GitHub: #12 closed, merged as #41.");
            expect(
              said.match(/^GitHub: #13 is a pull request, so merging #41 left it open\.$/gm),
            ).toHaveLength(1);
            const asked = readFileSync(join(dir, "asked.log"), "utf8");
            expect(asked).toContain(
              "api repos/{owner}/{repo}/issues/13 --jq .pull_request != null",
            );
            expect(asked).toContain("issue close 12 --reason completed --comment Merged as #41.");
            expect(asked).not.toContain("issue close 13");
            expect(readFileSync(join(dir, "plans", "github", "41.md"), "utf8")).not.toContain(
              "unclosed, ",
            );
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      );

      it("the note of a close plans gh refused carries what it said", { timeout: 60_000 }, () => {
        const dir = project(true);
        try {
          // Into a branch none of the queue's own is on, so the failed closes
          // are the merge's only note and start the assistant themselves.
          deliver(dir, "m1", {
            ...closesTwo,
            pull_request: {
              ...closesTwo.pull_request,
              base: { ref: "main" },
              head: { ref: "other" },
            },
          });
          // Its own starts log: the case before started an assistant, whose quick end
          // in the shared log would hold this start back.
          const said = run(dir, ["github", "--inbox"], {
            WORKFLOW_STARTS_LOG: join(dir, "starts.log"),
          });
          const why = noAppWords("o/r", { WORKFLOW_SECRETS_FILE: "" }, "Runs").replace(/\.$/, "");
          expect(said).toContain(
            `GitHub: #12 was not closed, merged as #41, noted: ${why}; assistant started.`,
          );
          expect(said).toContain(`GitHub: #13 was not closed, merged as #41, noted: ${why}.`);
          expect(said).toContain(
            "GitHub: #41 merged into main: none of the queue's own is behind.",
          );
          const note = readFileSync(join(dir, "plans", "github", "41.md"), "utf8");
          expect(note).not.toContain("\nmerged, ");
          expect(note).toContain(`issue #12: https://github.com/o/r/pull/41\n    ${why}\n\n`);
          expect(note).toContain(`issue #13: https://github.com/o/r/pull/41\n    ${why}\n\n`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });
  });

  // plans/executor-never-watches-ci.md, part 1: a failed run on the queue's own pull request.
  describe("a failed run", () => {
    const recorded = JSON.parse(
      readFileSync(new URL("./workflow-run-failed.json", import.meta.url), "utf8"),
    );
    const delivery = (
      change: Record<string, unknown> = {},
      outer: Record<string, unknown> = {},
    ) => ({
      ...recorded,
      ...outer,
      workflow_run: { ...recorded.workflow_run, ...change },
    });

    it("itemsOfDelivery gives one failed item from a completed, failed run on a pull request", () => {
      expect(itemsOfDelivery("workflow_run", recorded, "w1")).toEqual([
        {
          deliveryId: "w1",
          kind: "failed",
          pull: true,
          number: 40,
          head: "series-order",
          title: "Series keep their order",
          labels: [],
          url: "https://github.com/o/r/actions/runs/19283746501",
          at: "2026-11-14T21:04:00Z",
          text: "",
          author: "docs-claude[bot]",
          workflow: "Checks",
          run: 19283746501,
          attempt: 1,
          sha: "4f1c2b9a",
        },
      ]);
      for (const conclusion of ["timed_out", "startup_failure"])
        expect(itemsOfDelivery("workflow_run", delivery({ conclusion }), "w")).toHaveLength(1);
    });

    // plans/failed-runs-the-webhook-misses.md, part 1: whatever set it off.
    it("itemsOfDelivery gives one failed item from a run a push set off", () => {
      const pushed = itemsOfDelivery("workflow_run", delivery({ event: "push" }), "w1");
      expect(pushed).toEqual(itemsOfDelivery("workflow_run", recorded, "w1"));
      expect(pushed).toHaveLength(1);
    });

    it("itemsOfDelivery gives none for a cancelled, waiting, stale or green run, or a fork's", () => {
      for (const conclusion of ["cancelled", "action_required", "stale", "success"])
        expect(itemsOfDelivery("workflow_run", delivery({ conclusion })), conclusion).toEqual([]);
      expect(
        itemsOfDelivery("workflow_run", delivery({ head_repository: { full_name: "someone/r" } })),
      ).toEqual([]);
      expect(itemsOfDelivery("workflow_run", { ...recorded, action: "requested" })).toEqual([]);
    });

    it("githubEvents makes a failed event on the queue's own pull request, whoever set it off", () => {
      const nobody = { ...seen, permissions: {} };
      const bot = itemsOfDelivery("workflow_run", recorded, "w1");
      const person = itemsOfDelivery(
        "workflow_run",
        delivery({
          id: 19283746502,
          triggering_actor: { login: "stranger" },
          actor: { login: "stranger" },
        }),
        "w2",
      );
      const { events } = githubEvents(nobody, [...bot, ...person], context);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        kind: "failed",
        number: 40,
        by: "Checks",
        at: "2026-11-14T21:04:00Z",
        text: "",
        url: "https://github.com/o/r/actions/runs/19283746501",
        title: "Series keep their order",
        run: 19283746501,
        sha: "4f1c2b9a",
      });
      // A run a push to the queue's own head branch set off is one failed event
      // (plans/failed-runs-the-webhook-misses.md, part 1); with no pull request named in it,
      // `act` fills the number from the head branch first.
      const pushed = itemsOfDelivery(
        "workflow_run",
        delivery({ id: 19283746503, event: "push" }),
        "w4",
      );
      const pushedEvents = githubEvents(nobody, pushed, context).events;
      expect(pushedEvents).toHaveLength(1);
      expect(pushedEvents[0]).toMatchObject({ kind: "failed", run: 19283746503 });
      // Another pull request's run is no event.
      const other = itemsOfDelivery(
        "workflow_run",
        delivery({
          head_branch: "someone-else",
          pull_requests: [{ number: 77, head: { ref: "someone-else" } }],
        }),
        "w3",
      );
      expect(githubEvents(nobody, other, context).events).toEqual([]);
      // The same delivery twice is one event.
      const twice = githubEvents(nobody, [...bot, ...bot], context);
      expect(twice.events).toHaveLength(1);
      expect(githubEvents(twice.seen, bot, context).events).toEqual([]);
    });

    it("noteFor writes the failed line, and notesWaiting lists a note that ends with one", () => {
      const [event] = githubEvents(
        seen,
        itemsOfDelivery("workflow_run", recorded, "w1"),
        context,
      ).events;
      expect(noteFor(event, { first: true })).toMatch(
        /^# GitHub #40: Series keep their order\n\nfailed, 14 November 2026 \d\d:04, Checks run 19283746501 on 4f1c2b9a: https:\/\/github\.com\/o\/r\/actions\/runs\/19283746501\n\n$/,
      );
      const dir = mkdtempSync(join(tmpdir(), "notes-"));
      writeFileSync(
        join(dir, "40.md"),
        `# GitHub #40: S\n\nreview, 3 November 2026 21:02, by anton (write): u\n\n## Handled, 3 November 2026, session x\n\n${noteFor(event)}`,
      );
      expect(notesWaiting(dir)).toEqual(["plans/github/40.md"]);
      rmSync(dir, { recursive: true, force: true });
    });

    // plans/failed-runs-the-webhook-misses.md, part 2: read by `gh run list`.
    it("failedRunsOf reads one failed item per finished, failed run on the head commit", () => {
      const head = "4f1c2b9a7e3d5c8b";
      const row = (
        databaseId: number,
        conclusion: string | null,
        updatedAt: string,
        change: Record<string, unknown> = {},
      ) => ({
        databaseId,
        attempt: 2,
        status: "completed",
        conclusion,
        headSha: head,
        workflowName: "Checks",
        updatedAt,
        url: `https://github.com/o/r/actions/runs/${databaseId}`,
        ...change,
      });
      const pull = { number: 40, url: "https://github.com/o/r/pull/40", headRefOid: head };
      const runs = [
        row(5, "failure", at(12)),
        // Set off by a push to the branch: taken all the same.
        row(6, "timed_out", at(13), { event: "push", attempt: 0 }),
        row(7, "success", at(11)),
        row(8, "failure", at(14), { headSha: "0ld0ld0ld0ld" }),
        row(9, null, "", { status: "in_progress" }),
        row(10, "cancelled", at(15)),
        row(11, "action_required", at(15)),
        row(12, "failure", at(1)),
      ];
      const base = { number: 40, title: "S", labels: [], url: "u", pull: true, head: "x" };
      const failed = (run: number, attempt: number, when: string) => ({
        ...base,
        kind: "failed",
        author: "",
        text: "",
        url: `https://github.com/o/r/actions/runs/${run}`,
        workflow: "Checks",
        run,
        attempt,
        sha: "4f1c2b9a",
        at: when,
      });
      expect(failedRunsOf(pull, base, runs, (when: string) => when > at(5))).toEqual([
        failed(5, 2, at(12)),
        failed(6, 1, at(13)),
      ]);
      expect(failedRunsOf(pull, base, [], () => true)).toEqual([]);
    });

    it("githubEvents tells a run once by its id and attempt, whoever brought it, and hides nothing else", () => {
      const nobody = { ...seen, permissions: { anton: "write" } };
      const read = (run: number, attempt = 1) => ({
        number: 40,
        title: "S",
        labels: [],
        url: `https://github.com/o/r/actions/runs/${run}`,
        pull: true,
        head: "series-order",
        kind: "failed",
        author: "",
        text: "",
        workflow: "Checks",
        run,
        attempt,
        sha: "4f1c2b9a",
        at: at(5),
      });
      // Two runs failing in the same second are two events (Codex, /code-review).
      const comment = {
        number: 40,
        title: "S",
        labels: [],
        url: "c",
        pull: true,
        head: "series-order",
        kind: "comment",
        author: "anton",
        at: at(3),
        text: "Rename this.",
      };
      const first = githubEvents(nobody, [read(1), read(2), comment], context);
      expect(first.events.map((one) => [one.kind, one.run])).toEqual([
        ["failed", 1],
        ["failed", 2],
        // A failed run's time hides no earlier comment on its pull request (/code-review).
        ["review", undefined],
      ]);
      // The webhook's delivery of a run the read told is no second event (Codex).
      const delivered = itemsOfDelivery("workflow_run", delivery({ id: 1, run_attempt: 1 }), "w9");
      expect(githubEvents(first.seen, delivered, context).events).toEqual([]);
      // Its rerun, attempt 2, failing too is told.
      const rerun = itemsOfDelivery("workflow_run", delivery({ id: 1, run_attempt: 2 }), "w10");
      expect(githubEvents(first.seen, rerun, context).events).toHaveLength(1);
      // A run whose pull request is not known is nobody's.
      expect(githubEvents(nobody, [{ ...read(3), number: 0 }], context).events).toEqual([]);
    });

    it("with issues off, githubEvents marks every delivery seen and tells only failed runs", () => {
      const off = { ...context, issuesOff: true };
      const run = itemsOfDelivery("workflow_run", recorded, "w1");
      const { events, seen: next } = githubEvents(seen, [items[1], ...run], off);
      expect(events.map((one) => one.kind)).toEqual(["failed"]);
      expect(next.deliveries).toEqual(["d2", "w1"]);
      // Issues turned on later: the comment's delivery is not replayed (/code-review).
      expect(githubEvents(next, [items[1]], context).events).toEqual([]);
    });

    // In a project with pull requests, no Issues heading and the secret.
    describe("with pull requests and no issues", () => {
      let dir: string;
      let port: number;
      const stubDir = mkdtempSync(join(tmpdir(), "failed-claude-"));
      const rows = join(stubDir, "rows.json");
      const script = join(stubDir, "claude");
      const env = () => ({
        PATH: process.env.PATH || "",
        WORKFLOW_ROOT: dir,
        CLAUDE_PROJECT_DIR: dir,
        WORKFLOW_WEBHOOK_SECRET: "s3cret",
        WORKFLOW_WEBHOOK_PORT: String(port),
        WORKFLOW_GH: "/bin/false",
        WORKFLOW_CLAUDE: script,
        STUB_ROWS: rows,
        WORKFLOW_STARTS_LOG: join(stubDir, "starts.log"),
        WORKFLOW_USAGE_FILE: join(stubDir, "usage.json"),
        CLAUDE_PLUGIN_OPTION_OWNER: "Javi",
        CLAUDE_PLUGIN_OPTION_MACHINE: "lab",
      });
      const plans = (...args: string[]) =>
        spawnSync("node", [join(here, "plan-queue.mjs"), ...args], {
          encoding: "utf8",
          env: env(),
        });
      beforeAll(async () => {
        port = await freePort();
        fakeClaude(stubDir);
        dir = mkdtempSync(join(tmpdir(), "failed-run-"));
        execFileSync("git", ["init", "-q"], { cwd: dir });
        mkdirSync(join(dir, ".claude"));
        mkdirSync(join(dir, "plans"));
        writeFileSync(
          join(dir, ".claude", "workflow.md"),
          "---\nname: Runs\nbranch: test\nland: pull-request\n---\n\n# Runs\n",
        );
        writeFileSync(
          join(dir, "plans", "series-order.md"),
          "# Series\n\nPlan only, 14 November 2026, for Javi.\n\n## Built, 14 November 2026\n\nPull request #40 (https://github.com/o/r/pull/40) to test from branch series-order, commit 4f1c2b9a; draft.\n",
        );
      });
      afterAll(() => {
        // With no folder (its setup failed), the stop would reach the working checkout.
        if (dir) {
          plans("webhook", "--stop");
          rmSync(dir, { recursive: true, force: true });
        }
        rmSync(stubDir, { recursive: true, force: true });
      });

      it("plans webhook listens, and plans prints its line", { timeout: 30_000 }, () => {
        expect(plans("list").stdout).toContain("The webhook: none; plans webhook starts it.");
        expect(plans("webhook").stdout).toMatch(
          new RegExp(`^The webhook: listening on ${port} since \\d\\d:\\d\\d\\.\\n$`),
        );
        expect(plans("list").stdout).toMatch(/\nThe webhook: listening on \d+ since/);
        expect(plans("webhook", "--stop").stdout.trim()).toBe("The webhook: stopped.");
        // Without the secret, no line: nothing could listen.
        const bare = spawnSync("node", [join(here, "plan-queue.mjs"), "list"], {
          encoding: "utf8",
          env: { ...env(), WORKFLOW_WEBHOOK_SECRET: "" },
        }).stdout;
        expect(bare).not.toContain("The webhook");
      });

      // When a run fails on a pull request of the queue's own, then plans/github/<n>.md gains a
      // failed line and an assistant is started on it (handleEvents).
      it(
        "plans github --inbox notes a failed run and starts the assistant, and takes no comment",
        { timeout: 30_000 },
        () => {
          const inbox = join(dir, ".claude", "github-inbox");
          mkdirSync(inbox, { recursive: true });
          const keep = (id: string, event: string, body: object) =>
            writeFileSync(
              join(inbox, `${id}.json`),
              JSON.stringify({ id, event, body: JSON.stringify(body) }),
            );
          keep("c1", "issue_comment", {
            action: "created",
            issue: { number: 40, title: "Series", labels: [], pull_request: {} },
            comment: { body: "Rename this.", user: user("anton"), created_at: at(3) },
          });
          keep("w1", "workflow_run", recorded);
          const said = plans("github", "--inbox").stdout;
          expect(said).toMatch(/^GitHub: #40 Checks run failed, noted; assistant started\. /);
          expect(said).toContain("Runs Assistant was started on: plans/github/40.md.");
          const note = readFileSync(join(dir, "plans", "github", "40.md"), "utf8");
          expect(note).toMatch(
            /^# GitHub #40: Series keep their order\n\nfailed, 14 November 2026 \d\d:04, Checks run 19283746501 on 4f1c2b9a: https:\/\/github\.com\/o\/r\/actions\/runs\/19283746501\n\n$/,
          );
          expect(note).not.toContain("Rename this.");
          expect(JSON.parse(readFileSync(rows, "utf8"))).toHaveLength(1);
        },
      );

      // plans/failed-runs-the-webhook-misses.md, part 2: a token that cannot read a pull
      // request's checks still brings its comments and its failed runs.
      it(
        "plans github reads comments with no checks asked, and failed runs by gh run list",
        { timeout: 30_000 },
        () => {
          const read = mkdtempSync(join(tmpdir(), "failed-read-"));
          try {
            execFileSync("git", ["init", "-q"], { cwd: read });
            execFileSync("git", ["remote", "add", "origin", "https://github.com/o/r.git"], {
              cwd: read,
            });
            mkdirSync(join(read, ".claude"));
            mkdirSync(join(read, "plans"));
            writeFileSync(
              join(read, ".claude", "workflow.md"),
              "---\nname: Runs\nbranch: test\nland: pull-request\n---\n\n# Runs\n\n## Issues\n\nTopics here are GitHub issues.\n",
            );
            writeFileSync(
              join(read, "plans", "series-order.md"),
              "# Series\n\nPlan only, 14 November 2026, for Javi.\n\n## Built, 14 November 2026\n\nPull request #40 (https://github.com/o/r/pull/40) to test from branch series-order, commit 4f1c2b9a; draft.\n",
            );
            const sha = "4f1c2b9a7e3d5c8b";
            const asked = join(read, "asked.log");
            const gh = join(stubDir, "gh-read");
            // Answers `pr list` without checks, as a token that cannot read them would: refuses any
            // list that asks for them.
            writeFileSync(
              gh,
              `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(asked)}, args.join(" ") + "\\n");
const say = (value) => process.stdout.write(JSON.stringify(value));
if (args.join(" ").includes("statusCheckRollup")) process.exit(1);
if (args[0] === "pr" && args.includes("open"))
  say([{ number: 40, title: "Series keep their order", url: "https://github.com/o/r/pull/40",
    headRefName: "series-order", headRefOid: "${sha}",
    comments: [{ id: "IC_1", author: { login: "anton" }, createdAt: "2026-11-14T21:00:00Z", body: "Rename this." }],
    reviews: [] }]);
else if (args[0] === "run" && args[1] === "list") {
  if (process.env.RUNS_FAIL) process.exit(1);
  say([{ databaseId: 5, attempt: 1, status: "completed", conclusion: "failure", headSha: "${sha}",
    workflowName: "Checks", updatedAt: "2026-11-14T21:04:00Z", url: "https://github.com/o/r/actions/runs/5" }]);
}
else if (args[0] === "api" && /collaborators/.test(args[1])) process.stdout.write("write");
else if (args[0] === "api" && args[1].endsWith("pulls/40/comments") && process.env.NOTES_FAIL) process.exit(1);
else say([]);
`,
            );
            chmodSync(gh, 0o755);
            writeFileSync(rows, "[]");
            const github = (extra: Record<string, string> = {}) =>
              spawnSync("node", [join(here, "plan-queue.mjs"), "github"], {
                encoding: "utf8",
                env: {
                  ...env(),
                  WORKFLOW_ROOT: read,
                  CLAUDE_PROJECT_DIR: read,
                  WORKFLOW_GH: gh,
                  // It reads a failed run, not the listener: its assistant's start arms none,
                  // and no secrets file stands in for the blank secret.
                  WORKFLOW_WEBHOOK_SECRET: "",
                  WORKFLOW_SECRETS_FILE: "",
                  ...extra,
                },
              }).stdout;
            // Its review comments unread, the pull request's comment is told at once: seen by its
            // id, the next read, its line held, does not tell it again
            // (plans/catch-up-read-misses-no-comment.md, part 3).
            const notes = github({ NOTES_FAIL: "1", RUNS_FAIL: "1" });
            expect(notes).toMatch(/GitHub: #40 \w+ by anton, noted/);
            expect(notes).toContain("GitHub: could not read the review comments of #40 (");
            // A run list that fails does not pass the run it missed (Codex).
            const unread = github({ RUNS_FAIL: "1" });
            expect(unread).not.toContain("by anton");
            expect(unread).not.toContain("run failed");
            const said = github();
            expect(said).toContain("GitHub: #40 Checks run failed, noted");
            expect(said).not.toContain("by anton");
            const note = readFileSync(join(read, "plans", "github", "40.md"), "utf8");
            expect(note).toContain(
              "Checks run 5 on 4f1c2b9a: https://github.com/o/r/actions/runs/5",
            );
            expect(note.match(/Rename this\./g)).toHaveLength(1);
            const calls = readFileSync(asked, "utf8");
            expect(calls).toContain(`run list --branch series-order --commit ${sha}`);
            expect(calls).not.toContain("statusCheckRollup");
          } finally {
            rmSync(read, { recursive: true, force: true });
          }
        },
      );

      // plans/people-comments-reach-the-queue.md, part 3: when plans github reads after a time
      // with no listener, then a named person's comments on another person's open pull request
      // are noted, and a pull request no named person wrote on since is asked for nothing.
      it(
        "plans github reads a named person's comments on another person's open pull request",
        { timeout: 30_000 },
        () => {
          const read = mkdtempSync(join(tmpdir(), "people-read-"));
          try {
            execFileSync("git", ["init", "-q"], { cwd: read });
            execFileSync("git", ["remote", "add", "origin", "https://github.com/o/r.git"], {
              cwd: read,
            });
            mkdirSync(join(read, ".claude"));
            mkdirSync(join(read, "plans"));
            writeFileSync(
              join(read, ".claude", "workflow.md"),
              "---\nname: Runs\nbranch: test\nland: pull-request\n---\n\n# Runs\n\n## Issues\n\nTopics here are GitHub issues.\n\n## People\n\nHenry (`@Henry`) decides the copy.\n",
            );
            writeFileSync(
              join(read, ".claude", "github-seen.json"),
              JSON.stringify({ readAt: "2026-11-14T00:00:00.000Z" }),
            );
            const asked = join(read, "asked.log");
            const gh = join(stubDir, "gh-people");
            // #50 is another person's, henry wrote on it since the read's line; #51 has anton's
            // comment alone; #52 henry's from before the line; #53 henry's inline comment alone
            // (plans/catch-up-read-complete.md, part 2). The inline comments are one list.
            writeFileSync(
              gh,
              `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(asked)}, args.join(" ") + "\\n");
const say = (value) => process.stdout.write(JSON.stringify(value));
const pull = (number, login, at) => ({ number, title: "Theirs " + number,
  url: "https://github.com/o/r/pull/" + number, headRefName: "b" + number, headRefOid: "abc" + number,
  comments: [{ author: { login }, createdAt: at, body: "Could this sort by date?" }], reviews: [] });
const inline = (number, id, body) => ({ node_id: id, user: { login: "henry" },
  created_at: "2026-11-14T21:05:00Z", body, html_url: "https://github.com/o/r/pull/" + number + "#r1",
  pull_request_url: "https://api.github.com/repos/o/r/pulls/" + number });
if (args[0] === "pr" && args.includes("open"))
  say([pull(50, "henry", "2026-11-14T21:00:00Z"), pull(51, "anton", "2026-11-14T21:00:00Z"),
    pull(52, "henry", "2026-11-13T21:00:00Z"), { ...pull(53, "", ""), comments: [] }]);
else if (args[0] === "api" && /collaborators/.test(args[1])) process.stdout.write("write");
else if (args[0] === "api" && args[1].includes("pulls/comments?since="))
  say([inline(50, "PRRC_50", "And rename this."), inline(53, "PRRC_53", "Name the constant.")]);
else say([]);
`,
            );
            chmodSync(gh, 0o755);
            writeFileSync(rows, "[]");
            const said = spawnSync("node", [join(here, "plan-queue.mjs"), "github"], {
              encoding: "utf8",
              env: {
                ...env(),
                WORKFLOW_ROOT: read,
                CLAUDE_PROJECT_DIR: read,
                WORKFLOW_GH: gh,
                WORKFLOW_WEBHOOK_SECRET: "",
                WORKFLOW_SECRETS_FILE: "",
              },
            }).stdout;
            expect(said).toMatch(/GitHub: #50 review by henry, noted/);
            expect(said).toMatch(/GitHub: #53 review by henry, noted/);
            expect(said).not.toMatch(/#51|#52/);
            const note = readFileSync(join(read, "plans", "github", "50.md"), "utf8");
            expect(note).toContain("    Could this sort by date?");
            expect(note).toContain("    And rename this.");
            expect(readFileSync(join(read, "plans", "github", "53.md"), "utf8")).toContain(
              "    Name the constant.",
            );
            expect(existsSync(join(read, "plans", "github", "51.md"))).toBe(false);
            const calls = readFileSync(asked, "utf8");
            expect(calls).not.toContain("run list");
            expect(calls.match(/pulls\/comments\?since=/g)).toHaveLength(1);
            expect(calls).not.toMatch(/pulls\/\d+\/comments/);
          } finally {
            rmSync(read, { recursive: true, force: true });
          }
        },
      );

      // plans/catch-up-read-misses-no-comment.md, part 4: when the listener missed a named
      // person's comment or review and then heard another writer on the same thread, then plans
      // github notes the missed one, once. The later comment goes in by plans github --inbox, as
      // the listener handles it.
      // `more`, lines of the fake gh's run before its usual answers, for the cases of
      // plans/catch-up-read-complete.md; empty, the fake is the one these cases were written with.
      const missedRead = (
        answers: { issues: object[]; pulls: object[] },
        heard: object,
        more = "",
      ) => {
        const read = mkdtempSync(join(tmpdir(), "missed-read-"));
        execFileSync("git", ["init", "-q"], { cwd: read });
        execFileSync("git", ["remote", "add", "origin", "https://github.com/o/r.git"], {
          cwd: read,
        });
        mkdirSync(join(read, ".claude", "github-inbox"), { recursive: true });
        mkdirSync(join(read, "plans"));
        writeFileSync(
          join(read, ".claude", "workflow.md"),
          "---\nname: Runs\nbranch: test\nland: pull-request\n---\n\n# Runs\n\n## Issues\n\nTopics here are GitHub issues.\n\n## People\n\nHenry (`@Henry`) decides the copy.\n",
        );
        writeFileSync(
          join(read, ".claude", "github-seen.json"),
          JSON.stringify({ readAt: "2026-11-14T00:00:00.000Z" }),
        );
        writeFileSync(
          join(read, ".claude", "github-inbox", "h1.json"),
          JSON.stringify({ id: "h1", event: "issue_comment", body: JSON.stringify(heard) }),
        );
        const gh = join(read, "gh");
        writeFileSync(
          gh,
          `#!/usr/bin/env node
const args = process.argv.slice(2);
const say = (value) => process.stdout.write(JSON.stringify(value));
${more}if (args[0] === "issue" && args[1] === "list") say(${JSON.stringify(answers.issues)});
else if (args[0] === "pr" && args.includes("open")) say(${JSON.stringify(answers.pulls)});
else if (args[0] === "api" && /collaborators/.test(args[1])) process.stdout.write("write");
else say([]);
`,
        );
        chmodSync(gh, 0o755);
        writeFileSync(rows, "[]");
        const envOf = (extra: Record<string, string> = {}) => ({
          ...env(),
          WORKFLOW_ROOT: read,
          CLAUDE_PROJECT_DIR: read,
          WORKFLOW_GH: gh,
          WORKFLOW_WEBHOOK_SECRET: "",
          WORKFLOW_SECRETS_FILE: "",
          ...extra,
        });
        const githubWith = (extra: Record<string, string>, ...args: string[]) =>
          spawnSync("node", [join(here, "plan-queue.mjs"), "github", ...args], {
            encoding: "utf8",
            env: envOf(extra),
          }).stdout;
        const github = (...args: string[]) => githubWith({}, ...args);
        return { read, github, githubWith, envOf };
      };
      const antonSaid = (number: number, id: string, pull: boolean) => ({
        action: "created",
        issue: { number, title: "Loose", labels: [], ...(pull ? { pull_request: {} } : {}) },
        comment: {
          node_id: id,
          body: "I would keep it.",
          user: user("anton"),
          created_at: "2026-11-14T21:10:00Z",
        },
      });

      it(
        "plans github finds a comment the listener missed on an issue it heard from since",
        { timeout: 30_000 },
        () => {
          const issue = {
            number: 30,
            title: "Loose",
            labels: [],
            url: "https://github.com/o/r/issues/30",
            author: { login: "henry" },
            createdAt: "2026-11-10T09:00:00Z",
            updatedAt: "2026-11-14T21:10:00Z",
            body: "",
            comments: [
              {
                id: "IC_1",
                author: { login: "henry" },
                createdAt: "2026-11-14T21:00:00Z",
                body: "Could the list sort by date?",
              },
              {
                id: "IC_2",
                author: { login: "anton" },
                createdAt: "2026-11-14T21:10:00Z",
                body: "I would keep it.",
              },
            ],
          };
          const { read, github } = missedRead(
            { issues: [issue], pulls: [] },
            antonSaid(30, "IC_2", false),
          );
          try {
            expect(github("--inbox")).toBe("GitHub: nothing new.\n");
            const said = github();
            expect(said).toMatch(/GitHub: #30 comment by henry, noted/);
            const note = readFileSync(join(read, "plans", "github", "30.md"), "utf8");
            expect(note.match(/Could the list sort by date\?/g)).toHaveLength(1);
            expect(note).not.toContain("I would keep it.");
          } finally {
            rmSync(read, { recursive: true, force: true });
          }
        },
      );

      it(
        "plans github finds a review the listener missed on a pull request it heard from since",
        { timeout: 30_000 },
        () => {
          const pull = {
            number: 50,
            title: "Theirs",
            url: "https://github.com/o/r/pull/50",
            headRefName: "b50",
            headRefOid: "abc50",
            comments: [
              {
                id: "IC_3",
                author: { login: "anton" },
                createdAt: "2026-11-14T21:10:00Z",
                body: "I would keep it.",
              },
            ],
            reviews: [
              {
                id: "PRR_1",
                author: { login: "henry" },
                submittedAt: "2026-11-14T21:00:00Z",
                body: "Rename the helper.",
              },
            ],
          };
          const { read, github } = missedRead(
            { issues: [], pulls: [pull] },
            antonSaid(50, "IC_3", true),
          );
          try {
            expect(github("--inbox")).toBe("GitHub: nothing new.\n");
            expect(github()).toMatch(/GitHub: #50 review by henry, noted/);
            const note = readFileSync(join(read, "plans", "github", "50.md"), "utf8");
            expect(note).toContain("    Rename the helper.");
          } finally {
            rmSync(read, { recursive: true, force: true });
          }
        },
      );

      // plans/catch-up-read-complete.md, part 1: when a named person's comment is read and their
      // permission cannot be, then nothing is noted and the line holds; the next read that can
      // read it notes it once. A login GitHub says is no user holds nothing.
      const loose = (comments: object[]) => ({
        number: 30,
        title: "Loose",
        labels: [],
        url: "https://github.com/o/r/issues/30",
        author: { login: "henry" },
        createdAt: "2026-11-10T09:00:00Z",
        updatedAt: "2026-11-14T21:10:00Z",
        body: "",
        comments,
      });
      it(
        "plans github leaves a comment unseen while its author's permission cannot be read",
        { timeout: 30_000 },
        () => {
          const issue = loose([
            {
              id: "IC_1",
              author: { login: "henry" },
              createdAt: "2026-11-14T21:00:00Z",
              body: "Could the list sort by date?",
            },
            {
              id: "IC_4",
              author: { login: "triage" },
              createdAt: "2026-11-14T21:05:00Z",
              body: "Bump.",
            },
          ]);
          const { read, githubWith } = missedRead(
            { issues: [issue], pulls: [] },
            antonSaid(30, "IC_2", false),
            `if (args[0] === "api" && args[1].endsWith("collaborators/henry/permission") && process.env.HENRY_FAILS) {
  process.stderr.write("gh: Bad gateway (HTTP 502)\\n");
  process.exit(1);
} else if (args[0] === "api" && args[1].endsWith("collaborators/triage/permission")) {
  process.stderr.write("gh: triage is not a user (HTTP 404)\\n");
  process.exit(1);
} else `,
          );
          const seenFile = join(read, ".claude", "github-seen.json");
          try {
            const first = githubWith({ HENRY_FAILS: "1" });
            expect(first).toContain(
              "GitHub: could not read the permission of henry (gh: Bad gateway).",
            );
            expect(first).not.toContain("triage");
            expect(first).not.toContain("noted");
            expect(existsSync(join(read, "plans", "github", "30.md"))).toBe(false);
            expect(JSON.parse(readFileSync(seenFile, "utf8")).readAt).toBe(
              "2026-11-14T00:00:00.000Z",
            );
            const second = githubWith({});
            expect(second).toMatch(/GitHub: #30 comment by henry, noted/);
            expect(second).not.toContain("could not read the permission");
            expect(second).not.toContain("triage");
            const note = readFileSync(join(read, "plans", "github", "30.md"), "utf8");
            expect(note.match(/Could the list sort by date\?/g)).toHaveLength(1);
            expect(note).not.toContain("Bump.");
            expect(JSON.parse(readFileSync(seenFile, "utf8")).permissions.triage).toBe("none");
          } finally {
            rmSync(read, { recursive: true, force: true });
          }
        },
      );

      // plans/catch-up-read-complete.md, part 2: when a thread has more comments than gh embeds,
      // or the inline comments more than a page, then the one past them is noted.
      it("plans github reads every page", { timeout: 30_000 }, () => {
        const older = Array.from({ length: 100 }, (_, i) => ({
          id: `IC_old${i}`,
          author: { login: "anton" },
          createdAt: "2026-11-13T09:00:00Z",
          body: "Older.",
        }));
        const notes = Array.from({ length: 31 }, (_, i) => ({
          node_id: `PRRC_${i}`,
          user: { login: i === 30 ? "henry" : "anton" },
          created_at: i === 30 ? "2026-11-14T21:05:00Z" : "2026-11-13T09:00:00Z",
          body: i === 30 ? "Rename the helper." : "Older.",
          html_url: `https://github.com/o/r/pull/40#r${i}`,
          pull_request_url: "https://api.github.com/repos/o/r/pulls/40",
        }));
        const missed = {
          node_id: "IC_new",
          user: { login: "henry" },
          created_at: "2026-11-14T21:00:00Z",
          body: "Could the list sort by date?",
          html_url: "https://github.com/o/r/issues/30#issuecomment-1",
        };
        const pull = {
          number: 40,
          title: "Series",
          url: "https://github.com/o/r/pull/40",
          headRefName: "series-order",
          headRefOid: "4f1c2b9a",
          comments: [],
          reviews: [],
        };
        // Another person's pull request whose embedded comments are full: henry's past them
        // makes it read (Codex C1).
        const theirs = {
          ...pull,
          number: 54,
          url: "https://github.com/o/r/pull/54",
          headRefName: "b54",
          comments: older,
        };
        const { read, githubWith } = missedRead(
          { issues: [loose(older)], pulls: [pull, theirs] },
          antonSaid(30, "IC_2", false),
          `require("node:fs").appendFileSync(process.env.ASKED_LOG, args.join(" ") + "\\n");
if (args[0] === "api" && args[1].includes("issues/30/comments")) say([${JSON.stringify(missed)}]);
else if (args[0] === "api" && args[1].includes("issues/54/comments"))
  say([${JSON.stringify({ ...missed, node_id: "IC_54", body: "Split this pull request." })}]);
else if (args[0] === "api" && args[1].includes("pulls/comments?since=")) say(${JSON.stringify(notes)});
else `,
        );
        writeFileSync(
          join(read, "plans", "series-order.md"),
          "# Series\n\nPlan only, 14 November 2026, for Javi.\n\n## Built, 14 November 2026\n\nPull request #40 (https://github.com/o/r/pull/40) to test from branch series-order, commit 4f1c2b9a; draft.\n",
        );
        const asked = join(read, "asked.log");
        try {
          const said = githubWith({ ASKED_LOG: asked });
          expect(said).toMatch(/GitHub: #30 comment by henry, noted/);
          expect(said).toMatch(/GitHub: #40 review by henry, noted/);
          expect(said).toMatch(/GitHub: #54 review by henry, noted/);
          expect(readFileSync(join(read, "plans", "github", "54.md"), "utf8")).toContain(
            "    Split this pull request.",
          );
          const issueNote = readFileSync(join(read, "plans", "github", "30.md"), "utf8");
          expect(issueNote).toContain("    Could the list sort by date?");
          expect(issueNote).not.toContain("Older.");
          const pullNote = readFileSync(join(read, "plans", "github", "40.md"), "utf8");
          expect(pullNote).toContain("    Rename the helper.");
          expect(pullNote).not.toContain("Older.");
          const calls = readFileSync(asked, "utf8").split("\n");
          const thread = calls.filter((line) => line.includes("issues/30/comments"));
          const inline = calls.filter((line) => line.includes("pulls/comments?since="));
          expect(thread).toHaveLength(1);
          expect(inline).toHaveLength(1);
          expect([...thread, ...inline].every((line) => line.endsWith("--paginate"))).toBe(true);
          expect(calls.some((line) => /pulls\/40\/comments/.test(line))).toBe(false);
        } finally {
          rmSync(read, { recursive: true, force: true });
        }
      });

      // plans/catch-up-read-complete.md, part 4: when two reads run at once over one delivery,
      // then its note holds the comment once, a guard a dead process left taken over.
      it("two reads at once write a delivery's note once", { timeout: 30_000 }, async () => {
        const henrySaid = {
          action: "created",
          issue: { number: 30, title: "Loose", labels: [] },
          comment: {
            node_id: "IC_9",
            body: "Could the list sort by date?",
            user: user("henry"),
            created_at: "2026-11-14T21:00:00Z",
          },
        };
        const { read, envOf } = missedRead(
          { issues: [], pulls: [] },
          henrySaid,
          `if (args[0] === "api" && /collaborators/.test(args[1]))
  setTimeout(() => process.stdout.write("write"), 1500);
else `,
        );
        const guard = join(read, ".claude", "github-seen.guard");
        writeFileSync(guard, "2147483646");
        const run = () =>
          new Promise<string>((done) => {
            const child = spawn("node", [join(here, "plan-queue.mjs"), "github", "--inbox"], {
              env: envOf(),
            });
            let out = "";
            child.stdout.on("data", (chunk) => (out += chunk));
            child.on("close", () => done(out));
          });
        try {
          const said = await Promise.all([run(), run()]);
          expect(said.filter((one) => /#30 comment by henry, noted/.test(one))).toHaveLength(1);
          const note = readFileSync(join(read, "plans", "github", "30.md"), "utf8");
          expect(note.match(/Could the list sort by date\?/g)).toHaveLength(1);
          expect(existsSync(guard)).toBe(false);
        } finally {
          rmSync(read, { recursive: true, force: true });
        }
      });

      // plans/catch-up-read-complete.md, part 3: when status: ready was told, taken off and put
      // back, then the next read tells it again; not put back, nothing.
      it("plans github reads a ready label put back after it was told", { timeout: 30_000 }, () => {
        const issue = {
          ...loose([]),
          number: 12,
          title: "Series",
          labels: [{ name: "status: ready" }],
          url: "https://github.com/o/r/issues/12",
        };
        const labeled = (created_at: string) => ({
          event: "labeled",
          label: { name: "status: ready" },
          actor: { login: "anton" },
          created_at,
        });
        const events = [
          labeled("2026-11-14T09:00:00Z"),
          {
            event: "unlabeled",
            label: { name: "status: ready" },
            actor: { login: "anton" },
            created_at: "2026-11-14T10:00:00Z",
          },
          labeled("2026-11-14T21:10:00Z"),
        ];
        const { read, githubWith } = missedRead(
          { issues: [issue], pulls: [] },
          antonSaid(30, "IC_2", false),
          `if (args[0] === "api" && args[1].includes("issues/12/events"))
  say(process.env.PUT_BACK ? ${JSON.stringify(events)} : ${JSON.stringify(events.slice(0, 1))});
else `,
        );
        writeFileSync(
          join(read, "plans", "series.md"),
          "# Series\n\nPlan only, 14 November 2026, for Javi.\n\nIssue: #12.\n\n## What was asked\n",
        );
        const seenFile = join(read, ".claude", "github-seen.json");
        const told = () =>
          writeFileSync(
            seenFile,
            JSON.stringify({
              readAt: "2026-11-14T00:00:00.000Z",
              labeled: ["12:status: ready"],
              labeledAt: { "12:status: ready": "2026-11-14T09:00:00Z" },
            }),
          );
        try {
          told();
          expect(githubWith({})).toBe("GitHub: nothing new.\n");
          told();
          expect(githubWith({ PUT_BACK: "1" })).toMatch(/GitHub: #12 ready by anton, noted/);
          expect(JSON.parse(readFileSync(seenFile, "utf8")).labeledAt).toEqual({
            "12:status: ready": "2026-11-14T21:10:00Z",
          });
        } finally {
          rmSync(read, { recursive: true, force: true });
        }
      });

      // plans/checks-read-with-the-app.md, part 2: when a read of plans github fails, then plans
      // github and plans say which list and why, and the read's lines hold.
      it(
        "plans github says a list GitHub refused, and holds its lines",
        { timeout: 60_000 },
        () => {
          const read = mkdtempSync(join(tmpdir(), "unread-"));
          try {
            execFileSync("git", ["init", "-q"], { cwd: read });
            execFileSync("git", ["remote", "add", "origin", "https://github.com/o/r.git"], {
              cwd: read,
            });
            mkdirSync(join(read, ".claude"));
            mkdirSync(join(read, "plans"));
            writeFileSync(
              join(read, ".claude", "workflow.md"),
              "---\nname: Runs\nbranch: test\nland: pull-request\n---\n\n# Runs\n",
            );
            writeFileSync(
              join(read, "plans", "series-order.md"),
              "# Series\n\nPlan only, 14 November 2026, for Javi.\n\n## Built, 14 November 2026\n\nPull request #40 (https://github.com/o/r/pull/40) to test from branch series-order, commit 4f1c2b9a; draft.\n",
            );
            const gh = join(stubDir, "gh-unread");
            writeFileSync(
              gh,
              `#!/usr/bin/env node
const args = process.argv.slice(2);
const say = (value) => process.stdout.write(JSON.stringify(value));
if (args[0] === "pr" && args[1] === "list" && args.includes("merged")) say([]);
else if (args[0] === "pr" && args[1] === "list") {
  if (process.env.REFUSE_PR) {
    process.stderr.write("GraphQL: Resource not accessible by personal access token (repository.pullRequests)\\n");
    process.exit(1);
  }
  say([{ number: 40, title: "Series", url: "https://github.com/o/r/pull/40",
    headRefName: "series-order", headRefOid: "4f1c2b9a", comments: [], reviews: [] }]);
} else if (args[0] === "run" && args[1] === "list") {
  if (process.env.REFUSE_RUN) {
    process.stderr.write("HTTP 403: Resource not accessible by integration (https://api.github.com/x)\\n");
    process.exit(1);
  }
  say([]);
} else say([]);
`,
            );
            chmodSync(gh, 0o755);
            const seenFile = join(read, ".claude", "github-seen.json");
            const before = {
              readAt: "2026-11-14T00:00:00.000Z",
              runsReadAt: "2026-11-13T00:00:00.000Z",
            };
            writeFileSync(seenFile, JSON.stringify(before));
            const run = (args: string[], extra: Record<string, string> = {}) =>
              spawnSync("node", [join(here, "plan-queue.mjs"), ...args], {
                encoding: "utf8",
                env: {
                  ...env(),
                  WORKFLOW_ROOT: read,
                  CLAUDE_PROJECT_DIR: read,
                  WORKFLOW_GH: gh,
                  WORKFLOW_WEBHOOK_SECRET: "",
                  WORKFLOW_SECRETS_FILE: "",
                  ...extra,
                },
              }).stdout;
            const seenNow = () => JSON.parse(readFileSync(seenFile, "utf8"));
            const refusedLine =
              "GitHub: could not read the open pull requests (GraphQL: Resource not accessible by personal access token).";
            // A dry read says it and writes nothing.
            const dry = run(["github", "--dry"], { REFUSE_PR: "1" });
            expect(dry).toContain(refusedLine);
            expect(dry).not.toContain("nothing new");
            expect(seenNow()).toEqual(before);
            const refused = run(["github"], { REFUSE_PR: "1" });
            expect(refused.trim()).toBe(refusedLine);
            let seen = seenNow();
            expect(seen.readAt).toBe(before.readAt);
            expect(seen.runsReadAt).toBe(before.runsReadAt);
            expect(seen.unread.said).toEqual([
              "the open pull requests (GraphQL: Resource not accessible by personal access token)",
            ]);
            expect(run(["list"])).toMatch(
              /\nGitHub: the read at \d\d:\d\d could not read the open pull requests \(GraphQL: Resource not accessible by personal access token\); plans github reads again\.\n/,
            );
            // The pull requests read, a run list refused: today's held runs' line, now said.
            const runs = run(["github"], { REFUSE_RUN: "1" });
            expect(runs.trim()).toBe(
              "GitHub: could not read the runs of #40 (HTTP 403: Resource not accessible by integration).",
            );
            seen = seenNow();
            expect(seen.readAt > before.readAt).toBe(true);
            expect(seen.runsReadAt).toBe(before.runsReadAt);
            expect(run(["list"])).toContain("could not read the runs of #40 (HTTP 403");
            // Everything read: nothing unread, both lines moved, nothing said of it.
            expect(run(["github"]).trim()).toBe("GitHub: nothing new.");
            seen = seenNow();
            expect(seen.unread).toBeUndefined();
            expect(seen.runsReadAt > before.runsReadAt).toBe(true);
            expect(seen.readAt).toBe(seen.runsReadAt);
            expect(run(["list"])).not.toContain("could not read");
          } finally {
            rmSync(read, { recursive: true, force: true });
          }
        },
      );
    });

    // plans/open-assistant-reads-github-notes.md, part 1: a note reaches an open assistant chat by
    // a one-shot run of Claude with the message tool alone, addressed by the chat's socket.
    describe("an open assistant chat", () => {
      const stub = mkdtempSync(join(tmpdir(), "told-claude-"));
      const socks = join(stub, "socks");
      const plansPath = (dir: string, ...args: string[]) =>
        spawnSync("node", [join(here, "plan-queue.mjs"), ...args], {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH || "",
            TMPDIR: tmpdir(),
            WORKFLOW_ROOT: dir,
            CLAUDE_PROJECT_DIR: dir,
            WORKFLOW_GH: "/bin/false",
            WORKFLOW_CLAUDE: join(stub, "claude"),
            WORKFLOW_SOCKS: socks,
            STUB_ROWS: join(dir, "rows.json"),
            STUB_SENT: join(dir, "sent.log"),
            STUB_FAIL: existsSync(join(dir, "fail")) ? "1" : "",
            WORKFLOW_STARTS_LOG: join(dir, "starts.log"),
            WORKFLOW_USAGE_FILE: join(dir, "usage.json"),
            WORKFLOW_WEBHOOK_SECRET: "",
            WORKFLOW_SECRETS_FILE: "",
            WORKFLOW_APP_ID: "",
            WORKFLOW_APP_KEY: "",
            CLAUDE_PLUGIN_OPTION_OWNER: "Javi",
            CLAUDE_PLUGIN_OPTION_MACHINE: "lab",
          },
        }).stdout;
      // A chat named Runs Assistant, listed with a process.
      const chat = (dir: string, pid: number) => ({
        sessionId: `told-${process.pid}-${pid}`,
        name: "Runs Assistant",
        kind: "background",
        status: "idle",
        pid,
        startedAt: pid,
        cwd: dir,
      });
      const project = (rows: object[]) => {
        const dir = mkdtempSync(join(tmpdir(), "told-"));
        execFileSync("git", ["init", "-q"], { cwd: dir });
        mkdirSync(join(dir, ".claude", "github-inbox"), { recursive: true });
        mkdirSync(join(dir, "plans"));
        writeFileSync(
          join(dir, ".claude", "workflow.md"),
          "---\nname: Runs\nbranch: test\nland: pull-request\n---\n\n# Runs\n",
        );
        writeFileSync(
          join(dir, "plans", "series-order.md"),
          "# Series\n\nPlan only, 14 November 2026, for Javi.\n\n## Built, 14 November 2026\n\nPull request #40 (https://github.com/o/r/pull/40) to test from branch series-order, commit 4f1c2b9a; draft.\n",
        );
        writeFileSync(join(dir, "rows.json"), JSON.stringify(rows));
        writeFileSync(
          join(dir, ".claude", "github-inbox", "w1.json"),
          JSON.stringify({ id: "w1", event: "workflow_run", body: JSON.stringify(recorded) }),
        );
        return dir;
      };
      // Each one-shot run: its arguments and where it ran.
      const sent = (dir: string): { args: string[]; cwd: string }[] =>
        existsSync(join(dir, "sent.log"))
          ? readFileSync(join(dir, "sent.log"), "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
          : [];
      const textOf = (one: { args: string[] }) => one.args.at(-1) || "";
      beforeAll(() => {
        mkdirSync(socks);
        for (const pid of [111, 222]) writeFileSync(join(socks, `${pid}.sock`), "");
        // Records each -p run and prints a stream-json tool result, sent or refused.
        writeFileSync(
          join(stub, "claude"),
          `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "agents") process.stdout.write(fs.readFileSync(process.env.STUB_ROWS, "utf8"));
else if (args[0] === "-p") {
  fs.appendFileSync(process.env.STUB_SENT, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
  const content = process.env.STUB_FAIL
    ? "No agent named 'Runs' is reachable"
    : [{ type: "text", text: '{"success":true,"message":"Message sent"}' }];
  console.log(JSON.stringify({ type: "system", subtype: "init" }));
  console.log(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content }] } }));
}
`,
        );
        chmodSync(join(stub, "claude"), 0o755);
      });
      afterAll(() => rmSync(stub, { recursive: true, force: true }));

      it("an open assistant chat is sent the note", { timeout: 30_000 }, () => {
        const dir = project([chat("", 111)]);
        writeFileSync(join(dir, "rows.json"), JSON.stringify([chat(dir, 111)]));
        try {
          const said = plansPath(dir, "github", "--inbox");
          expect(said).toContain("GitHub: #40 Checks run failed, noted.\n");
          expect(said).toContain("GitHub: Runs Assistant was sent plans/github/40.md.\n");
          const runs = sent(dir);
          expect(runs).toHaveLength(1);
          const [one] = runs;
          expect(one.args[0]).toBe("-p");
          expect(one.args.join(" ")).toContain("--tools SendMessage --allowedTools SendMessage");
          expect(realpathSync(one.cwd)).toBe(realpathSync(tmpdir()));
          expect(textOf(one).split("\n").slice(0, 3)).toEqual([
            `Recipient: uds:${join(socks, "111.sock")}`,
            "Text:",
            "GitHub: plans/github/40.md.",
          ]);
          // Sent to a chat the queue has not seen run the assistant's agent: the line for it.
          expect(textOf(one)).toContain(
            "this chat has the assistant's name and not its instructions: tell Javi",
          );
          expect(plansPath(dir, "list")).toMatch(
            /\nFrom GitHub, not handled\n {2}plans\/github\/40\.md, sent to Runs Assistant at \d\d:\d\d\n/,
          );
          // Sent and still waiting: not sent again.
          expect(plansPath(dir, "github", "--inbox").trim()).toBe("GitHub: nothing new.");
          expect(sent(dir)).toHaveLength(1);
          // Handled, then a new event: sent again.
          const note = join(dir, "plans", "github", "40.md");
          appendFileSync(note, "## Handled, 14 November 2026, session s1\n\nRerun.\n\n");
          expect(plansPath(dir, "github", "--inbox").trim()).toBe("GitHub: nothing new.");
          appendFileSync(
            note,
            "failed, 14 November 2026 21:30, Checks run 19283746502 on 4f1c2b9a: https://github.com/o/r/actions/runs/19283746502\n\n",
          );
          expect(plansPath(dir, "github", "--inbox").trim()).toBe(
            "GitHub: Runs Assistant was sent plans/github/40.md.",
          );
          expect(sent(dir)).toHaveLength(2);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it(
        "picks the chat that ran the assistant's agent, else the one started last",
        { timeout: 30_000 },
        () => {
          const dir = project([]);
          const rows = [chat(dir, 111), chat(dir, 222)];
          writeFileSync(join(dir, "rows.json"), JSON.stringify(rows));
          const state = stateFile(rows[0].sessionId);
          try {
            writeFileSync(state, JSON.stringify({ agent: "assistant" }));
            plansPath(dir, "github", "--inbox");
            const [first] = sent(dir);
            expect(textOf(first)).toContain(`Recipient: uds:${join(socks, "111.sock")}\n`);
            expect(textOf(first)).not.toContain("has the assistant's name");
            // Neither ran it: the one started last, with the line.
            rmSync(state);
            rmSync(join(dir, ".claude", "github-told.json"));
            plansPath(dir, "github", "--inbox");
            const second = sent(dir)[1];
            expect(textOf(second)).toContain(`Recipient: uds:${join(socks, "222.sock")}\n`);
            expect(textOf(second)).toContain("has the assistant's name and not its instructions");
          } finally {
            rmSync(state, { force: true });
            rmSync(dir, { recursive: true, force: true });
          }
        },
      );

      // plans/one-assistant-after-handover.md, part 1.
      it(
        "assistantChat picks the chat started last that is not handed on",
        { timeout: 60_000 },
        () => {
          const dir = project([]);
          const [older, newer] = [chat(dir, 111), chat(dir, 222)];
          const states = [older, newer].map((one) => stateFile(one.sessionId));
          const picked = (rows: object[], state: Record<string, object>) => {
            for (const [i, one] of [older, newer].entries())
              writeFileSync(states[i], JSON.stringify(state[one.sessionId] || {}));
            writeFileSync(join(dir, "rows.json"), JSON.stringify(rows));
            rmSync(join(dir, ".claude", "github-told.json"), { force: true });
            const before = sent(dir).length;
            plansPath(dir, "github", "--inbox");
            return textOf(sent(dir)[before]).split("\n")[0];
          };
          const ran = { agent: "assistant" };
          const handing = { agent: "assistant", handing: { at: Date.now() - 20 * 60_000 } };
          try {
            // An older chat handed on and a newer one, both having run the agent: the newer.
            expect(
              picked([older, newer], { [older.sessionId]: handing, [newer.sessionId]: ran }),
            ).toBe(`Recipient: uds:${join(socks, "222.sock")}`);
            // The handed-on chat alone: it, the one chat until it is replaced.
            expect(picked([older], { [older.sessionId]: handing })).toBe(
              `Recipient: uds:${join(socks, "111.sock")}`,
            );
            // Two that ran the agent, neither handed on: the one started last.
            expect(picked([older, newer], { [older.sessionId]: ran, [newer.sessionId]: ran })).toBe(
              `Recipient: uds:${join(socks, "222.sock")}`,
            );
          } finally {
            for (const state of states) rmSync(state, { force: true });
            rmSync(dir, { recursive: true, force: true });
          }
        },
      );

      // Codex C10: the listener's own minute sends again, with no read or delivery asked.
      it("the listener's minute tries a note again by itself", { timeout: 60_000 }, async () => {
        const dir = project([]);
        const rows = [chat(dir, 111)];
        writeFileSync(join(dir, "rows.json"), JSON.stringify(rows));
        writeFileSync(join(dir, "fail"), "");
        const saved = { ...process.env };
        const set = {
          WORKFLOW_ROOT: dir,
          WORKFLOW_LIVE: JSON.stringify(rows),
          WORKFLOW_CLAUDE: join(stub, "claude"),
          WORKFLOW_SOCKS: socks,
        };
        Object.assign(process.env, set);
        vi.resetModules();
        const queue = await import("../plugins/workflow/scripts/plan-queue.mjs");
        const port = await freePort();
        const env = {
          PATH: process.env.PATH || "",
          TMPDIR: tmpdir(),
          ...set,
          CLAUDE_PROJECT_DIR: dir,
          WORKFLOW_GH: "/bin/false",
          STUB_ROWS: join(dir, "rows.json"),
          STUB_SENT: join(dir, "sent.log"),
          STUB_FAIL: "1",
          WORKFLOW_STARTS_LOG: join(dir, "starts.log"),
          WORKFLOW_USAGE_FILE: join(dir, "usage.json"),
          WORKFLOW_WEBHOOK_SECRET: "s3cret",
          WORKFLOW_WEBHOOK_PORT: String(port),
          WORKFLOW_SECRETS_FILE: "",
          WORKFLOW_APP_ID: "",
          WORKFLOW_APP_KEY: "",
          CLAUDE_PLUGIN_OPTION_OWNER: "Javi",
          CLAUDE_PLUGIN_OPTION_MACHINE: "lab",
        };
        const { server } = await queue.webhookCommand(["--serve"], env, { tell: 200 });
        try {
          // The start's read sends once; the minute alone sends the rest, five in all.
          const end = Date.now() + 45_000;
          while (sent(dir).length < 5 && Date.now() < end)
            await new Promise((done) => setTimeout(done, 100));
          expect(sent(dir)).toHaveLength(5);
          await new Promise((done) => setTimeout(done, 1500));
          expect(sent(dir)).toHaveLength(5);
        } finally {
          await new Promise((done) => server.close(done));
          for (const key of Object.keys(set))
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
          vi.resetModules();
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it(
        "tries a note it could not send again, five times, and plans says so",
        { timeout: 60_000 },
        () => {
          const dir = project([]);
          writeFileSync(join(dir, "rows.json"), JSON.stringify([chat(dir, 111)]));
          writeFileSync(join(dir, "fail"), "");
          try {
            const could =
              "GitHub: Runs Assistant could not be sent plans/github/40.md: No agent named 'Runs' is reachable";
            expect(plansPath(dir, "github", "--inbox")).toContain(
              `${could}; tried again in a minute.\n`,
            );
            for (let i = 2; i <= 4; i++)
              expect(plansPath(dir, "github", "--inbox").trim()).toBe(
                `${could}; tried again in a minute.`,
              );
            expect(plansPath(dir, "github", "--inbox").trim()).toBe(`${could}; plans lists it.`);
            expect(plansPath(dir, "github", "--inbox").trim()).toBe("GitHub: nothing new.");
            expect(sent(dir)).toHaveLength(5);
            expect(plansPath(dir, "list")).toContain(
              "\n  plans/github/40.md, not sent: No agent named 'Runs' is reachable\n",
            );
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      );
    });
  });

  // plans/related-plans-share-a-pull-request-follow-up-5.md: issues need pull requests.
  describe("issues are read only with pull requests", () => {
    const body = "# Hook\n\n## Issues\n\nTopics here are GitHub issues.\n";
    it("an Issues heading with land: pull-request turns issues on, as before", () => {
      expect(hasIssues(body, "pull-request")).toBe(true);
    });
    it("an Issues heading without land: pull-request turns them off", () => {
      expect(hasIssues(body, "push")).toBe(false);
    });
    it("with land taken out by hand, plans prints no webhook line", () => {
      const dir = mkdtempSync(join(tmpdir(), "issues-off-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: dir });
        mkdirSync(join(dir, ".claude"));
        const file = (land: string) =>
          writeFileSync(
            join(dir, ".claude", "workflow.md"),
            `---\nname: Hook\nbranch: test\n${land}---\n\n## Issues\n\nTopics here are GitHub issues.\n`,
          );
        const list = () =>
          spawnSync("node", [join(here, "plan-queue.mjs"), "list"], {
            encoding: "utf8",
            env: {
              PATH: process.env.PATH || "",
              WORKFLOW_ROOT: dir,
              WORKFLOW_GH: "/bin/false",
              WORKFLOW_LIVE: "[]",
              CLAUDE_PLUGIN_OPTION_OWNER: "Javi",
              CLAUDE_PLUGIN_OPTION_MACHINE: "lab",
            },
          }).stdout;
        file("land: pull-request\n");
        expect(list()).toContain("The webhook: none; plans webhook starts it.");
        file("");
        expect(list()).not.toContain("The webhook");
        // A listener left running acts on no delivery once issues are off (Codex).
        mkdirSync(join(dir, ".claude", "github-inbox"));
        const body = JSON.stringify({
          action: "opened",
          issue: { number: 3, title: "T", labels: [] },
        });
        writeFileSync(
          join(dir, ".claude", "github-inbox", "d1.json"),
          JSON.stringify({ id: "d1", event: "issues", body }),
        );
        const inbox = () =>
          spawnSync("node", [join(here, "plan-queue.mjs"), "github", "--inbox"], {
            encoding: "utf8",
            env: { PATH: process.env.PATH || "", WORKFLOW_ROOT: dir, WORKFLOW_GH: "/bin/false" },
          }).stdout;
        expect(inbox()).toBe("GitHub: nothing new.\n");
        expect(existsSync(join(dir, ".claude", "github-seen.json"))).toBe(false);
        file("land: pull-request\n");
        inbox();
        expect(existsSync(join(dir, ".claude", "github-seen.json"))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("plans webhook", () => {
    let dir: string;
    let port: number;
    const env = () => ({
      PATH: process.env.PATH || "",
      WORKFLOW_ROOT: dir,
      WORKFLOW_WEBHOOK_SECRET: "s3cret",
      WORKFLOW_WEBHOOK_PORT: String(port),
      WORKFLOW_GH: "/bin/false",
      WORKFLOW_LIVE: "[]",
      CLAUDE_PLUGIN_OPTION_OWNER: "Javi",
      CLAUDE_PLUGIN_OPTION_MACHINE: "lab",
    });
    const plans = (...args: string[]) =>
      spawnSync("node", [join(here, "plan-queue.mjs"), ...args], { encoding: "utf8", env: env() });
    beforeAll(async () => {
      port = await freePort();
      dir = mkdtempSync(join(tmpdir(), "webhook-"));
      execFileSync("git", ["init", "-q"], { cwd: dir });
      mkdirSync(join(dir, ".claude"));
      writeFileSync(
        join(dir, ".claude", "workflow.md"),
        "---\nname: Hook\nbranch: test\nland: pull-request\n---\n\n## Issues\n\nTopics here are GitHub issues.\n",
      );
    });
    afterAll(() => {
      // With no folder (its setup failed), the stop would reach the working checkout.
      if (!dir) return;
      plans("webhook", "--stop");
      rmSync(dir, { recursive: true, force: true });
    });

    it("with no secret says what to turn on and runs nothing", () => {
      const done = spawnSync("node", [join(here, "plan-queue.mjs"), "webhook"], {
        encoding: "utf8",
        env: { ...env(), WORKFLOW_WEBHOOK_SECRET: "" },
      });
      expect(done.status).toBe(1);
      expect(done.stdout.trim()).toBe(
        "The project's Claude has no webhook secret here: turn the webhook on in the app's settings on GitHub, subscribed to the events Issues, Issue comment, Pull request, Pull request review, Pull request review comment and Workflow run, with the address routed to this container and a secret, and set WORKFLOW_WEBHOOK_SECRET and WORKFLOW_WEBHOOK_PORT where GH_TOKEN is set, or in the file WORKFLOW_SECRETS_FILE names.",
      );
      expect(existsSync(join(dir, ".claude", "webhook.json"))).toBe(false);
    });

    it("answers a signed POST 202 and keeps it, a bad one 401 with nothing, and stops", async () => {
      expect(plans("list").stdout).toContain("The webhook: none; plans webhook starts it.");
      expect(plans("webhook").stdout).toMatch(
        new RegExp(`^The webhook: listening on ${port} since \\d\\d:\\d\\d\\.\\n$`),
      );
      const body = JSON.stringify({
        action: "opened",
        issue: { number: 3, title: "T", labels: [] },
      });
      const post = (signature: string, id: string) =>
        fetch(`http://127.0.0.1:${port}/`, {
          method: "POST",
          body,
          headers: {
            "X-Hub-Signature-256": signature,
            "X-GitHub-Event": "issues",
            "X-GitHub-Delivery": id,
          },
        });
      expect((await post(sign("s3cret", body), "good-1")).status).toBe(202);
      expect(existsSync(join(dir, ".claude", "github-inbox", "good-1.json"))).toBe(true);
      expect((await post(sign("wrong", body), "bad-1")).status).toBe(401);
      expect(existsSync(join(dir, ".claude", "github-inbox", "bad-1.json"))).toBe(false);
      // A second one finds the first alive and says so.
      expect(plans("webhook").stdout).toMatch(
        /^The webhook: listening on \d+ since \d\d:\d\d, last delivery \d\d:\d\d\.\n$/,
      );
      expect(plans("list").stdout).toMatch(/\nThe webhook: listening on \d+ since/);
      const pid = JSON.parse(readFileSync(join(dir, ".claude", "webhook.json"), "utf8")).pid;
      expect(plans("webhook", "--stop").stdout.trim()).toBe("The webhook: stopped.");
      await new Promise((done) => setTimeout(done, 300));
      expect(() => process.kill(pid, 0)).toThrow();
    });

    // plans/webhook-stale-record.md: a record counts only when its port answers.
    const record = () => JSON.parse(readFileSync(join(dir, ".claude", "webhook.json"), "utf8"));

    it("replaces a record whose pid is alive but whose port answers nothing, and starts one", () => {
      // This test's own pid: alive, and nothing listens on the port yet.
      writeFileSync(
        join(dir, ".claude", "webhook.json"),
        JSON.stringify({ pid: process.pid, port, at: Date.now(), lastAt: 0 }),
      );
      const done = plans("webhook");
      expect(done.status).toBe(0);
      expect(done.stdout).toMatch(new RegExp(`^The webhook: listening on ${port} since `));
      expect(record().pid).not.toBe(process.pid);
      expect(plans("webhook", "--stop").stdout.trim()).toBe("The webhook: stopped.");
    });

    it("leaves a live listener on its port alone and says it listens", () => {
      expect(plans("webhook").status).toBe(0);
      const first = record().pid;
      const again = plans("webhook");
      expect(again.status).toBe(0);
      expect(again.stdout).toMatch(new RegExp(`^The webhook: listening on ${port} since `));
      expect(record().pid).toBe(first);
      expect(plans("webhook", "--stop").stdout.trim()).toBe("The webhook: stopped.");
    });

    // plans/checks-read-with-the-app.md, part 3: when a chat starts in a project whose listener
    // was started by an older copy, then that listener is stopped and this copy's takes its place.
    it("listenerOlder is true for no code or a lower one, false for an equal or higher", () => {
      expect(listenerOlder({ pid: 1, port: 1 }, 100)).toBe(true);
      expect(listenerOlder({ pid: 1, port: 1, code: 99 }, 100)).toBe(true);
      expect(listenerOlder({ pid: 1, port: 1, code: 100 }, 100)).toBe(false);
      expect(listenerOlder({ pid: 1, port: 1, code: 101 }, 100)).toBe(false);
    });

    it(
      "replaces a listener an older copy started, and leaves one of its own copy",
      { timeout: 30_000 },
      async () => {
        const code = statSync(join(here, "plan-queue.mjs")).mtimeMs;
        expect(plans("webhook").status).toBe(0);
        const first = record();
        expect(first.code).toBe(code);
        // Its own copy's: left, its pid unchanged.
        expect(plans("webhook").status).toBe(0);
        expect(record().pid).toBe(first.pid);
        // An older copy's, by a lower code: stopped, and another started with this copy's.
        writeFileSync(
          join(dir, ".claude", "webhook.json"),
          JSON.stringify({ ...first, code: code - 1000 }),
        );
        const again = plans("webhook");
        expect(again.status).toBe(0);
        expect(again.stdout).toMatch(new RegExp(`^The webhook: listening on ${port} since `));
        const second = record();
        expect(second.pid).not.toBe(first.pid);
        expect(second.code).toBe(code);
        await new Promise((done) => setTimeout(done, 300));
        expect(() => process.kill(first.pid, 0)).toThrow();
        // One with no code at all, as every listener before this copy wrote: replaced too.
        const { code: _drop, ...bare } = second;
        writeFileSync(join(dir, ".claude", "webhook.json"), JSON.stringify(bare));
        expect(plans("webhook").status).toBe(0);
        expect(record().pid).not.toBe(second.pid);
        expect(record().code).toBe(code);
        expect(plans("webhook", "--stop").stdout.trim()).toBe("The webhook: stopped.");
      },
    );

    it("exits 1 when no listener is up after the wait", async () => {
      // The port taken by another server, so the listener cannot bind it.
      const taken = createServer();
      await new Promise<void>((done) => taken.listen(port, "127.0.0.1", done));
      try {
        const done = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
          execFile(
            "node",
            [join(here, "plan-queue.mjs"), "webhook"],
            { encoding: "utf8", env: env() },
            (error, stdout) => resolve({ status: error ? (error.code as number) : 0, stdout }),
          );
        });
        expect(done.status).toBe(1);
        expect(done.stdout).toBe(`The webhook: none came up on ${port}.\n`);
        expect(existsSync(join(dir, ".claude", "webhook.json"))).toBe(false);
      } finally {
        await new Promise((done) => taken.close(done));
      }
    });

    // plans/open-assistant-reads-github-notes.md, part 4: when a listener starts after another
    // that last heard GitHub at a known time and stopped ten minutes before, then plans says that
    // last delivery and when none listened; with none alive, since when.
    it("keeps the last delivery and says when none listened", () => {
      const months =
        "January February March April May June July August September October November December".split(
          " ",
        );
      const at = (ms: number) => {
        const day = new Date(ms);
        const time = day.toTimeString().slice(0, 5);
        return day.toDateString() === new Date().toDateString()
          ? time
          : `${day.getDate()} ${months[day.getMonth()]} ${time}`;
      };
      const t0 = Date.now() - 15 * 60_000;
      const t1 = Date.now() - 10 * 60_000;
      writeFileSync(
        join(dir, ".claude", "webhook.last.json"),
        JSON.stringify({ lastAt: t0, aliveAt: t1 }),
      );
      expect(plans("list").stdout).toContain(
        `\nThe webhook: none since ${at(t1)}, last delivery ${at(t0)}; plans webhook starts it.\n`,
      );
      expect(plans("webhook").stdout).toMatch(
        new RegExp(
          `^The webhook: listening on ${port} since (\\d\\d:\\d\\d), last delivery ${at(t0)}; none listened from ${at(t1)} to \\1\\.\\n$`,
        ),
      );
      expect(plans("list").stdout).toContain(
        `, last delivery ${at(t0)}; none listened from ${at(t1)} to `,
      );
      expect(plans("webhook", "--stop").stdout.trim()).toBe("The webhook: stopped.");
      // Stopped, the history keeps the delivery and when it was last alive.
      expect(plans("list").stdout).toMatch(
        new RegExp(
          `\\nThe webhook: none since \\d\\d:\\d\\d, last delivery ${at(t0)}; plans webhook starts it\\.\\n`,
        ),
      );
    });
  });
});

// plans/app-old-registration-said.md: an app that cannot send a failed run is said once, and its
// listener reads them itself until it can.
describe("an app that sends no failed run", () => {
  const both = ["Actions read and write", "the Workflow run event"];
  const url = "https://github.com/settings/installations/7";
  const app = { where: "app" as const, what: both, slug: "docs-claude", repo: "o/r" };
  const installation = {
    where: "installation" as const,
    what: both,
    slug: "docs-claude",
    url,
    repo: "o/r",
  };

  it("webhookLine says it while it holds, and is unchanged without", () => {
    const record = { pid: 1, port: 8789, at: Date.now(), lastAt: 0 };
    expect(webhookLine(record)).toMatch(/^The webhook: listening on 8789 since \d\d:\d\d\.$/);
    expect(webhookLine({ ...record, lacks: app })).toMatch(
      /^The webhook: listening on 8789 since \d\d:\d\d; the app sends no failed run \(it lacks Actions read and write and the Workflow run event\), so they are read every five minutes\.$/,
    );
    expect(webhookLine({ ...record, lastAt: Date.now(), lacks: installation })).toMatch(
      /, last delivery \d\d:\d\d; the app sends no failed run \(its new permissions are not accepted\), so they are read every five minutes\.$/,
    );
  });

  // plans/checks-read-with-the-app.md, parts 1 and 2.
  it("unreadLines says a list or the checks GitHub would not give, and nothing without", () => {
    expect(unreadLines({})).toEqual([]);
    expect(unreadLines({ readAt: "2026-11-15T09:00:00.000Z", runs: [] })).toEqual([]);
    const at = "2026-11-15T09:12:00.000Z";
    const [read] = unreadLines({
      unread: {
        at,
        said: [
          "the open pull requests (GraphQL: Resource not accessible by personal access token)",
          "the runs of #132 and #118 (out of time)",
        ],
      },
    });
    expect(read).toMatch(
      /^GitHub: the read at \d\d:\d\d could not read the open pull requests \(GraphQL: Resource not accessible by personal access token\); the runs of #132 and #118 \(out of time\); plans github reads again\.$/,
    );
    const lines = unreadLines({
      checksUnread: {
        at: Date.parse(at),
        why: "GraphQL: Resource not accessible by personal access token",
      },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^GitHub: the pull requests' checks could not be read at \d\d:\d\d \(GraphQL: Resource not accessible by personal access token\), so the Stop hook names no failed check; GH_TOKEN needs Checks and Commit statuses read\.$/,
    );
  });

  it("appLine says what to add and where, it for one and them for two, or where to accept", () => {
    expect(appLine(app)).toBe(
      "The project's Claude is sent no failed run by GitHub: its app lacks Actions read and write and the Workflow run event. Add them on GitHub (Settings, Developer settings, GitHub Apps, docs-claude, Permissions & events) and accept the new permissions if GitHub asks. Until then failed runs are read every five minutes.",
    );
    expect(appLine({ ...app, what: ["the Workflow run event"] })).toBe(
      "The project's Claude is sent no failed run by GitHub: its app lacks the Workflow run event. Add it on GitHub (Settings, Developer settings, GitHub Apps, docs-claude, Permissions & events) and accept the new permissions if GitHub asks. Until then failed runs are read every five minutes.",
    );
    expect(appLine(installation)).toBe(
      "The project's Claude is sent no failed run by GitHub: its app's new permissions are not accepted on o/r yet. Accept them at https://github.com/settings/installations/7. Until then failed runs are read every five minutes.",
    );
  });

  describe("plans webhook --serve, in process", () => {
    const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
    const until = async (ok: () => boolean, ms = 20_000) => {
      const end = Date.now() + ms;
      while (!ok()) {
        if (Date.now() > end) throw new Error("timed out");
        await pause(50);
      }
    };
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const sha = "4f1c2b9a7e3d5c8b";
    let dir: string;
    let stub: string;
    // The queue's module with its root at `dir`: the root is read once, at import.
    const queueAt = async (root: string) => {
      const saved = process.env.WORKFLOW_ROOT;
      process.env.WORKFLOW_ROOT = root;
      vi.resetModules();
      try {
        return await import("../plugins/workflow/scripts/plan-queue.mjs");
      } finally {
        if (saved === undefined) delete process.env.WORKFLOW_ROOT;
        else process.env.WORKFLOW_ROOT = saved;
      }
    };
    const env = (port: number, extra: Record<string, string> = {}) => ({
      PATH: process.env.PATH || "",
      WORKFLOW_ROOT: dir,
      CLAUDE_PROJECT_DIR: dir,
      WORKFLOW_WEBHOOK_SECRET: "s3cret",
      WORKFLOW_WEBHOOK_PORT: String(port),
      WORKFLOW_GH: join(stub, "gh"),
      WORKFLOW_CLAUDE: join(stub, "claude"),
      STUB_ROWS: join(stub, "rows.json"),
      WORKFLOW_STARTS_LOG: join(stub, "starts.log"),
      WORKFLOW_USAGE_FILE: join(stub, "usage.json"),
      CLAUDE_PLUGIN_OPTION_OWNER: "Javi",
      CLAUDE_PLUGIN_OPTION_MACHINE: "lab",
      WORKFLOW_APP_ID: "1",
      WORKFLOW_APP_KEY: pem,
      ...extra,
    });
    // The block's folders, made anew for a retry.
    const setUp = () => {
      stub = mkdtempSync(join(tmpdir(), "app-lacks-stub-"));
      fakeClaude(stub);
      writeFileSync(
        join(stub, "gh"),
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_ROWS.replace("rows.json", "asked.log"), args.join(" ") + "\\n");
const say = (value) => process.stdout.write(JSON.stringify(value));
if (args[0] === "pr" && args.includes("open"))
  say([{ number: 40, title: "Series keep their order", url: "https://github.com/o/r/pull/40",
    headRefName: "series-order", headRefOid: "${sha}", comments: [], reviews: [] }]);
else if (args[0] === "run" && args[1] === "list")
  say([{ databaseId: 5, attempt: 1, status: "completed", conclusion: "failure", headSha: "${sha}",
    workflowName: "Checks", updatedAt: "2026-11-14T21:04:00Z", url: "https://github.com/o/r/actions/runs/5" }]);
else if (args[0] === "api" && /collaborators/.test(args[1])) process.stdout.write("write");
else say([]);
`,
      );
      chmodSync(join(stub, "claude"), 0o755);
      chmodSync(join(stub, "gh"), 0o755);
      dir = mkdtempSync(join(tmpdir(), "app-lacks-"));
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["remote", "add", "origin", "https://github.com/o/r.git"], { cwd: dir });
      mkdirSync(join(dir, ".claude"));
      mkdirSync(join(dir, "plans"));
      writeFileSync(
        join(dir, ".claude", "workflow.md"),
        "---\nname: Runs\nbranch: test\nland: pull-request\n---\n\n# Runs\n",
      );
      writeFileSync(
        join(dir, "plans", "series-order.md"),
        "# Series\n\nPlan only, 14 November 2026, for Javi.\n\n## Built, 14 November 2026\n\nPull request #40 (https://github.com/o/r/pull/40) to test from branch series-order, commit 4f1c2b9a; draft.\n",
      );
    };
    const tearDown = () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stub, { recursive: true, force: true });
    };
    beforeAll(setUp);
    afterAll(tearDown);

    // Timed: tried up to three times, since a load spike rarely lasts three tries.
    let tries = 0;
    it(
      "reads failed runs every period while the installation lacks them, and stops once it has them",
      { timeout: 60_000, retry: 2 },
      async () => {
        // A retry starts in folders of its own: nothing the try before it
        // wrote, or a child of it still running writes, is counted.
        if (tries++) {
          tearDown();
          setUp();
        }
        let has = false;
        const asked: string[] = [];
        const fetch = async (address: string) => {
          const path = new URL(address).pathname;
          asked.push(path);
          const granted = { permissions: { actions: "write" }, events: ["workflow_run"] };
          const body =
            path === "/app"
              ? { slug: "docs-claude", ...granted }
              : has
                ? { id: 7, html_url: url, ...granted }
                : { id: 7, html_url: url, permissions: { issues: "write" }, events: ["issues"] };
          return new Response(JSON.stringify(body), { status: 200 });
        };
        const port = await freePort();
        const queue = await queueAt(dir);
        const { server } = await queue.webhookCommand(["--serve"], env(port), { fetch, every: 50 });
        const record = () => JSON.parse(readFileSync(join(dir, ".claude", "webhook.json"), "utf8"));
        const told = join(dir, ".claude", "webhook.told.json");
        const log = join(stub, "asked.log");
        const runLists = () =>
          (existsSync(log) ? readFileSync(log, "utf8") : "")
            .split("\n")
            .filter((line) => line.startsWith("run list")).length;
        try {
          await until(() => existsSync(join(dir, ".claude", "webhook.json")) && record().lacks);
          expect(record().lacks).toEqual({ ...installation, repo: "o/r" });
          expect(queue.webhookLine(record())).toContain(
            "; the app sends no failed run (its new permissions are not accepted), so they are read every five minutes.",
          );
          // The read at the start, then the timer's: run list asked again.
          await until(() => runLists() >= 2);
          await until(() => existsSync(join(dir, "plans", "github", "40.md")));
          expect(readFileSync(join(dir, "plans", "github", "40.md"), "utf8")).toContain(
            "Checks run 5 on 4f1c2b9a: https://github.com/o/r/actions/runs/5",
          );
          await until(() => JSON.parse(readFileSync(join(stub, "rows.json"), "utf8")).length > 0);
          expect(JSON.parse(readFileSync(join(stub, "rows.json"), "utf8"))[0].name).toBe(
            "Runs Assistant",
          );
          // The app gains them: lacks and the told file go, and nothing more is asked or read.
          writeFileSync(told, JSON.stringify({ told: "installation: x", at: 1 }));
          has = true;
          await until(() => !record().lacks);
          expect(existsSync(told)).toBe(false);
          await pause(2000);
          const [calls, reads] = [asked.length, runLists()];
          await pause(600);
          expect([asked.length, runLists()]).toEqual([calls, reads]);
        } finally {
          await new Promise((done) => server!.close(done));
        }
      },
    );

    // Codex: what the app has unknown is read for anyway; pull requests off end the reads.
    it(
      "reads while GitHub's answer fails, and stops once pull requests are off",
      { timeout: 60_000, retry: 2 },
      async () => {
        let calls = 0;
        const fetch = async () => {
          calls += 1;
          return new Response(JSON.stringify({ message: "Server Error" }), { status: 500 });
        };
        const port = await freePort();
        const file = join(dir, ".claude", "workflow.md");
        const kept = readFileSync(file, "utf8");
        const log = join(stub, "asked.log");
        rmSync(log, { force: true });
        rmSync(join(dir, ".claude", "webhook.json"), { force: true });
        const runLists = () =>
          (existsSync(log) ? readFileSync(log, "utf8") : "")
            .split("\n")
            .filter((line) => line.startsWith("run list")).length;
        const queue = await queueAt(dir);
        const { server } = await queue.webhookCommand(["--serve"], env(port), { fetch, every: 50 });
        try {
          await until(() => runLists() >= 2);
          expect(JSON.parse(readFileSync(join(dir, ".claude", "webhook.json"), "utf8")).lacks).toBe(
            undefined,
          );
          writeFileSync(file, kept.replace("land: pull-request\n", ""));
          await pause(2000);
          const [asked, reads] = [calls, runLists()];
          await pause(600);
          expect([calls, runLists()]).toEqual([asked, reads]);
        } finally {
          writeFileSync(file, kept);
          await new Promise((done) => server!.close(done));
        }
      },
    );

    it("with no app id asks GitHub nothing and runs no timer", { timeout: 20_000 }, async () => {
      let calls = 0;
      const fetch = async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      };
      const port = await freePort();
      rmSync(join(dir, ".claude", "webhook.json"), { force: true });
      const queue = await queueAt(dir);
      const { server } = await queue.webhookCommand(
        ["--serve"],
        env(port, { WORKFLOW_APP_ID: "" }),
        { fetch, every: 50 },
      );
      try {
        await until(() => existsSync(join(dir, ".claude", "webhook.json")));
        await pause(500);
        expect(calls).toBe(0);
        expect(JSON.parse(readFileSync(join(dir, ".claude", "webhook.json"), "utf8")).lacks).toBe(
          undefined,
        );
      } finally {
        await new Promise((done) => server!.close(done));
      }
    });
  });
});

// plans/adaptive-reuse.md, part 1: the inputs measured into a cached summary.
describe("the reuse inputs are cached", () => {
  const session = (agent: string, start: number, turns: number) =>
    [
      JSON.stringify({ type: "agent-setting", agentSetting: `workflow:${agent}` }),
      ...Array.from({ length: turns }, (_, i) =>
        JSON.stringify({
          type: "assistant",
          timestamp: `2026-11-0${1 + i}T10:00:00Z`,
          message: {
            id: `m${i}`,
            model: "claude-opus-5-5",
            usage: {
              input_tokens: 0,
              cache_creation_input_tokens: start + i * 1000,
              output_tokens: 1,
            },
          },
        }),
      ),
      "",
    ].join("\n");

  it("from a hook with no summary reads no transcript, and the ceiling is the default, said so", () => {
    const base = mkdtempSync(join(tmpdir(), "reuse-"));
    try {
      const dir = join(base, "-checkout");
      mkdirSync(dir);
      for (const name of ["a", "b", "c", "d", "e"])
        writeFileSync(join(dir, `${name}.jsonl`), session("executor", 50_000, 3));
      const file = join(base, "reuse", "-checkout.json");
      const reads: string[] = [];
      const read = (path: string) => {
        reads.push(path);
        return measureFile(path);
      };
      for (const mode of ["prompt", "tool", "stop", "wrote"]) {
        const cachedOnly = hookRun(["node", "plan-queue.mjs", mode]);
        expect(cachedOnly).toBe(true);
        const inputs = reuseInputs({ cachedOnly, dir, file, read });
        expect(inputs).toEqual({});
        const verdict = ceilingFor({ kind: "executor", inputs });
        expect(verdict.history).toBe(false);
        expect(verdict.why).toBe("the ceiling of 200k (no history yet: today's numbers)");
      }
      expect(reads).toEqual([]);
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("from a hook takes a summary older than the hour as it is and reads nothing", () => {
    const base = mkdtempSync(join(tmpdir(), "reuse-"));
    try {
      const dir = join(base, "-checkout");
      mkdirSync(dir);
      writeFileSync(join(dir, "a.jsonl"), session("planner", 30_000, 3));
      const file = join(base, "reuse", "-checkout.json");
      const t0 = Date.parse("2026-11-06T12:00:00Z");
      const measured = reuseInputs({ refresh: true, now: t0, dir, file, read: measureFile });
      writeFileSync(join(dir, "a.jsonl"), session("planner", 30_000, 6));
      writeFileSync(join(dir, "b.jsonl"), session("planner", 40_000, 3));
      let reads = 0;
      const inputs = reuseInputs({
        cachedOnly: hookRun(["node", "plan-queue.mjs", "stop"]),
        now: t0 + 3 * REUSE_REFRESH,
        dir,
        file,
        read: () => (reads++, null),
      });
      expect(reads).toBe(0);
      expect(inputs).toEqual(measured);
      expect(JSON.parse(readFileSync(file, "utf8")).measuredAt).toBe(t0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("plans and plans start from the command line measure an hour-old summary and write it", () => {
    for (const mode of [undefined, "list", "start", "cost"])
      expect(hookRun(["node", "plan-queue.mjs", ...(mode ? [mode] : [])])).toBe(false);
    const base = mkdtempSync(join(tmpdir(), "reuse-"));
    try {
      const dir = join(base, "-checkout");
      mkdirSync(dir);
      writeFileSync(join(dir, "a.jsonl"), session("planner", 30_000, 3));
      const file = join(base, "reuse", "-checkout.json");
      const t0 = Date.parse("2026-11-06T12:00:00Z");
      reuseInputs({ refresh: true, now: t0, dir, file, read: measureFile });
      writeFileSync(join(dir, "b.jsonl"), session("planner", 40_000, 3));
      const reads: string[] = [];
      const read = (path: string) => (reads.push(basename(path)), measureFile(path));
      const now = t0 + REUSE_REFRESH + 1;
      const inputs = reuseInputs({
        cachedOnly: hookRun(["node", "x", "start"]),
        now,
        dir,
        file,
        read,
      });
      expect(reads).toEqual(["b.jsonl"]);
      expect(inputs.planner?.sessions).toBe(2);
      expect(JSON.parse(readFileSync(file, "utf8")).measuredAt).toBe(now);

      // `plans` itself, run as the command is: the summary written under the data folder.
      const checkout = join(base, "checkout");
      mkdirSync(join(checkout, ".claude"), { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: checkout });
      writeFileSync(join(checkout, ".claude", "workflow.md"), "---\nname: Docs\n---\n");
      const projects = join(base, "projects");
      const folder = join(projects, checkout.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "a.jsonl"), session("planner", 30_000, 3));
      const data = join(base, "data");
      const env = {
        ...process.env,
        WORKFLOW_ROOT: checkout,
        CLAUDE_PROJECT_DIR: checkout,
        WORKFLOW_PROJECTS: projects,
        WORKFLOW_DATA: data,
        WORKFLOW_LIVE: "[]",
      };
      execFileSync("node", [join(here, "plan-queue.mjs")], {
        cwd: checkout,
        env,
        encoding: "utf8",
      });
      const summary = JSON.parse(
        readFileSync(join(data, "reuse", `${basename(folder)}.json`), "utf8"),
      );
      expect(Object.keys(summary.rows)).toEqual(["a"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  describe("a hook refreshes the summary in the background", () => {
    const t0 = Date.parse("2026-11-06T12:00:00Z");
    const setUp = () => {
      const base = mkdtempSync(join(tmpdir(), "reuse-"));
      const dir = join(base, "-checkout");
      mkdirSync(dir);
      writeFileSync(join(dir, "a.jsonl"), session("planner", 30_000, 3));
      const file = join(base, "reuse", "-checkout.json");
      const spawned: string[][] = [];
      let reads = 0;
      /** One hook's read, at `now`, as `reuseNow` makes it with a stub spawner. */
      const hookAt = (now: number) =>
        reuseInputs({
          cachedOnly: hookRun(["node", "plan-queue.mjs", "stop"]),
          now,
          dir,
          file,
          read: () => (reads++, null),
          stale: (summary: string) =>
            refreshLater(summary, {
              now,
              spawner: (_bin: string, args: string[]) => spawned.push(args),
            }),
        });
      return { base, dir, file, spawned, reads: () => reads, hookAt };
    };

    it("with no summary, or one an hour old, starts one plans cost and goes on with what it holds", () => {
      const none = setUp();
      try {
        expect(none.hookAt(t0)).toEqual({});
        expect(none.spawned).toHaveLength(1);
        expect(none.spawned[0].slice(-2)).toEqual(["cost", "--summary"]);
        expect(none.spawned[0][0]).toMatch(/plan-queue\.mjs$/);
        expect(none.reads()).toBe(0);
        expect(existsSync(none.file.replace(/\.json$/, ".refreshing"))).toBe(true);
      } finally {
        rmSync(none.base, { recursive: true, force: true });
      }
      const old = setUp();
      try {
        const measured = reuseInputs({ refresh: true, now: t0, dir: old.dir, file: old.file });
        expect(old.hookAt(t0 + REUSE_REFRESH)).toEqual(measured);
        expect(old.spawned).toHaveLength(1);
        expect(old.reads()).toBe(0);
      } finally {
        rmSync(old.base, { recursive: true, force: true });
      }
    });

    it("plans cost --summary refreshes the reuse inputs alone and prints nothing", () => {
      const calls: string[] = [];
      const printed: string[] = [];
      costCommand(["--summary"], {
        measureAll: () => (calls.push("measure"), []),
        refreshInputs: (opts: { refresh?: boolean }) => (
          calls.push(`reuseInputs refresh=${opts.refresh}`),
          {}
        ),
        write: (text: string) => printed.push(text),
      });
      expect(calls).toEqual(["reuseInputs refresh=true"]);
      expect(printed).toEqual([]);
    });

    it("two hooks at once start one refresh", () => {
      const run = setUp();
      try {
        // The first hook's marker is created; the second, at the same moment, finds it.
        run.hookAt(t0);
        run.hookAt(t0);
        expect(run.spawned).toHaveLength(1);
      } finally {
        rmSync(run.base, { recursive: true, force: true });
      }
    });

    it("a marker under an hour old starts nothing, the summary still old; one an hour old starts again", () => {
      const run = setUp();
      try {
        run.hookAt(t0);
        run.hookAt(t0 + REUSE_REFRESH - 1);
        expect(run.spawned).toHaveLength(1);
        expect(existsSync(run.file)).toBe(false);
        run.hookAt(t0 + REUSE_REFRESH);
        expect(run.spawned).toHaveLength(2);
        const marker = run.file.replace(/\.json$/, ".refreshing");
        expect(readFileSync(marker, "utf8")).toBe(String(t0 + REUSE_REFRESH));
        expect(readdirSync(dirname(marker))).toEqual(["-checkout.refreshing"]);
      } finally {
        rmSync(run.base, { recursive: true, force: true });
      }
    });

    it("with a summary under the hour, starts nothing", () => {
      const run = setUp();
      try {
        reuseInputs({ refresh: true, now: t0, dir: run.dir, file: run.file });
        run.hookAt(t0 + REUSE_REFRESH - 1);
        expect(run.spawned).toEqual([]);
        expect(run.reads()).toBe(0);
      } finally {
        rmSync(run.base, { recursive: true, force: true });
      }
    });
  });

  it("keeps a changed transcript's row when it cannot be read", () => {
    const base = mkdtempSync(join(tmpdir(), "reuse-"));
    try {
      const dir = join(base, "-checkout");
      mkdirSync(dir);
      writeFileSync(join(dir, "a.jsonl"), session("executor", 50_000, 3));
      const file = join(base, "reuse", "-checkout.json");
      const t0 = Date.parse("2026-11-06T12:00:00Z");
      const first = reuseInputs({ refresh: true, now: t0, dir, file, read: measureFile });
      expect(first.executor?.sessions).toBe(1);
      const kept = JSON.parse(readFileSync(file, "utf8")).rows.a;
      writeFileSync(join(dir, "a.jsonl"), session("executor", 50_000, 5));
      const after = reuseInputs({ refresh: true, now: t0 + 1000, dir, file, read: () => null });
      expect(after.executor).toEqual(first.executor);
      // Its old stat too, so the next refresh reads the transcript again.
      expect(JSON.parse(readFileSync(file, "utf8")).rows).toEqual({ a: kept });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("measures each transcript once, then only the changed, and a hook within the hour none", () => {
    const base = mkdtempSync(join(tmpdir(), "reuse-"));
    try {
      const dir = join(base, "-checkout");
      mkdirSync(dir);
      writeFileSync(join(dir, "a.jsonl"), session("planner", 30_000, 3));
      writeFileSync(join(dir, "b.jsonl"), session("planner", 40_000, 5));
      writeFileSync(join(dir, "c.jsonl"), session("executor", 50_000, 2));
      const file = join(base, "reuse", "-checkout.json");
      let reads: string[] = [];
      const read = (path: string) => {
        reads.push(basename(path));
        return measureFile(path);
      };
      const t0 = Date.parse("2026-11-06T12:00:00Z");
      const inputs = reuseInputs({ refresh: true, now: t0, dir, file, read });
      expect(reads.sort()).toEqual(["a.jsonl", "b.jsonl", "c.jsonl"]);
      const summary = JSON.parse(readFileSync(file, "utf8"));
      expect(Object.keys(summary.rows).sort()).toEqual(["a", "b", "c"]);
      for (const key of [
        "id",
        "mtime",
        "size",
        "agent",
        "model",
        "turns",
        "startContext",
        "endContext",
      ])
        expect(summary.rows.a).toHaveProperty(key);
      expect(summary.measuredAt).toBe(t0);
      expect(inputs.planner).toEqual({
        sessions: 2,
        start: 35_000,
        turns: 4,
        model: "claude-opus-5-5",
      });
      expect(inputs.executor).toEqual({
        sessions: 1,
        start: 50_000,
        turns: 2,
        model: "claude-opus-5-5",
      });
      expect(summary.inputs).toEqual(inputs);

      // Nothing changed: a stat per file, no transcript read.
      reads = [];
      reuseInputs({ refresh: true, now: t0 + 1000, dir, file, read });
      expect(reads).toEqual([]);

      // One grown: it alone is read again.
      writeFileSync(join(dir, "b.jsonl"), session("planner", 40_000, 7));
      reads = [];
      // From a hook within the hour of measuredAt: none read, even with b changed.
      expect(reuseInputs({ now: t0 + 30 * 60_000, dir, file, read })).toEqual(
        JSON.parse(readFileSync(file, "utf8")).inputs,
      );
      expect(reads).toEqual([]);
      // plans cost refreshes: b alone.
      const after = reuseInputs({ refresh: true, now: t0 + 31 * 60_000, dir, file, read });
      expect(reads).toEqual(["b.jsonl"]);
      expect(after.planner.turns).toBe(5);
      // A hook past the hour measures too.
      writeFileSync(join(dir, "c.jsonl"), session("executor", 50_000, 4));
      reads = [];
      reuseInputs({ now: t0 + 120 * 60_000, dir, file, read });
      expect(reads).toEqual(["c.jsonl"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("gives no inputs for a missing folder", () => {
    const base = mkdtempSync(join(tmpdir(), "reuse-"));
    try {
      expect(
        reuseInputs({ refresh: true, dir: join(base, "none"), file: join(base, "r.json") }),
      ).toEqual({});
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

/**
 * **Ready plans never wait with no executor** (plans/executor-takes-next-
 * ready-plan.md, part 2): a planner's or an assistant's stop, or the end
 * timer, starts one when plans are ready and none is alive, under the cheap
 * gate and the marker. A stub \`claude\` stands in: \`agents --json\` from a
 * file, \`--bg\` adds its row, and every call is logged, so a gate that reads
 * no sessions is seen to read none.
 */
describe("ready plans reach an executor", () => {
  const project = (name: string) => {
    const dir = mkdtempSync(join(tmpdir(), `queue-net-${name.toLowerCase()}-`));
    made.push(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    withOrigin(dir);
    mkdirSync(join(dir, ".claude"));
    mkdirSync(join(dir, "plans"));
    writeFileSync(join(dir, ".claude", "workflow.md"), `---\nname: ${name}\nbranch: test\n---\n`);
    for (const x of ["a", "b"])
      writeFileSync(
        join(dir, "plans", `${x}.md`),
        `# ${x}\n\nPlan only, 6 November 2026, for Javi.\n`,
      );
    const rows = join(dir, "rows.json");
    const calls = join(dir, "calls.log");
    const script = fakeClaude(dir, { prefix: "net", calls });
    const starts = join(dir, ".claude", "starts.log");
    const { WORKFLOW_LIVE: _, ...rest } = process.env;
    const env = {
      ...rest,
      CLAUDE_PROJECT_DIR: dir,
      WORKFLOW_ROOT: dir,
      WORKFLOW_CLAUDE: script,
      WORKFLOW_STARTS_LOG: starts,
      WORKFLOW_USAGE_FILE: join(dir, ".claude", "usage.json"),
    };
    const queue = (args: string[], input: object = {}, extra: Record<string, string> = {}) =>
      execFileSync("node", [join(here, "plan-queue.mjs"), ...args], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: { ...env, ...extra },
      });
    const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
    return {
      dir,
      rows,
      queue,
      calls: () => read(calls),
      started: () =>
        read(starts)
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
    };
  };
  const ownerStop = { session_id: "a0000000-0000-0000-0000-000000000000", agent_type: "assistant" };
  const why = "Plans were ready and no executor was alive.";

  it("a planner's stop with nothing of its own to do starts one", { timeout: 30_000 }, () => {
    const net = project("Plain");
    const id = "p7000000-0000-0000-0000-000000000000";
    writeFileSync(stateFile(id), JSON.stringify({ agent: "planner", plans: ["plans/a.md"] }));
    try {
      const said = net.queue(["stop"], { session_id: id, agent_type: "planner" });
      expect(JSON.parse(said).hookSpecificOutput.additionalContext).toContain(
        "Plain Executor 1 (lab) was started on: plans/a.md, in executor-1.",
      );
      expect(net.started()).toEqual([
        expect.objectContaining({
          name: "Plain Executor 1 (lab)",
          paths: ["plans/a.md"],
          why,
        }),
      ]);
      expect(existsSync(join(net.dir, ".claude", "executor.starting"))).toBe(false);
    } finally {
      rmSync(stateFile(id), { force: true });
    }
  });

  it("the owner's own assistant chat's stop starts one", { timeout: 30_000 }, () => {
    const net = project("Owner");
    const said = net.queue(["stop"], ownerStop);
    expect(JSON.parse(said).hookSpecificOutput.additionalContext).toContain(
      "Owner Executor 1 (lab) was started on: plans/a.md, in executor-1.",
    );
    expect(net.started()).toEqual([expect.objectContaining({ why })]);
  });

  it(
    "the end timer ending an idle executor with a ready plan starts one",
    { timeout: 30_000 },
    () => {
      const net = project("Timer");
      const exec = "e7000000-0000-0000-0000-000000000000";
      writeFileSync(
        net.rows,
        JSON.stringify([
          {
            sessionId: exec,
            id: "bg-t",
            name: "Timer Executor 1 (lab)",
            kind: "background",
            state: "done",
            status: "idle",
            cwd: net.dir,
          },
        ]),
      );
      writeFileSync(
        join(net.dir, ".claude", "executor.1.lock"),
        JSON.stringify({ sessionId: exec, pid: process.pid, released: false }),
      );
      try {
        expect(net.queue(["end", "--timer", String(Date.now() - 1), exec])).toBe("");
        expect(net.started()).toEqual([
          expect.objectContaining({
            name: "Timer Executor 2 (lab)",
            paths: ["plans/a.md"],
            why,
          }),
        ]);
      } finally {
        rmSync(stateFile(exec), { force: true });
      }
    },
  );

  // Codex C1 to C3 and the plan review: a stale marker is reclaimed, a lock
  // with no pid and a dead session's Building line are judged by the
  // sessions, and a stop where nothing was waiting after all says nothing.
  it(
    "reclaims a stale marker, and judges a pid-less lock and a dead session's Building line by the sessions",
    { timeout: 60_000 },
    () => {
      const stale = project("Stale");
      const marker = join(stale.dir, ".claude", "executor.starting");
      writeFileSync(marker, `${Date.now() - 3 * 60_000} 1`);
      expect(stale.queue(["stop"], ownerStop)).toContain("Stale Executor 1 (lab) was started on");
      expect(existsSync(marker)).toBe(false);

      const pidless = project("Pidless");
      writeFileSync(
        join(pidless.dir, ".claude", "executor.1.lock"),
        JSON.stringify({ sessionId: "gone", pid: null, released: false }),
      );
      expect(pidless.queue(["stop"], ownerStop)).toContain(
        "Pidless Executor 1 (lab) was started on",
      );

      const dead = project("Dead");
      for (const x of ["a", "b"]) rmSync(join(dead.dir, "plans", `${x}.md`));
      const building = (id: string) =>
        `# A\n\n## Building, 6 November 2026, session ${id}\n\nPlan only, 6 November 2026, for Javi.\n`;
      writeFileSync(join(dead.dir, "plans", "a.md"), building("d0000000-dead"));
      expect(dead.queue(["stop"], ownerStop)).toContain(
        "Dead Executor 1 (lab) was started on: plans/a.md, in executor-1.",
      );

      // The Building line's session alive, with the lock released: nothing waits, nothing is said.
      const alive = project("Alive");
      for (const x of ["a", "b"]) rmSync(join(alive.dir, "plans", `${x}.md`));
      writeFileSync(join(alive.dir, "plans", "a.md"), building("b0000000-live"));
      writeFileSync(
        alive.rows,
        JSON.stringify([
          {
            sessionId: "b0000000-live",
            name: "Alive Executor 1 (lab)",
            kind: "background",
            status: "busy",
            cwd: alive.dir,
          },
        ]),
      );
      expect(alive.queue(["stop"], ownerStop)).toBe("");
      expect(alive.started()).toEqual([]);
    },
  );

  it("starts nothing and reads no sessions beside a live lock, paused, while another hook starts one, deferred or asking", () => {
    const net = project("Held");
    const lock = join(net.dir, ".claude", "executor.1.lock");
    writeFileSync(lock, JSON.stringify({ sessionId: "live", pid: process.pid, released: false }));
    expect(net.queue(["stop"], ownerStop)).toBe("");
    rmSync(lock);
    const pause = join(net.dir, ".claude", "executor.pause");
    writeFileSync(pause, JSON.stringify({ at: "23:10" }));
    expect(net.queue(["stop"], ownerStop)).toBe("");
    rmSync(pause);
    const marker = join(net.dir, ".claude", "executor.starting");
    writeFileSync(marker, String(Date.now() - 60_000));
    expect(net.queue(["stop"], ownerStop)).toBe("");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    // A start already deferred to the reset, and plans whose planner is asking (/code-review).
    const deferred = join(net.dir, ".claude", "executor.deferred");
    writeFileSync(deferred, JSON.stringify({ until: Date.now() + 60 * 60_000, pid: 1, paths: [] }));
    expect(net.queue(["stop"], ownerStop)).toBe("");
    rmSync(deferred);
    writeFileSync(
      join(net.dir, ".claude", "asking.deferred"),
      JSON.stringify({
        until: Date.now() + 30 * 60_000,
        pid: null,
        paths: ["plans/a.md", "plans/b.md"],
      }),
    );
    expect(net.queue(["stop"], ownerStop)).toBe("");
    expect(net.calls()).toBe("");
    expect(net.started()).toEqual([]);
  });
});

// plans/priority-queue.md: the owner puts a plan first, and the executor builds it next.
describe("a plan put first, in a project", () => {
  const ids = {
    exec: "f1000000-0000-0000-0000-000000000000",
    planner: "f2000000-0000-0000-0000-000000000000",
    other: "f3000000-0000-0000-0000-000000000000",
  };
  const execRow = {
    sessionId: ids.exec,
    name: "First Executor 1",
    kind: "background",
    status: "busy",
    state: "working",
  };
  let dir: string;
  let projects: string;
  const env = (rows: object[] | null) => ({
    ...process.env,
    CLAUDE_PROJECT_DIR: dir,
    WORKFLOW_ROOT: dir,
    WORKFLOW_PROJECTS: projects,
    WORKFLOW_STARTS_LOG: join(dir, ".claude", "starts.log"),
    WORKFLOW_USAGE_FILE: join(dir, ".claude", "usage.json"),
    WORKFLOW_LIVE:
      rows === null ? "null" : JSON.stringify(rows.map((one) => ({ ...one, cwd: dir }))),
  });
  const run = (args: string[], input: object = {}, rows: object[] | null = []) =>
    spawnSync("node", [join(here, "plan-queue.mjs"), ...args], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: env(rows),
    });
  const queue = (args: string[], input: object = {}, rows: object[] | null = []) =>
    run(args, input, rows).stdout;
  const file = (name: string) => join(dir, "plans", name);
  const plan = (day: string, extra = "") =>
    `# P\n\nPlan only, ${day}, for Javi; the executor builds it.\n\n${extra}## What was asked\n\nA change.\n`;
  /** The queue as each case starts it: a.md of 12 November, b.md and c.md of 13 November. */
  const reset = () => {
    rmSync(join(dir, "plans"), { recursive: true, force: true });
    mkdirSync(join(dir, "plans"));
    writeFileSync(file("a.md"), plan("12 November 2026"));
    writeFileSync(file("b.md"), plan("13 November 2026"));
    for (const id of Object.values(ids)) rmSync(stateFile(id), { force: true });
  };
  const rows = (out: string, title: string) => {
    const at = out.indexOf(`\n${title}\n`);
    if (at < 0) return [];
    const block = out.slice(at + title.length + 2).split("\n\n")[0];
    return block.split("\n").filter((line) => line.startsWith("  "));
  };
  const SINCE = /first since \d{1,2} [A-Z][a-z]+ \d{2}:\d{2}/;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "first-"));
    projects = mkdtempSync(join(tmpdir(), "first-projects-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "workflow.md"), "---\nname: First\nbranch: test\n---\n");
  });
  afterAll(() => {
    for (const id of Object.values(ids)) rmSync(stateFile(id), { force: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(projects, { recursive: true, force: true });
  });

  it("plans first puts a ready plan at the top and says since when", () => {
    reset();
    const before = statSync(file("b.md"));
    const said = run(["first", "plans/b.md"]);
    expect(said.status).toBe(0);
    expect(said.stdout).toMatch(
      /^plans\/b\.md is first since \d{1,2} [A-Z][a-z]+ \d{2}:\d{2}: plans lists it at the top, and it is taken next, after the work in hand\.\n$/,
    );
    const after = statSync(file("b.md"));
    const text = readFileSync(file("b.md"), "utf8");
    expect(text).toMatch(
      /builds it\.\n\nFirst: \d{1,2} [A-Z][a-z]+ \d{4} \d{2}:\d{2}:\d{2}\.\n\n## What was asked/,
    );
    expect(Math.round(after.mtimeMs)).toBe(Math.round(before.mtimeMs));
    expect(Math.round(after.atimeMs)).toBe(Math.round(before.atimeMs));
    const listed = queue(["list"]);
    expect(listed).not.toContain("Ready, oldest first");
    const ready = rows(listed, "Ready, put first, then oldest first");
    expect(ready[0]).toMatch(/^ {2}plans\/b\.md +Plan only, 13 November, first since /);
    expect(ready[0]).toMatch(SINCE);
    expect(ready[1]).toMatch(/^ {2}plans\/a\.md +Plan only, 12 November$/);
    // Run again, the line is replaced, not doubled.
    run(["first", "plans/b.md"]);
    expect(readFileSync(file("b.md"), "utf8").match(/^First:/gm)).toHaveLength(1);
    // A path in any shape the start reads.
    expect(run(["first", "./plans/a.md"]).stdout).toMatch(/^plans\/a\.md is first since/);
  });

  it("plans first writes under a plan's own header, below a brief's line kept above it", () => {
    reset();
    // The brief's paragraph kept above the plan's header, which is on line 11.
    const kept =
      "# P\n\nBrief for the planner, 12 November 2026, by Workflow Assistant 6 from\nplans/x.md, a paragraph the planner kept above its plan's header, wrapped\nover\nseven\nlines\nof\nprose.\n\nPlan only, 13 November 2026, for Javi; the executor builds it.\n\n## What was asked\n\nA change.\n";
    expect(kept.split("\n")[10]).toMatch(/^Plan only, /);
    writeFileSync(file("b.md"), kept);
    expect(run(["first", "plans/b.md"]).status).toBe(0);
    const text = readFileSync(file("b.md"), "utf8");
    expect(text).toMatch(
      /builds it\.\n\nFirst: \d{1,2} [A-Z][a-z]+ \d{4} \d{2}:\d{2}:\d{2}\.\n\n## What was asked/,
    );
    const ready = rows(queue(["list"]), "Ready, put first, then oldest first");
    expect(ready[0]).toMatch(/^ {2}plans\/b\.md +Plan only, 13 November, first since /);
    expect(run(["first", "--undo", "plans/b.md"]).status).toBe(0);
    expect(readFileSync(file("b.md"), "utf8")).toBe(kept);
  });

  it("plans first writes above a section the header sits under (plans/put-first-review-fixes-follow-up.md)", () => {
    reset();
    // The header on line 7, under a `## ` section of its own.
    const under =
      "# P\n\n## Context\n\nA note kept above the header.\n\nPlan only, 13 November 2026, for Javi; the executor builds it.\n\n## What was asked\n\nA change.\n";
    expect(under.split("\n")[6]).toMatch(/^Plan only, /);
    writeFileSync(file("b.md"), under);
    expect(run(["first", "plans/b.md"]).status).toBe(0);
    expect(readFileSync(file("b.md"), "utf8")).toMatch(
      /^# P\n\nFirst: \d{1,2} [A-Z][a-z]+ \d{4} \d{2}:\d{2}:\d{2}\.\n\n## Context\n/,
    );
    const listed = queue(["list"]);
    expect(listed).not.toContain("First line not read");
    const ready = rows(listed, "Ready, put first, then oldest first");
    expect(ready[0]).toMatch(/^ {2}plans\/b\.md +Plan only, 13 November, first since /);
    expect(run(["first", "--undo", "plans/b.md"]).status).toBe(0);
    expect(readFileSync(file("b.md"), "utf8")).toBe(under);
    // The header on line 12, the last the queue reads it on: the two lines
    // written above it do not push it out (Codex C1).
    const edge = under.replace(
      "A note kept above the header.\n",
      "A\nnote\nkept\nabove\nthe\nheader.\n",
    );
    expect(edge.split("\n")[11]).toMatch(/^Plan only, /);
    writeFileSync(file("b.md"), edge);
    expect(run(["first", "plans/b.md"]).status).toBe(0);
    const ready12 = rows(queue(["list"]), "Ready, put first, then oldest first");
    expect(ready12[0]).toMatch(/^ {2}plans\/b\.md +Plan only, 13 November, first since /);
    expect(run(["first", "--undo", "plans/b.md"]).status).toBe(0);
    expect(readFileSync(file("b.md"), "utf8")).toBe(edge);
  });

  it("a First line on a day the calendar does not have is not read", () => {
    reset();
    for (const day of ["31 February 2026 10:00", "2026-02-31"]) {
      writeFileSync(file("b.md"), plan("13 November 2026", `First: ${day}.\n\n`));
      const listed = queue(["list"]);
      expect(listed, day).toContain("\nFirst line not read: plans/b.md\n");
      expect(listed, day).toContain("\nReady, oldest first\n");
      expect(listed, day).not.toContain("first since");
    }
  });

  it("the latest put first is on top", () => {
    reset();
    writeFileSync(file("c.md"), plan("13 November 2026"));
    writeFileSync(file("b.md"), plan("13 November 2026", "First: 1 January 2026 09:00:00.\n\n"));
    expect(run(["first", "plans/c.md"]).status).toBe(0);
    const ready = rows(queue(["list"]), "Ready, put first, then oldest first");
    expect(ready.map((line) => line.trim().split(/\s+/)[0])).toEqual([
      "plans/c.md",
      "plans/b.md",
      "plans/a.md",
    ]);
    expect(ready[1]).toContain("first since 1 January 09:00");
  });

  it("a mark within the same second as another is still the later (Codex C3)", () => {
    reset();
    // Another plan marked a minute ahead of the clock: the next mark goes a second past it.
    const ahead = new Date(Date.now() + 60_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const months =
      "January February March April May June July August September October November December".split(
        " ",
      );
    const stamp = `${ahead.getDate()} ${months[ahead.getMonth()]} ${ahead.getFullYear()} ${pad(ahead.getHours())}:${pad(ahead.getMinutes())}:${pad(ahead.getSeconds())}`;
    writeFileSync(file("a.md"), plan("12 November 2026", `First: ${stamp}.\n\n`));
    expect(run(["first", "plans/b.md"]).status).toBe(0);
    const ready = rows(queue(["list"]), "Ready, put first, then oldest first");
    expect(ready.map((one) => one.trim().split(/\s+/)[0])).toEqual(["plans/b.md", "plans/a.md"]);
    const b = firstOf(readFileSync(file("b.md"), "utf8"));
    const a = firstOf(readFileSync(file("a.md"), "utf8"));
    expect(b!.at - a!.at).toBe(1000);
  });

  it("a First line under a hand-over or a Planning line is still read, and undone (/code-review)", () => {
    reset();
    run(["first", "plans/b.md"]);
    const marked = readFileSync(file("b.md"), "utf8");
    // A hand-over written after the header paragraph, above the First line.
    const handed = marked.replace(
      "builds it.\n\n",
      "builds it.\n\n## Handing over, 13 November 2026\n\nStep in hand: 2\n\n",
    );
    expect(firstOf(handed)).not.toBeNull();
    expect(stateOf(handed)?.first).not.toBeNull();
    writeFileSync(
      file("x.md"),
      `# X\n\nBrief for the planner, 13 November 2026.\n\n## Planning, 13 November 2026, session ${ids.planner}\n\nFirst: 13 November 2026 10:00:00.\n\n## What\n`,
    );
    expect(run(["first", "--undo", "plans/x.md"]).stdout).toBe("plans/x.md is no longer first.\n");
    expect(readFileSync(file("x.md"), "utf8")).not.toContain("First:");
    // Prose that starts with the word is no mark, and stays.
    writeFileSync(
      file("b.md"),
      plan("13 November 2026").replace("builds it.\n", "builds it.\nFirst: the hook reads it.\n"),
    );
    run(["first", "plans/b.md"]);
    run(["first", "--undo", "plans/b.md"]);
    expect(readFileSync(file("b.md"), "utf8")).toContain("First: the hook reads it.\n");
  });

  it("a First line under a section holding a fenced heading is still read, and undone (Codex C2)", () => {
    reset();
    // A hand-over above the First line that shows a section in an example.
    const fenced = "```markdown\n## Example\n\nA line.\n```\n\n";
    writeFileSync(
      file("b.md"),
      plan(
        "13 November 2026",
        `## Handing over, 13 November 2026\n\nStep in hand: 2\n\n${fenced}First: 13 November 2026 10:00:00.\n\n`,
      ),
    );
    expect(firstOf(readFileSync(file("b.md"), "utf8"))).not.toBeNull();
    const listed = queue(["list"]);
    expect(listed).not.toContain("First line not read");
    expect(listed).toContain("first since 13 November 10:00");
    writeFileSync(
      file("x.md"),
      `# X\n\nBrief for the planner, 13 November 2026.\n\n## Planning, 13 November 2026, session ${ids.planner}\n\n${fenced}First: 13 November 2026 10:00:00.\n\n## What\n`,
    );
    expect(run(["first", "--undo", "plans/x.md"]).stdout).toBe("plans/x.md is no longer first.\n");
    expect(readFileSync(file("x.md"), "utf8")).not.toContain("First:");
    expect(readFileSync(file("x.md"), "utf8")).toContain("## Example\n");
    // A fence inside a longer one is the longer one's text: the mark under both is taken out.
    const nested = `\`\`\`\`markdown\n${fenced}\`\`\`\`\n\n`;
    writeFileSync(
      file("x.md"),
      `# X\n\nBrief for the planner, 13 November 2026.\n\n## Planning, 13 November 2026, session ${ids.planner}\n\n${nested}First: 13 November 2026 10:00:00.\n\n## What\n`,
    );
    expect(firstOf(readFileSync(file("x.md"), "utf8"))).not.toBeNull();
    expect(run(["first", "--undo", "plans/x.md"]).stdout).toBe("plans/x.md is no longer first.\n");
    expect(readFileSync(file("x.md"), "utf8")).not.toContain("First:");
    expect(readFileSync(file("x.md"), "utf8")).toContain(nested);
  });

  it("a built plan is no longer first", () => {
    reset();
    run(["first", "plans/b.md"]);
    writeFileSync(
      file("b.md"),
      `${readFileSync(file("b.md"), "utf8")}\n## Built, 13 November 2026\n\nCommit 0123abcd.\n`,
    );
    const listed = queue(["list"]);
    expect(listed).toContain("\nReady, oldest first\n");
    expect(listed).not.toContain("first since");
  });

  it("undo takes the line out", () => {
    reset();
    run(["first", "plans/b.md"]);
    const before = statSync(file("b.md"));
    expect(run(["first", "--undo", "plans/b.md"]).stdout).toBe("plans/b.md is no longer first.\n");
    expect(readFileSync(file("b.md"), "utf8")).toBe(plan("13 November 2026"));
    expect(Math.round(statSync(file("b.md")).mtimeMs)).toBe(Math.round(before.mtimeMs));
    const listed = queue(["list"]);
    expect(listed).toContain("\nReady, oldest first\n");
    expect(listed).not.toContain("first since");
    const again = run(["first", "--undo", "plans/b.md"]);
    expect([again.stdout, again.status]).toEqual(["plans/b.md was not first.\n", 0]);
  });

  it("a brief put first is planned first", () => {
    reset();
    writeFileSync(file("x.md"), "# X\n\nBrief for the planner, 12 November 2026.\n\n## What\n");
    writeFileSync(file("y.md"), "# Y\n\nBrief for the planner, 13 November 2026.\n\n## What\n");
    expect(run(["first", "plans/y.md"]).status).toBe(0);
    const briefs = rows(queue(["list"]), "Briefs, put first, then oldest first");
    expect(briefs[0]).toMatch(/^ {2}plans\/y\.md +brief, 13 November, first since /);
    expect(briefs[1]).toMatch(/^ {2}plans\/x\.md +brief, 12 November$/);
    const dry = queue(["start", "--dry", "--agent", "planner"]);
    expect(dry).toContain("Plan plans/y.md: it is a brief.");
    expect(dry).not.toContain("plans/x.md");
  });

  it("the planner's tool hook keeps a waiting file's First line", () => {
    reset();
    const mark = "First: 13 November 2026 10:00:00.";
    const brief = `# X\n\nBrief for the planner, 13 November 2026.\n\n${mark}\n\n## What\n\nA change.\n`;
    writeFileSync(file("x.md"), brief);
    const hook = (tool_name: string, tool_input: object) =>
      queue(["tool"], {
        session_id: ids.planner,
        agent_type: "workflow:planner",
        tool_name,
        tool_input: { file_path: file("x.md"), ...tool_input },
      });
    const denied = (out: string) =>
      out ? JSON.parse(out).hookSpecificOutput?.permissionDecisionReason || "" : "";
    const words = `plans/x.md is first (since 13 November 10:00): keep its line, ${mark}, above the first ## section. Only Javi's word takes it out: plans first --undo plans/x.md.`;
    // The plan written over the brief without the line.
    const planText = plan("13 November 2026");
    expect(denied(hook("Write", { content: planText }))).toBe(words);
    // The same write with the line kept passes.
    expect(hook("Write", { content: plan("13 November 2026", `${mark}\n\n`) })).toBe("");
    // The line moved under a `## ` section is not read there.
    expect(
      denied(
        hook("Edit", {
          old_string: `${mark}\n\n## What\n\nA change.\n`,
          new_string: `## What\n\nA change.\n\n${mark}\n`,
        }),
      ),
    ).toBe(words);
    // Another day the queue reads is the line still there.
    expect(
      hook("Edit", { old_string: mark, new_string: "First: 13 November 2026 11:00:00." }),
    ).toBe("");
    // An edit elsewhere in the file passes.
    expect(hook("Edit", { old_string: "A change.", new_string: "A change, said." })).toBe("");
    // A file not waiting, or not put first, is not held.
    writeFileSync(file("x.md"), brief.replace(`${mark}\n\n`, ""));
    expect(hook("Write", { content: planText })).toBe("");
    writeFileSync(file("x.md"), `${brief}\n## Dropped, 13 November 2026\n\nGone.\n`);
    expect(hook("Write", { content: planText })).toBe("");
  });

  it("the planner's tool hook names one place for a header under the first section (plans/put-first-any-header-place.md)", () => {
    const header = headerLine("13 November 2026");
    reset();
    const mark = "First: 13 November 2026 10:00:00.";
    const body = `## Context\n\nA note kept above the header.\n\n${header}\n\n## What was asked\n\nA change.\n`;
    writeFileSync(file("x.md"), `# P\n\n${mark}\n\n${body}`);
    const hook = (tool_name: string, tool_input: object) =>
      queue(["tool"], {
        session_id: ids.planner,
        agent_type: "workflow:planner",
        tool_name,
        tool_input: { file_path: file("x.md"), ...tool_input },
      });
    const denied = (out: string) =>
      out ? JSON.parse(out).hookSpecificOutput?.permissionDecisionReason || "" : "";
    const words = `plans/x.md is first (since 13 November 10:00): keep its line, ${mark}, above the first ## section. Only Javi's word takes it out: plans first --undo plans/x.md.`;
    // The line dropped.
    expect(denied(hook("Write", { content: `# P\n\n${body}` }))).toBe(words);
    // The line moved under the header paragraph, inside the section, is not read there.
    expect(
      denied(
        hook("Write", {
          content: `# P\n\n${body.replace(`${header}\n`, `${header}\n\n${mark}\n`)}`,
        }),
      ),
    ).toBe(words);
    // The line put back above that section passes.
    expect(
      hook("Write", {
        content: `# P\n\n${mark}\n\n${body.replace("A change.", "A change, said.")}`,
      }),
    ).toBe("");
    // A plan with this shape written over a brief whose header is at the top
    // is told the place in the plan it writes (Codex C1).
    writeFileSync(
      file("x.md"),
      `# P\n\nBrief for the planner, 13 November 2026.\n\n${mark}\n\n## What\n\nA change.\n`,
    );
    expect(denied(hook("Write", { content: `# P\n\n${body}` }))).toBe(words);
    expect(hook("Write", { content: `# P\n\n${mark}\n\n${body}` })).toBe("");
  });

  it("a header under a later section: the line is kept and written above the first section (plans/put-first-any-header-place.md)", () => {
    const header = headerLine("13 November 2026");
    reset();
    const mark = "First: 13 November 2026 10:00:00.";
    const body = `## Context\n\nA note.\n\n## Plan\n\n${header}\n\n## What was asked\n\nA change.\n`;
    // The header within twelve lines once the mark is taken out.
    expect(`# P\n\n${body}`.split("\n")[8]).toBe(header);
    const marked = `# P\n\n${mark}\n\n${body}`;
    writeFileSync(file("x.md"), marked);
    const hook = (tool_name: string, tool_input: object) =>
      queue(["tool"], {
        session_id: ids.planner,
        agent_type: "workflow:planner",
        tool_name,
        tool_input: { file_path: file("x.md"), ...tool_input },
      });
    const denied = (out: string) =>
      out ? JSON.parse(out).hookSpecificOutput?.permissionDecisionReason || "" : "";
    const words = `plans/x.md is first (since 13 November 10:00): keep its line, ${mark}, above the first ## section. Only Javi's word takes it out: plans first --undo plans/x.md.`;
    // The line dropped.
    expect(denied(hook("Write", { content: `# P\n\n${body}` }))).toBe(words);
    // The line straight above the section the header sits under is not read there.
    expect(
      denied(
        hook("Write", { content: `# P\n\n${body.replace("## Plan\n", `${mark}\n\n## Plan\n`)}` }),
      ),
    ).toBe(words);
    // The line above the first section passes, and the queue reads it there.
    const kept = `# P\n\n${mark}\n\n${body.replace("A note.", "A note, said.")}`;
    expect(hook("Write", { content: kept })).toBe("");
    writeFileSync(file("x.md"), kept);
    const listed = queue(["list"]);
    expect(listed).not.toContain("First line not read");
    const ready = rows(listed, "Ready, put first, then oldest first");
    expect(ready[0]).toMatch(/^ {2}plans\/x\.md +Plan only, 13 November, first since /);
    // plans first writes it there, and --undo gives the file back.
    const bare = `# P\n\n${body}`;
    writeFileSync(file("x.md"), bare);
    expect(run(["first", "plans/x.md"]).status).toBe(0);
    expect(readFileSync(file("x.md"), "utf8")).toMatch(
      /^# P\n\nFirst: \d{1,2} [A-Z][a-z]+ \d{4} \d{2}:\d{2}:\d{2}\.\n\n## Context\n/,
    );
    expect(run(["first", "--undo", "plans/x.md"]).status).toBe(0);
    expect(readFileSync(file("x.md"), "utf8")).toBe(bare);
  });

  it("plans first writes under the header the queue read, with a hand-over above it (plans/put-first-any-header-place.md, part 3)", () => {
    const header = headerLine("13 November 2026");
    reset();
    const handed = (step: string) =>
      `# P\n\n## Handing over, 13 November 2026, by the queue\n\n${step}\n\n${header}\n\n## What was asked\n\nA change.\n`;
    for (const [said, step, under] of [
      ["the plan's header", "Step in hand: 2.", header],
      [
        "a header-looking line quoted in the hand-over",
        "Step in hand: 2.\nPlan only, 12 November 2026, an earlier draft.",
        "Plan only, 12 November 2026, an earlier draft.",
      ],
    ]) {
      const text = handed(step);
      writeFileSync(file("x.md"), text);
      expect(run(["first", "plans/x.md"]).status, said).toBe(0);
      const written = readFileSync(file("x.md"), "utf8");
      const after = written.split(`${under}\n\n`)[1] ?? "";
      expect(after, said).toMatch(/^First: \d{1,2} [A-Z][a-z]+ \d{4} \d{2}:\d{2}:\d{2}\.\n\n/);
      const listed = queue(["list"]);
      expect(listed, said).not.toContain("First line not read");
      expect(listed, said).toMatch(/plans\/x\.md .*first since /);
      expect(run(["first", "--undo", "plans/x.md"]).status, said).toBe(0);
      expect(readFileSync(file("x.md"), "utf8"), said).toBe(text);
    }
  });

  it("plans first refuses what is not waiting", () => {
    reset();
    writeFileSync(
      file("building.md"),
      plan("13 November 2026").replace(
        "# P\n\n",
        `# P\n\n## Building, 13 November 2026, session ${ids.exec}\n\n`,
      ),
    );
    writeFileSync(
      file("built.md"),
      `${plan("13 November 2026")}\n## Built, 13 November 2026\n\nCommit 0123abcd.\n`,
    );
    writeFileSync(
      file("dropped.md"),
      `${plan("13 November 2026")}\n## Dropped, 13 November 2026\n\nDropped on Javi's word: gone.\n`,
    );
    const refused = (args: string[]) => {
      const out = run(["first", ...args], {}, [execRow]);
      expect(out.status, args.join(" ")).toBe(1);
      return out.stdout;
    };
    expect(refused(["plans/building.md"])).toBe(
      "plans/building.md is being built by First Executor 1: nothing to put first.\n",
    );
    expect(refused(["plans/built.md"])).toBe("plans/built.md is built: nothing to put first.\n");
    expect(refused(["plans/dropped.md"])).toBe(
      "plans/dropped.md is dropped (13 November 2026): nothing to build.\n",
    );
    expect(refused(["plans/nowhere.md"])).toBe(
      "plans/nowhere.md is not a plan or a brief in the queue; plans shows them.\n",
    );
    expect(refused([])).toBe(
      "A path is needed: plans first plans/<x>.md; plans shows the queue.\n",
    );
    for (const name of ["building.md", "built.md", "dropped.md"])
      expect(readFileSync(file(name), "utf8")).not.toContain("First:");
    // One path at a time, and no option but --undo (plans/put-first-review-fixes.md, part 3).
    const one =
      "plans first takes one path at a time: plans first plans/<x>.md, or plans first --undo plans/<x>.md.\n";
    const before = ["a.md", "b.md"].map((name) => readFileSync(file(name), "utf8"));
    expect(refused(["plans/a.md", "plans/b.md"])).toBe(one);
    expect(refused(["--undo", "plans/a.md", "plans/b.md"])).toBe(one);
    expect(refused(["--undo=plans/a.md"])).toBe(one);
    expect(refused(["--now", "plans/a.md"])).toBe(one);
    expect(["a.md", "b.md"].map((name) => readFileSync(file(name), "utf8"))).toEqual(before);
  });

  it("says a First line it does not read", () => {
    reset();
    writeFileSync(file("b.md"), plan("13 November 2026", "First: soon.\n\n"));
    const listed = queue(["list"]);
    expect(listed).toContain("\nFirst line not read: plans/b.md\n");
    expect(listed).toContain("\nReady, oldest first\n");
  });

  describe("the executor", () => {
    const line = `## Building, 13 November 2026, session ${ids.exec}`;
    const edit = (name: string, rows: object[] | null = [execRow]) =>
      queue(
        ["tool"],
        {
          session_id: ids.exec,
          agent_type: "workflow:executor",
          tool_name: "Edit",
          tool_input: {
            file_path: file(name),
            old_string: "# P\n",
            new_string: `# P\n\n${line}\n`,
          },
        },
        rows,
      );
    const denied = (out: string) =>
      out ? JSON.parse(out).hookSpecificOutput?.permissionDecisionReason || "" : "";
    const words = (path: string, since: string) =>
      `plans/b.md is first (since ${since}): build it before ${path}. Only Javi's word, through the assistant chat, changes the order.`;
    const putFirst = () =>
      writeFileSync(
        file("b.md"),
        plan("13 November 2026", "First: 13 November 2026 15:42:07.\n\n"),
      );

    it("the tool hook refuses a Building line out of turn", () => {
      reset();
      putFirst();
      expect(denied(edit("a.md"))).toBe(words("plans/a.md", "13 November 15:42"));
      expect(edit("b.md")).toBe("");
      // A plan put first later than b.md is not behind it.
      writeFileSync(file("c.md"), plan("13 November 2026", "First: 13 November 2026 16:00.\n\n"));
      expect(edit("c.md")).toBe("");
      // With the sessions unread it refuses nothing.
      expect(edit("a.md", null)).toBe("");
      // The plan put first, still asking its owner, holds nothing back.
      rmSync(file("c.md"));
      writeFileSync(
        file("b.md"),
        `${plan("13 November 2026", "First: 13 November 2026 15:42:07.\n\n")}\n## Decisions for Javi\n\n1. **One.** A (Recommended) or B.\n`,
      );
      writeFileSync(
        stateFile(ids.planner),
        JSON.stringify({
          agent: "planner",
          plans: ["plans/b.md"],
          asked: { "plans/b.md": Date.now() },
        }),
      );
      const planner = {
        sessionId: ids.planner,
        name: "First Planner 2",
        kind: "background",
        status: "waiting",
        waitingFor: "input needed",
        state: "blocked",
      };
      expect(edit("a.md", [execRow, planner])).toBe("");
    });

    it("a shell command's Building line out of turn is taken out", () => {
      reset();
      putFirst();
      writeFileSync(file("a.md"), plan("12 November 2026").replace("# P\n", `# P\n\n${line}\n`));
      const out = queue(
        ["wrote"],
        {
          session_id: ids.exec,
          agent_type: "workflow:executor",
          tool_name: "Bash",
          tool_input: { command: "sed -i ... plans/a.md" },
        },
        [execRow],
      );
      expect(JSON.parse(out)).toEqual({
        decision: "block",
        reason: `${words("plans/a.md", "13 November 15:42")} Its Building line was taken out.`,
      });
      expect(readFileSync(file("a.md"), "utf8")).not.toContain("## Building, ");
      // On the plan put first, it stays.
      writeFileSync(
        file("b.md"),
        plan("13 November 2026", "First: 13 November 2026 15:42:07.\n\n").replace(
          "# P\n",
          `# P\n\n${line}\n`,
        ),
      );
      rmSync(stateFile(ids.exec), { force: true });
      expect(
        queue(
          ["wrote"],
          {
            session_id: ids.exec,
            agent_type: "workflow:executor",
            tool_name: "Bash",
            tool_input: { command: "sed -i ... plans/b.md" },
          },
          [execRow],
        ),
      ).toBe("");
      expect(readFileSync(file("b.md"), "utf8")).toContain(line);
    });

    it("a handed-over plan is resumed whatever is first (Codex C1)", () => {
      reset();
      putFirst();
      writeFileSync(
        file("a.md"),
        plan("12 November 2026", "## Handing over, 13 November 2026\n\nStep in hand: 2\n\n"),
      );
      expect(edit("a.md")).toBe("");
      writeFileSync(
        file("a.md"),
        plan(
          "12 November 2026",
          `## Resumed, 13 November 2026, session ${ids.exec}, at step 2\n\nStep in hand: 2\n\n`,
        ),
      );
      expect(edit("a.md")).toBe("");
    });

    it("one shell command claiming two plans keeps only the first's (Codex C2)", () => {
      reset();
      putFirst();
      writeFileSync(file("a.md"), plan("12 November 2026").replace("# P\n", `# P\n\n${line}\n`));
      writeFileSync(
        file("b.md"),
        plan("13 November 2026", "First: 13 November 2026 15:42:07.\n\n").replace(
          "# P\n",
          `# P\n\n${line}\n`,
        ),
      );
      const out = queue(
        ["wrote"],
        {
          session_id: ids.exec,
          agent_type: "workflow:executor",
          tool_name: "Bash",
          tool_input: { command: "sed -i ... plans/a.md plans/b.md" },
        },
        [execRow],
      );
      expect(JSON.parse(out).reason).toBe(
        `${words("plans/a.md", "13 November 15:42")} Its Building line was taken out.`,
      );
      expect(readFileSync(file("a.md"), "utf8")).not.toContain("## Building, ");
      expect(readFileSync(file("b.md"), "utf8")).toContain(line);
    });

    it("a shell command claiming the first plan, still asking, judges it by its time before (Codex C1)", () => {
      reset();
      // b.md put first with a decision unanswered, its planner live, no question
      // recorded, and its window over by its time before the command.
      writeFileSync(
        file("b.md"),
        `${plan("13 November 2026", "First: 13 November 2026 15:42:07.\n\n")}\n## Decisions for Javi\n\n1. **One.** A (Recommended) or B.\n`,
      );
      writeFileSync(
        stateFile(ids.planner),
        JSON.stringify({ agent: "planner", plans: ["plans/b.md"] }),
      );
      const planner = {
        sessionId: ids.planner,
        name: "First Planner 2",
        kind: "background",
        status: "busy",
        state: "working",
      };
      const before = Date.now() - 40 * 60_000;
      writeFileSync(
        stateFile(ids.exec),
        JSON.stringify({ plansAt: { "plans/a.md": before, "plans/b.md": before } }),
      );
      writeFileSync(file("a.md"), plan("12 November 2026").replace("# P\n", `# P\n\n${line}\n`));
      writeFileSync(
        file("b.md"),
        readFileSync(file("b.md"), "utf8").replace("# P\n", `# P\n\n${line}\n`),
      );
      const out = queue(
        ["wrote"],
        {
          session_id: ids.exec,
          agent_type: "workflow:executor",
          tool_name: "Bash",
          tool_input: { command: "sed -i ... plans/a.md plans/b.md" },
        },
        [execRow, planner],
      );
      // The window is not revived by the command's own write: b.md is not
      // asking, keeps its line, and still holds a.md back.
      expect(JSON.parse(out).reason).toBe(
        `${words("plans/a.md", "13 November 15:42")} Its Building line was taken out.`,
      );
      expect(readFileSync(file("a.md"), "utf8")).not.toContain("## Building, ");
      expect(readFileSync(file("b.md"), "utf8")).toContain(line);
    });

    it("a plan put first still asking by the hook's time holds nothing back (plans/put-first-review-fixes-follow-up.md)", () => {
      reset();
      // b.md put first with a decision unanswered, its planner live, no
      // question recorded: its window is the hook's time for it.
      const asks = `${plan("13 November 2026", "First: 13 November 2026 15:42:07.\n\n")}\n## Decisions for Javi\n\n1. **One.** A (Recommended) or B.\n`;
      writeFileSync(file("b.md"), asks);
      writeFileSync(
        stateFile(ids.planner),
        JSON.stringify({ agent: "planner", plans: ["plans/b.md"] }),
      );
      const planner = {
        sessionId: ids.planner,
        name: "First Planner 2",
        kind: "background",
        status: "busy",
        state: "working",
      };
      const rows = [execRow, planner];
      const asking = /^plans\/b\.md is still asking Javi \(its planner's until \d{2}:\d{2}\)/;
      // By Write: the hook's time is the file's, just written, so b.md asks.
      expect(edit("a.md", rows)).toBe("");
      expect(denied(edit("b.md", rows))).toMatch(asking);
      // By a shell command: the hook's time is the one before the command
      // (`plansAt`), inside the window, while the file's mtime is past it.
      const old = (Date.now() - 40 * 60_000) / 1000;
      utimesSync(file("b.md"), old, old);
      writeFileSync(
        stateFile(ids.exec),
        JSON.stringify({ plansAt: { "plans/a.md": old * 1000, "plans/b.md": Date.now() } }),
      );
      writeFileSync(file("a.md"), plan("12 November 2026").replace("# P\n", `# P\n\n${line}\n`));
      const shell = (command: string) =>
        queue(
          ["wrote"],
          {
            session_id: ids.exec,
            agent_type: "workflow:executor",
            tool_name: "Bash",
            tool_input: { command },
          },
          rows,
        );
      expect(shell("sed -i ... plans/a.md")).toBe("");
      expect(readFileSync(file("a.md"), "utf8")).toContain(line);
      writeFileSync(file("b.md"), asks.replace("# P\n", `# P\n\n${line}\n`));
      utimesSync(file("b.md"), old, old);
      const out = JSON.parse(shell("sed -i ... plans/b.md"));
      expect(out.reason).toMatch(asking);
      expect(out.reason).toMatch(/ Its Building line was taken out\.$/);
      expect(readFileSync(file("b.md"), "utf8")).not.toContain("## Building, ");
      // Written during the command, not in `plansAt`: its file's time is the
      // hook's (/code-review 1), so it is asking and holds nothing back.
      writeFileSync(file("b.md"), asks);
      writeFileSync(file("a.md"), plan("12 November 2026").replace("# P\n", `# P\n\n${line}\n`));
      writeFileSync(stateFile(ids.exec), JSON.stringify({ plansAt: { "plans/a.md": old * 1000 } }));
      expect(shell("sed -i ... plans/a.md")).toBe("");
      expect(readFileSync(file("a.md"), "utf8")).toContain(line);
    });

    it("a fresh executor's prompt names the first plan first", () => {
      reset();
      putFirst();
      // One plan a start (plans/parallel-executors.md, part 2): the first.
      expect(queue(["start", "--dry"])).toContain("Build plans/b.md.");
      // A timer's start, its paths in the queue's order as it is then.
      const timer = execFileSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `import { start } from ${JSON.stringify(join(here, "plan-queue.mjs"))};
           console.log(start(["plans/a.md", "plans/b.md"], { dry: true, timer: true, deferral: "executor" }));`,
        ],
        { encoding: "utf8", env: env([]) },
      );
      expect(timer).toContain("Build plans/b.md.");
      // Paths given on the command line keep the order given.
      expect(queue(["start", "--dry", "plans/a.md", "plans/b.md"])).toContain("Build plans/a.md.");
    });

    it("the Stop hook names the first plan first", () => {
      reset();
      putFirst();
      writeFileSync(stateFile(ids.exec), JSON.stringify({ agent: "executor" }));
      const reason = JSON.parse(
        queue(["stop"], { session_id: ids.exec, agent_type: "executor" }, [execRow]),
      ).reason;
      expect(reason).toContain("can take it: plans/b.md (first since 13 November 15:42");
      expect(reason).not.toContain("plans/a.md");
    });
  });
});

// plans/executors-build-in-worktrees.md
describe("an executor builds in its own worktree", () => {
  /** A checkout with one commit as origin/test, a ready plan and a `claude` that records its starts. */
  const checkout = (name: string, ignores = "", separate = false) => {
    const dir = temp(`tree-${name.toLowerCase()}-`);
    g(
      dir,
      "init",
      "-q",
      ...(separate ? ["--separate-git-dir", join(temp("tree-git-"), "git")] : []),
    );
    mkdirSync(join(dir, ".claude"));
    mkdirSync(join(dir, "apps", "a"), { recursive: true });
    writeFileSync(join(dir, ".claude", "workflow.md"), `---\nname: ${name}\nbranch: test\n---\n`);
    writeFileSync(
      join(dir, ".gitignore"),
      `node_modules/\n.env\n.env.*\nplans/\n.claude/worktrees/\n${ignores}`,
    );
    writeFileSync(join(dir, "apps", "a", "index.js"), "\n");
    writeFileSync(join(dir, "README.md"), "\n");
    g(dir, "add", ".");
    g(dir, "commit", "-q", "-m", "one");
    g(dir, "update-ref", "refs/remotes/origin/test", "HEAD");
    mkdirSync(join(dir, "plans"));
    writeFileSync(join(dir, "plans", "x.md"), "# X\n\nPlan only, 24 November 2026, for Javi.\n");
    const rows = join(dir, ".claude", "rows.json");
    const script = fakeClaude(temp("tree-claude-"), { prefix: "tree", rows });
    const { WORKFLOW_LIVE: _, ...rest } = process.env;
    const env = {
      ...rest,
      CLAUDE_PROJECT_DIR: dir,
      WORKFLOW_ROOT: dir,
      WORKFLOW_CLAUDE: script,
      WORKFLOW_STARTS_LOG: join(dir, ".claude", "starts.log"),
      WORKFLOW_USAGE_FILE: join(dir, ".claude", "usage.json"),
    };
    const queue = (args: string[], input: object = {}, extra: Record<string, string> = {}) =>
      execFileSync("node", [join(here, "plan-queue.mjs"), ...args], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: { ...env, ...extra },
      });
    return { dir, tree: join(dir, ".claude", "worktrees", "executor-1"), rows, queue };
  };

  it("checkoutOf gives the checkout for a linked worktree, and the folder itself otherwise", () => {
    const repo = temp("tree-of-");
    g(repo, "init", "-q");
    g(repo, "commit", "-q", "--allow-empty", "-m", "one");
    const linked = join(repo, ".claude", "worktrees", "w");
    g(repo, "worktree", "add", "-q", "--detach", linked, "HEAD");
    expect(checkoutOf(linked)).toBe(repo);
    expect(checkoutOf(repo)).toBe(repo);
    const sub = join(repo, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, ".git"), "gitdir: ../.git/modules/sub\n");
    expect(checkoutOf(sub)).toBe(sub);
    const none = temp("tree-none-");
    expect(checkoutOf(none)).toBe(none);
  });

  it("checkoutOf reads a repository made with a separate git folder", () => {
    const repo = temp("tree-separate-");
    const elsewhere = join(temp("tree-gitdir-"), "git");
    g(repo, "init", "-q", "--separate-git-dir", elsewhere);
    g(repo, "commit", "-q", "--allow-empty", "-m", "one");
    const linked = join(repo, ".claude", "worktrees", "w");
    g(repo, "worktree", "add", "-q", "--detach", linked, "HEAD");
    expect(realpathSync(checkoutOf(linked))).toBe(realpathSync(repo));
    expect(checkoutOf(repo)).toBe(repo);
  });

  it("a dry start names --add-dir and the worktree, and makes nothing", () => {
    const one = checkout("Dry");
    const said = one.queue(["start", "--dry"]);
    expect(said).toContain(`Would run: claude "--add-dir" "${join(one.dir, "plans")}" "--bg"`);
    expect(said).not.toContain('"--remote-control"');
    expect(said).toContain("Would run it in .claude/worktrees/executor-1.");
    expect(existsSync(one.tree)).toBe(false);
  });

  it(
    "a start makes executor-1 at origin/test, links plans/, carries the .env files and starts the chat there",
    { timeout: 30_000 },
    () => {
      const one = checkout("Made");
      writeFileSync(join(one.dir, ".env"), "A=1\n");
      writeFileSync(join(one.dir, "apps", "a", ".env"), "B=1\n");
      mkdirSync(join(one.dir, "node_modules", "x"), { recursive: true });
      writeFileSync(join(one.dir, "node_modules", "x", ".env"), "C=1\n");
      expect(one.queue(["start"])).toContain("Made Executor 1 (lab) was started on: plans/x.md");
      const list = g(one.dir, "worktree", "list", "--porcelain");
      const entry = list.split("\n\n").find((block) => block.includes(one.tree)) || "";
      expect(entry).toContain(`HEAD ${g(one.dir, "rev-parse", "origin/test")}`);
      expect(entry).toContain("detached");
      expect(lstatSync(join(one.tree, "plans")).isSymbolicLink()).toBe(true);
      expect(realpathSync(join(one.tree, "plans"))).toBe(realpathSync(join(one.dir, "plans")));
      expect(g(one.tree, "status", "--porcelain")).toBe("");
      expect(readFileSync(join(one.tree, ".env"), "utf8")).toBe("A=1\n");
      expect(existsSync(join(one.tree, "apps", "a", ".env"))).toBe(true);
      expect(existsSync(join(one.tree, "node_modules", "x", ".env"))).toBe(false);
      const settings = JSON.parse(
        readFileSync(join(one.tree, ".claude", "settings.local.json"), "utf8"),
      );
      expect(settings.env.WORKFLOW_EXECUTOR).toBe("1");
      expect(JSON.parse(readFileSync(one.rows, "utf8"))[0].cwd).toBe(realpathSync(one.tree));
    },
  );

  it("a .worktreeinclude carries the files it lists and no others", { timeout: 30_000 }, () => {
    const one = checkout("Include", "config/local.json\n");
    writeFileSync(join(one.dir, ".worktreeinclude"), "config/local.json\n");
    mkdirSync(join(one.dir, "config"));
    writeFileSync(join(one.dir, "config", "local.json"), "{}\n");
    writeFileSync(join(one.dir, ".env"), "A=1\n");
    one.queue(["start"]);
    expect(existsSync(join(one.tree, "config", "local.json"))).toBe(true);
    expect(existsSync(join(one.tree, ".env"))).toBe(false);
  });

  it("refuses a start while plans/ holds a tracked file, and makes nothing", () => {
    const one = checkout("Tracked");
    g(one.dir, "add", "-f", "plans/x.md");
    g(one.dir, "commit", "-q", "-m", "plans");
    // The start's sync says its failed fetch first: the fixture has no remote.
    expect(one.queue(["start"])).toContain(
      "plans/ holds files tracked by git, and an executor's worktree would carry its own copy of them: take the folder out of git (git rm -r --cached plans) and ignore it, then start again.",
    );
    expect(existsSync(one.tree)).toBe(false);
    expect(readFileSync(one.rows, "utf8")).toBe("[]");
  });

  it(
    "a start in a repository with a separate git folder moves the checkout, not the git folder",
    { timeout: 30_000 },
    () => {
      const one = checkout("Separate", "", true);
      const said = one.queue(["start"]);
      expect(said).toContain("The checkout is at test");
      expect(said).toContain("Separate Executor 1 (lab) was started on: plans/x.md");
      expect(realpathSync(checkoutOf(one.tree))).toBe(realpathSync(one.dir));
    },
  );

  it("refuses a start while .claude/settings.local.json is tracked, and makes nothing", () => {
    const one = checkout("Settings");
    writeFileSync(join(one.dir, ".claude", "settings.local.json"), "{}\n");
    g(one.dir, "add", "-f", ".claude/settings.local.json");
    g(one.dir, "commit", "-q", "-m", "settings");
    expect(one.queue(["start"])).toContain(
      ".claude/settings.local.json is tracked by git, and an executor's worktree writes its number there: take it out of git (git rm --cached .claude/settings.local.json) and ignore it, then start again.",
    );
    expect(existsSync(one.tree)).toBe(false);
    expect(readFileSync(one.rows, "utf8")).toBe("[]");
  });

  it(
    "an untracked project file is carried into the worktree, and a newer one again; a tracked one is the branch's",
    { timeout: 30_000 },
    () => {
      const one = checkout("Carried");
      g(one.dir, "rm", "-q", "--cached", ".claude/workflow.md");
      g(one.dir, "commit", "-q", "-m", "untracked");
      g(one.dir, "update-ref", "refs/remotes/origin/test", "HEAD");
      const file = join(one.dir, ".claude", "workflow.md");
      one.queue(["start"]);
      const carried = join(one.tree, ".claude", "workflow.md");
      expect(readFileSync(carried, "utf8")).toBe(readFileSync(file, "utf8"));
      expect(g(one.tree, "status", "--porcelain")).toBe("");
      writeFileSync(file, "---\nname: Carried\nbranch: test\nexecutors: 2\n---\n");
      // Older than the worktree's copy, as a restored file can be: carried all the same.
      const earlier = new Date(Date.now() - 3_600_000);
      utimesSync(file, earlier, earlier);
      writeFileSync(one.rows, "[]");
      // The loop guard holds a second start within ten minutes: the owner's word lets it.
      one.queue(["start", "--owner-said", "start it again"]);
      expect(readFileSync(carried, "utf8")).toContain("executors: 2");

      const two = checkout("Kept");
      writeFileSync(
        join(two.dir, ".claude", "workflow.md"),
        "---\nname: Kept\nbranch: test\n# changed, not committed\n---\n",
      );
      two.queue(["start"]);
      expect(readFileSync(join(two.tree, ".claude", "workflow.md"), "utf8")).toBe(
        "---\nname: Kept\nbranch: test\n---\n",
      );
    },
  );

  it(
    "an executor edits only its worktree and plans/, a plan through the link being that plan",
    { timeout: 30_000 },
    () => {
      const one = checkout("Edits");
      one.queue(["start"]);
      const id = "e8100000-0000-0000-0000-000000000000";
      const hook = (mode: string, file: string, extra: object = {}) =>
        one.queue([mode], {
          session_id: id,
          agent_type: "workflow:executor",
          cwd: one.tree,
          tool_name: "Edit",
          tool_input: { file_path: file, old_string: "a", new_string: "b" },
          ...extra,
        });
      try {
        const outside = join(one.dir, "README.md");
        expect(JSON.parse(hook("tool", outside)).hookSpecificOutput.permissionDecisionReason).toBe(
          `An executor edits only its own worktree, .claude/worktrees/executor-1, and plans/: ${outside} is outside both.`,
        );
        expect(hook("tool", join(one.tree, "README.md"))).toBe("");
        const plan = join(one.tree, "plans", "x.md");
        expect(hook("tool", plan)).toBe("");
        writeFileSync(
          plan,
          `# X\n\n## Building, 24 November 2026, session ${id}\n\nPlan only, 24 November 2026, for Javi.\n`,
        );
        hook("wrote", plan);
        const state = JSON.parse(readFileSync(stateFile(id), "utf8"));
        expect(state.held).toEqual(["plans/x.md"]);
      } finally {
        rmSync(stateFile(id), { force: true });
      }
    },
  );

  it("blocks an executor's chat opened in the checkout", () => {
    const one = checkout("Here");
    const out = JSON.parse(
      one.queue(["prompt"], {
        session_id: "e8200000-0000-0000-0000-000000000000",
        agent_type: "executor",
        cwd: one.dir,
        prompt: "Build.",
      }),
    );
    expect(out).toEqual({
      decision: "block",
      reason:
        "Executors build in the worktrees the queue makes (.claude/worktrees/executor-<n>), and this chat is in the checkout: plans start starts one. Do not build here; say so, and stop.",
    });
  });

  it(
    "plans lists the executor in executor-1 on its branch, its context from the worktree's transcript",
    { timeout: 30_000 },
    () => {
      const one = checkout("Listed");
      one.queue(["start"]);
      g(one.tree, "switch", "-q", "-c", "topic");
      const [row] = JSON.parse(readFileSync(one.rows, "utf8"));
      const projects = temp("tree-projects-");
      const folder = join(projects, row.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(folder);
      writeFileSync(
        join(folder, `${row.sessionId}.jsonl`),
        `${JSON.stringify({
          type: "assistant",
          timestamp: new Date().toISOString(),
          message: { usage: { input_tokens: 10, cache_read_input_tokens: 40_990 } },
        })}\n`,
      );
      const said = one.queue(["list"], {}, { WORKFLOW_PROJECTS: projects });
      expect(said).toMatch(/Listed Executor 1 \(lab\) \[tree-\d*\], [^\n]*41k context/);
      expect(said).toContain("in executor-1 on topic");
    },
  );
});

// plans/parallel-executors.md
describe("several executors build at once", () => {
  const plan = (title: string, body = "", head = "") =>
    `# ${title}\n\nPlan only, 24 November 2026, for Javi.${head}\n\n## The change, part by part\n\n${body}\n`;
  /** A checkout with `executors: 3`, origin/test, the plans given, and a `claude` whose started chats are busy. */
  const pool = (name: string, plans: Record<string, string>, front = "executors: 3\n") => {
    const dir = temp(`pool-${name.toLowerCase()}-`);
    g(dir, "init", "-q");
    mkdirSync(join(dir, ".claude"));
    writeFileSync(
      join(dir, ".claude", "workflow.md"),
      `---\nname: ${name}\nbranch: test\n${front}---\n`,
    );
    writeFileSync(join(dir, ".gitignore"), "plans/\n.claude/worktrees/\n");
    g(dir, "add", ".");
    g(dir, "commit", "-q", "-m", "one");
    g(dir, "update-ref", "refs/remotes/origin/test", "HEAD");
    mkdirSync(join(dir, "plans"));
    Object.entries(plans).forEach(([file, text], i) => {
      writeFileSync(join(dir, "plans", file), text);
      const at = new Date(Date.now() - (10 - i) * 60_000);
      utimesSync(join(dir, "plans", file), at, at);
    });
    const rows = join(dir, ".claude", "rows.json");
    const script = fakeClaude(temp("pool-claude-"), {
      prefix: "pool",
      numbered: true,
      status: "busy",
      rows,
    });
    const { WORKFLOW_LIVE: _, ...rest } = process.env;
    const env = {
      ...rest,
      CLAUDE_PROJECT_DIR: dir,
      WORKFLOW_ROOT: dir,
      WORKFLOW_CLAUDE: script,
      WORKFLOW_STARTS_LOG: join(dir, ".claude", "starts.log"),
      WORKFLOW_USAGE_FILE: join(dir, ".claude", "usage.json"),
      WORKFLOW_STOP_LOG: join(dir, ".claude", "stops.log"),
    };
    const queue = (args: string[], input: object = {}, extra: Record<string, string> = {}) =>
      execFileSync("node", [join(here, "plan-queue.mjs"), ...args], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: { ...env, ...extra },
      });
    const read = () => JSON.parse(readFileSync(rows, "utf8"));
    const write = (all: object[]) => writeFileSync(rows, JSON.stringify(all));
    const tree = (n: number) => join(dir, ".claude", "worktrees", `executor-${n}`);
    const building = (file: string, id: string) =>
      writeFileSync(
        join(dir, "plans", file),
        readFileSync(join(dir, "plans", file), "utf8").replace(
          "\n\nPlan only",
          `\n\n## Building, 24 November 2026, session ${id}\n\nPlan only`,
        ),
      );
    return { dir, queue, read, write, tree, building, env };
  };

  it(
    "starts two executors on two plans with no file in common, each in its own worktree on its own branch",
    { timeout: 60_000 },
    () => {
      const one = pool("Two", {
        "a.md": plan("A", "Change src/a.js."),
        "b.md": plan("B", "Change src/b.js."),
      });
      expect(one.queue(["start"])).toContain(
        "Two Executor 1 (lab) was started on: plans/a.md, in executor-1.",
      );
      expect(one.queue(["start"])).toContain(
        "Two Executor 2 (lab) was started on: plans/b.md, in executor-2.",
      );
      const [first, second] = one.read();
      one.building("a.md", first.sessionId);
      one.building("b.md", second.sessionId);
      g(one.tree(1), "switch", "-q", "-c", "topic-a");
      g(one.tree(2), "switch", "-q", "-c", "topic-b");
      const listed = one.queue(["list"]);
      expect(listed).toContain("The executors, 2 of 3 at work:");
      expect(listed).toMatch(
        /\n  1  Two Executor 1 \(lab\) \[pool-0-\d*\], busy, [^\n]*in executor-1 on topic-a, building plans\/a\.md/,
      );
      expect(listed).toMatch(
        /\n  2  Two Executor 2 \(lab\) \[pool-1-\d*\], busy, [^\n]*in executor-2 on topic-b, building plans\/b\.md/,
      );
      expect(listed).toContain("\n  3  free");
    },
  );

  /** Fires a usage reset's timer on `paths`, as `defer` arms it; it prints nothing. */
  const reset = (one: ReturnType<typeof pool>, paths: string[]) =>
    one.queue(["start", "--timer", String(Date.now()), ...paths]);
  /** What the reset started, from the starts log and the chats listed: "<name>: <plan> in <worktree>". */
  const startedBy = (one: ReturnType<typeof pool>) => {
    const log = readFileSync(join(one.dir, ".claude", "starts.log"), "utf8")
      .trim()
      .split("\n");
    const rows: { name: string; cwd: string }[] = one.read();
    return log.map((line) => {
      const { name, paths } = JSON.parse(line);
      const row = rows.find((r) => r.name === name);
      return `${name}: ${paths.join(", ")} in ${row ? basename(row.cwd) : "none"}`;
    });
  };
  const three = {
    "a.md": plan("A", "Change src/a.js."),
    "b.md": plan("B", "Change src/b.js."),
    "c.md": plan("C", "Change src/c.js."),
  };

  it(
    "starts three executors at a usage reset on three plans deferred together, one each, in the queue's order",
    { timeout: 60_000 },
    () => {
      const one = pool("Reset", three);
      expect(reset(one, ["plans/a.md", "plans/b.md", "plans/c.md"])).toBe("");
      expect(startedBy(one)).toEqual([
        "Reset Executor 1 (lab): plans/a.md in executor-1",
        "Reset Executor 2 (lab): plans/b.md in executor-2",
        "Reset Executor 3 (lab): plans/c.md in executor-3",
      ]);
    },
  );

  it(
    "starts two at a usage reset with executors: 2 and leaves the third ready for a free executor, with no new deferral",
    { timeout: 60_000 },
    () => {
      const one = pool("Twice", three, "executors: 2\n");
      reset(one, ["plans/a.md", "plans/b.md", "plans/c.md"]);
      expect(startedBy(one)).toEqual([
        "Twice Executor 1 (lab): plans/a.md in executor-1",
        "Twice Executor 2 (lab): plans/b.md in executor-2",
      ]);
      expect(existsSync(join(one.dir, ".claude", "executor.deferred"))).toBe(false);
      const listed = one.queue(["list"]);
      expect(listed).toContain("1 plan free, but none starts: every executor is at work.");
      expect(listed).toMatch(/\n  plans\/c\.md +Plan only, 24 November\n/);
    },
  );

  it(
    "leaves a plan deferred with another that changes its file waiting on it at the reset",
    { timeout: 60_000 },
    () => {
      const one = pool("Shared", {
        "a.md": plan("A", "Change src/x.js."),
        "b.md": plan("B", "Change src/x.js and src/y.js."),
        "c.md": plan("C", "Change src/c.js."),
      });
      reset(one, ["plans/a.md", "plans/b.md", "plans/c.md"]);
      expect(startedBy(one)).toEqual([
        "Shared Executor 1 (lab): plans/a.md in executor-1",
        "Shared Executor 2 (lab): plans/c.md in executor-2",
      ]);
      expect(one.queue(["list"])).toMatch(
        /plans\/b\.md +Plan only, 24 November, waits on plans\/a\.md \(both change src\/x\.js\)/,
      );
    },
  );

  it(
    "goes on at a usage reset past a plan whose file name has a space, and past a number whose idle session refuses",
    { timeout: 60_000 },
    () => {
      const one = pool("Past", {
        "api cleanup.md": plan("A", "Change src/a.js."),
        "b.md": plan("B", "Change src/b.js."),
      });
      one.write([
        {
          sessionId: "past-idle-1",
          name: "Past Executor 9 (lab)",
          kind: "background",
          status: "idle",
          cwd: one.tree(1),
        },
      ]);
      reset(one, ["plans/api cleanup.md", "plans/b.md"]);
      expect(startedBy(one)).toEqual([
        "Past Executor 10 (lab): plans/api cleanup.md in executor-2",
        "Past Executor 11 (lab): plans/b.md in executor-3",
      ]);
    },
  );

  it(
    "holds a plan that changes a file the one in hand changes, says why, refuses its Building line, and names it once the first is built",
    { timeout: 60_000 },
    () => {
      const one = pool("Waits", {
        "a.md": plan("A", "Change src/x.js."),
        "b.md": plan("B", "Change src/x.js and src/y.js."),
      });
      expect(one.queue(["start"])).toContain("was started on: plans/a.md, in executor-1.");
      const [first] = one.read();
      one.building("a.md", first.sessionId);
      expect(one.queue(["start", "plans/b.md"]).trim()).toContain(
        "plans/b.md waits on plans/a.md (both change src/x.js): it is taken once that one is built.",
      );
      expect(one.queue(["start"]).trim()).toContain("plans/b.md waits on plans/a.md");
      expect(one.read()).toHaveLength(1);
      expect(one.queue(["list"])).toMatch(
        /plans\/b\.md +Plan only, 24 November, waits on plans\/a\.md \(both change src\/x\.js\)/,
      );
      // Another executor's Building line on it is refused.
      const other = "pool-other-0000";
      one.write([
        ...one.read(),
        {
          sessionId: other,
          name: "Waits Executor 9",
          kind: "background",
          status: "idle",
          cwd: one.tree(2),
        },
      ]);
      const file = join(one.dir, "plans", "b.md");
      const edit = JSON.parse(
        one.queue(["tool"], {
          session_id: other,
          agent_type: "workflow:executor",
          cwd: one.tree(2),
          tool_name: "Edit",
          tool_input: {
            file_path: file,
            old_string: "\n\nPlan only",
            new_string: `\n\n## Building, 24 November 2026, session ${other}\n\nPlan only`,
          },
        }),
      );
      expect(edit.hookSpecificOutput.permissionDecisionReason).toBe(
        "plans/b.md waits on plans/a.md (both change src/x.js): leave it, and build what the queue names.",
      );
      // Once a is built, b is named at the next stop.
      writeFileSync(
        join(one.dir, "plans", "a.md"),
        `${plan("A", "Change src/x.js.")}\n## Built, 24 November 2026\n\nCommit \`0123abcd\` on test.\n`,
      );
      writeFileSync(stateFile(first.sessionId), JSON.stringify({ agent: "executor" }));
      try {
        const stopped = JSON.parse(
          one.queue(["stop"], {
            session_id: first.sessionId,
            agent_type: "executor",
            cwd: one.tree(1),
          }),
        );
        expect(stopped.reason).toContain(
          "A plan is waiting and this session can take it: plans/b.md",
        );
      } finally {
        rmSync(stateFile(first.sessionId), { force: true });
        rmSync(stateFile(other), { force: true });
      }
    },
  );

  it("holds a plan on the plan its header names, and one landing on the topic in hand", () => {
    const at = (path: string, text: string, state = "ready") => ({ path, text, state });
    const a = at(
      "plans/a.md",
      plan("A", "Change src/a.js.", "\n\nLands: topic queue."),
      "building",
    );
    const b = at("plans/b.md", plan("B", "Change src/b.js.", "\n\nLands: topic queue."));
    expect(freePlans([a, b])[0].waitsOn).toEqual({
      path: "plans/a.md",
      why: "the same topic, queue",
    });
    const c = at("plans/c.md", plan("C", "Change src/c.js.", " It rests on plans/d.md."));
    const d = at("plans/d.md", plan("D", "Change src/d.js."));
    const free = freePlans([c, d]);
    expect(free[0].waitsOn).toEqual({ path: "plans/d.md", why: "it rests on it" });
    expect(free[1].waitsOn).toBeNull();
    // Two that name each other hold neither.
    const e = at("plans/e.md", plan("E", "", " With plans/f.md."));
    const f = at("plans/f.md", plan("F", "", " With plans/e.md."));
    expect(freePlans([e, f]).map((p) => p.waitsOn)).toEqual([null, null]);
    // Two of the day's fixes.
    const x = at("plans/x.md", plan("X", "Change src/x.js.", "\n\nLands: fix."), "building");
    const y = at("plans/y.md", plan("Y", "Change src/y.js.", "\n\nLands: fix."));
    expect(freePlans([x, y])[0].waitsOn).toEqual({ path: "plans/x.md", why: "the day's fixes" });
    // A file at the repository's root, and a plan resting on a brief (Codex C9, C10).
    const r = at("plans/r.md", plan("R", "Change `package.json`."), "building");
    const q = at("plans/q.md", plan("Q", "Change `package.json` too."));
    expect(freePlans([r, q])[0].waitsOn).toEqual({
      path: "plans/r.md",
      why: "both change package.json",
    });
    const brief = at("plans/d.md", "# D\n\nBrief for the planner, 24 November 2026.\n", "brief");
    expect(freePlans([c, brief])[0].waitsOn).toEqual({ path: "plans/d.md", why: "it rests on it" });
  });

  it("starts number 1 and no other with three free and one plan", () => {
    const one = pool("One", { "a.md": plan("A", "Change src/a.js.") });
    const dry = one.queue(["start", "--dry"]);
    expect(dry).toContain("Would run it in .claude/worktrees/executor-1.");
    expect(dry).not.toContain("executor-2");
    expect(
      takerFor({ path: "plans/a.md", state: "ready" }, { executors: 3, sessions: [] }),
    ).toEqual({ number: 1, session: null });
  });

  it(
    "names one plan to one of two executors stopping at one moment",
    { timeout: 60_000 },
    async () => {
      const one = pool("Race", { "a.md": plan("A", "Change src/a.js.") });
      const ids = ["race-exec-1", "race-exec-2"];
      one.write(
        ids.map((sessionId, i) => ({
          sessionId,
          name: `Race Executor ${i + 1} (lab)`,
          kind: "background",
          status: "idle",
          cwd: one.tree(i + 1),
        })),
      );
      for (const id of ids) writeFileSync(stateFile(id), JSON.stringify({ agent: "executor" }));
      const stop = (id: string, n: number) =>
        new Promise<string>((done, fail) => {
          const child = spawn("node", [join(here, "plan-queue.mjs"), "stop"], { env: one.env });
          let out = "";
          child.stdout.on("data", (chunk) => (out += chunk));
          child.on("error", fail);
          child.on("close", () => done(out));
          child.stdin.end(
            JSON.stringify({ session_id: id, agent_type: "executor", cwd: one.tree(n) }),
          );
        });
      try {
        const outs = await Promise.all(ids.map((id, i) => stop(id, i + 1)));
        expect(outs.filter((out) => out.includes("can take it: plans/a.md"))).toHaveLength(1);
        const claims = JSON.parse(
          readFileSync(join(one.dir, ".claude", "executor.claims.json"), "utf8"),
        );
        expect(Object.keys(claims)).toEqual(["plans/a.md"]);
      } finally {
        for (const id of ids) rmSync(stateFile(id), { force: true });
      }
    },
  );

  it(
    "hands over a plan whose executor has no process, names its worktree, and resumes it there",
    { timeout: 60_000 },
    () => {
      const one = pool("Gone", {
        "a.md": plan("A", "Change src/a.js."),
        "b.md": plan("B", "Change src/b.js."),
      });
      one.queue(["start"]);
      one.queue(["start"]);
      const [, second] = one.read();
      one.building("b.md", second.sessionId);
      one.write(
        one
          .read()
          .map((row: { sessionId: string }) =>
            row.sessionId === second.sessionId ? { ...row, status: undefined, pid: 0 } : row,
          ),
      );
      // The fresh executor is prompted to resume it.
      expect(one.queue(["start", "--dry"])).toContain(
        'Resume plans/b.md from its \\"Handing over\\" section.',
      );
      const said = one.queue(["start"]);
      const text = readFileSync(join(one.dir, "plans", "b.md"), "utf8");
      expect(text).toMatch(
        /## Handing over, [^\n]+, by the queue\n\nStep in hand: unknown, [^\n]* in worktree `executor-2`\./,
      );
      expect(said).toContain("was started on: plans/b.md, in executor-2.");
      const started = readFileSync(join(one.dir, ".claude", "starts.log"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .at(-1);
      expect(started.paths).toEqual(["plans/b.md"]);
      // Ended with plans end --now, a fresh executor starts in the ended one's number.
      const [first] = one.read();
      one.building("a.md", first.sessionId);
      const ended = one.queue(["end", first.sessionId, "--now"]);
      expect(ended).toContain("plans/a.md is handed over.");
      expect(ended).toContain("was started on: plans/a.md, in executor-1.");
      expect(readFileSync(join(one.dir, "plans", "a.md"), "utf8")).toContain(
        "in worktree `executor-1` in the middle of its work",
      );
      // A handed plan whose own worktree's executor is at work waits for it.
      const busy = [{ sessionId: "s2", number: 2, status: "busy", on: "plans/c.md" }];
      expect(
        takerFor(
          { path: "plans/b.md", state: "handed", tree: "executor-2" },
          { executors: 3, sessions: busy },
        ),
      ).toBeNull();
      expect(
        endedEdit(
          `# P\n\n## Building, 24 November 2026, session s1\n\nPlan only, 24 November 2026.\n`,
          { sessionId: "s1", branch: "x", tree: "executor-2" },
        ),
      ).toContain("on branch `x` in worktree `executor-2` in the middle of its work");
    },
  );

  // plans/short-session-id-is-live.md: when two executors would take one
  // plan, the live one keeps it.
  it("a second executor's Building line is refused on a plan a live session holds by a short id", () => {
    const one = pool("Short", { "a.md": plan("A", "Change src/a.js.") });
    const holder = "abcd1234-0000-4000-8000-000000000001";
    const other = "ef015678-0000-4000-8000-000000000002";
    one.write(
      [
        [holder, "Short Executor 1 (lab)"],
        [other, "Short Executor 2 (lab)"],
      ].map(([sessionId, name]) => ({
        sessionId,
        name,
        kind: "background",
        status: "busy",
        cwd: one.dir,
      })),
    );
    one.building("a.md", holder.slice(0, 8));
    const file = join(one.dir, "plans", "a.md");
    const at = new Date(statSync(file).mtimeMs).toTimeString().slice(0, 5);
    const edit = (session: string, old_string: string, new_string: string) =>
      JSON.parse(
        one.queue(["tool"], {
          session_id: session,
          agent_type: "workflow:executor",
          cwd: one.dir,
          tool_name: "Edit",
          tool_input: { file_path: file, old_string, new_string },
        }) || "{}",
      );
    const theirs = edit(
      other,
      "\n\nPlan only",
      `\n\n## Building, 25 November 2026, session ${other}\n\nPlan only`,
    );
    expect(theirs.hookSpecificOutput?.permissionDecisionReason).toBe(
      `plans/a.md is Short Executor 1 (lab)'s [abcd1234], taken at ${at}: leave it.`,
    );
    const dry = one.queue(["start", "--dry"]);
    expect(dry.trim()).toBe("Nothing is waiting in the queue.");
    // The short line is read as the holder's: its Building line on a second
    // plan is refused as one too many, not let through as on a plan nobody holds.
    writeFileSync(join(one.dir, "plans", "b.md"), plan("B", "Change src/b.js."));
    const second = JSON.parse(
      one.queue(["tool"], {
        session_id: holder,
        agent_type: "workflow:executor",
        cwd: one.dir,
        tool_name: "Edit",
        tool_input: {
          file_path: join(one.dir, "plans", "b.md"),
          old_string: "\n\nPlan only",
          new_string: `\n\n## Building, 25 November 2026, session ${holder}\n\nPlan only`,
        },
      }) || "{}",
    );
    expect(second.hookSpecificOutput?.permissionDecisionReason).toBe(
      "plans/b.md is not taken: this session is building plans/a.md, and an executor builds one plan at a time.",
    );
    // The session the line shortens corrects its own line, and nothing is refused.
    const own = edit(holder, `session ${holder.slice(0, 8)}\n`, `session ${holder}\n`);
    expect(own.hookSpecificOutput?.permissionDecision).not.toBe("deny");
  });

  // plans/name-claim-is-its-own.md: a start that saw no row yet claims the
  // plan for the session's name, and that session's line is its own.
  it("a session started under a name claim writes its own Building line", () => {
    const one = pool("Named", { "a.md": plan("A", "Change src/a.js.") });
    const started = "abcd1234-0000-4000-8000-000000000001";
    const other = "ef015678-0000-4000-8000-000000000002";
    const name = "Workflow Executor 9 (host)";
    one.write(
      [
        [started, name],
        [other, "Workflow Executor 10 (host)"],
      ].map(([sessionId, n]) => ({
        sessionId,
        name: n,
        kind: "background",
        status: "busy",
        cwd: one.dir,
      })),
    );
    const at = Date.now();
    writeFileSync(
      join(one.dir, ".claude", "executor.claims.json"),
      JSON.stringify({
        "plans/a.md": { holder: `name:${name}`, name, at, until: at + 30 * 60_000 },
      }),
    );
    const file = join(one.dir, "plans", "a.md");
    const edit = (session: string) =>
      JSON.parse(
        one.queue(["tool"], {
          session_id: session,
          agent_type: "workflow:executor",
          cwd: one.dir,
          tool_name: "Edit",
          tool_input: {
            file_path: file,
            old_string: "\n\nPlan only",
            new_string: `\n\n## Building, 26 November 2026, session ${session}\n\nPlan only`,
          },
        }) || "{}",
      );
    expect(edit(other).hookSpecificOutput?.permissionDecisionReason).toBe(
      `plans/a.md is ${name}'s [abcd1234], taken at ${new Date(at).toTimeString().slice(0, 5)}: leave it.`,
    );
    expect(edit(started).hookSpecificOutput?.permissionDecision).not.toBe("deny");
    // Stopped before its line, it is named the plan it was started on, now
    // claimed under its id, and not a plan that changes what that one changes (Codex C1, C2).
    writeFileSync(join(one.dir, "plans", "b.md"), plan("B", "Change src/a.js."));
    writeFileSync(stateFile(started), JSON.stringify({ agent: "executor" }));
    try {
      const stopped = JSON.parse(
        one.queue(["stop"], { session_id: started, agent_type: "executor", cwd: one.dir }) || "{}",
      );
      expect(stopped.reason).toContain(
        "A plan is waiting and this session can take it: plans/a.md",
      );
      expect(
        JSON.parse(readFileSync(join(one.dir, ".claude", "executor.claims.json"), "utf8"))[
          "plans/a.md"
        ].holder,
      ).toBe(started);
    } finally {
      rmSync(stateFile(started), { force: true });
      rmSync(stateFile(other), { force: true });
    }
  });

  // plans/start-output-per-start.md: a start reads its own output, never another's.
  it("two overlapping starts each read their own output", { timeout: 60_000 }, async () => {
    const one = pool("Overlap", {
      "a.md": plan("A", "Change src/a.js."),
      "b.md": plan("B", "Change src/b.js."),
    });
    const env = {
      ...one.env,
      STUB: "backgrounded",
      // Each start's session by its worktree.
      STUB_BG_IDS: JSON.stringify({ "executor-1": "1111aaaa", "executor-2": "2222bbbb" }),
    };
    const children: ReturnType<typeof spawn>[] = [];
    const begin = (path: string) => {
      const child = spawn("node", [join(here, "plan-queue.mjs"), "start", path], { env });
      children.push(child);
      let said = "";
      child.stdout.on("data", (chunk) => (said += chunk));
      child.stdin.end();
      return new Promise<string>((done) => child.on("close", () => done(said)));
    };
    const claims = () => {
      try {
        return JSON.parse(readFileSync(join(one.dir, ".claude", "executor.claims.json"), "utf8"));
      } catch {
        return {};
      }
    };
    let saidA = "";
    let saidB = "";
    try {
      const first = begin("plans/a.md");
      // The second starts while the first still waits on its session's row.
      const by = Date.now() + 20_000;
      while (!claims()["slot:1"] && Date.now() < by) await new Promise((r) => setTimeout(r, 100));
      expect(claims()["slot:1"]).toBeTruthy();
      const second = begin("plans/b.md");
      [saidA, saidB] = await Promise.all([first, second]);
    } finally {
      // A failed wait leaves no start running beside the rest of the suite.
      for (const child of children) if (child.exitCode === null) child.kill();
    }
    expect(saidA).not.toContain("was not started");
    expect(saidB).not.toContain("was not started");
    expect(saidA).toContain("Overlap Executor 1 (lab) was started on: plans/a.md, in executor-1.");
    expect(saidB).toContain("Overlap Executor 2 (lab) was started on: plans/b.md, in executor-2.");
    expect(claims()["plans/a.md"].holder).toBe("1111aaaa");
    expect(claims()["plans/b.md"].holder).toBe("2222bbbb");
  });

  // plans/overlapping-starts-own-names.md: a start holds its name until it
  // is logged, so a second start at the same moment numbers past it.
  it(
    "two overlapping starts get two names, and each claims its plan for its own session",
    { timeout: 60_000 },
    async () => {
      const one = pool("Overlap", {
        "a.md": plan("A", "Change src/a.js."),
        "b.md": plan("B", "Change src/b.js."),
      });
      const ids = {
        "executor-1": "1111aaaa-0000-4000-8000-000000000001",
        "executor-2": "2222bbbb-0000-4000-8000-000000000002",
      };
      // Each session's row is listed six seconds after its launch, inside
      // launch's ten, so the second numbers while the first is unlisted.
      const env = { ...one.env, STUB_ROW_AFTER: "6000", STUB_BG_IDS: JSON.stringify(ids) };
      const children: ReturnType<typeof spawn>[] = [];
      const begin = (path: string) => {
        const child = spawn("node", [join(here, "plan-queue.mjs"), "start", path], { env });
        children.push(child);
        let said = "";
        child.stdout.on("data", (chunk) => (said += chunk));
        child.stdin.end();
        return new Promise<string>((done) => child.on("close", () => done(said)));
      };
      const claims = () => {
        try {
          return JSON.parse(readFileSync(join(one.dir, ".claude", "executor.claims.json"), "utf8"));
        } catch {
          return {};
        }
      };
      let saidA = "";
      let saidB = "";
      try {
        const first = begin("plans/a.md");
        const by = Date.now() + 20_000;
        while (!claims()["slot:1"] && Date.now() < by) await new Promise((r) => setTimeout(r, 100));
        expect(claims()["slot:1"]).toBeTruthy();
        const second = begin("plans/b.md");
        [saidA, saidB] = await Promise.all([first, second]);
      } finally {
        for (const child of children) if (child.exitCode === null) child.kill();
      }
      expect(saidA).toContain(
        "Overlap Executor 1 (lab) was started on: plans/a.md, in executor-1.",
      );
      expect(saidB).toContain(
        "Overlap Executor 2 (lab) was started on: plans/b.md, in executor-2.",
      );
      expect(claims()["plans/a.md"].holder).toBe(ids["executor-1"]);
      expect(claims()["plans/b.md"].holder).toBe(ids["executor-2"]);
      const logged = readFileSync(join(one.dir, ".claude", "starts.log"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).name);
      expect(logged.sort()).toEqual(["Overlap Executor 1 (lab)", "Overlap Executor 2 (lab)"]);
      expect(existsSync(join(one.dir, ".claude", "starts.log.names.json"))).toBe(false);
    },
  );

  it("a planner start beside an executor start keeps its own number", { timeout: 30_000 }, () => {
    const one = pool("Overlap", { "a.md": plan("A", "Change src/a.js.") });
    writeFileSync(
      join(one.dir, "plans", "q.md"),
      "# Q\n\nBrief for the planner, 26 November 2026.\n\n## What was asked\n\nA question.\n",
    );
    const names = join(one.dir, ".claude", "starts.log.names.json");
    // Another start, at work this moment, holds the first executor's name.
    writeFileSync(
      names,
      JSON.stringify({ "Overlap Executor 1 (lab)": { pid: 999999, at: Date.now() } }),
    );
    const planner = one.queue(["start", "--agent", "planner", "plans/q.md"]);
    expect(planner).toContain("Overlap Planner 1 (lab) was started on: plans/q.md.");
    const executor = one.queue(["start", "plans/a.md"]);
    expect(executor).toContain(
      "Overlap Executor 2 (lab) was started on: plans/a.md, in executor-1.",
    );
    // Each start let its own name go; the other start's is left to it.
    expect(Object.keys(JSON.parse(readFileSync(names, "utf8")))).toEqual([
      "Overlap Executor 1 (lab)",
    ]);
  });

  it("a held name lapses after two minutes", { timeout: 30_000 }, () => {
    const one = pool("Overlap", { "a.md": plan("A", "Change src/a.js.") });
    const names = join(one.dir, ".claude", "starts.log.names.json");
    writeFileSync(
      names,
      JSON.stringify({
        "Overlap Executor 1 (lab)": { pid: 999999, at: Date.now() - 3 * 60_000 },
      }),
    );
    expect(one.queue(["start", "plans/a.md"])).toContain(
      "Overlap Executor 1 (lab) was started on: plans/a.md, in executor-1.",
    );
    expect(existsSync(names)).toBe(false);
  });

  // plans/names-guard-taken.md: a crashed holder's guard is removed at ten
  // seconds, and a start waits twelve for it, so it never goes on unheld.
  it("a start waits out a crashed holder's guard and holds its name", { timeout: 60_000 }, () => {
    const one = pool("Guard", { "a.md": plan("A", "Change src/a.js.") });
    const names = join(one.dir, ".claude", "starts.log.names.json");
    const guard = `${names}.guard`;
    // Written now, it is removed ten seconds on: a start that gave up at three
    // went on unheld, however long it took to reach the guard.
    writeFileSync(guard, "999999");
    writeFileSync(
      names,
      JSON.stringify({ "Guard Executor 1 (lab)": { pid: 999999, at: Date.now() } }),
    );
    expect(one.queue(["start", "plans/a.md"])).toContain(
      "Guard Executor 2 (lab) was started on: plans/a.md, in executor-1.",
    );
    expect(existsSync(guard)).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(names, "utf8")))).toEqual([
      "Guard Executor 1 (lab)",
    ]);
  });

  // plans/late-session-keeps-its-name.md: a failed launch may still bring
  // its session up under the name, so the name lapses with its span.
  it("a start whose launch fails keeps its name for two minutes", { timeout: 60_000 }, () => {
    const one = pool("Overlap", { "a.md": plan("A", "Change src/a.js.") });
    const names = join(one.dir, ".claude", "starts.log.names.json");
    const held = () => Object.keys(JSON.parse(readFileSync(names, "utf8")));
    const refused = one.queue(["start", "plans/a.md"], {}, { STUB: "untrusted" });
    expect(refused).toContain("Overlap Executor 1 (lab) was not started: Workspace not trusted");
    expect(held()).toEqual(["Overlap Executor 1 (lab)"]);
    expect(one.queue(["start", "plans/a.md"])).toContain(
      "Overlap Executor 2 (lab) was started on: plans/a.md, in executor-1.",
    );
    expect(held()).toEqual(["Overlap Executor 1 (lab)"]);
  });

  it("a session that comes up late shares no name", { timeout: 90_000 }, async () => {
    const one = pool("Late", { "a.md": plan("A", "Change src/a.js.") });
    const names = join(one.dir, ".claude", "starts.log.names.json");
    // The launcher says nothing, and its session is listed twenty seconds on.
    const late = one.queue(
      ["start", "plans/a.md"],
      {},
      { STUB_SILENT: "1", STUB_ROW_AFTER: "20000" },
    );
    expect(late).toContain(
      "Late Executor 1 (lab) was started, but has not appeared in claude agents after ten seconds",
    );
    expect(Object.keys(JSON.parse(readFileSync(names, "utf8")))).toEqual(["Late Executor 1 (lab)"]);
    expect(one.queue(["start", "plans/a.md"])).toContain(
      "Late Executor 2 (lab) was started on: plans/a.md, in executor-1.",
    );
    const by = Date.now() + 30_000;
    while (one.read().length < 2 && Date.now() < by) await new Promise((r) => setTimeout(r, 500));
    expect(
      one
        .read()
        .map((row: { name: string }) => row.name)
        .sort(),
    ).toEqual(["Late Executor 1 (lab)", "Late Executor 2 (lab)"]);
  });

  it("nextName numbers one above the highest of its kind and project", () => {
    const at = { project: "Docs", machine: "lab" };
    expect(nextName("executor", { ...at, names: [] })).toBe("Docs Executor 1 (lab)");
    expect(
      nextName("executor", { ...at, names: ["Docs Executor 1 (lab)", "Docs Executor 3 (lab)"] }),
    ).toBe("Docs Executor 4 (lab)");
    // Another project's and another kind's names are not counted.
    expect(
      nextName("executor", {
        ...at,
        names: ["Web Executor 7 (lab)", "Docs Planner 5 (lab)", "Docs Assistant", ""],
      }),
    ).toBe("Docs Executor 1 (lab)");
    expect(nextName("planner", { ...at, names: ["Docs Planner 5 (lab)"] })).toBe(
      "Docs Planner 6 (lab)",
    );
    // A name with no machine, as the old log has, is counted.
    expect(nextName("executor", { ...at, names: ["Docs Executor 2"] })).toBe(
      "Docs Executor 3 (lab)",
    );
  });

  // plans/claim-carries-the-launched-id.md: a start's claim holds the
  // launched session's id, and a name claim reads as its session's everywhere.
  it(
    "a start confirmed only by claude --bg's line claims the plan for the printed id",
    { timeout: 30_000 },
    () => {
      const one = pool("Printed", { "a.md": plan("A", "Change src/a.js.") });
      const said = one.queue(["start"], {}, { STUB: "backgrounded" });
      expect(said).toContain("Printed Executor 1 (lab) was started on: plans/a.md, in executor-1.");
      const claims = () =>
        JSON.parse(readFileSync(join(one.dir, ".claude", "executor.claims.json"), "utf8"));
      expect(claims()["plans/a.md"].holder).toBe("1234abcd");
      const at = new Date(claims()["plans/a.md"].at).toTimeString().slice(0, 5);
      // Not listed yet, the claim holds: no other start takes the plan.
      expect(one.queue(["start", "--dry"]).trim()).toBe(
        `plans/a.md is Printed Executor 1 (lab)'s [1234abcd], taken at ${at}: leave it.`,
      );
      const started = "1234abcd-0000-4000-8000-000000000001";
      const other = "ef015678-0000-4000-8000-000000000002";
      one.write(
        [
          [started, "Printed Executor 1 (lab)"],
          [other, "Printed Executor 2 (lab)"],
        ].map(([sessionId, name]) => ({
          sessionId,
          name,
          kind: "background",
          status: "busy",
          cwd: one.dir,
        })),
      );
      const file = join(one.dir, "plans", "a.md");
      const edit = (session: string) =>
        JSON.parse(
          one.queue(["tool"], {
            session_id: session,
            agent_type: "workflow:executor",
            cwd: one.dir,
            tool_name: "Edit",
            tool_input: {
              file_path: file,
              old_string: "\n\nPlan only",
              new_string: `\n\n## Building, 26 November 2026, session ${session}\n\nPlan only`,
            },
          }) || "{}",
        );
      expect(edit(other).hookSpecificOutput?.permissionDecisionReason).toBe(
        `plans/a.md is Printed Executor 1 (lab)'s [1234abcd], taken at ${at}: leave it.`,
      );
      expect(edit(started).hookSpecificOutput?.permissionDecision).not.toBe("deny");
      // A row whose agent id is the printed one holds it too, whatever its session id (Codex C1).
      const agent = "c41d0000-0000-4000-8000-000000000003";
      one.write([
        {
          sessionId: agent,
          id: "1234abcd",
          name: "Printed Executor 1 (lab)",
          kind: "background",
          status: "busy",
          cwd: one.dir,
        },
        {
          sessionId: other,
          name: "Printed Executor 2 (lab)",
          kind: "background",
          status: "busy",
          cwd: one.dir,
        },
      ]);
      expect(edit(agent).hookSpecificOutput?.permissionDecision).not.toBe("deny");
      expect(edit(other).hookSpecificOutput?.permissionDecision).toBe("deny");
      // A claim under a whole id no row lists ends at once: only a printed id waits for its row (Codex C6).
      const now = Date.now();
      writeFileSync(
        join(one.dir, ".claude", "executor.claims.json"),
        JSON.stringify({
          "plans/a.md": {
            holder: "dead0000-0000-4000-8000-000000000009",
            name: "Gone",
            at: now,
            until: now + 30 * 60_000,
          },
        }),
      );
      expect(edit(other).hookSpecificOutput?.permissionDecision).not.toBe("deny");
    },
  );

  it("takerFor reads an idle executor holding a name claim as holding it", () => {
    const sessions = [
      {
        sessionId: "abcd1234-0000-4000-8000-000000000001",
        name: "Taker Executor 1 (lab)",
        number: 1,
        status: "idle",
      },
    ];
    const claims = {
      "plans/a.md": { holder: "name:Taker Executor 1 (lab)", name: "Taker Executor 1 (lab)" },
    };
    const b = { path: "plans/b.md", state: "ready" };
    expect(takerFor(b, { executors: 1, sessions, claims })).toBeNull();
    expect(takerFor(b, { executors: 2, sessions, claims })).toEqual({ number: 2, session: null });
    // Held by a start of its id, as claude --bg prints it, it is held as well.
    expect(
      takerFor(b, { executors: 1, sessions, claims: { "plans/a.md": { holder: "abcd1234" } } }),
    ).toBeNull();
    // Another session's name claim leaves it free.
    expect(
      takerFor(b, {
        executors: 1,
        sessions,
        claims: { "plans/a.md": { holder: "name:Taker Executor 2 (lab)" } },
      }),
    ).toEqual({ number: 1, session: sessions[0] });
  });

  it("replacing a session releases its name claim", { timeout: 30_000 }, () => {
    const one = pool("Replace", { "a.md": plan("A", "Change src/a.js.") });
    const old = "abcd1234-0000-4000-8000-000000000001";
    const name = "Replace Executor 1 (lab)";
    one.write([{ sessionId: old, name, kind: "background", status: "idle", cwd: one.tree(1) }]);
    const at = Date.now();
    writeFileSync(
      join(one.dir, ".claude", "executor.claims.json"),
      JSON.stringify({
        "plans/a.md": { holder: `name:${name}`, name, at, until: at + 30 * 60_000 },
      }),
    );
    const said = one.queue(["start", "plans/a.md", "--replace", old]);
    expect(said).toContain("was started on: plans/a.md, in executor-1.");
    const fresh = one.read().find((row: { sessionId: string }) => row.sessionId !== old);
    expect(
      JSON.parse(readFileSync(join(one.dir, ".claude", "executor.claims.json"), "utf8"))[
        "plans/a.md"
      ].holder,
    ).toBe(fresh.sessionId);
  });

  it("a name claim's refusal shows no name in the id's place", () => {
    const one = pool("Bracket", { "a.md": plan("A", "Change src/a.js.") });
    const other = "ef015678-0000-4000-8000-000000000002";
    const name = "Bracket Executor 9 (host)";
    const rows = [
      {
        sessionId: other,
        name: "Bracket Executor 10 (host)",
        kind: "background",
        status: "busy",
        cwd: one.dir,
      },
    ];
    one.write(rows);
    const at = Date.now();
    writeFileSync(
      join(one.dir, ".claude", "executor.claims.json"),
      JSON.stringify({
        "plans/a.md": { holder: `name:${name}`, name, at, until: at + 30 * 60_000 },
      }),
    );
    const hhmm = new Date(at).toTimeString().slice(0, 5);
    const edit = () =>
      JSON.parse(
        one.queue(["tool"], {
          session_id: other,
          agent_type: "workflow:executor",
          cwd: one.dir,
          tool_name: "Edit",
          tool_input: {
            file_path: join(one.dir, "plans", "a.md"),
            old_string: "\n\nPlan only",
            new_string: `\n\n## Building, 26 November 2026, session ${other}\n\nPlan only`,
          },
        }) || "{}",
      );
    // No row has the name: no brackets.
    expect(edit().hookSpecificOutput?.permissionDecisionReason).toBe(
      `plans/a.md is ${name}'s, taken at ${hhmm}: leave it.`,
    );
    // A row has it: its id, at eight.
    one.write([
      ...rows,
      {
        sessionId: "abcd1234-0000-4000-8000-000000000001",
        name,
        kind: "background",
        status: "busy",
        cwd: one.dir,
      },
    ]);
    expect(edit().hookSpecificOutput?.permissionDecisionReason).toBe(
      `plans/a.md is ${name}'s [abcd1234], taken at ${hhmm}: leave it.`,
    );
  });

  it("refuses a Building line on a built plan and lists it once, under Built", () => {
    const one = pool("Built", {
      "a.md": `${plan("A", "Change src/a.js.")}\n## Built, ${today()}\n\nCommit \`0123abcd\` on test.\n`,
    });
    const id = "built-exec-0000";
    one.write([
      {
        sessionId: id,
        name: "Built Executor 1 (lab)",
        kind: "background",
        status: "busy",
        cwd: one.tree(1),
      },
    ]);
    const file = join(one.dir, "plans", "a.md");
    const out = JSON.parse(
      one.queue(["tool"], {
        session_id: id,
        agent_type: "workflow:executor",
        cwd: one.tree(1),
        tool_name: "Edit",
        tool_input: {
          file_path: file,
          old_string: "\n\nPlan only",
          new_string: `\n\n## Building, 24 November 2026, session ${id}\n\nPlan only`,
        },
      }),
    );
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe(
      'plans/a.md is built already: its "Built" section stands.',
    );
    const listed = one.queue(["list"]);
    expect(listed.match(/plans\/a\.md/g)).toHaveLength(1);
    expect(listed).toMatch(/Built today\n  plans\/a\.md/);
    rmSync(stateFile(id), { force: true });
  });

  it("starts none while every executor is at work, and says the first to finish takes it", () => {
    const one = pool("Full", { "x.md": plan("X", "Change src/x.js.") });
    one.write(
      [1, 2, 3].map((n) => ({
        sessionId: `full-${n}`,
        name: `Full Executor ${n} (lab)`,
        kind: "background",
        status: "busy",
        cwd: one.tree(n),
      })),
    );
    expect(one.queue(["start", "plans/x.md"])).toContain(
      "All 3 executors are at work (Full Executor 1 (lab), Full Executor 2 (lab), Full Executor 3 (lab)): the first to finish takes plans/x.md.",
    );
  });

  it("reads one executor, number 1, with no executors line, and says a value that is no whole number", () => {
    expect(executorsOf(undefined)).toBe(1);
    expect(executorsOf(3)).toBe(3);
    const one = pool("Plain", { "a.md": plan("A", "Change src/a.js.") }, "");
    expect(one.queue(["start", "--dry"])).toContain(
      "Would run it in .claude/worktrees/executor-1.",
    );
    expect(one.queue(["list"])).toContain("The executor: none alive; 1 plan ready");
    const bad = pool("Bad", {}, "executors: 0\n");
    let said = "";
    try {
      bad.queue(["check"]);
    } catch (error) {
      said = String((error as { stdout?: string }).stdout || "");
    }
    expect(said).toContain("executors: 0 is no whole number of 1 or more.");
  });

  it("plans check lints the catalogue of the worktree it is run in, and the checkout's from the checkout", () => {
    // Inherited: one beside the checkout, and one in it that git does not
    // carry into a worktree; both are the checkout's from the worktree too.
    const shared = temp("lint-shared-");
    writeFileSync(join(shared, "a.md"), "- `s` **Shared.** (Javi, 2026-10-21)\n");
    const one = pool(
      "Lint",
      {},
      `catalogue: docs/decisions.md\ninherits:\n  - ../${basename(shared)}\n  - local\n`,
    );
    mkdirSync(join(one.dir, "local"));
    writeFileSync(join(one.dir, "local", "a.md"), "- `l` **Local.** (Javi, 2026-10-21)\n");
    mkdirSync(join(one.dir, "docs"));
    writeFileSync(join(one.dir, "docs", "decisions.md"), "- `x` **One.** (Javi, 2026-10-21)\n");
    g(one.dir, "add", "docs");
    g(one.dir, "commit", "-q", "-m", "two");
    g(one.dir, "worktree", "add", "-q", "--detach", one.tree(1));
    writeFileSync(
      join(one.tree(1), "docs", "decisions.md"),
      "- `x` **One.** (Javi, 2026-10-21)\n- **No tier.**\n",
    );
    const check = (cwd: string) => {
      try {
        const out = execFileSync("node", [join(here, "plan-queue.mjs"), "check"], {
          cwd,
          encoding: "utf8",
          env: one.env,
        });
        return { out, code: 0 };
      } catch (error) {
        const e = error as { stdout: string; status: number };
        return { out: e.stdout, code: e.status };
      }
    };
    const inTree = check(one.tree(1));
    expect(inTree.code).toBe(1);
    expect(inTree.out).toContain("docs/decisions.md: no tier and date: **No tier.**");
    expect(inTree.out).not.toContain("no such catalogue");
    expect(inTree.out).toContain("4 entries in 3 files, 1 fault.");
    const inCheckout = check(one.dir);
    expect(inCheckout.code).toBe(0);
    expect(inCheckout.out).not.toContain("no tier and date");
    expect(inCheckout.out).toContain("3 entries in 3 files, no faults.");
  });

  /**
   * **A heavy step takes a slot**: `plans hold` started in the background in a
   * pool, its command a shell line that appends its start and end to one log.
   */
  const holding = (front: string) => {
    const one = pool("Hold", {}, `executors: 3\n${front}`);
    const log = join(one.dir, "steps.log");
    const lines = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
    const hold = (
      tag: string,
      args: string[],
      { seconds = 1, extra = {} as Record<string, string> } = {},
    ) => {
      const child = spawn(
        "node",
        [
          join(here, "plan-queue.mjs"),
          "hold",
          ...args,
          "--",
          "sh",
          "-c",
          `echo start ${tag} >> '${log}'; sleep ${seconds}; echo end ${tag} >> '${log}'`,
        ],
        { env: { ...one.env, WORKFLOW_HOLD_POLL: "200", ...extra }, detached: true },
      );
      let err = "";
      child.stderr.on("data", (chunk) => (err += chunk));
      const done = new Promise<{ code: number | null; err: string }>((resolve) =>
        child.on("exit", (code) => resolve({ code, err })),
      );
      return { child, done };
    };
    const until = async (ok: () => boolean, ms = 10_000) => {
      const end = Date.now() + ms;
      while (!ok()) {
        if (Date.now() > end) throw new Error(`timed out; log: ${lines().join(" | ")}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const waiting = (pid: number | undefined) =>
      existsSync(join(one.dir, ".claude", `executor.wait.browser.${pid}.json`));
    /** Kills a `plans hold` and the command's own process group, as a machine's kill of both would. */
    const kill = (child: ReturnType<typeof spawn>) => {
      const slots = readdirSync(join(one.dir, ".claude")).filter((f) =>
        f.startsWith("executor.hold."),
      );
      for (const file of slots) {
        const held = JSON.parse(readFileSync(join(one.dir, ".claude", file), "utf8"));
        if (held.pid === child.pid && held.group) process.kill(-held.group, "SIGKILL");
      }
      process.kill(-(child.pid as number), "SIGKILL");
    };
    return { ...one, log, lines, hold, until, waiting, kill };
  };

  it("runs a second step on a resource of one slot only after the first has ended", async () => {
    const one = holding("resources:\n  browser: 1\n");
    const a = one.hold("a", ["browser"]);
    await one.until(() => one.lines().includes("start a"));
    const b = one.hold("b", ["browser"]);
    await Promise.all([a.done, b.done]);
    expect(one.lines()).toEqual(["start a", "end a", "start b", "end b"]);
    expect((await b.done).err).toMatch(
      /^Waiting for browser: 1 of 1 taken \(pid \d+, since \d\d:\d\d\), 0 ahead\.\nbrowser is free: running sh -c /,
    );
  });

  it("runs two steps at once on a resource of two slots, and the third waits", async () => {
    const one = holding("resources:\n  browser: 2\n");
    const a = one.hold("a", ["browser"], { seconds: 2 });
    const b = one.hold("b", ["browser"], { seconds: 2 });
    await one.until(() => one.lines().length >= 2);
    const c = one.hold("c", ["browser"]);
    await Promise.all([a.done, b.done, c.done]);
    const lines = one.lines();
    expect(lines.slice(0, 2).sort()).toEqual(["start a", "start b"]);
    expect(lines[2]).toMatch(/^end [ab]$/);
    expect(lines.indexOf("start c")).toBeGreaterThan(2);
  });

  it("runs the step that began waiting first first", async () => {
    const one = holding("resources:\n  browser: 1\n");
    const a = one.hold("a", ["browser"], { seconds: 2 });
    await one.until(() => one.lines().includes("start a"));
    const b = one.hold("b", ["browser"]);
    await one.until(() => one.waiting(b.child.pid));
    const c = one.hold("c", ["browser"]);
    await Promise.all([a.done, b.done, c.done]);
    expect(one.lines()).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it(
    "starts the next waiting step within ten seconds of the holder being killed",
    { timeout: 40_000 },
    async () => {
      const one = holding("resources:\n  browser: 1\n");
      const a = one.hold("a", ["browser"], { seconds: 30 });
      await one.until(() => one.lines().includes("start a"));
      // The queue's own five seconds between looks, not the tests' faster one.
      const b = one.hold("b", ["browser"], { extra: { WORKFLOW_HOLD_POLL: "" } });
      await one.until(() => one.waiting(b.child.pid));
      one.kill(a.child);
      const killed = Date.now();
      await one.until(() => one.lines().includes("start b"), 10_000);
      expect(Date.now() - killed).toBeLessThan(10_000);
      expect((await b.done).code).toBe(0);
    },
  );

  it("keeps the slot taken while the command runs, its plans hold process killed alone", async () => {
    const one = holding("resources:\n  browser: 1\n");
    const a = one.hold("a", ["browser"], { seconds: 2 });
    await one.until(() => one.lines().includes("start a"));
    const b = one.hold("b", ["browser"]);
    await one.until(() => one.waiting(b.child.pid));
    process.kill(a.child.pid as number, "SIGKILL");
    await b.done;
    expect(one.lines()).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("exits with the command's code, the command's output its own", () => {
    const one = holding("resources:\n  browser: 1\n");
    const done = spawnSync(
      "node",
      [join(here, "plan-queue.mjs"), "hold", "browser", "--", "sh", "-c", "echo out; exit 3"],
      { env: one.env, encoding: "utf8" },
    );
    expect(done.status).toBe(3);
    expect(done.stdout).toBe("out\n");
    expect(done.stderr).toBe("");
    expect(readdirSync(join(one.dir, ".claude")).filter((f) => f.includes(".hold."))).toEqual([]);
  });

  it("holds a resource named as an object's own key, constructor, as any other", () => {
    const one = holding("resources:\n  browser: 1\n");
    const done = spawnSync(
      "node",
      [join(here, "plan-queue.mjs"), "hold", "constructor", "--", "sh", "-c", "echo ran"],
      { env: one.env, encoding: "utf8" },
    );
    expect(done.status).toBe(0);
    expect(done.stdout).toBe("ran\n");
  });

  it("gives a name the project file does not give one slot", async () => {
    const one = holding("resources:\n  browser: 2\n");
    const a = one.hold("a", ["gpu"], { seconds: 2 });
    await one.until(() => one.lines().includes("start a"));
    const b = one.hold("b", ["gpu"]);
    await Promise.all([a.done, b.done]);
    expect(one.lines()).toEqual(["start a", "end a", "start b", "end b"]);
    expect((await b.done).err).toContain(
      `Waiting for gpu: 1 of 1 taken (pid ${a.child.pid}, since`,
    );
  });

  it("exits 75 and runs nothing when no slot comes free in the wait", async () => {
    const one = holding("resources:\n  browser: 1\n");
    const a = one.hold("a", ["browser"], { seconds: 10 });
    await one.until(() => one.lines().includes("start a"));
    const b = one.hold("b", ["browser", "--wait", "0.05"]);
    const { code, err } = await b.done;
    expect(code).toBe(75);
    expect(err).toMatch(
      new RegExp(
        `\\nNo slot of browser came free in 0\\.05 minutes \\(pid ${a.child.pid}, since \\d\\d:\\d\\d\\): nothing was run\\.\\n$`,
      ),
    );
    expect(one.lines()).toEqual(["start a"]);
    expect(one.waiting(b.child.pid)).toBe(false);
    one.kill(a.child);
  });

  it("lists the resource's line under the executors and the executors' words on their rows", async () => {
    const one = holding("resources:\n  browser: 1\n");
    one.write(
      [2, 3].map((n) => ({
        sessionId: `hold-${n}`,
        name: `Hold Executor ${n} (lab)`,
        kind: "background",
        status: "busy",
        cwd: one.tree(n),
      })),
    );
    const a = one.hold("a", ["browser"], { seconds: 10, extra: { WORKFLOW_EXECUTOR: "2" } });
    await one.until(() => one.lines().includes("start a"));
    const b = one.hold("b", ["browser"], { extra: { WORKFLOW_EXECUTOR: "3" } });
    await one.until(() => one.waiting(b.child.pid));
    const listed = one.queue(["list"]);
    for (const child of [a.child, b.child]) one.kill(child);
    expect(listed).toMatch(
      /\n  2  Hold Executor 2 \(lab\) \[hold-2\], busy, [^\n]*, running browser\n/,
    );
    expect(listed).toMatch(
      /\n  3  Hold Executor 3 \(lab\) \[hold-3\], busy, [^\n]*, waiting for browser\n/,
    );
    expect(listed).toMatch(
      /\nbrowser: 1 of 1 taken \(executor 2, since \d\d:\d\d\), 1 waiting \(executor 3, since \d\d:\d\d\)\n/,
    );
  });

  it("plans check says a resources value that is no whole number of 1 or more", () => {
    const one = pool("Slots", {}, "resources:\n  browser: 0\n  db: two\n  Big: 2\n  gpu: 2\n");
    let said = "";
    try {
      one.queue(["check"]);
    } catch (error) {
      said = String((error as { stdout?: string }).stdout || "");
    }
    expect(said).toContain("resources: browser: 0 is no whole number of 1 or more.");
    expect(said).toContain("resources: db: two is no whole number of 1 or more.");
    expect(said).toContain("resources: Big is no name plans hold takes (a-z, 0-9 and -).");
    expect(said).not.toContain("gpu");
    const flat = pool("Flat", {}, "resources: 2\n");
    try {
      flat.queue(["check"]);
      said = "";
    } catch (error) {
      said = String((error as { stdout?: string }).stdout || "");
    }
    expect(said).toContain("resources: 2 is no map of names to whole numbers.");
  });
});
