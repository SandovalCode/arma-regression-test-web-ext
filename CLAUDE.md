# Test Recorder — Chrome Extension

## ¿Qué es este proyecto?

Una extensión de Chrome (Manifest V3) que permite a usuarios **sin conocimiento técnico** grabar flujos de prueba en el browser y replicarlos automáticamente. Reemplaza a Puppeteer/Playwright, que son bloqueados por sitios con suscripción paga. La extensión corre en el browser real sin flags de automatización, por lo que no es detectable como bot.

## ¿Por qué existe?

El equipo no tiene QA. Los usuarios necesitan:
1. Grabar sus acciones con un click desde el side panel
2. Replicar esas acciones automáticamente
3. Ver todos los tests guardados, ejecutarlos uno a uno o todos en secuencia

## Estructura de archivos

```
extension/
  manifest.json                  ← MV3, permisos, entry points
  background/
    service-worker.js            ← Orquestador principal: recording, replay, CDP, context menus
  content/
    recorder.js                  ← Inyectado dinámicamente durante grabación; captura eventos DOM
  sidepanel/
    sidepanel.html               ← UI principal (único entry point visual)
    sidepanel.js                 ← Lógica de UI, mensajería con SW
    sidepanel.css                ← Dark theme (default) + light theme toggle
  shared/
    constants.js                 ← Tipos de mensajes (MSG), status codes, timeouts
    storage.js                   ← Wrappers para chrome.storage.local
    selector-resolver.js         ← Resuelve selectores con fallback (aria → css → xpath → pierce → text)
    step-executor.js             ← Mapeo de cada step type a comandos CDP
  assets/
    icon16/48/128.png
```

## Flujo de grabación

1. Usuario click "Iniciar grabación" → sidepanel envía `START_RECORDING` al SW con el `tabId`
2. SW guarda la URL actual del tab como primer step (`navigate`) automáticamente
3. SW inyecta `content/recorder.js` en el tab activo (todas las frames)
4. `recorder.js` escucha: `click`, `mouseup`, `input`, `change`, `copy`, `paste`, `keydown`, `keyup`, `contextmenu`
5. Cada evento → `chrome.runtime.sendMessage({ type: 'RECORD_STEP', payload: { step } })`
6. El sidepanel recibe el mensaje directamente del content script y muestra la acción en el feed en tiempo real
7. El SW también recibe el mensaje y guarda el step en `recordingState.steps`
8. Al navegar a otra página: `webNavigation.onDOMContentLoaded` → SW graba step `navigate` con URL destino correcta + re-inyecta `recorder.js`
9. Usuario click "Detener" → dialog para nombre → SW guarda en `chrome.storage.local`

**Importante:** Los steps de `navigate` se graban en el SW (desde `onDOMContentLoaded`), NO en el content script. El content script ya no usa `beforeunload` porque registraba la URL incorrecta (origen, no destino).

## Flujo de replay

1. Sidepanel envía `RUN_RECORDING` (o `RUN_ALL`) al SW
2. SW: `chrome.debugger.attach({ tabId }, '1.3')` → habilita CDP
3. Por cada step: `executeStep(step, tabId, ...)` → espera 400ms entre steps
4. SW broadcastea `STEP_PROGRESS` → sidepanel actualiza progress bar en tiempo real
5. Al terminar: `appendRunResult(result)` → `chrome.debugger.detach`

## Tipos de steps y su ejecución CDP

| Step type | Acción CDP |
|---|---|
| `navigate` | `chrome.tabs.get` → si loading: espera `Page.loadEventFired`; si ya está en la URL: skip; si no: `Page.navigate` |
| `click` | `Input.dispatchMouseEvent` (moved → pressed → released) |
| `doubleClick` | Igual que click con `clickCount: 2` |
| `hover` | `Input.dispatchMouseEvent type:mouseMoved` |
| `change` | focus + `Input.insertText` + dispatchEvent input/change |
| `keyDown/keyUp` | `Input.dispatchKeyEvent` |
| `waitForElement` | Polling `Runtime.evaluate` cada 500ms, timeout 30s |
| `copy` | `Runtime.evaluate` para capturar texto seleccionado → guarda en `clipboardVars` Map del SW |
| `paste` | Lee `clipboardVars[variableName]` → `Input.insertText` (funciona cross-site) |
| `scroll` | `Input.dispatchMouseEvent type:mouseWheel` |
| `setViewport` | `Emulation.setDeviceMetricsOverride` |

## Selectores (5 estrategias con fallback)

Orden de prioridad en `selector-resolver.js`:
1. `aria/<label>` — aria-label, aria-labelledby, label[for]
2. CSS selector mínimo (`#id`, `[data-*]`, `[name=]`, tag+clase)
3. `xpath/<expr>` — path relativo desde root
4. `pierce/<css>` — CSS que penetra shadow DOM (recursivo)
5. `text/<contenido>` — texto visible del elemento

## Menú contextual (right-click durante grabación)

Dos opciones disponibles solo cuando hay grabación activa:
- **Registrar Hover** → graba step `hover` sobre el elemento bajo el cursor
- **Esperar elemento** → graba step `waitForElement` sobre el elemento bajo el cursor

El content script envía la info del elemento via `STORE_CONTEXT_EL` al SW. El SW almacena en `lastContextMenuEl` y lo consume cuando el usuario elige la opción del menú.

## Mensajes (constants.js)

```js
// sidepanel → SW
START_RECORDING, STOP_RECORDING, ABORT_RECORDING
RUN_RECORDING, RUN_ALL, ABORT_RUN
GET_RECORDINGS, GET_HISTORY
DELETE_RECORDING, DELETE_STEP   // DELETE_STEP elimina un step por índice durante grabación

// content script → SW
STORE_CONTEXT_EL   // info del elemento con right-click
RECORD_STEP        // step capturado (también llega directo al sidepanel)

// SW → sidepanel (broadcasts)
RECORD_STEP        // step grabado por el SW (hover, navigate)
STEP_PROGRESS      // progreso de replay
RUN_COMPLETE       // run terminado (passed/failed)
BATCH_PROGRESS     // batch: avanzó al siguiente recording
BATCH_COMPLETE     // batch: todos terminados
RECORDING_STATE    // confirmación de stop/abort
```

## Estado en memoria del SW

```js
recordingState = { active: bool, tabId: number, steps: Step[] }
replayState    = { active: bool, aborted: bool, tabId: number }
clipboardVars  = Map<variableName, copiedText>   // persiste durante un run completo
frameContextMap = Map<frameId, executionContextId>
lastContextMenuEl = { selectors, offsetX, offsetY, frame }  // del último right-click
```

## Modelo de datos (chrome.storage.local)

**recordings** — `Recording[]`
```js
{ id: string, title: string, createdAt: ISO, steps: Step[] }
```

**runHistory** — `RunResult[]` (máximo 100 entradas)
```js
{
  runId, recordingId, recordingTitle,
  startedAt, completedAt,
  passed: bool,
  totalSteps, completedSteps,
  failedStep: { index, type, error } | null,
  stepResults: [{ index, type, status, durationMs, error? }]
}
```

## Detalles técnicos importantes

- **Service worker keep-alive**: `chrome.alarms` cada ~24s durante runs largos (`KEEPALIVE_MINS = 0.4`)
- **Double-injection guard**: `window.__recorderActive` en el content script; `startRecording` siempre hace cleanup antes de re-inyectar
- **Deduplicación de steps**: ventana de 200ms en `sendStep()` de `recorder.js` (evita clicks dobles por label→input)
- **RECORD_STEP no se re-broadcastea**: el sidepanel ya lo recibe directamente del content script. Solo se broadcastea para steps creados en el SW (hover, navigate)
- **400ms entre steps**: el loop de replay tiene `await new Promise(r => setTimeout(r, 400))` después de cada step exitoso
- **Eliminar step durante grabación**: sidepanel envía `DELETE_STEP { index }` → SW hace `splice(index, 1)` en `recordingState.steps`

## Cargar la extensión

1. Ir a `chrome://extensions`
2. Activar "Modo desarrollador"
3. "Cargar descomprimida" → seleccionar carpeta `extension/`
4. El icono aparece en la toolbar; click abre el side panel
