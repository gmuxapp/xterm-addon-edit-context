import { describe, it, expect } from 'vitest'
import { EditContextAddon } from '../src/EditContextAddon'

// ── Fakes ──────────────────────────────────────────────────────────────────

/** Minimal fake EditContext that records calls and fires events. */
// @ts-expect-error Reserved for future integration tests.
// noinspection JSUnusedLocalSymbols
function _createFakeEditContext() {
  let text = ''
  let selectionStart = 0
  let selectionEnd = 0
  const listeners = new Map<string, Set<EventListener>>()

  return {
    get text() { return text },
    get selectionStart() { return selectionStart },
    get selectionEnd() { return selectionEnd },

    updateText(start: number, end: number, newText: string) {
      text = text.substring(0, start) + newText + text.substring(end)
    },
    updateSelection(start: number, end: number) {
      selectionStart = start
      selectionEnd = end
    },
    updateControlBounds(_b: DOMRect) {},
    updateSelectionBounds(_b: DOMRect) {},
    updateCharacterBounds(_start: number, _bounds: DOMRect[]) {},

    addEventListener(type: string, fn: EventListener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener(type: string, fn: EventListener) {
      listeners.get(type)?.delete(fn)
    },
    dispatchEvent(ev: Event) {
      for (const fn of listeners.get(ev.type) ?? []) fn(ev)
      return true
    },

    // Test helper: simulate a textupdate event.
    fireTextUpdate(props: {
      text: string
      updateRangeStart: number
      updateRangeEnd: number
      selectionStart: number
      selectionEnd: number
    }) {
      // Apply the update to our internal state (as the browser would).
      text = text.substring(0, props.updateRangeStart) + props.text + text.substring(props.updateRangeEnd)
      selectionStart = props.selectionStart
      selectionEnd = props.selectionEnd

      const event = { type: 'textupdate', ...props } as unknown as Event
      this.dispatchEvent(event)
    },

    // Test helper: set state without firing events.
    _setState(t: string, ss: number, se: number) {
      text = t
      selectionStart = ss
      selectionEnd = se
    },
  }
}

// ── _computeInput tests ──────────────────────────────────────────────────
//
// _computeInput is private, so we test it indirectly through the textupdate
// handler by constructing the addon with a fake EditContext and checking
// what gets sent to terminal.input().

describe('EditContextAddon text translation', () => {
  // We test the core diff logic by directly calling the private method.
  // This is acceptable for unit tests of an internal algorithm.
  function computeInput(
    contextText: string,
    contextSelStart: number,
    rangeStart: number,
    rangeEnd: number,
    newText: string,
  ): string | null {
    const addon = new EditContextAddon()
    // Poke internal state to simulate known context.
    ;(addon as any)._contextText = contextText
    ;(addon as any)._contextSelStart = contextSelStart
    ;(addon as any)._contextSelEnd = contextSelStart
    return (addon as any)._computeInput(contextText, rangeStart, rangeEnd, newText)
  }

  it('handles pure append at cursor (normal typing)', () => {
    // Context: "hel|" (cursor at 3). User types "l".
    const result = computeInput('hel', 3, 3, 3, 'l')
    expect(result).toBe('l')
  })

  it('handles append of multiple characters (swipe typing)', () => {
    // Context: "hello |" (cursor at 6). Swipe types "world".
    const result = computeInput('hello ', 6, 6, 6, 'world')
    expect(result).toBe('world')
  })

  it('handles word replacement at cursor (autocorrect)', () => {
    // Context: "helo|" (cursor at 4, which equals rangeEnd).
    // Autocorrect replaces "helo" (0-4) with "hello".
    // cursor >= rangeEnd, so: backspace 4 times (erases "helo"), type "hello".
    // No suffix to re-type since cursor was at end.
    const result = computeInput('helo', 4, 0, 4, 'hello')
    expect(result).toBe('\x7f'.repeat(4) + 'hello')
  })

  it('handles replacement before cursor with suffix', () => {
    // Context: "the teh quick|" (cursor at 13).
    // Autocorrect replaces "teh" (4-7) with "the".
    // cursor (13) >= rangeEnd (7), so:
    //   suffix = oldText[7..13] = " quick"
    //   backspace 13-4 = 9 times (erases " quick" + "teh")
    //   type "the" + " quick" (re-type suffix)
    const result = computeInput('the teh quick', 13, 4, 7, 'the')
    expect(result).toBe('\x7f'.repeat(9) + 'the quick')
  })

  it('handles dictation appending new text', () => {
    // Context: "|" (empty, cursor at 0). Dictation inserts "hello world".
    const result = computeInput('', 0, 0, 0, 'hello world')
    expect(result).toBe('hello world')
  })

  it('returns null for no-op (empty append at cursor)', () => {
    const result = computeInput('hello', 5, 5, 5, '')
    expect(result).toBeNull()
  })

  it('handles cursor inside replacement range', () => {
    // Context: "abcdef|gh" (cursor at 6).
    // Replace range 3-9 (cdefgh) with "XY".
    // cursor (6) is inside [3, 9).
    //   backspace 6-3 = 3 times (erases "def")
    //   forward-delete 9-6 = 3 times (erases "fgh" -- wait, "fgh" is at 6-8)
    //   Actually after 3 backspaces, cursor is at 3, and chars 6-9 remain.
    //   forward-delete 3 times erases those.
    //   type "XY"
    const result = computeInput('abcdefgh', 6, 3, 9, 'XY')
    // range 3-9 but string is only 8 chars. Use 3-8.
    const result2 = computeInput('abcdefgh', 6, 3, 8, 'XY')
    expect(result).toBe('\x7f'.repeat(3) + '\x1b[3~'.repeat(3) + 'XY')
    expect(result2).toBe('\x7f'.repeat(3) + '\x1b[3~'.repeat(2) + 'XY')
  })

  it('handles cursor before replacement range', () => {
    // Context: "|abcdef" (cursor at 0).
    // Replace range 2-4 ("cd") with "XY".
    // cursor (0) < rangeStart (2).
    //   move forward 2 times
    //   forward-delete 2 times
    //   type "XY"
    const result = computeInput('abcdef', 0, 2, 4, 'XY')
    expect(result).toBe('\x1b[C'.repeat(2) + '\x1b[3~'.repeat(2) + 'XY')
  })
})

describe('EditContextAddon _isTextInputKey', () => {
  function isTextInputKey(props: Partial<KeyboardEventInit> & { key: string }): boolean {
    const addon = new EditContextAddon()
    const ev = new KeyboardEvent('keydown', props)
    return (addon as any)._isTextInputKey(ev)
  }

  it('returns true for regular printable characters', () => {
    expect(isTextInputKey({ key: 'a' })).toBe(true)
    expect(isTextInputKey({ key: '1' })).toBe(true)
    expect(isTextInputKey({ key: ' ' })).toBe(true)
    expect(isTextInputKey({ key: '.' })).toBe(true)
  })

  it('returns true for dead keys', () => {
    expect(isTextInputKey({ key: 'Dead' })).toBe(true)
  })

  it('returns true for IME composition (keyCode 229)', () => {
    expect(isTextInputKey({ key: 'Process', keyCode: 229 })).toBe(true)
  })

  it('returns false for Ctrl+letter', () => {
    expect(isTextInputKey({ key: 'c', ctrlKey: true })).toBe(false)
    expect(isTextInputKey({ key: 'a', ctrlKey: true })).toBe(false)
  })

  it('returns false for Alt+letter', () => {
    expect(isTextInputKey({ key: 'x', altKey: true })).toBe(false)
  })

  it('returns false for Meta+letter', () => {
    expect(isTextInputKey({ key: 'v', metaKey: true })).toBe(false)
  })

  it('returns false for Enter', () => {
    expect(isTextInputKey({ key: 'Enter' })).toBe(false)
  })

  it('returns false for Tab', () => {
    expect(isTextInputKey({ key: 'Tab' })).toBe(false)
  })

  it('returns false for Escape', () => {
    expect(isTextInputKey({ key: 'Escape' })).toBe(false)
  })

  it('returns false for Backspace', () => {
    expect(isTextInputKey({ key: 'Backspace' })).toBe(false)
  })

  it('returns false for arrow keys', () => {
    expect(isTextInputKey({ key: 'ArrowLeft' })).toBe(false)
    expect(isTextInputKey({ key: 'ArrowRight' })).toBe(false)
    expect(isTextInputKey({ key: 'ArrowUp' })).toBe(false)
    expect(isTextInputKey({ key: 'ArrowDown' })).toBe(false)
  })

  it('returns false for function keys', () => {
    expect(isTextInputKey({ key: 'F1' })).toBe(false)
    expect(isTextInputKey({ key: 'F12' })).toBe(false)
  })
})
