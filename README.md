# WT Reticle Studio Pro: War Thunder `.blk` Custom Sight & Art Editor

**WT Reticle Studio Pro** is a zero-install, studio-grade vector drawing and auto-tracing web application for creating custom **War Thunder** tank sights (`.blk`), drawing artwork over existing sights (including dynamic HUD presets), and automatically converting reference images or line art into War Thunder reticle geometry.

Built in compliance with the official [War Thunder CDK Custom Sight Specification](https://wiki.warthunder.com/cdk/creation_sight).

---

## 1. Quick Start (How to Open & Run)

You do **not** need to install any software, compilers, or servers to use the editor:

### Option A: Recommended (With Automatic `sights/` Folder Sync)
Double-click **`Start-ReticleStudio.bat`**.
- This opens **`index.html`** in your browser AND runs **`sync-sights.ps1`** in the background.
- Any `.blk` sight file you drop into the **`sights/`** folder is automatically detected within ~2 seconds and appears in the top **`sights/`** dropdown menu without refreshing the page.

### Option B: Direct Browser Launch
Double-click **`index.html`** to open it in any modern browser (Chrome, Edge, Brave, Firefox, Opera).
- You can also click **`📁 Link sights/`** in the top bar and select the `sights/` folder to give your browser direct live-folder reading and saving access.

---

## 2. How the `sights/` Example Folder Works

The **`sights/`** folder comes bundled with example `.blk` sights and acts as a live library folder:
- **Example Sights Included**: The folder contains ready-to-use examples of both **custom vector art sights** (`drawLines`, `drawQuads`, `drawCircles`, `drawTexts`) and **modern War Thunder dynamic HUD preset sights** (`crosshair:t="..."`, `rangefinder`, `turret`, `fov`, `gunReady`, `bulletType`).
- **Automatic Static Crosshair Synthesis**: Even when an example or imported sight is a dynamic HUD preset containing no raw `drawLines` blocks of its own, **WT Reticle Studio Pro automatically synthesizes its static crosshair, ballistic range ticks, and HUD indicators into the Base Layer** so you can preview it and draw your custom artwork directly over it.
- **Drop In Any Sight**: Any `.blk` file you place inside **`sights/`** is automatically discovered and added to the top **`sights/`** dropdown menu.

---

## 3. Drawing Over an Existing Sight (Layers Workflow)

The editor separates every sight into two independent layers (found in **Reticle Layers & Static Base** on the right panel):

1. **Base / Uploaded `.blk` Layer**:
   - Holds the original sight you opened from `sights/`, **`Open .blk`**, or **`Overlay .blk`** (plus any synthesized static crosshair lines).
   - Click the **`🔓` / `🔒`** lock button on the Base Layer to lock it so you never accidentally move or erase the base crosshair while drawing your artwork.
   - Check or uncheck **`Include Base in Export`** depending on whether you want the exported `.blk` file to contain both the base sight and your artwork, or only your newly drawn artwork.
2. **Drawn Art Overlay Layer**:
   - Everything you draw with the left toolbar or generate with **Auto-Draw** goes here by default.
   - Toggle **`Color Layers`** in **Drawing & Tool Options** at any time to color-code the **Base Layer (Cyan)** vs **Drawn Art (Green)** for easy visual editing.

---

## 4. Reference Image & Pro Auto-Draw Vectorizer

Want to turn an anime character, mascot, meme, emblem, or technical diagram into a War Thunder reticle automatically?

### Step 1: Load Your Image
- Click **`Ref Image`** in the top bar (or drag-and-drop any **PNG, JPG, WebP, or SVG** directly onto the canvas).
- Check **`Move / Resize Image Directly on Canvas`** in the **Ref Image & Pro Auto-Draw** panel to drag, scale, or position the image directly over the crosshair, or use the **Opacity**, **Size**, **Offset X / Y**, and **Rotation** sliders.

### Step 2: Choose Your Auto-Draw Mode
In the **Auto-Draw Vectorizer** box, pick the mode that best matches your image:
- **Smart Line Art (Single-Stroke Centerline)** *(Default, best for line art, drawings, and characters)*:
  - Uses a Background-Only 2D Integral Image and Chamfer Distance Transform to trace thin lines as clean single-stroke centerlines while pinning the **exact outer border** of solid filled shapes (such as dark eyes or solid patches) without inward indentation.
- **Crisp Contours (Sub-Pixel Outlines)**:
  - Uses sub-pixel linear-interpolated Marching Squares to trace ultra-sharp inner and outer boundaries of high-contrast shapes and logos.
- **Illustration / Photo Edges (Canny)**:
  - Uses Sobel gradients, non-maximum suppression, and hysteresis thresholding to extract edges from full-color illustrations or photographs.
- **Hybrid Art (Lines + Filled Quads)**:
  - Combines single-stroke line tracing with automatic `drawQuads` region filling for dark solid areas.

### Step 3: Fine-Tune with Live Cyan Preview
With **`Live Preview`** checked, a real-time cyan overlay shows the exact vector lines/quads that will be created as you adjust:
- **Sensitivity (`5%–99%`)**: Higher values capture fainter pencil strokes, soft shading, and colored details (like cheek blush).
- **Contrast Boost (`1.0x–4.0x`)**: Amplifies faint lines against light backgrounds.
- **Resolution (`256px–1024px`)**: Sampling resolution (higher captures finer details).
- **Curve Smoothing (`0.20px–3.50px`)**: Lower keeps every subtle curve; higher simplifies strokes into fewer line segments.
- **De-Speckle (`1px–16px`)**: Filters out tiny stray dust pixels.
- **Invert B/W**: Enable this if your image has white/light lines on a dark background.

### Step 4: Commit to Reticle
Click **`Auto-Draw Image → Reticle`**.
- If you want to tweak a slider and re-trace, keep **`Replace Last`** checked (or click **`↩ Undo`** next to the button at any time).

---

## 5. Drawing Tools & Keyboard Shortcuts

| Shortcut | Tool | How It Works |
| :---: | :--- | :--- |
| **`V`** | **Select / CAD Edit** | Click or drag a marquee box to select shapes. Drag blue handles to scale, top green handle to rotate, or yellow vertex dots to reshape individual corners/endpoints. **Double-click any line** to select its entire connected polyline chain. **Double-click any text** to edit it. |
| **`L`** | **Line Segment** | Click-and-drag or click two points to place a `drawLines` segment. Hold **`Shift`** to snap angles to 15° increments. |
| **`P`** | **Polyline Chain** | Click to place connected vertices. **Double-click** or press **`Enter`** to finish. Hold **`Shift`** for 15° angle snap. |
| **`S`** | **Smooth Curve / Spline** | Click control points to draw a smooth Catmull-Rom organic curve (as `drawLines` or thick `drawQuads` ribbon). **Double-click** or press **`Enter`** to finish. |
| **`B`** | **Freehand Brush / Pen** | Draw freely with your mouse or stylus. Supports **Optimized Lines (`drawLines`)**, **Thick Ribbon (`drawQuads`)**, or **Filled Closed Shape (`drawQuads`)**. |
| **`Q`** | **Filled Polygon / Quad** | Click corners of any convex or concave shape and **double-click** (or click the green start point) to automatically triangulate and fill it with `drawQuads`. |
| **`R`** | **Rectangle / Square** | Drag to draw a rectangle (outline `drawLines` or filled `drawQuads`). Hold **`Shift`** for a perfect square, **`Alt`** to expand from center. |
| **`C`** | **Circle / Arc** | Drag from center outward. Supports **Outline (`drawLines`)**, **Filled (`drawQuads`)**, or **Native War Thunder Circle (`drawCircles`)** with custom arc start/end angles. |
| **`G`** | **Tactical Shape Stamp** | Drag to place an **Aiming Chevron (`^`)**, **Star**, **Regular Polygon (Hexagon/Octagon/N-Gon)**, or **Tactical Cross (`+`)**. Hold **`Shift`** while dragging to rotate freely. |
| **`T`** | **Text Label** | Click anywhere on the canvas to place a `drawTexts` label with custom size and alignment (`Center (0)`, `Left (1)`, `Right (-1)`). |
| **`E`** | **High-Speed Eraser** | Click or drag smoothly across any lines, quads, circles, or text to erase them at 60 FPS. Adjust **`Eraser Size`** in the right panel. |
| **`H`** / **`Space`** | **Pan Viewport** | Drag to pan around the canvas (or hold **`Spacebar`** + drag or **Middle-Mouse** drag at any time). Use the **Mouse Wheel** to zoom in/out toward the cursor. |

### Helpful Global Shortcuts
- **`Ctrl + Z`**: Undo (up to 50 steps)
- **`Ctrl + Y`** or **`Ctrl + Shift + Z`**: Redo
- **`Ctrl + C` / `Ctrl + V`**: Copy / Paste selected shapes
- **`Ctrl + D`**: Duplicate selected shapes
- **`Ctrl + A`**: Select all unlocked shapes
- **`Ctrl + S`**: Save / Export `.blk` file
- **`Delete` / `Backspace`**: Delete selected shapes
- **`Arrow Keys`**: Nudge selected shapes (`Shift + Arrow` for 10× larger step)

---

## 6. Sight Optimizer & Complexity Slider

War Thunder sights with too many individual segments can hit in-game rendering limits or lower FPS. The **Sight Optimizer & Complexity** box in the **Reticle Layers & Static Base** panel gives you complete control:

1. **Live Complexity Meter**: Shows total primitives (`Lines + Quads + Circles + Texts`) against the recommended `8,000` ceiling.
2. **`Detail Kept` Slider (`5%–99%`)**:
   - Click **`Optimize Sight`** to weld micro-gaps, merge collinear segments, join connected segments into continuous polylines, simplify curves, and merge adjacent quad strips.
   - Drag the **`Detail Kept`** slider left or right after optimizing to **interactively scrub** between maximum detail (`99%`) and aggressive segment reduction (`5%`) in real time!
3. **`↩ Undo Optimize` Button**:
   - Dedicated one-click restore button that brings back 100% of your original un-optimized geometry at any time.
4. **Selection-Only Simplifier**:
   - In the **Selection & CAD** panel, you can also simplify only the currently selected lines using the selection **`Detail Kept`** slider and **`Simplify Selected`** / **`↩ Undo`** buttons.

---

## 7. War Thunder CDK Sight Settings Reference

All core parameters from the [War Thunder CDK `creation_sight` documentation](https://wiki.warthunder.com/cdk/creation_sight) are supported and preserved when opening and saving `.blk` files:

- **Mil Standard (`thousandth:t`)**: Choose between **`USSR (1/6000)`**, **`NATO (1/6400)`**, or **`Real (1/6283)`** in **Sight Global Settings (CDK)**.
- **Per-Element Flags** (in **Selection & CAD**):
  - **`move:b=true`**: Element moves vertically when you inject ballistic range with the mouse wheel / rangefinder in-game.
  - **`thousandth:b=true`**: Coordinates are scaled in angular thousandths (mils) so the reticle scales accurately with the tank optic's zoom FOV.
  - **`highlight:b=yes`**: Boosts illumination glow brightness on that element.
  - Advanced radial parameters (`moveRadial:b`, `radialCenter:p2`, `radialAngle:r`, `radialMoveSpeed:r`, `center:b`) from existing sights are automatically preserved during editing and export.
- **Vehicle Class Compatibility (`matchExpClass`)**:
  - Automatically included and configurable in **Sight Global Settings (CDK)** (`exp_tank`, `exp_heavy_tank`, `exp_tank_destroyer`, `exp_SPAA`) so your exported `.blk` sight works both for individual vehicles AND in the universal `UserSights/all_tanks/` folder.

---

## 8. How to Install Your `.blk` Sight in War Thunder

1. Click **`Save .blk`** in the top-right corner of **WT Reticle Studio Pro** (or press **`Ctrl + S`**). Make sure your sight's filename **does not contain spaces** (e.g., use `my_custom_sight.blk`).
2. Copy your saved `.blk` file into your War Thunder **`UserSights`** folder:
   - **For a specific tank**:
     `C:\Users\<username>\Documents\My Games\WarThunder\Saves\<player-ID>\production\UserSights\<tank-ID>\<sight-name>.blk`
     *(Tip: You can generate a tank's folder automatically in War Thunder via **Options → Common Battle Settings → Grid sight → Add a grid sight** while in Test Drive with that tank).*
   - **For ALL ground vehicles at once**:
     `C:\Users\<username>\Documents\My Games\WarThunder\Saves\<player-ID>\production\UserSights\all_tanks\<sight-name>.blk`
     *(Make sure the vehicle classes you want are checked under **`matchExpClass (all_tanks)`** in **Sight Global Settings**; all four are enabled by default).*
3. Open War Thunder (or restart the game if it was already running), go to **Options → Main Parameters → Common Battle Settings → Sight Settings** (or **Grid sight**), and select your custom sight from the dropdown!

---

## 9. Troubleshooting

- **`Alt + F9` to reload sights in-game does not work**:
  - Pressing **`Alt + F9`** to reload custom sights without closing War Thunder will most probably **not** work, as this has been broken/unreliable in War Thunder for years. **The only reliable solution after adding or editing a `.blk` sight is to reboot (restart) the game.**
- **Sight does not show up or fails to load in War Thunder**:
  - **The sight name must not have spaces in it.** Make sure your `.blk` filename uses underscores instead of spaces (for example, use `my_sight.blk` instead of `my sight.blk`).
  - If placing the sight inside `UserSights\all_tanks\`, verify that the **`matchExpClass (all_tanks)`** vehicle classes are checked in **Sight Global Settings (CDK)** before saving.
- **Drawings are missing lines after loading in War Thunder**:
  - Your drawing could have too many lines (War Thunder does not specify a limit). You could try using the `Optimize Sight` feature and retry.

---

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

