# Video generation bridge

The bridge keeps provider credentials out of the browser and translates CozyClay's provider-neutral ShotSpec into provider requests.

## Run locally

```bash
RUNWAYML_API_SECRET=key_here npm run dev
```

The bridge binds to `127.0.0.1:5182`; Vite proxies `/generation` to it. The static GitHub Pages build remains generation-free.

## Endpoints

- `GET /generation/health`
- `GET /generation/models`
- `POST /generation/validate`
- `POST /generation/jobs`
- `GET /generation/jobs/:id`
- `DELETE /generation/jobs/:id` (when the provider exposes verified remote cancellation)

## Provider credentials

- Runway: `RUNWAYML_API_SECRET`
- Seedance / BytePlus ModelArk: `ARK_API_KEY`
- Kling: `KLING_API_TOKEN` (a server-side bearer token produced by Kling's authentication flow)
- Veo / Vertex AI: `GOOGLE_CLOUD_ACCESS_TOKEN`, `GOOGLE_CLOUD_PROJECT`, and optionally `GOOGLE_CLOUD_LOCATION`

The browser receives only model descriptors. Provider payloads and credentials stay inside `providers/`; completed MP4 files are downloaded immediately into the shared local job store.
