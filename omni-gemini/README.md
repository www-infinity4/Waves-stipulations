# Infinity HI-FI / Omni Wave Core

This folder is the shared protocol home for the modern Wave-style collaboration canvas, Infinity HI-FI event transport, adaptive acoustic rendering, and the Infinity Clipboard Keyboard.

## Layout

- `backend/server.py` — FastAPI WebSocket timeline, single-use tickets, durable events, and lease-controlled agent handoffs.
- `web-audio/acoustic_space.ts` — deterministic browser acoustic-space renderer with spatial positioning and convolver crossfades.
- `android-keyboard/THEME_CONTRACT.md` — contract for selectable keyboard skins, holiday packs, and user-created photo themes.

## Architectural boundary

Large media never enters the timeline ledger. Events carry content hashes and rendering controls. Yjs updates remain mergeable document state, while the SQLite ledger provides provenance and replay.

The Android keyboard is a separate IME client. It stores long clipboard projects locally, splits them at safe syntax boundaries, and inserts each numbered part directly into the focused editor using Android `InputConnection.commitText()`.

## Status

This branch establishes reviewable reference implementations. Authentication ticket issuance must be connected to a trusted identity provider before public deployment.