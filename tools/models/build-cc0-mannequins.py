#!/usr/bin/env python3
"""Build CozyClay's CC0 male/female mannequin FBXs from Blender's asset bundle.

Run with Blender, not CPython:
  blender --background --factory-startup --python tools/models/build-cc0-mannequins.py -- \
    /path/to/human_base_meshes_bundle.blend
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector


SOURCE_OBJECTS = {
    "male": "GEO-body_male_realistic",
    "female": "GEO-body_female_realistic",
}

def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials):
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)


def load_body(source_path: Path, object_name: str) -> bpy.types.Object:
    with bpy.data.libraries.load(str(source_path), link=False) as (source, target):
        if object_name not in source.objects:
            raise RuntimeError(f"source object not found: {object_name}")
        target.objects = [object_name]
    body = target.objects[0]
    bpy.context.collection.objects.link(body)
    body.name = "CozyClayMannequin"
    body.data = body.data.copy()
    body.data.name = "CozyClayMannequinMesh"

    # The asset browser lays each catalogue preview out at a different world
    # location.  That placement is presentation metadata, not part of the
    # mannequin: keep the mesh's local coordinates and build the rig at the
    # same origin or the FBX bind matrix offsets skin from skeleton.
    body.location = (0.0, 0.0, 0.0)
    body.rotation_euler = (0.0, 0.0, 0.0)
    body.scale = (1.0, 1.0, 1.0)

    # Keep the animation-ready base topology; higher multires levels are
    # sculpting data and would only inflate the browser payload.
    for modifier in list(body.modifiers):
        body.modifiers.remove(modifier)
    body.data.materials.clear()
    return body


def make_faceless(body: bpy.types.Object) -> None:
    """Replace detailed head geometry with a smooth mannequin ellipsoid."""
    z_min = min(vertex.co.z for vertex in body.data.vertices)
    z_max = max(vertex.co.z for vertex in body.data.vertices)
    height = z_max - z_min
    center_z = z_min + height * 0.918
    neck_cut = z_min + height * 0.835
    center_y = -body.dimensions.y * 0.08

    mesh = bmesh.new()
    mesh.from_mesh(body.data)
    bmesh.ops.delete(mesh, geom=[v for v in mesh.verts if v.co.z > neck_cut], context="VERTS")
    mesh.to_mesh(body.data)
    mesh.free()

    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=48,
        ring_count=32,
        location=(0.0, center_y, center_z),
    )
    head = bpy.context.object
    head.name = "CozyClayFacelessHead"
    head.scale = (
        body.dimensions.x * 0.13,
        body.dimensions.y * 0.37,
        height * 0.095,
    )
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    bpy.ops.mesh.primitive_cylinder_add(
        vertices=32,
        radius=1.0,
        depth=height * 0.075,
        location=(0.0, center_y, neck_cut + height * 0.018),
    )
    neck = bpy.context.object
    neck.name = "CozyClayFacelessNeck"
    neck.scale = (body.dimensions.x * 0.105, body.dimensions.y * 0.28, 1.0)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    head.select_set(True)
    neck.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    body.data.name = "CozyClayMannequinMesh"


def add_bone(armature, name, head, tail, parent=None):
    bone = armature.edit_bones.new(f"mixamorig{name}")
    bone.head = head
    bone.tail = tail
    bone.parent = parent
    return bone


def create_rig(body: bpy.types.Object) -> bpy.types.Object:
    z_min = min(vertex.co.z for vertex in body.data.vertices)
    z_max = max(vertex.co.z for vertex in body.data.vertices)
    height = z_max - z_min
    center_y = (min(vertex.co.y for vertex in body.data.vertices) + max(vertex.co.y for vertex in body.data.vertices)) / 2

    # Use ARDY's own neutral joint layout as the deformation skeleton. This
    # keeps every rest direction congruent with CoreSkeleton27 instead of
    # asking the retargeter to compensate for a second arbitrary mannequin.
    names = [
        "Hips", "Spine", "Spine1", "Spine2", "Spine3", "Neck", "Head",
        "RightShoulder", "RightArm", "RightForeArm", "RightHand",
        "RightHandEnd", "RightHandThumb1", "LeftShoulder", "LeftArm",
        "LeftForeArm", "LeftHand", "LeftHandEnd", "LeftHandThumb1",
        "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase",
        "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase",
    ]
    neutral = [
        (0.0, 0.0, 0.0), (0.0, 0.0709891, -0.0473261),
        (0.0, 0.1642033, -0.0637623), (0.0, 0.2584953, -0.0720118),
        (0.0, 0.3531475, -0.0720119), (0.0, 0.6016096, -0.0365176),
        (0.0, 0.7297793, -0.0139179), (-0.0319949, 0.5259196, -0.0186873),
        (-0.1909029, 0.5259195, -0.0186873), (-0.4863389, 0.5259194, -0.0186873),
        (-0.7189909, 0.5259193, -0.0186873), (-0.7886024, 0.5259193, -0.0186873),
        (-0.7468355, 0.5073563, 0.0277204), (0.0319949, 0.5259196, -0.0186873),
        (0.1909029, 0.5259196, -0.0186873), (0.4863389, 0.5259196, -0.0186873),
        (0.7189909, 0.5259196, -0.0186873), (0.7886024, 0.5259196, -0.0186873),
        (0.7468355, 0.5073565, 0.0277204), (-0.0949182, -0.0277289, 0.0),
        (-0.0949182, -0.4398469, 0.0), (-0.0949182, -0.8959379, 0.0),
        (-0.0949182, -0.9544128, 0.1606583), (0.0949182, -0.0277289, 0.0),
        (0.0949182, -0.4398469, 0.0), (0.0949182, -0.8959379, 0.0),
        (0.0949182, -0.9544128, 0.1606583),
    ]
    parent_names = {
        "Spine": "Hips", "Spine1": "Spine", "Spine2": "Spine1", "Spine3": "Spine2",
        "Neck": "Spine3", "Head": "Neck",
        "RightShoulder": "Spine3", "RightArm": "RightShoulder",
        "RightForeArm": "RightArm", "RightHand": "RightForeArm",
        "RightHandEnd": "RightHand", "RightHandThumb1": "RightHand",
        "LeftShoulder": "Spine3", "LeftArm": "LeftShoulder",
        "LeftForeArm": "LeftArm", "LeftHand": "LeftForeArm",
        "LeftHandEnd": "LeftHand", "LeftHandThumb1": "LeftHand",
        "RightUpLeg": "Hips", "RightLeg": "RightUpLeg",
        "RightFoot": "RightLeg", "RightToeBase": "RightFoot",
        "LeftUpLeg": "Hips", "LeftLeg": "LeftUpLeg",
        "LeftFoot": "LeftLeg", "LeftToeBase": "LeftFoot",
    }
    primary_child = {
        "Hips": "Spine", "Spine": "Spine1", "Spine1": "Spine2", "Spine2": "Spine3",
        "Spine3": "Neck", "Neck": "Head",
        "RightShoulder": "RightArm", "RightArm": "RightForeArm",
        "RightForeArm": "RightHand", "RightHand": "RightHandEnd",
        "LeftShoulder": "LeftArm", "LeftArm": "LeftForeArm",
        "LeftForeArm": "LeftHand", "LeftHand": "LeftHandEnd",
        "RightUpLeg": "RightLeg", "RightLeg": "RightFoot", "RightFoot": "RightToeBase",
        "LeftUpLeg": "LeftLeg", "LeftLeg": "LeftFoot", "LeftFoot": "LeftToeBase",
    }
    index = {name: i for i, name in enumerate(names)}
    hips_z = z_min + height * 0.53
    scale = (hips_z - z_min) / 0.9544128

    def joint(name):
        x, y, z = neutral[index[name]]
        return Vector((x * scale, center_y - z * scale, hips_z + y * scale))

    armature = bpy.data.armatures.new("CozyClayArmature")
    rig = bpy.data.objects.new("CozyClayRig", armature)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")

    bones = {}
    for name in names:
        head = joint(name)
        child_name = primary_child.get(name)
        if child_name:
            tail = joint(child_name)
        else:
            parent_name = parent_names.get(name)
            direction = (head - joint(parent_name)).normalized() if parent_name else Vector((0, 0, 1))
            tail = head + direction * max(height * 0.025, 0.02)
        parent = bones.get(parent_names.get(name))
        bones[name] = add_bone(armature, name, head, tail, parent)
        # CozyClay pose presets swing arms around local X.  Blender's default
        # roll puts X vertically on a horizontal bone, which sends that swing
        # behind the torso; a quarter-turn makes local X point front/back.
        if any(part in name for part in ("Shoulder", "Arm", "Hand")):
            bones[name].roll = -math.pi / 2 if name.startswith("Left") else math.pi / 2

    bpy.ops.object.mode_set(mode="OBJECT")
    return rig


def bind(body: bpy.types.Object, rig: bpy.types.Object) -> None:
    body.vertex_groups.clear()
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    if not body.vertex_groups:
        raise RuntimeError("Blender automatic skinning produced no vertex groups")


def bind_nearest_for_reference(body: bpy.types.Object, rig: bpy.types.Object) -> None:
    """Legacy deterministic fallback kept as reference for debugging only."""
    body.parent = rig
    modifier = body.modifiers.new("CozyClayArmature", "ARMATURE")
    modifier.object = rig
    body.vertex_groups.clear()

    deform_bones = [
        bone for bone in rig.data.bones
        if not bone.name.endswith(("HandEnd", "HandThumb1"))
    ]
    groups = {bone.name: body.vertex_groups.new(name=bone.name) for bone in deform_bones}

    def segment_distance(point, bone):
        start = bone.head_local
        delta = bone.tail_local - start
        t = max(0.0, min(1.0, (point - start).dot(delta) / max(delta.length_squared, 1e-9)))
        return (point - (start + delta * t)).length

    hips_z = rig.data.bones["mixamorigHips"].head_local.z
    for vertex in body.data.vertices:
        point = vertex.co
        candidates = []
        for bone in deform_bones:
            name = bone.name
            if point.x > 0.025 and "Right" in name:
                continue
            if point.x < -0.025 and "Left" in name:
                continue
            limb = any(part in name for part in ("Shoulder", "Arm", "Hand", "UpLeg", "Leg", "Foot", "Toe"))
            if abs(point.x) < 0.07 and limb:
                continue
            if point.z > hips_z + 0.08 and any(part in name for part in ("UpLeg", "Leg", "Foot", "Toe")):
                continue
            if point.z < hips_z - 0.08 and any(part in name for part in ("Shoulder", "Arm", "Hand", "Neck", "Head")):
                continue
            candidates.append((segment_distance(point, bone), bone.name))
        nearest = sorted(candidates)[:4]
        raw = [(1.0 / max(distance, 0.015) ** 4, name) for distance, name in nearest]
        total = sum(weight for weight, _name in raw)
        for weight, name in raw:
            groups[name].add([vertex.index], weight / total, "REPLACE")


def export_fbx(output_path: Path, body: bpy.types.Object, rig: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    output_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.fbx(
        filepath=str(output_path),
        use_selection=True,
        object_types={"ARMATURE", "MESH"},
        apply_unit_scale=True,
        apply_scale_options="FBX_SCALE_ALL",
        add_leaf_bones=False,
        bake_anim=False,
        mesh_smooth_type="FACE",
        path_mode="STRIP",
    )


def build(source_path: Path, output_dir: Path, kind: str) -> None:
    reset_scene()
    body = load_body(source_path, SOURCE_OBJECTS[kind])
    make_faceless(body)
    # Keep Blender Studio's authored neutral stance intact.  It is already a
    # clean animation base; reshaping vertices heuristically damages shoulders
    # and elbows.  The generated skeleton/rest metadata performs retargeting.
    body.data.update()
    rig = create_rig(body)
    bind(body, rig)
    export_fbx(output_dir / f"cozyclay-{kind}-neutral.fbx", body, rig)
    print(f"built {kind}: {len(body.data.vertices)} vertices, {len(rig.data.bones)} bones")


def main() -> None:
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if len(args) != 1:
        raise SystemExit("expected source .blend path after --")
    source_path = Path(args[0]).resolve()
    if not source_path.is_file():
        raise SystemExit(f"source bundle not found: {source_path}")
    output_dir = Path(__file__).resolve().parents[2] / "public" / "models"
    for kind in SOURCE_OBJECTS:
        build(source_path, output_dir, kind)


if __name__ == "__main__":
    main()
