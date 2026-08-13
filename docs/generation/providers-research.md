# Video provider research

확인일: 2026-08-13. 공개된 공식 문서만 구현 근거로 사용했다. 값이 없거나 문서 페이지에서 확정할 수 없는 항목은 **미확인**으로 표시한다.

## 구현에 반영한 Runway 계약

- `POST /v1/image_to_video`, `GET /v1/tasks/:id`, Bearer API key, `X-Runway-Version: 2024-11-06`을 사용한다. 현재 공통 요청 범위는 prompt 1–1000 UTF-16 code units, duration 2–10초, seed `0..4294967295`다. [API reference](https://docs.dev.runwayml.com/api/)
- Gen-4 Turbo/4.5 I2V는 `1280:720`, `720:1280` 외에도 여러 비율을 지원하지만 CozyClay v1은 도메인 비율 16:9/9:16만 노출한다. 입력 이미지 허용 비율은 Turbo 0.5–2.358, 4.5 0.5–2이며, PNG/JPEG/WebP data URI는 인코딩된 전체가 5MB 이하여야 한다. [Inputs](https://docs.dev.runwayml.com/assets/inputs/)
- HTTP 400/401/404/405는 재시도하지 않고, 429/502/503/504는 exponential backoff+jitter 대상이다. [HTTP errors](https://docs.dev.runwayml.com/errors/errors/)
- 공식 SDK는 고정 `setInterval` 폴링을 피하고 AbortSignal과 기본 10분 timeout을 권장하지만 정확한 폴링 초 간격은 공개하지 않는다. 이 구현은 1초에서 시작해 10초까지 늘어나는 backoff와 10분 timeout을 쓴다. [SDK polling](https://docs.dev.runwayml.com/api-details/sdks/)
- 성공 결과 URL은 API 접근 후 24–48시간 내 만료되므로 즉시 로컬 저장해야 한다. [Outputs](https://docs.dev.runwayml.com/assets/outputs/)
- API credit은 1 credit=$0.01이며 Gen-4 Turbo는 5 credits/s, Gen-4.5는 12 credits/s다. 사용 tier별 동시 실행/일일 생성 제한이 있고 고정 RPM 제한은 없다. [Pricing](https://docs.dev.runwayml.com/guides/pricing/), [Usage tiers](https://docs.dev.runwayml.com/usage/tiers/)

## 대체 provider 조사

| 서비스 | 공개 API·인증 | I2V와 주요 제약 | 과금/대기 특성 |
|---|---|---|---|
| Kling 3.0 | 공식 Open Platform API 있음. 현재 API Key 인증, legacy AK/SK도 존재 | 공식 I2V endpoint가 있으나 검색 가능한 문서에서 모델별 ratio/duration 값은 미확인 | 공개 문서 페이지에서 정확한 API 단가는 미확인. 비동기 task 방식 [Overview](https://kling.ai/document-api/quickStart%2FproductIntroduction%2Foverview), [I2V](https://kling.ai/document-api/apiReference/model/imageToVideo) |
| Seedance 2.0 | BytePlus ModelArk/Volcengine 공식 API 있음. ModelArk API key 기반 | text/image/video 입력, 480p–4K 및 4–15초 상품이 공개됨. 세부 ratio는 모델/해상도별 descriptor가 필요 | token 기반. BytePlus 예시 720p 5초 I2V는 2.0 약 $0.76, Fast 약 $0.60, Mini 약 $0.38. 비동기 task [Pricing](https://docs.byteplus.com/docs/ModelArk/1099320), [Seedance](https://seed.bytedance.com/en/seedance) |
| Google Veo 3.1 | Vertex AI 공개 API, Google ADC/OAuth 인증 | I2V, 16:9/9:16, 4/6/8초, uint32 seed. 예제는 15초 간격 operation polling | Veo 3 video $0.50/s, video+audio $0.75/s. 실제 지연 SLA는 미확인 [I2V sample](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/samples/googlegenaisdk-videogen-with-img), [API](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/veo-video-generation), [Pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing) |
| Luma Dream Machine | 공식 REST API, API key 인증 | Ray 계열 I2V, keyframe, 1:1/16:9/9:16/4:3/3:4/21:9/9:21; duration 상세는 현재 문서에서 미확인 | API와 웹 구독 credit은 별개. 모델별 API 가격은 공식 API 가격표 확인 필요; 비동기 generation/callback [Create](https://docs.lumalabs.ai/reference/creategeneration), [API](https://lumalabs.ai/api) |
| MiniMax Hailuo | 공식 REST API, Bearer API key | JPG/PNG/WebP URL/data URI, <20MB, short edge >300px, ratio 2:5–5:2. 6/10초와 768P/1080P 조합은 모델별 상이 | Hailuo 2.3 768P 6초 $0.28, 10초 $0.56, 1080P 6초 $0.49. 비동기 task; 지연 SLA 미확인 [I2V](https://platform.minimax.io/docs/api-reference/video-generation-i2v), [Pricing](https://platform.minimax.io/subscribe/token-plan?tab=api-enterprise) |
| Pika | 공식 소비자 웹 가격/기능은 확인됨 | Pika 2.5 I2V는 소비자 제품에 있으나, 2026-08-13 현재 공식 공개 developer API 문서를 확인하지 못함 | 소비자 subscription credit과 API 가격을 동일시할 수 없음 [Pricing](https://pika.art/pricing) |

## CozyClay `VIDEO_MODELS` 판정

- `seedance_2`는 ByteDance Seedance 2.0에 대응하며 BytePlus/Volcengine 직접 API 또는 Runway의 `seedance2` aggregator 모델로 접근 가능하다.
- `kling_3`는 Kling VIDEO 3.0에 대응하며 공식 Open Platform API가 있다. 다만 공개 문서에서 계약값을 충분히 확정하기 전에는 adapter를 추가하지 않는다.
- `veo_3_1`은 Google Veo 3.1에 대응하며 Vertex AI 직접 API와 Runway의 `veo3.1`/`veo3.1_fast` 양쪽 경로가 있다.
- 위 UI 목록은 “프롬프트를 어느 제품에 수동 전달할지”의 목록이고, 실제 bridge 모델은 `/generation/models` descriptor가 유일한 실행 가능 목록이다. ID를 암묵적으로 변환하지 않는다.

## provider descriptor 경계

각 `tools/generation/providers/*.mjs`는 `{ id, label, auth, available(), models[], validate(), estimateCost(), submit(), poll() }`를 내보낸다. 각 model descriptor는 duration, 비용, 입력·출력 capability를 기술한다. bridge는 provider 이름이나 payload를 알지 않고 descriptor/메서드만 호출한다. 확인되지 않은 capability는 `false` 또는 미등록으로 두며 UI는 `/generation/models` 응답만 사용한다.
