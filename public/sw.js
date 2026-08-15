const CACHE_PREFIX = "cozyclay-pwa-";
const CACHE_NAME = `${CACHE_PREFIX}v3`;
const CORE_ASSETS = [
	"./",
	"./index.html",
	"./manifest.webmanifest",
	"./icons/icon-32.png",
	"./icons/icon-192.png",
	"./icons/icon-512.png",
	"./icons/icon-maskable-512.png",
	"./icons/apple-touch-icon.png",
	"./fonts/inter-latin.woff2",
	"./models/cozyclay-male-neutral.fbx",
	"./models/cozyclay-female-neutral.fbx",
];

async function cacheResponse(cache, request, response) {
	if (!response.ok || response.type === "opaque") {
		throw new Error(`Required offline asset failed: ${request}`);
	}
	await cache.put(request, response.clone());
	return response;
}

async function cacheBuiltAssets(cache) {
	const response = await fetch("./", { cache: "reload" });
	if (!response.ok) throw new Error("Required offline app shell failed");
	await cache.put("./", response.clone());
	const html = await response.text();
	const assetUrls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
		.map((match) => new URL(match[1], self.location.href))
		.filter((url) => url.origin === self.location.origin)
		.map((url) => url.href);
	await Promise.all(assetUrls.map(async (url) => {
		const asset = await fetch(url, { cache: "reload" });
		await cacheResponse(cache, url, asset);
	}));
}

self.addEventListener("install", (event) => {
	event.waitUntil((async () => {
		const cache = await caches.open(CACHE_NAME);
		await Promise.all(CORE_ASSETS.map(async (url) => {
			const response = await fetch(url, { cache: "reload" });
			await cacheResponse(cache, url, response);
		}));
		await cacheBuiltAssets(cache);
	})());
});

self.addEventListener("activate", (event) => {
	event.waitUntil((async () => {
		const names = await caches.keys();
		await Promise.all(names
			.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
			.map((name) => caches.delete(name)));
		await self.clients.claim();
	})());
});

self.addEventListener("message", (event) => {
	if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
	const { request } = event;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin || url.pathname.includes("/ardy/")) return;
	if (request.headers.has("range")) {
		event.respondWith((async () => {
			try {
				return await fetch(request);
			} catch {
				const cached = await caches.match(url.href);
				if (!cached) return new Response(null, { status: 504 });
				const bytes = await cached.arrayBuffer();
				const range = request.headers.get("range")?.match(/bytes=(\d+)-(\d*)/);
				if (!range) return cached;
				const start = Number(range[1]);
				const end = range[2] ? Number(range[2]) : bytes.byteLength - 1;
				const chunk = bytes.slice(start, end + 1);
				return new Response(chunk, {
					status: 206,
					headers: {
						"accept-ranges": "bytes",
						"content-length": String(chunk.byteLength),
						"content-range": `bytes ${start}-${end}/${bytes.byteLength}`,
						"content-type": cached.headers.get("content-type") || "application/octet-stream",
					},
				});
			}
		})());
		return;
	}

	if (request.mode === "navigate") {
		event.respondWith((async () => {
			const cache = await caches.open(CACHE_NAME);
			try {
				const response = await fetch(request);
				return cacheResponse(cache, request, response);
			} catch {
				return (await cache.match(request)) || (await cache.match("./")) || (await cache.match("./index.html"));
			}
		})());
		return;
	}

	event.respondWith((async () => {
		const cached = await caches.match(request);
		if (cached) return cached;
		const cache = await caches.open(CACHE_NAME);
		const response = await fetch(request);
		return cacheResponse(cache, request, response);
	})());
});
