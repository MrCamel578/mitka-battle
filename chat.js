'use strict';

(function () {
  let selectedUserId = null;
  let timer = null;
  let open = false;
  let sending = false;
  const esc = value => escapeHtml(String(value ?? ''));
  const chatMarkup = () => `<aside id="chatWidget" class="chat-widget" aria-live="polite"><button class="chat-launcher" id="chatLauncher" type="button" onclick="toggleChat()"><span class="chat-dot"></span><span>Чат с админом</span><b id="chatUnread"></b></button><section class="chat-panel" id="chatPanel" hidden><header class="chat-header"><div><strong id="chatTitle">Поддержка</strong><small id="chatSubtitle">Администратор: Idi0t578</small></div><button class="chat-close" type="button" onclick="toggleChat()">×</button></header><div id="chatAdminUsers" class="chat-admin-users" hidden></div><div id="chatMessages" class="chat-messages"><div class="chat-empty">Загрузка чата…</div></div><form id="chatForm" class="chat-form"><input id="chatInput" maxlength="1000" placeholder="Напиши сообщение…" autocomplete="off"><button class="primary" type="submit" aria-label="Отправить">➤</button></form></section></aside>`;
  function root() { return document.getElementById('chatWidget'); }
  function isAdmin() { return !!(user && user.role === 'admin'); }
  function messageMarkup(message) {
    const own = isAdmin() ? message.senderRole === 'admin' : message.senderId === user?.id;
    const time = new Date(message.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return `<div class="chat-message ${own ? 'own' : ''}"><div class="chat-message-meta">${esc(message.senderName)} · ${time}</div><div class="chat-bubble">${esc(message.body).replace(/\n/g, '<br>')}</div></div>`;
  }
  async function loadConversations() {
    if (!isAdmin()) return;
    try {
      const data = await api('/api/chat/conversations');
      const host = document.getElementById('chatAdminUsers');
      if (!host) return;
      host.innerHTML = data.conversations.length ? data.conversations.map(item => `<button class="chat-user-choice ${Number(item.id) === selectedUserId ? 'active' : ''}" onclick="selectChatUser(${Number(item.id)},'${esc(item.username)}')"><b>${esc(item.username)}</b><small>${item.messages} сообщ.</small></button>`).join('') : '<div class="chat-empty chat-empty-small">Новых диалогов нет.</div>';
      host.hidden = false;
      if (!selectedUserId && data.conversations[0]) selectChatUser(data.conversations[0].id, data.conversations[0].username);
    } catch (error) { toast(error.message, 'error'); }
  }
  async function loadMessages() {
    if (!user || (isAdmin() && !selectedUserId)) return;
    try {
      const query = isAdmin() ? `?userId=${encodeURIComponent(selectedUserId)}` : '';
      const data = await api(`/api/chat/messages${query}`);
      const host = document.getElementById('chatMessages');
      if (!host) return;
      const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 60;
      host.innerHTML = data.messages.length ? data.messages.map(messageMarkup).join('') : '<div class="chat-empty">Сообщений пока нет. Напиши первым.</div>';
      if (atBottom) host.scrollTop = host.scrollHeight;
    } catch (error) { if (open) toast(error.message, 'error'); }
  }
  function schedulePolling() {
    clearInterval(timer);
    timer = setInterval(() => { if (open && user) { if (isAdmin()) loadConversations(); loadMessages(); } }, 3500);
  }
  function mount() {
    if (document.getElementById('chatWidget')) return;
    document.body.insertAdjacentHTML('beforeend', chatMarkup());
    document.getElementById('chatForm').addEventListener('submit', sendMessage);
    schedulePolling();
  }
  async function sendMessage(event) {
    event.preventDefault();
    if (!user || sending || (isAdmin() && !selectedUserId)) return;
    const input = document.getElementById('chatInput');
    const body = input.value.trim();
    if (!body) return;
    sending = true; input.disabled = true;
    try {
      await api('/api/chat/messages', { method: 'POST', body: JSON.stringify({ body, ...(isAdmin() ? { userId: selectedUserId } : {}) }) });
      input.value = ''; sound('message'); await loadMessages(); if (isAdmin()) await loadConversations();
    } catch (error) { toast(error.message, 'error'); }
    finally { sending = false; input.disabled = false; input.focus(); }
  }
  function toggleChat() {
    if (!user) return requireUser();
    open = !open;
    const panel = document.getElementById('chatPanel');
    if (panel) panel.hidden = !open;
    if (open) { sound('chat'); if (isAdmin()) loadConversations(); loadMessages(); }
  }
  function selectChatUser(id, name) {
    selectedUserId = Number(id); open = true;
    const panel = document.getElementById('chatPanel'); if (panel) panel.hidden = false;
    const title = document.getElementById('chatTitle'); if (title) title.textContent = `Чат: ${name}`;
    loadConversations(); loadMessages();
  }
  function syncChatUser() {
    mount();
    const widget = root();
    if (!widget) return;
    widget.hidden = !user;
    if (user && !isAdmin()) {
      const list = document.getElementById('chatAdminUsers'); if (list) list.hidden = true;
      const title = document.getElementById('chatTitle'); if (title) title.textContent = 'Чат с админом';
    }
  }
  const originalSetUser = setUser;
  setUser = function (nextUser) { originalSetUser(nextUser); syncChatUser(); };
  window.toggleChat = toggleChat;
  window.selectChatUser = selectChatUser;
  window.chatInit = syncChatUser;
})();
