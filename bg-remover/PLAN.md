# Open BG Remover — Planning / Resume Document

Goal: an open-source, self-hostable, 100% in-browser replacement for remove.bg
(which is shutting down as a public resource in December 2026).

**If you are resuming work: read this file top to bottom, check the task
checklist, then continue with the first unchecked item.** Update this file
after every meaningful step and commit it.

## Constraints discovered
- Dev sandbox can only reach the npm registry (no CDNs / HuggingFace / GitHub
  downloads). All assets therefore come from npm packages and are vendored
  into `bg-remover/` so the site works offline / on any static host.
- Repo `timsteeno/final_finance` otherwise holds an unrelated Android app; the
  tool lives entirely in `bg-remover/`. Branch: `ccr-eb3d823d-jcu3zm`.

## Architecture
- Static site, no build step. Open `index.html` via any static server
  (`python3 -m http.server` in `bg-remover/`). ES modules + module Web Worker.
- Inference: onnxruntime-web 1.22.0 (MIT), `ort.webgpu.min.mjs` (WebGPU EP
  with WASM fallback) in `vendor/ort/`.
- `vendor/coi-serviceworker.js` (MIT) enables cross-origin isolation on plain
  static hosts so multi-threaded WASM works.
- Models (in `models/`):
  - `u2netp.onnx` (4.6 MB, Apache-2.0, U²-Netp) — "Fast". 320x320 input,
    ImageNet mean/std with max-normalization, output min-max normalized.
    Source: npm `@planby-tech/rmbg-webgpu@0.2.1`.
  - `isnet_quint8.onnx` (44 MB) — "Balanced" (default). ISNet (DIS), 1024x1024
    input, `(x-128)/256`, output already 0..1 in `output`.
  - `isnet_fp16.onnx.part*` (88 MB split into <50MB parts) — "Best".
    ISNet models from npm `@imgly/background-removal-data@1.4.5` (AGPL-3.0
    package; reassembled from its chunk files via resources.json).
- Pipeline: decode image -> resize to model input -> worker inference ->
  mask upscale (bilinear) -> optional edge refine + foreground color
  decontamination -> RGBA cutout.
- Editor: full-res mask kept as Uint8Array; erase/restore brushes edit it;
  undo/redo; backgrounds (transparent / color / image / blurred original);
  drop shadow; auto-crop to subject with padding; export PNG/JPG/WebP,
  original or preview size.
- Batch: queue of many images, sequential processing, ZIP download
  (own store-only zip writer, `js/zip.js`).

## Feature checklist (remove.bg parity)
- [x] Upload: file picker, drag & drop, paste (Ctrl+V), image URL, multiple files
- [x] Automatic background removal (3 model quality levels)
- [x] Progress / status UI, model download progress + caching (Cache API)
- [x] Result view on checkerboard, before/after compare slider
- [x] Download PNG full resolution
- [x] Download JPG / WebP, with chosen background
- [x] Background: transparent, color picker + presets, custom image, blur original
- [x] Erase / restore brush with size + hardness, undo/redo, zoom
- [x] Drop shadow effect
- [x] Auto crop to subject + padding; preset canvas sizes optional
- [x] Batch processing + "Download all (ZIP)"
- [x] Edge refinement (foreground color estimation / decontamination)
- [x] Mobile-friendly responsive layout, dark mode
- [x] Keyboard shortcuts
- [x] README with self-hosting instructions + licenses
- [x] Automated Playwright tests: tests/smoke.mjs, tests/e2e.mjs (56 checks; ONLY_FAST=1 skips Best), tests/quality/* (model/matting analysis tools)

## Iteration log
- 2026-10-28: Investigated sandbox network, picked models, verified ISNet
  quint8 in Python onnxruntime on skimage sample images (good cutouts).
- 2026-10-28: v1 implemented (all files under bg-remover/). Smoke test passes
  in headless Chromium: astronaut sample processed with Balanced model,
  wasm x3 threads, crossOriginIsolated=true.
- NEXT: spawn sub-agents to (a) write a full Playwright E2E suite and report
  bugs, (b) review cut-out quality / edge handling, (c) UX + mobile review.
  Fix findings, re-test, repeat.

## How to test
    cd bg-remover && python3 -m http.server 8765 &
    node tests/smoke.mjs http://localhost:8765/
Playwright is preinstalled globally in the dev container (require via
createRequire, see tests/smoke.mjs).
- 2026-10-28: UX sub-agent review done; applied fixes (mobile overflow, sticky
  download footer, cancel/timer, error actions, a11y roles, contrast, pinch
  anchor, restore ghost, crop edge margin). Committed.
  Pending: E2E agent report, quality agent report. Remaining UX ideas not yet
  done: mobile bottom tool tray for brushing, drag/scale photo backgrounds,
  aspect-ratio canvas presets, gradient backgrounds.
- 2026-10-28: Quality agent: models verified against Python reference (MAD
  <1.2/255 for ISNet). Fixed tile-seam bug in matting.js; added guided-filter
  upsampling + contrast curve (js/upscale.js) when "Clean edge colors" is on;
  blur radii now 45/3. E2E agent: 56-check suite; fixed removing the active
  item leaving the viewer on a closed bitmap. e2e passes 55/55 (ONLY_FAST).
- NEXT ideas: small-island removal for Fast model; mobile bottom tool tray;
  drag/scale photo backgrounds; aspect-ratio canvas presets; gradient bgs;
  brush size in image px option; second round of agent testing.
- 2026-10-28: Round-2 bug hunt (tests/e2e2.mjs, 9 checks). Fixed: removeIslands
  now uses hysteresis (keeps whiskers/thin structures), input alpha preserved
  (and processed over white), model label after mid-run switch, negative zoom
  label, viewBox-only SVG, semi-transparent blur edges, double download,
  worker auto-restart on crash, memory (inactive items release canvases),
  mobile toast placement. Default model = Best when WebGPU exists.
  Added: mobile floating brush tray, gradient backgrounds, aspect presets.
  e2e 56/56, e2e2 9/9.
- NEXT ideas: drag/scale photo backgrounds; brush size in image px option;
  PWA manifest for install/offline; i18n; round-3 agent testing on real-world
  photo categories (products, cars, hair, animals, graphics/logos).
