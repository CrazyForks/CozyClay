# Hierarchy attach — frozen contracts (2026-08-30)

Goal: drag an OBJECT row in the Hierarchy onto a character (or one of its rig
bones) to ATTACH the prop — it then follows the character's animated motion
(the "carry the baseball bat" feature). Dragging back to Props detaches.
Object→object drops reuse the existing grouping parent.

WHY: props are world-anchored today, so a generated "walks with a bat" take
walks away from its bat. The data model only knows object→object grouping
(`parent`), the Hierarchy has NO row drag at all (file drops only), and the
renderer (props.jsx SceneObject) never reads the rig.

## A1 — data model (src/scene-objects.js)

```js
object.attach = null | { characterId: string, bone: string | null }
```
- `bone === null` = the character's animated ROOT frame; otherwise one of
  SCENE_ATTACH_BONES (exported const, frozen array):
  hips, spine, chest, neck, head, leftShoulder, leftElbow, leftHand,
  rightShoulder, rightElbow, rightHand, leftKnee, leftFoot, rightKnee,
  rightFoot  — the app's IK track ids, NOT three.js bone names.
- `setSceneObjectAttach(objects, id, attach)` → new array or the SAME array
  when refused/no-op (the setSceneObjectParent convention). Attaching CLEARS
  `parent`; `setSceneObjectParent` to a non-null parent CLEARS `attach`.
  Refuse unknown bone keys and malformed shapes. characterId is NOT validated
  here (the store does not know the cast); a dangling characterId renders as
  detached and is dropped at decode.
- Serialization: encode/decode `attach` beside `parent` (same record shape
  guards: wrong types decode to null).
- While ATTACHED, the object's x/y/z/rot*/scale* are its LOCAL transform in
  the attach frame. The world↔local conversion at attach/detach time is the
  APP's job (it has the three scene); the store treats numbers as opaque.

## A2 — hierarchy UI (src/hierarchy-model.js, src/hierarchy-panel.jsx)

- buildHierarchyNodes: an object with `attach` no longer lists under Props —
  it nests under its character's row (kind "object", same `object:<id>` row
  id; when attached to a bone, append the bone to the label, e.g.
  "Bat · Right Hand"). Unknown characterId → stays under Props.
- Row drag: rows of kind "object" become draggable
  (`dataTransfer.setData("application/x-cclay-hierarchy", rowId)`). The panel
  accepts a new optional prop:
  ```jsx
  reparent={{ canDrop: (sourceRowId, targetRowId) => bool,
              onDrop:  (sourceRowId, targetRowId) => void }}
  ```
  Drop feedback reuses the existing data-drop styling; canDrop gates the
  highlight AND the drop. The panel has NO policy — every rule lives in the
  App's canDrop. File drops (pictures) must keep working unchanged.
- Panel/model tests extend test/verify-hierarchy.mjs.

## A3 — app wiring + renderer (src/App.jsx, src/props.jsx, src/styles.css)

- canDrop/onDrop mapping (source must be `object:<id>`):
  - target `object:<other>`  → setSceneObjectParent (existing rules decide)
  - target character row (characterA / characterB / character:<id>)
    → attach { characterId, bone: null }
  - target bone row (`rig.leftHand` …, the characterA rig subtree)
    → attach { characterId: characters[0].id, bone: "leftHand" }
    (only bone ids in SCENE_ATTACH_BONES; group rows rig.torso/rig.leftArm
    etc. are NOT targets)
  - target `props` row → detach (attach: null, parent: null)
  - everything else → false
- NO VISUAL JUMP: on attach, convert the object's current WORLD transform to
  the attach frame's local and write it into x/y/z/rot*/scale*; on detach,
  convert back to world. One scene transaction per drop (undo restores both
  the field and the numbers).
- Renderer: an attached SceneObject follows the LIVE bone/root every frame
  (r3f createPortal into the bone object, or a useFrame world-matrix copy —
  implementer's choice, but it must track during playback and offscreen
  export, not only on re-render). `window.__cclayPropWorld[id]` must keep
  reporting the WORLD position of attached objects every frame — the QA hook
  the browser gate reads.
- Inspector: when attached, the Parent dropdown row shows the attachment
  ("Character 1 · Right Hand") with a detach button; the dropdown's
  object-parent options hide while attached.

## File ownership (NO other files; nobody touches tools/run-tests.mjs;
## NO commits, NO git; NO browser/QA-port use — main session verifies)

| Agent | Files |
|---|---|
| A1 | src/scene-objects.js, test/verify-scene-objects.mjs |
| A2 | src/hierarchy-model.js, src/hierarchy-panel.jsx, test/verify-hierarchy.mjs |
| A3 | src/App.jsx, src/props.jsx, src/styles.css |

## Gates (main session, after merge)

- G1 unit: verify-scene-objects (attach rules, exclusivity, serialization
  round-trip), verify-hierarchy (nesting + drag wiring), full node suite.
- G2 browser (CDP, 5280): add a Cube, dispatch DragEvent row→Character 1 →
  row nests under the character; play the take → __cclayPropWorld[cube]
  tracks the character (varies over frames, bounded distance to the root);
  drag row→rig.rightHand → tracks the hand (differs from root attach);
  drag row→Props → world-anchored again, no jump at each step.
