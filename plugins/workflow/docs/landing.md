# Landing by pull request

The executor reads this at a plan's start where `land: pull-request`;
"push" in its agent file means this landing
(decisions.md#topic-landing). The merge is the people's: run no `gh pr
merge` and no `gh pr ready`; push the branch itself only for a `Lands:
fix, now.` plan, as a fast-forward. In a project whose file has an
**Issues** heading, every write to GitHub but the push runs as `plans
gh` (`gh pr create`, `gh pr edit`); the push stays on `GH_TOKEN`.

**The `Lands` line**, under the plan's header paragraph, is one of
`Lands: fix.`, `Lands: fix, now.`, `Lands: refresh.` and `Lands: topic
<name>.`, a topic's ending `; lands in #<n>.` or `; stacked on #<n>.`
when its author names the pull request, kept on a rewrite. A plan with
none is `topic <the plan's file name without .md>`. A line written
before 26 November 2026 may say `, waiting` or `, ready` after the name,
and one before 28 November `as its fix` after `lands in #<n>`: they mean
nothing now. Follow the line; its author judges whether a change is a
fix.

**A topic's pull request opens as a draft, and stays ready once the
owner marks it** (decisions.md#draft-until-reviewed): `gh pr create`
takes `--draft`; a plan that joins one he has marked ready pushes to it
as it is, its checks run again, and the merge stays his. The day's fixes
pull request opens ready; a join, the refresh and the retarget leave the
state as it is.

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
its `Lands` line rewritten to it, its "Built" saying why.

**A topic's base** is the head branch it is stacked on when a `Lands`
line of its plans says `stacked on #<n>` (`gh pr view <n> --json
headRefName,state,isCrossRepository`), since its pull request opens
against that head and the parent's commits are not its own. A line
without it takes nothing away; of lines that name different pull
requests, the one of the plan whose commit is first on the topic's branch
counts, the branch having started from that head, and with none built
the plan in hand's. It is `<branch>` for any other topic, and for a
stacked one whose parent is MERGED, is from a fork (`isCrossRepository`:
GitHub stacks no pull request across forks, and an `origin/<headRefName>`
of that name is another branch) or whose head is gone from origin (no
`origin/<headRefName>` after `git fetch --prune`), as "A pull request is
refreshed" retargets a stack whose parent merged. A fork's commits are
not merged in, and "Built" gets, after its first line, `#<n> is from a
fork: built on <branch>, not stacked on it.` A parent CLOSED without
merging stays the base while its head is on origin, as GitHub keeps a
stack whose pull request was closed: "Built" gets, after its first line,
`Stacked on #<n>, closed without merging: its base stays <head> while
that branch is on origin.` With that head gone, the topic is built on
`<branch>` and gets no pull request, from a plan's landing or from the
recovery: opened against `<branch>` it would bring the owner the work he
closed. "Built" then opens `On topic <name>, commit <sha>, branch
pushed; no pull request.` and gets, after its first line, `No pull
request: #<n>, which topic <name> is stacked on, was closed without
merging and its branch is gone.` Every step below that names `<base>` takes it
so: the new branch, the start's merge, the create's `--base` and the
recovery.

**A merged parent's work comes in once.** A topic stacked on #<n> still
holds the parent's own commits once it is squash merged, and
`origin/<branch>` merged in plainly conflicts on every line both
changed. So wherever `origin/<branch>` is merged into a stacked topic
(the start's merge, the retarget, a refresh), read `gh pr view <n> --json
state,headRefOid,mergeCommit,isCrossRepository` first (`<mergeCommit>`
its `oid`), `<n>` the pull request "A topic's base" reads from its
plans' `Lands` lines, or its body's `Builds on #<n>` or
`<!-- workflow: stacked on #<n> -->`. With the parent MERGED and not
from a fork, its merge commit on the branch and not in the topic (`git
merge-base --is-ancestor <mergeCommit> origin/<branch>` holds, `...
<mergeCommit> HEAD` does not) and its head not on the branch (`git
merge-base --is-ancestor <headRefOid> origin/<branch>` does not hold),
merge in this order, each as a merge above, its message naming what it
merges (`Merge #<n>'s head into <name>`, `Merge <branch> before #<n>
into <name>`, `Merge #<n>'s squash into <name>, its work here already`,
then `Merge origin/<branch> into <name>`):

1. `<headRefOid>`, the parent as it merged (`git fetch origin
   pull/<n>/head` when the commit is not here), a conflict settled from
   the two plans;
2. `<mergeCommit>^`, the branch before the parent landed;
3. `<mergeCommit>` with `-s ours`, which records the squash and changes
   no file, its work being here since the first;
4. `origin/<branch>`.

The second and third only when the squash is the parent's work alone:
`git merge-tree --write-tree <mergeCommit>^ <headRefOid>` gives `git
rev-parse <mergeCommit>^{tree}`, so `-s ours` passes over nothing else
on the branch, and `git diff -U0 <mergeCommit>^ <mergeCommit> | git
patch-id --stable` gives the id that `git diff -U0 $(git merge-base
<mergeCommit>^ <headRefOid>) <headRefOid> | git patch-id --stable`
gives, without context so a line the branch changed nearby is not
read as the parent's, so
`<mergeCommit>^` holds none of the parent's work. Otherwise (a rebase
merge, or a squash the two checks do not pass) merge the first, then
`origin/<branch>` with the parent's head as the merge's base: git's own
base is older than the parent's files, so a file the parent added and
the topic renamed or deleted would come back with no conflict. `git
merge-tree --write-tree --name-only --merge-base=<headRefOid> HEAD
origin/<branch>` gives the merged tree on its first line and, exiting 1,
the files in conflict after it (any other exit, an older git's refusal
of `--merge-base` included, is git's error, and the topic goes back as
for a conflict left unsettled, below). Then `git merge -s ours --no-commit -m "Merge
origin/<branch> into <name>, with #<n>'s head as base" -m "<the
session's attribution lines>" origin/<branch>`, `git restore
--source=<tree> --staged --worktree -- :/`, each file it named settled
from the plans, `git add -u`, no `leftover conflict marker` in `git diff
--cached --check`, and `git commit --no-edit`. A conflict left
unsettled takes the topic back to the tip it had before the first (`git
reset --keep <that tip>`, after `git add -u` and `git merge --abort` in
a merge with a base), so no part of them is pushed. "Built" gets
one line for the four, `Merged <branch> <date> past #<n>'s squash,
commits <sha>, <sha>: <files or none>`, a merge that was already up to
date naming no commit, and the two of the fallback a line each, as a
merge above.

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
  rewritten to it. A stacked plan's line ends `; stacked on #<n>.`,
  written when it lacks it; so does the line
  of a plan built on a topic already stacked on one not from a fork,
  when it names no pull request. A plan that shares files with an open pull request
  goes where its `Lands` line says; its author read the project's
  **Pull requests** heading.
- **No branch yet** (no `origin/<name>`, no local `<name>`): `git switch
  -c <name> origin/<base>`, the topic's base above, that branch the pull
  request's `--base`; when it is the head branch it is stacked on, the
  first line of its body is `Builds on #<n>; merge that first.`
- **A branch with no pull request yet** (`origin/<name>`, no open pull request): `git
  switch -C <name> origin/<name>`, then `origin/<base>` merged in, the
  topic's base above: the head branch it is stacked on, or
  `origin/<branch>` once that pull request is MERGED, is a fork's or its
  head is gone from origin; the plan's push carrying the merge, a merged
  parent's work coming in once (above); an unsettled conflict
  leaves it as it is.
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
`origin/<branch>` merged into its head, a merged parent's work coming in
once (above), and pushed.
Delete a local branch only when `gh pr view <name> --json
state,headRefOid` says MERGED at its own commit; others stay, named in
the final message.

**A topic left with no pull request** is opened: each topic `plans`
lists under `Topics waiting for a pull request` with `so the next plan's
start opens it`. `gh pr list --state all --head <name> --json
number,url,state,headRefOid,isCrossRepository`, a pull request from a
fork being another person's and not this topic's: one found open, or
merged or closed at `origin/<name>`'s commit, is written into each of
its plans' "Built" after the first line, `Pull request #<n> (<url>)
found <open | merged | closed> <date>.`. Its base is the topic's base
(above); a stacked topic whose base is `<branch>` gets its description
without the `Builds on #<n>` line. A topic that gets no pull request ("A
topic's base") is not opened: with none found, each of its plans'
"Built" gets the `No pull request:` line that paragraph gives. One with
none found that is stacked on a parent MERGED and not from a fork is
brought up to date first, as "A pull request is refreshed" does it: `git
switch -C <name> origin/<name>` (a local branch holding commits that
head lacks left and named), `origin/<branch>` merged in, a merged
parent's work coming in once (above), the project's checks, and `git
push origin <name>`; so the comparison reads the topic's own work, a
deletion of what the parent added included, and its pull request opens
with no conflict. Left unsettled, its checks failing or its push
refused, the branch goes back to `origin/<name>` (`git reset --keep
origin/<name>`) and the topic is opened as it stands, without the
comparison, and named. One with none found, and `origin/<name>` adding
something to its base (`git merge-tree --write-tree origin/<base>
origin/<name>` giving a first line other than `git rev-parse
origin/<base>^{tree}`, so work a squash merge took is nothing), is
opened as "Nothing else queued" says with `--head <name>` added and
`--base <base>`, from the branch the plan in hand is on, the description
written to `plans/<its last built plan>/pull-request.md`, each of its
plans' "Built" getting `Pull request #<n> (<url>) opened <date> with
plans/<the plan in hand>.md.`; none and no such branch, or nothing
ahead, gets `No pull request: <branch <name> is gone from origin | its
commits are on <base> already>.` in each. A create refused because
another executor opened it first is read again and written as found. The plan in hand's "Built" and its
`Built:` message name each.

**Then a conflicting pull request is refreshed**: each of the queue's
own that GitHub reports as conflicting (`gh pr view <n> --json
mergeable,baseRefName,headRefName,headRefOid`, `mergeable`
`CONFLICTING`; one still `UNKNOWN` is asked again once the others are
done, and named if it stays so), a pull request before the ones stacked
on it, by "A pull request is refreshed". Then `git checkout --detach
origin/<branch>`.

**A pull request is refreshed**: start from its head as GitHub has it,
`git switch -C <head branch> origin/<head branch>`; a local branch
holding commits that head lacks is left and named. Merge its base,
`origin/<baseRefName>`, in, a merged parent's work as "A merged parent's
work comes in once" says (one stacked on a pull request just refreshed
merges that one's new head); run the project's checks, not the suites,
since its CI runs on the push; push it with `git push origin <head
branch>`, never to the branch. Its plan's "Built" gets `Refreshed <date>: merged <base>, commit <sha>, <files>`. One that
cannot be settled is left and named.

**A refresh**, `Lands: refresh.`, is the assistant's plan after a merge
(decisions.md#merge-refreshes-the-rest): no branch, commit, review or
pull request of its own. After "At a plan's start", each pull request
the plan names that is still open and behind its base (`git rev-list
--count origin/<head>..origin/<base>` over 0), or conflicting, is
refreshed by "A pull request is refreshed". A plan that names none takes
every one of the queue's own but another person's (`gh pr view <n>
--json author`, neither a bot nor the token's own login), which is left
and named. "Built" opens with `Refreshed: #<n> at <sha>, #<m> at <sha>;
left: #<k>, <why>.`, or `Refreshed: nothing was behind.`, and says
`Codex review: not run (a refresh).`

**A topic's plan**: one commit per plan on the topic's branch, squashed
back to the plan's tip, so a commit another person pushed stays theirs;
where that would rewrite a pushed commit, push the plan's commits as
they are and name each in "Built". Then `git push -u origin <name>`,
retried as for a merge. Then, by the topic:

- **A pull request already open** (`gh pr list --state open --head
  <name> --json number,url,isCrossRepository`, one from a fork being
  another person's): the description written again from
  every plan of the topic to `plans/<this plan>/pull-request.md`, keeping
  the uploaded image addresses of its body (`gh pr view <n> --json
  body`), this plan's screenshots as local paths; then

  ```
  gh pr edit <n> --title "<the sentence>" --body-file plans/<this plan>/pull-request.md \
    --attach plans/<topic>/<file>.png#<the line> ...
  ```

  `--title` when the title is written again (description.md, "The title"), one
  `--attach` per local screenshot the body names.
  No comment: the description is the record
  (decisions.md#joined-pull-request). "Built" opens with
  `Pull request #<n> (<url>) joined, commit <sha>; <draft | ready>.`,
  its state as `gh pr view <n> --json isDraft` gives it.
- **No pull request**: run `plans topic plans/<this plan>.md` and follow
  its line (decisions.md#topic-landing). A topic that gets none ("A
  topic's base") opens nothing, whatever the line says.
  - **More is queued** (`… still queued for topic <name>: its pull
    request waits for …`): nothing opens. "Built" opens with `On topic
    <name>, commit <sha>, branch pushed; its pull request waits for <the
    paths the line names>.`
  - **Nothing else queued** (`Nothing else is queued for topic <name>:
    …`): the description (description.md), written from every plan of the topic
    so far, oldest first, to `plans/<this plan>/pull-request.md` and read
    back as the reviewer will, then:

    ```
    gh pr create --draft --base <base> \
      --title "<this plan's title, or the sentence for all of the topic's plans when it opens with several>" \
      --body-file plans/<this plan>/pull-request.md \
      --attach plans/<topic>/<file>.png#<the line> ...
    ```

    one `--attach` per screenshot the body names. "Built" opens with
    `Pull request #<n> (<url>) to <branch> from branch <name>, commit
    <sha>; draft.`, and each earlier plan of the topic gets, after its
    "Built" section's first line, `Pull request #<n> (<url>) opened
    <date> with plans/<x>.md.`

**Each issue it closes is linked** (decisions.md#closes-its-issues),
since GitHub shows a linked issue beside the pull request and the
description need not. After the create or the edit, read the links made
by hand, by the gh the pull request was written with:

```
plans gh api graphql \
  -f query='query($pull: ID!) { node(id: $pull) { ... on PullRequest { closingIssuesReferences(first: 100, userLinkedOnly: true) { nodes { number } } } } }' \
  -f pull="$(gh pr view <n> --json id --jq .id)" \
  --jq '.data.node.closingIssuesReferences.nodes[].number'
```

Only those, since a link GitHub made from an old `Closes` line goes
with the line. Link each issue the topic's plans name that is not
among them:

```
plans gh api graphql \
  -f query='mutation($issue: ID!, $pull: ID!) { addCloseIssueReferences(input: { issueId: $issue, pullRequestIds: [$pull] }) { issue { number } } }' \
  -f issue="$(gh issue view <i> --json id --jq .id)" \
  -f pull="$(gh pr view <n> --json id --jq .id)"
```

One that is refused is not tried again in this landing: the
description is written once more as a join writes it, with `Closes
#<i>.` for that issue, "Built" and the `Built:` message say `Not
linked: #<i>, <gh's line>.`, and the queue's close at the merge reads
the line.

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

**A fix that is not one**, a commit that decides something, lands as
`topic <the plan's file name without .md>`, its `Lands` line rewritten
to it, its "Built" and the final message saying why
(decisions.md#fix-landing): it changes what a person sees or does in a
way no rule the project holds settles, or adds, changes or strikes a
rule with the owner's or another person's name. A change to tests, and
a line in the catalogue or a doc that only records how the product
already works or how a test is written or run, leave it a fix.

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
body as above and set it without `--attach`, with the same line under
`## To try it`. A pull request a refused create opened gets its body
replaced, never a second; a refused `gh pr edit` that set part of the
body is read back (`gh pr view <n> --json body`) and set again. The
cause is `This container's gh is older than 2.99.` when gh's own line is
`unknown flag: --attach`, else gh's own line. "Built" and the `Built:`
message say the same.

**The checks are not waited on** ("A push is not waited on"): after the
push and the pull request's create or edit, start the next plan; run no
`gh pr checks` and no `gh run watch` on a pull request. A run that fails
there comes back by the app's webhook as a short plan; the Stop hook
names a failed check the webhook does not bring (any with no webhook, another service's
with one), fixed and pushed before
the next plan. The project's `run` is read only for a fix pushed
straight.

**After the plan's push**, `git checkout --detach
origin/<branch>`; keep the local branches, the hook's match for pull
requests.

**The `Built:` message to the assistant leads with** each pull request opened or joined, its
link and what it was marked related to, for a topic stacked on a pull request closed without
merging, that line of its "Built", or with that branch gone `Topic
<name> has no pull request: #<n>, which it is stacked on, was closed
without merging and its branch is gone, so its pull request would bring
that work back. To open it with #<n>'s work in it:
<address>/compare/<branch>...<name>?expand=1` (`<address>` from `gh repo
view --json url --jq .url`), once a topic, by the plan whose landing or
recovery first writes that line, and, for a draft: `Pull request
#<n> (<link>) is a draft and waits on you: read its description and
screenshots, then mark it ready for review on GitHub (the Ready for
review button at the bottom of the pull request). Until then it asks
nothing of anyone else.`; for one he marked ready, that it stays ready,
its checks running again, and the merge his; then each topic whose pull
request waits, with the plans it waits for, and each one opened or found
at this plan's start, the day's fixes pull request, and the fixes pushed
straight.

**The description and the title** of a pull request, a topic's or the
day's fixes', are written as `description.md` says, the file beside
this one: read it whole, when it is not already in front of you, before
one is written or written again (decisions.md#step-file-length).
