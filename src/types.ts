/**
 * Minimal subset of the EditContext API that we depend on.
 *
 * On Chrome/Edge 133+, the native EditContext matches this.
 * On Safari/Firefox, the polyfill provides it.
 */
export interface IEditContext extends EventTarget {
  readonly text: string
  readonly selectionStart: number
  readonly selectionEnd: number

  updateText(rangeStart: number, rangeEnd: number, text: string): void
  updateSelection(start: number, end: number): void
  updateControlBounds(controlBounds: DOMRect): void
  updateSelectionBounds(selectionBounds: DOMRect): void
  updateCharacterBounds(rangeStart: number, characterBounds: DOMRect[]): void
}

/**
 * The textupdate event fired by EditContext when the user modifies text
 * through the OS input method (virtual keyboard, dictation, IME, etc.).
 */
export interface TextUpdateEvent extends Event {
  readonly text: string
  readonly updateRangeStart: number
  readonly updateRangeEnd: number
  readonly selectionStart: number
  readonly selectionEnd: number
}

/**
 * The characterboundsupdate event fired when the OS needs character
 * position information (for IME popup placement).
 */
export interface CharacterBoundsUpdateEvent extends Event {
  readonly rangeStart: number
  readonly rangeEnd: number
}

export interface EditContextAddonOptions {
  /**
   * Whether to load the polyfill for browsers without native EditContext
   * (Safari, Firefox). Defaults to true.
   */
  polyfill?: boolean

  /**
   * The element to attach the EditContext to. If not provided, the addon
   * creates a transparent overlay inside the terminal container.
   */
  inputElement?: HTMLElement
}
