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
    // pendingUrl is heading to the same page but a different query string
    // (e.g. form submit → server-assigned auto-increment job_id). Follow the redirect.
    if (samePathname(pendingUrl, targetUrl)) {
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
    // Settled on the same page but a different query string — same redirect case.
    if (samePathname(settled.url ?? "", targetUrl)) {
      await sleep(600);
      return;
    }
  } else if (normalizeUrl(tab.url ?? "") === normalizeUrl(targetUrl)) {
    await sleep(300);
    return;
  } else if (samePathname(tab.url ?? "", targetUrl)) {
    // Tab already completed a redirect to the same page with a different query string
    // (fast server response — tab finished loading before execNavigate ran).
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

function samePathname(url1, url2) {
  try {
    const u1 = new URL(url1);
    const u2 = new URL(url2);
    return u1.origin === u2.origin && u1.pathname === u2.pathname;
  } catch {
    return false;
  }
}
