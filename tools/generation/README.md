# Video generation bridge (draft)

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

This first draft contains a Runway adapter and in-memory job tracking. Durable job storage, result import, UI confirmation, Kling, and direct Veo adapters remain follow-up work before merge.
