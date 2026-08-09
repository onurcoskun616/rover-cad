"""
Crank-Piston kinematic simulation — proof of concept.

Generates four parts (Crank, ConRod, Piston, Block), exports each as STL,
and writes a kinematics.json that the frontend Kinematic Player can animate.

Expected globals (injected by simulationExportService):
  _rover_sim_out  — output directory path
  _rover_sim_ts   — timestamp for unique file names
"""

import FreeCAD, Part, Mesh, os, json, math

doc = FreeCAD.ActiveDocument

# ROVER_PARAMS_START
crank_radius = 30.0   # mm
conrod_length = 80.0   # mm
piston_radius = 20.0   # mm
piston_height = 30.0   # mm
block_width = 60.0     # mm
block_height = 100.0   # mm
block_depth = 50.0     # mm
crank_thickness = 10.0 # mm
# ROVER_PARAMS_END

out = _rover_sim_out
ts = _rover_sim_ts

# --- Crank: flat arm from origin to (crank_radius, 0, 0) with pin cylinder ---

arm_width = 12.0
arm = Part.makeBox(crank_radius, arm_width, crank_thickness,
                   FreeCAD.Vector(0, -arm_width / 2, -crank_thickness / 2))

hub = Part.makeCylinder(arm_width / 2, crank_thickness,
                        FreeCAD.Vector(0, 0, -crank_thickness / 2))

pin = Part.makeCylinder(5.0, crank_thickness,
                        FreeCAD.Vector(crank_radius, 0, -crank_thickness / 2))

crank_shape = arm.fuse(hub).fuse(pin)
crank_obj = doc.addObject("Part::Feature", "Crank")
crank_obj.Shape = crank_shape

# --- ConRod: thin bar from (crank_radius, 0, 0) to (crank_radius + conrod_length, 0, 0) ---

rod_width = 8.0
rod_thick = 6.0
rod = Part.makeBox(conrod_length, rod_width, rod_thick,
                   FreeCAD.Vector(crank_radius, -rod_width / 2, -rod_thick / 2))

rod_hole1 = Part.makeCylinder(4.0, rod_thick * 2,
                              FreeCAD.Vector(crank_radius, 0, -rod_thick))
rod_hole2 = Part.makeCylinder(4.0, rod_thick * 2,
                              FreeCAD.Vector(crank_radius + conrod_length, 0, -rod_thick))
rod_shape = rod.cut(rod_hole1).cut(rod_hole2)
conrod_obj = doc.addObject("Part::Feature", "ConRod")
conrod_obj.Shape = rod_shape

# --- Piston: cylinder at (crank_radius + conrod_length, 0, 0) ---

piston_x = crank_radius + conrod_length
piston = Part.makeCylinder(piston_radius, piston_height,
                           FreeCAD.Vector(piston_x, 0, -piston_height / 2),
                           FreeCAD.Vector(1, 0, 0))
piston_obj = doc.addObject("Part::Feature", "Piston")
piston_obj.Shape = piston

# --- Block: housing around piston travel ---

travel = 2 * crank_radius
block_x_start = piston_x - travel - 10
block = Part.makeBox(block_width + travel + 20, block_height, block_depth,
                     FreeCAD.Vector(block_x_start,
                                   -block_height / 2,
                                   -block_depth / 2))
bore = Part.makeCylinder(piston_radius + 1, block_width + travel + 40,
                         FreeCAD.Vector(block_x_start - 10, 0, 0),
                         FreeCAD.Vector(1, 0, 0))
block_shape = block.cut(bore)
block_obj = doc.addObject("Part::Feature", "Block")
block_obj.Shape = block_shape

doc.recompute()

# --- Export each part as STL ---

parts_map = {
    "Crank": crank_obj,
    "ConRod": conrod_obj,
    "Piston": piston_obj,
    "Block": block_obj,
}

for name, obj in parts_map.items():
    stl_path = os.path.join(out, f"sim_{ts}_{name}.stl")
    mesh_data = doc.addObject("Mesh::Feature", f"Mesh_{name}")
    mesh_data.Mesh = Mesh.Mesh(obj.Shape.tessellate(0.5))
    Mesh.export([mesh_data], stl_path)
    print(f"PART_STL:{name}={stl_path}")

# --- Write kinematics.json ---

kin = {
    "version": 1,
    "parts": {
        "Crank": {"mesh": "Crank"},
        "ConRod": {"mesh": "ConRod"},
        "Piston": {"mesh": "Piston"},
        "Block": {"mesh": "Block"},
    },
    "joints": [
        {
            "type": "Revolute",
            "name": "crank_main",
            "child": "Crank",
            "origin": [0, 0, 0],
            "axis": [0, 0, 1],
            "driven": True,
            "speed": 180,
        }
    ],
    "constraints": [
        {
            "type": "CrankSlider",
            "crank_joint": "crank_main",
            "crank_radius": crank_radius,
            "rod_part": "ConRod",
            "rod_length": conrod_length,
            "rod_origin": [crank_radius, 0, 0],
            "slider_part": "Piston",
            "slider_axis": [1, 0, 0],
            "slider_origin": [crank_radius + conrod_length, 0, 0],
        }
    ],
    "collision_pairs": [["Piston", "Block"]],
}

kin_path = os.path.join(out, f"sim_{ts}_kinematics.json")
with open(kin_path, "w") as f:
    json.dump(kin, f, indent=2)

print(f"KINEMATICS_PATH={kin_path}")
