from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path
from typing import Annotated, Any, Literal

import aiosqlite
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect, status
from pydantic import BaseModel, Field, field_validator, model_validator

logger = logging.getLogger("omni-gemini")
DB_PATH = Path("wave_timeline.db")
MAX_MESSAGE_BYTES = 64 * 1024
EXPECTED_AUDIENCE = "omni-network"
ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class RunState(str, Enum):
    QUEUED = "queued"
    CLAIMED = "claimed"
    RUNNING = "running"
    HANDOFF_PENDING = "handoff_pending"
    COMPLETED = "completed"
    RETRY_WAIT = "retry_wait"
    BLOCKED = "blocked"
    FAILED = "failed"
    CANCELLED = "cancelled"


ALLOWED_TRANSITIONS: dict[RunState, set[RunState]] = {
    RunState.QUEUED: {RunState.CLAIMED, RunState.CANCELLED},
    RunState.CLAIMED: {RunState.RUNNING, RunState.FAILED, RunState.CANCELLED},
    RunState.RUNNING: {
        RunState.HANDOFF_PENDING,
        RunState.COMPLETED,
        RunState.RETRY_WAIT,
        RunState.BLOCKED,
        RunState.FAILED,
        RunState.CANCELLED,
    },
    RunState.HANDOFF_PENDING: {RunState.COMPLETED, RunState.FAILED, RunState.CANCELLED},
    RunState.RETRY_WAIT: {RunState.RUNNING, RunState.FAILED, RunState.CANCELLED},
    RunState.BLOCKED: {RunState.RUNNING, RunState.FAILED, RunState.CANCELLED},
    RunState.COMPLETED: set(),
    RunState.FAILED: set(),
    RunState.CANCELLED: set(),
}


class PayloadType(str, Enum):
    TEXT_DELTA = "text_delta"
    CODE_EXEC = "code_exec"
    HIFI_AUDIO_STREAM = "hifi_audio_stream"
    AGENT_HANDOFF = "agent_handoff"
    YJS_UPDATE = "yjs_update"
    VIDEO_MASK_RENDER = "video_mask_render"


class SafeIdModel(BaseModel):
    @field_validator("*", mode="before")
    @classmethod
    def trim_strings(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class Ticket(SafeIdModel):
    ticket_id: str = Field(max_length=64)
    wave_id: str = Field(max_length=64)
    sender_id: str = Field(max_length=64)
    audience: str = Field(max_length=64)
    expires_at: datetime

    @field_validator("ticket_id", "wave_id", "sender_id", "audience")
    @classmethod
    def validate_safe_id(cls, value: str) -> str:
        if not ID_PATTERN.fullmatch(value):
            raise ValueError("identifier contains unsupported characters")
        return value


class RoutingHeader(BaseModel):
    run_id: str = Field(max_length=64)
    task_id: str = Field(max_length=64)
    destination_agent_id: str = Field(max_length=64)
    required_capability: str = Field(max_length=128)
    status: RunState
    attempt_number: int = Field(ge=1, le=100)
    trace_id: str = Field(max_length=64)
    span_id: str = Field(max_length=64)


class AudioSource(BaseModel):
    media_identity: str = Field(max_length=256)
    format: Literal["pcm_f32le", "opus_packet", "flac_stream"]
    sample_rate: int = Field(ge=8_000, le=192_000)
    channels: int = Field(ge=1, le=8)
    codec_frame_duration_ms: float = Field(gt=0, le=120)
    channel_layout: str = Field(max_length=64)
    clock_rate: int = Field(gt=0)


class AudioAnalysis(BaseModel):
    loudness_lufs: float = Field(ge=-120, le=0)
    true_peak_dbfs: float = Field(ge=-120, le=10)
    clipping_count: int = Field(ge=0)
    snr_db: float = Field(ge=0, le=150)
    spectral_noise_floor_dbfs: float = Field(ge=-150, le=0)


class AudioControl(BaseModel):
    target_gain_db: float = Field(ge=-120, le=40)
    eq_bands_db: list[float] = Field(min_length=3, max_length=31)
    denoise_threshold_db: float = Field(ge=-120, le=0)
    dynamic_range_ratio: float = Field(ge=0.1, le=20)


class AudioClock(BaseModel):
    sample_position: int = Field(ge=0)
    synchronization_epoch_ms: int = Field(ge=0)
    discontinuity_sequence: int = Field(ge=0)


class HiFiAudioEvent(BaseModel):
    source: AudioSource
    analysis: AudioAnalysis
    control: AudioControl
    clock: AudioClock


class EventPayload(BaseModel):
    data: dict[str, Any] = Field(default_factory=dict)
    content_hash: str | None = Field(default=None, pattern=r"^[a-fA-F0-9]{64}$")
    routing: RoutingHeader | None = None
    hifi_audio: HiFiAudioEvent | None = None

    @model_validator(mode="after")
    def validate_shape(self) -> "EventPayload":
        return self


class IncomingEvent(BaseModel):
    client_event_id: str = Field(max_length=64)
    blip_id: str = Field(max_length=64)
    payload_type: PayloadType
    payload: EventPayload

    @model_validator(mode="after")
    def require_typed_payload(self) -> "IncomingEvent":
        if self.payload_type is PayloadType.HIFI_AUDIO_STREAM and self.payload.hifi_audio is None:
            raise ValueError("hifi_audio is required for hifi_audio_stream")
        if self.payload_type is PayloadType.AGENT_HANDOFF and self.payload.routing is None:
            raise ValueError("routing is required for agent_handoff")
        return self


class SocketHub:
    def __init__(self) -> None:
        self.waves: dict[str, dict[str, WebSocket]] = {}
        self.lock = asyncio.Lock()

    async def add(self, wave_id: str, connection_id: str, socket: WebSocket) -> None:
        async with self.lock:
            self.waves.setdefault(wave_id, {})[connection_id] = socket

    async def remove(self, wave_id: str, connection_id: str) -> None:
        async with self.lock:
            wave = self.waves.get(wave_id)
            if wave is None:
                return
            wave.pop(connection_id, None)
            if not wave:
                self.waves.pop(wave_id, None)

    async def broadcast(self, wave_id: str, packet: str, skip: str | None = None) -> None:
        async with self.lock:
            targets = list(self.waves.get(wave_id, {}).items())
        dead: list[str] = []
        for connection_id, socket in targets:
            if connection_id == skip:
                continue
            try:
                await socket.send_text(packet)
            except Exception:
                dead.append(connection_id)
        for connection_id in dead:
            await self.remove(wave_id, connection_id)


hub = SocketHub()
tickets: dict[str, Ticket] = {}
ticket_lock = asyncio.Lock()


async def issue_ticket(wave_id: str, sender_id: str, lifetime_seconds: int = 300) -> Ticket:
    """Called by a trusted authentication boundary, not exposed as a public route."""
    ticket = Ticket(
        ticket_id=f"tkt_{uuid.uuid4().hex}",
        wave_id=wave_id,
        sender_id=sender_id,
        audience=EXPECTED_AUDIENCE,
        expires_at=utc_now() + timedelta(seconds=lifetime_seconds),
    )
    async with ticket_lock:
        tickets[ticket.ticket_id] = ticket
    return ticket


async def consume_ticket(ticket_id: str, wave_id: str) -> Ticket | None:
    async with ticket_lock:
        ticket = tickets.pop(ticket_id, None)
    if (
        ticket is None
        or ticket.wave_id != wave_id
        or ticket.audience != EXPECTED_AUDIENCE
        or ticket.expires_at <= utc_now()
    ):
        return None
    return ticket


async def initialize_database() -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("PRAGMA journal_mode=WAL")
        await db.executescript(
            """
            CREATE TABLE IF NOT EXISTS timeline_ledger (
                sequence_number INTEGER PRIMARY KEY AUTOINCREMENT,
                server_event_id TEXT UNIQUE NOT NULL,
                client_event_id TEXT NOT NULL,
                wave_id TEXT NOT NULL,
                blip_id TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                payload_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                UNIQUE(sender_id, client_event_id)
            );
            CREATE INDEX IF NOT EXISTS idx_timeline_wave_seq
                ON timeline_ledger(wave_id, sequence_number);
            CREATE TABLE IF NOT EXISTS task_leases (
                task_id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                lease_owner TEXT NOT NULL,
                lease_expiration TEXT NOT NULL,
                current_state TEXT NOT NULL,
                lease_version INTEGER NOT NULL,
                last_updated TEXT NOT NULL
            );
            """
        )
        await db.commit()


@asynccontextmanager
async def lifespan(_: FastAPI):
    await initialize_database()
    yield


app = FastAPI(title="Omni Gemini Wave Core", lifespan=lifespan)


async def replay_after(socket: WebSocket, wave_id: str, last_seq: int) -> int:
    highest = last_seq
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT * FROM timeline_ledger
               WHERE wave_id = ? AND sequence_number > ?
               ORDER BY sequence_number""",
            (wave_id, last_seq),
        ) as cursor:
            async for row in cursor:
                packet = dict(row)
                packet["payload"] = json.loads(packet["payload"])
                await socket.send_json(packet)
                highest = packet["sequence_number"]
    return highest


async def append_event(
    wave_id: str, sender_id: str, incoming: IncomingEvent
) -> tuple[dict[str, Any], bool]:
    now = utc_now()
    server_event_id = str(uuid.uuid4())
    async with aiosqlite.connect(DB_PATH, timeout=10) as db:
        await db.execute("BEGIN IMMEDIATE")
        try:
            routing = incoming.payload.routing
            if routing is not None:
                lease_expiry = now + timedelta(seconds=30)
                async with db.execute(
                    """SELECT lease_owner, lease_expiration, current_state, lease_version
                       FROM task_leases WHERE task_id = ?""",
                    (routing.task_id,),
                ) as cursor:
                    lease = await cursor.fetchone()
                if lease is None:
                    if routing.status not in {RunState.QUEUED, RunState.CLAIMED}:
                        raise ValueError("illegal initial task state")
                    await db.execute(
                        """INSERT INTO task_leases
                           (task_id, run_id, lease_owner, lease_expiration,
                            current_state, lease_version, last_updated)
                           VALUES (?, ?, ?, ?, ?, 1, ?)""",
                        (
                            routing.task_id,
                            routing.run_id,
                            sender_id,
                            lease_expiry.isoformat(),
                            routing.status.value,
                            now.isoformat(),
                        ),
                    )
                else:
                    owner, expiry_text, current_text, version = lease
                    expiry = datetime.fromisoformat(expiry_text)
                    current = RunState(current_text)
                    if expiry > now and owner != sender_id:
                        raise PermissionError(f"task lease is held by {owner}")
                    if routing.status not in ALLOWED_TRANSITIONS[current]:
                        raise ValueError(f"illegal transition {current.value} -> {routing.status.value}")
                    cursor = await db.execute(
                        """UPDATE task_leases
                           SET lease_owner = ?, lease_expiration = ?, current_state = ?,
                               lease_version = lease_version + 1, last_updated = ?
                           WHERE task_id = ? AND lease_version = ?""",
                        (
                            sender_id,
                            lease_expiry.isoformat(),
                            routing.status.value,
                            now.isoformat(),
                            routing.task_id,
                            version,
                        ),
                    )
                    if cursor.rowcount != 1:
                        raise RuntimeError("lease compare-and-swap conflict")

            cursor = await db.execute(
                """INSERT INTO timeline_ledger
                   (server_event_id, client_event_id, wave_id, blip_id, timestamp,
                    payload_type, payload, sender_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    server_event_id,
                    incoming.client_event_id,
                    wave_id,
                    incoming.blip_id,
                    now.isoformat(),
                    incoming.payload_type.value,
                    incoming.payload.model_dump_json(),
                    sender_id,
                ),
            )
            sequence = cursor.lastrowid
            await db.commit()
            return {
                "sequence_number": sequence,
                "server_event_id": server_event_id,
                "client_event_id": incoming.client_event_id,
                "wave_id": wave_id,
                "blip_id": incoming.blip_id,
                "timestamp": now.isoformat(),
                "payload_type": incoming.payload_type.value,
                "payload": incoming.payload.model_dump(mode="json"),
                "sender_id": sender_id,
            }, False
        except aiosqlite.IntegrityError:
            await db.rollback()
            async with db.execute(
                """SELECT sequence_number, server_event_id FROM timeline_ledger
                   WHERE sender_id = ? AND client_event_id = ?""",
                (sender_id, incoming.client_event_id),
            ) as cursor:
                duplicate = await cursor.fetchone()
            if duplicate is None:
                raise
            return {
                "sequence_number": duplicate[0],
                "server_event_id": duplicate[1],
                "client_event_id": incoming.client_event_id,
            }, True
        except Exception:
            await db.rollback()
            raise


@app.websocket("/wave/{wave_id}/stream")
async def wave_stream(
    websocket: WebSocket,
    wave_id: str,
    ticket_id: Annotated[str, Query(max_length=64)],
    last_seq: Annotated[int, Query(ge=0)] = 0,
) -> None:
    ticket = await consume_ticket(ticket_id, wave_id)
    if ticket is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await websocket.accept()
    connection_id = str(uuid.uuid4())
    try:
        # Register first, replay, then replay once more. Duplicate sequence numbers
        # are harmless and clients deduplicate by server_event_id.
        await hub.add(wave_id, connection_id, websocket)
        boundary = await replay_after(websocket, wave_id, last_seq)
        await replay_after(websocket, wave_id, boundary)

        while True:
            raw = await asyncio.wait_for(websocket.receive_text(), timeout=65)
            if len(raw.encode("utf-8")) > MAX_MESSAGE_BYTES:
                await websocket.send_json({"error": "payload_too_large"})
                continue
            message = json.loads(raw)
            if message.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
                continue
            if message.get("type") == "presence_sync":
                message.setdefault("data", {})["identity"] = ticket.sender_id
                await hub.broadcast(wave_id, json.dumps(message), skip=connection_id)
                continue

            incoming = IncomingEvent.model_validate(message)
            packet, duplicate = await append_event(wave_id, ticket.sender_id, incoming)
            await websocket.send_json(
                {
                    "status": "ack",
                    "client_event_id": incoming.client_event_id,
                    "server_event_id": packet["server_event_id"],
                    "sequence_number": packet["sequence_number"],
                    "duplicate": duplicate,
                }
            )
            if not duplicate:
                await hub.broadcast(wave_id, json.dumps(packet), skip=connection_id)
    except (WebSocketDisconnect, asyncio.TimeoutError):
        pass
    except Exception as exc:
        logger.exception("wave stream failed")
        try:
            await websocket.send_json({"error": type(exc).__name__, "message": str(exc)})
        except Exception:
            pass
    finally:
        await hub.remove(wave_id, connection_id)
