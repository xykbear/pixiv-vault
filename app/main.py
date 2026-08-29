"""FastAPI 入口：浏览/查看/下载/配置 API + 静态 SPA。"""
import json
import os
import zipfile

from fastapi import FastAPI, HTTPException, Response
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


@app.get("/api/thumb/file")
def api_thumb_file(rel: str):
    data = thumbs.get_thumbnail_file(rel)
    if data is None:
        raise HTTPException(404, "缩略图不存在")
    return Response(content=data, media_type="image/webp")


@app.get("/api/img")
def api_img(author: str, series: str, file: str, character: str = ""):
    if character:
        d = _safe_path_join(config.get_root(), os.path.join(author, series, character))
    else:
        d = _safe_path_join(config.get_root(), os.path.join(author, series))
    fp = _safe_path_join(d, file)
    if not os.path.isfile(fp):
        raise HTTPException(404, "图片不存在")
    return FileResponse(fp)


@app.get("/api/ugoira/frames")
def api_ugoira_frames(author: str, base: str, series: str = "", character: str = ""):
    rel = os.path.join(author, series, character, f"{base}.frames.json") if series else os.path.join(author, f"{base}.frames.json")
    fp = _safe_path_join(config.get_root(), rel)
    if not os.path.isfile(fp):
        raise HTTPException(404, "frames.json 不存在")
    return FileResponse(fp, media_type="application/json")


@app.get("/api/ugoira/frame")
def api_ugoira_frame(author: str, base: str, file: str, series: str = "", character: str = ""):
    rel = os.path.join(author, series, character, f"{base}.zip") if series else os.path.join(author, f"{base}.zip")
    zip_path = _safe_path_join(config.get_root(), rel)
    if not os.path.isfile(zip_path):
        raise HTTPException(404, "zip 不存在")
    try:
        with zipfile.ZipFile(zip_path) as z:
            data = z.read(file)
    except KeyError:
        raise HTTPException(404, f"帧 {file} 不在 zip 中")
    ext = os.path.splitext(file)[1].lower().lstrip(".")
    ctype = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
             "gif": "image/gif", "webp": "image/webp"}.get(ext, "application/octet-stream")
    return Response(content=data, media_type=ctype)


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
