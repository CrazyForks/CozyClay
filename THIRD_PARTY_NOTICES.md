# Third-Party Notices

CozyClay is an independent project. The names and licenses below apply only to their respective third-party projects and do not imply sponsorship, affiliation, or endorsement.

## Runtime libraries in the build

These are compiled into `dist/assets/` and therefore redistributed with every
build, the npm package and the hosted site. Verbatim licence texts are in
[`licenses/`](licenses/).

### Three.js

CozyClay's browser-based studio uses [Three.js](https://threejs.org/) through
`three`, `@react-three/fiber`, and `@react-three/drei`.

- Copyright © 2010-2026 three.js authors
- License: MIT
- Source: https://github.com/mrdoob/three.js
- License text: [`licenses/three.js-LICENSE.txt`](licenses/three.js-LICENSE.txt)

### React and React DOM

- Copyright (c) Meta Platforms, Inc. and affiliates
- License: MIT
- Source: https://github.com/facebook/react
- License text: [`licenses/react-LICENSE.txt`](licenses/react-LICENSE.txt)

### @react-three/fiber and @react-three/drei

- Copyright (c) 2020 react-spring
- License: MIT
- Source: https://github.com/pmndrs/react-three-fiber, https://github.com/pmndrs/drei
- License text: [`licenses/react-three-fiber-LICENSE.txt`](licenses/react-three-fiber-LICENSE.txt),
  [`licenses/react-three-drei-LICENSE.txt`](licenses/react-three-drei-LICENSE.txt)

### Draco

Three.js ships Google's Draco decoder for compressed geometry. It is a separate
project with its own licence, and it is emitted into the build as
`dist/assets/draco_decoder*` and `dist/assets/draco_wasm_wrapper*`.

- Copyright Google LLC
- License: Apache-2.0
- Source: https://github.com/google/draco
- License text: [`licenses/draco-LICENSE.txt`](licenses/draco-LICENSE.txt)

### Basis Universal

Three.js ships the Basis Universal transcoder for compressed textures, emitted
as `dist/assets/basis_transcoder*`.

- Copyright 2019-2026 Binomial LLC
- License: Apache-2.0
- Source: https://github.com/BinomialLLC/basis_universal
- License text: [`licenses/basis-universal-LICENSE.txt`](licenses/basis-universal-LICENSE.txt)

## Fonts

CozyClay bundles subsets of two typefaces. Both are licensed under the SIL Open
Font License 1.1, which allows redistribution with software, including
commercially, provided the copyright notice and the licence travel with the
files. The licence texts sit in `public/fonts/` so they follow the build into
`dist/fonts/` and into the npm package rather than staying behind in the repo.

### Inter

- Copyright (c) 2016 The Inter Project Authors
- License: SIL Open Font License 1.1
- Source: https://github.com/rsms/inter
- License text: `public/fonts/Inter-OFL.txt`

### Instrument Serif

- Copyright 2022 The Instrument Serif Project Authors
- License: SIL Open Font License 1.1
- Source: https://github.com/Instrument/instrument-serif
- License text: `public/fonts/InstrumentSerif-OFL.txt`

## Character models

`public/models/x-bot-tpose.fbx` and `y-bot-tpose.fbx` are Mixamo characters from
Adobe. Adobe permits using them inside a project and specifically does not permit
distributing the raw character files, which is what this repository, the npm
package and `cozyclay.org/models/` each do today. They are also outside the scope
of this repository's GPL-3.0 grant: nothing here relicenses them, and a fork does
not acquire the right to redistribute them.

They are being replaced with CC0 rigs. Until that lands, treat these two files as
third-party content that the repository licence does not cover.

- Adobe Mixamo, https://www.mixamo.com
- Terms: https://www.adobe.com/legal/terms.html

## Generated assets

`public/demo/walk-then-stop.npz` is motion generated with ARDY. Under the NVIDIA
Open Model License an output is not a Model Derivative and NVIDIA claims no
ownership in outputs, so the clip ships with the build under CozyClay's own
licence. The attribution the licence does ask for is recorded above.

## NVIDIA ARDY

CozyClay provides an optional bridge and data-conversion workflow for externally installed [ARDY](https://github.com/nv-tlabs/ardy), an interactive human-motion generation project from NVIDIA Research.

ARDY is not bundled with CozyClay. Users must obtain, install, and operate ARDY separately under NVIDIA's terms.

- Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES
- ARDY source license: Apache License 2.0
- Source: https://github.com/nv-tlabs/ardy
- Source license: https://github.com/nv-tlabs/ardy/blob/main/LICENSE

ARDY model checkpoints and other model assets may be governed by separate terms, including the NVIDIA Open Model License identified by the ARDY project. Users are responsible for reviewing and complying with those terms before downloading or using the models.

The NVIDIA Open Model License asks that copies carry the following notice, so it
is reproduced here:

> Licensed by NVIDIA Corporation under the NVIDIA Open Model License

Under that licence an output is not a Model Derivative, and NVIDIA claims no
ownership rights in outputs. Motion generated through the bridge is the user's,
and the sample clip shipped with the build is CozyClay's.

## Meta Llama 3

ARDY's text encoder is based on Meta Llama 3 (`Meta-Llama-3-8B-Instruct`).
CozyClay does not bundle or redistribute the model weights; the optional
`tools/ardy/setup-text-encoder.py` script downloads them directly from a
public repository to the user's own machine for local use, together with the
model's LICENSE and USE_POLICY files.

Built with Meta Llama 3.

- Copyright © Meta Platforms, Inc. All Rights Reserved.
- License: Meta Llama 3 Community License
- License text: https://www.llama.com/llama3/license/
- Acceptable Use Policy: https://www.llama.com/llama3/use-policy/

Meta Llama 3 is licensed under the Meta Llama 3 Community License,
Copyright © Meta Platforms, Inc. All Rights Reserved.

## LLM2Vec

ARDY's text encoder applies the LLM2Vec adapters from McGill NLP
(`LLM2Vec-Meta-Llama-3-8B-Instruct-mntp` and `-mntp-supervised`). Like the
base weights, they are downloaded by the setup script for local use, not
bundled.

- Copyright (c) 2024 McGill NLP
- License: MIT (the adapters are derived from Meta Llama 3; the Meta Llama 3
  Community License applies to that underlying model)
- Source: https://github.com/McGill-NLP/llm2vec
- License text: https://github.com/McGill-NLP/llm2vec/blob/main/LICENSE

## CozyClay license scope

The CozyClay source code in this repository is licensed under GPL-3.0-or-later.
That license does not replace or relicense Three.js, React, Draco, Basis
Universal, the bundled fonts, the character rigs, ARDY, ARDY model checkpoints,
or any other third-party component listed here.
