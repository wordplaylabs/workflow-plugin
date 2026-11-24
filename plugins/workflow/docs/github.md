# On GitHub

The assistant and the planner read this in a project with `land:
pull-request`, at the step their agent file names. `<the owner>` in a
template is the owner's name as the agent file gives it.

## GitHub issues

With an **Issues** heading and `land: pull-request`, a topic the people
discuss is an issue, written as the app through `plans gh` ("A topic the
people discuss is a GitHub issue"); when it says there is no app here,
say what it says.

- **When**: asked; one per request read from the group's chat, none for
  one already open (`plans gh issue list --search "<words>"`); and one
  with every brief unless he says not, the brief getting `Issue: #<n>.`
  under its header line.
- **Its shape**: the brief's title; no backstory, names or paths; the
  body in `plans/<topic>/issue.md`:

  ```
  ## Decided
  - <A thing already settled, one line, its reason.>

  The plan behind this: the first comment.
  Comment to poke holes or add what is missing; it is built as a draft pull request once the issue is labelled status: ready.
  ```

  `## Decided` only when the brief has one. An issue alone, `Make it an
  issue` with no brief, leaves out the line "The plan behind this: the
  first comment." and takes no label until a brief carries its number;
  the topic ends as answered, with its address. Run the Issues heading's
  `Check` on the file (with none, read it for a host address, a secret
  or a personal email), then `plans gh issue create --title "<the
  sentence>" --body-file plans/<topic>/issue.md --label "status:
  planning"`, the label left out for an issue alone.
- **The labels**, created when missing, one at a time: `status: planning` with the brief, added (`plans gh issue edit
  <n> --add-label "status: planning"`) when a brief takes the number of
  an issue that has no label; `status: planned` the planner's; `status: ready` a writer's, or yours on his word; `status: building` the executor's.
- **Ready on his word**: read the issue's comments (`plans gh issue view
  <n> --comments`); a change to the commenter's own part goes in under
  their name, anything else to him with the question tool. Then:

  ```
  ## Ready, <date>

  Ready on <the owner>'s word, <d Month>.
  <the decision> (<name>, <d Month>, comment on #<n>)
  ```

  `plans gh issue edit <n> --remove-label "status: planned" --add-label
  "status: ready"`, `plans start plans/<x>.md`. A change that does not
  fit a line is a new brief, the old plan dropped `replaced by
  plans/<y>.md`. "Build it without the issue" is a Ready section with
  that line alone.

## What reaches you from GitHub

The app's webhook writes each event in `plans/github/<n>.md` ("What
people with write access write on GitHub reaches the queue by the app's
webhook"); an open chat reads `plans/github/` at its next turn. For each
event under no `## Handled` line, read the issue and its plan, then act
once:

- a question, one comment as the app from the plan or docs, never a guess,
  saying so when they do not say (`plans gh issue comment <n>
  --body-file`);
- a change, a brief with its `Issue` line, or a "Decided" line when the
  plan is planned and it is the commenter's call, else the question tool
  to the owner;
- `plan`, a brief started as exit 4;
- `ready`, the Ready step, first line `Ready on GitHub, <d Month>.`;
- `review`, a short plan for a fix or an answer on the pull request;
- `merged`, a pull request merged into a branch the queue's own are on:
  its indented lines name them. For a `merged` note, write one refresh
  plan ("A refresh plan") for those under `behind` and `stacked on it`,
  and for one under `another person's, left` only when the owner said so
  in a chat; `plans first` it, on his standing word, and hand it on as
  any short plan. Several `merged` notes not handled are one plan. A refresh plan that waits with no Building
  line gains the pull requests it lacks, and no second is written;
- `failed`, a run that failed on the queue's own pull request: `gh run
  view <id> --json attempt,headSha` and `gh pr view <n> --json
  state,headRefOid,headRefName,baseRefName`; a pull request closed or past
  that commit gets nothing. Else read `gh run view <id> --log-failed |
  tail -n 200` and `gh pr diff <n>`. A failure the diff does not explain
  on a pull request behind its base (`gh api
  repos/{owner}/{repo}/compare/<base>...<head> --jq .behind_by` over 0) is
  refreshed, not rerun, since a rerun runs the same commit against the old
  base: it goes into the refresh plan, as a `merged` line's would. A
  failure the diff does not explain, on attempt 1, is rerun once, `plans
  gh run rerun <id> --failed`; one it explains, a rerun's, or a rerun
  refused, is a short plan for the fix, `Lands: topic <the head branch>,
  waiting; lands in #<n>.` (`Lands: fix.` on the day's fixes), started at
  once. Several `failed` lines on one commit that fail the same way are
  one failure: each run is rerun at most once, and one short plan is
  written.

Then write `## Handled, <date>, session <id>` with a line of what you did,
for `failed` which of the four.

## A refresh plan

```
# The queue's open pull requests carry <base> after #<n>

Short plan, <date>, by the assistant with <the owner>; the executor builds it.
Read with the plugin's docs/landing.md ("A refresh").

Lands: refresh.

## What was asked

#<n> merged into <base> on <d Month>. Behind it: #<a> (<head>), #<b>
(<head>). Stacked on it: #<c> (<head>). Left, <login>'s: #<d>.

## Done when

- Each pull request named has origin/<base> merged in and pushed to
  its own branch, or is in "Built" with why not.
```

Named `plans/refresh-after-<n>.md`. With `behind: not read`, it
names none. A failed run it answers is a line of "What was asked".

## A plan with an `Issue` line

A plan with an `Issue` line goes behind its issue, as the project's
app ("A topic the people discuss is a GitHub issue"): the body written to
`plans/<topic>/issue.md`, a hand-opened issue keeping its title and its
words above the headings, nothing else:

```
## Decided
- <A thing already settled, one line, its reason; the plan's Decided.>

## What will be built
- <A decision, one line, with the product or rule it rests on; The short version.>

## Not in this
- <The plan's Not in this plan, one line each.>

The plan behind this: <the Detail address, or "the first comment">.
Comment to poke holes or add what is missing; it is built as a draft pull request once the issue is labelled status: ready.
```

Both files pass the **Issues** heading's `Check` command first (with
none, read them for a host address, a secret or a personal email). Then
`plans gh issue edit <n> --body-file plans/<topic>/issue.md
--remove-label "status: planning" --add-label "status: planned"`, and
the plan, status sections cut, in `<details><summary>The whole
plan</summary>` … `</details>`, written to
`plans/<topic>/plan-comment.md` and posted with `plans gh issue comment
<n> --body-file` (`--edit-last` when it changes), or the `Detail` step
run and its address in the body. Such a plan waits for `status: ready`;
say the issue's address.
