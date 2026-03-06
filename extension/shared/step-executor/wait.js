import { waitForSelector } from "../selector-resolver.js";
import { STEP_TIMEOUT_MS, NAV_TIMEOUT_MS, POLLING_DOMAINS } from "../constants.js";
import { sleep } from "./helpers.js";

// ── waitForElement ─────────────────────────────────────────────────────────────

export async function execWaitForElement(step, tabId, contextId, cdp) {
  await waitForSelector(step.selectors, tabId, contextId, cdp, STEP_TIMEOUT_MS);

  // Salesforce instant-result-item (search dropdown) triggers a fast internal
  // re-render after appearing — wait an extra second for it to settle.
  const selStr = JSON.stringify(step.selectors ?? "");
  if (selStr.includes("instant-result-item")) {
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function execWaitForPageLoad(tabId, cdp) {
  // For domains that poll continuously (e.g. Salesforce Lightning), readyState
  // never reaches 'complete'. Detect these by hostname and use a fixed sleep.
  try {
    const tab = await chrome.tabs.get(tabId);
    const hostname = new URL(tab.url ?? "").hostname;
    if (POLLING_DOMAINS.some((d) => hostname.endsWith(d))) {
      await sleep(3000);
      return;
    }
  } catch (e) {
    console.error(e);
  }

  // Normal pages: wait for 'complete', fall back to 'interactive' + 2s settle.
  const INTERACTIVE_SETTLE_MS = 2000;
  const deadline = Date.now() + NAV_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const res = await cdp(tabId, "Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true
    });
    const state = res?.result?.value;
    if (state === "complete") return;
    if (state === "interactive") {
      await sleep(INTERACTIVE_SETTLE_MS);
      return;
    }
    await sleep(500);
  }
  // Timed out — continue anyway
}
