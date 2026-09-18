---
name: reflex-artifacts
description: How to build and deploy Reflex artifacts — apps published at <name>.<DEPLOY_DOMAIN> (Netlify frontend, optional Render backend with a persisted SQLite database). Use when the user asks to deploy, publish, host, ship or share an app, a site, a demo or a prototype.
---

# Reflex artifacts

An **artifact** is an app folder that Reflex publishes with the user's own accounts:

- the frontend goes to **Netlify** as a site at `https://<name>.<DEPLOY_DOMAIN>`;
- if the app has a backend, it is pushed to a **GitHub** repo and deployed as a free **Render**
  web service; its URL is injected into the frontend build;
- a backend's **SQLite** file survives Render's spin-downs: the process runs under a sidecar
  that restores the database on boot and snapshots it to Netlify Blobs whenever it changes.

Deploy with the `deploy_artifact` tool (`dir`, optional `name`), or from a shell:
`reflex artifact deploy <folder> [--name slug]`. The Artifacts tab in `reflex web` lists every
artifact with its deploys, logs and delete button. `list_artifacts` shows what exists and whether
deploys are configured. Never paste the user's Netlify/Render/GitHub keys into chat: they belong
in `~/.reflex/.env` (the Artifacts tab has a form for them).

## Layout the deploy understands (no manifest needed)

```
my-app/
  package.json          frontend with a "build" script (vite, CRA, sveltekit, astro …) → publish dist/ or build/
  index.html            …or a plain static folder (no build)
  web/ | frontend/ | client/   the frontend may live in a subfolder instead
  api/ | server/ | backend/    optional backend:
    requirements.txt + main.py (FastAPI)  → uvicorn main:app --host 0.0.0.0 --port $PORT
    package.json with "start"             → npm start
```

Rules a backend must follow:

- bind `0.0.0.0:$PORT` (Render sets `PORT`), answer `GET /health` with 2xx;
- read the database path from `DATABASE_URL` (`sqlite:///./data.db`); keep it a single SQLite
  file, relative to the backend folder, and use WAL mode if you like (the sidecar handles it);
- allow CORS from the frontend origin (simplest: `*` for demos);
- Python: pin deps in `requirements.txt` (`fastapi`, `uvicorn`). Node: `npm start` must run the
  server, not a dev tool.

The frontend reads the API base URL from an env var at build time: `import.meta.env.VITE_API_URL`
for Vite, `process.env.REACT_APP_API_URL` for CRA, `PUBLIC_API_URL` for SvelteKit/Astro. Fall back
to `http://localhost:8000` for local dev. Single-page apps get a `_redirects` fallback automatically.

## Manifest (optional, for anything non-standard)

Write `reflex-artifact.json` in the app folder:

```json
{
  "version": 1,
  "name": "todo-demo",
  "kind": "fullstack",
  "frontend": { "dir": "web", "build": "npm ci && npm run build", "publish": "dist", "apiUrlEnv": "VITE_API_URL", "spa": true },
  "backend": {
    "dir": "api", "runtime": "python",
    "build": "pip install -r requirements.txt",
    "start": "uvicorn main:app --host 0.0.0.0 --port $PORT",
    "health": "/health",
    "env": { "DATABASE_URL": "sqlite:///./data.db" }
  }
}
```

`kind: "static"` skips the backend. `backend.env` is plain config only; secrets the backend needs
should be requested with `request_secrets` and then added by the user in the Render dashboard.

## What to tell the user

After a deploy, give the frontend URL (and the API URL). The custom domain's certificate can take
a few minutes on the first deploy; the `*.netlify.app` fallback URL works immediately. The
backend repo is public unless `ARTIFACTS_REPO_PRIVATE=true` (Render then needs GitHub access), so
never commit secrets or `.env` files: the deploy excludes `.env*`, `node_modules`, build output
and `*.db` files. Render's free plan sleeps after inactivity; the first request after that takes
~30 s and the sidecar restores the database from the last snapshot.

## Fixing a failed deploy

The tool result lists the failing step. `Build frontend` failures are ordinary build errors: fix
and redeploy. `Backend health` means the service is live but `/health` never answered 2xx: check
the start command, port binding and the Render logs link. `Certificate` failing only means TLS is
still pending on the custom domain.
