# On GitHub

The assistant and the planner read this in a project with `land:
pull-request`, at the step their agent file names. `<the owner>` in a
template is the owner's name as the agent file gives it.

For every agent: a plan or a brief quoted anywhere on GitHub, in an
issue, a comment or a pull request, is inside `<details>` under a
one-line summary, never open.

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

  ![<What it shows, in one line.>](./<file>)

  The plan behind this: a collapsed comment below, once it is planned.
  Comment to poke holes or add what is missing; it is built as a draft pull request once planned, and a comment is taken in.
  ```

  `## Decided` only when the brief has one; a picture line for each
  screenshot or sketch the topic has in `plans/<topic>/` then, none when
  it has none. Each picture is looked at before it goes up, and one that
  shows a host address, a secret or a personal email is left out: the
  `Check` reads only the text. A held brief (its "Decided"
  has `Held on <the owner>'s word: <until what>.`) ends its second line
  `Comment to poke holes or add what is missing; a comment is taken in.`
  An issue alone, `Make it an
  issue` with no brief, leaves out the line "The plan behind this: a
  collapsed comment below, once it is planned." and takes no label until
  a brief carries its number; the topic ends as answered, with its
  address. The body is written when the issue is made and no agent edits
  it after; a hand-opened issue's body is never edited. Run
  the Issues heading's `Check` on the file (with none, read it for a
  host address, a secret or a personal email), then `plans gh issue
  create --title "<the sentence>" --body-file plans/<topic>/issue.md
  --label "status: planning" --attach plans/<topic>/<file>`, the label
  left out for an issue alone, one `--attach` per picture the body
  references, so the issue opens with them shown. A picture that does
  not go up posts nothing, and `plans gh` says why; the command is run
  once more without `--attach`, the file's picture lines replaced by the
  not-attached line, `Screenshots: not attached yet, kept in
  plans/<topic>/. <The cause.>` (landing.md, "The screenshots, when
  `--attach` fails", gives the cause), the `Check` run on the file
  again, since the cause is new text; the upload is not tried again.
- **In part**: a brief or plan that does only part of an issue names it
  `Related: #<n>.`; the one that finishes it carries `Issue: #<n>.`, since
  the pull request closes what its plans' `Issue` lines name.
- **The labels**, created when missing, one at a time: `status: planning` with the brief, added (`plans gh issue edit
  <n> --add-label "status: planning"`) when a brief takes the number of
  an issue that has no label; `status: planned` the planner's, on a held plan; `status: ready` the planner's on the owner's standing word, a writer's, or yours on his word; `status: building` the executor's.
- **Held**: a brief's "Decided" gets `Held on <the owner>'s word: <until
  what>.` only when he said to hold that one; never ask whether to.
- **Ready on his word**, for a held plan: read the issue's comments (`plans gh issue view
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
webhook"); an open assistant chat is sent `GitHub: plans/github/<n>.md.`
within a minute. For each
event under no `## Handled` line, read the issue and its plan, then act
once:

- a question, one comment as the app from the plan or docs, never a guess,
  saying so when they do not say (`plans gh issue comment <n>
  --body-file`);
- a task or a change from a person **People** names, by the GitHub
  login it gives them, or by name where it gives none: when it is clear
  and not the owner's call, act on it without him. The comment of a
  person **People** gives a login in backticks reaches you wherever they
  wrote it, on an issue no plan carries and on another person's pull
  request too: there, act only on a clear task or a question put to the
  queue; talk between people gets no reply and no question to the owner,
  and its Handled line says so. One that fits a short plan ("Which
  session a topic goes to") is written and started at once,
  landing in that pull request when it was said on one of the queue's
  own (`Lands: topic <the head branch>, waiting; lands in #<n>.`), or is
  a "Decided" line with their name when the plan is planned and has no
  Building line; anything bigger is a brief, with its `Issue` line when
  it was said on an issue, or that `Lands` line when on one of the
  queue's own pull requests. Said on another person's pull request, its
  plan takes a topic of its own. Reply once, as the app, only when they would otherwise
  not know it was taken: `On it: <what will change, in a line>.` An
  unclear one is asked back in one plain comment. The owner's call,
  asked with the question tool as today: the reversal of a rule with his
  or a third person's name, a direction beyond the issue's or pull
  request's topic, a merge, a production push, money or a secret;
- a change from a writer **People** does not name, a brief with its
  `Issue` line, or a "Decided" line when the plan is planned and it is
  the commenter's call, else the question tool to the owner;
- `plan`, a brief started as exit 4;
- `ready`, the Ready step, first line `Ready on GitHub, <d Month>.`;
- `review`, a short plan for a fix or an answer on the pull request; on
  another person's, only a named person's clear task or question, as above;
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
app ("A topic the people discuss is a GitHub issue"). No body is
written: the issue's was written once, when it was made, and a
hand-opened issue keeps its own.

1. Write `plans/<topic>/plan-comment.md`:

   ```
   <!-- workflow: plan -->
   <details><summary>The whole plan: <the plan's title></summary>

   <the plan, its status sections cut>
   </details>

   ![<What it shows, in one line.>](./<file>)
   ```

   A picture line for each screenshot or sketch the plan names in
   `plans/<topic>/`, none when it names none, each looked at first as
   the issue's are. With a `Detail` step, run
   it, and its address replaces the details block, after the first line. The file passes the **Issues** heading's
   `Check` command first (with none, read it for a host address, a
   secret or a personal email).
2. Find the plan comment among the app's own:

   ```
   plans gh api "repos/{owner}/{repo}/issues/<n>/comments" --paginate --jq '.[] | select(.user.type == "Bot") | select(.body | startswith("<!-- workflow: plan -->") or startswith("<details><summary>The whole plan")) | .id'
   ```

   With none,
   `plans gh issue comment <n> --body-file
   plans/<topic>/plan-comment.md --attach plans/<topic>/<file>`, one
   `--attach` per picture the file references, so the comment shows
   them; a picture that does not go up posts nothing, and the command
   is run once more without `--attach`, as the issue's is ("GitHub
   issues"). With one,
   `plans gh api -X PATCH
   "repos/{owner}/{repo}/issues/comments/<id>" -F
   body=@plans/<topic>/plan-comment.md`; with several, the first is
   patched and the rest left. A patch keeps the images already in the
   comment: the file takes, in place of its local references, the image
   addresses GitHub gave the posted comment, read from its body
   (`plans gh api "repos/{owner}/{repo}/issues/comments/<id>" --jq
   .body`), each picture matched by its alt text as first written; a
   picture with no address there, new or never attached, is not attached
   on a patch, since `gh api` uploads nothing, and its path is named in
   the comment instead, the `Screenshots: not attached yet` line kept
   while any is. Whoever changes a plan with an `Issue`
   line that no executor holds runs steps 1 and 2 again; nobody else
   posts a plan or a brief on an issue.
3. Without a `Held on` line in its "Decided", `plans gh issue edit <n>
   --add-label "status: ready"` with a `--remove-label` for each other
   `status:` label the issue carries (`plans gh issue view <n> --json
   labels --jq '.labels[].name'`; a read that fails stops the step, its
   output said), so it keeps one `status:` label; once it has taken,
   write the plan's Ready section, on the owner's standing word, and hand
   the plan on with `plans start` as any other plan:

   ```
   ## Ready, <date>

   Ready on <the owner>'s standing word, <d Month>.
   ```
4. A plan whose "Decided" carries `Held on <the owner>'s word: <until
   what>.` gets no Ready section: `plans gh issue edit <n> --add-label
   "status: planned"` with a `--remove-label` for each other `status:`
   label the issue carries, read as in step 3, and it waits for "Ready
   on his word"; say the issue's address and what it waits for, and a
   `status: ready` the edit took off, since a writer's may have been
   meant as the release.
