import { KEEPALIVE_MINS } from '../shared/constants.js';

// ── Service worker keep-alive ──────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'keepAlive') { /* no-op — the alarm itself keeps SW alive */ }
});

export function startKeepalive() {
  chrome.alarms.create('keepAlive', { periodInMinutes: KEEPALIVE_MINS });
}

export function stopKeepalive() {
  chrome.alarms.clear('keepAlive');
}
