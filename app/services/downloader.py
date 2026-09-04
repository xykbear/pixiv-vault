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
# 下载完成登记 log（生产端）：done 时追加一条到 {root}/.webapp_downloads.log（单文件），
# 供治理端 sync_webapp_logs 消费（生产→processing 闭环）。环境变量控制（默认关）。
_WEBAPP_LOG = os.environ.get("PIXIV_WEBAPP_LOG", "").strip().lower() in ("1", "true", "yes")
_WEBAPP_LOG_FILE = os.environ.get("PIXIV_WEBAPP_LOG_FILE", "")

_SAFE = re.compile(r'[/\\:*?"<>|]')
SERIES_DIRS = ("_未分類", "_未分类", "_meta_skip")


def _safe(s: str) -> str:
    s = _SAFE.sub("_", s or "")
    return s.strip() or "unknown"


def _root() -> str:
    return config.get_root()


def _log_file() -> str:
    """登记 log 单文件：归档根下 .webapp_downloads.log（与治理端约定，. 前缀不被扫盘）。"""
    return _WEBAPP_LOG_FILE or os.path.join(config.get_root(), ".webapp_downloads.log")


def _log_done(task: dict, author_dir: str, target_rel: str) -> None:
    """下载完成登记：追加 JSONL 到单文件（sync 消费后整体删除）。"""
    if not _WEBAPP_LOG:
        return
    try:
        os.makedirs(config.get_root(), exist_ok=True)
        rec = {
            "work_id": str(task["work_id"]),
            "author": author_dir,
            "target": target_rel,
            "series": task.get("series") or "",
            "characters": task.get("characters") or [],
            "is_collection": bool(task.get("is_collection")),
        }
        with open(_log_file(), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass  # 登记失败静默（log 是辅助信号，不影响下载结果）


def safe_author_dir(user_name: str) -> str:
    return _safe(user_name)


def target_path(author: str, series: str | None, characters: list | None, is_collection: bool = False, work_id: str = "", title: str = "") -> str:
    """计算归档相对路径（相对 pixiv/ 根）。

    is_collection: 无系列/无正式名称角色 → Collections/{id}_{title}。
    series/characters 为空且非 collection → _未分類（webapp 暂存，待治理）。
    """
    a = safe_author_dir(author)
    series = (series or "").strip()
    characters = [c.strip() for c in (characters or []) if c and c.strip()]
    if is_collection:
        t = _safe(title)[:60] if (title or "").strip() else "無題"
        return os.path.join(a, "Collections", f"{work_id}_{t}")
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


def _download_static(task: dict, client, body: dict, urls: list, dest_dir: str) -> None:
    os.makedirs(dest_dir, exist_ok=True)
    total = len(urls)
    task["progress"] = 0
    task["total"] = total
    done = 0
    work_id = task["work_id"]
    # meta（与本地工作流一致：{work_id}.meta.json）
    meta_path = os.path.join(dest_dir, f"{work_id}.meta.json")
    if not os.path.exists(meta_path):
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(body, f, ensure_ascii=False, indent=1)
    for idx, url in enumerate(urls):
        if task["status"] == "cancelled":
            return
        ext = os.path.splitext(url.split("/")[-1])[1] or ".jpg"
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
    elif task["status"] != "cancelled":
        pixiv_client.download_with_progress(client, zip_url, zip_path, on_progress,
                                            timeout=600)
    # meta
    if task["status"] != "cancelled":
        meta_path = os.path.join(dest_dir, f"{base}.meta.json")
        if not os.path.exists(meta_path):
            with open(meta_path, "w", encoding="utf-8") as f:
                json.dump(body, f, ensure_ascii=False, indent=1)
        task["log"].append(f"动图 {work_id} 完成：{len(frames)} 帧")


def create_task(url: str, series: str | None, characters: list | None, is_collection: bool = False) -> dict:
    """创建下载任务并后台执行。"""
    kind, work_id = pixiv_client.parse_link(url)
    if kind != "work":
        raise ValueError("仅支持单作品链接 pixiv.net/artworks/{id}")
    task_id = uuid.uuid4().hex[:12]
    task = {
        "task_id": task_id,
        "work_id": work_id,
        "url": url,
        "status": "pending",
        "type": "unknown",
        "progress": 0,
        "total": 0,
        "log": [],
        "series": series or "",
        "characters": characters or [],
        "is_collection": is_collection,
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
                    base = work_id
                    rel = target_path(author, series, characters, is_collection,
                                      work_id=work_id, title=body.get("title", ""))
                    dest_dir = os.path.join(_root(), rel)
                    _download_ugoira(task, client, body, dest_dir, base)
                    task["target"] = rel
                else:
                    urls = pixiv_client.work_original_urls(
                        body, pixiv_client.get_pages(work_id, client))
                    rel = target_path(author, series, characters, is_collection,
                                      work_id=work_id, title=body.get("title", ""))
                    dest_dir = os.path.join(_root(), rel)
                    _download_static(task, client, body, urls, dest_dir)
                    task["target"] = rel
                # 取消期间线程可能仍在跑，终结状态以取消为准（不覆盖 cancelled）
                if task["status"] != "cancelled":
                    task["status"] = "done"
                    task["progress"] = task["total"] or task["progress"]
                    author_dir = safe_author_dir(author)
                    _log_done(task, author_dir, rel)
            except Exception as e:
                if task["status"] != "cancelled":
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


def list_tasks() -> list[dict]:
    """返回全部任务（含快捷指令 API 触发的），用于下载视图展示。"""
    with _LOCK:
        return list(_TASKS.values())


def cancel_task(task_id: str) -> bool:
    with _LOCK:
        t = _TASKS.get(task_id)
        if t and t["status"] in ("pending", "running"):
            t["status"] = "cancelled"
            return True
    return False


def remove_task(task_id: str) -> bool:
    """移除任务（仅终结状态：done/error/cancelled）。运行中的请先取消。"""
    with _LOCK:
        t = _TASKS.get(task_id)
        if t and t["status"] in ("done", "error", "cancelled"):
            del _TASKS[task_id]
            return True
    return False
