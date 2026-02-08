# Data Scraping Guide

For large datasets (followers, posts, search results), prefer **network interception + replay** over DOM scrolling. APIs are faster, structured, and already paginated.

## Workflow (CLI-first)

1. Capture one matching request + response
2. Inspect response schema (array path + cursor path)
3. Replay with pagination and dedupe
4. Stop safely (cursor/rate limit/date cutoff)

Start daemon once:

```bash
dev-browser daemon ensure --mode launch --json
```

### 1) Capture request + response

Use one `run --code` and return exactly what you need to replay.

```bash
dev-browser run --page scrape-demo --json --code '
const MATCH = /\/(api|graphql)\//i;
const TARGET_URL = "https://example.com/profile";

let capturedRequest = null;
let capturedResponse = null;

const onRequest = (request) => {
  if (capturedRequest) return;
  const url = request.url();
  if (!MATCH.test(url)) return;
  capturedRequest = {
    url,
    method: request.method(),
    headers: request.headers(),
    postData: request.postData(),
  };
  log({ type: "captured-request", url });
};

const onResponse = async (response) => {
  if (capturedResponse) return;
  const url = response.url();
  if (!MATCH.test(url)) return;
  try {
    const json = await response.json();
    capturedResponse = {
      url,
      status: response.status(),
      topLevelKeys: json && typeof json === "object" ? Object.keys(json).slice(0, 20) : [],
      body: json,
    };
    log({ type: "captured-response", url, status: response.status() });
  } catch {
    // Skip non-JSON responses
  }
};

page.on("request", onRequest);
page.on("response", (response) => {
  void onResponse(response);
});

const serverInfo = await client.getServerInfo();
log({ type: "server", mode: serverInfo.mode });

await page.goto(TARGET_URL);
await helpers.waitForPageLoad(page);

for (let i = 0; i < 40 && (!capturedRequest || !capturedResponse); i += 1) {
  await page.waitForTimeout(250);
}

return { capturedRequest, capturedResponse };
'
```

### 2) Inspect schema before writing loops

Run a focused schema probe. Keep this small and fast.

```bash
dev-browser run --page scrape-demo --json --code '
const MATCH = /\/(api|graphql)\//i;
const TARGET_URL = page.url().startsWith("http") ? page.url() : "https://example.com/profile";

function summarizeSchema(root) {
  const arrayPaths = [];
  const cursorPaths = [];
  const queue = [{ path: "$", value: root }];

  while (queue.length > 0 && (arrayPaths.length < 10 || cursorPaths.length < 10)) {
    const current = queue.shift();
    if (!current) break;

    const { path, value } = current;

    if (Array.isArray(value)) {
      arrayPaths.push({ path, length: value.length });
      if (value.length > 0 && value[0] && typeof value[0] === "object") {
        queue.push({ path: `${path}[0]`, value: value[0] });
      }
      continue;
    }

    if (!value || typeof value !== "object") continue;

    for (const [key, next] of Object.entries(value)) {
      const nextPath = `${path}.${key}`;
      const lower = key.toLowerCase();
      if (lower.includes("cursor") || lower.includes("next") || lower.includes("token")) {
        cursorPaths.push(nextPath);
      }
      if (next && typeof next === "object") {
        queue.push({ path: nextPath, value: next });
      }
    }
  }

  return {
    topLevelKeys: root && typeof root === "object" ? Object.keys(root).slice(0, 20) : [],
    arrayPaths,
    cursorPaths,
  };
}

let schema = null;

const onResponse = async (response) => {
  if (schema) return;
  const url = response.url();
  if (!MATCH.test(url)) return;
  try {
    const json = await response.json();
    schema = summarizeSchema(json);
    log({ type: "schema-captured", url });
  } catch {
    // Skip non-JSON
  }
};

page.on("response", (response) => {
  void onResponse(response);
});

await page.goto(TARGET_URL);
await helpers.waitForPageLoad(page);

for (let i = 0; i < 40 && !schema; i += 1) {
  await page.waitForTimeout(250);
}

return schema ?? { error: "No matching JSON response captured" };
'
```

### 3) Replay with pagination

After you know paths, replay in browser context so auth/session are reused.

```bash
dev-browser run --page scrape-demo --json --code '
const BASE_URL = "https://example.com/api/data";
const HEADERS = {
  "accept": "application/json",
};
const PAGE_SIZE = 20;
const MAX_PAGES = 50;
let delayMs = 750;

function buildUrl(cursor) {
  const url = new URL(BASE_URL);
  url.searchParams.set("count", String(PAGE_SIZE));
  if (cursor) url.searchParams.set("cursor", cursor);
  return url.toString();
}

function extractPage(json) {
  const entries = json?.data?.entries ?? [];
  const nextCursor = entries.find((entry) => entry?.type === "cursor-bottom")?.value ?? null;
  const items = entries.filter((entry) => entry?.id && entry?.type !== "cursor-bottom");
  return { items, nextCursor };
}

const seen = new Set();
const items = [];
let cursor = null;
let pageCount = 0;

while (pageCount < MAX_PAGES) {
  const url = buildUrl(cursor);
  const api = await page.evaluate(
    async ({ url, headers }) => {
      const response = await fetch(url, {
        headers,
        credentials: "include",
      });
      let json = null;
      try {
        json = await response.json();
      } catch {
        // Non-JSON
      }
      return { status: response.status, json };
    },
    { url, headers: HEADERS }
  );

  if (api.status === 429) {
    delayMs = Math.min(delayMs * 2, 10000);
    log({ type: "rate-limit", page: pageCount + 1, backoffMs: delayMs });
    await page.waitForTimeout(delayMs);
    continue;
  }

  if (api.status >= 400 || !api.json) {
    log({ type: "http-error", page: pageCount + 1, status: api.status });
    break;
  }

  const { items: batch, nextCursor } = extractPage(api.json);
  let added = 0;

  for (const item of batch) {
    const id = String(item.id ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push(item);
    added += 1;
  }

  pageCount += 1;
  log({ type: "page", page: pageCount, added, total: items.length, nextCursor });

  if (!nextCursor || added === 0) break;

  cursor = nextCursor;
  await page.waitForTimeout(delayMs);
}

return {
  total: items.length,
  pageCount,
  items,
};
'
```

### 4) Stop conditions and safety

- Stop when cursor is missing, batch is empty, or no new IDs were added
- Add hard caps (`MAX_PAGES`, max item count, or date/ID threshold)
- Back off on `429` (exponential delay), and stop on repeated `4xx/5xx`
- Keep one page name (for example `--page scrape-demo`) to reuse state across runs

When done:

```bash
dev-browser daemon stop --mode launch
```
