# Notion Hack — Chrome Extension

Basic React 18 + Tailwind v4 + TypeScript Chrome (Manifest V3) extension scaffold,
built with Vite and `@crxjs/vite-plugin`.

## Structure

```
extension/
├── manifest.config.ts        # MV3 manifest (typed)
├── vite.config.ts
├── tsconfig.json
└── src/
    ├── popup/                # React popup (action.default_popup)
    │   ├── index.html
    │   ├── main.tsx
    │   ├── Popup.tsx
    │   └── index.css         # Tailwind entry (@import "tailwindcss")
    ├── background/index.ts   # MV3 service worker
    └── content/index.ts      # Content script (<all_urls>)
```

## Develop

```bash
cd extension
bun install
bun run dev
```

Then in Chrome:

1. Open `chrome://extensions`
2. Toggle **Developer mode**
3. Click **Load unpacked** and select `extension/dist/`
4. The extension reloads automatically on source changes (HMR for the popup).

## Build

```bash
bun run build
```

Outputs a production-ready unpacked extension to `extension/dist/`. Load that
folder via **Load unpacked** to install, or zip it for the Chrome Web Store.

## Notes

- Tailwind v4 is configured via `@tailwindcss/vite`; no `tailwind.config.js` or
  `postcss.config.js` is needed. Add custom theme tokens with `@theme` inside
  `src/popup/index.css` if desired.
- Permissions are minimal (`storage`, `activeTab`). Edit `manifest.config.ts`
  to add more.
- Icons are not included — Chrome will use a default placeholder. Add PNGs and
  reference them via `icons` / `action.default_icon` in `manifest.config.ts`.
