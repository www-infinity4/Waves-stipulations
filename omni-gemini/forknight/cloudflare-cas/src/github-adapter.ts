import { isRecord } from "./contracts";
import { parseTestingHandoff } from "./testing-handoff";

const MAX_WEBHOOK_BYTES = 256 * 1024;
const SIGNATURE = /^sha256=([a-f0-9]{64})$/;

function hexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

export async function verifyGitHubSignature(secret: string, signature: string | null, body: Uint8Array): Promise<boolean> {
  const match = signature?.match(SIGNATURE);
  const signatureHex = match?.[1];
  if (!secret || !signatureHex) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, hexBytes(signatureHex), body);
}

function repositoryAllowed(recordJson: string, fullName: string): boolean {
  const parsed = JSON.parse(recordJson) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.references)) return false;
  const expectedPath = `/${fullName.toLowerCase()}`;
  return parsed.references.some((reference) => {
    if (!isRecord(reference) || typeof reference.locator_uri !== "string") return false;
    try {
      const locator = new URL(reference.locator_uri);
      return locator.hostname.toLowerCase() === "github.com" && locator.pathname.replace(/\.git$/, "").toLowerCase() === expectedPath;
    } catch {
      return false;
    }
  });
}

export async function handleGitHubWebhook(request: Request, env: Cloudflare.Env, candidateId: string): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  if (request.headers.get("x-github-event") !== "repository_dispatch") {
    return Response.json({ error: "unsupported_event" }, { status: 400 });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_WEBHOOK_BYTES) return Response.json({ error: "request_too_large" }, { status: 413 });
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_WEBHOOK_BYTES) return Response.json({ error: "request_too_large" }, { status: 413 });
  if (!(await verifyGitHubSignature(env.GITHUB_WEBHOOK_SECRET, request.headers.get("x-hub-signature-256"), body))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!isRecord(value) || value.action !== "forknight.quarantine" || !isRecord(value.repository) ||
      typeof value.repository.full_name !== "string") {
    return Response.json({ error: "invalid_webhook" }, { status: 400 });
  }
  const handoff = parseTestingHandoff(value.client_payload);
  if (!handoff || handoff.candidate_id !== candidateId) {
    return Response.json({ error: "invalid_handoff" }, { status: 400 });
  }

  const snapshot = await env.CANDIDATE_CAS.getByName(candidateId).getSnapshot();
  if (!snapshot) return Response.json({ error: "candidate_not_found" }, { status: 404 });
  if (snapshot.status !== "quarantined" || snapshot.recordRevision !== handoff.record_revision) {
    return Response.json({ error: "candidate_conflict", status: snapshot.status, record_revision: snapshot.recordRevision }, { status: 409 });
  }
  if (!repositoryAllowed(snapshot.recordJson, value.repository.full_name)) {
    return Response.json({ error: "repository_not_authorized" }, { status: 403 });
  }

  await env.TESTING_HANDOFF_QUEUE.send(handoff, { contentType: "json" });
  return Response.json({ status: "queued", idempotency_key: handoff.idempotency_key }, { status: 202 });
}
