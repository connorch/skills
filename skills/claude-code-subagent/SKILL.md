---
name: claude-code-subagent
description: Delegate a bounded task to Claude Code CLI (`claude -p`) as a headless subagent, then review what it produced. Use when the user asks to hand work to Claude or Claude Code, when a multi-file implementation, refactor, investigation, or independent review would benefit from a second coding agent, or when heavy work should run on the user's Claude subscription. Not for use from inside Claude Code itself.
---

# Claude Code Subagent

Use Claude Code as a separate agent for bounded work. It runs headless with `claude -p` on the user's Claude subscription and exits with a single JSON result. You remain responsible for scoping the task, reviewing what it changed, running or checking verification, and explaining the final result.

If `CLAUDECODE` is set in your environment, you are already Claude Code. Use native subagents instead of this skill.

## Modes

| Mode | Use for | Permission mode |
| --- | --- | --- |
| Implement | Code changes, refactors, fixes | `auto` |
| Read-only | Review, investigation, second opinion, planning | `plan` |

Always pass `--permission-prompts none` so anything that would need a human prompt is denied instead of stalling the run. Claude keeps working around denials, and they are listed in the result's `permission_denials`.

Never pass `--dangerously-skip-permissions` or `--permission-mode bypassPermissions`. Auto mode's classifier blocks exfiltration, destructive git operations, force pushes, and similar actions; that is the safety layer for an unattended run. Auto mode does not support Haiku models, so do not combine it with `--model haiku`.

## Workflow

1. Pin the current state with `git status --short` and note any user changes already present.
2. Define the scope: behavior to change, files or areas to avoid, constraints, and verification commands.
3. Decide isolation. If you will keep editing the same checkout while Claude runs, give Claude its own worktree (`git worktree add <path> -b claude/<slug>`) and install dependencies there before verification. Otherwise run in place and do not touch the files until Claude exits.
4. Create a temporary artifact directory and write a self-contained prompt to it.
5. Launch `claude -p` in the background.
6. Shortly after launch, check once that the process is alive and `run.log` shows no error.
7. Wait for the `exit_code` file, then read the result JSON.
8. Inspect `git status` and `git diff`, and run the cheapest reliable verification yourself when practical.
9. Report what Claude changed, what you verified, any permission denials, and any remaining risks or open questions.

Use this command shape:

```bash
ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/claude-subagent.XXXXXX")"
PROMPT="$ARTIFACT_DIR/prompt.md"
RESULT="$ARTIFACT_DIR/result.json"

# Write a self-contained prompt to $PROMPT, then run from the repo (or worktree) root:
claude -p \
  --permission-mode auto \
  --permission-prompts none \
  --output-format json \
  --max-turns 80 \
  <"$PROMPT" >"$RESULT" 2>"$ARTIFACT_DIR/run.log"
echo $? >"$ARTIFACT_DIR/exit_code"
```

For read-only mode, swap `--permission-mode auto` for `--permission-mode plan`.

The prompt is passed on stdin, so there is no argument-length limit and no interactive stdin for the run to hang on. Leave the model unset so the user's configured default applies, unless the user asked for a specific model.

If `claude` is not installed, is not logged in, or the command fails, report the error from `run.log` and offer to do the work directly instead.

### Reading the result

`$RESULT` holds one JSON object. Check these fields:

- `is_error` and `subtype`: `success` means Claude finished. `error_max_turns` means it hit `--max-turns`; resume it or narrow the scope.
- `result`: Claude's final report.
- `session_id`: needed to resume for follow-ups.
- `permission_denials`: actions auto mode or the prompt policy refused. Decide whether each one matters. Do not rerun with looser permissions to get around a denial; report it to the user instead.
- `num_turns` and `total_cost_usd`: how heavy the run was. On a subscription, the cost is a list-price equivalent, not a charge.

```bash
jq '{subtype, is_error, num_turns, permission_denials, session_id, result}' "$RESULT"
```

Use `python3 -m json.tool "$RESULT"` if `jq` is not installed.

### Follow-ups

To fix or extend Claude's own work, resume its session instead of starting fresh. It keeps the context of what it already did:

```bash
claude -p --resume "$SESSION_ID" \
  --permission-mode auto \
  --permission-prompts none \
  --output-format json \
  <"$ARTIFACT_DIR/followup.md" >"$ARTIFACT_DIR/result-2.json" 2>>"$ARTIFACT_DIR/run.log"
```

Use the `session_id` from the most recent result.

### Running in the background

Real tasks commonly take 5 to 30 minutes, longer than most tool-call timeouts. Run the command in the background with your harness's background mechanism, or with `&` and a long wait.

- The `exit_code` file is the completion signal. Do not read the diff or the result until it exists.
- After the early liveness check, wait for exit rather than polling repeatedly.
- If the run is killed partway through, Claude's edits are left half-applied. Inspect `git diff` before doing anything else.

### Running from a sandboxed shell

`claude` needs outbound network access to Anthropic and write access to `~/.claude` for sessions and auth refresh. Inside a sandbox such as Codex's `workspace-write`, it fails with auth or network errors that look unrelated. Request to run the `claude` command outside the sandbox (escalated permissions) instead of weakening Claude's own permission mode.

`claude` uses the Claude login of the OS user running it. If it reports that it is not authenticated, ask the user to run `claude` interactively once to sign in.

## Prompt Requirements

Claude starts with no context from your conversation. The repo's `CLAUDE.md` loads automatically, so do not repeat it. Tell Claude:

- That it is running as a headless subagent and no human can answer questions, so it should make reasonable assumptions and list them in its report.
- The repo path, branch context if relevant, and the files or entry points to start from.
- The exact task and acceptance criteria.
- That it must preserve unrelated user changes.
- That it must not commit, push, open pull requests, deploy, or edit global config unless that is explicitly in scope.
- For read-only mode, that it must not modify any files.
- Which verification commands to run, or to explain why they were skipped.
- To end with a concise report: files changed, verification run and result, assumptions, and anything blocked or uncertain.

Keep the task bounded. If the work bundles several substantial changes, split it into separate runs or ask the user to choose the first scope. Every run draws on the user's Claude subscription limits, so prefer one well-scoped run over many small ones, and do not run more than two or three in parallel without asking.

## Example Prompts

Implementation:

```text
You are a headless subagent implementing a scoped change. No human is available to answer questions: make reasonable assumptions and list them in your report.

Repository: /absolute/path/to/repo

Goal:
- Add keyboard navigation to the command palette.

Acceptance criteria:
- ArrowUp and ArrowDown move the highlighted item.
- Enter selects the highlighted item.
- Escape closes the palette.
- Existing mouse behavior keeps working.

Constraints:
- Preserve unrelated user changes.
- Do not commit, push, open pull requests, deploy, or edit global config.
- Follow existing component and test patterns.

Verification:
- Run the focused component tests if available.
- Otherwise run the nearest relevant typecheck or test command and explain the choice.

Report:
- Files changed
- Behavioral summary
- Verification run and result
- Assumptions made
- Anything blocked or uncertain
```

Read-only review:

```text
You are a headless subagent doing a read-only review. Do not modify any files. No human is available to answer questions.

Repository: /absolute/path/to/repo
Scope: the uncommitted changes (`git diff`) plus any files they touch.

Look for correctness bugs, missed edge cases, and regressions. For each finding give the file and line, a concrete failure scenario, and your confidence. Skip style nits. If you find nothing substantive, say so.
```

## Review After Claude

Always inspect Claude's diff before telling the user the work is done. In read-only mode, confirm `git status` is unchanged from step 1. Revert only Claude-created mistakes when you are sure they are not user changes. If Claude leaves the repo in a worse state or changes unrelated files, stop and report the issue with the diff summary. If you used a worktree, merge or cherry-pick its changes only after review, then remove the worktree.
