"""
Measures each GLTF model the way Murow's renderer actually sees it, to derive
the GLTF_SCALE_* / UNIT_HEIGHT_* constants in shared/constants.ts.

Run from the repo root:  python scripts/measure-gltf-scale.py

Why this isn't just "read the glTF bounding box"
------------------------------------------------
An earlier version of this script composed every node transform from the mesh
up to the scene root, which is what the glTF spec says a conforming viewer
does. It reported the champion at 0.024 units tall; the renderer draws it at
2.07 — a factor of ~86 out, which is exactly the 0.01 scale the Sketchfab
exporter parks on an ancestor node.

Murow's parser (packages/murow/src/renderer/gltf/parser.ts) does NOT walk that
ancestor chain. For each mesh it looks up the first node that references it
(`nodes.find(n => n.mesh === meshIdx)`) and:

  * bakes ONLY that node's own local transform into the vertices, and
  * skips vertex baking entirely when the mesh is skinned, because the skin's
    joint hierarchy is what places those vertices at draw time.

So the numbers that matter are the post-parser vertex positions, and that is
what this script reproduces. Its output should match the per-mesh `halfX/halfY/
halfZ` (doubled) that `WebGPU3DRenderer` computes when it uploads each part.

Skinned meshes are measured in their bind pose (the accessor's raw min/max),
not the actual idle-animation pose, so treat the champion and minion as
close-but-not-exact.
"""
import json
import os

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Target world-space heights from shared/constants.ts, so the script can print
# the scale factor each model needs rather than leaving it as mental arithmetic.
TARGETS = {
    'hero': ('champion', 'GLTF_SCALE_CHAMPION', 1.8, 'y'),
    'minion': ('minion', 'GLTF_SCALE_MINION', 1.0, 'y'),
    # The tower is authored Z-up and re-rotated per instance
    # (GLTF_ROTATION_TOWER), so its *depth* is what becomes its height.
    'tower': ('tower', 'GLTF_SCALE_TOWER', 4.5, 'z'),
}
AXES = ('x', 'y', 'z')


def mat4_mul(a, b):
    """Column-major 4x4 multiply, a*b."""
    out = [0.0] * 16
    for col in range(4):
        for row in range(4):
            s = 0.0
            for k in range(4):
                s += a[k * 4 + row] * b[col * 4 + k]
            out[col * 4 + row] = s
    return out


def node_matrix(node):
    """The node's own local transform, matching helpers.ts `nodeToMat4`."""
    if 'matrix' in node:
        return node['matrix']
    t = node.get('translation', [0, 0, 0])
    x, y, z, w = node.get('rotation', [0, 0, 0, 1])
    s = node.get('scale', [1, 1, 1])

    xx, yy, zz = x * x, y * y, z * z
    xy, xz, yz = x * y, x * z, y * z
    wx, wy, wz = w * x, w * y, w * z
    rot = [
        1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
        2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
        2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
        0, 0, 0, 1,
    ]
    scale_mat = [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1]
    trans_mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1]
    return mat4_mul(trans_mat, mat4_mul(rot, scale_mat))


def transform(m, p):
    x, y, z = p
    return (
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
    )


def has_own_transform(node):
    return any(k in node for k in ('matrix', 'translation', 'rotation', 'scale'))


def bbox_of_primitive(gltf, primitive, matrix):
    """Post-parser AABB of one primitive, or None if it carries no bounds."""
    accessor_idx = primitive.get('attributes', {}).get('POSITION')
    if accessor_idx is None:
        return None
    accessor = gltf['accessors'][accessor_idx]
    lo, hi = accessor.get('min'), accessor.get('max')
    if not lo or not hi:
        return None
    if matrix is None:
        return list(lo), list(hi)

    # A rotation can turn the box, so transform all 8 corners rather than
    # just the two extremes.
    out_lo = [float('inf')] * 3
    out_hi = [float('-inf')] * 3
    for cx in (lo[0], hi[0]):
        for cy in (lo[1], hi[1]):
            for cz in (lo[2], hi[2]):
                for i, v in enumerate(transform(matrix, (cx, cy, cz))):
                    out_lo[i] = min(out_lo[i], v)
                    out_hi[i] = max(out_hi[i], v)
    return out_lo, out_hi


def measure(name):
    path = os.path.join(REPO_ROOT, 'public', 'models', name, 'scene.gltf')
    with open(path) as f:
        gltf = json.load(f)

    nodes = gltf['nodes']
    meshes = gltf.get('meshes', [])
    has_skins = bool(gltf.get('skins'))

    # Mirrors the parser: mesh indices in node order, each resolved back to the
    # FIRST node that references it.
    mesh_indices = [n['mesh'] for n in nodes if 'mesh' in n] or [0]

    label, const_name, target, target_axis = TARGETS.get(name, (name, '?', None, 'y'))
    print(f'=== {label} ({name}/scene.gltf) ===')

    overall_lo = [float('inf')] * 3
    overall_hi = [float('-inf')] * 3
    primary_size = None

    for mesh_idx in mesh_indices:
        mesh = meshes[mesh_idx]
        node = next(n for n in nodes if n.get('mesh') == mesh_idx)
        skinned = has_skins and 'skin' in node

        matrix = None
        note = 'raw accessor bounds'
        if skinned:
            note = 'skinned, parser skips vertex baking'
        elif has_own_transform(node):
            matrix = node_matrix(node)
            note = "mesh node's own transform baked"

        for primitive in mesh.get('primitives', []):
            box = bbox_of_primitive(gltf, primitive, matrix)
            if box is None:
                continue
            lo, hi = box
            size = [hi[i] - lo[i] for i in range(3)]
            if primary_size is None:
                primary_size = size
            print(f"  {node.get('name', f'node[{mesh_idx}]'):<48} "
                  f"size {[round(v, 4) for v in size]}  ({note})")
            for i in range(3):
                overall_lo[i] = min(overall_lo[i], lo[i])
                overall_hi[i] = max(overall_hi[i], hi[i])

    size = [overall_hi[i] - overall_lo[i] for i in range(3)]
    print(f'  {"WHOLE MODEL":<48} size {[round(v, 4) for v in size]}')
    print(f'  min {[round(v, 3) for v in overall_lo]}  max {[round(v, 3) for v in overall_hi]}')

    if target is not None and primary_size is not None:
        # Scale off the FIRST part, not the union: parts are loaded in node
        # order and in these exports part 0 is the body / the tower shaft —
        # the thing whose size the player reads as the unit's size. The union
        # is skewed by outliers (the champion's weapon reaches above its
        # head, so sizing to it leaves the champion visibly short).
        raw = primary_size[AXES.index(target_axis)]
        axis_note = '' if target_axis == 'y' else f', re-rotated to vertical at spawn'
        print(f'  -> first part raw {target_axis.upper()} = {round(raw, 4)}{axis_note}')
        print(f'     for a {target}-unit tall unit: {const_name} = {round(target / raw, 4)}')
    print()


for model in ('hero', 'minion', 'tower'):
    measure(model)

print('These should reproduce the GLTF_SCALE_* values already in')
print('shared/constants.ts. If they do not, the model changed - update the')
print('constant rather than nudging the number until it looks right.')
