"""配置管理：config.yaml 读写 + 代理 opener 构造。"""
import os

import httpx
import yaml

DEFAULT_PIXIV_ROOT = os.environ.get("PIXIV_ROOT", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"))
# cookies.txt：容器内挂载到 /data/cookies.txt（相对数据根），本地开发用 webapp/data/cookies.txt
DEFAULT_COOKIES_FILE = os.environ.get("COOKIES_FILE", "cookies.txt")
LOCAL_COOKIES_FALLBACK = os.path.join(DEFAULT_PIXIV_ROOT, "cookies.txt")

DEFAULT_CONFIG = {
    "proxy": {"scheme": "", "host": "", "port": ""},
    "cookies_file": DEFAULT_COOKIES_FILE,
    "thumb_size": 300,
}

REQ_TIMEOUT = 30.0
DL_TIMEOUT = 60.0


def get_root() -> str:
    return os.environ.get("PIXIV_ROOT", DEFAULT_PIXIV_ROOT)


def config_path() -> str:
    return os.path.join(get_root(), "config.yaml")


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(config_path(), encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        if isinstance(data, dict):
            for k in DEFAULT_CONFIG:
                if k in data:
                    cfg[k] = data[k]
    except FileNotFoundError:
        pass
    return cfg


def save_config(cfg: dict) -> None:
    merged = dict(DEFAULT_CONFIG)
    merged.update(cfg)
    os.makedirs(get_root(), exist_ok=True)
    with open(config_path(), "w", encoding="utf-8") as f:
        yaml.safe_dump(merged, f, allow_unicode=True, sort_keys=False)


def cookies_path() -> str:
    cfg = load_config()
    cf = cfg.get("cookies_file") or DEFAULT_COOKIES_FILE
    if os.path.isabs(cf):
        return cf
    p = os.path.join(get_root(), cf)
    if not os.path.exists(p) and os.path.exists(LOCAL_COOKIES_FALLBACK):
        return LOCAL_COOKIES_FALLBACK
    return p


def load_cookie() -> str:
    """读取 cookies.txt 返回 Cookie 头字符串。"""
    path = cookies_path()
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""


def cookie_status() -> dict:
    """检查 cookies 是否可用（含 PHPSESSID 判断）。"""
    path = cookies_path()
    if not os.path.exists(path):
        return {"ok": False, "exists": False, "reason": f"cookies.txt 不存在: {path}"}
    cookie = load_cookie()
    ok = "PHPSESSID=" in cookie
    return {
        "ok": ok,
        "exists": True,
        "path": path,
        "reason": "" if ok else "cookies.txt 缺少 PHPSESSID，可能已过期",
    }


def proxy_url() -> str | None:
    """构造代理 URL。scheme 为空则返回 None（直连）。"""
    cfg = load_config()
    p = cfg.get("proxy") or {}
    scheme = (p.get("scheme") or "").strip().lower()
    host = (p.get("host") or "").strip()
    port = str(p.get("port") or "").strip()
    if scheme and host and port:
        return f"{scheme}://{host}:{port}"
    return None


def make_httpx_client(**kwargs) -> httpx.Client:
    """构造带代理/超时的 httpx 客户端。"""
    kwargs.setdefault("timeout", httpx.Timeout(DL_TIMEOUT, connect=REQ_TIMEOUT))
    proxy = proxy_url()
    if proxy:
        kwargs.setdefault("proxy", proxy)
    return httpx.Client(**kwargs)
