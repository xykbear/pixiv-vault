"""FastAPI 入口：浏览/查看/下载/配置 API + 静态 SPA。"""
import hashlib
import json
import os
import zipfile
from email.utils import formatdate, parsedate_to_datetime

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse

from . import config
from .services import downloader, pixiv_client, scanner, thumbs

app = FastAPI(title="Pixiv Vault")

_STATIC = os.path.join(os.path.dirname(__file__), "static")


def _safe_path_join(root: str, rel: str) -> str:
    """校验并拼接路径，防穿越。"""
    if not rel or ".." in rel or rel.startswith("/"):
        raise HTTPException(400, "非法路径")
    p = os.path.join(root, rel)
    if not os.path.realpath(p).startswith(os.path.realpath(root)):
        raise HTTPException(400, "路径越界")
    return p


# ---------- 缓存生命周期 ----------
# 图片/帧/缩略图按路径稳定（仅作品重下才变化）。以 文件 mtime_ns+size 作 ETag 验证器：
#   max-age 内客户端直接用本地缓存（零请求）；过期后带 ETag 重验证，未变返回 304（零响应体）；
#   源文件变化（重下/重建）→ mtime/size 变 → ETag 变 → 自动失效取新内容。
_CACHE_IMAGE = 86400    # 静态图 / 动图帧 / frames.json：1 天
_CACHE_THUMB = 604800   # 缩略图：7 天


def _cache_validators(fp: str, extra: str = "") -> tuple[str, str]:
    """由文件 stat 生成 (ETag, Last-Modified)。extra 区分同文件多资源（如 zip 内帧名）。"""
    st = os.stat(fp)
    etag = '"' + hashlib.md5(f"{st.st_mtime_ns}-{st.st_size}-{extra}".encode()).hexdigest() + '"'
    return etag, formatdate(st.st_mtime, usegmt=True)


def _cache_headers(etag: str, last_modified: str, max_age: int) -> dict:
    return {
        "Cache-Control": f"public, max-age={max_age}, must-revalidate",
        "ETag": etag,
        "Last-Modified": last_modified,
    }


def _is_not_modified(request: Request, etag: str, last_modified: str) -> bool:
    """条件请求判定：If-None-Match 优先，无则 If-Modified-Since（RFC 9110）。"""
    inm = request.headers.get("if-none-match")
    if inm is not None:
        tags = {t[2:] if t.startswith("W/") else t for t in (s.strip() for s in inm.split(","))}
        return etag in tags or "*" in tags
    ims = request.headers.get("if-modified-since")
    if ims:
        try:
            # RFC 9110 §13.1.3：Last-Modified <= If-Modified-Since 即视为未修改 → 304
            if parsedate_to_datetime(ims) >= parsedate_to_datetime(last_modified):
                return True
        except (TypeError, ValueError):
            pass
    return False


@app.get("/api/tree/authors")
def api_authors():
    return {"authors": scanner.list_authors()}


@app.get("/api/tree/entries")
def api_entries(author: str):
    return {"entries": scanner.list_series(author)}


@app.get("/api/tree/characters")
def api_characters(author: str, series: str):
    return {"characters": scanner.list_characters(author, series)}


@app.get("/api/tree/works")
def api_works(author: str, series: str, character: str):
    return {"works": scanner.list_works(author, series, character)}


@app.get("/api/tree/images")
def api_images(author: str, series: str, character: str = ""):
    return {"images": scanner.list_images(author, series, character)}


# ---------- 跨作者搜索 ----------

@app.get("/api/search")
def api_search(q: str, limit: int = 200):
    """跨作者搜索角色/系列。首次调用触发后台索引构建，返回 {state, results}。

    state=ready 时 results 为命中；state=building/empty 时 results 空（索引
    构建中/失败，前端轮询重试）。
    """
    state = scanner.ensure_index()
    if state != "ready":
        return {"state": state, "results": []}
    return {"state": "ready", "results": scanner.search_index(q, limit)}


@app.get("/api/random")
def api_random():
    """随机角色（⋯ 菜单）：返回 item 及其上级导航上下文（系列/角色列表）。

    随机跳转直达图片层、跳过系列/角色层，前端面包屑上跳依赖这两层缓存；
    随 item 一并返回，既省掉前端两次往返，也保证上下文与 item 的
    author/series 对应一致。
    索引未就绪时返回 state，前端轮询后跳转（此时上下文为空）。
    """
    state = scanner.ensure_index()
    if state != "ready":
        return {"state": state, "item": None, "entries": [], "characters": []}
    item = scanner.random_entry()
    if not item:
        return {"state": "ready", "item": None, "entries": [], "characters": []}
    return {
        "state": "ready",
        "item": item,
        "entries": scanner.list_series(item["author"]),
        "characters": scanner.list_characters(item["author"], item["series"]),
    }


@app.get("/api/thumb/file")
def api_thumb_file(request: Request, rel: str):
    full = os.path.join(config.get_root(), rel)
    if not os.path.isfile(full):
        raise HTTPException(404, "源文件不存在")
    # 先据源文件验证器做 304 判定，命中则免去缩略图生成/读取
    etag, lastmod = _cache_validators(full)
    headers = _cache_headers(etag, lastmod, _CACHE_THUMB)
    if _is_not_modified(request, etag, lastmod):
        return Response(status_code=304, headers=headers)
    data = thumbs.get_thumbnail_file(rel)
    if data is None:
        raise HTTPException(404, "缩略图不存在")
    return Response(content=data, media_type="image/webp", headers=headers)


@app.get("/api/img")
def api_img(request: Request, author: str, series: str, file: str, character: str = ""):
    if character:
        d = _safe_path_join(config.get_root(), os.path.join(author, series, character))
    else:
        d = _safe_path_join(config.get_root(), os.path.join(author, series))
    fp = _safe_path_join(d, file)
    if not os.path.isfile(fp):
        raise HTTPException(404, "图片不存在")
    etag, lastmod = _cache_validators(fp)
    headers = _cache_headers(etag, lastmod, _CACHE_IMAGE)
    if _is_not_modified(request, etag, lastmod):
        return Response(status_code=304, headers=headers)
    return FileResponse(fp, headers=headers)


@app.get("/api/ugoira/frames")
def api_ugoira_frames(request: Request, author: str, base: str, series: str = "", character: str = ""):
    rel = os.path.join(author, series, character, f"{base}.frames.json") if series else os.path.join(author, f"{base}.frames.json")
    fp = _safe_path_join(config.get_root(), rel)
    if not os.path.isfile(fp):
        raise HTTPException(404, "frames.json 不存在")
    etag, lastmod = _cache_validators(fp)
    headers = _cache_headers(etag, lastmod, _CACHE_IMAGE)
    if _is_not_modified(request, etag, lastmod):
        return Response(status_code=304, headers=headers)
    return FileResponse(fp, media_type="application/json", headers=headers)


@app.get("/api/ugoira/frame")
def api_ugoira_frame(request: Request, author: str, base: str, file: str, series: str = "", character: str = ""):
    rel = os.path.join(author, series, character, f"{base}.zip") if series else os.path.join(author, f"{base}.zip")
    zip_path = _safe_path_join(config.get_root(), rel)
    if not os.path.isfile(zip_path):
        raise HTTPException(404, "zip 不存在")
    ext = os.path.splitext(file)[1].lower().lstrip(".")
    ctype = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
             "gif": "image/gif", "webp": "image/webp"}.get(ext, "application/octet-stream")
    # 同一 zip 内多帧：ETag 并入帧名，且 304 可跳过读 zip
    etag, lastmod = _cache_validators(zip_path, extra=file)
    headers = _cache_headers(etag, lastmod, _CACHE_IMAGE)
    if _is_not_modified(request, etag, lastmod):
        return Response(status_code=304, headers=headers)
    try:
        with zipfile.ZipFile(zip_path) as z:
            data = z.read(file)
    except KeyError:
        raise HTTPException(404, f"帧 {file} 不在 zip 中")
    return Response(content=data, media_type=ctype, headers=headers)


# ---------- 下载 ----------

@app.post("/api/download/preview/{work_id}")
def api_preview(work_id: str):
    try:
        return downloader.preview(work_id)
    except RuntimeError as e:
        raise HTTPException(400, str(e))


@app.post("/api/download")
def api_create_download(req: dict):
    url = (req.get("url") or "").strip()
    series = (req.get("series") or "").strip() or None
    characters = req.get("characters") or []
    is_collection = bool(req.get("is_collection"))
    if not url:
        raise HTTPException(400, "缺少 url")
    try:
        task = downloader.create_task(url, series, characters, is_collection)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return task


@app.get("/api/download")
def api_list_downloads():
    return {"tasks": downloader.list_tasks()}


@app.get("/api/download/{task_id}")
def api_task(task_id: str):
    t = downloader.get_task(task_id)
    if not t:
        raise HTTPException(404, "任务不存在")
    return t


@app.delete("/api/download/{task_id}")
def api_cancel(task_id: str):
    return {"cancelled": downloader.cancel_task(task_id)}


@app.delete("/api/download/{task_id}/clear")
def api_remove_task(task_id: str):
    if not downloader.remove_task(task_id):
        raise HTTPException(404, "任务不存在或仍在运行，无法清除")
    return {"removed": True}


# ---------- 配置 ----------

@app.get("/api/config")
def api_get_config():
    cfg = config.load_config()
    return {"config": cfg, "root": config.get_root(), "cookies": config.cookie_status()}


@app.put("/api/config")
def api_put_config(req: dict):
    cfg = config.load_config()
    if "proxy" in req and isinstance(req["proxy"], dict):
        cfg["proxy"] = req["proxy"]
    if "thumb_size" in req:
        cfg["thumb_size"] = int(req["thumb_size"])
    config.save_config(cfg)
    return {"ok": True, "config": cfg}


@app.get("/api/cookies/status")
def api_cookies_status():
    return config.cookie_status()


# ---------- 静态 SPA ----------

@app.get("/")
def index():
    return FileResponse(os.path.join(_STATIC, "index.html"))


@app.get("/{full_path:path}")
def static_files(full_path: str):
    if ".." in full_path:
        raise HTTPException(400, "非法路径")
    fp = os.path.join(_STATIC, full_path)
    if os.path.isfile(fp):
        return FileResponse(fp)
    raise HTTPException(404, "Not Found")
