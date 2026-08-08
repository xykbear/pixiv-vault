"""缩略图服务：Pillow 生成 + .thumbs/{cache_key}.webp 磁盘缓存。

- 静态图：对任意图片文件生成缩略图，缓存键 = {work_id}_p{page}
- 动图：取 zip 第一帧生成，缓存键 = {base}
"""
import hashlib
import io
import os
import re
import zipfile

from .. import config

_EXT_RE = re.compile(r"\.(jpg|jpeg|png|gif|webp)$", re.I)


def thumb_root() -> str:
    return os.path.join(config.get_root(), ".thumbs")


def _thumb_bytes_from_img(path: str, max_size: int) -> bytes:
    from PIL import Image

    with Image.open(path) as im:
        im.thumbnail((max_size, max_size))
        buf = io.BytesIO()
        im.convert("RGB").save(buf, "WEBP", quality=82)
        return buf.getvalue()


def _thumb_bytes_from_zip(zip_path: str, max_size: int) -> bytes:
    from PIL import Image

    with zipfile.ZipFile(zip_path) as z:
        first = z.namelist()[0]
        with Image.open(io.BytesIO(z.read(first))) as im:
            im.thumbnail((max_size, max_size))
            buf = io.BytesIO()
            im.convert("RGB").save(buf, "WEBP", quality=82)
            return buf.getvalue()


def _cache_path(key: str) -> str:
    os.makedirs(thumb_root(), exist_ok=True)
    return os.path.join(thumb_root(), f"{key}.webp")


def get_thumbnail(work_id: str) -> bytes | None:
    """兼容旧接口：按作品 ID 取封面缩略图（静态 _p0 或动图 zip 首帧）。"""
    cfg = config.load_config()
    max_size = int(cfg.get("thumb_size") or 300)
    cache = _cache_path(work_id)
    if os.path.exists(cache):
        with open(cache, "rb") as f:
            return f.read()
    data = _thumbnail_bytes_by_work(work_id, max_size)
    if data:
        with open(cache, "wb") as f:
            f.write(data)
        return data
    return None


def get_thumbnail_file(rel_path: str) -> bytes | None:
    """按相对 pixiv/ 根的图片路径生成缩略图（含动图 zip）。

    缓存键 = hash(rel_path)，源文件 mtime 变化时重建。
    """
    cfg = config.load_config()
    max_size = int(cfg.get("thumb_size") or 300)
    root = config.get_root()
    full = os.path.join(root, rel_path)
    if not os.path.isfile(full):
        return None
    key = hashlib.md5(rel_path.encode()).hexdigest()[:12]
    cache = _cache_path(key)
    if os.path.exists(cache):
        # 若源 mtime 变化则重建
        if os.path.getmtime(cache) >= os.path.getmtime(full):
            with open(cache, "rb") as f:
                return f.read()
    try:
        if rel_path.endswith(".zip"):
            data = _thumb_bytes_from_zip(full, max_size)
        else:
            data = _thumb_bytes_from_img(full, max_size)
    except Exception:
        return None
    with open(cache, "wb") as f:
        f.write(data)
    return data


def _thumbnail_bytes_by_work(work_id: str, max_size: int) -> bytes | None:
    """按作品 ID 找封面（静态 _p0 或动图 zip）生成缩略图字节。"""
    root = config.get_root()
    target = f"{work_id}_p0"
    for dirpath, _dirs, files in os.walk(root):
        if ".thumbs" in dirpath:
            continue
        for f in files:
            stem = _EXT_RE.sub("", f)
            if stem == target:
                return _thumb_bytes_from_img(os.path.join(dirpath, f), max_size)
    # 单页作品 {id}.ext
    for dirpath, _dirs, files in os.walk(root):
        if ".thumbs" in dirpath:
            continue
        for f in files:
            stem = _EXT_RE.sub("", f)
            if stem == work_id:
                return _thumb_bytes_from_img(os.path.join(dirpath, f), max_size)
    # 动图
    for dirpath, _dirs, files in os.walk(root):
        if ".thumbs" in dirpath:
            continue
        for f in files:
            if f.endswith(f"-{work_id}.zip"):
                return _thumb_bytes_from_zip(os.path.join(dirpath, f), max_size)
    return None
