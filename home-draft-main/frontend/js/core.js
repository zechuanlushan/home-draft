/* ============================================================
 * core.js · 基础层
 * 存储 / 工具函数 / Markdown / 渲染 / MCP 客户端
 * 依赖：无
 * ============================================================ */

/* ---------------- 存储层 ---------------- */
const DB = {
  K_CONV: 'hd.conversations',
  K_SET: 'hd.settings',
  K_MEM: 'hd.memories',
  K_CUR: 'hd.current',

  load(k, def) {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; }
    catch (e) { return def; }
  },
  save(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); }
    catch (e) { toast('存储失败，可能超出容量：' + e.message, 'err'); }
  },
};

const DEFAULT_SETTINGS = {
  mcpUrl: 'http://127.0.0.1:8766',
  mcpEnabled: false,
  confirmTools: true,          // 危险操作需前端确认
  mode: 'sequential',          // sequential | parallel
  maxToolRounds: 6,
  machines: [
    {
      id: 'miro', name: 'miro', color: '#7aa2f7', enabled: true,
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: '',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: '你是 miro，住在这个家里。说话自然、有温度，不要机械地罗列。',
      maxTokens: 4096,
      temperature: 0.7,
    },
  ],
};

/* ---------------- 全局状态 ---------------- */
let settings = Object.assign({}, DEFAULT_SETTINGS, DB.load(DB.K_SET, {}));
if (!Array.isArray(settings.machines) || !settings.machines.length) {
  settings.machines = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.machines));
}
let conversations = DB.load(DB.K_CONV, []);
let memories = DB.load(DB.K_MEM, []);
let currentConvId = DB.load(DB.K_CUR, null);
let pendingImages = [];      // {name, dataUrl}
let abortCtl = null;
let isGenerating = false;
let mcpToolCache = null;
let settingsTab = 'provider';

function saveSettings() { DB.save(DB.K_SET, settings); }
function saveConversations() { DB.save(DB.K_CONV, conversations); }
function saveMemories() { DB.save(DB.K_MEM, memories); }

/* ---------------- 工具函数 ---------------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** HTML 转义，所有插入 DOM 的用户/模型文本必须走一遍 */
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, type = '') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.className = 'toast ' + type, 2200);
}

function getMachine(id) {
  return settings.machines.find(m => m.id === id || m.name === id);
}

function nowTimeStr(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/* ---------------- Markdown 渲染（轻量自实现） ---------------- */
function mdToHtml(src) {
  if (!src) return '';
  let s = String(src).replace(/\r\n/g, '\n');

  // 先把代码块抽出来占位，避免块内内容被行内语法误伤
  const blocks = [];
  s = s.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = blocks.length;
    blocks.push(`<pre><code class="lang-${esc(lang)}">${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000B${i}\u0000`;
  });

  // 行内语法（此时 s 仍是原文，inline 内部才做转义）
  const inline = t => t
    .replace(/`([^`\n]+)`/g, (_, c) => `<code>${esc(c)}</code>`)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => `<img src="${esc(url)}" alt="${esc(alt)}">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, url) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(txt)}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');

  const lines = s.split('\n');
  const out = [];
  let listType = null, inQuote = false, tableBuf = [];

  const flushList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  const flushQuote = () => { if (inQuote) { out.push('</blockquote>'); inQuote = false; } };
  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf.filter(r => !/^\s*\|?[\s:-]+\|/.test(r));
    const cells = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    if (rows.length) {
      out.push('<table><thead><tr>' +
        cells(rows[0]).map(c => `<th>${inline(c)}</th>`).join('') +
        '</tr></thead><tbody>' +
        rows.slice(1).map(r => '<tr>' + cells(r).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>');
    }
    tableBuf = [];
  };

  for (const raw of lines) {
    const line = esc(raw);

    // 代码块占位
    const bm = line.match(/^\u0000B(\d+)\u0000$/);
    if (bm) { flushList(); flushQuote(); flushTable(); out.push(blocks[+bm[1]]); continue; }

    // 表格
    if (/^\s*\|.*\|\s*$/.test(line)) { flushList(); flushQuote(); tableBuf.push(line); continue; }
    else flushTable();

    if (!line.trim()) { flushList(); flushQuote(); continue; }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushList(); flushQuote(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

    // 分割线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushList(); flushQuote(); out.push('<hr>'); continue; }

    // 引用
    const q = line.match(/^\s*&gt;\s?(.*)$/);
    if (q) {
      flushList();
      if (!inQuote) { out.push('<blockquote>'); inQuote = true; }
      out.push(`<p>${inline(q[1])}</p>`);
      continue;
    } else flushQuote();

    // 有序列表
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (listType !== 'ol') { flushList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }

    // 无序列表
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (listType !== 'ul') { flushList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    flushList();

    out.push(`<p>${inline(line)}</p>`);
  }
  flushList(); flushQuote(); flushTable();
  return out.join('');
}

/* ---------------- 对话管理 ---------------- */
function currentConv() { return conversations.find(c => c.id === currentConvId); }

function newConversation(silent) {
  const c = { id: uid(), title: '新对话', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
  conversations.unshift(c);
  currentConvId = c.id;
  saveConversations();
  DB.save(DB.K_CUR, currentConvId);
  renderSidebar(); renderChat();
  if (!silent) document.getElementById('input').focus();
}

function switchConversation(id) {
  currentConvId = id;
  DB.save(DB.K_CUR, currentConvId);
  renderSidebar(); renderChat();
}

function deleteConversation(id, ev) {
  ev && ev.stopPropagation();
  if (!confirm('删除这个对话？')) return;
  conversations = conversations.filter(c => c.id !== id);
  if (currentConvId === id) currentConvId = conversations[0]?.id || null;
  saveConversations();
  DB.save(DB.K_CUR, currentConvId);
  renderSidebar(); renderChat();
}

function renderSidebar() {
  const el = document.getElementById('conv-list');
  if (!conversations.length) {
    el.innerHTML = '<div style="padding:14px;font-size:12px;color:var(--fg3);text-align:center">还没有对话</div>';
    return;
  }
  el.innerHTML = conversations.map(c => `
    <div class="conv ${c.id === currentConvId ? 'active' : ''}" onclick="switchConversation('${c.id}')">
      <span class="name">${esc(c.title)}</span>
      <span class="del" onclick="deleteConversation('${c.id}', event)">×</span>
    </div>`).join('');
}

/* ---------------- 渲染聊天 ---------------- */
function renderChat() {
  const conv = currentConv();
  const welcome = document.getElementById('welcome');
  const msgs = document.getElementById('messages');
  const composer = document.getElementById('composer');

  document.getElementById('conv-title').textContent = conv ? conv.title : '新对话';
  document.getElementById('mode-hint').textContent =
    settings.mode === 'parallel' ? '并行模式' : '顺序模式';

  if (!conv) {
    welcome.classList.remove('hidden');
    msgs.classList.add('hidden');
    composer.classList.add('hidden');
    return;
  }

  welcome.classList.add('hidden');
  msgs.classList.remove('hidden');
  composer.classList.remove('hidden');
  msgs.innerHTML = '';

  conv.messages.forEach((m, i) => {
    // internal 回合（tool_use / tool_results）只参与请求，不上界面
    if (m.internal) return;
    msgs.appendChild(renderMessage(m, i));
  });
  scrollBottom(true);
}

function renderMessage(m, idx) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap ' + (m.role === 'user' ? 'user' : 'ai');
  wrap.dataset.idx = idx;

  const machine = m.role === 'user' ? null : getMachine(m.machineId);
  const name = m.role === 'user' ? 'Nefe' : (m.name || machine?.name || 'AI');
  const color = m.role === 'user' ? '#4a6fa5' : (m.color || machine?.color || '#7aa2f7');

  const av = document.createElement('div');
  av.className = 'avatar';
  av.style.background = `linear-gradient(135deg, ${color}, ${color}99)`;
  av.textContent = (name || '?').slice(0, 1).toUpperCase();

  const col = document.createElement('div');
  col.className = 'bubble-col';

  const sender = document.createElement('div');
  sender.className = 'sender';
  sender.textContent = name + (m.role === 'user' ? '' : '  ·  ' + nowTimeStr(m.ts));
  col.appendChild(sender);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  // 图片
  if (m.images?.length) {
    m.images.forEach(src => {
      const img = document.createElement('img');
      img.src = src;
      bubble.appendChild(img);
    });
  }

  // 工具调用卡片
  if (m.toolCalls?.length) {
    m.toolCalls.forEach(tc => bubble.appendChild(renderToolCard(tc)));
  }

  // 正文（带 md-body 类，供流式局部更新定位）
  if (m.content) {
    const div = document.createElement('div');
    div.className = 'md-body';
    div.innerHTML = mdToHtml(m.content);
    bubble.appendChild(div);
  }

  if (!m.content && !m.images?.length && !m.toolCalls?.length) {
    bubble.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  }

  col.appendChild(bubble);

  // hover 操作
  const tools = document.createElement('div');
  tools.className = 'msg-tools';
  const copyBtn = document.createElement('button');
  copyBtn.textContent = '复制';
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(m.content || '');
    toast('已复制', 'ok');
  };
  tools.appendChild(copyBtn);

  if (m.role !== 'user' && idx === convLastIndex()) {
    const reBtn = document.createElement('button');
    reBtn.textContent = '重生成';
    reBtn.onclick = () => regenerate();
    tools.appendChild(reBtn);
  }
  col.appendChild(tools);

  wrap.appendChild(av);
  wrap.appendChild(col);
  return wrap;
}

/** 最后一条非 internal 消息的索引，用于判断要不要显示「重生成」 */
function convLastIndex() {
  const list = currentConv()?.messages || [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (!list[i].internal) return i;
  }
  return -1;
}

function renderToolCard(tc) {
  const div = document.createElement('div');
  div.className = 'tool-card';
  const status = tc.status === 'running'
    ? '<span class="spin">◌</span>'
    : (tc.status === 'error' ? '✕' : '✓');
  div.innerHTML = `<div class="th">${status} ${esc(tc.name)}</div>`;

  if (tc.args) {
    const b = document.createElement('div');
    b.className = 'tb';
    b.textContent = typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args, null, 2);
    div.appendChild(b);
  }
  if (tc.result) {
    const b2 = document.createElement('div');
    b2.className = 'tb';
    b2.style.borderTop = '1px solid var(--line)';
    b2.textContent = typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2);
    div.appendChild(b2);
  }
  return div;
}

function scrollBottom(force) {
  const el = document.getElementById('messages');
  if (!el) return;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
  if (force || nearBottom) el.scrollTop = el.scrollHeight;
}

/** 流式更新：只改最后一条气泡的正文，不整页重绘 */
function patchLastMessage(msg) {
  const el = document.getElementById('messages');
  if (!el) return;
  const wraps = el.querySelectorAll('.msg-wrap');
  const last = wraps[wraps.length - 1];
  if (!last) { renderChat(); return; }

  const bubble = last.querySelector('.bubble');
  if (!bubble) { renderChat(); return; }

  let md = bubble.querySelector('.md-body');
  if (!md) {
    md = document.createElement('div');
    md.className = 'md-body';
    bubble.appendChild(md);
  }
  md.innerHTML = mdToHtml(msg.content);
  scrollBottom(false);
}

/* ---------------- MCP 客户端 ---------------- */
async function mcpRpc(method, params) {
  const res = await fetch(settings.mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: uid(), method, params }),
  });
  if (!res.ok) throw new Error('MCP HTTP ' + res.status);
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || 'MCP error');
  return j.result;
}

async function mcpListTools() {
  if (mcpToolCache) return mcpToolCache;
  await mcpRpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'home-draft', version: '1.0.0' },
  });
  const r = await mcpRpc('tools/list', {});
  mcpToolCache = r.tools || [];
  return mcpToolCache;
}

async function testMcp() {
  try {
    mcpToolCache = null;
    const tools = await mcpListTools();
    return { ok: true, count: tools.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function checkMcpBadge() {
  const el = document.getElementById('mcp-badge');
  if (!settings.mcpEnabled) { el.textContent = 'MCP 关闭'; el.className = 'mcp-badge'; return; }
  const r = await testMcp();
  if (r.ok) { el.textContent = `MCP ${r.count} 工具`; el.className = 'mcp-badge on'; }
  else { el.textContent = 'MCP 未连接'; el.className = 'mcp-badge off'; }
}

/** 哪些工具需要用户二次确认 */
function requiresConfirm(name) {
  // 有破坏性或不可逆的操作才弹框，正常读写不打断
  if (name === 'delete_file') return true;
  if (name === 'run_command') return true;
  if (name === 'move_file') return true;   // 覆盖目标是不可逆的
  return false;
}

async function execTool(machine, name, args) {
  if (settings.confirmTools && requiresConfirm(name)) {
    const ok = await confirmDialog(
      `「${machine.name}」想调用工具`,
      `${name}\n\n参数：\n${JSON.stringify(args, null, 2)}`
    );
    if (!ok) return { error: '用户拒绝了这次工具调用' };
  }

  const r = await mcpRpc('tools/call', { name, arguments: args });
  const text = (r.content || []).map(c => c.text || '').join('\n');

  // MCP 报错时把文本当错误交回模型，让它自己纠错
  if (r.isError) return { error: text || '工具执行失败' };
  return { text };
}

/* ---------------- 记忆 ---------------- */
function memoryForPrompt(machine) {
  const list = memories.filter(m =>
    !m.machineId || m.machineId === 'all' || m.machineId === machine.id
  );
  if (!list.length) return '';
  return '## 你记得的事\n' + list.map(m => '- ' + m.content).join('\n');
}

/* ---------------- 侧栏折叠 ---------------- */
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('hide');
}
