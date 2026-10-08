# Prompts — Sprint 0: Foundation (30 sep – 6 oct)

Plan: `construccion/sprints/sprint-00-foundation/plan.md` · Reglas: `construccion/ia/asignacion-agentes.md`

| Tarea | Qué | Agente | Revisa | Rama | Depende de |
|---|---|---|---|---|---|
| T0.1 | Estructura base del repositorio | Codex (local) | Cursor | `s0/chore-repo-base` | — |
| T0.2 | App Electron endurecida + React | Codex (local) | **Claude Code [CRÍTICO]** | `s0/feat-electron-app` | T0.1 |
| T0.3 | Motor Python con servidor JSON-RPC | Codex (nube) | Cursor | `s0/feat-engine-rpc` | T0.1 |
| T0.4 | EngineProcess + cliente JSON-RPC + estado en UI | Codex (local) | **Claude Code [CRÍTICO]** | `s0/feat-engine-client` | T0.2, T0.3 |
| T0.5 | Contratos protocol-v1 | Codex (nube) | Cursor | `s0/feat-contracts` | T0.3 |
| T0.6 | Spike SQLite + Database + migraciones | Codex (local) | Cursor | `s0/spike-sqlite` | T0.2 |
| T0.7 | Logs JSONL (TS + Python) | Cursor | Codex | `s0/feat-logging` | T0.4 |
| T0.8 | AppConfig con zod | Cursor | Codex | `s0/feat-config` | T0.6 |
| T0.9 | Queue y Stack propias | **Ustedes** + Cursor (tutor) | Codex | `s0/feat-structures` | T0.2 |
| T0.10 | AIProvider + ClaudeProvider + ai:smoke | Claude Code | Codex | `s0/feat-ai-provider` | T0.2 |
| T0.11 | CI en GitHub Actions | Codex (local) | Cursor | `s0/ci` | T0.3, T0.5 |
| T0.12 | Documentos de la entrega 1 | Claude Chat o ChatGPT + ustedes | Ustedes | `s0/docs-entrega-1` | — |

**Orden sugerido:**
- Día 1: T0.1.
- Persona A: T0.2 → T0.4 → T0.6 → T0.8 → T0.10.
- Persona B: T0.3 → T0.5 → T0.11 → T0.7.
- Ambos, en paralelo: T0.9 y T0.12.
- Una sola sesión de Claude Code revisa T0.2 y T0.4 juntas.

---

## T0.1 — Estructura base del repositorio · Codex (local)

```text
Lee AGENTS.md, construccion/00-ESTADO.md y construccion/sprints/sprint-00-foundation/plan.md.
Tarea T0.1 — Estructura base del repositorio. Rama: s0/chore-repo-base (créala desde main).
Alcance:
1. .gitignore para Node, Electron, Python/uv (.venv), SQLite (*.db, *.db-wal, *.db-shm), .env, logs/, coverage/, out/, dist/.
2. .gitattributes con "* text=auto eol=lf" y binarios marcados (*.png, *.ico, *.jpg, *.bin, *.zip).
3. .editorconfig: UTF-8, LF, 2 espacios en TS/JSON/YAML, 4 espacios en Python.
4. .github/pull_request_template.md con: qué, por qué, cómo probar, evidencias, agente usado,
   tarea (T-XX) y la checklist de la Definition of Done de construccion/01-resumen-general.md.
5. Asegura que existan CyberSOC/app, CyberSOC/engine y CyberSOC/contracts (con .gitkeep).
Archivos permitidos: .gitignore, .gitattributes, .editorconfig, .github/pull_request_template.md, CyberSOC/*/.gitkeep.
No hagas: código de la app, CI (es T0.11), cambios en construccion/.
Terminado cuando: el commit contiene solo esos archivos y ningún archivo de construccion/ cambió.
Entrega el reporte de construccion/ia/reglas-agentes.md. No hagas merge.
```

Después del merge, ustedes protegen `main` en GitHub: PR obligatorio y CI obligatorio cuando exista.

## T0.2 — App Electron endurecida · Codex (local) · [CRÍTICO]

```text
Lee AGENTS.md, construccion/00-ESTADO.md y construccion/sprints/sprint-00-foundation/plan.md
(secciones "Estructura de CyberSOC/ esperada" y "Seguridad de la ventana Electron").
Tarea T0.2 — App Electron endurecida. Rama: s0/feat-electron-app.
Alcance:
1. En CyberSOC/app: Electron + electron-vite + TypeScript strict + React en el renderer.
   Scripts npm: dev, build, typecheck, lint, test.
2. BrowserWindow: contextIsolation:true, sandbox:true, nodeIntegration:false.
   CSP estricta (default-src 'self'; sin conexiones externas).
   Bloquea la navegación (will-navigate) y las ventanas nuevas (setWindowOpenHandler → deny).
3. Preload con contextBridge que expone SOLO window.cybersoc.system.getStatus()
   (por ahora devuelve { app: "CyberSOC Defender", version }).
4. Carpetas src/main, src/preload, src/renderer, src/shared y src/core (con un index vacío).
5. ESLint con no-restricted-imports que prohíba importar "electron" dentro de src/core/**. Prettier.
   Vitest con una prueba de ejemplo.
6. Página StatusPage mínima que muestre lo que devuelve getStatus().
Archivos permitidos: CyberSOC/app/**.
Dependencias permitidas: electron, electron-vite, vite, react, react-dom, @vitejs/plugin-react, typescript,
zod, vitest, eslint (+ plugins de TS y React), prettier y sus tipos. Cualquier otra: detente y pregunta.
No hagas: motor Python, SQLite, IA.
Terminado cuando: npm run dev abre la ventana; en DevTools typeof require y typeof process son "undefined";
npm run typecheck, npm run lint y npm test pasan.
Entrega el reporte de construccion/ia/reglas-agentes.md. No hagas merge.
```

## T0.3 — Motor Python con servidor JSON-RPC · Codex (nube)

```text
Lee AGENTS.md, construccion/00-ESTADO.md y construccion/sprints/sprint-00-foundation/plan.md (sección "Protocolo mínimo").
Tarea T0.3 — Motor Python con servidor JSON-RPC. Rama: s0/feat-engine-rpc.
Alcance:
1. En CyberSOC/engine: proyecto uv, Python 3.12, paquete src/cybersoc_engine,
   ejecutable con "python -m cybersoc_engine".
2. Servidor JSON-RPC 2.0 por stdin/stdout: un JSON por línea, UTF-8 explícito
   (usar sys.stdin.buffer y reconfigurar stdout), flush en cada mensaje.
3. Métodos: engine.hello (exige params.protocol == "1"), engine.ping (devuelve ts ISO-8601),
   engine.shutdown (responde y termina limpio).
4. Errores -32700 (línea inválida, sin caerse), -32600, -32601, -32602, -32603.
5. Logging JSON SOLO por stderr (logging_setup.py). Activa la regla T20 de ruff (prohíbe print).
6. Pruebas pytest de protocolo y handlers. Incluye una prueba que lance el proceso real, le envíe
   varias líneas (válidas e inválidas) y verifique que stdout solo contiene JSON válido.
Archivos permitidos: CyberSOC/engine/**.
Dependencias permitidas: pydantic, pytest, ruff. Otra: detente y pregunta.
No hagas: leer archivos del usuario, usar la red, usar SQLite.
Terminado cuando: uv run pytest y uv run ruff check pasan; una línea engine.ping por stdin produce una línea JSON de respuesta.
Indica en el reporte que trabajaste en la nube; la verificación final se hace en Windows.
Entrega el reporte de construccion/ia/reglas-agentes.md. No hagas merge.
```

## T0.4 — EngineProcess + cliente JSON-RPC + estado en UI · Codex (local) · [CRÍTICO]

```text
Lee AGENTS.md, construccion/00-ESTADO.md y construccion/sprints/sprint-00-foundation/plan.md
(secciones "Protocolo mínimo" e "Interfaces").
Tarea T0.4 — EngineProcess + JsonRpcEngineClient + estado del motor. Rama: s0/feat-engine-client.
Alcance:
1. src/core/engine/EngineClient.ts: interfaz con hello, ping y shutdown.
2. src/core/engine/JsonRpcEngineClient.ts:
   - Map<id, pendiente> con timeout por petición;
   - rechaza todas las pendientes si el proceso muere.
3. src/core/engine/EngineProcess.ts:
   - spawn con windowsHide:true y lectura de stdout por líneas;
   - stderr reenviado a un logger simple (lo reemplaza T0.7);
   - handshake engine.hello con timeout de 5 s;
   - estados: connected / disconnected / incompatible;
   - cierre: engine.shutdown y kill a los 2 s.
4. Comando del motor: CyberSOC/engine/.venv/Scripts/python.exe -m cybersoc_engine,
   sobrescribible con la variable CYBERSOC_ENGINE_CMD.
5. Composition root en src/main: inicia el motor al arrancar y lo cierra en before-quit.
6. IPC (con validación zod en main):
   - system:getStatus incluye { engine: { status, engineVersion, protocol } };
   - system:reconnectEngine.
7. StatusPage: "Motor: conectado vX · protocolo 1" o "desconectado", con botón Reconectar.
8. Pruebas Vitest:
   - cliente con streams simulados: correlación por id, timeout, rechazo cuando el proceso muere;
   - prueba de integración con el motor real, que se salta si no existe el .venv.
Archivos permitidos: CyberSOC/app/src/core/engine/**, src/main/**, src/preload/**, src/shared/**,
src/renderer/src/pages/StatusPage.tsx, CyberSOC/app/tests/**.
No hagas: cambios en CyberSOC/engine (si falta algo del motor, repórtalo).
Terminado cuando: se cumplen CA-0.2, CA-0.3 y CA-0.4 del plan (verificación manual) y las pruebas pasan.
Entrega el reporte de construccion/ia/reglas-agentes.md. No hagas merge.
```

## T0.5 — Contratos protocol-v1 · Codex (nube)

```text
Lee AGENTS.md y construccion/sprints/sprint-00-foundation/plan.md (sección "Protocolo mínimo").
Tarea T0.5 — Contratos protocol-v1. Rama: s0/feat-contracts.
Alcance:
1. CyberSOC/contracts/protocol-v1/: engine.hello.request.json, engine.hello.response.json,
   engine.ping.request.json, engine.ping.response.json, engine.shutdown.request.json,
   engine.shutdown.response.json, error.method-not-found.json, error.parse-error.json.
2. TS: esquemas zod en CyberSOC/app/src/shared/protocol.ts + una prueba que valide cada ejemplo.
3. Python: modelos pydantic en cybersoc_engine/rpc/protocol.py (alinéalos si ya existen)
   + tests/test_contracts.py que valide los mismos archivos.
Archivos permitidos: CyberSOC/contracts/**, CyberSOC/app/src/shared/protocol.ts, CyberSOC/app/tests/**,
CyberSOC/engine/src/cybersoc_engine/rpc/protocol.py, CyberSOC/engine/tests/test_contracts.py.
Terminado cuando: ambos lados validan todos los ejemplos, y alterar un campo obligatorio en un ejemplo hace fallar ambas pruebas.
Entrega el reporte de construccion/ia/reglas-agentes.md. No hagas merge.
```

## T0.6 — Spike SQLite + Database + migraciones · Codex (local)

```text
Lee AGENTS.md y construccion/sprints/sprint-00-foundation/plan.md (secciones "Migración 001" y "Spike de SQLite").
Tarea T0.6 — Spike SQLite + Database + migraciones. Rama: s0/spike-sqlite.
Alcance:
1. Spike (máximo 2 h). Prueba node:sqlite con la versión de Electron del proyecto, en npm run dev y en Vitest.
   Si falla, usa better-sqlite3 + @electron/rebuild, con Vitest ejecutado sobre el runtime de Electron
   (ELECTRON_RUN_AS_NODE). Documenta en el reporte qué funcionó, qué no y por qué (será la base de ADR-002).
2. src/core/persistence/Database.ts:
   - la ruta llega inyectada desde main (app.getPath('userData')/cybersoc.db);
   - al abrir: PRAGMA journal_mode=WAL y foreign_keys=ON.
3. src/core/persistence/MigrationRunner.ts y migrations/001_init.ts (schema_migrations, settings) según el plan.
4. Pruebas con una BD temporal: una BD nueva queda en versión 1, y una segunda ejecución no reaplica nada.
Archivos permitidos: CyberSOC/app/src/core/persistence/**, src/main/composition-root.ts, package.json, tests/**.
Dependencias: solo better-sqlite3 y @electron/rebuild, si hace falta el plan B.
Terminado cuando: se cumple CA-0.5 y funciona en npm run dev, en npm test y en CI.
Entrega el reporte de construccion/ia/reglas-agentes.md. No hagas merge.
```

## T0.7 — Logs JSONL · Cursor (modo agente)

```text
Lee AGENTS.md y construccion/sprints/sprint-00-foundation/plan.md (T0.7).
Tarea T0.7 — Logs JSONL. Rama: s0/feat-logging.
1. src/core/logging/logger.ts con pino. Escribe en userData/logs/cybersoc-YYYY-MM-DD.jsonl
   (ruta inyectada desde main), con los campos ts, level, component y msg.
2. EngineProcess: cada línea de stderr del motor se registra con component="engine";
   si la línea es JSON, conserva sus campos.
3. Redacción de secretos: nunca registrar valores de apiKey, authorization ni x-api-key.
   Nunca registrar contenido de archivos.
Archivos permitidos: src/core/logging/**, src/core/engine/EngineProcess.ts, src/main/composition-root.ts, tests/**.
Dependencia permitida: pino.
Terminado cuando: se cumple CA-0.6 y una prueba demuestra que una apiKey no aparece en el log.
No hagas merge.
```

## T0.8 — AppConfig · Cursor (modo agente)

```text
Lee construccion/sprints/sprint-00-foundation/plan.md (T0.8).
Tarea T0.8 — AppConfig. Rama: s0/feat-config.
1. src/core/config/AppConfig.ts: esquema zod con valores por defecto:
   engine.requestTimeoutMs=30000, scan.maxFileSizeMB=256, scan.queueCapacity=1000,
   ai.analysisModel="claude-haiku-4-5-20251001", ai.assistantModel="claude-haiku-4-5-20251001",
   ai.autoAnalyzeLimitPerScan=50, ai.sendFileNames=true.
2. Lectura y escritura en la tabla settings (usa Database de T0.6).
3. Pruebas: valores por defecto, rechazo de valores inválidos, persistencia tras reabrir la BD.
Archivos permitidos: src/core/config/**, tests/**.
No hagas merge.
```

## T0.9 — Queue y Stack propias · Ustedes + Cursor como tutor

**Esta tarea la escriben ustedes.** Usen el prompt de tutor de `asignacion-agentes.md`, con esta versión concreta:

```text
Voy a implementar YO Queue<T> (buffer circular con redimensionamiento) y Stack<T> en
CyberSOC/app/src/core/structures/, según construccion/sprints/sprint-00-foundation/plan.md (sección "Interfaces").
No escribas la implementación completa. Actúa como tutor:
1) revisa mi código y señala errores y casos borde (vuelta del índice, redimensionar con la cola dando la vuelta,
   dequeue en vacía, peakSize);
2) propón pruebas Vitest, incluida una prueba de propiedad con operaciones aleatorias contra un arreglo;
3) ayúdame con un script de benchmark: 10^6 operaciones en mi Queue contra Array.shift();
4) explica la complejidad de cada operación (O(1) amortizado) y por qué Array.shift() es O(n).
```

Después: revisión por Codex con la plantilla general. Ustedes escriben las fichas `construccion/estructuras-de-datos/queue.md` y `stack.md`.

## T0.10 — AIProvider + ClaudeProvider + ai:smoke · Claude Code

```text
Lee AGENTS.md, construccion/sprints/sprint-00-foundation/plan.md (sección "Interfaces") y
construccion/sprints/sprint-02-evidencia-ia-v1/plan.md (sección "Proveedor: API de Claude").
Tarea T0.10 — AIProvider + ClaudeProvider + ai:smoke. Rama: s0/feat-ai-provider.
Alcance:
1. src/core/ai/AIProvider.ts con los tipos AIProvider, AIResult y AIError del plan.
2. providers/FakeAIProvider.ts programable: cola de respuestas y errores simulados
   (OFFLINE, TIMEOUT, RATE_LIMIT con retryAfterMs, AUTH, PROVIDER_DOWN, INVALID_OUTPUT, INCOMPLETE).
3. providers/ClaudeProvider.ts con @anthropic-ai/sdk:
   - apiKey y modelo explícitos en el constructor; NUNCA leer ANTHROPIC_API_KEY de forma implícita;
   - healthCheck();
   - generateStructured<T>() con output_config.format a partir de un JSON Schema;
   - mapeo de errores HTTP y de stop_reason según la tabla del plan de S2;
   - timeout con AbortSignal.
   Verifica la forma exacta de output_config.format en la documentación actual del SDK antes de escribirla.
4. scripts/ai-smoke.ts: lee CYBERSOC_ANTHROPIC_API_KEY, pide una salida estructurada
   { status: "ok", model: string } y muestra modelo, tokens y latencia. Nunca imprime la clave.
5. Pruebas sin red: FakeAIProvider, y ClaudeProvider con el cliente HTTP simulado.
Archivos permitidos: CyberSOC/app/src/core/ai/**, CyberSOC/app/scripts/ai-smoke.ts, CyberSOC/app/tests/**,
package.json (solo el script ai:smoke y la dependencia).
Dependencia permitida: @anthropic-ai/sdk.
Terminado cuando: las pruebas pasan sin red y npm run ai:smoke funciona con una clave real (CA-0.8).
Entrega el reporte de construccion/ia/reglas-agentes.md. No hagas merge.
```

## T0.11 — CI · Codex (local)

```text
Lee AGENTS.md y construccion/sprints/sprint-00-foundation/plan.md (T0.11).
Tarea T0.11 — CI. Rama: s0/ci.
.github/workflows/ci.yml en windows-latest, con dos jobs:
- app: setup-node LTS, npm ci en CyberSOC/app, typecheck, lint, test;
- engine: instalar uv, uv sync, ruff check, pytest.
Las pruebas de contratos corren en ambos jobs. Usa cache de npm y de uv.
Sin secretos: las pruebas de IA usan FakeAIProvider.
Archivos permitidos: .github/workflows/ci.yml.
Terminado cuando: el workflow pasa en esta misma PR.
No hagas merge.
```

## T0.12 — Documentos de la entrega 1 · Claude Chat o ChatGPT + ustedes

Adjunten: `01-resumen-general.md`, `00-ESTADO.md`, el plan de S0 (sección "Documentos de la entrega 1"), el diagrama `arquitectura-v2.png` y el análisis de arquitectura aprobado.

```text
Redacta en español académico y conciso los documentos de la primera entrega de CyberSOC Defender,
a partir SOLO de los archivos adjuntos (no inventes funcionalidades):
1. propuesta.md: problema, objetivos, alcance y exclusiones, justificación, metodología por sprints,
   uso responsable de IA en el desarrollo.
2. requisitos.md: usa exactamente los IDs RF, RF-IA y RNF del resumen, con criterios de alto nivel.
3. casos-de-uso.md: los casos del plan, con un diagrama Mermaid.
4. arquitectura.md:
   - componentes y despliegue de 3 procesos;
   - secuencias en Mermaid: escaneo, análisis IA y Copilot;
   - frontera TS/Python y protocolo;
   - modelo de datos;
   - estructuras de datos;
   - seguridad;
   - diseño de IA con la Risk Policy.
Entrega cada documento por separado.
```

Segundo prompt, en la misma conversación:

```text
Ahora redacta ADR-001 a ADR-005 (escritorio Electron + React; SQLite propiedad del core;
protocolo JSON-RPC por stdio y motor de solo lectura; IA con la API de Claude y Risk Policy;
estructura del repositorio). Formato de cada ADR: contexto, decisión, alternativas consideradas,
consecuencias, estado.
```
