/**
 * EditContext addon for xterm.js.
 *
 * Replaces xterm.js' hidden-textarea input path with the EditContext API.
 * On browsers with native support (Chrome/Edge 121+), uses the native API.
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
import type { Terminal, ITerminalAddon } from '@xterm/xterm';
import type { EditContextAddonOptions } from './types';
export declare class EditContextAddon implements ITerminalAddon {
    private _editContext;
    private _overlay;
    private _disposables;
    private _contextText;
    private _contextSelStart;
    private _contextSelEnd;
    private _keyDownHandled;
    private readonly _options;
    constructor(options?: EditContextAddonOptions);
    activate(terminal: Terminal): void;
    dispose(): void;
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
    updateText(text: string, selectionStart: number, selectionEnd?: number): void;
    /**
     * Update the EditContext's bounds information so the OS can position
     * IME popups and virtual keyboard suggestions correctly.
     *
     * Call this after the terminal resizes or the cursor moves.
     */
    updateBounds(controlBounds: DOMRect, selectionBounds: DOMRect): void;
    private _setup;
    private _createEditContext;
    private _wireTextUpdate;
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
    private _computeInput;
    private _syncContextState;
    private _wireCharacterBounds;
    private _wireKeyboard;
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
    private _isTextInputKey;
    private _wireFocus;
    /**
     * Focus the overlay element. On touch devices, temporarily position it
     * at the bottom of the viewport to prevent iOS from scrolling the page
     * when the virtual keyboard opens.
     */
    private _focusOverlay;
}
//# sourceMappingURL=EditContextAddon.d.ts.map