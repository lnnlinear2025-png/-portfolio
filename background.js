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

  pins.unshift({ id: Date.now().toString(), url, title, read: false });
  await chrome.storage.sync.set({ pins });

  await chrome.action.setBadgeText({ text: 'ok' });
  await chrome.action.setBadgeBackgroundColor({ color: '#5A7268' });
  setTimeout(() => updateBadge(), 1500);
});

updateBadge();
