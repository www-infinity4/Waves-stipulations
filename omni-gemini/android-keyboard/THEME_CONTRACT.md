# Infinity Clipboard Keyboard Theme Contract

The Android application is an Input Method Editor (IME). Themes may change presentation but never key meaning, touch bounds, accessibility labels, or secure-field behavior.

## Theme manifest

Each built-in or imported theme contains a `theme.json` file:

```json
{
  "schema_version": 1,
  "theme_id": "winter-lights",
  "display_name": "Winter Lights",
  "author": "Infinity",
  "background": { "type": "image", "asset": "background.webp", "opacity": 0.72 },
  "keys": {
    "fill": "#172019CC",
    "label": "#FFFFFF",
    "pressed_fill": "#B9FF66",
    "corner_radius_dp": 8,
    "border_width_dp": 1,
    "border_color": "#FFFFFF44"
  },
  "clipboard_panel": {
    "accent": "#B9FF66",
    "surface": "#203126",
    "text": "#FFFFFF"
  }
}
```

## Supported designs

1. **Complete keyboard background** — one picture spans behind the entire key grid.
2. **Picture tiled per key** — the chosen image is cropped into the individual key surfaces.
3. **Key-set pack** — separate assets may be assigned to letter, number, action, space, and clipboard keys.
4. **Seasonal pack** — themes can include optional start/end dates but never activate without the user's selection.
5. **User drawing** — an image selected from Android's system photo picker is cropped locally and saved only in app-private storage.

## Required safeguards

- Never upload imported pictures.
- Strip image metadata when copying an image into the theme store.
- Reject executable files, SVG scripts, remote URLs, and path traversal.
- Decode images with strict pixel and file-size limits.
- Maintain WCAG-readable key labels by adding an automatic contrast scrim.
- Disable clipboard history and previews for password fields.
- Never modify the semantic action or accessibility label of a key based on its artwork.
- Offer a one-tap return to the default high-contrast theme.

## Keyboard modes

- **Typing:** normal keys plus an Infinity Clipboard toolbar.
- **Clipboard:** large project and `Insert next part` controls replace the key grid temporarily.
- **Theme studio:** preview, crop, label contrast, and key-grid mapping; it is opened from the companion activity, never over a password field.

## Initial Android components

- `InfinityInputMethodService`: owns the IME lifecycle and direct text insertion.
- `ClipboardProjectStore`: encrypted, on-device projects and delivery progress.
- `SafeChunker`: blank-line, line, then word-boundary splitting with checksums.
- `ThemeRepository`: built-in manifests and sanitized user-created themes.
- `KeyboardRenderer`: key geometry, labels, pressed states, and mapped imagery.
- `PreflightScanner`: warns when source text already contains collapsed imports or lost indentation.

The first prototype should be clipboard-only with the Android keyboard-switch control visible. A full typing layout can follow without changing the project or theme formats.