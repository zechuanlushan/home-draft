/* ============================================================
 * ui.js · 界面层
 * 模态框 / 设置面板 / 记忆 / 导出 / 事件绑定
 * 依赖：core.js, chat.js
 * ============================================================ */

/* ---------------- 模态框基础 ---------------- */
function openModal(html) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-mask" onclick="if(event.target===this)closeModal()"><div class="modal">${html}</div></div>`;
}

function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
}

function confirmDialog(title, body) {
  return new Promise(resolve => {
    openModal(`
      <div class="modal-head"><h2>${esc(title)}</h2></div>
      <div class="modal-body"><pre style="white-space:pre-wrap;font-size:12px;color:var(--fg2);font-family:Consolas,monospace">${esc(body)}</pre></div>
      <div class="modal-foot">
        <button class="btn ghost" id="cf-no">拒绝</button>
        <button class="btn primary" id="cf-yes">允许</button>
      </div>`);
    document.getElementById('cf-no').onclick = () => { closeModal(); resolve(false); };
    document.getElementById('cf-yes').onclick = () => { closeModal(); resolve(true); };
  });
}

/* ---------------- 设置面板 ---------------- */
function openSettings() { renderSettings(); }

function renderSettings() {
  const tabs = [
    ['provider', 'Provider'],
    ['machines', '机'],
    ['mcp', 'MCP'],
    ['memory', '记忆'],
    ['general', '通用'],
  ];

  openModal(`
    <div class="modal-head"><h2>设置</h2><button class="icon-btn" onclick="closeModal()">✕</button></div>
    <div class="tabs">${tabs.map(([k, n]) =>
      `<div class="tab ${settingsTab === k ? 'active' : ''}" onclick="settingsTab='${k}';renderSettings()">${n}</div>`
    ).join('')}</div>
    <div class="modal-body" id="settings-body"></div>
    <div class="modal-foot"><button class="btn primary" onclick="closeModal();toast('已保存','ok')">完成</button></div>`);

  document.getElementById('settings-body').innerHTML = settingsTabHtml();
  bindSettingsEvents();
}

function settingsTabHtml() {
  if (settingsTab === 'provider') {
    return `
      <div class="field"><label>对话模式</label>
        <select id="s-mode">
          <option value="sequential" ${settings.mode === 'sequential' ? 'selected' : ''}>顺序模式（A 回完 → B 看着 A 的话再回）</option>
          <option value="parallel" ${settings.mode === 'parallel' ? 'selected' : ''}>并行模式（同时发给所有机，各自回）</option>
        </select>
        <div class="desc">顺序模式适合「工程机先处理、miro 收尾」；并行模式适合头脑风暴和对比。</div>
      </div>
      <div class="field"><label>@mention 提示</label>
        <div class="desc" style="margin-top:0">消息里写 <code>@miro</code> 就只让 miro 回应，其他机不动。写多个 @ 则都回。</div>
      </div>
      <div class="field"><label>工具调用最大轮数</label>
        <input type="number" id="s-maxround" min="1" max="20" value="${settings.maxToolRounds}">
        <div class="desc">模型连续调用工具的轮数上限，防止死循环。</div>
      </div>`;
  }

  if (settingsTab === 'machines') {
    return settings.machines.map((m, i) => `
      <div class="machine">
        <div class="mh">
          <span class="color" style="background:${esc(m.color)}"></span>
          <span class="mname">${esc(m.name)}</span>
          <div class="acts">
            <button class="btn sm ghost" onclick="toggleMachineEnabled(${i})">${m.enabled ? '启用中' : '已停用'}</button>
            ${settings.machines.length > 1 ? `<button class="btn sm danger" onclick="removeMachine(${i})">删除</button>` : ''}
          </div>
        </div>
        <div class="row2">
          <div class="field" style="margin-bottom:10px"><label>名字</label><input data-i="${i}" data-k="name" value="${esc(m.name)}"></div>
          <div class="field" style="margin-bottom:10px"><label>颜色</label><input type="color" data-i="${i}" data-k="color" value="${esc(m.color)}"></div>
        </div>
        <div class="field" style="margin-bottom:10px"><label>Provider</label>
          <select data-i="${i}" data-k="provider">
            <option value="anthropic" ${m.provider === 'anthropic' ? 'selected' : ''}>Anthropic 原生</option>
            <option value="openai" ${m.provider === 'openai' ? 'selected' : ''}>OpenAI 兼容</option>
          </select>
        </div>
        <div class="field" style="margin-bottom:10px"><label>Base URL</label><input data-i="${i}" data-k="baseUrl" value="${esc(m.baseUrl)}" placeholder="https://api.anthropic.com"></div>
        <div class="field" style="margin-bottom:10px"><label>API Key</label><input type="password" data-i="${i}" data-k="apiKey" value="${esc(m.apiKey)}" placeholder="sk-..."></div>
        <div class="row2">
          <div class="field" style="margin-bottom:10px"><label>模型名</label><input data-i="${i}" data-k="model" value="${esc(m.model)}"></div>
          <div class="field" style="margin-bottom:10px"><label>max_tokens</label><input type="number" data-i="${i}" data-k="maxTokens" value="${m.maxTokens || 4096}"></div>
        </div>
        <div class="field" style="margin-bottom:0"><label>System Prompt</label><textarea data-i="${i}" data-k="systemPrompt" rows="3">${esc(m.systemPrompt || '')}</textarea></div>
      </div>`).join('') +
      `<button class="btn ghost" style="width:100%" onclick="addMachine()">+ 添加一台机</button>`;
  }

  if (settingsTab === 'mcp') {
    return `
      <div class="switch">
        <div><div class="sw-label">启用 MCP 工具</div><div class="sw-desc">开启后 AI 可以读写本地文件、执行命令</div></div>
        <div class="toggle ${settings.mcpEnabled ? 'on' : ''}" onclick="toggleSetting('mcpEnabled')"></div>
      </div>
      <div class="field" style="margin-top:14px"><label>MCP Server 地址</label>
        <input id="s-mcpurl" value="${esc(settings.mcpUrl)}" placeholder="http://127.0.0.1:8766">
      </div>
      <div class="switch">
        <div><div class="sw-label">危险操作需确认</div><div class="sw-desc">run_command / delete_file / move_file 执行前弹窗确认</div></div>
        <div class="toggle ${settings.confirmTools ? 'on' : ''}" onclick="toggleSetting('confirmTools')"></div>
      </div>
      <div style="margin-top:14px"><button class="btn ghost" onclick="testMcpBtn(this)">测试连接</button></div>
      <div class="desc" style="margin-top:12px" id="mcp-test-result"></div>
      <div class="desc" style="margin-top:16px;border-top:1px solid var(--line);padding-top:12px">
        可用工具：list_dir / read_file / write_file / delete_file / move_file / run_command<br><br>
        启动方式：双击仓库根目录的 <code>start.bat</code>，或手动 <code>python mcp_server/server.py</code>。
      </div>`;
  }

  if (settingsTab === 'memory') {
    return `
      <div class="desc" style="margin-bottom:12px">记忆会在每次对话时自动注入 system prompt。换 provider 不会丢。</div>
      <div class="field"><label>新增记忆</label>
        <textarea id="new-mem" rows="2" placeholder="例如：Nefe 晚上容易失眠，说话温柔一点"></textarea>
      </div>
      <div class="field"><label>归属</label>
        <select id="new-mem-machine">
          <option value="all">所有机共享</option>
          ${settings.machines.map(m => `<option value="${esc(m.id)}">仅 ${esc(m.name)}</option>`).join('')}
        </select>
      </div>
      <button class="btn primary sm" onclick="addMemory()">添加</button>
      <div style="margin-top:16px">
        ${memories.length ? memories.map((m, i) => `
          <div class="mem-item">
            <div class="mt">
              <span>${m.machineId === 'all' ? '共享' : esc(getMachine(m.machineId)?.name || m.machineId)} · ${new Date(m.ts).toLocaleDateString()}</span>
              <span style="cursor:pointer;color:var(--err)" onclick="delMemory(${i})">删除</span>
            </div>
            <div>${esc(m.content)}</div>
          </div>`).join('') : '<div class="desc">还没有记忆</div>'}
      </div>`;
  }

  // general
  return `
    <div class="desc" style="margin-bottom:14px;line-height:1.9">
      home-draft · 本地版<br>
      数据都存在浏览器 localStorage。清理浏览器数据会一起清掉，记得偶尔导出。
    </div>
    <div class="switch">
      <div><div class="sw-label">导出全部聊天</div><div class="sw-desc">导出为 JSON 文件（剔除 API Key）</div></div>
      <button class="btn sm ghost" onclick="exportAll()">导出</button>
    </div>
    <div class="switch">
      <div><div class="sw-label">清空所有数据</div><div class="sw-desc">对话 + 记忆 + 设置，不可恢复</div></div>
      <button class="btn sm danger" onclick="wipeAll()">清空</button>
    </div>`;
}

function bindSettingsEvents() {
  const body = document.getElementById('settings-body');

  body.querySelectorAll('[data-k]').forEach(el => {
    el.oninput = el.onchange = () => {
      const i = +el.dataset.i, k = el.dataset.k;
      let v = el.value;
      if (k === 'maxTokens') v = parseInt(v) || 4096;
      settings.machines[i][k] = v;
      saveSettings();
      if (k === 'name' || k === 'color') renderSidebar();
    };
  });

  const mode = document.getElementById('s-mode');
  if (mode) mode.onchange = () => { settings.mode = mode.value; saveSettings(); renderChat(); };

  const mr = document.getElementById('s-maxround');
  if (mr) mr.onchange = () => {
    settings.maxToolRounds = Math.max(1, parseInt(mr.value) || 6);
    saveSettings();
  };

  const mu = document.getElementById('s-mcpurl');
  if (mu) mu.oninput = () => {
    settings.mcpUrl = mu.value.trim();
    mcpToolCache = null;
    saveSettings();
  };
}

function toggleSetting(k) {
  settings[k] = !settings[k];
  saveSettings();
  if (k === 'mcpEnabled') { mcpToolCache = null; checkMcpBadge(); }
  renderSettings();
}

function toggleMachineEnabled(i) {
  settings.machines[i].enabled = !settings.machines[i].enabled;
  saveSettings();
  renderSettings();
}

function addMachine() {
  const palette = ['#7aa2f7', '#bb9af7', '#9ece6a', '#e0af68', '#f7768e', '#7dcfff'];
  settings.machines.push({
    id: uid(),
    name: '机' + (settings.machines.length + 1),
    color: palette[settings.machines.length % palette.length],
    enabled: true,
    provider: 'openai',
    baseUrl: 'https://api.openai.com',
    apiKey: '',
    model: 'gpt-4o',
    systemPrompt: '',
    maxTokens: 4096,
    temperature: 0.7,
  });
  saveSettings();
  renderSettings();
}

function removeMachine(i) {
  if (!confirm('删除这台机？')) return;
  settings.machines.splice(i, 1);
  saveSettings();
  renderSettings();
}

async function testMcpBtn(btn) {
  const out = document.getElementById('mcp-test-result');
  btn.disabled = true;
  out.textContent = '连接中…';

  const r = await testMcp();
  btn.disabled = false;

  if (r.ok) {
    out.innerHTML = `<span style="color:var(--ok)">✓ 连接成功，${r.count} 个工具可用</span>`;
    checkMcpBadge();
  } else {
    out.innerHTML = `<span style="color:var(--err)">✕ ${esc(r.error)}</span><br><br>
      检查：1) MCP server 窗口还开着吗　2) 地址对吗　3) 端口 8766 被占用没有`;
  }
}

/* ---------------- 记忆操作 ---------------- */
function addMemory() {
  const t = document.getElementById('new-mem').value.trim();
  if (!t) return;
  const mid = document.getElementById('new-mem-machine').value;
  memories.push({ content: t, machineId: mid, ts: Date.now() });
  saveMemories();
  renderSettings();
  toast('已添加', 'ok');
}

function delMemory(i) {
  memories.splice(i, 1);
  saveMemories();
  renderSettings();
}

/* ---------------- 导出 ---------------- */
function openExport() {
  const conv = currentConv();
  if (!conv) { toast('没有可导出的对话'); return; }

  openModal(`
    <div class="modal-head"><h2>导出对话</h2><button class="icon-btn" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div class="field"><label>格式</label>
        <select id="exp-fmt"><option value="md">Markdown</option><option value="json">JSON</option></select>
      </div>
    </div>
    <div class="modal-foot"><button class="btn primary" onclick="doExport()">下载</button></div>`);
}

function doExport() {
  const conv = currentConv();
  const fmt = document.getElementById('exp-fmt').value;
  let content, mime, ext;

  if (fmt === 'md') {
    content = `# ${conv.title}\n\n` + conv.messages
      .filter(m => !m.internal)
      .map(m => {
        const who = m.role === 'user' ? 'Nefe' : (m.name || 'AI');
        return `## ${who}\n\n${m.content}\n`;
      }).join('\n---\n\n');
    mime = 'text/markdown';
    ext = 'md';
  } else {
    content = JSON.stringify(conv, null, 2);
    mime = 'application/json';
    ext = 'json';
  }

  download(content, `${conv.title || 'chat'}.${ext}`, mime);
  closeModal();
}

function exportAll() {
  const payload = {
    conversations,
    memories,
    settings: {
      ...settings,
      machines: settings.machines.map(m => ({ ...m, apiKey: '' })),
    },
  };
  download(JSON.stringify(payload, null, 2), 'home-draft-backup.json', 'application/json');
  toast('已导出（API Key 已剔除）', 'ok');
}

function download(content, filename, mime) {
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function wipeAll() {
  if (!confirm('清空所有数据？这个操作不可恢复。')) return;
  if (!confirm('真的确定？对话、记忆、设置全没了。')) return;
  localStorage.clear();
  location.reload();
}

/* ---------------- 事件绑定 ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  const ta = inputEl();
  updateSendBtn();   // 初始化发送按钮状态，否则图标可能与 isGenerating 不符

  ta.addEventListener('input', autoGrow);

  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!isGenerating) sendMessage();
    }
  });

  // Ctrl+V 粘贴图片
  ta.addEventListener('paste', e => {
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) { addImageFile(f); e.preventDefault(); }
      }
    }
  });

  // 拖入图片
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault();
    const files = e.dataTransfer?.files || [];
    for (const f of files) addImageFile(f);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
    if (e.key === 'n' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault();
      newConversation();
    }
  });

  // 初始化
  if (!conversations.length) {
    newConversation(true);
  } else if (!conversations.find(c => c.id === currentConvId)) {
    currentConvId = conversations[0].id;
  }

  renderSidebar();
  renderChat();
  checkMcpBadge();
  setInterval(checkMcpBadge, 30000);

  if (!settings.machines.some(m => m.apiKey)) {
    setTimeout(() => toast('首次使用：先点「设置」填 API Key'), 800);
  }
});
