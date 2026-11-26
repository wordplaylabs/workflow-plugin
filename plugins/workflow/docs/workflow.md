# The workflow

Two forms, in any project: the queue, where an assistant answers and
routes, planners write plans and executors build them, as many at once
as the project's `executors` says; and the compact form's one maker.
The owner's part is the decisions. Each rule is named by its bold
lead-in, which the agent files cite; they hold the steps, and why each
rule was decided is its entry in `decisions.md`, cited at the end of
its paragraph.

## The agents

**Plan, then build, in two sessions.** A change of any size is planned by
one session and built by another, with the context cleared between: the
plan is the spec for one change, and the project's docs are the standing
context. Each agent runs as the whole session: `workflow:planner` (Fable, effort high) writes the
plan; `workflow:executor` (Opus, `--effort high`, which outranks a
settings file's effort) builds it through the checks, three reviews and
the push; `workflow:assistant` (Opus, effort medium, the agent a project's plain
chats open as) answers and routes; `workflow:maker` (Opus, effort high) is the compact
form's one chat, which decides, builds and records.
(decisions.md#plan-then-build)

**The owner talks to one chat.** `<Project> Assistant` is the only chat
that asks him anything or tells him anything: a planner's question
reaches him there, in the planner's words, and every plan built is said
there. Planners and executors work behind it, in no list of his, so no
start of one alerts his phone: when he asks what one is doing, the
assistant reads its conversation and tells him. What he writes in one,
from a terminal on its machine, is passed to the assistant. With none open, whoever has something for it opens it
(`plans start --agent assistant`). While work is under way the chat is
kept warm by a scheduled prompt twice an hour, and one over its ceiling
(`reuse.assistant`, 150k) writes a hand-over file and is replaced, once
quiet ten minutes, by a fresh chat of the same name: what it still owes
is written into the queue first, and the file is said once to whichever
assistant chat speaks next, since a scheduled `/compact` reaches a
background chat as a plain message. One assistant chat is live: the
fresh one is started first and the handed-on one stopped once the fresh
one is listed, or, when another is open already, as soon as it is quiet,
the queue trying again every ten minutes until one is open and the old
one stopped; a chat with no process is not open, so one is opened beside
its row; none is opened while `claude agents` cannot be read; what the
queue sends goes to the chat started last that is not handed on; and
`plans end <id> --now` ends one he names. A handed-on chat is not open
to a takeover, so two handed on at once are replaced by one fresh chat.
(decisions.md#one-chat)

**An agent file is the agent's instructions, and a start prompt names
the work.** Each agent file says what the agent does, in the order it
does it, each rule once and in the file of the agent that acts on it,
as an instruction with the handbook rule it rests on named in
parentheses, never the history of how it was decided; a negative is
paired with what to do instead; emphasis words are not used; a
procedure the agent runs in one phase of one mode is a file the agent
reads at that step, named in the agent file; a line the agent would
find by opening a file the plan or the project file names is left out;
and a string the scripts parse (a section heading, a line `plans`
reads, a message's first line) is written out exactly, in backticks.
The prompt the queue starts a chat with is one line: the path and what
it is (`Plan plans/<x>.md: it is a brief.`, `Build plans/<x>.md.`, `Built: plans/<x>.md.`), and a hook's words
are the state and the facts, with the rule named by its heading in the
agent file where the agent must act. (decisions.md#agent-file-is-instructions)

**An agent's report is short.** What is said to the owner, by the
assistant or the maker, leads with what changed for him and what waits
on him, a behavior as When … then …, then where the record is (the
plan's path, the pull request's link), in at most ten lines; a planner's
or an executor's final message is the record alone, what it wrote or
pushed and how it was handed on, since the `Planned:` or `Built:`
message to the assistant carries what was for him; a "Built" section opens with its landing line, then one
line for the "Done when" lines that hold, with the commands run and
their counts, one line per line that does not hold or was checked
another way, the deviations, the decisions taken for the owner, "Needs
a decision", the Codex paragraph
and the Usage line, and nothing the plan already says.
(decisions.md#report-is-short)

**A brief or a plan is a prompt for the agent that reads it**, and is
written as one. Four parts, in this order, under these headings: *What
was asked*, the outcome and why, in the owner's words as a paragraph of
the writer's; *Decided*, what is already settled, each with its reason
(left out when nothing is); *Done when*, each line a check the reader can
run or see and that comes back pass or fail, with the command where there
is one and a number where there is one; *Where to look*, the reference to
follow by its path, the earlier decisions by their plan or entry, and the
artifact itself (the message quoted, the log, the address), never a
description of it. The answer's form is the reader's agent file, so the
prompt does not repeat it. A line whose removal would cause the reader no
mistake is cut; what the reader will find by opening the file it is
pointed at is not copied in. The executor's briefs to its subagents, the
planner's `For` brief and the plan's own sections are the same four parts
with the plan's detail between them. (decisions.md#brief-is-a-prompt)

For example, the brief that asked for this rule:

```
# Briefs and plans are written as prompts for the agent that reads them

Brief for the planner, 2 November 2026, by the assistant with Javi.
The planner's plan replaces this file.

## What was asked

The planner reads every brief and the executor every plan, so each is a
prompt: Javi wants them written by Anthropic's current prompt guidance,
and the docs every agent reads written the same way.

## Done when

- The assistant's brief, the short plan and the planner's plan each
  follow the guidance.
- One real brief and one real plan, rewritten under the new rules, are
  shorter and still complete.
- When two fresh readers are given only a rewritten file, then each
  says what to do and how to check it is done.

## Where to look

- The guidance:
  https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview,
  https://code.claude.com/docs/en/best-practices (cut any line whose
  removal causes no mistake) and
  https://code.claude.com/docs/en/prompt-library.md (the outcome, a
  check, a reference, a measurable target, the artifact, the answer's
  form).
- The example: the first project's
  `plans/audit-duplication-and-reinvention.md`, rewritten on 2 November
  from 466 to about 250 words by those patterns, its content approved by
  Javi.
- What changes: `agents/assistant.md` (the short plan and the brief),
  `agents/planner.md` (the plan's shape), `agents/executor.md` (where it
  reads them) and `docs/workflow.md`.
```

**A behavior is written as a scenario**, When <what the person does>,
then <what they see>, one per line: in a brief's and a plan's "Done
when", in a plan's decisions where they state a behavior, and in the
agents' messages to the owner. "**When** I connect Google from the
account page, **then** a toast at the bottom says "Google is connected"
and goes after a few seconds." Each scenario in a plan's "Done when"
names the test that checks it or says it is looked at on screen, and for
one looked at on screen the executor names the screenshot that shows it;
the executor writes one test per scenario where one fits; a
check by command (a test, a lint, a grep) stays a command.
(decisions.md#behavior-as-scenario)

**The checkout is for reading**: the planner and the assistant read the
project there, at the branch as of the last start; one that finds the
tree dirty (`git status`) reads the file from the branch (`git show
origin/<branch>:<path>`) and says so. (decisions.md#reading-beside-a-build)

**The planner and the assistant read the specifics themselves and hand out
only bounded, read-only sweeps**: one answer shape, a turn limit, nothing
that writes. (decisions.md#bounded-sweeps)

**A plan is built once it is written**: order is asked only when another
plan already waits, and a dependency is written into the plan.
(decisions.md#built-once-written)

**Which session a topic goes to.** The assistant ends every topic in one
of four exits: answered; a call for a person the project names, said in
a line, with a message drafted only when the owner asks; a short plan
for the executor; or a brief for the planner, which holds the four
parts. A change described in a few sentences, inside rules the
project holds, with at most two strings resting on a product looked up
(any number free), no schema or privacy change and no person's rule
reversed, is a short plan; anything else is a brief.
(decisions.md#which-session)

**An idea is asked about before anything is written**: the assistant
answers it, then asks the owner with the question tool whether it becomes
an issue (in a project with an Issues heading and `land: pull-request`),
a brief or nothing yet; a clear bug, an objective fix or a request to
build, plan or file asks nothing, and a doubt between the two is asked
(the assistant's "Where each topic ends"). (decisions.md#idea-asked-first)

**Every new topic starts in the assistant's chat**, and what he writes in
a worker's chat is passed there. A planner's chat holds
the plans it wrote until an executor's `## Building` line takes each. The
owner carries no message between agents, and no chat sends him a
command to run. (decisions.md#new-topic-to-assistant)

**What he writes in a worker's chat is passed on, and the assistant
writes it.** A planner or an executor sends his words to the assistant
chat, `From <owner>: said in <chat's name>, <d Month>.`, then his words,
and does nothing else with them; the assistant puts them to him once
and writes the short plan, brief or follow-up. A change he asks the
assistant for, to a plan a live planner holds, goes to that planner as
`Change from <owner>: plans/<x>.md.` with his words, and is his word:
it goes in "Decided" with no second question. A message that only
informs is information; one that asks anything else is reported and
not acted on. (decisions.md#chat-that-heard-it)

**Handed to the assistant** is one route for every worker's message to
him: `ListAgents`; this project's `<Project> Assistant` chat on this
machine (kind `interactive` or `bg`, never `Remote Control`); one
message, its first line one of four: `Question for <owner>:
plans/<x>.md.` and `Planned: plans/<x>.md.` from a planner, `Built:
plans/<x>.md.` from an executor after every push, `From <owner>: said in
<chat's name>, <d Month>.` from either. With none open, `plans start
--agent assistant [<path>]` opens it, or names the one open, and the
message goes to it. (decisions.md#handed-to-the-assistant)

**Asked in plain words.** The owner reads a question on his phone, in the
question tool's dialog, with none of the chat in front of him: first what
it is about, in his words, then the situation in two or three sentences,
then what each choice means to him and costs him. Nothing is called by its
name in the code, nothing in backticks; the header is the topic in a word
or two; each label is what he gets, each description what it costs; the
recommended option first and marked; one decision per question, up to four
a call. A choice is named by what he gets, never by its place ("the
first option") or by an earlier message he may not have in front of him;
and no question asks whether to hold work, since work goes on unless he
said to hold it. `scripts/plain-words.mjs` refuses a question that names
code, is one sentence or names a choice by its place. Not this: header `Connect`,
question `Should the connect script keep the terminal open after the
hand-over, or exit on Ctrl+C?`, options `Keep open` / `Exit`. But this:
header `Hand-over`, question `This is about what a reader sees after they
hand a document over to someone else, the change you asked for this
morning. Today the page they land on stays open until they close it
themselves, which some readers take as the hand-over having failed. The
choice is whether that page closes on its own once the hand-over is
confirmed.`, options `Closes on its own (Recommended)`, description `The
reader sees a confirmation and the page goes; costs nothing unless they
wanted to go back to it`; `Stays open`, description `As today; costs the
readers who think it failed`. (decisions.md#asked-in-plain-words)

## The project file

**A project's part is one file, `.claude/workflow.md`**: frontmatter the
hooks read and a body the agents read; `plans init` writes a starter, the
name defaulting to the directory's and the branch to the remote's
default, or the branch checked out. (decisions.md#project-file)

```
---
name: Docs                # the project's name in session names
branch: test              # the branch the executor pushes, fast-forward
run: checks.yml           # the workflow that does what the local checks cannot (a deploy), read after a push straight to the branch; omit when CI only repeats them
land: pull-request        # a pull request per topic and one a day for small fixes; omit to push everything
ui:                       # paths a user sees, for the turn audit and the edit-time hook; a one-file catalogue with no paths governs them all
  - "src/components/**"
catalogue: docs/patterns  # the design catalogue: a directory or one file; omit for none
inherits:                 # catalogues this one overrides by id, farthest first
  - ../.claude/decisions
tools:                    # tool names whose calls change what a person sees
  - "mcp__server__write_.*"
mcp:                      # MCP configs every chat here gets (plans chat, plans start)
  - .mcp/server.json
deny:                     # MCP tools an agent here may never call, by agent
  assistant:
    - "mcp__server__write_.*"
form: compact             # one chat decides and builds; omit for the full queue
executors: 2              # how many executors build at once, each in its own worktree; omit for one
resources:                # heavy steps only so many executors run at once; a step takes a slot with plans hold
  browser: 1
reuse: 200000             # the context above which a finished session retires while this project has under five sessions of the agent: one number, or a map of executor and planner; with history the queue works the ceiling out from this project's transcripts
reviews:                  # the reviews before a push; omit for all three (none when compact)
  - code-review
note: \JaviAI             # the writing plugin's note command; omit for notes in the report
reply: \javi              # the command the author answers notes with
---
```

**`form: compact` is the compact form**: one chat, `workflow:maker`,
decides and builds, and the queue's hooks do nothing. A project moves
between the forms by this line alone; `branch` may be omitted, and the
maker then commits nothing; it reads no `land`. (decisions.md#compact-form)

**A project's chats open as its agent, from the project's own
settings.** A plain `claude` in a project with a project file opens as
`workflow:assistant`, or as `workflow:maker` with `form: compact`, by
the `agent` key of its `.claude/settings.local.json`, each person's
own and git-ignored. `/workflow:setup` writes it; the session-start
hook writes it where no settings file of the project or the person
names an agent, or the one that applies is the other of the two, moves
it when the form changed, and says in the owner's own chat that the
next one opens as it. An agent anyone else named, any but the two, is
left alone. The plugin sets none itself, and a folder with no
project file opens as Claude Code's own.
(decisions.md#chats-open-as-the-agent)

**`land: pull-request` lands by pull request.** A plan's author writes
where it lands in a `Lands` line under its header paragraph; absent the
key, the executor pushes everything to the branch and the line means
nothing; `docs/landing.md` holds the executor's steps.
(decisions.md#land-by-pull-request)

- **A topic** (`Lands: topic <name>.`): one branch named for the topic,
  a commit per plan, pushed after each; its pull request opens by itself
  when a plan of it is built and no other plan of it is ready, handed
  over or being built, and nobody marks a topic ready; a plan with no
  `Lands` line is a topic of its own; the pull request it lands in or is
  stacked on may follow the name (`; lands in #52.`), and `plans` says a
  `Lands` line it cannot read and the topics still waiting for a pull
  request, each with why. (decisions.md#topic-landing)
  A later plan joins an open pull request: the description is written
  again, its screenshots attached with `gh pr edit --attach`, and nothing
  is posted. (decisions.md#joined-pull-request)
- **A fix** (`Lands: fix.`): no decision, no catalogue or doc rule
  changed; it goes into the day's fixes pull request, and one whose
  commit changes a rule lands as a topic of its own. (decisions.md#fix-landing)
- **A fix wanted now** (`Lands: fix, now.`, on the owner's word only):
  pushed straight to the branch, its `run` read, and listed in the day's
  fixes. (decisions.md#fix-now-landing)
- **A refresh** (`Lands: refresh.`): the assistant's, after a merge; no
  commit of its own. (decisions.md#merge-refreshes-the-rest)

**The description is a short list of what changed**: the owner's
paragraphs when he wrote some, the `Closes`, `Builds on` and `Related`
lines, then `Changes`, a few bullets, each a bold lead and one plain
sentence of what a person can now do or see, with one screenshot under
a bullet only where it shows it; a bullet that replaces another
person's call says so by name; the commits no plan here accounts for
as bullets with their author; then where to try it; on one screen,
pictures aside. The decisions stay in the catalogue, whose diff the
pull request shows. The merge is the people's, and no agent merges. (decisions.md#short-description)

**How plans group into pull requests is the project's rule, under
`## Pull requests` in its file**, read by the author of a `Lands` line;
the plugin suggests one in `/workflow:setup` and keeps only what the queue cannot do without: a plan that
rests on an open draft pull request of the queue's own lands in it, and
one that rests on another person's pull request is stacked on it, since
the queue never pushes to another's branch. To rest on a pull request is
to use what it adds; landing in it, the plan's `Lands` is that pull
request's topic. Without the heading, a plan resting on the queue's own
pull request marked ready is stacked on it, and one that shares files
with an open pull request gets a `Related` line and a pull request of
its own. (decisions.md#stack-only-on-use,
decisions.md#pull-requests-heading)

**A branch is brought up to date by merging, never force-pushed**, a
conflicting pull request at a plan's start included, pushed to its own
head branch only. (decisions.md#merge-never-force)

**The executor refreshes only the queue's own pull requests, with the
checks alone**: those a plan in its `plans/` names as its own, the pull
request its "Built" opened or joined or its `Lands` topic's branch, never
one a `Related` line names. (decisions.md#refresh-only-your-own)

**A merge brings the queue's other pull requests up to date.** A pull
request merged into a branch reaches the assistant by the webhook with
the queue's own open pull requests on that branch, or stacked on the
merged one. The assistant writes one refresh plan for them, `Lands:
refresh.`, put first on the owner's standing word, and the executor
merges the base into each and pushes it to its own branch; another
person's is left until the owner says so. The owner hears which were
refreshed at his next message in his own assistant chat.
(decisions.md#merge-refreshes-the-rest)

**A topic's pull request opens as a draft and stays one until its owner
has reviewed it himself, and ready once he marks it**: he marks it ready
on GitHub, the one act that asks anyone else's reading, and the plugin
refuses an agent's `gh pr ready` that would mark one; a later plan's work
joins it as it is, its checks run again, and the merge stays his.
(decisions.md#draft-until-reviewed)

**`mcp` names the MCP configs a chat here needs**, which `plans chat` and
every chat the queue starts pass on the command line; `plans chat` opens
the maker or the assistant in a project with `mcp` or `inherits`, and
prints a config's path, never the file. (decisions.md#mcp-configs)

**`deny` keeps an agent off a tool the project gives another**: it maps a
plugin agent to MCP tool-name patterns matched whole (a connector named
alone means its every tool), which `scripts/tool-denials.mjs` refuses in
every chat, a subagent included; `plans check` lints it. (decisions.md#deny-key)

**The body's headings are the executor's steps for this project**:
**Before a build**, **While working** (which tests for one change),
**Before the push** (screenshots, checks, suites, in order, a step that
takes a slot written as `plans hold`), **After the
push** (what to watch), **Reading** (which tools read code and docs),
**Products** (the product people know for each kind of thing, which
`design-research` follows first), **People** (whose calls are theirs,
what each decides, and each one's GitHub login in backticks, whose clear
tasks on GitHub the queue acts on wherever they write them) and **Issues** (`Detail:`, a skill or command that
turns a plan into an address an issue links, and `Check:`, a command that
fails on what may not leave the repository; its presence turns issues on
with `land: pull-request`, since issues need pull requests)
and **Pull requests** (how plans group into pull requests); the body may
also name the tools that publish under the owner's name, which no agent
calls. (decisions.md#body-headings)

**A project is set up in a short interview**, `/workflow:setup`, asked
once with its kind's defaults (`kinds.md`), each thing's cost said; run
again, it keeps the answers. (decisions.md#setup-interview)

**A project turns off the connectors it does not use**: the setup denies
the claude.ai connectors no chat here needs, whole
(`mcp__claude_ai_<connector>`), in `.claude/settings.json`, or
`.claude/settings.local.json` when the first is tracked in a public or
shared repository, touching no other deny. (decisions.md#connectors-off)

**A project with no project file is not the workflow's**: the hooks do
nothing there, and `plans start` refuses. (decisions.md#no-project-file)

## Decisions

**The catalogue is the record.** The project file's `catalogue` names a
directory (a `README.md` with the everywhere rules and a table of the
files, then one file per kind of thing a person sees) or one file, each
rule a bold list item with its tier and date right after the bold
statement or ending the rule. The tier is read there and nowhere else: a
parenthesis inside the statement (`**Per-step (per row) toggle.**`) or in
the middle of the body is never one, and a fenced example is no rule. An
entry may open with an id, ``- `presenter-bold` **The presenter's name is
bold.** (Javi, 2026-10-21)``, cited as `file#id`; it names the plans that
decided it. A change to a rule rewrites its entry, the rule and its
reasons as they stand, and adds no dated note; a rule that reverses an
earlier call keeps that line struck through under it, and one that only
sharpens it keeps none. How a rule was decided before is never lost:
every change to an entry is in the repository's history, read with
`git log -p -- <the catalogue's file>` and searched for the entry's id.
What is not there was not decided.
(decisions.md#catalogue-is-the-record)

**The catalogue is only for well-formed opinions, researched or given by
a person; anything not in it is assumed to have no reason and is free to
change.** An entry is a person's call with its why, or a product or
source followed, named; a detail nobody decided for a reason is judged
against the principles, changed on sight and never recorded, until it
turns out to matter. (decisions.md#only-well-formed-opinions)

**A catalogue inherits others.** `inherits` lists catalogues above the
project's, farthest first; the project's entry of the same id overrides
an inherited one and says `overrides <file>#<id>`. `plans check` lints
every catalogue named: a missing tier and date, an id used twice, an
override naming no inherited id, an entry at the agent's choice.
(decisions.md#catalogue-inherits)

**The tier says who may change a rule.** A person's name is their call; a
named product (`as GitHub does`), a written source (`per <source>`) or a
measurement (`observed in <x>`) is replaced only by a better-grounded one,
named. `the agent's choice` is retired: an entry at it is a fault, until
it is re-tiered, confirmed as a person's call or deleted. A reversed rule stays
struck through under its replacement; a retired one says "retired".
(decisions.md#tier-says-who)

**A decision has a name; a part has none.** Nobody owns a file, a screen
or a feature: anyone changes anything through a plan, the reviews and a
pull request, where a disagreement is settled. A rule with a person's
name is their call: a change to it brings its reason, and the description names who decided the rule it
replaces. **People** names calls, not parts.
(decisions.md#decision-has-a-name)

**A change one person started is anyone's to go on with.** Another
person's commits on a pushed branch are kept as theirs, the executor
squashing only its own, and listed among the changes with their author.
(decisions.md#anyone-goes-on)

**The plans account for the queue's commits.** Every queue commits as
`Claude <noreply@anthropic.com>`; a plan's "Built" names its commit and
its merges by hash, so the description lists every commit on the branch
no plan in this checkout accounts for and no merged pull request down the
stack already showed, with their author, among the changes; none is left
out by author or title.
(decisions.md#plans-account-for-commits)

**A string rests on what produced it.** Every word a person sees is in the
plan's "The words" with what produced it: an entry or house rule
(`file#id`), a product named in Sources, a person, or free, with the
principle it follows. Only a string that carries a decision is researched;
only a new screen or flow is asked about first, any other control after
the research, when it leaves a choice the house rules do not settle. For
a new screen or flow, an executor does not ask: it researches how the
product people know does it, follows it, and names it in Built ("An
executor never waits on the owner").
The executor types nothing outside "The words"; each string's row gives
its kind, the catalogue file or section that governs it, and what shows
it, and the plan review checks the diff against it. (decisions.md#string-rests-on-source)

**A rule whose reason is gone is put to the owner, not followed**: keep,
change or retire, by the question tool, the rule standing until he
answers; a plan that deletes a thing lists the rules resting on it.
(decisions.md#reason-gone-ask)

**A decision is recognized in three places**: a plan's "Decided" and the
entries it drafts; an edit under `ui`, where the audit asks for the
entry; and the chat, where the owner's correction is recorded under his
name in the same turn. (decisions.md#recognized-three-places)

**A decision is found again in three ways**: the README's everywhere
rules, loaded always; a catalogue file's `paths` and `signals` (a one-file
catalogue with no `paths` governs every `ui` path), which
`scripts/catalogue-context.mjs` matches before an edit or a `tools` call,
each entry, and the hook's instruction, shown once per session; and, for an edit whose text draws a control or carries
words a person could read, a small model's naming of the catalogue's files
or sections it touches, loaded beside them (one call per distinct text,
sixty a session, twenty
seconds each, a log line per call; none without a catalogue); and the
`design-research` skill, when nothing covers a thing.
(decisions.md#found-three-ways)

**The audit's checks**: a `ui` path changed or a `tools` call made with no
entry added or changed in the catalogue, answered by the entry or a
`decisions: none (<why>)` line; a rule without its tier and date; an entry
at the agent's choice dated today. Each is refused once.
(decisions.md#audit-checks)

## The queue

**A plan's state is in its file**, which `plans` reads and prints: `##
Built` (its commit, the hash after `commit` or the first in its opening
paragraph that is no session id, seven digits or more, and a `Pull request #<n>`, `Pushed straight to
<branch> as a fix` or `On topic <name>` line); `## Dropped, <date>`,
written by the plan's author on the owner's word with one line of why, is
dropped: never ready, never started, refused by path, out of the asking
deferral; `## Building, <date>, session <id>`, the executor's while that
session lives, named by its id or a unique start of it, eight characters
or more; `## Handing over`, resumed first; an `Issue: #<n>.` line
with no `## Ready, <date>` is planned, waiting on GitHub; else a `Plan
only` or `Short plan` header dated 24 October 2026 or later is ready. In pull
request mode `plans` names what each brief and plan looks related to, and
the author answers with a `Related` line.
(decisions.md#plan-state-in-file, decisions.md#related-line)

**A plan put first is built next.** On the owner's word, or, for a
refresh plan, the assistant's on his standing word, `plans first
<path>` writes `First: <date> <time>.` above the first `## ` section of a
waiting plan or brief, where the queue reads it, whatever the header's
shape; the queue puts the files so marked ahead of the
rest, the latest marked on top, then oldest first, a handed-over plan
still before all, and `plans` says `first since` on each. The executor
takes it at the point between two plans and never stops the one in
hand: the tool hook refuses a Building line on another plan while a
ready plan put first is free, one it would not refuse as still asking. The
planner carries a brief's line into its plan, and its tool hook
refuses a write that drops it. The line counts only
while its file waits; `plans first --undo <path>` takes it out.
(decisions.md#plan-put-first)

**A queue has as many executors as its project file's `executors`
says**, one by default, numbered; each works in its own worktree, holds
its number's lock (`.claude/executor.<n>.lock`) and builds one plan at a
time, and the lowest-numbered free one takes the next plan it may build;
a usage reset starts as many as are free. Its Stop hook holds the stop
on a red or unfinished `run` of its push, or a pull request of the plans it took
with a failed check no webhook brings to the assistant, whose fix is pushed
where the red one was, before anything else, then names
the next plan free for it to a session it may reuse ("A chat is kept
while it is cheaper than a fresh one"), else
retires it and starts the next executor in its number, judged at every
stop while a plan waits, the plan it was named included. A plan the usage limit cuts
off, `plans end --now` ends, or whose executor a start finds with no
process, is handed over (work committed, a
"Handing over" section naming the branch and the worktree, stop) and
is resumed in the worktree it was built in; twice at the same step, or six times, it
is written "Built" with the item and handed to the assistant.
(decisions.md#executor-pool)

**A plan waits on another** when it rests on it (its header
paragraph names it and it is not built), lands on its topic, or
changes a file it changes while that one is being built; `plans`
says which and why, a Building line on it is refused, and the next
free plan is taken meanwhile. A plan is claimed for the executor it
is named to, so two never take one. (decisions.md#plan-waits-on)

**A heavy step takes a slot.** The project file's `resources` names
what only so many executors may run at once (`browser: 1`), and a
step of **Before the push** takes one by running as `plans hold
<name> -- <command>`: it waits its turn, oldest first, runs, and
frees the slot when it ends or its process dies. How many executors
write code is `executors`; how many run a heavy step at once is the
resource's number, so the first can be more than the machine runs of
the second. The executor that built a plan runs its checks and
reviews and fixes what they find: the reviews read, each in a
context of its own, and take no slot. From 24 November a word
`plans` does not know exits 2, so a step written for a newer copy
fails on an older one rather than passing having run nothing; a copy
from before then still passes it. (decisions.md#resource-slots)

**A push is not waited on.** The executor runs the project's checks
once, under **Before the push**, pushes and starts the next plan: it
watches no pull request's checks, which repeat them. A run that fails
on a pull request of the queue's own, whatever set it off, reaches the
assistant by the app's webhook, as `failed` in `plans/github/<n>.md`: it reads the
failed log and the diff, reruns the failed jobs once when the diff
does not explain the failure, and writes the fix's short plan,
landing in that pull request, when it does or the rerun fails too.
A failure the diff does not explain on a pull request behind its base
is refreshed, not rerun.
An app that cannot send a failed run, with no Actions permission or
no Workflow run event on its registration, or with them not yet
accepted on its installation, is said once at the start of the
owner's own chat and in `plans`' webhook line while it holds, and
its listener reads failed runs itself every five minutes until it
can. What CI does that the local checks cannot (a deploy, a check that
needs the hosted machine or a secret) is the project file's `run`,
read after a push straight to the branch, and nothing else is. The
executor's Stop hook names a failed check the webhook does not bring,
never one still running: every one where no webhook listens (no
secret, or its listener down), and a check by another service (a
commit status, another app's check) where one does. It reads the
checks with the person's token and, when GitHub refuses that, with the
app's where the project has one; a read both are refused is said in
`plans`, with what the token needs. Failed is a conclusion of failure,
timed out or startup failure, or a commit status of failure or error.
(decisions.md#push-not-waited-on)

**A free plan never waits while an executor is free**: a plan the Stop hook
named to a session that stops without taking it goes to a fresh
executor, the session retired on it; `plans start` gives the next free
plan to the lowest-numbered free executor, an idle chat with room by
the message it prints, an empty number by a fresh start; and a planner's
or an assistant's Stop hook, a retired executor's, or the end timer
that finds a free plan, a free executor (one listed with no process is
free) and the queue open starts
one under "Starts are bounded", two at one moment starting one.
`plans` says under its executors that the next hook or timer starts one,
or why none does. (decisions.md#plans-reach-an-executor)

**A chat is kept while it is cheaper than a fresh one**: a finished
session takes the next plan or brief while its context is under the
ceiling the queue works out for this project and agent, the wash of
`context-cost` from inputs measured in its transcripts, raised by what
the chat read or wrote of the files the work names (at most each
file's size), never over 480k, its cache still warm; the project
file's `reuse` (200k for an executor, 160k for a planner by default)
serves only while the project has under five sessions of the agent.
`plans cost` measures it: each session's turns, context and cost by
agent, from the transcripts, at the prices the script names with the
date they were read. (decisions.md#context-cost,
decisions.md#shared-is-what-is-held, decisions.md#reuse-check-cheap)

**Starts are bounded**: at most `executors` at a time; none while the five-hour
window is above 80 percent or the seven-day above 95, deferred to the
reset; none after a quick death; none once the last five of a kind, in
a day, ended with nothing built, planned or written, however many
started and pushed before them; `plans pause` and `plans resume` on the
owner's "pause the queue" and "resume the queue". After a quick death
or five with nothing the owner decides: on his yes, the assistant runs `plans start --owner-said "<his words>"`,
which starts one more and logs the words. No hook and no executor
passes it, and it passes nothing else.
(decisions.md#starts-bounded)

**Only the assistant's chat is a Remote Control chat**, of one name,
`<Project> Assistant`. A planner or an executor is a background chat
on its machine, named after the project and the machine, `<Project>
Executor 2 (lab)`, and started without Remote Control.
(decisions.md#session-names)

**A finished chat ends an hour after it goes quiet**, by `claude stop`,
which keeps its conversation; a replaced one three minutes after its
successor starts; one with a question or a prompt open never; the
assistant's never for going quiet ("The owner talks to one chat").
`plans end` ends this queue's finished chats now, `plans end <id>` one
of them.
(decisions.md#chat-ends-after-an-hour)

**A chat waits for the owner only while a question or a prompt is open
in it**: `plans` says `waiting for input` from the prompt Claude Code
reports standing, never from its reading of the last turn; a chat whose
turn is over reads `idle` and is a finished chat, and one with no
process `not running`. (decisions.md#waiting-is-an-open-prompt)

**`plans end <id> --now` ends a named chat whatever it is doing**, writes
its plan a "Handing over, <date>, ended with plans end --now" section,
releases the lock and starts a fresh session on it; an assistant chat
named is stopped with nothing started in its place; the assistant runs it
on the owner's word, or its own for a chat that is stuck.
(decisions.md#end-now)

**A hiccup is fixed, not asked about**: a stuck or stale executor, a
plan the queue leased wrongly, a run that fails on what the diff does
not explain, a refused upload or an issue a merge did not close is
fixed by the assistant by whatever
works, `plans end <id> --now`, `plans start`, a rerun or the command
again, and the owner is neither asked nor told. The same fix is tried
twice at most for one fault, and one still there is told as a failure,
with what was tried; never a merge, a forced or production push, or a
start past the owner's word this way. (decisions.md#hiccups-fixed)

**Archiving a chat in the Claude app does not stop it**; `claude stop` or
`plans end` does. (decisions.md#archiving)

**An executor builds in its own worktree**,
`.claude/worktrees/executor-<n>`, which the queue makes with git,
starts the executor's chat in and keeps between plans; `plans/` in it
is a link to the checkout's, a project that tracks `plans/` or
`.claude/settings.local.json` in git is refused, and the git-ignored
files it needs come by `.worktreeinclude`, the `.env` files with none,
and an untracked project file always. The queue's files stay
in the checkout, which nobody builds in: `plans start` moves it to
`origin/<branch>` when its tracked files are unchanged and it holds
no commit of its own, and names any untracked file the move would
overwrite. The executor's number is `WORKFLOW_EXECUTOR` in its chat,
set in the worktree's `.claude/settings.local.json`, for the project's
ports and databases; it edits only its worktree and `plans/`, a brief
for another project's `plans/` and its memory notes aside.
(decisions.md#executors-in-worktrees)

**Each project's queue runs apart from every other, in parallel**: a
change to the workflow goes through the plugin's own queue; a queue's
lock, pause and deferrals are in its checkout and its sessions named for
it.
(decisions.md#queues-in-parallel)

**A checkout is a queue**: two machines' checkouts of one repository are
two queues, sharing only the branch, a message or a brief one writes
into the other's `plans/`. (decisions.md#checkout-is-a-queue)

**Briefs are queued like plans**: a file headed `Brief for the planner`,
taken by the planner's `## Planning, <date>, session <id>` line; `plans
start --agent planner` starts a planner under the executor's bounds.
(decisions.md#briefs-queued)

**A planner with room left takes the next brief**: the oldest brief it
is under its ceiling for, in a session it may reuse ("A chat is kept
while it is cheaper than a fresh one"); else it retires, and `plans start`
leaves a brief with a live planner only
when it is under its ceiling for that brief and not waiting on a
question, by message when it is idle and by its Stop hook when it is
busy, leased for thirty minutes, each brief its own lease: `plans` says
who holds it and until when, its Planning line ends the lease, a brief
sent by message is named by no other planner's stop while its holder
lives, and at the lease's end the timer starts a fresh planner on it
unless its holder is still busy with room, which takes it at its stop
while the lease renews (decisions.md#brief-leased).
(decisions.md#planner-takes-next-brief)

**Asked once.** A decision a plan leaves to the owner is asked for its
planner by the assistant, once, by the planner's `Question for` message,
and by nobody else; a question a plan did not
foresee is decided by its executor, never asked ("An executor never
waits on the owner"). For thirty minutes from the
question the plan is the planner's: `plans` lists it under "Asking
<owner>", no executor takes it, by default or by path, unless the owner
says to the assistant to build it now (his word goes in "Decided" first), and
the tool hook refuses a Building line on it. The planner writes "Decided"
only once every decision is answered, which lets the plan go at once, and
sends it to the executor. Talking does not restart the window; another
question does. Past it, or once the planner's chat has ended, the executor
builds each undecided decision by its recommended option and writes it in
"Decided" as taken for the owner, unanswered, which the assistant lists
in the log; a later, different answer is
a follow-up plan. A planner the owner opened himself holds nothing.
(decisions.md#asked-once)

**An executor never waits on the owner.** It has no question tool, and
no step of a build waits for his word. A question it would put to him (a
decision the plan leaves open, one the plan did not foresee, a choice
inside the plan that the build or a review turns up) it decides: by the
plan's recommended option, or with none by the one the plan, the docs
and the catalogue ground best, the cheapest to undo where they are
silent. It sends the decision to be checked, `Decision to check:
plans/<x>.md.`, to the plan's planner while `plans` lists that chat as
holding the plan and not waiting for input, else to the assistant's
chat, and goes on; the answer, `Checked: plans/<x>.md.`, read before the
plan's commit, agrees or names another of its options, which is built
instead. Each decision is a `Taken on <owner>'s standing word` line of
"Built" and a line of the project's `plans/decisions-taken.md`, which
the assistant keeps for the owner to read when he likes, checking itself
any that went unchecked; a different word from him is a follow-up plan.
Never decided this way: a merge, a push to the default or a production
branch, a forced push, the reversal of a rule with a person's name, a
change outside the plan; each is a "Needs a decision" item for the
assistant. The assistant still asks him, for itself and for a planner,
since neither holds a build. (decisions.md#executor-never-waits)

**The group's message.** A change to another person's part (a rule whose
tier carries their name, or a thing **People** gives them) is built as
any plan, and the pull request is where it is discussed; the brief and
the plan say `Touches <name>'s part`, so the owner knows. No agent drafts
a message for another person unless the owner asked for one in the
conversation; asked, it is in his words, ready to paste. A group that has
already agreed is written in "Decided". (decisions.md#group-message)

**A topic the people discuss is a GitHub issue**: one sentence of what
should be true, the decisions under it, its body written once, when it
is made, and never edited by an agent after; the plan behind it is one
collapsed comment, the planner's, found again by its hidden first line
and edited in place on a change, or the project's Detail address in that
comment; anyone opens one, the assistant writes them on the owner's
word, the executor writes `Closes #<n>` on the pull request for each
issue its plans carry and links it, and the queue closes each when it
merges, whatever branch it merges into. A plan or a brief quoted
anywhere on GitHub is collapsed under a one-line summary.
(decisions.md#issue-is-the-overview, decisions.md#closes-its-issues)

**An issue nobody plans yet carries no status label and no plan line**
until a brief carries its number, and its topic ends as answered, with
the issue's address. (decisions.md#issue-alone)

**The queue speaks on GitHub as the project's own app**, through `plans
gh`, pull requests included; the push and a picture's upload alone are
the person's token. (decisions.md#project-app)

**A plan with an issue is built once planned**: the planner writes its
Ready section on the owner's standing word, labels the issue `status:
ready` and starts it, unless he said to hold that one, which `plans`
lists as planned until the label `status: ready` or his word writes the
section, comments folded by whose call each is; the issue's stage is one
`status:` label, `planning`, `planned`, `ready`, `building`.
(decisions.md#ready-before-built)

**What people with write access write on GitHub reaches the queue by the
app's webhook**: `plans webhook` listens on the container behind the
host's reverse proxy, checks each delivery's signature, notes each event in
`plans/github/`, starts the assistant on it, or sends the open one its
line, and closes each issue a merged pull request's description
closes; a close that fails is noted for the assistant, as a failed run
is; a comment from a person **People** names by login
is an event on any issue or pull request, another writer's only where it
mentions the app, on an issue a plan carries or on one of the queue's own
pull requests; a failed run and a merge arrive the same way in
any project with `land: pull-request`; a delivery the queue takes nothing from is answered and
not kept; `plans github` reads what was missed, says any list GitHub would not give it,
in its own output and in `plans` until a read gets everything, and does
not move its line past what it missed; `plans` says when it last heard
GitHub and when none listened; a listener an older copy of the
plugin started is replaced by the first start that finds it; the assistant
answers as the app, writes the brief, or writes Ready and starts the
build, and acts on a clear task from a person **People** names without
the owner, asking him only what is plainly his.
(decisions.md#github-webhook, decisions.md#note-sent-to-open-chat,
decisions.md#people-act-on-github)

**The day's fixes.** With `land: pull-request`, the day's `Lands: fix.`
plans are one pull request, `Small fixes, <d Month yyyy>`, from
`fixes-<yyyy-mm-dd>`, opened ready with the first fix and rewritten with
each next one, with no comment; it lists each fix's commit title and
screenshots, and under `Already on <branch>` the fixes pushed straight. A
fix after the day's pull request was merged or closed waits for
tomorrow's branch. (decisions.md#days-fixes)

**The executor works in one thread**: a subagent only for the review
against the plan (`workflow:reviewer`), a sweep that would flood its
context (`Explore`), a failure unexplained after two attempts, or one long
verbose read (`general-purpose`), at most four a plan, never during a
suite, each with a four-part brief; never a second executor;
`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` is 1. (decisions.md#one-thread)

**A second model reviews every plan's diff.** Codex reads the branch in a
throwaway worktree and writes bugs only to
`plans/<topic>/codex-review.md`, through `scripts/codex-review.sh`, once
per plan, under a timeout; the executor checks each finding and lists its
verdict in "Built". It never gates: when it cannot run, the build goes
on. (decisions.md#second-model)

**The plan review reads the screenshots too.** The executor's brief to the
reviewer names each screenshot and the catalogue files the Words table's
kinds name, and the review says what on screen is unlike those rules;
nothing without screenshots or a catalogue. A scenario's screenshot is
read for its "then" ("A behavior is written as a scenario").
(decisions.md#screens-reviewed)

**The turn audit** (`scripts/turn-audit.mjs`): once per turn, a session
that changed more than one file says at its Stop why each was needed,
and "The audit's checks" apply where the project names `ui` and its
catalogue; a session answers only for its own writes, and the planner and
the assistant are never audited. (decisions.md#turn-audit)

## Changing the workflow

**A change to the workflow is planned and built in the plugin's own
repository**: `/workflow:change` keeps its checkout beside the project,
writes the brief or short plan into its `plans/` and starts its queue;
`plans` acts on the repository it runs in; CI moves `main` on a green
`test`, and every machine picks the change up at its next session.
(decisions.md#change-in-plugin-repo)

**A change the plugin leaves for the project it came from goes back as a
brief.** The brief carries `From: <Project>, <path>.`, and the plan keeps
it; the planner writes that project's half as a `## For <Project>:
plans/<topic>.md` section in the four parts, and after the push the
executor writes it into that checkout's `plans/` and starts its planner,
the Stop hook holding the first stop until the file exists.
(decisions.md#leave-back-as-brief)

**The plugin's repository is public and names no project**: no tracked
file holds a host's address, a personal email, a token or the name of a
project the workflow runs in, and `test/public.test.ts` refuses each.
The one exception is the repository's own address, as "Installing"
gives it. (decisions.md#public-names-no-project)

## Installing

```
claude plugin marketplace add wordplaylabs/workflow-plugin#main
claude plugin install workflow@workflow --config owner="<name>"
```

A newcomer pastes one line into Claude Code, "Install the workflow
plugin from https://github.com/wordplaylabs/workflow-plugin by following
its INSTALL.md", and Claude runs these two commands, merges the settings
below with the person's yes, and offers `/workflow:setup`; `INSTALL.md`'s
JSON block is a copy of this one, and a test fails while they differ.
(decisions.md#install-one-line)

```json
"extraKnownMarketplaces": {
  "workflow": {
    "source": { "source": "github", "repo": "wordplaylabs/workflow-plugin", "ref": "main" },
    "autoUpdate": true
  }
},
"enabledPlugins": { "workflow@workflow": true },
"statusLine": {
  "type": "command",
  "command": "node \"$HOME/.claude/plugins/data/workflow-workflow/statusline.mjs\""
},
"worktree": { "bgIsolation": "none" },
"env": { "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "1" }
```

The owner's name is the plugin option `owner`; the machine's label is
`machine` (`echo '{"machine":"<label>"}' | claude plugin configure
workflow@workflow --values-stdin`).

**The plugin checks its own install at every session's start.** An
installed copy missing any of the plugin's files is said in the
session's first context and `plans`'s first line, with the files and
the fix (the files put back from the marketplace's clone at the copy's
commit, or the newer version installed when there is one; nothing is
deleted; a copy loaded from a folder, or an older version than the
installed one, gets no command, only a new chat). The session's context
carries the line and the steps the check writes for it: the agent says
the line to the owner first, asks once whether to install again, runs
the fix and the check again on yes, and does nothing else in that chat;
each agent file keeps one sentence pointing at the line.
(decisions.md#install-checks-itself)

**`plans` is a command in the owner's terminal too.** A SessionStart
hook writes `~/.local/bin/plans`, where Claude Code's own installer puts
`claude`, a shell wrapper that runs the installed copy named by Claude
Code's install record at each call, so a plugin update changes what it
runs with no step from anyone, and a rebuilt container has it back after
its first chat. A PATH without `~/.local/bin` is said in the owner's
own chats at each start while it holds, with the line to add, and never
in a chat the queue started, which nobody reads; a copy the record names
that is gone is said by the wrapper, with the update command; a file
there that is not the plugin's is left alone and said.
(decisions.md#plans-in-the-terminal)

**A push needs a token in the container**: a fine-grained `GH_TOKEN` on
the host (Contents and Workflows read and write, Actions and Metadata
read; with `land: pull-request`, Pull requests read and write, Checks
and Commit statuses read), carried in by the devcontainer's
`"containerEnv": { "GH_TOKEN": "${localEnv:GH_TOKEN}" }`, which the setup
writes, with `gh auth setup-git --hostname github.com` from the
dotfiles; its value is in no file, and `gh auth status` says when it
expires. A project with issues carries its app's id and private key the
same way, `WORKFLOW_APP_ID` and `WORKFLOW_APP_KEY` (the PEM's text),
from which `plans gh` mints the app's token, and its webhook's secret
and port, `WORKFLOW_WEBHOOK_SECRET` and `WORKFLOW_WEBHOOK_PORT` (8789
when unset). The app has Issues, Pull requests and Actions read and
write and is subscribed to the events the webhook reads: Issues, Issue
comment, Pull request, Pull request review, Pull request review comment
and Workflow run; without Actions and Workflow run no failed run reaches the
queue, and without one of the others its notes do not. The push stays
the person's token. `plans gh`
with no app says the same, and `plans webhook` with no secret names the
same events, both from the webhook's own list. Any
of the four variables left out of
the environment is read, when the queue uses it, from the private dotenv
file that `WORKFLOW_SECRETS_FILE` names (a relative path from the
checkout's root), and never put into the environment, so the key stays
out of every other program's environment. (decisions.md#push-token)

**Screenshots on a pull request** or an issue are uploaded with the
owner's own gh login and written into text the project's app posts, by
`plans gh pr create --attach`, `plans gh pr edit --attach` and the
same for an issue: a stored image is the one thing under his name,
never a post. A picture that does not go up posts nothing, and `plans
gh` says why. A project with no app attaches with gh's own flag under
the person's login, which needs gh 2.99 or newer (from GitHub's apt
repository; Debian's is 2.23). (decisions.md#screenshots-attach)

The research-writing skills are a second plugin, `writing@workflow`, that
a project turns on in its `.claude/settings.json`.
