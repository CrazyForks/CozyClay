# Video provider implementation notes

확인일: **2026-08-14**. 구현에는 공개된 공식 문서에서 확인된 계약만 사용한다. 미확인 필드는 전송하지 않고 어댑터 경고로 노출한다.

## 공통 경계

각 provider는 `models`, `available`, `validate`, `estimateCost`, `submit`, `poll`을 제공한다. 원격 취소가 확인된 provider만 `cancel`을 추가한다. 검증, 작업 저장, 폴링 시점, 결과 MP4 다운로드는 `tools/generation/bridge.mjs`와 클라이언트 세션이 공통 처리한다.

브라우저의 ShotSpec에는 composed prompt, shot 길이, 종횡비, 시작·끝 프레임, 선택적 reference video, camera block, subjects가 들어온다. 직접 지원되는 조건만 provider payload로 변환하며 camera 전용 필드가 확인되지 않은 경우 composed prompt와 staged frames를 사용한다.

## Seedance 2.0 / BytePlus ModelArk

- Bearer `ARK_API_KEY`, `POST /api/v3/contents/generations/tasks`, `GET` 및 `DELETE .../tasks/{id}`.
- 모델 `dreamina-seedance-2-0-260128`, 4–15초, 480p/720p/1080p/4k, 16:9 및 9:16 지원.
- `content` 배열의 `first_frame`, `last_frame`, `reference_video` 역할을 사용한다. first/last-frame mode와 reference-video mode는 함께 보내지 않는다.
- Seedance 2.0은 seed와 `camera_fixed`를 지원하지 않으므로 둘 다 전송하지 않는다.
- 비동기 상태는 queued/running/succeeded/failed/expired이고 결과는 `content.video_url`이다.
- 공식 문서: [Create task](https://docs.byteplus.com/en/docs/modelark/1520757), [Retrieve task](https://docs.byteplus.com/en/docs/modelark/1521309)

## Kling Video 3.0

- 공식 Open Platform의 I2V 경로를 사용하며 인증 토큰 생성 규칙은 지역·로그인 상태에 따라 공개 문서 접근이 달라 코드에서 추측하지 않는다. 서버가 준비한 `KLING_API_TOKEN`만 받는다.
- 보수적으로 확인된 720p/1080p와 5/10초만 실행 목록에 둔다.
- 시작 프레임과 끝 프레임을 매핑한다. reference-video와 camera-control의 상세 payload는 미확인이므로 전송하지 않고 경고한다.
- 원격 취소 계약도 미확인이므로 로컬에서 취소 성공으로 가장하지 않는다.
- 공식 문서: [Kling 3.0 Turbo I2V](https://home.kling.ai/document-api/api/video/3-0-turbo/image-to-video), [Kling 3.0 model guide](https://home.kling.ai/quickstart/klingai-video-3-model-user-guide)

## Google Veo 3.1 / Vertex AI

- OAuth bearer token과 Google Cloud project를 사용한다. `predictLongRunning`으로 제출하고 `fetchPredictOperation`으로 조회한다.
- `veo-3.1-generate-001` 및 fast 모델, 4/6/8초, 720p/1080p, 16:9/9:16을 지원한다.
- staged data URI는 `bytesBase64Encoded`로, `gs://` 이미지는 `gcsUri`로 바꾼다. 첫 프레임과 끝 프레임을 모두 지원한다.
- reference-video와 camera trajectory 전용 입력은 현재 모델의 확인된 계약이 아니므로 보내지 않는다.
- `storageUri`를 지정하지 않아 결과 bytes를 공통 저장 파이프라인에 전달한다. private `gs://` 결과는 공개 URL로 추측 변환하지 않고 명시적으로 실패시킨다.
- 원격 operation 취소 지원은 미확인이므로 adapter가 취소 성공을 주장하지 않는다.
- 공식 문서: [First and last frames](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/video/generate-videos-from-first-and-last-frames), [Veo API](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/veo-video-generation)

## 가격과 미확인 항목

Seedance는 token·해상도·입력 유형, Kling은 credits/s, Veo는 모델·해상도·오디오 조건으로 과금된다. 서로 다른 단위를 USD 추정치로 임의 환산하지 않아 direct adapter의 `estimatedCostUsd`는 `null`이다. 실제 latency SLA, 계정 entitlement, moderation 결과는 자격증명 없는 mock 테스트로 확인할 수 없다.
