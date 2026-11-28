# A pull request's description

The executor reads this whole before it writes a pull request's
description or title, or writes one again, where `land: pull-request`
(decisions.md#step-file-length). `landing.md`, beside it, has the
commands that send them, and a rule named here in quotation marks that
is no lead-in of this file ("A topic's base", "Each issue it closes is
linked") is that file's.

**The description** is a short list of what changed
(decisions.md#short-description): the main changes shown, the smaller
ones folded, housekeeping left out. Plain words, no dashes, the
project's spelling, each line's words from the plans or the catalogue, a
commit's title as written; on one screen with the fold closed, pictures
aside. It is written for the pull request as it stands, so a fix to what
an earlier plan of it added changes that line's sentence and adds none.

```
<The owner's paragraphs, word for word, when the body has some>

Closes #<n>.                                  <- only for an issue that could not be linked
Builds on #<n>; merge that first.             <- while its base is the head it is stacked on
<!-- workflow: stacked on #<n> -->            <- in its place once its base is <branch>

Related:                                      <- when a plan has a Related line

- #<n>
- branch `<name>`

## Changes

- **<A main change, two to five words.>** <One sentence of what a
  person can now do or see.>

  ![<What the picture shows, in one line.>](plans/<topic>/<file>.png)

- **<A main change.>** <One sentence.>

<details><summary>Other changes</summary>

- <A smaller change, one short sentence.>
- <The commit's title.> (<author>)

</details>

## To try it

<One line.>

<The owner's own sections, word for word, when the body has some>

<the attribution lines the session gives for a pull request, with any link
to a Claude session left out>
```

- **The owner's paragraphs**: on a rewrite (`gh pr view <n> --json
  body`), everything above the body's first `## ` heading, less its
  `Closes #`, `For #`, `Builds on #`,
  `<!-- workflow: stacked on #` and `Related:` lines and the list under a
  `Related:` line, is the owner's
  and opens the new body unchanged; a `Closes #` line for an issue no
  plan of the topic names is the owner's too, and is kept. With nothing
  there, the body opens with the lines that apply, so a pull request
  written again loses an older `For #<n>.` line and the queue's own
  `Closes #<n>.` lines, each issue linked instead. So is every `## `
  section whose heading the
  template does not name: it follows To try it, word for word, in the
  order the body has it. Write no opening paragraph of your
  own: the title is the summary.
- **Closes** and **Related**: no line for an issue that is linked. Each
  issue a plan of the topic names in its `Issue` line is linked to the
  pull request and shown in its Development sidebar ("Each issue it
  closes is linked"); `Closes #<n>.` is written only for one whose link
  was refused, one line each (decisions.md#closes-its-issues). Then one
  `Related:` line, then a list of everything the topic's plans'
  `Related` lines name, each once, one item a line with nothing else on
  it, numbers in order and then branches by name, less an issue a plan
  of the topic names in its `Issue` line, a number a `Closes` or `Builds
  on` line names and the pull request itself; none
  left, no `Related:` line. Look for no related work yourself, and
  comment on no other person's pull request.
- **Builds on**: a topic stacked on #<n>, not a fork's, says so in its
  body on every write, `<n>` as "A topic's base" reads it from the
  topic's plans' `Lands` lines, else as the old body's own line gives
  it: `Builds on #<n>; merge that first.` while its base is that head,
  and once its base is `<branch>` the comment
  `<!-- workflow: stacked on #<n> -->` in its place, which GitHub shows
  nobody and no rewrite drops (decisions.md#plans-account-for-commits).
- **Changes**: the main changes, five bullets at most, oldest first. A
  main change is a plan's central decision, what its title says the
  project now does; plans that did one thing share a bullet. Under five,
  a "Done when" scenario a person sees joins them when it is a thing of
  its own, not a state of a bullet already there. Over five, keep this
  plan's, then what the title it has names, then what a person meets
  before what is behind it, then the older; the title is judged after
  the five are picked ("The title"). The bold lead is the thing; the sentence, plain and one line of what it does, has no tier, date, struck rule or
  catalogue id. A bullet whose change replaces a rule with another
  person's name says so in its sentence, `replacing <name>'s call`, is a
  main change whatever its size and goes first, past five if more than
  five do (decisions.md#decision-has-a-name). A decision taken after
  thirty minutes unanswered says `taken for <the owner>, unanswered` in
  its line, here or under Other changes, and one taken in place of a
  question (a `Taken on` line of "Built") says `taken for <the owner>`.
- **Other changes**: everything else a person can now do or see, in a
  closed section under the bullets, `<details><summary>Other
  changes</summary>`, a blank line before and after its list: each
  scenario a person sees that is no main change and a plan's small
  changes, one plain sentence a line, 100 characters at most, with no
  lead, what several plans did to one thing in one line, oldest first.
  Then, last, a line per commit on the topic's branch that this
  checkout's plans do not account for (`git log
  origin/<base>..origin/<name> --format='%H%x09%an%x09%s'` after the
  push), as `- <the commit's title> (<author>)`, another person's merge
  included (decisions.md#plans-account-for-commits). Accounted for: this
  plan's commits and merges (`git log --first-parent <tip>..HEAD
  --format=%H`, and a merge this plan made before its tip); a commit a
  plan of the topic names by hash in its "Built", the shorter a prefix
  of the longer; on a branch stacked on a pull request since merged, the
  commits of each merged pull request down the stack: the topic's parent
  is the `stacked on #<n>` "A topic's base" reads from the topic's plans'
  `Lands` lines, a parent's own parent the `stacked on #<n>` of that pull
  request's plans' `Lands` lines in this checkout, and either, with no
  such line, the line of the body above it, `Builds on #<n>` or, once
  the base is `<branch>`, `<!-- workflow: stacked on #<n> -->` (`gh api
  --paginate repos/{owner}/{repo}/pulls/<n>/commits --jq '.[].sha'`).
  Nothing is left out by author or by title. With no line, no section.
  An old fold is not the owner's, and ends his section.
- **Left out**: housekeeping, which changes nothing for a person once
  the pull request is merged: a merge of the base and a refresh, a
  test's timeout or flake, and a fix to what this pull request itself
  added, a later plan's as much as a review's. This is about what the
  plans did; a commit no plan accounts for is listed whatever its title.
  A pull request whose plans did nothing else lists these as its
  bullets, so Changes is never empty.
- **Screenshots**: one under a main bullet at most, none under Other
  changes, only where it shows exactly what the bullet added or changed,
  in light mode at desktop width; dark mode or a phone width only for a
  bullet about the theme or about that width; its line, what the picture
  shows, is its alt text and the `#<the line>` of its `--attach`. Only
  the ones the body names are attached. On a rewrite, a picture whose
  bullet is no longer a main one leaves the body.
- **To try it**: a line from the project file's "After the push", else
  "Check out the branch."
- **The title** is one sentence saying what the whole pull request
  does now (decisions.md#pull-request-title), in the words of the
  leads under Changes, with no number and no plan's name. A plan alone
  in it gives its own title. On a join or a rewrite, read the one it has
  (`gh pr view <n> --json title`). One that is not the queue's last, the
  `Title:` line of the topic's latest "Built" that has one, else its
  first plan's title, is a person's: it stays, and "Built" says `Title
  kept: a person's.` The queue's own stays while it covers every
  main change, and is written again when this plan adds one
  it does not cover: the first plan's thing, then what was added, or
  the area they share when that is more than three things. "Built"
  gets `Title: <the sentence>` after its first line whenever the
  executor sets one.
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

<details><summary>Other fixes</summary>

- <The commit's title.>

</details>

## Already on <branch>

- <The commit's title.> (<the commit's short sha, linked>)

## To try it

<One line.>

<The owner's own sections, word for word, when the body has some>

<the attribution lines the session gives for a pull request, with any link
to a Claude session left out>
```

- **Fixes**: five fixes at most, oldest first; over five, this plan's,
  then what a person meets before what is behind it, then the older.
  Each is the commit's title, its screenshot by the topic's rule: one at
  most, none under Other fixes, light mode, desktop width, only where it
  shows the fix. A fix that replaces another person's call goes first,
  past five if need be, as a topic's bullet does. The other fixes follow
  in a closed `<details><summary>Other fixes</summary>`, a title a line,
  oldest first; with none, no section. Housekeeping is left out as in a
  topic's, and listed when the day's fixes did nothing else, so Fixes is
  never empty.
- **Already on <branch>**: the day's fixes pushed straight, from `git log
  origin/<branch> --first-parent --since=<the day's start> --format='%h
  %s'`, without merge commits and commits whose title ends in ` (#<n>)`;
  with none, no heading.
- **To try it** and **the attribution**: as the topic's description.
