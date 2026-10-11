# chaoxinghelper · 学习通助手

学习通助手的可编辑源代码导出，不是网站打包产物。包括独立查询网站、QQ Bot、Cloudflare 后台调度、本机 HTTPS 代理、卡片字体和模拟测试。

这是独立的源码仓库，不会更改现有线上部署，也不包含原网站的选课预约、日记页面或内容。原项目中为助手服务的共享数据库初始化、提醒和认证辅助模块保留，以避免漏掉依赖。

## 源码目录

- `app/query/`：登录、课程选择、任务进度、位置地图、站内提示及弹窗。
- `app/api/query/`：登录、本站会话校验、退出、状态、挂载控制、位置配置与自助修复接口。
- `lib/chaoxing-*.ts`：请求协议、登录会话、课程位置与网站后台选择。
- `lib/onebot-chaoxing-recovered.ts`、`lib/chaoxing-recovered.ts`：当前调度所使用的恢复版本源码；保留原实现及导出名称。`onebot-chaoxing.ts` 和 `chaoxing-client.ts` 是同时保留的基础实现与测试对象。
- `worker/`：QQ 会话与独立网站账号的 Durable Object，Alarm/Cron 持续调度。
- `scripts/chaoxing-local-relay.mjs`：鉴权、目标白名单、本机请求转发及脱敏诊断。
- `scripts/start-chaoxing-relay.ps1`、`ops/`：Windows 启动与 Tunnel 服务安装脚本。安装脚本需要管理员权限，源码导出过程不会执行它们。
- `public/fonts/`：网站和 QQ 卡片字体，见其中的授权文件。
- `tests/`：仅使用虚构账号与模拟响应的测试。

## 已排除的内容

没有复制旧 Git 历史、账号记录、密码、Cookie、会话数据、签到记录、生产令牌、Tunnel 凭据、原 D1 数据、R2 对象、环境变量文件、运行日志、HAR 或浏览器配置。配置仅保留空值和占位符。测试中的账号和 Cookie 均为虚构样本，不对应真实账号。

## 本地开发

需要 Node.js 22.13 或以上、pnpm。

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm typecheck
pnpm build
```

网页入口为 `/query`。本地 HTTP 开发时，浏览器对 `Secure` Cookie 的接受行为可能不同；登录联调建议使用 HTTPS。

## 新部署

不要使用原站的资源名称、数据库或凭据。先在自己的 Cloudflare 账号中创建 `chaoxinghelper-db` D1 数据库和 `chaoxinghelper-reminders` R2 桶，将自己的数据库 ID 填入 `wrangler.jsonc`。新仓库的 DO 迁移仅用于全新部署，不用于替换已有生产 Worker。

数据库表由 `db/runtime.ts` 和各模块按需建立，仓库不含数据导入。独立网站账号无需 QQ Bot 注册；QQ 功能需要另行配置自己的 OneBot 11 客户端并向 `onebot_bots` 注册 Bot 与令牌哈希。反向 WebSocket 路径为 `/api/onebot/ws`，鉴权使用 `Authorization: Bearer <token>`，哈希规则见 `oneBotTokenHash`。群组授权字段见 `onebot_bots.groups_json`。

```sh
pnpm build
pnpm deploy
```

生产密钥使用 Wrangler secret 注入，不能提交到 Git。`CHAOXING_RELAY_ORIGIN` 和 `CHAOXING_RELAY_TOKEN` 必须与你自行部署的代理一致；可在 `.dev.vars` 中配置开发值，示例见 `.dev.vars.example`。`CARD_FONT_ORIGIN` 可指向你自己的 HTTPS 站点，卡片优先使用内部 ASSETS 读取字体。

代理保持监听 `127.0.0.1:8788`。运行 `pnpm relay` 时会读取环境变量中的令牌，或在本地生成被 Git 忽略的 `.chaoxing-relay-token`。不要把代理直接裸露到公网。需要 Tunnel 时复制 `ops/cloudflared-chaoxing.example.yml` 为被忽略的正式配置，填写自己的 Tunnel ID、域名和凭据文件。再按需使用 Windows 启动脚本或服务安装脚本。

这份仓库不会使本机代理在电脑关机后继续运行；如需常驻，需要另行部署可控主机。

## 会话与验证边界

网页会话 Cookie 为 `cx_query_session`，当前有效期为 12 小时，要求 `HttpOnly; Secure; SameSite=Lax`。网页登录退出不会自动取消后台任务。上游 Cookie 失效、网络限制或验证码仍需处理，不承诺绕过平台验证。

登录后会使用 `/api/query/session` 核对本次新签发的 HttpOnly Cookie，校验成功才进入看板；Cookie 未保存或仍为之前账号的会话时，留在登录页并展示原因。校验凭据不是登录令牌，不能替代 Cookie 登录。位置接口 `401` 会返回登录页，后台任务不因此停止。顶部 Toast 固定 3 秒后开始收起，不因悬停、键盘焦点或触摸暂停；居中的错误日志弹窗仍需手动关闭。

测试验证模拟协议、隔离、状态和脱敏行为，不使用真实学生账号，也不替代真实平台授权与联调。

第三方协议说明见 `docs/chaoxing-third-party.txt`；字体授权见 `public/fonts/`。本次导出没有自行变更原代码的授权条款。
