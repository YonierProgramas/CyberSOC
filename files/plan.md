# Sprint 0 — Foundation

| Campo | Valor |
|---|---|
| Fechas | 30 sep – 6 oct 2026 |
| Depende de | — |
| Tag al cerrar | `v0.0.0-s0` |
| Carriles | A: `CyberSOC/app/` (Electron, core, IA) · B: `CyberSOC/engine/` (Python) · Ambos: documentos de la entrega 1 |

## Antes de empezar

- [ ] Decisiones D1–D14 revisadas y aprobadas en `00-ESTADO.md`.
- [ ] Ambos con Windows 10/11, Git, Node.js LTS, Python 3.12 y uv instalados.
- [ ] Repositorio creado en GitHub, con acceso para ambos.
- [ ] Cuenta en la consola de Anthropic (Claude Developer Platform), API key creada, crédito cargado y límite de gasto configurado.
- [ ] Esta carpeta `construccion/` subida al repositorio en el primer commit.

## Objetivo

Dejar una base ejecutable y verificada:

- la app abre;
- el motor Python responde;
- SQLite se crea con migraciones;
- hay logs, CI y las estructuras base;
- hay una conexión real con la IA.

Además, dejar listos los documentos de la primera entrega.

## Historias de usuario

- **HU-S0-01.** Como equipo, quiero un repositorio con `construccion/` y `CyberSOC/`, reglas para agentes y `main` protegido, para trabajar con una única fuente de verdad.
- **HU-S0-02.** Como desarrollador, quiero ejecutar `npm run dev` y ver la ventana con el estado del motor, para confirmar que TS y Python se comunican.
- **HU-S0-03.** Como desarrollador, quiero que la app cree y migre su base SQLite al iniciar.
- **HU-S0-04.** Como desarrollador, quiero logs estructurados de ambos procesos en un solo archivo.
- **HU-S0-05.** Como estudiante, quiero Queue y Stack propias, con pruebas y análisis de complejidad.
- **HU-S0-06.** Como equipo, quiero verificar la conexión real con el proveedor de IA a través de `AIProvider`.
- **HU-S0-07.** Como equipo, quiero CI que ejecute lint y pruebas de TS y Python en cada PR.
- **HU-S0-08.** Como equipo, quiero los documentos de la primera entrega en `construccion/`.

## Entregables

### Bloque A — Estructura y comunicación

- [ ] **T0.1** Estructura raíz: `.gitignore`, `.gitattributes` (`* text=auto eol=lf`), `.editorconfig`, `AGENTS.md`, `CLAUDE.md`, plantilla de PR y `main` protegido.
- [ ] **T0.2** App Electron + electron-vite + TypeScript `strict` + React, con la ventana endurecida (ver especificaciones).
- [ ] **T0.3** Motor Python (uv, paquete `src/cybersoc_engine`) con servidor JSON-RPC: `engine.hello`, `engine.ping`, `engine.shutdown`.
- [ ] **T0.4** `EngineProcess` (spawn, handshake, captura de stderr, cierre ordenado) y `JsonRpcEngineClient` (`Map<id, pendiente>`, timeouts). La UI muestra "Motor: conectado vX / desconectado" y un botón "Reconectar".
- [ ] **T0.5** Contratos: mensajes de referencia en `CyberSOC/contracts/protocol-v1/`, validados por pruebas en TS (zod) y en Python (pydantic).

### Bloque B — Base técnica

- [ ] **T0.6** Spike de SQLite (máximo 2 h) + clase `Database` + `MigrationRunner` + migración 001. El resultado del spike se documenta en ADR-002.
- [ ] **T0.7** Logger TS (pino → JSONL) y logging JSON de Python por stderr, reenviado al mismo archivo con `component=engine`.
- [ ] **T0.8** `AppConfig` con esquema zod y valores por defecto.
- [ ] **T0.9** `Queue<T>` (buffer circular) y `Stack<T>` propias, con pruebas, benchmark contra `Array.shift` y fichas escritas.

### Bloque C — IA, CI y entrega

- [ ] **T0.10** Interfaz `AIProvider`, `FakeAIProvider` y `ClaudeProvider` (API de Claude con el SDK oficial `@anthropic-ai/sdk`, modelo `claude-haiku-4-5-20251001`; en S0 solo `healthCheck` y `generateStructured` con `output_config.format`). Script `npm run ai:smoke`, que lee la clave de la variable `ANTHROPIC_API_KEY` (solo en desarrollo; nunca en el repo).
- [ ] **T0.11** CI en GitHub Actions (`windows-latest`): lint, typecheck y pruebas de TS; ruff y pytest de Python; pruebas de contrato.
- [ ] **T0.12** Documentos de la entrega 1 (ver lista al final), cierre del sprint y tag.

## Especificaciones clave

### Estructura de `CyberSOC/` esperada al cerrar

```
CyberSOC/
├─ contracts/protocol-v1/        engine.hello.request.json, engine.hello.response.json, ...
├─ app/
│  ├─ package.json · tsconfig*.json · electron.vite.config.ts · vitest.config.ts · eslint.config.js
│  ├─ scripts/ai-smoke.ts
│  ├─ src/main/        index.ts, window.ts, composition-root.ts, ipc/system.ipc.ts
│  ├─ src/preload/     index.ts
│  ├─ src/renderer/    index.html, src/main.tsx, App.tsx, pages/StatusPage.tsx
│  ├─ src/shared/      protocol.ts, ipc.ts        (esquemas zod)
│  ├─ src/core/structures/   Queue.ts, Stack.ts
│  ├─ src/core/engine/       EngineClient.ts, JsonRpcEngineClient.ts, EngineProcess.ts
│  ├─ src/core/persistence/  Database.ts, MigrationRunner.ts, migrations/001_init.ts
│  ├─ src/core/logging/logger.ts · src/core/config/AppConfig.ts
│  ├─ src/core/ai/           AIProvider.ts, providers/FakeAIProvider.ts, providers/ClaudeProvider.ts
│  └─ tests/                 unit/, integration/
└─ engine/
   ├─ pyproject.toml · uv.lock
   ├─ src/cybersoc_engine/   __main__.py, version.py, logging_setup.py, rpc/server.py, rpc/protocol.py, rpc/handlers.py
   └─ tests/                 test_protocol.py, test_handlers.py, test_contracts.py
```

Regla: `src/core/` no importa nada de `electron`. Se hace cumplir con la regla `no-restricted-imports` de ESLint.

### Seguridad de la ventana Electron

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- CSP estricta: `default-src 'self'`; el renderer no se conecta a ningún sitio externo.
- Navegación y apertura de ventanas nuevas bloqueadas.
- El preload expone solo `window.cybersoc.system.getStatus()` y `window.cybersoc.system.reconnectEngine()`.

### Protocolo mínimo (JSON-RPC 2.0, NDJSON)

```json
→ {"jsonrpc":"2.0","id":1,"method":"engine.hello","params":{"protocol":"1","client":"cybersoc-core/0.0.1"}}
← {"jsonrpc":"2.0","id":1,"result":{"protocol":"1","engineVersion":"0.0.1","python":"3.12.x","capabilities":[]}}
→ {"jsonrpc":"2.0","id":2,"method":"engine.ping","params":{}}
← {"jsonrpc":"2.0","id":2,"result":{"ts":"2026-10-01T15:00:00Z"}}
→ {"jsonrpc":"2.0","id":3,"method":"engine.shutdown","params":{}}
← {"jsonrpc":"2.0","id":3,"result":{"ok":true}}
```

Reglas:

- **Encuadre.** Un objeto JSON por línea, UTF-8 explícito en stdin y stdout, flush en cada mensaje.
- **stdout exclusivo del protocolo.** Los logs van por stderr. `print()` queda prohibido con la regla T20 de ruff.
- **Errores estándar:**

  | Código | Significado |
  |---|---|
  | -32700 | JSON inválido. El proceso no debe caerse |
  | -32600 | Petición inválida |
  | -32601 | Método desconocido |
  | -32602 | Parámetros inválidos |
  | -32603 | Error interno |

- **Handshake.** Timeout de 5 s. Si la versión de protocolo no coincide, el estado es "incompatible".
- **Proceso.** Se lanza con `windowsHide: true`. Al cerrar: `engine.shutdown` y, si el proceso sigue vivo a los 2 s, kill.
- **Ruta del motor.** En desarrollo: `CyberSOC/engine/.venv/Scripts/python.exe -m cybersoc_engine`. Se puede sobrescribir con la variable `CYBERSOC_ENGINE_CMD`.

### Interfaces

```ts
interface EngineClient {
  hello(): Promise<EngineInfo>;
  ping(): Promise<{ ts: string }>;
  shutdown(): Promise<void>;
}
interface EngineInfo { protocol: '1'; engineVersion: string; python: string; capabilities: string[]; }

class Queue<T> {            // buffer circular con redimensionamiento
  enqueue(x: T): void; dequeue(): T | undefined; peek(): T | undefined;
  get size(): number; isEmpty(): boolean; clear(): void; get peakSize(): number;
}
class Stack<T> {
  push(x: T): void; pop(): T | undefined; peek(): T | undefined;
  get size(): number; isEmpty(): boolean; get peakSize(): number;
}

interface AIProvider {
  readonly id: 'claude' | 'openai' | 'local' | 'fake';
  healthCheck(): Promise<AIResult<{ model: string }>>;
  generateStructured<T>(req: StructuredRequest<T>): Promise<AIResult<T>>;
  // runAssistantTurn(...) se añade en S4/S5
}
type AIResult<T> =
  | { ok: true; value: T; model: string; usage: { inputTokens: number; outputTokens: number }; latencyMs: number }
  | { ok: false; error: AIError };
interface AIError {
  kind: 'OFFLINE' | 'TIMEOUT' | 'RATE_LIMIT' | 'AUTH' | 'PROVIDER_DOWN' | 'INVALID_OUTPUT' | 'INCOMPLETE' | 'UNSAFE';
  retryable: boolean; retryAfterMs?: number; message: string;
}
```

### Migración 001

```sql
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
-- Al abrir la conexión: PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
-- Ruta de la BD: app.getPath('userData')/cybersoc.db (en pruebas: carpeta temporal)
```

### Spike de SQLite (máximo 2 h)

1. Probar `node:sqlite` en la versión de Electron elegida.
2. Si falla, `better-sqlite3` + `@electron/rebuild`, con las pruebas ejecutadas sobre el runtime de Electron.

La opción elegida debe funcionar en `npm run dev`, en Vitest y en CI, sin compilación nativa manual. La decisión se registra en ADR-002.

## Estructuras de datos del sprint

| Estructura | Uso | Evidencia |
|---|---|---|
| Queue (buffer circular) | Base para `ScanQueue` en S1 | Pruebas + benchmark de 10⁶ operaciones contra `Array.shift()` (O(n)) |
| Stack | Base para `FileDiscovery` en S1 | Pruebas + `peakSize` |
| Map | Peticiones RPC pendientes (`id → {resolve, reject, timer}`) | Prueba de correlación de respuestas |

## Pruebas

**Unitarias**

- [ ] Queue: orden FIFO, vuelta del buffer, redimensionamiento, cola vacía, `peakSize`.
- [ ] Queue: prueba de propiedad con operaciones aleatorias contra un arreglo de referencia.
- [ ] Stack: orden LIFO, vacía, `peakSize`.
- [ ] Python: `hello` y `ping`.
- [ ] Python: una línea JSON inválida devuelve -32700 sin tumbar el proceso.
- [ ] Python: nada se escribe en stdout salvo mensajes del protocolo.
- [ ] `FakeAIProvider` devuelve una salida estructurada válida y también errores simulados.

**Integración**

- [ ] Handshake real en menos de 5 s y ping de ida y vuelta.
- [ ] Método desconocido → -32601.
- [ ] Matar el proceso Python → el cliente rechaza las peticiones pendientes y el estado pasa a "desconectado".
- [ ] `shutdown` no deja procesos huérfanos.
- [ ] Migraciones sobre una BD nueva → versión 1. Una segunda ejecución no hace nada.
- [ ] Mensajes de `contracts/` validados por zod y por pydantic.

**Manuales**

- [ ] `npm run dev` muestra "Motor: conectado v0.0.1 · protocolo 1".
- [ ] El Administrador de tareas no muestra `python.exe` después de cerrar la app.
- [ ] `npm run ai:smoke` con clave real devuelve estado, modelo y tokens.
- [ ] Instalación completa en las dos máquinas, incluida una con usuario de Windows con tilde si existe.

## Criterios de aceptación

- [ ] **CA-0.1** Un clon limpio, siguiendo `manuales/instalacion.md`, corre en menos de 30 minutos en ambas máquinas.
- [ ] **CA-0.2** La ventana muestra el motor conectado con su versión y protocolo.
- [ ] **CA-0.3** Si se mata `python.exe`, la UI muestra "desconectado" en menos de 2 s, la app no se congela y "Reconectar" funciona.
- [ ] **CA-0.4** Al cerrar la app no queda ningún proceso Python vivo.
- [ ] **CA-0.5** La BD existe en `userData` con versión 1, y un reinicio no reaplica migraciones.
- [ ] **CA-0.6** El log JSONL contiene entradas del core y del motor, con timestamp, nivel y componente.
- [ ] **CA-0.7** Queue y Stack pasan sus pruebas con cobertura ≥ 90 %, y sus fichas están escritas.
- [ ] **CA-0.8** `ai:smoke` obtiene una respuesta estructurada y validada del proveedor real. Las pruebas automáticas usan solo el Fake.
- [ ] **CA-0.9** El CI está en verde y `main` está protegido.
- [ ] **CA-0.10** En la consola del renderer, `require` y `process` no existen.
- [ ] **CA-0.11** Los documentos de la entrega 1 están en `construccion/`.

## Evidencias a guardar (`evidencias/`)

- [ ] Captura de la ventana con el motor conectado.
- [ ] Captura del Administrador de tareas después de cerrar la app.
- [ ] Extracto del log JSONL.
- [ ] Reportes de Vitest y pytest.
- [ ] Captura del CI en verde.
- [ ] Salida de `ai:smoke` (sin la clave).
- [ ] Resultado del benchmark de la Queue.
- [ ] Hash del commit del tag.

## Riesgos a vigilar

- Módulo nativo de SQLite (se mitiga con el spike).
- Nombre de usuario de Windows con tildes o espacios que rompa rutas del venv o de las herramientas.
- Finales de línea CRLF (se mitiga con `.gitattributes`).
- Ventana de consola visible al lanzar Python (`windowsHide`).

## Fuera de alcance

Escaneo de archivos, detección, UI definitiva, API key desde la UI (llega en S2).

## Documentos de la entrega 1 (T0.12)

- [ ] `propuesta/propuesta.md`: problema, objetivos, alcance y exclusiones, justificación, metodología por sprints, uso responsable de IA en el desarrollo.
- [ ] `requisitos/requisitos.md`: RF, RF-IA y RNF con los IDs de `01-resumen-general.md` y criterios de alto nivel.
- [ ] `requisitos/casos-de-uso.md` + diagrama. Casos:
  - escanear archivo o carpeta;
  - cancelar;
  - ver resultado y evidencia;
  - solicitar análisis de IA;
  - conversar con el Copilot;
  - poner en cuarentena;
  - restaurar;
  - eliminar;
  - consultar historial;
  - configurar IA;
  - exportar reporte.
- [ ] `arquitectura/arquitectura.md`:
  - componentes;
  - despliegue (3 procesos);
  - secuencias de escaneo, análisis IA y Copilot;
  - frontera TS/Python y protocolo;
  - modelo de datos y clases iniciales;
  - plan de estructuras de datos;
  - seguridad;
  - diseño de IA y `RiskPolicy`.
- [ ] `arquitectura/diagramas/*.mmd`.
- [ ] `decisiones/ADR-001` a `ADR-005`.
- [ ] `estructuras-de-datos/queue.md` y `stack.md`.
- [ ] Plan: roadmap, tabla de sprints y riesgos (desde `00-ESTADO.md` y los planes).

## Al cerrar

Completar `cierre.md` con `sprints/plantilla-cierre.md`, crear el tag `v0.0.0-s0` y actualizar `00-ESTADO.md` (sprint actual → S1).
