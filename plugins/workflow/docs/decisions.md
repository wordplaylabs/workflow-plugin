# The workflow's decisions

The plugin's own catalogue, in the shape "The catalogue is the record"
asks of every project: one entry per rule of the handbook
(`docs/workflow.md`), which cites each as `decisions.md#<id>`, with its
tier and date, its reason and the plans that decided it. The rules are
in the handbook; why each was decided is here. The plans are in `plans/`
on the machine that planned them. An entry says its rule as it stands;
how it was decided before is in this file's history (`git log -p --
plugins/workflow/docs/decisions.md`, searched for the entry's id).

## The agents

- `plan-then-build` **A change is planned by one session and built by
  another, with the context cleared between.** (per Anthropic's best
  practices, 27 October) Anthropic's own advice is to interview with the
  question tool, write a self-contained spec and execute it in a fresh
  session; spec-driven development does the same without its ceremony.
  The plan is the spec for one change; the docs are the standing context
  that outlives it.
- `brief-is-a-prompt` **A brief or a plan is a prompt for the agent that
  reads it, in four parts: what was asked, decided, done when, where to
  look.** (Javi, 2 November) Claude Code's best practices ask for a
  written definition of done and something that comes back pass or fail,
  and cut what the reader would find by looking; its prompt library's
  six patterns (outcome, check, reference, target, artifact, answer's
  form); Anthropic's prompting best practices give the why and number
  steps only when order matters. plans/briefs-and-plans-as-prompts.md.
- `agent-file-is-instructions` **An agent file is the agent's
  instructions, each rule once, short, with the why in this catalogue;
  a start prompt names the work.** (Javi, 6 November) Anthropic's Claude
  Code best practices say every line of an always-loaded file takes a
  little of Claude's attention on every task, that a line Claude keeps
  missing is lost in a long file rather than cured by emphasis, and
  that a procedure needed only sometimes is read only when the task
  calls for it; its context engineering post asks for the smallest set
  of high-signal tokens at the right altitude, sections with headings,
  and instructions added only on observed failure; its Claude 4 best
  practices ask for clear, direct instructions a colleague with minimal
  context could follow, with the why given so the model generalizes
  from it, what to do rather than what not to do, and softened
  language, since emphasis makes a rule over-applied. HumanLayer keeps
  its root file under sixty lines and reads the research (IFScale,
  arXiv 2507.11538) as frontier models following about 150 to 200
  instructions with reasonable consistency, a budget the agent file
  shares with Claude Code's own fifty; the four big agent files were 30
  to 57 thousand characters, each rule in two or three of them. The
  start prompt said again what the agent file says, and was partly
  wrong. plans/simpler-agents.md, plans/simpler-agent-files.md.
- `report-is-short` **An agent's report is short: what changed, what
  waits on the owner, the evidence by command and count, nothing the
  plan says.** (Javi, 6 November) He reads the final messages on his
  phone and "Built" sections to find what is his to act on, and both
  restated the plan's "Done when" line by line; Claude Code's best
  practices ask for evidence, the command run and its output, rather
  than "all tests pass", and for short summaries back; Anthropic's
  context engineering post has a sub-agent return one to two thousand
  tokens of a run that spent tens of thousands; its Claude 4 best
  practices say to prompt explicitly for conciseness. plans/simpler-agents.md.
- `behavior-as-scenario` **A behavior a person sees is written as a
  scenario, When <what they do>, then <what they see>, one per line, each
  in a plan's Done when naming its test.** (Javi, 2 November) As OpenSpec's
  and Kiro's acceptance scenarios: a line the owner reads as what he will
  see, and the executor turns into one test. A scenario looked at on
  screen has the screenshot that shows it, which the plan review reads
  (Javi, 2 November). plans/behavior-as-when-then.md,
  plans/behavior-as-when-then-follow-up-2.md.
- `reading-beside-a-build` **The checkout is for reading: the planner and
  the assistant read the project there, from the project's branch when
  the tree is dirty.** (Javi, 27 October) A plan must not rest on
  half-built files; nobody builds in the checkout since each executor
  has a worktree, so the rule covers a tree someone left dirty.
  plans/executors-build-in-worktrees.md.
- `bounded-sweeps` **The planner and the assistant read the specifics
  themselves and hand out only bounded, read-only sweeps.** (Javi, 27
  October) A subagent's summary drops the detail a plan names, and a
  sweep that writes would be a second builder.
- `built-once-written` **A plan is built once it is written; order is
  asked only when another plan already waits.** (Javi, 27 October) A
  question about order costs the owner a round for nothing; a dependency
  belongs in the plan, where the executor reads it.
- `which-session` **The assistant ends every topic in one of four exits:
  answered, a person's call, a short plan or a brief.** (per Anthropic's
  best practices, 27 October; the second exit Javi's, 2 November) A diff
  you can describe in a sentence needs no plan; Shape Up keeps a small
  batch and a big batch apart, each with one way in. The person's call is
  said in a line, its message drafted only on request, as
  `group-message`. plans/messages-for-people-only-on-request.md.
  - ~~The assistant ends every topic in one of four exits: answered, a
    message, a short plan or a brief.~~ (per Anthropic's best practices,
    27 October)
- `idea-asked-first` **An idea is asked about before anything is
  written: an issue, a brief or not yet.** (Javi, 4 November) Ideas went
  from a sentence in the chat to a built draft pull request before he had
  sat with them, and several felt premature once he looked; one question
  puts the friction where the idea is, and a fix, which has nothing to
  sit with, asks nothing. The issue is offered only with `land:
  pull-request`, since issues need pull requests.
  plans/ask-before-briefing.md,
  plans/related-plans-share-a-pull-request-follow-up-6.md.
- `new-topic-to-assistant` **Every new topic starts in the assistant's
  chat.** (Javi, 30 October) A planner's chat holds the plans it wrote
  until an executor takes them; a new topic there would mix two plans in
  one context. plans/agents-pass-messages-directly.md.
- `chat-that-heard-it` **The chat he said it in writes it, and the agents
  pass the rest.** (Javi, 30 October) What he wanted gone was the
  copying between chats, and a pause until he has looked is fine; a
  peer's message is never the user's consent (Claude Code's own rule), so
  a relayed word is confirmed in the receiving chat.
  plans/agents-pass-messages-directly.md.
- `handed-to-the-assistant` **An executor's and a planner's follow-ups go
  to this project's assistant chat on this machine, started when there is
  none.** (Javi, 31 October) Four follow-ups and several decisions went
  into a final message nobody acted on once the to-do page was gone. A
  plan with a decision taken for the owner goes too, as one with items,
  so the assistant logs it. plans/agents-pass-messages-directly.md,
  plans/executor-never-waits.md.
- `asked-in-plain-words` **A question to the owner is written for a
  reader on a phone with none of the chat in front of him.** (Javi, 28
  October) Apple's alerts (a title that says what it is about, buttons
  that name the result); Nielsen Norman's confirmation dialogs; GOV.UK's
  question pages and clear language; Anthropic's note that the dialog may
  be all that is on the screen. plans/owner-questions-plain-and-once.md.

## The project file

- `project-file` **A project's part is one file, `.claude/workflow.md`:
  frontmatter the hooks read and a body the agents read.** (as Claude
  Code does, 27 October) The shape Claude Code uses for agents and
  skills, so nothing new is learned to write one.
- `compact-form` **`form: compact` is one chat that decides and builds;
  absent, the full form.** (Javi, 27 October) A project whose changes are
  small and many does not pay for a queue; the two forms share the
  catalogue, the headings and the branch, so a project moves between
  them by one line. A talk is this form with a project file (`mcp`,
  `inherits`, `tools`, `catalogue`, no `branch`), opened by `plans chat`,
  its slide steps a skill of its own workspace (Javi, 27 October).
  plans/sizes-and-decisions.md, plans/sizes-and-decisions-follow-up.md.
- `chats-open-as-the-agent` **A project's chats open as its agent, set
  in the project's own local settings, never by the plugin.** (per
  Claude Code's changelog, 2.1.323, 14 November) Claude Code deprecated
  a plugin's `agent` setting and says to set `agent` in your own
  settings or pass `--agent`; a setting of one's own opens the agent
  with no warning, and one naming an agent that is not installed opens
  Claude Code's default (tried on 2.1.325). The local file, since
  whether a person has the plugin is theirs, a tracked file changed at
  a session's start would dirty the checkout, and Claude Code gives
  that file to one person's overrides for one project.
  plans/agent-set-by-the-project.md.
- `land-by-pull-request` **With `land: pull-request`, a plan lands by its
  `Lands` line: a topic's pull request, the day's fixes or straight to
  the branch.** (Javi, 30 October) A pull request per topic when the
  topic has its central decision or two substantial ones; the fixes, with
  no decision, one pull request a day; one wanted at once straight to the
  branch. The author of the plan heard the owner say whether he wanted
  the thing or only a start. plans/land-by-pull-request.md,
  plans/pull-requests-by-topic.md.
  - ~~One pull request per plan.~~ (Javi, 28 October; made nine in a
    day)
- `topic-landing` **A topic's plans are built on one branch, pushed after
  each, and its pull request opens with the first plan marked ready.**
  (Javi, 30 October) The branch survives the container and the people
  can look at it before it asks anything of them; a later plan with a
  central decision of its own is a new topic; a plan with no `Lands`
  line is a topic of its own, so nothing lands unread by omission.
  plans/pull-requests-by-topic.md.
- `joined-pull-request` **A later plan joins an open pull request: the
  description is written again, its screenshots attached with `gh pr edit
  --attach`, and nothing is posted.** (Javi, 31 October) The description
  is what he reads when he reviews it, and a draft asks nothing of anyone
  else. plans/joined-pull-request-no-comment.md.
  - ~~A later plan joins an open pull request: the description is
    written again and one comment says what was added, since GitHub tells
    the people of a comment and not of a push.~~ (Javi, 28 October)
- `fix-landing` **A fix, a short plan with no decision that changes no
  catalogue or doc rule, goes into the day's fixes pull request.** (Javi,
  30 October) A fix has nothing to decide, so it asks nobody's reading;
  one whose commit changes a rule lands as a waiting topic, since review
  beats silence. plans/pull-requests-by-topic.md.
- `fix-now-landing` **A fix wanted now, on the owner's word only, is
  pushed straight to the branch and listed in the day's fixes.** (Javi,
  30 October) A fix the site needs today cannot wait for a merge.
  plans/pull-requests-by-topic.md.
- `short-description` **The description is a short list of what
  changed: a few bullets, each a bold lead and one plain sentence of
  what a person can now do or see, one screenshot under a bullet only
  where it shows it, then To try it; no tiers, dates, struck rules or
  ids.** (Javi, 8 November) Nobody read the long one; the decisions are
  in the catalogue, whose diff the pull request shows; Google's CL
  descriptions guide puts one summary first and the detail in an
  informative body, GitHub's "How to write the perfect pull request"
  says what the change does and shows it. A bullet that replaces
  another person's call names them; the commits no plan here accounts
  for stay, as bullets with their author. A section the owner adds
  anywhere in the body, a topic's or the day's fixes, is kept on every
  rewrite (Javi).
  plans/short-pull-request-descriptions.md,
  plans/short-pull-request-descriptions-follow-up.md.
  - ~~The description is the catalogue's diff: New, Changed and Retired,
    each entry as the catalogue stores it, a conflict first, each
    screenshot under its decision, then Also and To try it.~~ (Javi, 31
    October; replaced 8 November, nobody reading the diff of decisions
    in a description)
- `stack-only-on-use` **A plan that rests on an open draft pull request
  of the queue's own lands in it, and one that rests on another person's
  is stacked on it.** (Javi, 7 November) A draft is not done yet, so
  work that belongs to it goes into it, as he had to ask three times in
  a day for a stacked pull request to be joined into the draft it built
  on; the queue never pushes to another person's branch. How the rest
  group is the project's, since grouping is a cost the project carries,
  not the plugin. plans/stack-only-when-it-depends.md,
  plans/draft-takes-its-follow-ups.md,
  plans/related-plans-share-a-pull-request.md.
  - ~~A plan that rests on an open draft pull request of the queue's own
    lands in it; one that rests on a pull request marked ready, or
    someone else's, is stacked on it; one that only changes the same
    file is neither.~~ (Javi, 4 November)
  - ~~A plan that rests on an open pull request (uses what it adds) is
    stacked on it; one that only changes the same file is not.~~ (Javi,
    30 October)
- `pull-requests-heading` **How plans group into pull requests is the
  project's rule, under `## Pull requests` in its file; the plugin
  suggests one at setup and holds none.** (Javi, 7 November) Grouping is
  a cost the project carries, each pull request one more review and one
  more run of its suites, so the project says it; Gerrit's
  submit-whole-topic is a server setting for the same reason. The first
  project to say it chose that related plans share one pull request.
  plans/related-plans-share-a-pull-request.md.
- `merge-never-force` **A branch is brought up to date by merging, never
  force-pushed.** (Javi, 29 October) Merge, never force, which a project
  may enforce in its settings; a squash merge keeps the merge commit off
  the branch, and another person's commits on it stay as they are.
  plans/refresh-by-merge.md.
- `refresh-only-your-own` **The executor refreshes only the queue's own
  pull requests, those its plans name as their own, with the checks
  alone.** (Javi, 3
  November) The pull requests open as the project's app, so who opened
  one no longer tells them apart, and the checkout's plans name the
  queue's own; another person's pull request is refreshed by their own
  executor, and the suites run in the pull request's CI on the push.
  plans/refresh-only-your-own.md, plans/plans-as-github-issues.md.
  - ~~The executor refreshes only its own person's pull requests, with
    the checks alone.~~ (Javi, 30 October)
- `merge-refreshes-the-rest` **A pull request merged into a branch
  brings the queue's other open pull requests on it up to date: the
  merge reaches the assistant, which writes one refresh plan, put
  first.** (Javi, 15 November) In the project that asked, five merges
  in a day left three of the queue's pull requests conflicting and two
  red on a rule the branch had already fixed, each found only when he
  asked. GitHub's Update branch and Mergify's `update` merge the base
  into a pull request that is behind, and Bulldozer does it when the
  base moves; behind and not only conflicting is Renovate's
  `behind-base-branch`, since a pull request's checks ran against the
  base as it was. One plan for all, as the three the assistant wrote
  there by hand; another person's is left (`refresh-only-your-own`).
  A rerun keeps the commit and ref of its first run (GitHub's
  "Re-running workflows and jobs"), so a failure the diff does not
  explain on a pull request behind its base is refreshed. Workflow job
  is not read: its run's failure arrives when the run ends, and a
  rerun needs that. plans/merged-pr-refreshes-the-rest.md.
- `draft-until-reviewed` **A topic's pull request opens as a draft and
  stays one until its owner has reviewed it himself; once he marks it
  ready, it stays ready when work is added to it.** (Javi, 15 November,
  the draft since 30 October) No pull request asks anyone else's time
  until he has reviewed it; GitHub's draft pull requests, which nobody
  can merge until the author marks them ready; Gerrit's work in
  progress, visible to anyone and asking nothing of a reviewer. Once
  ready, a joining plan's push runs its checks again and the merge stays
  his, so making it a draft again only had him press Ready for review
  once more, three times on one pull request in a day; the Stop hook
  reads a draft's checks as any open pull request's.
  plans/owner-reviews-before-anyone-else.md,
  plans/no-agent-marks-ready.md, plans/draft-says-nothing-about-itself.md,
  plans/ready-stays-ready.md.
  - ~~A plan that joins a pull request its owner marked ready runs `gh pr
    ready --undo` before its push.~~ (Javi, 30 October)
  - ~~A pull request opens ready, never as a draft.~~ (Javi, 28 October)
- `mcp-configs` **`mcp` names the MCP configs a chat here needs, which
  every chat the queue starts passes on the command line.** (Javi, 27
  October) The tools then exist in the project's chats and nowhere else,
  and a token in a config stays where the config keeps it.
  plans/sizes-and-decisions-follow-up.md.
- `deny-key` **`deny` keeps an agent off a tool the project gives
  another.** (Javi, 27 October) A plugin agent's frontmatter cannot be
  extended from a project, and a settings deny holds for every agent
  alike, so the hook is the one place a per-agent deny can live.
  plans/deny-key-review-findings.md.
- `body-headings` **The project file's body headings are the executor's
  steps for this project: Before a build, While working, Before the push,
  After the push, Reading, Products, People, Issues, Pull requests.**
  (Javi, 27 October) A project's own steps belong in its file, so no
  agent or script names a project's specifics.
  plans/sizes-and-decisions.md, plans/land-by-pull-request.md,
  plans/related-plans-share-a-pull-request.md.
- `setup-interview` **A project is set up in a short interview,
  `/workflow:setup`, with the defaults of its kind.** (Javi, 27 October)
  A project file written by hand drifted from what the queue reads; the
  interview asks once and says what each thing turned on costs. In a
  project landing by pull request it asks how plans group into pull
  requests and writes the answer under `## Pull requests`; it offers
  issues only with pull requests, recommended when someone besides the
  owner builds here, and keeps them only so, since issues assume pull
  requests: a run again that ends without pull requests takes out issues
  and the Pull requests heading, and says so. It writes the agent
  a plain chat opens as. plans/project-setup-interview.md,
  plans/related-plans-share-a-pull-request.md and its follow-ups 1 to
  6, plans/agent-set-by-the-project.md.
- `connectors-off` **A project turns off the claude.ai connectors it does
  not use, whole, in its own settings.** (Javi, 27 October) The account's
  connectors otherwise reach every chat in every project; a project
  setting holds there and nowhere else, and the local file keeps the
  names out of a public repository. plans/setup-scopes-connectors.md.
- `no-project-file` **A project with no project file is not the
  workflow's: the hooks do nothing there.** (Javi, 27 October) A project
  with hooks of its own keeps them until its file lands.

## Decisions

- `catalogue-is-the-record` **The catalogue is the record: each rule a
  bold list item with its tier and date, read there and nowhere else.**
  (Javi, 27 October) What is not there was not decided, as far as the
  next agent can tell; one place to read a tier means one reader for the
  audit, the hook and the lint. An entry is rewritten when its rule
  changes (Javi, 24 November): in a month the plugin's own catalogue had
  grown to 61 KB, a quarter of it dated notes telling how each fix was
  reached, which no agent needs to follow the rule.
  plans/sizes-and-decisions.md, plans/tier-pattern-and-readme.md,
  plans/workflow-sweep-docs.md.
- `only-well-formed-opinions` **The catalogue is only for well-formed
  opinions, researched or given by a person; anything not in it is
  assumed to have no reason and is free to change.** (Javi, 30 October)
  The first project's catalogue had grown past six hundred rules, 138 of
  them the agent's choice, a record of details anyone can see by
  looking; Nygard's and MADR's records are for significant decisions,
  Bezos's two-way doors get a light process, GOV.UK admits a pattern that
  is useful and unique. plans/log-only-decisions-with-a-reason.md.
- `catalogue-inherits` **A catalogue inherits others, farthest first; the
  project's entry of the same id overrides an inherited one and says
  so.** (Javi, 27 October) A workspace's or a talk's rules are written
  once and overridden by id, never copied.
  plans/sizes-and-decisions-follow-up.md.
- `tier-says-who` **The tier says who may change a rule.** (as MADR does,
  27 October) MADR's accepted, superseded and deprecated, in the
  catalogue's shape: a person's call is theirs, a product or source is
  replaced only by a better-grounded one, named.
  plans/sizes-and-decisions.md, plans/every-word-researched.md.
  - ~~`the agent's choice`, the tier for what nothing covered.~~ (Javi,
    11 October; retired 30 October, a detail with no well-formed opinion
    behind it being free and not the catalogue's)
- `decision-has-a-name` **A decision has a name; a part has none.**
  (Javi, 30 October) When anyone can have Claude build anything, who
  carries a change out no longer matters; collective code ownership as
  Fowler names it, whose one condition is a discipline the team keeps,
  here the catalogue; MADR's `decision-makers`; GitHub's CODEOWNERS is
  the model not followed. plans/collaborating-when-claude-writes-the-code.md.
- `anyone-goes-on` **A change one person started is anyone's to go on
  with.** (Javi, 30 October) A plan's reasoning stays on the machine that
  planned it; what reaches another machine is the pull request, whose
  diff carries the catalogue's entries and, once merged, the squash commit
  that `git log -S<id>` finds.
  plans/collaborating-when-claude-writes-the-code.md.
- `plans-account-for-commits` **The plans account for the queue's
  commits, by hash.** (Javi, 31 October) Every queue commits as `Claude
  <noreply@anthropic.com>`, one shared account on GitHub, so no reader
  tells one person's Claude from another's by the author; only the plan
  that made a commit knows it. plans/also-knows-whose-commit.md,
  plans/also-knows-whose-commit-follow-up.md, plans/also-docs-match-the-rule.md.
- `string-rests-on-source` **A string rests on what produced it: an
  entry or house rule, a product looked up, a person, or free.** (Javi,
  29 October) Even simple text goes through the research, so a grounded
  answer exists before he asks why; only a string that carries a
  decision is researched and recorded. Each string's row gives its kind
  and what shows it, as Polaris's and Primer's lint rules name the
  component to use in place of a raw element, and the plan review checks
  the diff. plans/every-word-researched.md,
  plans/question-only-for-a-new-screen.md,
  plans/catch-inconsistent-ui-at-build.md.
- `reason-gone-ask` **A rule whose reason is gone is put to the owner,
  not followed.** (Javi, 27 October) A deleted component or a fixed bug
  leaves a rule that looks binding and is not; only the owner retires it.
  plans/sizes-and-decisions.md.
- `recognized-three-places` **A decision is recognized in a plan's
  Decided section, an edit under `ui` and the chat.** (Javi, 27 October)
  The audit cannot read the chat, so it watches the effect: a turn that
  changed what a person sees and recorded nothing is asked once.
  plans/sizes-and-decisions.md.
- `found-three-ways` **A decision is found again by the everywhere rules
  loaded always, the edit-time hook and the `design-research` skill.**
  (Javi, 27 October) A rule the agent never sees before the edit is a
  rule it breaks. A one-file catalogue with no `paths` governs every `ui`
  path, so the list is kept once, and the hook's instruction is shown
  once a session, as the rules are; a small model names the catalogue's
  parts an edit touches, since a rule in a file the path and the
  keywords never reach is one the executor breaks, bounded as every loop
  over model calls is. plans/sizes-and-decisions.md,
  plans/catalogue-hook-and-audit.md, plans/catch-inconsistent-ui-at-build.md.
- `audit-checks` **The audit's checks are refused once each, and the
  second stop passes.** (Javi, 27 October) A check that refuses forever
  loops; once is enough to make the agent look. A catalogue counts as
  written to only when an entry was added, changed or removed, since a
  frontmatter or prose line is no decision. plans/sizes-and-decisions.md,
  plans/log-only-decisions-with-a-reason.md, plans/catalogue-hook-and-audit.md.

## The queue

- `plan-state-in-file` **A plan's state is in its file: its header and
  its `## ` sections.** (Javi, 27 October) No agent and no daemon of the
  queue's own; any session reads the state where any session wrote it.
  A dropped plan is kept as the record of why, as GitHub closes an issue
  as not planned with the reason and MADR keeps a rejected record.
  plans/handed-plan-stays-in-queue.md, plans/dropped-plan-state.md.
- `plan-put-first` **A plan or a brief the owner puts first is taken
  next, at the point between two plans, and the mark is a line in its
  file, above its first `## ` section.** (Javi, 13 November) In a
  project a one-line fix that alone held a pull request's merge waited
  behind five larger plans, and the assistant's message asking for it
  first was recorded nowhere a fresh executor reads. One mark, the
  latest on top, as GitHub's merge queue has one "Jump the queue" and
  Slurm's `scontrol top` moves a job to the front, rather than levels
  (Buildkite's numeric priority, Mergify's priority rules), which ask
  a rank of every plan; nothing under way is stopped, as Buildkite's
  priority orders only jobs not yet assigned. The line has one place
  for every shape of header, where the queue reads it as it reads
  `Lands`: a place worked out per shape was wrong in three commits
  running and sent a planner to a section the queue does not read. The
  planner's tool hook refuses a write that leaves a waiting file
  without its line, since `plans first` keeps the file's times and
  Claude Code's stale-file check does not see its write. A refresh
  plan is put first by the assistant on his standing word.
  plans/priority-queue.md, plans/put-first-review-fixes.md,
  plans/put-first-any-header-place.md,
  plans/merged-pr-refreshes-the-rest.md.
- `related-line` **In pull request mode, `plans` says what each brief and
  ready plan looks related to, and the author answers with a `Related`
  line.** (Javi, 30 October) GitHub links a `#<n>` and writes a backlink
  on the other pull request, so its people see it where they read.
  plans/land-by-pull-request.md.
- `executor-pool` **A queue has as many executors as its project file
  says, one by default; each builds one plan at a time, the
  lowest-numbered free one takes the next, and its Stop hook holds the
  stop on a red run or pull request, then reuses or retires the
  session.** (Javi, 24 November) The executors were the bottleneck:
  every ready plan waited behind the one in hand. A number of the
  queue, not a third form beside the maker and the queue, as a Jenkins
  node has a number of executors. Every turn
  re-reads the whole context at the cache-read price, so a session is
  reused only while it is cheaper than a fresh one (`context-cost`),
  judged at every stop while plans wait, the plans it was named
  included: an executor named three plans at 187k declined them and
  stopped at 202k, and the hook passed, since it judged only plans not
  yet told. A plan is handed over by the usage limit's cutoff and by
  `plans end --now` alone. The hold is on the project's `run`, and on a
  pull request's failed checks only where no webhook brings them
  (`push-not-waited-on`); with more than one executor, only on the pull
  requests of the plans its session took. plans/parallel-executors.md,
  plans/cache-aware-queue.md, plans/base-at-building-line.md,
  plans/executor-over-ceiling-hands-on.md, plans/simpler-agents.md,
  plans/executor-never-watches-ci.md.
  - ~~One checkout has one executor, and its Stop hook holds the stop
    on a red run or pull request, then reuses or retires the
    session.~~ (Javi, 27 October; one checkout held one build)
- `plan-waits-on` **A plan waits on the plan it rests on, and on one
  being built that lands where it lands or changes a file it
  changes; a plan is claimed before it is taken.** (as Trunk's merge
  queue does, 24 November) Its parallel mode runs pull requests with
  no impacted target in common side by side and queues the rest
  behind one another; Claude Code's agent teams give each teammate
  its own files, hand out no blocked task and claim under a file
  lock; git refuses one branch in two worktrees. Waiting too often
  costs time, never a conflict. plans/parallel-executors.md.
- `push-not-waited-on` **The executor runs the checks once, before the
  push, and waits on no pull request's run of them; a failed run
  reaches the assistant by the webhook.** (Javi, 14 November) The pull
  request's run repeated what "Before the push" had just run, four
  minutes a plan in the project that asked; GitHub tells a person of
  the runs they set off and lets them hear of the failed ones only. The
  assistant reruns once what the diff does not explain, since a hosted
  runner fails on its own some days, and refreshes a pull request
  behind its base rather than rerun it. What CI alone can do is the
  project's `run`. A run is taken whatever set it off and read back by
  `gh run list`, which needs the token's Actions read alone: in the
  project that asked, the token could not read a pull request's checks.
  A cancelled check is no failure: it was superseded or stopped by a
  person (17 of that project's last 100 runs); one that needs action
  waits on a person, and only GitHub marks one stale. A check by another service, which no Actions
  event carries, is named by the Stop hook also while a webhook
  listens, since GitHub notifies of Actions runs alone. An app
  registered before its line named Actions and Workflow run sent no
  failed run, so the listener asks GitHub what the app's registration
  and installation have, tells the owner once what to add or accept,
  as `gh` names a missing scope, and reads failed runs every five
  minutes meanwhile, that project's checks taking about four. The Stop
  hook reads checks with the person's token, then the app's when GitHub
  refuses it, since an app registered by the plugin's line has no
  Checks and the handbook's token does; refused by both, `plans` says
  so. plans/executor-never-watches-ci.md,
  plans/failed-runs-the-webhook-misses.md,
  plans/app-old-registration-said.md, plans/checks-read-with-the-app.md,
  plans/merged-pr-refreshes-the-rest.md.
  - ~~The checks are watched after every push and fixed before the
    next plan.~~ (Javi, 28 October)
- `plans-reach-an-executor` **A free plan never waits while an executor
  is free: a plan named to a session that stops without taking it goes
  to a fresh executor, `plans start` gives the next to the
  lowest-numbered free executor, and a hook or timer that finds plans
  ready and none alive starts one.** (Javi, 6 November) Eight plans sat
  two hours in a project: an executor named nine plans built one and
  stopped, the hook judged only the plans not yet told and passed, and
  nothing started an executor on its own. The planner's rule since 27
  October, as SQS gives a message received and not deleted to
  another consumer, and a supervisor's restart of a worker that exits
  with work queued (Kubernetes `restartPolicy: Always`; Sidekiq's
  orphaned jobs moved back at startup and every five minutes). The
  queue is a file: the stop is the acknowledgement, and what matters is
  that no plan is ignored. An executor listed with no process is free:
  it refused every start and `plans end` would not end it, so a start
  retires it and hands its plan over, as `plans end --now` does. A plan
  handed over too often goes to the assistant, the owner not asked
  (`executor-never-waits`). plans/executor-takes-next-ready-plan.md,
  plans/put-first-review-fixes.md, plans/executor-never-waits.md,
  plans/parallel-executors.md.
- `starts-bounded` **Starts are bounded, as every loop over model calls
  is.** (Javi, 27 October) A queue that starts sessions on its own must
  not spend the subscription's window or loop on a session that dies. At
  most `executors` run at a time. The day's bound counts the starts that
  ended with nothing built, planned or written, five in a row, and the
  owner's yes starts one more (Javi): in a project twenty-four executors
  that each built and pushed, retiring at their ceiling, were refused a
  twenty-fifth as a loop, and his yes had no way in. A circuit breaker
  opens on failures in a row and a Kubernetes Job's `backoffLimit`
  counts failed pods only; a breaker half open lets one trial through,
  and `systemctl reset-failed` lets an administrator start a unit its
  start limit refuses. An assistant's progress counts a note from
  GitHub it handled, since answering a comment writes no plan; the loop
  guard and the quick death count no executor at work in another
  number. plans/queue-faults-carried-over.md,
  plans/loop-guard-counts-failures.md, plans/parallel-executors.md.
  - ~~A tripwire at twenty-four starts of a kind a day.~~ (Javi, 27
    October)
- `session-names` **Every session the queue starts is a Remote Control
  chat named after the project and the machine.** (Javi, 27 October) The
  owner finds each chat on his phone by its name, and no two sessions on
  any machine share one. plans/session-names-across-machines.md.
- `chat-ends-after-an-hour` **A finished chat ends an hour after it goes
  quiet.** (Javi, 27 October) The cache lives an hour; Claude Code's own
  supervisor stops a done background session on its own clock, about an
  hour by its docs and eight by this machine's log, so idle chats
  lingered. plans/idle-chats-end.md.
- `end-now` **`plans end <id> --now` ends a named chat whatever it is
  doing.** (Javi, 31 October) A stuck turn or a question no one will
  answer otherwise holds its executor's lock for good. The fresh
  executor starts in the ended one's number, and the hand-over names
  its worktree. plans/end-a-stuck-chat.md, plans/parallel-executors.md.
- `archiving` **Archiving a chat in the Claude app does not stop it.**
  (observed in Claude Code 2.1.113, 27 October) The app is a window into
  the session; the process's exit is what archives the chat.
  plans/idle-chats-end.md.
- `waiting-is-an-open-prompt` **A chat waits for the owner only while a
  question or a prompt is open in it.** (Javi, 14 November) `plans`
  called a planner "waiting for input" for 22 hours and the assistant
  relayed a question owed, with none open: Claude Code marks a session
  blocked from the text of its last turn too, "an error only you can
  clear" by its agent view page, here a refused GitHub token. The
  process's own `status: waiting` is the prompt on screen. Retakes part
  4 of plans/idle-chats-end.md. plans/waiting-means-a-question.md.
- `executors-in-worktrees` **An executor builds in its own worktree,
  made, named and kept by the queue, and the queue's files stay in the
  checkout.** (Javi, 24 November) One checkout held one build, so
  every ready plan waited behind the one in hand. Claude Code's own
  worktree per background session was the 27 October trouble: a new
  one each session, from the default branch, with a fresh install,
  left behind. So the queue makes one per executor number with plain
  git and starts the chat inside it, where Claude Code makes none; as
  Jenkins keeps a workspace per executor and exports
  `EXECUTOR_NUMBER`, and as Claude Code's `.worktreeinclude` and
  linked directories carry what a fresh checkout lacks. The number
  goes in the worktree's settings `env`, since `claude --bg` hands the
  chat to a process started before the launch, with the daemon's
  environment (the plan's trial, 24 November).
  plans/executors-build-in-worktrees.md.
  - ~~A background session works in the checkout, one executor
    holding the lock.~~ (Javi, 27 October; a worktree per session
    made the queue lose track of what was built where)
- `queues-in-parallel` **Each project's queue runs apart from every
  other, in parallel.** (Javi, 27 October) A change to the workflow is
  never held by the project it was noticed in.
  plans/session-names-across-machines.md, plans/plans-command-reads-cwd.md.
- `checkout-is-a-queue` **A checkout is a queue: two machines' checkouts
  of one repository are two queues.** (Javi, 27 October) Nothing is
  shared between machines but the branch and a message.
  plans/session-names-across-machines.md.
- `briefs-queued` **Briefs are queued like plans.** (Javi, 27 October) A
  brief written while the planner is busy is not lost, and the planner
  is started under the executor's bounds. plans/cache-aware-queue.md.
- `planner-takes-next-brief` **A planner with room left takes the next
  brief: the oldest it is under its ceiling for, the ceiling raised by
  what the brief shares with its plans.** (Javi, 6 November) For a
  planner the fresh start's writes outweigh the reread of a context three
  times its size, so what a brief shares with the chat is the planner's
  cost argument; under one ceiling the median planner planned one brief
  and retired. The share is the tokens the chat holds of the brief's
  files, and the ceiling is worked out from this project's planners
  (`context-cost`). plans/cache-aware-queue.md,
  plans/reuse-ceiling-per-agent.md, plans/simpler-agents.md,
  plans/adaptive-reuse.md.
- `brief-leased` **A brief left with a live planner is leased to it
  for thirty minutes, each brief its own lease; one over its ceiling or
  waiting on a question gets a fresh planner at once, and a brief not
  taken by the lease's end goes to a fresh planner unless its holder is
  busy with room.** (Javi, 6 November) Five briefs sat seven hours behind one
  planner's question: a message reaches a busy session between its tool
  calls, where no hook judges it, and a chat blocked on a question
  receives nothing until it is answered, so a brief sent by message was
  known to nobody. As SQS's visibility timeout and PagerDuty's
  escalation timeout (thirty minutes by default) hand an item nobody
  acknowledged to the next taker; the window is "Asked once"'s. Each
  brief has its own lease, and one sent by message is its holder's alone
  until the lease ends: two planners wrote a Planning line on one brief
  when a Stop hook named a brief already sent to an idle planner, and
  one lease file for every brief overwrote who held each. The queue is
  one line: planners are not the bottleneck, each decides by its context
  at its stop whether to take the next brief or pass it on, and what
  matters is that no brief is ignored.
  plans/briefs-reach-a-free-planner.md, plans/brief-lease-per-brief.md.
- `asked-once` **A decision a plan leaves to the owner is asked by its
  planner, once, and the plan is the planner's for thirty minutes.**
  (Javi, 28 October) Wait thirty minutes, then decide for him; a plan
  asked in two rounds keeps its hold until the last. A question the plan
  did not foresee is decided by the executor, not asked in its session
  (`executor-never-waits`). plans/owner-questions-plain-and-once.md,
  plans/asking-window-ends.md, plans/asking-plan-held-by-path.md,
  plans/asking-plan-guarded.md, plans/executor-never-waits.md.
- `executor-never-waits` **An executor never asks the owner and never
  waits on him: what it would ask it decides by the recommended option,
  checked with the plan's planner or the assistant, and logged for
  him.** (Javi, 14 November) One open question held every plan behind
  it, and a night's executors waited on him for hours. Anthropic's
  prompting guidance has an agent take local, reversible actions on its
  own and not the hard to reverse or shared ones, here the four it
  never takes, and not discard unfamiliar files: in its own worktree
  nothing is the owner's, so what an executor that is gone left there is
  stashed whole and said in Built, with no item. The consent is his
  standing word, not the peer's answer, which only grounds a choice
  among the plan's own options. The tool is taken away in the agent
  file, since an instruction is advisory. plans/executor-never-waits.md,
  plans/executors-build-in-worktrees.md.
- `group-message` **A change to another person's part is built as any
  plan, marked `Touches <name>'s part`; no agent drafts a message for
  another person unless the owner asks for one.** (Javi, 2 November) He
  rarely, if ever, sent the messages the planner drafted; the pull
  request is where the people discuss it, and nothing lands until a
  person merges, so the plan is not held for their answer.
  plans/land-by-pull-request.md,
  plans/messages-for-people-only-on-request.md.
  - ~~A change to another person's part is built as any plan, with a
    message for the group the owner sends.~~ (Javi, 28 October)
- `issue-is-the-overview` **A topic the people discuss is a GitHub
  issue, one sentence of what should be true with the detail under it
  and the plan behind it.** (Javi, 3 November) People comment where
  they already read; GitHub's bug template leads with one line, Shape
  Up's pitch is posted for comments with the detail kept out, and
  Linear keeps a document apart from the description.
  plans/plans-as-github-issues.md.
- `issue-alone` **An issue nobody plans yet carries no status label and
  no plan line until a brief carries its number.** (Javi, 4 November) An
  idea made an issue to discuss would otherwise read on GitHub as being
  planned, with a plan that does not exist. plans/ask-before-briefing.md.
- `project-app` **The queue writes issues, comments, labels and pull
  requests as the project's own GitHub App, never under a person's
  name.** (Javi, 3 November) A write under his name needed his yes each
  time; an app is nobody's name, as Copilot's and Claude's apps post as
  `[bot]`, its token is minted on the machine, so no workflow and no
  runner; who opened a pull request need not be told apart, since the
  checkout's plans name the queue's own. plans/plans-as-github-issues.md.
- `ready-before-built` **A plan with an issue is built once the issue
  is labelled ready, or the owner says so, its comments folded by whose
  call each is; the issue's stage is one `status:` label.** (Javi, 3
  November) Shape Up's bet is taken at the table after the comments; a
  person's comment on their own part is their call already
  (`decision-has-a-name`), and the rest is his; a `status:` group is
  how projects label stages on GitHub, which has no standard of its
  own, and the words are the queue's. plans/plans-as-github-issues.md.
- `github-webhook` **What people write on GitHub reaches the queue by
  the app's webhook to the container, and the assistant acts on it in
  Remote Control.** (Javi, 3 November) He wants the work on his own
  container, seen in Remote Control, not on a hosted runner, and at
  once rather than by a poll; the lab already fronts services with its
  proxy; GitHub signs each delivery, and Copilot and claude-code-action
  answer only people with write access. The listener counts as alive
  only when its record's pid is alive and its port takes a connection
  (Javi), since the record outlives a container's reboot, where its pid
  can name another process. A failed run, whatever set it off, and a
  merge are events too, issues on or off; a delivery nothing is taken
  from is not kept, each being 8 to 28 KB in the project that asked.
  The listener reads what its app can send and, lacking failed runs,
  reads them itself. A list `plans github` could not read is said and
  its line held, where it was read as empty and passed; a listener an
  older copy started is replaced by a newer one's start, as Bazel's
  client stops a server of another version, since one alive since
  before an update ran the old code for nine hours.
  plans/github-watched.md, plans/webhook-stale-record.md,
  plans/executor-never-watches-ci.md,
  plans/failed-runs-the-webhook-misses.md,
  plans/app-old-registration-said.md, plans/checks-read-with-the-app.md,
  plans/merged-pr-refreshes-the-rest.md.
- `days-fixes` **The day's fixes are one pull request, `Small fixes, <d
  Month yyyy>`, never two in a day.** (Javi, 30 October) A daily pull
  request for the small fixes rather than a message for the group, which
  would look odd there; Rust's rollups and Dependabot's grouped updates
  batch small changes the same way. plans/pull-requests-by-topic.md.
- `context-cost` **A session's context is worth keeping only while it is
  cheaper than a fresh one, by the wash worked out for each project and
  agent from its transcripts, raised by what the work shares with the
  chat, and never over 480k.** (Javi, 6 November) The wash is (start +
  shared reading) x (1 + write price / (turns x read price)): a kept
  context is re-read every turn at the read price, a fresh one writes
  its start and the reading it shares once at the one-hour write price,
  per Anthropic's pricing page
  (platform.claude.com/docs/en/about-claude/pricing), read on 5 November
  2026. The inputs are measured per project and agent from the
  transcripts and cached, the fresh start and the turns as medians, the
  shared reading as what the chat holds of the files the work names (`shared-is-what-is-held`). The project file's
  `reuse`, 200k for an executor and 160k for a planner, serves only
  while an agent has under five sessions in the project; 480k is the
  cap, the quality limit no price measures (Chroma's context rot,
  research.trychroma.com/context-rot). Compactions are out of the rule:
  none of this queue's first 60 sessions compacted, nor 56 of the first
  project's builds, and `plans cost` still counts them. plans/cache-aware-queue.md, plans/reuse-ceiling-per-agent.md,
  plans/simpler-agents.md, plans/adaptive-reuse.md,
  plans/shared-file-share.md.
- `reuse-check-cheap` **The reuse check costs the agent nothing: the
  scripts measure from the transcripts into a cached summary, and the
  agent reads one verdict line.** (Javi, 6 November) A check that spent
  tokens to save tokens would defeat its purpose. A hook never measures:
  one that finds the summary over an hour old starts `plans cost` in the
  background, measuring only the reuse inputs, and does not wait; the
  plans commands refresh it, a stat per transcript when nothing changed.
  What a chat holds of each file is the tool hook's append-only log
  (`shared-is-what-is-held`), a Read's hook a bare node start.
  plans/adaptive-reuse.md, plans/reuse-measured-outside-hooks.md,
  plans/hooks-refresh-reuse-in-background.md,
  plans/background-refresh-measures-only.md, plans/shared-file-share.md,
  plans/shared-count-fixes.md.
- `shared-is-what-is-held` **What a plan or brief shares with a chat is
  what the chat read or wrote of each file it names, at most the file's
  size, never the file's whole size.** (Javi, 6 November) A file counted
  whole raised an executor's ceiling from 74k to 157k for a 331 KB test
  file it had changed a few hunks of (13k tokens held of 83k); the share
  is what a fresh chat would have to read again. The count is the tool
  hook's, from each tool's result as the chat goes, into an append-only
  log of the session's that a hook never reads, so parallel hooks lose
  nothing: no model call, no transcript read, nothing in the agent's
  context. A file changed with no output is not held, and a command's
  output is split evenly among the files it names. plans/shared-file-share.md,
  plans/shared-count-fixes.md.
- `one-thread` **The executor works in one thread, with a subagent only
  in four named cases.** (per Anthropic's multi-agent research post, 27
  October) A plan's steps share one context, coding has few parallel
  strands, and a multi-agent run costs about fifteen times a chat; the
  owner's own trial cost more than it saved. Instructions are advisory, a
  setting is not, hence the spawn depth of 1.
- `second-model` **A second model reviews every plan's diff, and never
  gates.** (Javi, 27 October) A model that did not write the code finds
  what the writer's reviews share a blind spot for; a review that cannot
  run must not stop the build. plans/project-setup-interview.md.
- `screens-reviewed` **The plan review reads the executor's screenshots
  against the catalogue entries for the kinds on screen.** (Javi, 2
  November) A rule can hold in the code and still fail on the screen;
  Chromatic's UI Review puts the rendered change before a reviewer who
  did not make it; the plan review is already a fresh context per plan,
  so it gains the screenshots rather than a fourth review.
  plans/catch-inconsistent-ui-at-build.md.
- `turn-audit` **The turn audit asks once per turn why each file was
  needed and where the decision went.** (Javi, 27 October) A turn that
  changed what a person sees and recorded nothing is how a catalogue
  falls behind. plans/sizes-and-decisions.md.

## Changing the workflow

- `change-in-plugin-repo` **A change to the workflow is planned and built
  in the plugin's own repository.** (Javi, 27 October) A project's queue
  cannot change the plugin every machine installs; the plugin's own queue
  and CI can. plans/plans-command-reads-cwd.md.
- `leave-back-as-brief` **A change the plugin leaves for the project it
  came from goes back as a brief.** (Javi, 31 October) Four built plans
  left the project's half under "Not in this plan" and nobody carried it;
  Jira's linked issue created in another project, GitHub's issue
  transfer and Actions' `repository_dispatch` carry work across the same
  way. plans/project-follow-ups-reach-the-project.md.
- `public-names-no-project` **The plugin's repository is public and
  names no project, except in its own address.** (Javi, 27 October)
  Every machine installs from it and anyone may read it, so no tracked
  file holds a host's address, a personal email, the home lab's domain,
  a token or the name of a project the workflow runs in; a project's
  specifics are in its own project file, and `test/public.test.ts`
  refuses each. The repository is in the first project's organization,
  so that a machine's token could push, and its address,
  wordplaylabs/workflow-plugin, holds that name: the check allows the
  address written exactly so and refuses the name in any other form
  (Javi), since the address shows the name to anyone who opens the
  repository, and the old address worked only by GitHub's redirect,
  which GitHub deletes when a repository is created there.
  plans/plugin-address-in-files.md.

## Installing

- `install-one-line` **Anyone installs the workflow by pasting one line
  into Claude Code.** (Javi, 27 October) `INSTALL.md`, written for
  Claude, does the rest, and a test holds its settings to the handbook's.
  plans/install-by-asking-claude.md.
- `install-checks-itself` **The plugin checks its own install at
  every session's start, and an incomplete copy is said to the owner
  before any work.** (Javi, 3 November) The auto-updated copy of 2
  November lacked three directories and five scripts; every chat ran
  without the hooks and nothing said so, since Claude Code's validate
  passes a copy with components missing and its Errors tab is read by
  nobody. The check stands alone and is declared in the manifest, the
  one file read whenever the plugin loads; its file list is held to
  `git ls-files` by a test, as INSTALL.md's settings are to the
  handbook's. The fix puts the files back from the marketplace's clone,
  `git archive | tar`, or updates when the clone has moved on, since
  deleting the copy took the scripts from every chat still running on
  it; a `--plugin-dir` root is a source checkout, and a copy the
  install record does not name is an older version and gets no command.
  The line
  carries the question and the steps, said once by the script.
  plans/install-checks-itself.md, plans/install-fix-safe.md,
  plans/install-fix-every-path.md, plans/simpler-agent-files.md.
- `plans-in-the-terminal` **`plans` is a command in the owner's
  terminal, written by a SessionStart hook to `~/.local/bin`.** (Javi, 8
  November) Claude Code puts a plugin's `bin/` on the Bash tool's PATH
  and nowhere else, and a rebuilt devcontainer lost the wrapper he had
  written by hand; `~/.local/bin` is where Claude Code's installer, uv
  and pipx put a user's commands, and the install record is what the
  install check already calls installed, so the wrapper reads it at each
  call rather than being rewritten after an update. A missing PATH entry
  is said, not edited into a shell file, as `uv tool install` warns and
  only `uv tool update-shell` edits; it is said in the owner's chats at
  each start while it holds, as uv and pipx warn at each install, since
  said once it went to whichever chat wrote the file, a queue chat after
  a rebuild. A copy the record names that was removed gave Node's trace,
  so the wrapper checks for `bin/plans` first and says the update
  command. plans/plans-on-the-terminal-path.md,
  plans/plans-on-the-terminal-path-follow-up.md.
- `push-token` **A push needs a token in the container.** (Javi, 27
  October) The queue's chats run where no VS Code window may be, and VS
  Code's credential helper answers only while its window is attached; the
  Workflows scope lets a plan that changes `.github/workflows/` push. The
  app's key and the webhook's secret may instead be in a private file
  that `WORKFLOW_SECRETS_FILE` names, read only when used, so no other
  program's environment holds them (Javi); in a devcontainer the host's
  file has one fixed place per project, `~/.config/workflow/<project>.env`,
  made empty when missing so the container starts with the app off. The
  app has Actions read and write, so a failed run reaches the queue and
  the assistant can rerun it, and `plans gh` with no app names its
  permissions and the events the webhook reads, so an app registered by
  that line sends every delivery the queue takes.
  plans/push-to-github.md, plans/secrets-from-a-file.md,
  plans/secrets-file-made-on-host.md, plans/executor-never-watches-ci.md,
  plans/app-words-name-failed-runs.md.
- `screenshots-attach` **Screenshots on a pull request go up through `gh
  pr create --attach` and `gh pr edit --attach`, from gh 2.99.** (as
  GitHub CLI does, 31 October) GitHub's changelog of 1 September 2026
  added `--attach` to the create and the edit together; an older gh opens
  the pull request without them and says so.
  plans/land-by-pull-request.md, plans/joined-pull-request-no-comment.md.
