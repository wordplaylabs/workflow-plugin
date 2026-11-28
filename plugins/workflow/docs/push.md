# The push and after

The executor reads this whole once a plan's steps are built, and again
before it writes "Built" when it is no longer in front of it
(decisions.md#agent-file-length). `<the owner>` is the owner's name and
`<the plugin>` the plugin's folder, as the agent file gives them. A
name in quotation marks that is no heading here is a rule of the
handbook or a heading of the agent file ("Before the first edit", "A
question is decided, not asked"). With `land: pull-request`, "push" is
the landing the agent file names.

## Before the push

1. When **Before the push** asks for screenshots: look at each and fix
   what is wrong; they stay in `plans/<topic>/`, sent by nobody here,
   attached to the pull request by the landing, and the `Built:` message
   names each by path with what it shows.
2. The reviews `reviews` names ("A second model reviews every plan's
   diff"; all three when the key is absent, none when it is empty):
   1. `codex`: in the background, a Bash command, never during a suite:
      `<the plugin>/scripts/codex-review.sh origin/<branch>
      <file> "<plan title>"`, `<file>` the absolute path of
      `plans/<topic>/codex-review.md`.
   2. `plan`: `workflow:reviewer` with the plan's path, the branch, the
      choices you made on purpose, each screenshot by path with what it
      shows and its When … then … line, and the catalogue files the Words
      table's Kind column names.
   3. `code-review`: `/code-review medium`, which reviews
      `@{upstream}...HEAD` (`git branch -u origin/<branch>` when the
      branch tracks nothing).
   4. A plugin skill named (`writing:review`), invoked on the diff's
      files after the plan review.
   Then read them all. Fix what is real in the reviewer's, the verified
   `/code-review` findings and a skill's; a string a fix needs comes by
   "Before the first edit" step 3. Settle each Codex finding at its file
   and line: **fixed**, with a test where the plan's tests allow; **not
   a bug**, with the reason in a clause; or **out of scope**, a "Needs a
   decision" item. A Critical or High finding you cannot refute is fixed
   or becomes an item.
3. The checks and suites **Before the push** names, in its order, once a
   plan. Report counts as they
   came, failures with their output. A failure in a file you did not
   touch and the plan does not name is the owner's when it fails the
   same at `origin/<branch>` (`git switch --detach`, run it, switch
   back): reported in "Built" with its output, not fixed. One your
   change causes is yours to fix. A step the project file writes as
   `plans hold <name> -- <command>` is run as written, in the background
   as a suite is; while it waits or runs, edit no source ("A heavy step
   takes a slot").
4. Commit and push: one commit a plan, with the session's attribution
   (`git reset --soft <start>`, `<start>` the commit `git rev-parse HEAD`
   gave when the plan's branch was taken: another executor may have
   pushed since, and a squash onto its push would undo it). Stage the plan's files by path, the
   ones its diff touched, never `git add -A` or `git add .`; before
   committing, read `git status --porcelain`: an untracked file you did
   not write stays untracked. `git push origin HEAD:<branch>` as a
   fast-forward; refused, `git fetch origin && git rebase
   origin/<branch>` and push again. Refused for credentials ("could not
   read Username", "Authentication failed", "Permission denied") or with
   `gh` missing: try once more, then write `Not pushed: <cause>` in
   "Built" and the final message with the fix ("Installing"), and leave
   the commit on the branch. Never a token in a URL, a remote or a
   config, never another remote. Without `gh`, a public repository's run
   is read through `curl -s
   https://api.github.com/repos/<owner>/<repo>/actions/runs?branch=<branch>&per_page=1`;
   a private one's is unread, and "Built" says so.
5. Push and go on ("A push is not waited on"): watch no pull request's
   checks, which repeat what you just ran; one that fails comes back as
   a short plan. Only a `run`, the workflow the project file names for
   what the local checks cannot do, is read, after a push straight to
   the branch: note its id (`gh run list --branch <branch> --workflow
   <run> --limit 1`) and read it before your next push and before the
   final message (`gh run watch <id> --exit-status`, a failed job's log by
   `gh api repos/{owner}/{repo}/actions/jobs/<id>/logs`). A failed `run`
   is fixed before anything else is pushed. Then **After the push**.
   After the push, `git checkout --detach origin/<branch>`.

## After

- **"Built"**: write `## Built, <date>` under "Decided" by "An agent's
  report is short": the landing line (branch and commit, or the landing's
  line), one line for the "Done when" lines that hold with the commands
  and counts, a line per one that does not hold or was checked another
  way, a short table of suite counts with a `Codex` row, the
  deviations, a line per decision taken, `Taken on <the owner>'s standing word: <the question, in a clause>. <The option>, checked with <<chat's name>, which <agreed | named it over <yours> | did not answer before the commit> | nobody, no chat being open>. <Cheap to undo by a follow-up | Undoing it costs <what>>.`,
  then "Needs a decision": each item in a few lines, what you found,
  where, why it is not yours, the options, and its size, **assistant** (a
  change said in a few sentences, no named rule reversed, no schema,
  privacy or new word) or **planner** (anything else; when unsure, the larger), else `Needs a decision: nothing.`; then `Codex review: <n> findings; fixed C1; not a
  bug C2 (<why>); out of scope C3 (Needs a decision)`, or `not run
  (<the script's reason>)`; then `Usage: <n> percent of the five-hour window`, from `usage.json` in the plugin's data directory, read at the plan's start and here. Take the
  Building line out.
- **A `For` section** (`## For <Project>: plans/<topic>.md`) is a brief
  for another queue ("A change the plugin leaves for the project it came
  from goes back as a brief"). After the push, with the checkout its
  plan's `From` line names, write `<path>/plans/<topic>.md`: `#
  <Title>`, then `Brief for the planner, <date>, by <session> from <path>/plans/<x>.md (commit <sha>). The planner's plan replaces this file.`, then its `###` parts as `##`. A file there that names this
  plan's path stands; any other stays, and the brief takes the first
  free `<topic>-<n>.md` from 2. Then `cd <path> && plans start --agent
  planner plans/<the file>`, and send the message it prints, once. One
  line in "Built" per section: `For <Project>: <path>/plans/<topic>.md written; <planner started as <name> | handed to <name> by message |
  leased to <name> | already there, written by hand | not started: <the
  command's line>>.` Without a `From` line, a "Needs a decision" item
  sized assistant. Do this before the final message.
- **Memory**: what the next session needs and the repository does not
  record goes in a memory note, with a line in the index.
- **The assistant is told**, for every plan, with items or without
  ("Handed to the assistant"), one message after the push, or after
  `Not pushed: <cause>` with that line in it, its first line `Built:
  plans/<x>.md.`:

  ```
  Built: plans/<x>.md.
  <The landing line.> <What the project now does, as When … then ….> <What waits on the owner, or nothing.> <Each screenshot or file made for him, by path, with what it shows.>
  ```

  To this project's `<Project> Assistant` on this machine by
  `ListAgents`; with none, `plans start --agent assistant
  plans/<x>.md` opens it, or names the one open, and the message goes
  to it.
- **The final message** is the record, two lines: what was pushed, and
  how the plan was handed on.
