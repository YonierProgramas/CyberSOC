# Reglas de trabajo con agentes de IA

## Roles

| Herramienta | Rol | Úsenla para | Eviten |
|---|---|---|---|
| Claude Chat | Arquitecto y planificador | Arquitectura, contratos, tarjetas de tarea, revisión de diseño, prompts | Editar el repositorio |
| Claude Code | Implementador de cambios críticos | Frontera TS↔Python, cuarentena, orquestador de IA, seguridad de Electron, debugging difícil | Retoques triviales de UI |
| Codex | Implementador y revisor | Tareas bien especificadas, pruebas, refactors acotados, revisión de PR | Cambiar contratos sin tarjeta |
| Cursor | Edición diaria | UI, ajustes pequeños, navegación del código | Cambios que atraviesan varias capas |

## Flujo de una tarea

1. Se redacta la tarjeta con `plantilla-tarea.md` en `sprints/<sprint>/tareas/T-XX.md`.
2. Se crea la rama `sN/<tipo>-<descripcion>` desde `main` (ejemplo: `s1/feat-file-discovery`).
3. Un solo agente implementa en esa rama.
4. El agente ejecuta las pruebas y entrega el reporte.
5. Se abre un PR con la plantilla de PR.
6. Otro agente revisa, solo con comentarios.
7. El equipo lee el "Resumen para el equipo" del reporte y del revisor.
8. Squash merge con el CI en verde.
9. Si hubo decisiones, se registran en `00-ESTADO.md` o en un ADR.

## Reglas

- **Un escritor por rama.** Dos agentes pueden trabajar en paralelo solo sobre directorios disjuntos (`CyberSOC/app/` vs `CyberSOC/engine/`).
- **Contrato primero.** El día 1 de cada sprint se acuerda el contrato TS↔Python del sprint en `CyberSOC/contracts/`.
- **Cambios que requieren un ADR aprobado:**
  - contratos;
  - migraciones ya aplicadas;
  - dependencias nuevas;
  - cualquier cambio de seguridad.
- **Documentación:** toda va en `construccion/`. Nada dentro de `CyberSOC/`.
- **Si la tarjeta es ambigua** o hace falta salir de su alcance: detenerse y preguntar.

## Nunca

- Escribir EICAR o malware en disco; ejecutar muestras.
- Poner secretos en el código, los logs o los commits.
- Pedir permisos de administrador.
- Borrar archivos del usuario fuera de la bóveda de cuarentena.
- Usar `print()` en el motor Python: stdout es exclusivo del protocolo.
- Dar a la IA capacidad de ejecutar acciones o de decidir veredictos.
- Hacer merge.

## Formato del reporte del agente

```
Tarea: T-XX · Rama: sN/...
Archivos creados/modificados: ...
Comandos de verificación y resultado: ...
Decisiones tomadas (¿requieren ADR?): ...
Dudas / riesgos / pendientes: ...
```

## Prompt base para iniciar una sesión

```
Lee AGENTS.md, construccion/00-ESTADO.md, el plan del sprint actual y la tarjeta
construccion/sprints/<sprint>/tareas/T-XX.md. Implementa solo esa tarjeta en la rama
indicada. Modifica únicamente los archivos permitidos. Al terminar, entrega el reporte
en el formato de construccion/ia/reglas-agentes.md. No hagas merge.
```
