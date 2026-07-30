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
    value.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.72
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

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

room_width = payload.get("width_mm", 5200) / 1000
room_depth = payload.get("depth_mm", 4200) / 1000
room_height = payload.get("ceiling_height_mm", 2800) / 1000

floor_mat = material("Floor", (0.62, 0.48, 0.34, 1))
wall_mat = material("Wall", (0.84, 0.87, 0.89, 1))
furniture_mat = material("Furniture", (0.33, 0.52, 0.60, 1))
accent_mat = material("Accent", (0.60, 0.42, 0.28, 1))

cube("Floor", (0, 0, -0.04), (room_width / 2, room_depth / 2, 0.04), floor_mat)
cube(
    "BackWall",
    (0, room_depth / 2, room_height / 2),
    (room_width / 2, 0.05, room_height / 2),
    wall_mat,
)
cube(
    "LeftWall",
    (-room_width / 2, 0, room_height / 2),
    (0.05, room_depth / 2, room_height / 2),
    wall_mat,
)

placements = payload.get("placements") or [
    {
        "category": "sofa",
        "xMm": 1100,
        "yMm": 2600,
        "widthMm": 2400,
        "depthMm": 900,
    },
    {
        "category": "coffee_table",
        "xMm": 2100,
        "yMm": 1700,
        "widthMm": 1100,
        "depthMm": 600,
    },
]
heights = {
    "sofa": 0.82,
    "coffee_table": 0.42,
    "tv_console": 0.50,
    "dining_table": 0.76,
    "bed": 0.52,
    "wardrobe": 2.20,
}
for index, item in enumerate(placements):
    item_width = item.get("widthMm", 1000) / 1000
    item_depth = item.get("depthMm", 600) / 1000
    item_height = heights.get(item.get("category"), 0.72)
    x = item.get("xMm", 500) / 1000 + item_width / 2 - room_width / 2
    y = item.get("yMm", 500) / 1000 + item_depth / 2 - room_depth / 2
    cube(
        f"Furniture_{index}",
        (x, y, item_height / 2),
        (item_width / 2, item_depth / 2, item_height / 2),
        accent_mat if index % 2 else furniture_mat,
    )

camera_preset = payload.get("camera_preset_id", "corner_01")
camera_locations = {
    "corner_01": (
        room_width * 0.42,
        -room_depth * 0.42,
        min(2.25, room_height - 0.3),
    ),
    "corner_02": (
        -room_width * 0.42,
        -room_depth * 0.42,
        min(2.25, room_height - 0.3),
    ),
    "eye_level_01": (
        0,
        -room_depth * 0.42,
        min(1.6, room_height - 0.3),
    ),
}
bpy.ops.object.camera_add(
    location=camera_locations.get(camera_preset, camera_locations["corner_01"])
)
camera = bpy.context.object
camera.data.lens = 24
look_at(camera, (0, 0.2, 0.85))
bpy.context.scene.camera = camera

bpy.ops.object.light_add(type="AREA", location=(0, -0.5, room_height - 0.25))
key = bpy.context.object
key.data.energy = 900
key.data.shape = "DISK"
key.data.size = 4.0
look_at(key, (0, 0, 0))

bpy.ops.object.light_add(type="SUN", location=(1, -1, room_height))
sun = bpy.context.object
sun.rotation_euler = (math.radians(30), 0, math.radians(25))
sun.data.energy = 1.2

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
scene.render.image_settings.color_mode = "RGBA"
bpy.ops.wm.save_as_mainfile(filepath=str(output.with_suffix(".blend")))
bpy.ops.render.render(write_still=True)
