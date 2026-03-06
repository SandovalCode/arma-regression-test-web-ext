// ── setViewport ────────────────────────────────────────────────────────────────

export async function execSetViewport(step, tabId, cdp) {
  await cdp(tabId, "Emulation.setDeviceMetricsOverride", {
    width: step.width ?? 1280,
    height: step.height ?? 720,
    deviceScaleFactor: step.deviceScaleFactor ?? 1,
    mobile: step.isMobile ?? false
  });
}
