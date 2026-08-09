"""缩略图服务：Pillow 生成 + .thumbs/{cache_key}.webp 磁盘缓存。

- 静态图：对任意图片文件生成缩略图，缓存键 = hash(rel_path)
- 动图：取 zip 第一帧生成，缓存键 = hash(rel_path)
"""
import hashlib
import io
import os
import zipfile

from .. import config


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
