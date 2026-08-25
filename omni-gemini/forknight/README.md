# Forknight staging registry

Forknight catalogs external capability references, then rebuilds or isolates implementations behind Infinity-owned contracts. External repositories are research inputs, not automatically runtime dependencies.

## Lifecycle

`discovered → specified → rebuilding → quarantined → claimed → testing → verified → promoted`

Terminal and exception states are `rejected`, `blocked`, `superseded`, and `revoked`.

Workers claim a quarantined record with compare-and-swap on `candidate_id`, `record_revision`, and `status`. A successful claim increments the revision and appends the transition to `status_history`. A zero-row update means another worker won the claim; the losing worker exits without executing the test plan.

## Files

- `forknight-staging-record.schema.json`: authoritative discovery, rebuild, verification, provenance, and promotion record.
- `forknight-testing-handoff.schema.json`: minimal reproducible packet emitted when a record enters quarantine.

## Provenance rule

An external revision may be recorded in `provenance.external_revision`, but it is not treated as a commit in this repository unless independently resolved and verified. The externally reported Gemini revision `8fbc4e772410a8d3e913a52c00223b9d6215f60b` is currently unverified and must not be used as `promotion.tested_commit_sha`.

Provenance classification supports legal and security review; it is evidence, not an automatic legal clearance. Promotion requires separate security and license clearance plus immutable test, security, and provenance artifacts.

## Replay safety

The testing handoff binds the candidate revision, implementation digest, adapter-contract digest, sandbox policy, required tests, and idempotency key. A worker may reuse an earlier result only when the complete handoff identity and signed artifact digests match.

Infrastructure failures transition to `blocked`. Target implementation or contract failures transition to `rejected`.
