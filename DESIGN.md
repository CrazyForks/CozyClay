# CozyClay Studio Design Contract

## 0. Research Log

- Existing product surface: preserved the current dark Unity-like editor,
  compact timeline controls, violet camera identity, and bilingual labels.
- Interaction reference: the destructive action uses the existing immediate
  editor-button mechanism; no modal or animation is introduced because rail
  geometry is reversible by drawing it again and the state change is local.
- No new dependency, font, layout primitive, or motion token is required.

## 1. Direction

CozyClay is a dense production tool, not a dashboard. Controls stay compact,
technical, and close to the timeline state they change.

## 2. Color

- Editor surface: existing `#201c28` and `#2b2731`.
- Camera/rail identity: existing violet family (`#7258a0`, `#a78bfa`).
- Destructive action: existing product red `#e5484d`, used only for removal.
- Range-pin identity: `--range-pin-hand: #ff8a3d` for hand bands and markers, `--range-pin-foot: #4dd2ff` for foot bands and markers. Their ramp uses the same ink at reduced alpha for blend edges and selected washes; no accent border marks selection.

## 3. Type and Spacing

- Inherit the existing editor font and 10–11 px control scale.
- Use the existing 4 px-based compact spacing and 28 px camera-tool height.

## 4. Motion and Interaction

- Camera toolbar actions respond immediately.
- Crane editing exposes explicit Add point and Remove point actions beside the
  selected point height and count. Add point fills the largest un-authored
  interval and selects the new mark; Remove point is enabled only for a
  selected interior mark. The scene double-click/Delete gestures remain
  accelerators, never the only discoverable route.
- When a Shot uses Rail + Crane, its lower key strip represents crane progress:
  clicking the strip authors a crane point at that rail position, and the
  matching purple/amber marker stays synchronized with the scene handle.
- Binary camera actions state themselves in text (`Follow On` / `Follow Off`)
  and expose `aria-pressed`; Follow sits directly beside `Draw rail` and uses
  the existing violet Camera Block active state.
- Active drawing state continues to use the existing filled violet state.
- Destructive rail deletion uses a red hover/focus cue and an explicit text
  label; no icon-only or right-click-only deletion.
- Keyboard focus must remain visible.
- The camera tutorial's existing card owns the first-shot handoff: one primary
  Export action and one Continue editing dismissal. It uses existing panel,
  border, text and accent tokens, 8 px gaps and the 11 px control scale. Only
  buttons take pointer input. The existing Export popover owns delivery and
  keyboard focus; no second menu or modal is introduced.
- The hosted tutorial reuses its completion area for the edited-project
  download and local Studio instructions. Continue editing keeps the iframe
  alive. Pending/error/download-requested states use text, not animation.
- Full-Body editing is direct and frame-addressed: `Cut` splits at the
  playhead, while each resulting green segment owns a compact speed selector.
  Speed changes redraw the segment width immediately; there is no decorative
  transition because the new duration is the information.
- Full-Body speed runs from `0.1×` to `4.0×` in `0.1×` steps. The current
  segment is identified by the playhead and receives the brighter green
  selected state. Its slider and numeric stepper stay in the fixed timeline
  header instead of inside the segment, so a one-frame segment remains
  editable. Outer trim handles continue to own only the complete take's
  in/out points.

## 5. Reusable Primitives

- `.tl-camera-tool`: compact camera-toolbar action.
- `.tl-camera-tool.active`: active/engaged action.
- `.tl-camera-tool.danger`: destructive camera-toolbar action.
- `.tl-camera-metric`: read-only measured camera value.
- `.tl-motion-clip`: one cut Full-Body segment.
- `.tl-motion-clip.selected`: segment currently under the playhead.
- `.tl-motion-speed-editor`: fixed header slider + numeric stepper for the
  Full-Body segment under the playhead.
- `.tl-crane-editor`: card-local time/height graph; the whole graph is a
  click target for insertion, points have enlarged pointer targets, and
  vertical drags edit height without moving the Shot block.
- `.motion-readiness`: compact, text-labelled generation status beside the
  existing generation controls. It distinguishes checking, ready, not configured,
  unavailable, and unsupported request routes without gating authoring.
  It inherits `--fg`, `--muted`, `--cyan`, `--panel`, `--line2`, `--radius`,
  the 11 px inspector type scale, and 4/8 px spacing. State is never colour-only.
- `.motion-setup`: an explicitly opened region in the existing Settings popover,
  not a modal or another topbar control. Setup documentation opens separately;
  Retry only probes health. Both preserve the scene and prompt blocks.
  The popover scrolls within the viewport, commands wrap, and controls remain
  reachable at 390 px. Status updates use polite announcements, visible keyboard
  focus, and immediate state changes without decorative animation.
- `.camera-tutorial-handoff`: contextual action row inside the existing
  tutorial. It wraps at narrow widths and has visible keyboard focus.
- `.range-pin-panel`: compact IK Inspector section composed from `.field`,
  `.btn`, and `.inspector-hint`; owns the pin draft, validation, target choice,
  and per-character pin list. It is the scroll child of `.inspector-pane`,
  supports keyboard I/O frame shortcuts while active, and uses tonal selected
  washes rather than accent borders.
- `.tl-pin-band`: a Full-Body lane range band with inclusive frame geometry,
  faded blend ramps, hand/foot color tokens, and a click target that selects the
  corresponding `.range-pin-panel` draft. The timeline lane remains the scroll
  owner; bands never create a second scroll region.
- `.range-pin-target-marker`: a poser-only world marker and effector-to-target
  guide line. It is visible only for the active pin tool/selection, follows an
  object target at the playhead, and is hidden from delivery captures.

## 6. Motion and Interaction

- Range-pin edits are one committed action: Apply/Delete records one character
  undo snapshot containing both `pins` and their baked tagged keys. Rebuilding an
  object-target pin is debounced at 150ms after object transforms settle and does
  not create a second undo entry. `I` and `O` set the draft's inclusive In/Out
  frames to the playhead only while the Pin tool is active; reduced motion keeps
  the same immediate state changes without transitions.

## 7. Depth and Surface

- Use the existing dark tonal-shift editor surfaces, `--panel`, `--card2`,
  `--line`, and `--line2`. Pin state is expressed with washes, glyphs, and
  color-coded bands; no new shadow or border language is introduced.

## 8. Accessibility Constraints and Accepted Debt

- WCAG 2.2 AA intent: every pin control is keyboard reachable, labels are
  English-first through `ko()`, validation is inline and announced in the
  panel, focus remains visible, disabled object-target controls explain why,
  and `prefers-reduced-motion` removes decorative transitions.
- Accepted debt: edge dragging on pin bands is deferred; selecting the band and
  editing In/Out fields remains the shipped route.
