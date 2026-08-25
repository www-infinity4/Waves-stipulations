# Forknight Cloudflare orchestration topology

## Decision

Forknight uses four distinct Cloudflare data planes. Each has one responsibility:

| Plane | Product | Authority |
|---|---|---|
| Candidate coordination | Durable Object with SQLite storage | Authoritative per-candidate state, revision, lease, and transition log |
| Discovery and reporting | D1 | Searchable registry projection and cross-candidate queries |
| Test delivery | Cloudflare Queues | At-least-once asynchronous job delivery, retries, and dead-letter routing |
| Immutable outputs | R2 | Test reports, security reports, provenance reports, visual diffs, and implementation bundles |

Workers KV may cache public contracts and configuration. It is not an authoritative registry or lease store.

Live dashboards may subscribe through WebSockets hosted by a Durable Object. Build workers do not require persistent WebSockets: Cloudflare Queues supports asynchronous consumers, including pull consumers for infrastructure outside Cloudflare.

## Request flow

1. An authenticated Worker validates a staging-record mutation.
2. The Worker routes by `candidate_id` using `env.CANDIDATE_COORDINATOR.getByName(candidateId)`.
3. The candidate Durable Object performs the status/revision compare-and-swap and persists the transition before returning success.
4. A transition into `quarantined` creates a handoff bound to the record revision, implementation digest, contract digest, sandbox policy, and idempotency key.
5. The handoff is published to the test queue.
6. A consumer claims the candidate through the same Durable Object. Only one claim can advance `quarantined → claimed`.
7. The worker executes the sandbox plan and uploads immutable artifacts to R2.
8. The result is submitted to the candidate Durable Object, which verifies the lease and revision before transitioning to `verified`, `blocked`, or `rejected`.
9. D1 is updated as a projection for filtering, reporting, and dashboards. A projection failure does not roll back authoritative Durable Object state; it is retried idempotently.

## Consistency rules

- One Durable Object is created per `candidate_id`; there is no global coordinator object.
- Durable Object SQLite storage is authoritative. In-memory fields are caches only.
- A state mutation validates `candidate_id`, expected `record_revision`, expected status, actor identity, and idempotency key.
- Related state and transition-log writes occur in the same Durable Object storage transaction.
- Queue delivery is treated as at least once. Every consumer checks the idempotency key and immutable input digests.
- D1 contains a query projection, never the sole copy of a lease or CAS revision.
- R2 object keys include the candidate, record revision, implementation digest, and artifact digest.
- WebSocket clients receive notifications after persistence. A dropped notification never means a dropped state transition.

## Security boundaries

- Public ingestion passes through schema validation, authentication, authorization, request-size limits, and rate limits.
- Human dashboards belong behind Cloudflare Access.
- Machine callers use scoped service credentials; mTLS can be added with API Shield where worker certificate management is appropriate.
- Turnstile is for browser-originated abuse protection, not worker-to-worker identity.
- Build sandboxes default to denied network access, temporary filesystem access, bounded memory, and bounded execution time.
- Secrets are bindings and are never stored in schemas, queue messages, D1 rows, logs, or R2 metadata.

## Failure classification

| Condition | Result |
|---|---|
| Another worker already claimed the revision | No-op; acknowledge duplicate delivery |
| Same idempotency key and matching signed artifacts | Reuse the verified result |
| Host or sandbox infrastructure failure | `blocked` |
| Contract, determinism, policy, or target resource failure | `rejected` |
| Projection update failure | Retry projection; preserve authoritative state |
| Exhausted queue retries | Dead-letter queue plus operator alert |

## Deployment order

1. Deploy schemas and validation tests.
2. Create the R2 artifact bucket.
3. Create the primary test queue and dead-letter queue.
4. Create the D1 projection database and migrations.
5. Deploy the SQLite-backed candidate Durable Object migration.
6. Deploy the ingress/router Worker using bindings.
7. Deploy the queue consumer or configure external pull consumers.
8. Add Access-protected dashboard WebSockets.
9. Enable structured logs, traces, and alerts.

## Official platform references

- [Durable Objects rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Durable Objects concepts](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
- [D1 overview](https://developers.cloudflare.com/d1/)
- [Workers storage choices](https://developers.cloudflare.com/workers/platform/storage-options/)
- [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Queues retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
