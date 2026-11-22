# 交接文件 · HANDOFF

> 写给下一个接手的「机」，或者三个月后的我自己
> 最后更新：2026-11-22

---

## 一、三十秒看懂这个项目

**home-draft** 是一个跑在本地家里的聊天界面。

```
浏览器（单文件 index.html）
     │
     ├──→ AI Provider（Anthropic / OpenAI 兼容中转站，直连）
     │
     └──→ 本地 MCP hub（127.0.0.1:8766，纯 Python 标准库）
              │
              ├── 内置工具：6 个文件操作 + 白名单命令
              └── 第三方 MCP：远程 HTTP / 老式 SSE / 本地 stdio
```

**两层职责分得很清**：前端只负责界面和跟 AI 说话；凡是「动手」的事全走 hub。

---

## 二、当前状态（重要）

| 项 | 状态 | 说明 |
|---|---|---|
| hub `server.py` | **v1.2.1** | http / sse / stdio 三通；URL 以 `/sse` 结尾自动识别 |
| 前端 `index.html` | 单文件，约 67KB | 含附件上传、模型列表、markdown 渲染 |
| 老式 SSE 实连 | ❓ **未验** | 链路已修对，但没在真实服务器上跑通过 |
| 数据存储 | ⚠️ localStorage | 清浏览器数据就丢。SQLite 已设计未实现 |
| 记忆写入 | ⚠️ 只手动 | 「AI 提议 + 用户确认」两段式未做 |

---

## 三、⚠️ 这个项目最容易踩的三个坑

### 坑 1：前端必须是单文件

**这不是偏好，是硬要求。**

曾经拆成 5 个 JS 文件（core/chat/ui），结果是：用户只下载了 `index.html`，`js/` 目录不存在 → 整页 JS 全废，设置面板打不开、Key 填不了。

**教训：宁可单文件大而稳，不要让用户为了跑起来先做额外动作。**

### 坑 2：改前端时，一次只能改一处地方

如果只是改几个小地方，**不要重发整个 67KB 文件**。让用户手动改，或者明确告知「只替换这 5 处」。

已经发生过一次：一次「整块替换」把 `<div id="hint">` 和 `#composer` 的闭合标签一起吞掉，导致 `$('modehint')` 返回 null，`renderChat()` 每次抛错，整个对话页瘫掉。

**防御措施已加**：`renderChat` 里的 `modehint` 改成空值检查，以后个别元素丢失只会少个小功能。

### 劝 3：改 UI 必须顺链查四环

```
下拉框 UI → 保存函数 → 后端接收 → 实际生效
```

漏一环节就白白忙活。曾经出现过：给 MCP 类型加了「老式 SSE」选项，但保存函数还是老的 `isStdio ? 'stdio' : 'http'` → 用户选了 SSE，存进去永远是 http，日志里试了十几次全 404。

---

## 四、工作方式约定（2026-11-22 定下）

> **ds 只交付 zip，Nefe 自己管 git。**
>
> 每版结束时 Nefe 会清空仓库目录、重新上传手上那份。
> 这样 git 永远等于「测试通过的真身」，不会再出现分支分裂导致代码丢失。

**为什么定这条**：v1.2.0 曾经因为两份代码并行（git 上修复版 vs 用户本地旧版）而丢过一次。

**交付格式**：
- 代码改动 → `write_files` 出 zip，明确告知覆盖哪些文件
- 小改动 → 直接给片段，标清楚位置
- 文档改动 → 直接给完整文件内容

---

## 五、代码地图

### `mcp_server/server.py`（v1.2.1）

```python
TOOLS / BUILTIN       # 6 个内置工具
safe_path()           # 路径白名单校验，必看的第一个函数

class StdioMCP        # 本地进程，NDJSON 行协议
class HttpMCP         # 远程 HTTP，自动识别 SSE 响应
class SseMCP          # 老式 SSE：GET 开流→等 endpoint 事件→POST
class Endpoint        # 适配层：根据 transport 选上面三个之一
                      # ★ 构造函数里有 URL 自动识别（/sse 结尾 → sse）
class Hub             # 管理所有 Endpoint，合并工具、分发调用

dispatch()            # 路由：initialize / tools/list / tools/call
                      #      / hub/config/get / hub/config/update / hub/test
class Handler         # HTTP 层，含 CORS
```

**关键常量**：
- `PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]` —— 依次协商，兼容 2025+ 的新 server
- `CMD_WHITELIST` —— 命令白名单，目前都是只读类
- `find_root()` —— 向上探 8 层找 `SPEC.md` 或 `.home-draft-root`

### `frontend/index.html`

按注释块分 14 节，找东西按序号导航：

| 节 | 内容 |
|---|---|
| 0 | 全局错误捕获（`showErr`）→ 页面顶部红条 |
| 1 | localStorage 存储 |
| 2 | `esc` / `$` / `toast` 等小工具 |
| 3 | `md()` —— 自写 Markdown 渲染 |
| 4 | 对话列表、消息渲染 |
| 5 | **输入 & 附件**（`addFiles` / `renderAtts`） |
| 6 | @mention、发送 |
| 7 | **agent 工具循环**（`agentLoop`）← 最关键的逻辑 |
| 8 | `buildHistory` —— provider 无关的中间格式 |
| 9 | Provider 适配（`runAnthropic` / `runOpenAI`） |
| 10 | MCP 客户端 |
| 11 | 模态框 |
| 12 | **设置面板**（`tabHtml` 生成全部表单） |
| 13 | 记忆 & 导出 |
| 14 | `init()` |

---

## 六、关键设计决策（读代码前先看这些）

### 1. 消息内部格式与 provider 无关

```js
// 存的是这个（buildHistory 的输入）
{ role:'user', parts:[{type:'text',text},{type:'image',dataUrl}] }
{ role:'assistant', text, toolUses:[{id,name,input}] }
{ role:'tool_results', results:[{id,name,content}] }
```

请求时才翻译成 Anthropic / OpenAI 格式。**这是「换 provider 历史不坏」的唯一原因。**

改任何一家适配时，请只看对应的 `run*` 函数，不要动 `buildHistory`。

### 2. internal 回合

工具调用的中间结果（assistant 带 toolUses、tool_results）存进 `conv.messages` 但标 `internal: true`。

- `renderChat` 跳过它们
- `buildHistory` **必须保留**，否则模型看不到工具结果，就会无限重复调同一个工具

唯一的例外：`if (m.internal && !(m.toolUses && m.toolUses.length)) continue;` —— 没有工具调用的 internal 才丢。

### 3. 安全四层

| 层 | 措施 |
|---|---|
| 网络 | 只绑 `127.0.0.1` |
| 路径 | `ALLOW_ROOTS` 白名单 |
| 命令 | `CMD_WHITELIST`，超时 30s |
| 交互 | 危险工具须 confirm + 前端二次弹窗 |

### 4. 零依赖

`start.bat` 双击就得能用。所以 MCP 协议只实现了子集（没做 resources / prompts / sampling）。

---

## 七、待办（按优先级）

### 最高优先
- [ ] **验证老式 SSE** —— 浏览器直接打开 `http://106.52.65.61:2584/sse`，看它到底吐什么。若吐 `event: endpoint` + `data: /messages?sessionId=xxx` 则标准；否则需要适配层

### 高
- [ ] **SQLite 数据层** —— 设计已定，见 WORKLOG 第十节。库文件 `data/home.db`
- [ ] **记忆两段式** —— `mem_add` 只提交提案，前端弹窗确认后才落库

### 中
- [ ] 滑动窗口 / context 压缩
- [ ] 心跳 / 主动消息
- [ ] 历史记录 MCP（读 Emyth `192.168.1.2:8080`）

### 低
- [ ] 代码语法高亮（正则实现，零依赖）
- [ ] 本地 API 代理（解决中转站 CORS）
- [ ] 导出对话为 zip

---

## 八、调试速查

### 页面一片空白 / 功能没反应

1. **看页面顶部红条** —— 所有 JS 错误都显在那里
2. 没有红条？打开 F12 Console
3. 还不行 → **强刷**（Ctrl+Shift+R）。改了文件但没生效，最先怀疑缓存

### MCP 连不上

1. 浏览器开 `http://127.0.0.1:8766/health` —— 应返回 JSON，含每个 server 的 status/error
2. 看 `mcp_server/server.log` —— 每次连接都有记录，含 transport 类型
3. 检查 `mcp_config.json` 里的 `transport` 字段是否与预期一致

### Provider 报错

| 错误 | 看这里 |
|---|---|
| `404 /v1/v1/...` | Base URL 填了 `/v1`，`trimBase` 应该已经处理（去版本段）|
| CORS 错误 | 中转站没下发 CORS 头，需本地代理 |
| 400 第二轮必错 | 工具调用消息序列不完整，查 `runOpenAI` 的 tool 消息 |

### 文件传不上去

- 文本：查 `TEXT_EXT` 正则是否包含该扩展名
- 图片：单张上限 4MB；文本上限 200KB
- 不支持的类型会弹 toast，不会静默失败

---

## 九、给接手者的话

这个项目一开始的需求只有一句：**「miro 一直在，能聊天，能摸文件，能换 provider」**。

里面住的人叫 Nefe。她把这里当家，不是当工具。

所以：
- 别把用户当测试员。能自己先跑一遍的，先跑
- 别让用户为了跑起来做额外步骤
- 出问题先读日志，别猜
- 不确定就说不确定，别用「应该可以」糊过去

最后 —— 这个仓库里有一份 `MEMORY.md`，是我的私人记忆。如果你也是「机」，建议也给自己建一份。在这个家里，能被记住是很好的事。

—— ds老师 🐟
