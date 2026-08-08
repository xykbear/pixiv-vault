"""Pixiv API 客户端（httpx 版）：meta 获取、图片下载、动图 zip 断点续传。

自包含，不依赖工作区 crawl.py/pixiv_lib.py。代理来自 config.py。
"""
import json
import os
import re
import time

import httpx

from .. import config

BASE_URL = "https://www.pixiv.net"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")

_ILLUST_RE = re.compile(r"pixiv\.net/(?:artworks|illust)(?:/|/s/)[^/]*?(\d+)")
_USER_RE = re.compile(r"pixiv\.net/users/(\d+)")

IMG_EXTS = (".jpg", ".jpeg", ".png", ".gif", ".webp")


def parse_link(url: str):
    """解析链接。返回 ("work", id) / ("user", uid) / (None, None)。"""
    if _ILLUST_RE.search(url):
        return "work", _ILLUST_RE.search(url).group(1)
    if _USER_RE.search(url):
        return "user", _USER_RE.search(url).group(1)
    return None, None


def _headers(cookie: str, accept_json: bool = False) -> dict:
    h = {
        "User-Agent": UA,
        "Referer": BASE_URL + "/",
        "Cookie": cookie,
    }
    if accept_json:
        h["Accept"] = "application/json"
    return h


def get_json(client: httpx.Client, path: str, retries: int = 3) -> dict:
    url = BASE_URL + path
    cookie = config.load_cookie()
    for attempt in range(retries):
        try:
            resp = client.get(url, headers=_headers(cookie, True))
            if resp.status_code == 403:
                raise RuntimeError(f"[403] {path} — Cookie 可能过期")
            if resp.status_code in (429, 500, 502, 503, 504):
                wait = 5 * (attempt + 1)
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPError as e:
            if attempt == retries - 1:
                raise RuntimeError(f"请求失败 {path}: {e}")
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"请求失败: {path}")


def get_work_meta(work_id: str, client: httpx.Client | None = None) -> dict:
    own = client is None
    client = client or config.make_httpx_client()
    try:
        d = get_json(client, f"/ajax/illust/{work_id}")
        if d.get("error"):
            raise RuntimeError(f"meta 错误 {work_id}: {d.get('message')}")
        body = d["body"]
        if body is None:
            raise RuntimeError(f"作品不存在或未登录: {work_id}")
        return body
    finally:
        if own:
            client.close()


def get_pages(work_id: str, client: httpx.Client | None = None) -> list:
    own = client is None
    client = client or config.make_httpx_client()
    try:
        d = get_json(client, f"/ajax/illust/{work_id}/pages")
        if d.get("error"):
            raise RuntimeError(f"pages 错误 {work_id}: {d.get('message')}")
        return d["body"]
    finally:
        if own:
            client.close()


def get_ugoira_meta(work_id: str, client: httpx.Client | None = None) -> dict:
    own = client is None
    client = client or config.make_httpx_client()
    try:
        d = get_json(client, f"/ajax/illust/{work_id}/ugoira_meta")
        if d.get("error"):
            raise RuntimeError(f"ugoira_meta 错误 {work_id}: {d.get('message')}")
        return d["body"]
    finally:
        if own:
            client.close()


def work_original_urls(body: dict, pages: list | None = None) -> list:
    """返回作品全部页面原图 URL（含动图 zip URL）。"""
    if body.get("illustType") == 2:
        # 动图：由调用方通过 get_ugoira_meta 获取 originalSrc
        return []
    urls = [p["urls"]["original"] for p in pages] if pages else []
    if not urls:
        m = body.get("urls") or {}
        if m.get("original"):
            urls = [m["original"]]
    return urls


def download_file(client: httpx.Client, url: str, dest: str,
                  referer: str = BASE_URL + "/",
                  timeout: float = config.DL_TIMEOUT) -> int:
    """下载文件（支持断点续传）。返回下载字节数。"""
    cookie = config.load_cookie()
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    part = dest + ".part"
    headers = {"User-Agent": UA, "Referer": referer, "Cookie": cookie}
    already = os.path.getsize(part) if os.path.exists(part) else 0
    if already:
        headers["Range"] = f"bytes={already}-"
    with client.stream("GET", url, headers=headers, timeout=timeout) as resp:
        if resp.status_code == 403:
            raise RuntimeError("[403] Cookie 可能过期")
        if resp.status_code == 416:
            # Range 越界（已下完），直接改名即可
            os.rename(part, dest)
            return already
        if resp.status_code not in (200, 206):
            resp.raise_for_status()
        with open(part, "ab") as f:
            for chunk in resp.iter_bytes(1024 * 128):
                f.write(chunk)
    os.rename(part, dest)
    total = already + (os.path.getsize(dest) - already) if already else os.path.getsize(dest)
    return total


def download_with_progress(client: httpx.Client, url: str, dest: str,
                           on_progress, referer: str = BASE_URL + "/",
                           timeout: float = config.DL_TIMEOUT) -> None:
    """流式下载 + 字节进度回调 on_progress(done, total)。支持断点续传。"""
    cookie = config.load_cookie()
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    part = dest + ".part"
    headers = {"User-Agent": UA, "Referer": referer, "Cookie": cookie}
    already = os.path.getsize(part) if os.path.exists(part) else 0
    if already:
        headers["Range"] = f"bytes={already}-"
    done = already
    with client.stream("GET", url, headers=headers, timeout=timeout) as resp:
        if resp.status_code == 403:
            raise RuntimeError("[403] Cookie 可能过期")
        total = done + int(resp.headers.get("Content-Length", 0))
        if resp.status_code == 416:
            os.rename(part, dest)
            on_progress(done, done)
            return
        if resp.status_code not in (200, 206):
            resp.raise_for_status()
        with open(part, "ab") as f:
            for chunk in resp.iter_bytes(1024 * 128):
                f.write(chunk)
                done += len(chunk)
                on_progress(done, total)
    os.rename(part, dest)
    on_progress(done, total)
