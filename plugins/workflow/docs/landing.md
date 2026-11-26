# Landing by pull request

The executor reads this at a plan's start in a project with `land:
pull-request`, where "push" in its agent file means the landing below (decisions.md#topic-landing). The merge is the people's:
run no `gh pr merge` and no `gh pr ready`; push the
branch itself only for a `Lands: fix, now.` plan, as a fast-forward. In a
project whose file has an **Issues** heading, every write to GitHub but
the push runs as `plans gh` (`gh pr create`, `gh pr edit`); the push
stays on `GH_TOKEN`.

**The `Lands` line**, under the plan's header paragraph, is one of
`Lands: fix.`, `Lands: fix, now.`, `Lands: refresh.`, `Lands: topic
<name>, waiting.` and `Lands: topic <name>, ready.`, a topic's with `; lands in #<n>.` or
`; stacked on #<n>.` after its state when the author names the pull
request, kept when the line is rewritten. A plan with none is `topic
<the plan's file name without .md>, ready`. Follow the line; its author
judges whether a topic is ready and a change a fix.

**A topic's pull request opens as a draft, and stays ready once the
owner marks it** (decisions.md#draft-until-reviewed): `gh pr create`
takes `--draft`; a plan that joins one he has marked ready pushes to it
as it is, its checks run again, and the merge stays his. The day's fixes
pull request opens ready; a join, the refresh and the retarget leave the
state as it is. Asked to mark one ready, give the step: the Ready for
review button.

**A branch is brought up to date by a merge**, not a rebase and a forced
push (decisions.md#merge-never-force): `git merge --no-edit -m "Merge
origin/<base> into <name>" -m "<the session's attribution lines>"
origin/<base>`, a conflict settled from the plans and committed with
`git commit --no-edit`; one that cannot be is left (`git merge --abort`)
and named in the final message. Push it to that branch only; refused,
`git fetch origin`, merge `origin/<name>` the same way, run the checks
and push once more; refused again, leave it and name it. Each merge gets a line in "Built": `Merged <base> <date>, commit <sha>: <files or none>`, the files whose conflicts were settled.

**A topic's branch** is the topic's name, after `git fetch --prune`. A
name that is the branch, `main` or `fixes-` followed by anything is no
topic's: build the plan as `topic <the plan's file name without .md>`,
its "Built" saying why.

**A branch another worktree has checked out is that executor's** (git
refuses the switch and names the worktree): at a plan's start and in a
refresh it is left and named, `left: #<k>, executor-<n> is building on it`.

- **A plan that rests on an open pull request** (it uses what an earlier
  plan adds, and that plan's pull request is open) is settled first, by
  `gh pr view <n> --json isDraft,headRefName`
  (decisions.md#stack-only-on-use). **A draft of this queue's own** takes
  it: the plan lands in that pull request whatever its `Lands` line
  names, its topic that head branch. **Another person's** is stacked on
  ("No branch yet"). One of the queue's own marked ready goes by the
  project's **Pull requests** heading: lands in it (ready as he left
  it) when the heading says related plans share a pull request, else
  stacked on it. A stacked plan is built as `topic <the plan's file name
  without .md>` (with `-2` when that is the head branch) when its
  `Lands` line names that pull request's topic. A plan sent to another topic has its `Lands` line
  rewritten to it. A plan that shares files with an open pull request
  goes where its `Lands` line says; its author read the project's
  **Pull requests** heading.
- **No branch yet** (no `origin/<name>`, no local `<name>`): `git switch
  -c <name> origin/<branch>`. Stacked: `git switch -c <name> <that head
  branch>`, that branch the pull request's `--base` and the first line
  of its body `Builds on #<n>; merge that first.`
- **A waiting branch** (`origin/<name>`, no open pull request): `git
  switch -C <name> origin/<name>`, then its base merged in, the plan's
  push carrying the merge; an unsettled conflict leaves it as it is.
- **An open pull request's branch**: `git switch -C <name>
  origin/<name>`, no merge. In both, a local branch with commits the
  remote lacks is taken instead, and pushed first.
- **The tip it starts from** is recorded before the first edit, `git
  rev-parse HEAD` once the branch is taken and merged; the plan's squash
  goes back to it and no further.

**At a plan's start**, `git fetch --prune`. The queue's own pull
requests are the open ones a plan in this checkout's `plans/` names as
its own, by its "Built" or its `Lands` topic; a `Related` line names
another's (decisions.md#refresh-only-your-own). Each whose base's pull
request has merged is retargeted, `gh pr edit <n> --base <branch>`, and
`origin/<branch>` merged into its head and pushed.
Delete a local branch only when `gh pr view <name> --json
state,headRefOid` says MERGED at its own commit; others stay, named in
the final message.

**Then a conflicting pull request is refreshed**: each of the queue's
own that GitHub reports as conflicting (`gh pr view <n> --json
mergeable,baseRefName,headRefName,headRefOid`, `mergeable`
`CONFLICTING`; one still `UNKNOWN` is asked again once the others are
done, and named if it stays so), a pull request before the ones stacked
on it, by "A pull request is refreshed". Then `git checkout --detach
origin/<branch>`.

**A pull request is refreshed**: start from its head as GitHub has it,
`git switch -C <head branch> origin/<head branch>`; a local branch holding commits that head
lacks is left and named. Merge its base, `origin/<baseRefName>`, in (one
stacked on a pull request just refreshed merges that one's new head),
the conflicts settled from the two plans; run the project's checks, not
the suites, since its CI runs on the push; push it with `git push origin
<head branch>`, never to the branch. Its plan's "Built" gets `Refreshed <date>: merged <base>, commit <sha>, <files>`. One that cannot be settled
is left and named.

**A refresh**, `Lands: refresh.`, is the assistant's plan after a
merge (decisions.md#merge-refreshes-the-rest): no branch, commit,
review or pull request of its own. After "At a plan's start", each
pull request the plan names that is still open and behind its base
(`git rev-list --count origin/<head>..origin/<base>` over 0), or
conflicting, is refreshed by "A pull request is refreshed"; one it
names as stacked on the merged one was retargeted at the plan's
start. A plan that names none takes every one of the queue's own but
another person's (`gh pr view <n> --json author`, neither a bot nor the
token's own login), which is left and named.
Draft or ready, the state stays. "Built" opens with `Refreshed:
#<n> at <sha>, #<m> at <sha>; left: #<k>, <why>.`, or `Refreshed:
nothing was behind.`, and says `Codex review: not run (a refresh).`

**A topic's plan**: one commit per plan on the topic's branch, squashed
back to the plan's tip, so a commit another person pushed stays theirs;
where that would rewrite a pushed commit, push the plan's commits as
they are and name each in "Built". Then `git push -u origin <name>`,
retried as for a merge. Then, by the topic:

- **Waiting, no pull request**: nothing opens. "Built" opens with
  `On topic <name>, commit <sha>, branch pushed; its pull request waits.`
- **Ready, no pull request**: the description (below), written from
  every plan of the topic so far, oldest first, to `plans/<the ready
  plan>/pull-request.md` and read back as the reviewer will, then:

  ```
  gh pr create --draft --base <branch, or the head branch it is stacked on> \
    --title "<the ready plan's title>" \
    --body-file plans/<the ready plan>/pull-request.md \
    --attach plans/<topic>/<file>.png#<the line> ...
  ```

  one `--attach` per screenshot the body names. "Built" opens
  with `Pull request #<n> (<url>) to <branch> from branch <name>, commit <sha>; draft.`, and each earlier plan of the topic gets,
  after its "Built" section's first line,
  `Pull request #<n> (<url>) opened <date> with plans/<x>.md.`
- **A pull request already open**: the description written again from
  every plan of the topic to `plans/<this plan>/pull-request.md`, keeping
  the uploaded image addresses of its body (`gh pr view <n> --json
  body`), this plan's screenshots as local paths; then

  ```
  gh pr edit <n> --body-file plans/<this plan>/pull-request.md \
    --attach plans/<topic>/<file>.png#<the line> ...
  ```

  one `--attach` per local screenshot the body names, the uploaded ones
  kept as they are. A plan marked waiting says in "Built" that it was
  open already.
  No comment: the description is the record
  (decisions.md#joined-pull-request). "Built" opens with
  `Pull request #<n> (<url>) joined, commit <sha>; <draft | ready>.`,
  its state as `gh pr view <n> --json isDraft` gives it.

**Each issue it closes is linked** (decisions.md#closes-its-issues).
GitHub reads a closing keyword only on a pull request into the default
branch. After the create or the edit, read what it shows, `gh pr view <n>
--json closingIssuesReferences --jq '.closingIssuesReferences[].number'`,
and for each `Closes` line's issue not listed, link it, by the gh the
pull request was written with:

```
plans gh api graphql \
  -f query='mutation($issue: ID!, $pull: ID!) { addCloseIssueReferences(input: { issueId: $issue, pullRequestIds: [$pull] }) { issue { number } } }' \
  -f issue="$(gh issue view <i> --json id --jq .id)" \
  -f pull="$(gh pr view <n> --json id --jq .id)"
```

One that is refused is not tried again: "Built" and the `Built:` message
say `Not linked: #<i>, <gh's line>.`, and the `Closes` line and the
queue's close at the merge stand.

**A fix**, `Lands: fix.`, is built on the day's branch,
`fixes-<yyyy-mm-dd>`, the day of its push (decisions.md#days-fixes),
one commit pushed with `git push -u origin fixes-<yyyy-mm-dd>`. Its pull
request open (`gh pr list --state open --head fixes-<yyyy-mm-dd> --json
number,url`): the branch is `origin/fixes-<yyyy-mm-dd>`, and its
description rewritten by `gh pr edit` with `--attach`, keeping its
uploaded image addresses; no comment. None that day,
in any state (`gh pr list --state all --head
fixes-<yyyy-mm-dd>`): the branch is `origin/fixes-<yyyy-mm-dd>` when an
earlier fix waits on it, `origin/<branch>` merged in, else
`origin/<branch>`; after the push, `gh pr create --base <branch> --title "Small fixes, <d Month
yyyy>" --body-file plans/<the plan>/pull-request.md --attach ...`, the
date as `30 October 2026`. With the day's pull
request merged or closed, the fix **waits for tomorrow**: built the same
way on `fixes-<the next day's yyyy-mm-dd>`, pushed, no pull request;
"Built" opens with `On topic fixes-<the next day's yyyy-mm-dd>, commit
<sha>, branch pushed; its pull request waits.` At a plan's start, a
`fixes-` branch whose day has come and that has no pull request gets one
by the same command, each of its plans' "Built" getting
`Pull request #<n> (<url>) opened <date> with plans/<x>.md.` A local `fixes-` branch with commits the remote lacks is taken as is. Pushes are plain, retried as a merge's. The squash goes back to the
tip the day's branch had once taken and merged. "Built" opens with
`Pull request #<n> (<url>) of the day's fixes, commit <sha>; open.`

**A fix wanted now**, `Lands: fix, now.`: a branch of its own off
`origin/<branch>`; one commit; `git push origin HEAD:<branch>` as a
fast-forward, retried as the agent file's push says; the project's `run`
read (decisions.md#fix-now-landing). It is listed under `Already on
<branch>` in the day's fixes pull request when one is open, or by the
day's first fix that opens one; a day with none leaves it recorded by
its commit, which the final message says. "Built" opens with
`Pushed straight to <branch> as a fix, commit <sha>; <run> green.`
(with no `run`, `no run to read.` in place of `<run> green.`).

**A fix that is not one**, a commit that adds, changes or strikes a
catalogue rule or a rule in the project's docs, lands as `topic <the
plan's file name without .md>, waiting`, its "Built" and the final
message saying why (decisions.md#fix-landing).

**The screenshots, when `--attach` fails** (decisions.md#screenshots-attach):
through `plans gh`, a picture that did not go up means nothing was
posted, and `plans gh` printed why (`Screenshots not uploaded, so
nothing was posted: …`). Run the command once more without `--attach`,
each picture's reference replaced by its alt text as a line of its own,
and the line under `## To try it`: `Screenshots: not attached yet, kept
in plans/<topic>/. <The cause.>`, the cause what `plans gh` printed
between `nothing was posted: ` and `. Post it once more`, with a
capital. The upload is tried no second time. "Built" and the `Built:`
message say `Screenshots not attached: <the cause>`. On an issue or its
plan comment (github.md, "GitHub issues") the same, the line in place of
the picture lines.

With plain gh, in a project whose file has no **Issues** heading (gh
under 2.99.0, or the upload refused): look first whether a refused `gh
pr create` opened one anyway (`gh pr view <name> --json number,url`),
and try the upload once more, by `gh pr edit <n>` on the one it opened,
else by the same command; then take the images that failed out of the
body, each one's line kept as a line of its own (its alt text), and set
it without `--attach`, with the same line under `## To try it`. A pull
request a refused create opened gets its body replaced, never a second;
a refused `gh pr edit` that set part of the body is read back (`gh pr
view <n> --json body`) and set again. The cause is `This container's gh
is older than 2.99.` when gh's own line is `unknown flag: --attach`,
else gh's own line. "Built" and the `Built:` message say the same.

**The checks are not waited on** ("A push is not waited on"): after
the push and the pull request's create or edit, start the next plan;
run no `gh pr checks` and no `gh run watch` on a pull request. A run
that fails there reaches the assistant by the app's webhook and comes
back as a short plan landing in it; the Stop hook names a failed check
the webhook does not bring (any with no webhook, another service's
with one), fixed and pushed before the
next plan. The project's `run` is read only for a fix pushed straight.

**After the plan's push**, `git checkout --detach
origin/<branch>`; keep the local branches, the hook's match for pull
requests.

**The `Built:` message to the assistant leads with** each pull request opened or joined, its
link and what it was marked related to, and, for a draft: `Pull request
#<n> (<link>) is a draft and waits on you: read its description and
screenshots, then mark it ready for review on GitHub (the Ready for
review button at the bottom of the pull request). Until then it asks
nothing of anyone else.`; for one he marked ready, that it stays ready,
its checks running again, and the merge his; then the topics left waiting, the day's fixes
pull request, and the fixes pushed straight.

**The description** is a short list of what changed
(decisions.md#short-description): plain words, no dashes, the
project's spelling, each bullet's words from the plans or the
catalogue, a commit's title as written; on one screen, pictures aside.

```
<The owner's paragraphs, word for word, when the body has some>

Closes #<n>.                                  <- one per issue its plans' Issue lines name
Builds on #<n>; merge that first.             <- stacked plans only
Related: #<n>.                                <- plans with a Related line only

## Changes

- **<What was added or changed, two to five words.>** <One sentence of
  what a person can now do or see.>

  ![<What the picture shows, in one line.>](plans/<topic>/<file>.png)

- **<What was added or changed.>** <One sentence.>
- <The commit's title.> (<author>)

## To try it

<One line.>

<The owner's own sections, word for word, when the body has some>

<the attribution lines the session gives for a pull request, with any link
to a Claude session left out>
```

- **The owner's paragraphs**: on a rewrite (`gh pr view <n> --json
  body`), everything above the body's first `## ` heading, less its
  `Closes #`, `For #`, `Builds on #` and `Related:` lines, is the owner's
  and opens the new body unchanged; a `Closes #` line for an issue no
  plan of the topic names is the owner's too, and is kept. With nothing
  there, the body opens with the three lines that apply, so a pull
  request written again loses an older `For #<n>.` line and gains
  `Closes #<n>.`. So is every `## ` section whose heading the
  template does not name: it follows To try it, word for word, in the
  order the body has it. Write no opening paragraph of your
  own: the title is the summary.
- **Closes** and **Related**: `Closes #<n>.` for each issue a plan of
  the topic names in its `Issue` line, one line each, no issue twice:
  GitHub's keyword, so a merge into the default branch closes it and the
  queue closes it elsewhere (decisions.md#closes-its-issues). Then the
  plans' `Related` lines as written (`Related: #31.`), less a number a
  `Closes` line names. Look for no related work yourself, and comment on no other
  person's pull request.
- **Changes**: one bullet per thing a person can now do or see, from
  every plan of the topic, oldest first: a plan's central decision, each
  "Done when" scenario a person sees, and a plan's small changes folded
  into one bullet; the lead in bold is the thing, two to five words, in
  the words the plans and the catalogue use; the sentence is plain, one
  line of what it does, with no tier, date, struck rule or catalogue id.
  A bullet whose change replaces a rule with another person's name says
  so in its sentence, `replacing <name>'s call`, and goes first
  (decisions.md#decision-has-a-name). A decision taken after thirty
  minutes unanswered says `taken for <the owner>, unanswered` in its
  sentence, and one taken in place of a question (a `Taken on` line of
  "Built") says `taken for <the owner>`. Then, last, a line per commit on the topic's branch that this
  checkout's plans do not account for (`git log
  origin/<base>..origin/<name> --format='%H%x09%an%x09%s'` after the
  push), as `- <the commit's title> (<author>)`, another person's merge
  included (decisions.md#plans-account-for-commits). Accounted for: this
  plan's commits and merges (`git log --first-parent <tip>..HEAD
  --format=%H`, and a merge this plan made before its tip); a commit a
  plan of the topic names by hash in its "Built", the shorter a prefix
  of the longer; on a branch stacked on a pull request since merged, the commits of each merged pull request down the
  stack, found by the `Builds on #<n>` line of its body (`gh api
  --paginate repos/{owner}/{repo}/pulls/<n>/commits --jq '.[].sha'`).
  Nothing is left out by author or by title.
- **Screenshots**: one under a bullet at most, only where it shows
  exactly what the bullet added or changed, in light mode at desktop
  width; dark mode or a phone width only for a bullet about the theme or
  about that width; its line, what the picture shows, is its alt text and
  the `#<the line>` of its `--attach`. The screenshots the plan took for
  its review stay in `plans/<topic>/`; only the ones the body names are
  attached. A bullet with nothing to show has no picture.
- **To try it**: a line from the project file's "After the push", else
  "Check out the branch."
- **The title** is the title of the plan that marks the topic ready.
- **The attribution**: the session's lines for a pull request, less
  any line with a `claude.ai/code/session_` address, old ones included.
  On a rewrite, the attribution lines at the old body's end belong to
  none of the owner's sections: the new body ends with them once.

**The day's fixes pull request**, `Small fixes, <d Month yyyy>` from
`fixes-<yyyy-mm-dd>`, has its own description, written to `plans/<the
plan>/pull-request.md` each time a fix joins, with no words of yours.
On a rewrite (`gh pr view <n> --json body`) the owner's paragraphs and
sections are kept as in a topic's.

```
<The owner's paragraphs, word for word, when the body has some>

## Fixes

- <The commit's title.>

  ![<What the picture shows, in one line.>](plans/<x>/<file>.png)

## Already on <branch>

- <The commit's title.> (<the commit's short sha, linked>)

## To try it

<One line.>

<The owner's own sections, word for word, when the body has some>

<the attribution lines the session gives for a pull request, with any link
to a Claude session left out>
```

- **Fixes**: every fix on the day's branch, oldest first, its
  screenshot by the topic's rule: one at most, light mode, desktop
  width, only where it shows the fix.
- **Already on <branch>**: the day's fixes pushed straight, from `git log
  origin/<branch> --first-parent --since=<the day's start> --format='%h
  %s'`, without merge commits and commits whose title ends in ` (#<n>)`;
  with none, no heading.
- **To try it** and **the attribution**: as the topic's description.
