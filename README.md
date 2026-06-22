# StealthPOS Connector — Installer

A standalone Windows installer that onboards a new store to **[StealthPOS](https://stealthpos.net)**
in about five minutes. It is fully independent — it talks only to `stealthpos.net`
and ships the connector bundled inside it.

## What it does

A wizard walks the store through:

1. **Account** — log in, or sign up a brand-new StealthPOS client.
2. **POS type** — Gilbarco Passport, Verifone Commander, or other.
3. **Back office** — mirror an existing system (Modisoft, etc.) or read the POS directly.
4. **Folder** — auto-detects the Passport XML export folder (with a manual fallback).
5. **Install** — installs the **`StealthPOSConnector`** background Windows service, which
   watches the POS folder and uploads data to StealthPOS.

The service is registered with [nssm](https://nssm.cc) and runs the bundled
`edge.cjs` connector with the store's `BOS_*` environment configured.

## Develop

```bash
npm install
npm start          # opens the wizard locally (the whole UI works on macOS/Windows;
                   # only the final install step is Windows-only)
```

## Build the installer

```bash
npm run build                       # NSIS .exe → dist/
npx electron-builder --win --x64    # force x64 (store PCs) when building on Apple Silicon
```

Output: `dist/StealthPOS Connector Setup <version>.exe` (unsigned — Windows SmartScreen
will show a "More info → Run anyway" prompt until the build is code-signed).

## Layout

```
main.js                 Electron main process — IPC: detect/browse folder, login,
                        signup, install service, open dashboard
preload.js              contextBridge → window.stealth
renderer/               vanilla HTML/CSS/JS wizard (no framework)
resources/edge.cjs      the connector, bundled into the .exe (extraResources)
electron-builder.yml    NSIS packaging, requireAdministrator
```

## Updating the bundled connector

`resources/edge.cjs` is a vendored copy of the StealthPOS edge connector. Refresh it
when the connector changes, then rebuild.
