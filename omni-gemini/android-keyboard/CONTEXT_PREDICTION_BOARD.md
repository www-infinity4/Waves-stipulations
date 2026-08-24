# Tap Keyboard Intelligence and Weight Board

## Interaction rule

Infinity Clipboard Keyboard is a deliberate tap keyboard. Swipe/glide typing is not part of the product and is disabled in every theme.

The keyboard must not delay a committed key while waiting for prediction. Typing and prediction run on separate paths: taps are inserted immediately, while suggestions update asynchronously.

## User-visible weight board

The settings activity exposes named controls with a plain-language explanation, current value, reset control, and live test field.

### Physical key response

| Control | Purpose | Initial value |
|---|---|---:|
| Tap debounce | Ignore accidental duplicate electrical/touch events | 28 ms |
| Key commit delay | Optional time before a key is inserted | 0 ms |
| Long-press threshold | Time before alternates appear | 420 ms |
| Backspace repeat delay | Pause before held backspace repeats | 360 ms |
| Backspace repeat rate | Speed of held deletion | 55 ms |
| Key animation duration | Visual response only; never blocks insertion | 70 ms |
| Haptic strength | Touch confirmation | 45% |
| Sound volume | Optional key sound | 0% |

### Context prediction weights

All ranking weights are visible and adjustable from 0–100.

| Weight | Meaning | Initial |
|---|---|---:|
| Current sentence | Meaning and grammar of the sentence being written | 100 |
| Previous sentences | Nearby conversational context | 85 |
| Active document topic | Repeated entities and subject of the larger draft | 78 |
| Conversation intent | Question, request, explanation, correction, or code task | 82 |
| Personal vocabulary | User-approved terms, names, and spelling | 88 |
| Recent phrase reuse | Phrases intentionally used earlier | 52 |
| Grammar fit | Agreement, tense, and likely syntax | 76 |
| Semantic fit | Whether the completion continues the actual idea | 100 |
| Frequency prior | General language frequency | 32 |
| Length penalty | Prevent suggestions from becoming unnecessarily long | 45 |
| Repetition penalty | Suppress loops and repeated phrases | 72 |
| Confidence threshold | Minimum score before showing a completion | 68 |

## Whole-context completion

Prediction is not a word-to-word lookup. The engine builds a bounded context frame containing:

1. Text around the cursor.
2. The complete current sentence.
3. A configurable number of preceding sentences.
4. A local summary of older text when the document is long.
5. The editor type from Android `EditorInfo`.
6. The user's approved local vocabulary.
7. The current correction history and explicitly rejected suggestions.

It produces three distinct suggestion types:

- **Correction:** repair the current or previous word.
- **Continuation:** complete the current phrase or sentence.
- **Intent action:** insert a reusable structure such as a code fence, transfer header, address, or project phrase.

Suggestions are ranked as complete candidates. A candidate must improve semantic and grammatical fit; raw frequency alone cannot win.

## Privacy and learning

- Context inference is on-device in the first release.
- Password, PIN, payment, and private browser fields disable learning, storage, and previews.
- Personal learning is opt-in.
- Rejected suggestions lower only the relevant local pattern.
- Users can inspect, edit, export, or erase the learned vocabulary.
- No typed text is sent to a server unless a later cloud model is explicitly enabled.
- Cloud assistance, if added, is a separate visible mode and never silently replaces local prediction.

## Control profiles

- **Instant:** zero commit delay, short animations, conservative suggestions.
- **Careful:** stronger debounce and higher completion confidence.
- **Long-form:** maximum sentence/document context and phrase suggestions.
- **Code:** no prose autocorrection; symbol and identifier awareness.
- **Custom:** exposes every control and permits saving named profiles.

## Performance contract

- Key insertion target: under 16 ms from touch-up.
- Suggestion refresh target: under 80 ms for local candidates.
- Prediction work is cancellable; stale results may never replace newer context.
- The current context revision travels with every prediction request.
- Accepting a suggestion is one undoable edit using an InputConnection batch operation.
