# Forknight Candidate CAS Worker

This Worker is the authoritative per-candidate state and lease engine. Each `candidate_id` routes to one SQLite-backed Durable Object through `getByName()`.

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
