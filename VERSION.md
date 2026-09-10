# Fork change log / 组织 fork 版本记录

## central-infra 0.1.2 candidate — 2026-09-10

- 在原 Debian bookworm 发行系内固定 Node 24.21.0 官方 index digest，运行阶段安装 PCRE2 `10.42-1+deb12u1` 修复版本；从最终文件系统移除 npm/Yarn 及其 Corepack 引导工具的目录、依赖与入口，构建阶段仍按原锁文件使用 npm。
- 容器验收读取实际 Node/OpenSSL/Undici/zlib、PCRE2 包/文件摘要与工具缺席证据，检查真实 HEALTHCHECK 及原 Compose 对应的权限、挂载、回环端口和资源约束。
- PCRE2 实际共享库逐字节核对包校验和并记录 SHA-256；保留 slim 镜像按既有配置省略三份文档的原始 dpkg 验证输出，不将文档缺席误判为运行库损坏。
- 合成数据库回归增加重复迁移、软删除物理行/统计不可见，以及服务在线备份、独立卷恢复后的鉴权、重放、schema/dataset、统计与删除状态核对；沿用现有 CI 的镜像归档和原始验收输出，config/layer 身份从归档回读。
- README 和两种语言的运行说明同步。业务协议、数据库结构和应用入口保持原实现；候选仍待独立镜像/漏洞验收，剩余系统与内嵌依赖风险不由版本记录接受。没有注册表发布、生产变更或真实 Hook 发放。

English: pins Node 24.21.0 on the existing Debian release, installs the specific
PCRE2 security fix and removes npm/Yarn and Corepack from the final runtime filesystem. Actual
container checks cover dependency versions, health, deployment constraints, repeat
migration, soft deletion and a live SQLite backup restored to an independent volume.
CI retains the image identity and raw results. Remaining vulnerabilities require
independent review; this is not registry publication or production approval.

## central-infra 0.1.1 candidate — 2026-09-10

- 修复汇总日期筛选的首尾边界：最多接受 366 个 UTC 日期；此前日期差计算漏算端点，错误接受了 367 个日期。
- `2025-01-01` 至 `2026-01-01` 保持 HTTP 200，至 `2026-01-02` 返回 HTTP 400；真实 HTTP 回归和独立进程/容器驱动覆盖两侧边界，README 与中英文运行说明同步。
- 同一基础建设候选的修复，待独立验收；原生 CLI 版本、存储结构、真实 Hook 和生产部署状态不变。

English: fixes the inclusive UTC summary range limit. A range containing 366 dates
remains valid; 367 dates now return HTTP 400. HTTP and process/container regression
checks cover both endpoints. This remains a candidate for independent acceptance.

## central-infra 0.1.0 candidate — 2026-09-10

- 基于 Tencent/teamai-cli `3f7fa1dedbccac1416fe329bdd308bb45de30b0e` 新增独立中央统计服务；原 package 版本保持 0.22.0，不冒充 npm 0.23.x 或自动升级用户 CLI。
- 严格累计快照白名单、成员/安装/项目身份绑定、管理员登录、实时撤销/过期检查和中文筛选汇总。未知计数与已知零分开；UTC 首次统计日归属会话。
- 管理页使用 same-origin Referrer-Policy，保证原生浏览器表单具有可校验的 Origin；跨域/缺失来源继续拒绝。桌面和手机须验证真实登录，不能由服务端表单模拟替代。
- SQLite 显式结构迁移、事务去重/乱序处理、独立卷持久化，合成与生产数据卷绑定；没有公开删除/恢复接口。
- 容器构建检查中央生产源码禁止物理业务删除；隔离测试验证软删除物理行保留、默认统计不可见。CI 留存可下载镜像归档与传输 SHA-256，支持按准确产物交接。
- 锁定 Node 24.19.0 官方镜像摘要，以 UID 1000、只读根文件系统和移除 capabilities 的容器运行。
- fork 工程 CI 合并为一个容器构建及验收 job（12 分钟上限，构建 8 分钟、容器验收 2 分钟），保留相关原生 token、Dashboard、HTTP、Git 路径回归；不复用上游外部测试仓库或发布身份。npm package 标记 private，release job 限制仅上游仓库可运行。
- 固定 Node 24 类型定义以使用内置 SQLite；原 CLI 构建目标仍为 Node 20。中央服务单独入口仅要求 Node 24；原生 CLI 无 SQLite 启动依赖。
- 本版本为候选。真实服务器、HTTPS、部署/恢复以及真实成员接入均需各自的独立验证，不由本变更记录宣布通过。

English: adds a standalone authenticated Chinese usage service, strict cumulative
statistics protocol, explicit SQLite migration, durable volume and a non-root
container. Fork CI validates synthetic data and related upstream behavior. No
upstream npm release, production deployment or real user Hook is performed by CI.
