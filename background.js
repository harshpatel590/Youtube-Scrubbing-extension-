chrome.action.onClicked.addListener((tab) => {
  console.log('[MX Background] Icon clicked for tab:', tab.id);
  if (!tab || !tab.id) return;
  
  chrome.tabs.sendMessage(tab.id, { type: 'toggle-settings' }, { frameId: 0 })
    .then(() => console.log('[MX Background] Message delivered successfully'))
    .catch((err) => console.error('[MX Background] Error delivering message:', err));
});