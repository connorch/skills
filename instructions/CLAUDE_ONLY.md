This file contains instructions that are only useful to agents running Claude Code. If you are not operating in claude code, ignore these instructions.

## General Preferences - Claude Code

* If computer use is helpful for completing or verifying work, shell out to gpt-6-astra with Codex for it. If project has preferred browser automation instructions, use that.

## Picking the right models for workflows and subagents

Rankings, higher = better. Cost reflects what I actually pay (OpenAI is near-free for me due to a deal), not list price. Intelligence is how hard a problem you can hand the model unsupervised. Taste covers UI/UX, code quality, API design, and copy. Focus measures how well an agent stays on-task without getting sidetracked—important for agents handling longer, complex tasks requiring ongoing decision making and orchestration.

| model       | cost      | intelligence | taste | focus |
| ----------- | --------- | ------------ | ----- | ----- |
| gpt-6-astra | 7 (cheap) | 9            | 7     | 9     |
| sonnet-5    | 6         | 5            | 7     | 7     |
| opus-5.5    | 5         | 8            | 9     | 8     |
| fable-5.1   | 3         | 9            | 9     | 9     |

### How to apply

* These are defaults, not limits. You have standing permission to override them: if a cheaper model's output doesn't meet the bar, rerun or redo the work with a smarter model without asking. Judge the output, not the price tag. Escalating costs less than shipping mediocre work.
* Cost is a tie-breaker only; when axes conflict for anything that ships, intelligence > taste > cost. Focus determines the scale of work that a model can handle - longer projects need higher focus.
* Don't let cost prevent you from using the right model for the job. Instead, take advantage of cheaper options to get more information and try things before moving the work to a more expensive option.
* Bulk/mechanical work (clear-spec implementation, data analysis, migrations): gpt-6-astra - it's effectively free.
* Anything user-facing (UI, copy, API design) needs taste >= 8.
* Reviews of plans/implementations: fable-5.1 or gpt-6-astra.
* Never use Haiku.
* Mechanics: gpt models are only reachable through the Codex CLI - `codex exec` / `codex review` (my `~/.codex/config.toml` defaults to gpt-6-astra). Use the codex-implementation, and codex-review skills; for work they don't cover (investigation, data analysis), run `codex exec -s read-only` directly with a self-contained prompt.
* Claude models (sonnet, opus, or fable) run via the Agent/Workflow model parameter.

### Using gpt-6-astra inside workflows and subagents (the model parameter only takes Claude models, so use a wrapper)

* Spawn a thin Claude wrapper agent with `model: 'sonnet', effort: 'low'` whose prompt instructs it to write a self-contained codex prompt, run `codex exec` via Bash, and return the report (use `schema` on the wrapper to get structured output back).
* Always label these agents with a `gpt-6-astra:` prefix, e.g. `{label: 'gpt-6-astra:review-auth'}` - the workflow UI shows the wrapper's Claude model, so the label is the only indication the real worker is gpt-6-sol.
* Codex runs can exceed Bash's 10-minute timeout: pass an explicit timeout, or run in the background and poll for the report file.
* Parallel gpt-6-astra implementation agents must use `isolation: 'worktree'` so codex edits don't collide in the shared checkout.
* Workflow token budgets only count Claude tokens; codex work is free and invisible to `budget.spent()`.
