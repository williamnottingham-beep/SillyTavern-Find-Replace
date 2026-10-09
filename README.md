# Chat Find & Replace Polish

A small companion extension for [SillyTavern-Find-Replace](https://github.com/williamnottingham-beep/SillyTavern-Find-Replace).

## What it changes

- Highlights matching words in rendered chat messages while the Find & Replace panel is open.
- Uses the same literal/Regex mode, Regex flags, case-sensitivity setting, and selected message roles as the original extension.
- Uses the browser's CSS Custom Highlight API when available, which highlights text without changing message HTML. A marked-text fallback is included for older browsers.
- Shrinks the Find & Replace panel to around 320px wide and 56% of viewport height on desktop, with a smaller mobile layout.
- Leaves the original find/replace engine, saved rules, message updates, Regex processing, and replacement confirmations untouched.

## Install

1. Keep the original `chat-find-replace` extension installed and enabled.
2. Extract this ZIP.
3. Copy the `chat-find-replace-polish` folder into `SillyTavern/data/<your-user>/extensions/`.
4. Refresh SillyTavern and enable **Chat Find & Replace Polish** in the Extensions panel.
5. Open Find & Replace and enter a term. Matches in currently rendered message text should be highlighted as you type. Close the panel to clear highlighting.

## Notes

- This is a companion extension, not a replacement for the upstream project. It intentionally relies on the original extension's `#cfr-root` UI.
- Match highlighting works on rendered text nodes. A pattern that spans across separate HTML elements, or matches raw Markdown syntax that is not visibly rendered, may not produce a continuous visible highlight.
- This package was checked for JavaScript syntax and manifest/ZIP integrity. Test in your SillyTavern theme and browser before relying on it for large chat edits.
