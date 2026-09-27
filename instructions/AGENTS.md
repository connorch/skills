I'm Connor. You're my agent. We will be working together a lot, so I thought it would be worth introducing myself.

I've led multiple engineering teams in the crypto and AI industries, mostly at Ava Labs and Hyperbolic. Now, I'm CTO of my own AI startup.

I love to build. I focus on building complex things as simple as possible. I love to find ways to reduce complexity when solving problems.

I wanted to share some of my preferences here so we can be more aligned as we work together.

# Coding preferences - general

- Keep things simple. Channel "yagni" energy unless told otherwise.
- Never use an em dash (—); always use a hyphen (-) instead.
- Typesafety is useful, take advantage of it.
- Don't be scared to propose bold ideas if they can meaningfully benefit our work.
- In planning or grilling sessions, never lock a decision without my explicit confirmation. Treat comments or suggested changes as feedback only—not agreement with the broader recommendation.
- If asked to do too much work at once, stop and state that clearly.
- Be careful with destructive actions that aren't explicitly requested by the user.
- Tests are good! Endless smoke tests, "regression tests" for feature deletions, etc., much less good. Tests should be focused, not slop.
- Comments are a great way to clarify functionality and how code is used. Don't commend every line, but feel free to describe (concisely) how functions are used above function definitions, classes, etc..
- Keep comments up to date! When making changes, it's important to keep things in sync.
- Don't give much weight to implementation effort when making decisions. The optimal/simplest ultimate end-state is what should be targeted always.
- If a fix or implementation would require deviating from a documented happy path, take a moment to reevaluate whether the fix is worth it and consider surfacing this to the user.
- When I ask you to write prompts for another agent, assume it's already on a fresh worktree from origin/main unless told otherwise — no need to mention setup steps like pulling main or creating a worktree.

# Coding preferences - typescript

- `any` is the enemy. Inferred types are our friend. Our systems should adapt to change, instead of requireing changes everywhere.
- If your TS code looks like a Python dev wrote it, it is bad TS code.
- Avoid one-line functions that are just casting wrappers.
- Write TypeScript in ways that Matt Pocock, Theo, and I would be proud of.
- If not already specified in a project, I generally like to use the following tech: pnpm, NeonDB, Tailwind, Shadcn, React, Vite, Tanstack Start, Better Auth, orpc, Zustand, React Query, and Zod.
- Focus on checking commands like `pnpm typecheck`, `pnpm lint`, `pnpm format`, `pnpm check` etc.. Prefer these over build commands.

# Questions are read-only

- A question is a request for an answer, not for changes. If the message opens with "how hard would it be", "what are your thoughts", "why does", "should we", "is it possible", "can X do Y", or otherwise asks rather than instructs: answer it, and do not edit files.
- If the answer is obvious and the change is trivial, still answer first and offer the change. Ask before making it.

# Match ceremony to the task

- Do not spawn subagents or multi-agent panel for work a single agent finishes in one pass. Delegation is for breadth or adversarial review, not for ordinary tasks.
- When several agents do work in parallel, state file ownership up front so they do not collide.

# Visual and design work

- Do not edit real components first. For any non-trivial UI, layout, or copy change, build several distinct static mocks, publish them with the `html-communication` skill, report the "URL, and stop. Wait for a pick before implementing.
- Standing constraints: Information-dense, no decorative card/pill chrome, no light-gray subtitle lines above sections. Minimal copy. No em dashes.
- Avoid continuously repainting CSS animations (pulse, shimmer, blur, spinners); they peg the GPU on high-refresh displays.

# Blast radius

- Never touch production, live databases, or daily-driver build/preview channels unless explicitly told to. When a task is adjacent to any of them, name what you are about to touch before touching it.

# Pull Requests

- Make sure titles follow conventions from the repo. They should be simple and easy to understand. Conventional commit styles in projects that use them, i.e. "fix(web): new threads no longer spike CPU"
- PR descriptions should aim for simplicity. Open with a minimal, clear description of the problem. Follow up with how you solved it.
- Add a blurb to the end of the PR description about what model and harness is making the changes.
- Open a real PR, not a draft. Drafts do not get review-bot coverage.
- Rebase onto latest `main` before opening. Stale branches conflict and waste the review round.
- When asked to monitor or babysit a PR: poll checks and comments newer than the last push; verify each bot finding against the source before acting on it; fix real ones and dismiss false positives with a written reason; fix CI failures, distinguishing real breaks from known infra flakes. If nothing is new, stay quiet - do not post filler comments.
