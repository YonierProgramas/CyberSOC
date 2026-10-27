# ADR-006 — Cuarentena segura

**Estado: Aprobado** · 1 oct 2026 · D8 · Autorización: tarea T4.1 del equipo.

## Contexto

S4 cierra el ciclo detección → acción (RF-11 a RF-13). La cuarentena es la única operación de CyberSOC que **borra un archivo del usuario**, así que un orden de pasos incorrecto, un cierre inesperado o un archivo que cambia entre el escaneo y la acción (TOCTOU) pueden producir pérdida de datos o duplicados. Además, el archivo aislado no debe poder ejecutarse por accidente ni volver a disparar otros antivirus. Por ADR-003 el motor Python no escribe archivos: toda la cuarentena vive en el Core TypeScript. Fuente: [plan S4](../sprints/sprint-04-cuarentena-copilot-v1/plan.md), secciones "Bóveda" a "Nunca".

## Decisión

- **Bóveda:** `%LOCALAPPDATA%\CyberSOC Defender\quarantine\`, en el perfil del usuario, sin pedir administrador ni cambiar ACL.
- **Formato `.csq`:** cabecera (`CSQ1`, versión, IV) + contenido cifrado en streaming con **AES-256-GCM** (`node:crypto`, sin dependencias nuevas). La clave es aleatoria por ítem y se guarda en SQLite junto al registro. **El cifrado no busca secreto** (la clave está al lado): busca *neutralizar* (no ejecutable, no se abre con doble clic, otros antivirus no lo re-detectan) y *verificar integridad* (tag de GCM + SHA-256 original).
- **Poner en cuarentena, en este orden:**
  1. Confirmación del usuario.
  2. La ruta no está en las rutas protegidas.
  3. Se recalcula el SHA-256; si difiere del escaneo, se aborta y se pide un nuevo escaneo.
  4. Se inserta el registro `PENDING`.
  5. Se cifra a un temporal dentro de la bóveda, se hace flush, se verifica descifrando que el hash coincide y se renombra al nombre definitivo.
  6. Se borra el original; si no se puede, se borra el blob, se marca `FAILED` y se informa.
  7. Se marca `QUARANTINED` y se registra en `audit_log`.
- **Reconciliación al iniciar:** cada registro `PENDING` se revisa según existan el blob y el original, y se completa o se revierte. Nunca quedan dos copias ni ninguna.
- **Restaurar / eliminar:** restaurar descifra a un temporal, verifica el SHA-256, no sobrescribe (usa un sufijo o pide otra ruta) y valida la ruta destino contra path traversal; pide doble confirmación si era `DETECTED`. Eliminar, con confirmación, borra solo el blob y deja el registro `DELETED`.
- **Rutas protegidas:** Set de prefijos normalizados en minúsculas: `C:\Windows\`, `C:\Program Files\`, `C:\Program Files (x86)\`, `C:\ProgramData\Microsoft\`, `userData`, la bóveda y la carpeta de instalación.
- **Sin cuarentena automática:** toda acción la confirma el usuario. La opción para `DETECTED` existe, pero viene desactivada. La IA nunca pone ni saca archivos de cuarentena.

## Alternativas

- **Mover sin cifrar:** simple, pero el archivo sigue siendo ejecutable y otros antivirus lo vuelven a detectar en la bóveda. No detecta corrupción.
- **XOR con una clave fija:** neutraliza, pero no detecta corrupción y es trivial de revertir por error. No aporta nada frente a GCM, que ya viene en `node:crypto`.
- **ZIP con contraseña:** requiere una dependencia nueva. El cifrado ZIP clásico es débil y la extracción puede devolver el ejecutable a disco sin verificar el hash.
- **Borrar directamente:** irreversible. Un falso positivo destruiría un archivo legítimo sin posibilidad de restaurarlo (RF-12).

## Consecuencias

- Se aprueban la **migración 005** (`quarantine_items`, `audit_log`, `allowlist`), el IPC `quarantine.*` y la allowlist de hashes, que `RiskPolicy` evalúa antes que todo lo demás (origen `USER_ALLOWLIST`; decisión humana, coherente con ADR-004).
- Las pruebas de fallo son obligatorias: TOCTOU, original bloqueado, cierre en `PENDING`, blob corrupto, path traversal, colisión al restaurar, ruta protegida y dos operaciones simultáneas (Map de operaciones en curso).
- La bóveda ocupa aproximadamente el mismo espacio que el original. Quien tenga acceso a la BD puede descifrar los blobs; esto es aceptable porque el objetivo no es el secreto.
- Defender u otro proceso puede bloquear o borrar el original antes del paso 6. En ese caso el registro termina en `FAILED` y no queda blob.
- **Nunca:** cambiar ACL, pedir admin, tocar archivos del sistema, actuar sin confirmación ni borrar un original sin que su copia esté antes verificada en la bóveda.
- Este ADR aprueba el diseño; la implementación corresponde a T4.2–T4.5.
