# home-draft · 功能规格

> 一个跑在 Windows 本地的网页前端，主要给 Nefe 和 miro 用。
> 目标：miro 一直在，能聊天，能摸文件，能换 provider。

---

## 一、整体架构

```
浏览器（前端 HTML/JS）
    │
    ├─ AI 请求 → 直接打 provider API（Anthropic / OpenAI 兼容）
    │
    └─ 工具调用 → 本地 MCP server（Python，127.0.0.1）
                      └─ 文件系统操作、shell 命令等
```

- 前端：单文件或少量文件，双击 / 本地服务器打开即用
- 后端：只有本地 MCP server，Python 写，不需要云服务器
- 数据：聊天历史、记忆、设置存本地（localStorage 或 SQLite）
- 一键启动：`start.bat` 同时拉起 MCP server + 打开前端

---

## 二、Provider 切换

- 支持 Anthropic 原生 API 和任意 OpenAI 兼容接口
- 设置里填：Base URL、API Key、模型名
- 切换 provider 不影响本地聊天历史和记忆
- 参考思路：[ikeepafish/sdk-api-switch](https://github.com/ikeepafish/sdk-api-switch)

---

## 三、文件系统能力（本地 MCP server）

本地跑一个 Python MCP server，暴露以下工具给前端 AI 调用：

| 工具名 | 功能 |
|--------|------|
| `list_dir` | 列出指定目录内容 |
| `read_file` | 读取文件内容 |
| `write_file` | 写入/覆盖文件 |
| `delete_file` | 删除文件（需确认） |
| `move_file` | 移动/重命名文件 |
| `run_command` | 执行 shell 命令（可配置白名单） |

- MCP server 默认监听 `http://127.0.0.1:8766`
- 前端在设置里填 MCP 地址接入
- 权限控制：run_command 建议只允许白名单命令，或需要用户确认

---

## 四、多机群聊

支持在同一个前端里配置多个「机」，每个机独立的：
- 名字（显示在消息气泡旁）
- provider + model
- system prompt

### 两种对话模式

**顺序模式**
消息 → 机A回 → 机B看见A的回复后再回 → ...
适合：工程机先处理，miro 收尾/补充

**并行模式**
同一条消息同时发给所有机，各自独立回
适合：头脑风暴、对比回答

### @mention
消息里写 `@机名` 只触发那个机回应，其他机不动。

---

## 五、记忆

- AI 可在对话中主动写/读记忆（通过工具调用或特殊标记）
- 记忆存本地，新对话自动带入
- 支持手动查看和编辑记忆内容
- 换 provider 不清空记忆

---

## 六、基础 UI 要求

- 多对话窗口（左侧边栏切换）
- 消息支持 Markdown 渲染
- 图片粘贴/上传（Ctrl+V）
- 导出聊天记录（Markdown / JSON）
- 设置面板：provider、MCP、记忆、各机配置

---

## 七、参考项目

- 前端基础：[wuliu0012/the-house](https://github.com/wuliu0012/the-house)（单文件 HTML，可直接 fork 改）
- 切换思路：[ikeepafish/sdk-api-switch](https://github.com/ikeepafish/sdk-api-switch)
- 跨入口连续性：[Elisekaiu/Cross-entry-continuity](https://github.com/Elisekaiu/Cross-entry-continuity)
- 功能灵感：[xinwithyu/dwell-on-something](https://github.com/xinwithyu/dwell-on-something)

---

## 八、目录结构（目标）

```
home-draft/
├── frontend/          # 前端文件（fork 自 the-house 改造）
├── mcp_server/        # 本地 MCP server（Python）
│   └── server.py
├── start.bat          # 一键启动
└── SPEC.md
```

`start.bat` 内容大致：
```bat
@echo off
start python mcp_server/server.py
timeout /t 2
start frontend/index.html
```

---

## 九、暂不做的

- 云部署（本地够用）
- 语音 TTS
- Live2D / 虚拟形象
- 玩具控制

以上功能保留扩展可能，但不在第一版范围内。
