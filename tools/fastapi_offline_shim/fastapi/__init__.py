"""Minimal FastAPI-compatible layer over Starlette (see README). Subset only."""
from __future__ import annotations

import inspect
import json
import typing

from pydantic import BaseModel, ValidationError
from starlette import status  # noqa: F401
from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

__all__ = ["FastAPI", "APIRouter", "Depends", "File", "Form", "Query", "HTTPException", "Request", "Response", "UploadFile", "status"]


class HTTPException(Exception):
    def __init__(self, status_code: int, detail=None, headers: dict | None = None):
        self.status_code, self.detail, self.headers = status_code, detail, headers


class _Depends:
    def __init__(self, dep):
        self.dependency = dep


def Depends(dep):  # noqa: N802
    return _Depends(dep)


class _Param:
    def __init__(self, default=..., kind="query"):
        self.default, self.kind = default, kind


def File(default=...):  # noqa: N802
    return _Param(default, "file")


def Form(default=...):  # noqa: N802
    return _Param(default, "form")


def Query(default=None):  # noqa: N802
    return _Param(default, "query")


class _RequestValidation(Exception):
    def __init__(self, errors):
        self.errors = errors


def _convert(raw, ann):
    origin = typing.get_origin(ann)
    if origin in (typing.Union, getattr(__import__("types"), "UnionType", None)):
        args = [a for a in typing.get_args(ann) if a is not type(None)]
        ann = args[0] if args else str
    if ann is bool:
        return raw.lower() in ("1", "true", "yes", "on")
    if ann in (int, float, str):
        return ann(raw)
    return raw


async def _solve(fn, request: Request, path_params: dict, cache: dict, sub: Response):
    hints = typing.get_type_hints(fn)
    kwargs = {}
    params = list(inspect.signature(fn).parameters.items())
    # like FastAPI: dependencies are solved before the request body/query are validated
    params.sort(key=lambda kv: 0 if isinstance(kv[1].default, _Depends) else 1)
    for name, p in params:
        ann, default = hints.get(name), p.default
        if isinstance(default, _Depends):
            dep = default.dependency
            if dep not in cache:
                cache[dep] = await _call(dep, await _solve(dep, request, path_params, cache, sub))
            kwargs[name] = cache[dep]
        elif ann is Request:
            kwargs[name] = request
        elif ann is Response:
            kwargs[name] = sub
        elif isinstance(ann, type) and issubclass(ann, BaseModel):
            try:
                body = await request.json()
            except (json.JSONDecodeError, ValueError):
                raise _RequestValidation([{"type": "json_invalid", "loc": ["body"], "msg": "JSON decode error"}])
            try:
                kwargs[name] = ann.model_validate(body)
            except ValidationError as e:
                raise _RequestValidation([{"type": x["type"], "loc": ["body", *x["loc"]], "msg": x["msg"]} for x in e.errors()])
        elif isinstance(default, _Param) and default.kind in ("file", "form"):
            form = await request.form()
            v = form.get(name)
            if v is None and default.default is ...:
                raise _RequestValidation([{"type": "missing", "loc": ["body", name], "msg": "Field required"}])
            kwargs[name] = v
        elif name in path_params:
            kwargs[name] = _convert(path_params[name], ann)
        else:
            raw = request.query_params.get(name)
            dflt = default.default if isinstance(default, _Param) else default
            if raw is None:
                if dflt is inspect.Parameter.empty or dflt is ...:
                    raise _RequestValidation([{"type": "missing", "loc": ["query", name], "msg": "Field required"}])
                kwargs[name] = dflt
            else:
                try:
                    kwargs[name] = _convert(raw, ann)
                except ValueError:
                    raise _RequestValidation([{"type": "parsing", "loc": ["query", name], "msg": "Invalid value"}])
    return kwargs


async def _call(fn, kwargs):
    if inspect.iscoroutinefunction(fn):
        return await fn(**kwargs)
    return await run_in_threadpool(fn, **kwargs)


def _jsonable(x):
    if isinstance(x, BaseModel):
        return x.model_dump(mode="json")
    if isinstance(x, dict):
        return {k: _jsonable(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_jsonable(v) for v in x]
    return x


def _endpoint(fn, status_code, response_model):
    async def endpoint(request: Request):
        sub = Response()
        sub.status_code = None
        try:
            kwargs = await _solve(fn, request, request.path_params, {}, sub)
            result = await _call(fn, kwargs)
        except HTTPException as e:
            return JSONResponse({"detail": e.detail}, status_code=e.status_code, headers=e.headers)
        except _RequestValidation as e:
            return JSONResponse({"detail": e.errors}, status_code=422)
        if isinstance(result, Response):
            return result
        if response_model is not None:
            result = response_model.model_validate(result)
        resp = JSONResponse(_jsonable(result), status_code=sub.status_code or status_code)
        for k, v in sub.raw_headers:
            if k.lower() in (b"set-cookie",) or k.lower() not in (b"content-length", b"content-type"):
                resp.raw_headers.append((k, v))
        return resp
    return endpoint


class APIRouter:
    def __init__(self, prefix: str = "", tags=None):
        self.prefix, self.routes = prefix, []

    def _add(self, method, path, status_code=200, response_model=None, **_):
        def deco(fn):
            self.routes.append((method, self.prefix + path, fn, status_code, response_model))
            return fn
        return deco

    def get(self, path, **kw):
        return self._add("GET", path, **kw)

    def post(self, path, **kw):
        return self._add("POST", path, **kw)

    def put(self, path, **kw):
        return self._add("PUT", path, **kw)

    def patch(self, path, **kw):
        return self._add("PATCH", path, **kw)

    def delete(self, path, **kw):
        return self._add("DELETE", path, **kw)


class FastAPI(Starlette):
    def __init__(self, title: str = "", version: str = "", **_):
        super().__init__()
        self.title, self.version = title, version
        self._pending = APIRouter()

    def include_router(self, router: APIRouter):
        for method, path, fn, sc, rm in router.routes:
            self.router.routes.append(Route(path or "/", _endpoint(fn, sc, rm), methods=[method]))

    def get(self, path, **kw):
        def deco(fn):
            self.router.routes.append(Route(path, _endpoint(fn, kw.get("status_code", 200), None), methods=["GET"]))
            return fn
        return deco
