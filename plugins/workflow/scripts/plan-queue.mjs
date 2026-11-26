#!/usr/bin/env node
// The plan queue, and the hooks that carry plans from the planner to the
// executor (docs/workflow.md, "The queue"):
//
//   plan-queue.mjs list      `plans`: the plans written, being built, built
//                            and waiting, read from the files
//   plan-queue.mjs prompt    on UserPromptSubmit: an executor takes the lock,
//                            or is refused while another holds it; the queue
//                            goes into the context
//   plan-queue.mjs tool      on PreToolUse: refuses an executor's edit or
//                            writing command while another executor holds
//                            the lock, or after retiring, and its Building
//                            line on a plan still asking; a planner's edit to
//                            a taken plan; a planner's question records its
//                            time and defers a start of the plan it asks about
//   plan-queue.mjs stop      on Stop: the project's run on the push, or the
//                            checks on its pull requests, then the waiting
//                            plans (built here while the context is fresh,
//                            or a fresh executor started when tired)
//   plan-queue.mjs wrote     on PostToolUse (Edit, Write, Bash): an executor's
//                            Building line stops the retired planner of it;
//                            one a shell wrote on a plan still asking is
//                            taken out again
//   plan-queue.mjs cutoff    on StopFailure (rate_limit): hands the plan over
//                            and starts its resumption at the window's reset
//   plan-queue.mjs start     `plans start`: the one thing that starts
//                            executors and planners, within the bounds below
//   plan-queue.mjs end       `plans end`: ends this queue's finished chats; with
//                            --timer, the end timer each stop arms an hour on
//   plan-queue.mjs hold      `plans hold`: a heavy step run when a slot of
//                            its resource is free (decisions.md#resource-slots)
//   plan-queue.mjs pause | resume | sync | init
//   plan-queue.mjs help      the usage, on stdout; any other word: named on
//                            stderr with the usage, exit 2
//
// **Bounded, as every loop over model calls is**: as many executors at a time as the project says
// (the lock); no start without usage headroom, deferred to the window's
// reset instead; no start after one that died within ten minutes for
// another reason; no start once the last five of a kind ended with nothing
// done, until the owner says to start one; a pause switch.
// The assistant chat is a Remote Control chat; planners and executors are
// background chats `plans` lists, so none runs unwatched. No model call here; a hook that fails does nothing, which is
// the behavior without it. Session state lives in the OS temp directory;
// the lock, the pause and the deferral in the project's `.claude/` (ignored
// by git); the usage numbers and the starts' log in the plugin's data
// directory.
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { connect } from "node:net";
import { constants, homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { agentsChoice, catalogueFiles, paragraphs, shellWrites, untiered } from "./turn-audit.mjs";
import { locations } from "./catalogue-context.mjs";
import {
  appLacks,
  appSlug,
  appStanding,
  installationToken,
  repoOfRemote,
  repositoryId,
} from "./github-app.mjs";
import {
  attachWords,
  notUploaded,
  ownerToken,
  uploadAsset,
  withAddresses,
} from "./github-attach.mjs";
import {
  FAILED_CONCLUSIONS,
  NOTHING_SEEN,
  WEBHOOK_EVENTS,
  githubEvents,
  itemsOfDelivery,
  labelsOf,
  listen,
  noteFor,
} from "./github-webhook.mjs";
import {
  PROJECT_FILE,
  QUEUE_KINDS,
  checkoutOf,
  compiles,
  connectorAlone,
  couldNameMcp,
  everyTool,
  executorsOf,
  ignoreQueueFiles,
  init,
  kindOf,
  machine,
  owner,
  ownerReads,
  pluginAgents,
  project,
  REUSE_DEFAULT,
  RESOURCE_NAME,
  sessionAgent,
  slotsWritten,
} from "./project.mjs";
import { costWords, inputsOf, measure, measureFile, priceOf } from "./cost.mjs";
import { briefPaths, noteSeen, seenIn, seenOf } from "./seen.mjs";

export { machine, owner };

/** The modes Claude Code runs as hooks, from `hooks/hooks.json`. */
const HOOK_MODES = ["prompt", "tool", "stop", "wrote", "cutoff", "session"];

/**
 * The project: for a hook, `CLAUDE_PROJECT_DIR`, which Claude Code sets for
 * it; for the command, the repository it is run in (`bin/plans` sets
 * `WORKFLOW_ROOT`, since the Bash tool may carry another project's
 * `CLAUDE_PROJECT_DIR`, so `cd <checkout> && plans start` acts there). The
 * processes the command spawns inherit the environment, and with it the root;
 * a hook never reads `WORKFLOW_ROOT`. **The queue never moves**
 * (decisions.md#executors-in-worktrees): from an executor's worktree it is
 * the checkout's, so the plans, the lock, the pause and the project file are
 * in one place.
 */
const root = checkoutOf(
  (hookRun() ? "" : process.env.WORKFLOW_ROOT) || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
);
const here = dirname(fileURLToPath(import.meta.url));

/**
 * **The plugin's data directory**, kept across updates: from the script's own
 * path when run from the cache (`<plugins>/cache/<marketplace>/<plugin>/
 * <version>/scripts` gives `<plugins>/data/<plugin>-<marketplace>`); else the
 * default for this plugin. `WORKFLOW_DATA` for the tests. Never
 * `CLAUDE_PLUGIN_DATA`: in a Bash call, and in a session started from one, it
 * names whichever plugin exported it last.
 */
export function data(env = process.env, scriptDir = here) {
  if (env.WORKFLOW_DATA) return env.WORKFLOW_DATA;
  const cached = /^(.*)[\\/]cache[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/][^\\/]+[\\/]scripts$/.exec(
    scriptDir,
  );
  if (cached) return join(cached[1], "data", `${cached[3]}-${cached[2]}`);
  return join(homedir(), ".claude", "plugins", "data", "workflow-workflow");
}

/** The project's part, read once per process. */
let projectRead = null;
function proj() {
  projectRead ??= project(root);
  return projectRead;
}
const branch = () => proj().branch;

/** Plans dated before this are built by path only. */
const QUEUE_SINCE = Date.UTC(2026, 9, 24);
/** No executor starts above these (percent of each window): 80 is lenient, since a plan cut off is resumed at the reset; the seven-day reset can be days away. */
const FIVE_HOUR_MAX = 80;
const SEVEN_DAY_MAX = 95;
const MINUTE = 60_000;
/** How often a listener whose app sends no failed run reads them itself. */
const APP_RECHECK = 5 * MINUTE;
const QUICK_DEATH = 10 * MINUTE;
const USAGE_STALE = 30 * MINUTE;
// **Five starts of a kind in a row with nothing done is a loop**
// (decisions.md#starts-bounded): systemd's start burst, the failures a
// circuit breaker counts before it opens.
const LOOP_RUN = 5;
const MAX_HANDOVERS = 6;
/** Seconds after a window's reset that a deferred start runs. */
const AFTER_RESET = 120;

const files = {
  // One lock per executor number, held by the session in that number's
  // worktree.
  lock: (n = 1) => join(root, ".claude", `executor.${n}.lock`),
  // The plans named to an executor and not yet taken.
  claims: () => join(root, ".claude", "executor.claims.json"),
  pause: () => join(root, ".claude", "executor.pause"),
  // A hook starting an executor on ready plans (`startOnReady`), so two at one
  // moment start one.
  starting: () => join(root, ".claude", "executor.starting"),
  // One deferral per kind, so a planner's never drops an executor's; the
  // thirty minutes of "Asked once" have their own (`asking`), so a question
  // never moves a usage limit's restart.
  deferred: (kind = "executor") => join(root, ".claude", `${kind}.deferred`),
  usage: () => process.env.WORKFLOW_USAGE_FILE || join(data(), "usage.json"),
  starts: () => process.env.WORKFLOW_STARTS_LOG || join(data(), "starts.log"),
  // The names starts hold from their numbering until they are logged, beside
  // the log, so for every checkout and kind: `{ "<name>": { pid, at } }`
  // (`holdName`, plans/overlapping-starts-own-names.md).
  names: () => `${files.starts()}.names.json`,
  state: (sessionId) => join(tmpdir(), `workflow-queue-${sessionId || "unknown"}.json`),
  // The project's app's installation token and its end.
  appToken: () => join(root, ".claude", "app-token.json"),
  // What GitHub's webhook brought, and what was made of it
  // (decisions.md#github-webhook).
  githubSeen: () => join(root, ".claude", "github-seen.json"),
  // One read of GitHub at a time: its process's pid.
  githubGuard: () => join(root, ".claude", "github-seen.guard"),
  githubInbox: () => join(root, ".claude", "github-inbox"),
  webhook: () => join(root, ".claude", "webhook.json"),
  // When the listener last heard GitHub and was last alive, which no start
  // removes, so a restart keeps them.
  webhookLast: () => join(root, ".claude", "webhook.last.json"),
  // The notes an open assistant chat was sent (decisions.md#note-sent-to-open-chat).
  githubTold: () => join(root, ".claude", "github-told.json"),
  // What the owner was told of an app that sends no failed run.
  webhookTold: () => join(root, ".claude", "webhook.told.json"),
  // The refresh plans the owner's own assistant chat was told of
  // (decisions.md#merge-refreshes-the-rest).
  refreshesTold: () => join(root, ".claude", "refreshes.told.json"),
  // The hand-over file's time when last recorded, the session that wrote it
  // and the one told of it (decisions.md#one-chat).
  handoverTold: () => join(root, ".claude", "handover.told.json"),
};

/** What `plans` says, and `plans start` refuses with, in a project with no project file. */
const NO_PROJECT = `No ${PROJECT_FILE} here: plans init writes one.`;
/** What `plans` says, and `plans start` refuses with, in a project in the compact form. */
const COMPACT =
  "This project is in the compact form (form: compact): one chat decides and builds, and there is no queue.";

const MONTHS =
  "January February March April May June July August September October November December".split(
    " ",
  );

/**
 * A plan's day as a UTC day, or NaN: also for a day the calendar does not
 * have, the 31st of February, which `Date.UTC` would roll over into March
 * (decisions.md#plan-put-first).
 */
export function parseDay(text) {
  // "26 October 2026", as the plans and `today()` write it, or "2026-10-26",
  // as an agent or a person may.
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  const m = iso ? null : /^(\d{1,2}) ([A-Z][a-z]+) (\d{4})$/.exec(text.trim());
  if (!iso && !m) return NaN;
  const [year, month, day] = iso
    ? [Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])]
    : [Number(m[3]), MONTHS.indexOf(m[2]), Number(m[1])];
  if (month < 0 || month > 11) return NaN;
  const at = Date.UTC(year, month, day);
  const back = new Date(at);
  return back.getUTCMonth() === month && back.getUTCDate() === day ? at : NaN;
}

/** A plan's or brief's day in either spelling `parseDay` reads. */
const DAY = "\\d{1,2} [A-Z][a-z]+ \\d{4}|\\d{4}-\\d{2}-\\d{2}";
/** A day, in milliseconds: how old a per-session temp file must be to be swept. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** A day as the queue's lines say it within the year: the day and the month. */
function dayMonth(at) {
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** Today as the plans write it: "24 October 2026". */
export function today(now = Date.now()) {
  const d = new Date(now);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function sectionAfter(text, heading) {
  const at = text.search(heading);
  if (at < 0) return "";
  const rest = text.slice(at);
  const next = rest.slice(1).search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/**
 * The states a plan still asking its owner can be in: a planned plan
 * asks as a ready one does, and its question's window is recorded the
 * same way.
 */
const ASKS_STATES = ["ready", "planned"];
/** The states of a file that waits, whose `First` line counts (decisions.md#plan-put-first). */
const WAITING_STATES = ["brief", "planning", "ready", "planned", "handed"];

/** The queue's own status lines, dated, never a plan's "## Building it" section. */
const STATUS_HEADING = /^## (?:Planning, |Building, |Resumed, |Handing over\b)/;
/** A plan's dated header line, as `stateOf` reads it: its kind and its day. */
const PLAN_HEADER = new RegExp(`^(Plan only|Short plan), (${DAY})`, "m");
/** A brief's line, and its day when it has one. */
const BRIEF_HEADER = new RegExp(`^Brief for the planner\\b(?:, (${DAY}))?`, "m");
/**
 * A plan's dated header line or a brief's line: where a status section above
 * it ends. Dated, so a body line that only starts with the words does not end it.
 */
const HEADER_LINE = new RegExp(`${PLAN_HEADER.source}|${BRIEF_HEADER.source}`);

/**
 * **A plan's text without the queue's status sections**
 * (decisions.md#plan-state-in-file): each Planning, Building, Resumed or
 * Handing over line with its body, up to the next `## ` or the header line. A
 * hand-over written between the title and the header pushed the header past
 * the lines `stateOf` reads, and the plan fell out of every list.
 */
export function withoutStatus(text) {
  const kept = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    if (STATUS_HEADING.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && (/^## /.test(line) || HEADER_LINE.test(line))) skipping = false;
    if (!skipping) kept.push(line);
  }
  return kept.join("\n");
}

/**
 * **Where a plan lands**, from its `Lands` line
 * (decisions.md#land-by-pull-request): `{ kind: "fix", now }`, `{ kind:
 * "refresh" }` (decisions.md#merge-refreshes-the-rest, the assistant's plan
 * after a merge) or `{ kind: "topic", name }`, read from the text before the
 * plan's first `## ` heading, past its status sections; null with none, as a
 * plan in the push mode or an older plan has. A topic's line may say after its
 * name the pull request it lands in or is stacked on, `; lands in #52` or `;
 * stacked on #52`, where agents write it: `into` or `stackedOn`, beside the
 * topic, so an agent's placement does not change where the queue thinks the
 * plan lands. `, waiting` and `, ready` after the name were a topic's marks
 * until 26 November 2026 (decisions.md#topic-landing): still read, so every
 * older plan's topic is, and they mean nothing.
 */
export function landsOf(text = "") {
  // Hand-wrapped prose: the line may wrap anywhere a space is.
  const m =
    /^Lands:\s+(?:fix(,\s+now)?|(refresh)|topic\s+([a-z0-9]+(?:-[a-z0-9]+)*)(?:,\s+(?:waiting|ready))?(?:;\s+(lands\s+in|stacked\s+on)\s+#(\d+))?)\.?[ \t]*$/m.exec(
      headOf(text),
    );
  if (!m) return null;
  if (m[2]) return { kind: "refresh" };
  if (m[3]) {
    const lands = { kind: "topic", name: m[3] };
    if (m[4]) lands[/^lands/.test(m[4]) ? "into" : "stackedOn"] = Number(m[5]);
    return lands;
  }
  return { kind: "fix", now: Boolean(m[1]) };
}

/**
 * A plan's text before its first `## ` heading, past its status sections and
 * outside a fenced block, so a quoted example is not the plan's.
 */
function headOf(text) {
  const lines = withoutStatus(text).split("\n");
  const end = lines.findIndex((line) => /^## /.test(line));
  return withoutFences((end < 0 ? lines : lines.slice(0, end)).join("\n"));
}

/**
 * **A Lands line the queue cannot read is said**: a line starting `Lands:`
 * where `landsOf` looks that `landsOf` does not read, so the plan is not taken
 * for a topic named for its file without a word.
 */
export function landsUnread(text = "") {
  return /^Lands:/m.test(headOf(text)) && !landsOf(text);
}

/**
 * **A plan or a brief the owner put first** (decisions.md#plan-put-first),
 * its `First: 13 November 2026 15:42:07.` line, read as `landsOf` reads `Lands`: the day in either spelling `parseDay` reads,
 * then optionally a time, `hh:mm` or `hh:mm:ss`, a comma before it or not, the
 * full stop optional. `{ day, time, at }`, `time` as `hh:mm` or "" and `at` the
 * day and the time in milliseconds, the order two marks are put in; null with
 * none.
 */
export function firstOf(text = "") {
  const m = new RegExp(
    `^First:[ \\t]+(${DAY}),?(?:[ \\t]+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?\\.?[ \\t]*$`,
    "m",
  ).exec(firstHead(text));
  if (!m) return null;
  const date = parseDay(m[1]);
  if (Number.isNaN(date)) return null;
  const [hours, minutes, seconds] = [m[2], m[3], m[4]].map((part) => Number(part || 0));
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  const time = m[2] ? `${String(hours).padStart(2, "0")}:${m[3]}` : "";
  return { day: m[1], time, at: date + ((hours * 60 + minutes) * 60 + seconds) * 1000 };
}

/**
 * **A row put first, in words** (decisions.md#plan-put-first): `first since
 * <d Month> <hh:mm>`, the day without its year, the time when the line has
 * one; "" for a plan not put first. The rows of `plans`, the Stop hook's
 * line and the tool hook's refusal say it so.
 */
function firstWords(plan) {
  const first = plan?.first;
  if (!first) return "";
  const at = new Date(parseDay(first.day));
  const day = `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
  return `first since ${day}${first.time ? ` ${first.time}` : ""}`;
}

/** A `First:` line where `firstOf` looks that `firstOf` does not read, said by `plans`. */
export function firstUnread(text = "") {
  return /^First:/m.test(firstHead(text)) && !firstOf(text);
}

/**
 * Where a `First` line is read: the text before the first heading that is not
 * one of the queue's status lines, outside fences, the status sections
 * included, since a hand-over or a Planning line written under the header
 * lands above the line. The fences go first, so a heading in an example in
 * one of those sections does not end the text.
 */
function firstHead(text) {
  const lines = text.split("\n");
  const end = headEndAt(lines);
  return withoutFences((end < 0 ? lines : lines.slice(0, end)).join("\n"));
}

/** The index of the line that ends a `First` line's text: the first heading outside fences that is not a status line; -1 with none. */
function headEndAt(lines) {
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const inside = fence;
    fence = fenceAfter(fence, lines[i]);
    if (!inside && !fence && /^## /.test(lines[i]) && !STATUS_HEADING.test(lines[i])) return i;
  }
  return -1;
}

/** A `First` line `plans first` replaces: one with a day, read or not; prose that starts with the word stays. */
const FIRST_MARK = new RegExp(`^First:[ \\t]+(?:${DAY})`);

/**
 * One item of a `Related` line: `#<n>`, or `branch <name>`: a topic's name, or
 * another person's branch in Git's shape (`fix/pictures`, `v1.2`), a dot only
 * inside it, so the line's full stop is not the name's.
 */
const RELATED_ITEM = "(?:#\\d+|branch\\s+[\\w-]+(?:[/.][\\w-]+)*)";

/**
 * **What the author marked a plan or a brief related to**, from its `Related`
 * line: `Related: #31.`, `Related: #31 and branch outside-pictures-kept.`,
 * read as `landsOf` reads `Lands`, from the text before the first `## `, past
 * the status sections and outside a fenced block; a list of `{ kind: "pull",
 * number }` and `{ kind: "branch", name }`, or null with none.
 */
export function relatedOf(text = "") {
  const head = headOf(text);
  const m = new RegExp(
    `^Related:[ \\t]+(${RELATED_ITEM}(?:(?:,\\s+and\\s+|,\\s+|\\s+and\\s+)${RELATED_ITEM})*)\\.?[ \\t]*$`,
    "m",
  ).exec(head);
  if (!m) return null;
  return [...m[1].matchAll(new RegExp(RELATED_ITEM, "g"))].map(([item]) =>
    item.startsWith("#")
      ? { kind: "pull", number: Number(item.slice(1)) }
      : { kind: "branch", name: item.replace(/^branch\s+/, "") },
  );
}

/**
 * A project's name in a `From` line or a `For` heading: anything up to the
 * line's delimiter, as a project file's `name` or a directory's may be
 * (`my_docs`), never a comma, a colon or a line break.
 */
const PROJECT_WORDS = "[^\\s,:][^\\n,:]*?";

/**
 * **Where a brief from `/workflow:change` came from**, its `From: <Project>,
 * <path>.` line (decisions.md#leave-back-as-brief): read as `landsOf` reads
 * `Lands`, from the text before the first `## `, past the status sections and
 * outside a fenced block; the path absolute, the full stop optional, the line
 * wrapped at the comma or not. `{ project, path }`, or null with none.
 */
export function fromOf(text = "") {
  const head = headOf(text);
  // The path runs to the line's end, spaces and all (`/Users/j/My Projects/docs`).
  const m = new RegExp(`^From:[ \\t]+(${PROJECT_WORDS}),\\s+(\\/[^\\n]*?)\\.?[ \\t]*$`, "mu").exec(
    head,
  );
  return m ? { project: m[1].trim(), path: m[2] } : null;
}

/**
 * **The GitHub issue a brief or a plan is the plan behind**, its `Issue:
 * #<n>.` line: read as `fromOf` reads `From`, from the text before the
 * first `## `, past the status sections and outside a fenced block; the
 * number, 0 with none.
 */
export function issueOf(text = "") {
  return Number(/^Issue:[ \t]+#(\d+)\.?[ \t]*$/m.exec(headOf(text))?.[1] || 0);
}

/**
 * **A plan's `## Ready, <date>` section**, outside a fenced block: `{
 * readyDay, by, lines }`, `by` "github" for `Ready on GitHub, <d Month>.`,
 * "owner" for `Ready on <owner>'s word, <d Month>.`, "" for another first
 * line, and `lines` the decisions the comments made, one per line; null with
 * none.
 */
export function readyOf(text = "") {
  if (!/^## Ready, /m.test(text)) return null;
  const prose = withoutFences(text);
  const heading = new RegExp(`^## Ready, (${DAY})[ \\t]*$`, "m").exec(prose);
  if (!heading) return null;
  const body = prose.slice(heading.index + heading[0].length);
  const end = body.search(/^## /m);
  const lines = (end < 0 ? body : body.slice(0, end))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const first = lines[0] || "";
  const by = /^Ready on GitHub\b/.test(first)
    ? "github"
    : /^Ready on [^\n]*['\u2019]s word\b/.test(first)
      ? "owner"
      : "";
  return { readyDay: heading[1], by, lines: by ? lines.slice(1) : lines };
}

/**
 * **The briefs a plan carries to the project it came from**, its `## For
 * <Project>: plans/<topic>.md` sections outside fenced blocks
 * (decisions.md#leave-back-as-brief): `[{ project, file }]`, the file as
 * written; `[]` with none.
 */
export function carriesOf(text = "") {
  const heading = new RegExp(`^## For (${PROJECT_WORDS}): (plans\\/[^\\s/]+\\.md)[ \\t]*$`, "gmu");
  return [...withoutFences(text).matchAll(heading)].map((m) => ({
    project: m[1].trim(),
    file: m[2],
  }));
}

/** A `Related` line's items in words, for a Ready row: "#31 and branch a-b"; "" with none. */
function relatedWords(related) {
  if (!related?.length) return "";
  return andList(
    related.map((one) => (one.kind === "pull" ? `#${one.number}` : `branch ${one.name}`)),
  );
}

/**
 * A text without its fenced blocks, backticks or tildes, three or more, the
 * closing fence of the same character and at least as long (CommonMark), so
 * a plan that shows a section in an example does not read as having it.
 */
function withoutFences(text = "") {
  const kept = [];
  let fence = null;
  for (const line of text.split("\n")) {
    const inside = fence;
    fence = fenceAfter(fence, line);
    if (!inside && !fence) kept.push(line);
  }
  return kept.join("\n");
}

/**
 * The fence open after `line`, `fence` the one open before it, by
 * `withoutFences`'s rules, which every reader of fences shares, so the line
 * `plans first --undo` takes out is the one `firstOf` reads.
 */
function fenceAfter(fence, line) {
  const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
  if (!fence) return mark || null;
  const closes =
    mark &&
    mark[0] === fence[0] &&
    mark.length >= fence.length &&
    !line.trim().slice(mark.length).trim();
  return closes ? null : fence;
}

/**
 * **A plan or a brief dropped on the owner's word**
 * (decisions.md#plan-state-in-file): its `## Dropped, <date>` section,
 * outside a fenced block, as `{ droppedDay, why }`, the why its first
 * paragraph with the `Dropped on <owner>'s word: ` lead-in and the full
 * stop taken off; null with none.
 */
function droppedOf(text = "") {
  if (!/^## Dropped/m.test(text)) return null;
  const prose = withoutFences(text);
  const heading = /^## Dropped(?:, ([^\n]+?))?[ \t]*$/m.exec(prose);
  if (!heading) return null;
  const body = prose.slice(heading.index + heading[0].length);
  const end = body.search(/^## /m);
  const paragraph = (end < 0 ? body : body.slice(0, end)).trim().split(/\n\s*\n/)[0] || "";
  const why = paragraph
    .replace(/\s+/g, " ")
    .replace(/^Dropped on [^:]*'s word:\s*/, "")
    .replace(/\.$/, "");
  return { droppedDay: (heading[1] || "").trim(), why };
}

/** A plan's Built section, with what its heading says after the comma. */
const BUILT_DAY = /^## Built(?:, ([^\n]+))?/m;
/** Whether a plan has a Built section: its heading alone or with a date, never "## Builtin". */
const BUILT_SECTION = /^## Built(?:,|\s*$)/m;

/**
 * **A Building or Planning line names its session by its id or a unique
 * start of it** (decisions.md#plan-state-in-file), as git reads a short
 * hash: `plans` prints ids at eight characters, so an agent copies them. The
 * live id `written` names: itself when the sessions are unread (`live` null)
 * or when it is one of them; else the one live id it begins, when it is
 * eight characters or more and begins no other; else "".
 */
export function liveId(written, live) {
  if (live === null || live.includes(written)) return written;
  if (written.length < 8) return "";
  const starts = live.filter((id) => id.startsWith(written));
  return starts.length === 1 ? starts[0] : "";
}

/**
 * Whether the id a line wrote, read with the sessions unread, is
 * `sessionId`'s: the same, or a start of it of eight characters or more.
 * With the sessions read, `stateOf` has made it whole already.
 */
export function sameSession(written = "", sessionId = "") {
  return written === sessionId || (written.length >= 8 && sessionId.startsWith(written));
}

/**
 * A regular expression's source for `sessionId` as a line writes it, whole or
 * by a start of eight characters or more (`liveId`): its first eight, then
 * any run of the rest, up to where `stateOf` ends the id it reads.
 */
function sessionIdSource(sessionId) {
  const escape = (part) => part.replace(/[^\w-]/g, "\\$&");
  const rest = [...sessionId.slice(8)].reduceRight((tail, c) => `(?:${escape(c)}${tail})?`, "");
  return `${escape(sessionId.slice(0, 8))}${rest}(?![^\\s,])`;
}

/**
 * A plan's place in the queue, read from its text. `live` is the live
 * sessions' ids, or null when they could not be listed, which counts every
 * Building line as live: the safe side.
 */
export function stateOf(text, { mtime = 0, live = null } = {}) {
  // **A plan is a plan before it is a brief**: its header is read first, and
  // the brief's line only at a line's start, so a plan whose first lines
  // mention the brief it replaced reads as the plan. Both are looked for past
  // the queue's own status sections, wherever an agent wrote them; the status
  // checks below read the whole text. A `First` line and its blank count for
  // nothing, so one written above the first `## ` section, over a header
  // under a section, does not push the header out of the twelve lines.
  const lines = withoutStatus(withoutFirstLine(text)).split("\n");
  const header = PLAN_HEADER.exec(lines.slice(0, 12).join("\n"));
  const head = lines.slice(0, 6).join("\n");
  const dropped = droppedOf(text);
  // **A brief is queued like a plan**: one a planner is working on carries its
  // Planning line, live while its session is.
  const brief = header ? null : BRIEF_HEADER.exec(head);
  if (brief) {
    const day = brief[1] || "";
    const base = {
      kind: "Brief",
      day,
      date: day ? parseDay(day) : 0,
      mtime,
      relatedTo: relatedOf(text),
      issue: issueOf(text),
    };
    if (dropped) return { ...base, state: "dropped", ...dropped };
    // **A brief put first** (decisions.md#plan-put-first): the mark counts
    // while the brief waits or is planned, and the planner carries it on.
    const first = firstOf(text);
    const planning = /^## Planning, ([^,\n]+), session ([^\s,]+)/m.exec(text);
    const id = planning && liveId(planning[2], live);
    if (id) return { ...base, state: "planning", session: id, since: planning[1], first };
    return { ...base, state: "brief", stale: Boolean(planning), first };
  }
  if (!header) return null;
  const plan = {
    kind: header[1],
    day: header[2],
    date: parseDay(header[2]),
    mtime,
    lands: landsOf(text),
    relatedTo: relatedOf(text),
    from: fromOf(text),
    carries: carriesOf(text),
    issue: issueOf(text),
  };
  // Dropped before built: nobody writes both, and the drop is the last word.
  if (dropped) return { ...plan, state: "dropped", ...dropped };
  const built = BUILT_DAY.exec(text);
  if (built) {
    // The commit is the hash written after "commit", in any case and at git's
    // short length of seven or more: in the section's opening paragraph,
    // where the executor says how the plan landed, else anywhere in the
    // section; else the opening paragraph's first hash that is no session id,
    // Actions run or issue: the word after `session` or `run`, a whole UUID,
    // anything in brackets or a link, and a number after `#` are never a
    // commit. Cut to eight, in git's lower case.
    const section = sectionAfter(text, /^## Built/m);
    const paragraph =
      section
        .split("\n")
        .slice(1)
        .join("\n")
        .trim()
        .split(/\n\s*\n/)[0] || "";
    const commit = /\bcommit\s+`?([0-9a-f]{7,40})\b/i;
    const named = commit.exec(paragraph) || commit.exec(section);
    const loose = /(?<!#)\b[0-9a-f]{7,40}\b/i.exec(
      paragraph
        .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, " ")
        .replace(/\b(?:session|run):?\s+`?[0-9a-f-]{4,}\b`?/gi, " ")
        .replace(/\[[^\]\n]*\]|\bhttps?:\/\/\S+/g, " "),
    );
    const sha = (named ? named[1] : (loose?.[0] ?? "")).slice(0, 8).toLowerCase();
    // **A plan landed by pull request** (`land: pull-request`) names it, on
    // the first line or on the line a topic's later opening adds.
    const pr = Number(/^Pull request #(\d+)/m.exec(section)?.[1] || 0);
    // The section's first line says how the plan landed when it was not by
    // a pull request: a fix pushed straight, or a topic waiting for one.
    const opening =
      section
        .split("\n")
        .slice(1)
        .find((line) => line.trim()) || "";
    const fix = /^Pushed straight to /.test(opening);
    const topic = /^On topic ([^\s,]+)/.exec(opening)?.[1] || "";
    // A topic left with no pull request that has none to open
    // (decisions.md#topic-landing): its branch gone, or its commits on the
    // branch already.
    const noPull = /^No pull request: /m.test(section);
    // A refresh has no commit of its own: the pull requests' are theirs
    // (decisions.md#merge-refreshes-the-rest).
    const refresh = /^Refreshed\b/.test(opening);
    return {
      ...plan,
      state: "built",
      builtDay: (built[1] || "").trim(),
      sha: refresh ? "" : sha,
      pr: refresh ? 0 : pr,
      fix,
      topic,
      noPull,
      refresh,
    };
  }
  const resumed = [
    ...text.matchAll(/^## Resumed, [^,\n]+, session [^,\s]+, at step ([^\s,.]+)/gm),
  ].map((m) => m[1]);
  const stuck =
    resumed.length >= MAX_HANDOVERS || (resumed.length >= 2 && resumed.at(-1) === resumed.at(-2));
  const building = /^## Building, ([^,\n]+), session ([^\s,]+)/m.exec(text);
  const id = building && liveId(building[2], live);
  if (id) return { ...plan, state: "building", session: id, since: building[1], resumed, stuck };
  const stale = Boolean(building);
  const handed = /^## Handing over/m.test(text);
  if (handed) {
    const section = sectionAfter(text, /^## Handing over/m);
    // The name runs to whitespace, a trailing full stop or comma dropped; a
    // backticked name is taken whole (`feat/v1.2` is not `feat/v1`).
    const named = /branch `([^`\n]+)`|branch ([\w./-]+?)(?=[.,;:]?(?:\s|$))/m.exec(section);
    const branch = named ? [named[1] || named[2]] : null;
    const step = /^Step in hand: ([^\n]+)/m.exec(section);
    // The worktree it was built in; with none named, the one with its branch checked out.
    const tree =
      /in worktree `(executor-\d+)`/.exec(section)?.[1] ||
      (branch ? basename(worktrees().find((one) => one.branch === branch[0])?.path || "") : "");
    return {
      ...plan,
      state: "handed",
      first: firstOf(text),
      stale,
      resumed,
      stuck,
      branch: branch ? branch[0] : "",
      step: step ? step[1].trim() : "",
      tree: /^executor-\d+$/.test(tree) ? tree : "",
    };
  }
  // A date that does not parse (NaN) is no date on or after the queue's start.
  if (!(plan.date >= QUEUE_SINCE)) return { ...plan, state: "old" };
  const asks =
    /^## Decisions for [^\n]*\n[\s\S]*?^\d+\./m.test(sectionAfter(text, /^## Decisions for /m)) &&
    !/^## Decided/m.test(text);
  // **A plan with an issue waits for Ready**: planned until the label or the
  // owner's word writes the section. **A plan put first**
  // (decisions.md#plan-put-first): only while it waits; a built, dropped or
  // building plan carries no mark, with nothing to clear.
  const first = firstOf(text);
  if (plan.issue && !readyOf(text)) return { ...plan, state: "planned", stale, asks, first };
  return { ...plan, state: "ready", stale, asks, first };
}

/** The repository paths a plan names, once each. */
export function pathsIn(text) {
  // Any path of two or more segments with an extension, but the plans': every
  // batch changes the plans it builds, and every plan names the plans it rests on.
  const found = text.match(/(?<![\w/.:-])[\w-]+(?:\/[\w.-]+)+\.\w+/g) || [];
  return [...new Set(found.filter((path) => !path.startsWith("plans/")))];
}

/**
 * **What a plan or brief shares with a chat, in tokens**
 * (decisions.md#shared-is-what-is-held): for each path `briefPaths` finds in
 * `text` that the chat read or wrote (`seen`, its tool hook's count) and
 * that is a file in `checkout`, what the chat holds of it, at most the
 * file's size in bytes over four; never the whole file for a few hunks of
 * it; 0 for none.
 */
export function sharedTokens(text = "", seen = {}, { checkout = root } = {}) {
  let tokens = 0;
  for (const path of briefPaths(text || "")) {
    if (!(seen?.[path] > 0)) continue;
    try {
      const stat = statSync(join(checkout, path));
      if (stat.isFile()) tokens += Math.min(seen[path], stat.size / 4);
    } catch {
      // Named and gone: nothing to share.
    }
  }
  return Math.round(tokens);
}

/**
 * The plans under `plans/`, each with its path and state, the queue's order:
 * handed over first, then those put first, the latest put first on top
 * (decisions.md#plan-put-first), then oldest.
 */
export function readPlans(dir = join(root, "plans"), live = null, texts = {}) {
  let names = [];
  try {
    // The assistant's hand-over file is no plan (decisions.md#one-chat).
    names = readdirSync(dir).filter(
      (name) => name.endsWith(".md") && `plans/${name}` !== ASSISTANT_HANDOVER,
    );
  } catch {
    return [];
  }
  const plans = [];
  for (const name of names) {
    const file = join(dir, name);
    let text;
    let mtime;
    try {
      // A text given for the path is read in its place: a dry start's
      // hand-over.
      text = texts[`plans/${name}`] ?? readFileSync(file, "utf8");
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const state = stateOf(text, { mtime, live });
    if (state) plans.push({ path: `plans/${name}`, file, text, ...state });
  }
  return plans.sort(
    (a, b) =>
      Number(b.state === "handed") - Number(a.state === "handed") ||
      Number(Boolean(b.first)) - Number(Boolean(a.first)) ||
      (b.first?.at || 0) - (a.first?.at || 0) ||
      (a.date || 0) - (b.date || 0) ||
      a.mtime - b.mtime,
  );
}

/**
 * **A plan file the queue cannot read is listed, never dropped**
 * (decisions.md#plan-state-in-file): the `plans/*.md` with neither a plan's
 * header nor a brief's line where `stateOf` looks (`headless`), and those
 * that could not be read at all (`failed`), by path. One gone between the
 * listing and the read is gone, not failed. The log of decisions taken for
 * the owner (`TAKEN_LOG`) is the assistant's, not a plan.
 */
export const TAKEN_LOG = "plans/decisions-taken.md";

export function unreadPlans(dir = join(root, "plans")) {
  const unread = { headless: [], failed: [] };
  let names = [];
  try {
    // The assistant's hand-over file is no plan (decisions.md#one-chat).
    names = readdirSync(dir).filter(
      (name) => name.endsWith(".md") && `plans/${name}` !== ASSISTANT_HANDOVER,
    );
  } catch {
    return unread;
  }
  for (const name of names.sort()) {
    let text;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") unread.failed.push(`plans/${name}`);
      continue;
    }
    if (!stateOf(text) && `plans/${name}` !== TAKEN_LOG) unread.headless.push(`plans/${name}`);
  }
  return unread;
}

/**
 * **The rows a project counts as its own** (each project's queue runs apart):
 * a session whose working directory is in its checkout or one of its
 * worktrees, or one its own files name, the lock's holder or a `Building` or
 * `Planning` line's session, wherever it works.
 */
export function ownRows(rows, { paths = [], lockIds = [], named = [] } = {}) {
  return rows.filter(
    (row) =>
      inThisRepo(row.cwd, paths) ||
      Boolean(
        row.sessionId &&
        (lockIds.includes(row.sessionId) || named.some((id) => sameSession(id, row.sessionId))),
      ),
  );
}

/** The sessions the plans name in their `Building` and `Planning` lines, read from the files. */
function namedSessions(dir = join(root, "plans")) {
  const ids = [];
  let names = [];
  try {
    // The assistant's hand-over file is no plan (decisions.md#one-chat).
    names = readdirSync(dir).filter(
      (name) => name.endsWith(".md") && `plans/${name}` !== ASSISTANT_HANDOVER,
    );
  } catch {
    return ids;
  }
  for (const name of names) {
    let text = "";
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/^## (?:Building|Planning), [^,\n]+, session ([^\s,]+)/gm))
      ids.push(m[1]);
  }
  return ids;
}

/** The `claude` the queue runs: `WORKFLOW_CLAUDE` in the tests, a script in its place. */
const claudeBin = () => process.env.WORKFLOW_CLAUDE || "claude";

/** `claude agents`, read once per process; the start's wait asks it fresh. */
let liveRead;

/** This project's sessions, from `claude agents --json` (`ownRows`); null when it cannot be read. */
let liveAll = null;

/**
 * The names of every live session on this machine, in any checkout: a
 * start's number counts them all, since two checkouts of one project share
 * its names (decisions.md#session-names).
 */
function liveNames() {
  liveSessions();
  return (liveAll || []).map((row) => row.name || "");
}

/** `liveSessions`'s own rows of `rows`, every row kept in `liveAll`. */
function keepRows(rows) {
  liveAll = rows;
  liveRead =
    rows &&
    ownRows(rows, {
      paths: worktreePaths(),
      lockIds: readLocks().map((lock) => lock.sessionId),
      named: namedSessions(),
    });
  return liveRead;
}

/** `liveSessions`, read fresh without blocking: the listener's minute reads it while its server answers. */
function liveSessionsLater(timeout = 8000) {
  if (process.env.WORKFLOW_LIVE) return Promise.resolve(liveSessions({ fresh: true }));
  return new Promise((done) =>
    execFile(
      claudeBin(),
      ["agents", "--json"],
      { cwd: root, encoding: "utf8", timeout },
      (error, out) => {
        let rows = null;
        try {
          rows = error ? null : JSON.parse(out);
        } catch {
          // Unread, as a failed call.
        }
        done(keepRows(rows));
      },
    ),
  );
}

function liveSessions({ fresh = false, timeout = 8000 } = {}) {
  if (!fresh && liveRead !== undefined) return liveRead;
  let rows = null;
  // The tests' sessions, so a hook run in a child process sees rows of their own.
  if (process.env.WORKFLOW_LIVE) rows = JSON.parse(process.env.WORKFLOW_LIVE);
  else {
    try {
      rows = JSON.parse(
        execFileSync(claudeBin(), ["agents", "--json"], {
          cwd: root,
          encoding: "utf8",
          timeout,
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
    } catch {
      rows = null;
    }
  }
  return keepRows(rows);
}

/**
 * The worktrees of this repository, the checkout first, from `git worktree
 * list`. **A background session lives in one**: Claude Code moves it under
 * `.claude/worktrees/` before its first edit, so a session counted only in
 * the checkout read as gone.
 */
export function worktrees() {
  treesRead ??= readWorktrees();
  return treesRead;
}

/** `git worktree list`, read once per process. */
let treesRead;

function readWorktrees() {
  let out = "";
  try {
    out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [{ path: root, branch: "" }];
  }
  const trees = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) trees.push({ path: line.slice(9), branch: "" });
    else if (line.startsWith("branch refs/heads/") && trees.length)
      trees.at(-1).branch = line.slice(18);
  }
  // The checkout first, as `git worktree list` gives it; root when it does not.
  if (trees[0]?.path !== root) trees.unshift({ path: root, branch: "" });
  return trees;
}

function worktreePaths() {
  return worktrees().map((tree) => tree.path);
}

/**
 * The branch a session works on: its worktree's, from `git worktree list`,
 * else what `git branch --show-current` says there; "(unknown)" when neither
 * names one. The hand-overs write it for the next executor to check out.
 */
function branchOf(cwd = root) {
  const tree = treeOf(cwd || root, worktrees());
  if (tree?.branch) return tree.branch;
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd: tree?.path || root,
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch || "(unknown)";
  } catch {
    return "(unknown)";
  }
}

/** An executor's worktree's name, `executor-<n>`, for a working directory in one; else "". */
function treeNameOf(cwd) {
  const n = numberOf(cwd);
  return n ? `executor-${n}` : "";
}

/** The worktree a working directory is in: the deepest whose path is it or holds it. */
function treeOf(cwd, trees) {
  if (!cwd) return null;
  return (
    trees
      .filter((tree) => cwd === tree.path || cwd.startsWith(`${tree.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0] || null
  );
}

/**
 * The tree a command is run in: the worktree under `.claude/worktrees/` that
 * holds the working folder, else the checkout. **An executor builds in its
 * own worktree** (decisions.md#executors-in-worktrees): the queue's files stay
 * the checkout's, but `plans check` lints the catalogue being built there,
 * and the checkout's for a path git does not carry into the worktree.
 */
function treeHere(cwd = process.cwd()) {
  // As given and by real paths, as numberOf reads them.
  const tree =
    treeOf(cwd, worktrees()) ||
    treeOf(
      realPath(cwd),
      worktrees().map((t) => ({ ...t, path: realPath(t.path) })),
    );
  if (!tree || tree.path === root) return root;
  const trees = join(root, ".claude", "worktrees");
  const under = (base, dir) => {
    const rel = relative(base, dir);
    return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
  };
  return under(trees, tree.path) || under(realPath(trees), realPath(tree.path)) ? tree.path : root;
}

/**
 * **Any live executor counts**: a session is an executor by its name (`Executor
 * n`, given by `start()`), by the state its prompt hook wrote (`agent:
 * "executor"`, so one the owner started by hand counts too), or by holding the
 * lock. **A planner counts only when the queue started it**: a background row
 * named `Planner n`, or one whose state says `agent: "planner"`; the owner's
 * own planner chats are his, not the queue's.
 */
export function isSession(kind, row, state, locks = []) {
  // **The owner talks to one chat** (decisions.md#one-chat): this
  // project's `<Project> Assistant` on this machine, whoever opened it.
  if (kind === "assistant")
    return (
      !/remote/i.test(row.kind || "") &&
      row.name === sessionName("assistant", 0, { project: proj().name })
    );
  const named = parseName(row.name || "")?.kind === kind;
  if (kind === "planner") return row.kind === "background" && (named || state?.agent === "planner");
  return (
    named ||
    state?.agent === "executor" ||
    locks.some((lock) => !lock.released && lock.sessionId === row.sessionId)
  );
}

/**
 * **A session's name**: `<Project> <Kind> <n> (<machine>)`, `Workflow
 * Executor 2 (lab)`. The project and the machine are optional, since the
 * start log still holds names written before the machine was in them.
 */
const SESSION_NAME = /^(?:(.+) )?(Executor|Planner) (\d+)(?: \(([\w.-]+)\))?$/;

/**
 * The name the queue gives a session it starts; the assistant's is one
 * name, `<Project> Assistant`, with no number and no machine
 * (decisions.md#one-chat).
 */
export function sessionName(kind, n, { project = "", machine = "" } = {}) {
  if (kind === "assistant") return [project, "Assistant"].filter(Boolean).join(" ");
  const word = kind === "planner" ? "Planner" : "Executor";
  return [project, word, n, machine && `(${machine})`].filter(Boolean).join(" ");
}

/**
 * The number a new session of `kind` takes: one above the highest among
 * `names` that `parseName` reads as this kind and project, any machine or
 * none (the old log's names carry none), from 1 with none; the name
 * `sessionName` gives it. `canStart` numbers with it, and `holdName` again
 * under its guard (plans/overlapping-starts-own-names.md).
 */
export function nextName(kind, { project = "", machine = "", names = [] } = {}) {
  const n =
    Math.max(
      0,
      ...names.map((one) => {
        const parsed = parseName(one || "");
        return parsed && parsed.project === project && parsed.kind === kind ? parsed.n : 0;
      }),
    ) + 1;
  return sessionName(kind, n, { project, machine });
}

/** `{ project, kind, n, machine }` from a session's name, or null when the queue gave no such name. */
export function parseName(name) {
  const m = SESSION_NAME.exec(name);
  return m
    ? { project: m[1] || "", kind: m[2].toLowerCase(), n: Number(m[3]), machine: m[4] || "" }
    : null;
}

/**
 * A row's status as the queue says it: "waiting for input" only while its
 * process says a prompt stands (`status: waiting`, `waitingFor`), the prompt
 * named unless it is the question tool's; "not running" with no process (no
 * `pid`, no `status`); else the process's own status. `state` is not read:
 * `blocked` is also Claude Code's reading of the last turn's text, an error
 * only the owner can clear as much as a question
 * (decisions.md#waiting-is-an-open-prompt).
 */
export function statusOf(row) {
  if (row.status === "waiting" || row.waitingFor)
    return !row.waitingFor || row.waitingFor === "input needed"
      ? "waiting for input"
      : `waiting for input, ${row.waitingFor}`;
  if (!row.pid && !row.status) return "not running";
  return row.status || "status unknown";
}

/**
 * The live sessions of a kind (`executor` or `planner`), each with where it
 * works (`checkout` or a worktree's name), its branch, whether it holds the
 * lock, whether it is retired, and the plan its Building line (an
 * executor's) or the brief its Planning line (a planner's) names.
 */
export function sessionsOf(
  kind,
  live,
  locks = [],
  {
    trees = worktrees(),
    plans = [],
    stateFor = readState,
    seenFor = seenOf,
    usageFor = (row) => sessionUsage(transcriptOf(row)),
    fallback = REUSE_DEFAULT[kind] || REUSE_DEFAULT.executor,
    inputs = {},
    checkout = root,
  } = {},
) {
  if (!live) return [];
  const working = { planner: "planning", executor: "building" }[kind] || "";
  return live
    .map((row) => ({ row, state: stateFor(row.sessionId) }))
    .filter(({ row, state }) => isSession(kind, row, state, locks))
    .map(({ row, state }) => {
      const tree = treeOf(row.cwd, trees);
      return {
        kind,
        sessionId: row.sessionId,
        id: row.id || "",
        name: row.name || String(row.sessionId).slice(0, 8),
        status: statusOf(row),
        // Its context and the age of its last turn, from its transcript.
        usage: usageFor(row),
        // What its ceiling is worked out from
        // (decisions.md#reuse-check-cheap).
        fallback,
        inputs,
        where: !tree || tree.path === root ? "checkout" : basename(tree.path),
        branch: tree?.branch || "",
        // Its executor number, from its worktree.
        number: kind === "executor" ? numberOf(row.cwd) : 0,
        retired: Boolean(state?.retired),
        on:
          (working &&
            plans.find((plan) => plan.state === working && sameSession(plan.session, row.sessionId))
              ?.path) ||
          "",
        // When its end timer fires, if it is left quiet.
        endsAt: state?.end?.at || 0,
        // Why its Stop hook kept it for the work it took.
        kept: state?.kept || null,
        // What it read or wrote of each file, by its tool hook
        // (decisions.md#shared-is-what-is-held).
        seen: seenFor(row.sessionId),
        // A planner's plans, which its chat still talks about, where each
        // stands, and how tired it is.
        ...(kind === "planner"
          ? {
              holds: withPlans(state)?.plans || [],
              standing: Object.fromEntries(
                (withPlans(state)?.plans || []).map((path) => [
                  path,
                  standingOf(
                    plans.find((plan) => plan.path === path),
                    live,
                    { self: row.sessionId, stateFor, path, checkout },
                  ),
                ]),
              ),
            }
          : {}),
      };
    });
}

/**
 * **`plans` says what the next waiting work shares with each chat**
 * (decisions.md#shared-is-what-is-held): an executor's row against the
 * plan the queue starts first, by `readPlans`'s order, the one `plans
 * start` judges the live executor with: the first handed-over or ready
 * plan not asking, handed first; a planner's against the oldest brief
 * free for it; each with `shared` and `sharedWith`; a row with nothing
 * waiting is left as it is.
 */
export function withShare(rows, kind, plans, live, { checkout = root } = {}) {
  const first = plans.find((p) => (p.state === "handed" || p.state === "ready") && !p.askingIn);
  return rows.map((one) => {
    // A brief leased to this planner is free for it, so each planner's is its own.
    const next = kind === "planner" ? freeBriefs(plans, { live, self: one.sessionId })[0] : first;
    return next
      ? { ...one, shared: sharedTokens(next.text, one.seen, { checkout }), sharedWith: next.path }
      : one;
  });
}

/**
 * Where a planner's plan stands, as its line says it, so an idle planner's
 * reason is read off the line. A plan the queue did not read is `gone` when its
 * file is not in the checkout, `built` when an executor's line or a drop is in
 * it all the same, and `not read by the queue` otherwise, so the planner that
 * can fix it is kept.
 */
function standingOf(plan, live, { self = "", path = "", checkout = root, ...options } = {}) {
  if (!plan) {
    if (!path) return "gone";
    let text;
    try {
      text = readFileSync(join(checkout, path), "utf8");
    } catch (error) {
      return error.code === "ENOENT" ? "gone" : "not read by the queue";
    }
    return doneWith(text) ? "built" : "not read by the queue";
  }
  if (ASKS_STATES.includes(plan.state) && plan.asks) {
    // "Asked once": the planner's own while its question is under thirty minutes old.
    const asking = "askingIn" in plan ? plan.askingIn : askingIn(plan, live, options);
    if (!asking) return "unanswered, the executor decides";
    return `asks ${owner()}${asking.row.sessionId === self ? " here" : ""} until ${hhmm(asking.until)}`;
  }
  if (plan.state === "ready") return "ready, for the executor";
  if (plan.state === "planned") return `planned, waiting on GitHub (#${plan.issue})`;
  if (plan.state === "handed") return "handed over";
  if (plan.state === "building")
    return `building, ${live?.find((row) => row.sessionId === plan.session)?.name || String(plan.session).slice(0, 8)}`;
  return plan.state;
}

/** "a (built) and b (ready, for the executor)": a planner's plans with where each stands, when known. */
function heldWords(one) {
  const standing = one.standing || {};
  return andList(
    (one.holds || []).map((path) => (standing[path] ? `${path} (${standing[path]})` : path)),
  );
}

/**
 * "ends at 22:49 if left quiet" while the end timer is ahead and the session
 * idle, else "": a turn under way or a question or a prompt standing is not
 * quiet; a blocked state alone is.
 */
function endsWords(one, now = Date.now()) {
  return one.endsAt > now && /^idle\b/.test(one.status || "")
    ? `ends at ${hhmm(one.endsAt)} if left quiet`
    : "";
}

/**
 * "618k context, warm", "174k context, warm, shares 13k with plans/x.md, over
 * its ceiling", "200k context, cold 130 min, over its ceiling", or "" with no
 * usage: over the warm ceiling `ceilingFor` works out for the row's agent with
 * what it shares (`shared`, 0 when no work is in hand), said with the work it
 * shares it with (decisions.md#shared-is-what-is-held, `sharedWith`). The
 * assistant's ceiling is its `fallback`, the project's `reuse.assistant`,
 * past which its chat is handed on to a fresh one (decisions.md#one-chat).
 */
export function usageWords(one, now = Date.now()) {
  if (!one.usage) return "";
  const age = now - one.usage.at;
  const context = one.usage.context;
  // The assistant's ceiling is the project's, where its chat is compacted.
  const over =
    one.kind === "assistant"
      ? context > one.fallback
      : context >
        ceilingFor({
          kind: one.kind === "planner" ? "planner" : "executor",
          inputs: one.inputs,
          model: one.usage.model,
          shared: one.shared || 0,
          fallback: one.fallback,
        }).ceiling;
  return [
    `${kTokens(context)} context`,
    age <= WARM ? "warm" : `cold ${Math.round(age / MINUTE)} min`,
    one.sharedWith && one.shared >= 500
      ? `shares ${kTokens(one.shared)} with ${one.sharedWith}`
      : "",
    over ? "over its ceiling" : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * "kept for plans/x.md: <why>" while the session, not retired, has under way
 * a plan or brief it was kept for, else "": once that work is done the
 * reason is stale.
 */
function keptWords(one) {
  const paths = one.kept?.paths || [];
  return !one.retired && one.on && paths.includes(one.on) && one.kept.why
    ? `kept for ${andList(paths)}: ${one.kept.why}`
    : "";
}

/** One session as its kind's line says it. */
export function describeSession(one) {
  if (one.kind === "assistant")
    return [
      `${one.name} [${String(one.sessionId).slice(0, 8)}]`,
      one.status,
      usageWords(one),
      endsWords(one),
    ]
      .filter(Boolean)
      .join(", ");
  if (one.kind === "planner") {
    const holds = one.holds || [];
    return [
      `${one.name} [${String(one.sessionId).slice(0, 8)}]`,
      one.status,
      usageWords(one),
      endsWords(one),
      !one.retired && one.on ? `planning ${one.on}` : "",
      keptWords(one),
      !one.retired && holds.length ? `holds ${heldWords(one)}` : "",
      one.retired
        ? holds.length
          ? `retired, its plan${holds.length === 1 ? "" : "s"} ${heldWords(one)}`
          : "retired"
        : "",
    ]
      .filter(Boolean)
      .join(", ");
  }
  return [
    `${one.name} [${String(one.sessionId).slice(0, 8)}]`,
    one.status,
    usageWords(one),
    endsWords(one),
    one.where === "checkout"
      ? "in the checkout"
      : `in ${one.where}${one.branch ? ` on ${one.branch}` : ""}`,
    one.on ? `building ${one.on}` : "",
    // "running browser", "waiting for browser" (decisions.md#resource-slots).
    ...(one.holding || []),
    keptWords(one),
    one.retired ? "retired" : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * **`plans` says the ceilings** (decisions.md#reuse-check-cheap): each
 * agent's worked out with nothing shared, and what it rests on; with no
 * history for either, the project's numbers and that they are today's.
 */
export function ceilingsLine(reuse = REUSE_DEFAULT, inputs = {}) {
  const at = (kind) => ceilingFor({ kind, inputs, fallback: reuse[kind] });
  const executor = at("executor");
  const planner = at("planner");
  if (!executor.history && !planner.history)
    return `Ceilings: an executor retires past ${kTokens(executor.ceiling)} and a planner past ${kTokens(planner.ceiling)} (no history yet: today's numbers).`;
  const basis = (one) =>
    one.capped
      ? `the cap of ${kTokens(one.cap)}`
      : one.history
        ? `fresh start ${kTokens(one.start)}, ${one.turns} turns, ${one.prices} prices`
        : "no history yet: today's numbers";
  const measured = inputs.measured;
  const when = measured?.at
    ? `; measured from ${measured.transcripts} transcript${measured.transcripts === 1 ? "" : "s"} on ${dayMonth(measured.at)}`
    : "";
  return `Ceilings: an executor retires past ${kTokens(executor.ceiling)} (${basis(executor)}), a planner past ${kTokens(planner.ceiling)} (${basis(planner)}), plus what a plan or brief shares with the chat${when}.`;
}

/**
 * **`plans` says why the last fresh session of each kind started**: the
 * newest line of the starts log for this project's executors and planners
 * that retired a session, "Last fresh planner: <name> at <hh:mm> on <d Month>,
 * on plans/x.md; <old name> [<id>] was retired: <why>". None without one.
 */
export function lastFreshLines(log, project) {
  return ["executor", "planner"].flatMap((kind) => {
    const last = log.findLast((line) => {
      const parsed = parseName(line.name || "");
      return line.why && parsed && parsed.project === project && parsed.kind === kind;
    });
    if (!last) return [];
    return [
      `Last fresh ${kind}: ${last.name} at ${hhmm(last.at)} on ${dayMonth(last.at)}, on ${andList(last.paths || [])}; ${last.why}`,
    ];
  });
}

/** "a", "a and b", "a, b and c". */
function andList(items) {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The line for a kind: "The executor: ...", "The executors: ...", or "none alive". */
function sessionsLine(kind, alive) {
  if (!alive.length) return `The ${kind}: none alive.`;
  return `The ${kind}${alive.length === 1 ? "" : "s"}: ${alive.map(describeSession).join("; ")}.`;
}

/** Whether a session's working directory is this checkout, one of its worktrees, or under one; no directory is no repository's. */
export function inThisRepo(cwd, paths) {
  return Boolean(cwd) && paths.some((path) => cwd === path || cwd.startsWith(`${path}/`));
}

function pidAlive(pid) {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Whether the lock keeps this session from building: another session's, not released, its process alive. */
export function lockHeldByOther(lock, sessionId, alive = pidAlive) {
  return Boolean(lock && !lock.released && lock.sessionId !== sessionId && alive(lock.pid));
}

/** A shell command a retired or locked-out executor may still run: one that writes nothing, or the queue's own list. */
export function allowedWhileLocked(command) {
  if (/^\s*(plans(\s+(--all|list))?\s*$|node \S*plan-queue\.mjs list\b)/.test(command)) return true;
  return !shellWrites(command);
}

/**
 * **No agent marks a pull request ready for review**
 * (decisions.md#draft-until-reviewed): whether a shell command calls `gh pr
 * ready` without `--undo`. The command is split into simple commands on
 * `&&`, `||`, `;`, `|`, `&`, new lines, parentheses and backquotes outside
 * quotes, and each one's words are read with their quotes taken off, so a
 * quoted string naming it (a commit message) is no call. A comment, a
 * heredoc's body and a backslash before a new line are passed over; leading
 * `NAME=value` words, the shell's keywords (`if`, `then`, `do`, ...) and
 * the wrappers that run a command (`env`, `command`, `xargs`, ...) are
 * skipped, and `gh` is known by its file name. `gh api` with GitHub's
 * mutation for it, `markPullRequestReadyForReview`, is the same act.
 */
export function marksReady(command) {
  const parts = [[]];
  const heredocs = [];
  let word = null;
  let quote = "";
  const end = () => {
    if (word !== null) parts.at(-1).push(word);
    word = null;
  };
  const split = () => {
    end();
    parts.push([]);
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (c === "\\" && command[i + 1] === "\n") i++;
    else if (c === "\\" && i + 1 < command.length) word = (word ?? "") + command[++i];
    else if (c === "#" && word === null) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
    } else if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      // A heredoc: its delimiter read now, its body passed over at the new line.
      end();
      let j = i + 2;
      const strip = command[j] === "-";
      if (strip) j++;
      while (command[j] === " " || command[j] === "\t") j++;
      const at = command.slice(j).match(/^(['"]?)([^\s'";&|<>()]+)\1/);
      if (at) {
        heredocs.push({ delimiter: at[2], strip });
        j += at[0].length;
      }
      i = j - 1;
    } else if (c === "\n") {
      split();
      // Each heredoc started on the line ends at its delimiter's own line.
      for (const { delimiter, strip } of heredocs.splice(0)) {
        let next = command.indexOf("\n", i + 1);
        while (true) {
          const line = command.slice(i + 1, next === -1 ? undefined : next);
          i = next === -1 ? command.length : next;
          if ((strip ? line.replace(/^\t+/, "") : line) === delimiter || next === -1) break;
          next = command.indexOf("\n", i + 1);
        }
      }
    } else if (/\s/.test(c)) end();
    else if (";&|()`".includes(c)) split();
    else word = (word ?? "") + c;
  }
  end();
  const skipped = new Set([
    ...["if", "then", "else", "elif", "do", "while", "until", "!", "{", "time"],
    ...["env", "command", "exec", "nohup", "sudo", "xargs"],
  ]);
  return parts.some((words) => {
    let call = words.slice(words.findIndex((w) => !skipped.has(w) && !/^[A-Za-z_]\w*=/.test(w)));
    // `plans gh` is `gh` as the project's app.
    if (call[0]?.split("/").pop() === "plans" && call[1] === "gh") call = call.slice(1);
    if (call.length < 3 || call[0].split("/").pop() !== "gh") return false;
    if (call[1] === "api") return call.some((w) => w.includes("markPullRequestReadyForReview"));
    return call[1] === "pr" && call[2] === "ready" && !call.some((w) => /^--undo(=|$)/.test(w));
  });
}

const READY_REFUSED =
  "Marking a pull request ready for review is its owner's step on GitHub (the Ready for review button), never an agent's.";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  renameSync(temp, path);
}

function readState(sessionId) {
  return withPlans({
    told: [],
    retired: false,
    ...readJson(files.state(sessionId)),
  });
}

/** **A planner's state holds every plan it wrote**: `plans`, in order. */
function withPlans(state) {
  if (state?.agent !== "planner") return state;
  return { ...state, plans: state.plans ?? [] };
}

function blockReason(lock) {
  const since = lock.taken ? hhmm(lock.taken) : "earlier";
  return `Another executor is building in this worktree: ${lock.name || "an executor"} [${String(lock.sessionId).slice(0, 8)}], since ${since}. Each worktree holds one executor (the plugin's docs/workflow.md, "The queue"). Do not build; say so, and stop.`;
}

function annotate(plan) {
  // A plan put first says so, with its other words in the one parenthesis
  // (decisions.md#plan-put-first).
  const words = [
    plan.state === "handed" ? "handed over, resume" : "",
    firstWords(plan),
    plan.asks ? 'decisions unanswered: the recommended options, "Asked once"' : "",
  ].filter(Boolean);
  return words.length ? `${plan.path} (${words.join("; ")})` : plan.path;
}

/** "200k", a token count as the queue's lines say it. */
const kTokens = (n) => `${Math.round(n / 1000)}k`;

/**
 * **The quality limit that stays fixed** (decisions.md#context-cost): no chat
 * is kept past it, whatever the formula gives. Today's largest number (Javi),
 * and Chroma's context rot: models use a long context worse the longer it is,
 * a loss no price measures.
 */
export const REUSE_CAP = 480_000;
/** The sessions of an agent in a project before its measured inputs are trusted. */
const REUSE_HISTORY = 5;
/** Today's cold ceiling, while an agent has no history here: a cold context over it is rewritten at a loss. */
const COLD_DEFAULT = 60_000;

/**
 * **The ceiling worked out from measured inputs**
 * (decisions.md#reuse-check-cheap, on decisions.md#context-cost): a kept chat
 * and a fresh one cost the same when the kept one's context is
 *
 *     (S + shared) x (1 + w / (T x r))
 *
 * S the agent's fresh start here (its median first-turn context, which holds
 * the agent file, the plugin's instructions and the project's CLAUDE.md), T
 * its median turns, w and r the model's one-hour cache write and cache read,
 * `shared` the tokens the waiting work shares with the chat. Cold, the kept
 * context is written again at the write price, as a fresh start is: S +
 * shared. Under `REUSE_HISTORY` sessions of the agent, `fallback` (the
 * project file's `reuse`) and today's cold 60k. Never over `cap`.
 * `{ ceiling, wash, cap, capped, history, start, turns, prices, why }`.
 */
export function ceilingFor({
  kind = "executor",
  inputs = {},
  model = "",
  shared = 0,
  warm = true,
  fallback = REUSE_DEFAULT[kind] || REUSE_DEFAULT.executor,
  cap = REUSE_CAP,
}) {
  const measured = inputs?.[kind];
  if (!measured || !(measured.sessions >= REUSE_HISTORY) || !(measured.start > 0)) {
    const wash = warm ? fallback : Math.min(fallback, COLD_DEFAULT);
    const ceiling = Math.min(cap, wash);
    const capped = ceiling < wash;
    return {
      ceiling,
      wash,
      cap,
      capped,
      history: false,
      why: capped
        ? `the cap of ${kTokens(cap)}`
        : `the ceiling of ${kTokens(ceiling)} (no history yet: today's numbers)`,
    };
  }
  const { price } = priceOf(model || measured.model);
  const start = measured.start;
  const turns = Math.max(1, measured.turns || 1);
  const wash = warm ? (start + shared) * (1 + price.write / (turns * price.read)) : start + shared;
  const ceiling = Math.min(cap, wash);
  const capped = ceiling < wash;
  return {
    ceiling,
    wash,
    cap,
    capped,
    history: true,
    start,
    turns,
    prices: price.name,
    why: capped
      ? `the cap of ${kTokens(cap)}`
      : `the ceiling of ${kTokens(ceiling)} worked out here (fresh start ${kTokens(start)}, ${turns} turns, ${kTokens(shared)} shared, ${price.name} prices)`,
  };
}
/** The prompt cache's life, and how long before its end a context counts as cold. */
const CACHE_TTL = 60 * MINUTE;
const WARM = CACHE_TTL - 5 * MINUTE;
/** How long a planner's question holds its plan from the executor ("Asked once"). */
export const ANSWER_WINDOW = 30 * MINUTE;
/**
 * How long after the window closes its deferred start runs: a timer can fire
 * a millisecond early, and a start that still found the plan held would drop it.
 */
const WINDOW_SLACK = 5000;
/** The agent a deferral's timer starts: a brief's lease (`handed`) is a planner's. */
const agentOfDeferral = (file) =>
  file === "planner" || file === "handed" ? "planner" : "executor";

/**
 * **A session's context and its age, from its transcript**: the last
 * assistant turn's `usage` (input, cache reads and cache writes) and its
 * time; null when the file is missing or holds no such turn. Reads the last
 * 512 KB; an error entry Claude Code writes itself (model `<synthetic>`, its
 * usage all zero) is passed over.
 */
export function sessionUsage(transcriptPath) {
  if (!transcriptPath) return null;
  let text = "";
  try {
    const size = statSync(transcriptPath).size;
    const fd = openSync(transcriptPath, "r");
    try {
      const length = Math.min(size, 512 * 1024);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = text.split("\n").reverse();
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // The first line read may be cut.
    }
    const u = entry?.type === "assistant" ? entry.message?.usage : null;
    if (!u || entry.message?.model === "<synthetic>") continue;
    const total =
      (u.input_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0);
    if (!total) continue;
    return {
      context: total,
      at: Date.parse(entry.timestamp) || 0,
      // Its prices, for the ceiling (decisions.md#reuse-check-cheap).
      ...(entry.message?.model ? { model: entry.message.model } : {}),
    };
  }
  return null;
}

/**
 * A live row's transcript: `~/.claude/projects/<cwd, each character not a
 * letter or digit a dash>/<id>.jsonl`, an executor's in its worktree's
 * folder; when that folder lacks it, the checkout's.
 * `WORKFLOW_PROJECTS` for the tests.
 */
export function transcriptOf(
  row,
  projects = process.env.WORKFLOW_PROJECTS || join(homedir(), ".claude", "projects"),
) {
  if (!row?.cwd || !row.sessionId) return "";
  const own = join(transcriptsDir(row.cwd, projects), `${row.sessionId}.jsonl`);
  const checkout = join(transcriptsDir(root, projects), `${row.sessionId}.jsonl`);
  return existsSync(own) || !existsSync(checkout) ? own : checkout;
}

/** This checkout's transcript folder, named as `transcriptOf` names it. */
export function transcriptsDir(
  cwd = root,
  projects = process.env.WORKFLOW_PROJECTS || join(homedir(), ".claude", "projects"),
) {
  return join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

/**
 * A checkout's transcript folder and those of its executors' worktrees
 * (`<folder>--claude-worktrees-executor-<n>`), the checkout's first: the
 * sessions the ceilings are measured from
 * (decisions.md#executors-in-worktrees).
 */
function transcriptFolders(folder) {
  const prefix = `${basename(folder)}--claude-worktrees-executor-`;
  let trees = [];
  try {
    trees = readdirSync(dirname(folder))
      .filter((name) => name.startsWith(prefix) && /^[1-9][0-9]*$/.test(name.slice(prefix.length)))
      .sort()
      .map((name) => join(dirname(folder), name));
  } catch {
    // No projects folder: the checkout's alone.
  }
  return [folder, ...trees];
}

/** How long a command takes the cached reuse inputs as they are; a hook, at any age. */
export const REUSE_REFRESH = 60 * MINUTE;

/**
 * **The reuse ceiling's inputs, measured and cached**
 * (decisions.md#reuse-check-cheap): the summary at `<data()>/reuse/<the
 * transcript folder's name>.json`, `{ measuredAt, rows: { <id>: row }, inputs
 * }`, this machine's and never the checkout's. A transcript whose `mtime` or
 * `size` differs from its row, or has none, is measured alone (`read`),
 * keeping its row when that read fails; the rows of files gone are dropped;
 * the file is written atomically. From a command (`refresh` false) a summary
 * measured under `REUSE_REFRESH` ago is taken as it is, nothing listed; `plans
 * cost` passes `refresh`. A hook passes `cachedOnly` (`hookRun`) and takes the
 * summary as it is, whatever its age, listing and reading nothing: a hook
 * never measures; when the summary is missing or `REUSE_REFRESH` old it calls
 * `stale` (`refreshLater`, which starts `plans cost --summary` in the
 * background, this measuring alone and no report, and does not wait, at most
 * once an hour), and with no summary the ceilings are the defaults, said as
 * such; `plans`, `plans start` and `plans cost` keep the summary fresh. No
 * folder, or a read that fails: what the cache holds, or none.
 */
export function reuseInputs({
  refresh = false,
  cachedOnly = false,
  stale = null,
  now = Date.now(),
  dir = transcriptsDir(),
  file = join(data(), "reuse", `${basename(dir)}.json`),
  read = measureFile,
} = {}) {
  const cached = readJson(file);
  if (cachedOnly) {
    if (!(cached?.measuredAt && now - cached.measuredAt < REUSE_REFRESH)) stale?.(file);
    return cached?.inputs || {};
  }
  const rows = cached?.rows && typeof cached.rows === "object" ? cached.rows : {};
  if (!refresh && cached?.measuredAt && now - cached.measuredAt < REUSE_REFRESH)
    return cached.inputs || {};
  // The summary is named for the checkout's folder and covers its
  // executors' worktrees' too; no folder read at all keeps what it held.
  const paths = [];
  let readAny = false;
  for (const folder of transcriptFolders(dir))
    try {
      for (const name of readdirSync(folder))
        if (name.endsWith(".jsonl")) paths.push(join(folder, name));
      readAny = true;
    } catch {
      // A folder not there yet.
    }
  if (!readAny) return cached?.inputs || {};
  const next = {};
  for (const path of paths) {
    const id = basename(path).replace(/\.jsonl$/, "");
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    const old = rows[id];
    if (old && old.mtime === stat.mtimeMs && old.size === stat.size) {
      next[id] = old;
      continue;
    }
    // A transcript that cannot be read now keeps the row it had, with its old
    // stat, so the next refresh reads it again.
    const row = read(path) || (old?.agent ? old : null);
    if (row) next[id] = row;
  }
  // When and over how many transcripts, which `plans` says beside the ceilings.
  const inputs = {
    ...inputsOf(Object.values(next)),
    measured: { at: now, transcripts: Object.keys(next).length },
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeJson(file, { measuredAt: now, rows: next, inputs });
  } catch {
    // A summary that cannot be written is measured again next time.
  }
  return inputs;
}

/** Whether this run is one of Claude Code's hooks, by the mode `hooks.json` gives it. */
export function hookRun(argv = process.argv) {
  return HOOK_MODES.includes(argv[2]);
}

/**
 * **A hook refreshes the summary in the background**
 * (decisions.md#reuse-check-cheap): starts `plans cost --summary`, this script
 * measuring the reuse inputs alone with its output discarded, detached, once
 * it has created the marker `<summary>.refreshing` beside `file`, with the
 * time, atomically (`wx`): a marker that exists is another hook's refresh, and
 * while it is under `REUSE_REFRESH` old nothing starts, so a refresh that
 * cannot write the summary is tried at most hourly. An older marker is removed
 * and created again; two hooks replacing it at one moment may both start a
 * refresh, which is harmless: each writes the same summary atomically. The
 * refresh leaves the marker: its new `measuredAt` makes the next hook start
 * nothing. True when started.
 */
export function refreshLater(
  file,
  { now = Date.now(), spawner = detached, script = join(here, "plan-queue.mjs") } = {},
) {
  const marker = file.replace(/\.json$/, ".refreshing");
  const create = () => {
    try {
      writeFileSync(marker, String(now), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };
  try {
    mkdirSync(dirname(marker), { recursive: true });
  } catch {
    return false;
  }
  if (!create()) {
    let at;
    try {
      // A marker another hook has created and not yet written is its mtime's.
      at = Number(readFileSync(marker, "utf8")) || statSync(marker).mtimeMs;
    } catch {
      return false;
    }
    if (now - at < REUSE_REFRESH) return false;
    try {
      unlinkSync(marker);
    } catch {
      // Removed by another hook at the same moment: one of the two creates it.
    }
    if (!create()) return false;
  }
  try {
    spawner(process.execPath, [script, "cost", "--summary"], {
      ...process.env,
      WORKFLOW_ROOT: root,
    });
  } catch {
    return false;
  }
  return true;
}

let reuseRead = null;
/**
 * The reuse inputs, read once a run: a hook's from the summary alone, with a
 * background refresh when it is missing or an hour old; a command's measured
 * when the summary is an hour old (`reuseInputs`).
 */
function reuseNow() {
  if (!reuseRead) reuseRead = reuseInputs({ cachedOnly: hookRun(), stale: refreshLater });
  return reuseRead;
}

/**
 * **`plans cost`**: this checkout's transcripts, or a folder's, since a day
 * when given, then the reuse inputs refreshed and the report. With
 * `--summary`, the queue's own argument to itself (`refreshLater`), it
 * refreshes the reuse inputs alone and prints nothing: no transcript is priced
 * for a report nobody sees (decisions.md#reuse-check-cheap).
 */
export function costCommand(
  rest = [],
  {
    measureAll = measure,
    refreshInputs = reuseInputs,
    write = (text) => process.stdout.write(text),
  } = {},
) {
  const summary = rest.includes("--summary");
  const args = rest.filter((arg) => arg !== "--summary");
  const at = args.indexOf("--since");
  const since = at >= 0 ? args[at + 1] || "" : "";
  if (at >= 0 && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    write("plans cost --since takes a day as yyyy-mm-dd.\n");
    process.exitCode = 1;
    return;
  }
  // Resolved, so the reuse summary is keyed by the folder's own name.
  const given = args.filter((_, i) => at < 0 || (i !== at && i !== at + 1))[0];
  const folder = given ? resolve(given) : transcriptsDir();
  if (summary) {
    refreshInputs({ refresh: true, dir: folder });
    return;
  }
  const rows = transcriptFolders(folder).flatMap((one) => measureAll(one, { since }));
  const home = homedir();
  const shown = folder.startsWith(`${home}/`) ? `~${folder.slice(home.length)}` : folder;
  // **The reuse inputs, refreshed** (decisions.md#reuse-check-cheap), and
  // each agent's ceiling from them, which the report says after its line.
  const inputs = refreshInputs({ refresh: true, dir: folder });
  const reuse = Object.fromEntries(
    ["executor", "planner"].map((kind) => {
      const warm = ceilingFor({ kind, inputs, fallback: proj().reuse[kind] });
      const cold = ceilingFor({ kind, inputs, fallback: proj().reuse[kind], warm: false });
      return [kind, { ...inputs[kind], warm, cold }];
    }),
  );
  write(`${costWords(rows, { reuse, machine: machine().name, since, dir: shown }).join("\n")}\n`);
}

/** "14:32", a time as the queue's lines say it. */
function hhmm(at) {
  return new Date(at).toTimeString().slice(0, 5);
}

/**
 * **Asked once** (docs/workflow.md, "The queue"): the planner holding a plan
 * that asks the owner, while its question is under thirty minutes old. For a
 * ready plan that asks, the live row the queue counts as a planner whose
 * state names the plan (its `brief`, or one of its `plans`) and whose window
 * on it opened under `ANSWER_WINDOW` before `now`: `{ row, until }`, `until`
 * the time the window closes. The window opens at the plan's question, which
 * the planner's tool hook records per plan (`asked`), so talking does not
 * restart it; before any question it opens when the plan was written
 * (`mtime`), since the planner writes the plan and then asks. Null otherwise.
 */
export function askingIn(plan, live, { stateFor = readState, now = Date.now() } = {}) {
  if (!plan || !ASKS_STATES.includes(plan.state) || !plan.asks || !live) return null;
  for (const row of live) {
    const state = withPlans(stateFor(row.sessionId));
    if (!isSession("planner", row, state, null)) continue;
    if (state?.brief !== plan.path && !(state?.plans || []).includes(plan.path)) continue;
    const at = windowOpened(state, plan);
    if (at && now - at < ANSWER_WINDOW) return { row, until: at + ANSWER_WINDOW };
  }
  return null;
}

/**
 * A planner's question for the owner, sent to the assistant chat, by its
 * first line: `Question for <owner>: plans/<x>.md.` (decisions.md#one-chat).
 */
const QUESTION_FOR = /^Question for [^:\n]+: (plans\/[^\s]+?\.md)\.\s*(?:\n|$)/;

/** When a plan's window opened: its question, or before any, when the plan was written. */
function windowOpened(state, plan) {
  return state?.asked?.[plan.path] || plan.mtime || 0;
}

/** A plan's modification time, or 0 when it is gone. */
function mtimeOf(path) {
  try {
    return statSync(join(root, path)).mtimeMs;
  } catch {
    return 0;
  }
}

/** The plans with `askingIn` set on each, for the callers that have the live rows in hand. */
function withAsking(plans, live, options = {}) {
  return plans.map((plan) => ({ ...plan, askingIn: askingIn(plan, live, options) }));
}

/**
 * The text an Edit, Write or MultiEdit leaves in a file whose text is
 * `before`; `before` when an edit's old string is not there, since that edit
 * fails and changes nothing.
 */
export function editedText(toolName, toolInput = {}, before = "") {
  if (toolName === "Write") return String(toolInput?.content ?? before);
  const edits =
    toolName === "MultiEdit" ? toolInput?.edits || [] : toolName === "Edit" ? [toolInput] : [];
  let text = before;
  for (const edit of edits) {
    const from = String(edit?.old_string ?? "");
    const to = String(edit?.new_string ?? "");
    if (!from) {
      // An empty old string writes a new file, and only a new one.
      if (text) return before;
      text = to;
      continue;
    }
    if (!text.includes(from)) return before;
    text = edit.replace_all ? text.split(from).join(to) : text.replace(from, () => to);
  }
  return text;
}

const BUILDING_LINE = /^## Building, [^\n]*/gm;
/** A Building line with its line end, to take it out. */
const BUILDING_WHOLE = /^## Building, [^\n]*\n?/gm;
/** The Building line `sessionId` wrote, naming it whole or by a start of eight or more. */
export function buildingBy(sessionId) {
  return new RegExp(`^## Building, [^,\\n]+, session ${sessionIdSource(sessionId)}`, "m");
}

/** The Building lines `after` has that `before` has not. */
export function buildingAdded(before = "", after = "") {
  const had = new Set(before.match(BUILDING_LINE) || []);
  return (after.match(BUILDING_LINE) || []).filter((line) => !had.has(line));
}

/**
 * **A plan still asking is not taken, even by mistake**
 * (decisions.md#asked-once): `askingIn` on the plan as it would stand
 * without its Building lines, so the line under judgement does not make it
 * "building" and let itself through. A "Decided" section lets it go, as it
 * does every other hold. `{ row, until }` or null.
 */
function heldFromBuilding(path, text, live, { mtime = 0, ...options } = {}) {
  const state = stateOf(text.replace(BUILDING_WHOLE, ""), { mtime });
  // **A planned plan waits for Ready**.
  if (state?.state === "planned") return { planned: true, issue: state.issue };
  return state ? askingIn({ path, ...state }, live, options) : null;
}

/** The refusal of a Building line on a plan `heldFromBuilding` holds, in the start's words. */
function holdWords(path, held) {
  return held.planned ? plannedWords({ path, issue: held.issue }) : stillAskingWords(path, held);
}

/** The refusal of a Building line on a plan still asking, its time the one `plans` prints. */
function stillAskingWords(path, { until }) {
  const at = hhmm(until);
  return `${path} is still asking ${owner()} (its planner's until ${at}): build the other plans first, and come back to it after ${at}, or once its "Decided" says ${owner()} wants it built now.`;
}

/**
 * **A plan put first is built next** (decisions.md#plan-put-first): the ready
 * plans, not asking, put first, other than `path`, that the queue puts before
 * it: every one when `path` is not put first, else those put first later.
 * `plans` is `readPlans(...)`; `path`'s own mark is read from its text, so a
 * plan whose Building line is written already is judged by it. **Asking is the
 * hook's own reading**: a plan put first counts only when `heldFromBuilding`
 * does not hold it with `live` at `timeOf(plan)`, the time the calling hook
 * judges that plan's own Building line by, so a plan refused as still asking
 * never holds the rest.
 */
function firstAhead(
  path,
  plans,
  { live = null, timeOf = (plan) => plan.mtime, sessionId = "" } = {},
) {
  const own = plans.find((p) => p.path === path);
  // **A handed-over plan is finished first**: resumed, it is the build in
  // the middle, never out of turn.
  if (own && /^## (?:Handing over\b|Resumed, )/m.test(withoutFences(own.text || ""))) return [];
  const mine = own ? firstOf(own.text || "") : null;
  // A plan put first that waits on another, or that another executor has
  // claimed, is no plan this one is out of turn against.
  const claims = readClaims(plans, live);
  const waiting = new Set(
    freePlans(plans, { claims })
      .filter((p) => p.waitsOn)
      .map((p) => p.path),
  );
  return plans.filter(
    (p) =>
      p.path !== path &&
      p.state === "ready" &&
      p.first &&
      (!mine || p.first.at > mine.at) &&
      !waiting.has(p.path) &&
      !(claims[p.path] && !holdsClaim(claims[p.path], sessionId, live)) &&
      !heldFromBuilding(p.path, p.text || "", live, { mtime: timeOf(p) }),
  );
}

/** The refusal of a Building line on `path` while `ahead`, a plan put first, waits. */
function outOfTurnWords(path, ahead) {
  return `${ahead.path} is first (${firstWords(ahead).replace(/^first /, "")}): build it before ${path}. Only ${owner()}'s word, through the assistant chat, changes the order.`;
}

/**
 * "plans/x.md asks Javi through the assistant chat until 14:32: ...", the
 * start's refusal of a held plan: he answers only in the assistant chat
 * (decisions.md#one-chat), not in the planner's, which he cannot open.
 */
function askingWords(plan) {
  return `${plan.path} asks ${owner()} through the assistant chat until ${hhmm(plan.askingIn.until)}: he answers in the assistant chat, or the executor takes it then and decides by the recommended options.`;
}

/**
 * **One reuse rule, each agent held to the ceiling worked out for it**
 * (decisions.md#reuse-check-cheap): a finished session takes the next plan
 * or brief when its context is under `ceilingFor`'s ceiling for that work
 * (`shared`, the tokens the work shares with it), and, its cache cold, under
 * the cold ceiling too: every turn re-reads the whole context at the
 * cache-read price, and a fresh session writes its start and the reading it
 * shares at the write price. `kind` the agent, `inputs` what `reuseInputs`
 * measured, `fallback` the project file's number for it, `model` the
 * session's (its usage's, else the agent's commonest here). With no usage
 * known, it is kept. `{ reuse, why }` either way.
 */
export function mayReuse({
  usage = null,
  shared = 0,
  inputs = {},
  kind = "executor",
  model = usage?.model || "",
  fallback = REUSE_DEFAULT[kind] || REUSE_DEFAULT.executor,
  now = Date.now(),
}) {
  if (!usage) return { reuse: true, why: "no context known" };
  const warm = ceilingFor({ kind, inputs, model, shared, fallback });
  const context = `its context is ${kTokens(usage.context)} tokens`;
  if (usage.context > warm.ceiling) return { reuse: false, why: `${context}, over ${warm.why}` };
  if (
    usage.at &&
    now - usage.at > WARM &&
    usage.context > ceilingFor({ kind, inputs, model, shared, fallback, warm: false }).ceiling
  )
    return {
      reuse: false,
      why: `its cache has gone cold after ${Math.round((now - usage.at) / MINUTE)} minutes idle, and rewriting ${kTokens(usage.context)} tokens costs more than a fresh start`,
    };
  return { reuse: true, why: `${context}, under ${warm.why}` };
}

/**
 * A row whose turn is over with no prompt open: `state` done, or `state`
 * blocked while `statusOf` reads it `idle`, Claude Code's reading of the last
 * turn's text and not a prompt on screen
 * (decisions.md#waiting-is-an-open-prompt).
 */
function finished(row) {
  // A question or a prompt standing is never finished, whatever `state` says
  // (decisions.md#plan-put-first, "A finished chat ends an hour after it goes
  // quiet").
  if (statusOf(row).startsWith("waiting for input")) return false;
  return row.state === "done" || (row.state === "blocked" && statusOf(row) === "idle");
}

/**
 * **A finished chat ends when its cache has gone cold**: a background session
 * the queue counts as its own, whose turn is over with no prompt open
 * (`finished`: a question or a prompt standing keeps it, `working` is a turn),
 * whose last turn is older than the cache's warm span, with no plan or brief
 * under way (`on`). A planner's plans still in the queue keep nothing: each
 * stands alone in its file. `force` (`plans end`) ends a warm one too.
 * **`immediate` (`plans end <id> --now`) ends any background session of the
 * queue, whatever its state** (decisions.md#end-now): a chat stuck in a turn
 * could never be ended otherwise; the plan or brief it has under way comes back
 * as `on`, for the caller to hand over. `{ end: true, on? }` or `{ end: false,
 * why }`.
 */
export function decideEnd({
  row,
  usage = null,
  on = "",
  now = Date.now(),
  force = false,
  immediate = false,
}) {
  if (!row || row.kind !== "background")
    return { end: false, why: "it is not a background session of the queue" };
  if (immediate) return on ? { end: true, on } : { end: true };
  if (!finished(row))
    return {
      end: false,
      why:
        row.state === "done"
          ? "a question or a prompt is open in it"
          : `its state is ${row.state || "unknown"}`,
    };
  if (on) return { end: false, why: `it has ${on} under way` };
  // With no usage known, the timer fired an hour after the Stop that armed it.
  if (!force && usage && usage.at && now - usage.at <= WARM)
    return { end: false, why: "its cache is still warm" };
  return { end: true };
}

/**
 * What the Stop hook answers, decided from facts alone: `{refuse, reason}`,
 * `{retire, paths}` (a fresh executor takes them), `{handover, plan}` (a
 * fresh executor resumes it), `{context}` (pass, with words for the model),
 * or null to pass. With plans waiting, the reuse verdict comes first, on all
 * of them, told or not; a plan told and still waiting then retires the
 * session; the plans not yet told are named only when it says yes.
 */
export function decideStop({
  waiting = [],
  handed = [],
  run = null,
  told = [],
  paused = false,
  retired = false,
  current = null,
  continuing = false,
  refusedRun = null,
  usage = null,
  inputs = {},
  fallback = REUSE_DEFAULT.executor,
  now = Date.now(),
  carry = [],
}) {
  if (retired) return null;
  // **A red or unfinished run refuses the first stop of every turn**; a pull
  // request's checks only red, as `pullChecks` gives them. On a
  // stop the turn reached by continuing after a stop hook (`stop_hook_active`,
  // `continuing`), only a run other than the one last refused (`refusedRun`):
  // that is the loop guard, with Claude Code's own cap, and a new push's run
  // is still asked about. The rest decides on any stop: the plans have `told`.
  const askedAlready = continuing && refusedRun === run?.id;
  if (
    run &&
    !askedAlready &&
    run.onHead &&
    !(run.status === "completed" && run.conclusion === "success") &&
    !(run.pull && run.status !== "completed")
  ) {
    const how = run.status === "completed" ? "failed" : "in progress";
    // **A pull request's failed checks, in the pull request mode** (`land:
    // pull-request`) that no webhook brings to the assistant: every one with
    // no webhook, another service's (`other`) with one; running ones are
    // never waited on (decisions.md#push-not-waited-on).
    if (run.pull) {
      const n = run.pull.number;
      const also = run.pull.also || [];
      const first = run.pull.other
        ? `A check by another service on pull request #${n} (${run.pull.url}) has failed, and the webhook brings only Actions runs to the assistant. Read it (\`gh pr checks ${n} --json name,state,link\`), fix it and push the branch; the new checks are not waited on.`
        : `The checks on pull request #${n} (${run.pull.url}) have failed, and no webhook brings that to the assistant here. Read the failed job's log (\`gh run view <run id> --log-failed\`, the id from \`gh pr checks ${n} --json link\`), fix it and push the branch; the new checks are not waited on.`;
      return {
        refuse: true,
        runId: run.id,
        reason: `${first}${also.length ? ` ${also.length === 1 ? "Pull request" : "Pull requests"} ${andList(also.map((m) => `#${m}`))} ${also.length === 1 ? "has" : "have"} failed checks too.` : ""}${run.pull.run ? ` The ${run.pull.run.workflow || "Actions"} run on your push (${run.pull.run.id}) is ${run.pull.run.status === "completed" ? "failed" : "in progress"} too: \`gh run watch ${run.pull.run.id} --exit-status\`.` : ""}`,
      };
    }
    return {
      refuse: true,
      runId: run.id,
      reason: `The ${run.workflow || "Actions"} run on your push (${run.id}) is ${how}. Read it before you stop: \`gh run watch ${run.id} --exit-status\`, then on a failure the job's log (\`gh api repos/{owner}/{repo}/actions/jobs/<job>/logs\`), fix it, push, and read the new run. A green push is not a deploy until the run says so.`,
    };
  }
  // **A brief for the project a plan came from is written before the stop**
  // (decisions.md#leave-back-as-brief), refused once per section, as "The
  // audit's checks" are.
  const owed = carry.find((one) => one.missing && !told.includes(`for:${one.path}:${one.file}`));
  if (owed)
    return {
      refuse: true,
      told: [`for:${owed.path}:${owed.file}`],
      reason: owed.missing === "from" ? fromMissingWords(owed) : briefMissingWords(owed),
    };
  // A session with a plan of its own still being built is not done: it is
  // neither handed more nor retired until it writes Built or hands it over.
  if (paused || current) return null;
  const stuck = handed.find((plan) => plan.stuck);
  const resumable = handed.find((plan) => !plan.stuck);
  if (resumable) return { handover: resumable };
  if (stuck && !told.includes(stuck.path)) {
    const why =
      stuck.resumed.length >= MAX_HANDOVERS
        ? `this plan has been handed over ${stuck.resumed.length} times`
        : `this plan was handed over twice at step ${stuck.resumed.at(-1)}; it is stuck there`;
    return {
      context: `${stuck.path} is not handed over again: ${why}. Write its "Built" section with "Needs a decision: ${why}", sized planner, and hand it to the assistant as the agent file's "The final message" says; ${owner()} is not asked.`,
      told: [stuck.path],
    };
  }
  // **The ceiling is judged at every stop while plans wait**
  // (decisions.md#executor-pool): the plans the session was already named
  // included, so a session named plans under the ceiling and over it at a
  // later stop is retired on all of them; only the untold ones are named
  // when it may go on. Each plan is judged with what it shares with the
  // batch (decisions.md#reuse-check-cheap, `shared`), over the plans not
  // yet named when there are any, else over all: a session that declined a
  // plan it had room for is not kept for it while one it has no room for
  // waits (Javi).
  if (!waiting.length) return null;
  const fresh = waiting.filter((plan) => !told.includes(plan.path));
  const judge = (plan) =>
    mayReuse({ usage, shared: plan.shared || 0, inputs, kind: "executor", fallback, now });
  const pool = (fresh.length ? fresh : waiting).map((plan) => ({ plan, verdict: judge(plan) }));
  if (!pool.some(({ verdict }) => verdict.reuse))
    return { retire: true, paths: waiting.map((plan) => plan.path), why: pool[0].verdict.why };
  // **A plan named and not taken goes to a fresh executor**
  // (decisions.md#plans-reach-an-executor), as a brief goes to a fresh
  // planner: this live executor refuses every start, so a plan it was named
  // and stopped without taking would otherwise wait for good. Whatever its
  // context, the session is retired on every waiting plan, the ones that
  // arrived since included.
  const declined = waiting.filter((plan) => told.includes(plan.path));
  if (declined.length)
    return {
      retire: true,
      declined: true,
      paths: waiting.map((plan) => plan.path),
      why:
        declined.length === 1
          ? "the plan named at the last stop is still waiting, untaken"
          : "the plans named at the last stop are still waiting, untaken",
    };
  // **Kept for the plans it has room for**, those are taken, and the rest go
  // to a fresh executor at the next stop.
  const taken = pool.filter(({ verdict }) => verdict.reuse);
  const paths = taken.map(({ plan }) => plan.path);
  const why = taken[0].verdict.why;
  return {
    refuse: true,
    told: paths,
    kept: { paths, why },
    reason: `A plan is waiting and this session can take it: ${taken.map(({ plan }) => annotate(plan)).join(", ")} (${why}). Build it next.`,
  };
}

/** The Stop hook's words when a plan's brief for its project is not in that project's `plans/`. */
function briefMissingWords({ path, project, file, checkout }) {
  const there = checkout.replace(/\/+$/, "");
  return `${path} leaves work for ${project} (its section "For ${project}: ${file}") and ${there}/${file} is not written. Write the brief there from the section, by your agent file, and start that queue: cd ${there} && plans start --agent planner ${file}, or what its line says to do; then say so in "Built". A change the plugin leaves for the project it came from goes back as a brief.`;
}

/** The Stop hook's words when a plan's `For` section has no `From` line naming its project. */
function fromMissingWords({ path, project, file }) {
  return `${path} leaves work for ${project} (its section "For ${project}: ${file}") but names no checkout for it: no From line, or one for another project. Add "From: ${project}, <path>." under the plan's header paragraph when the brief says where it came from, else hand the section to the assistant as a "Needs a decision" item sized assistant, and say so in "Built".`;
}

/**
 * Whether a brief naming `path` is in `checkout`: at `file`, or, when that
 * name is another's, at the first `<topic>-<n>.md` the executor wrote
 * instead. A file of the name that does not name the plan is no brief of its;
 * nothing else is read from the other checkout.
 */
function briefThere(checkout, file, path, read = (at) => readFileSync(at, "utf8")) {
  const stem = file.replace(/\.md$/, "");
  for (let n = 1; n <= 20; n++) {
    let text;
    try {
      text = read(join(checkout, n === 1 ? file : `${stem}-${n}.md`));
    } catch {
      return false;
    }
    if (text.includes(path)) return true;
  }
  return false;
}

/**
 * **The briefs this session's built plans owe their projects**
 * (decisions.md#leave-back-as-brief): one entry per `For` section, `missing`
 * "from" with no `From` line for its project, "file" while no brief naming
 * the plan is in that checkout's `plans/`, else "".
 */
export function carryOf(plans, { read } = {}) {
  return plans.flatMap((plan) =>
    (plan.carries || []).map(({ project, file }) => {
      const from = plan.from && plan.from.project === project ? plan.from : null;
      const checkout = from?.path || "";
      const missing = !from ? "from" : briefThere(checkout, file, plan.path, read) ? "" : "file";
      return { path: plan.path, project, file, checkout, missing };
    }),
  );
}

/** The windows above their threshold that have not reset yet: a number written before its reset says nothing after it. */
function windowOver(usage, now = Date.now()) {
  const over = [];
  const open = (window) => window && window.resets_at * 1000 > now;
  const five = usage?.five_hour;
  const seven = usage?.seven_day;
  if (open(five) && five.used_percentage > FIVE_HOUR_MAX) over.push(["five-hour", five]);
  if (open(seven) && seven.used_percentage > SEVEN_DAY_MAX) over.push(["seven-day", seven]);
  return over;
}

/**
 * Whether an executor, or with `kind: "planner"` a planner, may start now:
 * `{start, name, note}`, `{defer, until, why}` or `{refuse, why}`. `log` is
 * the starts' log (both kinds, told apart by name), `progressAt` the newest
 * Building, Handing over, Built or plan in the plans, `usage` the status
 * line's numbers with their `at` (epoch seconds), `sessions` the live,
 * unretired sessions of the kind, `taken` the names of this machine's live
 * sessions, `machine` this machine's label. The usage windows and the
 * pause are shared.
 */
export function canStart({
  kind = "executor",
  lock = null,
  alive = pidAlive,
  log: all = [],
  progressAt = 0,
  now = Date.now(),
  paused = false,
  usage = null,
  sessions = [],
  brief = "",
  name = "",
  fallback = REUSE_DEFAULT[kind] || REUSE_DEFAULT.executor,
  inputs = {},
  taken = [],
  machine = "",
  unwatched = false,
  open = [],
  said = "",
  elsewhere = [],
  unread = false,
}) {
  // **Session names carry the project and the machine** (`Docs Executor 2
  // (lab)`), and the count is per project and per machine (the log is this
  // machine's), so two projects' executors number apart and two machines'
  // sessions never share a name (decisions.md#session-names).
  const ours = (one) => {
    const parsed = parseName(one || "");
    return parsed && parsed.project === name && parsed.kind === kind ? parsed : null;
  };
  // The assistant's starts are logged under its one name.
  const assistantName = sessionName("assistant", 0, { project: name });
  const log = all.filter((line) =>
    kind === "assistant" ? line.name === assistantName : ours(line.name),
  );
  if (paused)
    return {
      refuse: true,
      why: `The queue is paused since ${paused} ("resume the queue" in any session lifts it).`,
    };
  // **An assistant chat is opened only when none is open**
  // (decisions.md#one-chat): the one open, idle or busy, is sent the message
  // instead, and it is never replaced.
  if (kind === "assistant") {
    if (open.length)
      return {
        refuse: true,
        why: `${open[0]} is open: send it the message.${brief && brief !== ASSISTANT_HANDOVER ? ` ${isNote(brief) ? githubPrompt(brief) : assistantPrompt(brief)}` : ""}`,
      };
    sessions = [];
  }
  // **Any live, unretired session of the kind refuses a start, lock or not**.
  // The lock below is an executor's only evidence when the sessions cannot be
  // read. **A stale session does not block its successor** (cache-aware queue):
  // one whose context is over its reuse ceiling, or cold, is replaced when
  // idle; a busy planner so is left to finish, and a fresh one starts beside
  // it. A busy executor, or any session still worth reusing, refuses.
  // A session is judged with what the work shares with it
  // (decisions.md#reuse-check-cheap, `shared`, set by `startHere`). An executor
  // with a plan under way (its Building line) is never stale: replacing it
  // would orphan that work. **A planner is judged by what it can do now**
  // (decisions.md#brief-leased): one with a question or a prompt open takes
  // nothing until he answers, one with no process takes nothing at all
  // (decisions.md#waiting-is-an-open-prompt), and one mid-brief over its
  // ceiling for this brief would be retired at its next stop, so each gets a
  // fresh planner beside it. **A start nobody is watching** (`unwatched`, a
  // timer's) replaces an idle session whatever its warmth: the queue sends a
  // message to the assistant chat alone (`tellAssistant`), so the work it is
  // started for would otherwise wait on a chat nobody prompts. **An executor with no process is not alive**
  // (decisions.md#plan-put-first): it takes nothing, so it is replaced, its
  // plan handed over by `startHere`; a planner so is started beside.
  const idle = (one) => /^idle\b/.test(one.status || "");
  const work = kind === "planner" ? "brief" : "plan";
  const stale = (one) => {
    if (kind === "planner" && /^waiting for input\b/.test(one.status || ""))
      return {
        reuse: false,
        why: `a question or a prompt is open in its chat, and it takes nothing until ${owner()} answers it`,
      };
    if (one.status === "not running") return { reuse: false, why: "its process is not running" };
    if (kind !== "planner" && one.on) return { reuse: true };
    if (unwatched && idle(one))
      return {
        reuse: false,
        why: `idle while a ${work}'s thirty minutes ran out, and the queue cannot message it`,
      };
    return mayReuse({ usage: one.usage, shared: one.shared || 0, inputs, now, fallback, kind });
  };
  let replace = [];
  let beside = [];
  if (sessions.length && sessions.every((one) => !stale(one).reuse)) {
    // An idle planner with a brief under way is started beside, not replaced:
    // retiring it would orphan that brief. So is one that holds a plan no
    // Building line has taken yet, at the timer too: "A chat holds every plan
    // it wrote until a Building line takes it" (docs/workflow.md, "A planner
    // with room left takes the next brief"). A plan whose standing is not
    // known is not counted: every path a planner holds has one where the
    // queue reads its sessions. An old plan no Building line will take
    // either. A plan whose file the queue cannot read (`not read by the
    // queue`) is held, by the same rule: no Building line has taken it.
    const untaken = (state) =>
      Boolean(state) &&
      !["built", "dropped", "gone", "old"].includes(state) &&
      !state.startsWith("building");
    const holding = (one) =>
      kind === "planner" && (one.holds || []).some((path) => untaken(one.standing?.[path]));
    const kept = (one) =>
      kind === "executor" && one.status === "not running"
        ? false
        : !idle(one) || Boolean(one.on) || holding(one);
    const busy = sessions.filter(kept);
    if (!busy.length || kind === "planner") {
      replace = sessions
        .filter((one) => !kept(one))
        .map((one) => ({ ...one, why: stale(one).why }));
      beside = busy.map((one) => ({ ...one, why: stale(one).why }));
      sessions = [];
    }
  }
  if (sessions.length) {
    const first = sessions[0];
    const alive = sessions.map(describeSession).join("; ");
    // **A brief left with a live planner is leased to it**
    // (decisions.md#brief-leased): an idle one with room is sent the brief by
    // message, which starts its turn and its prompt hook; a busy one is sent
    // nothing, since a message reaches a busy chat between its tool calls,
    // where no hook judges it, and its Stop hook names the next brief. Either
    // way it has thirty minutes to take it.
    if (kind === "planner") {
      const room = sessions.filter((one) => stale(one).reuse);
      const taker = room.find(idle) || room[0];
      const path = brief || "plans/<topic>.md";
      const who = `${taker.name} [${String(taker.sessionId).slice(0, 8)}]`;
      const until = ` It has until ${hhmm(now + ANSWER_WINDOW)} to take it; then a fresh planner is started on it.`;
      const planning = taker.on ? `, planning ${taker.on}` : "";
      // **Each brief its own lease** (decisions.md#brief-leased): its holder,
      // whether it was sent by message, and the time printed.
      const leased = { holder: taker.sessionId, until: now + ANSWER_WINDOW };
      return idle(taker)
        ? {
            wait: true,
            why: `${who} is idle with room for ${path} (${stale(taker).why}): send it the brief with SendMessage, one message per brief: ${plannerPrompt(path)}${until}`,
            lease: `handed to ${who} at ${hhmm(now)} by message`,
            ...leased,
            held: true,
          }
        : {
            wait: true,
            why: `${who} is ${taker.status}${planning}, with room for ${path} (${stale(taker).why}): its Stop hook names the next brief waiting, so nothing is sent.${until}`,
            lease: `waiting for ${who} since ${hhmm(now)}${planning}`,
            ...leased,
            held: false,
          };
    }
    // Archiving in the Claude app hides the chat and leaves the process
    // running, so the id an agent ends it by stays.
    return {
      refuse: true,
      why: `An executor is alive: ${alive}. Have the assistant message it, or end it with plans end ${String(first.sessionId).slice(0, 8)} --now if it is stuck, then start again.`,
    };
  }
  const replacing = new Set(replace.map((one) => one.sessionId));
  if (
    kind === "executor" &&
    lock &&
    !lock.released &&
    !replacing.has(lock.sessionId) &&
    alive(lock.pid)
  ) {
    // The chats could not be read only when `claude agents` did not answer;
    // a holder read but filtered out (retired, another number's worktree)
    // is ended as the refusal above says.
    const who = `${lock.name || "an executor"} [${String(lock.sessionId).slice(0, 8)}]`;
    return {
      refuse: true,
      why: unread
        ? `An executor is alive: ${who}, and the chats could not be read: start again once plans lists them.`
        : `An executor is alive: ${who}. Have the assistant message it, or end it with plans end ${String(lock.sessionId).slice(0, 8)} --now if it is stuck, then start again.`,
    };
  }
  let note = "";
  const fresh = usage && usage.at && now - usage.at * 1000 <= USAGE_STALE;
  if (!fresh) {
    note = usage?.at
      ? `Usage unknown: the status line has not written since ${hhmm(usage.at * 1000)}.`
      : "Usage unknown: the status line has not written the usage file.";
  } else {
    const over = windowOver(usage, now);
    if (over.length) {
      const [name, window] = over.reduce((a, b) => (b[1].resets_at > a[1].resets_at ? b : a));
      return {
        defer: true,
        until: (window.resets_at + AFTER_RESET) * 1000,
        why: `the ${name} window is at ${Math.round(window.used_percentage)} percent`,
      };
    }
  }
  // **The two refusals the owner decides** (decisions.md#starts-bounded): a
  // quick death, and the last five starts of the kind in a day all made
  // since the newest progress, a circuit breaker's failures in a row. A
  // busy day of sessions that each did something is never a loop; among the
  // five, a start whose session is still at work (one this start goes
  // beside) has not ended. With his word (`said`) neither refuses: the
  // decision carries `past`, the finding of the first that would have.
  const done = { planner: "planned", assistant: "written" }[kind] || "built";
  // A planner's or an assistant's start names its agent, as `plans start
  // --agent planner <brief>` does, so the command it gives starts the same
  // kind.
  const agentFlag = kind === "executor" ? "" : `--agent ${kind} `;
  const decides = `${owner()} decides: a yes starts one more, by plans start ${agentFlag}--owner-said "<the words>".`;
  const findings = [];
  // Nor an executor at work in another number.
  const going = new Set([...beside.map((one) => one.name), ...elsewhere]);
  const last = log.filter((line) => !going.has(line.name)).at(-1);
  if (last && now - last.at < QUICK_DEATH && progressAt <= last.at)
    findings.push(
      `The last ${kind} (${last.name}) ended within ten minutes with nothing ${done}, and usage was not the cause; starting another would repeat it.`,
    );
  const since = log.filter(
    (line) => now - line.at < 24 * 60 * MINUTE && progressAt <= line.at && !going.has(line.name),
  );
  // The assistant is bounded by usage and a quick death alone: it is his one chat.
  if (since.length >= LOOP_RUN && kind !== "assistant")
    findings.push(`The last five ${kind}s ended with nothing ${done}; something is looping.`);
  if (findings.length && !said) return { refuse: true, why: `${findings[0]} ${decides}` };
  // From 1 in a project with none started yet. The live list counts too: the
  // log can be reset (a marketplace move) while a session it named is still
  // alive. **A start holds its name** from here until it is logged
  // (`holdName`), so a second start at the same moment, numbering again
  // under its guard, never takes it (plans/overlapping-starts-own-names.md).
  const besideNote = beside
    .map(
      (one) =>
        `Started beside ${one.name} [${String(one.sessionId).slice(0, 8)}], which is ${one.status} with a context of ${Math.round((one.usage?.context || 0) / 1000)}k (${one.why}).`,
    )
    .join(" ");
  return {
    start: true,
    name:
      kind === "assistant"
        ? assistantName
        : nextName(kind, { project: name, machine, names: [...log.map((l) => l.name), ...taken] }),
    note: [note, besideNote].filter(Boolean).join(" "),
    ...(replace.length ? { replace } : {}),
    ...(findings.length ? { past: findings[0] } : {}),
  };
}

/**
 * The hook's Handing over section for a session the usage limit cut off, put
 * in place of its Building line by `handOverEdit`.
 */
export function cutoffEdit(text, { sessionId, branch, tree = "", day = today() }) {
  return handOverEdit(
    text,
    `## Handing over, ${day}, by the hook\n\nStep in hand: unknown, the usage limit cut session ${sessionId} off on branch \`${branch}\`${treeWords(tree)}. Read the branch's commits and the task list's state in the final messages above.\n`,
  );
}

/**
 * What `plans end <id> --now` writes into the plan or brief the ended session
 * had under way (decisions.md#end-now), so the queue resumes it: a plan gets
 * a Handing over section in place of its Building line and reads `handed`; a
 * brief only loses its Planning line and is a brief again, since a Handing
 * over line would read as an executor's taking (`planTaken`). Text with no
 * such line of the session's is returned as it is.
 */
export function endedEdit(text, { sessionId, branch = "", tree = "", day = today() }) {
  const planning = new RegExp(
    `^## Planning, [^\\n]*session ${sessionIdSource(sessionId)}[^\\n]*(?:\\n[ \\t]*(?=\\n))?\\n?`,
    "m",
  );
  if (planning.test(text)) return text.replace(planning, "");
  if (!new RegExp(`^## Building, [^\\n]*session ${sessionIdSource(sessionId)}`, "m").test(text))
    return text;
  const where = branch ? ` on branch \`${branch}\`${treeWords(tree)}` : "";
  return handOverEdit(
    text,
    `## Handing over, ${day}, ended with plans end --now\n\nStep in hand: unknown, session ${sessionId} was ended with plans end --now${where} in the middle of its work. Read the branch's commits for what it did.\n`,
  );
}

/**
 * What a start writes into the plan of an executor it finds with no process
 * (decisions.md#plan-put-first), so the fresh executor resumes it: a Handing
 * over section in place of the Building line, as `plans end --now` writes one.
 */
export function goneEdit(text, { sessionId, branch = "", tree = "", day = today() }) {
  const where = branch ? `, on branch \`${branch}\`${treeWords(tree)}` : "";
  return handOverEdit(
    text,
    `## Handing over, ${day}, by the queue\n\nStep in hand: unknown, session ${sessionId}'s process was not running when a start looked${where}. Read the branch's commits for what it did.\n`,
  );
}

/** **A hand-over names its worktree**, after the branch. */
function treeWords(tree) {
  return tree ? ` in worktree \`${tree}\`` : "";
}

/**
 * A hand-over `section` in place of the Building line. **It goes after the
 * header paragraph**, as the executor's does
 * (decisions.md#plan-state-in-file), wherever the Building line was; with no
 * header found, in its place.
 */
function handOverEdit(text, section) {
  const building = /^## Building, [^\n]*(?:\n[ \t]*(?=\n))?\n?/m;
  const lines = text.replace(building, "").split("\n");
  const [header, at] = headerEnd(lines, PLAN_HEADER);
  if (header < 0) {
    if (building.test(text)) return text.replace(building, `${section}\n`);
    return `${text.replace(/\n*$/, "\n\n")}${section}`;
  }
  if (at < 0) lines.push("", section);
  else if (lines[at].trim() === "") lines.splice(at + 1, 0, section);
  else lines.splice(at, 0, "", section);
  return lines.join("\n");
}

/**
 * **Where a header paragraph ends** (decisions.md#plan-put-first):
 * `[header, end]`, the index of the first line matching `pattern` and the
 * index of the blank line, or the heading written straight under it, that
 * ends its paragraph; -1 for either with none. A hand-over and a First line
 * both go there.
 */
function headerEnd(lines, pattern) {
  const header = lines.findIndex((line) => pattern.test(line));
  if (header < 0) return [-1, -1];
  return [
    header,
    lines.findIndex((line, i) => i > header && (line.trim() === "" || /^## /.test(line))),
  ];
}

/** When a session cut off at a usage limit is started again: just past its window's reset, in milliseconds. */
function startAfterReset(transcriptPath) {
  let transcript = "";
  try {
    transcript = readFileSync(transcriptPath, "utf8").slice(-200_000);
  } catch {
    // No transcript: the usage file alone says when.
  }
  return (resetTime(readJson(files.usage()), transcript) + AFTER_RESET) * 1000;
}

/** When a cut-off session's window resets: the usage file's window over its threshold, else the transcript's last `resetsAt`. */
export function resetTime(usage, transcriptText = "") {
  const over = windowOver(usage);
  if (over.length) return Math.max(...over.map(([, w]) => w.resets_at));
  const resets = [...transcriptText.matchAll(/"resetsAt"\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
  if (resets.length) return resets.at(-1);
  const any = [usage?.five_hour?.resets_at, usage?.seven_day?.resets_at].filter(Boolean);
  return any.length ? Math.min(...any) : Math.round(Date.now() / 1000) + 3600;
}

// ---- the parts that touch the machine -----------------------------------------

function readLog() {
  try {
    return readFileSync(files.starts(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * **A start holds its name** (decisions.md#session-names): under the
 * names' guard, the held names younger than `STARTING_SPAN` kept, the log
 * read afresh, the name is numbered again by `nextName` over the log's
 * names, `taken` (the live names) and the names held, and written held for
 * this process. Since a start is logged before it lets its name go, a name
 * in flight is in the file or in the log whenever the guard is held, and a
 * second start at the same moment, in this checkout or another, numbers
 * past it. `claude agents` is not asked under the guard: it can take
 * seconds. "" when the guard is not taken or the file cannot be written:
 * the start goes on with `canStart`'s name, unheld
 * (plans/overlapping-starts-own-names.md).
 */
function holdName(kind, taken) {
  const path = files.names();
  const guard = `${path}.guard`;
  try {
    if (!takeGuard(guard)) return "";
  } catch {
    return "";
  }
  try {
    const now = Date.now();
    const held = Object.fromEntries(
      Object.entries(readJson(path) || {}).filter(
        ([, one]) => now - (one?.at || 0) < STARTING_SPAN,
      ),
    );
    const name = nextName(kind, {
      project: proj().name,
      machine: machine().name,
      names: [...readLog().map((line) => line.name), ...taken, ...Object.keys(held)],
    });
    writeJson(path, { ...held, [name]: { pid: process.pid, at: now } });
    return name;
  } catch {
    return "";
  } finally {
    try {
      unlinkSync(guard);
    } catch {
      // Gone already.
    }
  }
}

/** Lets go of a name `holdName` held for this process, and of the file once it holds none; a failed removal holds back nothing. */
function dropName(name) {
  const path = files.names();
  const guard = `${path}.guard`;
  try {
    if (!takeGuard(guard)) return;
  } catch {
    return;
  }
  try {
    const held = readJson(path);
    if (!held || held[name]?.pid !== process.pid) return;
    delete held[name];
    if (Object.keys(held).length) writeJson(path, held);
    else rmSync(path, { force: true });
  } catch {
    // The name lapses with its span.
  } finally {
    try {
      unlinkSync(guard);
    } catch {
      // Gone already.
    }
  }
}

function progressAt(plans) {
  let newest = 0;
  for (const plan of plans) {
    if (/^## (Building|Handing over|Built|Resumed)/m.test(plan.text))
      newest = Math.max(newest, plan.mtime);
  }
  return newest;
}

/** The newest plan written over a brief: a planner's progress, for the quick-death rule. */
function plannedAt(plans) {
  let newest = 0;
  for (const plan of plans)
    if (plan.state !== "brief" && plan.state !== "planning")
      newest = Math.max(newest, plan.mtime || 0);
  return newest;
}

/**
 * What a planner the queue starts is told: the brief's path and what it is;
 * the agent file says the rest.
 */
export function plannerPrompt(path) {
  return `Plan ${path}: it is a brief.`;
}

/**
 * What the assistant chat is told of a built plan, opened on it or sent it
 * (decisions.md#one-chat): the executor's own message adds what to tell the
 * owner; the agent file says the way through it.
 */
export function assistantPrompt(path) {
  return `Built: ${path}.`;
}

/**
 * The prompt of an assistant chat opened with nothing handed over: an agent
 * that has a message for it sends it next; the owner reads the line.
 */
function openedPrompt(by) {
  return `Opened for ${owner()} by ${by}: nothing is handed over. Say in a line that you are open, and wait for him.`;
}

/**
 * The newest brief or waiting plan, or the log of decisions taken: what an
 * assistant writes, its progress for the quick-death rule. A built plan is
 * not one: the executor writes its "Built" just before it starts an
 * assistant. An assistant handed only a decision to log writes the log alone
 * (decisions.md#executor-never-waits). **A note from GitHub it handled
 * counts** (decisions.md#starts-bounded): answering a comment or rerunning a
 * job writes no plan.
 */
export function writtenAt(
  plans,
  log = join(root, TAKEN_LOG),
  notes = join(root, "plans", "github"),
) {
  let logged = 0;
  try {
    logged = statSync(log).mtimeMs;
  } catch {}
  return Math.max(
    0,
    logged,
    ...readNotes(notes)
      .filter((one) => one.state === "handled")
      .map((one) => one.mtime),
    ...plans
      .filter((plan) => ["brief", "planning", "ready"].includes(plan.state))
      .map((plan) => plan.mtime || 0),
  );
}

/**
 * This project's assistant chat open on this machine, by its one name, any
 * state, never a Remote Control row, which is another machine's chat.
 */
function openAssistants(rows, except = "") {
  return (rows || [])
    .filter((row) => row.sessionId !== except && isSession("assistant", row))
    .map((row) => row.name);
}

/** "plans/a.md, plans/b.md (until 14:02)", a deferral as the pause and the resume say it. */
function deferredWords(deferred) {
  return `${(deferred.paths || []).join(", ")} (until ${hhmm(deferred.until)})`;
}

function pausedSince() {
  const pause = readJson(files.pause());
  return pause ? pause.at || "earlier" : existsSync(files.pause()) ? "earlier" : false;
}

/** Whether the lock's session is still running: listed by `claude agents`, or, when that cannot be read, its pid alive. */
function holderAlive(lock, live) {
  if (!lock) return false;
  return live ? live.some((row) => row.sessionId === lock.sessionId) : pidAlive(lock.pid);
}

function liveIds(live) {
  return live ? live.map((row) => row.sessionId) : null;
}

/** A per-session temp file of the plugin's, by its kind and its session's id. */
const TEMP_FILE =
  /^workflow-(?:queue|seen|turn|plain-words|catalogue|agent|stops)-(.+)\.(?:json|jsonl|tools|log|tmp)$/;

/**
 * **`plans` sweeps the plugin's per-session temp files**
 * (decisions.md#shared-is-what-is-held, decisions.md#reuse-check-cheap): every
 * file in `dir` named `workflow-<kind>-<id>.<ext>` of the plugin's own kinds
 * (the queue's state, the seen log, the turn audit's, the plain-words count,
 * the catalogue's, the tool denials', the test runs' stop logs) older than
 * `age` whose id is no live session's, of any project, is removed, since
 * nothing else removes one. A folder is never removed, an error passes that file over. A
 * command's work, never a hook's. Returns how many were removed.
 */
export function sweepTemp({ dir = tmpdir(), live = [], now = Date.now(), age = DAY_MS } = {}) {
  const keep = new Set(live);
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const id = TEMP_FILE.exec(name)?.[1];
    if (!id || keep.has(id)) continue;
    try {
      const path = join(dir, name);
      const stat = statSync(path);
      if (!stat.isFile() || now - stat.mtimeMs < age) continue;
      unlinkSync(path);
      removed += 1;
    } catch {
      // Gone meanwhile, or not ours to remove: passed over.
    }
  }
  return removed;
}

/** An executor's first prompt: the plans, or the handed plan to resume. */
export function startPrompt(path, plans) {
  const handed = plans.find((plan) => plan.state === "handed" && plan.path === path);
  if (handed) return `Resume ${handed.path} from its "Handing over" section.`;
  return `Build ${path}.`;
}

/**
 * The words for a plan another executor has claimed: its holder's id in
 * brackets, at eight; for a `name:` holder the id of the running row of
 * that name, and no brackets when none has it, since a name is no id.
 */
function claimedWords(path, one, live = null) {
  const named = /^name:(.+)$/.exec(String(one.holder || ""));
  const id = named
    ? live?.findLast((row) => row.name === named[1] && statusOf(row) !== "not running")
        ?.sessionId || ""
    : String(one.holder || "");
  const bracket = id ? ` [${id.slice(0, 8)}]` : "";
  return `${path} is ${one.name || "an executor"}'s${bracket}, taken at ${hhmm(one.at)}: leave it.`;
}

/**
 * A started chat's environment: this one without five variables. A node child
 * of the command inherits them all, a chat none: `WORKFLOW_ROOT` is the
 * command's; `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT` and
 * `CLAUDE_PLUGIN_DATA` are what a hook is exported, and a carried one reaches
 * the new chat's Bash tool naming another project or plugin; and
 * `CLAUDE_SESSION_ID`, which `plans pause` records, is the starting chat's.
 * **Nor the plugins' `bin` folders on its PATH**: Claude Code adds each
 * enabled plugin's after the PATH it inherits, so a chat started from one
 * that began on an older version would run that version's `plans` first.
 */
export function sessionEnv(env = process.env) {
  const {
    WORKFLOW_ROOT: _root,
    CLAUDE_PROJECT_DIR: _project,
    CLAUDE_PLUGIN_ROOT: _pluginRoot,
    CLAUDE_PLUGIN_DATA: _pluginData,
    CLAUDE_SESSION_ID: _session,
    ...rest
  } = env;
  if (rest.PATH)
    rest.PATH = rest.PATH.split(delimiter)
      .filter((dir) => !PLUGIN_BIN.test(dir))
      .join(delimiter);
  return rest;
}

/** A plugin's `bin` folder in Claude Code's cache: `<plugins>/cache/<marketplace>/<plugin>/<version>/bin`. */
const PLUGIN_BIN = /[\\/]plugins[\\/]cache[\\/][^\\/]+[\\/][^\\/]+[\\/][^\\/]+[\\/]bin[\\/]?$/;

/** Blocks for `ms`: the hooks and the command are synchronous, and print their answer on return. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const START_WAIT = 10;

/** A start's own output file, `.claude/<kind>.<pid>.started`: one per `plans` process (plans/start-output-per-start.md). */
const startOutput = (kind) => join(root, ".claude", `${kind}.${process.pid}.started`);

/**
 * **A start sees its session, or says why not**: `claude --bg` returns at
 * once, and where no trust dialog can appear it exits with `Workspace not
 * trusted`. Its output goes to `.claude/<kind>.<pid>.started`, a file of
 * this `plans` process's own, `<pid>` its pid, so a start by another
 * process at the same moment cannot truncate it or be read in its place
 * (plans/start-output-per-start.md); a later start in the same process, as
 * a usage reset's timer makes one after another, writes it afresh. `claude agents` is asked once a second
 * for ten seconds for a row of the new name, the start's own: a start holds
 * its name until it is logged (`holdName`), so no start beside it at the
 * same moment is given it (plans/overlapping-starts-own-names.md). `{ id }` when seen, the row's
 * session id, or when a line of the output is `claude --bg`'s own
 * confirmation for this name, `backgrounded · <id> · <name>`, which counts
 * as seeing the session though `claude agents` lists no row yet (a line
 * naming another session does not), the id that line printed, `{ id,
 * launched: true }`; the start claims the plan for it. Seen either way, the
 * file is removed. Else the line to say, its first, and nothing is logged;
 * the file stays, and every line a start says unconfirmed names it, the
 * `unread` note `start` adds included.
 */
function launch(args, name, kind, cwd = root) {
  const out = startOutput(kind);
  const seen = (one) => {
    try {
      rmSync(out, { force: true });
    } catch {
      // A file that cannot be removed holds back no confirmed start (Codex C2).
    }
    return one;
  };
  const fd = openSync(out, "w");
  try {
    const child = spawn(claudeBin(), args, {
      cwd,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: sessionEnv(),
    });
    child.on("error", () => {
      // A launcher that cannot run says so in nothing: the wait reports it.
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
  // Ten seconds by the clock, each ask cut to the time left, so a slow
  // `claude agents` cannot hold the Stop hook past its own timeout.
  const deadline = Date.now() + START_WAIT * 1000;
  let read = false;
  for (;;) {
    sleep(Math.max(0, Math.min(1000, deadline - Date.now())));
    const left = deadline - Date.now();
    if (left <= 0) break;
    const rows = liveSessions({ fresh: true, timeout: left });
    if (rows) read = true;
    const row = rows?.find((one) => one.name === name);
    if (row) return seen({ id: row.sessionId });
  }
  let lines = [];
  try {
    lines = readFileSync(out, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    // No output file: as if it said nothing.
  }
  // The launcher's own report that the session exists, read or not, after
  // any warning it printed first.
  const confirmed = lines
    .map((line) => /^backgrounded\s*·\s*(\S+)\s*·\s*(.+)$/.exec(line))
    .find((match) => match?.[2] === name);
  if (confirmed) return seen({ id: confirmed[1], launched: true });
  const said = lines[0] || "";
  // Nothing could be read: the start is not known to have failed.
  if (!read) return "unread";
  return said
    ? `${name} was not started: ${said.replace(/[.\s]+$/, "")}; its output is in .claude/${basename(out)}.`
    : `${name} was started, but has not appeared in claude agents after ten seconds; its output is in .claude/${basename(out)}.`;
}

function detached(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: root, detached: true, stdio: "ignore", env });
  child.unref();
  return child.pid;
}

/**
 * Stops a background chat after it has had time to write its last message;
 * an interactive one (tmux) is the owner's. A replaced session is stopped
 * three minutes on whatever its state, since its successor is started; a
 * quiet one is `endSession`'s, an hour after its last stop.
 */
function stopLater(sessionId, live) {
  const row = live?.find((r) => r.sessionId === sessionId);
  if (!row || row.kind !== "background") return;
  // The tests' record of what would be stopped, instead of `claude stop`.
  if (process.env.WORKFLOW_STOP_LOG) {
    appendFileSync(process.env.WORKFLOW_STOP_LOG, `${row.id || sessionId}\n`);
    return;
  }
  detached(process.execPath, [
    "-e",
    `setTimeout(() => { try { require("node:child_process").execFileSync(${JSON.stringify(claudeBin())}, ["stop", ${JSON.stringify(row.id || sessionId)}], { stdio: "ignore" }); } catch {} }, 180000)`,
  ]);
}

/**
 * `claude stop` now, which keeps the conversation; the tests' log records the
 * id instead. True when it stopped: a failed stop is said, never reported as
 * an end.
 */
function stopNow(id) {
  if (process.env.WORKFLOW_STOP_LOG) {
    appendFileSync(process.env.WORKFLOW_STOP_LOG, `${id}\n`);
    return true;
  }
  try {
    execFileSync(claudeBin(), ["stop", id], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/** A process's command line, from `/proc` or `ps`; "" when it cannot be read. */
function commandOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    try {
      return execFileSync("ps", ["-o", "args=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return "";
    }
  }
}

/**
 * Kills a timer the queue armed, and only it: never this process, and a pid
 * only while its command line matches `pattern`, since a timer gone leaves
 * its pid to be reused.
 */
function killTimer(pid, pattern) {
  if (!pid || pid === process.pid || !pattern.test(commandOf(pid))) return;
  try {
    process.kill(pid);
  } catch {
    // The timer is gone already.
  }
}

/** The command line of a deferral's timer. */
const START_TIMER = /plan-queue\.mjs start --timer /;

/** The command line of `sessionId`'s end timer. */
const endTimer = (sessionId) =>
  new RegExp(`plan-queue\\.mjs end --timer .*${sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

/** A timer's own registration, cleared when it has fired, whatever it decided. */
function clearEnd(sessionId, pid = process.pid) {
  const state = readJson(files.state(sessionId));
  if (!state?.end || (pid && state.end.pid !== pid)) return;
  const { end: _end, ...rest } = state;
  writeJson(files.state(sessionId), rest);
}

/**
 * **The end timer, armed at each stop**: `plan-queue.mjs end --timer <at>
 * <sessionId>`, `defer`'s shape, its pid and time in the session's state as
 * `end`, so a chat of a hundred turns has one sleeping timer, not a hundred.
 * `at` is the cache's life from now: when it fires the last turn is past
 * `WARM`, and `decideEnd` judges it.
 */
function armEnd(sessionId, live = null, at = Date.now() + CACHE_TTL) {
  // The owner's interactive chat (tmux) is never the queue's to end, so it
  // has no timer and its line no end time.
  const row = live?.find((r) => r.sessionId === sessionId);
  if (row && row.kind !== "background") return;
  const statePath = files.state(sessionId);
  const state = readJson(statePath) || {};
  killTimer(state.end?.pid, endTimer(sessionId));
  // The tests' record of the timer, as `stopLater` records stops.
  let pid = null;
  if (process.env.WORKFLOW_STOP_LOG)
    appendFileSync(process.env.WORKFLOW_STOP_LOG, `end ${sessionId} at ${at}\n`);
  else
    pid = detached(
      process.execPath,
      [join(here, "plan-queue.mjs"), "end", "--timer", String(at), sessionId],
      // The timer runs as the command, so its root is said: this project's.
      { ...process.env, WORKFLOW_ROOT: root },
    );
  writeJson(statePath, { ...state, end: { pid, at } });
}

/**
 * Ends the tmux server a session's subagents run in
 * (`tmux -L claude-swarm-<pid>`), which `claude stop` leaves running; a
 * missing one is no fault. The tests' log records it instead.
 */
function endSwarm(pid) {
  if (!pid) return;
  if (process.env.WORKFLOW_STOP_LOG) {
    appendFileSync(process.env.WORKFLOW_STOP_LOG, `tmux claude-swarm-${pid}\n`);
    return;
  }
  try {
    execFileSync("tmux", ["-L", `claude-swarm-${pid}`, "kill-server"], {
      stdio: "ignore",
      timeout: 5000,
    });
  } catch {
    // No swarm, or no tmux: nothing of the session's is left there.
  }
}

/**
 * **Ends one session by the rule** (`decideEnd`), from the live rows, its
 * state, the plans and its transcript: `claude stop` on an end, its subagents'
 * tmux server ended, the state's timer cleared. `immediate` ends it whatever
 * it is doing, its plan or brief under way handed over first. One line either
 * way: `Ended <name> [<8 hex>]: done, <usage>.` or `Not ended: <name> [<8
 * hex>], <why>.`; `ended` says which.
 */
function endSession(
  sessionId,
  { force = false, immediate = false, live = liveSessions({ fresh: true }) } = {},
) {
  const row = live?.find((r) => r.sessionId === sessionId) || null;
  const state = readState(sessionId);
  const who = `${row?.name || String(sessionId).slice(0, 8)} [${String(sessionId).slice(0, 8)}]`;
  if (!row) return { ended: false, line: `Not ended: ${who}, it is no live session.` };
  // **A handed-on assistant chat is taken over** (decisions.md#one-chat):
  // stopped once quiet, and a fresh one opened on the hand-over file.
  if (state.handing && isSession("assistant", row)) {
    const verdict = decideEnd({ row, force: true });
    if (!verdict.end) return { ended: false, line: `Not ended: ${who}, ${verdict.why}.` };
    // A fresh chat that would not start (paused, usage, a quick death)
    // leaves this one open: he is never left with none.
    const would = start([ASSISTANT_HANDOVER], {
      agent: "assistant",
      replace: sessionId,
      dry: true,
    });
    if (!/^Would run: /m.test(would))
      return { ended: false, line: `Not ended: ${who}, no fresh chat would start: ${would}` };
    if (!stopNow(row.id || sessionId))
      return { ended: false, line: `Not ended: ${who}, claude stop failed.` };
    endSwarm(row.pid);
    clearEnd(sessionId, null);
    const started = start([ASSISTANT_HANDOVER], { agent: "assistant", replace: sessionId });
    return { ended: true, line: `Ended ${who}: past its ceiling.\n${started}` };
  }
  const plans = readPlans(join(root, "plans"), liveIds(live));
  const plan = plans.find(
    (one) =>
      (one.state === "building" || one.state === "planning") && sameSession(one.session, sessionId),
  );
  const on = plan?.path || "";
  const usage = sessionUsage(transcriptOf(row));
  const verdict = decideEnd({ row, usage, on, force, immediate });
  if (!verdict.end) return { ended: false, line: `Not ended: ${who}, ${verdict.why}.` };
  // A failed stop keeps the timer, and says so.
  if (!stopNow(row.id || sessionId))
    return { ended: false, line: `Not ended: ${who}, claude stop failed.` };
  endSwarm(row.pid);
  killTimer(state.end?.pid, endTimer(sessionId));
  clearEnd(sessionId, null);
  const kind = state.agent === "planner" ? "planner" : "executor";
  const words = [
    // A blocked chat ended as finished says what its process said.
    row.state === "blocked" && finished(row) ? "idle" : row.state,
    usageWords({ kind, usage, fallback: proj().reuse[kind], inputs: reuseNow() }),
  ].filter(Boolean);
  const line = `Ended ${who}: ${words.join(", ")}.`;
  // **An ended executor holds nothing**
  // (decisions.md#plans-reach-an-executor): its lock released and its state
  // retired, so the start the end timer makes on ready plans does not count
  // it as alive while its process winds down.
  if (
    parseName(row.name || "")?.kind === "executor" ||
    readLocks().some((lock) => lock.sessionId === sessionId)
  ) {
    release(sessionId);
    writeJson(files.state(sessionId), { ...readState(sessionId), retired: true });
  }
  if (!verdict.on || !plan) return { ended: true, line };
  // **The plan under way is handed over once its session is stopped**, read
  // again so nothing it wrote while stopping is lost, and the queue resumes it
  // now: the lock released, a fresh executor or planner started in its place.
  release(sessionId);
  let text = plan.text;
  try {
    text = readFileSync(plan.file, "utf8");
  } catch {
    // Gone: nothing to hand over.
    return { ended: true, line };
  }
  writeFileSync(
    plan.file,
    endedEdit(text, {
      sessionId,
      branch: branchOf(row.cwd),
      tree: treeNameOf(row.cwd),
    }),
  );
  const agent = plan.state === "planning" ? "planner" : "executor";
  const started = start([plan.path], { replace: sessionId, agent });
  return {
    ended: true,
    // An executor started on the plan: the net starts none beside it.
    ...(agent === "executor" ? { handed: true } : {}),
    line: `${line} ${plan.path} is handed over.\n${started}`,
  };
}

/**
 * **`plans end [id...] [--now]`**: this queue's finished chats now, warm or
 * not (`force`), or the ones named, by session id, background id or the eight
 * hex `plans` prints. `immediate` (`--now`) ends the named ones whatever they
 * are doing, and only named ones. One line per session.
 */
function endCommand(ids = [], { immediate = false } = {}) {
  if (immediate && !ids.length)
    return "Not ended: name the chat to end now (plans end <id> --now); plans lists them.";
  const live = liveSessions({ fresh: true });
  if (!live) return "claude agents could not be read, so nothing is ended.";
  const locks = readLocks();
  const plans = readPlans(join(root, "plans"), liveIds(live));
  // The assistant chat is the owner's one chat, never a finished one to end.
  const ours = ["executor", "planner"].flatMap((kind) =>
    sessionsOf(kind, live, locks, { plans, usageFor: () => null }),
  );
  const lines = [];
  let targets = ours.map((one) => one.sessionId);
  if (ids.length) {
    targets = [];
    for (const id of ids) {
      const one = ours.find(
        (s) =>
          s.sessionId === id ||
          (s.id && s.id === id) ||
          (id.length >= 8 && s.sessionId.startsWith(id)),
      );
      if (one) targets.push(one.sessionId);
      else lines.push(`${id} is no live session of this queue; plans lists them.`);
    }
  }
  let handed = false;
  for (const sessionId of [...new Set(targets)]) {
    const ended = endSession(sessionId, { force: true, immediate, live });
    handed ||= Boolean(ended.handed);
    lines.push(ended.line);
  }
  // Each line above says why a session was not ended; with none alive, this says so.
  if (!ids.length && !targets.length)
    lines.push("Nothing to end: no finished chat of this queue is alive.");
  // **Ready plans never wait with no executor**
  // (decisions.md#plans-reach-an-executor), unless a handover above started
  // one already.
  const net = handed ? "" : startOnReady();
  if (net) lines.push(net);
  return lines.join("\n");
}

/**
 * Takes `paths` out of a deferral, and the file when none is left. Its
 * timer stays: firing, it starts only what is still waiting. **A plan leaves
 * the asking deferral once it is decided or taken** ("Asked once"): the
 * planner's write of its "Decided", an executor's Building line and a start
 * each call this.
 */
function dropDeferred(file, paths) {
  const deferred = readJson(files.deferred(file));
  if (!deferred) return;
  const rest = (deferred.paths || []).filter((path) => !paths.includes(path));
  if (rest.length === (deferred.paths || []).length) return;
  if (rest.length) writeJson(files.deferred(file), { ...deferred, paths: rest });
  else
    try {
      unlinkSync(files.deferred(file));
    } catch {
      // Gone already.
    }
}

/**
 * Defers a start to `until` (ms): one timer per deferral file (`file`, the
 * agent's by default, or `asking` for the window's), the deferral written
 * where `plans` shows it. **Paused, the deferral is held**: the file is
 * written with no timer (`pid: null`), and `resume` re-arms it.
 */
function defer(
  until,
  why,
  paths,
  replace = "",
  agent = "executor",
  file = agent,
  retired = "",
  said = "",
) {
  const old = readJson(files.deferred(file));
  killTimer(old?.pid, START_TIMER);
  // One timer for every deferred plan, at the later time, so a new
  // deferral never drops a pending one; and never in the past, so a timer
  // cannot fire straight into another deferral. The window's is at the
  // earlier time: its start re-arms the plans still held, each at its own.
  // A brief's lease is not here: each has its own (`lease`).
  const all = [...new Set([...(old?.paths || []), ...paths])];
  const when =
    file === "asking"
      ? Math.max(Math.min(until, old?.until || Infinity), Date.now() + MINUTE)
      : Math.max(until, old?.until || 0, Date.now() + MINUTE);
  const stop = replace || old?.replace || "";
  // **A deferred start keeps the owner's word**
  // (decisions.md#starts-bounded): the timer removes this file before it
  // starts, so the word goes on its command line.
  const word = said || old?.said || "";
  const held = Boolean(pausedSince());
  // The timer runs as the command, so its root is said: this project's.
  const pid = held
    ? null
    : detached(
        process.execPath,
        [
          join(here, "plan-queue.mjs"),
          "start",
          "--timer",
          String(when),
          ...(stop ? ["--replace", stop] : []),
          ...(agent === "executor" ? [] : ["--agent", agent]),
          ...(file === agent ? [] : ["--deferral", file]),
          ...(word ? ["--owner-said", word] : []),
          ...all,
        ],
        { ...process.env, WORKFLOW_ROOT: root },
      );
  // Why the session it replaces was retired, for the starts log the timer's start writes.
  const because = stop ? retired || old?.retired || "" : "";
  writeJson(files.deferred(file), {
    until: when,
    why,
    paths: all,
    pid,
    replace: stop,
    ...(because ? { retired: because } : {}),
    ...(word ? { said: word } : {}),
  });
  const time = hhmm(when);
  return held
    ? `Deferred until ${time}, held while the queue is paused: ${why}; ${all.join(", ")}.`
    : `Deferred until ${time}: ${why}; ${all.join(", ")}.`;
}

/**
 * **Each brief left with a planner has its own lease**
 * (decisions.md#brief-leased): `.claude/handed.deferred` is a table, one
 * entry per brief with its own `until`, `why`, `holder` (the planner's
 * session id) and `held` (sent by message), as SQS gives each message its
 * own visibility timeout. `until`, `pid` and `paths` stay at the top, so
 * `pause`, `resume` and `list` read it as the other deferrals.
 */
export function leases() {
  return readJson(files.deferred("handed"))?.leases || {};
}

/**
 * Writes the lease table and arms its one timer at the earliest `until`,
 * never under a minute from now, as `defer` does; paused, no timer. With no
 * lease left the file goes, and its timer with it.
 */
function writeLeases(table) {
  const old = readJson(files.deferred("handed"));
  killTimer(old?.pid, START_TIMER);
  const paths = Object.keys(table);
  if (!paths.length) {
    try {
      unlinkSync(files.deferred("handed"));
    } catch {
      // Gone already.
    }
    return;
  }
  const earliest = Math.min(...paths.map((path) => table[path].until));
  const when = Math.max(earliest, Date.now() + MINUTE);
  // The timer runs as the command, so its root is said: this project's.
  const pid = pausedSince()
    ? null
    : detached(
        process.execPath,
        [
          join(here, "plan-queue.mjs"),
          "start",
          "--timer",
          String(when),
          "--agent",
          "planner",
          "--deferral",
          "handed",
          ...paths,
        ],
        { ...process.env, WORKFLOW_ROOT: root },
      );
  writeJson(files.deferred("handed"), { until: earliest, pid, paths, leases: table });
}

/** Leases `path` to `holder` until `until`; a second lease on the same brief replaces the first. */
export function lease(path, { until, why, holder = "", held = false }) {
  writeLeases({ ...leases(), [path]: { until, why, holder, held: Boolean(held) } });
}

/** Ends the leases of `paths`; the rest keep their own times, and the file goes with the last. */
export function releaseLease(paths) {
  const table = leases();
  if (!paths.some((path) => path in table)) return;
  writeLeases(Object.fromEntries(Object.entries(table).filter(([path]) => !paths.includes(path))));
}

/** One line per lease, in `until` order, as `plans` prints the other deferrals. */
function leaseLines(deferred) {
  return Object.entries(deferred?.leases || {})
    .sort(([, a], [, b]) => a.until - b.until)
    .map(
      ([path, one]) =>
        `Deferred until ${hhmm(one.until)}: ${one.why ? `${one.why}; ` : ""}${path}${deferred.pid || deferred.firing ? "" : ", held while the queue is paused"}`,
    );
}

/**
 * **A brief sent by message is its planner's for the lease**
 * (decisions.md#brief-leased), as an acknowledged incident is its
 * responder's: the briefs waiting, less those whose lease is `held` by a
 * live, unretired planner other than `self` and `replace`, and not yet ended.
 * A lease waiting for a busy planner leaves its brief free, so whichever
 * planner stops first with room takes it. With the sessions unread, a held
 * lease is kept: its timer settles it.
 */
export function freeBriefs(
  plans,
  {
    live = null,
    self = "",
    replace = "",
    table = leases(),
    stateFor = readState,
    now = Date.now(),
  } = {},
) {
  const heldBy = (path) => {
    const one = table[path];
    if (!one?.held || !one.holder || one.until <= now) return "";
    if (one.holder === self || one.holder === replace) return "";
    if (!live) return one.holder;
    const row = live.find((r) => r.sessionId === one.holder);
    if (!row) return "";
    const state = stateFor(one.holder);
    return isSession("planner", row, state, null) && !state?.retired ? one.holder : "";
  };
  return plans.filter((p) => p.state === "brief" && !heldBy(p.path));
}

/**
 * Starts a fresh session on `paths`, or says why not: the one thing that
 * starts executors, planners and assistant chats. `plans start` (typed by
 * the owner or an agent) and its timers, the Stop and StopFailure hooks, the
 * prompt hook's start on ready plans (`startOnReady`), `plans end --now`'s
 * hand-over (`endSession`) and a GitHub note's assistant (`handleEvents`)
 * all come here.
 */
export function start(paths, options = {}) {
  // A project that is not the workflow's is left as it is.
  if (!proj().found) return NO_PROJECT;
  if (proj().form === "compact") return COMPACT;
  // **The checkout follows test first**, so the executor started runs the
  // queue's newest hooks; not for a dry run or a deferred one, which nobody
  // is watching. A start that replaces a session comes from a hook, so it
  // moves without fetching. One that does not sync still ignores the queue's
  // files, so the executor it starts finds the checkout clean.
  const synced = options.dry
    ? ""
    : options.timer || options.at > Date.now()
      ? ignoreQueueFiles(primaryCheckout())
      : sync({ fetch: !options.replace });
  // **A usage reset starts as many as are free** (decisions.md#executor-pool):
  // the timer's start goes on with the paths it has not started, each start
  // with its own bounds and claim, until one starts nothing, at most one try
  // a path and a number. A number started here, or refused for the session
  // there, is passed over by the next start, which may read the sessions
  // before the new chat is listed; a chat started here is at work beside the
  // next start, listed or not; the session replaced and the owner's word go
  // with the first start.
  let out = {};
  let said = startHere(paths, { ...options, out });
  const kind = options.agent === "planner" || options.agent === "assistant" ? "" : "executor";
  if (options.timer && kind && !options.dry) {
    const started = [];
    const passed = [];
    const going = [];
    const { replace: _r, said: _s, ...next } = options;
    for (let i = 1; i < paths.length + proj().executors; i++) {
      if (out.started) {
        going.push(out.started.name);
        started.push(out.started.path);
        if (out.started.number) passed.push(out.started.number);
      } else if (out.refused) passed.push(out.refused);
      else break;
      const rest = paths.filter((path) => !started.includes(queuePath(path)));
      if (!rest.length) break;
      out = {};
      said = `${said}\n${startHere(rest, { ...next, passed, going, again: true, out })}`;
    }
  }
  // **The listener is armed with a start** (decisions.md#github-webhook).
  if (!options.dry) armWebhook().catch(() => {});
  return synced ? `${synced}\n${said}` : said;
}

/**
 * The name of the chat running this command, from the session id Claude Code
 * gives its shell; "a terminal" for the owner's own.
 */
function starterName(live) {
  const id = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
  return (id && live?.find((row) => row.sessionId === id)?.name) || "a terminal";
}

/** How long a hook's `executor.starting` marker holds off another: a launch takes ten seconds. */
const STARTING_SPAN = 2 * MINUTE;

/**
 * **A plan's header paragraph**: from its `Plan only` or `Short plan` line
 * to the next blank line.
 */
function headerParagraph(text = "") {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => PLAN_HEADER.test(line));
  if (at < 0) return "";
  const end = lines.findIndex((line, i) => i > at && !line.trim());
  return lines.slice(at, end < 0 ? undefined : end).join("\n");
}

/** The plans a plan's header paragraph names, itself left out. */
function restsOn(plan) {
  const named = headerParagraph(plan.text).match(/plans\/[\w.-]+\.md/g) || [];
  return [...new Set(named)].filter((path) => path !== plan.path);
}

/** Where a plan lands, for its wait: its topic's name, the file's with no Lands line, or "fix". */
function topicOf(plan) {
  const lands = landsOf(plan.text);
  if (lands?.kind === "fix") return "fix";
  if (lands?.kind === "refresh") return "refresh";
  return lands?.name || basename(plan.path, ".md");
}

/** The files a plan changes: those named under "The change, part by part" and "Building it", else in its text but a `## For ` section. */
function changedFiles(text = "") {
  const parts = [/^## The change, part by part/m, /^## Building it/m]
    .map((heading) => sectionAfter(text, heading))
    .join("\n");
  const text2 = parts.trim() ? parts : text.replace(/^## For [\s\S]*?(?=^## |(?![\s\S]))/gm, "");
  // A file at the repository's root, named in backticks (`package.json`).
  const root = [...text2.matchAll(/`([\w-][\w.-]*\.\w+)`/g)].map((m) => m[1]);
  return [...new Set([...pathsIn(text2), ...root])];
}

/**
 * **A plan waits on another** (decisions.md#plan-waits-on): each ready or
 * handed plan not asking, in the queue's order, with `waitsOn: { path, why }`
 * or `null`. It waits on a plan its header paragraph names that is not built
 * (ready, asking, planned, handed or building), two that name each other
 * holding neither; and on a plan in progress (building by a live session,
 * handed over, or claimed) that lands on its topic, or is one of the day's
 * fixes as it is, or changes a file it changes. A plan held is passed over,
 * never reordered.
 */
export function freePlans(plans, { claims = {} } = {}) {
  const byPath = new Map(plans.map((plan) => [plan.path, plan]));
  // A brief or a plan still being planned is not built either.
  const unbuilt = ["ready", "planned", "handed", "building", "brief", "planning"];
  const inProgress = plans.filter(
    (plan) => plan.state === "building" || plan.state === "handed" || claims[plan.path],
  );
  return readyForExecutor(plans).map((plan) => {
    for (const path of restsOn(plan)) {
      const other = byPath.get(path);
      if (!other || !unbuilt.includes(other.state)) continue;
      if (restsOn(other).includes(plan.path)) continue;
      return { ...plan, waitsOn: { path, why: "it rests on it" } };
    }
    const topic = topicOf(plan);
    const files = changedFiles(plan.text);
    for (const other of inProgress) {
      if (other.path === plan.path) continue;
      if (topicOf(other) === topic)
        return {
          ...plan,
          waitsOn: {
            path: other.path,
            why: topic === "fix" ? "the day's fixes" : `the same topic, ${topic}`,
          },
        };
      const common = changedFiles(other.text).filter((path) => files.includes(path));
      if (common.length)
        return {
          ...plan,
          waitsOn: {
            path: other.path,
            why: `both change ${common[0]}${common.length > 1 ? ` and ${common.length - 1} more` : ""}`,
          },
        };
    }
    return { ...plan, waitsOn: null };
  });
}

/** The words for a plan that waits, as `plans start <path>` says them. */
function waitsWords(plan) {
  return `${plan.path} waits on ${plan.waitsOn.path} (${plan.waitsOn.why}): it is taken once that one is built.`;
}

/**
 * **A plan is claimed before it is taken**: `.claude/executor.claims.json`, a
 * path to `{ holder, name, at, until }`. A claim ends with its plan's Building
 * line, its holder gone from `claude agents` (when they could be read), or
 * `until`. The live claims.
 */
function readClaims(plans = [], live = null, now = Date.now()) {
  const table = readJson(files.claims()) || {};
  return Object.fromEntries(
    Object.entries(table).filter(([path, one]) => {
      if (!one || !(one.until > now)) return false;
      if (live && !holderRuns(one, live, now)) return false;
      const plan = plans.find((p) => p.path === path);
      return !plan || (plan.state !== "building" && plan.state !== "built");
    }),
  );
}

/**
 * Whether claim `one` is `sessionId`'s: its holder is the session's id
 * (`idHolds`), or `name:<n>` and the live row with that id is named `<n>`
 * and running. A start claims for the id `claude --bg` printed when it saw
 * no row yet, and for the session's name when it read no id either ("A
 * start sees its session, or says why not"; decisions.md#plan-waits-on), so
 * that session's own Building line is let through. With no live rows read,
 * a `name:` holder is nobody's.
 */
function holdsClaim(one, sessionId, live) {
  const holder = one?.holder || "";
  if (idHolds(holder, sessionId, live)) return true;
  const named = /^name:(.+)$/.exec(holder);
  return Boolean(
    named &&
    live?.some(
      (row) =>
        row.sessionId === sessionId && row.name === named[1] && statusOf(row) !== "not running",
    ),
  );
}

/**
 * Whether an id holder names session `sessionId`: the same id; a start of it
 * of eight or more (`sameSession`), as `claude --bg` prints one, that starts
 * no other row's id; or the `id` `claude agents` gives that session's row. A
 * `start:` or `name:` holder only by being the same.
 */
function idHolds(holder, sessionId, rows) {
  if (!holder || holder === sessionId) return Boolean(holder);
  if (/^(?:start|name):/.test(holder)) return false;
  if (rows?.some((row) => row.sessionId === sessionId && row.id === holder)) return true;
  if (!sameSession(holder, sessionId)) return false;
  return !rows || rows.filter((row) => sameSession(holder, row.sessionId)).length <= 1;
}

/**
 * Whether a claim's holder is a session with its process running: a row
 * of its id (`idHolds`) or its name that is not "not running". A name, or
 * an id `claude --bg` printed (`launched`), that no row lists yet is a
 * session starting, held for the start's span.
 */
function holderRuns(one, live, now = Date.now()) {
  const holder = one?.holder || "";
  const start = /^start:(\d+)$/.exec(holder);
  if (start) return pidAlive(Number(start[1]));
  const named = /^name:(.+)$/.exec(holder);
  const rows = live.filter((row) =>
    named ? row.name === named[1] : idHolds(holder, row.sessionId, live),
  );
  if (!rows.length) return (named || one.launched) && now - (one.at || 0) < STARTING_SPAN;
  return rows.some((row) => statusOf(row) !== "not running");
}

/**
 * Ends a session's claim on a plan, under the guard: the claim `holder`
 * holds; given the live rows (`{ live }`), any claim `holdsClaim` says is
 * that session's, by a start of its id or by its name.
 */
function unclaim(path, holder, { live } = {}) {
  const guard = `${files.claims()}.guard`;
  const guarded = takeGuard(guard);
  try {
    const table = readJson(files.claims()) || {};
    const one = table[path];
    const mine =
      one?.holder === holder ||
      (live !== undefined && Boolean(one) && holdsClaim(one, holder, live));
    if (!mine) return;
    delete table[path];
    writeJson(files.claims(), table);
  } finally {
    if (guarded)
      try {
        unlinkSync(guard);
      } catch {
        // Gone already.
      }
  }
}

/**
 * Claims a plan for a session under the guard; false when another holds it.
 * `from`, a holder whose claim this one takes over in the same write;
 * `launched`, an id `claude --bg` printed, held while no row lists it yet.
 */
function claim(path, { holder, name, now = Date.now(), live = null, from = "", launched = false }) {
  const guard = `${files.claims()}.guard`;
  if (!takeGuard(guard)) return false;
  try {
    const table = readJson(files.claims()) || {};
    const held = table[path];
    // A claim whose holder is gone from the sessions read ends, as `readClaims` reads it.
    const gone = live && held && !holderRuns(held, live, now);
    // A claim a start made for this session, by its name or a start of its
    // id, is its own to take again, so its stop names the plan it was started
    // on, now under its whole id.
    const own =
      held &&
      (held.holder === holder ||
        (from && held.holder === from) ||
        (!/^start:/.test(held.holder) && holdsClaim(held, holder, live)));
    if (held && !own && held.until > now && !gone) return false;
    table[path] = {
      holder,
      name,
      at: now,
      until: now + ANSWER_WINDOW,
      ...(launched ? { launched: true } : {}),
    };
    writeJson(files.claims(), table);
    return true;
  } finally {
    try {
      unlinkSync(guard);
    } catch {
      // Gone already.
    }
  }
}

/** A handed plan's own worktree's number, while it is within `executors` and there; else 0. */
function ownTree(plan, executors, trees = null) {
  const n = plan?.state === "handed" ? Number(/^executor-(\d+)$/.exec(plan.tree || "")?.[1]) : 0;
  return n && n <= executors && (!trees || trees.includes(n)) ? n : 0;
}

/**
 * **Who takes a plan**: `{ number, session }`, `session` the live unretired
 * executor there or null; a handed plan its own worktree's number while that
 * number is within `executors` and its worktree is there, else the lowest
 * number that is free, one with no live unretired executor or with one that
 * is idle, has no plan building and holds no claim, by its id or its name
 * (`holdsClaim`, the sessions read as the live rows); null when none is.
 */
export function takerFor(
  plan,
  { executors = 1, sessions = [], claims = {}, trees = null, from = 1 },
) {
  const holds = (one) =>
    Object.values(claims).some((held) => holdsClaim(held, one.sessionId, sessions));
  const at = (n) => sessions.filter((one) => one.number === n && !one.retired);
  const free = (n) =>
    !claims[`slot:${n}`] &&
    at(n).every(
      (one) =>
        one.status === "not running" ||
        (/^idle\b/.test(one.status || "") && !one.on && !holds(one)),
    );
  const taker = (n) => ({ number: n, session: at(n)[0] || null });
  const own = ownTree(plan, executors, trees);
  if (own) return free(own) ? taker(own) : null;
  for (let n = from; n <= executors; n++) if (free(n)) return taker(n);
  return null;
}

/** The plans an executor's default pick takes: ready or handed, not asking. */
function readyForExecutor(plans) {
  return plans.filter((p) => (p.state === "ready" || p.state === "handed") && !p.askingIn);
}

/**
 * **Ready plans never wait with no executor**
 * (decisions.md#plans-reach-an-executor): a planner's or an assistant's Stop
 * hook, a retired executor's, and the end timer start one when plans are
 * ready and none is alive. A cheap gate first, no sessions read: the project
 * found and not compact, the queue not paused, a ready or handed plan on
 * disk, or one whose Building line may be a dead session's, and the lock
 * absent, released, or held by a pid that is dead or unknown (a lock with no
 * pid is judged by the sessions, in `canStart`). Then a marker created
 * exclusively, its stale one reclaimed under a guard, so two hooks at one
 * moment start one executor, and `start` with its bounds ("Starts are
 * bounded"). The line `start` returns when it started one, else "": a refusal
 * or a deferral is said by `plans`, not at every stop.
 */
function startOnReady({ now = Date.now(), alive = pidAlive } = {}) {
  if (!proj().found || proj().form === "compact" || pausedSince()) return "";
  // A start already deferred to the window's reset has its timer: none again.
  const deferred = readJson(files.deferred("executor"));
  if (deferred?.pid && deferred.until > now) return "";
  // A plan its planner is still asking about is that chat's for its window ("Asked once").
  const asking = readJson(files.deferred("asking"));
  const held = asking?.until > now ? asking.paths || [] : [];
  const plans = readPlans(join(root, "plans"));
  if (
    !plans.some((p) => ["ready", "handed", "building"].includes(p.state) && !held.includes(p.path))
  )
    return "";
  // One executor holding its lock is not free; with several, an idle one
  // holding its lock may be, so `start` reads the sessions.
  if (
    proj().executors === 1 &&
    lockHeldByOther(readJson(files.lock(1)), "", (pid) => Boolean(pid) && alive(pid))
  )
    return "";
  const marker = files.starting();
  const token = `${now} ${process.pid}`;
  const create = () => {
    try {
      writeFileSync(marker, token, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };
  try {
    mkdirSync(dirname(marker), { recursive: true });
  } catch {
    return "";
  }
  if (!create()) {
    // A stale marker is reclaimed under the guard, so two hooks that both
    // found it stale cannot each remove the other's and both start.
    const guard = `${marker}.guard`;
    let guarded = false;
    try {
      guarded = takeGuard(guard);
    } catch {
      // A folder that cannot be written: no start from here.
    }
    if (!guarded) return "";
    try {
      let at;
      try {
        // A marker another hook has created and not yet written is its mtime's.
        at = Number(readFileSync(marker, "utf8").split(" ")[0]) || statSync(marker).mtimeMs;
      } catch {
        at = 0;
      }
      if (now - at < STARTING_SPAN) return "";
      try {
        unlinkSync(marker);
      } catch {
        // Gone already.
      }
      if (!create()) return "";
    } finally {
      try {
        unlinkSync(guard);
      } catch {
        // Gone already.
      }
    }
  }
  try {
    // The net messages nobody: an idle chat in the taker's number is retired for a fresh one.
    const said = start([], { why: "plans were ready and no executor was alive", net: true });
    // Only a start is said at a stop: nothing waiting after all, a refusal or
    // a deferral would repeat at every turn, and `plans` says on its first
    // line why none starts.
    return /was started on/.test(said) ? said : "";
  } catch {
    return "";
  } finally {
    // Only this hook's own marker is removed, never one that replaced it.
    try {
      if (readFileSync(marker, "utf8") === token) unlinkSync(marker);
    } catch {
      // Gone already.
    }
  }
}

/**
 * The first line's words for no executor alive: with plans ready,
 * that the next hook or timer starts one, or why none does, from `canStart`
 * run dry.
 */
function noneAliveWords(plans, live, { many = false } = {}) {
  const claimed = readClaims(plans, live);
  const free = freePlans(plans, { claims: claimed }).filter((p) => !p.waitsOn && !claimed[p.path]);
  if (!free.length) return many ? "" : "The executor: none alive.";
  const count = many
    ? `${free.length} ${free.length === 1 ? "plan" : "plans"} free`
    : `The executor: none alive; ${free.length} ${free.length === 1 ? "plan" : "plans"} ready`;
  const lock = readJson(files.lock(1));
  const decision = canStart({
    kind: "executor",
    lock: many ? null : lock,
    alive: () => holderAlive(lock, live),
    log: readLog(),
    progressAt: progressAt(plans),
    paused: pausedSince(),
    usage: readJson(files.usage()),
    sessions: [],
    unread: !live,
    name: proj().name,
    fallback: proj().reuse.executor,
    // Only the verdict is said, so the name it would take needs no sessions read.
    taken: [],
    machine: machine().name,
  });
  // With several, none starts while no number is free.
  if (many) {
    const sessions = live ? sessionsOf("executor", live, readLocks(), { plans }) : [];
    const claims = readClaims(plans, live);
    if (!free.some((plan) => takerFor(plan, { executors: proj().executors, sessions, claims })))
      return `${count}, but none starts: every executor is at work.`;
  }
  if (decision.refuse) return `${count}, but none starts: ${decision.why.replace(/\.$/, "")}.`;
  if (decision.defer)
    return `${count}, but none starts: until ${hhmm(decision.until)}, ${decision.why}.`;
  return many
    ? `${count}, and the next hook or timer starts an executor on the first.`
    : `${count}, and the next hook or timer starts one.`;
}

/**
 * **The executors, numbered**, as a Jenkins node lists its executors: a row per
 * number with the session in that worktree, `free` with none, and under them
 * what the free plans wait for.
 */
function executorsTable(rows, plans, live) {
  const n = proj().executors;
  const atWork = (one) => Boolean(one.on) || !/^(idle|not running)\b/.test(one.status || "");
  const lines = [];
  let working = 0;
  for (let number = 1; number <= n; number++) {
    const here = rows.filter((one) => one.number === number);
    if (here.some((one) => atWork(one) && !one.retired)) working++;
    lines.push(
      here.length
        ? here.map((one) => `  ${number}  ${describeSession(one)}`).join("\n")
        : `  ${number}  free`,
    );
  }
  for (const one of rows.filter((row) => !row.number || row.number > n))
    lines.push(`  ${one.number || "-"}  ${describeSession(one)}`);
  const free = noneAliveWords(plans, live, { many: true });
  return [`The executors, ${working} of ${n} at work:`, ...lines, ...(free ? [free] : [])].join(
    "\n",
  );
}

/** The effort an agent's frontmatter names (`effort: high`), or "". */
export function agentEffort(agent, dir = join(here, "..", "agents")) {
  try {
    const text = readFileSync(join(dir, `${agent}.md`), "utf8");
    const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] || "";
    return /^effort:\s*(\w+)/m.exec(front)?.[1] || "";
  } catch {
    return "";
  }
}

/** Whether a path is a note of what came from GitHub, `plans/github/<n>.md`, there. */
const isNote = (path) => /^plans\/github\/\d+\.md$/.test(path) && existsSync(join(root, path));

/** `plans start`'s refusal of a planned plan's path. */
function plannedWords(plan) {
  return `${plan.path} is planned and waits on GitHub (#${plan.issue}): it is built once the issue is labelled status: ready, or ${owner()} says so in the assistant's chat, which writes its "Ready" section.`;
}

/** `plans start`'s refusal of a dropped plan's path. */
function droppedWords(plan) {
  return `${plan.path} is dropped${plan.droppedDay ? ` (${plan.droppedDay})` : ""}: nothing to build.`;
}

/**
 * A path as the queue writes it, so `./plans/x.md` or an absolute one is
 * judged as `plans/x.md`.
 */
function queuePath(path) {
  const inside = relative(root, resolve(root, path));
  return inside && !inside.startsWith("..") && !isAbsolute(inside)
    ? inside.split(sep).join("/")
    : path;
}

/**
 * **`plans first <path>` and `plans first --undo <path>`**
 * (decisions.md#plan-put-first): on the owner's
 * word, writes `First: <date> <hh:mm:ss>.` as a paragraph of its own after
 * the header paragraph of a waiting plan or brief, in place of one already
 * there, or takes it out; the file's times are put back, so its place among
 * the plans of its day and its asking window stay as they were. It starts
 * nobody. `{ said, status }`.
 */
function firstCommand(args = [], { now = Date.now(), live } = {}) {
  if (!proj().found) return { said: NO_PROJECT, status: 1 };
  if (proj().form === "compact") return { said: COMPACT, status: 1 };
  const undo = args.includes("--undo");
  const paths = args.filter((arg) => arg !== "--undo");
  // One mark at a time, and no option but --undo read as a path
  // (decisions.md#plan-put-first).
  if (paths.length > 1 || paths.some((arg) => arg.startsWith("--")))
    return {
      said: "plans first takes one path at a time: plans first plans/<x>.md, or plans first --undo plans/<x>.md.",
      status: 1,
    };
  const given = paths[0];
  if (!given)
    return {
      said: "A path is needed: plans first plans/<x>.md; plans shows the queue.",
      status: 1,
    };
  const path = queuePath(given);
  const file = join(root, path);
  // The times as they were before the queue read the file, to be put back.
  let stat = null;
  try {
    stat = statSync(file);
  } catch {
    // Not there: refused below as no plan of the queue.
  }
  live = live === undefined ? liveSessions() : live;
  const plans = readPlans(join(root, "plans"), liveIds(live));
  const plan = plans.find((p) => p.path === path);
  if (!plan || !stat || plan.state === "old")
    return { said: `${path} is not a plan or a brief in the queue; plans shows them.`, status: 1 };
  if (plan.state === "dropped") return { said: droppedWords(plan), status: 1 };
  if (plan.state === "built") return { said: `${path} is built: nothing to put first.`, status: 1 };
  if (plan.state === "building") {
    const name =
      live?.find((row) => row.sessionId === plan.session)?.name || String(plan.session).slice(0, 8);
    return { said: `${path} is being built by ${name}: nothing to put first.`, status: 1 };
  }
  const lines = withoutFirstLine(plan.text).split("\n");
  const { header, end, heading, above } = firstPlace(lines, plan.kind);
  if (header < 0)
    return { said: `${path} is not a plan or a brief in the queue; plans shows them.`, status: 1 };
  let said;
  if (undo) {
    if (
      !firstHead(plan.text)
        .split("\n")
        .some((line) => FIRST_MARK.test(line))
    )
      return { said: `${path} was not first.`, status: 0 };
    said = `${path} is no longer first.`;
  } else {
    // The time as written, local, read as `firstOf` reads it; a second past
    // the latest mark of another waiting file when it is not later, so the
    // latest put first is on top even within one second.
    const local = new Date(now);
    let at = Date.UTC(
      local.getFullYear(),
      local.getMonth(),
      local.getDate(),
      local.getHours(),
      local.getMinutes(),
      local.getSeconds(),
    );
    const latest = Math.max(
      0,
      ...plans.filter((p) => p.path !== path && p.first).map((p) => p.first.at),
    );
    if (at <= latest) at = latest + 1000;
    const when = new Date(at);
    const day = `${when.getUTCDate()} ${MONTHS[when.getUTCMonth()]} ${when.getUTCFullYear()}`;
    const time = when.toISOString().slice(11, 19);
    const line = `First: ${day} ${time}.`;
    // Where `firstPlace` says, with a blank line after it above a section
    // only where one is before it, so --undo gives the file back byte for
    // byte.
    if (above) {
      if (heading === 0 || lines[heading - 1].trim() === "") lines.splice(heading, 0, line, "");
      else lines.splice(heading, 0, line);
    } else if (end < 0) lines.push("", line);
    else if (lines[end].trim() === "") lines.splice(end + 1, 0, line, "");
    else lines.splice(end, 0, "", line, "");
    said = `${path} is ${firstWords({ first: { day, time: time.slice(0, 5) } })}: plans lists it at the top, and it is taken next, after the work in hand.`;
  }
  writeFileSync(file, lines.join("\n"));
  utimesSync(file, stat.atimeMs / 1000, stat.mtimeMs / 1000);
  return { said, status: 0 };
}

/**
 * **What a topic's pull request waits for** (decisions.md#topic-landing): the
 * plans other than `but` that land on `topic` and are queued, ready (asking
 * included), handed over or being built, in the queue's order. A plan held
 * for the owner's word, a brief and a dropped plan hold nothing back; a fix
 * or a refresh is no topic's, whatever its file is named (Codex C5).
 */
export function topicQueued(plans, topic, but = "") {
  return plans.filter(
    (plan) =>
      plan.path !== but &&
      ["ready", "handed", "building"].includes(plan.state) &&
      !["fix", "refresh"].includes(plan.lands?.kind) &&
      topicOf(plan) === topic,
  );
}

/**
 * **`plans topic <path>`** (decisions.md#topic-landing): whether the build of
 * the plan at `path` opens its topic's pull request, or what it waits for,
 * in one line the executor follows at the landing. It reads the plans and the
 * live sessions, never gh: whether a pull request is open is the executor's
 * check. `{ said, status }`.
 */
function topicCommand(args = [], { live } = {}) {
  if (!proj().found) return { said: NO_PROJECT, status: 1 };
  if (proj().form === "compact") return { said: COMPACT, status: 1 };
  if (args.length > 1 || args.some((arg) => arg.startsWith("--")))
    return { said: "plans topic takes one path: plans topic plans/<x>.md.", status: 1 };
  if (!args[0])
    return {
      said: "A path is needed: plans topic plans/<x>.md; plans shows the queue.",
      status: 1,
    };
  const path = queuePath(args[0]);
  live = live === undefined ? liveSessions() : live;
  const plans = readPlans(join(root, "plans"), liveIds(live));
  const plan = plans.find((p) => p.path === path && p.kind !== "Brief" && p.state !== "old");
  if (!plan) return { said: `${path} is not a plan in the queue; plans shows them.`, status: 1 };
  // A dropped plan is built by nobody, so nothing opens with it (/code-review).
  if (plan.state === "dropped") return { said: droppedWords(plan), status: 1 };
  // By the line's kind, so a topic named fix or refresh is a topic (Codex C5).
  if (plan.lands?.kind === "fix" || plan.lands?.kind === "refresh")
    return { said: `${path} is no topic's: it lands as ${landsWords(plan.lands)}.`, status: 0 };
  const topic = topicOf(plan);
  const queued = topicQueued(plans, topic, path).map((p) => p.path);
  if (!queued.length)
    return {
      said: `Nothing else is queued for topic ${topic}: its pull request opens with ${path}.`,
      status: 0,
    };
  const one = queued.length === 1;
  return {
    said: `${andList(queued)} ${one ? "is" : "are"} still queued for topic ${topic}: its pull request waits for ${one ? "it" : "them"}.`,
    status: 0,
  };
}

/**
 * **Where `plans first` writes a file's First line**
 * (decisions.md#plan-put-first): after the header paragraph, as `handOverEdit`
 * places a hand-over, or, with `above`, when the header sits under a `## `
 * section, above the first one, `heading`, where `firstHead` reads it. The
 * header is the one `stateOf` read the file by, a plan's own, never a brief's
 * line kept above it. `lines` are the text's without its First line; `{ header,
 * end, heading, above }`, the first two as `headerEnd` gives them, `heading` as
 * `headEndAt` does.
 *
 * `headerEnd` finds the header `stateOf` read: `withoutStatus` ends a status
 * section at any line `HEADER_LINE` matches and keeps that line, so the file's
 * first line that looks like a plan's header, or a brief's line, is the first
 * `stateOf` sees, with or without status sections above it. Its twelve lines
 * only decide whether the file is in the queue, and `firstCommand` calls this
 * only for a file `stateOf` read, with the kind it gave. A header-looking line
 * quoted in a status section is the header to both, and the line written under
 * its paragraph is still read and still undone.
 */
function firstPlace(lines, kind) {
  const [header, end] = headerEnd(lines, kind === "Brief" ? BRIEF_HEADER : PLAN_HEADER);
  const heading = headEndAt(lines);
  return { header, end, heading, above: heading >= 0 && heading < header };
}

/**
 * A plan's text without the `First:` lines of its head, each with the blank
 * line after it where one is before it too, so no paragraph is left doubled.
 */
function withoutFirstLine(text) {
  const lines = text.split("\n");
  const kept = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inside = fence;
    fence = fenceAfter(fence, line);
    const outside = !inside && !fence;
    // The head ends at the first heading that is not one of the queue's status lines.
    if (outside && /^## /.test(line) && !STATUS_HEADING.test(line)) {
      kept.push(...lines.slice(i));
      break;
    }
    if (outside && FIRST_MARK.test(line)) {
      if (lines[i + 1]?.trim() === "" && (kept.length === 0 || kept.at(-1).trim() === "")) i++;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function startHere(
  paths,
  {
    replace = "",
    dry = false,
    agent = "executor",
    at = 0,
    timer = false,
    deferral = "",
    why = "",
    said = "",
    net = false,
    passed = [],
    going = [],
    again = false,
    out = {},
  } = {},
) {
  if (!proj().found) return NO_PROJECT;
  paths = paths.map(queuePath);
  // **The owner's word** (decisions.md#starts-bounded), as one line: it
  // passes the two refusals he decides, and the log keeps it.
  said = said.replace(/\s+/g, " ").trim();
  const live = liveSessions();
  // **A start takes over from an executor with no process**
  // (decisions.md#plan-put-first): each plan its Building line holds is read
  // as handed over, so it is picked first and resumed. The hand-over is
  // written only where the session is retired and its lock released below,
  // with the rest `canStart` replaces, and taken back with them when the
  // launch fails; a refused, deferred or dry start writes nothing.
  const gone = {};
  let read = readPlans(join(root, "plans"), liveIds(live));
  if (agent === "executor" && live) {
    for (const plan of read) {
      const row =
        plan.state === "building" ? live.find((one) => one.sessionId === plan.session) : null;
      if (!row || statusOf(row) !== "not running") continue;
      gone[plan.path] = {
        sessionId: plan.session,
        before: plan.text,
        text: goneEdit(plan.text, {
          sessionId: plan.session,
          branch: branchOf(row.cwd),
          tree: treeNameOf(row.cwd),
        }),
      };
    }
    if (Object.keys(gone).length)
      read = readPlans(
        join(root, "plans"),
        liveIds(live),
        Object.fromEntries(Object.entries(gone).map(([path, one]) => [path, one.text])),
      );
  }
  // **Asked once**: a plan whose planner is asking the owner is that chat's
  // for thirty minutes, neither taken by default nor accepted by path.
  const plans = withAsking(read, live);
  const kind = agent === "planner" || agent === "assistant" ? agent : "executor";
  // **A planner takes one brief, the oldest**; an executor every plan
  // waiting; an assistant with no path is opened on nothing.
  // The default pick never takes a brief sent by message to another live
  // planner (decisions.md#brief-leased).
  if (!paths.length && kind !== "assistant")
    paths =
      kind === "planner"
        ? freeBriefs(plans, { live, replace })
            .slice(0, 1)
            .map((p) => p.path)
        : readyForExecutor(plans).map((p) => p.path);
  if (!paths.length && kind !== "assistant") return "Nothing is waiting in the queue.";
  if (kind === "executor") {
    // **A dropped plan is nobody's to build**
    // (decisions.md#plan-state-in-file): named by path it is refused whole,
    // with nothing started; a timer drops it below.
    const dropped = plans.filter((p) => p.state === "dropped" && paths.includes(p.path));
    if (dropped.length && !timer) return dropped.map(droppedWords).join("\n");
    // **A planned plan waits for Ready**, refused by path the same way; the
    // default pick and a timer take only ready and handed plans.
    const planned = plans.filter((p) => p.state === "planned" && paths.includes(p.path));
    if (planned.length && !timer) return planned.map(plannedWords).join("\n");
    const held = plans.filter((p) => p.askingIn && paths.includes(p.path));
    // Refused whole, so nothing is half started; a deferred start, which
    // nobody is watching, starts the rest and leaves the held ones to the queue.
    if (held.length && !timer) return held.map(askingWords).join("\n");
    paths = paths.filter((path) => !held.some((p) => p.path === path));
    // A timer's held plans, asked again since it was armed, get the window's
    // deferral back at the earliest of their windows, once: not again at
    // each further start of a usage reset's.
    if (timer && held.length && !dry && !again)
      defer(
        Math.min(...held.map((p) => p.askingIn.until)) + WINDOW_SLACK,
        `${owner()} has thirty minutes to answer`,
        held.map((p) => p.path),
        "",
        "executor",
        "asking",
      );
    if (!paths.length) return held.map(askingWords).join("\n");
    // **A timer's start takes only what is still waiting**: a plan being built
    // or built since the timer was armed, or gone, is dropped, and with none
    // left nothing starts. A plan answered and still waiting is started. In the
    // queue's order as it is now, so a plan put first after the deferral was
    // written is still named first (decisions.md#plan-put-first).
    if (timer) {
      paths = plans
        .filter((p) => paths.includes(p.path) && ["ready", "handed", "old"].includes(p.state))
        .map((p) => p.path);
      if (!paths.length) return "Nothing is waiting in the queue.";
    }
  }
  // **One plan, to the lowest-numbered free executor**: the first of the
  // paths that waits on no other and is claimed by nobody; a path named
  // alone that waits says why.
  let number = 1;
  let messaged = "";
  let batch = null;
  let sessionAt = false;
  if (kind === "executor" && agent === "executor") {
    const claims = Object.fromEntries([
      ...Object.entries(readClaims(plans, live)).filter(
        ([, one]) => !holdsClaim(one, replace, live),
      ),
      // The numbers this timer started or was refused at, held as a start holds its own.
      ...passed.map((n) => [`slot:${n}`, { holder: "started", until: Infinity }]),
    ]);
    const free = freePlans(plans, { claims });
    const sessions = sessionsOf("executor", live, readLocks(), { plans })
      // A chat in the checkout is no number's: it builds nothing there.
      .filter((one) => one.sessionId !== replace && one.number);
    const trees = worktrees()
      .map((tree) => numberOf(tree.path))
      .filter(Boolean);
    // A path the queue reads no plan in is taken as named, with nothing to wait on.
    const open = paths
      .map(
        (path) =>
          free.find((p) => p.path === path) ||
          // A plan dated before the queue, named by path or a timer, is taken as named.
          (plans.some((p) => p.path === path && p.state !== "old")
            ? null
            : { path, text: "", waitsOn: null }),
      )
      .filter((p) => p && !p.waitsOn && !claims[p.path]);
    if (!open.length) {
      const waiting = paths.map((path) => free.find((p) => p.path === path)).find(Boolean);
      if (waiting?.waitsOn) return waitsWords(waiting);
      const held = paths.find((path) => claims[path]);
      if (held) return claimedWords(held, claims[held], live);
      return "Nothing is waiting in the queue.";
    }
    const executors = proj().executors;
    // A Stop hook retiring its session starts the fresh one in its own number.
    const own = numberOf(live?.find((row) => row.sessionId === replace)?.cwd);
    const takeOf = (plan) =>
      (own &&
        own <= executors &&
        plan.state !== "handed" &&
        takerFor(plan, { executors: own, from: own, sessions, claims, trees })) ||
      takerFor(plan, { executors, sessions, claims, trees });
    const pick = open.find(takeOf);
    if (!pick) {
      // A handed plan waits for its own worktree's executor.
      const own = ownTree(open[0], executors, trees);
      if (own) {
        const there = sessions.find((one) => one.number === own && !one.retired);
        return `${open[0].path} waits on executor-${own}, where it was built${there?.on ? ` and ${there.name} is building ${there.on}` : ""}: it is resumed there once that executor is free.`;
      }
      const busy = sessions.filter((one) => one.number <= executors).map((one) => one.name);
      return `All ${executors} executors are at work (${busy.join(", ") || "none read"}): the first to finish takes ${open[0].path}.`;
    }
    const taker = takeOf(pick);
    number = taker.number;
    sessionAt = Boolean(taker.session);
    // A usage reset's start deferred again keeps every plan it still has.
    if (timer) batch = paths;
    paths = [pick.path];
    // An idle chat with room is sent the plan by message, as a planner is a
    // brief; a timer's start, which nobody watches, starts a fresh one.
    const chat = taker.session;
    if (chat && /^idle\b/.test(chat.status || "") && !timer && !net && !pausedSince()) {
      const room = mayReuse({
        usage: chat.usage,
        shared: sharedTokens(pick.text, chat.seen),
        inputs: reuseNow(),
        kind: "executor",
        fallback: proj().reuse.executor,
      });
      if (room.reuse) {
        const who = `${chat.name} [${String(chat.sessionId).slice(0, 8)}]`;
        const line = pick.first
          ? `Plan first: ${pick.path}. Build it next, once the plan in hand is built; nothing to answer.`
          : `Plan ready: ${pick.path}. Build it when you are free, in queue order; nothing to answer.`;
        if (!dry && !claim(pick.path, { holder: chat.sessionId, name: chat.name, live }))
          return claimedWords(pick.path, readJson(files.claims())?.[pick.path] || {}, live);
        messaged = `${who} in executor-${number} is idle with room for ${pick.path} (${room.why}): send it the plan with SendMessage, one message: ${line} It has until ${hhmm(Date.now() + ANSWER_WINDOW)} to take it; then a fresh executor is started on it.`;
      }
    }
  }
  if (messaged) return messaged;
  // **A lease's timer reads the table** (decisions.md#brief-leased): a lease
  // whose brief is no longer one ends, the due ones are those past their own
  // `until`, and the oldest due, in the plans' order, is the one started on;
  // the rest keep their own times.
  const leaseTimer = kind === "planner" && timer && deferral === "handed";
  let due = [];
  if (leaseTimer) {
    const table = leases();
    const gone = Object.keys(table).filter(
      (path) => !plans.some((p) => p.path === path && p.state === "brief"),
    );
    if (!dry) releaseLease(gone);
    const by = Date.now() + WINDOW_SLACK;
    due = plans
      .filter((p) => p.state === "brief" && table[p.path] && table[p.path].until <= by)
      .map((p) => p.path);
    if (!due.length) {
      // This timer's file with nothing due keeps a timer for the rest.
      if (!dry && readJson(files.deferred("handed"))?.firing === process.pid) writeLeases(leases());
      return "Nothing is waiting in the queue.";
    }
    paths = due;
  } else if (kind === "planner" && timer) {
    // A usage limit's deferred start takes only what is still a brief.
    const still = plans.filter((p) => p.state === "brief" && paths.includes(p.path));
    if (!still.length) return "Nothing is waiting in the queue.";
    paths = still.map((p) => p.path);
  }
  if (kind === "planner") {
    // A planner is started on one brief, waiting or left by a session that is gone.
    const asked = paths[0];
    if (!plans.some((p) => p.path === asked && p.state === "brief"))
      return `${asked} is not a brief waiting for a planner; plans shows the briefs.`;
    // **A brief sent by message is its holder's for the lease**:
    // named by path, it is refused while another live planner holds it.
    if (!leaseTimer && !freeBriefs(plans, { live, replace }).some((p) => p.path === asked)) {
      const one = leases()[asked];
      const name = live?.find((row) => row.sessionId === one.holder)?.name || "a planner";
      return `${asked} was sent to ${name} [${String(one.holder).slice(0, 8)}] at ${hhmm(one.until - ANSWER_WINDOW)} and is its until ${hhmm(one.until)}; plans shows the briefs.`;
    }
    paths = [asked];
  }
  if (kind === "assistant" && paths.length) {
    // An assistant is opened on one built plan, or on a note of what came
    // from GitHub (decisions.md#github-webhook), or on nothing.
    const asked = paths[0];
    if (
      asked !== ASSISTANT_HANDOVER &&
      !isNote(asked) &&
      !plans.some((p) => p.path === asked && p.state === "built")
    )
      return `${asked} is not a built plan; plans shows the built plans.`;
    paths = [asked];
  }
  const paused = pausedSince();
  // Paused, the deferral is held (no timer), so the resume re-arms it.
  if (at && at > Date.now())
    return defer(
      at,
      `the usage limit cut the last ${kind} off`,
      paths,
      replace,
      kind,
      kind,
      why,
      said,
    );
  // A timer's start replacing a session takes the retirement's why its deferral kept.
  if (timer && replace && !why) why = readJson(files.deferred(deferral || kind))?.retired || "";
  // **A brief is judged against the planner it would go to**
  // (decisions.md#reuse-check-cheap): read once, and each live session's
  // ceiling is raised by what the work shares with it.
  const briefText = kind === "planner" ? plans.find((p) => p.path === paths[0])?.text || "" : "";
  const fallback = kind === "planner" ? proj().reuse.planner : proj().reuse.executor;
  const inputs = kind === "assistant" ? {} : reuseNow();
  const decision = canStart({
    kind,
    lock: readJson(files.lock(number)),
    alive: () => holderAlive(readJson(files.lock(number)), live),
    log: readLog(),
    progressAt:
      kind === "planner"
        ? plannedAt(plans)
        : kind === "assistant"
          ? writtenAt(plans)
          : progressAt(plans),
    paused,
    usage: readJson(files.usage()),
    // The session being replaced and retired ones do not block their successor.
    sessions:
      kind === "assistant"
        ? []
        : sessionsOf(kind, live, readLocks(), { plans, fallback, inputs })
            // An executor is judged against its number's sessions alone.
            .filter((one) => kind !== "executor" || one.number === number)
            .filter((one) => one.sessionId !== replace && !one.retired)
            .map((one) => ({
              ...one,
              // What the chat read or wrote of the files the work names.
              shared:
                kind === "planner"
                  ? sharedTokens(briefText, one.seen)
                  : Math.max(0, ...paths.map((path) => sharedTokens(planText(path), one.seen))),
            })),
    brief: kind === "executor" ? "" : paths[0] || "",
    elsewhere:
      kind === "executor"
        ? sessionsOf("executor", live, readLocks(), { plans, usageFor: () => null })
            .filter((one) => one.number && one.number !== number && !one.retired)
            .map((one) => one.name)
            .concat(going)
        : [],
    // This checkout's chats only: one in another checkout reads another queue.
    // The chat a hand-over replaces is stopped already.
    open: kind === "assistant" ? openAssistants(live, replace) : [],
    unread: !live,
    name: proj().name,
    fallback,
    inputs,
    taken: liveNames(),
    machine: machine().name,
    // Only the window's and a lease's timer: a usage limit's restart
    // refuses beside a live executor.
    unwatched: net || (timer && (deferral === "asking" || deferral === "handed")),
    said,
  });
  if (decision.refuse) {
    // A number whose session refused a usage reset's start is passed over by the next.
    if (kind === "executor" && sessionAt) out.refused = number;
    // A refused timer's start leaves the due briefs free, under Briefs in `plans`.
    if (leaseTimer && !dry) releaseLease(due);
    return decision.why;
  }
  // **A brief left with a live planner is leased to it for thirty minutes**
  // (decisions.md#brief-leased), the one brief its own lease: `plans` says
  // who holds it and until when, its Planning line ends the lease, and at
  // its end the timer starts a fresh planner on it unless its holder is
  // still busy with room, when the lease renews (Javi). The other due
  // briefs keep their leases, judged a minute on.
  if (decision.wait) {
    if (!dry)
      lease(paths[0], {
        until: decision.until,
        why: decision.lease,
        holder: decision.holder,
        held: decision.held && !leaseTimer,
      });
    return decision.why;
  }
  // An assistant is never deferred: its items wait in the plan for the next start.
  if (decision.defer && kind === "assistant")
    return `No assistant chat was started: ${decision.why}.`;
  // A lease's start, deferred by usage, stays a lease's, each due brief to
  // the reset with its holder.
  if (decision.defer && leaseTimer) {
    if (!dry) {
      const table = leases();
      writeLeases({
        ...table,
        ...Object.fromEntries(
          due.map((path) => [
            path,
            { ...table[path], until: decision.until, why: decision.why, held: false },
          ]),
        ),
      });
    }
    return `Deferred until ${hhmm(decision.until)}: ${decision.why}; ${due.join(", ")}.`;
  }
  // The window's start, deferred by usage, stays the window's, so at the reset
  // it still replaces an idle executor.
  if (decision.defer)
    return defer(
      decision.until,
      decision.why,
      batch || paths,
      replace,
      kind,
      deferral === "asking" ? deferral : kind,
      why,
      said,
    );
  // The sentence a start past a refusal on the owner's word adds, in its
  // output and in its log line's why.
  const pastWords = decision.past
    ? `${owner()} said to start it ("${said}"), past: ${decision.past}`
    : "";
  const prompt =
    kind === "planner"
      ? plannerPrompt(paths[0])
      : kind === "assistant"
        ? !paths.length
          ? openedPrompt(starterName(live))
          : paths[0] === ASSISTANT_HANDOVER
            ? takeOverPrompt(decision.name)
            : isNote(paths[0])
              ? githubPrompt(paths[0])
              : assistantPrompt(paths[0])
        : startPrompt(paths[0], plans);
  // **The agent file's effort, on the command line**: a settings
  // file's effort for the model outranks the frontmatter, and the user
  // settings set Opus to medium for the assistant; the command line outranks both.
  const effort = agentEffort(agent);
  // **The project's MCP configs reach every chat started here**, first: the
  // flag takes every value up to the next flag, so nothing positional may
  // follow it.
  const mcp = proj().mcp.flatMap((p) => ["--mcp-config", isAbsolute(p) ? p : resolve(root, p)]);
  // **An executor works in its worktree**
  // (decisions.md#executors-in-worktrees), reaching the checkout's plans/ by
  // its link and by `--add-dir`, which also takes every value up to the next
  // flag.
  const tree = kind === "executor" ? executorTree(number) : "";
  // **Only the assistant's chat is a Remote Control chat**
  // (decisions.md#session-names): a planner or an executor is a background
  // chat on the machine, in no list of the owner's, so its start alerts no
  // phone.
  const argsFor = (name) => [
    ...mcp,
    ...(tree ? ["--add-dir", join(root, "plans")] : []),
    "--bg",
    ...(kind === "assistant" ? ["--remote-control", name] : []),
    "--name",
    name,
    "--agent",
    // The plugin's agents are scoped by its name.
    `workflow:${agent}`,
    ...(effort ? ["--effort", effort] : []),
    prompt,
  ];
  // A dry run holds nothing: it shows the name with no other start in flight.
  if (dry)
    return [
      `Would run: claude ${argsFor(decision.name)
        .map((a) => JSON.stringify(a))
        .join(" ")}`,
      ...(tree ? [`Would run it in ${relative(root, tree)}.`] : []),
      ...(decision.past ? [`Would start on ${owner()}'s word, past: ${decision.past}`] : []),
      ...(decision.replace || []).map(
        (old) => `Would retire ${old.name} [${String(old.sessionId).slice(0, 8)}]: ${old.why}.`,
      ),
    ].join("\n");
  // The worktree is made before anyone is retired, so its refusal leaves all as it was.
  if (tree) {
    const made = ensureTree(number);
    if (made !== tree) return made;
    // The one lock of before the numbers goes with the first start.
    rmSync(join(root, ".claude", "executor.lock"), { force: true });
  }
  // **A start holds its name** until it is logged, numbered again under the
  // names' guard, so two starts at once never share one; the assistant has
  // one name and its own slot (plans/overlapping-starts-own-names.md).
  const name = (kind !== "assistant" && holdName(kind, liveNames())) || decision.name;
  const args = argsFor(name);
  // **A stale idle session is replaced**: retired and its lock released
  // before the launch, so the new executor's first prompt finds the lock
  // free; a launch that fails gives both back.
  const replaced = (decision.replace || []).map((old) => ({
    old,
    state: readState(old.sessionId),
    lock: readJson(files.lock(number)),
  }));
  for (const { old, state } of replaced) {
    writeJson(files.state(old.sessionId), { ...state, retired: true });
    if (kind === "executor") release(old.sessionId);
  }
  const handed = Object.entries(gone).filter(([, one]) =>
    replaced.some(({ old }) => old.sessionId === one.sessionId),
  );
  for (const [path, one] of handed) writeFileSync(join(root, path), one.text);
  // **The plan and the number are reserved before the launch**: for this
  // process, so a start beside it at one moment takes neither.
  const starter = `start:${process.pid}`;
  // **One assistant start at a time**: a second, before the first is
  // listed, would open a second chat of the one name.
  if (
    kind === "assistant" &&
    !claim("slot:assistant", { holder: starter, name: decision.name, live })
  )
    return `${decision.name} is being opened by another start at this moment: send it the message once plans lists it.`;
  // The session this start replaces gives up the plan its stop claimed.
  if (tree && replace) unclaim(paths[0], replace, { live });
  if (tree) {
    const plan = claim(paths[0], { holder: starter, name, live });
    const slot = plan && claim(`slot:${number}`, { holder: starter, name, live });
    if (!slot) {
      dropName(name);
      if (plan) unclaim(paths[0], starter);
      for (const { old, state, lock } of replaced) {
        writeJson(files.state(old.sessionId), state);
        if (lock?.sessionId === old.sessionId) writeJson(files.lock(number), lock);
      }
      for (const [path, one] of handed) writeFileSync(join(root, path), one.before);
      return `${paths[0]} or executor-${number} was taken by another start at this moment; plans shows the queue.`;
    }
  }
  const seen = launch(args, name, kind, tree || root);
  if (tree) unclaim(`slot:${number}`, starter);
  if (kind === "assistant") unclaim("slot:assistant", starter);
  // A launch that failed keeps the deferral, and with it the timer's pid.
  if (typeof seen === "string" && seen !== "unread") {
    dropName(name);
    if (tree) unclaim(paths[0], starter);
    for (const { old, state, lock } of replaced) {
      writeJson(files.state(old.sessionId), state);
      if (lock?.sessionId === old.sessionId) writeJson(files.lock(number), lock);
    }
    for (const [path, one] of handed) writeFileSync(join(root, path), one.before);
    // A lease's timer that failed to launch leaves its due briefs free, as a refusal does.
    if (leaseTimer) releaseLease(due);
    return seen;
  }
  // The deferrals keep the paths this start did not take, and their timers.
  const deferrals = { executor: ["executor", "asking"], planner: ["planner"] }[kind] || [];
  for (const file of deferrals) dropDeferred(file, paths);
  // **His yes starts one more** (decisions.md#starts-bounded): a start on
  // his word spends it, so a deferral still holding it is re-armed without
  // it, and its timer starts nothing past the guard.
  if (said)
    for (const file of deferrals) {
      const left = readJson(files.deferred(file));
      if (!left?.said) continue;
      const { said: _spent, ...rest } = left;
      writeJson(files.deferred(file), rest);
      defer(
        rest.until,
        rest.why,
        rest.paths || [],
        rest.replace || "",
        agentOfDeferral(file),
        file,
        rest.retired || "",
      );
    }
  // The brief started on ends its lease; a timer's other due briefs are left
  // free, the new planner's at its stops as any planner's.
  if (kind === "planner") releaseLease([...paths, ...due]);
  const unread =
    seen === "unread"
      ? ` claude agents could not be read, so it is not confirmed; its output is in .claude/${basename(startOutput(kind))}.`
      : "";
  const retiredWords = replaced.map(
    ({ old }) => `${old.name} [${String(old.sessionId).slice(0, 8)}] was retired: ${old.why}.`,
  );
  const usage = readJson(files.usage());
  // **The log says why a fresh session started**: the session it retired, a
  // Stop hook's (`replace`, with the hook's `why`) or the ones replaced
  // here, which `plans` prints.
  const oldName =
    live?.find((row) => row.sessionId === replace)?.name || String(replace).slice(0, 8);
  const because = [
    ...(replace && why ? [`${oldName} [${String(replace).slice(0, 8)}] was retired: ${why}.`] : []),
    // A start with nothing replaced says its own why (startOnReady's).
    ...(!replace && why ? [`${why[0].toUpperCase()}${why.slice(1)}.`] : []),
    ...retiredWords,
    ...(pastWords ? [pastWords] : []),
  ].join(" ");
  appendFileSync(
    files.starts(),
    `${JSON.stringify({ at: Date.now(), name, paths, five: usage?.five_hour?.used_percentage ?? null, seven: usage?.seven_day?.used_percentage ?? null, ...(because ? { why: because } : {}), ...(said ? { said } : {}) })}\n`,
  );
  // Logged, the name is counted from the log: the held one goes.
  dropName(name);
  // The session replaced is stopped three minutes on: a tired executor, or a
  // retired planner whose chat was its plan's until this next planner.
  if (replace) stopLater(replace, live);
  // A replaced session is stopped three minutes on; a planner by the sweep
  // below, which finds it retired.
  for (const { old } of replaced) if (kind === "executor") stopLater(old.sessionId, live);
  // A planner started by the assistant, with nothing to replace, still ends
  // the retired planners' chats: the next planner starting is their cut-off.
  if (kind === "planner") stopRetiredPlanners(live, { except: replace });
  // **The plan is claimed for the executor started on it**, so no other start
  // takes it before its Building line.
  out.started = { name, path: paths[0], number: tree ? number : 0 };
  if (tree) {
    const row = liveSessions({ fresh: true })?.find((one) => one.name === name);
    // Not listed yet: held by the id the launch read, else by its name, until
    // it is listed, or for the start's span ("A start sees its session"). The
    // start's own claim is handed over in the same write, so no other takes
    // the plan between.
    const id = row ? row.sessionId : seen?.id?.length >= 8 ? seen.id : "";
    claim(paths[0], {
      holder: id || `name:${name}`,
      name,
      from: starter,
      launched: !row && Boolean(seen?.launched) && Boolean(id),
    });
  }
  const what = paths.length
    ? `was started on: ${paths.join(", ")}${tree ? `, in ${basename(tree)}` : ""}`
    : `was opened for ${owner()}`;
  return [
    `${name} ${what}.${unread}${decision.note ? ` ${decision.note}` : ""}${pastWords ? ` ${pastWords}` : ""}`,
    ...retiredWords,
  ].join(" ");
}

/** "on main" once a built commit reached `main`, else "on <branch>". */
function onWhere(sha) {
  if (!sha) return "";
  if (branch() === "main") return "on main";
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"], {
      cwd: root,
      stdio: "ignore",
    });
    return "on main";
  } catch {
    return `on ${branch()}`;
  }
}

/**
 * The pull requests' states, by number, in lower case (`draft`, `open`,
 * `merged`, `closed`), from one `gh pr list --state all`; null when `gh`
 * cannot be read. An open draft is `draft`: it waits on its owner's review
 * (decisions.md#draft-until-reviewed).
 */
function pullStates() {
  try {
    const out = execFileSync(
      "gh",
      ["pr", "list", "--state", "all", "--limit", "100", "--json", "number,state,isDraft"],
      { cwd: root, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
    );
    return new Map(
      JSON.parse(out).map((pull) => [
        pull.number,
        pull.state === "OPEN" && pull.isDraft === true ? "draft" : String(pull.state).toLowerCase(),
      ]),
    );
  } catch {
    return null;
  }
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

/** An executor's worktree, `.claude/worktrees/executor-<n>`, as an absolute path. */
function executorTree(n) {
  return join(root, ".claude", "worktrees", `executor-${n}`);
}

/**
 * The `<n>` of the `executor-<n>` worktree a folder is in, or 0 for any
 * other folder, the checkout and Claude Code's own worktrees included.
 */
function numberOf(cwd) {
  if (!cwd) return 0;
  // As given and by real paths, so a checkout reached through a link
  // (macOS's /tmp, a linked home) still finds its worktrees.
  const trees = join(root, ".claude", "worktrees");
  for (const [base, dir] of [
    [trees, cwd],
    [realPath(trees), realPath(cwd)],
  ]) {
    const match = /^executor-([1-9][0-9]*)(?:[\\/]|$)/.exec(relative(base, dir));
    if (match) return Number(match[1]);
  }
  return 0;
}

/**
 * An executor session's number: its folder's, else the `WORKFLOW_EXECUTOR`
 * its worktree's settings gave it, so a chat whose folder left the worktree
 * (a `cd` into the added plans/) is still that executor.
 */
function executorNumber(input) {
  return numberOf(input?.cwd) || Number(process.env.WORKFLOW_EXECUTOR) || 0;
}

const TRACKED_PLANS =
  "plans/ holds files tracked by git, and an executor's worktree would carry its own copy of them: take the folder out of git (git rm -r --cached plans) and ignore it, then start again.";
const TRACKED_SETTINGS =
  ".claude/settings.local.json is tracked by git, and an executor's worktree writes its number there: take it out of git (git rm --cached .claude/settings.local.json) and ignore it, then start again.";

/**
 * **An executor builds in its own worktree**
 * (decisions.md#executors-in-worktrees): `.claude/worktrees/executor-<n>`,
 * made from `origin/<branch>` with plain git when `git worktree list` lacks
 * it, and left as it is when there, since the executor's "Start clean" deals
 * with what is in it. Its `plans` is a link to the checkout's; the
 * git-ignored files it lacks come by `.worktreeinclude`, the `.env` files
 * with none, and an untracked project file always, so the executor and its
 * hooks read one file at one path; and its number reaches the chat by the
 * tree's `.claude/settings.local.json` `env`, since `claude --bg` hands the
 * chat to a process started before the launch, with the daemon's
 * environment, which is why a tracked one refuses the start: the worktree
 * would start dirty. The path, or the refusal's line.
 */
function ensureTree(n) {
  // Tracked in the checkout's index or at the branch the worktree is made from.
  const tracked = (path) => {
    let listed = "";
    for (const args of [
      ["ls-files", "--", path],
      ["ls-tree", "-r", "--name-only", `origin/${branch()}`, "--", path],
    ])
      try {
        listed ||= git(args, { timeout: 4000 });
      } catch {
        // Unread: the worktree's own add says what is wrong.
      }
    return Boolean(listed);
  };
  if (tracked("plans")) return TRACKED_PLANS;
  // Git's paths, with `/` on every system.
  const settingsFile = ".claude/settings.local.json";
  const projectPath = ".claude/workflow.md";
  if (tracked(settingsFile)) return TRACKED_SETTINGS;
  const path = executorTree(n);
  // By real paths, as git may list a linked checkout's; a listed folder gone
  // from the disk is pruned and made again.
  const listed = worktreePaths().some((one) => realPath(one) === realPath(path));
  if (!listed || !existsSync(path)) {
    try {
      git(["worktree", "prune"]);
      git(["worktree", "add", "--detach", path, `origin/${branch()}`]);
    } catch (error) {
      const said = String(error?.stderr || error?.message || "")
        .split("\n")
        .map((line) => line.replace(/^fatal:\s*/, "").trim())
        .find(Boolean);
      return `The worktree .claude/worktrees/executor-${n} could not be made from origin/${branch()}: ${(said || "git refused").replace(/[.\s]+$/, "")}.`;
    }
    treesRead = undefined;
  }
  mkdirSync(join(root, "plans"), { recursive: true });
  const link = join(path, "plans");
  let there = true;
  try {
    lstatSync(link);
  } catch {
    there = false;
  }
  if (!there) symlinkSync(join(root, "plans"), link);
  else if (realPath(link) !== realPath(join(root, "plans")))
    return `.claude/worktrees/executor-${n}/plans is a folder of its own, not the link to the checkout's plans/: move what is in it to plans/ and remove it, then start again.`;
  // An untracked project file is carried, and ignored like the link, so the
  // worktree starts clean.
  const projectFile = existsSync(join(root, projectPath)) && !tracked(projectPath);
  for (const entry of projectFile ? ["plans", projectPath] : ["plans"])
    if (spawnSync("git", ["check-ignore", "-q", entry], { cwd: path }).status !== 0) {
      const where = spawnSync("git", ["rev-parse", "--git-path", "info/exclude"], {
        cwd: path,
        encoding: "utf8",
      });
      if (where.status === 0) {
        const file = resolve(path, where.stdout.trim());
        mkdirSync(dirname(file), { recursive: true });
        const text = existsSync(file) ? readFileSync(file, "utf8") : "";
        writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}/${entry}\n`);
      }
    }
  for (const file of new Set(projectFile ? [...carried(), projectPath] : carried())) {
    const from = join(root, file);
    const to = join(path, file);
    try {
      // The project file is the checkout's, whatever its date: a restored
      // older copy still carries a newly denied tool.
      const same =
        file === projectPath
          ? existsSync(to) && readFileSync(to, "utf8") === readFileSync(from, "utf8")
          : existsSync(to) && statSync(to).mtimeMs >= statSync(from).mtimeMs;
      if (same) continue;
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    } catch {
      // A file that cannot be copied is the build's to miss, not the start's.
    }
  }
  // A kept worktree left on a branch that tracks the settings file is
  // refused as the checkout is.
  if (spawnSync("git", ["ls-files", "--error-unmatch", settingsFile], { cwd: path }).status === 0)
    return TRACKED_SETTINGS;
  // Merged into what is there, written whole by a rename; a file that is
  // there and no JSON object is left as it is, never overwritten.
  const settings = join(path, settingsFile);
  const local = existsSync(settings) ? readJson(settings) : {};
  if (local && typeof local === "object" && !Array.isArray(local)) {
    mkdirSync(dirname(settings), { recursive: true });
    const temp = `${settings}.${process.pid}.tmp`;
    writeFileSync(
      temp,
      `${JSON.stringify({ ...local, env: { ...(local.env || {}), WORKFLOW_EXECUTOR: String(n) } }, null, 2)}\n`,
    );
    renameSync(temp, settings);
  }
  return path;
}

/**
 * The checkout's git-ignored files a worktree is given: those
 * `.worktreeinclude` lists (gitignore syntax) that git ignores, Claude
 * Code's own rule; with no such file, each ignored `.env` or `.env.<x>`
 * whose folder is not itself ignored.
 */
function carried() {
  const list = (args) => {
    try {
      return git(["ls-files", "-z", ...args], { timeout: 10_000 })
        .split("\0")
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const include = join(root, ".worktreeinclude");
  if (!existsSync(include))
    return list(["--others", "--ignored", "--exclude-standard", "--directory"]).filter(
      (file) => !file.endsWith("/") && /^\.env(\..+)?$/.test(basename(file)),
    );
  const named = list(["--others", "--ignored", `--exclude-from=${include}`]);
  if (!named.length) return [];
  const ignored = spawnSync("git", ["check-ignore", "-z", "--stdin"], {
    cwd: root,
    input: named.join("\0"),
    encoding: "utf8",
  });
  return (ignored.stdout || "").split("\0").filter(Boolean);
}

/**
 * The primary checkout, the one the hooks run from, even from inside a
 * worktree; else the root. A repository with a separate git folder lists
 * that folder first, no checkout: the root, which `checkoutOf` found, is the
 * checkout then.
 */
function primaryCheckout() {
  try {
    const first = git(["worktree", "list", "--porcelain"])
      .split("\n")
      .find((line) => line.startsWith("worktree "));
    if (first && existsSync(join(first.slice(9), ".git"))) return first.slice(9);
  } catch {
    // Not a repository's worktree list: the root it was given.
  }
  return root;
}

/**
 * **`plans sync`**: moves the checkout, detached or on a branch, whose tracked
 * files are unchanged and which holds no commit the project's branch lacks, to
 * `origin/<branch>`, detached, or says why not. One line either way. Nobody
 * builds in the checkout (decisions.md#executors-in-worktrees), so a branch
 * left checked out there is moved too.
 *
 * Always the primary checkout, the one the hooks run from, even when run
 * from inside a worktree. `fetch: false` inside a hook, which the plugin's
 * `hooks.json` gives ninety seconds (the Stop and StopFailure hooks) or twenty
 * (the prompt hook): a slow fetch there would kill the Stop hook after it
 * retired its session and before it started the next. Worktrees share the
 * repository's refs, so `origin/<branch>` is as new as the last push or fetch
 * from any of them.
 */
export function sync({ fetch = true } = {}) {
  const cwd = primaryCheckout();
  const run = (args, options = {}) => git(args, { cwd, ...options });
  let note = "";
  if (fetch) {
    try {
      run(["fetch", "origin"], { timeout: 15_000 });
    } catch (error) {
      const why = String(error.stderr || error.message)
        .split("\n")[0]
        .trim();
      note = `git fetch failed (${why}), so this is ${branch()} as last fetched. `;
    }
  }
  // A kind of queue file new since the project was set up is ignored
  // before the checkout is called clean; not in a repository the queue is not in.
  const added = proj().found ? ignoreQueueFiles(cwd) : "";
  if (added) note += `${added} `;
  try {
    let onBranch = "";
    try {
      onBranch = run(["symbolic-ref", "-q", "--short", "HEAD"]);
    } catch {
      // Detached.
    }
    // **An untracked file never holds the checkout**: git carries an untracked file across a
    // detach unchanged, the queue's working files under `plans/` and the
    // owner's `.env` alike. A tracked file changed (` M README`) still holds
    // it, a commit perhaps not made.
    const changes = run(["status", "--porcelain"])
      .split("\n")
      .filter((line) => line && !line.startsWith("?? "));
    if (changes.length)
      return `${note}Not moved: the checkout has changes; commit, stash or discard them first.`;
    const head = run(["rev-parse", "HEAD"]);
    const target = `origin/${branch()}`;
    const tip = run(["rev-parse", target]);
    if (head === tip && !onBranch) return `${note}Already at ${branch()}, ${tip.slice(0, 8)}.`;
    try {
      run(["merge-base", "--is-ancestor", "HEAD", target]);
    } catch {
      return `${note}Not moved: the checkout is ahead of ${branch()}; push or drop its commits first.`;
    }
    try {
      // An ignored file where the branch now tracks one (a `.env`) is named, never overwritten.
      run(
        [
          "-c",
          "core.quotePath=false",
          "checkout",
          "-q",
          "--no-overwrite-ignore",
          "--detach",
          target,
        ],
        {
          env: { ...process.env, LC_ALL: "C" },
        },
      );
    } catch (error) {
      // An untracked file where the target tracks one, or an untracked
      // directory's files where it tracks a file: git refuses and names each
      // path on a line of its own, indented by a tab, as written on disk.
      const stderr = String(error.stderr || "");
      const refusal =
        /untracked working tree files would be overwritten|would lose untracked files in them/;
      if (!refusal.test(stderr)) throw error;
      const paths = stderr
        .split("\n")
        .filter((line) => line.startsWith("\t"))
        .map((line) => line.trim());
      return `${note}Not moved: untracked files would be overwritten: ${paths.join(", ")}; move them first.`;
    }
    return `${note}The checkout is at ${branch()}, ${tip.slice(0, 8)}.`;
  } catch (error) {
    return `${note}Not moved: ${String(error.message).split("\n")[0]}`;
  }
}

/** The installed Claude Code's version: the target of `~/.local/bin/claude`, under `versions/`. */
function installedVersion() {
  try {
    return basename(realpathSync(join(homedir(), ".local", "bin", "claude")));
  } catch {
    return "";
  }
}

/**
 * A live session's version, from its process's binary (Linux); "" when it
 * cannot be read. Read as a link, not resolved: an updated install deletes
 * the old binary, and the link then ends in " (deleted)".
 */
function versionOfPid(pid) {
  try {
    return pid ? basename(readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "")) : "";
  } catch {
    return "";
  }
}

/**
 * **Which chats run an older Claude Code**: it updates itself in the
 * background, and a session takes the new version when it starts, so the
 * queue's are current and the owner's long chats are not. "" when every
 * readable one matches.
 */
export function versionLine(
  live,
  { installed = installedVersion(), versionOf = versionOfPid } = {},
) {
  if (!live || !installed || !/^\d+\.\d+\.\d+/.test(installed)) return "";
  const byVersion = new Map();
  for (const row of live) {
    const version = versionOf(row.pid);
    if (!version || version === installed || !/^\d+\.\d+\.\d+/.test(version)) continue;
    const who = `${row.name || "a chat"} [${String(row.sessionId).slice(0, 8)}]`;
    byVersion.set(version, [...(byVersion.get(version) || []), who]);
  }
  if (!byVersion.size) return "";
  const parts = [...byVersion].map(
    ([version, who]) =>
      `${who.length === 1 ? who[0] : `${who.slice(0, -1).join(", ")} and ${who.at(-1)}`} ${who.length === 1 ? "runs" : "run"} ${version}`,
  );
  return `Claude Code ${installed} is installed; ${parts.join("; ")}: a chat picks the new version up when it is restarted (claude --resume <id>).`;
}

/**
 * The table `plans` prints. `related: false` from the hooks, so a prompt
 * reads nothing from the network; `readers`, what `relatedReaders` returns,
 * for the tests.
 */
export function list({ all = false, live, related = true, readers = null } = {}) {
  // **The compact form has no queue**: one line, and no session is read.
  if (proj().found && proj().form === "compact") return COMPACT;
  live = live === undefined ? liveSessions() : live;
  const plans = withAsking(readPlans(join(root, "plans"), liveIds(live)), live);
  const locks = readLocks();
  const lock = locks.find((one) => !one.released) || null;
  const nameOf = (id) => live?.find((row) => row.sessionId === id)?.name || String(id).slice(0, 8);
  const now = new Date();
  const out = [];
  if (!proj().found) out.push(NO_PROJECT);
  const trees = worktrees();
  // **The executor line comes from the sessions**: a retired executor that kept
  // working held no lock and read as "none alive". The lock alone speaks only
  // when the sessions cannot be read.
  let executor = "";
  const executorRows = live
    ? withShare(
        sessionsOf("executor", live, locks, {
          trees,
          plans,
          fallback: proj().reuse.executor,
          inputs: reuseNow(),
        }),
        "executor",
        plans,
        live,
      )
    : [];
  // **What each executor holds or waits for**, on the row of its number that
  // is not retired, and a line per resource under the executors.
  const holds = holdsNow();
  for (const [name, { slots, waiting }] of holds)
    for (const [words, ones] of [
      [`running ${name}`, slots],
      [`waiting for ${name}`, waiting],
    ])
      for (const one of ones) {
        const rows = executorRows.filter((row) => one.executor && row.number === one.executor);
        const row = rows.find((each) => !each.retired) || rows[0];
        if (row) row.holding = [...(row.holding || []), words];
      }
  if (proj().executors > 1) executor = executorsTable(executorRows, plans, live);
  else if (live) executor = sessionsLine("executor", executorRows);
  else if (lock)
    executor = `The executor: ${lock.name || nameOf(lock.sessionId)} [${String(lock.sessionId).slice(0, 8)}], status unknown.`;
  if (!executor || executor === "The executor: none alive.")
    executor = proj().found ? noneAliveWords(plans, live) : "The executor: none alive.";
  const here = machine();
  out.push(`Plans on ${here.name}, ${today(now)} ${hhmm(now)}. ${executor}`);
  out.push(...resourceLines(holds));
  // **The planner line**: the queue's planners only.
  if (live)
    out.push(
      sessionsLine(
        "planner",
        withShare(
          sessionsOf("planner", live, locks, {
            trees,
            plans,
            fallback: proj().reuse.planner,
            inputs: reuseNow(),
          }),
          "planner",
          plans,
          live,
        ),
      ),
    );
  // **The ceilings, and why the last fresh session of each kind
  // started**, with a project file.
  if (proj().found)
    out.push(ceilingsLine(proj().reuse, reuseNow()), ...lastFreshLines(readLog(), proj().name));
  // **The assistant line**, while the one assistant chat is open
  // (decisions.md#one-chat).
  const assistants = live
    ? sessionsOf("assistant", live, locks, { trees, plans, fallback: proj().reuse.assistant })
    : [];
  if (assistants.length) out.push(sessionsLine("assistant", assistants));
  const versions = versionLine(live);
  if (versions) out.push(versions);
  // **The webhook's line**, in a project with issues
  // (decisions.md#github-webhook), or with pull requests and the webhook's
  // secret.
  const issues = proj().found && hasIssues();
  if (
    issues ||
    (proj().found && proj().land === "pull-request" && secret("WORKFLOW_WEBHOOK_SECRET"))
  )
    out.push(webhookLine());
  // **Issues off while plans carry them** (decisions.md#closes-its-issues):
  // there no comment reaches the queue and no merge closes an issue.
  if (proj().found && proj().land === "pull-request" && !issues) {
    const line = issuesOffLine(plans);
    if (line) out.push(line);
  }
  // **What GitHub would not give**, with pull requests, a webhook or none:
  // with none the Stop hook's read is the only route.
  if (proj().found && proj().land === "pull-request") out.push(...unreadLines(readSeen()));
  // **A worktree that is no executor's is left over**: the executors'
  // own are in their rows above.
  const under = join(root, ".claude", "worktrees") + "/";
  const leftOver = trees.filter((tree) => tree.path.startsWith(under) && !numberOf(tree.path));
  if (leftOver.length)
    out.push(
      `Worktrees under .claude/worktrees: ${leftOver
        .map(
          (tree) => `left over: ${basename(tree.path)}${tree.branch ? ` on ${tree.branch}` : ""}`,
        )
        .join(", ")}.`,
    );
  const paused = pausedSince();
  if (paused)
    out.push(`The queue is paused since ${paused} ("resume the queue" in any session lifts it).`);
  for (const kind of QUEUE_KINDS) {
    const deferred = readJson(files.deferred(kind));
    // A brief's lease, one line each (decisions.md#brief-leased).
    if (deferred && kind === "handed") out.push(...leaseLines(deferred));
    else if (deferred)
      out.push(
        `Deferred until ${hhmm(deferred.until)}: ${deferred.why ? `${deferred.why}; ` : ""}${deferred.paths.join(", ")}${deferred.pid ? "" : ", held while the queue is paused"}`,
      );
  }
  const width = Math.max(40, ...plans.map((p) => p.path.length + 2));
  const row = (path, rest) => `  ${path.padEnd(width)} ${rest}`;
  // **What each brief and ready plan looks related to**, in the pull request
  // mode: read once, and only when such a row exists, as `pullStates` is.
  const byPull = proj().land === "pull-request";
  const briefRows = plans.filter((p) => p.state === "brief" || p.state === "planning");
  // **What each waits on or who takes it**.
  const claims = readClaims(plans, live);
  const waits = new Map(freePlans(plans, { claims }).map((p) => [p.path, p.waitsOn]));
  const treeNumbers = worktrees().map((tree) => numberOf(tree.path));
  let poolRows;
  const readyRows = plans
    .filter((p) => (p.state === "ready" || p.state === "handed") && !p.askingIn)
    .map((p) => {
      // A handed plan whose own worktree's executor is at work waits for it.
      const own = ownTree(p, proj().executors, treeNumbers);
      const busyThere =
        own &&
        !takerFor(p, {
          executors: proj().executors,
          sessions: (poolRows ??= live ? sessionsOf("executor", live, readLocks(), { plans }) : []),
          claims,
          trees: treeNumbers,
        });
      return {
        ...p,
        waitsOn: waits.get(p.path) || null,
        waitsTree: busyThere ? own : 0,
        claim: claims[p.path] || null,
      };
    });
  const readRelated = byPull && related && (briefRows.length || readyRows.length);
  const work = readRelated ? readers || relatedReaders() : null;
  let unreadSaid = false;
  // Two spaces past the path's column; the line that `gh` was not read, once.
  const own = work ? ownOf(plans) : null;
  const relatedUnder = (plan) => {
    if (!work) return [];
    // A ready plan's own topic: its Lands line's, or its file name's.
    const topic =
      plan.state === "brief" || plan.state === "planning"
        ? ""
        : plan.lands?.kind === "fix" || plan.lands?.kind === "refresh"
          ? ""
          : plan.lands?.name || basename(plan.path, ".md");
    const lines = relatedLines(plan.text, plans, work, { topic, own });
    if (!work.pulls && !unreadSaid) {
      unreadSaid = true;
      lines.unshift("related work not read (gh)");
    }
    return lines.map((line) => `    ${line}`);
  };
  const group = (title, items, rest, under = () => []) => {
    if (!items.length) return;
    // **A group with a row put first says so** (decisions.md#plan-put-first).
    out.push(
      "",
      items.some((p) => p.first)
        ? title.replace(/oldest first$/, "put first, then oldest first")
        : title,
    );
    for (const plan of items) out.push(row(plan.path, rest(plan)), ...under(plan));
  };
  group(
    "Building",
    plans.filter((p) => p.state === "building"),
    (p) => `${nameOf(p.session)}, since ${p.since}`,
  );
  group(
    "Briefs, oldest first",
    briefRows,
    (p) =>
      p.state === "planning"
        ? [`${nameOf(p.session)}, since ${p.since}`, firstWords(p)].filter(Boolean).join(", ")
        : [
            [`brief${p.day ? `, ${p.day.replace(/ \d{4}$/, "")}` : ""}`, firstWords(p)]
              .filter(Boolean)
              .join(", "),
            p.stale ? "(a Planning line from a session that is gone)" : "",
          ]
            .filter(Boolean)
            .join(" "),
    relatedUnder,
  );
  // **Asked once**: a plan its planner is asking about, with the chat to
  // answer in and the time the executor takes over.
  group(
    `Asking ${owner()}, oldest first`,
    plans.filter((p) => p.askingIn),
    (p) =>
      `${p.kind}, ${p.day.replace(/ \d{4}$/, "")}${p.first ? `, ${firstWords(p)}` : ""}, in ${p.askingIn.row.name || "a planner"} [${String(p.askingIn.row.sessionId).slice(0, 8)}], ${statusOf(p.askingIn.row)}, the executor decides at ${hhmm(p.askingIn.until)}`,
  );
  // **A plan with an issue waits for Ready**: its issue, and the day it was
  // planned.
  group(
    "Planned, waiting on GitHub",
    plans.filter((p) => p.state === "planned" && !p.askingIn),
    (p) =>
      `#${p.issue}${p.first ? `, ${firstWords(p)}` : ""}, since ${p.day.replace(/ \d{4}$/, "")}`,
  );
  // **What was opened on GitHub and nothing carries yet**
  // (decisions.md#github-webhook).
  if (issues) {
    const carried = new Set(plans.filter((p) => p.issue).map((p) => p.issue));
    const fresh = Object.entries(readJson(files.githubSeen())?.fresh || {}).filter(
      ([n]) => !carried.has(Number(n)),
    );
    if (fresh.length)
      out.push(
        "",
        "New on GitHub",
        ...fresh.map(([n, one]) => `  #${n} ${one.title || ""}`.trimEnd()),
      );
  }
  // A note waits with issues on or off: failed runs and merges are noted in any
  // project with pull requests (decisions.md#merge-refreshes-the-rest).
  if (proj().found && proj().land === "pull-request") {
    const waiting = notesWaiting();
    // Each with whether the open assistant chat was sent it
    // (decisions.md#note-sent-to-open-chat).
    const told = readTold();
    const words = (entry) =>
      !entry
        ? ""
        : entry.ok
          ? `, sent to ${entry.to} at ${hhmm(entry.at)}`
          : `, not sent: ${entry.why}`;
    if (waiting.length)
      out.push(
        "",
        "From GitHub, not handled",
        ...waiting.map((path) => `  ${path}${words(toldOf(path, told))}`),
      );
  }
  // **Where each lands**, in the pull request mode, before the build, and
  // what its author marked it related to.
  group(
    "Ready, oldest first",
    readyRows,
    (p) =>
      [
        `${p.kind}, ${p.day.replace(/ \d{4}$/, "")}`,
        firstWords(p),
        // A plan with no Lands line is a topic of its own.
        byPull ? landsWords(p.lands || { kind: "topic", name: basename(p.path, ".md") }) : "",
        byPull && p.relatedTo ? `related: ${relatedWords(p.relatedTo)}` : "",
        p.state === "handed" ? "handed over, resume" : "",
        p.waitsOn ? `waits on ${p.waitsOn.path} (${p.waitsOn.why})` : "",
        p.waitsTree ? `waits on executor-${p.waitsTree}, where it was built` : "",
        p.claim
          ? `${p.claim.name || String(p.claim.holder).slice(0, 8)} takes it, since ${hhmm(p.claim.at)}`
          : "",
        p.asks ? "unanswered, the executor decides" : "",
        p.stuck ? "stuck, the assistant takes it" : "",
        p.stale ? "(a Building line from a session that is gone)" : "",
      ]
        .filter(Boolean)
        .join(", "),
    relatedUnder,
  );
  const built = plans.filter((p) => p.state === "built");
  // The date a Built or Dropped heading starts with, whatever follows it.
  const onDay = (day) =>
    parseDay(new RegExp(`^(?:${DAY})`).exec(day.trim())?.[0] || "") === parseDay(today(now));
  const shown = all ? built : built.filter((p) => onDay(p.builtDay));
  // A plan landed by pull request is listed by it, its state from one `gh`
  // call, made only when a row names one.
  const states = shown.some((p) => p.pr) ? pullStates() : null;
  group(all ? "Built" : "Built today", shown, (p) =>
    p.refresh
      ? "a refresh"
      : p.pr
        ? [`#${p.pr}`, states?.get(p.pr)].filter(Boolean).join(", ")
        : p.topic
          ? `topic ${p.topic}, ${p.noPull ? "no pull request" : "its pull request waits"}`
          : [p.sha, onWhere(p.sha), p.fix ? "a fix" : ""].filter(Boolean).join(", "),
  );
  // **A dropped plan is on screen only on its day**
  // (decisions.md#plan-state-in-file), with its date and its why; every
  // one with `--all`.
  const dropped = plans.filter((p) => p.state === "dropped");
  group(
    all ? "Dropped" : "Dropped today",
    // By the calendar day, so a drop dated 2026-10-30 is today's too.
    all ? dropped : dropped.filter((p) => onDay(p.droppedDay)),
    (p) =>
      `dropped${p.droppedDay ? `, ${p.droppedDay.replace(/ \d{4}$/, "")}` : ""}${p.why ? `: ${p.why}` : ""}`,
  );
  // **The topics built and waiting for their pull request**, oldest first:
  // a topic none of whose built plans names one yet, but one each of whose
  // plans says it has none to open; each with why it waits
  // (decisions.md#topic-landing). The plan that opened it names the pull
  // request, not the topic: its `Lands` line does.
  const opened = new Set(
    built.filter((p) => p.pr).flatMap((p) => [p.topic, p.lands?.name].filter(Boolean)),
  );
  const topics = new Map();
  for (const p of built)
    if (p.topic && !p.pr && !opened.has(p.topic))
      topics.set(p.topic, [...(topics.get(p.topic) || []), p]);
  const why = (name) => {
    if (name.startsWith("fixes-"))
      return "the day's fixes, opened at a plan's start once its day has come";
    const queued = topicQueued(plans, name).map((p) => p.path);
    if (!queued.length) return "nothing is queued for it, so the next plan's start opens it";
    return `opens once ${andList(queued)} ${queued.length === 1 ? "is" : "are"} built`;
  };
  const waitingTopics = [...topics].filter(([, ps]) => !ps.every((p) => p.noPull));
  if (waitingTopics.length)
    out.push(
      "",
      "Topics waiting for a pull request",
      ...waitingTopics.map(
        ([name, ps]) => `  ${name}: ${ps.map((p) => p.path).join(", ")}; ${why(name)}`,
      ),
    );
  const old = plans.filter((p) => p.state === "old").length;
  if (old)
    out.push(
      "",
      `Older, by path only: ${old} plan${old === 1 ? "" : "s"} dated before 24 October with no Built`,
    );
  const unread = unreadPlans();
  // A plan still to land whose Lands line is not read: listed, never taken
  // for a topic named for its file unsaid; only where the line means
  // something, the pull request mode.
  const landsNotRead = byPull
    ? plans
        .filter(
          (p) => !p.lands && !["built", "dropped", "old"].includes(p.state) && landsUnread(p.text),
        )
        .map((p) => p.path)
    : [];
  // A waiting file's First line the queue does not read
  // (decisions.md#plan-put-first), in either landing mode: said, so the
  // order is not silently oldest first.
  const firstNotRead = plans
    .filter((p) => WAITING_STATES.includes(p.state) && !p.first && firstUnread(p.text))
    .map((p) => p.path);
  if (unread.headless.length || unread.failed.length || landsNotRead.length || firstNotRead.length)
    out.push("");
  if (unread.headless.length)
    out.push(`Not read by the queue (no header found): ${unread.headless.join(", ")}`);
  if (unread.failed.length)
    out.push(`Not read by the queue (the file could not be read): ${unread.failed.join(", ")}`);
  if (landsNotRead.length) out.push(`Lands line not read: ${landsNotRead.join(", ")}`);
  if (firstNotRead.length) out.push(`First line not read: ${firstNotRead.join(", ")}`);
  // **The label is said where the queue is read**
  // (decisions.md#session-names), while the hostname stands in for it.
  if (!here.set)
    out.push(
      "",
      `${here.rejected ? `The plugin's "machine" option, "${here.rejected}", is no label (letters, digits, underscores, dots and hyphens), so this machine` : "This machine"} is named by its hostname; the plugin's "machine" option names it: /plugin configure workflow in a chat, or echo '{"machine":"<label>"}' | claude plugin configure workflow@workflow --values-stdin.`,
    );
  return out.join("\n");
}

/**
 * The project's run on its branch (`run` in the project file); null with
 * none, or unread. With `only`, the commits a fix pushed straight landed
 * (their Built lines' shas, seven or eight hex digits): null unless HEAD is one of them, so
 * the pull request mode never answers for a run another person's merge set off.
 */
function imageRun({ only = null, tree = root } = {}) {
  const workflow = proj().run;
  if (!workflow) return null;
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tree, encoding: "utf8" }).trim();
    if (only && !only.some((sha) => head.startsWith(sha))) return null;
    const out = execFileSync(
      "gh",
      [
        "run",
        "list",
        "--branch",
        branch(),
        "--workflow",
        workflow,
        "--limit",
        "1",
        "--json",
        "databaseId,status,conclusion,headSha",
      ],
      { cwd: root, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const run = JSON.parse(out)[0];
    if (!run) return null;
    return {
      id: run.databaseId,
      status: run.status,
      conclusion: run.conclusion,
      onHead: run.headSha === head,
      workflow,
    };
  } catch {
    process.stderr.write(`plan-queue: the ${workflow} run could not be read (gh)\n`);
    return null;
  }
}

/**
 * **The pull requests' checks, then the run of a fix pushed straight**, as
 * one answer for `decideStop`: the pull request is named first, and a run
 * not green on HEAD rides along in its words and its id, so the loop guard
 * does not let a continued stop pass a run never named.
 */
export function pullThenRun(pull, run) {
  const green = (r) => r.status === "completed" && r.conclusion === "success";
  if (!pull) return run;
  if (!run || !run.onHead || green(run)) return pull;
  return { ...pull, id: `${pull.id},run ${run.id}`, pull: { ...pull.pull, run } };
}

/** A rollup entry that is a commit status, not a check run. */
const isContext = (check) =>
  check.__typename === "StatusContext" || (!("status" in check) && "state" in check);

/**
 * **The verdict on a pull request's checks**, from `gh pr list --json
 * statusCheckRollup`: "red" when a check run concluded in failure, timed out
 * or startup failure (`FAILED_CONCLUSIONS`, the webhook's own) or a status
 * context's state is FAILURE or ERROR, "running" when a check run is not
 * COMPLETED or a context is PENDING or EXPECTED, else "green", an empty
 * rollup included: a project with no checks has nothing to wait for. Red
 * beats running. Cancelled, action required and stale are not red: a
 * cancelled check was superseded or stopped by a person, one that needs
 * action waits on a person, on the pull request's page, and only GitHub
 * marks one stale (decisions.md#github-webhook).
 */
export function checksVerdict(rollup = []) {
  let running = false;
  for (const check of rollup || []) {
    if (!check) continue;
    if (isContext(check)) {
      const state = String(check.state || "").toUpperCase();
      if (state === "FAILURE" || state === "ERROR") return "red";
      if (state === "PENDING" || state === "EXPECTED") running = true;
      continue;
    }
    if (FAILED_CONCLUSIONS.includes(String(check.conclusion || "").toLowerCase())) return "red";
    if (String(check.status || "").toUpperCase() !== "COMPLETED") running = true;
  }
  return running ? "running" : "green";
}

/**
 * **The checks by another service** in a `statusCheckRollup`: the commit
 * statuses and the check runs whose `detailsUrl` is no Actions run, which no
 * Actions event carries to the webhook (decisions.md#github-webhook).
 */
export function otherServices(rollup = []) {
  return (rollup || []).filter(
    (check) => check && (isContext(check) || !/\/actions\/runs\/\d+/.test(check.detailsUrl || "")),
  );
}

/**
 * **The failed checks on this checkout's pull requests** (`land:
 * pull-request`): the open pull requests whose head branch is a local branch
 * here at the same commit, from one `gh pr list`; the first whose checks are
 * red, in the run's shape (`id` its number and commit, so a push is asked
 * about again), for `decideStop`. With `brought`, a webhook brings the
 * Actions runs to the assistant, and only another service's checks are
 * judged (`other` in the answer). Running checks are not waited on
 * (decisions.md#push-not-waited-on). Null when none is red, none is this
 * checkout's, or `gh` cannot be read.
 */
function pullChecks({ brought = false, only = null } = {}) {
  try {
    const { out, why } = checksRead([
      "pr",
      "list",
      "--state",
      "open",
      // Past fifty, so a busy repository's own pull request is still read.
      "--limit",
      "200",
      "--json",
      "number,url,headRefName,headRefOid,statusCheckRollup",
    ]);
    noteChecksUnread(out === null ? why : null);
    if (out === null) throw new Error(why);
    // The local branches at their commits, in one call; a pull request whose
    // head is none of them is another person's.
    const local = new Map(
      git(["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"], {
        timeout: 4000,
      })
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ")),
    );
    const open = JSON.parse(out)
      .filter((pull) => local.get(pull.headRefName) === pull.headRefOid)
      // **Each executor answers for its own**: the pull requests of the
      // plans this session took.
      .filter((pull) => !only || only.includes(pull.number))
      .map((pull) => ({
        ...pull,
        verdict: checksVerdict(
          brought ? otherServices(pull.statusCheckRollup) : pull.statusCheckRollup,
        ),
      }))
      .filter((pull) => pull.verdict === "red");
    if (!open.length) return null;
    const [first, ...rest] = open;
    return {
      // Every pull request red is in the id, so the loop guard lets a
      // continued stop pass only once all of them were named.
      id: open.map((pull) => `${pull.number}@${pull.headRefOid}`).join(","),
      status: "completed",
      conclusion: "failure",
      onHead: true,
      pull: {
        number: first.number,
        url: first.url,
        also: rest.map((pull) => pull.number),
        other: brought,
      },
    };
  } catch {
    process.stderr.write("plan-queue: the pull requests' checks could not be read (gh)\n");
    return null;
  }
}

/**
 * **The checks read with the person's token, then the app's**: `gh` on the
 * person's token and, when GitHub refuses it and the project has an app,
 * again as `plans gh`, the one way the queue calls as the app. `{ out, why
 * }`, `out` null when both failed and `why` the first failure's reason. Eight
 * seconds each, so both fit the Stop hook's ninety in hooks.json with the
 * rest of the hook.
 */
function checksRead(args) {
  const person = ghAsk(args, 8000);
  if (person.out !== null) return person;
  const { why } = person;
  if (!secret("WORKFLOW_APP_ID") || !secret("WORKFLOW_APP_KEY")) return { out: null, why };
  try {
    const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), "gh", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 8000,
      env: { ...process.env, WORKFLOW_ROOT: root },
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { out, why: "" };
  } catch {
    return { out: null, why };
  }
}

/**
 * The seen file's `checksUnread`: set to `why` when the checks could not be
 * read, removed when they were (null); written only when it changes, never
 * at every stop.
 */
function noteChecksUnread(why) {
  const seen = readJson(files.githubSeen()) || {};
  if (why === null ? !seen.checksUnread : seen.checksUnread?.why === why) return;
  // Inside the read's guard, so a read's write does not undo it; taken by a
  // read, the next stop sets it.
  const guard = files.githubGuard();
  try {
    mkdirSync(dirname(guard), { recursive: true });
    if (!takeHoldGuard(guard)) return;
  } catch {
    return;
  }
  try {
    const now = readJson(files.githubSeen()) || {};
    const next = { ...now, checksUnread: { at: Date.now(), why } };
    if (why === null) delete next.checksUnread;
    writeJson(files.githubSeen(), next);
  } catch {
    // A checkout it cannot write: the stderr line stands.
  } finally {
    dropGuard(guard);
  }
}

/** Related work names three at most, as GitHub's duplicate detection suggests three. */
const RELATED_MAX = 3;
/** A pushed branch is read when its tip is under thirty days old, twenty at most. */
const BRANCH_DAYS = 30;
const BRANCHES_MAX = 20;

/**
 * **What a brief or a plan looks related to**: the open pull requests
 * (`pulls`, `{number, title, author, headRefName, files}`) and the pushed
 * branches with none (`branches`, `{name, author, title, files}`) whose
 * changed files include a path in `paths`, the test Gerrit's `conflicts:`
 * makes. A path named matches a changed file equal to it or ending with
 * `/<path>`, since a brief names `scripts/x.mjs` where the repository has
 * `plugins/workflow/scripts/x.mjs`. The most files in common first, a pull
 * request before a branch at the same count, three at most; `own` maps a pull
 * request's number, or a branch or topic name, to the plan of this queue that
 * holds it; a pull request's match keeps its head branch (`head`). Pure, so a
 * project's own hook can copy it.
 */
export function relatedWork(paths = [], { pulls = [], branches = [], own = new Map() } = {}) {
  const common = (files = []) =>
    files.filter((file) => paths.some((path) => file === path || file.endsWith(`/${path}`)));
  const found = [
    ...(pulls || []).map((pull) => ({
      kind: "pull",
      number: pull.number,
      title: pull.title || "",
      author: pull.author || "",
      files: common(pull.files),
      own: own.get(pull.number) || own.get(pull.headRefName) || "",
      // The head branch is the topic a `Lands` line names to land in it.
      head: pull.headRefName || "",
    })),
    ...(branches || []).map((one) => ({
      kind: "branch",
      name: one.name,
      title: one.title || "",
      author: one.author || "",
      files: common(one.files),
      own: own.get(one.name) || "",
    })),
  ].filter((one) => one.files.length);
  // A stable sort: input order within a count and a kind.
  return found
    .sort(
      (a, b) =>
        b.files.length - a.files.length || Number(a.kind !== "pull") - Number(b.kind !== "pull"),
    )
    .slice(0, RELATED_MAX);
}

/**
 * **This queue's pull requests and topics**, from the plans read already: a
 * built plan's pull request and its topic, and a ready, handed or building
 * plan's topic, each to the plan's path.
 */
export function ownOf(plans = []) {
  const own = new Map();
  for (const plan of plans) {
    if (plan.state === "built") {
      if (plan.pr) own.set(plan.pr, plan.path);
      for (const name of [plan.topic, plan.lands?.name]) if (name) own.set(name, plan.path);
    } else if (
      ["ready", "planned", "handed", "building"].includes(plan.state) &&
      plan.lands?.name
    ) {
      own.set(plan.lands.name, plan.path);
    }
  }
  return own;
}

/** The time left before `deadline`, as a child's timeout: at most `most`, at least 1 ms. */
const left = (deadline, most) => Math.max(1, Math.min(most, deadline - Date.now()));

/**
 * **The open pull requests with their files**, from one `gh pr list`; null
 * when `gh` cannot be read. GitHub lists up to a hundred files per pull
 * request, enough for a file in common.
 */
export function openPulls({ run = execFileSync, timeout = 10_000 } = {}) {
  try {
    const out = run(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        "200",
        "--json",
        "number,title,author,headRefName,files",
      ],
      { cwd: root, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] },
    );
    return JSON.parse(out).map((pull) => ({
      number: pull.number,
      title: pull.title || "",
      author: pull.author?.login || "",
      headRefName: pull.headRefName || "",
      files: (pull.files || []).map((file) => file.path).filter(Boolean),
    }));
  } catch {
    return null;
  }
}

/**
 * **The merged pull requests' heads**, each branch name to the commit it was
 * merged at, from one `gh pr list --state merged`: a branch squash-merged and
 * not deleted still has files past the branch, so one whose tip is still that
 * commit is no open work. Empty when unread.
 */
function mergedHeads({ run = execFileSync, timeout = 10_000 } = {}) {
  try {
    const out = run(
      "gh",
      ["pr", "list", "--state", "merged", "--limit", "100", "--json", "headRefName,headRefOid"],
      { cwd: root, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] },
    );
    return new Map(JSON.parse(out).map((pull) => [pull.headRefName, pull.headRefOid]));
  } catch {
    return new Map();
  }
}

/**
 * **The pushed branches with no open pull request**, with the files each
 * changes past the project's branch: a fetch first (remote-tracking refs
 * only; on a failure, what was fetched already), left out with `fetch:
 * false`, then the remote branches but `HEAD`, the project's branch, `main`,
 * the open pull requests' heads (`heads`) and a merged pull request's head
 * still at the commit it was merged at (`merged`), whose tip is under thirty
 * days old, twenty at most, newest first. A branch with no file past the
 * branch (merged and not deleted) is dropped. Nothing is read past
 * `deadline`, and what was read by then is the answer. `run` is `git(args,
 * options)`, a seam for the tests.
 */
export function pushedBranches({
  run = git,
  base = branch(),
  heads = [],
  merged = new Map(),
  now = Date.now(),
  fetch = true,
  deadline = Infinity,
} = {}) {
  if (fetch) {
    try {
      run(["fetch", "--prune", "--quiet", "origin"], { timeout: left(deadline, 8000) });
    } catch {
      // Offline, or no origin: what was fetched already.
    }
  }
  let refs = "";
  try {
    if (Date.now() >= deadline) return [];
    refs = run(
      [
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)%09%(objectname)%09%(committerdate:unix)%09%(authorname)%09%(subject)",
        "refs/remotes/origin",
      ],
      { timeout: left(deadline, 4000) },
    );
  } catch {
    return [];
  }
  const skip = new Set(["HEAD", base, "main", ...heads]);
  const since = now / 1000 - BRANCH_DAYS * 24 * 60 * 60;
  const candidates = String(refs)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref = "", sha = "", at = "0", author = "", ...subject] = line.split("\t");
      return { ref, sha, at: Number(at), author, title: subject.join("\t") };
    })
    // `origin/HEAD` reads as `origin` in its short form.
    .filter((one) => one.ref.startsWith("origin/"))
    .map((one) => ({ ...one, name: one.ref.slice("origin/".length) }))
    .filter(
      (one) =>
        !skip.has(one.name) && one.at > since && !(one.sha && merged.get(one.name) === one.sha),
    )
    .slice(0, BRANCHES_MAX);
  const out = [];
  for (const one of candidates) {
    if (Date.now() >= deadline) break;
    let files = [];
    try {
      files = String(
        run(["diff", "--name-only", `origin/${base}...origin/${one.name}`], {
          timeout: left(deadline, 4000),
        }),
      )
        .split("\n")
        .filter(Boolean);
    } catch {
      continue;
    }
    if (files.length) out.push({ name: one.name, author: one.author, title: one.title, files });
  }
  return out;
}

/**
 * What `relatedLines` reads: the open pull requests (null when unread) and the
 * pushed branches, inside one `budget` of milliseconds. No fetch while an
 * executor holds a lock, which fetches and pushes in this checkout itself: the
 * branches are then as last fetched.
 */
function relatedReaders({ budget = 25_000 } = {}) {
  const deadline = Date.now() + budget;
  const pulls = openPulls({ timeout: left(deadline, 10_000) });
  const merged = pulls ? mergedHeads({ timeout: left(deadline, 5000) }) : new Map();
  const heads = (pulls || []).map((pull) => pull.headRefName).filter(Boolean);
  // No fetch while an executor builds: its own fetches keep the refs.
  const building = readLocks().some((lock) => !lock.released);
  return {
    pulls,
    branches: pushedBranches({ heads, merged, deadline, fetch: !building }),
  };
}

/**
 * **The related lines for a text**: one per match of `relatedWork`, the pull request by its number and title, a branch by its
 * name and its last commit's title, then whose it is and two files at most.
 * A plan's own topic (`topic`, its branch and its pull request's head) is
 * never related to it; `own` is `ownOf(plans)`, built once by a caller with
 * many rows. A pull request of this queue's own names its topic, the head
 * branch a `Lands` line needs to land in it
 * (decisions.md#pull-requests-heading); the hook decides nothing.
 */
export function relatedLines(
  text,
  plans = [],
  { pulls = [], branches = [] } = {},
  { topic = "", own = ownOf(plans) } = {},
) {
  const others = {
    pulls: (pulls || []).filter((pull) => !topic || pull.headRefName !== topic),
    branches: (branches || []).filter((one) => !topic || one.name !== topic),
  };
  return relatedWork(pathsIn(text), { ...others, own }).map((one) => {
    const files =
      one.files.length > 2
        ? `${one.files.slice(0, 2).join(", ")} and ${one.files.length - 2} more`
        : one.files.join(", ");
    // Only a head a `Lands` line can name is a topic: not the day's fixes or the branch.
    const topicOf =
      one.kind === "pull" &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(one.head) &&
      !/^(?:fixes-|main$)/.test(one.head)
        ? `, topic ${one.head}`
        : "";
    const whose = one.own ? `this queue's, ${one.own}${topicOf}` : one.author;
    const what =
      one.kind === "pull" ? `#${one.number} "${one.title}"` : `branch ${one.name}, "${one.title}"`;
    return `looks related to ${what} (${whose ? `${whose}; ` : ""}both name ${files})`;
  });
}

function hookOutput(event, context) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }),
  );
}

/** A PreToolUse hook's refusal of the call, with its reason. */
function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
}

/**
 * **One lock holder, by an atomic create**: true when this session holds the
 * lock on return, false when another does. The read, the judgement and the
 * write happen while holding a guard file created exclusively (`wx`), so two
 * claimants of a released, dead or missing lock cannot both win; a bare
 * read-then-write could, and so could renaming a stale lock aside, which can
 * move a lock another claimant has just made.
 */
export function takeLock(sessionId, live, { path = files.lock(), alive = null } = {}) {
  const guard = `${path}.guard`;
  if (!takeGuard(guard)) {
    const lock = readJson(path);
    return Boolean(lock && lock.sessionId === sessionId && !lock.released);
  }
  try {
    const lock = readJson(path);
    if (lock && lock.sessionId === sessionId && !lock.released) return true;
    const holderLives = alive ?? ((held) => holderAlive(held, live));
    if (lock && !lock.released && holderLives(lock)) return false;
    const row = live?.find((r) => r.sessionId === sessionId);
    writeJson(path, {
      sessionId,
      pid: row?.pid || null,
      name: row?.name || "",
      taken: Date.now(),
      released: false,
    });
    return true;
  } finally {
    try {
      unlinkSync(guard);
    } catch {
      // Gone already.
    }
  }
}

/**
 * The lock's guard, created exclusively; waits up to three seconds for
 * another claimant to finish. A guard older than ten seconds is a crashed
 * claimant's and is removed (the critical section takes milliseconds).
 */
function takeGuard(guard) {
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      writeFileSync(guard, String(process.pid), { flag: "wx" });
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    try {
      if (Date.now() - statSync(guard).mtimeMs > 10_000) {
        unlinkSync(guard);
        continue;
      }
    } catch {
      // Released between the create and the look: try again.
      continue;
    }
    if (Date.now() > deadline) return false;
    sleep(25);
  }
}

/** Releases each number's lock this session holds. */
function release(sessionId) {
  for (const n of lockNumbers()) {
    const path = files.lock(n);
    const guard = `${path}.guard`;
    const guarded = takeGuard(guard);
    try {
      const lock = readJson(path);
      if (lock && lock.sessionId === sessionId) writeJson(path, { ...lock, released: Date.now() });
    } finally {
      if (guarded)
        try {
          unlinkSync(guard);
        } catch {
          // Gone already.
        }
    }
  }
}

/** The numbers with a lock file, the project's own and any left above them. */
function lockNumbers() {
  let names = [];
  try {
    names = readdirSync(join(root, ".claude"));
  } catch {
    // No .claude: no lock.
  }
  return names
    .map((name) => /^executor\.([1-9][0-9]*)\.lock$/.exec(name)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);
}

/** Every number's lock, each with its `number`. */
function readLocks() {
  return lockNumbers()
    .map((number) => {
      const lock = readJson(files.lock(number));
      return lock ? { ...lock, number } : null;
    })
    .filter(Boolean);
}

/**
 * **What a planner's Stop hook does: the executor's rule, for briefs**.
 * Nothing while a brief carries this session's live Planning line
 * (`current`), while paused, or when retired. With briefs waiting that this
 * session was not told of: it takes the oldest it is under its ceiling for,
 * each brief judged with what it shares with the chat
 * (decisions.md#reuse-check-cheap, `shared`); else it is retired for a fresh
 * planner. With nothing waiting it stays alive, idle and unretired, and a
 * brief reaches it by message.
 */
export function decidePlannerStop({
  current = null,
  waiting = [],
  told = [],
  paused = false,
  retired = false,
  usage = null,
  inputs = {},
  fallback = REUSE_DEFAULT.planner,
  now = Date.now(),
}) {
  if (retired || current || paused) return null;
  const fresh = waiting.filter((brief) => !told.includes(brief.path));
  // **A brief named and not taken goes to a fresh planner**: this live
  // planner refuses every start, so the brief it stopped without taking would
  // otherwise wait for good.
  if (!fresh.length) return waiting.length ? { retire: true, declined: true } : null;
  // Each brief with what it shares with this planner's plans
  // (decisions.md#reuse-check-cheap).
  const judged = fresh.map((brief) => ({
    brief,
    verdict: mayReuse({
      usage,
      shared: brief.shared || 0,
      inputs,
      kind: "planner",
      fallback,
      now,
    }),
  }));
  const taken = judged.find(({ verdict }) => verdict.reuse);
  if (!taken) return { retire: true, why: judged[0].verdict.why };
  const { brief: next, verdict } = taken;
  return {
    refuse: true,
    told: [next.path],
    kept: { paths: [next.path], why: verdict.why },
    reason: `A brief is waiting and this session can take it: ${next.path} (${verdict.why}). Plan it; what you wrote above this line was not a final message.`,
  };
}

/**
 * **A plan is taken once an executor has written on it**: a Building,
 * Built, Handing over or Resumed line, live or not, since a dead executor's
 * work is on its branch. From then on the plan is the executor's and its
 * planner changes nothing.
 */
export function planTaken(text = "") {
  // The executor's own lines, dated, never a plan's "## Building it" section.
  return /^## (?:Building, |Resumed, |Handing over\b)/m.test(text) || BUILT_SECTION.test(text);
}

/**
 * Whether a retired planner is done with a plan: taken by an executor, or
 * dropped on the owner's word (decisions.md#plan-state-in-file), which nobody
 * takes.
 */
function doneWith(text = "") {
  return planTaken(text) || Boolean(droppedOf(text));
}

/** A plan's `Lands` line in words, for a Ready row, with the pull request it lands in or is stacked on; "" with none. */
export function landsWords(lands) {
  if (!lands) return "";
  if (lands.kind === "fix") return lands.now ? "a fix, now" : "a fix";
  if (lands.kind === "refresh") return "a refresh";
  const where = lands.into
    ? `, lands in #${lands.into}`
    : lands.stackedOn
      ? `, stacked on #${lands.stackedOn}`
      : "";
  return `topic ${lands.name}${where}`;
}

/**
 * Who took a plan, for the planner's messages: "Executor 5 [b92bfc2b] on
 * <date>" (the live row's name, else "session b92bfc2b"), or
 * "built, commit <sha>" once it is built ("built, pull request #<n>" when it
 * landed by one, "built, straight to <branch>" for a fix pushed straight,
 * "built, on topic <name>" for a topic waiting); "" when nothing took it.
 */
export function whoTook(text = "", live = null) {
  if (BUILT_SECTION.test(text)) {
    const built = stateOf(text);
    if (built?.refresh) return "built, a refresh";
    if (built?.pr) return `built, pull request #${built.pr}`;
    if (built?.fix)
      return `built, straight to ${/^Pushed straight to (\S+) as a fix/m.exec(text)?.[1] || branch()}`;
    if (built?.topic) return `built, on topic ${built.topic}`;
    const sha = built?.sha || "";
    return sha ? `built, commit ${sha}` : "built";
  }
  const line = /^## (?:Building|Resumed|Handing over), ([^,\n]+)(?:, session ([^\s,]+))?/m.exec(
    text,
  );
  if (!line) return planTaken(text) ? "an executor" : "";
  const [, date, id = ""] = line;
  const full = id && live ? liveId(id, liveIds(live)) : id;
  const row = full ? live?.find((r) => r.sessionId === full) : null;
  const who = row?.name
    ? `${row.name} [${id.slice(0, 8)}]`
    : id
      ? `session ${id.slice(0, 8)}`
      : "an executor";
  return `${who} on ${date.trim()}`;
}

/** "<brief> was taken by Executor 5 [...] on <date>", or "<brief> is built, commit <sha>". */
function takenBy(brief, text, live) {
  const who = whoTook(text, live) || "an executor";
  return who.startsWith("built") ? `${brief} is ${who}` : `${brief} was taken by ${who}`;
}

/**
 * Stops the queue's retired planners whose plan is `path`, once an executor has
 * taken it: a background row the queue counts as a planner, retired, its state
 * naming the plan. the owner's own planner chats are not the queue's. Asked
 * once per half hour, so the executor's sweep on every stop does not pile up
 * timers.
 */
export function stopPlannersOn(
  path,
  live,
  {
    stateFor = readState,
    textOf = planText,
    stop = stopLater,
    write = writeJson,
    now = Date.now(),
  } = {},
) {
  for (const row of live || []) {
    const state = withPlans(stateFor(row.sessionId));
    if (!isSession("planner", row, state, null)) continue;
    // **Only when every plan of its own is taken**: an unretired planner is
    // never stopped by a Building line, being the warm context the next brief
    // goes to.
    const plans = state?.plans || [];
    if (!state?.retired || !plans.includes(path)) continue;
    if (!plans.every((one) => one === path || doneWith(textOf(one)))) continue;
    if (state.stopAsked && now - state.stopAsked < 30 * MINUTE) continue;
    write(files.state(row.sessionId), { ...state, stopAsked: now });
    stop(row.sessionId, live);
  }
}

/** Stops every live retired planner of the queue but `except`: the next planner has started. */
export function stopRetiredPlanners(
  live,
  { except = "", stateFor = readState, stop = stopLater } = {},
) {
  for (const row of live || []) {
    if (row.sessionId === except) continue;
    const state = stateFor(row.sessionId);
    if (isSession("planner", row, state, null) && state?.retired) stop(row.sessionId, live);
  }
}

/**
 * The executor's sweep on every stop: each live retired planner whose plan
 * is taken (`planTaken`, the same rule its tool hook refuses by) is
 * stopped, once a Building line was written some other way than an Edit.
 */
export function stopTakenPlanners(
  live,
  { stateFor = readState, textOf = planText, ...options } = {},
) {
  const paths = new Set();
  for (const row of live || []) {
    const state = withPlans(stateFor(row.sessionId));
    if (!isSession("planner", row, state, null) || !state?.retired) continue;
    const plans = state.plans || [];
    if (plans.length && plans.every((one) => doneWith(textOf(one)))) paths.add(plans[0]);
  }
  for (const path of paths) stopPlannersOn(path, live, { stateFor, textOf, ...options });
}

/**
 * **A planner may still edit its own plans, and only them, until an executor
 * takes each**: the owner goes on discussing a plan in its chat and the planner
 * revises any section, which the executor reads. True for Edit, Write or
 * MultiEdit on one of `plans` or under its sketch folder (`plans/<topic>/`); a
 * Bash command that writes one stays refused.
 */
export function plannerMayEdit({ plans = [], toolName = "", filePath = "", base = root }) {
  if (!["Edit", "Write", "MultiEdit"].includes(toolName)) return false;
  return Boolean(planEdited({ plans, filePath, base }));
}

/** Which of `plans` an edit of `filePath` is to, itself or its sketch folder; "" for none. */
function planEdited({ plans = [], filePath = "", base = root }) {
  if (!filePath) return "";
  const target = resolve(base, filePath);
  return (
    plans.filter(Boolean).find((one) => {
      const plan = resolve(base, one);
      return target === plan || target.startsWith(plan.replace(/\.md$/, "") + sep);
    }) || ""
  );
}

/** The text at a plan's path, or "" when it is gone. */
function planText(path) {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return "";
  }
}

/** A brief named in a prompt: a start prompt, or a message inside its wrapper. */
export const PLANNER_PROMPT = /\bPlan (plans\/\S+\.md): it is a brief/;

/**
 * **What a planner holding plans is told on every prompt**, retired or not:
 * where each of its plans stands, read from the file at that moment, a line
 * each; a retired one is told so (the state, the rules in the agent file).
 */
export function plannerContext(state, live = null, textOf = planText, options = {}) {
  const lines = (state?.plans || []).map((path) => {
    const text = textOf(path);
    if (!text) return `${path} is no longer in plans/.`;
    const dropped = droppedOf(text);
    if (dropped) return droppedWords({ path, ...dropped });
    if (BUILT_SECTION.test(text)) return `${path} is ${whoTook(text, live)}.`;
    if (planTaken(text))
      return `${path} was taken by ${whoTook(text, live)}: it is the executor's.`;
    const yours = `${path} is in the queue and still yours.`;
    // **Asked once**: the plan's question holds it for thirty minutes.
    const plan = { path, ...stateOf(text, { mtime: mtimeOf(path) }) };
    if (!ASKS_STATES.includes(plan.state) || !plan.asks) return yours;
    const asking = askingIn(plan, live, options);
    return asking
      ? `${yours} It asks ${owner()} until ${hhmm(asking.until)}.`
      : `${yours} Its question went unanswered for thirty minutes.`;
  });
  if (state?.retired) lines.push("This session is retired: it plans nothing more.");
  return lines.join("\n");
}

/** **Handed to the assistant**, as the planner's hook strings say it, one wording for every one; another project's assistant writes in another checkout. */
function byMessage() {
  const name = proj().name;
  return `by one message (${name ? `the ${name} Assistant` : "this project's Assistant"} on this machine, by ListAgents)`;
}

/**
 * Why a planner is too tired for `brief`, or "": the reuse rule with what the
 * brief shares with the chat (decisions.md#shared-is-what-is-held,
 * `sharedTokens` over its `seen`): a context over its ceiling for that brief,
 * or a cold cache over a large context.
 */
export function tiredFor(
  state,
  brief,
  {
    usage = null,
    inputs = {},
    fallback = REUSE_DEFAULT.planner,
    now = Date.now(),
    textOf = planText,
    checkout = root,
  } = {},
) {
  const shared = sharedTokens(textOf(brief), state.seen, { checkout });
  const verdict = mayReuse({ usage, shared, inputs, fallback, now, kind: "planner" });
  return verdict.reuse ? "" : verdict.why;
}

/** "plans/a.md" or "plans/a.md and plans/b.md", for a planner's messages. */
function ownWords(plans) {
  return plans.length === 1
    ? `Only its own plan, ${plans[0]}, and its sketch folder may still be edited, until an executor starts it.`
    : `Only its own plans, ${andList(plans)}, and their sketch folders may still be edited, until an executor starts each.`;
}

/**
 * **What a brief handed to a planner looks related to**, in the pull request
 * mode: `text`, the heading and the related lines, or "" with none; `read`,
 * whether the pull requests were read, so a brief is said once only when they
 * were. One budget of eight seconds, inside the prompt hook's twenty with the
 * sessions read before it.
 */
function briefRelated(path, plans) {
  if (proj().land !== "pull-request") return { text: "", read: true };
  const brief = planText(path);
  if (!brief) return { text: "", read: true };
  const readers = relatedReaders({ budget: 8000 });
  const lines = relatedLines(brief, plans, readers);
  return {
    text: lines.length ? `The brief looks related to:\n${lines.join("\n")}` : "",
    read: readers.pulls !== null,
  };
}

/** A plan the brief in hand became, added to the session's list once its file no longer reads as a brief. */
function noteFinished(state, plans) {
  const inHand = state.brief ? plans.find((p) => p.path === state.brief) : null;
  if (!inHand || inHand.state === "brief" || inHand.state === "planning") return state;
  if (state.plans.includes(inHand.path)) return state;
  return { ...state, plans: [...state.plans, inHand.path] };
}

/**
 * **The chat he said it in writes it**: a new plan a planner writes of its own,
 * a follow-up to a taken plan, joins the session's list as it is written, so
 * its question holds it ("Asked once") and an executor's Building line closes
 * it to this chat, as for the plan of a brief. `content` is the new file's
 * text: only a plan (a "Plan only" or "Short plan" header) joins, never a
 * brief, and never by a retired chat, which writes nothing new.
 */
export function noteWritten(state, path, content) {
  if (!path || state?.retired) return state;
  const plans = state?.plans || [];
  if (plans.includes(path) || path === state?.brief) return state;
  const plan = stateOf(content);
  if (!plan || plan.kind === "Brief") return state;
  return { ...state, plans: [...plans, path] };
}

/**
 * **A decided or dropped plan stops asking**: a planner's write that gives it a
 * "Decided" covering every decision, or a planner's or the assistant's write of
 * its `## Dropped` section (decisions.md#plan-state-in-file), takes it out of
 * the asking deferral, so `plans` no longer prints it as waiting on the owner.
 * A shell command names no file, so every plan the deferral holds is read.
 */
function leaveAsking(input) {
  const written = planPath(input.tool_input?.file_path);
  const held = written
    ? [written]
    : input.tool_name === "Bash"
      ? readJson(files.deferred("asking"))?.paths || []
      : [];
  const decided = held.filter((path) => {
    const text = planText(path);
    const plan = stateOf(text, { mtime: mtimeOf(path) });
    return plan?.state === "dropped" || (/^## Decided/m.test(text) && plan?.asks === false);
  });
  if (decided.length) dropDeferred("asking", decided);
}

/**
 * **A Planning line ends a brief's lease** (decisions.md#brief-leased): the
 * brief written, or with a shell command every brief the lease holds, that
 * any session now has under way (or has planned, or is gone) leaves the
 * `handed` deferral, so `plans` no longer says it waits on anyone.
 */
function leaveHanded(input) {
  const written = planPath(input.tool_input?.file_path);
  const held = written ? [written] : input.tool_name === "Bash" ? Object.keys(leases()) : [];
  // Under way, or past it: a plan written over the brief is no brief either.
  const taken = held.filter((path) => stateOf(planText(path))?.state !== "brief");
  if (taken.length) releaseLease(taken);
}

function plannerHook(mode, input, sessionId, statePath) {
  // **A decided plan stops asking**: the write that gives it a "Decided"
  // covering every decision takes it out of the asking deferral, so `plans`
  // no longer prints it as waiting on the owner.
  // A shell command names no file, so every plan the deferral holds is read.
  if (mode === "wrote") {
    leaveAsking(input);
    leaveHanded(input);
    return;
  }
  let state = readState(sessionId);
  state = { ...state, plans: state.plans || [] };
  if (mode === "tool" && input.tool_name === "Write") {
    const path = planPath(input.tool_input?.file_path);
    const noted =
      path && !existsSync(join(root, path))
        ? noteWritten(state, path, String(input.tool_input?.content || ""))
        : state;
    if (noted !== state) writeJson(statePath, (state = noted));
  }
  if (mode === "tool") {
    // **The window starts at the question** ("Asked once"), the planner's
    // `Question for <owner>: plans/<x>.md.` message to the assistant chat
    // (decisions.md#one-chat): its time goes in the state, which `askingIn`
    // reads, and a start of the plan it asks about is deferred to the
    // window's end, so an unanswered plan is built with nobody watching. The
    // message goes ahead.
    if (input.tool_name === "SendMessage") {
      const to = String(input.tool_input?.to || "");
      const named = / Assistant\b/.test(` ${to}`)
        ? QUESTION_FOR.exec(String(input.tool_input?.message || "").trimStart())?.[1]
        : "";
      const held = new Set([state.brief, ...state.plans].filter(Boolean));
      if (!named || !held.has(named)) return;
      const now = Date.now();
      const plan = { path: named, ...stateOf(planText(named), { mtime: mtimeOf(named) }) };
      if (!ASKS_STATES.includes(plan.state) || !plan.asks) return;
      // A plan whose window ran out is the executor's: a later question does
      // not hold it again.
      const at = windowOpened(state, plan);
      if (at && now - at >= ANSWER_WINDOW) return;
      writeJson(statePath, { ...state, asked: { ...(state.asked || {}), [named]: now } });
      defer(
        now + ANSWER_WINDOW + WINDOW_SLACK,
        `${owner()} has thirty minutes to answer`,
        [named],
        "",
        "executor",
        "asking",
      );
      return;
    }
    const filePath = input.tool_input?.file_path;
    const editing = ["Edit", "Write", "MultiEdit"].includes(input.tool_name);
    // **A taken plan refuses every edit**, retired or not, one plan at a time:
    // an executor can take it while the planner is still in the turn that
    // handed it over.
    const target = editing ? planEdited({ plans: [...state.plans, state.brief], filePath }) : "";
    if (target) {
      const text = planText(target);
      if (planTaken(text)) {
        deny(
          `${takenBy(target, text, null)}: the plan is the executor's now, and nothing in it changes from this session (your agent file, "A change to a taken plan").`,
        );
        return;
      }
    }
    const kept = editing ? firstDropped(input) : "";
    if (kept) {
      deny(kept);
      return;
    }
    if (!state.retired) return;
    const command = input.tool_name === "Bash" ? input.tool_input?.command || "" : null;
    if (command !== null && allowedWhileLocked(command)) return;
    // Only the plans this session wrote: a brief it was cut off on went to the next planner.
    if (plannerMayEdit({ plans: state.plans, toolName: input.tool_name, filePath })) return;
    deny(
      `This session is retired: its plans are in the queue. Do not plan again; say so, and stop.${state.plans.length ? ` ${ownWords(state.plans)}` : ""}`,
    );
    return;
  }
  const live = liveSessions();
  if (mode === "prompt") {
    const named = PLANNER_PROMPT.exec(String(input.prompt || ""))?.[1];
    if (state.retired) {
      writeJson(statePath, { ...state, agent: "planner" });
      const lines = [];
      if (named)
        lines.push(
          "This session is retired: the brief goes to `plans start --agent planner` in the assistant's chat.",
        );
      lines.push(
        state.plans.length
          ? plannerContext(state, live)
          : `This session is retired before it wrote its plan: its brief went to the next planner, and nothing in plans/ is this session's to change. A change or a new topic goes to the assistant's chat ${byMessage()}.`,
      );
      hookOutput("UserPromptSubmit", lines.join("\n"));
      return;
    }
    // **The planner's hooks decide whether it has room**: a brief
    // named while it is tired is not taken, and its Stop hook retires it for
    // a fresh planner.
    const tired = named
      ? tiredFor({ ...state, agent: "planner", seen: seenOf(sessionId) }, named, {
          usage: sessionUsage(input.transcript_path),
          inputs: reuseNow(),
          fallback: proj().reuse.planner,
        })
      : "";
    const queued = named ? readPlans(join(root, "plans"), liveIds(live)) : [];
    // A brief named mid-plan does not replace the one in hand.
    const inHand = queued.some(
      (p) => p.state === "planning" && sameSession(p.session, sessionId) && p.path !== named,
    );
    const taking = Boolean(named && !tired && !inHand);
    // **What the brief looks related to**, once per brief.
    const said = state.relatedSaid || [];
    const found = taking && !said.includes(named) ? briefRelated(named, queued) : null;
    const relatedText = found?.text || "";
    writeJson(statePath, {
      ...state,
      agent: "planner",
      ...(taking ? { brief: named } : {}),
      ...(found?.read ? { relatedSaid: [...said, named] } : {}),
    });
    const lines = [
      `Plans in the queue (plans):\n${list({ live, related: false })}\n\nThis session's id is ${sessionId}.`,
    ];
    if (tired)
      lines.push(
        `This session is too full for ${named} (${tired}): do not plan it; say so and stop.`,
      );
    if (relatedText) lines.push(relatedText);
    if (state.plans.length) lines.push(plannerContext(state, live));
    hookOutput("UserPromptSubmit", lines.join("\n\n"));
    return;
  }
  const plans = readPlans(join(root, "plans"), liveIds(live));
  // The brief in hand is the one whose live Planning line names this session.
  const current =
    plans.find((p) => p.state === "planning" && sameSession(p.session, sessionId)) || null;
  if (current) state.brief = current.path;
  state = noteFinished(state, plans);
  if (mode === "cutoff") {
    if (input.error && input.error !== "rate_limit") return;
    // Only a brief in hand, unfinished, is handed on: an idle planner cut off
    // while talking about its plans stays the warm chat it is.
    if (!current || state.retired) return;
    state.retired = true;
    // The plans written before the limit stay this session's own; the
    // unfinished brief goes to the next planner, whose plan this one may not write.
    writeJson(statePath, state);
    const at = startAfterReset(input.transcript_path);
    // The brief stands, without this session's Planning line, for the next
    // planner.
    writeFileSync(current.file, current.text.replace(/^## Planning, [^\n]*\n\n?/m, ""));
    start([current.path], { agent: "planner", replace: sessionId, at });
    armEnd(sessionId, live);
    return;
  }
  if (mode === "stop") {
    // A planner the queue gave nothing (the owner's own) is left alone.
    if (!state.brief && !state.plans.length) return;
    // A brief sent by message to another live planner is that planner's
    // (decisions.md#brief-leased), so two never plan one brief.
    const waiting = freeBriefs(plans, { live, self: sessionId }).map((p) => ({
      ...p,
      shared: sharedTokens(p.text, seenOf(sessionId)),
    }));
    const decision = decidePlannerStop({
      current,
      waiting,
      told: state.told,
      paused: Boolean(pausedSince()),
      retired: state.retired,
      usage: sessionUsage(input.transcript_path),
      inputs: reuseNow(),
      fallback: proj().reuse.planner,
    });
    // **Ready plans never wait with no executor**
    // (decisions.md#plans-reach-an-executor): a plan this planner wrote and
    // did not hand on, or whose start an executor that then died refused, is
    // started here.
    const withNet = (context) => {
      const net = startOnReady();
      return [context, net].filter(Boolean).join("\n\n");
    };
    if (!decision) {
      writeJson(statePath, state);
      // **A finished chat ends an hour after it goes quiet**.
      armEnd(sessionId, live);
      const net = withNet("");
      if (net) hookOutput("Stop", net);
      return;
    }
    if (decision.refuse) {
      state.told = [...state.told, ...decision.told];
      // The brief named is the one in hand from here, so the plan written
      // over it joins the list even when its Planning line is gone by the
      // next Stop.
      state.brief = decision.told[0];
      // Why it was kept, which `plans` says beside the session.
      state.kept = decision.kept;
      const said = state.relatedSaid || [];
      const found = said.includes(state.brief) ? null : briefRelated(state.brief, plans);
      const relatedText = found?.text || "";
      if (found?.read) state.relatedSaid = [...said, state.brief];
      writeJson(statePath, state);
      const reason = withNet(
        relatedText ? `${decision.reason}\n\n${relatedText}` : decision.reason,
      );
      process.stdout.write(JSON.stringify({ decision: "block", reason }));
      return;
    }
    state.retired = true;
    writeJson(statePath, state);
    const why = decision.declined
      ? "the brief named at the last stop is still waiting, untaken"
      : decision.why;
    const said = start([], { agent: "planner", replace: sessionId, why });
    armEnd(sessionId, live);
    // An executor can take a plan before this Stop: its Building line found
    // this planner unretired then, so the chat is stopped here.
    if (state.plans.length && state.plans.every((path) => doneWith(planText(path))))
      stopPlannersOn(state.plans[0], live);
    hookOutput("Stop", withNet(`Retired: ${why}. ${said}`));
  }
}

/**
 * A path under the root as `plans/<x>.md`, or "" for any other file. Its
 * folder is read by its real path, so a plan written through a worktree's
 * `plans` link is the checkout's `plans/x.md`.
 */
function planPath(file) {
  if (!file) return "";
  const path = relative(realPath(root), realFile(resolve(root, file)));
  return /^plans\/[^/]+\.md$/.test(path) ? path : "";
}

/** A folder's real path, links resolved; the path as given when it cannot be read. */
function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** A file's path with its folder's links resolved, for a file not written yet too. */
function realFile(full) {
  return join(realPath(dirname(full)), basename(full));
}

/** Whether a path is a folder or inside it. */
function within(path, folder) {
  const rel = relative(folder, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * **An executor edits only its own worktree and plans/**
 * (decisions.md#executors-in-worktrees): an editing tool's file, by its
 * real path, outside both is refused with the words; "" for any other call.
 */
function outsideTree(input) {
  if (!["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(input.tool_name)) return "";
  const file = input.tool_input?.file_path || input.tool_input?.notebook_path;
  if (!file) return "";
  const n = executorNumber(input);
  const given = resolve(input.cwd || root, file);
  // A link at the file itself is followed too.
  const full = existsSync(given) ? realPath(given) : realFile(given);
  if (within(full, realPath(join(root, "plans")))) return "";
  // A brief for the project a plan came from (its `For` section) goes into
  // that checkout's plans/, a folder beside its project file.
  const folder = dirname(full);
  if (basename(folder) === "plans" && existsSync(join(dirname(folder), PROJECT_FILE))) return "";
  // The memory notes, which Claude Code keeps under ~/.claude/projects.
  if (within(full, realPath(join(homedir(), ".claude", "projects")))) return "";
  // A chat in no executor's worktree has no worktree to edit: the prompt hook's words.
  if (!n) return IN_CHECKOUT;
  const tree = executorTree(n);
  if (within(full, realPath(tree))) return "";
  return `An executor edits only its own worktree, ${relative(root, tree)}, and plans/: ${file} is outside both.`;
}

const IN_CHECKOUT =
  "Executors build in the worktrees the queue makes (.claude/worktrees/executor-<n>), and this chat is in the checkout: plans start starts one. Do not build here; say so, and stop.";

/** The worktree a hook's session works in, from its `cwd`; the root when it is none. */
function sessionTree(input) {
  return treeOf(input?.cwd, worktrees())?.path || root;
}

/**
 * **The planner keeps a waiting file's First line**
 * (decisions.md#plan-put-first): an Edit, Write or MultiEdit to any
 * `plans/*.md` file that waits and is put first, whose new text the queue would
 * read no First line in, is refused with the line as it stands. `plans first`
 * keeps the file's times, so Claude Code's stale-file check does not see its
 * write; a line changed to another day the queue reads passes. The words, or
 * "". They name one place for every shape of header, above the first `## `
 * section: `firstHead`'s text, where `Lands` is read too, and no reading of the
 * phrase leaves it; a place worked out per shape sent a planner where the line
 * is not read.
 */
function firstDropped(input) {
  const path = planPath(input.tool_input?.file_path);
  if (!path) return "";
  const before = planText(path);
  const first = firstOf(before);
  const state = stateOf(before);
  if (!first || !WAITING_STATES.includes(state?.state)) return "";
  const after = editedText(input.tool_name, input.tool_input, before);
  if (firstOf(after)) return "";
  const line = firstHead(before)
    .split("\n")
    .find((one) => FIRST_MARK.test(one) && firstOf(one));
  return `${path} is first (${firstWords({ first }).replace(/^first /, "")}): keep its line, ${line}, above the first ## section. Only ${owner()}'s word takes it out: plans first --undo ${path}.`;
}

/**
 * **The executor's tool hook refuses a Building line on a plan still asking**
 * (decisions.md#asked-once): an Edit, Write or MultiEdit to a plan whose new
 * text adds a Building line, while `askingIn` holds the plan. The live
 * sessions are read only then, so every other edit costs nothing.
 */
/** The refusal of a second plan to a session building one. */
function oneAtATime(path, other) {
  return `${path} is not taken: this session is building ${other}, and an executor builds one plan at a time.`;
}

/**
 * **A Building line is refused on a plan that is not this session's to
 * take**: one built already, one another live session is building or holds a
 * claim on, one that waits on another. The plans as read before the line; ""
 * when it may take it.
 */
function takenWords(path, plans, live, sessionId) {
  const plan = plans.find((p) => p.path === path);
  if (!plan) return "";
  if (plan.state === "built") return `${path} is built already: its "Built" section stands.`;
  const mine = plans.find(
    (p) => p.state === "building" && sameSession(p.session, sessionId) && p.path !== path,
  );
  if (mine) return oneAtATime(path, mine.path);
  if (live && plan.state === "building" && !sameSession(plan.session, sessionId)) {
    const name = live?.find((row) => row.sessionId === plan.session)?.name;
    return claimedWords(path, { holder: plan.session, name, at: plan.mtime || Date.now() });
  }
  const claims = readClaims(plans, live);
  if (claims[path] && !holdsClaim(claims[path], sessionId, live))
    return claimedWords(path, claims[path], live);
  const others = Object.fromEntries(
    Object.entries(claims).filter(([, one]) => !holdsClaim(one, sessionId, live)),
  );
  const own = plans.map((p) => (p.path === path ? { ...p, state: "ready" } : p));
  const waits = freePlans(own, { claims: others }).find((p) => p.path === path)?.waitsOn;
  return waits
    ? `${path} waits on ${waits.path} (${waits.why}): leave it, and build what the queue names.`
    : "";
}

function buildingRefusal(input, statePath) {
  if (!["Edit", "Write", "MultiEdit"].includes(input.tool_name)) return "";
  const path = planPath(input.tool_input?.file_path);
  if (!path) return "";
  const before = planText(path);
  const after = editedText(input.tool_name, input.tool_input, before);
  if (!buildingAdded(before, after).length) return "";
  // **A dropped plan is nobody's to build** (decisions.md#plan-state-in-file),
  // whoever named it.
  const dropped = droppedOf(before);
  if (dropped) return droppedWords({ path, ...dropped });
  // A planned plan is refused from its text alone, before the sessions are
  // read.
  const planned = heldFromBuilding(path, after, null, { mtime: mtimeOf(path) });
  if (planned?.planned) return holdWords(path, planned);
  const live = liveSessions({ timeout: 4000 });
  const asking = heldFromBuilding(path, after, live, { mtime: mtimeOf(path) });
  if (asking) return holdWords(path, asking);
  // **Not out of turn** (decisions.md#plan-put-first): while a free ready
  // plan is put first ahead of this one; with no sessions read, nothing.
  if (live) {
    // Each plan's time is its file's, read by `readPlans`, as `mtimeOf` reads this one's.
    const plans = readPlans(join(root, "plans"), liveIds(live));
    const ahead = firstAhead(path, plans, { live, sessionId: input.session_id });
    if (ahead.length) return outOfTurnWords(path, ahead[0]);
  }
  // Judged with the sessions unread too, from the plans' text and the
  // claims.
  const taken = takenWords(
    path,
    readPlans(join(root, "plans"), liveIds(live)),
    live,
    input.session_id,
  );
  if (taken) return taken;
  // Judged with the sessions in hand, the plan is not judged again by the
  // shell's check; unjudged (no sessions read), the next shell command's
  // check reads them again.
  if (live) {
    const state = readState(input.session_id);
    if (!(state.taken || []).includes(path))
      writeJson(statePath, { ...state, taken: [...(state.taken || []), path] });
  }
  return "";
}

/** Each plan's modification time, before a shell command that may write one. */
function planTimes(dir = join(root, "plans")) {
  const times = {};
  try {
    for (const name of readdirSync(dir))
      if (name.endsWith(".md")) times[`plans/${name}`] = statSync(join(dir, name)).mtimeMs;
  } catch {
    // No plans.
  }
  return times;
}

/** The line a plain chat that opened before its agent's setting says (decisions.md#chats-open-as-the-agent). */
export function agentLine(kind) {
  return (
    `Chats in this project now open as the workflow's ${kind}, set in .claude/settings.local.json. ` +
    "This one opened before that: start a new chat."
  );
}

/** A line said once at a session's start: `systemMessage` for the owner, the context with the agent's step. */
function sayOnce(line) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `${line}\n\nSay this line to the owner in its own words, then go on with what was asked.`,
      },
      systemMessage: line,
    }),
  );
}

/**
 * Writes the agent a plain chat here opens as (`sessionAgent`), and when it
 * wrote, says so once in the owner's own chat: not in one opened as an agent
 * (its `agent_type`, there when started with `--agent`, as every chat the
 * queue starts is, whichever agent it names: the setting changed nothing for
 * it). The line as the install check says its
 * own: `systemMessage` for the owner, the context with the agent's step. Any
 * failure says nothing: a session's start never fails on it.
 */
function sayAgent(input) {
  try {
    const { agent, did } = sessionAgent(root, { form: proj().form });
    if (!did || input?.agent_type) return false;
    const kind = agent.slice(agent.lastIndexOf(":") + 1);
    const line = agentLine(kind);
    sayOnce(line);
    return true;
  } catch {
    // Said nothing, which is the start without it.
    return false;
  }
}

/**
 * The line that tells the owner his app sends no failed run: what it lacks
 * and where to add it, or, the registration having it, where to accept it.
 */
export function appLine(lacks) {
  const opening = "The project's Claude is sent no failed run by GitHub: ";
  const until = "Until then failed runs are read every five minutes.";
  if (lacks.where === "installation")
    return `${opening}its app's new permissions are not accepted on ${lacks.repo} yet. Accept them at ${lacks.url}. ${until}`;
  return `${opening}its app lacks ${lacks.what.join(" and ")}. Add ${lacks.what.length > 1 ? "them" : "it"} on GitHub (Settings, Developer settings, GitHub Apps, ${lacks.slug}, Permissions & events) and accept the new permissions if GitHub asks. ${until}`;
}

/**
 * **An app that cannot send a failed run is said once** in a chat the owner
 * reads (`ownerReads`: not a planner's, an executor's or the reviewer's),
 * while the listener's record says it lacks something; said again only when
 * what it lacks changes. As `sayAgent` says its line; any failure says
 * nothing.
 */
function sayApp(input) {
  try {
    if (!ownerReads(input) || proj().land !== "pull-request") return;
    const lacks = webhookAlive()?.lacks;
    if (!lacks?.what?.length) return;
    const key = `${lacks.where}: ${lacks.what.join(", ")}`;
    if (readJson(files.webhookTold())?.told === key) return;
    const line = appLine(lacks);
    sayOnce(line);
    writeJson(files.webhookTold(), { told: key, at: Date.now() });
  } catch {
    // Said nothing, which is the start without it.
  }
}

/**
 * **The refresh plans built since the owner last wrote here, said once**, in
 * the assistant chat: the paths told are kept in `.claude/refreshes.told.json`.
 * "" with none, and on any failure.
 */
function refreshedLine() {
  try {
    const told = readJson(files.refreshesTold())?.told || [];
    const paths = readPlans(join(root, "plans"))
      .filter((p) => p.state === "built" && p.lands?.kind === "refresh" && !told.includes(p.path))
      .map((p) => p.path);
    if (!paths.length) return "";
    writeJson(files.refreshesTold(), { told: [...told, ...paths].slice(-200) });
    return `Refreshed since ${owner()} last wrote here: ${andList(paths)}. Say to him first, in a line, which pull requests were brought up to date and which were left, from each plan's "Built".`;
  } catch {
    // Said nothing, which is the prompt without it.
    return "";
  }
}

/** The assistant's scheduled prompt, which keeps its chat warm while work is under way. */
const HEARTBEAT = "Heartbeat.";

/**
 * **The heartbeat's line** (decisions.md#one-chat): the plans building,
 * waiting (ready or handed for an executor, a brief waiting for or with a
 * planner) and asking, with a fault the assistant tells the owner (a
 * building plan whose executor is not running, a start deferred, a note
 * from GitHub waiting unhandled over ten minutes); or
 * `Nothing is under way.`, on which the assistant deletes its job.
 */
function workLine({ plans = null, live = liveSessions(), deferred = null } = {}) {
  const read = withAsking(plans || readPlans(join(root, "plans"), liveIds(live)), live);
  const building = read.filter((p) => p.state === "building");
  const asking = read.filter((p) => p.askingIn);
  const waiting = read.filter(
    (p) => !p.askingIn && ["ready", "handed", "brief", "planning"].includes(p.state),
  );
  // **A note nobody handled is a fault he is told**
  // (decisions.md#note-sent-to-open-chat): one waiting more than ten minutes
  // is named, and any note waiting keeps the heartbeat, with nothing else
  // under way too, so it is still there at ten minutes. Only with pull
  // requests, where `plans` lists them.
  const notes = proj().land === "pull-request" ? notesWaitingNow() : [];
  if (!building.length && !asking.length && !waiting.length && !notes.length)
    return "Nothing is under way.";
  // A Building line whose session is listed with no process, or is gone
  // from the list (read as waiting, `stale`).
  const faults = live
    ? [
        ...building.filter((p) => {
          const row = live.find((one) => one.sessionId === p.session);
          return !row || statusOf(row) === "not running";
        }),
        ...waiting.filter((p) => p.stale),
      ].map((p) => `${p.path}'s executor is not running`)
    : [];
  const later = deferred === null ? readJson(files.deferred("executor")) : deferred;
  if (later?.until > Date.now())
    faults.push(`a start waits until ${hhmm(later.until)}: ${later.why || "deferred"}`);
  faults.push(
    ...notes
      .filter((one) => Date.now() - one.mtime > NOTE_UNHANDLED)
      .map((one) => `${one.path} from GitHub is not handled`),
  );
  return `Work under way: ${building.length} building, ${waiting.length} waiting, ${asking.length} asking${faults.length ? `; ${faults.join("; ")}` : ""}.`;
}

/** How long a note waits unhandled before the heartbeat names it. */
const NOTE_UNHANDLED = 10 * MINUTE;

/** The file an assistant chat past its ceiling writes for the fresh one (decisions.md#one-chat). */
const ASSISTANT_HANDOVER = "plans/assistant-handover.md";

/** How long a handed-on assistant chat stays quiet before the fresh one takes over. */
const HANDOVER_QUIET = 10 * MINUTE;

/** The fresh assistant chat's prompt, on the hand-over file. */
export function takeOverPrompt(name) {
  return `Taking over as ${name}: ${ASSISTANT_HANDOVER}.`;
}

/**
 * **The assistant chat past its ceiling is handed on**
 * (decisions.md#one-chat): at its first stop over the project's
 * `reuse.assistant` the stop is held once, with the words to write the
 * hand-over file; at a later stop with the file written since, the end timer
 * is armed ten minutes on, cleared by the owner's next prompt, and when it
 * fires `endSession` stops the chat and opens a fresh one on the file. The
 * reason to hold, or "".
 */
function handOnStop(input, sessionId) {
  const usage = sessionUsage(input.transcript_path);
  const ceiling = proj().reuse.assistant;
  if (!(usage?.context > ceiling)) return "";
  // The owner's interactive chat (tmux) is his to end: never handed on.
  const live = liveSessions();
  const row = live?.find((one) => one.sessionId === sessionId);
  if (!row || row.kind !== "background" || !isSession("assistant", row)) return "";
  const state = readState(sessionId);
  if (!state.handing) {
    if (input.stop_hook_active) return "";
    writeJson(files.state(sessionId), { ...state, handing: { at: Date.now() } });
    return `${ceilingLine(usage, ceiling).replace(/\)\.$/, ")")}: write ${ASSISTANT_HANDOVER} by "Handing the chat on", then stop; a fresh chat takes over once this one is quiet.`;
  }
  if (mtimeOf(ASSISTANT_HANDOVER) > state.handing.at)
    armEnd(sessionId, live, Date.now() + HANDOVER_QUIET);
  return "";
}

/**
 * **A hand-over written is recorded as its writer's** (decisions.md#one-chat):
 * when the file's time is past the record's, the record becomes `{ at,
 * writer }`, nobody told yet, whether a Write, an Edit or a shell command
 * wrote it.
 */
function recordHandover(sessionId) {
  try {
    const at = mtimeOf(ASSISTANT_HANDOVER);
    const record = readJson(files.handoverTold()) || {};
    if (at && at > (record.at || 0)) writeJson(files.handoverTold(), { at, writer: sessionId });
  } catch {
    // Recorded nothing: the next chat is told of the file as of one from before the record.
  }
}

/**
 * **A hand-over out of date is said to nobody**: the chat that wrote it is
 * kept by the owner's message, so the record marks the file read.
 */
function dropHandover() {
  try {
    const at = mtimeOf(ASSISTANT_HANDOVER);
    const record = readJson(files.handoverTold()) || {};
    if (at) writeJson(files.handoverTold(), { at, writer: record.writer || "", told: "kept" });
  } catch {
    // Dropped nothing: the next chat may be told of the file once.
  }
}

/**
 * **The hand-over is said once to the next assistant chat**
 * (decisions.md#one-chat), whatever message opened it: "" when there is no
 * file, or when it is not newer than the record and a chat was told of it or
 * this chat wrote it. Else the record names this chat as told, and the line is
 * returned, but for a prompt `Taking over as `, which names the file itself.
 */
function handoverLine(sessionId, prompt) {
  try {
    const at = mtimeOf(ASSISTANT_HANDOVER);
    if (!at) return "";
    const record = readJson(files.handoverTold()) || {};
    const fresh = at > (record.at || 0);
    if (!fresh && (record.told || sameSession(record.writer || "", sessionId))) return "";
    writeJson(files.handoverTold(), {
      at,
      writer: fresh ? "" : record.writer || "",
      told: sessionId,
    });
    if (prompt.trim().startsWith("Taking over as ") && prompt.includes(ASSISTANT_HANDOVER))
      return "";
    const day = new Date(at);
    return `${ASSISTANT_HANDOVER} was written ${day.getDate()} ${MONTHS[day.getMonth()]} ${hhmm(at)} and no assistant chat has read it since: read it first, by "Staying ready" 4.`;
  } catch {
    // Said nothing, which is the prompt without it.
    return "";
  }
}

/** **The assistant's ceiling's line**, when its context is over it; else "". */
function ceilingLine(usage, ceiling) {
  return usage && usage.context > ceiling
    ? `This chat is over its ceiling (${kTokens(usage.context)} of ${kTokens(ceiling)}).`
    : "";
}

function hook(mode, input) {
  // **No agent marks a pull request ready**, in every session with the
  // plugin, whatever its project or agent
  // (decisions.md#draft-until-reviewed).
  if (
    mode === "tool" &&
    input.tool_name === "Bash" &&
    marksReady(input.tool_input?.command || "")
  ) {
    deny(READY_REFUSED);
    return;
  }
  // **A project with no project file is not the workflow's**: its own hooks,
  // if it has any, run alone (a project moving onto the plugin keeps its old
  // queue until its file lands).
  if (!proj().found) return;
  // **A project's chats open as its agent, from the project's own settings**
  // (decisions.md#chats-open-as-the-agent): before the compact return, since
  // a compact project needs its maker.
  const saidAgent = mode === "session" && sayAgent(input);
  // **The compact form has no queue**: the maker is one chat, and the queue's
  // hooks do nothing (the catalogue's hooks run in both forms).
  if (proj().form === "compact") return;
  // **The session's start arms the webhook's listener**
  // (decisions.md#github-webhook).
  if (mode === "session") {
    // Not awaited: the process stays up the port's check, at most 300 ms.
    armWebhook().catch(() => {});
    // One JSON object a start: the app's line waits for a start without the agent's.
    if (!saidAgent) sayApp(input);
    return;
  }
  const sessionId = input.session_id;
  const executor = kindOf(input) === "executor";
  const statePath = files.state(sessionId);
  // Only an executor's Building line takes a plan, and only a planner's
  // "Decided" or a planner's or the assistant's `## Dropped` lets one go; any
  // other session's edit returns at once.
  // **A chat that runs the assistant's agent says so in its state**, so a note
  // goes to it first, without the line for a chat with the name alone
  // (decisions.md#note-sent-to-open-chat).
  if (kindOf(input) === "assistant" && ["wrote", "prompt", "stop"].includes(mode)) {
    const state = readState(sessionId);
    if (state.agent !== "assistant") writeJson(statePath, { ...state, agent: "assistant" });
  }
  if (mode === "wrote" && kindOf(input) === "assistant") {
    recordHandover(sessionId);
    leaveAsking(input);
    return;
  }
  // **The assistant chat's prompt**: the heartbeat's line in place of
  // anything else, the ceiling's when over it, and a hand-over no chat has
  // read and what was refreshed at any other prompt (decisions.md#one-chat,
  // decisions.md#merge-refreshes-the-rest).
  if (mode === "prompt" && kindOf(input) === "assistant") {
    const heartbeat = String(input.prompt || "").trim() === HEARTBEAT;
    // **His prompt keeps the chat**: a hand-over's timer waits for quiet, so
    // his message clears it; a heartbeat or another chat's message does not.
    // The hand-over file is then out of date: dropped, so the next stop
    // over the ceiling asks for it again.
    if (!heartbeat && !/^\s*<cross-session-message\b/.test(String(input.prompt || ""))) {
      const state = readState(sessionId);
      if (state.end) killTimer(state.end.pid, endTimer(sessionId));
      if (state.end || state.handing) {
        const { end: _end, handing: _handing, ...rest } = state;
        writeJson(files.state(sessionId), rest);
        // A hand-over his message made out of date is no chat's to read.
        dropHandover();
      }
    }
    const lines = [
      heartbeat ? "" : handoverLine(sessionId, String(input.prompt || "")),
      heartbeat ? workLine() : refreshedLine(),
      ceilingLine(sessionUsage(input.transcript_path), proj().reuse.assistant),
    ].filter(Boolean);
    if (lines.length) hookOutput("UserPromptSubmit", lines.join("\n"));
    return;
  }
  if (mode === "wrote" && !executor && kindOf(input) !== "planner") return;
  // **What a plan or brief shares with a chat is what the chat read or wrote of
  // it** (decisions.md#shared-is-what-is-held, decisions.md#reuse-check-cheap):
  // a planner's or an executor's tool call appends its tokens to its log, from
  // the hook's own input. A subagent's call carries the subagent's
  // `agent_type`, so it returned above. A Read has its own hook, `seen.mjs`,
  // which counts it alone.
  if (mode === "wrote")
    try {
      noteSeen(sessionId, seenIn(input, { checkout: root }));
    } catch {
      // A temp folder that cannot be written loses this count, not the hook's work.
    }
  // **The assistant chat is never ended for going quiet**
  // (decisions.md#one-chat): it is the one the owner talks to, handed on to
  // a fresh one only past its ceiling.
  if (mode === "stop" && kindOf(input) === "assistant") {
    const held = handOnStop(input, sessionId);
    if (held) {
      process.stdout.write(JSON.stringify({ decision: "block", reason: held }));
      return;
    }
    // **Ready plans never wait with no executor**
    // (decisions.md#plans-reach-an-executor): its cheap gate reads no
    // sessions unless a plan is ready and the lock is free.
    const net = startOnReady();
    if (net) hookOutput("Stop", net);
    return;
  }
  if (kindOf(input) === "planner") {
    plannerHook(mode, input, sessionId, statePath);
    return;
  }
  if (!executor) return;
  // A message reaches the tool hook for the planner's question; an
  // executor's is let through.
  if (mode === "tool" && input.tool_name === "SendMessage") return;
  if (mode === "wrote") {
    // **The Building line takes the plan from its planner**: a retired
    // planner whose plan this is has its chat stopped. Anything else
    // returns at once.
    const building = buildingBy(sessionId);
    // **Every plan this session took, kept past its Building line**
    // (decisions.md#leave-back-as-brief): "Built" takes the line out, and
    // the Stop hook still asks what the built plan owes.
    const hold = (paths) => {
      const state = readState(sessionId);
      const held = [...new Set([...(state.held || []), ...paths])];
      if (held.length !== (state.held || []).length) writeJson(statePath, { ...state, held });
    };
    // A Building line written by a shell command: found by reading the plans
    // after the fact, since no tool hook could refuse it. **On a plan still
    // asking it is taken out again** (decisions.md#asked-once), with the tool
    // hook's words. A plan judged once (`taken`) is not judged again, so the
    // live sessions are read once per plan; one whose line is gone drops from
    // the list. Before any question the window opens at the plan's time
    // before the command (`plansAt`, which the tool hook records), since the
    // command has just written the file.
    if (input.tool_name === "Bash") {
      const mine = readPlans(join(root, "plans")).filter((p) => building.test(p.text));
      const state = readState(sessionId);
      const taken = (state.taken || []).filter((path) => mine.some((p) => p.path === path));
      const unjudged = mine.filter((p) => !taken.includes(p.path));
      const said = [];
      const newly = [];
      if (unjudged.length) {
        const live = liveSessions({ timeout: 4000 });
        const own = new RegExp(`${building.source}[^\\n]*\\n?`, "gm");
        // The queue with the sessions in hand, for a plan put first ahead
        // (decisions.md#plan-put-first); none with no sessions read. The plans
        // this command claimed are judged as they stood before it, so one
        // command claiming two is not let through by its own lines, their times
        // too: the command's write would open a plan's window again, and a plan
        // put first still asking would stop holding the other back. One time
        // per plan for its asking window, its own Building line's and a plan
        // put first's alike: its time before the command; with none, a plan
        // this command claimed has none, since the command's write would open
        // its window again, and any other its file's, written by someone else.
        const claimed = (p) => unjudged.some((one) => one.path === p.path);
        const hookTime = (p) => state.plansAt?.[p.path] || (claimed(p) ? 0 : p.mtime || 0);
        const queued = live
          ? readPlans(join(root, "plans"), liveIds(live)).map((p) =>
              claimed(p)
                ? {
                    ...p,
                    ...stateOf(p.text.replace(own, ""), {
                      mtime: hookTime(p),
                      live: liveIds(live),
                    }),
                  }
                : p,
            )
          : [];
        for (const plan of unjudged) {
          const asking = heldFromBuilding(plan.path, plan.text, live, { mtime: hookTime(plan) });
          const ahead = asking
            ? []
            : firstAhead(plan.path, queued, { live, timeOf: hookTime, sessionId });
          // No sessions read is the hook doing nothing, as when it fails:
          // judged, so a failing list is not asked again on every command.
          // Judged as the plans stood before the line. One line a
          // command: a second taken in it is refused.
          const refused =
            asking || ahead.length
              ? ""
              : newly.length
                ? oneAtATime(plan.path, newly[0])
                : takenWords(
                    plan.path,
                    live ? queued : readPlans(join(root, "plans")),
                    live,
                    sessionId,
                  );
          if (!asking && !ahead.length && !refused) {
            taken.push(plan.path);
            newly.push(plan.path);
            continue;
          }
          writeFileSync(plan.file, plan.text.replace(own, ""));
          const words = asking
            ? holdWords(plan.path, asking)
            : ahead.length
              ? outOfTurnWords(plan.path, ahead[0])
              : refused;
          said.push(`${words} Its Building line was taken out.`);
        }
      }
      if (String(taken) !== String(state.taken || []))
        writeJson(statePath, { ...readState(sessionId), taken });
      // A Building line that stays holds the plan, and the plan stops asking;
      // one the asking check took out is not this session's.
      if (taken.length) hold(taken);
      if (newly.length) dropDeferred("asking", newly);
      if (said.length)
        process.stdout.write(JSON.stringify({ decision: "block", reason: said.join("\n") }));
      return;
    }
    const path = planPath(input.tool_input?.file_path);
    if (!path) return;
    if (!building.test(planText(path))) return;
    hold([path]);
    dropDeferred("asking", [path]);
    stopPlannersOn(path, liveSessions());
    return;
  }
  const state = readState(sessionId);
  if (mode === "tool") {
    const command = input.tool_name === "Bash" ? input.tool_input?.command || "" : null;
    if (command !== null && allowedWhileLocked(command)) return;
    const lock = readJson(files.lock(executorNumber(input)));
    let reason = "";
    if (lockHeldByOther(lock, sessionId)) reason = blockReason(lock);
    else if (state.retired)
      reason =
        "This session is retired: a fresh executor took the queue. Do not build; say so, and stop.";
    else reason = outsideTree(input) || buildingRefusal(input, statePath);
    // A writing command may write a Building line: the plans' times before it,
    // for the wrote hook's judgement.
    if (!reason && command !== null) writeJson(statePath, { ...state, plansAt: planTimes() });
    if (reason) {
      deny(reason);
    }
    return;
  }
  const live = liveSessions();
  if (mode === "prompt") {
    // **The checkout is for reading** (decisions.md#executors-in-worktrees): an
    // executor's chat opened anywhere but its worktree builds nothing.
    if (!executorNumber(input)) {
      process.stdout.write(JSON.stringify({ decision: "block", reason: IN_CHECKOUT }));
      return;
    }
    // The session's own number's lock.
    const number = executorNumber(input);
    const lock = readJson(files.lock(number));
    if (lockHeldByOther(lock, sessionId, () => holderAlive(lock, live))) {
      process.stdout.write(JSON.stringify({ decision: "block", reason: blockReason(lock) }));
      return;
    }
    if (state.retired) {
      hookOutput(
        "UserPromptSubmit",
        "This session is retired: a fresh executor took the queue. Do not build; answer from what you know, and say so.",
      );
      return;
    }
    if (!takeLock(sessionId, live, { path: files.lock(number) })) {
      // Another prompt hook took it between the check above and the create.
      process.stdout.write(
        JSON.stringify({
          decision: "block",
          reason: blockReason(readJson(files.lock(number)) || {}),
        }),
      );
      return;
    }
    // An executor the owner started by hand has no `Executor n` name; this marks it.
    if (state.agent !== "executor") writeJson(statePath, { ...state, agent: "executor" });
    hookOutput(
      "UserPromptSubmit",
      `Plans in the queue (plans):\n${list({ live, related: false })}\n\nThis session's id is ${sessionId}.`,
    );
    return;
  }
  if (mode === "cutoff") {
    if (input.error && input.error !== "rate_limit") return;
    release(sessionId);
    state.retired = true;
    writeJson(statePath, state);
    armEnd(sessionId, live);
    const plans = readPlans(join(root, "plans"), liveIds(live));
    const plan = plans.find((p) => p.state === "building" && sameSession(p.session, sessionId));
    if (!plan) return;
    writeFileSync(
      plan.file,
      cutoffEdit(plan.text, {
        sessionId,
        branch: branchOf(input.cwd),
        tree:
          treeNameOf(input.cwd) ||
          (executorNumber(input) ? `executor-${executorNumber(input)}` : ""),
      }),
    );
    const at = startAfterReset(input.transcript_path);
    start([plan.path], { replace: sessionId, at });
    return;
  }
  if (mode === "stop") {
    const lock = readJson(files.lock(executorNumber(input)));
    // **A finished chat ends an hour after it goes quiet**: every stop that
    // does not block arms the end timer.
    if (lockHeldByOther(lock, sessionId, () => holderAlive(lock, live))) {
      armEnd(sessionId, live);
      return;
    }
    const plans = readPlans(join(root, "plans"), liveIds(live));
    // The sweep: a Building line written another way (a shell command, a
    // hook that failed) still stops the retired planner whose plan it took.
    stopTakenPlanners(live);
    // "Asked once": a plan its planner is still asking about is not named.
    // **One plan at a time**: the first plan free for this session, one
    // that waits on none and that no other session holds a claim on; a
    // handed plan only its own number's, or one whose worktree is no
    // executor's now.
    const mine = executorNumber(input) || 1;
    const claims = Object.fromEntries(
      Object.entries(readClaims(plans, live)).filter(
        ([, one]) => !holdsClaim(one, sessionId, live),
      ),
    );
    const free = freePlans(withAsking(plans, live), { claims }).filter(
      (p) => !p.waitsOn && !claims[p.path],
    );
    // Claimed before it is named, so two stops at one moment name it once.
    const current =
      plans.find((p) => p.state === "building" && sameSession(p.session, sessionId)) || null;
    const name = live?.find((row) => row.sessionId === sessionId)?.name || "";
    const mayName = !current && !state.retired && !pausedSince();
    const waiting = (
      mayName
        ? [
            free.find(
              (p) => p.state === "ready" && claim(p.path, { holder: sessionId, name, live }),
            ),
          ]
        : []
    )
      .filter(Boolean)
      // Judged again with the claims as they are now: another stop may have
      // claimed a plan this one waits on meanwhile.
      .filter((p) => {
        const now = Object.fromEntries(
          Object.entries(readClaims(plans, live)).filter(
            ([, one]) => !holdsClaim(one, sessionId, live),
          ),
        );
        const still = freePlans(withAsking(plans, live), { claims: now }).find(
          (one) => one.path === p.path,
        );
        if (still && !still.waitsOn) return true;
        unclaim(p.path, sessionId);
        return false;
      })
      .map((p) => ({ ...p, shared: sharedTokens(p.text, seenOf(sessionId)) }));
    const handed = free.filter((p) => {
      if (p.state !== "handed") return false;
      const n = Number(/^executor-(\d+)$/.exec(p.tree || "")?.[1]) || 0;
      return !n || n === mine || n > proj().executors || !existsSync(executorTree(n));
    });
    const building = buildingBy(sessionId);
    const carry = carryOf(
      plans.filter(
        (p) =>
          p.state === "built" &&
          p.carries?.length &&
          ((state.held || []).includes(p.path) || building.test(p.text)),
      ),
    );
    const decision = decideStop({
      carry,
      current,
      waiting,
      handed,
      // The pull request mode reads its pull requests' failed checks that no
      // webhook brings to the assistant (two fixes would cross): every one
      // with no secret or no listener alive, another service's with one
      // (decisions.md#github-webhook); then the run a fix pushed straight sets
      // off. The push mode reads its run. `webhookAlive` is the pid alone, no
      // port's wait in a Stop hook: a record a reboot left can read as alive
      // until the next session's start drops it.
      run:
        proj().land === "pull-request"
          ? pullThenRun(
              pullChecks({
                brought: Boolean(secret("WORKFLOW_WEBHOOK_SECRET") && webhookAlive()),
                // With one executor every pull request of the queue is its own.
                only:
                  proj().executors > 1
                    ? plans
                        .filter(
                          (p) => p.state === "built" && p.pr && (state.held || []).includes(p.path),
                        )
                        .map((p) => p.pr)
                    : null,
              }),
              imageRun({
                only: plans.filter((p) => p.state === "built" && p.fix && p.sha).map((p) => p.sha),
                tree: sessionTree(input),
              }),
            )
          : imageRun({ tree: sessionTree(input) }),
      told: state.told,
      paused: Boolean(pausedSince()),
      retired: state.retired,
      continuing: Boolean(input.stop_hook_active),
      refusedRun: state.runRefused ?? null,
      usage: sessionUsage(input.transcript_path),
      inputs: reuseNow(),
      fallback: proj().reuse.executor,
    });
    // A plan claimed and not named goes back to the queue.
    if (waiting.length && !decision?.kept && !decision?.retire) unclaim(waiting[0].path, sessionId);
    if (!decision) {
      armEnd(sessionId, live);
      // A retired session whose successor's start was refused, deferred or died
      // hands on at its next stop (decisions.md#plans-reach-an-executor).
      const net = state.retired ? startOnReady() : "";
      if (net) hookOutput("Stop", net);
      return;
    }
    if (decision.refuse) {
      if (decision.runId) state.runRefused = decision.runId;
      if (decision.told) state.told.push(...decision.told);
      // Why it was kept, which `plans` says beside the session.
      if (decision.kept) state.kept = decision.kept;
      writeJson(statePath, state);
      process.stdout.write(JSON.stringify({ decision: "block", reason: decision.reason }));
      return;
    }
    if (decision.context) {
      state.told.push(...decision.told);
      writeJson(statePath, state);
      armEnd(sessionId, live);
      hookOutput("Stop", decision.context);
      return;
    }
    const paths = decision.handover ? [decision.handover.path] : decision.paths;
    release(sessionId);
    state.retired = true;
    writeJson(statePath, state);
    const why = decision.handover ? `${decision.handover.path} was handed over` : decision.why;
    const said = start(paths, { replace: sessionId, why });
    armEnd(sessionId, live);
    const started = /was started on/.test(said);
    hookOutput(
      "Stop",
      started
        ? `Retired: ${why}. ${said}`
        : `Retired: ${why}, but no executor was started: ${said}`,
    );
  }
}

/**
 * **`plans check` lints the `deny` key** (docs/workflow.md, "The project
 * file"), from `project()`'s one parse: a line under the key it could not
 * read, by line number; a list or a value with no agent's name over it; an
 * agent the plugin has no file for, or with no pattern; a pattern that does not compile alone; a
 * connector named alone, which the hook reads as its every tool; a pattern
 * that could match no MCP tool's name. One line per fault; an absent or
 * empty `deny` says nothing.
 */
export function checkDeny(project = proj(), agents = pluginAgents()) {
  const written = project.written?.deny;
  const lines = (project.written?.unread ?? [])
    .filter((at) => at.under === "deny")
    .map(
      (at) =>
        `deny: line ${at.line} is not read: ${at.text} (${at.item ? "an item goes under its agent's name, indented as deep or deeper" : 'an agent is "name:" with its patterns under it, or "name: pattern"'})`,
    );
  // A flat list or a value under `deny` denies nothing: say so, or a typo
  // turns every denial off unseen.
  if ((Array.isArray(written) && written.length) || (typeof written === "string" && written))
    lines.push(
      "deny: names no agent; each agent's name goes on a line of its own under deny, its patterns under it",
    );
  for (const [agent, patterns] of Object.entries(project.deny)) {
    if (!agents.includes(agent))
      lines.push(`deny: ${agent} is no agent of the plugin (${agents.join(", ")})`);
    if (!patterns.length) lines.push(`deny: ${agent}: no pattern under it, so it denies nothing`);
    for (const pattern of patterns) {
      if (!compiles(pattern)) lines.push(`deny: ${agent}: ${pattern} is not a regular expression`);
      else if (connectorAlone(pattern))
        lines.push(
          `deny: ${agent}: ${pattern} names a connector, not a tool: write \`${everyTool(pattern)}\``,
        );
      else if (!couldNameMcp(pattern))
        lines.push(
          `deny: ${agent}: ${pattern} names no MCP tool (mcp__<server>__<tool>); deny watches MCP calls only`,
        );
    }
  }
  return lines;
}

/**
 * **`plans check`**: every catalogue the project file names, linted. One line
 * per fault: an entry without its tier and date, every entry at the retired
 * agent's choice (old or new: each is a detail with no well-formed opinion
 * behind it, free and not the catalogue's), an id used twice in one
 * catalogue, a project entry that says it overrides a `file#id` no inherited
 * catalogue has. Then the count.
 */
function checkCatalogues(project = proj(), dir = root) {
  const locs = locations(project, dir, root);
  const named = [...project.inherits, project.catalogue].filter(Boolean);
  if (!named.length)
    return { text: "No catalogue: the project file names no catalogue or inherits.", faults: 0 };
  // A location the project file names that is not there is a fault.
  const lines = named
    .filter((p) => !locs.some((loc) => loc.label === p.replace(/\/$/, "")))
    .map((p) => `${p}: no such catalogue`);
  const inherited = new Set();
  let entries = 0;
  let fileCount = 0;
  const read = locs.map((loc) => {
    const files = catalogueFiles(loc.path).map((f) => ({
      ...f,
      text: readFileSync(f.path, "utf8"),
    }));
    fileCount += files.length;
    return { loc, files };
  });
  for (const { loc, files } of read) {
    const ids = new Map();
    for (const f of files) {
      const where = loc.path.endsWith(".md") ? loc.label : `${loc.label}/${f.name}`;
      for (const rule of untiered(f.text))
        lines.push(
          `${where}: no tier and date: ${rule.length > 80 ? `${rule.slice(0, 77)}...` : rule}`,
        );
      for (const rule of agentsChoice(f.text))
        lines.push(
          `${where}: the agent's choice, retired: ${rule.length > 80 ? `${rule.slice(0, 77)}...` : rule}`,
        );
      for (const { item, line } of paragraphs(f.text)) {
        entries++;
        const id = /^- `([\w.-]+)`/.exec(item)?.[1];
        if (!id) continue;
        if (ids.has(id))
          lines.push(
            `${where}:${line}: id ${id} is used twice in ${loc.label} (first ${ids.get(id)})`,
          );
        else ids.set(id, `${where}:${line}`);
        if (!loc.own) inherited.add(`${f.name.replace(/\.md$/, "")}#${id}`);
      }
    }
  }
  for (const { loc, files } of read.filter((r) => r.loc.own)) {
    for (const f of files) {
      const where = loc.path.endsWith(".md") ? loc.label : `${loc.label}/${f.name}`;
      for (const { item, line } of paragraphs(f.text))
        // The id ends at a word character: a sentence's full stop is not part of it.
        for (const m of item.matchAll(/\boverrides?\s+`?([\w./-]+#[\w.-]*[\w-])`?/gi))
          if (!inherited.has(m[1].replace(/\.md#/, "#")))
            lines.push(`${where}:${line}: overrides ${m[1]}, which no inherited catalogue has`);
    }
  }
  const tail = `${entries} entries in ${fileCount} file${fileCount === 1 ? "" : "s"}, ${lines.length ? `${lines.length} fault${lines.length === 1 ? "" : "s"}` : "no faults"}.`;
  return { text: [...lines, tail].join("\n"), faults: lines.length };
}

/**
 * **`plans chat`**: the maker in a compact project, else the assistant, with
 * the project's `mcp` configs (beside what the user settings load) and its
 * inherited catalogues as added directories.
 */
function chatCommand(args = [], project = proj(), dir = root) {
  const at = (p) => (isAbsolute(p) ? p : resolve(dir, p));
  const agent = project.form === "compact" ? "maker" : "assistant";
  const effort = agent === "maker" ? agentEffort("maker") : "";
  // `--mcp-config` and `--add-dir` take every value up to the next flag, so
  // they come first and the owner's words after a flag of one value.
  return [
    ...project.mcp.flatMap((p) => ["--mcp-config", at(p)]),
    ...project.inherits.flatMap((p) => ["--add-dir", at(p)]),
    "--agent",
    `workflow:${agent}`,
    ...(effort ? ["--effort", effort] : []),
    ...args,
  ];
}

// **What people write on GitHub reaches the queue on its own**
// (decisions.md#github-webhook): `plans webhook` listens, `plans github`
// reads what was missed, both through `githubEvents`, and what is done
// with an event is below: the note, the assistant started, the issue
// closed.

/**
 * **The values of a dotenv file**: `NAME=value` a line, `export ` before it
 * allowed, `#` lines and a ` #` after an unquoted value comments (a value
 * that begins with `#` is the value, as Compose reads it); a single-quoted
 * value as written, a double-quoted one running over lines to its closing
 * quote, its `\n`, `\"` and `\` escapes read.
 */
function dotenv(text = "") {
  const source = String(text).replace(/\r\n?/g, "\n");
  const values = {};
  const start = /^[ \t]*(?:export[ \t]+)?([A-Za-z_]\w*)[ \t]*=[ \t]*/gm;
  let m;
  while ((m = start.exec(source))) {
    const at = start.lastIndex;
    const quote = /["']/.test(source[at]) ? source[at] : "";
    let end = at + 1;
    while (quote && end < source.length && source[end] !== quote)
      end += quote === '"' && source[end] === "\\" ? 2 : 1;
    if (quote && end < source.length) {
      const inner = source.slice(at + 1, end);
      values[m[1]] =
        quote === '"' ? inner.replace(/\\([n"\\])/g, (_, c) => (c === "n" ? "\n" : c)) : inner;
      start.lastIndex = end + 1;
    } else {
      // Unquoted, or a quote never closed: the rest of the line.
      const lineEnd = source.indexOf("\n", at) < 0 ? source.length : source.indexOf("\n", at);
      values[m[1]] = source
        .slice(at, lineEnd)
        .replace(/[ \t]+#.*$/, "")
        .trim();
      start.lastIndex = lineEnd;
    }
  }
  return values;
}

/**
 * **A secret, read when it is used** (decisions.md#push-token): the
 * environment's value of `name` when it is set, else its value in the private
 * dotenv file `WORKFLOW_SECRETS_FILE` names (a relative path from the
 * checkout's root, so `plans gh` from a subfolder and the listener started at
 * the root read the same file), read again at each call and never put into
 * `process.env`, so no program the queue starts inherits it; "" when neither
 * has it or the file cannot be read.
 */
export function secret(name, env = process.env) {
  if (env[name]) return env[name];
  if (!env.WORKFLOW_SECRETS_FILE) return "";
  try {
    return dotenv(readFileSync(resolve(root, env.WORKFLOW_SECRETS_FILE), "utf8"))[name] || "";
  } catch {
    return "";
  }
}

/** Setup's read-only mount of the host's secrets file (skills/setup, step 6). */
const SETUP_SECRETS = "/run/secrets/workflow.env";

/**
 * **Where a refusal says to set** `names` (decisions.md#push-token): inside a
 * container setup made, whose `WORKFLOW_SECRETS_FILE` is the read-only mount
 * nobody can write from there, the host's `~/.config/workflow/<project>.env`
 * (the project file's `name` in lower case, spaces as hyphens, as setup
 * writes it) and the rebuild that reads it; anywhere else, beside `GH_TOKEN`
 * or in the file `WORKFLOW_SECRETS_FILE` names.
 */
function setWhere(names, env = process.env, project = proj().name) {
  if (env.WORKFLOW_SECRETS_FILE !== SETUP_SECRETS)
    return `set ${names} where GH_TOKEN is set, or in the file WORKFLOW_SECRETS_FILE names.`;
  const file = String(project).toLowerCase().replace(/ /g, "-");
  return `set ${names} in ~/.config/workflow/${file}.env on the host, then rebuild the container.`;
}

/** The port the listener takes: `WORKFLOW_WEBHOOK_PORT`, else 8789. */
const webhookPort = (env = process.env) => Number(secret("WORKFLOW_WEBHOOK_PORT", env)) || 8789;

/**
 * Whether the project file turns issues on: its `## Issues` heading, read
 * only with `land: pull-request`, since issues need pull requests; a `land`
 * line taken out by hand turns them off.
 */
export function hasIssues(body = proj().body || "", land = proj().land) {
  return land === "pull-request" && /^## Issues[ \t]*$/m.test(withoutFences(body));
}

/**
 * The line `plans` says when issues are off but plans neither built nor
 * dropped carry an `Issue` line (decisions.md#closes-its-issues); "" with none.
 */
export function issuesOffLine(plans) {
  const carrying = plans.filter(
    (p) => p.issue && !["built", "dropped", "gone", "old"].includes(p.state),
  );
  if (!carrying.length) return "";
  const paths = carrying.slice(0, 3).map((p) => p.path);
  const more = carrying.length > 3 ? `, and ${carrying.length - 3} more` : "";
  const carry = carrying.length === 1 ? "1 plan carries" : `${carrying.length} plans carry`;
  return `Issues are off here: .claude/workflow.md has no Issues heading, but ${carry} an Issue line (${paths.join(", ")}${more}). No comment on their issues reaches the queue and no merge closes one; /workflow:setup turns issues on.`;
}

/** `plans webhook`'s refusal with no secret here. */
export function noSecretWords(env = process.env, project = proj().name) {
  return `The project's Claude has no webhook secret here: turn the webhook on in the app's settings on GitHub, subscribed to ${eventsWords()}, with the address routed to this container and a secret, and ${setWhere("WORKFLOW_WEBHOOK_SECRET and WORKFLOW_WEBHOOK_PORT", env, project)}`;
}

/**
 * The listener's record, when its process is alive; null else. `plans`'s
 * status line reads this, pid only, since the line is synchronous and a
 * port's check would make every `plans` wait; what starts a listener asks
 * `webhookListening`.
 */
function webhookAlive() {
  const record = readJson(files.webhook());
  return record?.pid && pidAlive(record.pid) ? record : null;
}

/** Whether something takes a connection on 127.0.0.1 at `port` within `ms`. */
function portAnswers(port, ms = 300) {
  return new Promise((done) => {
    let socket;
    try {
      socket = connect({ host: "127.0.0.1", port: Number(port) });
    } catch {
      // A port no socket can take, as a hand-edited record's: nothing answers.
      return done(false);
    }
    const timer = setTimeout(() => end(false), ms);
    function end(answers) {
      clearTimeout(timer);
      socket.destroy();
      done(answers);
    }
    socket.once("connect", () => end(true));
    socket.once("error", () => end(false));
  });
}

/**
 * **A listener is alive when its port answers**: the record's pid alive and
 * its port taking a connection. The record sits in the checkout and outlives
 * a container's reboot, where a new container's pid can name another process
 * (decisions.md#github-webhook).
 */
async function webhookListening() {
  const record = webhookAlive();
  return record?.port && (await portAnswers(record.port)) ? record : null;
}

/**
 * The record `seen` found stale, removed before another listener starts,
 * unless a listener wrote its own since (two starts racing).
 */
function dropWebhookRecord(seen) {
  const now = readJson(files.webhook());
  if (!seen || !now || now.pid !== seen.pid || now.at !== seen.at) return;
  try {
    unlinkSync(files.webhook());
  } catch {
    // Gone already.
  }
}

/**
 * **The copy of the plugin this is**: when this `plan-queue.mjs` was
 * written. Each installed version is its own folder, written when it was
 * installed, so a later version's is higher.
 */
function codeStamp() {
  return statSync(fileURLToPath(import.meta.url)).mtimeMs;
}

/** Whether a listener's record was written by an older copy than `code`: none named, or lower. */
export function listenerOlder(record, code = codeStamp()) {
  return !record?.code || record.code < code;
}

/**
 * **A listener of an older copy is replaced** (as Bazel's client stops a
 * server of another version): when `alive` was started by an older copy,
 * it is stopped and its record removed, as `--stop` does, and true is
 * returned once its port is free (two seconds at most), so the new one can
 * take it. Only an older one, so two chats on two versions do not take
 * turns stopping each other's.
 */
async function replaceOlder(alive) {
  return listenerOlder(alive) && (await stopListener(alive));
}

/**
 * Stops the listener `record` names and removes its record, true once its
 * port is free (two seconds at most). Only a listener of the queue's: a pid
 * another process took since, or another user's, is not stopped. Still
 * answering, it keeps its record, so `plans` and `--stop` still find it.
 */
async function stopListener(record) {
  if (!ourListener(record.pid)) return false;
  try {
    process.kill(record.pid);
  } catch (error) {
    // Another user's process is not ours to stop; one gone already is.
    if (error.code === "EPERM") return false;
  }
  const until = Date.now() + 2000;
  while ((await portAnswers(record.port)) && Date.now() < until)
    await new Promise((done) => setTimeout(done, 100));
  if (await portAnswers(record.port)) return false;
  dropWebhookRecord(record);
  return true;
}

/** Starts a detached listener, removing first the stale record `seen`; its pid. */
function spawnListener(seen, env) {
  dropWebhookRecord(seen);
  return detached(process.execPath, [fileURLToPath(import.meta.url), "webhook", "--serve"], {
    ...env,
    WORKFLOW_ROOT: root,
  });
}

/**
 * Whether `pid` runs a listener of the queue's, by its command line where
 * the system shows one (`/proc`); elsewhere taken as one. A pid a reboot
 * gave another process is not stopped by a start.
 */
function ourListener(pid) {
  let line;
  try {
    line = readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return !existsSync("/proc/self/cmdline");
  }
  return line.includes("plan-queue.mjs") && line.includes("webhook");
}

/** A time as the listener's history says it: "15:40" today, "23 November 15:40" before. */
function whenWords(at, now = Date.now()) {
  const day = new Date(at);
  return day.toDateString() === new Date(now).toDateString()
    ? hhmm(at)
    : `${day.getDate()} ${MONTHS[day.getMonth()]} ${hhmm(at)}`;
}

/** A gap between two listeners longer than this, in ms, is said as one none listened in. */
const LISTENER_GAP = 2 * MINUTE;

/**
 * The webhook's line in `plans` and `plans webhook`: listening, with when
 * none listened before it in the last day; or none, since when, from the
 * listener's history (`last`).
 */
export function webhookLine(record = webhookAlive(), last = readJson(files.webhookLast())) {
  const now = Date.now();
  if (!record) {
    const since = last?.aliveAt || last?.lastAt;
    if (!since) return "The webhook: none; plans webhook starts it.";
    const delivered = last.lastAt ? `, last delivery ${whenWords(last.lastAt, now)}` : "";
    return `The webhook: none since ${whenWords(since, now)}${delivered}; plans webhook starts it.`;
  }
  const down =
    record.down && now - record.down.to < DAY_MS
      ? `; none listened from ${whenWords(record.down.from, now)} to ${whenWords(record.down.to, now)}`
      : "";
  const delivered = record.lastAt ? `, last delivery ${whenWords(record.lastAt, now)}` : "";
  // **An app that cannot send a failed run is said while it holds**.
  const lacks = record.lacks;
  const why = !lacks?.what?.length
    ? ""
    : lacks.where === "installation"
      ? "its new permissions are not accepted"
      : `it lacks ${lacks.what.join(" and ")}`;
  const reads = why
    ? `; the app sends no failed run (${why}), so they are read every five minutes`
    : "";
  return `The webhook: listening on ${record.port} since ${hhmm(record.at)}${delivered}${down}${reads}.`;
}

/**
 * **The listener is armed where it can listen**: in a project with `land:
 * pull-request` and the secret set, issues on or off, since a failed run on
 * a pull request reaches the assistant by it (decisions.md#github-webhook),
 * when none is alive, a detached `plans webhook --serve`. `plans start` and
 * the session's start call it; it says nothing.
 */
async function armWebhook(env = process.env) {
  if (!proj().found || proj().land !== "pull-request" || !secret("WORKFLOW_WEBHOOK_SECRET", env))
    return 0;
  const seen = readJson(files.webhook());
  const alive = await webhookListening();
  if (alive && !(await replaceOlder(alive))) return 0;
  return spawnListener(seen, env);
}

/**
 * What the checkout's plans hold for `githubEvents`: carried, planned and
 * own; with them `people`, the logins the project file's **People** gives.
 */
function githubContext(plans = readPlans(join(root, "plans"))) {
  const own = ownOf(plans);
  return {
    carried: plans.filter((p) => p.issue && p.state !== "dropped").map((p) => p.issue),
    planned: plans.filter((p) => p.state === "planned").map((p) => p.issue),
    own: [...own.keys()],
    people: proj().people,
  };
}

/** `gh` for a read, the person's token: the queue's reads, as `openPulls` does. */
function ghRead(args, timeout) {
  return ghAsk(args, timeout).out;
}

/**
 * `gh` for a read that is said when it fails: `{ out, why, status }`, `out`
 * null, `why` GitHub's reason (`whyOf`) and `status` the number in `(HTTP
 * <n>)` on `gh`'s stderr, 0 with none, when the call fails.
 */
function ghAsk(args, timeout) {
  try {
    const out = execFileSync(process.env.WORKFLOW_GH || "gh", args, {
      cwd: root,
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { out, why: "", status: 0 };
  } catch (error) {
    const status = Number(/\(HTTP (\d+)\)/.exec(String(error?.stderr || ""))?.[1] || 0);
    return { out: null, why: whyOf(error, timeout), status };
  }
}

/**
 * **Why a `gh` call failed, in GitHub's words**: the first line `gh` wrote
 * on stderr, cut before its first " (" (the GraphQL path after it) and at
 * 120 characters, its last period dropped; "no answer in <n> seconds" when
 * its timeout killed it; the error's own first line when `gh` wrote nothing.
 */
function whyOf(error, timeout = 0) {
  if (error?.code === "ETIMEDOUT")
    return `no answer in ${Math.max(1, Math.round(timeout / 1000))} seconds`;
  const first = (text) =>
    String(text || "")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) || "";
  const line = first(error?.stderr) || first(error?.message) || "no answer";
  const cut = line.indexOf(" (");
  return (cut > 0 ? line.slice(0, cut) : line).slice(0, 120).trim().replace(/\.$/, "");
}

/**
 * The permission of each author not in the seen file yet, `gh api
 * .../collaborators/<login>/permission`, cached there: `{ seen, unread }`.
 * A login GitHub answers 404 for, saying it is not a user (every bot as
 * `gh`'s lists name it), has permission `none`; an old answer, over a day,
 * is asked again and, with no time left, is unknown. A login it cannot read is left out, so its
 * item is left unseen (`githubEvents`) and it is asked again; `unread` maps
 * it to GitHub's reason, or "out of time" when the deadline passed first.
 */
function withPermissions(seen, items, repo, deadline) {
  const permissions = { ...seen.permissions };
  const checked = { ...(seen.checked || {}) };
  const unread = new Map();
  for (const login of new Set(items.map((item) => item.author).filter(Boolean))) {
    // Read again after a day, so a person whose access was taken away stops
    // counting.
    const fresh = Date.now() - (checked[login] || 0) < 24 * 60 * MINUTE;
    if ((permissions[login] && fresh) || login.endsWith("[bot]")) continue;
    // An old answer is no answer: its item waits for one.
    delete permissions[login];
    if (Date.now() >= deadline) {
      unread.set(login, "out of time");
      continue;
    }
    const { out, why, status } = ghAsk(
      ["api", `repos/${repo}/collaborators/${login}/permission`, "--jq", ".permission"],
      left(deadline, 5000),
    );
    // A 404 is an answer only when GitHub says the login is no user; a
    // repository the token cannot see answers 404 too.
    const permission = status === 404 && /is not a user/.test(why) ? "none" : out?.trim();
    if (permission) {
      permissions[login] = permission;
      checked[login] = Date.now();
    } else unread.set(login, why || "no answer");
  }
  return { seen: { ...seen, permissions, checked }, unread };
}

/** The app's slug, read once and kept in the seen file; "" with no app. */
async function slugOf(seen, env = process.env) {
  if (seen.slug) return seen.slug;
  const id = secret("WORKFLOW_APP_ID", env);
  const key = secret("WORKFLOW_APP_KEY", env);
  if (!id || !key) return "";
  try {
    return await appSlug({ id, key });
  } catch {
    return "";
  }
}

/** The prompt of an assistant started on a note. */
export function githubPrompt(path) {
  return `GitHub: ${path}.`;
}

/**
 * **What is done with the events** (decisions.md#github-webhook), in their
 * order, a line printed per thing: `merged` closes each issue its
 * description closes as the app with `Merged as #<m>.` and writes `Issue
 * #<n> closed <date>.` in its plan's "Built", and a close that fails is an
 * `unclosed` note for the assistant (decisions.md#closes-its-issues), tried
 * once since a merge is an event once; every other kind but `issue` is appended to
 * `plans/github/<n>.md` and the assistant started on the oldest note not
 * handled, under the queue's bounds; `issue` is kept for `plans` to list.
 */
export async function handleEvents(events, seen, { dry = false } = {}) {
  const said = [];
  const noted = [];
  const fresh = { ...(seen.fresh || {}) };
  const plans = readPlans(join(root, "plans"));
  let login = seen.login || "";
  // Read once a batch, at its first merge: the open pull requests do not
  // change between its events.
  let open;
  // Appends `event`'s note to its pull request's or issue's file, and marks
  // the line said next as that note's.
  const note = (event) => {
    const dir = join(root, "plans", "github");
    const file = join(dir, `${event.number}.md`);
    if (!dry) {
      mkdirSync(dir, { recursive: true });
      appendFileSync(file, noteFor(event, { first: !existsSync(file) }));
    }
    noted.push({ path: `plans/github/${event.number}.md`, line: said.length });
  };
  for (const event of events) {
    if (event.kind === "merged") {
      // Each issue in turn, whatever the last one's close did; a failed one is
      // noted first, so the line said is that note's.
      for (const issue of event.issues || []) {
        const done = await closeIssue(event, issue, plans, dry);
        if (done.why) note({ ...event, kind: "unclosed", issue, why: done.why });
        said.push(done.said);
      }
      // **What the merge left behind**
      // (decisions.md#merge-refreshes-the-rest): the open pull requests, read
      // as they are now.
      if (proj().land !== "pull-request" || !event.base) continue;
      if (open === undefined) {
        const { out } = ghAsk(
          [
            "pr",
            "list",
            "--state",
            "open",
            "--limit",
            "100",
            "--json",
            "number,headRefName,baseRefName,author",
          ],
          10_000,
        );
        open = null;
        try {
          const list = out === null ? null : JSON.parse(out || "[]");
          if (Array.isArray(list)) open = list;
        } catch {
          // Unread, as a failed call.
        }
        if (!login) login = String(ghRead(["api", "user", "--jq", ".login"], 5000) || "").trim();
      }
      // An unread login would leave every person's pull request as another's,
      // so it is unread as the list is. A merge from the project's own branch
      // into another (a release) leaves nothing stacked on it.
      const behind =
        open && login
          ? behindOf(
              event.head === proj().branch ? { ...event, head: "" } : event,
              open,
              githubContext(plans).own,
              login,
            )
          : { unread: true };
      if (!behind.unread && !behind.own.length && !behind.stacked.length) {
        said.push(
          `GitHub: #${event.number} merged into ${event.base}: none of the queue's own is behind.`,
        );
        continue;
      }
      note({ ...event, behind });
      said.push(
        behind.unread
          ? `GitHub: #${event.number} merged into ${event.base}, noted: behind not read.`
          : `GitHub: #${event.number} merged into ${event.base}, noted: ${behind.own.length + behind.stacked.length} behind.`,
      );
      continue;
    }
    if (event.kind === "issue") {
      fresh[event.number] = { title: event.title, at: event.at };
      said.push(`GitHub: #${event.number} opened by ${event.by}, listed.`);
      continue;
    }
    note(event);
    said.push(
      event.kind === "failed"
        ? `GitHub: #${event.number} ${event.by} run failed, noted.`
        : `GitHub: #${event.number} ${event.kind} by ${event.by}, noted.`,
    );
  }
  let started = "";
  let refused = "";
  if (noted.length) {
    // The oldest note with an event not handled; one chat at a time.
    const path = notesWaiting()[0] || noted[0].path;
    const out = dry ? "" : start([path], { agent: "assistant" });
    const ours = noted.find((one) => one.path === path) || noted[0];
    if (/ was started on: /.test(out)) {
      said[ours.line] = `${said[ours.line].replace(/\.$/, "; assistant started.")} ${out}`;
      started = out;
    } else if (out) refused = out;
  }
  // **An open chat is sent the note** (decisions.md#note-sent-to-open-chat),
  // whether this run noted it or not. A chat started on it reads every note
  // waiting, so none is sent it again, unless its start is not confirmed
  // (`claude agents` unread), which the minute's send covers. A told file
  // that cannot be written throws nothing, so the seen file is still written
  // and no delivery is noted twice.
  let sent = "";
  try {
    if (!started) sent = tellAssistant({ dry });
    else if (!/ is not confirmed\./.test(started))
      markTold(sessionName("assistant", 0, { project: proj().name }));
  } catch {
    // Told nothing: the listener's minute tries again.
  }
  said.push(sent || refused);
  return { said: said.filter(Boolean), seen: { ...seen, fresh, ...(login ? { login } : {}) } };
}

/**
 * An issue a merged pull request closes (decisions.md#closes-its-issues),
 * closed as the app with a line in its plan's "Built". `{ said, why }`:
 * the line `plans github` says of it, and why it was not closed, "" when it
 * was, when the number is a pull request's, or in a dry run: `plans gh`'s own
 * refusal whole, on one line, else gh's last line of words (cut at 200), else
 * "gh said nothing", with no full stop at its end, for the `unclosed` note
 * the assistant closes it from.
 */
async function closeIssue(event, issue, plans, dry) {
  let ran = null;
  // Read here, since the runs below keep no output for `repoHere` to read.
  const repo = dry ? "" : repoHere(spawnSync, process.env, false);
  // gh's output is kept: its words are the read's answer, or the cause of a
  // failed read or close.
  const gh = (args) =>
    ghCommand(args, {
      run: (bin, given, options) =>
        (ran = spawnSync(bin, given, {
          ...options,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
          // A stalled gh would hold the read's guard and every delivery after it.
          timeout: 30_000,
        })),
      repo,
    });
  // What the number is, first: `gh issue close` closes a pull request given
  // its number, and a Closes line closes issues only, so a typo or a person's
  // own line closes nobody's pull request (plans/merge-closes-no-pull-request.md).
  // GitHub's issues endpoint gives a pull request its `pull_request` key; a
  // read with no answer is a failed close, the number's kind not known.
  let done = { status: 0, said: "" };
  if (!dry) {
    done = await gh([
      "api",
      `repos/{owner}/{repo}/issues/${issue}`,
      "--jq",
      ".pull_request != null",
    ]);
    const kind = done.status === 0 ? String(ran?.stdout || "").trim() : "";
    if (kind === "true")
      return {
        said: `GitHub: #${issue} is a pull request, so merging #${event.number} left it open.`,
        why: "",
      };
    if (kind === "false")
      done = await gh([
        "issue",
        "close",
        String(issue),
        "--reason",
        "completed",
        "--comment",
        `Merged as #${event.number}.`,
      ]);
    else if (done.status === 0)
      done = {
        status: 1,
        said: `the read of whether #${issue} is a pull request answered ${kind ? `"${kind.slice(0, 80)}"` : "nothing"}`,
      };
  }
  const plan = plans.find((p) => p.issue === issue && p.state === "built");
  if (plan && done.status === 0 && !dry) {
    const lines = plan.text.split("\n");
    const at = lines.findIndex((line) => /^## Built\b/.test(line));
    const first = lines.findIndex((line, i) => i > at && line.trim());
    if (at >= 0 && first > at) {
      lines.splice(first + 1, 0, `Issue #${issue} closed ${today()}.`);
      writeFileSync(plan.file, lines.join("\n"));
    }
  }
  if (done.status === 0)
    return { said: `GitHub: #${issue} closed, merged as #${event.number}.`, why: "" };
  // One line, whatever it says, since the note indents only its first.
  const words = String(ran?.stderr || "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const why = (
    done.said.replace(/\s+/g, " ").trim() ||
    words.at(-1)?.slice(0, 200) ||
    "gh said nothing"
  ).replace(/\.$/, "");
  return {
    said: `GitHub: #${issue} was not closed, merged as #${event.number}, noted: ${why}.`,
    why,
  };
}

/**
 * **What a merge leaves behind** (decisions.md#merge-refreshes-the-rest),
 * pure: of the open pull requests (`number`, `headRefName`, `baseRefName`,
 * `author`), the queue's own by `own` (a number or a head) whose base is the
 * merged one's base or its head. `{ own, stacked, theirs }`, each `[{ number,
 * head, login }]`: `stacked` on the merged head, `theirs` by a person who is
 * not `login`, the token's own (with `login` empty, every person's: unread,
 * the safe side is to leave it), `own` the rest.
 */
export function behindOf(event, pulls = [], own = [], login = "") {
  const ours = new Set(own);
  const out = { own: [], stacked: [], theirs: [] };
  for (const pull of pulls) {
    if (pull.number === event.number) continue;
    if (!ours.has(pull.number) && !ours.has(pull.headRefName)) continue;
    const on =
      pull.baseRefName === event.base
        ? "own"
        : event.head && pull.baseRefName === event.head
          ? "stacked"
          : "";
    if (!on) continue;
    const who = pull.author?.login || "";
    const one = { number: pull.number, head: pull.headRefName, login: who };
    if (!pull.author?.is_bot && (!login || who !== login)) out.theirs.push(one);
    else out[on].push(one);
  }
  return out;
}

/**
 * **The notes with an event not handled yet**, oldest first: a note whose
 * last event line comes after its last `## Handled` line. `plans` lists
 * them, so a note whose chat could not start is seen.
 */
export function notesWaiting(dir = join(root, "plans", "github")) {
  return readNotes(dir)
    .filter((one) => one.state === "waiting")
    .sort((a, b) => a.mtime - b.mtime)
    .map((one) => one.path);
}

/**
 * A note's event line, as `noteFor` writes it: what `noteState` reads for
 * `notesWaiting` and `writtenAt`. `unclosed`, an issue a merge did not close,
 * waits as any event (decisions.md#closes-its-issues).
 */
const NOTE_EVENT = /^(?:plan|mention|comment|review|ready|failed|merged|unclosed), /;

/**
 * "waiting" when a note's last event line comes after its last `## Handled`
 * line, "handled" when the reverse, "" with neither.
 */
function noteState(text) {
  const lines = text.split("\n");
  const lastEvent = lines.findLastIndex((line) => NOTE_EVENT.test(line));
  const lastHandled = lines.findLastIndex((line) => /^## Handled\b/.test(line));
  return lastEvent > lastHandled ? "waiting" : lastHandled > lastEvent ? "handled" : "";
}

/** Each note in `dir`: its path, its state (`noteState`) and its time; a note unread is left out. */
function readNotes(dir) {
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => /^\d+\.md$/.test(name));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = join(dir, name);
    try {
      const state = noteState(readFileSync(file, "utf8"));
      return [{ path: `plans/github/${name}`, state, mtime: statSync(file).mtimeMs }];
    } catch {
      return [];
    }
  });
}

/** How many times a note is sent to an open assistant chat before `plans` alone lists it. */
const TELL_TRIES = 5;
/** How long the one-shot run that sends it has. */
const TELL_TIMEOUT = 60_000;

/** The one-shot run's system prompt: the relay words of the trial (plans/open-assistant-reads-github-notes.md). */
const RELAY_PROMPT =
  "You relay one message to another Claude session on this machine. Call SendMessage exactly once. Its 'to' argument is the whole Recipient line after 'Recipient: ', every character. Its 'message' argument is the Text, changing no character. Then answer with the tool's result and nothing else.";

/** The told file: `{ [path]: { mtime, at, to, ok, tries } }`, a note's last send. */
function readTold() {
  const told = readJson(files.githubTold());
  return told && typeof told === "object" ? told : {};
}

/**
 * Whether `note` waits to be sent to the chat `session`: never sent, sent
 * before its last change (a new event), or failed under `TELL_TRIES` times
 * on that chat, so a chat that replaces one never reached is tried afresh.
 */
function untold(note, told, session) {
  const entry = told[note.path];
  return (
    !entry ||
    entry.mtime !== note.mtime ||
    (!entry.ok && (entry.session !== session || (entry.tries || 0) < TELL_TRIES))
  );
}

/** The notes waiting, oldest first. */
function notesWaitingNow() {
  return readNotes(join(root, "plans", "github"))
    .filter((one) => one.state === "waiting")
    .sort((a, b) => a.mtime - b.mtime);
}

/** The notes waiting and not yet sent to the chat `session`, oldest first. */
export function notesUntold(session, told = readTold()) {
  return notesWaitingNow().filter((one) => untold(one, told, session));
}

/** The told entry of a note as it is now, or null: one written before its last change says nothing. */
function toldOf(path, told = readTold(), dir = join(root, "plans", "github")) {
  const entry = told[path];
  if (!entry) return null;
  const note = readNotes(dir).find((one) => one.path === path);
  return note && note.mtime === entry.mtime ? entry : null;
}

/**
 * Writes the notes `notes` told to `to`, each at the change it had when
 * read, so an event noted meanwhile is still sent.
 */
function markTold(to, at = Date.now(), notes = notesWaitingNow()) {
  const told = readTold();
  for (const note of notes) told[note.path] = { mtime: note.mtime, at, to, ok: true, tries: 0 };
  writeJson(files.githubTold(), told);
}

/**
 * **The open assistant chat a note is sent to**
 * (decisions.md#note-sent-to-open-chat): of the live rows with the
 * assistant's name and a process, the one whose state says it ran the
 * assistant's agent, else the one started last. `{ row, address, agent }`,
 * the address its process's socket, or the name when no socket is found and
 * one chat alone has it, else "". Null with none.
 */
export function assistantChat(
  live,
  {
    stateOf = readState,
    socks = process.env.WORKFLOW_SOCKS || "/tmp/cc-socks",
    // Every chat on the machine: a name another checkout's chat shares is no address.
    all = liveAll || live,
  } = {},
) {
  const rows = (live || []).filter((row) => row.pid && isSession("assistant", row));
  if (!rows.length) return null;
  const ran = rows.find((one) => stateOf(one.sessionId)?.agent === "assistant");
  const row = ran || [...rows].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
  const sock = join(socks, `${row.pid}.sock`);
  const alone = (all || []).filter((one) => one.name === row.name).length === 1;
  const address = existsSync(sock) ? `uds:${sock}` : alone ? row.name : "";
  return { row, address, agent: !!ran };
}

/**
 * The message an open assistant chat is sent for `path`: the start prompt's
 * line, what to read and do, and, to a chat the queue has not seen run the
 * assistant's agent, the line asking it to tell the owner.
 */
export function noteMessage(path, { agent = true, pluginRoot = join(here, "..") } = {}) {
  return [
    githubPrompt(path),
    `From this project's webhook, not a person: an event in that file, and maybe in others of plans/github/, is under no "## Handled" line. Read "What reaches you from GitHub" in ${join(pluginRoot, "docs", "github.md")}, act once as it says for each, and write the Handled line.`,
    ...(agent
      ? []
      : [
          `If your instructions hold no heading "What reaches you from GitHub", this chat has the assistant's name and not its instructions: tell ${owner()} in a line that it was opened before this project's chats opened as the assistant, and that a new chat opened here has them.`,
        ]),
  ].join("\n");
}

/**
 * Whether the one-shot run's stream-json output holds a tool result that
 * sent: `{ ok: true }`, else `{ ok: false, why }`, the why the tool
 * result's own words cut at 120 characters, or "".
 */
export function relayResult(out) {
  let words = "";
  for (const line of String(out || "").split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const content = event?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type !== "tool_result") continue;
      const text =
        typeof part.content === "string"
          ? part.content
          : Array.isArray(part.content)
            ? part.content.map((one) => one?.text || "").join("")
            : "";
      if (/"success"\s*:\s*true/.test(text)) return { ok: true };
      words ||= text.replace(/\s+/g, " ").trim();
    }
  }
  return { ok: false, why: words.slice(0, 120) };
}

/**
 * **A note reaches an open assistant chat by a message the queue sends
 * itself** (decisions.md#note-sent-to-open-chat): when a note waits untold,
 * one one-shot run of Claude, from the temp folder with the message tool
 * alone, sends the chat `noteMessage` for the oldest. Sent, every waiting
 * note is told, since the message covers them all; not, the oldest's tries
 * grow, and the listener's minute tries again. The line `plans github`
 * prints, or "" with nothing to send or no chat to send it to.
 */
export function tellAssistant({ dry = false, live, now = Date.now() } = {}) {
  // The compact form has no queue, and a note is read only with pull requests.
  if (proj().form === "compact" || proj().land !== "pull-request") return "";
  const versions = notesWaitingNow();
  if (!versions.length || dry) return "";
  const chat = assistantChat(live ?? liveSessions());
  if (!chat) return "";
  const session = chat.row.sessionId;
  const waiting = notesUntold(session);
  if (!waiting.length) return "";
  const { path, mtime } = waiting[0];
  const name = chat.row.name;
  let why = "";
  if (!chat.address) why = `no address for ${name}`;
  else {
    const { WORKFLOW_ROOT: _root, CLAUDE_PROJECT_DIR: _dir, ...env } = process.env;
    const ran = spawnSync(
      claudeBin(),
      [
        "-p",
        "--model",
        "haiku",
        "--tools",
        "SendMessage",
        "--allowedTools",
        "SendMessage",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--output-format",
        "stream-json",
        "--verbose",
        "--system-prompt",
        RELAY_PROMPT,
        `Recipient: ${chat.address}\nText:\n${noteMessage(path, { agent: chat.agent })}`,
      ],
      {
        // No project's hooks or `agent` setting apply in the temp folder.
        cwd: tmpdir(),
        env,
        encoding: "utf8",
        timeout: TELL_TIMEOUT,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const result = relayResult(ran.stdout);
    if (result.ok) {
      markTold(name, now, versions);
      return `GitHub: ${name} was sent ${path}.`;
    }
    why =
      ran.error?.code === "ETIMEDOUT"
        ? `no answer in ${TELL_TIMEOUT / 1000} seconds`
        : ran.error
          ? ran.error.message
          : result.why || "no tool result";
  }
  const told = readTold();
  const before = told[path];
  const again = before && before.mtime === mtime && !before.ok && before.session === session;
  const tries = (again ? before.tries || 0 : 0) + 1;
  told[path] = { mtime, at: now, to: name, session, ok: false, tries, why };
  writeJson(files.githubTold(), told);
  return `GitHub: ${name} could not be sent ${path}: ${why}; ${tries < TELL_TRIES ? "tried again in a minute" : "plans lists it"}.`;
}

/** The seen file, with its defaults. */
function readSeen() {
  return { ...NOTHING_SEEN, ...readJson(files.githubSeen()) };
}

/**
 * The seen file written by a read, with the Stop hook's `checksUnread` as it
 * is on disk now, not as the read found it seconds before: the Stop hook
 * alone sets it.
 */
function writeSeen(next) {
  const { checksUnread } = readJson(files.githubSeen()) || {};
  const kept = { ...next };
  delete kept.checksUnread;
  if (checksUnread) kept.checksUnread = checksUnread;
  writeJson(files.githubSeen(), kept);
}

/**
 * Items and the seen file through `githubEvents`, the permissions read first,
 * then handled: `{ said, unread }`, `unread` a list not read per author whose
 * permission is unknown, `listOf`'s shape, so the read's line holds. With
 * issues off only failed runs and merges make events (`issuesOff`); a failed
 * run whose pull request GitHub left out is given the open one of its head
 * branch (decisions.md#github-webhook).
 */
async function act(items, { deadline = Date.now() + 25_000, dry = false } = {}) {
  const issues = hasIssues();
  items = items.map((item) => {
    if (item.kind !== "failed" || item.number || !item.head || Date.now() >= deadline) return item;
    let number = 0;
    try {
      const out = ghRead(
        ["pr", "list", "--head", item.head, "--state", "open", "--limit", "1", "--json", "number"],
        left(deadline, 10_000),
      );
      number = JSON.parse(out || "[]")[0]?.number || 0;
    } catch {
      // Unread: no event is made of it.
    }
    return { ...item, number };
  });
  let seen = readSeen();
  seen.slug = await slugOf(seen);
  const repo = repoHere(spawnSync, process.env, false);
  // A run is nobody's writing, and with issues off nothing else is acted on:
  // no permission is read for either.
  let whys = new Map();
  if (repo && issues)
    ({ seen, unread: whys } = withPermissions(
      seen,
      items.filter((item) => item.kind !== "failed" && !seenBefore(seen, item)),
      repo,
      deadline,
    ));
  const context = { ...githubContext(), slug: seen.slug, issuesOff: !issues };
  const { events, seen: next, unjudged } = githubEvents(seen, items, context);
  const { said, seen: kept } = await handleEvents(events, next, { dry });
  // A dry run changes nothing on disk, so the real one still sees it all.
  if (!dry) writeSeen(kept);
  const unread = unjudged.map((login) => ({
    name: `the permission of ${login}`,
    line: "read",
    why: whys.get(login) || "not asked",
  }));
  return { said, unread };
}

/** Whether a comment, review or issue's opening was seen by its id (`githubEvents`'s key). */
function seenBefore(seen, item) {
  const key = item.kind === "opened" ? `opened:${item.number}` : item.id;
  return Boolean(key && (seen.items || []).includes(key));
}

/** The inbox's deliveries not seen yet, oldest first, as items. */
function inboxItems(seen) {
  let names = [];
  try {
    names = readdirSync(files.githubInbox()).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const entries = names
    .map((name) => {
      const file = join(files.githubInbox(), name);
      try {
        return {
          file,
          mtime: statSync(file).mtimeMs,
          delivery: JSON.parse(readFileSync(file, "utf8")),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.mtime - b.mtime);
  // The inbox keeps the last five hundred, as the seen file does.
  for (const old of entries.slice(0, Math.max(0, entries.length - 500)))
    try {
      unlinkSync(old.file);
    } catch {
      // Gone already.
    }
  return entries
    .filter((one) => !seen.deliveries.includes(one.delivery.id))
    .flatMap((one) => {
      try {
        return itemsOfDelivery(one.delivery.event, JSON.parse(one.delivery.body), one.delivery.id);
      } catch {
        return [];
      }
    });
}

/**
 * **`plans github`, one at a time** (decisions.md#github-webhook): a read
 * runs behind `files.githubGuard()`, the pid-owned guard `plans hold` uses,
 * waiting up to a minute for another to end, so two never judge the same
 * delivery; one that cannot take it reads nothing and its inbox waits for
 * the next. A dry run changes nothing and takes no guard.
 */
async function githubCommand(options = {}) {
  if (options.dry) return githubRead(options);
  const guard = files.githubGuard();
  let held = false;
  try {
    mkdirSync(dirname(guard), { recursive: true });
    held = takeHoldGuard(guard, 60_000);
  } catch {
    // A folder it cannot write: the read runs unguarded, and its own write
    // of the seen file says what is wrong.
    return githubRead(options);
  }
  if (!held) return ["GitHub: another read is running here, so this one read nothing."];
  const release = () => dropGuard(guard);
  process.on("exit", release);
  try {
    return await githubRead(options);
  } finally {
    release();
    process.off("exit", release);
  }
}

/** Removes a guard file while it holds this process's pid. */
function dropGuard(guard) {
  try {
    if (readFileSync(guard, "utf8") === String(process.pid)) unlinkSync(guard);
  } catch {
    // Gone already.
  }
}

/**
 * **`plans github`'s read**: what the inbox may have missed since the last
 * read, from `gh`, under `relatedReaders`'s budget: the open issues updated
 * since, with their comments and labels, every open pull request's inline
 * comments, the queue's own open pull requests' comments and reviews, and
 * the pull requests merged since; then the inbox's own deliveries; all
 * through `githubEvents`.
 */
async function githubRead({ budget = 25_000, dry = false, inbox = false } = {}) {
  const deadline = Date.now() + budget;
  // The read's own start is the next one's line, so nothing made while it runs
  // is lost.
  const began = new Date().toISOString();
  const seen = readSeen();
  const since = seen.readAt || "";
  const items = [];
  // The listener's handling: the inbox alone, no read; nothing once pull
  // requests are off, so a listener left running acts on no delivery; with
  // issues off, `act` takes the failed runs alone
  // (decisions.md#github-webhook).
  if (inbox && proj().land !== "pull-request") return ["GitHub: nothing new."];
  if (inbox) {
    const { said, unread } = await act(inboxItems(seen), { deadline, dry });
    const all = [...said, ...unreadSaid(unread).map((group) => `GitHub: could not read ${group}.`)];
    return all.length ? all : ["GitHub: nothing new."];
  }
  const newer = (at) => !since || (at && at > since);
  // The runs' own line, moved only when every run list was read, so a read
  // that fails or runs out of time does not pass a failure it missed.
  const runsSince = seen.runsReadAt ?? since;
  const newerRun = (at) => !runsSince || (at && at > runsSince);
  // **A list it could not read is said, and its line holds**: each failed
  // read is kept by its name and GitHub's reason, and the lines below move
  // only past what was read. `runs` is a run list, `pulls` the open pull
  // requests, which hold both lines, anything else `readAt` alone.
  const unread = [];
  const listOf = (name, line, args, most) => {
    if (Date.now() >= deadline) {
      unread.push({ name, line, why: "out of time" });
      return null;
    }
    const { out, why } = ghAsk(args, left(deadline, most));
    if (out === null) {
      unread.push({ name, line, why });
      return null;
    }
    try {
      const list = JSON.parse(out || "[]");
      if (Array.isArray(list)) return list;
    } catch {
      // Said below, as unread.
    }
    unread.push({ name, line, why: "an answer that is not JSON" });
    return null;
  };
  // A thread's whole list of comments, every page, since the line.
  const threadComments = (number) =>
    listOf(
      `the comments of #${number}`,
      "read",
      [
        "api",
        `repos/{owner}/{repo}/issues/${number}/comments?per_page=100${since ? `&since=${since}` : ""}`,
        "--paginate",
      ],
      10_000,
    )?.map(restItem);
  // What changed since the last read, not the newest fifty.
  const searched = (what) => (since ? ["--search", `${what}:>=${since.slice(0, 19)}Z`] : []);
  // With issues off, the queue's own pull requests' failed runs alone
  // (decisions.md#github-webhook).
  const issuesOn = hasIssues();
  const issues = !issuesOn
    ? []
    : listOf(
        "the open issues",
        "read",
        [
          "issue",
          "list",
          "--state",
          "open",
          "--limit",
          "100",
          ...searched("updated"),
          "--json",
          "number,title,labels,author,createdAt,updatedAt,url,body,comments",
        ],
        10_000,
      ) || [];
  const plans = readPlans(join(root, "plans"));
  const context = githubContext(plans);
  for (const issue of issues) {
    if (!newer(issue.updatedAt)) continue;
    const base = {
      number: issue.number,
      title: issue.title,
      labels: labelsOf(issue),
      url: issue.url,
      pull: false,
    };
    if (newer(issue.createdAt))
      items.push({
        ...base,
        kind: "opened",
        author: issue.author?.login || "",
        at: issue.createdAt,
        text: issue.body || "",
      });
    // A label read is no event of its own time: the issue's update stands in.
    // **A label put back is read again**: one told is read when the issue
    // was updated since, and told when put on after it was last told
    // (decisions.md#github-webhook).
    let labelEvents;
    for (const label of ["status: planning", "status: ready"]) {
      if (!base.labels.includes(label)) continue;
      const key = `${issue.number}:${label}`;
      const told = (seen.labeled || []).includes(key);
      const toldAt = seen.labeledAt?.[key];
      // An older file's key with no time: the final write gives it one.
      if (told && (!toldAt || issue.updatedAt <= toldAt)) continue;
      // Once per issue, a failed read too.
      if (labelEvents === undefined)
        labelEvents = listOf(
          `the label events of #${issue.number}`,
          "read",
          ["api", `repos/{owner}/{repo}/issues/${issue.number}/events`, "--paginate"],
          5000,
        );
      if (!labelEvents) continue;
      const last = labeller(labelEvents, label);
      if (told && !(last.at > toldAt)) continue;
      items.push({
        ...base,
        kind: "labeled",
        label,
        author: last.login,
        at: issue.updatedAt,
        text: "",
      });
    }
    // A list `gh` embeds is its first hundred, the oldest: a full one is read
    // again whole.
    const comments =
      (issue.comments || []).length < EMBEDDED
        ? (issue.comments || []).map(embeddedItem)
        : threadComments(issue.number);
    for (const comment of comments || [])
      if (newer(comment.at))
        items.push({ ...base, kind: "comment", ...comment, url: comment.url || issue.url });
  }
  const pulls =
    listOf(
      "the open pull requests",
      "pulls",
      [
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        "50",
        "--json",
        // No checks: a token that cannot read them would fail the whole list
        // (decisions.md#github-webhook).
        "number,title,url,headRefName,headRefOid,comments,reviews",
      ],
      10_000,
    ) || [];
  const own = new Set(context.own);
  const people = new Set(context.people);
  // **The inline comments of every open pull request, in one list**, with a
  // line: one call for the repository, so a named person's inline comment on
  // another person's pull request is found (decisions.md#github-webhook).
  // Unread, every pull request's are skipped and the line holds.
  const inline =
    !issuesOn || !since || !pulls.length
      ? null
      : listOf(
          "the review comments",
          "read",
          ["api", `repos/{owner}/{repo}/pulls/comments?since=${since}&per_page=100`, "--paginate"],
          10_000,
        );
  const inlineOf = new Map();
  for (const note of inline || []) {
    const number = Number(/\/pulls\/(\d+)$/.exec(note?.pull_request_url || "")?.[1] || 0);
    if (!number) continue;
    if (!inlineOf.has(number)) inlineOf.set(number, []);
    inlineOf.get(number).push(note);
  }
  // **Another person's pull request is read when a named person wrote on it
  // since the last read** (decisions.md#people-act-on-github): its comments,
  // reviews and inline comments as the queue's own, no run list, a failed
  // run being told for the queue's own alone; none on a first read, which
  // has no line.
  // A list `gh` embeds is its first hundred, the oldest: a full one is read
  // again whole, before a named person's words are looked for in it.
  const commentsOf = (pull) =>
    (pull.comments || []).length < EMBEDDED
      ? (pull.comments || []).map(embeddedItem)
      : threadComments(pull.number);
  const reviewsOf = (pull) =>
    (pull.reviews || []).length < EMBEDDED
      ? (pull.reviews || []).map(embeddedItem)
      : listOf(
          `the reviews of #${pull.number}`,
          "read",
          ["api", `repos/{owner}/{repo}/pulls/${pull.number}/reviews?per_page=100`, "--paginate"],
          10_000,
        )?.map(restItem);
  const namedSince = (said) =>
    said.some(({ author, at }) => author && people.has(author.toLowerCase()) && newer(at));
  for (const pull of pulls) {
    const ours = own.has(pull.number) || own.has(pull.headRefName);
    if (!ours && !(issuesOn && since)) continue;
    const comments = issuesOn ? commentsOf(pull) : null;
    const reviews = issuesOn ? reviewsOf(pull) : null;
    const inlineSaid = (inlineOf.get(pull.number) || []).map(restItem);
    if (!ours && !namedSince([...(comments || []), ...(reviews || []), ...inlineSaid])) continue;
    const base = {
      number: pull.number,
      title: pull.title,
      labels: [],
      url: pull.url,
      pull: true,
      head: pull.headRefName,
    };
    // The head commit's runs alone, so a busy branch's older runs do not
    // crowd a failed one out.
    const runs = !ours
      ? null
      : listOf(
          `the runs of #${pull.number}`,
          "runs",
          [
            "run",
            "list",
            "--branch",
            pull.headRefName,
            "--commit",
            pull.headRefOid,
            "--limit",
            "100",
            "--json",
            "databaseId,attempt,status,conclusion,headSha,workflowName,updatedAt,url",
          ],
          5000,
        );
    if (runs) items.push(...failedRunsOf(pull, base, runs, newerRun));
    if (!issuesOn) continue;
    for (const comment of comments || [])
      if (newer(comment.at)) items.push({ ...base, kind: "comment", ...comment, url: pull.url });
    for (const review of reviews || [])
      if (newer(review.at)) items.push({ ...base, kind: "review", ...review, url: pull.url });
    // With no line, a first read, the queue's own pull request's own list.
    const notes = since
      ? inline && (inlineOf.get(pull.number) || [])
      : listOf(
          `the review comments of #${pull.number}`,
          "read",
          ["api", `repos/{owner}/{repo}/pulls/${pull.number}/comments`, "--paginate"],
          5000,
        );
    for (const note of since ? inline && inlineSaid : (notes || []).map(restItem))
      if (newer(note.at))
        items.push({ ...base, kind: "review", ...note, url: note.url || pull.url });
  }
  // **The merges since the last read**, issues on or off, with their base
  // (decisions.md#merge-refreshes-the-rest); none on a first read, which
  // has no line yet and would tell the last hundred.
  const merged = !(proj().land === "pull-request" && since)
    ? []
    : listOf(
        "the merged pull requests",
        "read",
        [
          "pr",
          "list",
          "--state",
          "merged",
          "--limit",
          "100",
          ...searched("merged"),
          "--json",
          "number,title,url,body,mergedAt,mergedBy,headRefName,baseRefName",
        ],
        10_000,
      ) || [];
  for (const pull of merged)
    if (newer(pull.mergedAt))
      items.push({
        number: pull.number,
        title: pull.title,
        labels: [],
        url: pull.url,
        pull: true,
        head: pull.headRefName,
        base: pull.baseRefName || "",
        kind: "closed",
        merged: true,
        author: pull.mergedBy?.login || "",
        at: pull.mergedAt,
        text: pull.body || "",
      });
  items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const acted = await act([...items, ...inboxItems(seen)], { deadline, dry });
  const said = acted.said;
  unread.push(...acted.unread);
  // Unmoved, `runsReadAt` keeps the line it read from, so a `readAt` that
  // moves does not carry the runs past what they missed.
  const readOk = !unread.some((one) => one.line !== "runs");
  const runsOk = !unread.some((one) => one.line !== "read");
  const groups = unreadSaid(unread);
  if (!dry) {
    const next = {
      ...readSeen(),
      readAt: readOk ? began : seen.readAt,
      runsReadAt: runsOk ? began : runsSince,
      unread: { at: began, said: groups },
    };
    if (!groups.length) delete next.unread;
    // A label told before its time was kept is read again only when put on
    // after this read.
    next.labeledAt = { ...next.labeledAt };
    // To the second, as GitHub writes its times.
    for (const key of next.labeled || []) next.labeledAt[key] ||= `${began.slice(0, 19)}Z`;
    // Past a read whose line moved, the times an older seen file kept hide
    // nothing more.
    if (readOk) {
      delete next.issues;
      delete next.pulls;
    }
    writeSeen(next);
  }
  const all = [...said, ...groups.map((group) => `GitHub: could not read ${group}.`)];
  return all.length ? all : ["GitHub: nothing new."];
}

/** A list `gh` embeds (an issue's comments, a pull request's reviews) holds its first hundred, the oldest. */
const EMBEDDED = 100;

/** An item's fields from a comment or review `gh` embeds in a list. */
function embeddedItem(one) {
  return {
    id: one?.id || "",
    author: one?.author?.login || "",
    at: one?.submittedAt || one?.createdAt || "",
    text: one?.body || "",
    url: one?.url || "",
  };
}

/** An item's fields from a comment, review or inline comment of GitHub's REST lists. */
function restItem(one) {
  return {
    id: one?.node_id || "",
    author: one?.user?.login || "",
    at: one?.submitted_at || one?.created_at || "",
    text: one?.body || "",
    url: one?.html_url || "",
  };
}

/**
 * **The lists a read could not get, said**: grouped by their reason, in the
 * order met, each group `<names> (<why>)`, one kind's pull requests joined
 * ("the runs of #132 and #118").
 */
function unreadSaid(unread = []) {
  const groups = new Map();
  for (const { name, why } of unread) {
    if (!groups.has(why)) groups.set(why, []);
    groups.get(why).push(name);
  }
  return [...groups].map(([why, names]) => {
    const kinds = new Map();
    for (const name of names) {
      const [, kind, number] = name.match(/^(.* of) (#\d+)$/) || [null, name, null];
      if (!kinds.has(kind)) kinds.set(kind, []);
      if (number) kinds.get(kind).push(number);
    }
    const said = [...kinds].map(([kind, numbers]) =>
      numbers.length ? `${kind} ${andList(numbers)}` : kind,
    );
    return `${andList(said)} (${why})`;
  });
}

/**
 * **`plans`'s lines for what GitHub would not give**: the lists the last
 * `plans github` could not read, and the pull requests' checks the Stop
 * hook could not, each while it holds.
 */
export function unreadLines(seen = {}) {
  const out = [];
  if (seen.unread?.said?.length)
    out.push(
      `GitHub: the read at ${hhmm(seen.unread.at)} could not read ${seen.unread.said.join("; ")}; plans github reads again.`,
    );
  if (seen.checksUnread)
    out.push(
      `GitHub: the pull requests' checks could not be read at ${hhmm(seen.checksUnread.at)} (${seen.checksUnread.why}), so the Stop hook names no failed check; GH_TOKEN needs Checks and Commit statuses read.`,
    );
  return out;
}

/**
 * **A pull request's failed runs, as read** (decisions.md#github-webhook): from
 * `gh run list --branch <head>`, which needs the token's Actions read alone,
 * whatever set each run off. One `failed` item per row on the pull request's
 * head commit that has completed in a failing conclusion (`FAILED_CONCLUSIONS`)
 * and is `newer` than the last read; a run still going is read once it ends.
 * `at` is the row's `updatedAt`, as a delivery's `updated_at`, and the run and
 * attempt make the same `seen.runs` key, so a run both bring is told once.
 */
export function failedRunsOf(pull, base, runs = [], newer = () => true) {
  const items = [];
  for (const row of runs || []) {
    if (
      !row ||
      row.headSha !== pull.headRefOid ||
      row.status !== "completed" ||
      !FAILED_CONCLUSIONS.includes(row.conclusion) ||
      !newer(row.updatedAt)
    )
      continue;
    items.push({
      ...base,
      kind: "failed",
      author: "",
      text: "",
      url: row.url || "",
      workflow: row.workflowName || "",
      run: row.databaseId,
      attempt: row.attempt || 1,
      sha: String(pull.headRefOid || "").slice(0, 8),
      at: row.updatedAt,
    });
  }
  return items;
}

/**
 * **Who put a label on an issue, and when**, from its events (`gh api
 * .../issues/<n>/events`): the last `labeled` one with that label, `{ login,
 * at }`, both "" with none.
 */
function labeller(events, label) {
  const last = events.findLast((one) => one?.event === "labeled" && one.label?.name === label);
  return { login: last?.actor?.login || "", at: last?.created_at || "" };
}

/**
 * **`plans webhook`**: with `--serve`, the listener itself; with `--stop`,
 * the listener ended; else a listener started when none is alive. With no
 * secret, one line and nothing runs. The listener asks GitHub what its app
 * has and, while the app cannot send a failed run, reads them itself every
 * `every` milliseconds.
 */
export async function webhookCommand(
  args = [],
  env = process.env,
  { fetch = globalThis.fetch, every = APP_RECHECK, tell = MINUTE } = {},
) {
  if (args.includes("--stop")) {
    // A record whose port answers nothing is stale, its pid perhaps another
    // process's: nothing is killed, and the next start removes the record.
    const record = await webhookListening();
    if (!record) return { said: "The webhook: none was running.", status: 0 };
    if (!(await stopListener(record))) return { said: webhookLine(record), status: 1 };
    return { said: "The webhook: stopped.", status: 0 };
  }
  const webhookSecret = secret("WORKFLOW_WEBHOOK_SECRET", env);
  if (!webhookSecret) return { said: noSecretWords(env), status: 1 };
  const seen = readJson(files.webhook());
  const alive = await webhookListening();
  if (alive && !(await replaceOlder(alive))) return { said: webhookLine(alive), status: 0 };
  const port = webhookPort(env);
  if (!args.includes("--serve")) {
    // The listener writes its own record once it listens, so only the starter
    // removes a stale one: two starts racing never remove the winner's.
    spawnListener(seen, env);
    // Two seconds for it to answer; `sleep` blocks the loop a connect needs.
    const until = Date.now() + 2000;
    let up = null;
    while (!(up = await webhookListening()) && Date.now() < until)
      await new Promise((done) => setTimeout(done, 100));
    if (!up) return { said: `The webhook: none came up on ${port}.`, status: 1 };
    return { said: webhookLine(up), status: 0 };
  }
  mkdirSync(files.githubInbox(), { recursive: true });
  const record = { pid: process.pid, port, at: Date.now(), lastAt: 0, code: codeStamp() };
  // **The listener's history outlives its record**: the last delivery's time,
  // and when none listened, from the last listener's last sign of life to now.
  const last = readJson(files.webhookLast()) || {};
  record.lastAt = last.lastAt || 0;
  const since = last.aliveAt || last.lastAt || 0;
  if (since && record.at - since > LISTENER_GAP) record.down = { from: since, to: record.at };
  const markAlive = () =>
    writeJson(files.webhookLast(), { lastAt: record.lastAt, aliveAt: Date.now() });
  // **The handling runs in a child**, one at a time, so a start's wait never
  // keeps the server from answering GitHub within its ten seconds.
  let child = null;
  // What waits on the child: null, the inbox, or a whole read, which reads the
  // inbox too, so a timer's read that finds the child busy is not lost to it.
  let again = null;
  const run = (args) => {
    if (child) {
      again = args.length === 0 || again?.length === 0 ? [] : ["--inbox"];
      return;
    }
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), "github", ...args], {
      cwd: root,
      stdio: "ignore",
      env: { ...env, WORKFLOW_ROOT: root },
    });
    child.on("exit", () => {
      child = null;
      if (again) {
        const next = again;
        again = null;
        run(next);
      }
    });
  };
  const work = () => run(["--inbox"]);
  const server = listen({
    port,
    secret: webhookSecret,
    // Every verified delivery moves when GitHub last reached it; only one the
    // queue takes something from is written
    // (decisions.md#merge-refreshes-the-rest).
    heard: () => {
      record.lastAt = Date.now();
      writeJson(files.webhook(), record);
      markAlive();
    },
    keep: (id, event, body) => {
      writeFileSync(join(files.githubInbox(), `${id}.json`), JSON.stringify({ id, event, body }));
    },
    after: work,
  });
  // **What the app has**, asked of GitHub: "has", "lacks" (set on the record),
  // "unknown" when GitHub's answer or the record's write failed, the record's
  // `lacks` left as it was, and "none" with no app's id, key or repository
  // here. Never throws: the listener outlives a failed check.
  const check = async () => {
    try {
      const id = secret("WORKFLOW_APP_ID", env);
      const key = secret("WORKFLOW_APP_KEY", env);
      const repo = repoHere(spawnSync, env, false);
      if (!id || !key || !repo) return "none";
      const [owner, name] = repo.split("/");
      const lacks = appLacks(await appStanding({ owner, repo: name, id, key, fetch }));
      if (lacks) record.lacks = { ...lacks, repo };
      else {
        delete record.lacks;
        try {
          unlinkSync(files.webhookTold());
        } catch {
          // Never told.
        }
      }
      writeJson(files.webhook(), record);
      return lacks ? "lacks" : "has";
    } catch {
      return "unknown";
    }
  };
  server.on("listening", async () => {
    writeJson(files.webhook(), record);
    markAlive();
    // **Each minute**: the history's sign of life, and a note no open
    // assistant chat was sent yet sent again (decisions.md#note-sent-to-open-chat).
    // The sessions are read only while a note waits, and without blocking the
    // server; a child runs only when there is a chat to send it to.
    let reading = false;
    const minute = setInterval(async () => {
      try {
        markAlive();
      } catch {
        // A folder that cannot be written loses this minute's mark.
      }
      if (reading || child || !notesWaitingNow().length) return;
      const now = project(root);
      if (now.land !== "pull-request" || now.form === "compact") return;
      reading = true;
      const chat = assistantChat(await liveSessionsLater());
      reading = false;
      if (chat && notesUntold(chat.row.sessionId).length) run(["--inbox"]);
    }, tell);
    server.on("close", () => clearInterval(minute));
    // What a container that was down missed, once, as `plans github` reads it.
    run([]);
    const first = await check();
    if (first === "has" || first === "none") return;
    // **While the app cannot send a failed run, the listener reads them
    // itself**, asking GitHub again each time, so the read ends once it can:
    // also while what the app has is unknown, or its id, key or repository
    // cannot be read for a moment; one read more when it gains them, for a
    // run that failed since the last; and none once pull requests are off,
    // the project file read afresh.
    let checking = false;
    const timer = setInterval(async () => {
      if (checking) return;
      if (project(root).land !== "pull-request") return clearInterval(timer);
      checking = true;
      const standing = await check();
      checking = false;
      if (standing !== "has") return run([]);
      clearInterval(timer);
      run([]);
    }, every);
    server.on("close", () => clearInterval(timer));
  });
  server.on("error", () => process.exit(1));
  return { said: "", status: 0, server };
}

/**
 * The events the app is subscribed to, as `noAppWords` and `noSecretWords`
 * say them: "the events Issues, … and Workflow run", from the webhook's own
 * list.
 */
function eventsWords() {
  const labels = WEBHOOK_EVENTS.map((e) => e.label);
  return `the events ${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/** `plans gh`'s refusal with no app here. */
export function noAppWords(repo = "", env = process.env, project = proj().name) {
  return `The project's Claude has no GitHub App here: register one on GitHub (Settings, Developer settings, GitHub Apps; Issues, Pull requests and Actions read and write; ${eventsWords()}), install it on ${repo || "this repository"}, and ${setWhere("WORKFLOW_APP_ID and WORKFLOW_APP_KEY", env, project)}`;
}

/**
 * The repository `plans gh` acts on: the origin's address, else `gh repo
 * view` when `ask`; "" when neither says.
 */
function repoHere(run = spawnSync, env = process.env, ask = true) {
  const remote = run("git", ["remote", "get-url", "origin"], {
    cwd: root,
    encoding: "utf8",
    timeout: 4000,
  });
  const named = remote.status === 0 ? repoOfRemote(remote.stdout) : null;
  if (named || !ask) return named || "";
  const viewed = run(
    env.WORKFLOW_GH || "gh",
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    { cwd: root, encoding: "utf8", timeout: 10_000 },
  );
  return viewed.status === 0 ? String(viewed.stdout).trim() : "";
}

/**
 * **`plans gh <args...>`: `gh` as the project's own GitHub App**: `gh` run
 * with `GH_TOKEN` set to the app's installation token, its output the
 * terminal's, so the token is never printed. `gh pr ready` without `--undo`
 * is refused as the tool hook refuses it; with no app's id or key here, one
 * line says what to register and nothing runs. **A `pr` or `issue` call with
 * `--attach` uploads its pictures with the owner's own gh login**
 * (decisions.md#screenshots-attach), the one thing done under his name, a
 * stored image and never a post: each picture is sent first, in order, the
 * addresses GitHub answers are put in the text, and gh runs as the app
 * without the flag, the text as `--body`. A picture that does not go up posts
 * nothing and says why. `{ said, status }`, `said` the refusal, the cause or "".
 */
export async function ghCommand(
  args = [],
  {
    env = process.env,
    fetch = globalThis.fetch,
    run = spawnSync,
    repo = null,
    now = Date.now(),
    cacheFile = files.appToken(),
    cwd = process.cwd(),
  } = {},
) {
  const quoted = ["gh", ...args].map((word) => `'${String(word).replace(/'/g, "'\\''")}'`);
  if (marksReady(quoted.join(" "))) return { said: READY_REFUSED, status: 1 };
  const id = secret("WORKFLOW_APP_ID", env);
  const key = secret("WORKFLOW_APP_KEY", env);
  if (!id || !key) return { said: noAppWords(repo ?? repoHere(run, env, false), env), status: 1 };
  // Only a word gh reads as the flag counts, not `--attach` given as a body's text.
  const parsed = ["pr", "issue"].includes(String(args[0])) ? attachWords(args, { cwd }) : null;
  const words = parsed?.files.length ? parsed : null;
  if (words?.fault) return { said: notUploaded(words.fault), status: 1 };
  let owners = "";
  if (words) {
    owners = ownerToken({ env, run });
    if (!owners)
      return { said: notUploaded("gh has no login here to upload them with"), status: 1 };
  }
  const name = repo ?? repoHere(run, env);
  const [owner, repository] = name.split("/");
  if (!owner || !repository)
    return {
      said: "The project's Claude could not tell which GitHub repository this is: the origin names none, and gh repo view said nothing.",
      status: 1,
    };
  let token;
  try {
    token = await installationToken({
      owner,
      repo: repository,
      id,
      key,
      cacheFile,
      fetch,
      now,
    });
  } catch (error) {
    return {
      said: `The project's Claude could not get a token from GitHub: ${error.message}.`,
      status: 1,
    };
  }
  let ghArgs = args;
  if (words) {
    // The repository gh posts to: `-R` (its last two parts, as gh reads
    // `HOST/OWNER/REPO`), else an issue's or pull request's address among the
    // words, else `GH_REPO`, else the checkout's.
    const named = (value) => /([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(value || "").trim());
    const linked = words.rest
      .map((word) => /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/\d+/.exec(word))
      .find(Boolean);
    const [, targetOwner, targetRepo] = (words.repo && named(words.repo)) ||
      linked ||
      (env.GH_REPO && named(env.GH_REPO)) || [null, owner, repository];
    const target = `${targetOwner}/${targetRepo}`;
    let repositoryNumber;
    try {
      repositoryNumber = await repositoryId({ owner: targetOwner, repo: targetRepo, token, fetch });
    } catch (error) {
      return {
        said: notUploaded(`the id of ${target} could not be read (${error.message})`),
        status: 1,
      };
    }
    const sent = [];
    for (const file of words.files) {
      try {
        const url = await uploadAsset({
          file,
          repositoryId: repositoryNumber,
          token: owners,
          fetch,
        });
        sent.push({ ...file, url });
      } catch (error) {
        const refused = `GitHub refused ${file.given} with the login gh has here`;
        const cause =
          error.status === undefined
            ? `${file.given} could not be sent (${error.message})`
            : error.status === 404
              ? `${refused} (404: that login cannot push to ${target}, or the upload does not take its token)`
              : error.status === 401
                ? `${refused} (401: that login has ended)`
                : `${refused} (${error.status}: ${error.message || "no reason given"})`;
        return { said: notUploaded(cause), status: 1 };
      }
    }
    const { body } = words;
    const text = withAddresses(body.text, sent, body.dir, cwd);
    ghArgs = [
      ...words.rest.slice(0, body.at),
      "--body",
      text,
      ...words.rest.slice(body.at + body.count),
    ];
  }
  // Where it was run, so gh finds the branch and the relative paths it is
  // given.
  const done = run(env.WORKFLOW_GH || "gh", ghArgs, {
    cwd,
    stdio: "inherit",
    env: { ...env, GH_TOKEN: token },
  });
  if (done.error)
    return { said: `The project's Claude could not run gh: ${done.error.message}.`, status: 1 };
  return { said: "", status: done.status ?? 1 };
}

/**
 * **A heavy step takes a slot** (decisions.md#resource-slots): the project
 * file's `resources` says how many may run a named step at once, and `plans
 * hold <name> -- <command>` waits for a slot, oldest first, as Buildkite's
 * concurrency groups do, runs the command and frees the slot when it ends or
 * its process dies. A name the file does not give has one slot, as Jenkins
 * makes a resource a lock names. A ticket is `executor.wait.<name>.<pid>.json`,
 * a slot `executor.hold.<name>.<k>.json`, both in the checkout's `.claude/`,
 * so every worktree's executor shares them.
 */
const HOLD_POLL = 5000;
/** The default wait for a slot, in minutes, and the exit when none came (EX_TEMPFAIL). */
const HOLD_WAIT = 120;
const HOLD_GAVE_UP = 75;
/** A slot or ticket untouched this long, in ms, is no one's, its pid alive or not. */
const HOLD_STALE = 60_000;
const HOLD_FILE = /^executor\.(hold|wait)\.([a-z0-9-]+)\.([0-9]+)\.json$/;

const holdFiles = {
  guard: (name) => join(root, ".claude", `executor.hold.${name}.guard`),
  slot: (name, k) => join(root, ".claude", `executor.hold.${name}.${k}.json`),
  ticket: (name, pid) => join(root, ".claude", `executor.wait.${name}.${pid}.json`),
};

/** How many may hold a resource at once: the project file's number, else one. */
function slotsOf(name, resources = proj().resources) {
  return (Object.hasOwn(resources, name) && resources[name]) || 1;
}

/** Whether a process group lives: `plans hold` starts its command as one, so its children count. */
function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * Whether a slot or ticket is still someone's: its `plans hold` process alive
 * and its file touched within `HOLD_STALE` (a pid the system gave to another
 * process stops touching it), or the command it started still running.
 */
function heldAlive(one, touched) {
  if (!one?.pid) return false;
  if (one.group && groupAlive(one.group)) return true;
  return pidAlive(one.pid) && Date.now() - touched < HOLD_STALE;
}

/**
 * Every resource's slots taken and tickets waiting, oldest first, by name:
 * a Map of `{ slots: [{ k, pid, executor, at }], waiting: [{ pid, executor, at }] }`.
 * A file no one holds is left out, and removed when its resource is `drop`,
 * the one whose guard the caller holds.
 */
function holdsNow({ drop = "" } = {}) {
  const out = new Map();
  let names = [];
  try {
    names = readdirSync(join(root, ".claude"));
  } catch {
    return out;
  }
  for (const file of names) {
    const match = HOLD_FILE.exec(file);
    if (!match) continue;
    const [, kind, name, number] = match;
    const path = join(root, ".claude", file);
    const one = readJson(path);
    let touched = 0;
    try {
      touched = statSync(path).mtimeMs;
    } catch {
      // Gone since the listing.
    }
    if (!heldAlive(one, touched)) {
      if (name === drop && one)
        try {
          unlinkSync(path);
        } catch {
          // Removed by another waiter.
        }
      continue;
    }
    if (!out.has(name)) out.set(name, { slots: [], waiting: [] });
    if (kind === "hold") out.get(name).slots.push({ ...one, k: Number(number) });
    else out.get(name).waiting.push(one);
  }
  for (const one of out.values())
    for (const list of [one.slots, one.waiting]) list.sort((a, b) => a.at - b.at || a.pid - b.pid);
  return out;
}

/** "executor 2, since 11:02; pid 4242, since 11:03": who holds or waits, by number or pid. */
function holdersWords(holders) {
  return holders
    .map(
      (one) =>
        `${one.executor ? `executor ${one.executor}` : `pid ${one.pid}`}, since ${hhmm(one.at)}`,
    )
    .join("; ");
}

/** " (<holders>)", or "" for nobody. */
function inBrackets(holders) {
  return holders.length ? ` (${holdersWords(holders)})` : "";
}

/** `plans`'s line per resource in use or waited for. */
function resourceLines(holds = holdsNow()) {
  return [...holds]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, { slots, waiting }]) =>
        `${name}: ${slots.length} of ${slotsOf(name)} taken${inBrackets(slots)}, ${waiting.length} waiting${inBrackets(waiting)}`,
    );
}

/**
 * Takes a free slot of `name` for this process's ticket when as many slots
 * are free as there are tickets up to its own, oldest first, under the
 * resource's guard: the slot's number, or 0. A ticket dropped while this
 * process could not touch it (stopped, say) is written again with its time.
 */
function takeSlot(name, me) {
  const guard = holdFiles.guard(name);
  if (!takeHoldGuard(guard)) return 0;
  try {
    const ticket = holdFiles.ticket(name, me.pid);
    if (!existsSync(ticket)) writeJson(ticket, me);
    const { slots = [], waiting = [] } = holdsNow({ drop: name }).get(name) || {};
    // The number as the file says it now, not as it said when the wait began.
    const free = slotsOf(name, project(root).resources) - slots.length;
    const place = waiting.findIndex((one) => one.pid === me.pid);
    if (place < 0 || place >= free) return 0;
    const taken = new Set(slots.map((one) => one.k));
    let k = 1;
    while (taken.has(k)) k++;
    writeJson(holdFiles.slot(name, k), { ...me, at: Date.now() });
    unlinkSync(ticket);
    return k;
  } finally {
    try {
      if (readFileSync(guard, "utf8") === String(process.pid)) unlinkSync(guard);
    } catch {
      // Gone already.
    }
  }
}

/**
 * A resource's guard, created exclusively with this process's pid; waits up to
 * `wait` milliseconds, three seconds by default. Unlike the lock's guard it
 * never goes stale by age, only when the process that wrote it is gone, so a
 * waiter paused inside it keeps it.
 */
function takeHoldGuard(guard, wait = 3000) {
  const deadline = Date.now() + wait;
  for (;;) {
    try {
      writeFileSync(guard, String(process.pid), { flag: "wx" });
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    try {
      const pid = Number(readFileSync(guard, "utf8"));
      if (pid && !pidAlive(pid)) {
        unlinkSync(guard);
        continue;
      }
    } catch {
      // Released between the create and the look: try again.
      continue;
    }
    if (Date.now() > deadline) return false;
    sleep(25);
  }
}

/** Removes a file of this process's, unless another process's has replaced it. */
function dropOwn(path) {
  try {
    if (readJson(path)?.pid === process.pid) unlinkSync(path);
  } catch {
    // Gone already.
  }
}

/**
 * `plans hold <name> [--wait <minutes>] -- <command>`: the command's exit
 * code, 75 when no slot came free in the wait, 2 for a line it cannot read.
 * The queue's own lines go to stderr, so the command's output is its own.
 */
async function holdCommand(args) {
  const dash = args.indexOf("--");
  const before = dash < 0 ? args : args.slice(0, dash);
  const command = dash < 0 ? [] : args.slice(dash + 1);
  const at = before.indexOf("--wait");
  // An empty word is no number, though Number reads it as 0.
  const minutes = at < 0 ? HOLD_WAIT : before[at + 1]?.trim() ? Number(before[at + 1]) : NaN;
  const given = before.filter((_, i) => at < 0 || (i !== at && i !== at + 1));
  const flag = given.find((word) => word.startsWith("--"));
  const name = given[0];
  // A line it cannot read names what is wrong, as an unknown command does.
  // The wait before the name: a name taken for its value is not missing.
  const wrong = flag
    ? `unknown option "${flag}"`
    : !(Number.isFinite(minutes) && minutes >= 0)
      ? "plans hold --wait takes minutes, a number."
      : !RESOURCE_NAME.test(name || "")
        ? "plans hold needs a resource's name."
        : !command[0]
          ? "plans hold needs -- and the command to run."
          : given.length !== 1
            ? "plans hold takes one resource's name before --."
            : "";
  if (wrong) {
    refuse(wrong);
    return 2;
  }
  const say = (line) => process.stderr.write(`${line}\n`);
  const me = {
    pid: process.pid,
    executor: numberOf(process.cwd()) || Number(process.env.WORKFLOW_EXECUTOR) || 0,
    at: Date.now(),
  };
  const ticket = holdFiles.ticket(name, me.pid);
  let k = 0;
  const cleanup = () => {
    dropOwn(ticket);
    if (k) dropOwn(holdFiles.slot(name, k));
  };
  process.on("exit", cleanup);
  // **Alive is touched**: the ticket, then the slot, every third of the
  // staleness, so a pid the system hands on holds nothing for long.
  const touch = setInterval(() => {
    const path = k ? holdFiles.slot(name, k) : ticket;
    try {
      if (readJson(path)?.pid === process.pid) utimesSync(path, new Date(), new Date());
    } catch {
      // Dropped while stopped: the next look writes the ticket again.
    }
  }, HOLD_STALE / 3);
  touch.unref();
  let child = null;
  const numbered = (signal) => 128 + (constants.signals[signal] || 0);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, () => {
      // The command's whole group, so a shell's children stop too.
      if (child?.pid)
        try {
          process.kill(-child.pid, signal);
        } catch {
          // Ended already.
        }
      else {
        cleanup();
        process.exit(numbered(signal));
      }
    });
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeJson(ticket, me);
  k = takeSlot(name, me);
  const words = command.join(" ");
  if (!k) {
    const { slots = [], waiting = [] } = holdsNow().get(name) || {};
    const ahead = waiting.findIndex((one) => one.pid === me.pid);
    say(
      `Waiting for ${name}: ${slots.length} of ${slotsOf(name)} taken${inBrackets(slots)}, ${Math.max(0, ahead)} ahead.`,
    );
    const poll = Number(process.env.WORKFLOW_HOLD_POLL) || HOLD_POLL;
    const deadline = me.at + minutes * MINUTE;
    while (!k) {
      const left = deadline - Date.now();
      if (left <= 0) {
        cleanup();
        say(
          `No slot of ${name} came free in ${minutes} minutes${inBrackets(holdsNow().get(name)?.slots || [])}: nothing was run.`,
        );
        return HOLD_GAVE_UP;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(poll, left)));
      // A look that wakes past the wait takes nothing.
      if (Date.now() < deadline) k = takeSlot(name, me);
    }
    say(`${name} is free: running ${words}.`);
  }
  return new Promise((resolve) => {
    // One word may be a shell line (`plans hold browser -- "npm run e2e && npm run a11y"`).
    // Its own process group, signalled whole, and alive while any of it is.
    child = spawn(command[0], command.slice(1), {
      stdio: "inherit",
      shell: command.length === 1,
      detached: true,
    });
    // **The slot is the command's too**: killed alone, this process leaves
    // the command running, and the slot stays taken until it ends.
    const slot = holdFiles.slot(name, k);
    if (child.pid && readJson(slot)?.pid === process.pid)
      writeJson(slot, { ...readJson(slot), group: child.pid });
    child.on("error", (error) => {
      say(`${command[0]}: ${error.message}`);
      cleanup();
      resolve(127);
    });
    child.on("exit", (code, signal) => {
      cleanup();
      resolve(code ?? numbered(signal));
    });
  });
}

const USAGE = `plans                 the queue: briefs, asking, ready, building, built
plans --all           with the older plans listed by path
plans start [path]    start the lowest-numbered free executor on the next free plan, or this one
plans start --agent planner <brief>   start a planner on a brief
plans start --agent assistant   open the owner's assistant chat when none is open
plans start --agent assistant <plan>  open it on a built plan, or name the one open
plans start --owner-said "<words>" [path...]  start one more past a refusal that says the owner decides, on the owner's yes
plans first <path> [--undo]  put a waiting plan or brief first, on the owner's word, or take that back
plans topic <path>    say whether a plan's build opens its topic's pull request, or what it waits for
plans pause | resume  stop and restart starting sessions
plans end [id...] [--now]  end this queue's finished chats, or these; --now ends a named one whatever it is doing
plans sync            move a clean checkout with no commit of its own to the branch, detached
plans init            write .claude/workflow.md for this project
plans check           lint the catalogues and the deny key the project file names
plans hold <name> [--wait <minutes>] -- <command>   run a heavy step when a slot of <name> is free
plans cost [--since yyyy-mm-dd] [<folder>]  what this queue's sessions cost, by agent, from their transcripts
plans chat [--dry] [args...]  open the maker (compact) or the assistant here, with the project's mcp and inherits
plans gh <args...>    gh as the project's own GitHub App (WORKFLOW_APP_ID, WORKFLOW_APP_KEY)
plans webhook [--stop]  listen for the app's webhook on this container, or stop listening
plans github          read what GitHub has that the webhook missed, and act on it`;

/** A word `main` does not take: named on stderr, the usage after it, exit 2, stdout empty. */
function refuse(what) {
  process.stderr.write(`plans: ${what}\n${USAGE}\n`);
  process.exitCode = 2;
}

export function main(args = process.argv.slice(2)) {
  const [mode, ...rest] = args;
  // Only no word at all lists: an empty one (`plans "$step"`) is unknown.
  if (mode === undefined || mode === "list" || mode === "--all") {
    // The sweep needs every live session on the machine, any project's:
    // unread, nothing is removed.
    const live = liveSessions();
    if (liveAll) sweepTemp({ live: liveIds(liveAll) });
    process.stdout.write(`${list({ all: args.includes("--all"), live })}\n`);
    return;
  }
  if (mode === "init") {
    process.stdout.write(`${init(root)}\n`);
    return;
  }
  // **`plans cost`**.
  if (mode === "cost") {
    costCommand(rest);
    return;
  }
  if (mode === "check") {
    const written = proj().written.executors;
    const slots = proj().written.resources;
    const denied = [
      ...checkDeny(),
      ...(written !== undefined && executorsOf(written) !== Number(written)
        ? [`executors: ${written} is no whole number of 1 or more.`]
        : []),
      // A key with nothing under it names no resource.
      ...(slots === undefined || slots === "" || (Array.isArray(slots) && !slots.length)
        ? []
        : slots && typeof slots === "object" && !Array.isArray(slots)
          ? Object.entries(slots)
              .filter(([name]) => !(name in proj().resources))
              .map(([name, value]) =>
                RESOURCE_NAME.test(name)
                  ? `resources: ${name}: ${slotsWritten(value)} is no whole number of 1 or more.`
                  : `resources: ${name} is no name plans hold takes (a-z, 0-9 and -).`,
              )
          : [`resources: ${slotsWritten(slots)} is no map of names to whole numbers.`]),
    ];
    const { text, faults } = checkCatalogues(proj(), treeHere());
    process.stdout.write(`${[...denied, text].join("\n")}\n`);
    if (faults || denied.length) process.exitCode = 1;
    return;
  }
  if (mode === "chat") {
    const dry = rest.includes("--dry");
    const command = chatCommand(rest.filter((a) => a !== "--dry"));
    process.stdout.write(
      `${dry ? "Would run" : "Running"}: claude ${command.map((a) => JSON.stringify(a)).join(" ")}\n`,
    );
    if (!dry) {
      const done = spawnSync(claudeBin(), command, {
        cwd: root,
        stdio: "inherit",
        env: sessionEnv(),
      });
      process.exitCode = done.status ?? 1;
    }
    return;
  }
  if (mode === "webhook") {
    return webhookCommand(rest).then(({ said, status }) => {
      if (said) process.stdout.write(`${said}\n`);
      if (status) process.exitCode = status;
    });
  }
  if (mode === "github") {
    return githubCommand({ dry: rest.includes("--dry"), inbox: rest.includes("--inbox") }).then(
      (said) => process.stdout.write(`${said.join("\n")}\n`),
    );
  }
  if (mode === "gh") {
    return ghCommand(rest).then(({ said, status }) => {
      if (said) process.stderr.write(`${said}\n`);
      process.exitCode = status;
    });
  }
  if (mode === "end") {
    const at = rest.indexOf("--timer");
    if (at >= 0) {
      // The end timer: a wait, then the rule, with no output.
      const when = Number(rest[at + 1]);
      const sessionId = rest.filter((_, i) => i !== at && i !== at + 1)[0];
      setTimeout(
        () => {
          let handed = false;
          try {
            if (sessionId) handed = Boolean(endSession(sessionId).handed);
          } catch {
            // A timer that fails ends nothing: the supervisor's own clock remains.
          }
          // **The end timer is the queue's sweep**
          // (decisions.md#plans-reach-an-executor): plans ready and no executor
          // alive start one, unless the end handed a plan over and started one
          // already.
          try {
            if (!handed) startOnReady();
          } catch {
            // A start that fails leaves the plans to the next hook or timer.
          }
          // Fired, it is no timer of the session's any more, so its pid is not signalled.
          if (sessionId) clearEnd(sessionId);
        },
        Math.max(0, when - Date.now()),
      );
      return;
    }
    process.stdout.write(
      `${endCommand(
        rest.filter((a) => a !== "--now"),
        { immediate: rest.includes("--now") },
      )}\n`,
    );
    return;
  }
  // **`plans topic`** (decisions.md#topic-landing).
  if (mode === "topic") {
    const { said, status } = topicCommand(rest);
    process.stdout.write(`${said}\n`);
    if (status) process.exitCode = status;
    return;
  }
  // **`plans first`** (decisions.md#plan-put-first).
  if (mode === "first") {
    const { said, status } = firstCommand(rest);
    process.stdout.write(`${said}\n`);
    if (status) process.exitCode = status;
    return;
  }
  // **`plans hold`** (decisions.md#resource-slots).
  if (mode === "hold")
    return holdCommand(rest).then((code) => {
      process.exitCode = code;
    });
  if (["help", "--help", "-h"].includes(mode)) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  // **An unknown word fails**: a step written for a newer copy (`plans hold`,
  // say) must not pass on an older one having run nothing.
  if (!["sync", "pause", "resume", "start", ...HOOK_MODES].includes(mode))
    return refuse(`unknown command "${mode}"`);
  if (mode === "sync") {
    process.stdout.write(`${sync()}\n`);
    return;
  }
  if (mode === "pause") {
    // **A pause holds the deferred starts**: each timer is killed and its
    // deferral kept, with no timer, for the resume to re-arm.
    const held = [];
    for (const kind of QUEUE_KINDS) {
      const deferred = readJson(files.deferred(kind));
      if (!deferred) continue;
      if (deferred.pid) {
        killTimer(deferred.pid, START_TIMER);
        writeJson(files.deferred(kind), { ...deferred, pid: null });
      }
      held.push(deferredWords(deferred));
    }
    writeJson(files.pause(), {
      at: new Date().toString().slice(0, 21),
      by: process.env.CLAUDE_SESSION_ID || "",
    });
    process.stdout.write(
      `The queue is paused: no executor is started or handed plans until 'resume the queue' in any session.${held.length ? ` Held: ${held.join("; ")}.` : ""}\n`,
    );
    return;
  }
  if (mode === "resume") {
    try {
      unlinkSync(files.pause());
    } catch {
      // It was not paused.
    }
    const armed = [];
    for (const kind of QUEUE_KINDS) {
      const deferred = readJson(files.deferred(kind));
      if (!deferred) continue;
      // The leases' one timer, at the earliest of their own times.
      if (kind === "handed") {
        writeLeases(deferred.leases || {});
        armed.push(deferredWords(readJson(files.deferred(kind)) || deferred));
        continue;
      }
      // A timer at the later of its time and a minute from now.
      defer(
        deferred.until,
        deferred.why,
        deferred.paths || [],
        deferred.replace || "",
        agentOfDeferral(kind),
        kind,
        deferred.retired || "",
        deferred.said || "",
      );
      armed.push(deferredWords(readJson(files.deferred(kind)) || deferred));
    }
    process.stdout.write(
      `The queue is running again.${armed.length ? ` Re-armed: ${armed.join("; ")}.` : ""}\n`,
    );
    return;
  }
  if (mode === "start") {
    const paths = [];
    const options = {};
    let timer = 0;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--dry") options.dry = true;
      else if (rest[i] === "--agent") options.agent = rest[++i];
      else if (rest[i] === "--replace") options.replace = rest[++i];
      else if (rest[i] === "--timer") timer = Number(rest[++i]);
      else if (rest[i] === "--deferral") options.deferral = rest[++i];
      else if (rest[i] === "--owner-said") options.said = rest[++i] ?? "";
      // A flag it does not take, a mistyped --dry say, is refused before
      // anything is read or started, not taken for a plan's path.
      else if (rest[i].startsWith("--")) return refuse(`unknown option "${rest[i]}"`);
      else paths.push(rest[i]);
    }
    // An agent that is none of the three is refused, as an unknown subcommand is.
    // A value left out or empty is refused too, not taken for the executor.
    if ("agent" in options && !["executor", "planner", "assistant"].includes(options.agent))
      return refuse(`unknown agent "${options.agent ?? ""}"`);
    // **The owner's words, or nothing starts** (decisions.md#starts-bounded):
    // words left out, or a path (one with spaces too) or a flag taken for them.
    if ("said" in options) {
      const words = options.said.trim();
      if (
        !words ||
        words.startsWith("--") ||
        /^\S+\.md$/.test(words) ||
        /^(\.\/)?plans\/.*\.md$/.test(words)
      )
        return refuse(
          `plans start --owner-said needs what ${owner()} said, in quotes, before the path.`,
        );
    }
    if (timer) {
      // The deferred start: a wait and then the same start, nothing else. **A
      // timer clears only its own deferral**: one whose plans were all
      // decided or taken lost its file, and a newer deferral with another
      // timer may stand there now. **The leases' file stays**: the start
      // reads each lease's own time (decisions.md#brief-leased).
      setTimeout(
        () => {
          const file = files.deferred(
            options.deferral || (options.agent === "planner" ? "planner" : "executor"),
          );
          // A lease timer that fires takes its pid out of the table, so a
          // lease written while it starts a planner never kills it.
          if (options.deferral === "handed" && readJson(file)?.pid === process.pid)
            writeJson(file, { ...readJson(file), pid: null, firing: process.pid });
          else if (readJson(file)?.pid === process.pid)
            try {
              unlinkSync(file);
            } catch {
              // Cleared already.
            }
          start(paths, { ...options, timer: true });
        },
        Math.max(0, timer - Date.now()),
      );
      return;
    }
    process.stdout.write(`${start(paths, options)}\n`);
    return;
  }
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  try {
    hook(mode, input);
  } catch (error) {
    process.stderr.write(`plan-queue ${mode}: ${error.message}\n`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
