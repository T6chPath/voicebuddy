# Offline FastAPI stand-in (development verification only)

The environment where this project was written had Starlette, uvicorn and Pydantic but **no FastAPI and no network**.
To still run the backend tests and the browser end-to-end tests, this folder implements the small subset of FastAPI's
API the app uses (routers, `Depends`, Pydantic bodies with 422 errors, query/path params, `UploadFile`/`File`,
`HTTPException`, injected `Response` for cookies, `response_model`, `StreamingResponse`, CORS) on top of Starlette.

**Do not use it in production.** Install the real thing (`pip install -r backend/requirements.txt`) — the app code
imports `fastapi` normally and the same tests run unchanged against real FastAPI. The test runner only puts this
folder on `sys.path` when `import fastapi` fails.
