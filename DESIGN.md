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

## 3. Type and Spacing

- Inherit the existing editor font and 10–11 px control scale.
- Use the existing 4 px-based compact spacing and 28 px camera-tool height.

## 4. Motion and Interaction

- Camera toolbar actions respond immediately.
- Binary camera actions state themselves in text (`Follow On` / `Follow Off`)
  and expose `aria-pressed`; the On state uses the existing blue accent.
- Active drawing state continues to use the existing filled violet state.
- Destructive rail deletion uses a red hover/focus cue and an explicit text
  label; no icon-only or right-click-only deletion.
- Keyboard focus must remain visible.

## 5. Reusable Primitives

- `.tl-camera-tool`: compact camera-toolbar action.
- `.tl-camera-tool.active`: active/engaged action.
- `.tl-camera-tool.danger`: destructive camera-toolbar action.
- `.tl-camera-metric`: read-only measured camera value.
