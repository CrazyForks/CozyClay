import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(path) {
	return readFileSync(path, "utf8");
}

function includesAll(path, values) {
	const text = source(path);
	for (const value of values) assert.ok(text.includes(value), `${path} is missing Korean UI copy: ${value}`);
}

function excludesAll(path, values) {
	const text = source(path);
	for (const value of values) assert.ok(!text.includes(value), `${path} still exposes legacy English UI copy: ${value}`);
}

includesAll("src/onboarding.jsx", ["카메라 설정", "이 순서대로 만들어 보세요", "AI로 가져가기"]);
excludesAll("src/onboarding.jsx", ["Set the camera", "Build it in this order", "Take it to your AI"]);

includesAll("src/install-app.jsx", ["앱 설치", "Cozy Clay를 다른 앱처럼 사용하세요", "홈 화면에 추가"]);
excludesAll("src/install-app.jsx", ["Install app", "Keep Cozy Clay with your other apps", "Add to Home Screen"]);

includesAll("src/result-modal.jsx", ["장면이 준비됐어요", "프롬프트 복사", "프레임 다운로드"]);
excludesAll("src/result-modal.jsx", ["Your shot is ready", "Copy prompt", "Download frame"]);

includesAll("src/App.jsx", ["장면", "재생 보기", "속성", "모션 생성", "오브젝트 변환", "카메라 레일 완성", "연결 중…"]);
excludesAll("src/App.jsx", [">Scene<", ">PlayView<", ">Inspector<", "Cancel run", "Generate motion", '{ label: "PLAYBACK"', '{ label: "GENERATING"', '{ label: "ROOT PATH"', "Camera rail drawn —"]);

includesAll("src/ardy/client.js", ["브리지 상태가 좋지 않아요", "브리지에 연결할 수 없어요", "생성 응답에 본문 스트림이 없어요"]);
excludesAll("src/ardy/client.js", ["bridge unhealthy", "bridge unreachable", "generate: response has no body stream"]);

includesAll("src/hierarchy-panel.jsx", ["이름 바꾸기", "샷 구조", "프레임 맞추기"]);
excludesAll("src/hierarchy-panel.jsx", [">Rename<", ">Duplicate<", ">Delete<", ">Frame<"]);

includesAll("src/ardy/timeline.jsx", ["애니메이션 타임라인", "프롬프트", "타임라인 펼치기"]);
excludesAll("src/ardy/timeline.jsx", ["Animation timeline", "Playback transport", "Expand timeline"]);

includesAll("src/posestudio.jsx", ["포즈 스튜디오", "포즈 적용", "포즈 저장"]);
excludesAll("src/posestudio.jsx", ["Pose Studio · Subject", "Apply pose", "Save pose"]);

includesAll("src/ardy/waypoints.js", ["핀 사이에는 최소", "자연스럽게 걷기엔 너무 느려요", "이전 구간보다 속도가"]);

const manifest = JSON.parse(source("public/manifest.webmanifest"));
assert.equal(manifest.lang, "ko-KR");
assert.match(source("index.html"), /<html lang="ko">/);

// English remains intentional in the model-facing prompt contract.
assert.match(source("src/shot.js"), /Camera move:/);
assert.match(source("src/shot.js"), /Use the attached blocking frame ONLY/);

console.log("all Korean UI localization checks PASS");
