# Video provider research

확인일: **2026-08-13**. 아래는 공개된 공식 문서만 구현 근거로 사용했다. 공식 문서에서 확인하지 못한 값은 **미확인/가정**으로 표시한다.

## Runway `image_to_video` 구현 계약

- API는 Bearer key와 `X-Runway-Version: 2024-11-06`을 사용한다. `promptText`는 1–1000 UTF-16 code units, `duration`은 모델별 허용 범위, `seed`는 `0..4294967295`다. 현재 endpoint가 받는 모델에는 `gen4_turbo`, `gen4.5`, `seedance2`, `veo3.1`, `veo3.1_fast` 등이 있다. [API reference](https://docs.dev.runwayml.com/api/)
- 출력 비율: Gen-4 Turbo는 `1280:720`, `1584:672`, `1104:832`, `720:1280`, `832:1104`, `960:960`; Gen-4.5 I2V는 여기에 `672:1584`가 포함된다. CozyClay v1은 provider-agnostic domain에서 16:9/9:16만 노출한다. 입력 이미지 허용 비율은 Turbo 0.5–2.358, Gen-4.5 0.5–2.0이다. [Inputs](https://docs.dev.runwayml.com/assets/inputs/)
- 이미지 제한: URL 16 MB, data URI 5 MB(약 33% base64 팽창 포함), ephemeral upload 200 MB. URL은 HTTPS+도메인이어야 한다. [Inputs](https://docs.dev.runwayml.com/assets/inputs/)
- 재시도: 400/401/404/405는 재시도 금지, 429/502/503/504는 exponential backoff+jitter 대상이다. [HTTP errors](https://docs.dev.runwayml.com/errors/errors/)
- 폴링은 **5초 이상 간격**, jitter, 비-200 응답 backoff가 공식 권장이다. SDK 기본 timeout은 10분이고 AbortSignal 사용을 권장한다. 구현은 5초부터 30초까지 backoff, 전체 10분 timeout을 사용한다. [SDK polling](https://docs.dev.runwayml.com/api-details/sdks/)
- 결과 URL은 API 접근 후 24–48시간 안에 만료되므로 직접 노출하지 않고 즉시 로컬 저장해야 한다. [Outputs](https://docs.dev.runwayml.com/assets/outputs/)
- 1 credit=$0.01. Gen-4 Turbo 5 credits/s, Gen-4.5 12, Seedance 2 36(480/720p), Veo 3.1 audio 40/no-audio 20 credits/s다. 제한은 usage tier별 동시 작업/일일 작업 형태이며 고정 단일 RPM이라고 가정하지 않는다. [Pricing](https://docs.dev.runwayml.com/guides/pricing/), [Usage tiers](https://docs.dev.runwayml.com/usage/tiers/)
- **가정:** 공개 문서에는 모델별 실제 생성 지연 SLA가 없다. 네트워크 timeout은 생성 latency가 아니라 개별 HTTP 요청 보호값이다.

## 다른 공식 API 비교

| 서비스 | 공개 API·인증 | I2V/제약 | 가격·지연 |
|---|---|---|---|
| Kling 3.0 | Kling Open Platform 공식 API가 있고 Kling 3.0 Turbo I2V 문서가 공개됨. 인증 상세는 로그인/지역에 따라 문서 접근이 달라 **미확인** | VIDEO 3.0은 720p/1080p, 공식 제품 가이드는 초당 과금과 native audio를 명시. API payload 세부 ratio/duration은 이 조사에서 확정하지 않음 | 공식 가이드: 720p no-audio 6 credits/s, audio 9; 1080p no-audio 8, audio 12. latency SLA **미확인**. [I2V API](https://home.kling.ai/document-api/api/video/3-0-turbo/image-to-video), [model guide](https://home.kling.ai/quickstart/klingai-video-3-model-user-guide) |
| Seedance | BytePlus ModelArk 공식 API, ModelArk API key | Seedance 1.x I2V가 공개되어 있고 first/last/reference image를 지원. Seedance 2.0은 BytePlus 가격표와 Runway aggregator에서 확인되지만 BytePlus의 공개 endpoint 계약은 이 조사에서 충분히 확인하지 못함 | BytePlus 1.0 Lite는 $1.8/M tokens, 300 RPM·모델별 동시 5. Seedance 2 가격은 token/해상도/오디오 조합. latency SLA **미확인**. [BytePlus model](https://docs.byteplus.com/api/docs/ModelArk/1553576), [pricing](https://docs.byteplus.com/docs/ModelArk/1099320) |
| Google Veo | Vertex AI 공개 API, Google ADC/OAuth | `veo-3.1-generate-001` I2V, 16:9/9:16, Veo 3 계열 4/6/8초, uint32 seed. 예제는 15초 폴링 | 비동기 long-running operation. 실제 latency SLA **미확인**. [I2V sample](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/samples/googlegenaisdk-videogen-with-img), [video API](https://cloud.google.com/vertex-ai/generative-ai/docs/video/generate-videos-from-text), [pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing) |
| Luma | Dream Machine REST API, Bearer API key | Ray 2/Ray Flash 2 I2V, URL keyframes, 1:1/16:9/9:16/4:3/3:4/21:9/9:21, 문서 예시는 5초 | 비동기 generation과 callback. 정확한 현행 API 단가·latency SLA는 **미확인**. [video guide](https://docs.lumalabs.ai/ue/docs/video-generation), [create API](https://docs.lumalabs.ai/reference/creategeneration) |
| Pika | 공식 developer API, `X-API-KEY` | Turbo I2V는 multipart image, prompt/negative prompt/seed를 받음. 공개 페이지에서 duration/ratio는 **미확인** | 비동기 `video_id`. 공개 문서에서 현행 API 단가·latency SLA는 **미확인**. [Turbo I2V](https://dev.pika.art/docs/api-reference/generate-turbo-i2v) |
| MiniMax | 공식 REST API, Bearer API key | Hailuo 2.3 I2V. 768P 6/10초, 1080P 6초; URL 또는 base64 data URI | 768P 6초 $0.28, 10초 $0.56, 1080P 6초 $0.49. 비동기 task→file→download; latency SLA **미확인**. [I2V](https://platform.minimax.io/docs/api-reference/video-generation-i2v), [pricing](https://platform.minimax.io/subscribe/token-plan?tab=api-enterprise) |

## CozyClay 모델 ID 판정

- `seedance_2` → Runway 공식 aggregator의 `seedance2`로 **공식 접근 가능**. 코드에 명시적 mapping이 있으며 실행 목록은 bridge descriptor `seedance2`를 쓴다.
- `veo_3_1` → Runway의 `veo3.1`로 **공식 접근 가능**. Vertex AI 직접 경로도 있지만 현재 adapter는 Runway만 구현한다.
- `kling_3` → Kling 공식 Open Platform에는 대응 API가 있지만 **현재 CozyClay에서 접근 불가**. 인증/payload가 다른 provider adapter가 없으므로 mapping은 의도적으로 `null`이다.
- UI의 실행 가능한 목록은 `/generation/models` 응답이 단일 진실 공급원이다. bridge가 없을 때 보이는 기존 모델은 수동 hand-off용이며 자동 실행 가능하다는 뜻이 아니다.

## 경계와 남은 실API 검증

Provider descriptor는 `{ provider, id, durations, capabilities, cost }`를 UI에 제공하고, Runway payload 변환은 `tools/generation/providers/runway.mjs` 안에만 둔다. 유료 호출은 하지 않았다. 실제 key 테스트에서만 확인 가능한 것은 계정 tier/잔액, moderation, provider-side latency, 현재 모델 entitlement, 실제 MP4 codec/content다.
