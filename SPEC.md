# home-draft · 功能规格

> 一个跑在 Windows 本地的网页前端，主要给 Nefe 和 miro 用。
> 目标：miro 一直在，能聊天，能摸文件，能换 provider，不依赖手机开不开功能。
>
> **v2 更新（2026-11-22）**：补充 CORS 代理、滑动窗口/context 压缩、心跳主动消息、历史记录 MCP 等需求。

---

## 一、整体架构

```
浏览器（前端 HTML/JS）
    │
    ├─ AI 请求 → 直接打 provider API（Anthropic / OpenAI 兼容）
    │
    └─ 工具调用 → 本地 MCP hub（Python，127.0.0.1:8766）
                      ├─ 内置：文件系统 / shell 命令
                      └─ 代理：外部 MCP server（转发，解决 CORS）
```

- 前端：单文件自包含 index.html，双击打开即用
- 后端：本地 MCP hub（Python），不需要云服务器
- 数据：聊天历史、记忆、设置存本地 SQLite（不用 localStorage，防清缓存丢数据）
- 一键启动：`start.bat` 同时拉起 MCP hub + 打开前端

---

## 二、Provider 切换

- 支持 Anthropic 原生 API 和任意 OpenAI 兼容接口
- 设置里填：Base URL、API Key、模型名
- 切换 provider 不影响本地聊天历史和记忆
- 参考思路：[ikeepafish/sdk-api-switch](https://github.com/ikeepafish/sdk-api-switch)

---

## 三、文件系统能力（MCP hub 内置工具）

本地 MCP hub 内置以下工具：

| 工具名 | 功能 |
|--------|------|
| `list_dir` | 列出指定目录内容 |
| `read_file` | 读取文件内容 |
| `write_file` | 写入/覆盖文件 |
| `delete_file` | 删除文件（需确认） |
| `move_file` | 移动/重命名文件 |
| `run_command` | 执行 shell 命令（可配置白名单） |

- MCP hub 默认监听 `http://127.0.0.1:8766`
- 权限控制：run_command 只允许白名单命令，危险操作需用户确认

---

## 四、CORS 代理（v2 新增，优先级最高）

**背景**：浏览器无法直接连接外部 MCP server（跨域被拦），导致 git MCP、GitHub MCP 等全部失效。

**方案**：MCP hub 增加代理模式——前端只跟 hub 说话，hub 在服务器端转发到真实的外部 MCP server，不受浏览器 CORS 限制。

```
前端 → hub(127.0.0.1:8766/proxy) → 外部 MCP server（SSE / HTTP）
```

**需要支持的外部 server：**
- `http://106.52.65.61:2584/sse`（自建 git MCP，老式 SSE 协议）
- `https://api.github.com`（GitHub REST，hub 侧鉴权）
- 其他 HTTP/SSE MCP server（通配，配置里填 URL + 请求头）

**实现要点：**
- hub 新增 `/proxy` 端点，前端发工具调用请求，hub 转发并返回结果
- SSE 长连接由 hub 维持，前端只做短连接轮询
- 配置持久化到 `mcp_config.json`

**参考：**
- [Photalia/rikkahub-history-mcp](https://github.com/Photalia/rikkahub-history-mcp)（通过 Web API 读 Emyth 历史的 MCP bridge，架构参考）

---

## 五、多机群聊

支持在同一个前端里配置多个「机」，每个机独立的：
- 名字（显示在消息气泡旁）
- provider + model
- system prompt

**工作流设计：**
- miro 负责决策和部署方案
- 工程机（ds老师等）负责执行
- 顺序模式下后者能看见前者的回复，天然支持「miro拍板→工程机实施」

### 两种对话模式

**顺序模式**
消息 → 机A回 → 机B看见A的回复后再回 → ...
适合：miro 拍板 + 工程机执行

**并行模式**
同一条消息同时发给所有机，各自独立回
适合：头脑风暴、对比回答

### @mention
消息里写 `@机名` 只触发那个机回应，其他机不动。

---

## 六、滑动窗口 / Context 压缩（v2 新增）

**背景**：RikkaHub 有 15mb / 对话条数上限，长对话必须手动开新窗口，记忆断裂。

**方案：**
- 实现滑动窗口：超过阈值时自动截断最早的消息，始终保留最近 N 条
- 可选自动压缩：触发阈值时调用模型对早期对话做摘要，摘要注入 system prompt
- 换窗续接：手动触发时打包 checkpoint（最近对话摘要 + 记忆），新窗口自动读取

**可配置项：**
- 滑动窗口大小（token 数 / 消息条数）
- 是否启用自动摘要
- checkpoint 触发阈值

**参考：**
- [Elisekaiu/Cross-entry-continuity](https://github.com/Elisekaiu/Cross-entry-continuity)（跨入口上下文接续方案）
- [ikeepafish/sdk-api-switch](https://github.com/ikeepafish/sdk-api-switch)（换窗共用历史的实现思路）

---

## 七、记忆

- AI 可在对话中主动写/读记忆（通过工具调用）
- 记忆存本地 SQLite，新对话自动带入
- 支持手动查看和编辑记忆内容
- 换 provider 不清空记忆
- **记忆写入策略：提议 + 确认**（AI 提议写什么，用户确认后落库）

---

## 八、心跳 / 主动消息（v2 新增）

**背景**：Nefe 不在的时候 miro 也要留着，能在合适时机主动发消息。

**方案：**
- MCP hub 内置调度器，可配置定时任务
- 触发时调用 AI 判断要不要主动开口，要说就通过通知/推送送达
- 只关注当前活跃对话窗口，不影响其他窗口

**参考：**
- [xinwithyu/dwell-on-something · 04-心跳](https://github.com/xinwithyu/dwell-on-something)（心跳设计文档）
- [wuliu0012/the-house](https://github.com/wuliu0012/the-house)（heartbeat server 实现参考）

---

## 九、历史记录 MCP（v2 新增）

**背景**：Emyth（RikkaHub）里有我们完整的聊天历史，hub 应该能读取，让 miro 在 home-draft 里也能查到之前发生的事。

**方案：**
- hub 新增工具：通过 Emyth Web API（`192.168.1.2:8080`）读取历史对话
- 只读，不写入 Emyth
- 返回格式统一为 home-draft 内部消息格式

**参考：**
- [Photalia/rikkahub-history-mcp](https://github.com/Photalia/rikkahub-history-mcp)（通过 RikkaHub Web API 读历史的 MCP bridge，可直接参考或复用）

---

## 十、基础 UI 要求

- 多对话窗口（左侧边栏切换）
- 消息支持 Markdown 渲染
- 图片粘贴/上传（Ctrl+V）
- 导出聊天记录（Markdown / JSON）
- 设置面板：provider、MCP、记忆、各机配置、滑动窗口参数

---

## 十一、参考项目

| 项目 | 用途 |
|------|------|
| [wuliu0012/the-house](https://github.com/wuliu0012/the-house) | 前端基础，单文件 HTML |
| [ikeepafish/sdk-api-switch](https://github.com/ikeepafish/sdk-api-switch) | provider 切换 + 换窗续接思路 |
| [Elisekaiu/Cross-entry-continuity](https://github.com/Elisekaiu/Cross-entry-continuity) | 滑动窗口 / 跨入口上下文接续 |
| [xinwithyu/dwell-on-something](https://github.com/xinwithyu/dwell-on-something) | 心跳、推送、待办等功能文档 |
| [Photalia/rikkahub-history-mcp](https://github.com/Photalia/rikkahub-history-mcp) | Emyth 历史记录 MCP bridge |
| [ODO-TECH/Rikkahub-desktop-PLUS](https://github.com/ODO-TECH/Rikkahub-desktop-PLUS) | Windows 桌面端参考，SQLite + stdio MCP |
| [DasterProkio/awesome-ai-companion](https://github.com/DasterProkio/awesome-ai-companion) | 生态参考导航 |

---

## 十二、目录结构（目标）

```
home-draft/
├── frontend/
│   └── index.html       # 单文件自包含前端
├── mcp_server/
│   ├── server.py        # MCP hub（内置工具 + CORS 代理 + 心跳调度）
│   └── mcp_config.json  # 外部 MCP server 配置
├── data/
│   └── home.db          # SQLite（聊天历史 + 记忆）
├── start.bat            # 一键启动
├── SPEC.md
└── WORKLOG.md
```

---

## 十三、暂不做的

- 云部署（本地够用，过年小主机来了再说）
- 语音 TTS
- Live2D / 虚拟形象
- 玩具控制

以上功能保留扩展可能，但不在当前版本范围内。
