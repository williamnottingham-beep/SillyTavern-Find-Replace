# Chat Find & Replace Plus 1.2.0

A polished build of [SillyTavern-Find-Replace](https://github.com/williamnottingham-beep/SillyTavern-Find-Replace), with a compact panel, rendered-text match highlights, and fixes for the composer launcher disappearing after UI rebuilds.

## What changed in 1.2.0

- **Restored/recoverable launcher:** keeps a reference to the launcher even when SillyTavern rebuilds `#leftSendForm`, then reattaches it to the new composer. The observer watches `document.body`, not an element that may itself be replaced.
- **Integrated extension, not a companion:** all controls, replacement logic, and highlighting ship in this one `chat-find-replace` folder. It does not depend on a second extension to display the button.
- **Find-term highlighting:** while the panel is open, matching visible text is highlighted using the CSS Custom Highlight API. A `<mark>` fallback is provided for browsers that do not support the API. Match styling is removed when the panel closes.
- **Compact panel:** 320px maximum width, 56% viewport height on desktop and 50% on mobile, with tighter spacing and smaller controls.
- **More robust startup:** if the SillyTavern context is not ready when the script first runs, initialization retries briefly instead of silently exiting.
- **Safer bulk replacement:** validates the core update/save APIs before changing content, snapshots affected message text/swipes, and attempts to restore original values if a render, event, or save operation fails.
- **Keyboard shortcut fix:** `Ctrl+Shift+F` / `Cmd+Shift+F` no longer hijacks keystrokes while typing in regular text fields, contenteditable controls, or the Find & Replace panel.
- **Preserves upstream features:** literal search, JavaScript Regex, flags, role filters, live previews, next-match navigation, saved rules, and alternate-swipe replacement remain included.

## Install/update

**Use this as a replacement for the original extension, not alongside it.**

1. Disable and remove the separate `chat-find-replace-polish` companion extension if you installed the earlier experimental build. This version includes the highlighting feature itself.
2. Back up or rename your current `SillyTavern/data/<your-user>/extensions/chat-find-replace/` folder.
3. Extract this ZIP and replace that folder with the included `chat-find-replace/` folder. Keep only one enabled copy of Chat Find & Replace to avoid duplicate launchers and event handlers.
4. Refresh SillyTavern and enable **Chat Find & Replace Plus** in the Extensions panel.

For an all-users installation, the same folder can be placed under `SillyTavern/public/scripts/extensions/third-party/chat-find-replace/` if that directory is supported by your setup.

## Usage

1. Click the magnifying-glass button next to the composer controls, or press `Ctrl+Shift+F` / `Cmd+Shift+F` when focus is not inside a text field.
2. Enter a search term. Visible matching text highlights in the rendered chat while the panel remains open.
3. Literal search is the default. Enable Regex mode to use JavaScript regex syntax, such as `\b(cat|dog)\b`, with flags like `gi`.
4. Choose User, AI, and optionally System/note messages.
5. Review the preview and select **Replace in chat**. The extension asks for confirmation before applying changes.
6. Use **More options & saved rules** for case sensitivity, notes/system messages, alternate swipes, and saved presets.

## Known highlighting limits

- Highlighting applies to text visible in rendered message content. It does not highlight raw Markdown markers that are not displayed.
- A match that spans separate HTML text nodes, such as a Regex match crossing bold and non-bold formatting, may not appear as one uninterrupted highlight.
- Non-text metadata, attachments, and reasoning/thinking blocks are not part of the replacement or highlight target.
- If you switch to a different theme/browser, the amber highlight may look slightly different.

## Validation

This package was checked for JavaScript syntax, manifest JSON validity, and ZIP integrity. The repository's UI still needs a live SillyTavern test to verify behavior with the exact current core build and theme.

## License

MIT. See `LICENSE`.
