from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def material(name: str, color: tuple[float, float, float, float]):
    value = bpy.data.materials.new(name)
    value.diffuse_color = color
    value.use_nodes = True
    value.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = color
    value.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.74
    return value


def cube(
    name: str,
    location: tuple[float, float, float],
    scale: tuple[float, float, float],
    value,
):
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    obj.data.materials.append(value)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return obj


def look_at(obj, target: tuple[float, float, float]):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


args = sys.argv[sys.argv.index("--") + 1 :]
payload = json.loads(Path(args[0]).read_text(encoding="utf-8"))
output = Path(args[1])
view_mode = args[2]

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

bounds = payload["detected_bounds"]
plan_width = payload["plan_width_mm"] / 1000
plan_depth = payload["plan_depth_mm"] / 1000
wall_height = payload["ceiling_height_mm"] / 1000
wall_thickness = payload["wall_thickness_mm"] / 1000


def pixel_to_scene(x: float, y: float) -> tuple[float, float]:
    x_ratio = (x - bounds["x"]) / bounds["width"]
    y_ratio = (y - bounds["y"]) / bounds["height"]
    return (
        x_ratio * plan_width - plan_width / 2,
        plan_depth / 2 - y_ratio * plan_depth,
    )


floor_material = material("Floor", (0.72, 0.67, 0.60, 1))
wall_material = material("Wall", (0.86, 0.88, 0.89, 1))
accent_material = material("SelectedRoom", (0.35, 0.63, 0.55, 1))

cube(
    "Floor",
    (0, 0, -0.045),
    (plan_width / 2, plan_depth / 2, 0.045),
    floor_material,
)

wall_objects = []
for index, wall in enumerate(payload["walls"]):
    start_x, start_y = pixel_to_scene(wall["x1"], wall["y1"])
    end_x, end_y = pixel_to_scene(wall["x2"], wall["y2"])
    center = ((start_x + end_x) / 2, (start_y + end_y) / 2, wall_height / 2)
    dx, dy = end_x - start_x, end_y - start_y
    length = math.hypot(dx, dy)
    if length < 0.05:
        continue
    item = cube(
        f"Wall_{index:03d}",
        center,
        (length / 2, wall_thickness / 2, wall_height / 2),
        wall_material,
    )
    item.rotation_euler[2] = math.atan2(dy, dx)
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

if view_mode == "topdown":
    cube(
        "SelectedRoom",
        (room_center[0], room_center[1], 0.015),
        (
            (room_max_x - room_min_x) / 2,
            (room_max_y - room_min_y) / 2,
            0.012,
        ),
        accent_material,
    )
    bpy.ops.object.camera_add(location=(0, 0, max(plan_width, plan_depth) * 1.4))
    camera = bpy.context.object
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = max(plan_width, plan_depth) * 1.22
    look_at(camera, (0, 0, 0))
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
                ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy)
                / length_squared,
            ),
        )
        nearest = (start[0] + ratio * dx, start[1] + ratio * dy)
        return math.hypot(point[0] - nearest[0], point[1] - nearest[1])

    # Keep all structural objects in the .blend file, but make the camera-side
    # cutaway usable by excluding only walls that would sit directly on the lens.
    for wall_object, start, end in wall_objects:
        if distance_to_segment(camera.location, start, end) < 0.9:
            wall_object.hide_render = True

bpy.context.scene.camera = camera

bpy.ops.object.light_add(
    type="AREA",
    location=(room_center[0], room_center[1], wall_height - 0.25),
)
key = bpy.context.object
key.data.energy = 1000
key.data.shape = "DISK"
key.data.size = max(3.0, min(plan_width, plan_depth) * 0.65)
look_at(key, (room_center[0], room_center[1], 0))

bpy.ops.object.light_add(type="SUN", location=(0, 0, wall_height))
sun = bpy.context.object
sun.rotation_euler = (math.radians(28), 0, math.radians(32))
sun.data.energy = 1.0

scene = bpy.context.scene
available_engines = {
    item.identifier for item in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items
}
scene.render.engine = (
    "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in available_engines else "BLENDER_EEVEE"
)
scene.render.resolution_x = 1024
scene.render.resolution_y = 768
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = str(output)
scene.render.film_transparent = False
scene.world.color = (0.055, 0.055, 0.055)
bpy.ops.wm.save_as_mainfile(filepath=str(output.with_suffix(".blend")))
bpy.ops.render.render(write_still=True)
