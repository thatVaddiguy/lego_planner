from __future__ import annotations

import base64
import csv
import io
import json
import math
import zipfile
from dataclasses import dataclass
from typing import Any, Dict, List, Tuple

from flask import Flask, jsonify, render_template, request, send_file
from PIL import Image, ImageDraw, UnidentifiedImageError

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024  # 20 MB upload limit

MAX_DIMENSION = 256  # studs per side
STUD_SIZE_CM = 0.8   # one LEGO stud is 8 mm


try:
    RESAMPLE_LANCZOS = Image.Resampling.LANCZOS
except AttributeError:
    RESAMPLE_LANCZOS = Image.LANCZOS


# --- Editable LEGO-like palette -------------------------------------------------
DEFAULT_COLORS: Dict[str, Tuple[int, int, int]] = {
    "black": (27, 42, 52),
    "dark_blue": (0, 57, 94),
    "blue": (0, 85, 191),
    "medium_blue": (90, 147, 219),
    "light_blue": (180, 210, 228),
    "white": (242, 243, 242),
    "light_gray": (160, 165, 169),
    "dark_gray": (99, 95, 98),
    "tan": (228, 205, 158),
    "dark_tan": (149, 138, 115),
    "brown": (88, 57, 39),
    "reddish_brown": (105, 64, 39),
    "orange": (254, 138, 24),
    "dark_orange": (169, 85, 0),
    "red": (196, 40, 28),
    "dark_red": (114, 14, 15),
    "yellow": (245, 205, 47),
    "dark_green": (24, 70, 50),
    "green": (75, 151, 74),
    "sand_green": (120, 144, 130),
}

DEFAULT_INVENTORY: Dict[str, int] = {
    "black": 500,
    "dark_blue": 300,
    "blue": 250,
    "light_blue": 120,
    "white": 180,
    "light_gray": 200,
    "dark_gray": 150,
    "tan": 80,
    "brown": 50,
    "orange": 40,
}


@dataclass(frozen=True)
class BrickColor:
    name: str
    rgb: Tuple[int, int, int]
    count: int


def srgb_distance(a: Tuple[int, int, int], b: Tuple[int, int, int]) -> float:
    dr = a[0] - b[0]
    dg = a[1] - b[1]
    db = a[2] - b[2]
    return math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db)


def normalize_rgb(value: Any, color_name: str) -> Tuple[int, int, int]:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError(f"Palette color '{color_name}' must be an RGB array like [255, 0, 0].")

    normalized: List[int] = []
    for channel in value:
        try:
            channel_int = int(channel)
        except (TypeError, ValueError):
            raise ValueError(f"Palette color '{color_name}' must use whole-number RGB values.") from None
        if channel_int < 0 or channel_int > 255:
            raise ValueError(f"Palette color '{color_name}' must use RGB values between 0 and 255.")
        normalized.append(channel_int)
    return tuple(normalized)  # type: ignore[return-value]


def load_custom_palette(data: Any) -> Dict[str, Tuple[int, int, int]]:
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ValueError("Custom palette must be a JSON object mapping color names to RGB arrays.")

    palette: Dict[str, Tuple[int, int, int]] = {}
    for raw_name, rgb in data.items():
        if not isinstance(raw_name, str):
            raise ValueError("Custom palette color names must be strings.")
        name = raw_name.strip()
        if not name:
            raise ValueError("Custom palette color names cannot be empty.")
        palette[name] = normalize_rgb(rgb, name)
    return palette


def build_palette(custom_palette: Dict[str, Tuple[int, int, int]] | None = None) -> Dict[str, Tuple[int, int, int]]:
    merged = dict(DEFAULT_COLORS)
    if custom_palette:
        merged.update(custom_palette)
    return merged


def load_inventory(data: Dict[str, int], palette: Dict[str, Tuple[int, int, int]]) -> List[BrickColor]:
    if not isinstance(data, dict):
        raise ValueError("Inventory must be a JSON object mapping color names to counts.")
    colors: List[BrickColor] = []
    for name, count in data.items():
        if name not in palette:
            raise ValueError(f"Color '{name}' is not in the palette.")
        try:
            count_int = int(count)
        except (TypeError, ValueError):
            raise ValueError(f"Count for color '{name}' must be a whole number.") from None
        if count_int < 0:
            raise ValueError(f"Count for color '{name}' must be >= 0.")
        if count_int == 0:
            continue
        colors.append(BrickColor(name=name, rgb=palette[name], count=count_int))
    if not colors:
        raise ValueError("Inventory is empty. Add at least one color with a count above zero.")
    return colors


def parse_dimension(value: Any, label: str) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label} must be a whole number.") from None
    if number <= 0:
        raise ValueError("Width and height must be positive integers.")
    if number > MAX_DIMENSION:
        raise ValueError(f"{label} cannot be larger than {MAX_DIMENSION} studs.")
    return number


def resize_image(image: Image.Image, width: int, height: int) -> Image.Image:
    if width <= 0 or height <= 0:
        raise ValueError("Width and height must be positive integers.")
    if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
        # Flatten transparency onto white so transparent areas don't turn black.
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        image = Image.alpha_composite(background, rgba)
    return image.convert("RGB").resize((width, height), RESAMPLE_LANCZOS)


def compute_preferences(image: Image.Image, colors: List[BrickColor]) -> List[Dict[str, object]]:
    prefs: List[Dict[str, object]] = []
    ranking_cache: Dict[Tuple[int, int, int], List[Tuple[str, float]]] = {}
    w, h = image.size
    for y in range(h):
        for x in range(w):
            pixel = image.getpixel((x, y))
            ranked = ranking_cache.get(pixel)
            if ranked is None:
                ranked = sorted(
                    ((c.name, srgb_distance(pixel, c.rgb)) for c in colors),
                    key=lambda t: t[1],
                )
                ranking_cache[pixel] = ranked
            best = ranked[0][1]
            second = ranked[1][1] if len(ranked) > 1 else ranked[0][1]
            prefs.append(
                {
                    "x": x,
                    "y": y,
                    "pixel": pixel,
                    "ranked": ranked,
                    "confidence": second - best,
                }
            )
    return prefs


def assign_colors(preferences: List[Dict[str, object]], colors: List[BrickColor]) -> List[Dict[str, object]]:
    remaining = {c.name: c.count for c in colors}
    total_capacity = sum(remaining.values())
    if total_capacity < len(preferences):
        raise ValueError(
            f"Not enough bricks. Need {len(preferences)}, but inventory only has {total_capacity}."
        )

    ordered = sorted(preferences, key=lambda p: p["confidence"], reverse=True)
    assignments: List[Dict[str, object]] = []

    for p in ordered:
        ranked = p["ranked"]
        chosen_name = None
        chosen_dist = None
        for color_name, dist in ranked:
            if remaining[color_name] > 0:
                chosen_name = color_name
                chosen_dist = dist
                break
        if chosen_name is None:
            raise RuntimeError("No remaining color available, but capacity check passed.")
        remaining[chosen_name] -= 1
        assignments.append(
            {
                "x": p["x"],
                "y": p["y"],
                "source_rgb": p["pixel"],
                "assigned_color": chosen_name,
                "distance": chosen_dist,
            }
        )

    assignments.sort(key=lambda a: (a["y"], a["x"]))
    return assignments


def build_preview(assignments: List[Dict[str, object]], colors: List[BrickColor], width: int, height: int, cell_size: int = 20) -> Image.Image:
    color_map = {c.name: c.rgb for c in colors}
    img = Image.new("RGB", (width * cell_size, height * cell_size), (30, 30, 30))
    draw = ImageDraw.Draw(img)

    for a in assignments:
        x = int(a["x"])
        y = int(a["y"])
        color = tuple(color_map[str(a["assigned_color"])])
        x0 = x * cell_size
        y0 = y * cell_size
        x1 = x0 + cell_size - 1
        y1 = y0 + cell_size - 1
        draw.rectangle([x0, y0, x1, y1], fill=color)

        # Shade the stud relative to the brick color so it reads on light and dark bricks.
        luminance = 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2]
        shift = -40 if luminance > 140 else 45
        stud = tuple(max(0, min(255, c + shift)) for c in color)
        inset = max(2, cell_size // 5)
        draw.ellipse(
            [x0 + inset, y0 + inset, x1 - inset, y1 - inset],
            outline=stud,
            width=max(1, cell_size // 12),
        )
    return img


def preview_to_base64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def assignments_to_csv_bytes(assignments: List[Dict[str, object]]) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["x", "y", "color", "source_rgb", "match_distance"])
    for a in assignments:
        writer.writerow([a["x"], a["y"], a["assigned_color"], a["source_rgb"], round(float(a["distance"]), 2)])
    return buf.getvalue().encode("utf-8")


def parts_list_csv_bytes(summary: List[Dict[str, int | str]], palette: Dict[str, Tuple[int, int, int]]) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["color", "rgb", "used", "available", "remaining"])
    for row in sorted(summary, key=lambda r: -int(r["used"])):
        rgb = palette.get(str(row["color"]), (0, 0, 0))
        writer.writerow([row["color"], list(rgb), row["used"], row["available"], row["remaining"]])
    return buf.getvalue().encode("utf-8")


def row_runs(row: List[str]) -> List[Tuple[str, int]]:
    """Collapse a row of colors into (color, count) runs: a a b -> [(a, 2), (b, 1)]."""
    runs: List[Tuple[str, int]] = []
    for color in row:
        if runs and runs[-1][0] == color:
            runs[-1] = (color, runs[-1][1] + 1)
        else:
            runs.append((color, 1))
    return runs


def instructions_txt(assignments: List[Dict[str, object]], width: int, height: int) -> str:
    grid = [[None for _ in range(width)] for _ in range(height)]
    for a in assignments:
        grid[int(a["y"])][int(a["x"])] = str(a["assigned_color"])

    lines: List[str] = [
        "LEGO Mosaic Build Instructions",
        f"Size: {width} x {height} studs "
        f"({width * STUD_SIZE_CM:.1f} cm x {height * STUD_SIZE_CM:.1f} cm), {width * height} bricks total.",
        "Build each row from left to right, starting at the top.",
        "Coordinates are zero-based from the top-left corner: (x, y).",
        "",
    ]
    for y in range(height):
        runs = row_runs(grid[y])
        lines.append(f"Row {y + 1} of {height}  (y={y})")
        lines.append("  " + ", ".join(f"{count}x {color}" for color, count in runs))
        detail = []
        x = 0
        for color, count in runs:
            span = f"x={x}" if count == 1 else f"x={x}-{x + count - 1}"
            detail.append(f"{span}: {color}")
            x += count
        lines.append("  " + "; ".join(detail))
        lines.append("")
    return "\n".join(lines)


def usage_summary(assignments: List[Dict[str, object]], colors: List[BrickColor]) -> List[Dict[str, int | str]]:
    used: Dict[str, int] = {c.name: 0 for c in colors}
    available: Dict[str, int] = {c.name: c.count for c in colors}
    for a in assignments:
        used[str(a["assigned_color"])] += 1
    return [
        {
            "color": c.name,
            "used": used[c.name],
            "available": available[c.name],
            "remaining": available[c.name] - used[c.name],
        }
        for c in colors
    ]


def parse_json_field(raw: str, label: str) -> Any:
    try:
        return json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        raise ValueError(f"{label} is not valid JSON: {e.msg} (line {e.lineno}, column {e.colno}).") from None


@app.get("/")
def index():
    return render_template(
        "index.html",
        config_json=json.dumps(
            {
                "palette": DEFAULT_COLORS,
                "inventory": DEFAULT_INVENTORY,
                "maxDimension": MAX_DIMENSION,
                "studSizeCm": STUD_SIZE_CM,
            }
        ),
    )


@app.errorhandler(413)
def too_large(_e):
    return jsonify({"error": "That image is too large. Please upload a file under 20 MB."}), 413


@app.post("/api/plan")
def plan():
    try:
        if "image" not in request.files or not request.files["image"].filename:
            return jsonify({"error": "Missing image upload."}), 400

        image_file = request.files["image"]
        width = parse_dimension(request.form.get("width", "48"), "Width")
        height = parse_dimension(request.form.get("height", "48"), "Height")
        inventory_json = parse_json_field(request.form.get("inventory", "{}"), "Inventory")
        custom_palette_json = parse_json_field(request.form.get("custom_palette", "{}"), "Custom palette")
        palette = build_palette(load_custom_palette(custom_palette_json))

        try:
            image = Image.open(image_file.stream)
            image.load()
        except (UnidentifiedImageError, OSError):
            raise ValueError("Could not read the uploaded file as an image. Try a PNG or JPEG.") from None

        inventory = load_inventory(inventory_json, palette)
        resized = resize_image(image, width, height)
        preferences = compute_preferences(resized, inventory)
        assignments = assign_colors(preferences, inventory)
        preview = build_preview(assignments, inventory, width, height)

        return jsonify(
            {
                "preview_base64": preview_to_base64(preview),
                "assignments": assignments,
                "summary": usage_summary(assignments, inventory),
                "width": width,
                "height": height,
                "palette": palette,
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.post("/api/export")
def export_files():
    try:
        payload = request.get_json(force=True)
        width = parse_dimension(payload["width"], "Width")
        height = parse_dimension(payload["height"], "Height")
        assignments = payload["assignments"]
        inventory_json = payload["inventory"]
        custom_palette_json = payload.get("custom_palette", {})

        palette = build_palette(load_custom_palette(custom_palette_json))
        inventory = load_inventory(inventory_json, palette)
        preview = build_preview(assignments, inventory, width, height)
        csv_bytes = assignments_to_csv_bytes(assignments)
        txt_bytes = instructions_txt(assignments, width, height).encode("utf-8")
        parts_bytes = parts_list_csv_bytes(usage_summary(assignments, inventory), palette)

        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("placements.csv", csv_bytes)
            zf.writestr("instructions.txt", txt_bytes)
            zf.writestr("parts_list.csv", parts_bytes)
            preview_buf = io.BytesIO()
            preview.save(preview_buf, format="PNG")
            zf.writestr("preview.png", preview_buf.getvalue())

        zip_buffer.seek(0)
        return send_file(
            zip_buffer,
            mimetype="application/zip",
            as_attachment=True,
            download_name="lego_mosaic_plan.zip",
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 400


if __name__ == "__main__":
    app.run(debug=True)
