# Blue Ghost Cursor

A tiny Chrome extension that injects a second, **blue** mouse cursor into every web page. The ghost cursor wanders around on its own using smooth value-noise — it never touches your real input, never clicks, never moves the OS pointer.

It also has a **push-to-talk hotkey**: press the configured combo (default **Shift+Q**) to start dictating with the browser's Web Speech API. The transcript appears in a chat-style bubble next to the ghost cursor. Press the hotkey again to stop.

## Install (unpacked)

1. Open `chrome://extensions` in Chrome (or any Chromium browser).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this folder.
4. Open any regular web page — a blue arrow will start drifting around. The toolbar popup has an **Enabled** toggle, **Speed** slider, and **Hotkey** rebinder.

## Using the voice bubble

- Default hotkey is **Shift+Q**. Press it on a page to begin listening; the bubble appears next to the ghost cursor with a pulsing dot.
- Speak — interim words appear in italics and finalize as recognition lands.
- Press the same hotkey again to stop early. The bubble lingers a couple of seconds so you can read it, then fades.
- Rebind the hotkey from the popup: click the hotkey button, then press any key combo. **Esc** cancels, the **↻** button resets to default.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest, content-script registration. |
| `content.js` | Injects the cursor, runs the noise-based animation loop, handles the hotkey, drives Web Speech API, paints the bubble. |
| `content.css` | Cursor + bubble styles inside a max-z-index overlay container. |
| `popup.html` / `popup.css` / `popup.js` | Toolbar popup UI with toggle, speed slider, and hotkey capture. |
| `background.js` | Service worker; sets default settings on install. |

## Notes & limits

- **Chrome internal pages** (`chrome://...`, the New Tab page, the Web Store) do not allow content scripts, so neither the cursor nor the hotkey will work there. Browser-level restriction.
- **Microphone permission** is per page origin. The first time you trigger the hotkey on a new site, Chrome will prompt for mic access; deny it and the bubble will say so. There is no way to grant this once for all sites from a content script.
- **Web Speech API** is Chromium-specific (`webkitSpeechRecognition`) and relies on Google's speech servers when online. Firefox does not implement it; the bubble will show a "not supported" message there.
- The cursor motion uses two octaves of 1D value-noise (one each for X and Y), mapped to the viewport with a small edge margin. Speed scales the noise's time axis. Animation pauses while the tab is hidden.
- No icons are bundled — Chrome falls back to the default puzzle-piece icon. Drop PNGs into an `icons/` folder and reference them in the manifest if you want custom artwork.
