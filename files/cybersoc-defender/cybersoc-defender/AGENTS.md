# CyberSOC Defender — Instrucciones para agentes

Aplica a Claude Code, Codex y Cursor.

## Antes de cualquier cambio, lee en este orden

1. `construccion/00-ESTADO.md` — sprint actual y decisiones vigentes.
2. `construccion/ia/reglas-agentes.md` — reglas de trabajo.
3. La tarjeta de tarea asignada en `construccion/sprints/<sprint>/tareas/`.
4. El plan del sprint actual: `construccion/sprints/<sprint>/plan.md`.

## Reglas que nunca se rompen

- `CyberSOC/` contiene solo código, configuración, pruebas y fixtures. Nada de documentación de sprints.
- Toda documentación va en `construccion/`.
- Modifica solo los archivos permitidos por la tarjeta.
- No añadas dependencias ni cambies contratos (`CyberSOC/contracts/`) o migraciones ya aplicadas sin un ADR aprobado.
- El motor Python nunca escribe archivos del usuario, nunca usa la red y nunca accede a SQLite.
- La IA nunca decide un veredicto: solo `RiskPolicy` lo hace.
- La IA se usa solo mediante la API de Claude (Anthropic), a través de `AIProvider`/`ClaudeProvider`, desde el proceso main.
- Nunca escribas EICAR ni malware en disco. Nunca commitees secretos ni API keys.
- Ejecuta las pruebas antes de declarar una tarea terminada y reporta la salida.
- No hagas merge. Termina con el reporte definido en `construccion/ia/reglas-agentes.md`.
