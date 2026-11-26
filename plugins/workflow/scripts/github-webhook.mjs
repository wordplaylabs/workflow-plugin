// **What people write on GitHub reaches the queue on its own**
// (decisions.md#github-webhook): the app's webhook posts each event to
// `plans webhook` on the container, which checks its signature, keeps it
// in `.claude/github-inbox/`, and turns it into the queue's events;
// `plans github` reads what a container that was down missed, into the
// same events. This file is the pure part and the listener; what is done
// with an event is `plan-queue.mjs`'s. `node:` modules only.
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
 * branches.
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
 * author, at, text, url, merged, pull, label, head, id }`, `id` GitHub's
 * `node_id` of a comment, a review or an inline comment, `kind` one of `opened`
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
        id: payload.comment?.node_id || "",
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
        id: said.node_id || "",
        author: said.user?.login || "",
        at: said.submitted_at || said.created_at || "",
        text: said.body || "",
        url: said.html_url || pr?.html_url || "",
      },
    ];
  }
  // **A failed run is an item** (decisions.md#github-webhook): `completed`
  // comes whatever the outcome, so only the failing conclusions, on a branch
  // of this repository, a fork's branch may share a name. Whatever set it
  // off, a push to the branch as much as the pull request: a run is judged by
  // its pull request, in `githubEvents`, and one on a branch with no pull
  // request of the queue's own is no event (decisions.md#github-webhook).
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
 * hook alike (decisions.md#github-webhook): `cancelled` was superseded by a
 * later push or stopped by a person, `action_required` waits on a person,
 * on the pull request's page, and only GitHub sets `stale`; none is
 * anybody's to fix.
 */
export const FAILED_CONCLUSIONS = ["failure", "timed_out", "startup_failure"];

/**
 * **Whether a delivery is kept** (decisions.md#merge-refreshes-the-rest):
 * only an event the webhook reads, whose body is JSON and makes an item; an
 * event the queue takes nothing from (Workflow job, a run not yet
 * completed, a pull request pushed to) is answered and not kept.
 */
export function keeps(event, rawBody) {
  if (!WEBHOOK_EVENTS.some((one) => one.event === event)) return false;
  try {
    // A body of `null` or a shape the parser trips on is kept nothing of, and
    // never stops the listener.
    return itemsOfDelivery(event, JSON.parse(rawBody) || {}).length > 0;
  } catch {
    return false;
  }
}

/**
 * **The issues a pull request closes** (decisions.md#closes-its-issues): the
 * numbers of the whole `Closes #<n>.` lines and of an older `For #<n>.` line
 * above the description's first `## ` heading, where the template puts them,
 * outside a fenced block or an HTML comment, the full stop optional, in order,
 * each once; `[]` with none. Lines end in `\n`, `\r\n` or `\r`. A comment
 * (`<!--` to `-->`, `<!-->` and `<!--->` empty ones, on one line or over
 * several) is read as nothing, a `## ` in it included, and a line holding one
 * is read with it taken out; a `<!--` in a code span, in indented code or on a
 * fence's line opens none.
 */
export function closesOf(text = "") {
  const numbers = [];
  let fence = "";
  let comment = false;
  for (const raw of String(text).split(/\r\n?|\n/)) {
    const mark = comment ? "" : /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
    if (fence) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = "";
      continue;
    }
    if (mark) {
      fence = mark;
      continue;
    }
    const line = comment || !/^(?: {4}|\t)/.test(raw) ? uncommented(raw) : raw;
    if (/^## /.test(line)) break;
    const m = /^(?:Closes|For) #(\d+)\.?[ \t]*$/.exec(line);
    if (m && !numbers.includes(Number(m[1]))) numbers.push(Number(m[1]));
  }
  return numbers;

  // The line with its comments taken out, `comment` left open when one runs on.
  function uncommented(raw) {
    let line = "";
    let rest = raw;
    while (rest) {
      if (comment) {
        const end = rest.indexOf("-->");
        if (end < 0) break;
        comment = false;
        rest = rest.slice(end + 3);
        continue;
      }
      // Code spans are blanked to their length, so a `<!--` in one is found nowhere.
      const masked = rest.replace(/(?<!`)(`+)(?!`)[^]*?(?<!`)\1(?!`)/g, (span) =>
        " ".repeat(span.length),
      );
      const start = masked.indexOf("<!--");
      if (start < 0) {
        line += rest;
        break;
      }
      line += rest.slice(0, start);
      rest = rest.slice(start + 4);
      const empty = /^-?>/.exec(rest);
      if (empty) rest = rest.slice(empty[0].length);
      else comment = true;
    }
    return line;
  }
}

/**
 * An empty seen file; `items` holds GitHub's ids of the comments and reviews
 * seen, and `opened:<n>` for an issue's opening, newest last; `labeledAt` the
 * time each `labeled` key was last told.
 */
export const NOTHING_SEEN = Object.freeze({
  deliveries: [],
  items: [],
  permissions: {},
  labeled: [],
  labeledAt: {},
  runs: [],
  merges: [],
  readAt: "",
});

/** Deliveries kept to tell a redelivery, newest last. */
const DELIVERIES_KEPT = 500;

/**
 * Comments, reviews and openings kept by id, newest last: every one seen
 * since the last read's line, which can be weeks old; past that, a read may
 * note the oldest again.
 */
const ITEMS_KEPT = 5000;

/**
 * **The queue's events from GitHub's items** (decisions.md#github-webhook),
 * pure: `{ events, seen, unjudged }`, each event `{ kind, number, by, at, text, url,
 * title, permission, pull }`, in the items' order. `context` says what the
 * checkout's plans hold: `carried` (the issues a plan or a brief carries),
 * `planned` (a planned plan's issues), `own` (the queue's own pull requests),
 * `slug` (the app's), `people` (the logins the project file's **People**
 * gives, lower-cased) and `issuesOff` (every delivery is marked seen, and only
 * failed runs and merges are events). A comment from a person `people` names
 * is an event on any issue and any pull request, a review or an inline
 * comment of theirs when it has words; another writer's only where it
 * mentions the app, on an issue a plan carries or on the queue's own pull
 * request (decisions.md#people-act-on-github). Kinds: `issue` (an issue opened,
 * unlabelled), `plan` (`status: planning` set on an issue nothing carries),
 * `mention` (`@<slug>` in a comment), `comment` (on an issue), `review` (on a
 * pull request), `ready` (`status: ready` on a planned plan's issue), `merged` (a
 * pull request merged, told once by its number, `issues` the ones its
 * description closes, by `closesOf`, whoever wrote it, or `[]` with issues
 * off, with `base` and `head`; nobody is gated, since only a person with write access merges),
 * `failed` (a run that failed on the queue's
 * own pull request, `by` its workflow, with `run` and `sha`). A reader's item,
 * one whose author's permission is not write or admin in `seen.permissions`,
 * and the app's own are never events, but a failed run is nobody's writing and
 * is judged by its pull request alone; a delivery seen is skipped, and so is a
 * comment, a review or an issue's opening seen before, by GitHub's id of it
 * (`seen.items`), whichever of a delivery and a read brought it first. An
 * item whose author's permission is unknown, not a key of
 * `seen.permissions` and not a bot's, is left unseen, its delivery too, so
 * the next read judges it: `unjudged` names those authors, once each. A
 * label is told again when put on after it was last told: `seen.labeledAt`
 * keeps when.
 */
export function githubEvents(seen = NOTHING_SEEN, items = [], context = {}) {
  const carried = new Set(context.carried || []);
  const planned = new Set(context.planned || []);
  const own = new Set(context.own || []);
  const people = new Set((context.people || []).map((login) => login.toLowerCase()));
  const slug = context.slug || "";
  const next = {
    ...NOTHING_SEEN,
    ...seen,
    deliveries: [...(seen.deliveries || [])],
    items: [...(seen.items || [])],
    permissions: { ...(seen.permissions || {}) },
    labeled: [...(seen.labeled || [])],
    labeledAt: { ...(seen.labeledAt || {}) },
    runs: [...(seen.runs || [])],
    merges: [...(seen.merges || [])],
  };
  const known = new Set(next.items);
  const events = [];
  const unjudged = new Set();
  for (const item of items) {
    if (item.deliveryId) {
      if (next.deliveries.includes(item.deliveryId)) continue;
      next.deliveries.push(item.deliveryId);
    }
    const merge = item.kind === "closed" && item.merged;
    // With issues off, a delivery is still marked seen, so turning issues on
    // later replays none of it; a failed run and a merge are events either
    // way (decisions.md#merge-refreshes-the-rest).
    if (context.issuesOff && item.kind !== "failed" && !merge) continue;
    if (item.kind === "failed") {
      // **A run is told once, by its id and attempt**, whether a delivery or
      // a read brought it. The app's own pull request is set off by the app:
      // no author gate; one whose number is unknown is nobody's.
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
      // brought it, and passes no author gate.
      if (next.merges.includes(item.number)) continue;
      next.merges.push(item.number);
      events.push({
        kind: "merged",
        number: item.number,
        issues: context.issuesOff ? [] : closesOf(item.text),
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
    // A seen file from before items were kept by id holds a time per issue
    // and pull request: what a read brings from no later than it was told then.
    const before = (item.pull ? seen.pulls : seen.issues)?.[item.number];
    if (!item.deliveryId && before && item.at && item.at <= before) continue;
    // **An item is seen once, by GitHub's id of it**, whichever of a delivery
    // and a read brought it first, before the author gates, so one that was no
    // event when heard is not judged again; an issue's opening by its number.
    const key = item.kind === "opened" ? `opened:${item.number}` : item.id || "";
    if (key && known.has(key)) continue;
    const author = item.author || "";
    // **An author whose permission is unknown is not judged**
    // (decisions.md#github-webhook): the item stays unseen, its delivery
    // too, for the next read; a bot is no person and is judged as a reader.
    if (
      author &&
      !(slug && author === `${slug}[bot]`) &&
      !author.endsWith("[bot]") &&
      !Object.hasOwn(next.permissions, author)
    ) {
      if (item.deliveryId) next.deliveries = next.deliveries.filter((id) => id !== item.deliveryId);
      unjudged.add(author);
      continue;
    }
    if (key) {
      known.add(key);
      next.items.push(key);
    }
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
    const named = people.has(author.toLowerCase());
    if (item.kind === "opened") {
      // An issue opened with a label is labelled too, and that item is the one that counts.
      if (!item.labels?.length) event("issue");
    } else if (item.kind === "labeled") {
      const key = `${item.number}:${item.label}`;
      // Told already at or after this time: a read's and a delivery's of one
      // putting on are told once.
      if (item.at && next.labeledAt[key] && item.at <= next.labeledAt[key]) continue;
      const once = () => {
        if (!next.labeled.includes(key)) next.labeled.push(key);
        if (item.at && !(next.labeledAt[key] >= item.at)) next.labeledAt[key] = item.at;
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
      else if (named || (item.pull ? ours : carried.has(item.number)))
        event(item.pull ? "review" : "comment");
    } else if (item.kind === "review") {
      // A review with no words on another person's pull request asks nothing.
      if (ours || (named && (item.text || "").trim())) event(mentions ? "mention" : "review");
    }
  }
  next.deliveries = next.deliveries.slice(-DELIVERIES_KEPT);
  next.runs = next.runs.slice(-DELIVERIES_KEPT);
  next.merges = next.merges.slice(-DELIVERIES_KEPT);
  next.items = next.items.slice(-ITEMS_KEPT);
  return { events, seen: next, unjudged: [...unjudged] };
}

const MONTHS =
  "January February March April May June July August September October November December".split(
    " ",
  );

/** "3 November 2026 21:58", as the note writes a time. */
function noteTime(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${hh}:${mm}`;
}

/**
 * **An event as its note** (decisions.md#github-webhook): the heading
 * when the note is new (`first`), then a line of the event and its text
 * as written, indented four spaces.
 */
export function noteFor(event, { first = false } = {}) {
  const head = first ? `# GitHub #${event.number}: ${event.title}\n\n` : "";
  const text = (event.text || "")
    .split(/\r\n?|\n/)
    .map((line) => (line.trim() ? `    ${line}` : ""))
    .join("\n")
    .replace(/\n+$/, "");
  // A failed run's line names its workflow, run and commit; nobody wrote it.
  if (event.kind === "failed")
    return `${head}failed, ${noteTime(event.at)}, ${event.by} run ${event.run} on ${event.sha}: ${event.url}\n\n`;
  // An issue a merge did not close: the issue, the pull request's address, and
  // under it why (decisions.md#closes-its-issues).
  if (event.kind === "unclosed")
    return `${head}unclosed, ${noteTime(event.at)}, issue #${event.issue}: ${event.url}\n    ${event.why}\n\n`;
  // A merge's line names the base and who merged; under it, what it left behind
  // (decisions.md#merge-refreshes-the-rest).
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
 * **The listener** (decisions.md#github-webhook): every verified POST is
 * `heard()`, kept by `keep(id, event, rawBody)` when the queue takes
 * something from it (`keeps`), and answered 202 before `after()` runs the
 * work, GitHub wanting an answer within ten seconds; one it takes nothing
 * from is answered 202 with nothing kept and no work
 * (decisions.md#merge-refreshes-the-rest); an unverified one is answered
 * 401 with nothing kept, anything but a POST 405. The server, listening
 * on `port`.
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
