# AGENTS.md

This file provides guidance to Codex and other coding agents when working with code in this repository.

## Build and Development Commands

Always use Node.js/pnpm instead of Bun.

```bash
# Install all workspace dependencies (from repo root)
pnpm install

# Build CLI package (publishes `dev-browser` bin)
pnpm --filter dev-browser-cli build

# Run dev mode with watch
pnpm --filter dev-browser-cli dev

# Run tests (uses vitest)
pnpm --filter dev-browser-cli test

# Run TypeScript check
pnpm --filter dev-browser-cli exec tsc --noEmit
```

## Important: Before Completing Code Changes

**Always run these checks before considering a task complete:**

1. **CLI TypeScript check**: `pnpm --filter dev-browser-cli exec tsc --noEmit`
2. **CLI tests**: `pnpm --filter dev-browser-cli test`
3. **CLI build**: `pnpm --filter dev-browser-cli build`

Common TypeScript issues in this codebase:

- Use `import type { ... }` for type-only imports (required by `verbatimModuleSyntax`)
- Browser globals (`document`, `window`) in `page.evaluate()` callbacks need safe access via `globalThis`

## Project Architecture

### Overview

This is a browser automation tool designed for developers and AI agents. It solves the problem of maintaining browser state across multiple script executions - unlike Playwright scripts that start fresh each time, dev-browser keeps pages alive and reusable.

### Structure

- `packages/cli/` - CLI package to publish on npm (`dev-browser` command)
  - `src/index.ts` - Commander-based CLI entrypoint
  - `src/daemon.ts` - Daemon lifecycle commands
  - `src/run.ts` - `run --code` execution command
  - `src/workers/` - Daemon worker entrypoints used by built CLI
  - `src/core/` - Internal runtime core (server/client/relay/types/snapshot)
- `skills/dev-browser/` - Skill text layer only (`SKILL.md` + `references/`)

### Usage Pattern

```bash
# Ensure daemon (launch mode)
dev-browser daemon ensure --mode launch --json

# Run multi-step code on persistent page
dev-browser run --page my-page --json --code 'await page.goto("https://example.com"); return { title: await page.title() };'

# Stop daemon
dev-browser daemon stop --mode launch
```

## Node.js Guidelines

- Use `pnpm exec tsx` for TypeScript execution in development only
- Use `node:fs` for filesystem operations
- Use `pnpm` for all dependency and script operations
