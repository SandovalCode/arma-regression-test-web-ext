// ── Entry point ────────────────────────────────────────────────────────────────
// Imports each module in dependency order. Side-effecting modules (keepalive,
// debugger-handler, context-menu, message-router) register their Chrome API
// listeners on import. Pure modules (state, utils, recording, replay) are pulled
// in transitively through message-router.
import './keepalive.js';
import './debugger-handler.js';
import './context-menu.js';
import './message-router.js';

// ── Open side panel when extension icon is clicked ─────────────────────────────
chrome.action.onClicked.addListener(async tab => {
  await chrome.sidePanel.open({ tabId: tab.id });
});
