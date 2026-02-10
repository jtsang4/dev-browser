# @jtsang/dev-browser-cli

`dev-browser` command line package.

## Install

```bash
pnpm add -g @jtsang/dev-browser-cli
# or: npm install -g @jtsang/dev-browser-cli
```

## Quick start

```bash
# 1) start daemon
dev-browser daemon ensure --mode launch --json

# 2) run code on a persistent page
dev-browser run --page demo --json --code 'await page.goto("https://example.com"); return { title: await page.title() };'

# 3) stop daemon
dev-browser daemon stop --mode launch
```

## Commands

- `dev-browser daemon ensure` - start daemon if needed
- `dev-browser daemon status` - show current daemon status
- `dev-browser daemon stop` - stop daemon
- `dev-browser daemon clean` - clean stale runtime state
- `dev-browser daemon logs` - print daemon logs (`--follow` to stream)
- `dev-browser doctor` - show runtime diagnostics
- `dev-browser run` - run JS against a named page

## Modes

- `launch` - manages browser process directly
- `extension` - connects through browser extension mode
