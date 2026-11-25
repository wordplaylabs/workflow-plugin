// The types of plan-queue.mjs's exports, for its tests: the hook stays plain
// JavaScript so Claude Code runs it with node and nothing else.
import type { Usage } from "./statusline.mjs";

export type PlanState = {
  state: "brief" | "planning" | "built" | "building" | "handed" | "ready" | "old";
  kind?: string;
  day?: string;
  date?: number;
  mtime?: number;
  sha?: string;
  builtDay?: string;
  session?: string;
  since?: string;
  stale?: boolean;
  asks?: boolean;
  resumed?: string[];
  stuck?: boolean;
  branch?: string;
  step?: string;
  /** A plan's `From` line: the project it came from and its checkout. */
  from?: { project: string; path: string } | null;
  /** A plan's `## For <Project>: plans/<topic>.md` sections. */
  carries?: { project: string; file: string }[];
  /** A waiting plan's or brief's `First` line (plans/priority-queue.md). */
  first?: First | null;
};
/** A `First: <date> <time>.` line, read (plans/priority-queue.md, part 1). */
export type First = { day: string; time: string; at: number };
/** A brief a built plan owes the project it came from (plans/project-follow-ups-reach-the-project.md). */
export type Carry = {
  path: string;
  project: string;
  file: string;
  checkout: string;
  missing: "" | "file" | "from";
};
/** A plan waiting for an executor, with what it shares with the chat in tokens. */
export type Waiting = { path: string; shared?: number; asks?: boolean; state?: string };
export type Handed = { path: string; stuck: boolean; resumed: string[] };
export type Run = { id: number; status: string; conclusion: string | null; onHead: boolean };
export type Lock = {
  sessionId: string;
  pid?: number | null;
  name?: string;
  taken?: number;
  released?: number | false;
};
export type StopDecision = {
  refuse?: true;
  reason?: string;
  runId?: number;
  told?: string[];
  retire?: true;
  /** Retired on plans it was named at a stop and left waiting. */
  declined?: true;
  paths?: string[];
  why?: string;
  handover?: Handed;
  context?: string;
  /** Why the session was kept, and for which plans. */
  kept?: Kept;
} | null;
/** Why a Stop hook kept a session, and the plans or brief it took. */
export type Kept = { paths: string[]; why: string };
/** One agent's ceiling while it has no history here (the project file's `reuse`), in tokens. */
export type Ceiling = number;
/** The project file's `reuse`, each agent's ceiling while it has no history here. */
export type Ceilings = { executor: Ceiling; planner: Ceiling };
/** One agent's sessions here, as `reuseInputs` measured them (cost.mjs's `inputsOf`). */
export type AgentInputs = { sessions: number; start: number; turns: number; model?: string };
/** What the ceiling is worked out from: each agent's measured sessions, and when and over how many transcripts. */
export type ReuseInputs = {
  executor?: AgentInputs;
  planner?: AgentInputs;
  assistant?: AgentInputs;
  measured?: { at: number; transcripts: number };
};
export type StartDecision = {
  start?: true;
  name?: string;
  note?: string;
  defer?: true;
  until?: number;
  refuse?: true;
  /** A live planner may take the brief: `why` is the line to say, `lease` the hand-off's deferral why. */
  wait?: true;
  lease?: string;
  /** The planner the brief is leased to, and whether it was sent the brief by message. */
  holder?: string;
  held?: boolean;
  why?: string;
  replace?: (Session & { why: string })[];
};

export function parseDay(text: string): number;
export function today(now?: number): string;
/** A plan's text without the queue's status sections (Planning, Building, Resumed, Handing over). */
export function withoutStatus(text: string): string;
/** Issues are on with an Issues heading and `land: pull-request`, the project file's by default. */
export function hasIssues(body?: string, land?: string): boolean;
/** The live id a Building or Planning line's `written` id names: itself, the one live id it begins at eight or more, or "". */
export function liveId(written: string, live: string[] | null): string;
/** Whether the id a line wrote, read with the sessions unread, is `sessionId`'s: the same, or a start of eight or more. */
export function sameSession(written?: string, sessionId?: string): boolean;
/** The Building line `sessionId` wrote, naming it whole or by a start of eight or more. */
export function buildingBy(sessionId: string): RegExp;
export function stateOf(
  text: string,
  options?: { mtime?: number; live?: string[] | null },
): PlanState | null;
export function pathsIn(text: string): string[];
/** Whether a session's working directory is this checkout, one of its worktrees, or under one. */
export function inThisRepo(cwd: string | undefined, paths: string[]): boolean;
/** The rows a project counts as its own: in its checkout or worktrees, or named by its lock or plans. */
export function ownRows<R extends { sessionId?: string; cwd?: string }>(
  rows: R[],
  options?: { paths?: string[]; lockIds?: string[]; named?: string[] },
): R[];
export function data(env?: Record<string, string | undefined>, scriptDir?: string): string;
export function owner(env?: Record<string, string | undefined>, settings?: string): string;
export function machine(
  env?: Record<string, string | undefined>,
  settings?: string,
): { name: string; set: boolean; rejected: string };
/** The deny key's faults, one line each, from the project's one parse. */
export function checkDeny(
  project?: {
    deny: Record<string, string[]>;
    written?: {
      deny?: unknown;
      unread?: { line: number; text: string; under: string | null; item: boolean }[];
    };
  },
  agents?: string[],
): string[];
/** A started chat's environment, without the root and the hook variables. */
export function sessionEnv(
  env?: Record<string, string | undefined>,
): Record<string, string | undefined>;
/** The line a plain chat that opened before its agent's setting says, for `assistant` or `maker`. */
export function agentLine(kind: string): string;
export type AppLacks = {
  where: "app" | "installation";
  what: string[];
  slug: string;
  url?: string;
  repo?: string;
};
export function appLine(lacks: AppLacks): string;
export type WebhookRecord = {
  pid: number;
  port: number | string;
  at: number;
  lastAt: number;
  lacks?: AppLacks;
};
export function webhookLine(record?: WebhookRecord | null): string;
export function webhookCommand(
  args?: string[],
  env?: Record<string, string | undefined>,
  options?: { fetch?: typeof fetch; every?: number },
): Promise<{ said: string; status: number; server?: import("node:http").Server }>;
export function takeLock(
  sessionId: string,
  live: LiveRow[] | null,
  options?: { path?: string; alive?: ((lock: Lock) => boolean) | null },
): boolean;
/** What `text`'s files share with a chat that holds `seen`, at most each file's size, in tokens. */
export function sharedTokens(
  text: string,
  seen?: Record<string, number>,
  options?: { checkout?: string },
): number;
export type LiveRow = {
  sessionId: string;
  id?: string;
  name?: string;
  status?: string;
  cwd?: string;
  kind?: string;
  pid?: number;
  waitingFor?: string;
  /**
   * `working`, `blocked`, `done`, `failed` or `stopped`, as `claude agents --json` gives it;
   * `blocked` is Claude Code's reading of the last turn's text or a prompt standing.
   */
  state?: string;
};
/** A row's status as `plans` says it: `waiting for input` only while a prompt stands, `not running` with no process. */
export function statusOf(row: LiveRow): string;
export type Tree = { path: string; branch: string };
/** A live executor or planner session, as its line and `canStart` see it. */
export type Session = {
  kind: "executor" | "planner" | "assistant";
  sessionId: string;
  id: string;
  name: string;
  status: string;
  where: string;
  branch: string;
  /** Its executor number, from its `executor-<n>` worktree; 0 for a chat in no such worktree. */
  number: number;
  retired: boolean;
  /** The plan an executor's Building line, or the brief a planner's Planning line, names. */
  on: string;
  /** A planner's plans, in the order it wrote them. */
  holds?: string[];
  /** Where each of a planner's plans stands: "ready, for the executor", "built", "gone". */
  standing?: Record<string, string>;
  /** When its end timer fires, if it is left quiet (ms); 0 with none. */
  endsAt?: number;
  /** Its context and the age of its last turn, from its transcript. */
  usage?: SessionUsage | null;
  /** Its agent's measured sessions here, which its ceiling is worked out from. */
  inputs?: ReuseInputs;
  /** The project file's ceiling, used while its agent has no history here. */
  fallback?: Ceiling;
  /** Why its Stop hook kept it for the work it took. */
  kept?: Kept | null;
  /** What it read or wrote of each file, in tokens, by its tool hook. */
  seen?: Record<string, number>;
  /** What the oldest waiting plan or brief shares with it, in tokens, and that work's path. */
  shared?: number;
  sharedWith?: string;
};
export function worktrees(): Tree[];
/** `<Project> <Kind> <n> (<machine>)`, the project and the machine optional. */
export function sessionName(
  kind: string,
  n: number,
  options?: { project?: string; machine?: string },
): string;
export function parseName(
  name: string,
): { project: string; kind: string; n: number; machine: string } | null;
export function isSession(
  kind: "executor" | "planner" | "assistant",
  row: LiveRow,
  state: { agent?: string } | null | undefined,
  locks?: Lock[],
): boolean;
export function sessionsOf(
  kind: "executor" | "planner" | "assistant",
  live: LiveRow[] | null,
  locks?: Lock[],
  options?: {
    trees?: Tree[];
    plans?: { state: string; session?: string; path: string }[];
    stateFor?: (
      sessionId: string,
    ) => { agent?: string; retired?: boolean; plans?: string[] } | null;
    seenFor?: (sessionId: string) => Record<string, number>;
    usageFor?: (row: LiveRow) => SessionUsage | null;
    fallback?: Ceiling;
    inputs?: ReuseInputs;
    checkout?: string;
  },
): Session[];
export function ceilingsLine(reuse?: Ceilings, inputs?: ReuseInputs): string;
export function lastFreshLines(
  log: { at: number; name: string; paths?: string[]; why?: string }[],
  project: string,
): string[];
/** How long a planner's question holds its plan from the executor ("Asked once"). */
export const ANSWER_WINDOW: number;
export type AskingOptions = {
  stateFor?: (sessionId: string) => {
    agent?: string;
    brief?: string;
    plans?: string[];
    /** Each plan's last question, by path. */
    asked?: Record<string, number>;
  } | null;
  now?: number;
};
export function askingIn(
  plan: { path: string; state?: string; asks?: boolean; mtime?: number } | null | undefined,
  live: LiveRow[] | null,
  options?: AskingOptions,
): { row: LiveRow; until: number } | null;
export function describeSession(one: Session): string;
/** A brief waiting for a planner, with what it shares with the chat in tokens. */
export type WaitingBrief = { path: string; shared?: number };
export function decidePlannerStop(facts: {
  current?: { path: string } | null;
  waiting?: WaitingBrief[];
  told?: string[];
  paused?: boolean;
  retired?: boolean;
  usage?: SessionUsage | null;
  inputs?: ReuseInputs;
  fallback?: Ceiling;
  now?: number;
}):
  | { retire: true; declined?: true; why?: string }
  | { refuse: true; told: string[]; reason: string; kept: Kept }
  | null;
export function tiredFor(
  state: { plans?: string[]; seen?: Record<string, number> },
  brief: string,
  options?: {
    usage?: SessionUsage | null;
    inputs?: ReuseInputs;
    fallback?: Ceiling;
    now?: number;
    textOf?: (path: string) => string;
    checkout?: string;
  },
): string;
export function plannerMayEdit(facts: {
  plans?: string[];
  toolName?: string;
  filePath?: string;
  base?: string;
}): boolean;
export function planTaken(text?: string): boolean;
export function whoTook(text?: string, live?: LiveRow[] | null): string;
export function plannerContext(
  state: { plans?: string[]; retired?: boolean } | null,
  live?: LiveRow[] | null,
  textOf?: (path: string) => string,
  options?: AskingOptions,
): string;
export type PlannerState = {
  agent?: string;
  retired?: boolean;
  brief?: string;
  plans?: string[];
  stopAsked?: number;
};
export function stopPlannersOn(
  path: string,
  live: LiveRow[] | null,
  options?: {
    stateFor?: (sessionId: string) => PlannerState | null;
    textOf?: (path: string) => string;
    stop?: (sessionId: string, live: LiveRow[] | null) => void;
    write?: (path: string, value: object) => void;
    now?: number;
  },
): void;
export function stopTakenPlanners(
  live: LiveRow[] | null,
  options?: {
    stateFor?: (sessionId: string) => PlannerState | null;
    textOf?: (path: string) => string;
    stop?: (sessionId: string, live: LiveRow[] | null) => void;
    write?: (path: string, value: object) => void;
    now?: number;
  },
): void;
export function stopRetiredPlanners(
  live: LiveRow[] | null,
  options?: {
    except?: string;
    stateFor?: (sessionId: string) => { agent?: string; retired?: boolean } | null;
    stop?: (sessionId: string, live: LiveRow[] | null) => void;
  },
): void;
export function plannerPrompt(path: string): string;
/** What the assistant chat is told of a built plan: `Built: <path>.` */
export function assistantPrompt(path: string): string;
/** The fresh assistant chat's prompt, on the hand-over file. */
export function takeOverPrompt(name: string): string;
/** An executor's start prompt: `Build <path>.`, or the resume of a handed plan. */
export function startPrompt(path: string, plans: { state: string; path: string }[]): string;
/** A plan's wait (plans/parallel-executors.md, part 3). */
export type WaitsOn = { path: string; why: string } | null;
export function freePlans<P extends { path: string; state: string; text?: string }>(
  plans: P[],
  options?: { claims?: Record<string, Claim> },
): (P & { waitsOn: WaitsOn })[];
/** A plan named to an executor and not yet taken. */
export type Claim = { holder: string; name?: string; at: number; until: number };
export function takerFor(
  plan: { path: string; state: string; tree?: string } | null,
  options: {
    executors?: number;
    sessions?: {
      number: number;
      status?: string;
      on?: string;
      retired?: boolean;
      sessionId: string;
    }[];
    claims?: Record<string, Claim>;
    trees?: number[] | null;
    from?: number;
  },
): { number: number; session: object | null } | null;
export function githubPrompt(path: string): string;
export const PLANNER_PROMPT: RegExp;
export function fromOf(text?: string): { project: string; path: string } | null;
export function firstOf(text?: string): First | null;
export function firstUnread(text?: string): boolean;
export function carriesOf(text?: string): { project: string; file: string }[];
export function carryOf(
  plans: { path: string; from?: PlanState["from"]; carries?: PlanState["carries"] }[],
  options?: { read?: (at: string) => string },
): Carry[];
export function versionLine(
  live: LiveRow[] | null,
  options?: { installed?: string; versionOf?: (pid?: number) => string },
): string;
export function sync(options?: { fetch?: boolean }): string;
export function agentEffort(agent: string, dir?: string): string;
export function start(
  paths: string[],
  options?: {
    replace?: string;
    dry?: boolean;
    agent?: string;
    at?: number;
    timer?: boolean;
    /** Why the session `replace` names was retired, for the starts log. */
    why?: string;
  },
): string;
export function list(options?: { all?: boolean; live?: LiveRow[] | null }): string;
export function lockHeldByOther(
  lock: Lock | null,
  sessionId: string,
  alive?: (pid?: number | null) => boolean,
): boolean;
export function allowedWhileLocked(command: string): boolean;
export function decideStop(facts: {
  waiting?: Waiting[];
  handed?: Handed[];
  run?: Run | null;
  told?: string[];
  paused?: boolean | string;
  retired?: boolean;
  current?: { path: string } | null;
  continuing?: boolean;
  refusedRun?: number | null;
  usage?: SessionUsage | null;
  inputs?: ReuseInputs;
  fallback?: Ceiling;
  now?: number;
  /** The briefs this session's built plans owe their projects. */
  carry?: Carry[];
}): StopDecision;
/** A session's context, its last turn's time and, when the transcript says it, its model. */
export type SessionUsage = { context: number; at: number; model?: string };
/** How long a reuse summary, and a background refresh's marker, holds. */
export const REUSE_REFRESH: number;
/** Starts `plans cost --summary` in the background unless a marker under an hour old stops it. */
export function refreshLater(
  file: string,
  options?: {
    now?: number;
    spawner?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => unknown;
    script?: string;
  },
): boolean;
/** `plans cost`: the report, or with `--summary` the reuse inputs refreshed alone. */
export function costCommand(
  rest?: string[],
  options?: {
    measureAll?: (dir: string, options: { since: string }) => unknown[];
    refreshInputs?: (options: { refresh: boolean; dir: string }) => Record<string, unknown>;
    write?: (text: string) => void;
  },
): void;
export function sessionUsage(transcriptPath: string): SessionUsage | null;
export function decideEnd(facts: {
  row: LiveRow | null;
  usage?: SessionUsage | null;
  on?: string;
  now?: number;
  force?: boolean;
}): { end: true } | { end: false; why: string };
/** How long a hook's `executor.starting` marker, left by a start still running or crashed, holds off another hook's. */
/** The line of an executor started on the ready plans when none is alive, else "" (the gate, the marker, a refusal or a deferral). */
export function transcriptOf(row: { cwd?: string; sessionId?: string }, projects?: string): string;
export function mayReuse(facts: {
  usage?: SessionUsage | null;
  /** What the work shares with the chat, in tokens. */
  shared?: number;
  inputs?: ReuseInputs;
  kind?: "executor" | "planner";
  model?: string;
  fallback?: Ceiling;
  now?: number;
}): { reuse: boolean; why: string };
export function usageWords(
  one: {
    kind?: string;
    usage?: SessionUsage | null;
    inputs?: ReuseInputs;
    fallback?: Ceiling;
    shared?: number;
    sharedWith?: string;
  },
  now?: number,
): string;
/** Removes the plugin's per-session temp files older than `age` whose session is not live; the count. */
export function sweepTemp(options?: {
  dir?: string;
  live?: string[];
  now?: number;
  age?: number;
}): number;
/** Each row with what the next waiting work shares with it: a handed plan first for an executor. */
export function withShare<R extends { sessionId: string; seen?: Record<string, number> }>(
  rows: R[],
  kind: string,
  plans: { path: string; state: string; text?: string; askingIn?: number }[],
  live: LiveRow[] | null,
  options?: { checkout?: string },
): (R & { shared?: number; sharedWith?: string })[];
export function canStart(facts: {
  kind?: "executor" | "planner" | "assistant";
  lock?: Lock | null;
  alive?: (pid?: number | null) => boolean;
  log?: { at: number; name: string }[];
  progressAt?: number;
  now?: number;
  paused?: boolean | string;
  usage?: Usage | null;
  sessions?: Session[];
  /** The brief a planner start was asked for, named in the message to send a live planner. */
  brief?: string;
  name?: string;
  fallback?: Ceiling;
  inputs?: ReuseInputs;
  taken?: string[];
  machine?: string;
  /** A timer's start: an idle session is replaced whatever its warmth. */
  unwatched?: boolean;
  /** This project's assistant chats open on this machine, by name: an assistant start is refused beside one. */
  open?: string[];
}): StartDecision;
/** A brief's lease (plans/brief-lease-per-brief.md): its own end, why, holder and whether it was sent by message. */
export type Lease = { until: number; why: string; holder: string; held: boolean };
/** The leases of `.claude/handed.deferred`, by brief; `{}` with no file. */
export function leases(): Record<string, Lease>;
/** Leases a brief, replacing its earlier lease, and arms the one timer at the earliest end. */
export function lease(
  path: string,
  options: { until: number; why: string; holder?: string; held?: boolean },
): void;
/** Ends the leases of `paths`; the file goes with the last. */
export function releaseLease(paths: string[]): void;
/** The briefs waiting, less those sent by message to another live, unretired planner. */
export function freeBriefs<P extends { path: string; state: string }>(
  plans: P[],
  options?: {
    live?: { sessionId: string; name?: string; kind?: string }[] | null;
    self?: string;
    replace?: string;
    table?: Record<string, Lease>;
    stateFor?: (sessionId: string) => { agent?: string; retired?: boolean } | null;
    now?: number;
  },
): P[];
export function cutoffEdit(
  text: string,
  options: { sessionId: string; branch: string; tree?: string; day?: string },
): string;
/** `plans end <id> --now`'s hand-over of the plan the ended session had under way. */
export function endedEdit(
  text: string,
  options: { sessionId: string; by: string; branch?: string; tree?: string; day?: string },
): string;
/** A start's hand-over of the plan of an executor it found with no process. */
export function goneEdit(
  text: string,
  options: { sessionId: string; branch?: string; tree?: string; day?: string },
): string;
export function readPlans(
  dir?: string,
  live?: string[] | null,
  texts?: Record<string, string>,
): (PlanState & { path: string; file: string; text: string })[];
/** The assistant's log of the decisions executors took for the owner; never a plan. */
export const TAKEN_LOG: string;
/** An assistant's progress: the newest brief or waiting plan, or the log's last write. */
export function writtenAt(plans: { state: string; mtime?: number }[], log?: string): number;
/** The `plans/*.md` the queue cannot read: no header and no brief line, or no read at all. */
export function unreadPlans(dir?: string): { headless: string[]; failed: string[] };
export function resetTime(usage: Partial<Usage> | null, transcriptText?: string): number;
