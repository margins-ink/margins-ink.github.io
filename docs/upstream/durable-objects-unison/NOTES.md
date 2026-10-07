# SQLite Durable Objects and Unison (researched 2026-10-06)

Status tags: [read] seen in fetched page summary, [reported] secondary source/search snippet, [unverified] not checked.

## 1. Cloudflare Durable Objects with SQLite backend
- DO = Worker + storage, globally unique name, requests handled by a single-threaded object, so one writer per object [read: what-are-durable-objects].
- SQLite is the recommended backend; new KV-backed namespaces are no longer allowed for accounts without an existing one; KV-to-SQLite conversion of existing classes is not documented ("future migration path") [read: access-durable-objects-storage]. Enable with `new_sqlite_classes` in a migration [read].
- SQL API: `ctx.storage.sql.exec(query, ...bindings)` returns cursor (`next/toArray/one/raw`, `rowsRead`, `rowsWritten`, `columnNames`); `databaseSize`; `transactionSync(cb)` (sync, throws = rollback). Consume cursors before the next await [read: sqlite-storage-api, page updated 2026-09-21].
- PITR: `getBookmarkForTime(ts)` within last 30 days, lexically comparable bookmarks, `onNextSessionRestoreBookmark(bm)` restores on next restart; not in local dev [read].
- Limits: 10 GB per object (paid), unlimited objects, 5 GB account on free; 100 columns/table; key+value 2 MB; SQL statement 100 KB; soft 1,000 req/s per object; CPU 30 s default up to 5 min; WS received message 32 MiB; 6 simultaneous outbound connections; 500 classes paid [read: limits]. Note the what-are page still says "1 GB expanding to 10 GB": stale, limits page wins [read, conflict].
- Pricing (paid): 1M req/mo then $0.15/M; 400k GB-s then $12.50/M GB-s; rows read 25B incl then $0.001/M; rows written 50M incl then $1.00/M; storage 5 GB-mo incl then $0.20/GB-mo; incoming WS messages billed 20:1 [read: pricing]. Page text still says storage billing "January 2026, target Jan 7" though today is 2026-10: unresolved whether it is on; assume on [unverified].
- Hibernation: idle object evicted from memory, WS clients stay connected, no duration charge while hibernating, in-memory state lost, `serializeAttachment` max 16,384 bytes, ping/pong auto-handled without waking [read: websockets].
- Placement: location hint (best effort), jurisdictions EU/US/FedRAMP-Moderate (strict); created near first requester; objects do not move after creation (planned) [read: data-location]. No read replicas mentioned on that page [read].
- Versus KV backend: KV has only the KV API; SQLite supports both APIs plus PITR [read].
- Nothing documented about archiving DO storage to R2 [read]; you build that yourself.

## 2. Unison today
- Codebase = SQLite file (`.unison/v2/unison.sqlite3`), ASTs keyed by hash, names separate from hashes; Share sync protocol exchanges hash-addressed "entities" in CBOR [reported: search results, unison PR #6243 snippet]. The big-idea page itself does not mention SQLite [read].
- Code shipping: sender ships bytecode tree, recipient lists hashes it lacks and requests only those; cached afterwards [read: the-big-idea]. This is the missing-hash protocol.
- Unison Cloud: Cell, Table, OrderedTable, named Databases, typed, transactional storage; BYOC clusters; free plan 50 MB, 5,000 req/mo, 5 services [read: unison.cloud]. Daemon/actor abilities: not on that page; @unison/cloud Share page was JS-rendered, not obtained [unverified]. Unison MCP `guide` not read (server down).
- Runtime: Haskell bytecode interpreter plus a JIT native compiler (Unison Cloud, [reported]). Wasm: a community library compiling Unison to WASM (@__dfreeman, 2025-08, [reported] from a tweet), and jaredly/unison.rs, an experimental Rust runtime compiled to WASM [reported]. No official wasm/JS backend found [read: github summary shows none]. Runtime-in-a-Worker is therefore unproven; check the dfreeman library before assuming.
- Unison repo licence: LICENSE file present, MIT likely, [unverified].

## 3. S3-as-log design (Andrew's pattern)
Primitives available [read]: S3 `If-None-Match: *` (create-only, 412 on loss) and `If-Match: etag` (CAS) on PutObject/CopyObject/CompleteMultipartUpload; R2 lists If-Match and If-None-Match as supported on S3 PutObject.

Design:
- Immutable layer, no coordination: definitions/terms/types/patches stored as `objects/<hash>` with `If-None-Match:*` (idempotent; a 412 means already present, fine). Content addressing means any writer, any region, any cache can write them.
- Mutable layer, one writer: per branch/project, a DO sequences appends of commit/branch-head records to the log `log/<branch>/<seq>.seg` (create-only PUT; seq collision = fencing) and updates `head/<branch>` (If-Match CAS) as a checkpoint/pointer. DO SQLite holds: materialised namespace/name table, hash existence index, the current seq. DO acks a push only after S3 PUT returns (S3 is truth; the DO's local SQLite is a cache, though DO storage is itself durable so it can also be the fast ack path with async S3 shipping, trading a tiny loss window).
- Cold start: read `head`, load latest snapshot (`snap/<seq>.sqlite` or LTX-like page file), replay segments after it into SQLite. Compaction: roll N segments into a snapshot, delete old segments; never delete `objects/` (GC by reachability is the only O(N) job: make it a per-branch mark job, not periodic global).
- Split-brain: a DO is unique per name, but if the guarantee is ever doubted, the create-only seq PUT is the fence (same idea as SlateDB manifest fencing).
- Unison mapping: Share sync is already "send entities by hash, only unknown ones" + mutable namespace/branch pointers. Entities go to S3/R2 by hash; only the head update needs the DO. Reads of definitions never touch the DO (CDN/R2 direct).

Prior art [read from primary docs unless noted]:
- Litestream: async WAL pages packaged as LTX files with monotonic TXID, snapshots (default 24 h), restore = snapshot + LTX replay with gap check; single-process writer; async so a loss window exists. Matches the segment+snapshot shape.
- SlateDB: embedded LSM on S3/R2/GCS, "formally verified manifest fencing protocol" for single writer + many readers, Apache-2.0, supports zero-copy clone/branch; a Rust library, so not directly in a Worker unless compiled to wasm [unverified].
- Neon: safekeepers (Paxos) make WAL durable, pageserver materialises, object storage holds immutable history off the query path; branching is metadata-only. Same split (durable log vs materialised cache), heavier.
- WarpStream: stateless agents write multi-partition files to S3; a control-plane replicated state machine maps files to offsets (ordering lives in metadata, bytes in S3). The "DO as sequencer, S3 as bytes" analogue.
- LiteFS: SQLite FS replication, pre-1.0, "stable in production"; lease details not in fetched page [unverified]; needs a lease service, not applicable on Workers.
- Turso/libSQL bottomless: no page found in docs index [unverified]; not relied on.

## 4. Ways to combine, ranked
1. Branch-head DO + S3/R2 hash store (smallest, matches Unison natively). Cost: a Worker, one DO class, R2 bucket, a small codec for Share entity wire format. Unlocks: cheap global push/pull/mirror of a codebase, per-tenant isolation, PITR on the namespace. Blocks: only that Share's entity format is not a stable public API [unverified]; we implement a subset or mirror via UCM.
2. Missing-hash server for function shipping: DO/Worker answers "which of these hashes do you lack" from SQLite index, serves bytecode from R2. Unlocks Remote-style deploy to edge. Blocks: an executing runtime elsewhere; the server part works without one. Cost small once #1 exists.
3. Per-entity durable state replacing Unison Cloud Cells: DO per entity with SQL, Unison calls it over HTTP. Unlocks strong single-writer state with SQL, location hints. Blocks: Unison HTTP client ability exists (unison MCP guide http-json topic, unread), loses Unison Cloud typed transactions; duplicative of Cloud, so lower value.
4. Unison runtime inside a Worker/DO. Blocks: no official wasm/JS backend; only community wasm compiler (reported) and unison.rs (experimental). Highest cost and risk; defer.
5. Whole-codebase SQLite (`unison.sqlite3`) inside a DO: 10 GB cap fine, but UCM's schema is internal and the file is meant for one local process; use as a snapshot object in S3, not as a live DO database.

## 5. Recommendation and smallest PoC
Do #1 with S3/R2 as truth. PoC (about a day): Worker + DO class `Branch(name)` with SQLite tables `log(seq, kind, hash, ts)` and `names(path, hash)`; endpoints `PUT /obj/:hash` (verifies hash of body, R2 put with If-None-Match:*), `POST /have` (returns unknown hashes from a list), `POST /head` (DO appends segment to R2 with create-only key `log/<branch>/<seq>`, then updates SQLite and `head` with If-Match). Test: kill the DO's SQLite (new instance), cold-start from R2 snapshot+replay, and race two concurrent appends expecting exactly one 412. Do not use Unison entity bytes yet: use opaque blobs keyed by sha3/blake3 to prove the protocol, then swap in Share's format.

## Gaps
Unison Cloud Daemon/Remote details, @unison/cloud API, Unison MCP guide topics, Turso/LiteFS lease internals, R2 conditional-write edge cases (e.g. If-Match on missing key), and whether DO storage billing is active were not verified.
