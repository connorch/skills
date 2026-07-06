---
name: codex-computer-use
description: Runs Codex CLI as a separate local verification agent for computer-use checks, screenshots, simulators, browsers, and app runtime inspection. Use when verifying local app UI behavior, visual state, playback, desktop/browser flows, or artifacts that need independent computer-use interaction.
---

# Codex Computer Use

Use Codex as a separate local verification agent when the task needs real UI interaction, screenshots, simulator/browser/device state, or an independent runtime check outside Claude's current context.

Do not use this for ordinary code reading, typechecking, linting, or tests Claude can run directly. Launching apps, simulators, or browsers to verify the requested work is fine without asking; ask first only if the run could disrupt the user's environment beyond that, such as closing their apps, changing system settings, or acting on real accounts or data.

## Workflow

1. Identify the app, flow, route, screen, or behavior to verify.
2. Start or locate any required local server, simulator, app, or browser target.
3. Create a temporary artifact directory for Codex's prompt, report, screenshots, and videos.
4. Run `codex exec` with enough sandbox access for computer-use verification.
5. Read Codex's report and inspect referenced artifacts when possible.
6. Confirm the result to the user, separating observed behavior from unverified Codex claims.

Use this command shape:

```bash
ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-computer-use.XXXXXX")"
REPORT="$ARTIFACT_DIR/report.md"
PROMPT="$ARTIFACT_DIR/prompt.md"

# Write a self-contained prompt to $PROMPT, then run:
codex exec \
  -C "$PWD" \
  --add-dir "$ARTIFACT_DIR" \
  -s danger-full-access \
  -o "$REPORT" \
  "$(cat "$PROMPT")"
```

Use `-s danger-full-access` only for computer-use runs that need app launching, browser automation, simulator interaction, screenshots, or machine-level inspection. For browser-only checks that can stay inside the repo and a local server, `-s workspace-write` is acceptable.

If `codex` is not installed or the command fails, report the error and run the verification yourself if you can.

## Prompt Requirements

Tell Codex:

- The exact flow, screen, route, or app behavior to verify.
- How to start or access the app, including URL, command, simulator, or app path.
- Required credentials, test data, or a note that it must avoid real accounts.
- What screenshots, videos, logs, or terminal output to save in the artifact directory.
- The success criteria and any known edge cases to inspect.
- To avoid destructive actions, production data changes, purchases, sends, or account mutations unless explicitly authorized.
- After launching an app, wait briefly for the window/accessibility tree to settle; retry failed computer-use reads/actions with short backoff before declaring the tool blocked.
- If computer-use accessibility/click/key actions fail and Codex uses screenshots, AppleScript, CLI, APIs, app scripting, or any other substitute mechanism, it must report the result as degraded/partial verification, not a full computer-use pass.
- To write a durable interim report in the artifact directory before long waits, polling loops, or diagnostics; do not rely only on `codex exec -o` for final output.
- To report observed behavior, artifacts created, errors encountered, and confidence level.

## Example Prompt

```text
Use computer-use verification for this local app flow.

Target:
- <URL, app path, simulator, or command>

Flow:
1. <step>
2. <step>
3. <step>

Success criteria:
- <expected visible behavior>

Artifacts:
- Save screenshots and any useful logs under the artifact directory.
- Include artifact paths in the final report.
- Write/update an interim report before any long wait, polling loop, or diagnostic branch.

Safety:
- Do not use real accounts or perform destructive actions.
- Stop and report if the flow asks for credentials or authorization not provided here.

Report:
- What you observed
- Whether the flow passed
- Whether verification used real computer-use UI interaction, or a fallback/substitute mechanism; if fallback was used, label the result degraded/partial and explain why.
- Screenshot/video/log artifact paths
- Any defects, uncertainty, or blocked steps
```

## Reporting Back

Do not simply forward Codex's report. Inspect the artifacts that matter and summarize what was actually observed. If Codex says the flow passed, include what it tested and any gaps it did not cover.
If Codex used any fallback instead of computer-use UI interaction, call that out as degraded/partial verification in your summary.
