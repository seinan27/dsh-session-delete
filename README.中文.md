# dsh-session-delete[会话删除]

[English](./README.md) | [简体中文](./README.中文.md)

给 DeepSeek Harness 的每个会话行一个**真删除**按钮，而且把两种删除分开讲清楚。

**默认：进 Windows 回收站。** 会话目录挪到回收站，就是你平时找已删东西的地方。想还原就在资源管理器里还原，想真没了就清空回收站。

**彻底：不留痕迹。** 目录销毁，同时把 DSH 里所有明文提到这个会话 id 的地方一起清掉。

---

## 为什么要有「彻底」这一步的清扫

2026-11-26 在真实 profile 上量出来的。一个会话按常规方式删掉——registry 条目摘了、目录没了、标题缓存也删了。这个 id 还留在五个文件里：

```
main-session.json                     邻近插件维护的会话登记
session-send-delivered.json           投递账本
storages/workspace.json               工作区的 sessionIds 数组
qq-bridge/transcript.jsonl            ← 里面躺着一段完整回复原文
prompt-inherit.log / subagent-policy.log
```

**一个「已删除」的会话，回复原文还留在转录里，那就没删。** 所以 `permanent` 现在会扫这些地方：`.jsonl` 和 `.log` 整行去掉，`.json` 删键和数组元素。

**它做不到的：** 改不了第三方插件写在 `$DSH_HOME` 之外的东西，也不碰 `.zstd` 备份或你自己做的磁盘镜像。它清理的是**按名字知道的那些存储**，遇到解析不了的文件会记一条警告——绝不静默跳过。

## registry 从不手改

`storages/workspace.json` 是通过活的 storage domain（`unarchive` / `unpin` / `remove`）写的，不是直接编辑文件。背着宿主改那个文件，是工作区在下次写入时丢会话的老路。

## 安装

```bash
dsh plugin --profile <profile> add github:seinan27/dsh-session-delete#v1.0.0
```

需要 web server 和 storage domain；headless profile 不会加载这个 bundle。装完重启 DSH——插件代码和前端那一半都在启动时加载。

## 用法

1. 勾选要删的会话（点行里的勾选框；滚动不影响已选）。
2. 底部出现一条浮条：决定勾不勾**彻底删除**。
3. 删。

不勾，什么都不问——这个操作是可恢复的，问一句反而像在说它不可恢复。勾了，会问一次，并列出要删的东西。

## 一次删除实际做了什么

| 步骤 | 默认 | 彻底 |
|---|---|---|
| 停掉该会话上活着的 agent | 是 | 是 |
| 从归档 / 置顶里摘掉 | 是 | 是 |
| 从工作区 registry 移除 | 是 | 是 |
| 会话目录 | → Windows 回收站 | 销毁 |
| 标题缓存（`session_projcache`） | 删 | 删 |
| 其他文件里的引用 | 不动 | 清扫 |
| `session-delete.log` 记一行审计 | 是 | 是 |

如果磁盘没有回收站（网络共享、某些移动硬盘），默认会退回本插件自己的 `$DSH_HOME/.trash-sessions/`，并在 warnings 里说明——不会因为挪不进去就让删除失败。

## 测试

```bash
node test/basic.mjs     # 14 项，无框架、无网络
```

能被离线测的只有清扫那一半——它是纯文件手术。registry 摘除、停 agent、web 路由都要 storage domain，靠手工验。

## 许可

MIT，见 [LICENSE](./LICENSE)。

与 DeepSeek 无隶属关系，也未经其背书。
