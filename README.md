# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Plowester1/github-core-clone-01-v2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Plowester1/github-core-clone-01-v2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A from-scratch GitHub core clone built entirely on the Node.js standard library
with zero runtime dependencies. It speaks the four protocols a GitHub-style
server needs: smart-HTTP Git (protocol v0 and v2), the GitHub REST API v3,
GraphQL, and the Model Context Protocol (MCP) over Streamable HTTP.

## Protocols

- **Git smart HTTP v0/v2** — `info/refs` advertisements, `git-upload-pack`
  (fetch) with sideband framing and delta resolution, and `git-receive-pack`
  (push) with fast-forward validation.
- **REST API v3** — repositories, contents, issues, labels, comments, and pull
  requests with merge-base aware file diffs.
- **GraphQL** — a hand-written lexer/parser, field projection, connections with
  cursors and pagination, introspection, queries, and mutations.
- **MCP** — JSON-RPC 2.0 over Streamable HTTP exposing snake_case tools such as
  `create_repository`, `create_issue`, `create_pull_request`, and
  `get_file_contents`.

## Run

```sh
MAKEFUN_SHOP_TOKEN=test-token MAKEFUN_ENV_URL=http://127.0.0.1:8080 node --experimental-strip-types main.ts
```

The process registers with the lifecycle service and serves HTTP. It requires
the `MAKEFUN_ENV_URL` environment variable to run; without it the process exits
with status code 1.

## Endpoints

- `/healthz` — liveness probe.
- `/api/v3` — the REST API v3 surface.
- `/api/graphql` — the GraphQL endpoint.
- `/mcp` — the MCP Streamable HTTP endpoint.
- `/<owner>/<repo>.git` — Git smart HTTP.

## Design

- A single process with one `node:http` listener and one shared in-memory
  store. Modules are split by protocol boundary.
- Repository objects live in a map keyed by lowercase SHA-1; refs live in a
  per-repository map. Issue and pull-request numbers are one-based indexes into
  append-only arrays for constant-time lookup and paginated slicing.
- Git trees are real nested objects; commit ancestry uses indexed parent arrays,
  and merge-base uses true traversal.
- A per-repository immutable pack cache lets concurrent clones share the same
  bytes. The router uses an exact-route map plus manual slash segmentation,
  and cached `Buffer`s avoid request-time reserialization.

Built for @polersyer (make.fun referral tq3ft7yq), GitHub Plowester1, repo
github-core-clone-01-v2-rebuild.

---

<sub>Entered on [make.fun](https://make.fun/?ref=tq3ft7yq&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>