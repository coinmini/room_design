from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def make_material(
    name: str,
    color: tuple[float, float, float, float],
    *,
    roughness: float = 0.65,
    metallic: float = 0.0,
):
    value = bpy.data.materials.new(name)
    value.diffuse_color = color
    value.use_nodes = True
    shader = value.node_tree.nodes.get("Principled BSDF")
    if shader:
        shader.inputs["Base Color"].default_value = color
        shader.inputs["Roughness"].default_value = roughness
        shader.inputs["Metallic"].default_value = metallic
    return value


def add_surface_detail(value, kind: str):
    nodes = value.node_tree.nodes
    links = value.node_tree.links
    shader = nodes.get("Principled BSDF")
    if not shader:
        return
    coordinates = nodes.new("ShaderNodeTexCoord")
    noise = nodes.new("ShaderNodeTexNoise")
    bump = nodes.new("ShaderNodeBump")
    settings = {
        "wood": (4.2, 5.0, 0.62, 0.13, 0.075),
        "fabric": (92.0, 2.2, 0.72, 0.12, 0.018),
        "stone": (7.0, 4.0, 0.58, 0.10, 0.045),
        "wall": (68.0, 2.0, 0.55, 0.055, 0.012),
    }
    scale, detail, roughness, strength, distance = settings[kind]
    noise.inputs["Scale"].default_value = scale
    noise.inputs["Detail"].default_value = detail
    noise.inputs["Roughness"].default_value = roughness
    bump.inputs["Strength"].default_value = strength
    bump.inputs["Distance"].default_value = distance
    links.new(coordinates.outputs["Generated"], noise.inputs["Vector"])
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], shader.inputs["Normal"])
    if kind == "wood":
        ramp = nodes.new("ShaderNodeValToRGB")
        base = tuple(value.diffuse_color)
        ramp.color_ramp.elements[0].color = (
            max(0, base[0] * 0.58),
            max(0, base[1] * 0.56),
            max(0, base[2] * 0.52),
            1,
        )
        ramp.color_ramp.elements[1].color = (
            min(1, base[0] * 1.28 + 0.04),
            min(1, base[1] * 1.25 + 0.03),
            min(1, base[2] * 1.18 + 0.02),
            1,
        )
        links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
        links.new(ramp.outputs["Color"], shader.inputs["Base Color"])


def box(
    name: str,
    location: tuple[float, float, float],
    size: tuple[float, float, float],
    value,
    *,
    rotation_z: float = 0.0,
    bevel: float = 0.0,
):
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    obj.rotation_euler[2] = rotation_z
    obj.data.materials.append(value)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel > 0:
        modifier = obj.modifiers.new("Soft edges", "BEVEL")
        modifier.width = min(bevel, min(size) * 0.24)
        modifier.segments = 2
    return obj


def cylinder(
    name: str,
    location: tuple[float, float, float],
    radius: float,
    depth: float,
    value,
):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=32,
        radius=radius,
        depth=depth,
        location=location,
    )
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(value)
    bevel = obj.modifiers.new("Soft edges", "BEVEL")
    bevel.width = min(0.025, radius * 0.22, depth * 0.12)
    bevel.segments = 2
    return obj


def sphere(
    name: str,
    location: tuple[float, float, float],
    radius: float,
    value,
    *,
    scale: tuple[float, float, float] = (1, 1, 1),
):
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=24,
        ring_count=12,
        radius=radius,
        location=location,
    )
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    obj.data.materials.append(value)
    return obj


def look_at(obj, target: tuple[float, float, float]):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


args = sys.argv[sys.argv.index("--") + 1 :]
payload = json.loads(Path(args[0]).read_text(encoding="utf-8"))
output = Path(args[1])
view_mode = args[2]
dollhouse_modes = {"dollhouse", "semantic", "depth", "normal"}

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

bounds = payload["detected_bounds"]
plan_width = payload["plan_width_mm"] / 1000
plan_depth = payload["plan_depth_mm"] / 1000
wall_height = payload["ceiling_height_mm"] / 1000
wall_thickness = payload["wall_thickness_mm"] / 1000
layout_preset = payload.get("layout_preset_id", "auto")
if layout_preset == "auto":
    layout_preset = "two_bedroom" if plan_width >= 7.0 else "one_bedroom"
furniture_scale = max(
    0.62,
    min(1.28, min(plan_width / 8.15, plan_depth / 6.06)),
)
semantic_layout = payload.get("semantic_layout", payload.get("semanticLayout"))
use_semantic_layout = isinstance(semantic_layout, dict)
semantic_rooms = semantic_layout.get("rooms", []) if use_semantic_layout else []
semantic_openings = semantic_layout.get("openings", []) if use_semantic_layout else []
semantic_furniture = semantic_layout.get("furniture", []) if use_semantic_layout else []
semantic_walls = semantic_layout.get("walls", []) if use_semantic_layout else []


def pixel_to_scene(x: float, y: float) -> tuple[float, float]:
    x_ratio = (x - bounds["x"]) / bounds["width"]
    y_ratio = (y - bounds["y"]) / bounds["height"]
    return (
        x_ratio * plan_width - plan_width / 2,
        plan_depth / 2 - y_ratio * plan_depth,
    )


def normalized_to_scene(x_ratio: float, y_ratio: float) -> tuple[float, float]:
    return (
        x_ratio * plan_width - plan_width / 2,
        plan_depth / 2 - y_ratio * plan_depth,
    )


def point_value(value) -> tuple[float, float] | None:
    if isinstance(value, dict) and "xMm" in value and "yMm" in value:
        return (
            bounds["x"] + float(value["xMm"]) / payload["plan_width_mm"] * bounds["width"],
            bounds["y"] + float(value["yMm"]) / payload["plan_depth_mm"] * bounds["height"],
        )
    if isinstance(value, dict) and "x" in value and "y" in value:
        return float(value["x"]), float(value["y"])
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        return float(value[0]), float(value[1])
    return None


def polygon_value(item: dict) -> list[tuple[float, float]]:
    polygon = item.get("polygon", item.get("footprint", []))
    points = [point_value(value) for value in polygon]
    valid = [value for value in points if value is not None]
    if len(valid) >= 3:
        return valid

    rectangle = item.get("bbox", item.get("bounds", item.get("rect", {})))
    if isinstance(rectangle, dict):
        if all(key in rectangle for key in ("xMm", "yMm", "widthMm", "depthMm")):
            first = point_value({"xMm": rectangle["xMm"], "yMm": rectangle["yMm"]})
            second = point_value(
                {
                    "xMm": float(rectangle["xMm"]) + float(rectangle["widthMm"]),
                    "yMm": float(rectangle["yMm"]) + float(rectangle["depthMm"]),
                }
            )
            if first is not None and second is not None:
                return [
                    first,
                    (second[0], first[1]),
                    second,
                    (first[0], second[1]),
                ]
        x = rectangle.get("x")
        y = rectangle.get("y")
        width = rectangle.get("width")
        height = rectangle.get("height", rectangle.get("depth"))
        if None not in (x, y, width, height):
            return [
                (float(x), float(y)),
                (float(x) + float(width), float(y)),
                (float(x) + float(width), float(y) + float(height)),
                (float(x), float(y) + float(height)),
            ]
    return []


def semantic_name(item: dict) -> str:
    value = (
        item.get("category")
        or item.get("type")
        or item.get("semantic")
        or item.get("label")
        or item.get("name")
        or "unknown"
    )
    return str(value).strip().lower().replace("-", "_").replace(" ", "_")


def furniture_center(item: dict) -> tuple[float, float]:
    center = point_value(item.get("center"))
    if center is None:
        polygon = polygon_value(item)
        if polygon:
            center = (
                sum(point[0] for point in polygon) / len(polygon),
                sum(point[1] for point in polygon) / len(polygon),
            )
    if center is None and "x" in item and "y" in item:
        center = (float(item["x"]), float(item["y"]))
    if center is None and "xMm" in item and "yMm" in item:
        center = point_value({"xMm": item["xMm"], "yMm": item["yMm"]})
    if center is None:
        center = (
            bounds["x"] + bounds["width"] / 2,
            bounds["y"] + bounds["height"] / 2,
        )
    return pixel_to_scene(*center)


def wall_pixel_points(wall: dict) -> tuple[tuple[float, float], tuple[float, float]] | None:
    start = point_value(wall.get("start"))
    end = point_value(wall.get("end"))
    if start is not None and end is not None:
        return start, end
    if all(key in wall for key in ("x1", "y1", "x2", "y2")):
        return (
            (float(wall["x1"]), float(wall["y1"])),
            (float(wall["x2"]), float(wall["y2"])),
        )
    return None


def furniture_size(
    item: dict,
    default: tuple[float, float],
) -> tuple[float, float]:
    size = item.get("size", {})
    if not isinstance(size, dict):
        size = {}
    width_mm = size.get("widthMm", item.get("widthMm"))
    depth_mm = size.get("depthMm", item.get("depthMm"))
    if width_mm is not None and depth_mm is not None:
        return float(width_mm) / 1000, float(depth_mm) / 1000

    width = size.get("width", item.get("width"))
    depth = size.get(
        "depth",
        size.get("height", item.get("depth", item.get("height"))),
    )
    if width is not None and depth is not None:
        return (
            max(0.08, float(width) / bounds["width"] * plan_width),
            max(0.08, float(depth) / bounds["height"] * plan_depth),
        )

    polygon = polygon_value(item)
    if polygon:
        xs = [point[0] for point in polygon]
        ys = [point[1] for point in polygon]
        return (
            max(0.08, (max(xs) - min(xs)) / bounds["width"] * plan_width),
            max(0.08, (max(ys) - min(ys)) / bounds["height"] * plan_depth),
        )
    return default


def furniture_rotation(item: dict) -> float:
    degrees = item.get(
        "rotationDeg",
        item.get("rotation_deg", item.get("rotation", 0)),
    )
    return math.radians(-float(degrees or 0))


def local_point(
    center: tuple[float, float],
    dx: float,
    dy: float,
    rotation_z: float,
) -> tuple[float, float]:
    return (
        center[0] + dx * math.cos(rotation_z) - dy * math.sin(rotation_z),
        center[1] + dx * math.sin(rotation_z) + dy * math.cos(rotation_z),
    )


style_preset_id = str(payload.get("style_preset_id", "modern_warm_v1"))
style_palettes = {
    "modern_warm_v1": {
        "label": "Modern warm",
        "wall": (0.91, 0.89, 0.84, 1),
        "wall_top": (0.98, 0.97, 0.93, 1),
        "floor": (0.47, 0.29, 0.16, 1),
        "floor_light": (0.67, 0.48, 0.29, 1),
        "wood": (0.25, 0.12, 0.065, 1),
        "fabric": (0.47, 0.45, 0.41, 1),
        "fabric_light": (0.83, 0.78, 0.69, 1),
    },
    "modern_minimal_v1": {
        "label": "Modern minimal",
        "wall": (0.94, 0.945, 0.94, 1),
        "wall_top": (0.985, 0.985, 0.98, 1),
        "floor": (0.62, 0.57, 0.49, 1),
        "floor_light": (0.76, 0.72, 0.65, 1),
        "wood": (0.48, 0.42, 0.34, 1),
        "fabric": (0.50, 0.52, 0.53, 1),
        "fabric_light": (0.82, 0.83, 0.82, 1),
    },
    "natural_wood_v1": {
        "label": "Natural wood",
        "wall": (0.93, 0.90, 0.82, 1),
        "wall_top": (0.98, 0.95, 0.88, 1),
        "floor": (0.58, 0.36, 0.17, 1),
        "floor_light": (0.74, 0.52, 0.28, 1),
        "wood": (0.42, 0.22, 0.09, 1),
        "fabric": (0.55, 0.48, 0.38, 1),
        "fabric_light": (0.88, 0.80, 0.66, 1),
    },
}
style_palette = style_palettes.get(
    style_preset_id,
    style_palettes["modern_warm_v1"],
)
style_label = str(style_palette["label"])

materials = {
    "wall": make_material(
        f"Wall · {style_label}",
        style_palette["wall"],
        roughness=0.8,
    ),
    "wall_top": make_material(
        f"Wall cap · {style_label}",
        style_palette["wall_top"],
        roughness=0.78,
    ),
    "floor": make_material(
        f"Floor · {style_label}",
        style_palette["floor"],
        roughness=0.58,
    ),
    "floor_light": make_material(
        f"Light floor · {style_label}",
        style_palette["floor_light"],
        roughness=0.62,
    ),
    "tile": make_material("Warm stone", (0.67, 0.64, 0.58, 1), roughness=0.72),
    "tile_dark": make_material("Dark stone", (0.23, 0.25, 0.24, 1), roughness=0.66),
    "rug": make_material("Woven rug", (0.77, 0.68, 0.55, 1), roughness=0.92),
    "fabric": make_material(
        f"Fabric · {style_label}",
        style_palette["fabric"],
        roughness=0.9,
    ),
    "fabric_light": make_material(
        f"Light fabric · {style_label}",
        style_palette["fabric_light"],
        roughness=0.92,
    ),
    "accent": make_material("Accent blue", (0.18, 0.36, 0.46, 1), roughness=0.84),
    "accent_warm": make_material("Ochre accent", (0.68, 0.36, 0.10, 1), roughness=0.82),
    "wood": make_material(
        f"Woodwork · {style_label}",
        style_palette["wood"],
        roughness=0.56,
    ),
    "white": make_material("Furniture white", (0.88, 0.87, 0.82, 1), roughness=0.64),
    "dark": make_material("Graphite", (0.055, 0.065, 0.068, 1), roughness=0.5),
    "metal": make_material("Brushed metal", (0.25, 0.27, 0.28, 1), roughness=0.33, metallic=0.65),
    "glass": make_material("Window glass", (0.31, 0.48, 0.56, 1), roughness=0.18, metallic=0.08),
    "green": make_material("Plant leaves", (0.16, 0.31, 0.14, 1), roughness=0.88),
    "selected": make_material("Selected room", (0.30, 0.62, 0.55, 1), roughness=0.78),
    "ground": make_material("Studio ground", (0.92, 0.92, 0.90, 1), roughness=0.94),
}
for key in ("floor", "floor_light", "wood"):
    add_surface_detail(materials[key], "wood")
for key in ("rug", "fabric", "fabric_light"):
    add_surface_detail(materials[key], "fabric")
for key in ("tile", "tile_dark"):
    add_surface_detail(materials[key], "stone")
add_surface_detail(materials["wall"], "wall")


box(
    "Studio ground",
    (0, 0, -0.16),
    (plan_width * 2.8, plan_depth * 2.8, 0.08),
    materials["ground"],
)
box(
    "Floor slab",
    (0, 0, -0.055),
    (plan_width, plan_depth, 0.11),
    materials["floor"],
)


def add_floor_zone(
    name: str,
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    value,
):
    first = normalized_to_scene(x1, y1)
    second = normalized_to_scene(x2, y2)
    box(
        name,
        ((first[0] + second[0]) / 2, (first[1] + second[1]) / 2, 0.012),
        (abs(second[0] - first[0]), abs(second[1] - first[1]), 0.024),
        value,
    )


def add_room_floor(name: str, polygon: list[tuple[float, float]], value):
    scene_points = [pixel_to_scene(*point) for point in polygon]
    mesh = bpy.data.meshes.new(name + " mesh")
    mesh.from_pydata(
        [(point[0], point[1], 0.018) for point in scene_points],
        [],
        [list(range(len(scene_points)))],
    )
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(value)
    return obj


def room_floor_material(room_data: dict):
    room_type = semantic_name(room_data)
    if any(token in room_type for token in ("bath", "toilet", "wc", "卫生间", "浴室")):
        return materials["tile"]
    if any(token in room_type for token in ("kitchen", "厨房")):
        return materials["tile"]
    if any(token in room_type for token in ("bed", "卧室", "主卧", "次卧")):
        return materials["floor_light"]
    return materials["floor"]


if view_mode in dollhouse_modes | {"interior"}:
    if use_semantic_layout:
        for index, room_data in enumerate(semantic_rooms):
            polygon = polygon_value(room_data)
            if polygon:
                add_room_floor(
                    f"{semantic_name(room_data).title()} floor {index}",
                    polygon,
                    room_floor_material(room_data),
                )
    else:
        # Legacy soft-furnishing zones retained for pre-V0.4 scene payloads.
        add_floor_zone("Bedroom floor left", 0.025, 0.025, 0.355, 0.455, materials["floor_light"])
        add_floor_zone("Bedroom floor center", 0.36, 0.025, 0.715, 0.455, materials["floor_light"])
        add_floor_zone("Bathroom floor", 0.72, 0.025, 0.985, 0.44, materials["tile_dark"])
        add_floor_zone("Living floor", 0.025, 0.46, 0.785, 0.975, materials["floor"])
        add_floor_zone("Kitchen floor", 0.79, 0.445, 0.985, 0.975, materials["tile"])


def render_wall_height(wall: dict) -> float:
    if view_mode == "topdown":
        return min(0.58, wall_height)
    if view_mode not in dollhouse_modes:
        return wall_height

    points = wall_pixel_points(wall)
    if points is None:
        return min(0.92, wall_height) if use_semantic_layout else wall_height
    start, end = points
    middle_x = ((start[0] + end[0]) / 2 - bounds["x"]) / bounds["width"]
    middle_y = ((start[1] + end[1]) / 2 - bounds["y"]) / bounds["height"]
    if use_semantic_layout:
        # The V0.4 camera is almost top-down. Low, even cutaway walls expose the
        # semantic furniture while preserving every confirmed wall centerline.
        if middle_y > 0.86:
            return min(0.32, wall_height)
        if middle_x > 0.94:
            return min(0.48, wall_height)
        return min(0.92, wall_height)
    # Camera looks from the lower-right. Lower those two foreground edges and
    # keep the rear shell tall to create the architectural dollhouse cutaway.
    if middle_y > 0.84 or middle_x > 0.89:
        return min(0.34, wall_height)
    if middle_y < 0.13 or middle_x < 0.12:
        return wall_height
    return min(1.38, wall_height)


wall_objects = []
wall_source = semantic_walls if use_semantic_layout and semantic_walls else payload["walls"]
for index, wall in enumerate(wall_source):
    points = wall_pixel_points(wall)
    if points is None:
        continue
    start_x, start_y = pixel_to_scene(*points[0])
    end_x, end_y = pixel_to_scene(*points[1])
    dx, dy = end_x - start_x, end_y - start_y
    length = math.hypot(dx, dy)
    if length < 0.05:
        continue
    height = render_wall_height(wall)
    center = ((start_x + end_x) / 2, (start_y + end_y) / 2, height / 2)
    item = box(
        f"Wall_{index:03d}",
        center,
        (
            length,
            float(wall.get("thicknessMm", wall_thickness * 1000)) / 1000,
            height,
        ),
        materials["wall"],
        rotation_z=math.atan2(dy, dx),
        bevel=0.015,
    )
    wall_objects.append((item, (start_x, start_y), (end_x, end_y)))


room = payload["room_selection"]
room_first = pixel_to_scene(room["x"], room["y"])
room_second = pixel_to_scene(
    room["x"] + room["width"],
    room["y"] + room["height"],
)
room_min_x, room_max_x = sorted((room_first[0], room_second[0]))
room_min_y, room_max_y = sorted((room_first[1], room_second[1]))
room_center = (
    (room_min_x + room_max_x) / 2,
    (room_min_y + room_max_y) / 2,
)


def add_bed(
    name: str,
    x_ratio: float,
    y_ratio: float,
    *,
    rotation_z: float = 0.0,
    accent=None,
):
    center = normalized_to_scene(x_ratio, y_ratio)
    width = 1.55 * furniture_scale
    depth = 2.0 * furniture_scale
    box(
        name + " base",
        (center[0], center[1], 0.18),
        (width, depth, 0.32),
        materials["wood"],
        rotation_z=rotation_z,
        bevel=0.05,
    )
    box(
        name + " mattress",
        (center[0], center[1], 0.39),
        (width * 0.96, depth * 0.96, 0.25),
        materials["white"],
        rotation_z=rotation_z,
        bevel=0.08,
    )
    head = local_point(center, 0, depth * 0.49, rotation_z)
    box(
        name + " headboard",
        (head[0], head[1], 0.72),
        (width + 0.12, 0.12, 1.0),
        materials["fabric"],
        rotation_z=rotation_z,
        bevel=0.05,
    )
    blanket_center = local_point(center, 0, -depth * 0.18, rotation_z)
    box(
        name + " blanket",
        (blanket_center[0], blanket_center[1], 0.545),
        (width * 0.91, depth * 0.44, 0.065),
        accent or materials["accent"],
        rotation_z=rotation_z,
        bevel=0.025,
    )
    for side in (-1, 1):
        pillow_center = local_point(center, side * width * 0.25, depth * 0.29, rotation_z)
        box(
            name + f" pillow {side}",
            (pillow_center[0], pillow_center[1], 0.56),
            (width * 0.38, depth * 0.23, 0.16),
            materials["fabric_light"],
            rotation_z=rotation_z,
            bevel=0.07,
        )
        table_center = local_point(center, side * (width * 0.67), depth * 0.27, rotation_z)
        box(
            name + f" nightstand {side}",
            (table_center[0], table_center[1], 0.25),
            (0.4, 0.4, 0.5),
            materials["wood"],
            rotation_z=rotation_z,
            bevel=0.035,
        )


def add_sofa(name: str, x_ratio: float, y_ratio: float):
    center = normalized_to_scene(x_ratio, y_ratio)
    width = 2.35 * furniture_scale
    depth = 0.88 * furniture_scale
    box(
        name + " base",
        (center[0], center[1], 0.24),
        (width, depth, 0.34),
        materials["dark"],
        bevel=0.08,
    )
    box(
        name + " seat",
        (center[0], center[1] + depth * 0.07, 0.47),
        (width * 0.86, depth * 0.76, 0.23),
        materials["fabric_light"],
        bevel=0.09,
    )
    box(
        name + " back",
        (center[0], center[1] - depth * 0.42, 0.76),
        (width, 0.19, 0.82),
        materials["fabric"],
        bevel=0.08,
    )
    for side in (-1, 1):
        box(
            name + f" arm {side}",
            (center[0] + side * width * 0.46, center[1], 0.57),
            (0.2, depth, 0.62),
            materials["fabric"],
            bevel=0.07,
        )
    for index, side in enumerate((-0.3, 0.3)):
        box(
            name + f" cushion {index}",
            (center[0] + side * width, center[1] - depth * 0.22, 0.76),
            (width * 0.28, 0.16, 0.42),
            materials["accent" if index == 0 else "accent_warm"],
            bevel=0.07,
        )


def add_dining_set(name: str, x_ratio: float, y_ratio: float):
    center = normalized_to_scene(x_ratio, y_ratio)
    width = 1.55 * furniture_scale
    depth = 0.86 * furniture_scale
    box(
        name + " top",
        (center[0], center[1], 0.76),
        (width, depth, 0.10),
        materials["wood"],
        bevel=0.04,
    )
    for dx in (-width * 0.4, width * 0.4):
        for dy in (-depth * 0.34, depth * 0.34):
            box(
                name + f" leg {dx} {dy}",
                (center[0] + dx, center[1] + dy, 0.38),
                (0.07, 0.07, 0.72),
                materials["dark"],
                bevel=0.015,
            )
    chair_positions = [
        (-width * 0.34, -depth * 0.78, 0.0),
        (width * 0.34, -depth * 0.78, 0.0),
        (-width * 0.34, depth * 0.78, math.pi),
        (width * 0.34, depth * 0.78, math.pi),
    ]
    for index, (dx, dy, angle) in enumerate(chair_positions):
        box(
            name + f" chair seat {index}",
            (center[0] + dx, center[1] + dy, 0.47),
            (0.43, 0.43, 0.11),
            materials["fabric"],
            rotation_z=angle,
            bevel=0.04,
        )
        box(
            name + f" chair back {index}",
            (center[0] + dx, center[1] + dy + (0.17 if angle == 0 else -0.17), 0.72),
            (0.43, 0.09, 0.55),
            materials["fabric"],
            rotation_z=angle,
            bevel=0.04,
        )
        for lx in (-0.16, 0.16):
            for ly in (-0.15, 0.15):
                box(
                    name + f" chair leg {index} {lx} {ly}",
                    (center[0] + dx + lx, center[1] + dy + ly, 0.23),
                    (0.035, 0.035, 0.43),
                    materials["dark"],
                )


def add_plant(name: str, x_ratio: float, y_ratio: float, height: float = 0.8):
    center = normalized_to_scene(x_ratio, y_ratio)
    cylinder(name + " pot", (center[0], center[1], 0.17), 0.18, 0.34, materials["accent_warm"])
    cylinder(name + " stem", (center[0], center[1], 0.47), 0.025, height * 0.55, materials["green"])
    for index, (dx, dy, dz) in enumerate(
        [(-0.12, 0, 0.62), (0.12, 0.04, 0.69), (0, -0.1, 0.78), (0.08, -0.08, 0.88)]
    ):
        sphere(
            name + f" leaf {index}",
            (center[0] + dx, center[1] + dy, dz),
            0.17,
            materials["green"],
            scale=(0.7, 0.42, 1.35),
        )


def add_furnishings():
    if layout_preset == "two_bedroom":
        add_bed("Primary bed", 0.19, 0.225, accent=materials["accent"])
        add_bed("Second bed", 0.535, 0.225, accent=materials["accent_warm"])
    elif layout_preset == "one_bedroom":
        add_bed("Primary bed", 0.535, 0.225, accent=materials["accent_warm"])
        study = normalized_to_scene(0.19, 0.23)
        box(
            "Study desk",
            (study[0], study[1], 0.74),
            (1.35 * furniture_scale, 0.62, 0.09),
            materials["wood"],
            bevel=0.045,
        )
        box(
            "Study chair",
            (study[0], study[1] - 0.5, 0.48),
            (0.48, 0.48, 0.9),
            materials["fabric"],
            bevel=0.08,
        )
    else:
        add_bed(
            "Studio bed",
            0.59,
            0.29,
            rotation_z=math.pi / 2,
            accent=materials["accent_warm"],
        )

    rug_center = normalized_to_scene(0.37, 0.625)
    box(
        "Living rug",
        (rug_center[0], rug_center[1], 0.047),
        (3.15 * furniture_scale, 2.18 * furniture_scale, 0.045),
        materials["rug"],
        bevel=0.03,
    )
    add_sofa("Living sofa", 0.37, 0.74)
    table_center = normalized_to_scene(0.37, 0.605)
    box(
        "Coffee table top",
        (table_center[0], table_center[1], 0.39),
        (1.15 * furniture_scale, 0.65 * furniture_scale, 0.09),
        materials["wood"],
        bevel=0.055,
    )
    for dx in (-0.43, 0.43):
        box(
            "Coffee table leg",
            (table_center[0] + dx * furniture_scale, table_center[1], 0.2),
            (0.055, 0.48 * furniture_scale, 0.38),
            materials["dark"],
        )

    tv_center = normalized_to_scene(0.37, 0.485)
    box(
        "TV console",
        (tv_center[0], tv_center[1], 0.29),
        (2.0 * furniture_scale, 0.42, 0.52),
        materials["wood"],
        bevel=0.045,
    )
    box(
        "Television",
        (tv_center[0], tv_center[1] - 0.03, 1.0),
        (1.55 * furniture_scale, 0.08, 0.82 * furniture_scale),
        materials["dark"],
        bevel=0.025,
    )

    add_dining_set("Dining", 0.68, 0.69)

    # L-shaped kitchen and full-height refrigerator.
    counter_center = normalized_to_scene(0.90, 0.68)
    box(
        "Kitchen counter long",
        (counter_center[0], counter_center[1], 0.46),
        (0.62, 2.65 * furniture_scale, 0.9),
        materials["white"],
        bevel=0.035,
    )
    box(
        "Kitchen worktop long",
        (counter_center[0], counter_center[1], 0.94),
        (0.68, 2.72 * furniture_scale, 0.07),
        materials["tile_dark"],
        bevel=0.025,
    )
    back_counter = normalized_to_scene(0.86, 0.485)
    box(
        "Kitchen counter back",
        (back_counter[0], back_counter[1], 0.46),
        (1.65 * furniture_scale, 0.62, 0.9),
        materials["white"],
        bevel=0.035,
    )
    box(
        "Kitchen worktop back",
        (back_counter[0], back_counter[1], 0.94),
        (1.7 * furniture_scale, 0.68, 0.07),
        materials["tile_dark"],
        bevel=0.025,
    )
    fridge = normalized_to_scene(0.955, 0.50)
    box(
        "Refrigerator",
        (fridge[0], fridge[1], 1.02),
        (0.64, 0.68, 2.04),
        materials["metal"],
        bevel=0.045,
    )
    cooktop = normalized_to_scene(0.90, 0.67)
    box(
        "Cooktop",
        (cooktop[0], cooktop[1], 0.985),
        (0.48, 0.62, 0.025),
        materials["dark"],
        bevel=0.012,
    )

    # Bathroom fixtures.
    vanity = normalized_to_scene(0.79, 0.17)
    box(
        "Bathroom vanity",
        (vanity[0], vanity[1], 0.42),
        (0.95 * furniture_scale, 0.48, 0.78),
        materials["wood"],
        bevel=0.04,
    )
    box(
        "Bathroom basin",
        (vanity[0], vanity[1], 0.84),
        (0.68 * furniture_scale, 0.37, 0.12),
        materials["white"],
        bevel=0.06,
    )
    toilet = normalized_to_scene(0.89, 0.28)
    box(
        "Toilet base",
        (toilet[0], toilet[1], 0.23),
        (0.42, 0.61, 0.43),
        materials["white"],
        bevel=0.13,
    )
    box(
        "Toilet tank",
        (toilet[0], toilet[1] + 0.24, 0.58),
        (0.46, 0.20, 0.56),
        materials["white"],
        bevel=0.06,
    )
    shower = normalized_to_scene(0.91, 0.10)
    box(
        "Shower glass",
        (shower[0] - 0.37, shower[1], 0.95),
        (0.035, 0.95, 1.85),
        materials["glass"],
        bevel=0.01,
    )

    add_plant("Living plant", 0.61, 0.52)
    add_plant("Bedroom plant", 0.31, 0.36, 0.65)

    # Rear windows and curtains visually anchor the shell.
    rear_y = plan_depth / 2 - wall_thickness * 0.46
    for index, x_ratio in enumerate((0.18, 0.52)):
        window_center_x = normalized_to_scene(x_ratio, 0)[0]
        window_width = 1.2 * furniture_scale
        box(
            f"Window glass {index}",
            (window_center_x, rear_y, 1.5),
            (window_width, 0.035, 1.2),
            materials["glass"],
        )
        for side in (-1, 1):
            box(
                f"Window frame {index} {side}",
                (window_center_x + side * window_width * 0.5, rear_y - 0.015, 1.5),
                (0.045, 0.06, 1.28),
                materials["dark"],
            )
            box(
                f"Curtain {index} {side}",
                (window_center_x + side * window_width * 0.64, rear_y - 0.09, 1.34),
                (0.22, 0.08, 1.75),
                materials["fabric_light"],
                bevel=0.025,
            )
        box(
            f"Window frame horizontal {index}",
            (window_center_x, rear_y - 0.015, 0.89),
            (window_width, 0.06, 0.045),
            materials["dark"],
        )


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def semantic_furniture_kind(item: dict) -> str:
    name = semantic_name(item)
    if name == "dining_chair":
        return "chair"
    if name in {"tv", "television"}:
        return "television"
    if name == "sink":
        return "sink"
    aliases = (
        ("nightstand", ("nightstand", "bedside", "床头柜")),
        ("dining_table", ("dining", "餐桌")),
        ("coffee_table", ("coffee_table", "茶几")),
        ("tv_console", ("tv_console", "media_console", "电视柜")),
        ("television", ("television", "screen", "电视")),
        ("sectional_sofa", ("sectional", "l_sofa", "sofa", "沙发")),
        ("bathtub", ("bathtub", "bath_tub", "浴缸")),
        ("shower", ("shower", "淋浴")),
        ("toilet", ("toilet", "wc", "马桶")),
        ("vanity", ("vanity", "washbasin", "basin", "洗手台", "洗手盆")),
        ("refrigerator", ("refrigerator", "fridge", "冰箱")),
        ("cooktop", ("cooktop", "stove", "hob", "灶")),
        ("kitchen_sink", ("kitchen_sink", "sink_cabinet", "水槽")),
        ("kitchen_counter", ("kitchen", "counter", "cabinet", "橱柜")),
        ("bed", ("double_bed", "queen_bed", "bed", "双人床", "床")),
        ("chair", ("chair", "椅")),
    )
    for kind, tokens in aliases:
        if any(token in name for token in tokens):
            return kind
    return name


semantic_rooms_by_id = {
    str(room_data.get("id")): room_data
    for room_data in semantic_rooms
    if room_data.get("id") is not None
}


def furniture_room_type(item: dict) -> str:
    room_id = item.get("roomId", item.get("room_id"))
    room_data = semantic_rooms_by_id.get(str(room_id))
    return semantic_name(room_data) if room_data else ""


def local_box(
    name: str,
    center: tuple[float, float],
    offset: tuple[float, float],
    z: float,
    size: tuple[float, float, float],
    value,
    rotation_z: float,
    *,
    bevel: float = 0.0,
):
    location = local_point(center, offset[0], offset[1], rotation_z)
    return box(
        name,
        (location[0], location[1], z),
        size,
        value,
        rotation_z=rotation_z,
        bevel=bevel,
    )


def add_semantic_bed(
    name: str,
    center: tuple[float, float],
    width: float,
    depth: float,
    rotation_z: float,
    *,
    include_nightstands: bool,
):
    width = clamp(width, 1.35, 1.90)
    depth = clamp(depth, 1.75, 2.20)
    local_box(
        name + " base",
        center,
        (0, 0),
        0.16,
        (width, depth, 0.28),
        materials["wood"],
        rotation_z,
        bevel=0.055,
    )
    local_box(
        name + " mattress",
        center,
        (0, 0),
        0.37,
        (width * 0.96, depth * 0.96, 0.24),
        materials["white"],
        rotation_z,
        bevel=0.09,
    )
    local_box(
        name + " headboard",
        center,
        (0, depth * 0.48),
        0.69,
        (width + 0.10, 0.11, 0.92),
        materials["fabric"],
        rotation_z,
        bevel=0.05,
    )
    local_box(
        name + " blanket",
        center,
        (0, -depth * 0.18),
        0.52,
        (width * 0.91, depth * 0.42, 0.06),
        materials["accent"],
        rotation_z,
        bevel=0.025,
    )
    for index, side in enumerate((-1, 1)):
        local_box(
            name + f" pillow {index}",
            center,
            (side * width * 0.25, depth * 0.29),
            0.55,
            (width * 0.38, depth * 0.22, 0.15),
            materials["fabric_light"],
            rotation_z,
            bevel=0.065,
        )
        if include_nightstands:
            local_box(
                name + f" nightstand {index}",
                center,
                (side * width * 0.68, depth * 0.28),
                0.23,
                (0.42, 0.42, 0.46),
                materials["wood"],
                rotation_z,
                bevel=0.035,
            )


def add_semantic_nightstand(
    name: str,
    center: tuple[float, float],
    width: float,
    depth: float,
    rotation_z: float,
):
    box(
        name,
        (center[0], center[1], 0.24),
        (clamp(width, 0.30, 0.58), clamp(depth, 0.30, 0.58), 0.48),
        materials["wood"],
        rotation_z=rotation_z,
        bevel=0.035,
    )


def add_semantic_sofa(
    name: str,
    center: tuple[float, float],
    width: float,
    depth: float,
    rotation_z: float,
):
    if depth > width:
        width, depth = depth, width
        rotation_z += math.pi / 2
    width = clamp(width, 2.15, 3.45)
    depth = clamp(depth, 0.82, 1.45)
    seat_depth = min(0.92, depth)
    local_box(
        name + " main base",
        center,
        (0, 0),
        0.24,
        (width, seat_depth, 0.34),
        materials["dark"],
        rotation_z,
        bevel=0.08,
    )
    local_box(
        name + " main seat",
        center,
        (0, 0.04),
        0.45,
        (width * 0.88, seat_depth * 0.76, 0.22),
        materials["fabric_light"],
        rotation_z,
        bevel=0.09,
    )
    local_box(
        name + " main back",
        center,
        (0, seat_depth * 0.43),
        0.72,
        (width, 0.18, 0.78),
        materials["fabric"],
        rotation_z,
        bevel=0.075,
    )
    chaise_length = clamp(max(depth, 1.32), 1.32, 1.85)
    chaise_x = width * 0.36
    chaise_y = -(chaise_length - seat_depth) * 0.46
    local_box(
        name + " chaise base",
        center,
        (chaise_x, chaise_y),
        0.24,
        (width * 0.28, chaise_length, 0.34),
        materials["dark"],
        rotation_z,
        bevel=0.075,
    )
    local_box(
        name + " chaise seat",
        center,
        (chaise_x, chaise_y - 0.03),
        0.45,
        (width * 0.24, chaise_length * 0.88, 0.22),
        materials["fabric_light"],
        rotation_z,
        bevel=0.085,
    )
    for index, side in enumerate((-0.25, 0.05, 0.31)):
        local_box(
            name + f" cushion {index}",
            center,
            (side * width, seat_depth * 0.30),
            0.69,
            (width * 0.20, 0.15, 0.38),
            materials["accent" if index == 1 else "fabric_light"],
            rotation_z,
            bevel=0.06,
        )


def add_semantic_tv(
    name: str,
    center: tuple[float, float],
    width: float,
    depth: float,
    rotation_z: float,
    *,
    console: bool,
):
    if depth > width:
        width, depth = depth, width
        rotation_z += math.pi / 2
    width = clamp(width, 1.20, 2.35)
    if console:
        box(
            name + " console",
            (center[0], center[1], 0.26),
            (width, clamp(depth, 0.34, 0.58), 0.50),
            materials["wood"],
            rotation_z=rotation_z,
            bevel=0.04,
        )
    box(
        name + " television",
        (center[0], center[1], 0.82),
        (width * 0.82, 0.07, 0.78),
        materials["dark"],
        rotation_z=rotation_z,
        bevel=0.025,
    )


def add_semantic_coffee_table(
    name: str,
    center: tuple[float, float],
    width: float,
    depth: float,
    rotation_z: float,
):
    width = clamp(width, 0.80, 1.45)
    depth = clamp(depth, 0.45, 0.85)
    box(
        name + " top",
        (center[0], center[1], 0.36),
        (width, depth, 0.09),
        materials["wood"],
        rotation_z=rotation_z,
        bevel=0.05,
    )
    for side in (-1, 1):
        local_box(
            name + f" leg {side}",
            center,
            (side * width * 0.36, 0),
            0.18,
            (0.055, depth * 0.72, 0.34),
            materials["dark"],
            rotation_z,
        )


def add_semantic_dining_set(
    name: str,
    center: tuple[float, float],
    width: float,
    depth: float,
    rotation_z: float,
    *,
    include_chairs: bool = True,
):
    if depth > width:
        width, depth = depth, width
        rotation_z += math.pi / 2
    width = clamp(width, 1.55, 2.10)
    depth = clamp(depth, 0.78, 1.08)
    box(
        name + " top",
        (center[0], center[1], 0.74),
        (width, depth, 0.10),
        materials["wood"],
        rotation_z=rotation_z,
        bevel=0.045,
    )
    for x_index, dx in enumerate((-width * 0.40, width * 0.40)):
        for y_index, dy in enumerate((-depth * 0.34, depth * 0.34)):
            local_box(
                name + f" leg {x_index}-{y_index}",
                center,
                (dx, dy),
                0.37,
                (0.065, 0.065, 0.70),
                materials["dark"],
                rotation_z,
            )
    if include_chairs:
        for index, side in enumerate((-1, 1)):
            for place, x_ratio in enumerate((-0.34, 0.0, 0.34)):
                chair_center = local_point(
                    center,
                    x_ratio * width,
                    side * depth * 0.78,
                    rotation_z,
                )
                chair_rotation = rotation_z + (0 if side < 0 else math.pi)
                box(
                    name + f" chair seat {index}-{place}",
                    (chair_center[0], chair_center[1], 0.46),
                    (0.42, 0.42, 0.11),
                    materials["fabric_light"],
                    rotation_z=chair_rotation,
                    bevel=0.04,
                )
                local_box(
                    name + f" chair back {index}-{place}",
                    chair_center,
                    (0, 0.17),
                    0.70,
                    (0.42, 0.09, 0.52),
                    materials["fabric"],
                    chair_rotation,
                    bevel=0.04,
                )


def add_semantic_bathtub(
    name: str,
    center: tuple[float, float],
    width: float,
    depth: float,
    rotation_z: float,
):
    if depth > width:
        width, depth = depth, width
        rotation_z += math.pi / 2
    width = clamp(width, 1.45, 2.10)
    depth = clamp(depth, 0.70, 0.98)
    local_box(
        name + " basin",
        center,
        (0, 0),
        0.24,
        (width * 0.88, depth * 0.70, 0.35),
        materials["tile"],
        rotation_z,
        bevel=0.16,
    )
    for side in (-1, 1):
        local_box(
            name + f" long rim {side}",
            center,
            (0, side * depth * 0.43),
            0.44,
            (width, 0.10, 0.18),
            materials["white"],
            rotation_z,
            bevel=0.045,
        )
        local_box(
            name + f" end rim {side}",
            center,
            (side * width * 0.46, 0),
            0.44,
            (0.12, depth * 0.78, 0.18),
            materials["white"],
            rotation_z,
            bevel=0.045,
        )


def add_semantic_shower(
    name: str,
    center: tuple[float, float],
    width: float,
    depth: float,
    rotation_z: float,
):
    width = clamp(width, 0.72, 1.20)
    depth = clamp(depth, 0.72, 1.20)
    box(
        name + " tray",
        (center[0], center[1], 0.06),
        (width, depth, 0.12),
        materials["tile"],
        rotation_z=rotation_z,
        bevel=0.045,
    )
    local_box(
        name + " glass side",
        center,
        (-width * 0.47, 0),
        0.66,
        (0.025, depth, 1.25),
        materials["glass"],
        rotation_z,
    )
    local_box(
        name + " glass front",
        center,
        (0, -depth * 0.47),
        0.66,
        (width, 0.025, 1.25),
        materials["glass"],
        rotation_z,
    )


def add_semantic_toilet(
    name: str,
    center: tuple[float, float],
    rotation_z: float,
):
    local_box(
        name + " bowl",
        center,
        (0, -0.06),
        0.23,
        (0.42, 0.58, 0.42),
        materials["white"],
        rotation_z,
        bevel=0.14,
    )
    local_box(
        name + " tank",
        center,
        (0, 0.24),
        0.53,
        (0.45, 0.19, 0.54),
        materials["white"],
        rotation_z,
        bevel=0.055,
    )


def add_semantic_vanity(
    name: str,
    center: tuple[float, float],
    width: float,
    depth: float,
    rotation_z: float,
):
    width = clamp(width, 0.62, 1.20)
    depth = clamp(depth, 0.38, 0.62)
    box(
        name + " cabinet",
        (center[0], center[1], 0.38),
        (width, depth, 0.72),
        materials["wood"],
        rotation_z=rotation_z,
        bevel=0.04,
    )
    box(
        name + " basin",
        (center[0], center[1], 0.78),
        (width * 0.74, depth * 0.72, 0.14),
        materials["white"],
        rotation_z=rotation_z,
        bevel=0.07,
    )


def add_semantic_kitchen_counter(
    name: str,
    center: tuple[float, float],
    width: float,
    depth: float,
    rotation_z: float,
    *,
    appliance: str | None,
):
    if depth > width:
        width, depth = depth, width
        rotation_z += math.pi / 2
    minimum_width = 0.58 if appliance in {"sink", "cooktop"} else 1.55
    width = clamp(width, minimum_width, 3.75)
    depth = clamp(depth, 0.52, 0.72)
    box(
        name + " cabinet",
        (center[0], center[1], 0.44),
        (width, depth, 0.86),
        materials["wood"],
        rotation_z=rotation_z,
        bevel=0.035,
    )
    box(
        name + " worktop",
        (center[0], center[1], 0.90),
        (width + 0.05, depth + 0.05, 0.07),
        materials["tile_dark"],
        rotation_z=rotation_z,
        bevel=0.02,
    )
    if appliance in {"sink", "both"}:
        sink_x = 0.0 if appliance == "sink" else -width * 0.25
        local_box(
            name + " kitchen sink",
            center,
            (sink_x, 0),
            0.945,
            (0.55, depth * 0.64, 0.035),
            materials["metal"],
            rotation_z,
            bevel=0.04,
        )
    if appliance in {"cooktop", "both"}:
        cooktop_x = 0.0 if appliance == "cooktop" else width * 0.25
        local_box(
            name + " cooktop",
            center,
            (cooktop_x, 0),
            0.945,
            (0.54, depth * 0.68, 0.025),
            materials["dark"],
            rotation_z,
            bevel=0.012,
        )


def add_semantic_refrigerator(
    name: str,
    center: tuple[float, float],
    width: float,
    depth: float,
    rotation_z: float,
):
    box(
        name,
        (center[0], center[1], 0.98),
        (clamp(width, 0.55, 0.82), clamp(depth, 0.55, 0.82), 1.96),
        materials["metal"],
        rotation_z=rotation_z,
        bevel=0.045,
    )


def add_semantic_proxy(
    name: str,
    item: dict,
    center: tuple[float, float],
    rotation_z: float,
):
    """Render a stable proxy for every recognized category without a bespoke asset."""

    width, depth = furniture_size(item, (0.80, 0.60))
    size = item.get("size", {}) if isinstance(item.get("size"), dict) else {}
    height = clamp(float(size.get("heightMm", 800)) / 1000, 0.24, 2.40)
    kind = semantic_furniture_kind(item)
    value = (
        materials["wood"]
        if kind in {"wardrobe", "desk", "shelf"}
        else materials["white"]
        if kind == "washing_machine"
        else materials["fabric_light"]
    )
    box(
        name + " proxy",
        (center[0], center[1], height / 2),
        (clamp(width, 0.15, 4.0), clamp(depth, 0.15, 4.0), height),
        value,
        rotation_z=rotation_z,
        bevel=min(0.06, height * 0.08),
    )


def opening_segment(opening: dict) -> tuple[tuple[float, float], tuple[float, float]] | None:
    direct = wall_pixel_points(opening)
    if direct is not None:
        return direct
    segment = opening.get("segment", {})
    if isinstance(segment, dict):
        start = point_value(segment.get("start"))
        end = point_value(segment.get("end"))
        if start is not None and end is not None:
            return start, end
    center = point_value(opening.get("center"))
    if center is None:
        return None
    width_mm = opening.get("widthMm")
    width_px = opening.get("width")
    if width_mm is not None:
        horizontal_span = float(width_mm) / payload["plan_width_mm"] * bounds["width"]
        vertical_span = float(width_mm) / payload["plan_depth_mm"] * bounds["height"]
    elif width_px is not None:
        horizontal_span = vertical_span = float(width_px)
    else:
        return None
    axis = str(opening.get("wallAxis", opening.get("orientation", "horizontal"))).lower()
    if axis.startswith("v"):
        return (
            (center[0], center[1] - vertical_span / 2),
            (center[0], center[1] + vertical_span / 2),
        )
    return (
        (center[0] - horizontal_span / 2, center[1]),
        (center[0] + horizontal_span / 2, center[1]),
    )


def snap_opening_segment_to_wall(
    segment: tuple[tuple[float, float], tuple[float, float]],
) -> tuple[tuple[float, float], tuple[float, float]]:
    """Snap small vision-coordinate drift to the nearest parallel semantic wall."""

    if not semantic_walls:
        return segment
    start, end = segment
    horizontal = abs(end[0] - start[0]) >= abs(end[1] - start[1])
    opening_axis = (start[1] + end[1]) / 2 if horizontal else (start[0] + end[0]) / 2
    opening_start, opening_end = sorted(
        (start[0], end[0]) if horizontal else (start[1], end[1])
    )
    perpendicular_scale = (
        payload["plan_depth_mm"] / bounds["height"]
        if horizontal
        else payload["plan_width_mm"] / bounds["width"]
    )
    longitudinal_scale = (
        payload["plan_width_mm"] / bounds["width"]
        if horizontal
        else payload["plan_depth_mm"] / bounds["height"]
    )
    best_axis = None
    best_score = float("inf")
    for wall in semantic_walls:
        wall_points = wall_pixel_points(wall)
        if wall_points is None:
            continue
        wall_start, wall_end = wall_points
        wall_horizontal = abs(wall_end[0] - wall_start[0]) >= abs(
            wall_end[1] - wall_start[1]
        )
        if wall_horizontal != horizontal:
            continue
        wall_axis = (
            (wall_start[1] + wall_end[1]) / 2
            if horizontal
            else (wall_start[0] + wall_end[0]) / 2
        )
        wall_interval = sorted(
            (wall_start[0], wall_end[0])
            if horizontal
            else (wall_start[1], wall_end[1])
        )
        interval_gap = max(
            0.0,
            wall_interval[0] - opening_end,
            opening_start - wall_interval[1],
        )
        perpendicular_mm = abs(wall_axis - opening_axis) * perpendicular_scale
        longitudinal_gap_mm = interval_gap * longitudinal_scale
        if perpendicular_mm > 250 or longitudinal_gap_mm > 350:
            continue
        score = perpendicular_mm + longitudinal_gap_mm * 0.35
        if score < best_score:
            best_axis = wall_axis
            best_score = score
    if best_axis is None:
        return segment
    if horizontal:
        return (start[0], best_axis), (end[0], best_axis)
    return (best_axis, start[1]), (best_axis, end[1])


def add_semantic_openings():
    for index, opening in enumerate(semantic_openings):
        segment = opening_segment(opening)
        if segment is None:
            continue
        segment = snap_opening_segment_to_wall(segment)
        start = pixel_to_scene(*segment[0])
        end = pixel_to_scene(*segment[1])
        dx, dy = end[0] - start[0], end[1] - start[1]
        width = math.hypot(dx, dy)
        if width < 0.16:
            continue
        axis_angle = math.atan2(dy, dx)
        kind = semantic_name(opening)
        if "window" in kind or "窗" in kind:
            sill = float(opening.get("sillHeightMm", 120)) / 1000
            window_height = clamp(
                float(opening.get("heightMm", 820)) / 1000,
                0.45,
                0.86,
            )
            middle = ((start[0] + end[0]) / 2, (start[1] + end[1]) / 2)
            box(
                f"Window glass {index}",
                (middle[0], middle[1], sill + window_height / 2),
                (width, 0.028, window_height),
                materials["glass"],
                rotation_z=axis_angle,
            )
            for side, point in enumerate((start, end)):
                box(
                    f"Window frame {index}-{side}",
                    (point[0], point[1], sill + window_height / 2),
                    (0.045, 0.06, window_height + 0.08),
                    materials["dark"],
                    rotation_z=axis_angle,
                )
            continue

        swing_degrees = float(opening.get("swingDeg", opening.get("swing_deg", 28)))
        if opening.get("swing") in ("right", "clockwise", -1):
            swing_degrees *= -1
        leaf_angle = axis_angle + math.radians(swing_degrees)
        leaf_center = (
            start[0] + math.cos(leaf_angle) * width / 2,
            start[1] + math.sin(leaf_angle) * width / 2,
        )
        door_height = clamp(
            float(opening.get("heightMm", 2050)) / 1000,
            1.90,
            2.40,
        )
        opening_id = str(opening.get("id", "")).lower()
        if width >= 1.15 or "entry" in opening_id:
            leaf_width = width / 2
            first_angle = axis_angle + math.radians(abs(swing_degrees))
            second_angle = axis_angle + math.pi - math.radians(abs(swing_degrees))
            first_center = (
                start[0] + math.cos(first_angle) * leaf_width / 2,
                start[1] + math.sin(first_angle) * leaf_width / 2,
            )
            second_center = (
                end[0] + math.cos(second_angle) * leaf_width / 2,
                end[1] + math.sin(second_angle) * leaf_width / 2,
            )
            for leaf_index, (center, angle) in enumerate(
                ((first_center, first_angle), (second_center, second_angle))
            ):
                box(
                    f"Door leaf {index}-{leaf_index}",
                    (center[0], center[1], door_height / 2),
                    (leaf_width, 0.045, door_height),
                    materials["wood"],
                    rotation_z=angle,
                    bevel=0.018,
                )
            continue
        box(
            f"Door leaf {index}",
            (leaf_center[0], leaf_center[1], door_height / 2),
            (width, 0.045, door_height),
            materials["wood"],
            rotation_z=leaf_angle,
            bevel=0.018,
        )


def add_semantic_furnishings():
    kinds = [semantic_furniture_kind(item) for item in semantic_furniture]
    nightstand_rooms = {
        str(item.get("roomId", item.get("room_id")))
        for item, kind in zip(semantic_furniture, kinds, strict=False)
        if kind == "nightstand"
    }
    explicit_chair_rooms = {
        str(item.get("roomId", item.get("room_id")))
        for item, kind in zip(semantic_furniture, kinds, strict=False)
        if kind == "chair"
    }
    for index, (item, kind) in enumerate(zip(semantic_furniture, kinds, strict=False)):
        center = furniture_center(item)
        rotation_z = furniture_rotation(item)
        room_id = str(item.get("roomId", item.get("room_id")))
        room_type = furniture_room_type(item)
        name = f"Semantic {kind} {index}"
        if kind == "bed":
            width, depth = furniture_size(item, (1.55, 2.0))
            add_semantic_bed(
                name,
                center,
                width,
                depth,
                rotation_z,
                include_nightstands=room_id not in nightstand_rooms,
            )
        elif kind == "nightstand":
            width, depth = furniture_size(item, (0.42, 0.42))
            add_semantic_nightstand(name, center, width, depth, rotation_z)
        elif kind == "sectional_sofa":
            width, depth = furniture_size(item, (2.75, 1.25))
            add_semantic_sofa(name, center, width, depth, rotation_z)
        elif kind == "tv_console":
            width, depth = furniture_size(item, (1.85, 0.45))
            add_semantic_tv(name, center, width, depth, rotation_z, console=True)
        elif kind == "television":
            width, depth = furniture_size(item, (1.55, 0.10))
            add_semantic_tv(name, center, width, depth, rotation_z, console=False)
        elif kind == "coffee_table":
            width, depth = furniture_size(item, (1.10, 0.62))
            add_semantic_coffee_table(name, center, width, depth, rotation_z)
        elif kind == "dining_table":
            width, depth = furniture_size(item, (1.75, 0.90))
            add_semantic_dining_set(
                name,
                center,
                width,
                depth,
                rotation_z,
                include_chairs=room_id not in explicit_chair_rooms,
            )
        elif kind == "chair":
            width, depth = furniture_size(item, (0.44, 0.44))
            box(
                name,
                (center[0], center[1], 0.46),
                (clamp(width, 0.36, 0.52), clamp(depth, 0.36, 0.52), 0.72),
                materials["fabric_light"],
                rotation_z=rotation_z,
                bevel=0.05,
            )
        elif kind == "bathtub":
            width, depth = furniture_size(item, (1.72, 0.82))
            add_semantic_bathtub(name, center, width, depth, rotation_z)
        elif kind == "shower":
            width, depth = furniture_size(item, (0.90, 0.90))
            add_semantic_shower(name, center, width, depth, rotation_z)
        elif kind == "toilet":
            add_semantic_toilet(name, center, rotation_z)
        elif kind == "vanity" or (
            kind in {"kitchen_sink", "sink"}
            and any(token in room_type for token in ("bath", "toilet", "wc", "卫生间", "浴室"))
        ):
            width, depth = furniture_size(item, (0.85, 0.50))
            add_semantic_vanity(name, center, width, depth, rotation_z)
        elif kind == "kitchen_counter":
            width, depth = furniture_size(item, (2.65, 0.62))
            add_semantic_kitchen_counter(name, center, width, depth, rotation_z, appliance="both")
        elif kind in {"kitchen_sink", "sink", "cooktop"}:
            width, depth = furniture_size(item, (1.55, 0.62))
            appliance = "cooktop" if kind == "cooktop" else "sink"
            add_semantic_kitchen_counter(
                name,
                center,
                width,
                depth,
                rotation_z,
                appliance=appliance,
            )
        elif kind == "refrigerator":
            width, depth = furniture_size(item, (0.68, 0.68))
            add_semantic_refrigerator(name, center, width, depth, rotation_z)
        else:
            add_semantic_proxy(name, item, center, rotation_z)

if view_mode in dollhouse_modes | {"interior"}:
    if use_semantic_layout:
        add_semantic_furnishings()
        add_semantic_openings()
    else:
        add_furnishings()


def distance_to_segment(point, start, end):
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    length_squared = dx * dx + dy * dy
    if length_squared == 0:
        return math.hypot(point[0] - start[0], point[1] - start[1])
    ratio = max(
        0,
        min(
            1,
            ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / length_squared,
        ),
    )
    nearest = (start[0] + ratio * dx, start[1] + ratio * dy)
    return math.hypot(point[0] - nearest[0], point[1] - nearest[1])


if view_mode == "topdown":
    box(
        "Selected room",
        (room_center[0], room_center[1], 0.035),
        (
            room_max_x - room_min_x,
            room_max_y - room_min_y,
            0.025,
        ),
        materials["selected"],
    )
    bpy.ops.object.camera_add(location=(0, 0, max(plan_width, plan_depth) * 1.4))
    camera = bpy.context.object
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = max(plan_width, plan_depth) * 1.22
    look_at(camera, (0, 0, 0))
    camera.name = "topdown"
    camera.data.name = "topdown"
elif view_mode in dollhouse_modes:
    if use_semantic_layout:
        # Preserve plan axes and show only a small amount of wall elevation. This
        # matches an architectural top-down dollhouse instead of a corner orbit.
        camera_height = max(plan_width, plan_depth) * 1.95
        camera_tilt = math.radians(4.0)
        camera_y = -(camera_height - 0.18) * math.tan(camera_tilt)
        bpy.ops.object.camera_add(location=(0, camera_y, camera_height))
        camera = bpy.context.object
        camera.data.type = "ORTHO"
        output_aspect = 1536 / 1152
        camera.data.ortho_scale = max(plan_width, plan_depth * output_aspect) * 1.18
        camera.data.lens = 50
        camera.data.clip_start = 0.08
        # Near-vertical look_at() may introduce an arbitrary roll. An explicit
        # X rotation keeps the plan axes deterministic across Blender versions.
        camera.rotation_euler = (camera_tilt, 0, 0)
    else:
        camera_height = max(plan_width, plan_depth) * 1.02
        bpy.ops.object.camera_add(
            location=(
                plan_width * 0.92,
                -plan_depth * 1.12,
                camera_height,
            )
        )
        camera = bpy.context.object
        camera.data.type = "ORTHO"
        camera.data.ortho_scale = max(plan_width, plan_depth) * 1.38
        camera.data.lens = 45
        camera.data.clip_start = 0.08
        look_at(camera, (0, 0, 0.48))
    camera.name = view_mode
    camera.data.name = view_mode
else:
    margin = min(
        0.42,
        max(0.25, min(room_max_x - room_min_x, room_max_y - room_min_y) * 0.12),
    )
    preset = payload.get("camera_preset_id", "corner_01")
    camera_locations = {
        "corner_01": (
            room_max_x - margin,
            room_min_y + margin,
            min(1.65, wall_height - 0.35),
        ),
        "corner_02": (
            room_min_x + margin,
            room_min_y + margin,
            min(1.65, wall_height - 0.35),
        ),
        "eye_level_01": (
            room_center[0],
            room_min_y + margin,
            min(1.6, wall_height - 0.35),
        ),
    }
    bpy.ops.object.camera_add(location=camera_locations.get(preset, camera_locations["corner_01"]))
    camera = bpy.context.object
    camera.data.lens = 24
    camera.data.clip_start = 0.08
    look_at(camera, (room_center[0], room_center[1], 0.92))
    camera.name = preset
    camera.data.name = preset
    for wall_object, start, end in wall_objects:
        if distance_to_segment(camera.location, start, end) < 0.9:
            wall_object.hide_render = True


def add_delivery_camera(
    name: str,
    location: tuple[float, float, float],
    target: tuple[float, float, float],
    *,
    camera_type: str = "PERSP",
    lens: float = 24,
    ortho_scale: float | None = None,
):
    bpy.ops.object.camera_add(location=location)
    delivery_camera = bpy.context.object
    delivery_camera.name = name
    delivery_camera.data.name = name
    delivery_camera.data.type = camera_type
    delivery_camera.data.lens = lens
    delivery_camera.data.clip_start = 0.08
    if ortho_scale is not None:
        delivery_camera.data.ortho_scale = ortho_scale
    look_at(delivery_camera, target)
    return delivery_camera


if view_mode == "dollhouse":
    # Keep one canonical editable scene with all supported delivery cameras.
    # The active camera remains the deterministic dollhouse camera used by the
    # current render, while users can switch to the named cameras in Blender or
    # a later web workbench without rebuilding the semantic scene.
    canonical_camera = camera
    delivery_margin = min(
        0.42,
        max(0.25, min(room_max_x - room_min_x, room_max_y - room_min_y) * 0.12),
    )
    add_delivery_camera(
        "topdown",
        (0, 0, max(plan_width, plan_depth) * 1.4),
        (0, 0, 0),
        camera_type="ORTHO",
        ortho_scale=max(plan_width, plan_depth) * 1.22,
    )
    delivery_locations = {
        "corner_01": (
            room_max_x - delivery_margin,
            room_min_y + delivery_margin,
            min(1.65, wall_height - 0.35),
        ),
        "corner_02": (
            room_min_x + delivery_margin,
            room_min_y + delivery_margin,
            min(1.65, wall_height - 0.35),
        ),
        "eye_level_01": (
            room_center[0],
            room_min_y + delivery_margin,
            min(1.6, wall_height - 0.35),
        ),
    }
    for delivery_name, delivery_location in delivery_locations.items():
        add_delivery_camera(
            delivery_name,
            delivery_location,
            (room_center[0], room_center[1], 0.92),
        )
    camera = canonical_camera

bpy.context.scene.camera = camera

lighting_center = (
    (0, 0, 0.35) if view_mode in dollhouse_modes else (room_center[0], room_center[1], 0.35)
)
bpy.ops.object.light_add(
    type="AREA",
    location=(-plan_width * 0.25, -plan_depth * 0.35, wall_height * 2.1),
)
key = bpy.context.object
key.data.energy = 1250 if view_mode in dollhouse_modes else 950
key.data.shape = "DISK"
key.data.size = max(4.0, min(plan_width, plan_depth) * 0.85)
look_at(key, lighting_center)

bpy.ops.object.light_add(
    type="AREA",
    location=(plan_width * 0.85, plan_depth * 0.55, wall_height * 1.35),
)
fill = bpy.context.object
fill.data.energy = 750 if view_mode in dollhouse_modes else 480
fill.data.size = max(3.0, min(plan_width, plan_depth) * 0.72)
look_at(fill, lighting_center)

bpy.ops.object.light_add(type="SUN", location=(0, 0, wall_height))
sun = bpy.context.object
sun.rotation_euler = (math.radians(28), 0, math.radians(132))
sun.data.energy = 1.3 if view_mode in dollhouse_modes else 0.9
sun.data.angle = math.radians(18)

scene = bpy.context.scene
available_engines = {
    item.identifier for item in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items
}
eevee_engine = (
    "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in available_engines else "BLENDER_EEVEE"
)
render_quality = payload.get("render_quality", "base")
use_cycles = (
    view_mode == "dollhouse"
    and render_quality in {"base", "final"}
    and "CYCLES" in available_engines
)
scene.render.engine = "CYCLES" if use_cycles else eevee_engine
if use_cycles:
    scene.cycles.samples = 96 if render_quality == "base" else 160
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 6
    scene.cycles.diffuse_bounces = 3
    scene.cycles.glossy_bounces = 3
    try:
        cycles_preferences = bpy.context.preferences.addons["cycles"].preferences
        cycles_preferences.compute_device_type = "METAL"
        cycles_preferences.get_devices()
        for device in cycles_preferences.devices:
            device.use = True
        scene.cycles.device = "GPU"
    except (KeyError, TypeError, RuntimeError):
        scene.cycles.device = "CPU"

scene.render.resolution_x = 1536 if view_mode in dollhouse_modes else 1024
scene.render.resolution_y = 1152 if view_mode in dollhouse_modes else 768
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = str(output)
scene.render.film_transparent = False
scene.world.color = (0.88, 0.88, 0.86) if view_mode in dollhouse_modes else (0.055, 0.055, 0.055)


def flat_material(name: str, color: tuple[float, float, float, float]):
    value = bpy.data.materials.new(name)
    value.use_nodes = True
    nodes = value.node_tree.nodes
    links = value.node_tree.links
    nodes.clear()
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = color
    emission.inputs["Strength"].default_value = 1.0
    output_node = nodes.new("ShaderNodeOutputMaterial")
    links.new(emission.outputs["Emission"], output_node.inputs["Surface"])
    return value


def semantic_color(name: str) -> tuple[float, float, float, float]:
    lowered = name.lower()
    if "wall" in lowered:
        return (0.18, 0.48, 0.92, 1)
    if any(token in lowered for token in ("floor", "ground", "rug")):
        return (0.48, 0.48, 0.48, 1)
    if any(token in lowered for token in ("bed", "mattress", "pillow", "blanket")):
        return (0.26, 0.78, 0.38, 1)
    if any(token in lowered for token in ("sofa", "chair", "cushion")):
        return (0.96, 0.43, 0.18, 1)
    if any(token in lowered for token in ("table", "console", "nightstand")):
        return (0.96, 0.72, 0.14, 1)
    if any(token in lowered for token in ("kitchen", "refrigerator", "cooktop", "sink")):
        return (0.58, 0.26, 0.88, 1)
    if any(
        token in lowered for token in ("bathroom", "toilet", "shower", "bathtub", "vanity", "basin")
    ):
        return (0.12, 0.74, 0.82, 1)
    if any(token in lowered for token in ("plant", "leaf", "stem")):
        return (0.08, 0.48, 0.18, 1)
    if any(token in lowered for token in ("window", "curtain")):
        return (0.36, 0.84, 0.96, 1)
    if "door" in lowered:
        return (0.64, 0.38, 0.16, 1)
    return (0.78, 0.78, 0.78, 1)


if view_mode == "semantic":
    semantic_materials = {}
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        color = semantic_color(obj.name)
        if color not in semantic_materials:
            semantic_materials[color] = flat_material(
                f"Semantic {len(semantic_materials)}",
                color,
            )
        obj.data.materials.clear()
        obj.data.materials.append(semantic_materials[color])
    scene.world.color = (0, 0, 0)
    scene.view_settings.view_transform = "Standard"

if view_mode in {"depth", "normal"}:
    view_layer = scene.view_layers["ViewLayer"]
    tree = bpy.data.node_groups.new(
        f"{view_mode.title()} compositor",
        "CompositorNodeTree",
    )
    scene.compositing_node_group = tree
    render_layers = tree.nodes.new("CompositorNodeRLayers")
    tree.interface.new_socket(
        name="Image",
        in_out="OUTPUT",
        socket_type="NodeSocketColor",
    )
    composite = tree.nodes.new("NodeGroupOutput")
    if view_mode == "depth":
        view_layer.use_pass_z = True
        camera_distance = (camera.location - Vector((0, 0, 0.48))).length
        map_range = tree.nodes.new("ShaderNodeMapRange")
        map_range.inputs["From Min"].default_value = max(
            0.1,
            camera_distance - max(plan_width, plan_depth) * 0.95,
        )
        map_range.inputs["From Max"].default_value = (
            camera_distance + max(plan_width, plan_depth) * 0.95
        )
        map_range.inputs["To Min"].default_value = 1.0
        map_range.inputs["To Max"].default_value = 0.0
        tree.links.new(render_layers.outputs["Depth"], map_range.inputs["Value"])
        tree.links.new(map_range.outputs["Result"], composite.inputs["Image"])
    else:
        view_layer.use_pass_normal = True
        multiply = tree.nodes.new("ShaderNodeVectorMath")
        multiply.operation = "MULTIPLY"
        multiply.inputs[1].default_value = (0.5, 0.5, 0.5)
        add = tree.nodes.new("ShaderNodeVectorMath")
        add.operation = "ADD"
        add.inputs[1].default_value = (0.5, 0.5, 0.5)
        tree.links.new(render_layers.outputs["Normal"], multiply.inputs[0])
        tree.links.new(multiply.outputs["Vector"], add.inputs[0])
        tree.links.new(add.outputs["Vector"], composite.inputs["Image"])
    scene.view_settings.view_transform = "Standard"

try:
    scene.view_settings.look = "AgX - Medium High Contrast"
except (TypeError, ValueError):
    pass

if view_mode not in {"semantic", "depth", "normal"}:
    bpy.ops.wm.save_as_mainfile(filepath=str(output.with_suffix(".blend")))
if view_mode == "dollhouse":
    glb_output = output.with_suffix(".glb")
    try:
        bpy.ops.export_scene.gltf(
            filepath=str(glb_output),
            export_format="GLB",
            export_cameras=True,
            export_lights=True,
        )
    except Exception as exc:  # noqa: BLE001 - optional delivery must not block PNG
        glb_output.unlink(missing_ok=True)
        print(f"Optional GLB export failed: {exc}", file=sys.stderr)
bpy.ops.render.render(write_still=True)
