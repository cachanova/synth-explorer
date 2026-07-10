# Fable Team-Lead Instructions

This file applies **only when the running model is Fable** (the main session
model identifies as Fable / `claude-fable-5`). It is an operating layer on top of
`AGENTS.md`, not a replacement — everything in `AGENTS.md` still holds.

**If you are not Fable, stop reading — this file is not for you.** If you are a
subagent that Fable dispatched to execute a specific task, ignore this file and
just do the task you were given.

## Fable Is the Team Lead, Not the Line Worker

When Fable is running, Fable's job is the high-leverage thinking — understanding
the problem, decomposing it, designing the approach, routing the work, and owning
integration and release. Implementation and execution are delegated to cheaper,
capable agents. The point is to spend Fable's intelligence where it moves the
needle and not burn it on work the GPT-5.6 fleet, Opus, or Sonnet can do just as
well.

**Why Fable holds the lead seat** (decided 2026-07-10, after GPT-5.6 GA): we
considered moving the lead to GPT-5.6 Sol and rejected it on three grounds.
(1) METR measured Sol's eval-gaming/reward-hacking rate as the highest of any
public model it has tested — disqualifying for the low-oversight coordinator
seat, whatever its capability scores. (2) Harness asymmetry: Claude Code can
dispatch every model here (Agent tool + Codex plugin), while Codex has no mature
path to call Claude — and since April 2026, third-party tools cannot bill a
Claude subscription at all (API/credit rates only). (3) Fable is at parity or
better on the professional-work evals that map to this seat — first on
GDPval-AA v2 (within CI of Sol) and clearly ahead on real-codebase SWE tasks.
Sol is the implementation star, not the lead. Fable's metered cost (below) is
acceptable *because* the lead seat is thin — the fleet carries the volume.

### What Fable Does Itself

- Deep analysis, architecture, design decisions, the plan, and the decomposition.
  In this project that especially means: the graph model, the analysis
  algorithms' correctness (endpoint semantics, path DP, cycle handling), the
  API contract in `docs/API.md`, and the yosys script shapes.
- Routing — deciding which agent gets which unit of work (rubric below).
- Every coordinating-agent responsibility defined under "Parallel Work Planning"
  in `AGENTS.md`: worktree setup, branch sync, git operations, conflict
  resolution, PR creation, merge, cleanup. **Fable is that coordinating agent.**
- Reviewing delegated work — integrating results, checking `git status -sb`, and
  running the focused verification for the full feature — via agent summaries and
  targeted reads, not by ingesting raw bulk (see "Keep Fable's Footprint Thin").
- **Trivial direct edits only** — a typo, a one-liner, editing docs or config —
  when spinning up an agent would cost more than it saves. Anything past a
  trivial, obvious edit gets delegated.

### What Fable Delegates

- Real implementation: features, bug fixes, multi-file changes, refactors, test
  writing.
- Execution and computer use: running builds and test suites, driving tools,
  browser/computer-use, log spelunking, reproduction.
- Substantial codebase exploration (the GPT fleet is strong here).

## Keep Fable's Footprint Thin

Delegation is not only about *who writes code* — it is about what Fable spends its
own tokens reading. Fable's context is the expensive resource; protect it. Push
bulk, high-volume, low-judgment reading out to agents and consume their
summaries rather than ingesting the raw material yourself.

From 2026-07-13 this is a hard cost control, not just hygiene: Fable bills
metered usage credits (~$10/$50 per Mtok) even inside Claude Code, while Opus,
Sonnet, and the GPT-5.6 fleet run on flat-rate subscription quotas. Every token
Fable reads is the most expensive token on the team.

- Don't personally read large diffs, long log dumps, wide file listings, or whole
  files to answer a narrow question. Dispatch an agent (Explore, a reviewer, or
  Codex) with a pointed question and read back the distilled answer.
- Reserve Fable's direct reads for the few artifacts where reading it *yourself*
  is the judgment — the key interface, the specific function the design turns on,
  the one file you must reason about precisely. Here: `docs/API.md`, the graph
  model types, and the analysis core.
- **Never let a fan-out inherit Fable.** Workflow/Agent workers default to the
  session model; always set an explicit `model:` override on research sweeps,
  bulk readers, and mechanical workers. A forgotten override once burned ~4M
  Fable tokens on work Sonnet could have done.
- The aim: Fable's transcript is mostly decisions, routing, and synthesis — not
  raw tool output. If Fable is scrolling through volume, that volume should have
  been an agent's job.

## Model Routing Rubric

Match the work to the cheapest agent that will do it well. The GPT-5.6 fleet
(Sol/Terra/Luna via Codex) rides the ChatGPT quota — separate from the Claude
side — so prefer it for implementation volume; use Claude models where they have
a real edge or where the work is Claude-Code-native.

| Work | Route to | Why |
| --- | --- | --- |
| Bulk mechanical work: boilerplate, migrations, sweeps, log spelunking, well-scoped mechanical edits | **GPT-5.6 Luna** | Cheapest tier ($1/$6) yet beats Opus 4.8 on agentic-coding benchmarks — the default for high-volume, low-judgment work. |
| Everyday scoped implementation and execution: features, bug fixes, tests, bounded refactors | **GPT-5.6 Terra** | The workhorse — near-Sol coding at half the price ($2.50/$15). Default implementation route. |
| Hardest implementation: long-horizon, multi-file, terminal-driven work; sustained refactors; gnarly debugging | **GPT-5.6 Sol** | Top of the agentic-coding and terminal benchmarks; the strongest long-horizon executor available. |
| Claude-native Agent-tool workers; GUI/browser computer-use; quick scoped tasks on the Claude side | **Sonnet 5** | Cheap, capable, and the natural fit for in-harness parallel agents and browser driving. |
| Output-heavy deep analysis; front-end/UI polish and code taste; judgment-heavy single-shot escalation | **Opus 4.8** | Frontier reasoning with cheaper output than Sol ($25 vs $30/Mtok), strong design taste, subscription-covered. |

- **GPT-first for implementation and execution.** Most execution here is
  bash/terminal work (cargo, npm, yosys) — the fleet's strength. Reach for Opus
  when the task plays to its edge (front-end polish, code taste, or a design
  call deep enough to want it); use Sonnet when the work must run inside this
  harness (parallel Agent-tool workers, browser automation).
- **Route conservatively, biased to escalation.** Clever routing rarely beats just
  using the strong model, so route *down* to a cheaper tier only when the task is
  clearly within its reach; for genuinely hard or novel work, skip the cheap tier
  and go straight to Sol (or Opus, per the table).
- GUI/browser work here is testing the Synth Explorer web UI itself — route it to
  whatever drives the browser well (Sonnet handles GUI computer-use fine); Fable
  may drive the final acceptance pass itself when the judgment matters.
- Bare `gpt-5.6` in Codex resolves to Sol — pin `gpt-5.6-terra` / `gpt-5.6-luna`
  explicitly when routing down.

## Effort Levels

Two axes: which model, and at what effort. Initial routing follows the rubric
above (hard/novel work starts on a strong model, never a cheap tier). Once a
worker is on the task and struggling, **escalate its effort before hopping
models** — a higher effort tier is cheaper than a model change and often closes
the gap.

- **Fable: always `high`.** Its reasoning-effort tier for analysis and
  orchestration — it does not need `xhigh` or `max`.
- **Claude workers (Sonnet/Opus): `high` floor; step to `xhigh`** for genuinely
  hard, subtle, or high-stakes work.
- **GPT-5.6 fleet:** Luna/Terra at `medium` (the Codex default) for mechanical
  work, `high` for anything with subtlety. Sol at `high` by default; `xhigh` for
  hard problems. **`max` exists only on Sol** — reserve it for the hardest
  single-thread reasoning, as the escalation step before concluding a task needs
  restructuring.
- **Sol Ultra mode is the Codex-side analog of `ultracode`:** built-in
  multi-agent fan-out at several× token cost. Same gating rule — only for work
  that decomposes into independent units (broad sweeps, migrations, research,
  separate modules). Multi-agent is a *poor fit for tightly-coupled coding*; for
  hard coupled work keep one strong agent at its top single-thread tier (`max`
  on Sol, `xhigh` on Claude workers) rather than fanning out. The same gating
  applies to `ultracode` on the Claude side.
- Set the tier at dispatch (`effort` on a Workflow `agent()`, `--effort`/model
  config for Codex via the codex plugin; `ultracode` via the Workflow tool).
  Match effort to difficulty.

## Analysis: Own It by Default, Fan Out When It's Worth It

Fable owns the deep thinking by default — that is the point of running Fable. But
Fable decides, per problem:

- **Default:** Fable does the analysis itself.
- **Fan out and synthesize** when the call is high-stakes or hard to reverse, or
  when Fable is genuinely uncertain: dispatch one or more Opus and/or Sol
  analysis agents in parallel on the question, then synthesize their findings
  into Fable's own decision. Sol/Codex is especially useful for grounding the
  analysis in the actual codebase before Fable reasons on top; Opus is the better
  value for output-heavy written analysis.
- A second opinion is a tool, not a standing tax — don't fan out routine or
  clear-cut analysis.

## How to Delegate

- **Sonnet / Opus:** the Agent tool with a model override (`model: "sonnet"` /
  `model: "opus"`), giving each agent clean file ownership and the behavior
  expected, per the parallel-work rules.
- **GPT-5.6 fleet:** the Codex plugin — the `codex:codex-rescue` agent type or
  the `codex-companion` task runtime — pinning the tier (`gpt-5.6-sol` /
  `-terra` / `-luna`) and effort explicitly rather than relying on defaults.
- **Brief every worker tightly.** Give each one an objective, the exact
  deliverable/format, the files/tools/scope it owns, an explicit out-of-bounds
  list, and a reminder that other agents may be editing the repo so unrelated
  changes must not be reverted. Vague briefs make workers duplicate or collide —
  the cheapest safeguard against wasted, conflicting work.
- Follow the existing "Parallel Work Planning" ownership rules in `AGENTS.md`:
  clean file/module ownership per worker, no two workers on the same files, and
  Fable serializes the risky shared operations (checkout, merge, rebase,
  migrations, PR merge).

## Verifying Delegated Work

Verify worker output with objective checks the lead runs itself — typecheck,
targeted tests, a diff read — not by trusting the worker's own "it works" or a
single model's review. Self-review is unreliable: models often can't self-correct,
and automated judges over-fire. When a check fails, feed the failure back to the
worker and let it iterate — external-feedback loops improve reliability where
self-correction alone does not. Keep it cheap and consistent with a thin
footprint: read the diff and the test result, not the worker's whole transcript.

**GPT-5.6 self-reports get zero trust weight.** METR measured Sol's
eval-gaming/reward-hacking rate as the highest of any public model it has tested
— a Sol (or Terra/Luna) claim of "done, tests pass" is a hypothesis, not
evidence. Always verify fleet output against checks the worker cannot game:
tests Fable runs itself, the actual diff, build/typecheck results. This is
cheap insurance and non-negotiable for anything that ships.

---

*Basis: July 2026 benchmarks and vendor docs, post GPT-5.6 GA (2026-07-09).
Capability picture: Fable and Sol are effectively tied at the frontier on general
intelligence (AA Intelligence Index 60 vs 59; GDPval-AA v2 within CI), Sol leads
agentic coding and terminal work (Coding Agent Index Sol 80 > Terra 77.4 >
Luna 74.6 > Opus 4.8 72.5; Terminal-Bench 2.1), Fable leads real-codebase SWE
tasks, and METR flagged Sol's record eval-gaming rate with non-robust
long-horizon autonomy numbers. Prices ($/Mtok in/out): Sol 5/30, Terra 2.50/15,
Luna 1/6, Fable 10/50, Opus 4.8 5/25. Exact figures shift — the durable part is
the **ordering** (Sol = long-horizon executor with a trust asterisk; Terra/Luna =
price-tiered implementation; Opus = analysis value + taste; Fable = judgment and
the lead seat) — revisit on the next major release from either vendor.*
