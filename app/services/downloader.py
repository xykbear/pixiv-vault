"""下载服务：后台任务下载单作品（静态图/动图），进度轮询。

静态图：页级进度；动图：字节级进度 + zip 断点续传。
"""
import json
import os
import re
import threading
import time
import uuid

from .. import config
from . import pixiv_client

# 任务存储：{task_id: {...}}
_TASKS: dict[str, dict] = {}
_LOCK = threading.Lock()
# 并发下载限制：同时最多 N 个下载线程，避免 Pixiv 风控/带宽争抢
MAX_CONCURRENT = int(os.environ.get("PIXIV_MAX_CONCURRENT", "2"))
_SEM = threading.Semaphore(MAX_CONCURRENT)

_SAFE = re.compile(r'[/\\:*?"<>|]')
SERIES_DIRS = ("オリジナル", "_未分類", "_未分类", "_meta_skip")


def _safe(s: str) -> str:
    s = _SAFE.sub("_", s or "")
    return s.strip() or "unknown"


def _root() -> str:
    return config.get_root()


def safe_author_dir(user_name: str) -> str:
    return _safe(user_name)


def target_path(author: str, series: str | None, characters: list | None, is_original: bool = False) -> str:
    """计算归档相对路径（相对 pixiv/ 根）。"""
    a = safe_author_dir(author)
    series = (series or "").strip()
    characters = [c.strip() for c in (characters or []) if c and c.strip()]
    if is_original:
        return os.path.join(a, "オリジナル", "")
    if series:
        s = _safe(series)
        if characters:
            character_dir = "_".join(_safe(c) for c in characters)
            return os.path.join(a, s, character_dir)
        return os.path.join(a, s, "_未分類", "")
    return os.path.join(a, "_未分類", "")


def preview(work_id: str) -> dict:
    """预览作品 meta + 标签（含原创特殊标签）。"""
    client = config.make_httpx_client()
    try:
        body = pixiv_client.get_work_meta(work_id, client)
        pages = pixiv_client.get_pages(work_id, client) if body.get("pageCount", 1) > 1 else None
        urls = pixiv_client.work_original_urls(body, pages)
        is_ugoira = body.get("illustType") == 2
        tags = []
        raw = body.get("tags") or {}
        if isinstance(raw, dict):
            raw = raw.get("tags", [])
        for t in raw:
            tag = t.get("tag") if isinstance(t, dict) else str(t)
            if tag:
                tags.append(tag)
        ugoira = None
        if is_ugoira:
            um = pixiv_client.get_ugoira_meta(work_id, client)
            ugoira = {
                "frames": len(um.get("frames", [])),
                "zip": um.get("originalSrc", ""),
            }
        return {
            "id": str(body.get("id", work_id)),
            "title": body.get("title", ""),
            "userName": body.get("userName", ""),
            "userId": str(body.get("userId", "")),
            "pageCount": body.get("pageCount", 1),
            "xRestrict": body.get("xRestrict", 0),
            "isOriginal": body.get("isOriginal", False),
            "illustType": body.get("illustType", 0),
            "tags": tags,
            "is_ugoira": is_ugoira,
            "ugoira": ugoira,
            "n_urls": len(urls),
        }
    finally:
        client.close()


def _download_static(task: dict, client, urls: list, dest_dir: str) -> None:
    os.makedirs(dest_dir, exist_ok=True)
    total = len(urls)
    task["progress"] = 0
    task["total"] = total
    done = 0
    for idx, url in enumerate(urls):
        ext = os.path.splitext(url.split("/")[-1])[1] or ".jpg"
        work_id = task["work_id"]
        dest = os.path.join(dest_dir, f"{work_id}_p{idx}{ext}")
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            done += 1
            task["progress"] = done
            continue
        pixiv_client.download_file(client, url, dest)
        done += 1
        task["progress"] = done
        task["log"].append(f"已下载 {work_id}_p{idx}{ext}")


def _download_ugoira(task: dict, client, body, dest_dir: str, base: str) -> None:
    os.makedirs(dest_dir, exist_ok=True)
    work_id = task["work_id"]
    um = pixiv_client.get_ugoira_meta(work_id, client)
    frames = um.get("frames", [])
    frames_path = os.path.join(dest_dir, f"{base}.frames.json")
    if not os.path.exists(frames_path):
        with open(frames_path, "w", encoding="utf-8") as f:
            json.dump(frames, f, ensure_ascii=False, indent=1)

    zip_url = um.get("originalSrc", "")
    if not zip_url:
        raise RuntimeError("未获取到动图 zip URL")
    zip_path = os.path.join(dest_dir, f"{base}.zip")

    def on_progress(done: int, total: int) -> None:
        task["progress"] = done
        task["total"] = total

    if os.path.exists(zip_path) and os.path.getsize(zip_path) > 0:
        task["progress"] = os.path.getsize(zip_path)
        task["total"] = os.path.getsize(zip_path)
    else:
        pixiv_client.download_with_progress(client, zip_url, zip_path, on_progress,
                                            timeout=600)
    # meta
    meta_path = os.path.join(dest_dir, f"{base}.meta.json")
    if not os.path.exists(meta_path):
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(body, f, ensure_ascii=False, indent=1)
    task["log"].append(f"动图 {work_id} 完成：{len(frames)} 帧")


def create_task(url: str, series: str | None, characters: list | None, is_original: bool = False) -> dict:
    """创建下载任务并后台执行。"""
    kind, work_id = pixiv_client.parse_link(url)
    if kind != "work":
        raise ValueError("仅支持单作品链接 pixiv.net/artworks/{id}")
    task_id = uuid.uuid4().hex[:12]
    task = {
        "task_id": task_id,
        "work_id": work_id,
        "status": "pending",
        "type": "unknown",
        "progress": 0,
        "total": 0,
        "log": [],
        "series": series or "",
        "characters": characters or [],
        "error": "",
        "target": "",
    }
    with _LOCK:
        _TASKS[task_id] = task

    def run():
        task["status"] = "queued"
        task["log"].append("排队中…")
        with _SEM:
            task["status"] = "running"
            client = config.make_httpx_client(timeout=config.DL_TIMEOUT)
            try:
                body = pixiv_client.get_work_meta(work_id, client)
                task["type"] = "ugoira" if body.get("illustType") == 2 else "static"
                task["log"].append(f"作品: {body.get('title')} by {body.get('userName')}")
                author = body.get("userName") or "unknown"
                if task["type"] == "ugoira":
                    parts = [p for p in [_safe(series or '')] + [_safe(c) for c in task['characters'] or []] if p]
                    base = "-".join(parts + [work_id])
                    dest_dir = os.path.join(_root(), safe_author_dir(author))
                    _download_ugoira(task, client, body, dest_dir, base)
                    task["target"] = os.path.relpath(dest_dir, _root())
                else:
                    urls = pixiv_client.work_original_urls(
                        body, pixiv_client.get_pages(work_id, client))
                    rel = target_path(author, series, characters, is_original)
                    dest_dir = os.path.join(_root(), rel)
                    _download_static(task, client, urls, dest_dir)
                    task["target"] = rel
                task["status"] = "done"
                task["progress"] = task["total"] or task["progress"]
            except Exception as e:
                task["status"] = "error"
                task["error"] = str(e)
                task["log"].append(f"错误: {e}")
            finally:
                client.close()

    threading.Thread(target=run, daemon=True).start()
    return task


def get_task(task_id: str) -> dict | None:
    with _LOCK:
        return _TASKS.get(task_id)


def cancel_task(task_id: str) -> bool:
    with _LOCK:
        t = _TASKS.get(task_id)
        if t and t["status"] in ("pending", "running"):
            t["status"] = "cancelled"
            return True
    return False
