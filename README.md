# xterm-addon-edit-context

An [xterm.js](https://github.com/xtermjs/xterm.js) addon that replaces the default hidden-textarea input with the [EditContext API](https://w3c.github.io/edit-context/) for better mobile keyboard support.

## Problem

xterm.js' input model treats its hidden textarea as a keystroke buffer. Mobile virtual keyboards are text editors, not keystroke generators: they replace words (autocorrect), insert phrases (dictation), and manipulate cursor position (iOS spacebar trackpad). The textarea model can't distinguish these operations from normal typing, causing duplicated text, lost corrections, and broken advanced features.

## Solution

The EditContext API decouples text input from DOM elements. Instead of the browser owning the relationship between a textarea and the OS text input service, your code becomes the text model. Text mutations arrive as `textupdate` events with explicit replacement ranges ("replace characters 3-7 with 'hello'"), eliminating the ambiguity.

This addon:

- Uses native EditContext on Chrome/Edge (121+)
- Loads a [polyfill](https://github.com/neftaly/editcontext-polyfill) for Safari (15.4+) and Firefox (125+)
- Forwards keyboard events (special keys, modifier combos) to xterm.js' existing handler
- Translates text replacements into terminal-compatible input sequences

## What it fixes

| Feature | Without addon | With addon |
|---|---|---|
| Dictation | Duplicated text | Clean replacement |
| Autocorrect | Duplicated or garbled | Clean replacement |
| Swipe typing | Partially works | Clean input |
| Hold-backspace word deletion | Broken (no word boundaries) | Works with line sync |
| iOS spacebar trackpad | Broken (no cursor context) | Works with line sync |
| CJK IME composition | Partial (CompositionHelper) | Clean via EditContext |

## Install

```bash
npm install xterm-addon-edit-context
```

## Usage

```ts
import { Terminal } from '@xterm/xterm'
import { EditContextAddon } from 'xterm-addon-edit-context'

const terminal = new Terminal()
terminal.open(document.getElementById('terminal')!)

const editContextAddon = new EditContextAddon()
terminal.loadAddon(editContextAddon)
```

### Line sync (optional)

For hold-backspace word deletion and iOS spacebar trackpad to work, the OS needs to know what text is on the current line. Call `updateText()` after terminal output to sync:

```ts
// After terminal output, read the current line and sync it.
// This enables the OS to compute word boundaries and cursor movement.
function syncInputLine() {
  const buf = terminal.buffer.active
  const line = buf.getLine(buf.cursorY)
  if (!line) return

  const text = line.translateToString(true)
  editContextAddon.updateText(text, buf.cursorX)
}
```

Without line sync, the addon still fixes dictation, autocorrect, and swipe typing. Those features only need the EditContext's replacement range information, not knowledge of the full line content.

### IME positioning (optional)

For correct IME popup placement, provide the terminal's bounds:

```ts
function syncBounds() {
  const dims = terminal.dimensions
  if (!dims || !terminal.element) return

  const rect = terminal.element.getBoundingClientRect()
  const buf = terminal.buffer.active

  editContextAddon.updateBounds(
    rect,
    new DOMRect(
      rect.left + buf.cursorX * dims.css.cell.width,
      rect.top + buf.cursorY * dims.css.cell.height,
      dims.css.cell.width,
      dims.css.cell.height,
    ),
  )
}
```

## Options

```ts
new EditContextAddon({
  // Load the polyfill for Safari/Firefox. Default: true.
  polyfill: true,

  // Provide your own input element instead of the auto-created overlay.
  inputElement: myCustomElement,
})
```

## How it works

1. Creates a transparent overlay element inside the terminal container
2. Attaches an EditContext to it (native on Chrome/Edge, polyfill on Safari/Firefox)
3. Redirects focus from xterm's hidden textarea to the overlay
4. Suppresses xterm's `input`/`composition` event handlers (capture phase)
5. Handles `textupdate` events: computes the diff and sends PTY input
6. Forwards `keydown`/`keyup` to xterm's textarea for keyboard evaluation (special keys, modifiers, Kitty protocol)

## Browser support

| Browser | Support |
|---|---|
| Chrome / Edge 121+ | Native EditContext |
| Chrome for Android | Native EditContext |
| Samsung Internet 25+ | Native EditContext |
| Safari 15.4+ (including iOS) | Polyfill |
| Firefox 125+ | Polyfill |

## License

MIT
