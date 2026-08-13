#!/usr/bin/env node
// Korean option locale verification.
//
// English is the default UI; Korean is opt-in when the active locale is ko
// (localStorage "cozyclay.locale" = "ko", or navigator.language ko-*). This
// harness is a static file check, so it cannot set localStorage before the
// page loads and locale.js exposes no URL/script injection hook. Instead:
//   1. import locale.js in node with a polyfilled localStorage to exercise
//      both the en default and the ko option through ko() deterministically;
//   2. verify Korean UI copy survives in the source, but only inside
//      ko("en", "ko") pairs, isKo branches, or the *_KO mapping tables.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function source(path) {
	return readFileSync(path, "utf8");
}

function includesAll(path, values) {
	const text = source(path);
	for (const value of values) assert.ok(text.includes(value), `${path} is missing Korean UI copy: ${value}`);
}

// Every ko() pair must carry a non-empty English default and a non-empty
// Korean option.
function assertKoPairsHaveBothSides(path) {
	const text = source(path);
	const pairs = [...text.matchAll(/ko\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)/g)];
	assert.ok(pairs.length > 0, `${path} has no ko("en", "ko") pairs to verify`);
	for (const [, en, koText] of pairs) {
		assert.ok(en.trim(), `${path} has an empty English default in ko(): ${koText}`);
		assert.ok(koText.trim(), `${path} has an empty Korean option in ko(): ${en}`);
	}
}

// Korean may only appear inside ko(...) calls, isKo branches, or the
// *_KO mapping tables — never as bare Korean in JSX or strings.
function assertKoreanInsideLocaleConstructs(path) {
	const lines = source(path).split("\n");
	let inKoTable = false;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (/const\s+[A-Za-z0-9_]*_KO\s*=\s*\{/.test(line)) inKoTable = true;
		if (inKoTable && /^\s*};?\s*$/.test(line)) inKoTable = false;
		if (!/[\uAC00-\uD7AF]/.test(line.replace(/\/\/.*$/, ""))) continue;
		assert.ok(
			inKoTable || /ko\(/.test(line) || /\bisKo\b/.test(line),
			`${path}:${index + 1} — Korean UI copy outside ko()/isKo/KO table: ${line.trim()}`
		);
	}
}

// locale.js reads localStorage at module scope, so a fresh dynamic import
// with a polyfilled storage exercises each locale path deterministically,
// independent of the host machine's navigator.language.
async function loadLocaleModule(storedValue) {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key) => (key === "cozyclay.locale" ? storedValue : null),
			setItem() {},
			removeItem() {},
		},
	});
	try {
		const url = pathToFileURL(resolve("src/locale.js"));
		url.search = `verify=${storedValue}-${Math.random().toString(36).slice(2)}`;
		return await import(url.href);
	} finally {
		if (previous) Object.defineProperty(globalThis, "localStorage", previous);
		else delete globalThis.localStorage;
	}
}

const enLocale = await loadLocaleModule("en");
assert.equal(enLocale.LOCALE, "en");
assert.equal(enLocale.isKo, false);
assert.equal(enLocale.ko("Frame", "프레임"), "Frame");
assert.equal(enLocale.ko("Collapse timeline", "타임라인 접기"), "Collapse timeline");

const koLocale = await loadLocaleModule("ko");
assert.equal(koLocale.LOCALE, "ko");
assert.equal(koLocale.isKo, true);
assert.equal(koLocale.ko("Frame", "프레임"), "프레임");
assert.equal(koLocale.ko("Collapse timeline", "타임라인 접기"), "타임라인 접기");

// The five files converted to the English-default + Korean-option pattern.
for (const path of ["src/result-modal.jsx", "src/install-app.jsx", "src/hierarchy-panel.jsx", "src/object-catalog.jsx"]) {
	assertKoreanInsideLocaleConstructs(path);
	assertKoPairsHaveBothSides(path);
}

// The PR's Korean copy is preserved, now living inside the locale constructs.
includesAll("src/install-app.jsx", ["앱 설치", "Cozy Clay를 다른 앱처럼 사용하세요", "홈 화면에 추가"]);
includesAll("src/result-modal.jsx", ["장면이 준비됐어요", "프롬프트 복사", "프레임 다운로드", "AI에 넣는 순서", "AI에 이미지 첨부"]);
includesAll("src/App.jsx", ["장면", "재생 보기", "속성", "모션 생성", "오브젝트 변환", "카메라 레일 완성", "연결 중…"]);
includesAll("src/ardy/client.js", ["브리지 상태가 좋지 않아요", "브리지에 연결할 수 없어요", "생성 응답에 본문 스트림이 없어요"]);
includesAll("src/hierarchy-panel.jsx", ["이름 바꾸기", "장면 구조", "장면 계층", "프레임 맞추기", "장면 문서", "+ 새 장면", "장면은 최소 하나 필요합니다"]);
includesAll("src/ardy/timeline.jsx", ["애니메이션 타임라인", "프롬프트", "타임라인 펼치기"]);
includesAll("src/posestudio.jsx", ["포즈 스튜디오", "포즈 적용", "포즈 저장"]);
includesAll("src/ardy/waypoints.js", ["핀 사이에는 최소", "자연스럽게 걷기엔 너무 느려요", "이전 구간보다 속도가"]);

// English is the default, so the document and manifest metadata are English.
const manifest = JSON.parse(source("public/manifest.webmanifest"));
assert.equal(manifest.lang, "en");
assert.match(source("index.html"), /<html lang="en">/);

// English remains intentional in the model-facing prompt contract.
assert.match(source("src/shot.js"), /Camera move:/);
assert.match(source("src/shot.js"), /Use the attached blocking frame ONLY/);

console.log("all Korean option locale checks PASS");
