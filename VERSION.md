# Fork change log / 组织 fork 版本记录

## central-infra 0.1.0 candidate — 2026-09-10

- 基于 Tencent/teamai-cli `3f7fa1dedbccac1416fe329bdd308bb45de30b0e` 新增独立中央统计服务；原 package 版本保持 0.22.0，不冒充 npm 0.23.x 或自动升级用户 CLI。
- 严格累计快照白名单、成员/安装/项目身份绑定、管理员登录、实时撤销/过期检查和中文筛选汇总。未知计数与已知零分开；UTC 首次统计日归属会话。
- SQLite 显式结构迁移、事务去重/乱序处理、独立卷持久化，合成与生产数据卷绑定；没有公开删除/恢复接口。
- 锁定 Node 24.19.0 官方镜像摘要，以 UID 1000、只读根文件系统和移除 capabilities 的容器运行。
- fork 工程 CI 合并为一个容器构建及验收 job（12 分钟上限，构建 8 分钟、容器验收 2 分钟），保留相关原生 token、Dashboard、HTTP、Git 路径回归；不复用上游外部测试仓库或发布身份。npm package 标记 private，release job 限制仅上游仓库可运行。
- 固定 Node 24 类型定义以使用内置 SQLite；原 CLI 构建目标仍为 Node 20。中央服务单独入口仅要求 Node 24；原生 CLI 无 SQLite 启动依赖。
- 本版本为候选。真实服务器、HTTPS、部署/恢复以及真实成员接入均需各自的独立验证，不由本变更记录宣布通过。

English: adds a standalone authenticated Chinese usage service, strict cumulative
statistics protocol, explicit SQLite migration, durable volume and a non-root
container. Fork CI validates synthetic data and related upstream behavior. No
upstream npm release, production deployment or real user Hook is performed by CI.
