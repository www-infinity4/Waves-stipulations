import { authorize } from "./auth";
import { processQueueBatch } from "./consumer";
import { handleGitHubWebhook } from "./github-adapter";
import { CandidateCasObject } from "./candidate-cas";
import {
  isCandidateId,
  isRecord,
  isStatus,
  type InitializeInput,
  type TransitionInput,
} from "./contracts";

const MAX_JSON_BYTES = 256 * 1024;
const MAX_CONTENT_BYTES = 1024 * 1024;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

async function readJson(request: Request, maxBytes = MAX_JSON_BYTES): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new RangeError("request_too_large");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new RangeError("request_too_large");
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function candidateFromPath(pathname: string): { candidateId: string; action: string; hash?: string } | null {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "v1" || parts[1] !== "candidates" || !isCandidateId(parts[2])) return null;
  return { candidateId: parts[2], action: parts[3] ?? "snapshot", hash: parts[4] };
}

interface InitializeRequest {
  actorId: string;
  idempotencyKey: string;
  record: Record<string, unknown>;
}

interface TransitionRequest extends Omit<TransitionInput, "candidateId" | "recordJson"> {
  record?: Record<string, unknown>;
}

function validInitialize(value: unknown, candidateId: string): value is InitializeRequest {
  if (!isRecord(value)) return false;
  return typeof value.actorId === "string" && value.actorId.length > 0 &&
    typeof value.idempotencyKey === "string" && value.idempotencyKey.length > 0 &&
    isRecord(value.record) && candidateId.length <= 128;
}

function validTransition(value: unknown): value is TransitionRequest {
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.expectedRevision) && Number(value.expectedRevision) >= 1 &&
    isStatus(value.expectedStatus) && isStatus(value.toStatus) &&
    typeof value.actorId === "string" && value.actorId.length > 0 &&
    typeof value.reason === "string" && value.reason.length > 0 &&
    typeof value.idempotencyKey === "string" && value.idempotencyKey.length > 0 &&
    (value.record === undefined || isRecord(value.record)) &&
    (value.leaseOwner === undefined || typeof value.leaseOwner === "string") &&
    (value.leaseDurationSeconds === undefined ||
      (Number.isSafeInteger(value.leaseDurationSeconds) && Number(value.leaseDurationSeconds) >= 1 && Number(value.leaseDurationSeconds) <= 3600));
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const webhookMatch = new URL(request.url).pathname.match(/^\/v1\/github\/candidates\/(cap_[a-z0-9_]+)$/);
      const webhookCandidate = webhookMatch?.[1];
      if (webhookCandidate) return handleGitHubWebhook(request, env, webhookCandidate);
      if (!(await authorize(request, env.API_TOKEN))) return json({ error: "unauthorized" }, 401);
      const route = candidateFromPath(new URL(request.url).pathname);
      if (!route) return json({ error: "not_found" }, 404);
      const candidate = env.CANDIDATE_CAS.getByName(route.candidateId);

      if (request.method === "GET" && route.action === "snapshot") {
        const snapshot = await candidate.getSnapshot();
        return snapshot ? json(snapshot) : json({ error: "not_initialized" }, 404);
      }
      if (request.method === "POST" && route.action === "initialize") {
        const body = await readJson(request);
        if (!validInitialize(body, route.candidateId)) return json({ error: "invalid_request" }, 400);
        const result = await candidate.initialize({
          candidateId: route.candidateId,
          actorId: body.actorId,
          idempotencyKey: body.idempotencyKey,
          recordJson: JSON.stringify(body.record),
        });
        return json(result, result.applied || result.replayed ? 200 : 409);
      }
      if (request.method === "POST" && route.action === "transitions") {
        const body = await readJson(request);
        if (!validTransition(body)) return json({ error: "invalid_request" }, 400);
        const { record, ...transition } = body;
        const result = await candidate.transition({
          ...transition,
          candidateId: route.candidateId,
          ...(record === undefined ? {} : { recordJson: JSON.stringify(record) }),
        });
        return json(result, result.applied || result.replayed ? 200 : 409);
      }
      if (request.method === "POST" && route.action === "content") {
        const contentType = request.headers.get("content-type") ?? "application/octet-stream";
        const length = Number(request.headers.get("content-length") ?? 0);
        if (length > MAX_CONTENT_BYTES) return json({ error: "request_too_large" }, 413);
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.byteLength > MAX_CONTENT_BYTES) return json({ error: "request_too_large" }, 413);
        return json(await candidate.putContent(new TextDecoder().decode(bytes), contentType), 201);
      }
      if (request.method === "GET" && route.action === "content" && route.hash) {
        if (!/^[a-f0-9]{64}$/.test(route.hash)) return json({ error: "invalid_hash" }, 400);
        const entry = await candidate.getContent(route.hash);
        return entry ? json(entry) : json({ error: "not_found" }, 404);
      }
      if (request.method === "GET" && route.action === "content") {
        return json(await candidate.listContent());
      }
      return json({ error: "method_not_allowed" }, 405);
    } catch (error) {
      if (error instanceof RangeError) return json({ error: error.message }, 413);
      if (error instanceof SyntaxError) return json({ error: "invalid_json" }, 400);
      console.error(JSON.stringify({ message: "request_failed", error: error instanceof Error ? error.message : "unknown" }));
      return json({ error: "internal_error" }, 500);
    }
  },
  async queue(batch, env): Promise<void> {
    await processQueueBatch(batch, env);
  },
} satisfies ExportedHandler<Cloudflare.Env, unknown>;

export { CandidateCasObject };
