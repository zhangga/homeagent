# HomeAgent 故障快速索引

本目录记录稳定、可复用的排障路径。它不是发布状态清单：当前产品行为以
[`README.md`](../../README.md) 为准，领域与存储契约以
[`CONTEXT.md`](../../CONTEXT.md) 为准，发布门禁以
[`docs/beta-release-runbook.md`](../beta-release-runbook.md) 为准。

## 先做这四件事

1. 记录现象、首次发生时间、运行平台和最小复现，不先改数据或重装工具。
2. 确认实际进程、有效数据目录、Provider、模型、Agent revision 和 Run ID；不要从当前目录或界面默认值推断。
3. 只读取有界日志并脱敏。App Secret、令牌、授权码、消息正文和 provider 原始诊断不得进入 URL、命令行参数、Issue 或公开日志。
4. 使用最窄的只读检查复现；涉及真实飞书、真实 Provider、下载、签名、公证或发布时，必须先满足对应授权和环境门禁。

## 按症状定位

| ID | 症状 | 首要判断 | 详细条目 |
|---|---|---|---|
| CLI-001 | 新安装 `bun`/Agent CLI 后仍提示找不到命令 | 运行中的服务或终端继承了旧 PATH | [进程环境未刷新](agent-cli.md#cli-001--进程继承了旧-path) |
| CLI-002 | CLI 有版本号，但 HomeAgent 显示不可用或调用失败 | “存在、已登录、模型可路由、可实际执行”是四个不同门槛 | [Provider 分层诊断](agent-cli.md#cli-002--cli-存在不等于-provider-可用) |
| CLI-003 | Codex 启动即报 unknown/unexpected argument | 当前 Codex 版本与参数作用域不匹配 | [Codex 参数作用域](agent-cli.md#cli-003--codex-参数作用域与版本不匹配) |
| CLI-004 | PowerShell 脚本中文乱码或在无关的 `}` 附近报语法错 | Windows PowerShell 5.1 可能误读 UTF-8 无 BOM | [按消费方处理编码](agent-cli.md#cli-004--编码由消费方决定) |
| DATA-001 | 清理仓库 `data/` 后旧数据仍存在 | 运行实例使用了别的有效数据目录 | [确认有效数据目录](agent-cli.md#data-001--先确认有效数据目录) |
| DATA-002 | SQLite 损坏，担心 Raw 或知识全部丢失 | SQLite 是可重建投影，不是权威数据源 | [确认权威存储](agent-cli.md#data-002--rawwiki-权威sqlite-是投影) |
| RUN-001 | 重试后 Provider/模型/权限/Skill 发生变化 | Run 必须使用创建时冻结的执行证据 | [冻结 Run 契约](agent-cli.md#run-001--run-必须使用冻结执行证据) |
| RUN-002 | 未验收任务结果进入知识页 | WorkAction Raw 的准入状态被绕过 | [held/excluded 准入](agent-cli.md#run-002--workaction-结果先-held-再验收) |
| STORE-001 | 写盘失败后内存与重启结果不一致 | mutation 在持久化提交前污染了内存 | [候选提交与原子替换](agent-cli.md#store-001--先持久化候选再替换内存) |
| SEC-001 | Workdir/导入/Skill 路径看似在根目录内却越界 | 字符串前缀检查没有阻止 symlink/junction | [路径信任边界](agent-cli.md#sec-001--路径必须规范化并拒绝链接逃逸) |
| RELEASE-001 | Windows 聚焦测试通过，准备宣布 beta 就绪 | Windows 结果不能替代支持平台和外部门禁 | [发布结论边界](agent-cli.md#release-001--本地通过不等于-beta-ready) |

若索引没有命中，先用稳定错误片段搜索当前实现和相邻测试：

```bash
rg -n -i "错误片段|状态名|组件名" packages docs README.md CONTEXT.md
```

新增故障条目时至少记录：稳定 ID、错误指纹、根因、最短只读检查、处理、验证、易误判项和最后验证日期。后续结论推翻旧结论时保留旧错误指纹并标记纠正链，避免相同误判再次发生。
