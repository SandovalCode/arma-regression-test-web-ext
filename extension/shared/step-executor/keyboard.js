// ── keyDown / keyUp ────────────────────────────────────────────────────────────

const KEY_MODIFIERS = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8
};

export async function execKeyDown(step, tabId, cdp) {
  const modifiers = KEY_MODIFIERS[step.key] ?? 0;
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: step.key,
    modifiers
  });
}

export async function execKeyUp(step, tabId, cdp) {
  const modifiers = KEY_MODIFIERS[step.key] ?? 0;
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: step.key,
    modifiers
  });
}
