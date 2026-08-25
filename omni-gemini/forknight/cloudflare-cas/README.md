# Forknight Candidate CAS Worker

This Worker is the authoritative per-candidate state and lease engine. Each `candidate_id` routes to one SQLite-backed Durable Object through `getByName()`.

It also consumes `forknight-testing-handoff` jobs. Valid jobs are claimed through
the per-candidate object, executed through the internal `TEST_EXECUTOR` service
binding, and finalized as `verified`, `rejected`, or `blocked`. Reports use
content-addressed R2 keys; exhausted infrastructure retries flow to the Queue's
configured dead-letter queue.

Signed GitHub `repository_dispatch` events can enqueue an existing handoff at
`POST /v1/github/candidates/:candidateId`. The event must use the
`forknight.quarantine` action, carry the exact staging handoff in
`client_payload`, match the authoritative candidate revision and an allowed
GitHub reference, and pass `X-Hub-Signature-256` verification. Configure
`GITHUB_WEBHOOK_SECRET` with `wrangler secret put`; it is never stored in Git.

The gateway requires `Authorization: Bearer <token>`. Configure the production secret with `npx wrangler secret put API_TOKEN`; never commit it.

## API

- `POST /v1/candidates/:candidateId/initialize`
- `GET /v1/candidates/:candidateId`
- `POST /v1/candidates/:candidateId/transitions`
- `POST /v1/candidates/:candidateId/content`
- `GET /v1/candidates/:candidateId/content`
- `GET /v1/candidates/:candidateId/content/:sha256`

Transitions require the expected revision, expected status, actor, reason, and idempotency key. Claims additionally require a lease owner and duration. Conflicting revisions, statuses, leases, or forbidden state transitions return a conflict without mutation.

## Verification

```sh
npm install
npm run types
npm run check
npm run deploy:dry
```

The tests run in the Workers runtime and verify concurrent claim exclusion, idempotent replay, deterministic content hashing, and metadata listing.
