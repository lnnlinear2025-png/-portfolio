/**
 * background.js - Service Worker for Tab Out
 */

async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});
    const count = tabs.filter(t => {
      const url = t.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    if (count === 0) return;

    let color;
    if (count <= 10)      color = '#3d7a4a';
    else if (count <= 20) color = '#b8892e';
    else                  color = '#b35a5a';

    await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    chrome.action.setBadgeText({ text: '' });
  }
}

chrome.runtime.onInstalled.addListener(() => updateBadge());
chrome.runtime.onStartup.addListener(() => updateBadge());
chrome.tabs.onCreated.addListener(() => updateBadge());
chrome.tabs.onRemoved.addListener(() => updateBadge());
chrome.tabs.onUpdated.addListener(() => updateBadge());

// Alt+S: save current tab to pins
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'save-current-tab') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

  const url = tab.url;
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
      url.startsWith('about:') || url.startsWith('edge://')) return;

  const title = tab.title || url;
  const { pins = [] } = await chrome.storage.sync.get('pins');

  if (pins.some(p => p.url === url)) {
    await chrome.action.setBadgeText({ text: 'ok' });
    await chrome.action.setBadgeBackgroundColor({ color: '#5A7268' });
    setTimeout(() => updateBadge(), 1500);
    return;
  }

  pins.unshift({ id: Date.now().toString(), url, title, read: false, savedAt: new Date().toISOString() });
  await chrome.storage.sync.set({ pins });

  await chrome.action.setBadgeText({ text: 'ok' });
  await chrome.action.setBadgeBackgroundColor({ color: '#5A7268' });
  setTimeout(() => updateBadge(), 1500);
});

updateBadge();

/* ----------------------------------------------------------------
   SMART DIGEST — 3-day unread check + DeepSeek summary + Feishu push
   ---------------------------------------------------------------- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('folio-digest-check', { periodInMinutes: 60 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('folio-digest-check', { periodInMinutes: 60 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'folio-digest-check') return;
  await runDigestCheck();
});

async function getDigestSettings() {
  const data = await chrome.storage.local.get([
    'digestApiKey', 'digestWebhook', 'digestEnabled',
    'digestDays', 'digestTodoDays', 'digestTodoEnabled',
  ]);
  return {
    apiKey:       data.digestApiKey      || '',
    webhook:      data.digestWebhook     || '',
    enabled:      data.digestEnabled     !== false,
    days:         data.digestDays        || 3,
    todoDays:     data.digestTodoDays    || 7,
    todoEnabled:  data.digestTodoEnabled !== false,
  };
}

async function runDigestCheck() {
  const { apiKey, webhook, enabled, days, todoDays, todoEnabled } = await getDigestSettings();
  if (!webhook) return;

  // Todo overdue check
  if (todoEnabled) {
    await runTodoOverdueCheck(webhook, todoDays);
  }

  if (!enabled || !apiKey) return;

  const { pins = [] } = await chrome.storage.sync.get('pins');
  const threshold = days * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const candidates = pins.filter(p => {
    if (p.read || p.digested) return false;
    const saved = p.savedAt ? new Date(p.savedAt).getTime() : parseInt(p.id, 10);
    return (now - saved) >= threshold;
  });

  if (candidates.length === 0) return;

  for (const pin of candidates) {
    try {
      const pageText = await fetchPageText(pin.url);
      if (!pageText) continue;
      const summary = await summarizeWithDeepSeek(pageText, pin.title, apiKey);
      if (!summary) continue;
      await sendToFeishu(webhook, pin.title, pin.url, summary, pin.savedAt || new Date(parseInt(pin.id, 10)).toISOString());

      // Mark as digested so we don't re-process
      pin.digested = true;
      pin.digestedAt = new Date().toISOString();
      pin.summary = summary;
    } catch (err) {
      console.error('[Folio] digest error for', pin.url, err);
    }
  }

  // Save updated pins
  const updated = pins.map(p => candidates.find(c => c.id === p.id) || p);
  await chrome.storage.sync.set({ pins: updated });

  // System notification
  if (candidates.length > 0) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Folio 摘要',
      message: `已为 ${candidates.length} 篇未读内容生成摘要并发送到飞书`,
    });
  }
}

async function fetchPageText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000);
    return text || null;
  } catch {
    return null;
  }
}

async function summarizeWithDeepSeek(text, title, apiKey) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: '你是一个内容摘要助手。请用中文简洁地总结以下网页内容，150字以内，提炼核心观点，语言流畅自然。',
        },
        {
          role: 'user',
          content: `标题：${title}\n\n正文：${text}`,
        },
      ],
      max_tokens: 300,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

async function runTodoOverdueCheck(webhook, todoDays) {
  const { todos = [] } = await chrome.storage.sync.get('todos');
  const threshold = todoDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const overdue = todos.filter(t => {
    if (t.done || t.overdueNotified) return false;
    const created = t.createdAt ? new Date(t.createdAt).getTime() : parseInt(t.id, 10);
    return (now - created) >= threshold;
  });

  if (overdue.length === 0) return;

  for (const todo of overdue) {
    const daysOld = Math.floor((now - new Date(todo.createdAt || parseInt(todo.id, 10)).getTime()) / 86400000);
    await sendTodoOverdueToFeishu(webhook, todo, daysOld, todoDays);
    todo.overdueNotified = true;
  }

  const updated = todos.map(t => overdue.find(o => o.id === t.id) || t);
  await chrome.storage.sync.set({ todos: updated });

  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'Folio Todo 提醒',
    message: `${overdue.length} 个待办已超过 ${todoDays} 天未完成`,
  });
}

async function sendTodoOverdueToFeishu(webhook, todo, daysOld, todoDays) {
  await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msg_type: 'interactive',
      card: {
        header: {
          title: { tag: 'plain_text', content: '⏰ Folio Todo 超期提醒' },
          template: 'orange',
        },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: `**${todo.text}**\n已创建 ${daysOld} 天，超过你设定的 ${todoDays} 天提醒阈值`,
            },
          },
          { tag: 'hr' },
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: todo.url ? `来源：${todo.url}` : '手动添加的任务',
            },
          },
          {
            tag: 'note',
            elements: [{ tag: 'plain_text', content: '打开 Folio 新标签页 → Todo 处理此任务' }],
          },
        ],
      },
    }),
  });
}

async function sendToFeishu(webhook, title, url, summary, savedAt) {
  const daysAgo = Math.floor((Date.now() - new Date(savedAt).getTime()) / 86400000);
  await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msg_type: 'interactive',
      card: {
        header: {
          title: { tag: 'plain_text', content: '📚 Folio 摘要提醒' },
          template: 'blue',
        },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: `**${title}**\n保存于 ${daysAgo} 天前，至今未读`,
            },
          },
          { tag: 'hr' },
          {
            tag: 'div',
            text: { tag: 'lark_md', content: summary },
          },
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '打开原文' },
                url,
                type: 'primary',
              },
            ],
          },
        ],
      },
    }),
  });
}
