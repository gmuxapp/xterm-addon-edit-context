import { describe, it, expect } from 'vitest'
import { EditContextAddon } from '../src/EditContextAddon'

// ── _computeInput tests ──────────────────────────────────────────────────
//
// _computeInput is private, so we test it by poking internal state on a
// bare addon instance (not activated). This is acceptable for unit tests
// of an internal algorithm.

describe('_computeInput', () => {
  function computeInput(
    contextText: string,
    contextSelStart: number,
    rangeStart: number,
    rangeEnd: number,
    newText: string,
  ): string | null {
    const addon = new EditContextAddon()
    ;(addon as any)._contextText = contextText
    ;(addon as any)._contextSelStart = contextSelStart
    ;(addon as any)._contextSelEnd = contextSelStart
    return (addon as any)._computeInput(contextText, rangeStart, rangeEnd, newText)
  }

  // ── Append (cursor at insertion point, empty range) ──

  it('appends a single character (normal typing)', () => {
    const result = computeInput('hel', 3, 3, 3, 'l')
    expect(result).toBe('l')
  })

  it('appends multiple characters (swipe typing)', () => {
    const result = computeInput('hello ', 6, 6, 6, 'world')
    expect(result).toBe('world')
  })

  it('appends from empty context (first dictation)', () => {
    const result = computeInput('', 0, 0, 0, 'hello world')
    expect(result).toBe('hello world')
  })

  it('returns null for empty append (no-op)', () => {
    expect(computeInput('hello', 5, 5, 5, '')).toBeNull()
  })

  // ── Replacement: cursor at or after rangeEnd ──

  it('replaces entire word at cursor (autocorrect "helo" → "hello")', () => {
    // "helo|" → cursor=4, range=[0,4), new="hello"
    // 4 backspaces erase "helo", then type "hello"
    const result = computeInput('helo', 4, 0, 4, 'hello')
    expect(result).toBe('\x7f'.repeat(4) + 'hello')
  })

  it('replaces mid-line word, re-types suffix (autocorrect "teh" → "the")', () => {
    // "the teh quick|" → cursor=13, range=[4,7), new="the"
    // suffix = " quick" (chars 7..13)
    // 9 backspaces erase " quick" + "teh", then type "the quick"
    const result = computeInput('the teh quick', 13, 4, 7, 'the')
    expect(result).toBe('\x7f'.repeat(9) + 'the quick')
  })

  it('replaces with shorter text (5 chars → 2 chars)', () => {
    // "hello|" → cursor=5, range=[0,5), new="hi"
    const result = computeInput('hello', 5, 0, 5, 'hi')
    expect(result).toBe('\x7f'.repeat(5) + 'hi')
  })

  it('deletes without inserting (replacement with empty string)', () => {
    // "hello world|" → cursor=11, range=[5,11), new=""
    // Deletes " world": 6 backspaces
    const result = computeInput('hello world', 11, 5, 11, '')
    expect(result).toBe('\x7f'.repeat(6))
  })

  // ── Replacement: cursor inside range ──

  it('replaces when cursor is inside the range', () => {
    // "abcdefgh" with cursor at 6, range=[3,8), new="XY"
    // 3 backspaces (cursor 6 → 3), 2 forward-deletes (chars 6,7), type "XY"
    const result = computeInput('abcdefgh', 6, 3, 8, 'XY')
    expect(result).toBe('\x7f'.repeat(3) + '\x1b[3~'.repeat(2) + 'XY')
  })

  // ── Replacement: cursor before range ──

  it('replaces when cursor is before the range', () => {
    // "|abcdef" with cursor at 0, range=[2,4), new="XY"
    // 2 forward-moves, 2 forward-deletes, type "XY"
    const result = computeInput('abcdef', 0, 2, 4, 'XY')
    expect(result).toBe('\x1b[C'.repeat(2) + '\x1b[3~'.repeat(2) + 'XY')
  })

  // ── Edge: cursor exactly at rangeEnd (common for dictation) ──

  it('handles cursor exactly at rangeEnd with no suffix', () => {
    // "test|" → cursor=4, range=[0,4), new="testing"
    const result = computeInput('test', 4, 0, 4, 'testing')
    expect(result).toBe('\x7f'.repeat(4) + 'testing')
  })

  // ── Edge: cursor exactly at rangeStart ──

  it('handles cursor exactly at rangeStart', () => {
    // "|test rest" → cursor=0, range=[0,4), new="best"
    // cursor === rangeStart, which is < rangeEnd → forward-delete path
    // 0 forward-moves, 4 forward-deletes, type "best"
    const result = computeInput('test rest', 0, 0, 4, 'best')
    expect(result).toBe('\x1b[3~'.repeat(4) + 'best')
  })
})

// ── _isTextInputKey tests ────────────────────────────────────────────────

describe('_isTextInputKey', () => {
  function isTextInputKey(props: Partial<KeyboardEventInit> & { key: string }): boolean {
    const addon = new EditContextAddon()
    return (addon as any)._isTextInputKey(new KeyboardEvent('keydown', props))
  }

  // Keys that textupdate should handle (returns true)

  it('returns true for printable characters', () => {
    expect(isTextInputKey({ key: 'a' })).toBe(true)
    expect(isTextInputKey({ key: 'Z' })).toBe(true)
    expect(isTextInputKey({ key: '1' })).toBe(true)
    expect(isTextInputKey({ key: ' ' })).toBe(true)
    expect(isTextInputKey({ key: '.' })).toBe(true)
    expect(isTextInputKey({ key: '/' })).toBe(true)
  })

  it('returns true for Shift+letter (uppercase, still printable)', () => {
    expect(isTextInputKey({ key: 'A', shiftKey: true })).toBe(true)
  })

  it('returns true for dead keys (compose sequences)', () => {
    expect(isTextInputKey({ key: 'Dead' })).toBe(true)
  })

  it('returns true for IME composition (key=Process)', () => {
    expect(isTextInputKey({ key: 'Process', keyCode: 229 })).toBe(true)
  })

  // Keys that should be forwarded to xterm (returns false)

  it('returns false for Ctrl+letter', () => {
    expect(isTextInputKey({ key: 'c', ctrlKey: true })).toBe(false)
  })

  it('returns false for Alt+letter', () => {
    expect(isTextInputKey({ key: 'x', altKey: true })).toBe(false)
  })

  it('returns false for Meta+letter', () => {
    expect(isTextInputKey({ key: 'v', metaKey: true })).toBe(false)
  })

  it('returns false for Enter, Tab, Escape, Backspace', () => {
    expect(isTextInputKey({ key: 'Enter' })).toBe(false)
    expect(isTextInputKey({ key: 'Tab' })).toBe(false)
    expect(isTextInputKey({ key: 'Escape' })).toBe(false)
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

  it('returns false for Delete and Home/End/PageUp/PageDown', () => {
    expect(isTextInputKey({ key: 'Delete' })).toBe(false)
    expect(isTextInputKey({ key: 'Home' })).toBe(false)
    expect(isTextInputKey({ key: 'End' })).toBe(false)
    expect(isTextInputKey({ key: 'PageUp' })).toBe(false)
    expect(isTextInputKey({ key: 'PageDown' })).toBe(false)
  })
})
