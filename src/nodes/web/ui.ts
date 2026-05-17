/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const signal = args && args.signal;
let port = (args && args.port) || 3002;
const apiPort = (args && args.apiPort) || 3001;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>holoiconic</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace; display: flex; height: 100vh; }
  #chat-panel { flex: 1; display: flex; flex-direction: column; border-right: 1px solid #21262d; }
  #graph-panel { width: 400px; display: flex; flex-direction: column; }
  .panel-header { padding: 12px 16px; border-bottom: 1px solid #21262d; font-weight: 600; font-size: 14px; color: #58a6ff; display: flex; justify-content: space-between; align-items: center; }
  .panel-header button { background: #238636; color: #fff; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .panel-header button:hover { background: #2ea043; }
  #messages { flex: 1; overflow-y: auto; padding: 16px; }
  .msg { margin-bottom: 12px; padding: 8px 12px; border-radius: 6px; white-space: pre-wrap; word-wrap: break-word; font-size: 14px; line-height: 1.5; }
  .msg.user { background: #1f2937; color: #e5e7eb; }
  .msg.assistant { background: #161b22; color: #c9d1d9; border-left: 3px solid #58a6ff; }
  .msg .role { font-size: 11px; text-transform: uppercase; color: #8b949e; margin-bottom: 4px; }
  .tool-calls { margin-top: 8px; }
  .tool-call { background: #1c1f26; border: 1px solid #30363d; border-radius: 4px; margin-bottom: 6px; font-size: 12px; }
  .tool-call-header { padding: 6px 10px; cursor: pointer; color: #d2a8ff; display: flex; justify-content: space-between; align-items: center; }
  .tool-call-header:hover { background: #21262d; }
  .tool-call-body { display: none; padding: 6px 10px; border-top: 1px solid #30363d; color: #8b949e; font-family: monospace; white-space: pre-wrap; max-height: 200px; overflow-y: auto; }
  .tool-call-body.open { display: block; }
  .tool-call-label { font-weight: 600; color: #d2a8ff; }
  .tool-call-toggle { font-size: 10px; color: #8b949e; }
  #input-row { display: flex; padding: 12px 16px; border-top: 1px solid #21262d; gap: 8px; }
  #input { flex: 1; background: #161b22; border: 1px solid #30363d; color: #c9d1d9; padding: 8px 12px; border-radius: 6px; font-size: 14px; font-family: inherit; }
  #input:focus { outline: none; border-color: #58a6ff; }
  #send { background: #238636; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 14px; }
  #send:hover { background: #2ea043; }
  #send:disabled { opacity: 0.5; cursor: not-allowed; }
  #node-list { flex: 1; overflow-y: auto; padding: 8px; }
  #node-search { width: 100%; background: #161b22; border: 1px solid #30363d; color: #c9d1d9; padding: 6px 10px; font-size: 12px; font-family: monospace; border-radius: 4px; margin-bottom: 4px; }
  #node-search:focus { outline: none; border-color: #58a6ff; }
  #node-search-wrap { padding: 8px 8px 0 8px; }
  .node-item { padding: 6px 10px; cursor: pointer; border-radius: 4px; font-size: 13px; font-family: monospace; display: flex; align-items: center; gap: 6px; }
  .node-item:hover { background: #161b22; }
  .node-item.selected { background: #1f2937; color: #58a6ff; }
  .node-item .node-name-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 9px; padding: 1px 5px; border-radius: 3px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; flex-shrink: 0; }
  .badge-function { background: #1f6feb33; color: #58a6ff; }
  .badge-tool { background: #23863633; color: #3fb950; }
  .badge-spawned { background: #da363333; color: #f85149; }
  .badge-other { background: #30363d; color: #8b949e; }
  #node-detail { border-top: 1px solid #21262d; display: flex; flex-direction: column; }
  #node-detail-header { padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #21262d; }
  #node-detail-header .node-name { font-weight: 600; font-size: 13px; color: #58a6ff; }
  #node-detail-header .btn-group { display: flex; gap: 4px; }
  #node-detail-header button { background: #30363d; color: #c9d1d9; border: none; padding: 3px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; }
  #node-detail-header button:hover { background: #484f58; }
  #node-detail-header button.save-btn { background: #238636; color: #fff; }
  #node-detail-header button.save-btn:hover { background: #2ea043; }
  #node-detail-header button.cancel-btn { background: #da3633; color: #fff; }
  #node-detail-header button.cancel-btn:hover { background: #f85149; }
  #node-detail-header button.delete-btn { background: #da3633; color: #fff; }
  #node-detail-header button.delete-btn:hover { background: #f85149; }
  #node-source { height: 300px; overflow-y: auto; padding: 12px; font-size: 12px; font-family: monospace; white-space: pre-wrap; background: #0d1117; color: #8b949e; }
  #node-source-edit { height: 300px; width: 100%; padding: 12px; font-size: 12px; font-family: monospace; background: #161b22; color: #c9d1d9; border: 1px solid #58a6ff; resize: none; display: none; }
  #create-node-form { padding: 12px; border-top: 1px solid #21262d; display: none; }
  #create-node-form input, #create-node-form textarea { width: 100%; background: #161b22; border: 1px solid #30363d; color: #c9d1d9; padding: 6px 10px; border-radius: 4px; font-size: 12px; font-family: monospace; margin-bottom: 8px; }
  #create-node-form input:focus, #create-node-form textarea:focus { outline: none; border-color: #58a6ff; }
  #create-node-form textarea { height: 120px; resize: vertical; }
  #create-node-form .form-buttons { display: flex; gap: 4px; justify-content: flex-end; }
  #create-node-form button { padding: 4px 10px; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
  #create-node-form .create-btn { background: #238636; color: #fff; }
  #create-node-form .create-cancel-btn { background: #30363d; color: #c9d1d9; }
  .notification { position: fixed; top: 16px; right: 16px; padding: 10px 16px; border-radius: 6px; font-size: 13px; z-index: 1000; animation: fadeOut 3s forwards; }
  .notification.success { background: #238636; color: #fff; }
  .notification.error { background: #da3633; color: #fff; }
  @keyframes fadeOut { 0%,70% { opacity: 1; } 100% { opacity: 0; } }
  /* compact provider config form (non-blocking, persists, status) */
  #provider-form { padding: 2px 8px; background: #161b22; border-bottom: 1px solid #21262d; font-size: 9px; display: flex; gap: 3px; align-items: center; flex-wrap: wrap; }
  #provider-form input { background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 1px 4px; border-radius: 2px; font-size: 8px; font-family: inherit; min-width: 60px; }
  #provider-form input:focus { border-color: #58a6ff; outline: none; }
  #provider-form .p-base { flex: 2; min-width: 140px; }
  #provider-form .p-key { flex: 1; min-width: 70px; }
  #provider-form .p-model { flex: 0.8; min-width: 50px; }
  #provider-form button { background: #30363d; color: #c9d1d9; border: none; padding: 1px 5px; border-radius: 2px; font-size: 8px; cursor: pointer; }
  #provider-form button:hover { background: #484f58; }
  #provider-form .p-clear { background: #da363333; color: #f85149; }
  #p-status { font-size: 8px; opacity: 0.7; margin-left: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px; }
</style>
</head>
<body>
<div id="chat-panel">
  <div class="panel-header">holoiconic chat <span id="prov" style="font-size:9px;opacity:0.85;background:#21262d;padding:1px 5px;border-radius:3px;cursor:default;margin-left:6px;vertical-align:middle;" title="Custom provider status (set via form below)">default</span></div>
  <div id="provider-form">
    <input id="p-base" class="p-base" placeholder="baseUrl e.g. http://localhost:11434/v1 or https://api.groq.com/openai" />
    <input id="p-key" class="p-key" placeholder="apiKey (blank=sk-local)" />
    <input id="p-model" class="p-model" placeholder="model" />
    <button id="p-set">set</button>
    <button id="p-clear" class="p-clear">clear</button>
    <span id="p-status"></span>
  </div>
  <div id="messages"></div>
  <div id="input-row">
    <input id="input" type="text" placeholder="Type a message..." autocomplete="off" />
    <button id="send">Send</button>
  </div>
</div>
<div id="graph-panel">
  <div class="panel-header"><span>graph nodes</span><button id="create-node-btn">+ New Node</button></div>
  <div id="create-node-form">
    <input id="new-node-name" type="text" placeholder="Node name (e.g. my:function)" />
    <textarea id="new-node-source" placeholder="Node source code (async function body receiving ctx, args)"></textarea>
    <div class="form-buttons">
      <button class="create-cancel-btn" id="create-cancel">Cancel</button>
      <button class="create-btn" id="create-submit">Create</button>
    </div>
  </div>
  <div id="node-search-wrap"><input id="node-search" type="text" placeholder="Filter nodes..." autocomplete="off" /></div>
  <div id="node-list"></div>
  <div id="node-detail">
    <div id="node-detail-header">
      <span class="node-name" id="detail-node-name"></span>
      <div class="btn-group" id="detail-buttons"></div>
    </div>
    <div id="node-source">Click a node to view source</div>
    <textarea id="node-source-edit"></textarea>
  </div>
</div>
<script>
const API = 'http://localhost:' + ${apiPort} + '/v1/chat/completions';
const BASE = window.location.origin;
const msgDiv = document.getElementById('messages');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const nodeList = document.getElementById('node-list');
const nodeSource = document.getElementById('node-source');
const nodeSourceEdit = document.getElementById('node-source-edit');
const detailNodeName = document.getElementById('detail-node-name');
const detailButtons = document.getElementById('detail-buttons');
const createNodeForm = document.getElementById('create-node-form');
const nodeSearchInput = document.getElementById('node-search');

let selectedNode = null;
let originalSource = null;
let editMode = false;
let allNodesCache = [];
let providerConfig = null; // {baseUrl, apiKey, model} for custom OpenAI per WebUI session

// Persistent session ID for multi-turn conversations
const sessionId = 'webui:' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
const chatHistory = [];

function notify(msg, type) {
  const el = document.createElement('div');
  el.className = 'notification ' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderToolCalls(toolCalls, container) {
  if (!toolCalls || toolCalls.length === 0) return;
  const wrap = document.createElement('div');
  wrap.className = 'tool-calls';
  for (const tc of toolCalls) {
    const tcDiv = document.createElement('div');
    tcDiv.className = 'tool-call';
    const header = document.createElement('div');
    header.className = 'tool-call-header';
    header.innerHTML = '<span class="tool-call-label">' + escHtml(tc.name) + '</span><span class="tool-call-toggle">click to expand</span>';
    const body = document.createElement('div');
    body.className = 'tool-call-body';
    body.textContent = 'Input: ' + JSON.stringify(tc.input, null, 2) + '\\n\\nResult: ' + (tc.result || '(no result)');
    header.onclick = () => {
      body.classList.toggle('open');
      header.querySelector('.tool-call-toggle').textContent = body.classList.contains('open') ? 'collapse' : 'click to expand';
    };
    tcDiv.appendChild(header);
    tcDiv.appendChild(body);
    wrap.appendChild(tcDiv);
  }
  container.appendChild(wrap);
}

async function send() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  sendBtn.disabled = true;
  addMsg('user', text);
  chatHistory.push({ role: 'user', content: text });

  const d = document.createElement('div');
  d.className = 'msg assistant';
  d.innerHTML = '<div class="role">assistant</div>';
  const contentSpan = document.createElement('span');
  d.appendChild(contentSpan);
  msgDiv.appendChild(d);

  let fullText = '';
  let toolCalls = [];

  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: (providerConfig && providerConfig.model) || 'holoiconic',
        messages: chatHistory,
        session: sessionId,
        stream: true,
        ...(providerConfig ? { baseUrl: providerConfig.baseUrl, apiKey: providerConfig.apiKey || undefined } : {}),
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      contentSpan.textContent = 'Error: ' + (err.error ? err.error.message : res.statusText);
      sendBtn.disabled = false;
      input.focus();
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
          if (delta && delta.tool_calls) {
            toolCalls = delta.tool_calls;
          }
          if (delta && delta.content) {
            fullText += delta.content;
            contentSpan.textContent = fullText;
            msgDiv.scrollTop = msgDiv.scrollHeight;
          }
        } catch {}
      }
    }

    // Flush any remaining data in the buffer after stream ends
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data: ')) {
        const payload = trimmed.slice(6);
        if (payload !== '[DONE]') {
          try {
            const chunk = JSON.parse(payload);
            const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
            if (delta && delta.content) {
              fullText += delta.content;
              contentSpan.textContent = fullText;
            }
          } catch {}
        }
      }
    }

    // Render tool calls if any
    renderToolCalls(toolCalls, d);

    chatHistory.push({ role: 'assistant', content: fullText });
  } catch (e) {
    contentSpan.textContent = 'Error: ' + e.message;
  }
  sendBtn.disabled = false;
  input.focus();
  loadNodes();
}

function addMsg(role, content) {
  const d = document.createElement('div');
  d.className = 'msg ' + escHtml(role);
  d.innerHTML = '<div class="role">' + escHtml(role) + '</div>' + escHtml(content);
  msgDiv.appendChild(d);
  msgDiv.scrollTop = msgDiv.scrollHeight;
}

sendBtn.onclick = send;
input.onkeydown = (e) => { if (e.key === 'Enter') send(); };

// Wire providerConfig as non-blocking inline form (below header): 3 inputs + set/clear; localStorage persist (load init, save set); masked status; auto-apply on send (replaces prompts)
const provEl = document.getElementById('prov');
function maskKey(k) { if (!k) return ''; return k.slice(0,4) + '***' + (k.length > 6 ? k.slice(-2) : ''); }
function shortBase(b) { if (!b) return ''; const h = (b.split('//')[1] || b).split('/')[0]; return h.slice(0,22); }
function updateProviderStatus() {
  const st = document.getElementById('p-status');
  if (providerConfig && providerConfig.baseUrl) {
    const sb = shortBase(providerConfig.baseUrl);
    const mk = maskKey(providerConfig.apiKey);
    const mm = providerConfig.model ? providerConfig.model.slice(0,10) : '';
    if (provEl) { provEl.textContent = sb + (mm ? ':' + mm : ''); provEl.title = 'Custom: ' + providerConfig.baseUrl + (mk ? ' k:'+mk : ''); }
    if (st) st.textContent = sb + (mk ? '·'+mk : '') + (mm ? '·'+mm : '');
  } else {
    if (provEl) { provEl.textContent = 'default'; provEl.title = 'Using default provider (set form to target custom OpenAI-compatible)'; }
    if (st) st.textContent = '';
  }
}
function loadProviderFromStorage() {
  try {
    const saved = localStorage.getItem('holo_providerConfig');
    if (saved) {
      providerConfig = JSON.parse(saved);
      const bi = document.getElementById('p-base'); if (bi) bi.value = providerConfig.baseUrl || '';
      const ki = document.getElementById('p-key'); if (ki) ki.value = providerConfig.apiKey || '';
      const mi = document.getElementById('p-model'); if (mi) mi.value = providerConfig.model || '';
    }
  } catch {}
  updateProviderStatus();
}
function wireProviderForm() {
  const setB = document.getElementById('p-set');
  const clrB = document.getElementById('p-clear');
  const bi = document.getElementById('p-base');
  const ki = document.getElementById('p-key');
  const mi = document.getElementById('p-model');
  if (setB) setB.onclick = () => {
    const b = (bi && bi.value || '').trim();
    if (!b) { notify('baseUrl is required for custom provider', 'error'); return; }
    const k = (ki && ki.value || '').trim();
    const m = (mi && mi.value || '').trim();
    providerConfig = { baseUrl: b, apiKey: k, model: m };
    try { localStorage.setItem('holo_providerConfig', JSON.stringify(providerConfig)); } catch {}
    updateProviderStatus();
    notify('Saved to localStorage — custom provider active on next send', 'success');
  };
  if (clrB) clrB.onclick = () => {
    providerConfig = null;
    try { localStorage.removeItem('holo_providerConfig'); } catch {}
    if (bi) bi.value = ''; if (ki) ki.value = ''; if (mi) mi.value = '';
    updateProviderStatus();
    notify('Cleared — back to default provider', 'success');
  };
  // allow Enter in base to set quickly
  if (bi) bi.onkeydown = (e) => { if (e.key === 'Enter' && setB) setB.onclick(); };
}
loadProviderFromStorage();
wireProviderForm();

function setEditMode(on) {
  editMode = on;
  nodeSource.style.display = on ? 'none' : 'block';
  nodeSourceEdit.style.display = on ? 'block' : 'none';
  renderDetailButtons();
}

function renderDetailButtons() {
  detailButtons.innerHTML = '';
  if (!selectedNode) return;
  if (editMode) {
    const saveBtn = document.createElement('button');
    saveBtn.className = 'save-btn';
    saveBtn.textContent = 'Save';
    saveBtn.onclick = saveSource;
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cancel-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => {
      setEditMode(false);
      nodeSource.textContent = originalSource || '(no source)';
    };
    detailButtons.appendChild(cancelBtn);
    detailButtons.appendChild(saveBtn);
  } else {
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.onclick = () => {
      nodeSourceEdit.value = originalSource || '';
      setEditMode(true);
    };
    detailButtons.appendChild(editBtn);
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.onclick = deleteNode;
    detailButtons.appendChild(deleteBtn);
  }
}

async function deleteNode() {
  if (!selectedNode) return;
  if (!confirm('Delete node "' + selectedNode + '"? This retracts ALL quads for this subject.')) return;
  try {
    const res = await fetch(BASE + '/api/node/' + encodeURIComponent(selectedNode), {
      method: 'DELETE',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed');
    notify('Node "' + selectedNode + '" deleted (' + data.retracted + ' quads)', 'success');
    selectedNode = null;
    detailNodeName.textContent = '';
    nodeSource.textContent = 'Click a node to view source';
    detailButtons.innerHTML = '';
    loadNodes();
  } catch (e) {
    notify('Error deleting: ' + e.message, 'error');
  }
}

async function saveSource() {
  const newSource = nodeSourceEdit.value;
  try {
    const res = await fetch(BASE + '/api/node/' + encodeURIComponent(selectedNode) + '/source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: newSource }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');
    originalSource = newSource;
    nodeSource.textContent = newSource;
    setEditMode(false);
    notify('Node "' + selectedNode + '" saved', 'success');
    loadNodes();
  } catch (e) {
    notify('Error saving: ' + e.message, 'error');
  }
}

function getBadgeClass(types) {
  if (!types || types.length === 0) return 'badge-other';
  if (types.includes('Tool')) return 'badge-tool';
  if (types.includes('Spawned')) return 'badge-spawned';
  if (types.includes('Function')) return 'badge-function';
  return 'badge-other';
}

function renderNodeList(filter) {
  const f = (filter || '').toLowerCase();
  nodeList.innerHTML = '';
  for (const n of allNodesCache) {
    if (f && !n.name.toLowerCase().includes(f)) continue;
    const el = document.createElement('div');
    el.className = 'node-item' + (n.name === selectedNode ? ' selected' : '');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'node-name-text';
    nameSpan.textContent = n.name;
    el.appendChild(nameSpan);
    if (n.types && n.types.length > 0) {
      for (const t of n.types) {
        const badge = document.createElement('span');
        badge.className = 'badge ' + getBadgeClass([t]);
        badge.textContent = t;
        el.appendChild(badge);
      }
    }
    el.onclick = () => showSource(n.name, el);
    nodeList.appendChild(el);
  }
}

async function loadNodes() {
  try {
    const res = await fetch(BASE + '/api/nodes');
    const nodes = await res.json();
    allNodesCache = nodes;
    renderNodeList(nodeSearchInput.value);
  } catch {}
}

nodeSearchInput.oninput = () => renderNodeList(nodeSearchInput.value);

async function showSource(name, el) {
  document.querySelectorAll('.node-item').forEach(e => e.classList.remove('selected'));
  if (el) el.classList.add('selected');
  selectedNode = name;
  setEditMode(false);
  detailNodeName.textContent = name;
  try {
    const res = await fetch(BASE + '/api/node/' + encodeURIComponent(name));
    const data = await res.json();
    originalSource = data.source;
    nodeSource.textContent = data.source || '(no source)';
    renderDetailButtons();
  } catch {
    nodeSource.textContent = '(error loading)';
    originalSource = null;
    renderDetailButtons();
  }
}

// Create Node
document.getElementById('create-node-btn').onclick = () => {
  createNodeForm.style.display = createNodeForm.style.display === 'block' ? 'none' : 'block';
};
document.getElementById('create-cancel').onclick = () => {
  createNodeForm.style.display = 'none';
  document.getElementById('new-node-name').value = '';
  document.getElementById('new-node-source').value = '';
};
document.getElementById('create-submit').onclick = async () => {
  const name = document.getElementById('new-node-name').value.trim();
  const source = document.getElementById('new-node-source').value;
  if (!name) { notify('Node name is required', 'error'); return; }
  if (!source) { notify('Node source is required', 'error'); return; }
  try {
    const res = await fetch(BASE + '/api/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, source }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Create failed');
    createNodeForm.style.display = 'none';
    document.getElementById('new-node-name').value = '';
    document.getElementById('new-node-source').value = '';
    notify('Node "' + name + '" created', 'success');
    loadNodes();
    // Auto-select the new node
    setTimeout(() => showSource(name, null), 200);
  } catch (e) {
    notify('Error creating: ' + e.message, 'error');
  }
};

loadNodes();
</script>
</body>
</html>`;

const serverOptions = {
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Serve the SPA
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders } });
    }

    // API: list nodes (GET) or create node (POST)
    if (url.pathname === '/api/nodes') {
      if (req.method === 'POST') {
        try {
          const body = await req.json();
          const name = body.name;
          const source = body.source;
          if (!name || typeof name !== 'string') {
            return Response.json({ error: 'name (string) is required' }, { status: 400, headers: corsHeaders });
          }
          if (!source || typeof source !== 'string') {
            return Response.json({ error: 'source (string) is required' }, { status: 400, headers: corsHeaders });
          }
          // Check if node already exists
          const existing = await ctx.query({ subject: name, predicate: 'type', object: 'Function' });
          if (existing.length > 0) {
            return Response.json({ error: 'Node already exists: ' + name }, { status: 409, headers: corsHeaders });
          }
          await ctx.insert(name, 'type', 'Function');
          await ctx.insert(name, 'source', source);
          return Response.json({ ok: true, name }, { status: 201, headers: corsHeaders });
        } catch (err) {
          const isSyntaxError = err instanceof SyntaxError || (err.message && err.message.includes('JSON'));
          return Response.json({ error: err.message || String(err) }, { status: isSyntaxError ? 400 : 500, headers: corsHeaders });
        }
      }
      // GET: list nodes — returns names and their types
      const fnNodes = await ctx.query({ predicate: 'type', object: 'Function' });
      const names = fnNodes.map(n => n.subject);
      const result = [];
      for (const name of names) {
        const typeQuads = await ctx.query({ subject: name, predicate: 'type' });
        const types = typeQuads.map(q => q.object);
        result.push({ name, types });
      }
      result.sort((a, b) => a.name.localeCompare(b.name));
      return Response.json(result, { headers: corsHeaders });
    }

    // API: update node source (POST /api/node/:name/source)
    if (url.pathname.match(/^\/api\/node\/.+\/source$/) && req.method === 'POST') {
      try {
        // Extract node name: everything between /api/node/ and the final /source
        const pathParts = url.pathname.slice('/api/node/'.length);
        const candidateName = decodeURIComponent(pathParts.slice(0, pathParts.lastIndexOf('/source')));
        // Verify the candidate is a known Function node to avoid route ambiguity
        // (e.g. POST /api/node/my/source should not create a phantom "my" node)
        const fnCheck = await ctx.query({ subject: candidateName, predicate: 'type', object: 'Function' });
        if (fnCheck.length === 0) {
          return Response.json({ error: 'Node not found: ' + candidateName }, { status: 404, headers: corsHeaders });
        }
        const body = await req.json();
        const newSource = body.source;
        if (typeof newSource !== 'string') {
          return Response.json({ error: 'source (string) is required' }, { status: 400, headers: corsHeaders });
        }

        await ctx.remove(candidateName, 'source');
        await ctx.insert(candidateName, 'source', newSource);

        return Response.json({ ok: true, name: candidateName }, { headers: corsHeaders });
      } catch (err) {
        const isSyntaxError = err instanceof SyntaxError || (err.message && err.message.includes('JSON'));
        return Response.json({ error: err.message || String(err) }, { status: isSyntaxError ? 400 : 500, headers: corsHeaders });
      }
    }

    // API: delete a node (DELETE /api/node/:name)
    if (url.pathname.startsWith('/api/node/') && req.method === 'DELETE') {
      try {
        const name = decodeURIComponent(url.pathname.slice('/api/node/'.length));
        const quads = await ctx.query({ subject: name });
        if (quads.length === 0) {
          return Response.json({ error: 'Node not found: ' + name }, { status: 404, headers: corsHeaders });
        }
        for (const q of quads) {
          await ctx.remove(q.subject, q.predicate, q.object, q.graph);
        }
        return Response.json({ ok: true, name, retracted: quads.length }, { headers: corsHeaders });
      } catch (err) {
        return Response.json({ error: err.message || String(err) }, { status: 500, headers: corsHeaders });
      }
    }

    // API: get node deps (GET /api/node/:name/deps)
    if (url.pathname.match(/^\/api\/node\/.+\/deps$/) && req.method === 'GET') {
      try {
        const pathParts = url.pathname.slice('/api/node/'.length);
        const name = decodeURIComponent(pathParts.slice(0, pathParts.lastIndexOf('/deps')));
        const result = await ctx.call('graph:deps', { node: name });
        return Response.json(result, { headers: corsHeaders });
      } catch (err) {
        return Response.json({ error: err.message || String(err) }, { status: 500, headers: corsHeaders });
      }
    }

    // API: get node source (GET /api/node/:name)
    if (url.pathname.startsWith('/api/node/') && req.method === 'GET') {
      const name = decodeURIComponent(url.pathname.slice('/api/node/'.length));
      const sourceQuads = await ctx.query({ subject: name, predicate: 'source' });
      const source = sourceQuads.length > 0 ? sourceQuads[0].object : null;
      return Response.json({ name, source }, { headers: corsHeaders });
    }

    return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders });
  },
};

let server;
try {
  server = await ctx.call('runtime:adapter', { op: 'serve', port, fetch: serverOptions.fetch });
} catch (err) {
  if (port !== 0 && String(err.message || err).includes('Failed to start server')) {
    console.warn('[web:ui] port ' + port + ' unavailable — falling back to an ephemeral port');
    server = await ctx.call('runtime:adapter', { op: 'serve', port: 0, fetch: serverOptions.fetch });
  } else {
    throw err;
  }
}
port = server.port;
await ctx.set('web:ui', 'port', String(port));

console.log('[web:ui] listening on http://localhost:' + port);

if (signal) {
  await new Promise((resolve) => {
    signal.addEventListener('abort', resolve, { once: true });
  });
  await server.stop();
  console.log('[web:ui] stopped');
}
