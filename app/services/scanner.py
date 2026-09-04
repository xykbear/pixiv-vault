"""浏览目录扫描服务：扫描 pixiv/ 统一根，构建 作者→系列→角色→图片 树。

角色层直接列出该角色目录下的所有图片（每页一张），非按作品聚合。
"""
import json
import os
import re
import threading
import unicodedata

from .. import config

IMG_EXTS = (".jpg", ".jpeg", ".png", ".gif", ".webp")


def _meta_of(work_dir: str, work_id: str) -> dict:
    """读取作品目录下的 meta.json（{work_id}.meta.json）。"""
    p = os.path.join(work_dir, f"{work_id}.meta.json")
    if os.path.exists(p):
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def _static_work_id(filename: str) -> str | None:
    """静态图文件名 {work_id}_p{n}.ext 或 {work_id}.ext → work_id。"""
    base = filename
    for ext in IMG_EXTS:
        if base.endswith(ext):
            base = base[: -len(ext)]
            break
    m = re.match(r"^(\d+)(?:_p\d+)?$", base)
    return m.group(1) if m else None


def _ugoira_base(filename: str) -> str | None:
    """动图 *.frames.json → base（{id}，新规则动图以 {id} 命名）。"""
    if filename.endswith(".frames.json"):
        return filename[: -len(".frames.json")]
    return None


def list_authors() -> list[dict]:
    """返回作者列表（第一级目录）。"""
    root = config.get_root()
    authors = []
    for name in sorted(os.listdir(root)):
        p = os.path.join(root, name)
        if os.path.isdir(p) and not name.startswith(".") and name != "_meta_skip":
            authors.append({"author": name, "mtime": os.path.getmtime(p)})
    return authors


def list_series(author: str) -> list[dict]:
    """返回作者下的系列/平铺动图/未分类等二级条目。"""
    root = config.get_root()
    author_dir = os.path.join(root, author)
    if not os.path.isdir(author_dir):
        return []
    entries = []
    for name in sorted(os.listdir(author_dir)):
        p = os.path.join(author_dir, name)
        if name.startswith("."):
            continue
        if os.path.isdir(p):
            kind = "series"
            # NAS 目录名可能是 NFD 分解形式（如 _未分類 → _未分󰡔類），
            # 用 NFC 归一化比较以识别特殊目录（AGENTS.md：禁止对目录做 NFKC/NFD 重命名）
            norm = unicodedata.normalize("NFC", name)
            if norm in ("_未分類", "_未分类"):
                kind = norm
            entries.append({"author": author, "name": name, "kind": kind,
                            "mtime": os.path.getmtime(p)})
        elif os.path.isfile(p) and _ugoira_base(name):
            base = _ugoira_base(name)
            entries.append({"author": author, "name": base, "kind": "ugoira",
                            "mtime": os.path.getmtime(p)})
    return entries


def list_characters(author: str, series: str) -> list[dict]:
    """返回系列目录下的角色列表（第三级）。"""
    root = config.get_root()
    d = os.path.join(root, author, series)
    if not os.path.isdir(d):
        return []
    characters = []
    for name in sorted(os.listdir(d)):
        if name.startswith("."):
            continue
        p = os.path.join(d, name)
        if os.path.isdir(p):
            characters.append({"author": author, "series": series, "name": name,
                               "kind": "character", "mtime": os.path.getmtime(p)})
        elif _ugoira_base(name):
            base = _ugoira_base(name)
            characters.append({"author": author, "series": series, "name": base,
                               "kind": "ugoira", "mtime": os.path.getmtime(p)})
    return characters


def _file_sort_key(filename: str) -> tuple:
    """按 作品ID 数字 + 页码 排序。"""
    wid = _static_work_id(filename) or "0"
    m = re.search(r"_p(\d+)", filename)
    page = int(m.group(1)) if m else 0
    try:
        wid_num = int(wid)
    except ValueError:
        wid_num = 0
    return (wid_num, page)


def list_images(author: str, series: str, character: str = "") -> list[dict]:
    """返回目录下所有图片（每页一张），按 作品ID+页码 排序。

    character 非空时扫描 {author}/{series}/{character}/；character 为空时扫描
    {author}/{series}/ 本身（适配 _未分类 平铺结构）。

    静态图每页一个条目；动图一个条目（id 为 base，type=ugoira）。
    返回项含 author/series/character/file，前端可直接拼 img/thumb URL。
    """
    root = config.get_root()
    if character:
        d = os.path.join(root, author, series, character)
    else:
        d = os.path.join(root, author, series)
    if not os.path.isdir(d):
        return []
    images = []
    static_files = sorted(
        (f for f in os.listdir(d) if os.path.isfile(os.path.join(d, f)) and _static_work_id(f)),
        key=_file_sort_key,
    )
    for f in static_files:
        wid = _static_work_id(f)
        images.append({
            "type": "static",
            "id": wid,
            "file": f,
            "author": author,
            "series": series,
            "character": character,
        })
    # 动图 zip（目录内）: {id}.zip（新规则）或 {系列}-{角色}-{id}.zip（旧平铺兼容）
    zips = sorted(
        (f for f in os.listdir(d) if os.path.isfile(os.path.join(d, f)) and f.endswith(".zip")),
        key=_file_sort_key,
    )
    for z in zips:
        base = z[: -len(".zip")]
        images.append({
            "type": "ugoira",
            "id": base,
            "file": z,
            "author": author,
            "series": series,
            "character": character,
        })
    # 统一按 作品ID 排序（静态 + 动图混排；旧格式 {系列}-{角色}-{id} 提取尾部数字）
    images.sort(key=lambda im: (_sort_id(im["id"]), im["type"] == "static", im["id"]))
    return images


def _sort_id(work_id: str) -> int:
    """作品 ID 排序键：纯数字直接转 int，旧三段式取尾部 {id}。"""
    if work_id.isdigit():
        return int(work_id)
    m = re.search(r"-(\d+)$", work_id)
    return int(m.group(1)) if m else 0


def list_works(author: str, series: str, character: str) -> list[dict]:
    """返回某系列下角色目录内的作品（静态图按作品聚合，含封面缩略图）。"""
    root = config.get_root()
    d = os.path.join(root, author, series, character)
    if not os.path.isdir(d):
        return []
    works: dict[str, dict] = {}
    # 静态图作品聚合
    for name in os.listdir(d):
        wid = _static_work_id(name)
        if wid and (wid not in works or name.endswith("_p0.png") or name.endswith("_p0.jpg")):
            works.setdefault(wid, {"id": wid, "type": "static", "page": 0,
                                   "cover": name, "path": os.path.join(d, name)})
    # 动图（作者目录平铺）
    for name in os.listdir(d):
        if name.endswith(".zip"):
            base = name[:-len(".zip")]
            works.setdefault(base, {"id": base, "type": "ugoira", "page": 0,
                                    "cover": base, "path": os.path.join(d, name)})
    result = []
    for w in works.values():
        meta = _meta_of(d, w["id"])
        result.append({
            "id": w["id"],
            "type": w["type"],
            "title": meta.get("title", ""),
            "pages": meta.get("pageCount", 1),
            "has_thumb": True,
        })
    return sorted(result, key=lambda x: x["id"], reverse=True)


# ---------- 跨作者搜索索引（进程内缓存目录树，无建库） ----------
#
# 痛点：找角色须先记得作者。方案：后台线程构建 作者→系列→角色 目录树
# （只 os.listdir 目录名，不读 meta/图），缓存进程内；搜索在内存过滤。
# NAS 全库列目录名实测 ~19s（冷），后台线程构建避免阻塞搜索请求。
# 失效：新下载/移动会新增目录，索引滞后；每次搜索前轻量检测顶层作者
# mtime 签名，变化即触发后台重建（旧索引可用期间继续响应）。

_INDEX_LOCK = threading.Lock()
_INDEX = None            # [{author, series, character, nfile}] 或 None
_INDEX_SIG = None        # 构建时顶层 {author_dir: mtime} 签名
_INDEX_STATE = "empty"   # empty | building | ready


def notify_change(author_dir: str) -> None:
    """标记某作者目录已变化（下载落盘后调用），触发下次搜索前索引重建。

    顶层签名只含作者目录 mtime，而新增**角色**目录（已有系列下）不会冒泡到
    作者目录 mtime——webapp 下载到已存在系列下的新角色时索引会陈旧。
    调用方（downloader 写盘后）显式 os.utime 作者目录，使签名检测到变化。
    """
    root = config.get_root()
    p = os.path.join(root, author_dir)
    try:
        if os.path.isdir(p):
            os.utime(p, None)  # mtime 置当前时间 → 顶层签名变化
    except OSError:
        pass


def _norm(s: str) -> str:
    """NFKC 归一 + 小写（全半角/大小写模糊匹配）。"""
    return unicodedata.normalize("NFKC", s or "").lower()


def _top_signature() -> dict:
    """顶层作者目录签名 {author_dir: mtime}（轻量，~0.2s NAS）。

    根目录不可读/不存在时抛 OSError（调用方区分"空库"与"读失败"——NAS 断连
    不应静默产出空索引置 ready 让搜索误报无命中，review A6）。
    """
    root = config.get_root()
    sig = {}
    for name in os.listdir(root):
        p = os.path.join(root, name)
        if os.path.isdir(p) and not name.startswith(".") and name != "_meta_skip":
            try:
                sig[name] = os.path.getmtime(p)
            except OSError:
                pass  # 单目录 stat 失败跳过（其余继续）
    return sig


def _build_index():
    """全库遍历目录树（3 层），只列目录名不读内容。返回条目列表 + 顶层签名。"""
    root = config.get_root()
    entries = []
    sig = _top_signature()
    for author in sorted(sig):
        ap = os.path.join(root, author)
        for series in sorted(os.listdir(ap)):
            if series.startswith("."):
                continue
            sp = os.path.join(ap, series)
            if not os.path.isdir(sp):
                continue
            if series in ("_meta_skip", "Collections"):
                continue
            if _norm(series) in ("_未分類", "_未分类"):
                continue
            # 系列层本身也可能是平铺作品目录（无角色子目录）→ 不作为条目
            for char in sorted(os.listdir(sp)):
                if char.startswith("."):
                    continue
                cp = os.path.join(sp, char)
                if not os.path.isdir(cp):
                    continue
                if _norm(char) in ("_未分類", "_未分类", "_meta_skip"):
                    continue
                try:
                    nf = len(os.listdir(cp))
                except OSError:
                    nf = 0
                entries.append({
                    "author": author, "series": series,
                    "character": char, "nfile": nf,
                })
    return entries, sig


def _build_worker():
    """后台重建索引线程体（重建完成后置 ready）。"""
    global _INDEX, _INDEX_SIG, _INDEX_STATE
    try:
        entries, sig = _build_index()
        with _INDEX_LOCK:
            _INDEX = entries
            _INDEX_SIG = sig
            _INDEX_STATE = "ready"
    except Exception:
        with _INDEX_LOCK:
            _INDEX_STATE = "empty"


def _start_build():
    """启动后台重建（防重复）。调用方须已持锁或确认可安全建。"""
    global _INDEX_STATE
    if _INDEX_STATE == "building":
        return False
    _INDEX_STATE = "building"
    threading.Thread(target=_build_worker, daemon=True).start()
    return True


def ensure_index():
    """确保索引就绪：空则触发后台构建；顶层签名变化则后台重建。

    返回状态：empty(首次触发中) | building | ready。ready 且顶层未变时
    索引可直接用于内存搜索（搜索本身零 NAS 开销）。
    """
    global _INDEX_STATE
    with _INDEX_LOCK:
        if _INDEX_STATE == "building":
            return _INDEX_STATE
        if _INDEX_STATE == "ready" and _INDEX is not None:
            # 轻量探测顶层是否变化（新下载/新作者 → 目录 mtime 变）
            if _top_signature() == _INDEX_SIG:
                return "ready"
            _start_build()  # 顶层已变：占位 building + 后台重建
            return "building"
    # empty：首次触发
    _start_build()
    return _INDEX_STATE


def search_index(q: str, limit: int = 200):
    """跨作者搜索角色/系列（内存过滤，无 NAS 读）。返回命中列表。

    相关性排序：精确命中（角色/系列名 == 关键词）优先，其余子串命中次之，
    避免常见短词的精确命中被淹没（review A4）。截断到 limit。
    """
    key = _norm(q)
    if not key:
        return []
    with _INDEX_LOCK:
        entries = _INDEX or []
    exact = []
    fuzzy = []
    for e in entries:
        ec = _norm(e["character"])
        es = _norm(e["series"])
        if key in ec or key in es:
            rank = 0 if (ec == key or es == key) else 1
            (exact if rank == 0 else fuzzy).append(e)
    return (exact + fuzzy)[:limit]
