# Third-Party Notices

CozyClay is an independent project. The names and licenses below apply only to their respective third-party projects and do not imply sponsorship, affiliation, or endorsement.

## Three.js

CozyClay's browser-based 3D studio uses [Three.js](https://threejs.org/) through `three`, `@react-three/fiber`, and `@react-three/drei`.

- Copyright (c) 2010-2026 three.js authors
- License: MIT
- Source: https://github.com/mrdoob/three.js
- License text: https://github.com/mrdoob/three.js/blob/dev/LICENSE

## NVIDIA ARDY

CozyClay provides an optional bridge and data-conversion workflow for externally installed [ARDY](https://github.com/nv-tlabs/ardy), an interactive human-motion generation project from NVIDIA Research.

ARDY is not bundled with CozyClay. Users must obtain, install, and operate ARDY separately under NVIDIA's terms.

- Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES
- ARDY source license: Apache License 2.0
- Source: https://github.com/nv-tlabs/ardy
- Source license: https://github.com/nv-tlabs/ardy/blob/main/LICENSE

ARDY model checkpoints and other model assets may be governed by separate terms, including the NVIDIA Open Model License identified by the ARDY project. Users are responsible for reviewing and complying with those terms before downloading or using the models.

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

The CozyClay source code in this repository is licensed under GPL-3.0-or-later. That license does not replace or relicense Three.js, ARDY, ARDY model checkpoints, or any other third-party component.
