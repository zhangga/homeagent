# HomeAgent Product Icon Implementation Plan

> **Design spec:** `docs/superpowers/specs/2026-07-29-homeagent-product-icon-design.md`

**Goal:** Replace HomeAgent's generic and inconsistent brand marks with the
approved terracotta “roof + intelligent spark” system across macOS, the Web
admin/setup surfaces, and the downloadable Feishu avatar without changing
product identity, user data, or existing Feishu applications.

**Architecture:** Keep repository-owned SVG files as the geometry source,
commit responsive PNG derivatives, validate every asset without network access,
inline verified SVG in one shared Web component, inject a fixed local avatar
path into the Web app, and make macOS packaging fail when the `.icns` or avatar
resource is missing.

**Tech stack:** Bun, TypeScript, Hono server-rendered HTML, static SVG/PNG
assets, macOS `iconutil`, Bun test.

## Delivery Rules

- Work test-first within each task: add a focused failing test, observe the
  intended failure, implement the minimum behavior, then rerun the focused
  suite.
- Preserve all unrelated working-tree changes. The target files
  `packages/web/src/layout.ts`, `packages/web/src/setup-view.ts`,
  `packages/web/src/views.ts`, `packages/web/src/app.ts`, and
  `packages/app/src/main.ts` already contain other in-progress edits.
- Use the approved geometry and exact color values from the design spec. Do not
  reinterpret the icon while implementing it.
- Do not add an external font, CDN dependency, runtime image service, mascot,
  animation, or theme-specific brand color.
- Do not call an unverified Feishu avatar API and do not mutate existing Feishu
  applications.
- Keep the avatar download route fixed and local; never accept a path or file
  name from the request.
- Generated PNGs are committed release inputs. Runtime and CI verification must
  not require a graphics package or network access.
- Commit work in the task-sized boundaries below; never stage unrelated user
  changes.

## Task 1: Add Canonical SVG Assets and Static Validation

**Files:**

- Create: `assets/brand/homeagent-mark.svg`
- Create: `assets/brand/homeagent-glyph.svg`
- Create: `assets/brand/README.md`
- Create: `scripts/verify-brand-assets.ts`
- Create: `scripts/verify-brand-assets.test.ts`
- Modify: `package.json`

### Step 1: Write failing SVG contract tests

Cover:

1. Both SVG files exist and use the approved viewBox.
2. The full mark contains the roof, home outline, intelligent spark, large-size
   halo, and decorative spark groups with stable IDs.
3. The glyph contains only roof/home and intelligent-spark geometry.
4. Neither file contains `script`, `foreignObject`, `image`, external `href`,
   event-handler attributes, font declarations, or embedded data URLs.
5. Every literal color belongs to the approved palette:
   `#DA7B51`, `#C45F43`, `#A94733`, `#F4C965`, `#FFF3E5`, and `#342A25`.
6. The glyph uses `currentColor` or approved CSS variables where background
   adaptation is required.
7. Verification returns a nonzero exit code for unsafe or malformed fixture
   SVGs.

### Step 2: Run the focused test and verify RED

```powershell
bun test scripts/verify-brand-assets.test.ts
```

Expected: fail because the assets and verifier do not exist.

### Step 3: Create the approved SVG geometry

- Use rounded roof and wall strokes with the approved proportions.
- Keep the intelligent spark centered across all variants.
- Mark large-size-only halo and decorative spark groups explicitly so the
  shared component can remove them below 128px.
- Give the root SVG an accessible-compatible viewBox but no hard-coded display
  width or height.
- Do not include XML processing instructions so the SVG can be safely inlined
  into HTML.

### Step 4: Implement the offline verifier

Export pure helpers for:

- reading and validating SVG text;
- collecting literal colors;
- rejecting active/external content;
- validating required IDs and viewBox;
- returning structured failures for tests and a concise CLI message.

Add:

```json
"verify:brand": "bun run scripts/verify-brand-assets.ts"
```

to the root scripts.

### Step 5: Document the source contract

`assets/brand/README.md` must record:

- the concept and exact palette;
- approved clear space and center point;
- full, flat, compact, and monochrome breakpoints;
- canonical versus generated files;
- the Feishu circular safe area;
- the command used to validate assets.

### Step 6: Run focused verification

```powershell
bun test scripts/verify-brand-assets.test.ts
bun run verify:brand
bun run typecheck
```

### Step 7: Commit Task 1

```powershell
git add -- assets/brand/homeagent-mark.svg assets/brand/homeagent-glyph.svg assets/brand/README.md scripts/verify-brand-assets.ts scripts/verify-brand-assets.test.ts package.json
git commit -m "feat: add HomeAgent brand source assets"
```

## Task 2: Add Responsive PNG and macOS Iconset Assets

**Files:**

- Create: `assets/brand/homeagent-feishu-avatar-512.png`
- Create: `assets/macos/AppIcon.iconset/icon_16x16.png`
- Create: `assets/macos/AppIcon.iconset/icon_16x16@2x.png`
- Create: `assets/macos/AppIcon.iconset/icon_32x32.png`
- Create: `assets/macos/AppIcon.iconset/icon_32x32@2x.png`
- Create: `assets/macos/AppIcon.iconset/icon_128x128.png`
- Create: `assets/macos/AppIcon.iconset/icon_128x128@2x.png`
- Create: `assets/macos/AppIcon.iconset/icon_256x256.png`
- Create: `assets/macos/AppIcon.iconset/icon_256x256@2x.png`
- Create: `assets/macos/AppIcon.iconset/icon_512x512.png`
- Create: `assets/macos/AppIcon.iconset/icon_512x512@2x.png`
- Modify: `scripts/verify-brand-assets.ts`
- Modify: `scripts/verify-brand-assets.test.ts`

### Step 1: Add failing PNG contract tests

Parse PNG signatures and IHDR fields directly; do not add an image library to
production dependencies.

Cover:

1. The Feishu avatar is exactly 512×512 PNG.
2. Every iconset file exists and its pixel dimensions match its filename.
3. Required bit depth and color type are accepted.
4. Empty, mislabeled, truncated, or dimensionally incorrect fixture files fail.
5. The verifier lists all required files in deterministic order.

### Step 2: Run the focused test and verify RED

```powershell
bun test scripts/verify-brand-assets.test.ts
```

Expected: fail because the PNG derivatives are missing.

### Step 3: Render and commit responsive derivatives

Use the approved SVGs with a deterministic local renderer available in the
workspace to create the PNGs once; do not make the application depend on that
renderer.

- `16px` uses the monochrome roof + spark glyph.
- `32px` and `64px` use the compact flat mark without halo or decorative spark.
- `128px` through `512px` use the flat or complete mark according to the design
  breakpoint.
- `1024px` uses the complete gradient, halo, and decorative spark.
- The Feishu avatar uses a solid terracotta field and keeps all critical
  geometry inside the central circular safe area.

Inspect the generated files visually before committing them. Do not accept
interpolation artifacts, off-center stars, clipped round strokes, or a
notification-like decorative spark at compact sizes.

### Step 4: Extend the verifier

Add PNG dimension and required-file checks to `bun run verify:brand`. The script
must remain offline and read-only.

### Step 5: Run focused verification

```powershell
bun test scripts/verify-brand-assets.test.ts
bun run verify:brand
```

### Step 6: Commit Task 2

```powershell
git add -- assets/brand/homeagent-feishu-avatar-512.png assets/macos/AppIcon.iconset scripts/verify-brand-assets.ts scripts/verify-brand-assets.test.ts
git commit -m "feat: add responsive HomeAgent icon assets"
```

## Task 3: Create One Shared Web Brand Component

**Files:**

- Create: `packages/web/src/brand-mark.ts`
- Create: `packages/web/src/brand-mark.test.ts`
- Create: `packages/web/src/assets.d.ts`
- Modify: `packages/web/src/index.ts`

### Step 1: Write failing component tests

Cover:

1. `full` renders the full-color mark with the accessible name `HomeAgent`.
2. `dark` renders the glyph with cream roof and honey spark variables.
3. `mono` renders the single-color glyph.
4. Decorative usage sets `aria-hidden="true"` and omits a duplicate accessible
   name.
5. `size < 128` removes the halo and decorative spark.
6. `size < 24` renders the no-background monochrome glyph.
7. Output contains no external URL, font reference, emoji, script, or event
   handler.
8. Invalid variants or nonpositive sizes are rejected by the type/API boundary.

### Step 2: Run the focused test and verify RED

```powershell
bun test packages/web/src/brand-mark.test.ts
```

Expected: fail because the component does not exist.

### Step 3: Implement the component

- Import canonical SVG with Bun's text loader:

```ts
import fullMark from "../../../assets/brand/homeagent-mark.svg" with { type: "text" };
import glyph from "../../../assets/brand/homeagent-glyph.svg" with { type: "text" };
```

- Add only the TypeScript declaration needed for SVG text imports.
- Inline only these repository-owned, verified constants through Hono `raw()`.
- Put size and color adaptation inside the component; callers receive no raw
  path-level controls.
- Expose a small typed API for variant, size, accessible label, and decorative
  mode.
- Export the component through `packages/web/src/index.ts`.

### Step 4: Run focused tests

```powershell
bun test packages/web/src/brand-mark.test.ts
bun run typecheck
```

### Step 5: Commit Task 3

```powershell
git add -- packages/web/src/brand-mark.ts packages/web/src/brand-mark.test.ts packages/web/src/assets.d.ts packages/web/src/index.ts
git commit -m "feat: add shared HomeAgent brand component"
```

## Task 4: Replace the Admin and Setup Brand Marks

**Files:**

- Modify: `packages/web/src/layout.ts`
- Modify: `packages/web/src/setup-view.ts`
- Modify: `packages/web/src/setup-view.test.ts`
- Modify: `packages/web/src/app.test.ts`
- Modify: `packages/web/src/brand-mark.test.ts`

### Step 1: Add failing rendering tests

Cover:

1. The admin rail renders the `dark` brand component and lowercase wordmark.
2. The setup and restarting screens render the flat brand component and
   lowercase wordmark.
3. The brand areas no longer contain `🧠` or `⌁`.
4. Both surfaces use the same component contract, not copied SVG path data.
5. `HomeAgent` remains present in accessible text and document titles.
6. Existing navigation and setup behavior remain unchanged.

### Step 2: Run the focused tests and verify RED

```powershell
bun test packages/web/src/brand-mark.test.ts packages/web/src/setup-view.test.ts packages/web/src/app.test.ts
```

Expected: fail because the pages still use the old emoji and `⌁` symbols.

### Step 3: Replace only the brand regions

- Preserve existing navigation structure, links, setup steps, and form actions.
- Replace the admin rail brand markup and its local styling.
- Replace both setup brand occurrences, including the restarting screen.
- Keep the setup page's existing paper/moss styling; use terracotta only in the
  mark and approved brand accents.
- Keep the visible wordmark lowercase while titles and accessible labels use
  `HomeAgent`.

### Step 4: Run focused Web verification

```powershell
bun test packages/web/src/brand-mark.test.ts packages/web/src/setup-view.test.ts packages/web/src/app.test.ts
bun run typecheck
```

### Step 5: Commit Task 4

Stage only the brand-related hunks because the target files may contain
unrelated in-progress edits.

```powershell
git diff -- packages/web/src/layout.ts packages/web/src/setup-view.ts packages/web/src/setup-view.test.ts packages/web/src/app.test.ts
git add -p -- packages/web/src/layout.ts packages/web/src/setup-view.ts packages/web/src/setup-view.test.ts packages/web/src/app.test.ts
git add -- packages/web/src/brand-mark.test.ts
git commit -m "feat: unify HomeAgent web branding"
```

## Task 5: Provide the Fixed Local Feishu Avatar Download

**Files:**

- Modify: `packages/app/src/runtime-paths.ts`
- Modify: `packages/app/src/runtime-paths.test.ts`
- Modify: `packages/app/src/main.ts`
- Modify: `packages/web/src/dev.ts`
- Modify: `packages/web/src/app.ts`
- Modify: `packages/web/src/app.test.ts`
- Modify: `packages/web/src/views.ts`

### Step 1: Add failing runtime-path tests

Cover:

1. Source mode resolves `brandAssetDir` to `<repo>/assets/brand`.
2. Bundled mode resolves it to
   `<app>/Contents/Resources/brand`.
3. The avatar path is formed from the fixed filename, not environment or
   request input.

### Step 2: Add failing Web route and view tests

Cover:

1. `GET /brand/homeagent-feishu-avatar.png` returns `200`, `image/png`, a stable
   download filename, and exact fixture bytes when an injected file exists.
2. The route never reads a query-string or path-supplied filename.
3. A missing injected file returns an explicit non-200 local-asset error without
   leaking the absolute path.
4. Integrations shows a download link only when the asset is readable.
5. When unavailable, Integrations shows an explicit local asset message instead
   of a broken link.
6. Copy explains that upload is manual and never claims the current Feishu app
   was updated.

### Step 3: Run focused tests and verify RED

```powershell
bun test packages/app/src/runtime-paths.test.ts packages/web/src/app.test.ts
```

Expected: fail because runtime paths and the fixed download route are absent.

### Step 4: Implement path injection and the route

- Add `brandAssetDir` to `RuntimePaths`.
- Production passes the fixed avatar path to `createWebApp`.
- Development passes the repository asset path.
- Tests inject a temporary PNG fixture.
- Add an optional `brandAvatarPath` Web option so unrelated test constructors
  remain small; production and development entrypoints must always provide it.
- Read only that injected absolute path.
- Use `Content-Disposition: attachment` with the stable filename
  `HomeAgent-Feishu-Avatar.png`.
- Render availability and manual upload guidance in the Feishu Integrations
  section.

### Step 5: Run focused verification

```powershell
bun test packages/app/src/runtime-paths.test.ts packages/web/src/app.test.ts
bun run typecheck
```

### Step 6: Commit Task 5

Stage only task-related hunks in dirty target files.

```powershell
git add -p -- packages/app/src/main.ts packages/web/src/app.ts packages/web/src/app.test.ts packages/web/src/views.ts
git add -- packages/app/src/runtime-paths.ts packages/app/src/runtime-paths.test.ts packages/web/src/dev.ts
git commit -m "feat: expose HomeAgent Feishu avatar"
```

## Task 6: Wire the macOS App Icon and Bundle Resources

**Files:**

- Modify: `assets/macos/Info.plist.template`
- Modify: `scripts/build-macos-app.ts`
- Modify: `scripts/build-macos-app.test.ts`
- Modify: `scripts/smoke-macos-bundle.ts`
- Modify: `scripts/smoke-macos-bundle.test.ts`

### Step 1: Add failing build-plan tests

Cover:

1. The plan requires
   `HomeAgent.app/Contents/Resources/HomeAgent.icns`.
2. The plan requires
   `HomeAgent.app/Contents/Resources/brand/homeagent-feishu-avatar-512.png`.
3. The plist template names `HomeAgent` through `CFBundleIconFile`.
4. The bundle smoke checker rejects missing `.icns`.
5. The bundle smoke checker rejects missing avatar PNG.

### Step 2: Run the focused tests and verify RED

```powershell
bun test scripts/build-macos-app.test.ts scripts/smoke-macos-bundle.test.ts
```

Expected: fail because neither resource is part of the current bundle.

### Step 3: Add plist and build wiring

- Add `CFBundleIconFile` with value `HomeAgent`.
- Before signing, call:

```text
/usr/bin/iconutil -c icns assets/macos/AppIcon.iconset -o <Resources>/HomeAgent.icns
```

- Copy the Feishu avatar to `Contents/Resources/brand`.
- Validate source files before running `iconutil`.
- Add both files to `MacOSBuildPlan.outputs`.
- Keep the files inside the final App bundle before the existing bundle
  `codesign` step so the current signature covers them.
- Do not alter bundle ID, executable, URL scheme, versioning, signing identity,
  or DMG naming.

### Step 4: Extend smoke fixtures and checks

- Create both required resource files in the passing fixture.
- Assert removal of either file fails with a concise missing-resource message.
- Inspect plist content so a present but unreferenced `.icns` also fails.

### Step 5: Run focused packaging verification

```powershell
bun test scripts/build-macos-app.test.ts scripts/smoke-macos-bundle.test.ts
bun run build:macos -- --target arm64 --dry-run
bun run typecheck
```

On a macOS runner, additionally run:

```bash
bun run build:macos -- --target arm64 --allow-dirty
/usr/bin/plutil -p dist/HomeAgent.app/Contents/Info.plist
/usr/bin/codesign --verify --deep --strict --verbose=2 dist/HomeAgent.app
```

### Step 6: Commit Task 6

```powershell
git add -- assets/macos/Info.plist.template scripts/build-macos-app.ts scripts/build-macos-app.test.ts scripts/smoke-macos-bundle.ts scripts/smoke-macos-bundle.test.ts
git commit -m "feat: package HomeAgent macOS icon"
```

## Task 7: Complete Cross-Surface Verification and Release Notes

**Files:**

- Modify: `README.md`
- Modify: `docs/beta-release-runbook.md`
- Modify: `scripts/verify-beta-readiness.ts`
- Modify: `scripts/verify-beta-readiness.test.ts`

### Step 1: Add failing readiness assertions

Cover:

1. Canonical brand assets are required release inputs.
2. `bun run verify:brand` runs as part of local beta readiness.
3. When `--app` is supplied, the candidate bundle must contain and reference
   `HomeAgent.icns`.
4. When `--app` is supplied, the candidate bundle must contain the downloadable
   Feishu avatar.
5. Readiness output distinguishes automated asset verification from manual
   visual review.

### Step 2: Run the focused readiness tests and verify RED

```powershell
bun test scripts/verify-beta-readiness.test.ts
```

Expected: fail because brand verification is not yet a readiness gate.

### Step 3: Update release-facing documentation

Document:

- the new local avatar download and manual Feishu upload step;
- the macOS visual check in Finder, Dock, and the DMG;
- circular crop verification in Feishu;
- the explicit statement that existing Feishu apps are not automatically
  changed;
- the brand verification command for maintainers.

Preserve unrelated README and runbook edits already present in the worktree.

### Step 4: Run the complete automated verification

```powershell
bun run verify:brand
bun test scripts/verify-brand-assets.test.ts
bun test packages/web/src/brand-mark.test.ts packages/web/src/setup-view.test.ts packages/web/src/app.test.ts
bun test packages/app/src/runtime-paths.test.ts
bun test scripts/build-macos-app.test.ts scripts/smoke-macos-bundle.test.ts scripts/verify-beta-readiness.test.ts
bun run typecheck
bun test
```

### Step 5: Perform the approved visual matrix

Inspect:

- 16, 24, 32, 48, 128, 512, and 1024px;
- white, setup-paper, dark navigation, and terracotta backgrounds;
- macOS Finder and Dock;
- admin navigation and both setup/restarting screens;
- Feishu circular avatar crop.

Confirm:

- the roof and spark remain centered and recognizable;
- compact sizes contain no halo or decorative spark;
- the decorative spark at large size does not resemble a notification badge;
- grayscale still reads as roof + intelligent spark;
- no brand area uses `🧠` or `⌁`.

### Step 6: Commit Task 7

Stage only brand-related documentation hunks.

```powershell
git add -p -- README.md docs/beta-release-runbook.md
git add -- scripts/verify-beta-readiness.ts scripts/verify-beta-readiness.test.ts
git commit -m "docs: add HomeAgent brand release checks"
```

## Final Acceptance

Implementation is complete only when:

1. All HomeAgent-owned surfaces use the same approved roof + intelligent spark
   system.
2. macOS bundles contain and reference a valid `HomeAgent.icns`.
3. The Web UI no longer uses `🧠` or `⌁` in brand regions.
4. The Feishu avatar downloads locally, survives circular crop, and is described
   as a manual upload.
5. No existing app identity, user configuration, knowledge, task, credential,
   or Feishu binding is migrated or replaced.
6. Brand verification, targeted tests, typecheck, and the complete test suite
   pass.
