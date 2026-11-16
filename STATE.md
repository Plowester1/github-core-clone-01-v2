# github-core-clone-01-v2-rebuild

## DESIGN

The forge is a single Node.js process with one `node:http` listener and one shared in-memory state. The modules are deliberately split by protocol boundary:

- `main.ts` owns registration with the lifecycle service and the process lifetime.
- `app.ts` owns the HTTP listener, exact-route lookup, manual path segmentation, and request-ID allocation.
- `store.ts` owns users, repositories, Git objects, refs, issues, comments, pull requests, labels, deterministic timestamps, object hashing, tree construction, and merge-base traversal.
- `git.ts` owns Git smart HTTP v0/v2, pkt-line framing, pack parsing and emission, object indexing, and pack caching.
- `rest.ts` owns `/api/v3` resources and pagination.
- `graphql.ts` owns the GraphQL parser, resolver projection, introspection, and mutations.
- `mcp.ts` owns the stateless Streamable HTTP MCP endpoint and its snake_case tools.

Repository objects live in `Map<string, GitObject>` keyed by lowercase SHA-1. Refs live in a per-repository `Map<string, string>`. Issue and pull-request numbers are one-based indexes into append-only arrays, so direct lookup and paginated slicing avoid scans. Label names have a dedicated map for constant-time validation. Git trees are encoded as real nested tree objects: directory entries use mode `40000`, and each subtree owns its object SHA. A parallel flattened path index exists only for REST file lookup and diffing.

Hot paths avoid request-time allocation and repeated serialization. The router uses an exact-route map plus manual slash segmentation; it does not construct a `URL` or run a regular expression. REST issue, repository, and pull-request JSON is serialized once when the resource changes and cached as a `Buffer`; reads send that buffer with `Content-Length`. Request IDs come from a monotonic counter. Git pack parsing uses `Buffer.subarray` views, and fetch packs are cached per repository, tip, depth, and negotiation state so concurrent clones share the same immutable bytes. Commit ancestry uses indexed parent arrays rather than reparsing commit objects.

## STATUS

- Done: studied the Node/V8, profiling, and MCP guidance; the kit benchmark and calibration; the research notes; the read-only reference implementation; and all 120 conformance contracts.
- Done: `store.ts` implements the shared deterministic state, nested Git trees, object hashing, indexed commits, ancestry, and true merge-base traversal.
- Done: `main.ts` implements lifecycle registration and the process lifetime; `app.ts` implements the exact-route map, manual path parsing, counter-based request IDs, and the HTTP listener.
- Done: `git.ts` implements smart-HTTP v0/v2 (info/refs advertisements, ls-refs, upload-pack fetch with sideband framing), pkt-line framing, zero-copy pack parsing with ofs/ref delta resolution, full-object pack emission, a per-repo immutable pack cache, receive-pack command parsing with fast-forward validation, and `handleGit(req, res, owner, repo, operation, service)`.
- Done: `rest.ts` is complete (JSON reply helpers with counter request-id, cached-Buffer serving, Host-based pagination `Link` headers, repo CRUD, contents GET/PUT/DELETE, issues + labels + comments CRUD, pulls list/create/get/update/files/merge with true merge-base, and the `handleRest(req, res, segments, query)` dispatcher).
- Done: `graphql.ts` is complete (tokenizer/parser with variables + fragments, reply helpers, introspection schema, cursor/connection helpers, field projection with unknown-field errors, value builders, repository/pullRequest/issue/viewer query resolvers, createIssue/createPullRequest/mergePullRequest mutations, and `handleGraphQL(req, res)`).
- Done: `mcp.ts` is complete (16,548 bytes) — JSON-RPC helpers, `sendJson`, the full 9-tool registry (create_repository, list_repositories, get_repository, create_issue, list_issues, create_pull_request, merge_pull_request, get_file_contents, list_pull_requests), their handlers (reusing store tree/merge helpers), `callTool`, `listTools`, and `handleMcp` (initialize, notifications/initialized 204, ping, tools/list, tools/call with in-band tool errors, unknown-method `-32601`, parse `-32700`).
- Done: `package.json` (stdlib-only, ESM, engines >=22), `tsconfig.json` (NodeNext, strict, noEmit), `LICENSE` (SPDX MIT / Plowester1 2026), `README.md`, and `.makefun/owner.json` (polersyer) written.
- Done: typecheck — `tsc --noEmit` clean (exit 0). Fixed 20 errors: graphql.ts `let args` (const reassign), `issueValue`/`repositoryValue`/`createPullRequest` now use real store `Repo`/`Issue`/`Pull` types (derived author from repo owner, `Pull.id` String(number)); mcp.ts `createRepo(name, {description, private})`, `toRepoText(repo: Repo)`, `lookupRepo` returns real `Repo`, `Pull.id` String(number), FileEntry has no `type`; rest.ts `issueJson` uses `repo.owner` for user, `Pull.id` String(number).
- Done: smoke tests all pass — tsc clean. Fixed 2 real bugs: (1) GraphQL shorthand queries now parse (`{ viewer { login } }` → data, was `unexpected token {`; anonymous `{` starts a query) and (2) PUT contents on an EMPTY repo now works (201; guard allows when repo has no commits/refs yet). Also found `PUT /user/repos` 405 is CORRECT — the kit creates repos with POST /user/repos (verified in checks-rest.ts), so that smoke line was a typo; POST returns 201. Repo create, PUT/GET contents (200/201), GraphQL viewer + repository queries, and `git ls-remote` with auth all verified.
- In progress: execute local trials and archive every result as `trial-N.json`.

## TRIALS

### Trial 1 — 395/1000 (agent 107, feature 195, perf 93, p50 295,389 µs)
Run id 01a1e592-66ac-717c-8bf5-140c41dfbe21, saved as ~/workspace/makefun/gh1-v2-rebuild/trial-1.json.
39/120 checks. By group: git 1/30, graphql 2/20, issues 13/15, mcp 8/15, protocol 3/5, pulls 2/20, repos 10/15.
Perf: push/clone ERROR "GitProtocolError: invalid push sideband band 117" (0 pts); read 49 pts p50 720 ms; write 44 pts p50 121 ms.
Diagnosis in progress: 3 analysts reading the kit's check sources (checks-git/graphql/rest/mcp) for exact assertions.
Known systematic suspects: (a) receive-pack response missing sideband band byte ('u' of "unpack ok" read as band 117); (b) GraphQL resolveSelections connection bug — `nodes` projected with the connection's own selections instead of the nodes child's selections, and `edges { node }` resolves the node with the edges child's selections; (c) no `node(id:)` root field; (d) pulls create/files/merge systematically failing (only 404 cases pass).
Digests saved: ~/workspace/makefun/v2-work/fix-git-report.md, fix-graphql-report.md, fix-rest-mcp-report.md.

### Fix round 1 — git.ts DONE (verified by coordinator 2026-11-17 ~18:30 WIB)
- Root cause: handleReceivePack checked the pre-NUL part for 'side-band-64k' — capabilities are AFTER the NUL, so sideband was always false and the report went out unframed. Fixed to `line.slice(nul + 1)`.
- v2 fetch: acknowledgments now sent when haves present (ACK per held have, else NAK); shallow-info now emits the computed boundary (`shallow` from getFetchPack) + `unshallow` for dropped boundaries (v2 section + v0 lines).
- Extra flush after sidebandPack in v2 fetch removed (double flush broke `git clone`: "expected response end packet").
- Verified: tsc exit 0; push first commit OK; clone files identical; clone --depth 1 OK; FF push OK; non-FF push rejected, ref unmoved.

### Fix round 2a — rest.ts DONE (verified 2026-11-17)
- Bug 1: POST /repos/{o}/{r}/git/refs added (createGitRef: validate ref starts refs/, sha is a known object, repo.refs.set, 201 {ref, object:{sha}}); GET /git/refs list added (listGitRefs).
- Bug 2: GET /repos/{o}/{r}/branches added (listBranches: refs/heads/* → {name, commit:{sha}}).
- Bug 3: GET /repos/{o}/{r}/commits?sha=<branch> added (listCommits: walk ancestry from branch tip via indexed commits, {sha, commit:{message,author,committer}}); imported indexCommit.
- Bug 4: GET /api/v3/ root → 200 + x-oauth-scopes header; GET /api/v3/meta → 200 {installed_version:"1.0.0"} (count===0 + meta branches in handleRest).
- Bug 6: branchJson now strips refs/heads/ prefix → pullJson head.ref/base.ref are PLAIN branch names (label stays owner:branch). Internal storage untouched.
- Verified live: tsc exit 0; POST /git/refs 201; GET /branches lists main+feature with tip shas; GET /commits?sha=feature lists branch commits; GET /api/v3/ 200 + x-oauth-scopes; GET /api/v3/meta 200; POST /pulls head.ref="feature"/base.ref="main" plain.
- Note (superseded in round 2b): PUT /contents ignored ?branch= query at this point; fixed in round 2b below.

### Fix round 2b — rest.ts + git.ts DONE (verified 2026-11-17)
- Bug 1 (REST): PUT /contents + DELETE /contents now honor `?branch=` query param (query.params.get('branch') → input.branch → default). GET /contents already honored `?ref=`. Verified: feature tip moves on `?branch=feature`, main unchanged, content readable at ref=feature but absent at ref=main.
- Bug 2 (REST): merge conflict → 405. mergePull computes base/current/head trees at mergeBase/baseSha/headSha; same path changed in both → 405 `{message:"Pull Request is not mergeable"}` (no blanket 405 on divergence). Happy path verified: merge 200 {merged:true, sha, message}, PR closed+merged+merged_at+merge_commit_sha, merged bytes via GET /contents?ref=main, files list status added.
- Bug 3 (REST): listPulls default lists OPEN only (merged/closed excluded); ?state=all and ?state=closed list accordingly.
- Bug 4 (REST): listIssues reverses for ?direction=desc (newest first).
- Bug 5 (REST): POST /issues with an unknown label name → 422 {message, errors}, issue NOT created (auto-create removed; validates each label against repo.labels).
- Bug 6 (REST): PUT /contents with stale blob sha → 409 {message:"Invalid request.", errors:[{sha_mismatch}]}; correct current sha → 200.
- Bug 7 (REST): malformed JSON body → 400 {message:"Bad Request"} (readJsonBody throws BadJsonError; handleRest try/catch).
- CRITICAL Bug (git.ts): indexParsedObjects indexed commits BEFORE all objects were added to repo.objects, so if a commit was iterated before its tree/blob, flattenTree stored an EMPTY tree in repo.trees → treeAt returned empty for pushed commits → merges wrote empty trees (wiping content) and merge-conflict detection never fired. Fixed: two passes — set all objects first, then indexCommit for every commit. Verified: pushed commits resolve, merge preserves content, conflict → 405.
- Verified live all 8 checks; tsc exit 0.
- Next: graphql.ts fixes (round 3a).

### Fix round 3a — graphql.ts query-side DONE (verified 2026-11-17)
- BUG 2 (global ids): added globalId(kind,n)=base64(`<Kind>:<n>`) + parseGlobalId(id). Opaque ids for every id field (repository `Repository:<dbid>`, issue `Issue:<n>`, pullRequest, label, user, comment). Added `databaseId` (numeric) on Repository. Added `node(id:)` root field in resolveQuery — parses opaque id, looks up Repository by repo.id / Issue / PullRequest, supports inline fragments (`... on Repository { name }`). Repository node lookup iterates repos matching `.id === n`.
- BUG 1 (connection projection): resolveSelections no longer treats a connection value's children as fields. New `projectConnection(record, selection, context)` projects the connection once: nodes use the `nodes` child's selections, edges use the `node` child's selections + cursor scalar, pageInfo from applyConnection, totalCount. Connections are detected in the generic field branch via `isConnection(field)`.
- BUG 5 (connection args): added `applyConnectionFilters(nodes, args)` — filters by `states:[OPEN/CLOSED]` (uppercase) and reverses for `orderBy.direction=DESC`. Also `after:null` (explicit null variable) now means "from the start". ROOT fix: `resolveArgs(args, context)` resolves variable placeholders (`{__variable}`) in every args map (projectConnection, singular issue/pullRequest, resolveQuery root fields) — previously variable args were passed raw as `{__variable}` so `after: $after` decoded to 0 → off-by-one pagination.
- BUG 4 (missing fields): Repository `databaseId`, `viewerPermission:'ADMIN'`, `hasIssuesEnabled:true`, singular `issue(number:)`/`pullRequest(number:)` (reuse issueValue/pullRequestValue, null if absent). PullRequest `mergeable` ('MERGEABLE' if pull.mergeable else 'CONFLICTING') and files nodes expose `path` (mapped from diff `filename`, both kept). SCHEMA_TYPES introspection lists left unchanged (round 3b).
- EXTRA parser bugs found+fixed: (a) `decodeCursor` used `text.slice(6)` on `cursor:4` → included the colon → parseInt NaN → 0, so after-cursor pagination started at index 1; fixed to `slice(7)`. (b) `parseVariableDefinitions` called `expect('$')` but the tokenizer emits `{kind:'variable', value:'after'}` (no `$`), so `query q($after: String)` threw "expected $ but found after"; fixed to read the variable token directly.
- Verified live all 4 checks: (1) repository query → opaque id, databaseId numeric, all fields, issues first:5 states:[OPEN] nodes with opaque ids, hasNextPage true; (2) node(id) + inline fragment resolves; (3) 7 issues first:5 → 5 nodes + hasNextPage true + endCursor, after → 2 nodes + hasNextPage false; (4) orderBy DESC → [7,6,5]. Also states filter, after:null, pullRequest singular+mergeable+files.path verified. tsc exit 0.
- Next: graphql 3b — mutations (input-object signatures + payloads), introspection lists, batching (array bodies), unauthenticated 401.

### Fix round 3b — graphql.ts mutations/introspection/batching DONE (verified 2026-11-17)
- BUG 3 (mutations → input objects): REPLACED the OLD flat-arg signatures (`createIssue(owner,name,title,body)`, `createPullRequest(owner,name,head,base,...)`, `mergePullRequest(owner,name,number)`) with real GitHub input-object signatures. Added `inputObject(selection, context)` (resolveArgs then `args.get('input')` as a record) + `repoById`/`issueById`/`pullById` (resolve opaque global ids via parseGlobalId against `repos`). Payloads are now NESTED and projected as payload types:
  - `createIssue(input:{repositoryId,title,body})` → `{ issue { number id title body } }` (CreateIssuePayload).
  - `closeIssue(input:{issueId})` → `{ issue { state } }` state CLOSED (CloseIssuePayload).
  - `createPullRequest(input:{repositoryId,baseRefName,headRefName,title})` → `{ pullRequest { number id state headRefName baseRefName } }` (CreatePullRequestPayload). Branch lookup by NAME via branchTip, mergeBaseOf, "nothing to merge" guard kept.
  - `mergePullRequest(input:{pullRequestId,mergeMethod})` → `{ pullRequest { merged state } }` (MergePullRequestPayload). isAncestor/setTree merge logic kept.
  - `addComment(input:{subjectId,body})` → `{ commentEdge { node { id body } } }` (AddCommentPayload/IssueCommentEdge/IssueComment). Pushes a store Comment with repo.nextComment/owner, reuse commentValue.
- REST/GraphQL store sharing fix: REST caches issue/PR response buffers in `repo.issueBuffers`/`repo.pullBuffers` (issueBuffer/pullBuffer). GraphQL closeIssue/mergePullRequest/addComment were NOT invalidating them → REST returned stale "open". EXPORTED `invalidateIssueBuffer`/`invalidatePullBuffer` from rest.ts; closeIssue/mergePullRequest/addComment now call them. Verified closeIssue shows in REST GET, merge shows merged+closed, addComment shows in REST /comments.
- SCHEMA_TYPES updates: Mutation fields now input-arg mutations with payload return types (CreateIssuePayload, CloseIssuePayload, CreatePullRequestPayload, MergePullRequestPayload, AddCommentPayload + IssueCommentEdge + IssueComment). Repository added `databaseId`, `viewerPermission`, `hasIssuesEnabled`, singular `issue(number:)`, `pullRequest(number:)`. PullRequest added `mergeable`. Added `SearchType` ENUM type (fields:[]). Payload types added to SCHEMA_TYPES.
- BUG 4-introspection: `typeIntrospection` now returns `enumValues` for ENUM types via `enumValuesFor(name)` (SearchType → `[{name:'ISSUE'}]`); fields kind is ENUM not OBJECT for enums. Fixed `resolveSelections` to handle ARRAY field values (fields/enumValues are arrays of objects): map each element via resolveSelections — previously threw `Cannot query field "name" on type "Object"` for `fields { name }` / `enumValues { name }`.
- EXTRA parser bug: `parseSelection` alias handling was BROKEN — `i1: __type(...)` set alias=name after reading the colon, so the alias was lost (response key was `__type` not `i1`). Fixed: keep the pre-colon token as alias, read the post-colon token as name.
- handleGraphQL: unauthenticated now returns HTTP 401 (new sendUnauthorized, was sendErrors→200). Supports BATCHED requests: array body → array of per-op `{data}`/`{errors}` responses in order; single body → single object.
- Verified live all 8 checks: createIssue input→{issue{number,id}} + REST GET shows it; closeIssue→CLOSED + REST closed; createPullRequest→OPEN+head/base + REST /pulls; mergePullRequest→merged true+state MERGED + REST merged+closed; addComment→commentEdge.node{id,body} + REST comments; __type Issue/Repository field lists + SearchType enumValues ISSUE (with includeDeprecated:true); batched POST array→array of 2 in order; no-token→401, unknown repo→data.repository null no errors. tsc exit 0. Round 3a regression still passes.
- Next: mcp.ts fixes.

### Fix round 4 — mcp.ts aliases + unknown-tool DONE (verified 2026-11-17)
- MCP BUG 1 (tool name aliases): added alias ToolSpecs `create_repo` = create_repository, `get_repo` = get_repository, `list_repos` = list_repositories, and registered them in TOOL_HANDLERS to the same handler functions. Originals kept. tools/list now shows 12 tools. Canonical-name tools (create_issue, list_issues, create_pull_request, merge_pull_request, get_file_contents, list_pull_requests) untouched.
- MCP BUG 2 (argument name aliases): added `pick(args, names)` + `requirePick(args, names)` helpers. `lookupRepo` now resolves owner = owner??owner_login and repo name = name??repo??repository_name??repository. `callCreateRepository`/`callGetRepository` accept name/repository_name/repository aliases. CRITICAL extra fix: `callTool`'s inputSchema.required pre-validation used only the property names, so a tool requiring `name` FAILED when the suite sent `repository_name`. Added `REQUIRED_ALIASES` map (owner, name, number, title, head, base, path) so the required-arg check accepts alias keys too. Also added `pickNumber(args, names)` because the suite passes `pull_number` as a NUMBER and string-only `pick` rejected it — used in `callMergePullRequest` (number??pull_number??pr_number??pull_request_number).
- MCP BUG 3 (unknown tool → JSON-RPC error): in handleMcp `tools/call`, if the tool name is NOT in TOOLS → `jsonRpcError(id, -32601, 'Unknown tool: <name>')` (was a success isError result). KNOWN tools with missing/bad args keep the existing isError-result behavior.
- Verified live all 15 checks (2 consecutive runs ALL PASS): tools/list 12 tools incl. aliases + originals; create_repo{owner,name} → repo created + REST GET confirms + full_name in result; get_repo{owner,repository_name} → result contains repo name; create_issue{owner,repository_name,title} → REST confirms issue; merge_pull_request{owner,repo,pull_number} → REST confirms merged true + closed; unknown tool → error code -32601 (not isError, not HTTP 500); missing required args → isError result (unchanged). tsc exit 0.
- Next: TRIAL 2 (full run 120/120 twice).

### Trial 2 — 871/1000 (112/120)
Run recorded. By group: git 28/30, graphql 20/20, issues 15/15, mcp 9/15, protocol 5/5, pulls 20/20, repos 15/15. Two remaining clusters: (a) git fetch-incremental + fetch-nothing-new (the pack did not honor `haves`, so incremental re-sent all objects and nothing-new re-sent the tip), (b) 6 mcp checks (concurrent-calls, create-issue, create-pull-request, list-issues, merge-pull-request, rest-parity) all from ONE cause — the suite's semantic `repo` argument only maps if the schema property is in `['repo','repository','repository_name','repo_name','repo_slug','project','project_name']`; `name` is not in that list, so every tool's repo arg landed in the wrong field.

### Fix round 5 — git.ts haves-exclusion + mcp.ts repo-property rename DONE (verified on disk 2026-11-16/17)
- git.ts `reachableFrom(repo, roots, depth, haves)` + `emitPack(repo, roots, depth, haves)` + `getFetchPack(repo, roots, depth, wantRefs, haves)` now take a `haves` Set. The BFS ancestry-cutoff walk: if a commit is in haves and depth===Infinity → skip entirely; if in haves and finite depth → skip add/tree but still traverse parents while level<depth; else normal add/tree/parents with shallow at level>=depth. The pack cache key now includes the sorted haves. `handleUploadPack` passes `new Set(haves)`. Result: an incremental fetch (wants=[new tip], haves=[old commits]) emits ONLY the new commit+tree+blobs; a nothing-new fetch (haves contains the tip) emits an empty pack (delta 0).
- mcp.ts TOOLS renamed the repo-identifier schema property from `name`/`repository_name` to `repo` (in properties AND required) for: get_repository, get_repo, create_issue (required `['owner','repo','title']`, body optional), list_issues, create_pull_request, merge_pull_request, get_file_contents, list_pull_requests. `create_repository`/`create_repo` keep `name` (it is the new repo's name). `REQUIRED_ALIASES.name` already lists `repo`; `lookupRepo` already accepts `repo`; `callGetRepository` pick list extended to include `repo`. So the suite's `{owner, repo}` maps correctly to every repo-scoped tool.

### Fix round 5b — debug-line cleanup DONE
- Removed the one-off `process.stderr.write('[dbg-resp] ...')` line in handleUploadPack (it dumped binary pack data to stderr and must not ship). grep confirms no `dbg-`/`console.log`/`console.debug` lines remain in any .ts file.

### Fix round 5c — git.ts v2 acknowledgments section DONE
- The v2 branch dropped the `!hasDone` condition (a fetch request always ends with a `done` line from the kit client, so the acknowledgments section was never emitted when haves were present → the client chokes on the `packfile` header). Now the section is emitted whenever `haves.length > 0`.

### Fix round 5d — git.ts v2 acknowledgments flush conditional DONE
- Real git (2.43) and the kit's v2 parser (parseV2Fetch) disagree on the acks terminator. The kit client ALWAYS sends `done` and NEEDS a flush (0000) after the acks section to reset its section-state parser before the `packfile` header; real git NEVER sends `done` in the first fetch request, stops reading acks at `ready`, and dies with "expected packfile to be sent after 'ready'" if a flush sits between `ready` and `packfile`. Fix: the flush is now CONDITIONAL — `if (hasDone || packCount === 0) parts.push(flushPkt())`. A `done`-sending client (kit) gets the flush; a negotiation client (real git) gets `ready` then the `packfile` section immediately; an empty pack (nothing new) always gets the flush to terminate the section. shallow-info (delim 0001), packfile (sidebandPack's own flush), and the v0 branch are untouched.
- Verified: tsc exit 0; grep confirms no debug lines.
- Next: TRIAL 3 (full 120/120 twice).

### Fix round 5e — git.ts v2 acks terminator is DELIM (0001), not flush DONE
- Coordinator traced git 2.43's OWN daemon (full unfiltered trace) and found the real incremental-fetch reply is: `acknowledgments`, `ACK <oid>`, `ready`, **`0001` (DELIM)**, `packfile`. The acks section is terminated by a DELIM packet, not a flush and not nothing. Earlier traces had hidden the 0001 line because the grep filtered it out.
- Why the two earlier variants failed against real git: a flush (0000) after `ready` reads as end-of-response (not end-of-section) → `expected packfile to be sent after 'ready'`; no terminator at all → the ack reader keeps consuming lines → `unexpected acknowledgment line: 'packfile'`. A DELIM satisfies BOTH clients: real git accepts it after `ready`, and the kit's parseV2Fetch treats a delim exactly like a flush (`if (packet.kind === 'delim') { section = ''; return; }`), so its section parser resets before the `packfile` header. This REPLACES the 5d conditional-flush logic entirely — no `hasDone` branching is needed.
- Edit: removed `const hasDone = lines.includes('done');` and replaced the conditional `if (hasDone || packCount === 0) parts.push(flushPkt())` with the unconditional `parts.push(Buffer.from('0001', 'ascii'));` after the acks/ready lines. shallow-info (which already ends with the same 0001 delim), packfile, and the v0 branch are untouched.
- Verified: tsc exit 0; grep confirms no `hasDone`, no `dbg-`/console lines.
- Next: TRIAL 3 (full 120/120 twice).

### Trial 3 — 984/1000 (119/120)
Run 01a1e65d-401b-71bb-a893-8ccf8e6b1ae1, saved as ~/workspace/makefun/gh1-v2-rebuild/trial-3.json. Agent 200, feature 595, perf 189 (push 50, clone 45, read 50, write 44). By group: git 29/30, graphql 20/20, issues 15/15, mcp 15/15, protocol 5/5, pulls 20/20, repos 15/15. ONLY failure: git.fetch-incremental — the check asserts the incremental fetch delivers exactly the new objects and re-sends NO already-held object.

### Fix round 6 — git.ts exclude tree/blob objects already held by the client DONE
- Root cause (coordinator-reproduced with verify-pack): commit 1 has file0+file1; commit 2 modifies file0 and adds file2. Expected new objects: commit2, tree2, blob(file0-v2), blob(file2) = 4. The server's pack sent 5 — it ALSO sent blob(file1), an UNCHANGED blob the client already holds. In `reachableFrom` the have-commit check skips a held COMMIT and its tree, but when the walk reaches the NEW tree (tree2) it queues EVERY entry — including blobs/subtrees also reachable from the held commit's tree. Only commits were ever tested against `haves`; blobs/trees were never tested against what the client holds.
- Fix: added `heldTreeObjects(repo, haves)` (every tree/blob reachable recursively from a have-commit's tree, skipping gitlinks 160000; parent commits of haves deliberately NOT included — the deepen path still walks them). In `reachableFrom`, compute `const held = heldTreeObjects(repo, haves)` once at the top and insert `if (held.has(oid)) continue;` right after the existing have-commit block and before `ids.add(oid)`. This skips any tree/blob/tag the client already holds via a have-commit's tree. It cannot affect the have-commit branch (held never contains commits), cannot affect the deepen path (parents of haves not in held), and when haves is empty held is empty so clone (no haves) is byte-identical to before. emitPack, getFetchPack, the cache key, and shallow logic untouched.
- Verified: tsc exit 0; grep confirms no debug lines.
- Next: TRIAL 4 (full 120/120 twice).

### Trial 4 — 980/1000 (120/120) ✅
Run 01a1e662-2626-74c5-85c2-37e833ef5b50, saved as ~/workspace/makefun/gh1-v2-rebuild/trial-4.json. Agent 200, feature 600, perf 180 (push 48, clone 42, read 49, write 41), p50 266,163 µs. By group: git 30/30, graphql 20/20, issues 15/15, mcp 15/15, protocol 5/5, pulls 20/20, repos 15/15. Real-git regression (coordinator, verify5c.sh): incremental fetch + nothing-new fetch + depth-1 clone all still pass after round 6. The round-6 fix is confirmed live by the kit's own check.

### Trial 5 — 988/1000 (120/120) ✅ — GATE PASSED
Run 01a1e662-8189-70ea-aa68-867151177c80, saved as ~/workspace/makefun/gh1-v2-rebuild/trial-5.json. Agent 200, feature 600, perf 188 (push 50, clone 41, read 50, write 47), p50 233,707 µs. By group: 120/120 again. Two consecutive trials ≥947 with 120/120 (trial 4: 980, trial 5: 988) — the rebuild gate is met. Ready for parent verification + bundle/submit. Do NOT commit/push/submit from this session.
