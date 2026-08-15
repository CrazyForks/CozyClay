# Replacing the Mixamo rigs

## Why

`public/models/x-bot-tpose.fbx` and `y-bot-tpose.fbx` are Adobe Mixamo
characters. Adobe's terms allow using Mixamo content inside a project and do not
allow distributing the raw character files. CozyClay distributes them three ways:

- committed to this repository
- packed into the npm tarball as `dist/models/`
- served directly from `https://cozyclay.org/models/y-bot-tpose.fbx`

The third is the plainest form of the thing Adobe disallows: a URL that returns
the character file. The repository is also GPL-3.0-or-later, which cannot apply
to Adobe's assets, so a fork inherits a licence that does not actually cover two
of the files it just cloned.

## Candidates

All CC0, so redistribution stops being a question.

| Source | Male / female bodies | Rigged | Notes |
| --- | --- | --- | --- |
| [Blender Studio Human Base Meshes](https://www.blender.org/download/demo-files/) | Yes, realistic and stylised | **No** | Best topology. Sculpting bases, so rigging is on us. |
| [MakeHuman](http://www.makehumancommunity.org/) exports | Generated to spec | Yes | Exports from an official unmodified build are CC0. Proportions dialled in rather than picked. |
| [Quaternius Universal Animation Library](https://quaternius.com/packs/universalanimationlibrary.html) | Single neutral mannequin | Yes | Fastest drop-in, states Mixamo rig compatibility, but no body-type split. |

The tool needs distinct male and female proportions, because eyeline and shoulder
width change what a given camera height reads as — which is the whole point of
blocking a shot. That rules the single mannequin out as a complete answer.

## What has to hold after the swap

The rig is not just a mesh here. Three things depend on its skeleton:

1. **Bone naming.** `src/App.jsx` loads the rig and the ARDY path maps onto
   `mixamorig:`-prefixed joints. A replacement either matches that naming or the
   mapping gains a translation layer.
2. **ARDY retargeting.** `tools/ardy/` converts generated motion onto the rig.
   Joint count, rest pose and axis conventions all matter.
3. **Pose presets and IK.** `BUILT_IN_POSES` and the sparse IK correction assume
   the current joint set.

## Order of work

1. Export a male and a female base at previz proportions, T-pose, CC0 source.
2. Rig with a skeleton whose joint names match the existing mapping, or add the
   translation layer and keep the rigs clean.
3. Load in the studio and confirm the character renders and poses.
4. Run `npm run test:ardy` and play back the shipped sample clip.
5. Replace the files, delete the Mixamo pair, and drop the Character models
   section from `THIRD_PARTY_NOTICES.md`.

Step 4 is the one that decides whether this is a file swap or a retargeting job.
