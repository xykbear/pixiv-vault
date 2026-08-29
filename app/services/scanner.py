"""浏览目录扫描服务：扫描 pixiv/ 统一根，构建 作者→系列→角色→图片 树。

角色层直接列出该角色目录下的所有图片（每页一张），非按作品聚合。
"""
import json
import os
import re
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
