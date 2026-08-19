[English](README.md) · [简体中文](README.zh-CN.md)

# pi-claude-cross-session

**pi** 与 **Claude Code** 之间的跨会话消息，构建在 Claude Code 自己的 peer
协议之上。pi 侧注册的工具与 Claude Code 跨会话消息功能暴露的工具**完全一致**，
包括定义逐字相同的两个工具：`ListAgents`（发现）和 `SendMessage`（投递），
外加 `/list-agents` 与 `/peers` 命令。Claude 侧无需安装任何东西：本 pi 会话
会出现在 Claude Code 原生的 `ListAgents` 里，并原样接收其原生 `SendMessage`
发来的消息。

## 演示

**pi 注册自己**——会话启动时绑定收件 socket，并在 Claude Code 自己的会话注册表
里发布自己：

<img src="docs/images/01-register.png" width="800" alt="pi 的启动通知：Claude cross-session messaging on, visible to Claude Code as pi-demo-43b">

**Claude Code 发现它**——这个 pi 会话出现在 Claude Code 原生的 `ListAgents` 里，
可以按名字寻址：

<img src="docs/images/02-discover.png" width="800" alt="Claude Code 确认 pi-demo-43b 已列出，可以通过 SendMessage 触达">

**一条消息走完一个来回**——Claude Code 的 `SendMessage` 送达 pi 的收件箱，pi
再用它自己的 `SendMessage` 回一条，两个方向用的是同一套工具和协议：

<img src="docs/images/03-roundtrip.png" width="800" alt="Claude Code 给 pi 发消息，pi 回复确认双向消息生效">

机制一句话：Claude Code 给每个会话分配一个收件 socket 和磁盘上的一条注册表
记录。pi 从该注册表发现活着的 Claude 会话，并把 peer 协议帧写到它们的收件
socket。反方向上，pi 绑定自己的收件 socket、以 `pi-*` peer 的身份发布自己的
注册表记录，于是 Claude Code 内置工具到达 pi 的方式与到达另一个 Claude 会话
完全一样。入站消息在一个轮次的工具调用之间投递给 pi agent，pi 空闲时则开启
一个新轮次——与 Claude Code 官方文档描述的自身会话投递行为一致。

本扩展所延伸的功能见 Claude Code 官方的
[跨会话消息](https://code.claude.com/docs/en/cross-session-messaging)
页面。它所依赖的注册表和线上帧格式并不是文档化的第三方 API；本包在使用前
严格校验每一个消费到的字段、帧、socket 和进程事实，接口漂移只降级本功能。

## 环境要求

- pi 0.84.2 或更高版本（已在 0.84.2 上实测），运行于 macOS 或 Linux。
- Claude Code 2.1.224 或更高版本，且其会话已启用跨会话消息。消息启用后无需
  额外操作；若某个会话不在列表中，适用 Claude Code 自己的要求（版本、
  特性开关评估、收件 socket 绑定）。
- 接收方 Claude 会话的 `crossSessionInbound` 设置决定进入该会话的消息如何
  处理。pi 不能也不会覆盖该决定。

## 安装

发布之后：

```bash
pi install npm:pi-claude-cross-session@0.1.0
# 或者从 git 发布标签安装：
pi install git:github.com/utopia2077/pi-claude-cross-session@v0.1.0
```

在本 checkout 中免安装快速试用：

```bash
pi -e ./index.ts
```

## 工具

两个工具逐字沿用 Claude Code 自己的名称、描述和参数 schema，因此熟悉
Claude Code 工具面的模型可以无差别地驱动它们。

### ListAgents

发现 pi 可以发消息的会话。每个存活且启用消息功能的 Claude Code 会话列为
一行：名称、类型标签、状态和工作目录。名称就是 `SendMessage` 的地址。当两行
共用同一个裸名称时，列表会给这些行追加短 ` [ref]`；向完整的 `name [ref]`
形式发送即可消歧。会话只有绑定了收件 socket 才会出现；存活但未绑定的会话
只报告数量、不列出。

### SendMessage

向指定名称的会话投递一条纯文本消息。`to` 接受列表中的裸名称，或当列表/错误
显示了 ` [ref]` 时的 `name [ref]` 形式。可选的 `summary` 字段仅为定义对等而
接受：与 Claude Code 中一样，它是只影响 UI 的一行预览，从不随消息正文传输；
pi 没有此类预览，因此它在这里不起作用。消息到达目标会话的收件 socket；其
自身的 `crossSessionInbound` 设置决定 Claude 是否读取，结果会以投递通知的
形式回报给 pi。

## 行为与边界

- **投递到会话的收件 socket，而不是模型。** 帧写入目标收件 socket 即报告
  `SendMessage` 成功。接收方会话自身的入站设置决定 Claude 是否读取。Claude
  Code 会把结果（held/denied/expired/delivered）回写到 pi 的 socket；pi 在
  会话记录中显示为投递通知。
- **失败的写入绝不自动重试。** 未写出任何字节的超时是干净失败；结果不明确的
  写入按不明确如实报告，必须与接收方核对。
- **名称是唯一地址。** 消息按 `ListAgents` 给出的精确当前名称寻址，仅当裸
  名称有歧义时才追加 ` [ref]`。会话 UUID 与 socket 路径从不打印、从不持久化。
- **一个进程、一条广告。** pi 在会话启动时绑定一个收件 socket、发布一条注册
  表记录；两者在会话关闭时移除，包括状态更新与关闭并发竞态的情形。
- **有界。** 帧上限 64 KiB，最多 32 个并发连接、每连接 8 帧，最多 50 条待读
  入站消息；溢出即丢弃。
- **同用户、同机器。** pi 从不与其他机器上的会话通信、从不经过 Anthropic
  服务器，且只能到达当前 OS 用户拥有的会话。注册表目录和 socket 目录必须是
  当前用户拥有、模式为 0700 的真实目录；任何不安全证据都会大声降级本功能，
  而不是猜测。
- **来源被展示，而非被认证。** 入站消息标注有从注册表解析出的发送方会话
  名称。已经以你的 OS 用户身份运行的代码同样可以读写这些文件和 socket。

## 已知限制

- **`/reload` 会轮换会话身份。** pi 在每次 `session_start` 生成新的会话
  UUID，因此 `/reload`（或任何会话替换）之后，Claude 看到的是一个新 peer，
  跨边界的会话连续性会丢失。广告按设计是每会话一条；在途消息按旧身份结算。
- **没有去重或环回节流。** Claude Code 会对重复消息限速并丢弃相同重复；pi
  只把待读入站队列限制在 50 条。一个有 bug 或恶意的同用户发送方仍可填满
  队列。
- **pi 胶水层没有自动化测试。** 协议适配器（`peer.ts`）有假 socket 和测试
  自有目录的单元测试覆盖；`index.ts` 里的扩展接线通过真实 pi 会话的手工烟测
  验证。

## 配置

- `PI_CLAUDE_MESSAGING=off`（或 `0`、`no`、`false`）禁用本扩展：工具全部
  失效，不绑 socket，不写注册表记录。

## 它刻意不是什么

- 不是 broker 或守护进程：一个 pi 进程拥有一个 socket 和一条注册表记录，
  会话启动时创建、会话关闭时移除。
- 不是编排器：pi 从不启动或管理 Claude 会话，也从不打断或操纵它们。
- 不是权限绕过：来自其他会话的消息从不批准任何事，入站消息要求的一切动作
  仍然受 pi 自己的工具与权限提示约束。

## 故障排查

- `ListAgents` 返回 "no reachable sessions"：目标 Claude 会话必须正在运行且
  已启用消息功能。Claude Code 内部的 `/list-agents` 会显示它自己可达的会话。
- 注册表完全缺失：先启动一次 Claude Code；它会创建 `~/.claude/sessions`。
- 发送报告成功但 Claude 会话没有任何显示：检查目标会话的
  `crossSessionInbound` 设置和 pi 的投递通知；被挂起或拒绝的消息会在那里
  报告。
- 在 Linux 上，广告记录和进程检查使用 `/proc`；在没有 `/proc` 的容器里，
  发现和存活检查会降级。

## 开发

### 本地开发循环

把 checkout 安装进 pi 而不复制文件；pi 读取 `package.json` 里的
`pi.extensions` 清单并直接加载 `index.ts`，因此改动在 `/reload` 后生效：

```bash
pi install /absolute/path/to/pi-claude-cross-session
pi list                      # 应能看到该包
```

在 pi 会话内验证扩展已激活：会话启动会打印类似
`visible to Claude Code as "pi-<dir>-<hash>"` 的通知，让 agent 调用
`ListAgents` 则走通真实路径。每次改完代码，在 pi TUI 内运行 `/reload`
热加载扩展。

用 `-e ./index.ts` 做不写 settings 的一次性运行，用
`pi remove /absolute/path/to/pi-claude-cross-session` 卸载。

### 仓库自检

```bash
npm ci
npm run check   # biome + tsc + vitest（CI 在 Linux 和 macOS 上运行）
```

测试套件只使用测试自有的临时目录和假 socket；绝不触碰真实的
`~/.claude/sessions` 注册表、`/tmp/cc-socks` 或任何在线 peer。

## 发布说明

- npm tarball 通过 `files` 字段只发布 `index.ts`、`peer.ts` 和文档；pi 直接
  加载 TypeScript，因此没有构建步骤。
- pi 自带 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 和
  `typebox`；本包以 `"*"` 范围把它们声明为 `peerDependencies`，自身没有
  运行时依赖。
- pi 包画廊会为在 `pi` manifest 中声明了 `image`（或 `video`）字段的包显示
  预览；有了横幅素材后可以补上。

## 许可证

[MIT](LICENSE)
