import pytest
from pydantic import ValidationError

from server import EventPayload, IncomingEvent


def test_hifi_event_requires_typed_audio_block() -> None:
    with pytest.raises(ValidationError):
        IncomingEvent.model_validate(
            {
                "client_event_id": "event-1",
                "blip_id": "audio-1",
                "payload_type": "hifi_audio_stream",
                "payload": {"data": {}},
            }
        )


def test_handoff_requires_routing_block() -> None:
    with pytest.raises(ValidationError):
        IncomingEvent.model_validate(
            {
                "client_event_id": "event-2",
                "blip_id": "task-1",
                "payload_type": "agent_handoff",
                "payload": {"data": {}},
            }
        )


def test_text_delta_accepts_plain_data() -> None:
    event = IncomingEvent.model_validate(
        {
            "client_event_id": "event-3",
            "blip_id": "text-1",
            "payload_type": "text_delta",
            "payload": {"data": {"insert": "hello"}},
        }
    )
    assert isinstance(event.payload, EventPayload)
