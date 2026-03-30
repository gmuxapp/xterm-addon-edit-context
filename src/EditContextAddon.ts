/**
 * EditContext addon for xterm.js.
 *
 * Replaces xterm.js' hidden-textarea input path with the EditContext API.
 * On browsers with native support (Chrome/Edge 133+), uses the native API.
 * On Safari and Firefox, loads a polyfill that provides the same interface
 * via a hidden textarea with smarter event translation.
 *
 * Why: xterm.js' default input model treats the hidden textarea as a
 * keystroke buffer. Mobile virtual keyboards are text editors, not
 * keystroke generators: they replace words (autocorrect), insert phrases
 * (dictation), and manipulate cursor position (spacebar trackpad). The
 * textarea model can't distinguish these operations from normal typing,
 * causing duplicated text, lost corrections, and broken advanced features.
 *
 * EditContext gives us explicit replacement ranges ("replace characters
 * 3-7 with 'hello'") instead of ambiguous insertion events. This makes
 * dictation, autocorrect, swipe typing, hold-backspace word deletion,
 * and iOS spacebar cursor movement work correctly.
 *
 * Architecture:
 *
 *   1. Create a focusable overlay element inside the terminal container.
 *   2. Attach an EditContext to it (native or polyfill).
 *   3. Redirect focus from xterm's textarea to our overlay.
 *   4. Suppress xterm's input/composition event handlers (capture phase).
 *   5. Handle textupdate events: diff against known state, send to PTY.
 *   6. Handle keyboard events on the overlay for non-text keys.
 *   7. Optionally sync the EditContext's text buffer with the terminal's
 *      current input line for hold-backspace and spacebar trackpad.
 *
 * Desktop keyboard input (keydown-based escape sequences, Kitty protocol,
 * modifier encoding) is handled by forwarding KeyboardEvent from our
 * overlay to the terminal. The addon only intercepts the text-input path;
 * it does not replace xterm.js' keyboard evaluation.
 */

import type { Terminal, ITerminalAddon } from '@xterm/xterm'
import type {
  IEditContext,
  TextUpdateEvent,
  CharacterBoundsUpdateEvent,
  EditContextAddonOptions,
} from './types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when the native EditContext API is available. */
function hasNativeEditContext(): boolean {
  return typeof (globalThis as any).EditContext === 'function'
}

/**
 * Create a focusable overlay element for EditContext input.
 *
 * The element is transparent and covers the terminal viewport so that
 * tapping anywhere on the terminal focuses it and opens the keyboard.
 * pointer-events is set to none for everything except focus; the terminal's
 * own mouse/touch handlers continue to work underneath.
 */
function createOverlay(container: HTMLElement): HTMLDivElement {
  const el = document.createElement('div')
  el.className = 'xterm-edit-context-overlay'
  el.tabIndex = 0
  // Accessible: screen readers should announce this as the terminal input.
  el.setAttribute('role', 'textbox')
  el.setAttribute('aria-multiline', 'false')
  el.setAttribute('aria-label', 'Terminal input')

  Object.assign(el.style, {
    position: 'absolute',
    inset: '0',
    // Transparent, non-interactive (taps pass through to xterm's canvas).
    // We override pointer-events selectively for focus in the focus handler.
    opacity: '0',
    pointerEvents: 'none',
    zIndex: '1',
    // Prevent the element from affecting layout.
    overflow: 'hidden',
    outline: 'none',
    caretColor: 'transparent',
  } satisfies Partial<CSSStyleDeclaration>)

  container.style.position = 'relative'
  container.appendChild(el)
  return el
}

/**
 * Suppress xterm.js' own input/composition/beforeinput handling on its
 * textarea. We intercept in the capture phase on the container (parent of
 * the textarea) so we fire before xterm's own capture-phase listeners.
 *
 * Returns a cleanup function.
 */
function suppressXtermInput(container: HTMLElement): () => void {
  const stop = (ev: Event) => {
    ev.stopImmediatePropagation()
  }

  // These are the events xterm.js listens for on its textarea:
  //   input, compositionstart, compositionupdate, compositionend
  // We block them all. keydown/keyup are NOT blocked; they're forwarded.
  const events = ['input', 'compositionstart', 'compositionupdate', 'compositionend'] as const
  for (const name of events) {
    container.addEventListener(name, stop, { capture: true })
  }

  return () => {
    for (const name of events) {
      container.removeEventListener(name, stop, { capture: true })
    }
  }
}

// ---------------------------------------------------------------------------
// EditContextAddon
// ---------------------------------------------------------------------------

export class EditContextAddon implements ITerminalAddon {
  private _editContext: IEditContext | null = null
  private _overlay: HTMLDivElement | null = null
  private _disposables: (() => void)[] = []

  // The text content we last synced to the EditContext. Used to compute
  // diffs when textupdate fires with replacement ranges.
  private _contextText = ''
  private _contextSelStart = 0
  // Tracked for future selection-range operations.
  // @ts-expect-error Written by _syncContextState/updateText, reserved for future use.
  private _contextSelEnd = 0

  // When true, the next textupdate was already handled by the keydown path
  // and should be skipped to avoid double-sending.
  private _keyDownHandled = false

  private readonly _options: Required<EditContextAddonOptions>

  constructor(options?: EditContextAddonOptions) {
    this._options = {
      polyfill: options?.polyfill ?? true,
      inputElement: options?.inputElement ?? (null as unknown as HTMLElement),
    }
  }

  // ── ITerminalAddon ──────────────────────────────────────────────────

  activate(terminal: Terminal): void {
    const container = terminal.element
    if (!container) {
      throw new Error('EditContextAddon: terminal.element is not available. Call term.open() first.')
    }

    this._setup(terminal, container)
  }

  dispose(): void {
    for (const d of this._disposables) d()
    this._disposables = []
    this._overlay?.remove()
    this._overlay = null
    this._editContext = null
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Update the EditContext's text buffer to match the terminal's current
   * input line. Call this after terminal output to enable OS-level features
   * that depend on knowing the text content:
   *
   *  - Hold-backspace word deletion (OS computes word boundaries)
   *  - iOS spacebar trackpad (OS computes cursor movement)
   *  - Better autocorrect suggestions (OS sees surrounding context)
   *
   * If never called, the EditContext still works for basic input; it just
   * treats each input session as starting from empty.
   */
  updateText(text: string, selectionStart: number, selectionEnd?: number): void {
    const ec = this._editContext
    if (!ec) return

    const selEnd = selectionEnd ?? selectionStart
    ec.updateText(0, ec.text.length, text)
    ec.updateSelection(selectionStart, selEnd)
    this._contextText = text
    this._contextSelStart = selectionStart
    this._contextSelEnd = selEnd
  }

  /**
   * Update the EditContext's bounds information so the OS can position
   * IME popups and virtual keyboard suggestions correctly.
   *
   * Call this after the terminal resizes or the cursor moves.
   */
  updateBounds(controlBounds: DOMRect, selectionBounds: DOMRect): void {
    const ec = this._editContext
    if (!ec) return
    ec.updateControlBounds(controlBounds)
    ec.updateSelectionBounds(selectionBounds)
  }

  // ── Setup ───────────────────────────────────────────────────────────

  private async _setup(terminal: Terminal, container: HTMLElement): Promise<void> {
    // 1. Create or use the overlay element.
    const overlay = this._options.inputElement ?? createOverlay(container)
    this._overlay = overlay instanceof HTMLDivElement ? overlay : null

    // 2. Create the EditContext.
    const ec = await this._createEditContext(overlay)
    if (!ec) {
      console.warn('EditContextAddon: EditContext not available and polyfill disabled.')
      return
    }
    this._editContext = ec

    // 3. Suppress xterm's textarea input handling.
    this._disposables.push(suppressXtermInput(container))

    // 4. Wire up events.
    this._wireTextUpdate(ec, terminal)
    this._wireCharacterBounds(ec, terminal)
    this._wireKeyboard(overlay, terminal)
    this._wireFocus(overlay, terminal, container)
  }

  private async _createEditContext(element: HTMLElement): Promise<IEditContext | null> {
    if (hasNativeEditContext()) {
      const ec = new (globalThis as any).EditContext()
      // Native API: assign to the element's editContext property.
      ;(element as any).editContext = ec
      return ec as unknown as IEditContext
    }

    if (!this._options.polyfill) return null

    // Dynamic import so the polyfill is not bundled when native is available.
    try {
      const polyfill = await import('@neftaly/editcontext-polyfill')
      if (polyfill.install) polyfill.install()
      const ec = new (globalThis as any).EditContext()
      ;(element as any).editContext = ec
      return ec as unknown as IEditContext
    } catch (err) {
      console.warn('EditContextAddon: failed to load polyfill:', err)
      return null
    }
  }

  // ── textupdate → terminal input ─────────────────────────────────────

  private _wireTextUpdate(ec: IEditContext, terminal: Terminal): void {
    const handler = (ev: Event) => {
      const e = ev as TextUpdateEvent

      // If the keydown handler already sent this input, skip.
      if (this._keyDownHandled) {
        this._keyDownHandled = false
        this._syncContextState(ec)
        return
      }

      // Compute what changed relative to our known state.
      const oldText = this._contextText
      const rangeStart = e.updateRangeStart
      const rangeEnd = e.updateRangeEnd
      const newText = e.text

      // Translate the replacement into PTY input.
      //
      // Simple case: text appended at the cursor (normal typing).
      // Complex case: replacement of existing text (autocorrect, dictation).
      //
      // For replacements, we need to:
      //   1. Move the terminal cursor to the start of the replacement range.
      //   2. Delete the old text in the range.
      //   3. Insert the new text.
      //
      // We express cursor movement as arrow keys and deletion as
      // backspace/delete, which works for readline-based programs and most
      // TUIs. For programs in raw mode, the simple case (appending) still
      // works; replacements are best-effort.

      const data = this._computeInput(oldText, rangeStart, rangeEnd, newText)
      if (data) {
        terminal.input(data, true)
      }

      this._syncContextState(ec)
    }

    ec.addEventListener('textupdate', handler)
    this._disposables.push(() => ec.removeEventListener('textupdate', handler))
  }

  /**
   * Translate an EditContext replacement into PTY input bytes.
   *
   * The cursor is assumed to be at `_contextSelStart` in the PTY line.
   * We compute the minimal sequence of backspaces, forward-deletes, and
   * character insertions to apply the replacement.
   *
   * Three cases based on cursor position relative to the replacement range:
   *
   *   cursor >= rangeEnd:
   *     Backspace from cursor to rangeEnd erases the suffix.
   *     Continue backspacing from rangeEnd to rangeStart to erase the range.
   *     Then insert newText + re-type the suffix.
   *
   *   cursor inside [rangeStart, rangeEnd):
   *     Backspace from cursor to rangeStart erases the left part of the range.
   *     Forward-delete from rangeStart to rangeEnd erases the right part.
   *     Then insert newText.
   *
   *   cursor < rangeStart:
   *     Move forward to rangeStart. Forward-delete the range. Insert newText.
   */
  private _computeInput(
    oldText: string,
    rangeStart: number,
    rangeEnd: number,
    newText: string,
  ): string | null {
    const cursor = this._contextSelStart

    // Pure append at cursor: normal typing, swipe, dictation of new text.
    if (rangeStart === rangeEnd && rangeStart === cursor) {
      return newText || null
    }

    let data = ''

    if (cursor >= rangeEnd) {
      // Cursor is at or after the replacement range.
      // Save the text between rangeEnd and cursor (the suffix we'll erase
      // with backspace and need to re-type).
      const suffix = oldText.substring(rangeEnd, cursor)
      // Backspace from cursor all the way to rangeStart: erases suffix + range.
      const totalBackspace = cursor - rangeStart
      data += '\x7f'.repeat(totalBackspace)
      // Insert new text, then re-type the suffix.
      data += newText + suffix

    } else if (cursor > rangeStart) {
      // Cursor is inside the replacement range.
      // Backspace from cursor to rangeStart.
      data += '\x7f'.repeat(cursor - rangeStart)
      // Forward-delete from (now at rangeStart) to rangeEnd.
      const remaining = rangeEnd - cursor
      data += '\x1b[3~'.repeat(remaining)
      // Insert new text.
      data += newText

    } else {
      // Cursor is before the replacement range. Move forward to rangeStart.
      const forward = rangeStart - cursor
      data += '\x1b[C'.repeat(forward)
      // Forward-delete the range.
      const rangeLen = rangeEnd - rangeStart
      data += '\x1b[3~'.repeat(rangeLen)
      // Insert new text.
      data += newText
    }

    return data || null
  }

  private _syncContextState(ec: IEditContext): void {
    this._contextText = ec.text
    this._contextSelStart = ec.selectionStart
    this._contextSelEnd = ec.selectionEnd
  }

  // ── characterboundsupdate ───────────────────────────────────────────

  private _wireCharacterBounds(ec: IEditContext, terminal: Terminal): void {
    const handler = (ev: Event) => {
      const e = ev as CharacterBoundsUpdateEvent
      const dims = terminal.dimensions
      if (!dims) return

      const container = terminal.element
      if (!container) return

      const rect = container.getBoundingClientRect()
      const cellW = dims.css.cell.width
      const cellH = dims.css.cell.height

      // The terminal cursor position tells us where the input starts
      // in the grid. We compute bounds for each character in the
      // requested range.
      const buf = terminal.buffer.active
      const cursorCol = buf.cursorX
      const cursorRow = buf.cursorY

      // Character offset relative to the start of the input text.
      // Map each character to a cell position.
      const bounds: DOMRect[] = []
      for (let i = e.rangeStart; i < e.rangeEnd; i++) {
        // Approximate: assume characters flow left-to-right from cursor.
        const charOffset = i - this._contextSelStart + cursorCol
        const col = charOffset % terminal.cols
        const row = cursorRow + Math.floor(charOffset / terminal.cols)

        bounds.push(new DOMRect(
          rect.left + col * cellW,
          rect.top + row * cellH,
          cellW,
          cellH,
        ))
      }

      ec.updateCharacterBounds(e.rangeStart, bounds)
    }

    ec.addEventListener('characterboundsupdate', handler)
    this._disposables.push(() => ec.removeEventListener('characterboundsupdate', handler))
  }

  // ── Keyboard forwarding ─────────────────────────────────────────────
  //
  // Keyboard events fire on our overlay element. We need to forward them
  // to xterm.js' keyboard evaluation. We do this by:
  //
  //   1. Re-dispatching a clone of the KeyboardEvent on xterm's textarea.
  //      xterm.js does not check isTrusted, so this works.
  //   2. If xterm's custom key handler or internal handler calls
  //      preventDefault(), we call it on the original event too.
  //
  // Text characters that produce textupdate events are de-duplicated:
  // if the keydown produces a printable character AND textupdate fires,
  // we let textupdate win (it has richer replacement range info).

  private _wireKeyboard(overlay: HTMLElement, terminal: Terminal): void {
    const textarea = terminal.textarea
    if (!textarea) return

    const handleKeyDown = (ev: KeyboardEvent) => {
      // Let textupdate handle printable characters without modifiers.
      // Keys like Enter, Tab, Escape, arrows, and modifier combos are
      // forwarded to xterm.
      if (this._isTextInputKey(ev)) {
        // Mark that we expect a textupdate for this keystroke.
        // Don't forward to xterm; textupdate will handle it.
        return
      }

      // Clone and dispatch on xterm's textarea.
      const clone = new KeyboardEvent(ev.type, ev)
      const dispatched = textarea.dispatchEvent(clone)

      // If xterm's handler called preventDefault on the clone, mirror it.
      if (!dispatched) {
        ev.preventDefault()
      }

      // If xterm handled this keydown (would send data), mark it so we
      // skip the textupdate if one fires for the same keystroke.
      this._keyDownHandled = true
    }

    const handleKeyUp = (ev: KeyboardEvent) => {
      const clone = new KeyboardEvent(ev.type, ev)
      textarea.dispatchEvent(clone)
      this._keyDownHandled = false
    }

    overlay.addEventListener('keydown', handleKeyDown, { capture: true })
    overlay.addEventListener('keyup', handleKeyUp, { capture: true })
    this._disposables.push(() => {
      overlay.removeEventListener('keydown', handleKeyDown, { capture: true })
      overlay.removeEventListener('keyup', handleKeyUp, { capture: true })
    })
  }

  /**
   * Returns true if this keyboard event will produce a text character that
   * should be handled via textupdate rather than forwarded to xterm's
   * keyboard handler.
   *
   * We forward: Enter, Tab, Escape, Backspace, Delete, arrow keys, function
   * keys, and any key with Ctrl/Alt/Meta (modifier combos).
   *
   * We let textupdate handle: regular character keys with no modifiers
   * (or only Shift).
   */
  private _isTextInputKey(ev: KeyboardEvent): boolean {
    // Modifier combos: always forward.
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return false

    // Dead keys (compose sequences): let textupdate handle the result.
    if (ev.key === 'Dead') return true

    // IME composition: mobile keyboards send key='Process' (or keyCode 229).
    // Let textupdate handle the composed result.
    if (ev.key === 'Process' || ev.keyCode === 229) return true

    // Non-printable keys (multi-char key names like 'Enter', 'ArrowLeft'):
    // always forward to xterm's keyboard handler.
    if (ev.key.length !== 1) return false

    // Single printable character with no Ctrl/Alt/Meta: textupdate handles it.
    return true
  }

  // ── Focus management ────────────────────────────────────────────────
  //
  // xterm.js focuses its hidden textarea when the terminal is clicked.
  // We need to redirect that focus to our overlay element so the OS text
  // input service connects to our EditContext.
  //
  // Strategy:
  //   - Listen for focus on xterm's textarea; when it fires, refocus overlay.
  //   - Listen for clicks/taps on the terminal container; focus overlay.
  //   - On mobile (touch device), position the overlay so the OS opens the
  //     keyboard without scrolling the page (same trick as gmux's
  //     focusTerminalInput).

  private _wireFocus(
    overlay: HTMLElement,
    terminal: Terminal,
    container: HTMLElement,
  ): void {
    let redirecting = false

    const textarea = terminal.textarea
    if (!textarea) return

    // When xterm focuses its textarea, steal focus to our overlay.
    const onTextareaFocus = () => {
      if (redirecting) return
      redirecting = true
      this._focusOverlay(overlay)
      redirecting = false
    }

    // When the terminal container is clicked/tapped, focus overlay.
    const onContainerClick = (ev: MouseEvent) => {
      // Don't steal focus from interactive children (buttons, etc.)
      if (ev.target instanceof HTMLElement &&
          ev.target.closest('button, input, textarea, select, a, label, [role="button"]')) {
        return
      }
      this._focusOverlay(overlay)
    }

    textarea.addEventListener('focus', onTextareaFocus)
    container.addEventListener('click', onContainerClick)

    this._disposables.push(() => {
      textarea.removeEventListener('focus', onTextareaFocus)
      container.removeEventListener('click', onContainerClick)
    })
  }

  /**
   * Focus the overlay element. On touch devices, temporarily position it
   * at the bottom of the viewport to prevent iOS from scrolling the page
   * when the virtual keyboard opens.
   */
  private _focusOverlay(overlay: HTMLElement): void {
    const isTouchDevice = window.matchMedia('(pointer: coarse)').matches
      || navigator.maxTouchPoints > 0

    if (!isTouchDevice) {
      overlay.focus({ preventScroll: true })
      return
    }

    // iOS keyboard open trick: position element at viewport bottom.
    const prev = {
      position: overlay.style.position,
      left: overlay.style.left,
      bottom: overlay.style.bottom,
      top: overlay.style.top,
      width: overlay.style.width,
      height: overlay.style.height,
      opacity: overlay.style.opacity,
      zIndex: overlay.style.zIndex,
      pointerEvents: overlay.style.pointerEvents,
    }

    overlay.style.position = 'fixed'
    overlay.style.left = '0'
    overlay.style.bottom = '0'
    overlay.style.top = 'auto'
    overlay.style.width = '1px'
    overlay.style.height = '1px'
    overlay.style.opacity = '0.01'
    overlay.style.zIndex = '-1'
    overlay.style.pointerEvents = 'auto'
    overlay.focus({ preventScroll: true })

    requestAnimationFrame(() => {
      overlay.style.position = prev.position
      overlay.style.left = prev.left
      overlay.style.bottom = prev.bottom
      overlay.style.top = prev.top
      overlay.style.width = prev.width
      overlay.style.height = prev.height
      overlay.style.opacity = prev.opacity
      overlay.style.zIndex = prev.zIndex
      overlay.style.pointerEvents = prev.pointerEvents
    })
  }
}
