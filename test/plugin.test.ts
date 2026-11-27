import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  agentLine,
  appLine,
  canStart,
  checkDeny,
  data,
  decideStop,
  isSession,
  machine,
  owner,
  parseName,
  sessionName,
  pathsIn,
  sessionEnv,
} from "../plugins/workflow/scripts/plan-queue.mjs";
import { FILES, missing, steps } from "../plugins/workflow/scripts/install-check.mjs";
import { install, onPath, source, WRAPPER } from "../plugins/workflow/scripts/plans-on-path.mjs";
import {
  defaultBranch,
  readFrontmatter,
  ignoreQueueFiles,
  init,
  kindOf,
  peopleOf,
  matches,
  project,
  QUEUE_IGNORES,
  QUEUE_KINDS,
  sessionAgent,
} from "../plugins/workflow/scripts/project.mjs";
import {
  agentsChoice,
  globToRegExp,
  reasonFor,
  untiered,
} from "../plugins/workflow/scripts/turn-audit.mjs";

// The end timer and the stops are recorded here, so no hook a test runs
// leaves a timer sleeping for an hour (plans/idle-chats-end.md).
process.env.WORKFLOW_STOP_LOG = join(tmpdir(), `workflow-stops-plugin-${process.pid}.log`);

const scripts = new URL("../plugins/workflow/scripts/", import.meta.url).pathname;
const made: string[] = [];
const dir = (prefix: string) => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  made.push(path);
  return path;
};
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

describe("the project file", () => {
  it("reads a backslashed value back as written", () => {
    const root = dir("note-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      "---\nname: Paper\nnote: \\JaviAI   # the note command\nreply: \\javi\n---\n",
    );
    const text = readFileSync(join(root, ".claude", "workflow.md"), "utf8");
    expect(readFrontmatter(text).values).toMatchObject({ note: "\\JaviAI", reply: "\\javi" });
  });

  it("reads name, branch, run, ui and catalogue", () => {
    const root = dir("project-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      `---
name: Docs   # the name in session names
branch: test
run: image.yml
ui:
  - "apps/*/src/**"
  - 'packages/ui/**'
catalogue: docs/patterns
---

# Body
`,
    );
    expect(project(root)).toMatchObject({
      name: "Docs",
      branch: "test",
      run: "image.yml",
      ui: ["apps/*/src/**", "packages/ui/**"],
      catalogue: "docs/patterns",
      found: true,
    });
    expect(project(root).body).toContain("# Body");
  });

  it("reads the text under ## Pull requests as pullRequests, and none without the heading", () => {
    const root = dir("pulls-");
    mkdirSync(join(root, ".claude"));
    const file = join(root, ".claude", "workflow.md");
    writeFileSync(
      file,
      "---\nname: Pulls\nland: pull-request\n---\n\n## After the push\n\nThe run.\n\n## Pull requests\n\nRelated plans share one.\nA new one opens only when none fits.\n\n## Reading\n\nRead.\n",
    );
    expect(project(root).pullRequests).toBe(
      "Related plans share one.\nA new one opens only when none fits.",
    );
    writeFileSync(file, "---\nname: Pulls\n---\n\n## Pull requests\n\nA pull request per topic.\n");
    expect(project(root).pullRequests).toBe("A pull request per topic.");
    writeFileSync(file, "---\nname: Pulls\n---\n\n## Reading\n\nRead.\n");
    expect(project(root).pullRequests).toBe("");
  });

  it("reads the logins in backticks under ## People as people, and none without the heading", () => {
    const root = dir("people-");
    mkdirSync(join(root, ".claude"));
    const file = join(root, ".claude", "workflow.md");
    writeFileSync(
      file,
      "---\nname: People\n---\n\n## People\n\nHenry (`@Henry-B`) decides the copy; Anton (`anton_x`) the data, with `henry-b` again.\nMara has no login. `not a login` and `-dash` are none.\n\n## Reading\n\nRead `main`.\n",
    );
    expect(project(root).people).toEqual(["henry-b", "anton_x"]);
    expect(peopleOf("## People\n\n`henry`\n")).toEqual(["henry"]);
    writeFileSync(file, "---\nname: People\n---\n\n## Reading\n\nRead `henry`.\n");
    expect(project(root).people).toEqual([]);
  });

  it("defaults the name to the directory and the branch to the remote's default, else main", () => {
    const root = dir("defaults-");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q", "-b", "work");
    // At run time the branch checked out is a plan's: never the project's.
    expect(project(root)).toMatchObject({ branch: "main", run: "", ui: [], found: false });
    expect(project(root).name).toMatch(/^defaults-/);
    const origin = dir("origin-");
    execFileSync("git", ["init", "-q", "--bare", "-b", "trunk"], { cwd: origin, stdio: "ignore" });
    git("remote", "add", "origin", origin);
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    expect(project(root).branch).toBe("trunk");
  });

  const gitIn =
    (root: string) =>
    (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();

  it("a project with no remote takes the branch it is on", () => {
    const root = dir("master-");
    const g = gitIn(root);
    g("init", "-q", "-b", "master");
    g("commit", "-q", "--allow-empty", "-m", "one");
    expect(defaultBranch(root, { checkedOut: true })).toBe("master");
    expect(defaultBranch(root)).toBe("main");
    init(root);
    expect(readFileSync(join(root, ".claude", "workflow.md"), "utf8")).toMatch(/^branch: master$/m);
  });

  it("a remote's default branch still wins", () => {
    const root = dir("work-");
    const g = gitIn(root);
    g("init", "-q", "-b", "work");
    g("commit", "-q", "--allow-empty", "-m", "one");
    g("update-ref", "refs/remotes/origin/main", "HEAD");
    g("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    expect(defaultBranch(root, { checkedOut: true })).toBe("main");
  });

  it("a remote without origin/HEAD writes main, not the branch checked out", () => {
    const root = dir("pushed-");
    const g = gitIn(root);
    g("init", "-q", "-b", "feature");
    g("remote", "add", "origin", dir("bare-"));
    expect(defaultBranch(root, { checkedOut: true })).toBe("main");
  });

  it("a repository with no commit takes the branch git names, and a folder with no git main", () => {
    const root = dir("unborn-");
    gitIn(root)("init", "-q", "-b", "trunk");
    expect(defaultBranch(root, { checkedOut: true })).toBe("trunk");
    expect(defaultBranch(dir("nogit-"), { checkedOut: true })).toBe("main");
  });

  it("ignores every file the queue keeps in .claude/, one line per kind, and the worktrees' folder", () => {
    expect(QUEUE_IGNORES).toEqual([
      ...QUEUE_KINDS.map((kind) => `.claude/${kind}.*`),
      ".claude/assistant.*",
      ".claude/worktrees/",
      ".claude/app-token.*",
      ".claude/github-*",
      ".claude/webhook.*",
      ".claude/refreshes.*",
      ".claude/handover.*",
      ".claude/settings.local.json",
    ]);
    // The names plan-queue.mjs writes there: its literal files and one per kind.
    const source = readFileSync(join(scripts, "plan-queue.mjs"), "utf8");
    const literal = [...source.matchAll(/join\(root, "\.claude", "([^"]+)"\)/g)].map((m) => m[1]);
    // A start's output is its own, `<kind>.<pid>.started` (plans/start-output-per-start.md).
    const perKind = [
      ...source.matchAll(
        /join\(root, "\.claude", `\$\{kind\}((?:\.\$\{process\.pid\})?\.[a-z]+)`\)/g,
      ),
    ].map((m) => m[1]);
    expect(literal).toEqual(expect.arrayContaining(["executor.lock", "executor.pause"]));
    expect(perKind).toEqual(expect.arrayContaining([".deferred", ".${process.pid}.started"]));
    const names = [
      ...literal.map((name) => (name === "worktrees" ? "worktrees/x/f" : name)),
      ...QUEUE_KINDS.flatMap((kind) =>
        perKind.map((ext) => `${kind}${ext.replace("${process.pid}", "4242")}`),
      ),
      // An assistant chat's start (plans/project-follow-ups-reach-the-project.md).
      "assistant.4242.started",
      // The agent a plain chat opens as (plans/agent-set-by-the-project.md).
      "settings.local.json",
    ];
    const root = dir("ignores-");
    gitIn(root)("init", "-q");
    writeFileSync(join(root, ".gitignore"), `${QUEUE_IGNORES.join("\n")}\n`);
    const ignored = execFileSync(
      "git",
      ["check-ignore", "--no-index", ...names.map((name) => `.claude/${name}`)],
      { cwd: root, encoding: "utf8" },
    );
    expect(ignored.trim().split("\n").sort()).toEqual(
      names.map((name) => `.claude/${name}`).sort(),
    );
  });

  it("adds a missing queue line to .git/info/exclude once, even where the project's own rule overrides it", () => {
    const root = dir("exclude-");
    gitIn(root)("init", "-q");
    writeFileSync(join(root, ".gitignore"), ".claude/executor.*\n.claude/planner.*\n");
    expect(ignoreQueueFiles(root)).toBe(
      "Added .claude/asking.*, .claude/handed.*, .claude/assistant.*, .claude/worktrees/, .claude/app-token.*, .claude/github-*, .claude/webhook.*, .claude/refreshes.*, .claude/handover.*, .claude/settings.local.json to .git/info/exclude.",
    );
    expect(ignoreQueueFiles(root)).toBe("");
    writeFileSync(join(root, ".gitignore"), "!.claude/**\n");
    expect(ignoreQueueFiles(root)).toBe(
      "Added .claude/executor.*, .claude/planner.* to .git/info/exclude.",
    );
    expect(ignoreQueueFiles(root)).toBe("");
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf8").split("\n");
    for (const line of QUEUE_IGNORES) expect(exclude.filter((one) => one === line)).toHaveLength(1);
    expect(ignoreQueueFiles(dir("nogit-"))).toBe("");
  });

  it("init writes no ignore line the project already has another way", () => {
    const root = dir("init-ignored-");
    gitIn(root)("init", "-q");
    writeFileSync(join(root, ".gitignore"), ".claude/worktrees\n");
    init(root);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(
      ".claude/worktrees\n.claude/executor.*\n.claude/planner.*\n.claude/asking.*\n.claude/handed.*\n.claude/assistant.*\n.claude/app-token.*\n.claude/github-*\n.claude/webhook.*\n.claude/refreshes.*\n.claude/handover.*\n.claude/settings.local.json\n",
    );
  });

  it("writes the starter once, and refuses a second time", () => {
    const root = dir("init-");
    expect(init(root)).toBe("Wrote .claude/workflow.md: fill in each heading for this project.");
    const text = readFileSync(join(root, ".claude", "workflow.md"), "utf8");
    for (const heading of [
      "Before a build",
      "While working",
      "Before the push",
      "After the push",
      "Pull requests",
      "Reading",
    ])
      expect(text).toContain(`## ${heading}`);
    expect(text).toContain(
      "## Pull requests\n\nHow plans group into pull requests, when `land: pull-request` is on:\nrelated plans share one, or a pull request per topic; omit the heading\nto let each plan's author decide.\n\n## Reading",
    );
    // The starter's comment is no rule: the heading reads as what it says.
    expect(project(root).pullRequests).toMatch(/^How plans group into pull requests/);
    expect(project(root).found).toBe(true);
    expect(init(root)).toBe(".claude/workflow.md exists already; edit it instead.");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(
      ".claude/executor.*\n.claude/planner.*\n.claude/asking.*\n.claude/handed.*\n.claude/assistant.*\n.claude/worktrees/\n.claude/app-token.*\n.claude/github-*\n.claude/webhook.*\n.claude/refreshes.*\n.claude/handover.*\n.claude/settings.local.json\n",
    );
    expect(text).toContain(
      "# deny:                  MCP tools an agent here may never call, by agent (regular expressions)",
    );
  });

  /** A project whose frontmatter is `front`, read back through `project()`. */
  const withFront = (front: string) => {
    const root = dir("deny-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "workflow.md"), `---\n${front}---\n`);
    return project(root);
  };

  it("reads a map of lists: deny, by agent, each agent's patterns in order", () => {
    const front = `name: Lab
deny:                     # MCP tools an agent here may never call
  assistant:              # the owner's chat
    - "mcp__(claude_ai_)?lab-devops__.*"
    - mcp__lab__write_.*
  planner:
    - 'mcp__lab-personal__.*'
    - mcp__research__.*
branch: test
`;
    expect(readFrontmatter(`---\n${front}---\n`).values).toMatchObject({
      deny: {
        assistant: ["mcp__(claude_ai_)?lab-devops__.*", "mcp__lab__write_.*"],
        planner: ["mcp__lab-personal__.*", "mcp__research__.*"],
      },
      branch: "test",
    });
    const proj = withFront(front);
    expect(proj.deny).toEqual({
      assistant: ["mcp__(claude_ai_)?lab-devops__.*", "mcp__lab__write_.*"],
      planner: ["mcp__lab-personal__.*", "mcp__research__.*"],
    });
    expect(proj.branch).toBe("test");
  });

  it("gives deny as {} when absent or a flat list, which names no agent", () => {
    expect(withFront("name: Lab\n").deny).toEqual({});
    expect(withFront('name: Lab\ndeny:\n  - "mcp__lab__.*"\n').deny).toEqual({});
    expect(withFront("name: Lab\ndeny: mcp__lab__.*\n").deny).toEqual({});
  });

  it("keeps a list's items when an indented name follows them, and reads no map as a list", () => {
    const kept = withFront('tools:\n  - "mcp__x__.*"\n  extra:\n  - "mcp__y__.*"\nbranch: test\n');
    expect(kept.tools).toEqual(["mcp__x__.*", "mcp__y__.*"]);
    expect(kept.branch).toBe("test");
    expect(withFront('tools:\n  extra:\n    - "mcp__x__.*"\n').tools).toEqual([]);
    // Patterns before the first agent's name keep the list flat, which names no agent.
    expect(withFront('deny:\n  - "mcp__lab__.*"\n  assistant:\n    - "mcp__x__.*"\n').deny).toEqual(
      {},
    );
  });
});

describe("the plugin's queue in any project", () => {
  it("names sessions by the project, and counts per name", () => {
    const log = [
      { at: 0, name: "Test Executor 1" },
      { at: 0, name: "Other Executor 9" },
    ];
    expect(canStart({ log, name: "Test" })).toMatchObject({ start: true, name: "Test Executor 2" });
    expect(canStart({ log, name: "Other" })).toMatchObject({ name: "Other Executor 10" });
    expect(canStart({ kind: "planner", log, name: "Test" })).toMatchObject({
      name: "Test Planner 1",
    });
  });

  // plans/collaborating-when-claude-writes-the-code.md, parts 1, 3 and 4.
  it("keeps another person's commit on a topic's branch, and says what a change is related to", () => {
    const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
    const text = (path: string) => readFileSync(join(plugin, path), "utf8").replace(/\s+/g, " ");
    const executor = text("docs/landing.md");
    expect(executor).toContain(
      "squashed back to the plan's tip, so a commit another person pushed stays theirs",
    );
    // plans/pull-requests-small-and-plain.md, part 4: one Related list, each named once.
    expect(executor).toContain(
      "Related: <- when a plan has a Related line - #<n> - branch `<name>` ## Changes",
    );
    expect(executor).toContain(
      "Then one `Related:` line, then a list of everything the topic's plans' `Related` lines name, each once, one item a line with nothing else on it, numbers in order and then branches by name, less a number a `Closes` or `Builds on` line names and the pull request itself; none left, no `Related:` line.",
    );
    expect(executor).toContain(
      "`Closes #`, `For #`, `Builds on #` and `Related:` lines and the list under a `Related:` line, is the owner's",
    );
    // plans/pull-request-description-standard-follow-up.md: the description lists it under Also.
    expect(executor).toContain("- <The commit's title.> (<author>)");
    expect(executor).not.toContain("credited by GitHub's commits list");
    expect(executor).toContain("its link and what it was marked related to");
    for (const agent of ["planner", "assistant"])
      expect(text(`agents/${agent}.md`), agent).toContain("`Related: #31.`");
    const doc = text("docs/workflow.md");
    expect(doc).toContain("**A decision has a name; a part has none.**");
    expect(doc).toContain("**A change one person started is anyone's to go on with.**");
    // plans/also-lists-the-right-commits.md: Also holds other people's commits and no others.
    expect(executor).not.toContain("titled `Merge origin/<…> into <…>`");
    // plans/also-knows-whose-commit.md: the plans account for the queue's commits, by hash.
    expect(executor).toContain("that this checkout's plans do not account for");
    expect(executor).toContain("`git log --first-parent <tip>..HEAD --format=%H`");
    expect(executor).toContain("a merge this plan made before its tip");
    expect(executor).toContain("Nothing is left out by author or by title.");
    expect(executor).toContain("`Merged <base> <date>, commit <sha>: <files or none>`");
    expect(executor).toContain("`Refreshed <date>: merged <base>, commit <sha>,");
    expect(executor).not.toContain("^<its headRefOid>");
    expect(executor).not.toContain("git fetch origin pull/<n>/head");
    expect(executor).not.toContain("`git config user.name`");
    expect(doc).toContain("**The plans account for the queue's commits.**");
    // plans/also-knows-whose-commit-follow-up.md: every merged base down the stack, read in pages.
    expect(executor).toContain("each merged pull request down the stack");
    expect(executor).toContain("found by the `Builds on #<n>` line of its body");
    expect(executor).toContain(
      "`gh api --paginate repos/{owner}/{repo}/pulls/<n>/commits --jq '.[].sha'`",
    );
    expect(executor).not.toContain("--json commits");
    // plans/short-pull-request-descriptions.md: listed among the changes, no Also heading.
    expect(doc).toContain("with their author, among the changes");
    expect(doc).not.toContain("under `Also`");
    expect(doc).not.toContain("another person's commits with their author");
    // plans/also-docs-match-the-rule.md: the docs and the opening sentence name the rule as built.
    expect(executor).toContain("a commit's title as written");
    // plans/docs-as-a-prompt.md: the reason is the catalogue's entry, not the handbook's.
    expect(text("docs/decisions.md")).toContain(
      "the commits no plan here accounts for stay, as bullets with their author",
    );
    expect(doc).toContain("and no merged pull request down the stack already showed");
  });

  // plans/try-it-is-one-line.md.
  it("keeps a pull request's To try it to the one line of how to try it", () => {
    const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
    const executor = readFileSync(join(plugin, "docs/landing.md"), "utf8").replace(/\s+/g, " ");
    expect(executor).not.toContain("(plans/ is not tracked)");
    expect(executor).not.toContain("Checks: <the checks workflow's name>");
    // The owner's own sections are the only thing between the one line and the attribution.
    expect(
      executor.match(
        /## To try it <One line\.> <The owner's own sections, word for word, when the body has some> <the attribution lines/g,
      ),
    ).toHaveLength(2);
  });

  // plans/short-pull-request-descriptions.md, replacing plans/pull-request-description-standard.md.
  it("a pull request's description is a short list of what changed", () => {
    const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
    const executor = readFileSync(join(plugin, "docs/landing.md"), "utf8");
    const mode = executor.slice(executor.indexOf("# Landing by pull request"));
    const [topic, fixes] = [...mode.matchAll(/^```\n([\s\S]*?)^```$/gm)]
      .map((m) => m[1])
      .filter((block) => block.includes("## To try it"));
    expect(topic.indexOf("## Changes")).toBeGreaterThan(-1);
    expect(topic.indexOf("## Changes")).toBeLessThan(topic.indexOf("## To try it"));
    for (const gone of [
      "## New",
      "## Changed",
      "## Retired",
      "## Also",
      "## Decisions",
      "## Screenshots",
    ])
      expect(topic).not.toContain(gone);
    // A screenshot sits under its bullet, one level in.
    expect(topic).toMatch(/\n {2}!\[<[^\]\n]+>\]\(plans\/<topic>\/<file>\.png\)/);
    expect(fixes).toMatch(/^## Fixes\n\n- <The commit's title\.>\n/m);
    // plans/short-pull-request-descriptions-follow-up-2.md: the line is the alt text, once.
    expect(fixes).not.toContain("<What changed in the screenshot, in one line.>");
    expect(fixes).toMatch(/\n {2}!\[<[^\]\n]+>\]\(plans\/<x>\/<file>\.png\)/);
    // /code-review: the image follows its bullet with the topic's placeholder, and no line between.
    expect(fixes).toMatch(
      /^- <The commit's title\.>\n\n {2}!\[<What the picture shows, in one line\.>\]\(plans\/<x>\/<file>\.png\)/m,
    );
    expect(topic).toContain("![<What the picture shows, in one line.>]");
    expect(fixes).not.toContain("## Also");
    expect(fixes).not.toContain("plans/<x>.md");
    const doc = readFileSync(join(plugin, "docs/workflow.md"), "utf8").replace(/\s+/g, " ");
    expect(doc).toContain("**The description is a short list of what changed**");
    expect(doc).not.toContain("**The description is the catalogue's diff**");
    expect(doc).not.toContain("the plan's path;");
    const decisions = readFileSync(join(plugin, "docs/decisions.md"), "utf8");
    expect(decisions).toContain("`short-description`");
    expect(decisions).toMatch(/^\s+- ~~The description is the catalogue's diff/m);
    // plans/short-pull-request-descriptions-follow-up.md: the owner's sections stay.
    const landing = executor.replace(/\s+/g, " ");
    expect(landing).toContain(
      "So is every `## ` section whose heading the template does not name: it follows To try it, word for word, in the order the body has it.",
    );
    expect(landing).toContain(
      "On a rewrite (`gh pr view <n> --json body`) the owner's paragraphs and sections are kept as in a topic's.",
    );
    // Codex's C1: the old attribution is not kept inside the owner's last section.
    expect(landing).toContain(
      "On a rewrite, the attribution lines at the old body's end belong to none of the owner's sections: the new body ends with them once.",
    );
    expect(decisions.replace(/\s+/g, " ")).toContain(
      "A section the owner adds anywhere in the body, a topic's or the day's fixes, is kept on every rewrite (Javi).",
    );
  });

  // plans/no-session-link-in-pull-requests.md.
  it("leaves the link to a Claude session out of a pull request's description", () => {
    const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
    const executor = readFileSync(join(plugin, "docs/landing.md"), "utf8").replace(/\s+/g, " ");
    const ending =
      "<the attribution lines the session gives for a pull request, with any link to a Claude session left out>";
    expect(executor.split(ending)).toHaveLength(3);
    expect(executor).not.toContain("<the attribution lines the session gives for a pull request>");
    expect(executor).toContain("less any line with a `claude.ai/code/session_` address");
  });

  // plans/dropped-plan-state.md, part 3.
  it("names the Dropped section in the agents and the state in the doc's queue", () => {
    const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
    const text = (path: string) => readFileSync(join(plugin, path), "utf8").replace(/\s+/g, " ");
    for (const agent of ["planner", "assistant"])
      expect(text(`agents/${agent}.md`), agent).toContain(
        "`Dropped on ${user_config.owner}'s word:",
      );
    expect(text("agents/executor.md")).toContain("A plan with a `## Dropped` section is nobody's");
    const doc = text("docs/workflow.md");
    const queue = doc.slice(doc.indexOf("## The queue"));
    expect(queue).toContain(
      "`## Dropped, <date>`, written by the plan's author on the owner's word with one line of why, is dropped: never ready, never started, refused by path, out of the asking deferral",
    );
  });

  // plans/quiet-worker-starts.md, part 5.
  it("the assistant reads a worker's chat for the owner", () => {
    const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
    const assistant = readFileSync(join(plugin, "agents/assistant.md"), "utf8").replace(
      /\s+/g,
      " ",
    );
    expect(assistant).toContain("A planner's or an executor's chat is in no list of his");
    expect(assistant).toContain(
      "when he asks what one is doing, read its row in `plans` and the end of its transcript (`~/.claude/projects/*/<id>*.jsonl`",
    );
    expect(assistant).toContain(
      "tell him in a few lines what it did last and what it is on; send that chat nothing to ask.",
    );
  });

  // plans/agents-pass-messages-directly.md, parts 1 to 4.
  it("passes the agents' messages to each other, never through the owner", () => {
    const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
    const text = (path: string) => readFileSync(join(plugin, path), "utf8").replace(/\s+/g, " ");
    const planner = text("agents/planner.md");
    // plans/one-assistant-chat.md, part 3: his words here are passed on.
    expect(planner).toContain("From ${user_config.owner}: said in <this chat's name>");
    expect(planner).toContain("A message that comes in");
    expect(planner).not.toContain("For the assistant's chat in Remote Control");
    const assistant = text("agents/assistant.md");
    expect(assistant).toContain("What crosses chats");
    expect(assistant).toContain("Change from ${user_config.owner}: plans/<x>.md.");
    expect(assistant).not.toContain("Change from Javi");
    expect(text("agents/executor.md")).toContain(
      "`<Project> Assistant` on this machine by `ListAgents`",
    );
    const doc = text("docs/workflow.md");
    expect(doc).toContain("What he writes in a worker's chat is passed on");
    expect(doc).toContain("Handed to the assistant");
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
      );
    for (const file of files(plugin))
      expect(readFileSync(file, "utf8").replace(/\s+/g, " "), file).not.toContain("to paste there");
  });

  it("reads the agent from a plugin's scoped name or a bare one", () => {
    expect(kindOf({ agent_type: "workflow:executor" })).toBe("executor");
    expect(kindOf({ agent_type: "executor" })).toBe("executor");
    expect(kindOf({ agent_type: "workflow:planner" })).toBe("planner");
    expect(kindOf({})).toBe("");
  });

  it("names the project's run in the Stop hook's refusal, and refuses on none without one", () => {
    const run = {
      id: 7,
      status: "in_progress",
      conclusion: null,
      onHead: true,
      workflow: "checks.yml",
    };
    expect(decideStop({ run })).toMatchObject({ refuse: true });
    expect((decideStop({ run }) as { reason: string }).reason).toContain(
      "The checks.yml run on your push (7)",
    );
    expect(decideStop({ run: null })).toBeNull();
  });

  it("reads the owner from the option, then the settings, then says the owner", () => {
    const settings = join(dir("settings-"), "settings.json");
    expect(owner({ CLAUDE_PLUGIN_OPTION_OWNER: "Ada" }, settings)).toBe("Ada");
    expect(owner({}, settings)).toBe("the owner");
    writeFileSync(
      settings,
      JSON.stringify({ pluginConfigs: { "workflow@workflow": { options: { owner: "Grace" } } } }),
    );
    expect(owner({}, settings)).toBe("Grace");
  });

  it("reads the machine from the option, then the settings, then the hostname", () => {
    const settings = join(dir("settings-"), "settings.json");
    expect(machine({ CLAUDE_PLUGIN_OPTION_MACHINE: "lab" }, settings)).toEqual({
      name: "lab",
      set: true,
      rejected: "",
    });
    expect(machine({}, settings)).toEqual({ name: hostname(), set: false, rejected: "" });
    writeFileSync(
      settings,
      JSON.stringify({ pluginConfigs: { "workflow@workflow": { options: { machine: "lab" } } } }),
    );
    expect(machine({}, settings)).toEqual({ name: "lab", set: true, rejected: "" });
    // A label that is not one is passed over for the next, then the hostname.
    expect(machine({ CLAUDE_PLUGIN_OPTION_MACHINE: "my box" }, settings)).toEqual({
      name: "lab",
      set: true,
      rejected: "",
    });
    expect(machine({ CLAUDE_PLUGIN_OPTION_MACHINE: "my box" }, `${settings}.none`)).toEqual({
      name: hostname(),
      set: false,
      rejected: "my box",
    });
  });

  it("names a session by project, kind, number and machine, and reads the name back", () => {
    const names: [string, { project?: string; machine?: string }][] = [
      ["Workflow Executor 2 (lab)", { project: "Workflow", machine: "lab" }],
      ["Workflow Executor 2", { project: "Workflow" }],
      ["Executor 2", {}],
    ];
    for (const [name, options] of names) {
      expect(sessionName("executor", 2, options)).toBe(name);
      expect(parseName(name)).toEqual({
        project: options.project || "",
        kind: "executor",
        n: 2,
        machine: options.machine || "",
      });
    }
    for (const name of [
      "Assistant",
      "Assistant (Anton merge)",
      "Executor",
      "Docs Assistant 4 (lab)",
    ])
      expect(parseName(name)).toBeNull();
    // plans/one-assistant-chat.md, part 1: one assistant, with no number.
    expect(sessionName("assistant", 4, { project: "Docs", machine: "lab" })).toBe("Docs Assistant");
  });

  // plans/one-assistant-chat.md, part 1.
  it("opens the one assistant chat only with none open, under the shared bounds", () => {
    const log = [
      { at: 0, name: "Docs Assistant" },
      { at: 0, name: "Docs Executor 9 (lab)" },
      { at: 0, name: "Other Assistant" },
    ];
    const base = { kind: "assistant", log, name: "Docs", machine: "lab", brief: "plans/a.md" };
    expect(canStart(base)).toMatchObject({ start: true, name: "Docs Assistant" });
    expect(canStart({ ...base, open: ["Docs Assistant [44444444]"] })).toEqual({
      refuse: true,
      why: "Docs Assistant [44444444] is open: send it the message. Built: plans/a.md.",
    });
    expect(canStart({ ...base, brief: "", open: ["Docs Assistant [44444444]"] })).toEqual({
      refuse: true,
      why: "Docs Assistant [44444444] is open: send it the message.",
    });
    expect(canStart({ ...base, paused: "today" })).toMatchObject({ refuse: true });
    const now = Date.UTC(2026, 9, 31, 12);
    const usage = {
      at: now / 1000,
      five_hour: { used_percentage: 90, resets_at: now / 1000 + 3600 },
    };
    expect(canStart({ ...base, usage, now })).toMatchObject({ defer: true });
    // A quick death with nothing written refuses; another project's start does not count.
    expect(
      canStart({ ...base, log: [{ at: now - 60_000, name: "Docs Assistant" }], now }),
    ).toMatchObject({
      refuse: true,
      why: expect.stringContaining("The last assistant (Docs Assistant) ended within ten minutes"),
    });
    expect(
      canStart({ ...base, log: [{ at: now - 60_000, name: "Other Assistant" }], now }),
    ).toMatchObject({ start: true });
    // A live executor of the project does not hold an assistant back.
    expect(
      canStart({
        ...base,
        sessions: [{ sessionId: "e", name: "Docs Executor 9 (lab)", status: "busy" }],
      }),
    ).toMatchObject({ start: true });
  });

  it("numbers a start per machine, from the log and the live list", () => {
    const log = [
      { at: 0, name: "Test Executor 1" },
      { at: 0, name: "Other Executor 9" },
    ];
    expect(canStart({ log, name: "Test", machine: "lab" })).toMatchObject({
      start: true,
      name: "Test Executor 2 (lab)",
    });
    expect(
      canStart({
        kind: "planner",
        log: [{ at: 0, name: "Workflow Planner 1 (lab)" }],
        taken: ["Workflow Planner 3 (lab)", "Workflow Executor 2 (lab)", "Assistant"],
        name: "Workflow",
        machine: "lab",
      }),
    ).toMatchObject({ start: true, name: "Workflow Planner 4 (lab)" });
  });

  it("tells the queue's sessions by name, with or without the machine", () => {
    expect(isSession("executor", { name: "Workflow Executor 2 (lab)" })).toBe(true);
    expect(isSession("executor", { name: "Workflow Executor 2" })).toBe(true);
    expect(isSession("planner", { name: "Workflow Planner 1 (lab)", kind: "background" })).toBe(
      true,
    );
    expect(isSession("executor", { name: "Assistant (Anton merge)" })).toBe(false);
  });

  it("says the machine in plans' first line, and how to name it while the hostname stands in", () => {
    const root = dir("machine-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "workflow.md"), "---\nname: Lab\n---\n");
    const { CLAUDE_PLUGIN_OPTION_MACHINE: _, ...rest } = process.env;
    const plans = (env: Record<string, string>) =>
      execFileSync("node", [join(scripts, "plan-queue.mjs")], {
        encoding: "utf8",
        // A home of its own, so the user settings name no machine.
        env: { ...rest, HOME: root, CLAUDE_PROJECT_DIR: root, WORKFLOW_LIVE: "[]", ...env },
      });
    const named = plans({ CLAUDE_PLUGIN_OPTION_MACHINE: "lab" });
    expect(named).toMatch(/^Plans on lab, /);
    expect(named).not.toContain("named by its hostname");
    expect(plans({ CLAUDE_PLUGIN_OPTION_MACHINE: "my box" })).toContain(
      `The plugin's "machine" option, "my box", is no label (letters, digits, underscores, dots and hyphens), so this machine is named by its hostname;`,
    );
    const unset = plans({});
    expect(unset.startsWith(`Plans on ${hostname()}, `)).toBe(true);
    expect(unset.trimEnd().split("\n").at(-1)).toBe(
      `This machine is named by its hostname; the plugin's "machine" option names it: /plugin configure workflow in a chat, or echo '{"machine":"<label>"}' | claude plugin configure workflow@workflow --values-stdin.`,
    );
  });

  it("finds the data directory from WORKFLOW_DATA, the cache path, or the default, never CLAUDE_PLUGIN_DATA", () => {
    expect(data({ WORKFLOW_DATA: "/w", CLAUDE_PLUGIN_DATA: "/d" })).toBe("/w");
    // Another plugin's directory, as the Bash tool carried it: never taken.
    expect(
      data(
        { CLAUDE_PLUGIN_DATA: "/h/.claude/plugins/data/codex-openai-codex" },
        "/h/.claude/plugins/cache/workflow/workflow/abc123/scripts",
      ),
    ).toBe("/h/.claude/plugins/data/workflow-workflow");
    expect(data({}, "/h/.claude/plugins/cache/workflow/workflow/abc123/scripts")).toBe(
      "/h/.claude/plugins/data/workflow-workflow",
    );
    expect(data({}, "/h/.claude/plugins/cache/mkt/tool/1.0.0/scripts")).toBe(
      "/h/.claude/plugins/data/tool-mkt",
    );
    expect(data({}, "/somewhere/else/scripts")).toMatch(
      /\.claude\/plugins\/data\/workflow-workflow$/,
    );
  });

  /** Two throwaway repositories, each with a project file and one plan of its own. */
  const twoProjects = () =>
    ["a", "b"].map((name) => {
      const root = dir(`queue-${name}-`);
      execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
      mkdirSync(join(root, ".claude"));
      mkdirSync(join(root, "plans"));
      mkdirSync(join(root, "deep"));
      writeFileSync(join(root, ".claude", "workflow.md"), `---\nname: Q${name}\n---\n`);
      writeFileSync(
        join(root, "plans", `only-in-${name}.md`),
        `# Plan ${name}\n\nShort plan, 27 October 2026.\n`,
      );
      return root;
    });
  const queueIn = (command: string, cwd: string, env: Record<string, string>) => {
    const { WORKFLOW_ROOT: _, ...rest } = process.env;
    return execFileSync("node", [command], {
      cwd,
      env: { ...rest, WORKFLOW_DATA: dir("queue-data-"), WORKFLOW_LIVE: "[]", ...env },
      encoding: "utf8",
    });
  };
  const bin = new URL("../plugins/workflow/bin/plans", import.meta.url).pathname;

  it("plans reads the folder it runs in, not the chat's project", () => {
    const [a, b] = twoProjects();
    const out = queueIn(bin, join(a, "deep"), { CLAUDE_PROJECT_DIR: b });
    expect(out).toContain("plans/only-in-a.md");
    expect(out).not.toContain("plans/only-in-b.md");
  });

  it("plans in a linked worktree reads the checkout that holds plans/", () => {
    const [a, b] = twoProjects();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: a, stdio: "ignore" });
    git("add", ".claude");
    git("-c", "user.name=T", "-c", "user.email=t@example.org", "commit", "-qm", "start");
    git("worktree", "add", "-q", join(".claude", "worktrees", "w"));
    const out = queueIn(bin, join(a, ".claude", "worktrees", "w"), { CLAUDE_PROJECT_DIR: b });
    expect(out).toContain("plans/only-in-a.md");
  });

  it("a hook, with no WORKFLOW_ROOT, still takes CLAUDE_PROJECT_DIR", () => {
    const [a, b] = twoProjects();
    const out = queueIn(join(scripts, "plan-queue.mjs"), a, { CLAUDE_PROJECT_DIR: b });
    expect(out).toContain("plans/only-in-b.md");
    expect(out).not.toContain("plans/only-in-a.md");
  });

  it("starts a chat without the command's root or another project's directory", () => {
    expect(
      sessionEnv({
        WORKFLOW_ROOT: "/a",
        CLAUDE_PROJECT_DIR: "/b",
        CLAUDE_SESSION_ID: "s",
        CLAUDE_PLUGIN_ROOT: "/r",
        CLAUDE_PLUGIN_DATA: "/d",
        PATH: "/bin",
        HOME: "/h",
      }),
    ).toEqual({ PATH: "/bin", HOME: "/h" });
  });

  it("starts a chat without the plugins' bin folders it inherited, so its plans is the installed one", () => {
    const old = "/home/u/.claude/plugins/cache/workflow/workflow/822635629e80/bin";
    const now = "/home/u/.claude/plugins/cache/workflow/workflow/73aa1d388dcc/bin";
    const path = (...dirs: string[]) => dirs.join(delimiter);
    expect(sessionEnv({ PATH: path(old, "/usr/bin", now, "/bin") }).PATH).toBe(
      path("/usr/bin", "/bin"),
    );
  });

  it("finds any path of two segments with an extension, and no address or plan", () => {
    expect(pathsIn("see src/a/b.ts and docs/x.md, not 192.0.2.1 or plans/p.md")).toEqual([
      "src/a/b.ts",
      "docs/x.md",
    ]);
    expect(pathsIn("https://example.org/a/b.md")).toEqual([]);
  });
});

describe("the turn audit's UI rule", () => {
  const ui = ["apps/*/src/{components,app}/**"].map(globToRegExp);
  it("asks for the catalogue only when the project names the paths and the catalogue", () => {
    const changed = ["apps/web/src/components/Button.tsx"];
    expect(reasonFor(changed, "x", "", { ui, catalogue: "docs/patterns" })).toContain(
      "nothing under docs/patterns did",
    );
    expect(reasonFor(changed, "x", "", { ui, catalogue: "" })).toBe("");
    expect(reasonFor(changed, "x", "", {})).toBe("");
    expect(
      reasonFor([...changed, "docs/patterns/buttons.md"], "x", "", {
        ui,
        catalogue: "docs/patterns",
      }),
    ).not.toContain("a user sees");
  });
});

describe("the turn audit's readers", () => {
  it("never judges the planner or the assistant, by a scoped name or a bare one", () => {
    const root = dir("audit-");
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "workflow.md"), "---\nname: A\nbranch: test\n---\n");
    const audit = join(scripts, "turn-audit.mjs");
    for (const agent_type of ["workflow:planner", "planner", "workflow:assistant"]) {
      const session_id = `reader-${agent_type.replace(":", "-")}-${process.pid}`;
      const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
      const run = (mode: string, input: object) =>
        execFileSync("node", [audit, mode], {
          input: JSON.stringify(input),
          encoding: "utf8",
          env,
        });
      run("prompt", { session_id, agent_type, prompt: "Plan it." });
      for (const file of ["a.md", "b/c.md"]) {
        mkdirSync(join(root, file, ".."), { recursive: true });
        writeFileSync(join(root, file), "x\n");
        run("tool", {
          session_id,
          tool_name: "Write",
          tool_input: { file_path: join(root, file) },
        });
      }
      expect(run("stop", { session_id, agent_type })).toBe("");
    }
  });
});

describe("the status line's copy", () => {
  it("copies itself into the data directory once, and again when it changes", () => {
    const target = dir("data-");
    const run = () =>
      execFileSync("node", [join(scripts, "statusline.mjs"), "install"], {
        env: { ...process.env, WORKFLOW_DATA: target },
      });
    run();
    const copy = join(target, "statusline.mjs");
    expect(existsSync(copy)).toBe(true);
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(join(scripts, "statusline.mjs"), "utf8"));
    writeFileSync(copy, "// old\n");
    run();
    expect(readFileSync(copy, "utf8")).not.toBe("// old\n");
    // The copy runs alone: it writes the usage beside itself.
    execFileSync("node", [copy], {
      input: JSON.stringify({
        rate_limits: { five_hour: { used_percentage: 3, resets_at: 1 } },
      }),
      env: { ...process.env, WORKFLOW_DATA: "", CLAUDE_PLUGIN_DATA: "" },
    });
    expect(JSON.parse(readFileSync(join(target, "usage.json"), "utf8")).five_hour).toMatchObject({
      used_percentage: 3,
    });
  });
});

// plans/plans-on-the-terminal-path.md: `plans` in the owner's own terminal.
describe("the terminal's plans", () => {
  const record = "/fake/installed_plugins.json";
  // The owner's chat unless `started` names the kind the queue marked it with.
  // The owner's chat unless `agent` names the agent the chat runs as.
  const hook = (target: string, PATH = process.env.PATH, agent?: string) =>
    execFileSync("node", [join(scripts, "plans-on-path.mjs")], {
      encoding: "utf8",
      input: JSON.stringify({ session_id: "s", ...(agent ? { agent_type: agent } : {}) }),
      env: { ...process.env, WORKFLOW_BIN: target, PATH },
    });
  const pathLine =
    '`plans` is a command at ~/.local/bin/plans, but ~/.local/bin is not on PATH in the terminal this chat was started from. To run it from a terminal, add `export PATH="$HOME/.local/bin:$PATH"` to your shell\'s startup file (~/.zshrc or ~/.bashrc), then open a new terminal.';
  const foreignLine =
    "~/.local/bin/plans exists and is not the workflow plugin's, so it was left as it is; the queue's command is still plans in a chat.";
  const agent = "Say this line to the owner in a sentence, then go on with the work.";

  it("fills the record and the key in from the cache path, else the user's default record", () => {
    expect(source("/h/.claude/plugins/cache/mk/wf/1.0/scripts")).toEqual({
      record: "/h/.claude/plugins/installed_plugins.json",
      key: "wf@mk",
    });
    expect(source("/src/plugins/workflow/scripts")).toEqual({
      record: "$HOME/.claude/plugins/installed_plugins.json",
      key: "workflow@workflow",
    });
    expect(WRAPPER(record, "wf@mk")).toContain(`record="${record}"\nkey="wf@mk"\n`);
  });

  it("writes the wrapper when it is missing, not again when it is there, and again when it changed", () => {
    const target = dir("bin-");
    const file = join(target, "plans");
    const text = WRAPPER(record, "workflow@workflow");
    expect(install(target, text)).toBe("written");
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(statSync(file).mode & 0o777).toBe(0o755);
    const mtime = statSync(file).mtimeMs;
    expect(install(target, text)).toBe("same");
    expect(statSync(file).mtimeMs).toBe(mtime);
    // An older wrapper of the plugin's, or the hand-written stopgap: the record and bin/plans.
    writeFileSync(
      file,
      '#!/bin/sh\nr="$HOME/.claude/plugins/installed_plugins.json"\nexec "$dir/bin/plans" "$@"\n',
    );
    expect(install(target, text)).toBe("written");
    expect(readFileSync(file, "utf8")).toBe(text);
    // The hook itself, with its own text, writes once.
    const fresh = dir("bin-");
    const onIt = `${fresh}${delimiter}${process.env.PATH}`;
    hook(fresh, onIt);
    const first = statSync(join(fresh, "plans")).mtimeMs;
    expect(hook(fresh, onIt)).toBe("");
    expect(statSync(join(fresh, "plans")).mtimeMs).toBe(first);
  });

  it("runs the copy the record names, with its arguments and its exit code", () => {
    const bin = dir("bin-");
    const plugins = dir("plugins-");
    const copy = join(plugins, "cache", "workflow", "workflow", "9.9.9");
    mkdirSync(join(copy, "bin"), { recursive: true });
    writeFileSync(
      join(copy, "bin", "plans"),
      'process.stdout.write(process.argv.slice(2).join(" ")); process.exit(3);',
    );
    const recordFile = join(plugins, "installed_plugins.json");
    writeFileSync(
      recordFile,
      JSON.stringify({ version: 2, plugins: { "workflow@workflow": [{ installPath: copy }] } }),
    );
    install(bin, WRAPPER(recordFile, "workflow@workflow"));
    const run = spawnSync("sh", [join(bin, "plans"), "a", "b"], { encoding: "utf8" });
    expect(run.stdout).toBe("a b");
    expect(run.status).toBe(3);
  });

  it("says the plugin is not installed when the record names no key, or there is no record", () => {
    const plugins = dir("plugins-");
    const recordFile = join(plugins, "installed_plugins.json");
    writeFileSync(
      recordFile,
      JSON.stringify({ version: 2, plugins: { "other@other": [{ installPath: "/x" }] } }),
    );
    for (const path of [recordFile, join(plugins, "none.json")]) {
      const bin = dir("bin-");
      install(bin, WRAPPER(path, "workflow@workflow"));
      const run = spawnSync("sh", [join(bin, "plans")], { encoding: "utf8" });
      expect(run.stderr).toBe(
        `The workflow plugin is not installed on this machine: ${path} names no workflow@workflow. Install it with: claude plugin install workflow@workflow\n`,
      );
      expect(run.status).toBe(1);
    }
  });

  it("says a copy the record names that is gone in one line, with the update command", () => {
    const plugins = dir("plugins-");
    const never = join(plugins, "cache", "workflow", "workflow", "0.0.1");
    const empty = join(plugins, "cache", "workflow", "workflow", "0.0.2");
    mkdirSync(empty, { recursive: true });
    for (const copy of [never, empty]) {
      const recordFile = join(plugins, "installed_plugins.json");
      writeFileSync(
        recordFile,
        JSON.stringify({ version: 2, plugins: { "workflow@workflow": [{ installPath: copy }] } }),
      );
      const bin = dir("bin-");
      install(bin, WRAPPER(recordFile, "workflow@workflow"));
      const run = spawnSync("sh", [join(bin, "plans")], { encoding: "utf8" });
      expect(run.stderr).toBe(
        `The workflow plugin's installed copy is gone: ${recordFile} names ${copy}, which has no bin/plans. Install it again with: claude plugin update workflow@workflow\n`,
      );
      expect(run.status).toBe(1);
      const out = run.stdout + run.stderr;
      expect(out).not.toContain("Cannot find module");
      expect(out).not.toMatch(/^ {4}at /m);
    }
  });

  it("says the PATH line in the owner's chat at each start while PATH lacks the folder, else nothing", () => {
    const target = dir("bin-");
    for (let start = 0; start < 2; start++) {
      const said = JSON.parse(hook(target));
      expect(said.systemMessage).toBe(pathLine);
      expect(said.hookSpecificOutput).toEqual({
        hookEventName: "SessionStart",
        additionalContext: `${pathLine}\n\n${agent}`,
      });
    }
    // plans/one-assistant-chat.md, part 7: a worker's chat is read by nobody,
    // the file written and nothing said; the assistant's and the maker's are his.
    for (const kind of ["executor", "planner", "reviewer"]) {
      const worker = dir("bin-");
      expect(hook(worker, process.env.PATH, `workflow:${kind}`)).toBe("");
      expect(readFileSync(join(worker, "plans"), "utf8")).toContain("bin/plans");
    }
    for (const kind of ["assistant", "maker"])
      expect(
        JSON.parse(hook(dir("bin-"), process.env.PATH, `workflow:${kind}`)).systemMessage,
      ).toBe(pathLine);
    const onIt = dir("bin-");
    expect(hook(onIt, `${onIt}/${delimiter}${process.env.PATH}`)).toBe("");
    expect(hook(onIt, `${onIt}/${delimiter}${process.env.PATH}`, "workflow:executor")).toBe("");
    expect(onPath(onIt, `/usr/bin${delimiter}${onIt}/`)).toBe(true);
    expect(onPath("/home/me/.local/bin", "~/.local/bin")).toBe(false);
  });

  it("leaves another program's plans as it is, and says so", () => {
    const other = dir("bin-");
    writeFileSync(join(other, "plans"), 'exec /opt/other/bin/plans "$@"\n');
    expect(install(other, WRAPPER(record, "workflow@workflow"))).toBe("foreign");
    expect(readFileSync(join(other, "plans"), "utf8")).toBe('exec /opt/other/bin/plans "$@"\n');
    // A file the hook cannot read is not taken for missing, and no temp file stays.
    const locked = dir("bin-");
    writeFileSync(join(locked, "plans"), "secret\n", { mode: 0o300 });
    if (process.getuid?.() !== 0) {
      expect(() => install(locked, WRAPPER(record, "workflow@workflow"))).toThrow();
      expect(readdirSync(locked)).toEqual(["plans"]);
    }
    const target = dir("bin-");
    writeFileSync(join(target, "plans"), "#!/bin/sh\necho mine\n");
    const said = JSON.parse(hook(target, `${target}${delimiter}${process.env.PATH}`));
    expect(said.systemMessage).toBe(foreignLine);
    expect(said.hookSpecificOutput.additionalContext).toBe(`${foreignLine}\n\n${agent}`);
    expect(readFileSync(join(target, "plans"), "utf8")).toBe("#!/bin/sh\necho mine\n");
  });
});

describe("the two forms", () => {
  const compact = () => {
    const root = dir("compact-");
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "workflow.md"), "---\nname: Slides\nform: compact\n---\n");
    return root;
  };
  const queue = (root: string, args: string[], input?: object) =>
    execFileSync("node", [join(scripts, "plan-queue.mjs"), ...args], {
      input: input ? JSON.stringify(input) : "",
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root, WORKFLOW_LIVE: "[]" },
    });
  const line =
    "This project is in the compact form (form: compact): one chat decides and builds, and there is no queue.";

  it("reads form: compact, and the full form when absent", () => {
    expect(project(compact()).form).toBe("compact");
    const full = dir("full-");
    expect(project(full).form).toBe("full");
    init(full);
    expect(readFileSync(join(full, ".claude", "workflow.md"), "utf8")).toContain(
      "# form: compact          one chat decides and builds; omit for the full queue",
    );
  });

  it("has no queue in the compact form: plans says so, a start refuses, a prompt hook is silent", () => {
    const root = compact();
    expect(queue(root, []).trim()).toBe(line);
    expect(queue(root, ["start", "--dry", "plans/x.md"]).trim()).toBe(line);
    expect(queue(root, ["prompt"], { session_id: "compact-1", agent_type: "executor" })).toBe("");
  });

  it("has a maker agent, and every agent names the design-research skill", () => {
    const agents = new URL("../plugins/workflow/agents/", import.meta.url).pathname;
    const maker = readFileSync(join(agents, "maker.md"), "utf8");
    for (const key of ["name: maker", "model: opus", "effort: high", "skills:"])
      expect(maker).toContain(key);
    for (const agent of ["maker", "planner", "executor", "assistant"]) {
      const front = /^---\n([\s\S]*?)\n---/.exec(
        readFileSync(join(agents, `${agent}.md`), "utf8"),
      )![1];
      expect(front, agent).toMatch(/skills:\n {2}- design-research/);
    }
    expect(
      existsSync(new URL("../plugins/workflow/skills/design-research/SKILL.md", import.meta.url)),
    ).toBe(true);
  });
});

describe("every string rests on what produced it", () => {
  const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
  it("the planner, the assistant, the executor and the reviewer name the plan's Words; the skill no longer skips the research", () => {
    for (const agent of ["planner", "assistant", "executor", "reviewer"])
      expect(readFileSync(join(plugin, "agents", `${agent}.md`), "utf8"), agent).toContain("Words");
    expect(
      readFileSync(join(plugin, "skills", "design-research", "SKILL.md"), "utf8"),
    ).not.toContain("needs no question");
  });

  it("the skill's question and the edit-time line name one boundary, a new screen or flow", () => {
    const skill = readFileSync(join(plugin, "skills", "design-research", "SKILL.md"), "utf8");
    const step2 = /^2\. [\s\S]*?(?=^3\. )/m.exec(skill)![0];
    expect(step2).toContain("A new screen or flow: ask, once, with two choices");
    expect(step2).toContain("A detail no product settles is free");
    expect(step2).not.toContain("you choose");
    // The skill no longer offers the retired tier.
    expect(skill).not.toContain("(the agent's choice,");
    expect(readFileSync(join(plugin, "agents", "maker.md"), "utf8")).toContain(
      "a new screen or flow is asked about",
    );
  });

  it("the audit's tier hint offers the tiers that stand, never the retired agent's choice", () => {
    const hint = reasonFor(["docs/patterns/a.md"], "", "", {
      catalogue: "docs/patterns",
      texts: { "docs/patterns/a.md": "- **No tier.**\n" },
      day: "27 October",
      who: "Javi",
    });
    expect(hint).toContain(
      "(Javi, 27 October), (as GitHub does, 27 October) or (per <source>, 27 October).",
    );
    expect(hint).not.toContain("the agent's choice");
  });
});

describe("the handbook holds every rule the plugin cites", () => {
  const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
  const handbook = readFileSync(join(plugin, "docs", "workflow.md"), "utf8");
  // A rule's name is its bold statement, read outside the fenced examples, on one line.
  const prose = handbook.replace(/```[\s\S]*?```/g, "");
  const bold = [...prose.matchAll(/\*\*([^*]+?)\*\*/g)].map((m) =>
    m[1].replace(/\s+/g, " ").replace(/\.$/, ""),
  );
  // A cited section is a heading of the handbook or of the landing steps the executor reads.
  const landing = readFileSync(join(plugin, "docs", "landing.md"), "utf8");
  const headings = [...`${handbook}\n${landing}`.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  // The names the agent files, the scripts, the skills and the tests cite in
  // quotation marks, collected by hand on 2 November (plans/docs-as-a-prompt.md).
  const NAMES = [
    "A behavior is written as a scenario",
    "A brief or a plan is a prompt for the agent that reads it",
    "A change one person started is anyone's to go on with",
    "A change the plugin leaves for the project it came from goes back as a brief",
    "A decision has a name; a part has none",
    "A second model reviews every plan's diff",
    "A string rests on what produced it",
    "A topic's pull request opens as a draft and stays one until its owner has reviewed it himself",
    "After the push",
    "An executor never waits on the owner",
    "Asked in plain words",
    "Asked once",
    "Before a build",
    "Before the push",
    "Briefs are queued like plans",
    "Handed to the assistant",
    "The audit's checks",
    "The catalogue is the record",
    "The checkout is for reading",
    "What he writes in a worker's chat is passed on",
    "The group's message",
    "The plans account for the queue's commits",
    "The tier says who may change a rule",
    "The turn audit",
    "Which session a topic goes to",
    "While working",
    "`land: pull-request` lands by pull request",
  ];
  const SECTIONS = [
    "The agents",
    "The project file",
    "Decisions",
    "The queue",
    "Changing the workflow",
    "Installing",
  ];

  it("holds each cited name as the opening of a bold statement", () => {
    for (const name of NAMES)
      expect(
        bold.some((b) => b.startsWith(name)),
        name,
      ).toBe(true);
  });

  it("ends every rule's paragraph with its entry in decisions.md, and cites every entry", () => {
    const decisions = readFileSync(join(plugin, "docs", "decisions.md"), "utf8");
    const ids = new Set([...decisions.matchAll(/^- `([\w.-]+)` \*\*/gm)].map((m) => m[1]));
    expect(ids.size).toBeGreaterThanOrEqual(60);
    const cited = new Set<string>();
    for (const para of prose.split(/\n\s*\n/)) {
      const text = para.trim();
      if (!/^(- )?\*\*/.test(text)) continue;
      const refs = [...text.matchAll(/decisions\.md#([\w.-]+)/g)].map((m) => m[1]);
      expect(refs.length, text.slice(0, 60)).toBeGreaterThan(0);
      for (const id of refs) {
        expect(ids.has(id), id).toBe(true);
        cited.add(id);
      }
    }
    // A paragraph with no bold lead-in may cite an entry too (the Installing line).
    for (const m of prose.matchAll(/decisions\.md#([\w.-]+)/g)) cited.add(m[1]);
    for (const id of ids) expect(cited.has(id), id).toBe(true);
  });

  it("holds each cited section as a heading", () => {
    for (const section of SECTIONS) expect(headings, section).toContain(section);
  });

  // plans/simpler-agent-files.md: an agent file cites a rule by its name, never by one gone.
  it("every rule an agent file cites is in the handbook", () => {
    const flatProse = prose.replace(/\s+/g, " ");
    let cited = 0;
    for (const agent of readdirSync(join(plugin, "agents"))) {
      const text = readFileSync(join(plugin, "agents", agent), "utf8");
      const flat = text.replace(/```[\s\S]*?```/g, "").replace(/\s+/g, " ");
      const own = [
        ...[...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]),
        ...[...flat.matchAll(/\*\*([^*]+?)\*\*/g)].map((m) => m[1]),
      ];
      for (const [, name] of flat.matchAll(/(?:the docs' |the handbook's |\()"([A-Z`][^"]+?)"/g)) {
        cited++;
        expect(
          flatProse.includes(`**${name}`) ||
            headings.includes(name) ||
            own.some((lead) => lead.startsWith(name)),
          `${agent}: "${name}"`,
        ).toBe(true);
      }
    }
    expect(cited).toBeGreaterThan(20);
  });
});

describe("a brief or a plan is a prompt", () => {
  const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
  const agent = (name: string) => readFileSync(join(plugin, "agents", `${name}.md`), "utf8");
  // A rule's wording runs across hand-wrapped lines; read it as one line.
  const flat = (text: string) => text.replace(/\s+/g, " ");
  const PARTS = ["What was asked", "Decided", "Done when", "Where to look"];

  it("the docs hold the rule and an example brief whose headings are the four parts in order", () => {
    const docs = readFileSync(join(plugin, "docs", "workflow.md"), "utf8");
    expect(docs).toContain("**A brief or a plan is a prompt for the agent that reads it**");
    const rule = docs.slice(docs.indexOf("**A brief or a plan is a prompt"));
    const example = /For example, the brief that asked for this rule:\n\n```\n([\s\S]*?)\n```/.exec(
      rule,
    )![1];
    const headings = [...example.matchAll(/^## (.+)$/gm)].map((m) => m[1].replace(/,.*/, ""));
    // Decided is left out of a brief when nothing is settled; the rest are always there.
    expect(headings).toEqual(PARTS.filter((part) => headings.includes(part)));
    for (const part of ["What was asked", "Done when", "Where to look"])
      expect(headings).toContain(part);
    // No longer than the brief it rewrites (1,917 characters).
    expect(example.length).toBeLessThanOrEqual(1917);
  });

  it("the assistant's brief and short plan each hold Done when and no Tests", () => {
    const text = agent("assistant");
    const blocks = [...text.matchAll(/```\n(\s*# <Title[\s\S]*?)```/g)].map((m) => m[1]);
    const brief = blocks.find((b) => b.includes("Brief for the planner"))!;
    const short = blocks.find((b) => b.includes("Short plan, <date>"))!;
    for (const block of [brief, short]) {
      expect(block).toMatch(/^ *## Done when$/m);
      expect(block).not.toMatch(/^ *## Tests$/m);
    }
    const order = (block: string) =>
      PARTS.map((part) => block.search(new RegExp(`^ *## ${part}`, "m"))).filter((i) => i >= 0);
    expect(order(brief)).toHaveLength(4);
    expect(order(brief)).toEqual([...order(brief)].sort((a, b) => a - b));
  });

  it("the planner's shape names Done when, and neither What the products do nor Tests as a section", () => {
    const text = agent("planner");
    const shape = /^## The plan's shape\n[\s\S]*?(?=^## )/m.exec(text)![0];
    expect(shape).toMatch(/^\d+\. \*\*Done when\*\*/m);
    expect(shape).not.toContain("What the products do");
    expect(shape).not.toMatch(/^\d+\. \*\*Tests\*\*/m);
    expect(text).not.toContain("usual size");
  });

  it("the executor's Built rule and its four-part rule, and the reviewer's second check, name Done when", () => {
    const executor = flat(agent("executor"));
    // Each rule read to its end: the Built bullet to the next bullet, the four-part rule to its last sentence.
    const built = /\*\*"Built"\*\*.*? - \*\*/.exec(executor)![0];
    expect(built).toContain('"Done when"');
    // The four parts, done when among them, are the handbook rule the brief names.
    const brief = /A brief has the four parts of .*?three hundred words\./.exec(executor)![0];
    expect(brief).toContain("A brief or a plan is a prompt for the agent that reads it");
    expect(executor).toContain('its "Done when" is what you check before "Built".');
    const reviewer = flat(agent("reviewer"));
    const second = /2\. \*\*([^*]+)\*\*/.exec(reviewer)![1];
    expect(second).toContain('"Done when"');
  });

  // plans/behavior-as-when-then.md: a behavior a person sees is When … then ….
  it("the docs and the agents that write or check a Done when hold When … then …, the example brief too", () => {
    const docs = flat(readFileSync(join(plugin, "docs", "workflow.md"), "utf8"));
    const rule =
      /\*\*A behavior is written as a scenario\*\*.*?\(decisions\.md#behavior-as-scenario\)/.exec(
        docs,
      )![0];
    expect(rule).toContain("When <what the person does>, then <what they see>");
    expect(rule).toMatch(/"\*\*When\*\* I connect Google[^"]*, \*\*then\*\* a toast/);
    expect(rule).toContain("names the test that checks it");
    const report = /\*\*An agent's report is short\.\*\*.*?\(decisions\.md#report-is-short\)/.exec(
      docs,
    )![0];
    expect(report).toContain("a behavior as When … then …");
    const example = /For example, the brief that asked for this rule: ```(.*?)```/.exec(docs)![1];
    const done = example.slice(
      example.indexOf("## Done when"),
      example.indexOf("## Where to look"),
    );
    expect(done).toMatch(/- When [^,]+, then /);
    const assistant = flat(agent("assistant"));
    expect(assistant).toMatch(
      /"Done when" \(the checks he would run[^)]*When <what he does>, then <what he sees>/,
    );
    expect(assistant).toMatch(
      /the test files and cases to add among them; a behavior a person sees is a scenario/,
    );
    expect(assistant).toMatch(/## The final message [^#]*When <what he does>, then <what he sees>/);
    const planner = flat(agent("planner"));
    expect(planner).toMatch(/4\. \*\*Done when\*\*[^*]*When <what they do>, then <what they see>/);
    // plans/one-assistant-chat.md, parts 3 and 4: what was for him goes in the message to the assistant.
    expect(planner).toMatch(/Planned: plans\/<x>\.md\..{0,120}a behavior as When … then …/);
    const executor = flat(agent("executor"));
    expect(executor).toContain(
      'Give each When … then … line of "Done when" the test it names, one per scenario',
    );
    expect(executor).toMatch(/Built: plans\/<x>\.md\..{0,120}as When … then …/);
    // The reviewer checks the scenarios rather than writing them: its check 2, to check 3.
    const check = flat(
      /2\. \*\*Every line of its "Done when"[^]*?(?=\n3\. )/.exec(agent("reviewer"))![0],
    );
    expect(check).toContain("a When … then … line by the test it names");
    expect(check).toContain('the screenshot named for it, read with Read, shows its "then"');
    expect(check).toContain("is a gap when none is named");
    const perScenario = /Give each When … then … line.*? - /.exec(executor)![0];
    expect(perScenario).toContain("screenshotted to `plans/<topic>/<file>.png`");
    expect(flat(agent("reviewer"))).toContain("a scenario's screenshot is check 2's");
    expect(rule).toContain(
      "for one looked at on screen the executor names the screenshot that shows it",
    );
    expect(executor).toContain(
      "each screenshot by path with what it shows and its When … then … line",
    );
  });
});

// plans/ask-before-briefing.md
describe("an idea is asked about before anything is written", () => {
  const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
  const read = (path: string) => readFileSync(join(plugin, path), "utf8");

  it("opens the assistant's exits with the question, before exit 1, and asks nothing of a fix", () => {
    const exits = /^## Where each topic ends\n([\s\S]*?)(?=^## )/m.exec(
      read("agents/assistant.md"),
    )![1];
    const first = exits.trim().split("\n\n")[0].replace(/\s+/g, " ");
    expect(first).toMatch(/^\*\*An idea is asked about first\.\*\*/);
    expect(first).toContain("ask with the question tool what it becomes before writing anything");
    expect(first).toContain(
      '`Make it an issue`, "Shared with the others to discuss and come back to another day; nothing is planned yet" (in a project with an Issues heading and `land: pull-request`)',
    );
    expect(first).toContain(
      '`Brief it`, "A planner plans it now and it is built as a draft pull request; say so to keep it for your word"',
    );
    expect(first).toContain('`Not yet`, "Nothing is written; keep talking it through"');
    expect(first).toContain("Nothing is written on Not yet.");
    expect(first).toContain(
      "A clear bug or an objective fix asks nothing; when unsure which it is, ask.",
    );
    expect(exits.indexOf("An idea is asked about first")).toBeLessThan(
      exits.indexOf("1. **Answered.**"),
    );
  });

  it("has the handbook say the same, pointing at the assistant and citing its entry", () => {
    const docs = read("docs/workflow.md").replace(/\s+/g, " ");
    const rule =
      /\*\*An idea is asked about before anything is written\*\*.*?\(decisions\.md#idea-asked-first\)/.exec(
        docs,
      )![0];
    expect(rule).toContain(
      "an issue (in a project with an Issues heading and `land: pull-request`), a brief or nothing yet",
    );
    expect(rule).toContain(
      "a clear bug, an objective fix or a request to build, plan or file asks nothing",
    );
    expect(rule).toContain('(the assistant\'s "Where each topic ends")');
    expect(read("docs/decisions.md")).toContain("- `idea-asked-first` **An idea is asked about");
  });

  it("writes an issue nobody plans yet with no label and no plan line", () => {
    const issues = /^## GitHub issues\n([\s\S]*?)(?=^## )/m
      .exec(read("docs/github.md"))![1]
      .replace(/\s+/g, " ");
    expect(issues).toContain(
      "With an **Issues** heading and `land: pull-request`, a topic the people discuss is an issue",
    );
    expect(issues).toContain(
      'An issue alone, `Make it an issue` with no brief, leaves out the line "The plan behind this: a collapsed comment below, once it is planned." and takes no label until a brief carries its number; the topic ends as answered, with its address.',
    );
    expect(issues).toContain(
      '--label "status: planning" --attach plans/<topic>/<file>`, the label left out for an issue alone,',
    );
    expect(issues).toContain(
      '`status: planning` with the brief, added (`plans gh issue edit <n> --add-label "status: planning"`) when a brief takes the number of an issue that has no label',
    );
    expect(read("docs/workflow.md").replace(/\s+/g, " ")).toContain(
      "**An issue nobody plans yet carries no status label and no plan line** until a brief carries its number, and its topic ends as answered, with the issue's address. (decisions.md#issue-alone)",
    );
  });
});

// plans/messages-for-people-only-on-request.md
describe("a message for another person only when the owner asks", () => {
  const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
  const read = (path: string) => readFileSync(join(plugin, path), "utf8").replace(/\s+/g, " ");

  it("has the planner's shape hold no For the group section, and a message drafted only on request", () => {
    const planner = readFileSync(join(plugin, "agents", "planner.md"), "utf8");
    const shape = /^## The plan's shape\n[\s\S]*?(?=^## )/m.exec(planner)![0];
    expect(shape).not.toContain("For the group");
    expect(shape).toContain("`Touches <name>'s part (<what>).`");
    const flat = read("agents/planner.md");
    expect(flat).not.toContain("For the group");
    // plans/one-assistant-chat.md, part 6: one he asked for in the brief goes in the Planned: message.
    expect(flat).toContain('a message he asked for in the brief\'s "Decided", ready to paste');
  });

  it("has the docs and the assistant draft a person's message only when the owner asks", () => {
    const docs = read("docs/workflow.md");
    const rule = /\*\*The group's message\.\*\*.*?\(decisions\.md#group-message\)/.exec(docs)![0];
    expect(rule).toContain("No agent drafts a message for another person unless the owner asked");
    expect(rule).not.toContain("For the group");
    expect(docs).toContain(
      "a call for a person the project names, said in a line, with a message drafted only when the owner asks",
    );
    const assistant = read("agents/assistant.md");
    expect(assistant).toContain("say in a line whose call it is and what to ask them");
    expect(assistant).toContain("only when ${user_config.owner} asks for one");
    expect(assistant).toContain(
      'when ${user_config.owner} asks for a message, it goes in the brief\'s "Decided" for the planner',
    );
  });
});

describe("the audit's tier check", () => {
  it("finds a rule without its tier and passes one with each of the three", () => {
    const text = `# Buttons

- **Icon buttons carry a tooltip.** (Javi, 3 September)
- **Load more sits under the feed.** (as GitHub does, 10 October) The reason.
- **Keys are drawn as a grid,
  four to a row.** (the agent's choice, 11 October)
- **A button with no tier.** It says why.
- ~~**A struck rule.**~~ (retired)
`;
    expect(untiered(text)).toEqual(["**A button with no tier.** It says why."]);
    // An entry at the retired tier has its tier and date: its fault is its own kind.
    expect(agentsChoice(text)).toEqual([
      "**Keys are drawn as a grid, four to a row.** (the agent's choice, 11 October)",
    ]);
    expect(
      untiered("- **A rule.** (Mary Jane, 27 October)\n- **Another.** (José, 2 May)\n"),
    ).toEqual([]);
  });

  it("checks the README's rules, not its prose, and suggests a tier the check accepts", () => {
    const rule = {
      catalogue: "docs/patterns",
      texts: {
        "docs/patterns/README.md":
          "# Patterns\n\nThe rules for everywhere.\n\n| File | Governs |\n| --- | --- |\n| a.md | buttons |\n\n- **Bare.**\n",
        "docs/patterns/a.md": "- **No tier.**\n",
      },
      day: "27 October",
    };
    expect(reasonFor(["docs/patterns/README.md"], "", "", rule)).toContain(
      'docs/patterns/README.md has 1 rule without a tier and date: "**Bare.**"',
    );
    const prose = { ...rule, texts: { "docs/patterns/README.md": "# Patterns\n\nProse only.\n" } };
    expect(reasonFor(["docs/patterns/README.md"], "", "", prose)).toBe("");
    expect(reasonFor(["docs/patterns/a.md"], "", "", { ...rule, who: "the owner" })).toContain(
      "(<a person's name>, 27 October)",
    );
    expect(reasonFor(["docs/patterns/a.md"], "", "", { ...rule, who: "Javi" })).toContain(
      "(Javi, 27 October)",
    );
  });

  it("refuses a stop once when a catalogue file changed with an untiered rule", () => {
    const root = dir("tiers-");
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, ".claude"));
    mkdirSync(join(root, "docs", "patterns"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      '---\nname: Tiers\nui:\n  - "src/**"\ncatalogue: docs/patterns\n---\n',
    );
    const audit = join(scripts, "turn-audit.mjs");
    const run = (mode: string, input: object) =>
      execFileSync("node", [audit, mode], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_OPTION_OWNER: "Javi" },
      });
    const id = `tiers-${process.pid}`;
    run("prompt", { session_id: id, prompt: "Record the rule" });
    const file = join(root, "docs", "patterns", "buttons.md");
    writeFileSync(file, "# Buttons\n\n- **A button with no tier.**\n");
    run("tool", { session_id: id, tool_name: "Write", tool_input: { file_path: file } });
    const first = run("stop", { session_id: id, stop_hook_active: false });
    expect(JSON.parse(first).reason).toContain(
      'docs/patterns/buttons.md has 1 rule without a tier and date: "**A button with no tier.**". Every rule ends with who it rests on and when: (Javi,',
    );
    expect(run("stop", { session_id: id, stop_hook_active: true })).toBe("");
  });
});

describe("the writing plugin", () => {
  const top = new URL("../", import.meta.url).pathname;
  const skills = join(top, "plugins", "writing", "skills");
  const SKILLS = ["review", "edit", "draft", "proof", "sources", "figures"];
  const front = (name: string) =>
    /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(skills, name, "SKILL.md"), "utf8"))?.[1] ?? "";

  it("is the marketplace's second plugin", () => {
    const market = JSON.parse(
      readFileSync(join(top, ".claude-plugin", "marketplace.json"), "utf8"),
    );
    expect(market.plugins.map((p: { name: string }) => p.name)).toEqual(["workflow", "writing"]);
    const manifest = JSON.parse(
      readFileSync(join(top, "plugins", "writing", ".claude-plugin", "plugin.json"), "utf8"),
    );
    expect(manifest.name).toBe("writing");
  });

  it("has six skills, each with a name, a description and paths; review and proof fork", () => {
    for (const name of SKILLS) {
      const head = front(name);
      expect(head, name).toMatch(new RegExp(`^name: ${name}$`, "m"));
      expect(head, name).toMatch(/^description: \S/m);
      expect(head, name).toMatch(/^paths:/m);
      expect(/^context: fork$/m.test(head), name).toBe(name === "review" || name === "proof");
    }
  });

  it("has every reference file a skill names, and each skill under 500 lines", () => {
    for (const name of SKILLS) {
      const text = readFileSync(join(skills, name, "SKILL.md"), "utf8");
      expect(text.split("\n").length, name).toBeLessThan(500);
      for (const [, file] of text.matchAll(/\]\(([\w-]+\.md)\)/g))
        expect(existsSync(join(skills, name, file)), `${name}/${file}`).toBe(true);
    }
    const names = (name: string) =>
      [...readFileSync(join(skills, name, "SKILL.md"), "utf8").matchAll(/\]\(([\w-]+\.md)\)/g)].map(
        (m) => m[1],
      );
    expect(names("review")).toEqual(["semantic-review.md", "narrative-and-pedagogy.md"]);
    expect(names("edit")).toEqual(["copyedit-and-grammar.md", "latex-style.md"]);
    expect(names("draft")).toEqual(["prose-drafting.md"]);
  });

  it("names no person's note commands but in the one example sentence", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    for (const file of walk(join(top, "plugins", "writing"))) {
      const lines = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => /JaviAI|\\javi\b/.test(line));
      for (const line of lines) expect(line, file).toContain("note: \\JaviAI");
    }
  });
});

describe("the catalogue follow-up", () => {
  it("accepts ISO dates, per and observed-in tiers, and an id", () => {
    expect(
      untiered(`- \`a\` **One.** (Javi, 2026-10-21)
- **Two.** (per Wheeler, 3 October) [S1] why.
- \`c\` **Three.** (observed in Limits deck, 2026-10-21)
- \`d\` **No tier.**
`),
    ).toEqual(["`d` **No tier.**"]);
  });

  it("reads inherits, tools, mcp and a file catalogue", () => {
    const root = dir("keys-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      `---\nname: Talk\ncatalogue: _talk/decisions.md\ninherits:\n  - ../.claude/decisions\ntools:\n  - "mcp__p__ppt_set_.*"\nmcp:\n  - ../.ppt/mcp.json\n---\n`,
    );
    expect(project(root)).toMatchObject({
      catalogue: "_talk/decisions.md",
      inherits: ["../.claude/decisions"],
      tools: ["mcp__p__ppt_set_.*"],
      mcp: ["../.ppt/mcp.json"],
    });
  });

  /** A project with a catalogue of three files: one untiered entry, one duplicate id, one clean. */
  const linted = (clean = false) => {
    const root = dir("check-");
    mkdirSync(join(root, ".claude"));
    mkdirSync(join(root, "decisions"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      "---\nname: Check\ncatalogue: decisions\n---\n",
    );
    writeFileSync(join(root, "decisions", "a.md"), "- `x` **One.** (Javi, 2026-10-21)\n");
    if (!clean) {
      writeFileSync(join(root, "decisions", "b.md"), "- `x` **Two.** (Javi, 2026-10-21)\n");
      writeFileSync(
        join(root, "decisions", "c.md"),
        "- **No tier.**\n- **Bare choice.** (the agent's choice, 2026-10-21)\n- **Reasoned choice.** (the agent's choice, 2026-10-21, Gmail differs)\n",
      );
    }
    return root;
  };
  const plansIn = (root: string, args: string[]) => {
    try {
      return {
        out: execFileSync("node", [join(scripts, "plan-queue.mjs"), ...args], {
          encoding: "utf8",
          env: { ...process.env, CLAUDE_PROJECT_DIR: root, WORKFLOW_LIVE: "[]" },
        }),
        code: 0,
      };
    } catch (error) {
      const e = error as { stdout: string; status: number };
      return { out: e.stdout, code: e.status };
    }
  };

  it("plans check prints each fault and exits 1, and reports none on a clean catalogue", () => {
    const bad = plansIn(linted(), ["check"]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("decisions/c.md: no tier and date: **No tier.**");
    expect(bad.out).toContain("id x is used twice in decisions");
    expect(bad.out).toContain(
      "decisions/c.md: the agent's choice, retired: **Bare choice.** (the agent's choice, 2026-10-21)",
    );
    expect(bad.out).toContain(
      "decisions/c.md: the agent's choice, retired: **Reasoned choice.** (the agent's choice, 2026-10-21, Gmail differs)",
    );
    expect(bad.out).toContain("5 entries in 3 files, 4 faults.");
    const good = plansIn(linted(true), ["check"]);
    expect(good).toMatchObject({ code: 0 });
    expect(good.out).toContain("1 entries in 1 file, no faults.");
  });

  it("plans check reads a catalogue's README: an entry at the retired tier there is a fault", () => {
    const root = linted(true);
    writeFileSync(
      join(root, "decisions", "README.md"),
      "# Decisions\n\nThe rules for everywhere.\n\n- **Everywhere.** (the agent's choice, 2026-10-21)\n",
    );
    const bad = plansIn(root, ["check"]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain(
      "decisions/README.md: the agent's choice, retired: **Everywhere.** (the agent's choice, 2026-10-21)",
    );
    expect(bad.out).toContain("2 entries in 2 files, 1 fault.");
  });

  it("plans check lints deny: an agent the plugin has not, a pattern that is no regular expression or no MCP name", () => {
    const root = linted(true);
    const file = (deny: string) =>
      writeFileSync(
        join(root, ".claude", "workflow.md"),
        `---\nname: Check\ncatalogue: decisions\n${deny}---\n`,
      );
    file('deny:\n  gardener:\n    - "mcp__lab__.*"\n  assistant:\n    - "mcp__["\n    - Bash\n');
    const bad = plansIn(root, ["check"]);
    expect(bad.code).toBe(1);
    expect(bad.out.split("\n").slice(0, 3)).toEqual([
      "deny: gardener is no agent of the plugin (assistant, executor, maker, planner, reviewer)",
      "deny: assistant: mcp__[ is not a regular expression",
      "deny: assistant: Bash names no MCP tool (mcp__<server>__<tool>); deny watches MCP calls only",
    ]);
    file('deny:\n  - "mcp__lab__.*"\n');
    const flat = plansIn(root, ["check"]);
    expect(flat.code).toBe(1);
    expect(flat.out).toContain(
      "deny: names no agent; each agent's name goes on a line of its own under deny, its patterns under it",
    );
    file('deny:\n  workflow:assistant:\n    - "mcp__lab__.*"\n');
    expect(plansIn(root, ["check"]).out).toContain(
      "deny: workflow:assistant is no agent of the plugin (assistant, executor, maker, planner, reviewer)",
    );
    file('deny:\n  assistant:\n    - "mcp__server__write_.*"\n');
    const good = plansIn(root, ["check"]);
    expect(good).toMatchObject({ code: 0 });
    expect(good.out).toBe("1 entries in 1 file, no faults.\n");
  });

  /** The check's output on a project whose frontmatter adds `deny`. */
  const checkWith = (deny: string) => {
    const root = linted(true);
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      `---\nname: Check\ncatalogue: decisions\n${deny}---\n`,
    );
    return plansIn(root, ["check"]);
  };
  /** The deny hook on a project whose frontmatter adds `deny`: its stdout. */
  const hookWith = (deny: string, mode: string, input: object) => {
    const root = dir("hook-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "workflow.md"), `---\nname: Lab\n${deny}---\n`);
    return execFileSync("node", [join(scripts, "tool-denials.mjs"), mode], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
  };

  it("an agent with its pattern on one line is read", () => {
    const root = dir("deny-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      '---\ndeny:\n  assistant: "mcp__lab__.*"   # the owner\'s chat\n  planner:\n    - mcp__x__.*\n---\n',
    );
    expect(project(root).deny).toEqual({ assistant: ["mcp__lab__.*"], planner: ["mcp__x__.*"] });
    const bad = checkWith('deny:\n  assistant "mcp__lab__.*"\n');
    expect(bad.code).toBe(1);
    expect(bad.out.split("\n")[0]).toBe(
      'deny: line 5 is not read: assistant "mcp__lab__.*" (an agent is "name:" with its patterns under it, or "name: pattern")',
    );
  });

  it("a mis-indented item is reported", () => {
    // At the agent's indent, an item is the agent's, as YAML reads it.
    const root = dir("deny-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      '---\ndeny:\n    assistant:\n    - "mcp__a__.*"\n  - "mcp__b__.*"\n---\n',
    );
    expect(project(root).deny).toEqual({ assistant: ["mcp__a__.*"] });
    const bad = checkWith(
      'deny:\n    assistant:\n    - "mcp__a__.*"\n  - "mcp__b__.*"\n- "mcp__c__.*"\n',
    );
    expect(bad.code).toBe(1);
    expect(bad.out.split("\n").slice(0, 2)).toEqual([
      'deny: line 7 is not read: - "mcp__b__.*" (an item goes under its agent\'s name, indented as deep or deeper)',
      'deny: line 8 is not read: - "mcp__c__.*" (an item goes under its agent\'s name, indented as deep or deeper)',
    ]);
  });

  it("a pattern cannot escape the anchors", () => {
    expect(matches(["mcp__a)|(.*"], "Bash")).toBe(false);
    expect(matches(["mcp__a)|(.*"], "mcp__a")).toBe(false);
    expect(matches(["mcp__a__(x|y)"], "mcp__a__y")).toBe(true);
    const bad = checkWith('deny:\n  assistant:\n    - "mcp__a)|(.*"\n');
    expect(bad.code).toBe(1);
    expect(bad.out.split("\n")[0]).toBe("deny: assistant: mcp__a)|(.* is not a regular expression");
  });

  it("a connector named alone denies its every tool", () => {
    const deny = 'deny:\n  assistant:\n    - "mcp__(claude_ai_)?lab"\n';
    for (const tool_name of ["mcp__claude_ai_lab__delete", "mcp__lab__delete"])
      expect(hookWith(deny, "tool", { agent_type: "workflow:assistant", tool_name })).toContain(
        '"permissionDecision":"deny"',
      );
    expect(
      hookWith(deny, "tool", { agent_type: "workflow:assistant", tool_name: "mcp__labs__x" }),
    ).toBe("");
    const bad = checkWith(deny);
    expect(bad.code).toBe(1);
    expect(bad.out.split("\n")[0]).toBe(
      "deny: assistant: mcp__(claude_ai_)?lab names a connector, not a tool: write `mcp__(claude_ai_)?lab__.*`",
    );
  });

  it("a connector named alone is read at its start only, between anchors, in an alternation", () => {
    const denied = (pattern: string, tool_name: string) =>
      hookWith(`deny:\n  assistant:\n    - "${pattern}"\n`, "tool", {
        agent_type: "workflow:assistant",
        tool_name,
      }).includes('"permissionDecision":"deny"');
    // An `mcp__` inside a server's name is no start: this names a tool.
    expect(denied("mcp__github_mcp__delete", "mcp__github_mcp__delete")).toBe(true);
    expect(denied("mcp__github_mcp__delete", "mcp__github_mcp__delete__x")).toBe(false);
    expect(denied("^mcp__lab$", "mcp__lab__x")).toBe(true);
    expect(denied("mcp__a|mcp__b__c", "mcp__a__x")).toBe(true);
    expect(denied("mcp__a|mcp__b__c", "mcp__b__c")).toBe(true);
    expect(denied("mcp__a|mcp__b__c", "mcp__b__d")).toBe(false);
    expect(checkWith('deny:\n  assistant:\n    - "mcp__github_mcp__delete"\n').code).toBe(0);
    expect(checkWith('deny:\n  assistant:\n    - "^mcp__lab$"\n').out.split("\n")[0]).toBe(
      "deny: assistant: ^mcp__lab$ names a connector, not a tool: write `^mcp__lab__.*$`",
    );
  });

  it("an agent named twice keeps both lists; a flow list or an empty agent is reported", () => {
    const root = dir("deny-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      "---\ndeny:\n  executor: mcp__a__x\n  executor: mcp__b__y\n---\n",
    );
    expect(project(root).deny).toEqual({ executor: ["mcp__a__x", "mcp__b__y"] });
    const flow = checkWith("deny:\n  executor: [mcp__a__x, mcp__b__y]\n");
    expect(flow.code).toBe(1);
    expect(flow.out.split("\n")[0]).toBe(
      'deny: line 5 is not read: executor: [mcp__a__x, mcp__b__y] (an agent is "name:" with its patterns under it, or "name: pattern")',
    );
    expect(checkWith("deny:\n  executor:\n").out.split("\n")[0]).toBe(
      "deny: executor: no pattern under it, so it denies nothing",
    );
  });

  it("an alternation passes the lint", () => {
    expect(checkWith('deny:\n  assistant:\n    - "(mcp__a|mcp__b)__.*"\n')).toMatchObject({
      code: 0,
    });
    expect(checkWith('deny:\n  assistant:\n    - "mcp__(a|b)__.*"\n')).toMatchObject({ code: 0 });
    const bad = checkWith('deny:\n  assistant:\n    - "(Bash|Read)"\n');
    expect(bad.out.split("\n")[0]).toBe(
      "deny: assistant: (Bash|Read) names no MCP tool (mcp__<server>__<tool>); deny watches MCP calls only",
    );
  });

  it("the deny key is parsed once", () => {
    // The lint reads the project it is handed, not the file under the root.
    const root = dir("deny-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "workflow.md"), '---\ndeny:\n  - "mcp__lab__.*"\n---\n');
    expect(checkDeny(project(root), ["assistant"])).toEqual([
      "deny: names no agent; each agent's name goes on a line of its own under deny, its patterns under it",
    ]);
  });

  it("another plugin's agent of the same name is not held to these lists", () => {
    const deny = 'deny:\n  assistant:\n    - "mcp__lab__.*"\n';
    const call = (agent_type: string) =>
      hookWith(deny, "tool", { agent_type, tool_name: "mcp__lab__delete" });
    expect(call("other:assistant")).toBe("");
    expect(call("workflow:assistant")).toContain('"permissionDecision":"deny"');
    expect(call("assistant")).toContain('"permissionDecision":"deny"');
  });

  it("plans check reads an override ending a sentence, and faults a catalogue that is not there", () => {
    const root = dir("override-");
    mkdirSync(join(root, ".claude"));
    mkdirSync(join(root, "ws", "decisions"), { recursive: true });
    mkdirSync(join(root, "_talk"));
    writeFileSync(join(root, "ws", "decisions", "title.md"), "- `x` **One.** (Javi, 2026-10-21)\n");
    writeFileSync(
      join(root, "_talk", "decisions.md"),
      "- `x` **Mine.** (Javi, 2026-10-22) overrides title#x.\n",
    );
    const file = (extra: string) =>
      writeFileSync(
        join(root, ".claude", "workflow.md"),
        `---\nname: O\ncatalogue: _talk/decisions.md\ninherits:\n  - ws/decisions\n${extra}---\n`,
      );
    file("");
    expect(plansIn(root, ["check"])).toMatchObject({ code: 0 });
    file("  - gone/decisions\n");
    const missing = plansIn(root, ["check"]);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("gone/decisions: no such catalogue");
  });

  it("plans chat --dry prints the maker's command with the project's mcp and inherits", () => {
    const root = dir("chat-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      "---\nname: Talk\nform: compact\ninherits:\n  - ../ws/decisions\nmcp:\n  - .ppt/mcp.json\n---\n",
    );
    const { out } = plansIn(root, ["chat", "--dry", "Change slide 3"]);
    expect(out).toContain('"--agent" "workflow:maker" "--effort" "high" "Change slide 3"');
    expect(out).toContain(`"--mcp-config" "${join(root, ".ppt", "mcp.json")}"`);
    expect(out).not.toContain("--strict-mcp-config");
    expect(out).toContain(`"--add-dir" "${join(root, "..", "ws", "decisions")}"`);
    expect(out).toContain('"Change slide 3"');
    // The several-value flags come first, so the owner's words follow a flag of one value.
    expect(out.indexOf('"--agent"')).toBeGreaterThan(out.lastIndexOf('"--add-dir"'));
    expect(out.trim().endsWith('"Change slide 3"')).toBe(true);
  });

  it("refuses a turn that called a writing tool and recorded nothing, once, and passes decisions: none", () => {
    const root = dir("calls-");
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, ".claude"));
    mkdirSync(join(root, "decisions"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      '---\nname: Calls\ncatalogue: decisions\ntools:\n  - "mcp__p__ppt_set_.*"\n---\n',
    );
    const audit = join(scripts, "turn-audit.mjs");
    const run = (mode: string, input: object) =>
      execFileSync("node", [audit, mode], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      });
    const turn = (id: string, last: string) => {
      run("prompt", { session_id: id, prompt: "Make the title bigger" });
      run("tool", { session_id: id, tool_name: "mcp__p__ppt_set_text", tool_input: {} });
      run("tool", { session_id: id, tool_name: "mcp__p__ppt_get_slide", tool_input: {} });
      return run("stop", { session_id: id, stop_hook_active: false, last_assistant_message: last });
    };
    const first = turn(`calls-a-${process.pid}`, "Done.");
    expect(JSON.parse(first).reason).toBe(
      "1 call to mcp__p__ppt_set_text was made, and nothing under decisions did. Add or update the entry in decisions in this turn, as the Decisions rules say, or say why not in your final message with the line: decisions: none (why). A free detail, one nobody decided for a reason, gets no entry: decisions: none (free: <the rule it follows>).",
    );
    expect(run("stop", { session_id: `calls-a-${process.pid}`, stop_hook_active: true })).toBe("");
    expect(turn(`calls-b-${process.pid}`, "decisions: none (a bug)")).toBe("");
    expect(turn(`calls-c-${process.pid}`, "decisions: none (free: tooltips are short)")).toBe("");
  });

  it("audits a writing call in a project with no git", () => {
    const root = dir("nogit-");
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      '---\nname: NoGit\nform: compact\ncatalogue: decisions.md\ntools:\n  - "mcp__p__ppt_set_.*"\n---\n',
    );
    const audit = join(scripts, "turn-audit.mjs");
    const run = (mode: string, input: object) =>
      execFileSync("node", [audit, mode], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      });
    const id = `nogit-${process.pid}`;
    run("prompt", { session_id: id, prompt: "Bigger title" });
    run("tool", { session_id: id, tool_name: "mcp__p__ppt_set_text", tool_input: {} });
    expect(run("stop", { session_id: id, stop_hook_active: false })).toContain(
      "1 call to mcp__p__ppt_set_text was made",
    );
  });
});

describe("the setup interview", () => {
  it("reads reviews, defaulting by form, and the starter names the key", () => {
    const at = (front: string) => {
      const root = dir("reviews-");
      mkdirSync(join(root, ".claude"));
      writeFileSync(join(root, ".claude", "workflow.md"), `---\nname: R\n${front}---\n`);
      return project(root).reviews;
    };
    expect(at("")).toEqual(["plan", "code-review", "codex"]);
    expect(at("form: compact\n")).toEqual([]);
    expect(at("reviews:\n  - code-review\n")).toEqual(["code-review"]);
    const fresh = dir("reviews-init-");
    init(fresh);
    expect(readFileSync(join(fresh, ".claude", "workflow.md"), "utf8")).toContain(
      "# reviews:               the reviews before a push: plan, code-review, codex, or a plugin skill; omit for all three",
    );
  });

  // plans/related-plans-share-a-pull-request.md, part 4.
  it("has the setup skill ask how plans group into pull requests and write the heading", () => {
    const text = readFileSync(
      new URL("../plugins/workflow/skills/setup/SKILL.md", import.meta.url),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(text).toContain(
      'header `Pull requests`: "This is about what happens when a new change touches the same thing as a pull request already open here. Each pull request is one more review for you, and one more run of the checks on GitHub. How should plans group into pull requests here?"',
    );
    expect(text).toContain("`Related plans share one (Recommended)`");
    expect(text).toContain("`A pull request per topic`");
    expect(text).toContain(
      "answer replaces the text under `## Pull requests` in the project file's body (the starter's line included)",
    );
    expect(text).toContain(
      "## Pull requests Related plans share one: a plan related to an open pull request of the queue's own lands in it (`Lands: topic <name>; lands in #<n>.`) while it has room, five plans, and a new pull request opens only when none fits or it is full.",
    );
    expect(text).toContain(
      "## Pull requests A pull request per topic: each is merged or held on its own",
    );
  });

  // plans/related-plans-share-a-pull-request-follow-up.md.
  it("has the setup skill's Issues question open with two sentences of context", () => {
    const text = readFileSync(
      new URL("../plugins/workflow/skills/setup/SKILL.md", import.meta.url),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(text).toContain(
      "header `Issues`: \"This is about whether the topics people talk over here live on GitHub, as issues they can comment on. The project's Claude would write each issue, and a plan is built as a draft pull request once planned. Should topics here become GitHub issues that the project's Claude writes and the people comment on?\"",
    );
    expect(text).not.toContain('"Should topics here');
  });

  // plans/related-plans-share-a-pull-request-follow-up-2.md.
  it("has the setup skill's Issues question recommend Yes when someone besides the owner builds here", () => {
    const text = readFileSync(
      new URL("../plugins/workflow/skills/setup/SKILL.md", import.meta.url),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(text).toContain(
      "Yes is first and marked recommended when the collaborators list someone besides the owner, else No is first and recommended; on a run again, the file's answer is the recommended one",
    );
  });

  // plans/related-plans-share-a-pull-request-follow-up-3.md, Decided 1.
  it("has the setup skill's No on a run again take out the Issues heading and setup's secrets parts, keeping the host's file", () => {
    const text = readFileSync(
      new URL("../plugins/workflow/skills/setup/SKILL.md", import.meta.url),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(text).toContain(
      "`No, not here` (Turns issues off here: the issues setting and the secrets file access are taken out; issues already on GitHub stay)",
    );
    const undo = text.slice(
      text.indexOf("On a run again, `No, not here` in a file with an Issues heading takes out"),
    );
    expect(undo).not.toBe(text);
    for (const part of [
      "the `## Issues` heading and its lines",
      "the `WORKFLOW_SECRETS_FILE` line of `containerEnv`",
      "setup's own mount to `/run/secrets/workflow.env`",
      "a `mounts` array left empty going with it",
      "(in Compose, the service's volume with that target and either source)",
      "a string `initializeCommand` losing its ` && <the command>` part (the key going when it held only that)",
      'an object one its `"workflow-secrets"` key',
      "A mount to that target with any other source is the project's own and stays.",
      "The host's `~/.config/workflow/<project>.env` and the issues already on GitHub stay.",
    ])
      expect(undo).toContain(part);
    expect(text).toContain(
      "`Issues: off; the Issues heading and the secrets file's mount are taken out, effective after a rebuild; ~/.config/workflow/<project>.env on the host is kept.`",
    );
    expect(text).toContain(
      "`Issues: off; the Issues heading is taken out.`, when no secrets part of setup's own was there to take out",
    );
  });

  // plans/related-plans-share-a-pull-request-follow-up-3.md, Decided 2.
  it("has the setup skill recommend the file's Issues answer only from a file that already landed by pull request or had issues on", () => {
    const text = readFileSync(
      new URL("../plugins/workflow/skills/setup/SKILL.md", import.meta.url),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(text).toContain(
      "on a run again, the file's answer is the recommended one when the file already had `land: pull-request` or an Issues heading; else the collaborators rule decides, since the question is new to it. Yes writes the heading",
    );
  });

  // plans/related-plans-share-a-pull-request-follow-up-4.md, Decided 1 and 2, made one
  // rule by plans/related-plans-share-a-pull-request-follow-up-5.md, Decided 1, 2 and 4.
  it("has the setup skill's run again ending without pull requests take out the Issues parts and the Pull requests heading, whichever answer dropped land", () => {
    const text = readFileSync(
      new URL("../plugins/workflow/skills/setup/SKILL.md", import.meta.url),
      "utf8",
    ).replace(/\s+/g, " ");
    const step4 = text.slice(text.indexOf("## 4. Write the project file"), text.indexOf("## 5. "));
    expect(step4).toContain(
      "**A run again that ends without pull requests**, whichever answer left `land` out (the Landing question's `Pushed straight`, or one that picks the compact form, the maker's, which has no pull requests) or a hand that took it out before, takes out what the Issues question's Yes wrote when the file has an Issues heading, by the paragraph that ends step 6, followed though the project no longer lands by pull request, and the `## Pull requests` heading with its text unless that is still the line `plans init` wrote, since it says how plans group into pull requests and means nothing without them (decisions.md#pull-requests-heading); issues need pull requests (Javi, 7 November). Step 6's two questions are then not asked.",
    );
    const off =
      "Issues are turned off too, since they need pull requests; issues already on GitHub stay";
    expect(text).toContain(
      "The answer writes `land: pull-request`, or takes the line out, and what that takes out with it is step 4's. On a run again in a file with an Issues heading, the description of `Pushed straight` is `Lands the moment the checks pass; nobody reads it first. " +
        off +
        "`",
    );
    expect(text).toContain(
      "On a run again in a file with an Issues heading, the two that pick the maker end their description with `" +
        off +
        "`, since the maker has no pull requests (step 4).",
    );
    expect(text).not.toContain("the Landing question's `Pushed straight` there");
    const step6 = text.slice(text.indexOf("## 6. The GitHub token"), text.indexOf("## 7. "));
    const at = step6.indexOf(
      "On a run again, `No, not here` in a file with an Issues heading takes out",
    );
    expect(at, "the Issues undo paragraph in step 6").toBeGreaterThan(-1);
    const undo = step6.slice(at);
    expect(undo).toContain(
      "and so does a run again that ends without pull requests there (step 4), each part",
    );
    expect(text).toContain(
      "When a run again took the Issues heading out, by No or by ending without pull requests (step 4), one line: - `Issues: off;",
    );
  });

  // plans/related-plans-share-a-pull-request-follow-up-6.md, Decided 2.
  it("has the setup skill say a Pull requests heading it took out", () => {
    const text = readFileSync(
      new URL("../plugins/workflow/skills/setup/SKILL.md", import.meta.url),
      "utf8",
    ).replace(/\s+/g, " ");
    const step7 = text.slice(text.indexOf("## 7. "), text.indexOf("## 8. "));
    expect(step7).toContain(
      "When a run again that ends without pull requests took out a `## Pull requests` heading whose text was no longer the line `plans init` wrote (step 4), one line: `Pull requests: the Pull requests section of the project file, which said how plans group into pull requests, is taken out, since the project no longer lands by pull request.`",
    );
  });

  it("has the setup skill at fable, and the kinds table's five rows of eight columns", () => {
    const skill = new URL("../plugins/workflow/skills/setup/", import.meta.url).pathname;
    const text = readFileSync(join(skill, "SKILL.md"), "utf8");
    expect(text).toMatch(/^model: fable$/m);
    expect(text).toMatch(/^description: Sets a project up for the workflow in a short interview/m);
    const rows = readFileSync(join(skill, "kinds.md"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("| ") && !/^\| (Kind|---)/.test(line));
    expect(rows.map((r) => r.split("|")[1].trim())).toEqual([
      "Web app or service",
      "Paper",
      "Talk",
      "Personal tool or script",
      "Something else",
    ]);
    for (const row of rows) expect(row.split("|").length - 2, row).toBe(8);
    // The reading-tools trial's outcome (plans/reading-tools-trial.md, 5c): none for every kind.
    for (const row of rows) expect(row.split("|")[7].trim(), row).toBe("none");
    // Every kind recommends its connectors: a "Connectors" column, filled in every row.
    const header = readFileSync(join(skill, "kinds.md"), "utf8")
      .split("\n")
      .find((line) => line.startsWith("| Kind |"));
    expect(header?.split("|")[8].trim()).toBe("Connectors");
    for (const row of rows) expect(row.split("|")[8].trim(), row).not.toBe("");
  });

  it("has the setup turn off the connectors a project does not use, by whole connector", () => {
    const skills = new URL("../plugins/workflow/skills/", import.meta.url).pathname;
    const text = readFileSync(join(skills, "setup", "SKILL.md"), "utf8");
    expect(text).toContain("permissions.deny");
    expect(text).toContain("mcp__claude_ai_<connector>");
    expect(text).toContain("Connectors: <chosen> on here; <denied> off (permissions.deny).");
    // Javi, 27 October: the denies go to settings.local.json where settings.json is public or shared.
    expect(text).toContain(".claude/settings.local.json");
    expect(text).toContain("gh repo view --json visibility");
    // A connector some agents need and others must not reach is the project file's.
    expect(text).toContain("the project file's `deny` key");
    // The GitHub token reaches the container through containerEnv (plans/github-token-in-containers.md).
    expect(text).toContain('"GH_TOKEN": "${localEnv:GH_TOKEN}"');
    expect(text).toContain("containerEnv");
    expect(text).toContain("gh auth status --hostname github.com");
    for (const line of [
      "GitHub: GH_TOKEN reaches this container (containerEnv); gh is signed in as <login>.",
      "GitHub: GH_TOKEN added to devcontainer.json (containerEnv); rebuild the container with GH_TOKEN set on the host, then gh signs in with it.",
      "GitHub: no gh in this container; the dotfiles install it and wire it to git when GH_TOKEN is set.",
      "GitHub: no .devcontainer here; GH_TOKEN must be in the shell that starts the queue's chats.",
    ])
      expect(text).toContain(line);
    expect(text.indexOf("## 6. The GitHub token")).toBeGreaterThan(-1);
    expect(text.indexOf("## 9. The final message")).toBeGreaterThan(
      text.indexOf("## 6. The GitHub token"),
    );
    expect(text).not.toMatch(
      /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/,
    );
    // No connector of the owner's is named in a skill or an agent file (CLAUDE.md: nothing
    // from a project is in the plugin); the public check covers the rest.
    const agents = new URL("../plugins/workflow/agents/", import.meta.url).pathname;
    const named = [
      ...(readdirSync(skills, { recursive: true }) as string[]).map((path) => join(skills, path)),
      ...readdirSync(agents).map((path) => join(agents, path)),
    ]
      .filter((path) => path.endsWith(".md"))
      .filter((path) => /homelab/i.test(readFileSync(path, "utf8")));
    expect(named).toEqual([]);
  });

  it("passes the project's mcp to a started chat", () => {
    const root = dir("start-mcp-");
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      "---\nname: M\nbranch: test\nmcp:\n  - .mcp/server.json\n---\n",
    );
    const out = execFileSync(
      "node",
      [join(scripts, "plan-queue.mjs"), "start", "--dry", "plans/x.md"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: root,
          WORKFLOW_LIVE: "[]",
          WORKFLOW_STARTS_LOG: join(root, ".claude", "starts.log"),
          WORKFLOW_USAGE_FILE: join(root, ".claude", "usage.json"),
        },
      },
    );
    expect(out).toContain(
      `Would run: claude "--mcp-config" "${join(root, ".mcp", "server.json")}" "--add-dir" "${join(root, "plans")}" "--bg"`,
    );
  });
});

describe("a plan still asking, whoever names it", () => {
  const agent = (name: string) =>
    readFileSync(new URL(`../plugins/workflow/agents/${name}.md`, import.meta.url), "utf8");

  it("has the executor run plans before a plan named in a message, and wait on one asking", () => {
    const sources = /## The plans you build\n\n[\s\S]*?\n\n/
      .exec(agent("executor"))![0]
      .replace(/\s+/g, " ");
    expect(sources).toContain("Run `plans` before building a plan named in a message");
    expect(sources).toContain('"Asking ${user_config.owner}" waits until the time it prints');
  });

  it("has the assistant hold back a plan still asking", () => {
    const handOver = /3\. \*\*A short plan for the executor\.\*\*[\s\S]*?\n4\. /.exec(
      agent("assistant"),
    )![0];
    expect(handOver).toContain('lists under "Asking ${user_config.owner}" is not sent');
  });
});

describe("a pull request stacked only on one it cannot be built without", () => {
  const read = (path: string) =>
    readFileSync(new URL(`../plugins/workflow/${path}`, import.meta.url), "utf8");

  it("has the executor stack on use, never on a shared file, and refresh a conflicting pull request", () => {
    const mode = /# Landing by pull request[\s\S]*?\n\*\*A topic's plan\*\*/
      .exec(read("docs/landing.md"))![0]
      .replace(/\s+/g, " ");
    expect(mode).not.toContain("--name-only");
    expect(mode).toContain("it uses what an earlier plan adds");
    // plans/related-plans-share-a-pull-request.md: a shared file goes where its `Lands` line says.
    expect(mode).toContain(
      "A plan that shares files with an open pull request goes where its `Lands` line says; its author read the project's **Pull requests** heading.",
    );
    expect(mode).toContain("`mergeable` `CONFLICTING`");
    // From the head as GitHub has it, its own base merged in, a plain push.
    expect(mode).toContain("`git switch -C <head branch> origin/<head branch>`");
    expect(mode).toContain("Merge its base, `origin/<baseRefName>`, in");
    expect(mode).toContain("push it with `git push origin <head branch>`, never to the branch");
  });

  // plans/refresh-by-merge.md: a branch is brought up to date by merging, never force-pushed.
  it("has the executor merge a branch up to date and never force-push", () => {
    const text = read("docs/landing.md");
    const flat = read("agents/executor.md").replace(/\s+/g, " ");
    expect(text).not.toContain("--force-with-lease");
    expect(text).not.toContain("git rebase --onto");
    expect(flat).toContain("nothing is force-pushed, ever");
    const mode = /# Landing by pull request[\s\S]*?\n\*\*The description\*\*/
      .exec(text)![0]
      .replace(/\s+/g, " ");
    const part = (from: string, to: string) => {
      const [start, end] = [mode.indexOf(from), mode.indexOf(to)];
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return mode.slice(start, end);
    };
    // One merge, defined once: no editor, the attribution, a plain push retried after a merge.
    const merge = part("**A branch is brought up to date by a merge**", "**A topic's branch**");
    expect(merge).toContain(
      '`git merge --no-edit -m "Merge origin/<base> into <name>" -m "<the session\'s attribution lines>" origin/<base>`',
    );
    expect(merge).toContain("`git commit --no-edit`");
    expect(merge).toContain("Push it to that branch only");
    expect(merge).toContain(
      "merge `origin/<name>` the same way, run the checks and push once more",
    );
    // The refresh, the waiting topic and the day's fixes branch merge, then push plainly.
    const refresh = part("**Then a conflicting pull request is refreshed**", "**A topic's plan**");
    expect(refresh).toContain("Merge its base, `origin/<baseRefName>`, in");
    expect(refresh).toContain("`git push origin <head branch>`, never to the branch");
    expect(refresh).toContain("`Refreshed <date>: merged <base>, commit <sha>, <files>`"); // plans/also-knows-whose-commit.md
    const waiting = part(
      "**A branch with no pull request yet**",
      "**An open pull request's branch**",
    );
    expect(waiting).toContain("then its base merged in");
    expect(waiting).not.toContain("rebase");
    const topic = part("**A topic's plan**", "**A pull request already open**");
    expect(topic).toContain("`git push -u origin <name>`, retried as for a merge");
    const fixes = part("**A fix**, `Lands: fix.`", "**A fix wanted now**");
    expect(fixes).toContain("`origin/<branch>` merged in");
    expect(fixes).toContain("one commit pushed with `git push -u origin fixes-<yyyy-mm-dd>`");
    expect(fixes).toContain(
      "The squash goes back to the tip the day's branch had once taken and merged",
    );
    expect(fixes).not.toContain("rebase");
    expect(read("docs/workflow.md").replace(/\s+/g, " ")).toContain(
      "A branch is brought up to date by merging, never force-pushed",
    );
  });

  // plans/refresh-only-your-own.md: only this person's pull requests, with the checks alone.
  it("has the executor refresh and retarget only its own person's pull requests, with the checks", () => {
    const mode = /# Landing by pull request[\s\S]*?\n\*\*A topic's plan\*\*/
      .exec(read("docs/landing.md"))![0]
      .replace(/\s+/g, " ");
    // plans/plans-as-github-issues.md: the pull requests open as the project's
    // app, so the plans' naming, never a Related line's, tells the queue's own.
    const own =
      "The queue's own pull requests are the open ones a plan in this checkout's `plans/` names as its own, by its \"Built\" or its `Lands` topic; a `Related` line names another's";
    const start = mode.slice(mode.indexOf("**At a plan's start**"));
    const refresh = mode.slice(mode.indexOf("**Then a conflicting pull request is refreshed**"));
    expect(start.slice(0, start.indexOf("**Then a conflicting"))).toContain(own);
    expect(refresh).toContain("each of the queue's own that GitHub reports as conflicting");
    expect(refresh).toContain(
      "run the project's checks, not the suites, since its CI runs on the push",
    );
    expect(mode).not.toContain("checks and suites run again");
    expect(read("docs/workflow.md").replace(/\s+/g, " ")).toContain(
      "The executor refreshes only the queue's own pull requests, with the checks alone**: those a plan in its `plans/` names as its own",
    );
  });

  it("has the docs, the planner and the assistant name a plan rested on only when it is used", () => {
    expect(read("docs/workflow.md").replace(/\s+/g, " ")).toContain(
      "**How plans group into pull requests is the project's rule, under `## Pull requests` in its file**, read by the author of a `Lands` line; the plugin suggests one in `/workflow:setup` and keeps only what the queue cannot do without: a plan that rests on an open draft pull request of the queue's own lands in it while it has room, and one that rests on another person's pull request is stacked on it, since the queue never pushes to another's branch.",
    );
    // Without the heading, what the queue did before: stacked on a ready one, a Related line for a shared file.
    expect(read("docs/workflow.md").replace(/\s+/g, " ")).toContain(
      "Without the heading, a plan resting on the queue's own pull request marked ready is stacked on it, and one that shares files with an open pull request gets a `Related` line and a pull request of its own.",
    );
    for (const agent of ["planner", "assistant"])
      expect(read(`agents/${agent}.md`).replace(/\s+/g, " ")).toContain(
        "only when it uses what that plan adds, never for a shared file",
      );
  });

  // plans/related-plans-share-a-pull-request.md: the plugin drops its own
  // grouping rule; the project's Pull requests heading says it.
  it("leaves how plans group to the project's Pull requests heading", () => {
    for (const path of [
      "docs/workflow.md",
      "docs/landing.md",
      "agents/planner.md",
      "agents/assistant.md",
    ]) {
      const text = read(path).replace(/\s+/g, " ");
      expect(text).not.toContain("same file is neither");
      expect(text).not.toContain("only changes a file an open pull request changes");
    }
    expect(read("docs/decisions.md").replace(/\s+/g, " ")).toContain(
      "one that only changes the same file is neither.~~ (Javi, 4 November)",
    );
    expect(read("agents/assistant.md").replace(/\s+/g, " ")).toContain(
      "then go by the project file's **Pull requests** heading",
    );
    expect(read("agents/planner.md").replace(/\s+/g, " ")).toContain(
      "read the project file's **Pull requests** heading, which decides where a related plan lands",
    );
    expect(read("docs/landing.md").replace(/\s+/g, " ")).toContain(
      "One of the queue's own marked ready goes by the project's **Pull requests** heading: lands in it (ready as he left it) when the heading says related plans share a pull request, else stacked on it",
    );
  });

  // plans/prs-close-their-issues.md: a pull request closes the issues it fixes, and the
  // assistant hands on with nothing owed.
  it("has the executor write Closes and link each issue, and the assistant hand on with nothing owed", () => {
    const flat = (path: string) => read(path).replace(/\s+/g, " ");
    const landing = flat("docs/landing.md");
    expect(read("docs/landing.md")).toMatch(
      /\nCloses #<n>\. +<- one per issue its plans' Issue lines name\n/,
    );
    expect(landing).toContain(
      "- **Closes** and **Related**: `Closes #<n>.` for each issue a plan of the topic names in its `Issue` line, one line each, no issue twice: GitHub's keyword, so a merge into the default branch closes it and the queue closes it elsewhere (decisions.md#closes-its-issues).",
    );
    expect(landing).toContain(
      "less its `Closes #`, `For #`, `Builds on #` and `Related:` lines and the list under a `Related:` line, is the owner's and opens the new body unchanged; a `Closes #` line for an issue no plan of the topic names is the owner's too, and is kept.",
    );
    expect(landing).toContain(
      "**Each issue it closes is linked** (decisions.md#closes-its-issues). GitHub reads a closing keyword only on a pull request into the default branch.",
    );
    expect(landing).toContain(
      "addCloseIssueReferences(input: { issueId: $issue, pullRequestIds: [$pull] })",
    );
    expect(landing).toContain(
      "One that is refused is not tried again: \"Built\" and the `Built:` message say `Not linked: #<i>, <gh's line>.`, and the `Closes` line and the queue's close at the merge stand.",
    );
    expect(flat("docs/github.md")).toContain(
      "- **In part**: a brief or plan that does only part of an issue names it `Related: #<n>.`; the one that finishes it carries `Issue: #<n>.`, since the pull request closes what its plans' `Issue` lines name.",
    );
    expect(flat("agents/planner.md")).toContain(
      "different thing on the same files, and for an issue the plan does only part of, which stays open.",
    );
    const docs = flat("docs/workflow.md");
    expect(docs).toContain(
      "the executor writes `Closes #<n>` on the pull request for each issue its plans carry and links it, and the queue closes each when it merges, whatever branch it merges into.",
    );
    expect(docs).toContain("a `Closes` line per issue, `Builds on`, and one `Related` list");
    expect(docs).toContain("closes each issue a merged pull request's description closes;");
    expect(docs).toContain(
      "what it still owes is written into the queue first, and the file is said once to whichever assistant chat speaks next",
    );
    const assistant = flat("agents/assistant.md");
    expect(assistant).toContain(
      'first write and hand on every brief or short plan this chat still owes ("Where each topic ends"), so each is in the queue.',
    );
    expect(assistant).toContain(
      "each thing still to do that waits on something, as `When <what happens>, then <what to do>.`",
    );
    expect(assistant).toContain(
      "A brief or a plan to write that waits on nothing is never a line of it.",
    );
    expect(assistant).toContain(
      "or told by a prompt's line that no assistant chat has read the file since it was written, read it before anything else",
    );
    expect(flat("docs/decisions.md")).toContain(
      "- `closes-its-issues` **A pull request names each issue it fixes with `Closes #<n>.`, is linked to it, and its merge closes it, whatever branch it merges into.** (Javi, 26 November)",
    );
    // `For #<n>.` is no longer what the executor writes: only an older line read or taken out.
    for (const path of [
      "docs/landing.md",
      "docs/workflow.md",
      "docs/github.md",
      "agents/executor.md",
    ])
      for (const line of read(path)
        .split("\n")
        .filter((one) => one.includes("For #")))
        expect(line).toMatch(/`Closes #`, `For #`|an older `For #<n>\.` line/);
  });

  // plans/draft-takes-its-follow-ups.md: a plan resting on an open draft of
  // the queue's own lands in it, listed with that draft's topic, not a new one.
  it("lands a plan resting on the queue's own open draft in that draft, and stacks it on any other", () => {
    const mode = /# Landing by pull request[\s\S]*?\n\*\*A topic's plan\*\*/
      .exec(read("docs/landing.md"))![0]
      .replace(/\s+/g, " ");
    const rests = mode.slice(
      mode.indexOf("**A plan that rests on an open pull request**"),
      mode.indexOf("**No branch yet**"),
    );
    expect(rests).toContain("`gh pr view <n> --json isDraft,headRefName`");
    expect(rests).toContain("**A draft of this queue's own** takes it");
    expect(rests).toContain(
      "the plan lands in that pull request whatever its `Lands` line names, its topic that head branch",
    );
    expect(rests).toContain("**Another person's** is stacked on");
    // A plan written for a draft since marked ready gets a topic of its own, not the ready one.
    expect(rests).toContain(
      "as `topic <the plan's file name without .md>` (with `-2` when that is the head branch) when its `Lands` line names that pull request's topic",
    );
    // The plan is listed where it lands, so its old topic is not taken for opened.
    expect(rests).toContain("A plan sent to another topic has its `Lands` line rewritten to it");
    const fresh = mode.slice(
      mode.indexOf("**No branch yet**"),
      mode.indexOf("**A branch with no pull request yet**"),
    );
    expect(fresh).toContain("Stacked: `git switch -c <name> <that head branch>`");
    expect(fresh).not.toContain("that plan's pull request is open: then");
    for (const agent of ["planner", "assistant"]) {
      const text = read(`agents/${agent}.md`).replace(/\s+/g, " ");
      expect(text).toContain(
        "an open draft of this queue's own it lands in (\"lands in #<n>\", its `Lands` that draft's topic), another person's it is stacked on (\"stacked on #<n>\"), one of this queue's marked ready by the **Pull requests** heading, stacked without it",
      );
      expect(text).not.toContain("build it on #<n>'s branch");
    }
    const entry = read("docs/decisions.md").replace(/\s+/g, " ");
    expect(entry).toContain(
      "~~A plan that rests on an open pull request (uses what it adds) is stacked on it; one that only changes the same file is not.~~ (Javi, 30 October)",
    );
  });
});

describe("a pull request per topic", () => {
  const read = (path: string) =>
    readFileSync(new URL(`../plugins/workflow/${path}`, import.meta.url), "utf8").replace(
      /\s+/g,
      " ",
    );

  it("has the executor land a fix in the day's pull request or straight, and a topic when nothing more of it is queued", () => {
    const text = read("docs/landing.md");
    const mode = /# Landing by pull request[\s\S]*/.exec(text)![0];
    // A fix: the day's branch and title.
    expect(mode).toContain("**A fix**, `Lands: fix.`");
    expect(mode).toContain("`fixes-<yyyy-mm-dd>`");
    expect(mode).toContain('--title "Small fixes, <d Month yyyy>"');
    expect(mode).toContain("--head fixes-<yyyy-mm-dd>");
    // A fix after the day's pull request merged waits for tomorrow's (Javi, 30 October).
    expect(mode).toContain("the fix **waits for tomorrow**");
    expect(mode).toContain("`fixes-<the next day's yyyy-mm-dd>`, pushed, no pull request");
    // A fix wanted now: the fast-forward push to the branch, then the Already on list.
    expect(mode).toContain("**A fix wanted now**, `Lands: fix, now.`");
    expect(mode).toContain("`git push origin HEAD:<branch>` as a fast-forward");
    expect(mode).toContain("under `Already on <branch>`");
    // A topic: its name is the branch; plans/topic-opens-when-nothing-waits.md:
    // its pull request opens by the queue's line, once nothing more is queued.
    expect(mode).toContain("**A topic's branch** is the topic's name");
    expect(mode).toContain(
      "- **No pull request**: run `plans topic plans/<this plan>.md` and follow its line (decisions.md#topic-landing).",
    );
    expect(mode).toContain(
      '**More is queued** (`… still queued for topic <name>: its pull request waits for …`): nothing opens. "Built" opens with `On topic <name>, commit <sha>, branch pushed; its pull request waits for <the paths the line names>.`',
    );
    expect(mode).toContain(
      "**Nothing else queued** (`Nothing else is queued for topic <name>: …`): the description (below), written from every plan of the topic so far, oldest first, to `plans/<this plan>/pull-request.md`",
    );
    // plans/pull-requests-small-and-plain.md, part 4: a title for the whole
    // pull request, written again on a join that it no longer covers, and
    // five plans to one, the next on a topic stacked on it.
    expect(mode).toContain(
      "--title \"<this plan's title, or the sentence for all of the topic's plans when it opens with several>\"",
    );
    expect(mode).toContain(
      "- **The title** is one sentence saying what the whole pull request does now (decisions.md#pull-request-title), in the words of the leads under Changes, with no number and no plan's name. A plan alone in it gives its own title. On a join, read the one it has (`gh pr view <n> --json title`). One that is not the queue's last, the `Title:` line of the topic's latest \"Built\" that has one, else its first plan's title, is a person's: it stays, and \"Built\" says `Title kept: a person's.` The queue's own stays while it covers every bullet under Changes, and is written again when this plan adds one it does not cover: the first plan's thing, then what was added, or the area they share when that is more than three things. \"Built\" gets `Title: <the sentence>` after its first line whenever the executor sets one.",
    );
    expect(mode).toContain(
      "- **A pull request takes five plans** (decisions.md#pull-request-full). Before a plan lands in an open pull request of the queue's own, by its `Lands` line, its topic or a draft it rests on, run `plans full <n> plans/<this plan>.md` and follow its line: it lands in it, or on the topic the line names, stacked on #<n>, its `Lands` line rewritten as the line gives it and that topic's branch taken as below. \"Built\" and the `Built:` message say `#<n> was full: built on topic <name>, stacked on it.`",
    );
    expect(mode).toContain(
      "then its base merged in, origin/<branch> or the head branch it is stacked on,",
    );
    const handbook = read("docs/workflow.md");
    expect(handbook).toContain(
      "**A pull request takes five plans.** A plan that would land in an open pull request of the queue's own that holds five lands on a topic stacked on it, with the other plans sent there, five to each; `plans full <n> <path>` says which, to the author of a `Lands` line and to the executor at the plan's start. Only a plan that fixes what the pull request itself added, a failed check, a finding of its review or a bug in it, still lands in it, its line saying `; lands in #<n> as its fix.` The day's fixes are not counted. (decisions.md#pull-request-full)",
    );
    expect(handbook).toContain(
      "Its title is one sentence saying what the whole pull request does now, written again when a plan adds what it does not cover; a title a person wrote stays. (decisions.md#pull-request-title)",
    );
    expect(handbook).toContain(
      "a `Closes` line per issue, `Builds on`, and one `Related` list naming each related pull request, issue or branch once",
    );
    expect(handbook).toContain("lands in it while it has room, and one that rests");
    const full =
      "Before writing `lands in #<n>`, run `plans full <n> plans/<topic>.md` and write the `Lands` line it gives; `as its fix` only for a plan that fixes what #<n> itself added.";
    expect(read("agents/planner.md")).toContain(full);
    const assistant = read("agents/assistant.md");
    expect(assistant).toContain(full);
    expect(assistant).toContain(
      "and no question, once `plans full <n> plans/<x>.md` gives that line;",
    );
    expect(read("docs/github.md")).toContain(
      "is a short plan for the fix, `Lands: topic <the head branch>; lands in #<n> as its fix.`",
    );
    expect(mode).toContain(
      "A line written before 26 November 2026 may say `, waiting` or `, ready` after the name: it means nothing now. Follow the line; its author judges whether a change is a fix.",
    );
    expect(mode).toContain(
      "**A topic left with no pull request** is opened: each topic `plans` lists under `Topics waiting for a pull request` as `nothing is queued for it`.",
    );
    expect(mode).toContain("`Pull request #<n> (<url>) found <open | merged | closed> <date>.`");
    // Codex C1 to C3: its own branch, not a fork's, and a closed one only at the branch's commit.
    expect(mode).toContain(
      "a pull request from a fork being another person's and not this topic's",
    );
    expect(mode).toContain("one found open, or merged or closed at `origin/<name>`'s commit");
    // /code-review: work a squash merge took opens nothing.
    expect(mode).toContain("so work a squash merge took is nothing");
    expect(mode).toContain('is opened as "Nothing else queued" says with `--head <name>` added');
    expect(mode).toContain(
      "`No pull request: <branch <name> is gone from origin | its commits are on <branch> already>.` in each. A create refused because another executor opened it first is read again and written as found.",
    );
    expect(mode).toContain(
      'lands as `topic <the plan\'s file name without .md>`, its `Lands` line rewritten to it, its "Built" and the final message saying why (decisions.md#fix-landing).',
    );
    expect(mode).toContain(
      "then each topic whose pull request waits, with the plans it waits for, and each one opened or found at this plan's start",
    );
    expect(mode).not.toContain("marks the topic ready");
    expect(mode).not.toContain("**Waiting, no pull request**");
    expect(mode).toContain("written from every plan of the topic so far, oldest first");
    // plans/ready-stays-ready.md: a pull request the owner marked ready stays ready when joined.
    expect(mode).toContain("a plan that joins one he has marked ready pushes to it as it is");
    expect(mode).not.toContain("ready --undo");
    expect(mode).not.toContain("a draft again");
    expect(mode).not.toContain("joined, commit <sha>; draft.");
    expect(mode).toContain("for one he marked ready, that it stays ready");
    expect(read("docs/workflow.md")).not.toContain("a draft again");
    expect(read("skills/setup/SKILL.md")).not.toContain("a draft again");
    expect(read("docs/decisions.md")).toContain(
      "once he marks it ready, it stays ready when work is added to it.** (Javi, 15 November, the draft since 30 October)",
    );
    expect(read("docs/decisions.md")).toContain(
      "~~A plan that joins a pull request its owner marked ready runs `gh pr ready --undo` before its push.~~ (Javi, 30 October)",
    );
    // plans/joined-pull-request-no-comment.md: a plan joining an open pull request posts nothing.
    expect(mode).not.toContain("one comment");
    // plans/owner-reviews-before-anyone-else.md: a topic's pull request opens as a draft.
    expect(mode).toContain("gh pr create --draft --base");
    expect(mode).toContain("no `gh pr merge` and no `gh pr ready`;");
    // plans/draft-says-nothing-about-itself.md: GitHub already shows a draft as one.
    expect(mode).not.toContain("Opened as a draft");
    expect(read("docs/workflow.md")).not.toContain("The draft's first line says so");
    // plans/joined-pull-request-no-comment.md: the screenshots go in by `gh pr edit --attach`.
    expect(mode).not.toContain("gh pr comment");
    expect(mode).not.toContain("in the comment below");
    expect(mode).toContain(
      'gh pr edit <n> --title "<the sentence>" --body-file plans/<this plan>/pull-request.md \\ --attach plans/<topic>/<file>.png#<the line>',
    );
    expect(mode).toContain("No comment: the description is the record");
    expect(mode).toContain("set it without `--attach`");
    expect(mode).toContain("description rewritten by `gh pr edit` with `--attach`");
    // The Codex review of it: a partly refused edit is set again from the body gh left.
    expect(mode).toContain("is read back (`gh pr view <n> --json body`) and set again");
    // Javi, 30 October: the comment says nothing of the draft either.
    expect(mode).not.toContain("a draft again until");
    expect(mode).not.toContain("its comment says so");
    // The shorter description: plans/pull-request-description-standard.md.
    expect(mode).not.toContain("None: no rule changed");
  });

  it("has the docs, the assistant and the planner say where a plan lands", () => {
    // plans/docs-as-a-prompt.md: the reason and the date are the catalogue's entry.
    // plans/topic-opens-when-nothing-waits.md: nobody marks a topic ready.
    expect(read("docs/decisions.md")).toContain(
      "A pull request per topic, opened once nothing more of the topic is queued; the fixes, with no decision, one pull request a day; one wanted at once straight to the branch.",
    );
    expect(read("docs/decisions.md")).toContain(
      "- `topic-landing` **A topic's plans are built on one branch, pushed after each, and its pull request opens by itself once a plan of it is built and no other plan of it is queued.** (Javi, 26 November)",
    );
    expect(read("docs/decisions.md")).toContain(
      "Queued is ready, handed over or being built; a plan held for his word, a brief and a dropped plan hold nothing back, since held work would hide built work.",
    );
    expect(read("docs/decisions.md")).toContain(
      "- ~~A topic's plans are built on one branch, pushed after each, and its pull request opens with the first plan marked ready.~~ (Javi, 30 October)",
    );
    expect(read("docs/decisions.md")).toContain(
      "one whose commit changes a rule lands as a topic of its own, whose pull request opens at once, since review beats silence.",
    );
    expect(read("docs/workflow.md")).toContain(
      "- **A topic** (`Lands: topic <name>.`): one branch named for the topic, a commit per plan, pushed after each; its pull request opens by itself when a plan of it is built and no other plan of it is ready, handed over or being built, and nobody marks a topic ready;",
    );
    expect(read("docs/workflow.md")).toContain(
      "commit changes a rule lands as a topic of its own. (decisions.md#fix-landing)",
    );
    expect(read("skills/setup/SKILL.md")).toContain("(`Lands: topic <name>; lands in #<n>.`)");
    // No file under plugins/workflow writes a marked line.
    const root = new URL("../plugins/workflow/", import.meta.url).pathname;
    const marked = spawnSync("grep", ["-rnE", "topic <[^>]+>, (waiting|ready)", root], {
      encoding: "utf8",
    });
    expect(marked.stdout).toBe("");
    expect(marked.status).toBe(1);
    expect(read("docs/workflow.md")).toContain(
      "A topic's pull request opens as a draft and stays one until its owner has reviewed it himself",
    );
    expect(read("docs/workflow.md")).not.toContain("in this mode the queue reads no run");
    // plans/joined-pull-request-no-comment.md: the docs carry the rule, the old one quoted.
    expect(read("docs/decisions.md").replace(/\s+/g, " ")).toContain(
      "its screenshots attached with `gh pr edit --attach`, and nothing is posted.** (Javi, 31 October)",
    );
    expect(read("docs/workflow.md")).not.toContain("written again and one comment says");
    // plans/screenshots-by-owners-login.md: uploaded with the owner's login, posted as the app.
    expect(read("docs/workflow.md").replace(/\s+/g, " ")).toContain(
      "are uploaded with the owner's own gh login and written into text the project's app posts, by `plans gh pr create --attach`, `plans gh pr edit --attach` and the same for an issue: a stored image is the one thing under his name, never a post. A picture that does not go up posts nothing, and `plans gh` says why. A project with no app attaches with gh's own flag under the person's login, which needs gh 2.99 or newer (from GitHub's apt repository; Debian's is 2.23).",
    );
    expect(read("docs/workflow.md").replace(/\s+/g, " ")).toContain(
      "The app has Issues, Pull requests and Actions read and write",
    );
    expect(read("docs/workflow.md").replace(/\s+/g, " ")).toContain(
      "the push and a picture's upload alone are the person's token.",
    );
    expect(read("agents/assistant.md")).toContain("Lands: <fix | fix, now | topic <name>>.");
    expect(read("agents/assistant.md")).toContain(
      "else `Lands: topic <name>.` (a topic `plans` lists, or a new one): its pull request opens by itself once nothing more of the topic is queued, so never ask him whether a topic is ready.",
    );
    expect(read("agents/assistant.md")).not.toContain("That topic is ready");
    expect(read("agents/assistant.md")).toContain("Lands: topic <name>; lands in #<n>.");
    expect(read("agents/assistant.md")).toContain("`Lands: fix, now.` only when");
    expect(read("agents/planner.md")).toContain(
      "With `land: pull-request`, `Lands: topic <name>.`, optionally `; lands in #<n>.`, `; lands in #<n> as its fix.` or `; stacked on #<n>.` after the name. `<name>` is the topic's branch, lower-case words joined by hyphens. A plan alone in a pull request titles it, so title it for what the project does after it. A brief's `Lands` line is carried.",
    );
    expect(read("agents/planner.md")).toContain(
      "or the refusal, and with `land: pull-request` the topic. One message per plan.",
    );
    expect(read("skills/setup/SKILL.md")).toContain(
      "Small fixes with no decision in them come as one pull request a day.",
    );
  });
});

describe("the reuse ceiling and the reviewer", () => {
  it("has the executor stop at one retry of a push refused for credentials", () => {
    const text = readFileSync(
      new URL("../plugins/workflow/agents/executor.md", import.meta.url),
      "utf8",
    );
    expect(text).toContain("Not pushed: <cause>");
    expect(text.replace(/\s+/g, " ")).toContain("Never a token in a URL, a remote or a config");
  });

  it("reads land, push by default, and the starter names it", () => {
    const at = (front: string) => {
      const root = dir("land-");
      mkdirSync(join(root, ".claude"));
      writeFileSync(join(root, ".claude", "workflow.md"), `---\nname: R\n${front}---\n`);
      return project(root).land;
    };
    expect(at("")).toBe("push");
    expect(at("land: pull-request\n")).toBe("pull-request");
    expect(at("land: merge\n")).toBe("push");
    const fresh = dir("land-init-");
    init(fresh);
    expect(readFileSync(join(fresh, ".claude", "workflow.md"), "utf8")).toContain(
      "# land: pull-request    a pull request per topic and one a day for small fixes; omit to push everything",
    );
  });

  it("reads reuse per agent, the numbers used while a project has no history, 200k for an executor and 160k for a planner by default, and the starter names it", () => {
    const at = (front: string) => {
      const root = dir("reuse-");
      mkdirSync(join(root, ".claude"));
      writeFileSync(join(root, ".claude", "workflow.md"), `---\nname: R\n${front}---\n`);
      return project(root).reuse;
    };
    // plans/one-assistant-chat.md, part 2: the assistant's, 150k, where its chat is handed on.
    const defaults = { executor: 200_000, planner: 160_000, assistant: 150_000 };
    expect(at("")).toEqual(defaults);
    expect(at("reuse: nothing\n")).toEqual(defaults);
    // A number holds both agents to it.
    expect(at("reuse: 120000\n")).toEqual({
      executor: 120_000,
      planner: 120_000,
      assistant: 150_000,
    });
    // The map sets each; a missing one is the default.
    expect(at("reuse:\n  executor: 150000\n  planner: 100000\n  assistant: 90000\n")).toEqual({
      assistant: 90_000,
      executor: 150_000,
      planner: 100_000,
    });
    expect(at("reuse:\n  executor: 150000\n")).toEqual({ ...defaults, executor: 150_000 });
    // The related keys are retired: read as nothing.
    expect(at("reuse:\n  planner-related: 100000\n  executor-related: 10\n")).toEqual(defaults);
    const fresh = dir("reuse-init-");
    init(fresh);
    const text = readFileSync(join(fresh, ".claude", "workflow.md"), "utf8");
    expect(text).toContain(
      "# reuse: 200000 # the context above which a finished session retires while this project has under five sessions of the agent: one number, or a map of executor and planner; with history the queue works the ceiling out from this project's transcripts; a map's assistant (150000) is where the assistant chat is handed on",
    );
    expect(text).not.toContain("planner-related");
  });

  it("has the reviewer agent, read-only", () => {
    const text = readFileSync(
      new URL("../plugins/workflow/agents/reviewer.md", import.meta.url),
      "utf8",
    );
    for (const line of [
      "name: reviewer",
      "model: opus",
      "effort: medium",
      "tools: Read, Grep, Glob, Bash",
    ])
      expect(text).toContain(line);
  });
});

describe("the reading-tools trial", () => {
  const trial = new URL("../trials/reading-tools/", import.meta.url).pathname;

  it("prints the pilot's four commands on --dry and runs nothing", () => {
    const results = join(dir("trial-"), "results.jsonl");
    const out = execFileSync("node", [join(trial, "run.mjs"), "--pilot", "--dry"], {
      encoding: "utf8",
      env: { ...process.env, READING_TRIAL_RESULTS: results },
    });
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(4);
    for (const line of lines)
      expect(line).toMatch(
        /\) claude -p --output-format stream-json --verbose --max-budget-usd 1 /,
      );
    expect(lines.filter((l) => l.includes("--mcp-config"))).toHaveLength(2);
    expect(lines.filter((l) => l.includes("--append-system-prompt"))).toHaveLength(2);
    expect(existsSync(results)).toBe(false);
  });

  it("passes every task's oracle answer and fails an empty answer and the prompt itself", async () => {
    const { check, readTasks } = await import("../trials/reading-tools/run.mjs");
    const tasks = readTasks();
    expect(tasks).toHaveLength(24);
    for (const repo of ["plugin", "project"]) {
      const own = tasks.filter((t: { repo: string }) => t.repo === repo);
      expect(own.filter((t: { kind: string }) => t.kind === "code")).toHaveLength(6);
      expect(own.filter((t: { kind: string }) => t.kind === "docs")).toHaveLength(6);
    }
    for (const task of tasks) {
      expect(check(task, task.oracle), task.id).toBe(true);
      expect(check(task, ""), task.id).toBe(false);
      expect(check(task, null), task.id).toBe(false);
      expect(check(task, task.prompt), task.id).toBe(false);
    }
  });

  it("orders every task and rep for both arms, alternating which goes first", async () => {
    const { schedule } = await import("../trials/reading-tools/run.mjs");
    const tasks = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const runs = schedule(tasks, { reps: 2 });
    expect(runs).toHaveLength(12);
    expect(runs.map((r: { arm: string }) => r.arm).slice(0, 4)).toEqual([
      "native",
      "tools",
      "tools",
      "native",
    ]);
    expect(schedule(tasks, { reps: 2 })).toEqual(runs);
    expect(schedule(tasks, { reps: 1, arms: ["tools"] })).toHaveLength(3);
  });

  it("reports the means, the medians and the delta from eight lines", async () => {
    const { summarize, format } = await import("../trials/reading-tools/report.mjs");
    const run = (arm: string, ok: boolean, creation: number, input: number, cost: number) => ({
      kind: "run",
      repo: "plugin",
      arm,
      id: "x",
      rep: 1,
      ok,
      cost,
      usage: { input, cache_read: 1000, cache_creation: creation, output: 100 },
      turns: 4,
      seconds: 10,
      error: null,
    });
    const lines = [
      run("native", true, 10_000, 0, 0.2),
      run("native", true, 12_000, 0, 0.2),
      run("native", true, 14_000, 0, 0.2),
      run("native", false, 16_000, 0, 0.2),
      run("tools", true, 6_000, 0, 0.1),
      run("tools", true, 8_000, 0, 0.1),
      run("tools", true, 10_000, 0, 0.1),
      run("tools", true, 12_000, 0, 0.1),
      { ...run("tools", true, 1, 0, 9), pilot: true },
      {
        kind: "index",
        repo: "plugin",
        seconds: { code: 1, docs: 2 },
        bytes: { code: 2048, docs: 1024 },
      },
    ];
    const summary = summarize(lines);
    const r = summary.repos.plugin;
    expect(r.native.runs).toBe(4);
    expect(r.tools.runs).toBe(4);
    expect(r.native.T.mean).toBe(13_000);
    expect(r.tools.T.mean).toBe(9_000);
    expect(r.native.T.median).toBe(13_000);
    expect(r.delta.T).toBeCloseTo(-30.77, 1);
    expect(r.delta.cost).toBeCloseTo(-50, 5);
    expect(r.delta.success).toBe(25);
    expect(r.noise).toBe(50);
    expect(summary.outcome).toBe("everywhere");
    const text = format(summary);
    expect(text).toContain("| T | 13,000 (median 13,000) | 9,000 (median 9,000) | -30.8% |");
    expect(text).toContain("| success | 75% | 100% | +25.0 points |");
    expect(text).toContain("| plugin | 1 s, 2 KB | 2 s, 1 KB |");
    expect(text).toContain("**Outcome by the rule: everywhere.**");
  });
});

describe("the reading-tools trial's stream", () => {
  it("reads the result line and counts the tools a run called", async () => {
    const { readStream } = await import("../trials/reading-tools/run.mjs");
    const tool = (name: string) => ({ type: "tool_use", name });
    const stream = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [tool("Grep"), tool("Read")] } }),
      JSON.stringify({ type: "assistant", message: { content: [tool("mcp__jcodemunch__order")] } }),
      JSON.stringify({ type: "assistant", message: { content: [tool("Read"), { type: "text" }] } }),
      JSON.stringify({ type: "result", result: "decideStop", total_cost_usd: 0.1 }),
      '{"type":"assist',
    ].join("\n");
    const { result, tools } = readStream(stream);
    expect(result.result).toBe("decideStop");
    expect(tools).toEqual({ Grep: 1, Read: 2, mcp__jcodemunch__order: 1 });
    expect(readStream("")).toEqual({ result: null, tools: {} });
  });
});

describe("the reading-tools trial's guards", () => {
  it("says the outcome is incomplete when an arm has no runs", async () => {
    const { summarize } = await import("../trials/reading-tools/report.mjs");
    const run = { kind: "run", repo: "plugin", arm: "native", id: "x", rep: 1, ok: true };
    const summary = summarize([{ ...run, cost: 0.1, usage: null, turns: 2, seconds: 5 }]);
    expect(summary.repos.plugin.delta.success).toBeNull();
    expect(summary.repos.plugin.keeps).toBe(false);
    expect(summary.outcome).toBe("incomplete: an arm has no runs");
  });

  it("reads the window from usage.json and says when the reading is stale", async () => {
    const { windowOf } = await import("../trials/reading-tools/run.mjs");
    const path = join(dir("usage-"), "usage.json");
    const now = Date.UTC(2026, 9, 27, 15);
    const at = (minutesAgo: number, used: number) =>
      writeFileSync(
        path,
        JSON.stringify({
          at: now / 1000 - minutesAgo * 60,
          five_hour: { used_percentage: used, resets_at: now / 1000 + 3600 },
        }),
      );
    at(1, 61);
    expect(windowOf(path, now)).toEqual({ over: 61, stale: false });
    at(1, 40);
    expect(windowOf(path, now)).toEqual({ over: null, stale: false });
    at(45, 40);
    expect(windowOf(path, now)).toEqual({ over: null, stale: true });
    expect(windowOf(join(path, "missing"), now)).toEqual({ over: null, stale: true });
  });
});

/** plans/owner-questions-plain-and-once.md, part 3: the hooks manifest runs the plain-words check. */
describe("the hooks manifest", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../plugins/workflow/hooks/hooks.json", import.meta.url), "utf8"),
  );
  const commands = (event: string, matcher?: string) =>
    manifest.hooks[event]
      .filter((entry: { matcher?: string }) => entry.matcher === matcher)
      .flatMap((entry: { hooks: { command: string }[] }) => entry.hooks.map((h) => h.command));

  it("checks every question to the owner, and resets the count at each prompt", () => {
    expect(commands("PreToolUse", "AskUserQuestion")).toEqual([
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/plain-words.mjs" question',
    ]);
    expect(commands("UserPromptSubmit")).toContain(
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/plain-words.mjs" prompt',
    );
    expect(manifest.description).toContain("the plain-words check of every question");
  });
  // plans/catch-inconsistent-ui-at-build.md: room for the small model's one call.
  it("gives the catalogue hook thirty seconds, for its model call", () => {
    const entry = manifest.hooks.PreToolUse.flatMap((e: { hooks: object[] }) => e.hooks).find(
      (h: { command: string }) => h.command.includes("catalogue-context.mjs"),
    );
    expect(entry.timeout).toBe(30);
  });
  // plans/one-assistant-chat.md, part 3: the planner's question is a message.
  it("runs the queue's tool hook on a message, for the window's time", () => {
    const tool = manifest.hooks.PreToolUse.find((entry: { hooks: { command: string }[] }) =>
      entry.hooks.some((h) => h.command.endsWith('plan-queue.mjs" tool')),
    );
    expect(tool.matcher.split("|")).toContain("SendMessage");
    expect(tool.matcher.split("|")).not.toContain("AskUserQuestion");
  });
  // plans/shared-count-fixes.md, part 1: a Read is counted by a bare node start, not the queue.
  it("counts a Read with seen.mjs alone, and the other tools' calls in the queue's wrote mode", () => {
    expect(commands("PostToolUse", "Read")).toEqual([
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/seen.mjs"',
    ]);
    expect(commands("PostToolUse", "Edit|Write|MultiEdit|Bash")).toEqual([
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-queue.mjs" wrote',
    ]);
  });
  // plans/plans-on-the-terminal-path.md: every session's start writes the terminal's plans.
  it("writes the terminal's plans at every session's start", () => {
    expect(
      commands("SessionStart", "startup|resume|clear").some((c: string) =>
        c.endsWith('scripts/plans-on-path.mjs"'),
      ),
    ).toBe(true);
  });
});

describe("installing by asking Claude", () => {
  const repo = new URL("../", import.meta.url).pathname;
  const read = (path: string) => readFileSync(join(repo, path), "utf8");
  const prompt =
    "Install the workflow plugin from https://github.com/wordplaylabs/workflow-plugin by following its INSTALL.md.";
  /** The first ```json block of a Markdown text. */
  const jsonBlock = (text: string) => /```json\r?\n([\s\S]*?)\r?\n```/.exec(text)?.[1] ?? "";
  /** The first plain ``` block of a Markdown text: the commands. */
  const commands = (text: string) => /```\r?\n([\s\S]*?)\r?\n```/.exec(text)?.[1] ?? "";
  const installing = () => {
    const docs = read("plugins/workflow/docs/workflow.md");
    return docs.slice(docs.indexOf("\n## Installing\n"));
  };

  it("holds the settings the docs' Installing section holds, so the two cannot drift", () => {
    const install = JSON.parse(jsonBlock(read("INSTALL.md")));
    // The docs show the keys as a fragment of the settings file, without its braces.
    const fromDocs = JSON.parse(`{${jsonBlock(installing())}}`);
    expect(Object.keys(fromDocs)).toEqual([
      "extraKnownMarketplaces",
      "enabledPlugins",
      "statusLine",
      "worktree",
      "env",
    ]);
    expect(install).toEqual(fromDocs);
  });
  it("runs the two commands the docs' Installing section names", () => {
    const fromDocs = commands(installing());
    expect(fromDocs).toContain("claude plugin marketplace add wordplaylabs/workflow-plugin#main");
    expect(fromDocs).toContain('claude plugin install workflow@workflow --config owner="<name>"');
    expect(commands(read("INSTALL.md"))).toBe(fromDocs);
  });
  it("opens the README with the line a person pastes", () => {
    const readme = read("README.md");
    const first = readme.split(/^## /m)[1];
    expect(first.startsWith("Install\n")).toBe(true);
    expect(first.split("\n").filter(Boolean)[1]).toBe(`> ${prompt}`);
  });
});

// plans/install-checks-itself.md: an incomplete copy is said plainly.
// plans/install-fix-safe.md: its fix puts the files back and deletes nothing.
describe("the install check", () => {
  const repo = new URL("../", import.meta.url).pathname;
  const plugin = join(repo, "plugins", "workflow");
  /** A copy of `plugins/workflow` in a temp dir, outside any cache, with the paths given removed. */
  const copy = (...remove: string[]) => {
    const root = join(dir("workflow-copy-"), "workflow");
    cpSync(plugin, root, { recursive: true });
    for (const path of remove) rmSync(join(root, path), { recursive: true, force: true });
    return root;
  };
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  /**
   * A plugins directory as Claude Code lays it out: the marketplace's clone,
   * `<tmp>/marketplaces/workflow`, one commit holding `plugins/workflow`, and
   * the copy at `<tmp>/cache/workflow/workflow/<version>`, the paths given removed.
   */
  const cache = (...remove: string[]) => {
    const tmp = dir("workflow-plugins-");
    const clone = join(tmp, "marketplaces", "workflow");
    mkdirSync(clone, { recursive: true });
    gitIn(clone, "init", "-q", "-b", "main");
    cpSync(plugin, join(clone, "plugins", "workflow"), { recursive: true });
    gitIn(clone, "add", "-A");
    gitIn(clone, "commit", "-q", "-m", "one");
    const version = gitIn(clone, "rev-parse", "--short=12", "HEAD");
    const root = join(tmp, "cache", "workflow", "workflow", version);
    cpSync(plugin, root, { recursive: true });
    for (const path of remove) rmSync(join(root, path), { recursive: true, force: true });
    writeFileSync(
      join(tmp, "installed_plugins.json"),
      JSON.stringify(
        {
          version: 2,
          plugins: { "workflow@workflow": [{ scope: "user", installPath: root, version }] },
        },
        null,
        2,
      ),
    );
    return { tmp, clone, root, version };
  };
  /** The record names another version directory: the copy is an older one. */
  const older = (tmp: string) =>
    writeFileSync(
      join(tmp, "installed_plugins.json"),
      JSON.stringify(
        {
          version: 2,
          plugins: {
            "workflow@workflow": [
              {
                scope: "user",
                installPath: join(tmp, "cache", "workflow", "workflow", "ffffffffffff"),
                version: "ffffffffffff",
              },
            ],
          },
        },
        null,
        2,
      ),
    );
  const OLDER = "This copy is an older version that new chats do not load: start a new chat.";
  const FOLDER =
    "This copy is loaded from a folder, not the plugins cache: put them back in that folder, " +
    "then start a new chat.";
  const broken = ["hooks/hooks.json", "scripts/project.mjs", "skills"];
  const brokenList =
    "hooks/hooks.json, scripts/project.mjs, skills/change/SKILL.md, " +
    "skills/design-research/SKILL.md, skills/setup/SKILL.md, skills/setup/kinds.md";
  /** The manifest's SessionStart command, the one declared inline. */
  const manifestCommand = () => {
    const manifest = JSON.parse(
      readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8"),
    );
    const [entry] = manifest.hooks.SessionStart;
    expect(entry.matcher).toBe("startup|resume|clear");
    return entry.hooks[0].command as string;
  };
  /** The check run on a copy, its JSON's text, or "" when it printed nothing. */
  const check = (root: string) => {
    const run = spawnSync("node", [join(root, "scripts", "install-check.mjs")], {
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    if (!run.stdout) return "";
    const out = JSON.parse(run.stdout);
    // The owner sees the line; the agent gets the line and what to do with it.
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: "SessionStart",
      additionalContext: `${out.systemMessage}\n\n${steps(root)}`,
    });
    return out.systemMessage as string;
  };
  /** `plans` in a throwaway git repository, on the copy's `bin/plans`. */
  const plans = (root: string) => {
    const cwd = dir("workflow-plans-");
    execFileSync("git", ["init", "-q"], { cwd });
    return spawnSync("node", [join(root, "bin", "plans")], { cwd, encoding: "utf8" });
  };
  /** The command after `The fix: `, up to `, then start a new chat.` */
  const fixIn = (text: string) => /The fix: (.*), then start a new chat\./.exec(text)?.[1];
  const head = (root: string, gone: string) =>
    `The workflow plugin's installed copy is incomplete: 6 of its ${FILES.length} files are missing ` +
    `from ${root}, and what is missing does not run in this chat. Missing: ${gone}. `;

  it("lists every tracked file of the plugin, so a new file without a line fails here", () => {
    const tracked = execFileSync("git", ["ls-files", "plugins/workflow"], {
      cwd: repo,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .map((path) => path.slice("plugins/workflow/".length));
    expect(FILES, "FILES in scripts/install-check.mjs differs from git ls-files").toEqual(tracked);
  });
  it("When a complete copy starts a session, then the check prints nothing", () => {
    expect(check(copy())).toBe("");
  });
  it("When a cached copy lacks files and the clone is at its commit, then the fix is git archive", () => {
    const { clone, root, version } = cache(...broken);
    expect(check(root)).toBe(
      head(root, brokenList) +
        `The fix: git -C "${clone}" archive ${version}:plugins/workflow | tar -x -C "${root}", ` +
        "then start a new chat.",
    );
  });
  it("When that fix is run, then the copy is whole again, bin/plans executable", () => {
    const { root } = cache(...broken, "bin/plans");
    const command = fixIn(check(root));
    expect(command).toMatch(/ archive /);
    const run = spawnSync("sh", ["-c", command as string], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(missing(root)).toEqual([]);
    expect(statSync(join(root, "bin", "plans")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(root, "scripts", "project.mjs"), "utf8")).toBe(
      readFileSync(join(plugin, "scripts", "project.mjs"), "utf8"),
    );
    expect(check(root)).toBe("");
  });
  it("When the clone has moved on from the copy's commit, then the fix is plugin update", () => {
    const { clone, root } = cache(...broken);
    writeFileSync(join(clone, "later.txt"), "later\n");
    gitIn(clone, "add", "-A");
    gitIn(clone, "commit", "-q", "-m", "two");
    expect(check(root)).toBe(
      head(root, brokenList) +
        "The fix: claude plugin update workflow@workflow, then start a new chat.",
    );
  });
  it("When the clone is absent, then the fix is plugin update", () => {
    const { clone, root } = cache(...broken);
    rmSync(clone, { recursive: true, force: true });
    expect(check(root)).toBe(
      head(root, brokenList) +
        "The fix: claude plugin update workflow@workflow, then start a new chat.",
    );
  });
  it("When the copy is not in a plugins cache, then the line names no command", () => {
    const root = copy(...broken);
    expect(check(root)).toBe(
      head(root, brokenList) +
        "This copy is loaded from a folder, not the plugins cache: put them back in that folder, " +
        "then start a new chat.",
    );
  });
  it("When plans runs on an incomplete copy, then it says the same line and exits 1", () => {
    const root = copy(...broken);
    const text = check(root);
    expect(text).toContain("This copy is loaded from a folder");
    const run = plans(root);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(`${text}\n`);
  });
  it("When the copy is an older version than the installed one, then the line names no command", () => {
    const { tmp, root } = cache(...broken);
    older(tmp);
    const text = check(root);
    expect(text).toBe(head(root, brokenList) + OLDER);
    const run = plans(root);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(`${text}\n`);
  });
  it("When a folder above the cache is a symlink, then the installed copy is still the installed one", () => {
    const { tmp, clone, root, version } = cache(...broken);
    const link = `${tmp}-link`;
    symlinkSync(tmp, link);
    made.push(link);
    const linked = join(link, "cache", "workflow", "workflow", version);
    writeFileSync(
      join(tmp, "installed_plugins.json"),
      JSON.stringify(
        {
          version: 2,
          plugins: { "workflow@workflow": [{ scope: "user", installPath: linked, version }] },
        },
        null,
        2,
      ),
    );
    // Node resolves the script's path, so the check reads the real root.
    const run = spawnSync("node", [join(linked, "scripts", "install-check.mjs")], {
      encoding: "utf8",
    });
    expect(JSON.parse(run.stdout).systemMessage).toBe(
      head(root, brokenList) +
        `The fix: git -C "${clone}" archive ${version}:plugins/workflow | tar -x -C "${root}", ` +
        "then start a new chat.",
    );
    const one = cache("scripts/install-check.mjs", "skills");
    const oneLink = `${one.tmp}-link`;
    symlinkSync(one.tmp, oneLink);
    made.push(oneLink);
    const oneLinked = join(oneLink, "cache", "workflow", "workflow", one.version);
    writeFileSync(
      join(one.tmp, "installed_plugins.json"),
      JSON.stringify({ plugins: { "workflow@workflow": [{ installPath: oneLinked }] } }, null, 2),
    );
    const cwd = dir("workflow-plans-");
    execFileSync("git", ["init", "-q"], { cwd });
    const plansRun = spawnSync("node", [join(oneLinked, "bin", "plans")], {
      cwd,
      encoding: "utf8",
    });
    expect(plansRun.stderr).toContain("The fix: git -C");
  });
  it("When one file is missing, then the line says it is", () => {
    const root = copy("docs/landing.md");
    expect(check(root)).toContain(`1 of its ${FILES.length} files is missing from ${root}`);
  });
  it("When a copy lacks the check itself, then the manifest and plans decide as the check does", () => {
    const first =
      "The workflow plugin's installed copy is incomplete: scripts/install-check.mjs is missing, " +
      "and maybe more. ";
    const atCommit = cache("scripts/install-check.mjs");
    const movedOn = cache("scripts/install-check.mjs");
    writeFileSync(join(movedOn.clone, "later.txt"), "later\n");
    gitIn(movedOn.clone, "add", "-A");
    gitIn(movedOn.clone, "commit", "-q", "-m", "two");
    const old = cache("scripts/install-check.mjs");
    older(old.tmp);
    const folder = copy("scripts/install-check.mjs");
    // The manifest's line carries the agent's steps; plans prints the line alone.
    const ask =
      ' Say this line to the owner, then ask once with the question tool, headed "Install", ' +
      "whether to run the fix; on yes run it, then say to start a new chat; on no, say nothing " +
      "is changed. Then stop.";
    const say = " Say this line to the owner, then stop.";
    const layouts: [string, string, string][] = [
      [
        atCommit.root,
        `The fix: git -C "${atCommit.clone}" archive ${atCommit.version}:plugins/workflow | ` +
          `tar -x -C "${atCommit.root}", then start a new chat.`,
        ask,
      ],
      [
        movedOn.root,
        "The fix: claude plugin update workflow@workflow, then start a new chat.",
        ask,
      ],
      [old.root, OLDER, say],
      [folder, FOLDER, say],
    ];
    for (const [root, last, steps] of layouts) {
      const fallback = `${first}${last}\n`;
      const env = { ...process.env, HOME: dir("workflow-home-"), CLAUDE_PLUGIN_ROOT: root };
      const hook = spawnSync("sh", ["-c", manifestCommand()], { encoding: "utf8", env });
      expect(hook.status, root).toBe(0);
      expect(hook.stdout, root).toBe(`${first}${last}${steps}\n`);
      const cwd = dir("workflow-plans-");
      execFileSync("git", ["init", "-q"], { cwd });
      const run = spawnSync("node", [join(root, "bin", "plans")], { cwd, encoding: "utf8", env });
      expect(run.status, root).toBe(1);
      expect(run.stdout, root).toBe("");
      expect(run.stderr, root).toBe(fallback);
    }
  });
  it("says what the agents do with the line in the same words in all four", () => {
    const paragraph = (agent: string) =>
      /\*\*An incomplete install comes first\.\*\*[\s\S]*?\n\n/.exec(
        readFileSync(join(plugin, "agents", `${agent}.md`), "utf8"),
      )?.[0];
    const assistant = paragraph("assistant");
    expect(assistant).toContain("The workflow plugin's installed copy is incomplete");
    for (const agent of ["planner", "executor", "maker"]) expect(paragraph(agent)).toBe(assistant);
  });
});

// plans/priority-queue.md, part 6 and part 7.
describe("a plan put first", () => {
  const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
  it("the Plan first message is one sentence in three files", () => {
    const message =
      "`Plan first: plans/<topic>.md. Build it next, once the plan in hand is built; nothing to answer.`";
    for (const agent of ["executor", "assistant", "planner"]) {
      const text = readFileSync(join(plugin, "agents", `${agent}.md`), "utf8");
      expect(text.replace(/\n[ \t]*/g, " "), agent).toContain(message);
      // plans/one-assistant-chat.md, part 6: putting a plan first is the assistant's, on his word.
      if (agent === "assistant") expect(text, agent).toContain("plans first");
      else expect(text, agent).not.toContain("plans first");
    }
    const handbook = readFileSync(join(plugin, "docs", "workflow.md"), "utf8");
    expect(handbook).toContain("**A plan put first is built next.**");
    expect(handbook).toContain("(decisions.md#plan-put-first)");
    expect(readFileSync(join(plugin, "docs", "decisions.md"), "utf8")).toContain(
      "- `plan-put-first` **A plan or a brief the owner puts first is taken",
    );
  });
});

describe("the scripts' type declarations", () => {
  const scripts = new URL("../plugins/workflow/scripts/", import.meta.url);
  const files = readdirSync(scripts).filter((file) => file.endsWith(".d.mts"));
  it("finds the declarations files", () => expect(files.length).toBeGreaterThan(0));
  for (const file of files) {
    const script = file.replace(/\.d\.mts$/, ".mjs");
    it(`every function ${file} declares is exported by ${script}`, async () => {
      const declarations = readFileSync(new URL(file, scripts), "utf8");
      const declared = [
        ...declarations.matchAll(
          /^export (?:declare )?(?:async )?(?:function|const|let|var|class) (\w+)/gm,
        ),
      ].map((match) => match[1]);
      expect(declared.length).toBeGreaterThan(0);
      const exported = Object.keys(await import(new URL(script, scripts).href));
      expect(declared.filter((name) => !exported.includes(name))).toEqual([]);
    });
  }
});

// plans/executor-never-waits.md: what an executor would ask the owner, it decides.
describe("a plan's commit holds the plan's files only", () => {
  // plans/owners-untracked-files-left-alone.md, item 2.
  const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
  const flat = (text: string) => text.replace(/\s+/g, " ");
  const before = () =>
    /## Before the push(.*?)## After/.exec(
      flat(readFileSync(join(plugin, "agents/executor.md"), "utf8")),
    )![1];

  it("stages the plan's files by path and leaves untracked files the executor did not write", () => {
    const step4 = /4\. Commit and push:.*? 5\. /.exec(before())![0];
    expect(step4).toContain("Stage the plan's files by path, the ones its diff touched");
    expect(step4).toContain("never `git add -A` or `git add .`");
    expect(step4).toContain("`git status --porcelain`");
    expect(step4).toContain("an untracked file you did not write stays untracked");
  });

  it("reports a failure in a file the executor did not touch as the owner's", () => {
    const step3 = /3\. The checks and suites.*? 4\. /.exec(before())![0];
    expect(step3).toContain(
      "A failure in a file you did not touch and the plan does not name is the owner's",
    );
    expect(step3).toContain("when it fails the same at `origin/<branch>`");
    expect(step3).toContain("not fixed");
    expect(step3).toContain("One your change causes is yours to fix.");
  });
});

describe("an executor never waits on the owner", () => {
  const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
  const read = (path: string) => readFileSync(join(plugin, path), "utf8");
  const flat = (text: string) => text.replace(/\s+/g, " ");

  it("the handbook and the catalogue hold the rule", () => {
    const handbook = flat(read("docs/workflow.md"));
    const rule = /\*\*An executor never waits on the owner\.\*\*.*?\(decisions\.md#[\w-]+\)/.exec(
      handbook,
    )![0];
    expect(rule.endsWith("(decisions.md#executor-never-waits)")).toBe(true);
    expect(rule).toContain("`Decision to check: plans/<x>.md.`");
    expect(rule).toContain("`Checked: plans/<x>.md.`");
    expect(rule).toContain("`plans/decisions-taken.md`");
    const asked = /\*\*Asked once\.\*\*.*?\(decisions\.md#asked-once\)/.exec(handbook)![0];
    expect(asked).not.toContain("is asked in the executor's session");
    const one =
      /\*\*A queue has as many executors as its project file's `executors` says\*\*.*?\(decisions\.md#executor-pool/.exec(
        handbook,
      )![0];
    expect(one).not.toContain("the owner is asked");
    expect(one).toContain("handed to the assistant");
    expect(read("docs/decisions.md")).toContain(
      "- `executor-never-waits` **An executor never asks the owner and never",
    );
  });

  it("the executor has no question tool and decides what it would ask", () => {
    const file = read("agents/executor.md");
    const front = /^---\n([\s\S]*?)\n---/.exec(file)![1];
    const disallowed = /^disallowedTools: (.*)$/m.exec(front)![1].split(/,\s*/);
    expect(disallowed).toContain("AskUserQuestion");
    expect(file).toContain("\n## A question is decided, not asked\n");
    const text = flat(file);
    expect(text).toContain("Decision to check: plans/<x>.md.");
    expect(text).toContain("Checked: plans/<x>.md.");
    expect(text).toContain("Taken on ${user_config.owner}'s standing word:");
    expect(text).not.toContain("**ask**");
    expect(text).not.toContain("asked once");
    expect(text).not.toContain("is asked");
    expect(text.split("question tool").length - 1).toBe(1);
    expect(text).toContain("You have no question tool");
  });

  // plans/one-assistant-chat.md, parts 3 to 6: the owner talks to one chat.
  it("has only the assistant ask and tell the owner, by the four first lines", () => {
    const front = (agent: string) => /^---\n([\s\S]*?)\n---/.exec(read(`agents/${agent}.md`))![1];
    const body = (agent: string) =>
      flat(read(`agents/${agent}.md`).replace(/^---\n[\s\S]*?\n---/, ""));
    const disallowed = (agent: string) =>
      /^disallowedTools: (.*)$/m.exec(front(agent))![1].split(/,\s*/);
    expect(disallowed("planner")).toContain("AskUserQuestion");
    // The tool is taken away in the frontmatter; no instruction names it.
    for (const agent of ["planner", "executor"]) {
      expect(disallowed(agent), agent).toEqual(
        expect.arrayContaining(["PushNotification", "SendUserFile", "TaskCreate"]),
      );
      expect(body(agent), agent).not.toContain("PushNotification");
      expect(body(agent), agent).not.toMatch(/SendUserFile|task list|TaskCreate|in this chat/);
    }
    // Each first line in the file that sends it and the file that reads it.
    const lines: [string, string[], string[]][] = [
      ["Question for ${user_config.owner}: plans/<x>.md.", ["planner"], ["assistant"]],
      ["Answered: plans/<x>.md.", ["assistant"], ["planner"]],
      ["Planned: plans/<x>.md.", ["planner"], ["assistant"]],
      ["Built: plans/<x>.md.", ["executor"], ["assistant"]],
      ["From ${user_config.owner}: said in <", ["planner", "executor"], ["assistant"]],
      // The queue's own, sent by tellAssistant (plans/open-assistant-reads-github-notes.md).
      ["GitHub: plans/github/<n>.md.", [], ["assistant"]],
    ];
    for (const [line, senders, readers] of lines)
      for (const agent of [...senders, ...readers]) expect(body(agent), agent).toContain(line);
  });

  it("the planner and the assistant answer a check at once", () => {
    for (const agent of ["planner", "assistant"]) {
      const text = flat(read(`agents/${agent}.md`));
      expect(text, agent).toContain("Decision to check: plans/<x>.md.");
      expect(text, agent).toContain("Checked: plans/<x>.md.");
      expect(text, agent).toContain("answer at once with one `SendMessage` to that executor");
      expect(text, agent).toMatch(/ask \$\{user_config\.owner\} nothing about it/i);
    }
  });

  it("the assistant keeps the log", () => {
    const text = flat(read("agents/assistant.md"));
    expect(text).toContain('`plans/decisions-taken.md` ("Decisions taken")');
    expect(text).toContain("`# Decisions taken for ${user_config.owner}, for his review`");
    expect(text).toContain(
      "`- plans/<x>.md, <the executor's name>: <the question>. Taken: <the option>. Checked with <chat's name>:",
    );
    expect(text).toContain('log what was taken ("Decisions taken")');
  });

  // plans/executor-never-waits-follow-up.md.
  it("the skill and the handbook let an executor research and follow a new screen", () => {
    const clause =
      "an executor does not ask: it researches how the product people know does it, follows it, and names it in Built";
    const skill = flat(read("skills/design-research/SKILL.md"));
    const step2 = /2\. \*\*A new screen or flow.*? 3\. \*\*/.exec(skill)![0];
    expect(step2).toContain(`An${clause.slice(2)}`);
    // Codex C1: step 4's "build after the answer" does not hold an executor.
    const step4 = /4\. \*\*Say what you found.*? 5\. \*\*/.exec(skill)![0];
    expect(step4).toContain("An executor builds at once and says what it found in Built");
    const rule =
      /\*\*A string rests on what produced it\.\*\*.*?\(decisions\.md#string-rests-on-source\)/.exec(
        flat(read("docs/workflow.md")),
      )![0];
    expect(rule).toContain(clause);
  });

  // plans/executors-build-in-worktrees.md, part 6: nothing in an
  // executor's worktree is the owner's, so its clean start stashes it whole.
  const startClean = () => {
    const clean = /4\. Start clean:.*? 5\. /.exec(flat(read("agents/executor.md")))![0];
    const stash = /`(git stash push --include-untracked -m [^`]*)`/.exec(clean)![1];
    return { clean, stash };
  };

  it("an executor's clean start stashes its worktree whole, named in Built, discarding nothing", () => {
    const { clean, stash } = startClean();
    expect(clean).toContain("nothing in this worktree is ${user_config.owner}'s");
    expect(clean).toContain("you are not resuming the plan it belongs to");
    expect(clean).toContain('name the stash in "Built"; discard nothing');
    expect(clean).toContain("`GIT_AUTHOR_*` and `GIT_COMMITTER_*`");
    expect(clean).toContain("`.claude/worktrees/executor-<n>`, kept for the next one");
    expect(clean).toContain("`$WORKFLOW_EXECUTOR`");
    expect(clean).not.toContain("GIT_LITERAL_PATHSPECS");
    expect(clean).not.toContain("Make no worktree");
    expect(stash).not.toContain(" -- ");
  });

  it("when an executor's worktree holds a change and an untracked file, the stash takes both and the switch follows, the ignored .env staying", () => {
    const { stash } = startClean();
    const root = dir("stash-");
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      LC_ALL: "C",
    };
    const run = (cmd: string) => spawnSync("sh", ["-c", cmd], { cwd: root, env, encoding: "utf8" });
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "test");
    writeFileSync(join(root, ".gitignore"), ".env\n");
    writeFileSync(join(root, "app.txt"), "one\n");
    git("add", ".gitignore", "app.txt");
    git("commit", "-q", "-m", "one");
    // origin/test gains notes.md, which the worktree has untracked.
    writeFileSync(join(root, "notes.md"), "the branch's\n");
    git("add", "notes.md");
    git("commit", "-q", "-m", "two");
    git("update-ref", "refs/remotes/origin/test", "HEAD");
    git("checkout", "-q", "--detach", "HEAD~1");
    writeFileSync(join(root, "app.txt"), "edited\n");
    writeFileSync(join(root, "notes.md"), "a gone executor's\n");
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    const named = stash.replace("<this session's name>", "Executor 1").replace("<topic>", "x");
    expect(run(named).status).toBe(0);
    expect(git("status", "--porcelain")).toBe("");
    expect(run("git switch -c x origin/test").status).toBe(0);
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("the branch's\n");
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(git("stash", "list")).toContain("Executor 1, before plans/x.md");
    expect(git("show", "stash@{0}:app.txt")).toBe("edited");
    expect(git("show", "stash@{0}^3:notes.md")).toBe("a gone executor's");
  });
});

// plans/agent-set-by-the-project.md: the plugin sets no agent; a project's own local settings do.
describe("the agent a project's chats open as", () => {
  const local = (root: string) => join(root, ".claude", "settings.local.json");
  const readLocal = (root: string) => readFileSync(local(root), "utf8");
  const project = (form = "") => {
    const root = dir("agent-");
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      `---\nname: A\nbranch: main\n${form ? `form: ${form}\n` : ""}---\n`,
    );
    return root;
  };
  const user = (settings?: object) => {
    const file = join(dir("agent-user-"), "settings.json");
    if (settings) writeFileSync(file, JSON.stringify(settings));
    return file;
  };
  const hookIn = (root: string, input: object, env: Record<string, string> = {}) => {
    const { WORKFLOW_ROOT: _r, CLAUDE_PROJECT_DIR: _p, ...rest } = process.env;
    const home = dir("agent-home-");
    return execFileSync("node", [join(scripts, "plan-queue.mjs"), "session"], {
      cwd: root,
      env: { ...rest, HOME: home, WORKFLOW_DATA: dir("agent-data-"), WORKFLOW_LIVE: "[]", ...env },
      input: JSON.stringify(input),
      encoding: "utf8",
    });
  };

  it("writes the assistant where no settings file names an agent", () => {
    const root = project();
    expect(sessionAgent(root, { userSettings: user() })).toEqual({
      agent: "workflow:assistant",
      did: "set",
    });
    expect(readLocal(root)).toBe('{\n  "agent": "workflow:assistant"\n}\n');
    expect(
      execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: root,
        encoding: "utf8",
      }),
    ).toBe("?? .claude/workflow.md\n");
    expect(sessionAgent(root, { userSettings: user() }).did).toBe("");
  });

  it("writes the maker in a compact project", () => {
    const root = project("compact");
    expect(sessionAgent(root, { form: "compact", userSettings: user() })).toEqual({
      agent: "workflow:maker",
      did: "set",
    });
    expect(JSON.parse(readLocal(root)).agent).toBe("workflow:maker");
  });

  it("keeps the local file's other keys", () => {
    const root = project();
    writeFileSync(
      local(root),
      JSON.stringify({ permissions: { deny: ["mcp__x__.*"] }, env: { A: "1" } }),
    );
    expect(sessionAgent(root, { userSettings: user() }).did).toBe("set");
    const kept = JSON.parse(readLocal(root));
    expect(Object.keys(kept)).toEqual(["permissions", "env", "agent"]);
    expect(kept).toEqual({
      permissions: { deny: ["mcp__x__.*"] },
      env: { A: "1" },
      agent: "workflow:assistant",
    });
  });

  it("writes over a key with no name in it", () => {
    for (const empty of ['""', "null"]) {
      const root = project();
      writeFileSync(local(root), `{ "env": {}, "agent": ${empty} }\n`);
      expect(sessionAgent(root, { userSettings: user() }).did).toBe("set");
      expect(Object.entries(JSON.parse(readLocal(root)))).toEqual([
        ["env", {}],
        ["agent", "workflow:assistant"],
      ]);
    }
  });

  it("moves the key when the form changed", () => {
    const root = project();
    writeFileSync(local(root), JSON.stringify({ agent: "workflow:maker", env: { A: "1" } }));
    expect(sessionAgent(root, { userSettings: user() }).did).toBe("moved");
    expect(Object.entries(JSON.parse(readLocal(root)))).toEqual([
      ["agent", "workflow:assistant"],
      ["env", { A: "1" }],
    ]);
    expect(sessionAgent(root, { form: "compact", userSettings: user() }).did).toBe("moved");
    expect(JSON.parse(readLocal(root)).agent).toBe("workflow:maker");
  });

  it("leaves an agent somebody else named", () => {
    const other = project();
    writeFileSync(local(other), JSON.stringify({ agent: "mine:helper" }));
    expect(sessionAgent(other, { userSettings: user() }).did).toBe("");
    expect(JSON.parse(readLocal(other)).agent).toBe("mine:helper");
    const shared = project();
    writeFileSync(
      join(shared, ".claude", "settings.json"),
      JSON.stringify({ agent: "mine:helper" }),
    );
    expect(sessionAgent(shared, { userSettings: user() }).did).toBe("");
    expect(existsSync(local(shared))).toBe(false);
    const personal = project();
    writeFileSync(local(personal), JSON.stringify({ env: { A: "1" } }));
    expect(sessionAgent(personal, { userSettings: user({ agent: "mine:helper" }) }).did).toBe("");
    expect(JSON.parse(readLocal(personal))).toEqual({ env: { A: "1" } });
  });

  it("writes the maker over the plugin's assistant named in the shared file or the user settings", () => {
    const personal = project("compact");
    const settings = user({ agent: "workflow:assistant" });
    expect(sessionAgent(personal, { form: "compact", userSettings: settings }).did).toBe("set");
    expect(JSON.parse(readLocal(personal)).agent).toBe("workflow:maker");
    const shared = project("compact");
    writeFileSync(
      join(shared, ".claude", "settings.json"),
      JSON.stringify({ agent: "workflow:assistant" }),
    );
    expect(sessionAgent(shared, { form: "compact", userSettings: user() }).did).toBe("set");
    expect(JSON.parse(readLocal(shared)).agent).toBe("workflow:maker");
    const full = project();
    expect(sessionAgent(full, { userSettings: settings }).did).toBe("");
    expect(existsSync(local(full))).toBe(false);
    const outranked = project("compact");
    writeFileSync(
      join(outranked, ".claude", "settings.json"),
      JSON.stringify({ agent: "mine:helper" }),
    );
    expect(sessionAgent(outranked, { form: "compact", userSettings: settings }).did).toBe("");
    expect(existsSync(local(outranked))).toBe(false);
  });

  it("leaves a local file it cannot read as JSON, and one git tracks", () => {
    const broken = project();
    writeFileSync(local(broken), "{ not json");
    expect(sessionAgent(broken, { userSettings: user() }).did).toBe("");
    expect(readLocal(broken)).toBe("{ not json");
    const list = project();
    writeFileSync(local(list), "[]\n");
    expect(sessionAgent(list, { userSettings: user() }).did).toBe("");
    expect(readLocal(list)).toBe("[]\n");
    const tracked = project();
    writeFileSync(local(tracked), '{ "env": {} }\n');
    execFileSync("git", ["add", "-f", ".claude/settings.local.json"], { cwd: tracked });
    expect(sessionAgent(tracked, { userSettings: user() }).did).toBe("");
    expect(readLocal(tracked)).toBe('{ "env": {} }\n');
  });

  it("writes nothing where the project's own rule keeps git from ignoring the file", () => {
    const root = project();
    writeFileSync(join(root, ".gitignore"), "!.claude/**\n");
    expect(sessionAgent(root, { userSettings: user() }).did).toBe("");
    expect(existsSync(local(root))).toBe(false);
  });

  it("says the line in the owner's chat alone", () => {
    const line = agentLine("assistant");
    expect(line).toBe(
      "Chats in this project now open as the workflow's assistant, set in .claude/settings.local.json. This one opened before that: start a new chat.",
    );
    const owners = project();
    const said = JSON.parse(hookIn(owners, { session_id: "s1" }));
    expect(said.systemMessage).toBe(line);
    expect(said.hookSpecificOutput).toEqual({
      hookEventName: "SessionStart",
      additionalContext: `${line}\n\nSay this line to the owner in its own words, then go on with what was asked.`,
    });
    expect(JSON.parse(readLocal(owners)).agent).toBe("workflow:assistant");
    expect(hookIn(owners, { session_id: "s2" })).toBe("");
    const opened = project();
    expect(hookIn(opened, { session_id: "s4", agent_type: "workflow:assistant" })).toBe("");
    const planner = project();
    expect(hookIn(planner, { session_id: "s7", agent_type: "workflow:planner" })).toBe("");
    expect(JSON.parse(readLocal(planner)).agent).toBe("workflow:assistant");
    expect(JSON.parse(readLocal(opened)).agent).toBe("workflow:assistant");
    const compact = project("compact");
    expect(JSON.parse(hookIn(compact, { session_id: "s5" })).systemMessage).toBe(
      agentLine("maker"),
    );
    expect(JSON.parse(readLocal(compact)).agent).toBe("workflow:maker");
  });

  // plans/app-old-registration-said.md, part 4: an app that sends no failed run is said once.
  it("says once in the owner's chat that the app sends no failed run, again when that changes", () => {
    const root = project();
    writeFileSync(
      join(root, ".claude", "workflow.md"),
      "---\nname: A\nbranch: main\nland: pull-request\n---\n",
    );
    // The agent already set, so the agent's line is not what this start says.
    writeFileSync(local(root), JSON.stringify({ agent: "workflow:assistant" }));
    const both = ["Actions read and write", "the Workflow run event"];
    const app = { where: "app", what: both, slug: "docs-claude", repo: "o/r" };
    const accept = {
      where: "installation",
      what: both,
      slug: "docs-claude",
      url: "https://github.com/settings/installations/7",
      repo: "o/r",
    };
    // A listener's record, its pid this test's, alive.
    const record = (lacks?: object) =>
      writeFileSync(
        join(root, ".claude", "webhook.json"),
        JSON.stringify({ pid: process.pid, port: 1, at: Date.now(), lastAt: 0, lacks }),
      );
    const start = (id: string, agent = "") =>
      // No secret, from the environment or a secrets file, so no listener is armed here.
      hookIn(
        root,
        { session_id: id, ...(agent ? { agent_type: agent } : {}) },
        { WORKFLOW_WEBHOOK_SECRET: "", WORKFLOW_SECRETS_FILE: "" },
      );
    record(app);
    const said = JSON.parse(start("a1"));
    expect(said.systemMessage).toBe(appLine(app));
    expect(said.hookSpecificOutput).toEqual({
      hookEventName: "SessionStart",
      additionalContext: `${appLine(app)}\n\nSay this line to the owner in its own words, then go on with what was asked.`,
    });
    expect(start("a2")).toBe("");
    record(accept);
    // plans/one-assistant-chat.md, part 7: a worker's chat is read by nobody; the assistant's is his.
    expect(start("a3", "workflow:planner")).toBe("");
    expect(start("a3b", "workflow:executor")).toBe("");
    expect(JSON.parse(start("a4", "workflow:assistant")).systemMessage).toBe(appLine(accept));
    expect(start("a5")).toBe("");
    record();
    expect(start("a6")).toBe("");
  });

  it("does nothing in a folder with no project file", () => {
    const root = dir("agent-none-");
    execFileSync("git", ["init", "-q"], { cwd: root });
    expect(hookIn(root, { session_id: "s6" })).toBe("");
    expect(existsSync(local(root))).toBe(false);
  });

  it("has the setup skill write the agent a plain chat opens as", () => {
    const text = readFileSync(
      new URL("../plugins/workflow/skills/setup/SKILL.md", import.meta.url),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(text).toContain(
      '**The agent a plain chat opens as**, the `agent` key of `.claude/settings.local.json`, merged into what is there with every other key kept: `workflow:maker` when the project file says `form: compact`, else `workflow:assistant` (the workflow docs, "A project\'s chats open as its agent").',
    );
    expect(text).toContain(
      "`Opens as: the assistant, in every plain chat here (agent in .claude/settings.local.json, this machine's; another machine writes it at its first chat).`",
    );
    expect(text).toContain("`Opens as: <agent>, named in <file>; left as it is.`");
    expect(text).toContain(
      "`For a restructuring or a full copy edit, the full queue: remove form: compact, then claude --agent workflow:assistant and a brief for the planner.`",
    );
  });

  it("sets no agent itself", () => {
    expect(existsSync(new URL("../plugins/workflow/settings.json", import.meta.url))).toBe(false);
  });
});

// plans/owner-requests-nov-25.md: the owner's requests of 24 and 25 November as the plugin's rules.
describe("the agents keep an issue tidy, build a finished plan, act on named people's tasks and fix hiccups", () => {
  const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
  const read = (path: string) => readFileSync(join(plugin, path), "utf8");
  const flat = (path: string) => read(path).replace(/\s+/g, " ");
  const section = (path: string, heading: string) =>
    new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m")
      .exec(read(path))![1]
      .replace(/\s+/g, " ");

  it("an issue's description is written once and its plan is one collapsed comment, edited in place", () => {
    const github = flat("docs/github.md");
    expect(github).not.toContain("issue edit <n> --body-file");
    expect(github).not.toContain("--edit-last");
    const issues = section("docs/github.md", "GitHub issues");
    expect(issues).toContain(
      "The plan behind this: a collapsed comment below, once it is planned. Comment to poke holes or add what is missing; it is built as a draft pull request once planned, and a comment is taken in.",
    );
    expect(issues).toContain(
      "The body is written when the issue is made and no agent edits it after; a hand-opened issue's body is never edited.",
    );
    const plan = section("docs/github.md", "A plan with an `Issue` line");
    expect(plan).toContain("No body is written");
    expect(plan).not.toContain("issue edit <n> --body-file");
    expect(plan).toContain(
      "<!-- workflow: plan --> <details><summary>The whole plan: <the plan's title></summary>",
    );
    expect(plan).toContain(
      '--jq \'.[] | select(.user.type == "Bot") | select(.body | startswith("<!-- workflow: plan -->") or startswith("<details><summary>The whole plan")) | .id\'',
    );
    expect(plan).toContain(
      'plans gh api -X PATCH "repos/{owner}/{repo}/issues/comments/<id>" -F body=@plans/<topic>/plan-comment.md`; with several, the first is patched and the rest left.',
    );
    expect(plan).toContain("nobody else posts a plan or a brief on an issue.");
    expect(github).toContain(
      "For every agent: a plan or a brief quoted anywhere on GitHub, in an issue, a comment or a pull request, is inside `<details>` under a one-line summary, never open.",
    );
    expect(flat("docs/workflow.md")).toContain(
      "its body written once, when it is made, and never edited by an agent after; the plan behind it is one collapsed comment, the planner's, found again by its hidden first line and edited in place on a change",
    );
    expect(flat("docs/decisions.md")).toContain(
      "written once; the plan behind it is one collapsed comment, edited in place.** (Javi, 25 November)",
    );
  });

  // plans/issue-body-set-once-on-refused-upload.md, then plans/screenshots-by-owners-login.md
  it("an issue is made without its pictures when their upload fails", () => {
    const issues = section("docs/github.md", "GitHub issues");
    expect(issues).toContain(
      'A picture that does not go up posts nothing, and `plans gh` says why; the command is run once more without `--attach`, the file\'s picture lines replaced by the not-attached line, `Screenshots: not attached yet, kept in plans/<topic>/. <The cause.>` (landing.md, "The screenshots, when `--attach` fails", gives the cause), the `Check` run on the file again, since the cause is new text; the upload is not tried again.',
    );
    expect(issues).not.toContain("made anyway");
    expect(issues).not.toContain("read back");
    expect(section("docs/github.md", "A plan with an `Issue` line")).toContain(
      "the issue's was written once, when it was made, and a hand-opened issue keeps its own.",
    );
    const landing = flat("docs/landing.md");
    expect(landing).toContain(
      "through `plans gh`, a picture that did not go up means nothing was posted, and `plans gh` printed why (`Screenshots not uploaded, so nothing was posted: …`). Run the command once more without `--attach`, each picture's reference replaced by its alt text as a line of its own, and the line under `## To try it`: `Screenshots: not attached yet, kept in plans/<topic>/. <The cause.>`, the cause what `plans gh` printed between `nothing was posted: ` and `. Post it once more`, with a capital. The upload is tried no second time.",
    );
    expect(landing).toContain(
      'On an issue or its plan comment (github.md, "GitHub issues") the same, the line in place of the picture lines.',
    );
    expect(landing).not.toContain("set once, as it is made");
    expect(flat("docs/decisions.md")).toContain(
      "An issue is never made with a picture that did not go up (`screenshots-attach`), so its body is set once and no more.",
    );
    expect(flat("docs/decisions.md")).toContain(
      "~~Screenshots on a pull request or an issue go up through gh's `--attach`, as the project's app with Contents read and write.~~ (Javi, 25 November)",
    );
    expect(flat("agents/assistant.md")).toContain(
      "A `Screenshots not attached` line whose cause is the login gh has (none, ended, refused) is a step only he can take, told once with the cause as written;",
    );
  });

  // plans/screenshots-reach-github-follow-up.md
  it("an issue attaches its topic's pictures when made and when its plan comment is first posted", () => {
    const issues = section("docs/github.md", "GitHub issues");
    expect(issues).toContain("![<What it shows, in one line.>](./<file>)");
    expect(issues).toContain(
      'plans gh issue create --title "<the sentence>" --body-file plans/<topic>/issue.md --label "status: planning" --attach plans/<topic>/<file>`, the label left out for an issue alone, one `--attach` per picture the body references, so the issue opens with them shown.',
    );
    expect(issues).toContain(
      "`Screenshots: not attached yet, kept in plans/<topic>/. <The cause.>`",
    );
    expect(issues).toContain("the command is run once more without `--attach`");
    const plan = section("docs/github.md", "A plan with an `Issue` line");
    expect(plan).toContain("</details> ![<What it shows, in one line.>](./<file>) ```");
    expect(plan).toContain(
      "plans gh issue comment <n> --body-file plans/<topic>/plan-comment.md --attach plans/<topic>/<file>`, one `--attach` per picture the file references, so the comment shows them;",
    );
    expect(plan).toContain(
      'A patch keeps the images already in the comment: the file takes, in place of its local references, the image addresses GitHub gave the posted comment, read from its body (`plans gh api "repos/{owner}/{repo}/issues/comments/<id>" --jq .body`), each picture matched by its alt text as first written; a picture with no address there, new or never attached, is not attached on a patch, since `gh api` uploads nothing, and its path is named in the comment instead, the `Screenshots: not attached yet` line kept while any is.',
    );
    expect(issues).not.toContain("left as made");
    expect(issues).toContain("the upload is not tried again");
    expect(plan).toContain(
      'a picture that does not go up posts nothing, and the command is run once more without `--attach`, as the issue\'s is ("GitHub issues").',
    );
    const landing = flat("docs/landing.md");
    expect(landing).toContain("The upload is tried no second time.");
    expect(landing).not.toContain("issue edit <n> --body-file");
    expect(landing).not.toContain("left as made");
    expect(flat("docs/decisions.md")).toContain(
      "An issue attaches when it is made and when its plan comment is first posted; a patch of that comment keeps the addresses GitHub already gave its images",
    );
  });

  it("a held plan with an issue gets no Ready from step 3", () => {
    const plan = section("docs/github.md", "A plan with an `Issue` line");
    expect(plan.indexOf(" 4. ")).toBeGreaterThan(plan.indexOf(" 3. "));
    const step3 = plan.slice(plan.indexOf(" 3. "), plan.indexOf(" 4. "));
    expect(step3.startsWith(' 3. Without a `Held on` line in its "Decided",')).toBe(true);
    expect(step3.indexOf("Without a `Held on` line")).toBeLessThan(step3.indexOf("issue edit"));
    expect(step3.indexOf("Without a `Held on` line")).toBeLessThan(step3.indexOf("Ready section"));
  });

  it("a planned plan with an issue is made ready on the owner's standing word, unless he held it", () => {
    const plan = section("docs/github.md", "A plan with an `Issue` line");
    expect(plan).toContain(
      "3. Without a `Held on` line in its \"Decided\", `plans gh issue edit <n> --add-label \"status: ready\"` with a `--remove-label` for each other `status:` label the issue carries (`plans gh issue view <n> --json labels --jq '.labels[].name'`; a read that fails stops the step, its output said), so it keeps one `status:` label; once it has taken, write the plan's Ready section, on the owner's standing word, and hand the plan on with `plans start` as any other plan: ``` ## Ready, <date> Ready on <the owner>'s standing word, <d Month>. ```",
    );
    expect(plan).toContain(
      'A plan whose "Decided" carries `Held on <the owner>\'s word: <until what>.` gets no Ready section: `plans gh issue edit <n> --add-label "status: planned"` with a `--remove-label` for each other `status:` label the issue carries, read as in step 3, and it waits for "Ready on his word"; say the issue\'s address and what it waits for, and a `status: ready` the edit took off, since a writer\'s may have been meant as the release.',
    );
    expect(section("docs/github.md", "GitHub issues")).toContain(
      "only when he said to hold that one; never ask whether to.",
    );
    expect(flat("agents/planner.md")).toContain(
      "Such a plan is started like any other once its Ready section is written; a held one waits, and the message says the issue's address and what it waits for.",
    );
    expect(flat("agents/planner.md")).not.toContain("waits for `status: ready`");
    expect(flat("agents/assistant.md")).not.toContain("waits for your word to build");
    expect(flat("docs/workflow.md")).toContain(
      "**A plan with an issue is built once planned**: the planner writes its Ready section on the owner's standing word",
    );
    expect(flat("docs/decisions.md")).toContain(
      "- `ready-before-built` **A plan with an issue is built once it is planned, on the owner's standing word, unless he said to hold that one;",
    );
  });

  it("a named person's clear task on GitHub is acted on without the owner", () => {
    const reaches = section("docs/github.md", "What reaches you from GitHub");
    expect(reaches).toContain(
      "a task or a change from a person **People** names, by the GitHub login it gives them, or by name where it gives none: when it is clear and not the owner's call, act on it without him.",
    );
    expect(reaches).toContain(
      "`Lands: topic <the head branch>; lands in #<n> as its fix.` for a fault in what it added, else the line `plans full <n> plans/<x>.md` gives",
    );
    expect(reaches).toContain(
      "Reply once, as the app, only when they would otherwise not know it was taken: `On it: <what will change, in a line>.`",
    );
    expect(reaches).toContain(
      "the reversal of a rule with his or a third person's name, a direction beyond the issue's or pull request's topic, a merge, a production push, money or a secret;",
    );
    expect(reaches).toContain("a change from a writer **People** does not name");
    expect(reaches).toContain(
      "The comment of a person **People** gives a login in backticks reaches you wherever they wrote it, on an issue no plan carries and on another person's pull request too: there, act only on a clear task or a question put to the queue; talk between people gets no reply and no question to the owner, and its Handled line says so.",
    );
    const docs = flat("docs/workflow.md");
    expect(docs).toContain(
      "**People** (whose calls are theirs, what each decides, and each one's GitHub login in backticks, whose clear tasks on GitHub the queue acts on wherever they write them)",
    );
    expect(docs).toContain(
      "a comment from a person **People** names by login is an event on any issue or pull request, another writer's only where it mentions the app, on an issue a plan carries or on one of the queue's own pull requests; a failed run and a merge arrive the same way",
    );
    expect(docs).toContain("decisions.md#people-act-on-github)");
    const decisions = flat("docs/decisions.md");
    expect(decisions).toContain(
      "- `people-act-on-github` **A clear task from a person the project names, in an issue or a pull request, is acted on without the owner.** (Javi, 25 November)",
    );
    expect(decisions).toContain(
      "Their comments are events wherever they are written, an issue no plan carries and another person's pull request too, by the login **People** gives in backticks, as Prow reads its people from the repository's OWNERS file and acts on their comments on any pull request; no mention is asked of them, since his ask was the task and not a way of writing it; write access is still required, and what is no task there gets no reply, so the app stays out of talk between people. plans/owner-requests-nov-25.md and plans/people-comments-reach-the-queue.md.",
    );
  });

  it("the assistant fixes a hiccup without asking or telling", () => {
    const assistant = flat("agents/assistant.md");
    expect(assistant).not.toContain("else ask once, saying what it holds");
    expect(assistant).toContain(
      '`plans end <id> --now` for a chat ${user_config.owner} names, or on your own for one that is stuck, stale or holds a plan the queue gave to another ("Hiccups")',
    );
    const hiccups = section("agents/assistant.md", "Hiccups");
    expect(hiccups).toContain("ask nothing and tell him nothing.");
    expect(hiccups).toContain(
      "Try the same fix twice at most for one fault; one still there is a failure you tell him, with what was tried.",
    );
    expect(hiccups).toContain(
      "Never this way: `plans start --owner-said`, a merge, a forced push, a production push.",
    );
    const order = read("agents/assistant.md");
    expect(order.indexOf("## Hiccups")).toBeGreaterThan(order.indexOf("## Decisions taken"));
    expect(section("agents/assistant.md", "What you tell him unasked")).toContain(
      "a failure, one that changes the product, needs his call or needs a step only he can take",
    );
    expect(section("agents/assistant.md", "Staying ready")).toContain(
      'a fault its line names you fix by "Hiccups", and tell him only when it is still there after its fixes.',
    );
    const docs = flat("docs/workflow.md");
    expect(docs).toContain(
      "the assistant runs it on the owner's word, or its own for a chat that is stuck. (decisions.md#end-now)",
    );
    expect(docs).toMatch(
      /\*\*A hiccup is fixed, not asked about\*\*[^*]*\(decisions\.md#hiccups-fixed\)/,
    );
    expect(flat("docs/decisions.md")).toContain(
      "- `hiccups-fixed` **A hiccup of the queue is fixed by whatever works, never asked about or reported.** (Javi, 25 November)",
    );
  });

  // plans/merge-close-retried.md, parts 3 and 4.
  it("an issue a merge did not close is noted for the assistant, which closes it or says so", () => {
    const reaches = section("docs/github.md", "What reaches you from GitHub");
    expect(reaches).toContain(
      "- `unclosed`, an issue a merged pull request's description closes that the queue could not close (a number that is a pull request is left open, and noted nowhere): its line names the issue, the line under it the cause. A hiccup (\"Hiccups\"). Read `plans gh issue view <i> --json state,url,comments --jq '.state, .url, .comments[-1].body'`: `CLOSED`, nothing more; an address with `/pull/` is a pull request's, never closed this way, told as below. An open issue, `plans gh issue close <i> --reason completed --comment \"Merged as #<m>.\"`, without `--comment` when the last comment already says it, twice at most. One still open then, a number that is no issue here or is a pull request's, or a cause that is his step (no app here, a permission the app lacks) is a failure you tell him: `#<i> was not closed when #<m> merged: <the cause>.`;",
    );
    expect(reaches).toContain(
      "Then write `## Handled, <date>, session <id>` with a line of what you did, for `failed` which of the four, for `unclosed` closed or told.",
    );
    expect(section("agents/assistant.md", "Hiccups")).toContain(
      'A stuck or stale executor, a plan the queue leased wrongly, a run that fails on what the diff does not explain, a refused upload, an issue a merge did not close: do what works (`plans end <id> --now`, `plans start <path>`, the command again; a failed run as `failed` in "What reaches you from GitHub" says, rerun once or refreshed, an issue not closed as `unclosed` says there), ask nothing and tell him nothing.',
    );
    const docs = flat("docs/workflow.md");
    expect(docs).toContain(
      "a run that fails on what the diff does not explain, a refused upload or an issue a merge did not close is fixed by the assistant by whatever works",
    );
    expect(docs).toContain(
      "closes each issue a merged pull request's description closes; a close that fails is noted for the assistant, as a failed run is;",
    );
    expect(flat("docs/decisions.md")).toContain(
      "A close that fails is noted for the assistant, which closes the issue by hand as any hiccup, twice at most, and tells him of one still open: nothing tried it again, and its one line was printed where nobody reads. The queue itself tries once, since gh posts the `Merged as` comment before it closes and a blind second try would post it twice. A number that is a pull request is left open, since gh closes a pull request given its number and a typo or a person's own line would close somebody's. A `Closes` line in an HTML comment or a fence is not read, since the description does not show it, and lines ending in CRLF, as GitHub's web editor can save them, are read as any. A comment and a fence are told as GitHub's page tells them, by CommonMark's HTML blocks, raw HTML and fenced code, each case checked on GitHub's own renderer: a `<!--` first on its line hides every line up to the one holding `-->`; one further along a line hides only what its own paragraph closes, and is plain text when the paragraph ends first, so a sentence that mentions `<!--` hides nothing below it; a fence closes at its mark alone on a line. Known limits, each a description GitHub's page already shows cut short or one no template writes: where GitHub finds a comment unclosed and hides the rest of the description (a second `<!--` after a comment's close on its line, a comment that outlasts its list item or block quote, a `<!--` inside `<details>` or another HTML block), the reading goes on from the next `-->`, or, for one further along a line of an HTML block, as past plain text; and code indented inside a list item is read as the item's text, so a `<!--` first on such a line hides what follows. plans/prs-close-their-issues.md, plans/merge-close-retried.md, plans/merge-closes-no-pull-request.md, plans/closes-skips-comments-and-crlf.md and plans/closes-reads-comments-as-github.md.",
    );
  });

  it("a question names no choice by its place and never asks to hold", () => {
    const docs = flat("docs/workflow.md");
    expect(docs).toContain(
      'A choice is named by what he gets, never by its place ("the first option") or by an earlier message he may not have in front of him; and no question asks whether to hold work, since work goes on unless he said to hold it.',
    );
    expect(docs).toContain(
      "`scripts/plain-words.mjs` refuses a question that names code, is one sentence or names a choice by its place.",
    );
    expect(flat("docs/decisions.md")).toContain(
      "A choice named by its place sent him back to a chat he did not have (Javi, 25 November).",
    );
    expect(read("scripts/plain-words.mjs")).toContain(
      'refers to a choice by its place ("${placed}")',
    );
  });
});

// plans/one-assistant-after-handover.md, part 5.
describe("one assistant chat is live after a hand-over", () => {
  const plugin = new URL("../plugins/workflow/", import.meta.url).pathname;
  const read = (path: string) => readFileSync(join(plugin, path), "utf8").replace(/\s+/g, " ");

  it("the handbook, the assistant's file and the catalogue say so", () => {
    const handbook = read("docs/workflow.md");
    expect(handbook).toContain(
      "One assistant chat is live: the fresh one is started first and the handed-on one stopped once the fresh one is listed, or, when another is open already, as soon as it is quiet, the queue trying again every ten minutes until one is open and the old one stopped; a chat with no process is not open, so one is opened beside its row; none is opened while `claude agents` cannot be read; what the queue sends goes to the chat started last that is not handed on; and `plans end <id> --now` ends one he names.",
    );
    expect(handbook).toContain(
      "starts a fresh session on it; an assistant chat named is stopped with nothing started in its place;",
    );
    const assistant = read("agents/assistant.md");
    expect(assistant).toContain(
      "and the paths of the plans in the queue; then `CronDelete` the heartbeat's job and stop.",
    );
    expect(assistant).toContain(
      "which then sets the heartbeat again by 1 when work is under way. The queue stops this chat then, or as soon as another assistant chat is open; `plans end <id> --now` ends one ${user_config.owner} names.",
    );
    expect(assistant).toContain(
      "and go on from it, setting the heartbeat by 1 when work is under way.",
    );
    expect(assistant).toContain(
      "his message meanwhile keeps this one, which then sets the heartbeat again by 1 when work is under way.",
    );
    const decisions = read("docs/decisions.md");
    expect(decisions).toContain(
      "Three chats of the name were once live for hours: the takeover's timer tried once and gave up while a question stood, a second chat was opened while `claude agents` could not be read, and the old one, never stopped, kept the webhook's notes.",
    );
    expect(decisions).toContain(
      "So the takeover is tried every ten minutes until the handed-on chat is stopped, with no fresh start when another is open, quiet read from the process's own status; none is opened on a list that cannot be read; and what the queue sends goes to the chat started last that is not handed on.",
    );
    // plans/assistant-takeover-never-leaves-none.md, part 5.
    expect(decisions).toContain(
      "A takeover that stopped the old chat first left him with none when the fresh one's launch failed, and the launch was confirmed by the stopped chat's own row, which stays listed under the name for weeks.",
    );
    expect(decisions).toContain(
      "So the fresh chat is started first, confirmed by a session not listed before, and the old one is stopped once it is, as a rolling update brings the new copy up before it takes the old one down; and a chat with no process is not open, since it takes no message: one is opened beside its row.",
    );
    expect(decisions).toContain(
      "An assistant chat he names is ended the same way, with nothing started in its place: archiving it stopped nothing.",
    );
    // plans/assistant-chat-counts-live-rows.md.
    expect(handbook).toContain(
      "A handed-on chat is not open to a takeover, so two handed on at once are replaced by one fresh chat.",
    );
    expect(decisions).toContain(
      "a handed-on chat is on its way out, so it is not open to a takeover, and one fresh chat replaces both. A stopped row beside the live chat made its name shared, so a note waited; only rows with a process share it.",
    );
    expect(decisions).toContain(
      "addressed by the chat's process, the one started last that is not handed on:",
    );
  });
});
