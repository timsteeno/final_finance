# Open BG Remover

A free, open-source, **100% in-browser** background remover — a self-hostable
replacement for remove.bg. Images never leave your device; there are no
accounts, credits, watermarks or resolution limits (up to ~16 MP, the iOS
canvas limit).

## Features
- Upload by file picker, drag & drop, paste (Ctrl/⌘+V) or image URL; multiple files at once
- Three AI models: **Fast** (U²-Netp, 4.6 MB), **Balanced** (ISNet 8-bit, 44 MB), **Best** (ISNet fp16, 88 MB)
- WebGPU acceleration when available, multi-threaded WASM otherwise
- Edge colour decontamination for clean hair/soft edges on new backgrounds
- Before/after compare slider, zoom & pan (wheel, pinch, space-drag)
- Erase / Restore brushes with size + hardness, undo/redo
- Backgrounds: transparent, colour (presets + picker), your own photo, blurred original
- Drop shadow, crop-to-subject with margin
- Export PNG / JPG / WebP at full or reduced size; batch “ZIP all”
- Installable PWA that works fully offline after the first visit (app shell + models cached)
- Share-target / `?url=` link support to open an image directly

## Run it
It is a static site with no build step:

```sh
cd bg-remover
python3 -m http.server 8000
# open http://localhost:8000
```

Deploy by copying the `bg-remover/` folder to any static host (GitHub Pages,
Netlify, Cloudflare Pages, nginx…). `coi-serviceworker.js` enables
cross-origin isolation automatically so multi-threaded WASM works even on hosts
where you can't set COOP/COEP headers. If you can set headers, serve:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## Tests
```sh
python3 -m http.server 8765 &      # from bg-remover/
node tests/smoke.mjs http://localhost:8765/
ONLY_FAST=1 node tests/e2e.mjs http://localhost:8765/   # full functional suite
node tests/e2e2.mjs http://localhost:8765/              # regression checks
node tests/e2e3.mjs http://localhost:8765/              # review regressions
node tests/e2e4.mjs http://localhost:8765/              # memory / hibernation
node tests/offline.mjs http://localhost:8765/           # offline/PWA check
```

## Licenses
- App code: MIT (see `LICENSE`)
- onnxruntime-web: MIT (`licenses/onnxruntime-web-MIT.txt`)
- coi-serviceworker: MIT (`licenses/coi-serviceworker-MIT.txt`)
- U²-Netp model: Apache-2.0 (`licenses/Apache-2.0.txt`), via npm `@planby-tech/rmbg-webgpu`
- ISNet models: from npm `@imgly/background-removal-data` (AGPL-3.0,
  `licenses/imgly-background-removal-data-AGPL-3.0.md`); original ISNet/DIS
  weights by Xuebin Qin et al. (Apache-2.0). If you redistribute the ISNet
  model files, comply with the AGPL-3.0 (this project's source is public).
- Sample images: from scikit-image's bundled data (public domain / CC0).
