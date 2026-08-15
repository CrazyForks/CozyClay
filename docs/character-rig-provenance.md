# CC0 character rig provenance

CozyClay's two blocking mannequins are built from Blender Foundation's Human
Base Meshes v1.4.1. The selected realistic male and female bodies are neutral,
untextured base meshes released under CC0 1.0.

The downloaded source archive is:

- `human-base-meshes-bundle-v1.4.1.zip`
- SHA-256 `811f43accbb31a88266d932f8f5563b2d13586fca0ba2693aad1f5fe582b3515`
- https://download.blender.org/demo/asset-bundles/human-base-meshes/human-base-meshes-bundle-v1.4.1.zip

`tools/models/build-cc0-mannequins.py` performs the project-specific work:

1. loads the male and female realistic body meshes;
2. turns the source A-pose into CozyClay's T-pose;
3. removes source materials and sculpt-only multiresolution data;
4. creates the same 27-joint ARDY-compatible armature for both bodies;
5. generates skin weights and limits each vertex to four influences; and
6. exports metre-scale FBX files for the browser.

The former Adobe Mixamo X-Bot and Y-Bot files are not included in the source
tree, npm package, static build or service-worker cache.

## Regenerating

Install Blender 5.2 or newer, download the official archive, extract it, then:

```sh
npm run models:build -- /absolute/path/to/human_base_meshes_bundle.blend
```

After regeneration, run `npm run ardy:rest`, `npm run test:ardy`,
`npm run test:licenses`, and `npm run build`.
