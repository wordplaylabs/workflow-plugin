# Handing a topic on

The assistant reads this whole, when it is not already in front of it,
before it writes or drops a short plan or a brief, and when a `Built:`
message comes (decisions.md#agent-file-length). `<the owner>` is the
owner's name as the agent file gives it. A name in quotation marks
that is no heading or lead-in here is a rule of the handbook or a
heading of the agent file ("What crosses chats", "What you tell him
unasked").

## A short plan

With `land: pull-request`, its `Lands` line: `Lands: fix.` when its
"Decided" records nothing a rule did not settle and it changes no rule
with a person's name (a plan with a decision in it is a topic's; a fix
to tests, or a doc line that only records how the product already
works or how a test is written, is a fix); `Lands: fix, now.` only when
the owner wants it on the site at once; else
`Lands: topic <name>.` (a topic `plans` lists, or a new one): its pull
request opens by itself once nothing more of the topic is queued, so
never ask him whether a topic is ready. Asked to mark a pull request ready, give the step,
the Ready for review button, and run nothing ("`land: pull-request`
lands by pull request").
Write it by "A short plan", run `plans start plans/<topic>.md` and
do what its line says: send the message it gives to the chat it
names, once, or nothing; the message is `Plan ready: plans/<topic>.md. Build it when you are free, in queue order; nothing to answer.`. When
the owner wants a plan or a brief ahead of the others, run
`plans first plans/<topic>.md` before `plans start` ("A plan put first is
built next"), on his word only; `plans start` then gives
`Plan first: plans/<topic>.md. Build it next, once the plan in hand is built; nothing to answer.` in place of the other message, for a plan already waiting too;
`plans first --undo plans/<topic>.md` takes it back. A plan `plans`
lists under "Asking <the owner>" is not sent; say when it is
free.

```
# <Title: what the project does after the change>

Short plan, <date>, by the assistant with <the owner>; the executor builds it.
Read with <the project's docs> ("<rule names>").

Lands: <fix | fix, now | topic <name>>.
Related: <#<n> | branch <name>, joined by "and">.

## What was asked
## Decided, <date>
## Done when
## The change
## The words
## Building it
## Not in this plan
## Sources
## Decisions for <the owner>

None.
```

"Done when" is every check the executor runs, its command or what is
looked at, the test files and cases to add among them; a behavior a
person sees is a scenario, When <what they do>, then <what they see>,
naming its test or the screen ("A behavior is written as a scenario").
"The change" names every file and function and each part's rule. "The
words": `| String | Where | Kind | Shown by | Rests on |`, or a line
saying none changes. "Sources": addresses, or "None: every string
follows a named rule or is free". Under six thousand characters; `Lands`
and `Related` only with `land: pull-request`.

## A brief

Write it as a prompt
("A brief or a plan is a prompt for the agent that reads it"): "What
was asked" (their words, your paragraph); "Decided, <date>" for what
was settled; "Done when" (the checks he would run or look at, a
behavior as When <what he does>, then <what he sees>); "Where to look"
(docs, plans, files, commits, addresses). Another person's part gets
the `Touches` line; when the owner asks for a message, it goes in the brief's "Decided" for the planner to write.
Its `Lands` line only when the **Pull requests** heading sends it into
an open pull request of the queue's own; the planner carries it.

```
# <Title: what the project does after the change>

Brief for the planner, <date>, by the assistant with <the owner>. The planner's plan replaces this file.

Lands: topic <name>; lands in #<n>.
Related: <#<n> | branch <name>>.
From: <Project>, <path>.
Issue: #<n>.

## What was asked
Touches <name>'s part (<what>), by the project file's People.
## Decided, <date>
## Done when
## Where to look
```

Then `plans start --agent planner plans/<topic>.md`: it starts a
planner, or prints a message to send once with `SendMessage`, or says
one takes it at its next stop, or says why not. One start or message
per brief; a correction goes by "What crosses chats".

## Either one

**Related work**, with `land: pull-request`: when `plans` says the new
file `looks related to` a pull request or branch, open it, then go by
the project file's **Pull requests** heading: a pull request of the
queue's own the heading says to share gets `Lands: topic <its topic,
from the plans line>; lands in #<n>.`, whether it is a draft or
marked ready, and no question; otherwise, when it is the same thing, add
`Related: #31.` or `Related: #31 and branch <name>.` under the `Lands`
or header line and say what it does and whose it is. A shared file alone
gets no line.

**A plan rested on.** Name an earlier plan in the header line only when
it uses what that plan adds, never for a shared file. Then it goes in
that plan's pull request: an open draft of this queue's own it lands in
("lands in #<n>", its `Lands` that draft's topic), another person's it
is stacked on ("stacked on #<n>"), one of this queue's marked ready by
the **Pull requests** heading, stacked without it, after the name:
`Lands: topic <name>; lands in #<n>.` or `; stacked on #<n>.`.

**Dropping.** A brief or short plan nobody has taken gets `## Dropped,
<date>` under its header paragraph, after any `Lands` or `Related`
line, with `Dropped on <the owner>'s word: <why>.`; with an
`Issue` line, `plans gh issue close <n> --reason "not planned"
--comment "<the Dropped line>"`.

## After a build

**Follow-ups.** On `Built: plans/<x>.md.`, as a message or the prompt
you were opened on (the two for one plan are one), tell him ("What you
tell him unasked"), read that plan's "Built", log what was taken ("Decisions
taken"), then, for its "Needs a decision" items and any decision you
would change, write `plans/<topic>-follow-up.md` naming it in its first
line, or a brief for an item bigger than marked, and hand it on. A
change to a plan or brief a live planner holds (no Building line) goes
to that chat by "What crosses chats"; after its Building line, or with
the chat gone, it is your follow-up, a decision taken for the owner
unanswered included ("Asked once"). A `Screenshots not attached` line
whose cause is the login gh has (none, ended, refused) is a step only he
can take, told once with the cause as written; once he says it is done,
write one short plan per topic's pull request still
without them, `Lands: topic <its head branch>; lands in #<n>.`,
whose one step is the description written again with `--attach` for the
files its plans' "Built" sections name; a day's fixes pull request
(`fixes-<date>`, no topic's branch) is told to him with the files' paths
instead.

## Decisions taken

- **`Built: plans/<x>.md.`**, before the follow-ups: add to
  `plans/decisions-taken.md`, under the day's `## <d Month yyyy>`
  heading, newest day first, a line for each `Taken on` line of "Built",
  the executor named by the message's sender,
  `- plans/<x>.md, <the executor's name>: <the question>. Taken: <the option>. Checked with <chat's name>: <agreed | changed it from <option> | no answer>. <Cheap to undo by a short plan | Undoing it costs <what>>.`,
  and for each "Decided" line the executor took unanswered ("Asked
  once"), the same with `Checked with nobody: the planner's recommended option, unanswered for thirty minutes.`
  One with no answer, or checked with nobody, you check now, as the agent file's "Decisions taken" says of a decision to check,
  and its line says `checked by the assistant after the build`; where
  another option is better grounded, write the follow-up that changes it
  and name it in the line.
- **The file**, written when missing: `# Decisions taken for <the owner>, for his review`, then `Kept by the assistant. No executor asks <the owner> or waits on him: each decision one would have asked is taken by the recommended option, checked with the plan's planner or the assistant, and listed here, newest first. A different answer from him is a follow-up plan.`
- **When he asks what was decided for him**, answer from the file and
  send it with SendUserFile; a line he changes is a follow-up
  ("Follow-ups"), and the line gains `Changed by <the owner>, <d Month>: plans/<y>.md.`
