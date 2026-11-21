# WT Reticle Studio Pro: War Thunder `.blk` Custom Sight & Art Editor

**WT Reticle Studio Pro** is a zero-install, browser-based vector editor and auto-tracing studio for creating custom **War Thunder** tank sights (`.blk`), drawing custom artwork over existing sights (including modern dynamic HUD presets), and converting reference images or line art into War Thunder reticle geometry.

Built in compliance with the official [War Thunder CDK Custom Sight Specification](https://wiki.warthunder.com/cdk/creation_sight).

---

## Table of Contents

1. [Quick Start & Launching](#1-quick-start--launching)
2. [Project Files & the `sights/` Example Folder](#2-project-files--the-sights-example-folder)
3. [Top Bar, Canvas Viewport & Floating HUD](#3-top-bar-canvas-viewport--floating-hud)
4. [Left Toolbar: All 12 Tools & Quick Selection Actions](#4-left-toolbar-all-12-tools--quick-selection-actions)
5. [Right Inspector: Complete Panel-by-Panel Reference](#5-right-inspector-complete-panel-by-panel-reference)
   - [Panel 1: Drawing & Tool Options](#panel-1-drawing--tool-options)
   - [Panel 2: Circular Rangefinder (Radial)](#panel-2-circular-rangefinder-radial)
   - [Panel 3: Tank Sight Preset (HUD)](#panel-3-tank-sight-preset-hud)
   - [Panel 4: Ref Image & Pro Auto-Draw](#panel-4-ref-image--pro-auto-draw)
   - [Panel 5: Reticle Layers & Static Base](#panel-5-reticle-layers--static-base)
   - [Panel 6: Selection & CAD](#panel-6-selection--cad)
   - [Panel 7: Sight Global Settings (CDK)](#panel-7-sight-global-settings-cdk)
6. [Complete Keyboard & Mouse Shortcuts](#6-complete-keyboard--mouse-shortcuts)
7. [Step-by-Step Workflows](#7-step-by-step-workflows)
8. [How to Install Your `.blk` Sight in War Thunder](#8-how-to-install-your-blk-sight-in-war-thunder)
9. [Troubleshooting](#9-troubleshooting)
10. [License](#license)

---

## 1. Quick Start & Launching

The working web app can be found [here](https://joshua-cislini.github.io/WT-Sight-Editor/) hosted on my GitHub page.

Naturally you can also run it locally on your own hardware;
No Node.js, Python, compiler, or server installation is required.

### Option A: Windows Launcher with Automatic `sights/` Folder Sync (Recommended)
Double-click **`Start-ReticleStudio.bat`**.
- Runs `sync-sights.ps1 -OpenBrowser -Watch` in the background and opens `index.html` in your default browser.
- Every ~1 second, the PowerShell watcher checks the `sights/` folder (including subfolders). Whenever you add, edit, or delete a `.blk` file in `sights/`, it regenerates `presets.js` and the app automatically hot-reloads the `sights/` dropdown within ~2.5 seconds (and on window focus) without losing your current work.

### Option B: Direct Browser Launch (`index.html`)
Double-click **`index.html`** directly in Chrome, Edge, Brave, Firefox, or Opera.
- All bundled sights from `presets.js` and the built-in `Default Sight` are available immediately.
- If you want live disk folder access without running the batch file, click **`📁 Link sights/`** in the top bar (see below).

### Option C: Online / GitHub Pages Hosting
Because the editor runs 100% client-side in HTML5/CSS/JS, you can host the folder directly on **GitHub Pages** (an empty `.nojekyll` file is already included so static files are served directly).
- Reference images and `.blk` files stay strictly on the visitor's computer and are never uploaded anywhere.
- When accessed over `http://` or `https://`, `index.html` automatically appends a cache-busting query timestamp (`?v=<timestamp>`) to `styles.css`, `presets.js`, `blk-parser.js`, and `app.js` so visitors always receive the latest version on a normal refresh. (Note: update `presets.js` by running `sync-sights.ps1` before pushing if you add new files inside `sights/`).

---

## 2. Project Files & the `sights/` Example Folder

| File / Folder | Purpose |
| :--- | :--- |
| **`index.html`** | Studio layout (top bar, left toolbar, center canvas, right inspector panels, Raw `.blk` modal, Quick Guide modal) and automatic web cache-busting loader. |
| **`styles.css`** | Visual stylesheet and dark studio theme. |
| **`app.js`** | 60-FPS batched canvas renderer, all 12 drawing/CAD tools, Eraser, Sight Optimizer, Multi-Mode Image Auto-Tracer, undo/redo history, PNG exporter, and file linking. |
| **`blk-parser.js`** | War Thunder `.blk` parser, static sight/HUD geometry synthesizer, and dual-format serializer (classic custom sights and `tank_sight_presets` HUD files). |
| **`presets.js`** | Pre-bundled JavaScript catalog containing all `.blk` sights discovered in `sights/` plus the built-in `Default Sight`. |
| **`sights/`** | Live library folder containing example `.blk` sights (vector art sights and preset examples). Any `.blk` file placed here is automatically discovered. |
| **`sync-sights.ps1`** | PowerShell script that scans `sights/` recursively, bundles sights into `presets.js`, and watches for file changes when `-Watch` is passed. |
| **`Start-ReticleStudio.bat`** | One-click Windows launcher that opens the editor and starts the `sync-sights.ps1` watcher. |
| **`.nojekyll`** | Tells GitHub Pages to serve files as static assets without Jekyll processing. |
| **`README.md` / `LICENSE`** | Full documentation and MIT License file. |

### How the `sights/` Example Folder Works
- The `sights/` folder includes ready-to-use example `.blk` sights plus a built-in `Default Sight`.
- **Tank Sight HUD Presets (`tank_sight_presets/*.blk`)**: Modern War Thunder preset files define `crosshair:t="..."`, per-optic reticle colors (`Day`, `Illum`, `NVG`, `Thermal`), `reticle` overrides, `shotDistScaleOffset:i`, and 1920x1080 HUD widget blocks (`rangefinder`, `turret`, `fov`, `gunReady`, `bulletType`) without embedding raw vector shapes. Opening one switches automatically into **HUD Preset** mode so you can drag widgets directly on the canvas, preview any custom `.blk` sight referenced by `crosshair:t` underneath, and export clean `tank_sight_presets` `.blk` files without unwanted `drawLines` or `matchExpClass` blocks.
- **Classic Static Crosshair Synthesis & `Overlay .blk`**: Classic presets with no `drawLines` (such as `Default Sight` or `ariete`) automatically synthesize static lines onto the **Base Layer** so you can trace or draw artwork right over them, and using **Overlay .blk** on a HUD preset similarly generates wireframe guides in the Base Layer.

---

## 3. Top Bar, Canvas Viewport & Floating HUD

### Top Header Bar
- **Brand Badge & Active File Pill (`#activeFileName`)**: Displays the filename of the currently loaded/edited sight.
- **`sights/` Dropdown**: Selects and loads any sight from `sights/`, uploaded files, or `Default Sight` into the workspace.
- **`↻` (Rescan `sights/` Folder)**: Manually triggers an immediate rescan of any linked folder handle and reloads `presets.js`.
- **`📁 Link sights/`**: Opens a native directory picker (`showDirectoryPicker`, with a folder `<input>` fallback) so you can point your browser directly at your local `sights/` folder (or directly at War Thunder's `UserSights` folder) for live discovery without the `.bat` watcher. When already linked cleanly, the button label updates to `📁 <folder>/ Linked`.
- **`Blank`**: Creates a clean blank CDK custom sight (`custom_sight.blk`) with default central hairs, sample `crosshair_distances`, `matchExpClass`, and `thousandth:t="ussr"`, resets history, and centers the view.
- **`Open .blk`**: Opens a `.blk` or `.txt` file from disk, adds it to the dropdown catalog, and replaces the current workspace document.
- **`Overlay .blk`**: Opens a `.blk` or `.txt` file and imports its shapes into the **Base Layer** on top of your current work (appending or replacing the Base Layer depending on the `Overlay:` selector in Panel 5) while keeping your Drawn Art intact.
- **`Ref Image`**: Loads a reference image (`PNG`, `JPG`, `WebP`, `SVG`, etc.) onto the canvas behind your reticle shapes for manual tracing or automatic vectorization.
  - **Drag & Drop Anywhere**: You can also drag and drop a `.blk` file or an image directly onto the browser window. Dropping a single `.blk` opens it; dropping multiple `.blk` files adds all of them into the `sights/` dropdown and opens the first one; dropping an image loads it as the reference image.
- **Undo / Redo (`↶` / `↷`)**: Steps backward or forward up to **50 history states** (`Ctrl+Z` / `Ctrl+Y` or `Ctrl+Shift+Z`).
- **6 Preview Modes (`Day` / `Illum` / `Thermal` / `NVG` / `CAD` / `Motion`)**:
  - **`Day`**: Daytime olive optic field using your configured `Day Color` (`crosshairColor`).
  - **`Illum`**: Night/dark optic view with backlit glow using your configured `Light Color` (`crosshairLightColor`, or red default).
  - **`Thermal`**: Thermal gunner sight preview honoring `Thermal Color` (`crosshairThermalColor`) and each HUD widget's `thermalColor` / `thermalTextColor`.
  - **`NVG`**: Night-vision optic preview honoring `NVG Color` (`crosshairNvColor`) and each HUD widget's `nvColor` / `nightVisionTextColor`.
  - **`CAD`**: High-contrast dark slate blueprint view for crisp precision editing.
  - **`Motion`**: Color-codes elements by range-adjustment behavior — **Static** (silver-white `#cbd5e1`), **Vertical `move:b`** (cyan `#38bdf8`), and **Radial `moveRadial:b` / `radial:b`** (magenta `#e879f9`) — with a live count legend in the top-right corner of the canvas.
- **`PNG`**: Renders the current canvas (in whichever preview mode and zoom level is currently active) and downloads a `<sight_name>_preview.png` screenshot.
- **`Raw .blk`**: Opens the **Raw War Thunder `.blk` Source** modal displaying the live serialized `.blk` text, line count, and KB size:
  - **Editable Textarea**: You can inspect or manually edit the raw `.blk` code directly.
  - **`Copy to Clipboard`**: Copies the serialized `.blk` text to your clipboard.
  - **`Download .blk`**: Downloads the exact text currently in the textarea as `<sight_name>.blk` (with any spaces replaced by `_`).
  - **`Apply Changes to Canvas`**: Re-parses your edited raw `.blk` text and updates the canvas immediately.
- **`◎ Range Preview`**: Opens the interactive **Rangefinder & Circular Dial Simulator** floating bar above the viewport HUD so you can scrub (`0–4000 m`), auto-play (`▶`), choose shell velocities, simulate optic zoom (`0.50x–3.50x`), trigger **`⚡ RF / Reload`** (live laser rangefinding progress bar + gun reload countdown), and watch circular rangefinders (`radial:b=yes`, `ballistics`, `moveRadial:b=yes`) and range ladders move live.
- **`? Guide`**: Opens a quick-reference help modal inside the app summarizing key workflows and War Thunder setup.
- **`Save .blk`**: Exports the full `.blk` file (`Ctrl+S`). In supported browsers (Chrome/Edge/Brave), uses the native Save File Picker so you can overwrite or save straight into a local folder; otherwise downloads `<sight_name>.blk`. Spaces in suggested filenames are automatically replaced with `_`, and saving a filename that still contains spaces triggers a warning toast.

### Center Canvas Viewport & Floating HUD
- **16:9 In-Game Screen Frame**: The canvas draws the exact **16:9 in-game screen boundaries** (`Y` from `-0.5` to `+0.5`, `X` from `-0.8889` to `+0.8889`). When **`Sight Mask`** is enabled, the 16:9 frame is shaded with a radial optic vignette and `2px` border; when disabled, the background fills the viewport with a subtle `1.5px` 16:9 guide frame.
- **Top-Left Context Hint Pill**: Dynamically displays contextual tips, mouse actions, and modifier keys for whichever tool is currently active.
- **Bottom Viewport HUD**:
  - **`X` / `Y` Readout**: Live War Thunder canvas coordinates of your cursor (snapped coordinates when snapping is active).
  - **`-` / `Zoom %` / `+`**: Zoom out or in around the viewport center (scrolling the mouse wheel zooms smoothly toward the cursor).
  - **`Fit`**: Automatically frames and centers all shapes currently in the sight.
  - **`Origin`**: Resets the camera directly to `(0, 0)` at standard scale.
  - **`L | Q | C | T` Counter**: Live count of Lines, Quads, Circles, and Texts currently in the document.

---

## 4. Left Toolbar: All 12 Tools & Quick Selection Actions

### Drawing & Editing Tools

| Key | Tool | Detailed Behavior & Modifiers |
| :---: | :--- | :--- |
| **`V`** | **Select / CAD Edit** | Click a shape to select it (`Shift+Click` toggles items in multi-selection). Drag empty canvas to draw a marquee box (`Shift+Drag` adds to selection). Drag inside selected shapes to move them. Drag blue **bounding-box corner handles** to scale (`Shift` locks uniform aspect ratio). Drag the top green **rotation handle** to rotate (`Shift` snaps to 15-degree increments). Drag yellow **vertex handles** on selected lines/quads to reposition individual endpoints/corners. **Double-click any line** to select its entire connected polyline chain. **Double-click any text** to edit it. |
| **`L`** | **Line Segment** | Creates individual `drawLines` segments. Supports both **click-and-drag** (drag >= 5px) and **click-then-click** (short click sets start point, second click sets end point; press `Esc` to cancel). Hold **`Shift`** to snap angles to 15-degree increments. |
| **`P`** | **Polyline Chain** | Click to place a continuous chain of connected `drawLines` segments. Hold **`Shift`** to snap the next segment to 15-degree increments. **Double-click** or press **`Enter`** to finish (press `Esc` to cancel the unfinished chain). |
| **`S`** | **Smooth Curve / Spline** | Click control points to generate a smooth Catmull-Rom spline. Output can be smooth connected `drawLines` or a thick `drawQuads` ribbon (configured under **Active Tool Options**). Hold **`Shift`** for 15-degree segment angle snap. **Double-click** or press **`Enter`** to finish. |
| **`B`** | **Freehand Brush / Pen** | Click and drag freely to sketch. Automatically simplifies raw pointer jitter using Ramer-Douglas-Peucker simplification and outputs **Optimized Lines (`drawLines`)**, **Thick Ribbon (`drawQuads`)**, or **Filled Closed Shape (`drawQuads`)**. |
| **`Q`** | **Filled Quad / Polygon** | Click 3 or more vertices (convex or concave) and either **click within 10px of the orange start dot**, **double-click**, or press **`Enter`** to automatically ear-clip triangulate the polygon into valid War Thunder `drawQuads`. |
| **`R`** | **Rectangle / Square** | Click and drag from one corner to the opposite corner. Hold **`Shift`** to constrain to a perfect square. Respects **Output Type** (`Outline (drawLines)` or `Filled (drawQuads)`). |
| **`C`** | **Circle / Arc** | Click center and drag outward to set radius. Respects **Output Type**: `Outline (drawLines)` (polygon arc), `Filled (drawQuads)` (filled fan/ring quads), or `Native WT Circle (drawCircles)` (single native WT circle/arc primitive). Supports custom **Circle Segs** and **Arc Angles**. |
| **`G`** | **Tactical Shape Stamp** | Click center and drag radius to stamp **Aiming Chevron (`^`)**, **Star**, **Regular Polygon (N-Gon)**, or **Tactical Cross (`+`)**. Hold **`Shift`** while dragging to rotate interactively. Outputs `drawLines` or filled `drawQuads` depending on **Output Type**. |
| **`T`** | **Text Label** | Click anywhere on the canvas to open the **War Thunder Text Element** popover (`Text`, `Size`, `Align`: `Center (0)`, `Left (1)`, `Right (-1)`). Press **`Enter`** or click **Place Text** to insert into `drawTexts`. |
| **`E`** | **Eraser** | High-speed 60-FPS swept-path eraser. Click or drag quickly across any unlocked `line`, `quad`, `circle`, or `text` inside the cursor circle to erase it cleanly without dragging lag. Adjust brush diameter via **Eraser Size**. |
| **`H`** | **Pan Viewport** | Drag to pan around the canvas. You can also pan temporarily from *any* tool by holding **`Spacebar` + Left-Drag** or **Middle-Mouse Drag**. |

### Left Toolbar Bottom Quick Actions (Require Selection)
- **`Duplicate (Ctrl+D)`**: Clones selected shapes onto the **Drawn** layer shifted by `(+0.015, +0.015)`.
- **`Flip H`**: Mirrors selected unlocked shapes horizontally around the selection's bounding-box center.
- **`Flip V`**: Mirrors selected unlocked shapes vertically around the selection's bounding-box center.
- **`Mirror-Copy Across X=0`**: Creates mirrored clones of the selection across the vertical center axis (`X = 0`).
- **`Delete (Del / Backspace)`**: Deletes all selected unlocked shapes.

---

## 5. Right Inspector: Complete Panel-by-Panel Reference

### Panel 1: Drawing & Tool Options
- **Top Toggle Chips**:
  - **`Mirror X`**: Mirrors every newly drawn line, quad, circle, stamp, or text horizontally across `X = 0` (displays a vertical cyan guide line when active).
  - **`Mirror Y`**: Mirrors every newly drawn shape vertically across `Y = 0` (displays a horizontal cyan guide line when active). Combined with `Mirror X`, draws 4-way quadrant symmetry.
  - **`Snap Grid`**: Snaps pointer coordinates to intersections of the current **Grid Step**.
  - **`Snap Vertex`**: Magnetically snaps pointer and dragged vertices to nearby existing shape endpoints and corners (`11px` snap radius; ignores the vertex's own shape when dragging an endpoint).
  - **`Show Grid`**: Displays/hides the background coordinate grid and `X=0` / `Y=0` axes.
  - **`Color Layers`**: Color-codes shapes by layer (`Base Layer` = Cyan `#38bdf8`, `Drawn Layer` = Green `#34d399`, `Selected` = Amber `#f59e0b`) regardless of preview mode so you can easily tell layers apart while editing.
  - **`Color Motion`**: Color-codes shapes by motion type (**Static** vs **Vertical `move:b`** vs **Radial `moveRadial:b`**) in any preview mode and displays the live motion legend.
- **`Grid Step`**: Coordinate spacing of major grid lines (`0.001` to `10`, default `0.025`; automatically doubles visually when zoomed way out so grid lines never clutter the screen).
- **`Ticks`**: Toggles preview rendering of War Thunder's dynamic `crosshair_distances` tick marks and labels on canvas.
- **`Draw: move:b / mils / radial`**: Sets default CDK flags attached to drawn shapes: **`move:b`** (vertical ballistic drop tracking; mutually exclusive with `radial`), **`mils`** (`thousandth:b=true`), and **`radial`** (`moveRadial:b=yes`; mutually exclusive with `move:b`).
- **Active Tool Options Box** (shows controls relevant to the active tool):
  - **Freehand (`B`)**:
    - **`Brush Output`**: `Optimized Lines (drawLines)`, `Thick Ribbon (drawQuads)`, or `Filled Closed Shape (drawQuads)`.
    - **`Smoothing`**: Ramer-Douglas-Peucker simplification tolerance (`0.0001` to `0.01`, default `0.0012`).
    - **`Thickness`** *(when `Thick Ribbon` is selected)*: World width of generated quad strips (`0.001` to `0.03`, default `0.0040`).
  - **Spline (`S`)**:
    - **`Curve Output`**: `Smooth Lines (drawLines)` or `Thick Ribbon (drawQuads)` (shows `Thickness` slider).
    - **`Smoothness`**: Number of subdivided segments per control-point span (`4` to `32`, default `12`).
  - **Rect (`R`) / Circle (`C`) / Shape (`G`)**:
    - **`Output Type`**: `Outline (drawLines)`, `Filled (drawQuads)`, or `Native WT Circle (drawCircles)` (enabled when Circle tool is active).
    - **`Circle Segs`** *(Circle outline/filled)*: Polygon segment count around a full 360-degree circle (`6` to `128`, default `36`).
    - **`Arc Angles`** *(Circle tool)*: Start and End angle in degrees (`0` to `360`).
  - **Tactical Stamp (`G`)**:
    - **`Stamp Shape`**: `Aiming Chevron (^)`, `Star`, `Regular Polygon (N-Gon)`, or `Tactical Cross (+)`.
    - **`Points / Sides`**: Number of star points or polygon sides (`3` to `24`, default `5`).
    - **`Inner Ratio`**: Inner-to-outer radius ratio for Stars, Chevrons, and Cross arm thickness (`0.15` to `0.85`, default `0.45`).
  - **Eraser (`E`)**:
    - **`Eraser Size`**: Screen-space cursor radius in pixels (`4px` to `60px`, default `16px`).

---

### Panel 2: Circular Rangefinder (Radial)
Create and edit historical TZF-style or modern circular rotating rangefinder sights:
- **`▶ Preview Circular Rangefinder`**: Opens and starts the **Range Preview** simulation bar so you can watch the circular dial rotate live.
- **Quick Radial Sight Builder (`+ Build`)**: Generates ready-to-use **`TZF 12a Panther (Dot Ring)`**, **`TZF 9b Tiger (Dual Arc)`**, or **`Modern Radial Tick Dial (All Tanks)`** sights with `ballistics { bullet { ... } }` or top-level `radial:b=yes` settings.
- **Scale Target (`Main Scale` or `Bullet #1..N`) + `+ Bullet` / `✕ Remove`**: Switch between the top-level `crosshair_distances` ring and per-shell `ballistics { bullet { ... } }` rings.
- **Radial Options**: Toggle **`Circular (radial:b)`**, **`Dots (circleMode)`**, **`Clockwise (upward)`**, and **`Gun Corr.` (`applyCorrectionToGun`)**, and configure **`bulletType`**, **`Velocity (m/s)`**, **`Ring Radius`** (in `mils` or screen units), **`Angle° / Stretch`**, **`Center X / Y` (`distancePos`)**, and **`Label Offset` (`textPos`)**.
- **Range Marks Generator**: Set **`Step`**, **`Max`**, and **`Labels`** interval and click **`Generate Distance Marks`** to populate `crosshair_distances`.
- **`+ Index Pointer`** & **`Bake → Editable Shapes`**: Drop a fixed 12 o'clock aiming triangle pointer or bake any native radial scale into individual editable `moveRadial:b=yes` vector primitives.

---

### Panel 3: Tank Sight Preset (HUD)
Full visual editor for War Thunder `UserSights/tank_sight_presets/*.blk` HUD preset files:
- **Export Format (`Classic Custom Sight` vs `HUD Preset (tank_sight_presets)`)**: Chooses whether `Save .blk` / `Raw .blk` exports a classic CDK sight (`drawLines{}`) or a clean `tank_sight_presets` preset file without polluting `drawLines` or `matchExpClass`.
- **Quick HUD Preset Templates (`+ Apply`)**: One-click templates for **Pro Competitive HUD (All 5 Widgets)** (Day/Thermal green, Illum/NVG red-orange, blue `gunReady`, aligned RF/Ready row, `reticle` overrides enabled) and **Minimal Custom HUD (Default)**.
- **Linked Reticle (`crosshair:t`) & Backdrop**:
  - Edit `crosshair:t="..."` (with autocomplete suggestions from classic sights in `sights/`) or click **`Load Backdrop .blk`** to preview any custom `.blk` reticle directly behind the HUD widgets with live **Range Preview** and **`reticle` overrides**.
  - **`Dist Offset` (`shotDistScaleOffset:i`)**: Shifts the ballistic distance scale horizontally.
- **Reticle Overrides (`reticle {}`)**: Enable `Include` and `overridden:b`, and adjust **`lineWidth:r`** (`lineW`) and **`fontSize:r`** (`fontS`) with live canvas scaling.
- **Live 1920x1080 HUD Overlay & Dragging (`Show HUD Overlay` / `Drag HUD`)**:
  - Displays all enabled HUD widgets interactively on canvas. With **`Drag HUD`** enabled and the Select (`V`) tool active, drag any positioned widget directly on the canvas with **smart center/widget alignment snap guides** (hold **`Shift`** to axis-lock, **`Alt`** to temporarily suppress snapping, or use **Arrow Keys** / **`Shift+Arrow`** to nudge by `1px` / `10px`).
- **5-Widget Inspector (`RF` / `Turret` / `FOV` / `Ready` / `Ammo`)**:
  - Toggle **`Block`** (include/exclude block on export) and **`Visible`** (`visible:b`) per widget.
  - Edit 1920x1080 **`HUD X / Y`** coordinates with **`X=960`**, **`Y=540`**, **`Mirror X`**, and **`Align RF/Ready`** quick alignment buttons, plus **`textSize:i`** and **`font:t`**.
  - Widget-specific properties: **`rangefinder`** progress bar (`progressColor:c`, `progressBackgroundColor:c`), **`gunReady`** (`gunReadyMarkVisible:b`, `gunReadyReloadCountdownVisible:b`), and **`bulletType`** (`isShortName:b`).
  - **4-Mode Per-Widget Palette (`Day` / `Illum` / `NVG` / `Thermal`)**: Customize foreground (`textColor` / `color`) and background (`bgColor`) RGBA colors independently for every optic mode, with **`Day → All Modes`**, **`Apply → All`**, and **`Match Reticle`** utilities.

---

### Panel 4: Ref Image & Pro Auto-Draw
- **Image Loading & Placement**:
  - **`Load Image`**: Browse and load any `PNG`, `JPG`, `WebP`, or `SVG`.
  - **`Sample Art`**: Generates a built-in high-contrast 512x512 line-art crosshair/emblem test image so you can try Auto-Draw immediately without uploading a file.
  - **`Remove`**: Clears the loaded reference image and its live trace preview.
  - **`Show`**: Shows/hides the reference image on canvas without removing it.
  - **`Move / Resize Image Directly on Canvas`**: Displays interactive cyan corner scale handles, a center drag handle, and a top rotation handle (`Shift` snaps to 15-degree steps) directly on the reference image so you can align it over the sight visually.
  - **`Opacity`**: Image transparency (`0%` to `100%`, default `45%`).
  - **`Size`**: Reference image world height (slider `0.05` to `1.6`, or exact numeric input `0.01` to `5`, default `0.45`).
  - **`Offset X / Y`**: Exact `(X, Y)` center coordinates of the reference image.
  - **`Rotation`**: Exact angle in degrees (`-180°` to `+180°`).
  - **`Reset Pos`**: Resets position to `(0, 0)`, rotation to `0°`, and size to `0.45`.
  - **`Fit Sight`**: Resets position/rotation and scales the image to `0.90` world height (filling most of the `16:9` viewport height).
- **Auto-Draw Vectorizer Box** *(displays detected `Lines / Quads` badge on the right)*:
  - **`Mode`**:
    - **`Smart Line Art (Single-Stroke Centerline)`** *(Default)*: Ideal for line art, anime/mascot drawings, and emblems. Uses a chroma-aware luminance blend (detecting colored accents like cheek blush as well as black ink), a Background-Only 2D Integral Image (`>= Otsu threshold`), and a Chamfer Distance Transform + separable max filter so thin strokes vectorize cleanly as single-stroke centerlines while thick solid fills (such as dark eyes) trace strictly along their **exact outer border** without inward indentation.
    - **`Crisp Contours (Sub-Pixel Outlines)`**: Uses sub-pixel linear-interpolated Marching Squares to outline every solid dark region and hole boundary.
    - **`Illustration / Photo Edges (Canny)`**: Applies Sobel gradient magnitude, non-maximum suppression, and dual-threshold hysteresis edge tracking for photos or shaded illustrations.
    - **`Hybrid Art (Lines + Filled Quads)`**: Traces crisp line art (`drawLines`) and fills dark interior spans (`drawQuads`) automatically.
  - **`Sensitivity`** (`5%` to `99%`, default `72%`): Higher values capture lighter pencil lines, subtle shading, and colored details; lower values keep only bold high-contrast strokes.
  - **`Contrast Boost`** (`1.0x` to `4.0x`, default `1.6x`): Stretches tonal separation around the image mean before thresholding.
  - **`Resolution`** (`256px` to `1024px`, default `640px`): Longest-edge sampling grid resolution; higher captures finer details at slightly higher segment counts.
  - **`Curve Smoothing`** (`0.20px` to `3.50px`, default `0.65px`): Sub-pixel Ramer-Douglas-Peucker tolerance; lower values hug subtle curves, higher values reduce total segment count.
  - **`De-Speckle`** (`1px` to `16px`, default `3px`): Minimum pixel chain length required before a traced path is kept (filters out noise/dust).
  - **`Stroke Type`**: Exports traced paths as **`Standard Lines (drawLines)`** or **`Thick Filled Ribbon (drawQuads)`** (using the active brush thickness).
  - **`Live Preview`**: Shows a real-time cyan vector preview overlay on top of your reference image whenever you move a slider or reposition the image.
  - **`Replace Last`**: When checked, clicking `Auto-Draw Image → Reticle` again replaces the previously traced batch rather than stacking duplicates.
  - **`Invert B/W`**: Inverts luminance calculation (enable this when tracing **white/bright lines on a dark background**).
  - **`Target Layer Dropdown`**: Routes traced geometry to **`→ Drawn Layer`** or **`→ Base Layer`**.
  - **`Auto-Draw Image → Reticle`**: Commits the vectorized lines/quads into your sight and pushes an Undo step.
  - **`↩ Undo`**: One-click removal of the most recently committed Auto-Draw trace batch.

---

### Panel 5: Reticle Layers & Static Base
The editor manages two layers so you can modify or draw over existing sights safely:

- **Base / Uploaded `.blk` Card** *(Blue dot, displays shape count)*:
  - **`👁` (Visibility)** & **`🔓` / `🔒` (Lock)**: Hide/show or lock the Base Layer so selection, dragging, and erasing never touch the underlying crosshair while you draw on top.
  - **`Include Base in Export`**: Checked by default. Uncheck if you used another sight only as a tracing guide and want to export *only* your Drawn Art Overlay.
  - **`Overlay: Append` / `Overlay: Replace`**: Controls whether clicking `Overlay .blk` adds to the existing Base Layer or replaces only the Base Layer.
  - **`Static Template Selector` + `+ Static Sight`**: Synthesizes **`Static: Auto From File`**, **`Static: Standard Crosshair`**, or **`Static: Ariete + HUD`** vector elements directly into the Base Layer at any time.
  - **Quick Transform (`dX`, `dY`, `Scale` + `Apply`)**: Shifts and scales the entire Base Layer around its center in one click.
  - **`Flip H` / `Flip V` / `Center` / `Clear`**: Flips the Base Layer, centers its bounding box at `(0, 0)`, or clears all Base Layer shapes.
- **Drawn Art Overlay Card** *(Green dot, displays shape count)*:
  - **`👁` (Visibility)** & **`🔓` / `🔒` (Lock)**: Toggle visibility or lock state for your custom Drawn Art layer.
  - **`Merge to Base`**: Moves all Drawn shapes into the Base Layer.
  - **`Center`**: Centers the Drawn Layer's bounding box at `(0, 0)`.
  - **`Clear Drawn`**: Deletes all shapes on the Drawn Layer.
- **Sight Optimizer & Complexity Box**:
  - **Complexity Meter (`0 / 8000`)**: Displays total primitives (`Lines + Quads + Circles + Texts`) relative to the `8,000` recommended ceiling (turns red if exceeded).
  - **`Detail Kept` Slider (`5%` to `99%`, default `75%`)**: Higher values preserve fine curves (`99%` merges nearly collinear segments cleanly); lower values weld larger gaps, merge short segments, and decimate vertices aggressively. Dragging the slider after clicking **Optimize Sight** scrubs detail live in real time against your stored pre-optimization baseline!
  - **`Weld Gaps`**: Snaps and merges nearby line endpoints across small sub-pixel gaps before simplifying chains.
  - **`Optimize Quads`**: Also prunes micro-quads and merges aligned quad strips.
  - **`Optimize Sight`**: Runs bidirectional spatial-grid polyline chaining + Ramer-Douglas-Peucker simplification across lines (and quad optimization if enabled).
  - **`↩ Undo Optimize`**: Dedicated one-click restore button that brings back 100% of your original un-optimized baseline geometry.

---

### Panel 6: Selection & CAD
*(Active whenever 1 or more shapes are selected)*

- **Header Badge**: Displays count of selected primitives.
- **Layer & Origin**:
  - **`→ Drawn` / `→ Base`**: Moves selected shapes to the Drawn or Base layer.
  - **`Center (0,0)`**: Centers the selection's bounding box at the sight origin `(0, 0)`.
- **Symmetry**:
  - **`Mirror Copy X` / `Mirror Copy Y`**: Duplicates the selection mirrored across `X = 0` or `Y = 0`.
- **CDK Per-Element Flags** *(applies to all selected elements)*:
  - **`move:b`**: Toggles `move:b=true` (moves vertically with range correction; mutually exclusive with `moveRadial:b`).
  - **`thousandth:b`**: Toggles `thousandth:b=true` (uses mils/thousandth coordinate scaling).
  - **`highlight:b`**: Toggles `highlight:b=yes` (boosts illumination glow in-game).
- **Circular Motion (`moveRadial`)**:
  - Toggle **`moveRadial:b`** *(mutually exclusive with `move:b`)*, edit **`Pivot X / Y` (`radialCenter`)**, **`Angle°` (`radialAngle`)**, and **`Speed` (`radialMoveSpeed`)**, or click **`Sync by Radius`** (`Rigid Mult × radius`) so multi-radius vector digits rotate rigidly as a single dial.
  - Multi-selection automatically preserves differing `radialAngle` / `radialMoveSpeed` values (`Mixed` placeholder) unless explicitly overwritten.
- **Exact Numeric Transforms**:
  - **`Shift dX / dY` + `Go`**: Translates selection by exact coordinates.
  - **`Scale / Rot°` + `Go`**: Scales and rotates selection around its bounding-box center by exact values.
- **Radial / Circular Array**:
  - **`Copies`** (`2` to `60`, default `6`) + **Pivot** (`Around (0,0)` or `Selection Center`) + **`Create Radial Array`**: Creates evenly spaced circular copies around the chosen pivot (`360° / Copies`).
- **Convert & Simplify Selection**:
  - **`Detail Kept` Slider (`5%–99%`) + `Simplify Selected` + `↩ Undo`**: Runs the polyline chainer and RDP simplifier exclusively on the currently selected unlocked lines, with live scrubbing and dedicated one-click Undo.
  - **`Select Chain`**: Expands a selected line to all connected line segments forming the same stroke or loop (same as double-clicking a line).
  - **`Lines → Quads`**: Converts selected thin `drawLines` segments into filled `drawQuads` strips using the active brush thickness.
  - **`Quads → Lines`**: Extracts the 4 outer edges of selected `drawQuads` into wireframe `drawLines`.
- **Single-Element Numeric Inspector** *(shown when exactly 1 shape is selected)*:
  - Allows direct numeric editing of **`Line`** (`X1, Y1, X2, Y2`), **`Quad`** (`TL/TR/BR/BL X & Y`), **`Circle`** (`Center X/Y, Diameter, Thickness, Start Deg, End Deg`), or **`Text`** (`Text string, X, Y, Size`).

---

### Panel 7: Sight Global Settings (CDK)
Maps directly to War Thunder's top-level `.blk` header properties and blocks:
- **`Central Vert` (`drawCentralLineVert:b`)**: Draws War Thunder's built-in full-height vertical central crosshair line.
- **`Central Horz` (`drawCentralLineHorz:b`)**: Draws War Thunder's built-in full-width horizontal central crosshair line.
- **`Sight Mask` (`drawSightMask:b`)**: Enables the optic mask (and switches the canvas backdrop between framed optic mask and full-screen view).
- **`Smooth Edge` (`useSmoothEdge:b`)**: Enables smooth anti-aliased sight mask edges in-game.
- **`Range Readout` (`drawDistanceCorrection:b`)**: Enables/disables the in-game range correction text readout.
- **`Gun Correction` (`applyCorrectionToGun:b`)**: Controls whether zeroing elevates the gun (`yes`) or shifts aiming chevrons/ladders downward (`no`, used by TZF-style sights).
- **`Mil Standard` (`thousandth:t`)**: Selects angular mil formula **`USSR (1/6000)`**, **`NATO (1/6400)`**, or **`Real (1/6283)`** (live canvas preview adjusts `thousandth:b=true` coordinates accordingly).
- **`lineSizeMult`** & **`fontSizeMult`**: Global line thickness and text size multipliers used by War Thunder.
- **`Day Color` (`crosshairColor:c`)** + Alpha (`0–255`): Base reticle color and opacity in `Day` mode.
- **`Light Color` (`crosshairLightColor:c`)** + Alpha (`0–255`): Illuminated reticle color and opacity in `Illum` mode.
- **`NVG Color` (`crosshairNvColor:c`)** + Alpha (`0–255`): Night-vision optic reticle color and opacity in `NVG` mode.
- **`Thermal Color` (`crosshairThermalColor:c`)** + Alpha (`0–255`): Thermal sight reticle color and opacity in `Thermal` mode.
- **`Dist Offset` (`shotDistScaleOffset:i`)**: Horizontal pixel/scale offset for the ballistic distance scale (synced with Panel 3).
- **`matchExpClass (all_tanks)`**: Checkboxes for **`Tanks / MBT` (`exp_tank`)**, **`Heavy Tanks` (`exp_heavy_tank`)**, **`Tank Destroyers` (`exp_tank_destroyer`)**, and **`SPAA` (`exp_SPAA`)**. Included by default on blank and exported classic `.blk` files so sights work in `UserSights/all_tanks/` as well as vehicle-specific folders.
- **Preserved Advanced Properties**: Top-level blocks (such as `crosshair_distances`, `crosshair_hor_ranges`, `reticle`, HUD blocks) and CDK per-element radial properties (`moveRadial:b`, `radialCenter:p2`, `radialAngle:r`, `radialMoveSpeed:r`, `center:b`) found in existing `.blk` files are parsed and preserved cleanly on export.

---

## 6. Complete Keyboard & Mouse Shortcuts

| Input | Action |
| :--- | :--- |
| **`V`** | Select / CAD Edit tool |
| **`L`** | Line Segment tool |
| **`P`** | Polyline Chain tool |
| **`S`** | Smooth Curve / Spline tool |
| **`B`** | Freehand Brush / Pen tool |
| **`Q`** | Filled Quad / Polygon tool |
| **`R`** | Rectangle / Square tool |
| **`C`** | Circle / Arc tool |
| **`G`** | Tactical Shape Stamp tool |
| **`T`** | Text Label tool |
| **`E`** | Eraser tool |
| **`H`** | Pan tool |
| **`Spacebar + Drag`** or **`Middle-Click + Drag`** | Pan viewport temporarily from any tool |
| **`Mouse Wheel`** | Zoom in/out toward the cursor |
| **`Shift + Click / Drag`** | Multi-select (`V`), keep aspect ratio on Scale handles (`V`), axis-lock dragged HUD widgets (`V`), 15-degree snap on Rotate handles / Ref Image rotation / `L` / `P` / `S`, force Square (`R`), or interactive Stamp rotation (`G`) |
| **`Alt + Drag`** | Temporarily bypass snap alignment guides while dragging a HUD widget |
| **`Double-Click`** | Finish `Polyline` / `Spline` / `Polygon`; with `Select (V)`, double-click a **line** to select its connected chain or double-click **text** to edit |
| **`Enter`** | Finish active `Polyline` / `Spline` / `Polygon`, or confirm Text input |
| **`Escape`** | Close Raw `.blk` modal or Text popover, cancel active polyline/pending line start, or clear selection |
| **`Arrow Keys`** | Nudge selected shapes by `0.0025` units (or selected HUD widget by `1px` when `Drag HUD` is active) |
| **`Shift + Arrow Keys`** | Nudge selected shapes by `0.02` units (or selected HUD widget by `10px`) |
| **`Ctrl + Z`** | Undo |
| **`Ctrl + Y`** or **`Ctrl + Shift + Z`** | Redo |
| **`Ctrl + C` / `Ctrl + V`** | Copy / Paste selected shapes (pastes onto Drawn layer) |
| **`Ctrl + D`** | Duplicate selected shapes (onto Drawn layer) |
| **`Ctrl + A`** | Select all visible, unlocked shapes |
| **`Ctrl + S`** | Save / Download `.blk` file |
| **`Delete` / `Backspace`** | Delete selected unlocked shapes |

---

## 7. Step-by-Step Workflows

### Workflow 1: Drawing Custom Art Over an Existing Sight
1. Pick any sight from the **`sights/`** dropdown (or click **`Overlay .blk`** / **`Open .blk`**).
   - Classic presets synthesize static crosshair and range scale guides onto the **Base Layer** (and using **Overlay .blk** on a HUD preset similarly generates wireframe guides in Base).
2. In **Panel 5 (Reticle Layers & Static Base)**, click **`🔒`** on the **Base Layer** so you cannot accidentally move or erase it. *(Optional: toggle **`Color Layers`** in Panel 1 to see Base in Cyan and Drawn Art in Green).*
3. Draw using the left toolbar (`L`, `S`, `B`, `Q`, `G`, `T`) or use **Pro Auto-Draw** to trace a reference image onto the **Drawn Layer**.
4. Keep **`Include Base in Export`** checked if you want both combined, or uncheck it to export *only* your custom Drawn overlay, then click **`Save .blk`**.

### Workflow 2: Converting an Image / Drawing Automatically with Auto-Draw
1. Click **`Ref Image`** in the top bar (or drag-and-drop a `PNG`/`JPG`/`WebP`/`SVG` onto the canvas).
2. In **Panel 4 (Ref Image & Pro Auto-Draw)**, check **`Move / Resize Image Directly on Canvas`** and position the image inside the **16:9 viewport** where you want it to appear in-game. Uncheck when positioned.
3. Choose **`Smart Line Art`** for clean line drawings/characters (or **`Hybrid Art`** if you also want dark regions filled with quads, or **`Crisp Contours`** for solid logos).
4. Adjust **`Sensitivity`**, **`Contrast Boost`**, and **`Curve Smoothing`** while watching the real-time cyan preview overlay. *(If your image uses bright lines on a dark background, enable **`Invert B/W`**).*
5. Click **`Auto-Draw Image → Reticle`**. If total primitives get high, use **Sight Optimizer & Complexity** (`Detail Kept` + **`Optimize Sight`**) to reduce segment count smoothly without losing silhouette accuracy.

### Workflow 3: Building or Editing a Tank Sight HUD Preset (`tank_sight_presets`)
1. Open an existing preset from `UserSights/tank_sight_presets/` via **`Open .blk`** (or choose a quick template in **Panel 3: Tank Sight Preset (HUD)** and click **`+ Apply`**).
2. Type the custom sight filename (without `.blk`) in **`crosshair:t`**, or click **`Load Backdrop .blk`** to render your custom reticle directly underneath the HUD elements.
3. Adjust **`reticle {}`** thickness/font overrides and toggle **`Drag HUD`** to drag **`RF`**, **`Turret`**, **`Ready`**, and **`Ammo`** into exact 1920x1080 positions with live snap guides.
4. Configure per-mode colors (**Day** / **Illum** / **NVG** / **Thermal**), toggle the top-bar optic preview modes to inspect contrast, and open **`◎ Range Preview`** → **`⚡ RF / Reload`** to simulate live rangefinding & reload countdowns before clicking **`Save .blk`**.

---

## 8. How to Install Your `.blk` Sight in War Thunder

1. Click **`Save .blk`** in the top-right corner of **WT Reticle Studio Pro** (or press **`Ctrl + S`**). Make sure your sight's filename **does not contain spaces** (for example, use `my_custom_sight.blk`).
2. Copy your saved `.blk` file into your War Thunder **`UserSights`** folder:
   - **For a specific tank**:
     `C:\Users\<username>\Documents\My Games\WarThunder\Saves\<player-ID>\production\UserSights\<tank-ID>\<sight-name>.blk`
     *(Tip: You can generate a tank's folder automatically in War Thunder via **Options → Common Battle Settings → Grid sight → Add a grid sight** while in Test Drive with that tank).*
   - **For ALL ground vehicles at once**:
     `C:\Users\<username>\Documents\My Games\WarThunder\Saves\<player-ID>\production\UserSights\all_tanks\<sight-name>.blk`
     *(Make sure the vehicle classes you want are checked under **`matchExpClass (all_tanks)`** in **Sight Global Settings (CDK)**; all four are enabled by default).*
   - **For a Tank Sight HUD Preset (`HUD Preset` export mode)**:
     `C:\Users\<username>\Documents\My Games\WarThunder\Saves\<player-ID>\production\UserSights\tank_sight_presets\<preset-name>.blk`
3. Open War Thunder (or reboot/restart the game if it was already running), go to **Options → Main Parameters → Common Battle Settings → Sight Settings** (or **Grid sight**), and select your custom sight from the dropdown!

---

## 9. Troubleshooting

- **`Alt + F9` to reload sights in-game does not work**:
  - Pressing **`Alt + F9`** to reload custom sights without closing War Thunder will most probably **not** work, as this has been broken/unreliable in War Thunder for years. **The only reliable solution after adding or editing a `.blk` sight is to reboot (restart) the game.**
- **Sight does not show up or fails to load in War Thunder**:
  - **The sight name must not have spaces in it.** Make sure your `.blk` filename uses underscores instead of spaces (for example, use `my_sight.blk` instead of `my sight.blk`).
  - If placing the sight inside `UserSights\all_tanks\`, verify that the **`matchExpClass (all_tanks)`** vehicle classes are checked in **Sight Global Settings (CDK)** before saving.
- **Auto-Draw detects too little or nothing from my reference image**:
  - Increase **`Sensitivity`** (`80%–95%`) and **`Contrast Boost`** (`2.0x–3.0x`), or enable **`Invert B/W`** if the image has light lines on a dark background.
  - Try switching between **`Smart Line Art`** (best for sketches/lineart) and **`Illustration / Photo Edges (Canny)`** (best for full-color photos/artwork).
- **Reticle has too many segments / in-game FPS drops or War Thunder hits primitive limits**:
  - Open **Reticle Layers & Static Base → Sight Optimizer & Complexity**, adjust **`Detail Kept`** downward (`50%–75%`), and click **`Optimize Sight`** (or click **`↩ Undo Optimize`** if you want to restore full detail and pick a higher percentage).
- **Custom sight doesn't match the proportions I saw in the editor**:
  - Remember the outer viewport rectangle in the editor represents the exact **16:9** in-game screen (`Y: -0.5 to +0.5`, `X: -0.8889 to +0.8889`). Elements with `thousandth:b=true` scale with gunner optic magnification (zoom FOV), while elements with `thousandth:b=false` remain fixed in screen coordinates.

---

## Disclaimer

Portions of this project, including parts of the code, styling, and documentation, were created with the assistance of AI.

---

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
