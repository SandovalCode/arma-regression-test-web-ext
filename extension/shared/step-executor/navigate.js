import { sleep, waitForNavigation } from "./helpers.js";
import { NAV_TIMEOUT_MS } from "../constants.js";

// ── navigate ───────────────────────────────────────────────────────────────────

export async function execNavigate(step, tabId, cdp) {
  const targetUrl = step.url ?? "";
  if (!targetUrl) return;

  const tab = await chrome.tabs.get(tabId);

  if (tab.status === "loading") {
    // tab.pendingUrl is the in-flight destination (more reliable than tab.url here).
    const pendingUrl = tab.pendingUrl || tab.url || "";
    if (normalizeUrl(pendingUrl) === normalizeUrl(targetUrl)) {
      await waitForNavigation(tabId, NAV_TIMEOUT_MS);
      await sleep(600);
      return;
    }
    // Loading to a different URL — wait for it to settle, then check again.
    await waitForNavigation(tabId, NAV_TIMEOUT_MS);
    const settled = await chrome.tabs.get(tabId);
    if (normalizeUrl(settled.url ?? "") === normalizeUrl(targetUrl)) {
      await sleep(600);
      return;
    }
  } else if (normalizeUrl(tab.url ?? "") === normalizeUrl(targetUrl)) {
    await sleep(300);
    return;
  }

  const navPromise = waitForNavigation(tabId, NAV_TIMEOUT_MS);
  await cdp(tabId, "Page.navigate", { url: targetUrl });
  await navPromise;
  await sleep(600); // give JS frameworks time to boot
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}
