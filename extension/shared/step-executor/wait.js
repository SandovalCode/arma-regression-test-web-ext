import { waitForSelector } from "../selector-resolver.js";
import { STEP_TIMEOUT_MS, NAV_TIMEOUT_MS, POLLING_DOMAINS } from "../constants.js";
import { sleep } from "./helpers.js";

const REFRESH_WAIT_CYCLE_MS = 4_000;  // time to look for element before each refresh
const REFRESH_WAIT_MAX_MS   = 40_000; // total max duration

// ── waitForElement ─────────────────────────────────────────────────────────────

// ── waitForElementWithRefresh ──────────────────────────────────────────────────
// Polls for an element, reloading the page every REFRESH_WAIT_CYCLE_MS until
// it appears or REFRESH_WAIT_MAX_MS elapses.

export async function execWaitForElementWithRefresh(step, tabId, contextId, cdp) {
  const deadline = Date.now() + REFRESH_WAIT_MAX_MS;

  while (Date.now() < deadline) {
    const cycleMs = Math.min(REFRESH_WAIT_CYCLE_MS, deadline - Date.now());

    try {
      await waitForSelector(step.selectors, tabId, contextId, cdp, cycleMs);
      return; // element found
    } catch (err) {
      // If not a poll timeout, re-throw (e.g. debugger detached)
      if (!err.message.includes("timed out") && !err.message.includes("not found")) {
        throw err;
      }
    }

    if (Date.now() >= deadline) break;

    // Element not found this cycle — reload and wait for the page to settle
    await cdp(tabId, "Page.reload", {});
    await execWaitForPageLoad(tabId, cdp);
  }

  const tried = (step.selectors ?? []).flat().filter(Boolean).join(", ");
  throw new Error(`waitForElementWithRefresh timed out after ${REFRESH_WAIT_MAX_MS / 1000}s. Tried: ${tried}`);
}

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
