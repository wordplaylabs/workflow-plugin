// **What people write on GitHub reaches the queue on its own**
// (plans/github-watched.md): the app's webhook posts each event to `plans
// webhook` on the container, which checks its signature, keeps it in
// `.claude/github-inbox/`, and turns it into the queue's events; `plans
// github` reads what a container that was down missed, into the same
// events. This file is the pure part and the listener; what is done with
// an event is `plan-queue.mjs`'s. `node:` modules only.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

/**
 * **A delivery is GitHub's when its signature says so** (GitHub's
 * "Validating webhook deliveries"): `X-Hub-Signature-256` is `sha256=` and
 * the HMAC SHA-256 of the raw body under the secret, in hex, compared in
 * constant time. A missing header, a legacy `sha1=` one or no secret is no.
 */
export function verifyDelivery(secret, rawBody, signatureHeader) {
  if (!secret || typeof signatureHeader !== "string" || !signatureHeader.startsWith("sha256="))
    return false;
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
  );
  const given = Buffer.from(signatureHeader);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The labels of an issue or a pull request, by name. */
export const labelsOf = (thing) =>
  (thing?.labels || []).map((label) => label?.name || label).filter(Boolean);

/**
 * **The events the webhook reads**, `event` as GitHub sends it in
 * `X-GitHub-Event` and `label` as the app's settings name it, in the order
 * the lines that set up the app give them: `noAppWords` and `noSecretWords`
 * build their list from this, and a test ties it to `itemsOfDelivery`'s
 * branches (plans/webhook-events-from-the-parser.md).
 */
export const WEBHOOK_EVENTS = Object.freeze([
  { event: "issues", label: "Issues" },
  { event: "issue_comment", label: "Issue comment" },
  { event: "pull_request", label: "Pull request" },
  { event: "pull_request_review", label: "Pull request review" },
  { event: "pull_request_review_comment", label: "Pull request review comment" },
  { event: "workflow_run", label: "Workflow run" },
]);

/**
 * **A delivery as the queue's items**, one shape for a delivery and for
 * `plans github`'s read: `{ deliveryId, kind, number, title, labels,
 * author, at, text, url, merged, pull, label, head }`, `kind` one of `opened`
 * (an issue), `labeled`, `comment`, `review`, `closed` (a pull request) and
 * `failed` (a run that failed on a pull request, with `workflow`, `run` and
 * `sha`), `pull` true on a pull request; a `closed` one has `base` too. An event the queue takes nothing
 * from is no item.
 */
export function itemsOfDelivery(event, payload = {}, deliveryId = "") {
  const issue = payload.issue;
  const pr = payload.pull_request;
  const base = (thing, pull) => ({
    deliveryId,
    number: thing?.number || 0,
    title: thing?.title || "",
    labels: labelsOf(thing),
    url: thing?.html_url || "",
    pull,
  });
  if (event === "issues" && issue && !issue.pull_request) {
    if (payload.action === "opened")
      return [
        {
          ...base(issue, false),
          kind: "opened",
          author: issue.user?.login || "",
          at: issue.created_at || "",
          text: issue.body || "",
        },
      ];
    if (payload.action === "labeled")
      return [
        {
          ...base(issue, false),
          kind: "labeled",
          label: payload.label?.name || "",
          author: payload.sender?.login || "",
          at: issue.updated_at || "",
          text: "",
        },
      ];
    return [];
  }
  if (event === "issue_comment" && payload.action === "created" && issue)
    return [
      {
        ...base(issue, Boolean(issue.pull_request)),
        kind: "comment",
        author: payload.comment?.user?.login || "",
        at: payload.comment?.created_at || "",
        text: payload.comment?.body || "",
        url: payload.comment?.html_url || issue.html_url || "",
      },
    ];
  if (
    (event === "pull_request_review" && payload.action === "submitted") ||
    (event === "pull_request_review_comment" && payload.action === "created")
  ) {
    const said = payload.review || payload.comment || {};
    return [
      {
        ...base(pr, true),
        head: pr?.head?.ref || "",
        kind: "review",
        author: said.user?.login || "",
        at: said.submitted_at || said.created_at || "",
        text: said.body || "",
        url: said.html_url || pr?.html_url || "",
      },
    ];
  }
  // **A failed run is an item** (plans/executor-never-watches-ci.md, part 1):
  // `completed` comes whatever the outcome, so only the failing conclusions,
  // on a branch of this repository, a fork's branch may share a name.
  // Whatever set it off, a push to the branch as much as the pull request: a
  // run is judged by its pull request, in `githubEvents`, and one on a branch
  // with no pull request of the queue's own is no event
  // (plans/failed-runs-the-webhook-misses.md, part 1).
  if (event === "workflow_run" && payload.action === "completed") {
    const run = payload.workflow_run;
    if (
      !run ||
      !FAILED_CONCLUSIONS.includes(run.conclusion) ||
      !run.head_repository?.full_name ||
      run.head_repository.full_name !== payload.repository?.full_name
    )
      return [];
    return [
      {
        deliveryId,
        kind: "failed",
        pull: true,
        // Empty on some runs: the queue fills it from the head branch.
        number: run.pull_requests?.[0]?.number || 0,
        head: run.head_branch || "",
        title: run.display_title || "",
        labels: [],
        url: run.html_url || "",
        at: run.updated_at || "",
        text: "",
        author: run.triggering_actor?.login || run.actor?.login || "",
        workflow: run.name || "",
        run: run.id,
        attempt: run.run_attempt || 1,
        sha: String(run.head_sha || "").slice(0, 8),
      },
    ];
  }
  if (event === "pull_request" && payload.action === "closed" && pr)
    return [
      {
        ...base(pr, true),
        head: pr.head?.ref || "",
        base: pr.base?.ref || "",
        kind: "closed",
        merged: Boolean(pr.merged),
        author: payload.sender?.login || "",
        at: pr.merged_at || pr.closed_at || "",
        text: pr.body || "",
      },
    ];
  return [];
}

/**
 * **The conclusions that make a check failed**, in the webhook and the Stop
 * hook alike (plans/failed-runs-the-webhook-misses.md, part 3): `cancelled`
 * was superseded by a later push or stopped by a person, `action_required`
 * waits on a person, on the pull request's page, and only GitHub sets
 * `stale`; none is anybody's to fix.
 */
export const FAILED_CONCLUSIONS = ["failure", "timed_out", "startup_failure"];

/**
 * **Whether a delivery is kept** (plans/merged-pr-refreshes-the-rest.md,
 * part 3): only an event the webhook reads, whose body is JSON and makes an
 * item; an event the queue takes nothing from (Workflow job, a run not yet
 * completed, a pull request pushed to) is answered and not kept.
 */
export function keeps(event, rawBody) {
  if (!WEBHOOK_EVENTS.some((one) => one.event === event)) return false;
  try {
    // A body of `null` or a shape the parser trips on is kept nothing of, and
    // never stops the listener (/code-review).
    return itemsOfDelivery(event, JSON.parse(rawBody) || {}).length > 0;
  } catch {
    return false;
  }
}

/** The issue a pull request is for, from its `For #<n>.` line; 0 with none. */
export function forOf(text = "") {
  return Number(/^For #(\d+)\.?[ \t]*$/m.exec(text)?.[1] || 0);
}

/** An empty seen file. */
export const NOTHING_SEEN = Object.freeze({
  deliveries: [],
  issues: {},
  pulls: {},
  permissions: {},
  labeled: [],
  runs: [],
  merges: [],
  readAt: "",
});

/** Deliveries kept to tell a redelivery, newest last. */
const DELIVERIES_KEPT = 500;

/**
 * **The queue's events from GitHub's items** (plans/github-watched.md, part
 * 2), pure: `{ events, seen }`, each event `{ kind, number, by, at, text,
 * url, title, permission, pull }`, in the items' order. `context` says
 * what the checkout's plans hold: `carried` (the issues a plan or a brief
 * carries), `planned` (a planned plan's issues), `own` (the queue's own
 * pull requests), `slug` (the app's) and `issuesOff` (every delivery is
 * marked seen, and only failed runs and merges are events). Kinds: `issue` (an issue opened,
 * unlabelled), `plan` (`status: planning` set on an issue nothing carries),
 * `mention` (`@<slug>` in a comment), `comment` (on an issue a plan
 * carries), `review` (a review, a review comment or a comment on the
 * queue's own pull request), `ready` (`status: ready` on a planned plan's
 * issue), `merged` (a pull request merged, told once by its number, `issue`
 * its `For #<n>` line's or 0 with issues off, with `base` and `head`; nobody
 * is gated, since only a person with write access merges), `failed` (a run that
 * failed on the queue's own pull request, `by` its workflow, with `run` and
 * `sha`). A reader's item, one whose author's permission is not write or
 * admin in `seen.permissions`, and the app's own are never events, but a
 * failed run is nobody's writing and is judged by its pull request alone; a
 * delivery seen is skipped, and so is an item from a read no newer than what
 * was seen of its issue.
 */
export function githubEvents(seen = NOTHING_SEEN, items = [], context = {}) {
  const carried = new Set(context.carried || []);
  const planned = new Set(context.planned || []);
  const own = new Set(context.own || []);
  const slug = context.slug || "";
  const next = {
    ...NOTHING_SEEN,
    ...seen,
    deliveries: [...(seen.deliveries || [])],
    issues: { ...(seen.issues || {}) },
    pulls: { ...(seen.pulls || {}) },
    permissions: { ...(seen.permissions || {}) },
    labeled: [...(seen.labeled || [])],
    runs: [...(seen.runs || [])],
    merges: [...(seen.merges || [])],
  };
  const events = [];
  for (const item of items) {
    if (item.deliveryId) {
      if (next.deliveries.includes(item.deliveryId)) continue;
      next.deliveries.push(item.deliveryId);
    }
    const merge = item.kind === "closed" && item.merged;
    // With issues off, a delivery is still marked seen, so turning issues on
    // later replays none of it (/code-review); a failed run and a merge are
    // events either way (plans/merged-pr-refreshes-the-rest.md, part 1).
    if (context.issuesOff && item.kind !== "failed" && !merge) continue;
    if (item.kind === "failed") {
      // **A run is told once, by its id and attempt**, whether a delivery or
      // a read brought it, and touches no pull request's time, so no comment
      // and no other run of the same second is hidden by it (Codex,
      // /code-review). The app's own pull request is set off by the app: no
      // author gate; one whose number is unknown is nobody's.
      const key = `${item.run}:${item.attempt || 1}`;
      if (next.runs.includes(key) || !item.number) continue;
      if (!own.has(item.number) && !(item.head && own.has(item.head))) continue;
      next.runs.push(key);
      events.push({
        kind: "failed",
        number: item.number,
        by: item.workflow || "",
        at: item.at || "",
        text: "",
        url: item.url || "",
        title: item.title || "",
        run: item.run,
        sha: item.sha || "",
      });
      continue;
    }
    if (merge) {
      // **A merge is told once, by its number**, whether a delivery or a read
      // brought it, and passes no author gate; before the read's time gate, so
      // a comment seen after it does not hide a merge the webhook missed (Codex).
      if (item.at && (!next.pulls[item.number] || item.at > next.pulls[item.number]))
        next.pulls[item.number] = item.at;
      if (next.merges.includes(item.number)) continue;
      next.merges.push(item.number);
      events.push({
        kind: "merged",
        number: item.number,
        issue: context.issuesOff ? 0 : forOf(item.text),
        base: item.base || "",
        head: item.head || "",
        by: item.author || "",
        at: item.at || "",
        url: item.url || "",
        title: item.title || "",
        text: "",
      });
      continue;
    }
    if (!item.deliveryId) {
      // A read's item: only what is newer than this issue's last item seen.
      const map = item.pull ? next.pulls : next.issues;
      const last = map[item.number];
      if (last && item.at && item.at <= last) continue;
    }
    const map = item.pull ? next.pulls : next.issues;
    if (item.at && (!map[item.number] || item.at > map[item.number])) map[item.number] = item.at;
    const author = item.author || "";
    if (!author || (slug && author === `${slug}[bot]`)) continue;
    const permission = next.permissions[author];
    if (permission !== "write" && permission !== "admin") continue;
    const event = (kind, extra = {}) =>
      events.push({
        kind,
        number: item.number,
        by: author,
        at: item.at || "",
        text: item.text || "",
        url: item.url || "",
        title: item.title || "",
        permission,
        ...extra,
      });
    const mentions = slug && new RegExp(`(^|[^\\w-])@${slug}\\b`, "i").test(item.text || "");
    const ours = own.has(item.number) || Boolean(item.head && own.has(item.head));
    if (item.kind === "opened") {
      // An issue opened with a label is labelled too, and that item is the one that counts.
      if (!item.labels?.length) event("issue");
    } else if (item.kind === "labeled") {
      const key = `${item.number}:${item.label}`;
      const once = () => {
        if (!next.labeled.includes(key)) next.labeled.push(key);
      };
      if (item.label === "status: planning" && !carried.has(item.number)) {
        once();
        event("plan");
      } else if (item.label === "status: ready" && planned.has(item.number)) {
        once();
        event("ready");
      }
    } else if (item.kind === "comment") {
      if (mentions) event("mention");
      else if (item.pull ? ours : carried.has(item.number)) event(item.pull ? "review" : "comment");
    } else if (item.kind === "review") {
      if (ours) event(mentions ? "mention" : "review");
    }
  }
  next.deliveries = next.deliveries.slice(-DELIVERIES_KEPT);
  next.runs = next.runs.slice(-DELIVERIES_KEPT);
  next.merges = next.merges.slice(-DELIVERIES_KEPT);
  return { events, seen: next };
}

const MONTHS =
  "January February March April May June July August September October November December".split(
    " ",
  );

/** "3 November 2026 21:58", as the note writes a time. */
export function noteTime(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${hh}:${mm}`;
}

/**
 * **An event as its note** (plans/github-watched.md, part 3): the heading
 * when the note is new (`first`), then a line of the event and its text
 * as written, indented four spaces.
 */
export function noteFor(event, { first = false } = {}) {
  const head = first ? `# GitHub #${event.number}: ${event.title}\n\n` : "";
  const text = (event.text || "")
    .split("\n")
    .map((line) => (line.trim() ? `    ${line}` : ""))
    .join("\n")
    .replace(/\n+$/, "");
  // A failed run's line names its workflow, run and commit; nobody wrote it.
  if (event.kind === "failed")
    return `${head}failed, ${noteTime(event.at)}, ${event.by} run ${event.run} on ${event.sha}: ${event.url}\n\n`;
  // A merge's line names the base and who merged; under it, what it left behind
  // (plans/merged-pr-refreshes-the-rest.md, part 2).
  if (event.kind === "merged") {
    const behind = event.behind || {};
    const pulls = (list, login = false) =>
      list.map((one) => `#${one.number} ${one.head}${login ? ` (${one.login})` : ""}`).join(", ");
    const lines = behind.unread
      ? ["    behind: not read"]
      : [
          behind.own?.length ? `    behind: ${pulls(behind.own)}` : "",
          behind.stacked?.length ? `    stacked on it: ${pulls(behind.stacked)}` : "",
          behind.theirs?.length ? `    another person's, left: ${pulls(behind.theirs, true)}` : "",
        ].filter(Boolean);
    return `${head}merged, ${noteTime(event.at)}, into ${event.base} by ${event.by}: ${event.url}\n${lines.map((line) => `${line}\n`).join("")}\n`;
  }
  return `${head}${event.kind}, ${noteTime(event.at)}, by ${event.by} (${event.permission}): ${event.url}\n${text ? `${text}\n` : ""}\n`;
}

/**
 * **The listener** (plans/github-watched.md, part 1): every verified POST
 * is `heard()`, kept by `keep(id, event, rawBody)` when the queue takes
 * something from it (`keeps`), and answered 202 before `after()` runs the
 * work, GitHub wanting an answer within ten seconds; one it takes nothing
 * from is answered 202 with nothing kept and no work
 * (plans/merged-pr-refreshes-the-rest.md, part 3); an unverified one is
 * answered 401 with nothing kept, anything but a POST 405. The server,
 * listening on `port`.
 */
export function listen({ port, secret, keep, heard = () => {}, after = () => {} }) {
  const server = createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      // GitHub caps a payload at 25 MB.
      if (size > 26_000_000) request.destroy();
      else chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (!verifyDelivery(secret, raw, request.headers["x-hub-signature-256"])) {
        response.writeHead(401).end();
        return;
      }
      const id = String(request.headers["x-github-delivery"] || "").replace(/[^\w-]/g, "");
      const event = String(request.headers["x-github-event"] || "");
      const body = raw.toString("utf8");
      const kept = keeps(event, body);
      try {
        heard();
        if (kept) keep(id || `local-${Date.now()}`, event, body);
      } catch {
        response.writeHead(500).end();
        return;
      }
      response.writeHead(202).end();
      if (kept) setImmediate(after);
    });
  });
  server.listen(port);
  return server;
}
