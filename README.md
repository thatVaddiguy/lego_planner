# 🧱 LEGO Mosaic Planner

Turn any picture into a buildable LEGO mosaic **using only the bricks you already own**.

Upload an image, pick a size, tell the planner how many 1×1 pieces of each color you have, and it produces a color-matched mosaic that never uses more bricks than your inventory allows. Then follow the row-by-row build guide or download the build files.

---

## Features

- **Drag-and-drop upload**: drop a file, click to browse, or paste an image from your clipboard.
- **Sizing that keeps proportions**: width presets (16 to 96 studs), aspect-ratio lock, and a live readout of brick count and physical size (1 stud = 8 mm).
- **Visual inventory editor**: set the count for each color next to its swatch. You don't need to write JSON, though you can still import and export it.
- **Custom colors**: pick any color with a color picker and give it a name.
- **Brick meter**: shows whether you have enough bricks before you generate.
- **Inventory-aware matching**: each stud gets the closest color you still have in stock. The most confident matches are placed first, so scarce colors go where they matter most.
- **Interactive preview**: switch between mosaic, original, and side-by-side views. Hover a stud to see its row, column, and color.
- **Build guide**: step through the mosaic row by row (arrow keys work too). Each row is grouped into runs such as `5× black, 3× blue`. The current row is highlighted on the mosaic, and you can click any row to jump to it.
- **Parts list**: shows how many bricks of each color the mosaic uses and how many are left over.
- **Export**: a ZIP with placements, written instructions, a parts list, and a preview image.
- **Remembers your setup**: inventory, custom colors, and size are saved in your browser.
- Light and dark themes (follows your system setting), and layouts for desktop and mobile.

## Quick start

Requires **Python 3.10+**.

```bash
git clone https://github.com/thatVaddiguy/lego_planner.git
cd lego_planner

python -m venv .venv
# Windows:      .venv\Scripts\activate
# macOS/Linux:  source .venv/bin/activate

pip install -r requirements.txt
python lego.py
```

Open **http://127.0.0.1:5000** in your browser.

## How to use

1. **Choose an image.** Simple images with bold shapes and good contrast work best.
2. **Set the size** in studs. With the link button on, the height follows the image's proportions.
3. **Enter your bricks.** The list shows the colors you have in stock. Tick *Show all colors* to add others, or use *Set all* to give every visible color the same count.
4. *(Optional)* **Add custom colors** under *Add a custom color*.
5. Check that the meter says **Enough bricks**, then click **Generate mosaic**.
6. Review the preview, parts list, and build guide.
7. Click **Download build files** to save everything as a ZIP.

### Tips for better results

- Fewer studs means a blockier image. 48 to 64 studs wide is usually enough for a recognizable portrait.
- If **Color match** shows *Fair* or *Rough*, your inventory is missing colors close to the ones in the image. Add a few custom colors or crop the image first.
- Having a few more bricks than you need gives the planner room to choose better colors.

## Built-in palette

| Name | RGB | Name | RGB |
|---|---|---|---|
| `black` | 27, 42, 52 | `brown` | 88, 57, 39 |
| `dark_blue` | 0, 57, 94 | `reddish_brown` | 105, 64, 39 |
| `blue` | 0, 85, 191 | `orange` | 254, 138, 24 |
| `medium_blue` | 90, 147, 219 | `dark_orange` | 169, 85, 0 |
| `light_blue` | 180, 210, 228 | `red` | 196, 40, 28 |
| `white` | 242, 243, 242 | `dark_red` | 114, 14, 15 |
| `light_gray` | 160, 165, 169 | `yellow` | 245, 205, 47 |
| `dark_gray` | 99, 95, 98 | `dark_green` | 24, 70, 50 |
| `tan` | 228, 205, 158 | `green` | 75, 151, 74 |
| `dark_tan` | 149, 138, 115 | `sand_green` | 120, 144, 130 |

To change the palette or the default inventory, edit `DEFAULT_COLORS` and `DEFAULT_INVENTORY` in `lego.py`. A custom color that reuses a built-in name replaces that built-in color.

## Importing and exporting inventory as JSON

Under **Import / export as JSON**, you can paste either a plain inventory:

```json
{ "black": 500, "dark_blue": 300, "white": 180 }
```

or an inventory together with custom colors:

```json
{
  "inventory": { "black": 200, "bright_pink": 120 },
  "custom_palette": { "bright_pink": [255, 105, 180] }
}
```

## Output files

The downloaded `lego_mosaic_plan.zip` contains:

| File | Contents |
|---|---|
| `instructions.txt` | Row-by-row build steps, grouped into runs (e.g. `5x white, 3x blue`) with column ranges |
| `parts_list.csv` | Bricks used, available, and left over for each color |
| `placements.csv` | One line per stud: `x`, `y`, color, source RGB, and match distance |
| `preview.png` | A rendered image of the mosaic |

Coordinates start at the top-left corner, which is `(0, 0)`.

## How it works

1. The image is resized to `width × height` pixels, one pixel per stud. Transparent areas become white.
2. For every pixel, each color in the inventory is ranked by a weighted RGB distance, `sqrt(2·ΔR² + 4·ΔG² + 3·ΔB²)`, which roughly matches how sensitive the eye is to each channel.
3. Pixels are ordered by *confidence*, meaning how much better their best color is than their second best.
4. Each pixel, in that order, gets the closest color that still has bricks left. Pixels with one clear best color are assigned first. Ambiguous pixels absorb shortages by falling back to their next-best color.

## API

The UI uses two JSON endpoints, which you can also call directly.

### `POST /api/plan` (multipart form)

| Field | Description |
|---|---|
| `image` | Image file (max 20 MB) |
| `width`, `height` | Size in studs, 1–256 |
| `inventory` | JSON object `{ "color": count }` |
| `custom_palette` | Optional JSON object `{ "name": [r, g, b] }` |

Returns `preview_base64`, `assignments`, `summary`, `width`, `height`, and `palette`.

```bash
curl -F image=@photo.jpg -F width=48 -F height=36 \
     -F 'inventory={"black":800,"white":800,"blue":800}' \
     http://127.0.0.1:5000/api/plan
```

### `POST /api/export` (JSON)

Takes `width`, `height`, `assignments`, `inventory`, and `custom_palette` as returned or used by `/api/plan`. Returns the ZIP file.

If a request fails validation, both endpoints return HTTP `400` with `{ "error": "..." }`. The checks are:

- the size must be 1–256 studs
- the JSON must be valid
- every color in the inventory must exist in the palette
- counts must be 0 or more
- RGB values must be between 0 and 255
- the inventory must have at least `width × height` bricks

## Project structure

```text
lego.py               Flask app: palette, color matching, planning, export endpoints
templates/index.html  Page markup
static/style.css      Styles (light/dark themes, responsive layout)
static/app.js         Front-end logic: upload, inventory editor, preview, build guide
requirements.txt      Python dependencies (Flask, Pillow)
```

## License

No license has been chosen yet. Add a `LICENSE` file if you plan to share or accept contributions.

*LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize, or endorse this project.*
