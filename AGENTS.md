# AGENTS.md

## Architecture

This is an xterm.js addon, not a standalone terminal. It has zero coupling to gmux. All input/output goes through `terminal.input()` (the xterm.js public API).

The addon creates a transparent overlay with EditContext attached. It does NOT replace xterm.js' keyboard handling for special keys; only the text-input path (the hidden textarea's `input`/`composition` events) is replaced.

## Testing

Tests run in jsdom (`vitest`). The `_computeInput` method is the core algorithm; test it thoroughly via the public-facing behavior (textupdate handler or direct private access for unit tests).

Real-device testing is essential. Behavior differs significantly between iOS Safari, Android Chrome, and Firefox. Use gmux's `/_/input-diagnostics` page to capture event traces from real devices.

## Key decisions

- `terminal.input(data, true)` is the public API for injecting input. We use it instead of internal APIs for forward compatibility.
- Keyboard events are forwarded to xterm's textarea via `dispatchEvent(new KeyboardEvent(...))`. xterm.js does not check `isTrusted`, so this works. If that changes upstream, we'll need to adapt.
- The polyfill (`@neftaly/editcontext-polyfill`) is dynamically imported so it's tree-shaken when native EditContext is available.
