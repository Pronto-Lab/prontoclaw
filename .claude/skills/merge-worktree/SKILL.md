---
name: merge-worktree
description: Squash-merge the current worktree branch into the main branch (or a specified target). Analyzes git history and source code to craft a comprehensive commit message.
argument-hint: "[target-branch]"
disable-model-invocation: true
---

# Merge Worktree

Squash-merge the current worktree branch back into the target branch with a comprehensive, structured commit message.

## Current context

- Git dir: `!git rev-parse --git-dir`
- Current branch: `!git branch --show-current`
- Recent commits: `!git log --oneline -20`
- Working tree status: `!git status --short`

## Instructions

Follow these phases exactly, in order. Do NOT skip phases.

---

### Phase 1: Validation

1. **Verify worktree**: Check if the current git directory is a worktree. The output of `git rev-parse --git-dir` must contain `/worktrees/`. If it does not, **stop immediately** and tell the user:
   > "This skill must be run from inside a git worktree. Use `/worktree` to create one first."

2. **Identify current branch**: Get the worktree branch name from `git branch --show-current`.

3. **Resolve target branch**:
   - If `$ARGUMENTS` is provided and non-empty, use it as the target branch.
   - Otherwise, detect the default branch: check if `main` exists, else check `master`. If neither exists, stop and ask the user.

4. **Identify the original repo path**: Parse the original repo root from the git-dir path. Use `git rev-parse --git-common-dir` to find it, then derive the original repo working directory.

5. **Clean working tree**: Run `git status --porcelain`. If there are uncommitted changes, stop and tell the user to commit or stash them first.

---

### Phase 2: Research

This is the most critical phase. You must deeply understand what was done before writing any commit message.

1. **Commit history**: Run `git log --oneline <target>..HEAD` to see all commits on this worktree branch.

2. **File change summary**: Run `git diff <target>...HEAD --stat` to get an overview of what files changed and how much.

3. **Full diff**: Run `git diff <target>...HEAD` to read the complete diff. Study it carefully.

4. **Read key files**: For the most significantly changed files, use the Read tool to understand the full context.

5. **Categorize changes**: Group all changes into categories:
   - Features, Fixes, Refactors, Tests, Docs, Config/Chore

6. **Identify the dominant type**: Determine which conventional commit type best represents the overall body of work.

---

### Phase 3: Target branch preparation

1. **Get the original repo path** (from Phase 1 step 4).

2. **Check target branch state**: Run `git -C <original-repo-path> log --oneline -10 <target>`.

3. **Detect stray WIP commits**: If the target branch has WIP-style commits, warn the user.

4. **Fetch latest** (if remote exists): Run `git -C <original-repo-path> fetch origin <target> 2>/dev/null`.

---

### Phase 4: Squash merge

1. **Ensure target branch is checked out** in the original repo:
   ```
   git -C <original-repo-path> checkout <target>
   ```

2. **Perform the squash merge**:
   ```
   git -C <original-repo-path> merge --squash <worktree-branch>
   ```

3. **Handle conflicts**: If conflicts occur, list them and **stop and report to the user**.

4. If the merge succeeds, proceed to Phase 5.

---

### Phase 5: Craft commit message and commit

Based on Phase 2 research, write the commit message following this structure:

```
<type>: <concise summary in imperative mood, under 72 chars, no period>

<2-4 sentence paragraph explaining what was done and WHY.>

Changes:
- <grouped bullet points of what changed>
- <use sub-bullets for details within a group>

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

**Rules:**
- `<type>` must be one of: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`
- Summary line: imperative mood, no period, max 72 chars
- Body paragraph: explain the *why* and *context*
- Changes: group related items together, most important first

**Create the commit** in the original repo using a heredoc.

---

### Phase 6: Verification

1. **Confirm the commit**: Run `git -C <original-repo-path> log --oneline -3` and show the result.

2. **Report summary**: Tell the user the final commit hash, summary line, target branch, and remind them about worktree cleanup and pushing.

---

## Important notes

- **Never force-push or use destructive git operations** without explicit user confirmation.
- **Never skip pre-commit hooks** (`--no-verify`).
- If anything unexpected happens at any phase, **stop and explain** rather than guessing.
- The commit message quality is paramount.
