# Pixiv Vault

自托管的 Pixiv 图片浏览、查看与下载 Web 应用。移动端优先，可容器部署。

- **浏览**：作者 → 系列 → 角色 → 图片 树形懒加载，缩略图网格，搜索；作者/系列/角色层显示修改日期，支持按名称/日期排序（localStorage 记忆）；面包屑返回恢复各层滚动位置
- **查看器**：静态图手势滑动翻页 / 双指缩放 / 双击放大，动图 canvas 帧播放；键盘 ←/→ 切换
- **下载**：粘贴链接 → 预览 meta+标签 → 手动选择系列/角色 → 后台任务 + 进度轮询；下载视图展示服务端全部任务（含快捷指令 API 触发的），下载中/失败任务可重试，已结束任务可清除
- **设置**：网络代理（HTTP/HTTPS/SOCKS5）、cookies 状态

> 注意：下载功能需要 Pixiv 登录 cookie（cookies.txt），且 Pixiv 可能需要代理访问。请遵守 Pixiv 服务条款，仅用于个人收藏。

## 快速开始

### 本地开发（需 Python 3.12+ 和 uv）

```bash
./dev.sh                 # 默认绑定局域网 IP（en0/en1 探测）
./dev.sh 8899 127.0.0.1  # 仅本机访问
```

首次运行自动创建 `.venv` 并安装依赖。数据目录默认 `./data`（可用 `PIXIV_ROOT` 环境变量覆盖）。

### 容器部署（推荐：直接拉取 GHCR 镜像）

镜像发布在 GitHub Container Registry（amd64 + arm64 双架构，push main 自动构建）：

```bash
docker pull ghcr.io/xykbear/pixiv-vault:latest
docker run -d --name pixiv-vault \
  -e PUID=1000 -e PGID=1000 -e TZ=Asia/Shanghai \
  -e PIXIV_ROOT=/data -e COOKIES_FILE=/data/cookies.txt \
  -v /path/to/data:/data -p 8899:8000 ghcr.io/xykbear/pixiv-vault:latest
```

或使用 `docker-compose.yml`（`image` 已指向 GHCR，改数据目录挂载路径与 PUID/PGID 后 `docker compose up -d`）。

### 本地构建（开发/自定义）

```bash
docker build --platform linux/amd64 -t pixiv-vault .
# Apple Silicon 等非 x86_64 主机构建 amd64 时用 --platform linux/amd64
```

## 数据目录结构

```
data/
├── config.yaml     # 配置（代理等），Web 设置页可编辑
├── cookies.txt     # Pixiv 登录 cookie
├── .thumbs/        # 缩略图缓存
└── {作者}/          # 归档作品
    ├── Collections/{作品ID}_{标题}/    # 合集（多角色混合/随机集）
    ├── {系列}/{角色}/            # 静态图 {id}_p{n}.ext + 动图 {id}.zip/.frames.json/.meta.json（同目录混合）
    ├── {系列}/_未分類/            # 有系列但角色未定（临时待分类）
    ├── オリジナル/                # 原创（平铺）
    └── _未分類/                  # 其余无系列作品（平铺）
```

> 每张图/每个作品伴随 `{作品ID}.meta.json`，webapp 下载的静态图/动图均写 meta（治理可据此追踪分类）。

## 配置

- **代理**：Web 设置页配置，写入 `config.yaml`，实时生效（无需重启）。代理仅用于访问 Pixiv 下载，与系统/Git 代理无关
- **并发下载数**：环境变量 `PIXIV_MAX_CONCURRENT`（默认 2）
- **cookies**：`config.yaml` 的 `cookies_file` 指定（默认相对数据根的 `cookies.txt`）
- **任务存储**：下载任务存内存（`_TASKS`），重启即清空，不持久化

## 技术栈

- 后端：FastAPI + uvicorn + httpx（含 socks 代理支持）+ Pillow + PyYAML
- 前端：原生 SPA（无构建），Tailwind CDN + Viewer.js（已本地化到 static/）
- 下载：后台线程池，静态图页级进度、动图字节级进度 + zip 断点续传

## 开发说明

- 前端改动（`app/static/`）刷新浏览器即生效，无需重启
- 后端改动（`app/*.py`）需重启服务
- 构建镜像时 `.dockerignore` 已排除 `.venv`/`__pycache__`

## License

MIT
