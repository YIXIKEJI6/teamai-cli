# 中央用量服务

本服务接收经过审核的统计快照并提供中文管理页。它独立于原生 Git 规则/Skill 分发、本机 Dashboard 和 local-agent HTTP 资源协议。运行服务不会扫描 HOME、安装 Hook、读取 transcript 或向远端发送历史会话。第一版为单实例、小团队服务，SQLite 放在本地持久卷；不支持多主机共享网络文件系统或多副本部署。

## 构建与合成验收

需要 Docker Engine（含 Linux 容器）和 Node 20+ 来运行外部验收驱动；直接运行中央服务需要 Node 24。依赖由 package-lock 锁定。官方基础镜像 Node 24.21.0 bookworm-slim 的 index 摘要写在 Dockerfile；镜像 config ID、注册表 manifest digest 和 source commit 是不同对象。CI 不上传注册表，不能把本地镜像 ID 填成尚不存在的发布摘要。

```sh
docker build --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" --iidfile /tmp/teamai-image-id .
export TEAMAI_CENTRAL_IMAGE="$(cat /tmp/teamai-image-id)"
node scripts/central-e2e.mjs docker
```

构建阶段保留 npm，安装一次锁定依赖、编译、类型检查和相关原生/中央回归。运行阶段安装 Debian `libpcre2-8-0=10.42-1+deb12u1` 安全修复，并删除基础镜像自带 npm/Yarn 及其 Corepack 引导工具的实际目录、依赖和入口。应用只复制中央 bundle、迁移和许可证，不复制应用 node_modules、CLI 或凭据；其余 Debian/Node 文件仍在，须按准确镜像审查漏洞。

外部验收驱动创建独立随机合成卷，通过真实 HTTP 验证两个成员/项目、错误鉴权、白名单、去重、乱序、登录撤销、数据/日志隐私，再重建容器验证持久化。容器内记录 Node/OpenSSL/Undici/zlib 实际版本、PCRE2 包版本与文件摘要、npm/Yarn 文件和入口缺席。镜像自带 HEALTHCHECK 必须真实执行成功；同时检查 UID 1000、只读根文件系统、capabilities、no-new-privileges、回环端口、只读鉴权挂载、256 MiB/1 CPU 与 tmpfs 约束。

仅对驱动自建的合成库做参数化软删除 fixture，确认物理行保留、重复删除幂等、HTTP 汇总不可见。服务运行期间通过 SQLite 备份 API 制作一致副本，恢复到另一独立卷，核对 schema、dataset、物理行、删除状态、鉴权、重放和统计；原卷及恢复卷各执行两次迁移。最后只清理本次合成容器和卷，不增加业务删除或恢复接口。

PCRE2 共享库字节必须匹配已安装包的校验和，并记录 SHA-256。保留 `dpkg -V` 原始输出；仅允许基础镜像既有 slim 文档排除配置对应的三份 README/changelog 缺席，运行库缺失或校验失败仍直接阻断。

本机没有 Docker 时可单独验证真实 Node 进程链路，但该结果不能替代容器验收：

```sh
npm ci --ignore-scripts
npm run typecheck
npm run test:central
npm run build
node scripts/central-e2e.mjs local
```

沿用现有 CI 的单个 Ubuntu job 执行 Docker 构建与上述容器验收，保存镜像归档、来源标签和原始结果；config/layer 身份从归档回读，本次不修改 workflow。它不推送镜像注册表、不发布 npm、不自动部署。应用 bundle 只内联 zod 和本服务；上游 CLI 依赖审计、镜像系统依赖和 Node 内嵌库须分别归因。版本更新不等于其余依赖没有漏洞；发布前仍须保存准确镜像、扫描器和数据库身份，逐项审查剩余适用性。

## 配置与显式初始化

先审查成员/安装/项目别名以及管理员身份。参考 docker/identities.synthetic.json 写一份**位于仓库之外**的 identities.json；真实环境必须设 dataset=production，并使用新的数据卷。expiresAt 是明确的 UTC 到期时间。别名只允许字母、数字、下划线和短横线；不使用姓名、主机名、路径或仓库 URL 代替匿名别名。

```sh
node scripts/central-credentials.mjs /secure/reviewed-identities.json /secure/NEW-teamai-credentials
```

输出 server/auth.json 只含 SHA-256 摘要与已审查绑定，client-secrets/ 下是各自随机 256-bit 凭据文件（0600），不会在终端打印。**只把 server/ 交给服务端，凭据通过已有安全渠道分别交给对应管理员/安装端。** 示例路径须替换为已审计路径；脚本不会配置 Secret Manager 或代表安全渠道已成立。生产文件权限应让容器 UID 1000 可读取（目录 0700、文件 0600、owner 1000），由已获权运维在受控目录准备，不能挂载管理员 HOME 或整份 TeamAI 配置。

```sh
export TEAMAI_CENTRAL_AUTH_DIR=/secure/NEW-teamai-credentials/server
export TEAMAI_CENTRAL_ORIGIN=https://usage.example.com
export TEAMAI_CENTRAL_IMAGE=sha256:REPLACE_WITH_VERIFIED_IMAGE_ID
docker compose -p teamai-central run --rm central migrate
docker compose -p teamai-central up -d central
docker compose -p teamai-central ps
```

`migrate` 是独立运维动作，执行版本化 001 结构迁移；重复执行只验证版本及数据集，不在 serve 时补表、补字段或回填。真实已有数据库迁移须按环境授权办理。配置文件与数据卷绑定 synthetic/production，切换模式须新卷，禁止借同一卷混入测试数据。

Compose 只映射 127.0.0.1:3722，根文件系统只读、UID 1000、cap_drop=ALL；卷名绑定 Compose project，重建时保持同一 project。禁止 `down -v` 作为生产重启操作。管理员入口使用公开 HTTPS origin；HTTP origin 只允许回环验证。数据库路径、监听地址/端口可由 TEAMAI_CENTRAL_DB/HOST/PORT 明确配置；直接 Node 默认监听 127.0.0.1，原 CLI dashboard 的 127.0.0.1:3721 保持不变。

## HTTP 与统计口径

| 接口 | 身份 | 行为 |
|---|---|---|
| GET /healthz | 无 | 只返回可用性，不返回成员或统计 |
| GET /login、POST /login | 登录入口 | 管理员标识+凭据；同源检查、失败限流 |
| GET / | 管理员 | 中文汇总页面；匿名请求 401 |
| POST /logout | 同源浏览器 | 撤销本次 HttpOnly / SameSite=Strict 会话 |
| POST /api/usage/report | 安装 Bearer | 严格统计累计快照，管理员凭据不能上报 |
| GET /api/usage/options | 管理员 | 允许成员/项目别名 |
| GET /api/usage/summary | 管理员 | member/project/from/to 筛选；日期含首尾，最多 366 天 |

日期边界示例：`from=2025-01-01&to=2026-01-01` 包含 366 个日期，可以查询；结束日期延长至 `2026-01-02` 则包含 367 个日期，返回 HTTP 400。

report 必需字段：schemaVersion=1、UUID eventId/sessionId、绑定的 memberId/installationId/project、firstStopAt/observedAt（UTC，精确到毫秒）、单调正整数 sequence、prompts（非负整数或 null）、tokens 四桶 input/output/cacheRead/cacheCreation（各为非负整数或 null）、producerVersion。每个计数最多 10^12，请求最多 8192 字节。拒绝未知字段、负数、路径、未来时间超过 5 分钟、身份不符或不允许的项目；返回泛化错误，不回显输入。

上游 Codex 新格式为会话级累计 token_usage_record；旧格式按 rollout 取最新再汇总。**中央接口要求生产端先完成逻辑会话聚合**，不能每个 rollout 独立上报为同一累计快照，否则会被冲突检查拒绝或口径错误。客户端适配/Hook 属于后续阶段，本版本只有合成验收驱动，不能把上游 event 文件直接 POST。

- eventId 在安装内唯一。同 ID 同内容返回 duplicate，不同内容返回 409；客户端网络失败用同一事件和相同内容重试。
- 逻辑会话键由成员、安装、项目、匿名会话 UUID 组成。较旧 sequence 返回 stale，不改变总量；相同 sequence 不同事件、首日改变、计数下降、已知退回未知或新快照时间倒退返回 409。更高序号更新整份快照，所有写入在事务内完成。
- 各 token 桶互不重叠，沿用原生 TokenUsage；Codex 输入已经由原生解析器扣除缓存读。未知桶是 null，已知零是 0；页面和 API 同时展示已知小计及未知会话数。
- 会话归属 firstStopAt 的 UTC 日期，跨日续接仍更新首日。这是会话归属汇总，不是期间内每个请求的发生量；不计算成本/配额。latestReport 指筛选范围内最新接受的新快照接收时间，重试/旧序号不刷新它。
- 原生 report/sync/ack 仍服务原来的资源后端，Git 分发保持；本服务未知资源路由返回 404。没有企业 SSO，管理员凭据是独立高熵身份。
- 凭据仅在只读配置里保存摘要；每请求重新读取，revoked=true、过期或旋转后立即失效，已有管理员 session 也失效。原子替换 server/auth.json 即可生效（挂载整个 server/ 目录），别改统计库来撤销凭据。
- 无公开业务删除/恢复接口；普通统计始终过滤 del_status=0。不做自动清理或隐式恢复；真实数据保留与治理需另有授权。

## HTTPS、备份与恢复

反向代理由目标环境现有服务承接。只新增已批准域名到本机回环端口，保留原服务，限制请求体和超时，不记录请求体、Authorization 或 Cookie。完成真实 DNS、证书链、匿名 401、错误/撤销身份、合成隔离数据、进程重启/容器重建验证后才能称目标服务可用。

备份采用 SQLite 一致性备份 API（或停止**本服务**后复制完整卷），不能在写入时只复制主 .sqlite 文件忽略 WAL。恢复先在独立卷验证同一 schema、dataset、统计及鉴权，再按获权窗口切换。镜像回滚用已验收 digest；首部署没有历史镜像就明确记录“无上一版本”，回退是停止新服务、撤回本次专属代理配置并保留数据卷，不能伪造旧 digest。

上线前保留 source HEAD、镜像摘要、CI、环境审计、授权动作、数据备份/恢复和真实 HTTPS 证据。候选代码、容器 CI、独立验收、生产上线和真实成员采集是分别判断的状态。
