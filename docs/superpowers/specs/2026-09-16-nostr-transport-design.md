# AgentBridge 0.2 — sin servidor propio, sobre tableros públicos (Nostr)

Fecha: 2026-09-16 · Estado: revisión 2, tras la auditoría de Codex (15 hallazgos incorporados).
Pendiente de revisión escrita.

## Objetivo

Que **cualquier persona, incluidos desconocidos, use AgentBridge sin contratar ni operar un
servidor**: ni quien lo mantiene, ni quien pregunta, ni quien contesta. Lo único que necesita cada
quien es su computadora, Node 22.13 o más nuevo y Claude Code.

Hoy (0.1.x) todo pasa por un relay propio en Render (Fastify + Postgres) que cuesta $10.50 al mes,
exige un `ADMIN_TOKEN` para dar de alta a cada persona, deja que su operador lea todas las preguntas
y respuestas, y además **administra los turnos**: una pregunta a la vez, intentos con tiempo límite,
reintentos y cancelaciones. La 0.2 lo reemplaza por **tableros públicos de Nostr** (servidores de
mensajes que opera la comunidad, gratuitos, donde se dejan sobres cerrados) y mueve esa
administración de turnos a la computadora de quien contesta.

### Criterios de éxito

1. Dos personas en redes distintas, sin servidor propio, completan: compartir enlace → solicitud →
   aprobación → pregunta → acuse → respuesta.
2. Si la computadora de quien contesta está apagada, una pregunta admitida se contesta al prenderse,
   siempre que algún tablero haya conservado el sobre. Si la de quien pregunta está apagada, la
   respuesta se recupera al prenderse con la misma condición. Los reintentos cubren pérdidas
   parciales.
3. Revocar un permiso es atómico: después de `revoke` no se entrega a Claude ninguna pregunta de esa
   persona ni se publica ninguna respuesta nueva para ella.
4. Ningún tablero ni quien mantiene el proyecto puede leer el contenido, y el evento público no
   revela al remitente (ver los límites exactos en "Privacidad: qué se garantiza y qué no").
5. Dos o más procesos (canal, servidor MCP, CLI) usando la misma identidad no pierden ni duplican
   estado.
6. Las pruebas automáticas corren sin internet y sin Docker.
7. El servicio y la base de datos de Render se borran y dejan de cobrar.

## Evidencia: prueba desechable del 2026-09-16

Se publicaron sobres NIP-59 (kind 1059) con llaves de usar y tirar en 9 tableros públicos
gratuitos, usando `nostr-tools` 2.25.2. El código de la prueba no se conserva.

| Pregunta | Resultado |
|---|---|
| ¿Aceptan sobres sin pago ni registro? | 7 de 9 (uno no conectó; otro exige AUTH NIP-42 y el intento falló por configuración del propio tablero) |
| ¿Dejan leerlos sin autenticarse? | Sí, los 7 |
| Latencia con quien contesta escuchando | 0.2–1 s |
| ¿Se recuperan con una conexión nueva? | Sí, en los 7 |
| ¿Siguen ahí a los 20 minutos? | Sí, 100 % en los 7 |
| ¿Se verifica quién lo mandó? | Sí, el remitente del sello coincide con el de adentro |
| Tamaño en red | 1 KB de texto → 4 KB; 30 KB → 64 KB (rechazado por 3 tableros con tope de 65 536 bytes); 90 KB → 214 KB (solo 3 lo aceptan) |

Veinte minutos **no** validan retención de 24 horas o días. Eso se comprueba en la aceptación
(ver "Migración"), y el diseño asume que un tablero puede perder cualquier sobre.

Tableros que funcionaron: `relay.primal.net`, `relay.snort.social`, `relay.nostr.net`,
`nostr.oxtr.dev`, `nos.lol`, `offchain.pub`, `nostr.mom`.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Punto de encuentro | Tableros públicos Nostr. Sin servidor propio. |
| Relay de Render | Se reemplaza por completo. Se borra el código en la rama 0.2; el despliegue sigue vivo hasta la aceptación. |
| Protocolo | Aplicación propia sobre NIP-59 (seal + gift wrap) con kind interno propio. **No** es NIP-17: no publica kind 10050 ni es legible por apps de chat Nostr. |
| Conexión entre personas | Solicitud y aprobación explícita de quien contesta, con generación de permiso. |
| Enlace para agregarte | Público, no secreto. Localizador sin firma, no prueba de nada. |
| Estado local | SQLite local (`node:sqlite`, incluido en Node) con transacciones. Node mínimo 22.13. |
| Turnos | Un único despachador por identidad, con cola persistente, intentos, tiempo límite y recuperación. |
| Antispam | Prueba de trabajo NIP-13 en todo sobre, verificada antes de descifrar; límites de ritmo y de almacenamiento. |
| AUTH | Soporte NIP-42 para leer y publicar. |
| Disponibilidad | Se contesta solo con la computadora de quien contesta prendida. Admisión de preguntas: 24 h. |
| Piloto actual | Sigue con la 0.1.1; Render sigue prendido hasta validar la 0.2. |

## Privacidad: qué se garantiza y qué no

**Se garantiza:**
- Nadie fuera de las dos personas puede leer preguntas, respuestas, nombres ni notas.
- El evento público no lleva al remitente: quien consulta un tablero ve "un sobre para la llave X"
  firmado por una llave desechable.
- Nadie puede hacerse pasar por un contacto: todo mensaje se acepta solo si el sello está firmado por
  la llave esperada.

**No se garantiza:**
- **Ocultar quién habla con quién frente al operador de un tablero.** Puede correlacionar la IP que
  publica un sobre para X con la IP que después lee los sobres de X, y con AUTH conoce la llave de
  quien lee. Copiar el mismo sobre en varios tableros permite correlación entre tableros.
- **Secreto hacia adelante.** Si alguien roba tu llave, puede descifrar cualquier sobre dirigido a
  ti que algún tablero haya conservado.
- **Borrado.** La etiqueta NIP-40 pide a los tableros borrar a los 7 días, pero no los obliga.
- **Disponibilidad bajo ataque dirigido.** Los límites de este diseño contienen el abuso casual; un
  atacante con recursos puede degradar el servicio para una llave concreta.
- **Protección de la llave frente a programas del mismo usuario.** Los permisos 0600 impiden que la
  lean otros usuarios del sistema, no otros programas tuyos. La sesión encerrada no la lee por sus
  reglas de permisos, igual que hoy con el token del dispositivo; una sesión normal de Claude Code sí
  podría.

## Arquitectura

```
Quien pregunta                          Tableros públicos (Nostr)            Quien contesta
──────────────                          ─────────────────────────            ──────────────
CLI / servidor MCP ── sobres nuevos ──► [ hasta 5 tableros por destino ] ──► canal (plugin) en la
     │                  por intento                                          sesión encerrada
     │                                                                            │
~/.agentbridge/                                                        ~/.agentbridge/
  identity.json   (llave)                                                identity.json
  agentbridge.db  (contactos, preguntas enviadas,                        agentbridge.db (aprobados,
                   cursores)                                              solicitudes, cola, intentos,
                                                                          respuestas, cursores)
                                                                       ~/.agentbridge-responder/
                                                                          perfil de Claude Code
```

El relay era el archivero y el coordinador de turnos. En la 0.2 cada computadora lleva su propio
archivero (SQLite) y el canal de quien contesta asume la coordinación de turnos.

### Qué se va

`apps/relay` completo con sus pruebas y helpers de Postgres, su entrada en `workspaces`,
`render.yaml`, el botón "Deploy to Render", `ADMIN_TOKEN`, `admin enroll-link`, `enroll`, `invite`,
`accept`, `RelayHttpClient` (`packages/core/src/http.ts`), `RelayWsClient`
(`packages/channel/src/relay-client.ts`), `TicketView` y los mensajes de servidor de
`packages/core/src/protocol.ts`, y el script `db:up`. Con ellos desaparecen los pendientes de
`docs/known-gaps.md` que solo existen en el relay.

### Qué se queda igual

Los ajustes de la sesión encerrada (`responderSettings`, `RESPONDER_DENY`,
`blockReadsOutsideWorkingDirectories` anidado en `permissions`), `RESPONDER_PERSONA`, la validación
de `--model` y `--effort`, el escaneo de carpetas peligrosas de `setup`, la herramienta `reply` con
su código de 4 caracteres, `LIMITS.questionMaxChars`, `answerMaxChars`, `sourceMaxChars`,
`maxOpenTicketsPerPair`, `maxTicketsPerPairPerDay` y `attemptTimeoutMs`, y el traductor de errores
`packages/cli/src/spanish-errors.ts`.

### Qué cambia en código existente (no "se queda igual")

- **`setup-responder` y `doctor`:** hoy `startScript()` y `runDoctor()` usan un solo `home` para la
  credencial y para el perfil de Claude Code (`setup-responder.ts:87`, `doctor.ts:150`). Se separan
  en `identityHome` (`~/.agentbridge`) y `profileHome` (`~/.agentbridge-responder`) en ambas APIs,
  en sus opciones de línea de comandos y en `start.sh`, que exporta
  `AGENTBRIDGE_HOME=<identityHome>` y `CLAUDE_CONFIG_DIR=<profileHome>/claude`. Las dos rutas se
  verifican fuera de la carpeta compartida. Desaparece la copia de credenciales entre carpetas que
  hoy hace `setup` (errores C2 y token rancio).
- **Canal:** `RelayConnection` e `InFlight` no bastan, porque `InFlight.start()` sobrescribe la
  pregunta activa (`inflight.ts:25`) y la cola, los tiempos límite y la recuperación vivían en el
  relay. El canal pasa a usar la unidad `dispatcher` (abajo). El texto de `reply` deja de decir
  "Respuesta entregada" (`channel.ts:99`): dice que la respuesta quedó guardada y en envío, porque
  un `OK` de un tablero no significa que la otra persona la recibió. Perder algunos tableros ya no
  cancela la pregunta activa.
- **Servidor MCP de quien pregunta:** `AskerApi` hoy es `Pick<RelayHttpClient, …>` con estados
  `queued/dispatched/…` y `online: boolean` (`mcp-asker.ts:10`, `protocol.ts:24`). Se reemplaza por
  la interfaz `AskerService` con los estados nuevos y sin presencia: Nostr no permite saber si
  alguien está en línea, y las herramientas lo dicen así. Se agrega la herramienta `connect`.

### Unidades nuevas

Cada una con un solo propósito y probable por separado:

1. **`identity`** (`packages/core`): crea la llave secp256k1 en `identity.json` con creación
   exclusiva (`wx`, 0600, carpeta 0700), de modo que dos `setup` simultáneos no generen identidades
   distintas; lee la llave; produce y lee el enlace (`agentbridge:` + `nprofile` NIP-19).
2. **`relay-url`** (`packages/core`): valida direcciones de tableros como entrada hostil.
3. **`envelope`** (`packages/core`): arma y abre sobres, con la tubería de validación y los topes por
   capa de la sección "Protocolo", incluida la prueba de trabajo.
4. **`boards`** (`packages/core`): conexiones a tableros con AUTH NIP-42, publicación, suscripción,
   paginación, límites de ritmo y manejo de `CLOSED`.
5. **`store`** (`packages/core`): SQLite con esquema versionado y transacciones; las máquinas de
   estados se aplican aquí.
6. **`dispatcher`** (`packages/channel`): cola persistente, un único despachador por identidad,
   intentos, tiempo límite y recuperación.
7. **`asker-service`** (`packages/cli`): `AskerService` para CLI y servidor MCP, con reintentos.

## Protocolo

### Mensajes

Todo mensaje es el contenido JSON de un rumor (kind interno propio, fijo) dentro de un sello
(kind 13) dentro de un sobre (kind 1059). El contenido lleva `v: 1`, `type` y `msgId` (uuid del
mensaje lógico, igual en todos sus reintentos).

| `type` | Dirección | Campos propios |
|---|---|---|
| `connect_request` | pregunta → contesta | `requestId`, `name`, `note`, `relays` |
| `connect_approved` | contesta → pregunta | `requestId`, `generation`, `name`, `relays` |
| `connect_rejected` | contesta → pregunta | `requestId` |
| `connect_revoked` | contesta → pregunta | `generation` |
| `question` | pregunta → contesta | `questionId`, `generation`, `text`, `expiresAt` |
| `receipt` | contesta → pregunta | `questionId` |
| `answer` | contesta → pregunta | `questionId`, `text`, `source`, `confidence` |
| `rejected` | contesta → pregunta | `questionId`, `reason`: `expired` \| `limit` \| `unanswered` \| `stale_generation` |

### Tubería de recepción, en este orden

Cada paso es más caro que el anterior; un sobre que falla un paso no llega al siguiente.

1. Tamaño del evento ≤ 64 KB; `kind` 1059; etiqueta `p` igual a mi llave; `created_at` no mayor a
   ahora + 10 min.
2. `id` recalculado igual al declarado, y prueba de trabajo NIP-13 de ese `id` ≥ la dificultad
   configurada (16 bits por defecto).
3. Límite de ritmo: como máximo 120 sobres por minuto por tablero; el excedente se ignora y se
   registra.
4. Firma del sobre válida.
5. Descifrado del sobre; el sello resultante ≤ 48 KB, kind 13, hash y firma válidos.
6. Descifrado del sello; el rumor resultante ≤ 32 KB, kind interno correcto, `id` recalculado,
   `rumor.pubkey === seal.pubkey`.
7. Contenido JSON validado con zod, `v === 1`, campos de texto dentro de `LIMITS` y ≤ 16 KB en UTF-8.
8. Autorización según `type` y remitente (ver "Conexión" y "Entrega"). Cualquier mensaje que no sea
   `connect_request` de una llave sin relación se descarta sin guardar nada.

El envío verifica los mismos topes por capa antes de publicar y devuelve un error en español si se
exceden. Estos topes son propios y pequeños; no dependemos del formato extendido de NIP-44 para
mensajes de más de 65 535 bytes. `nostr-tools` se fija en versión exacta y el plan incluye vectores
de prueba con Unicode y escapes JSON.

### Reintentos y deduplicación

- Cada reintento de un mensaje lógico es un **sobre nuevo** (llave desechable nueva, `created_at`
  nuevo, prueba de trabajo nueva) con el mismo `msgId`. Así un tablero o cliente que ya vio un sobre
  no descarta el reintento.
- La deduplicación de efectos se hace por mensaje lógico con remitente: `(senderPubkey, questionId)`
  para preguntas y sus respuestas, `(senderPubkey, requestId)` para solicitudes. Si llega el mismo
  identificador con contenido distinto, se rechaza y se registra.
- Un reintento de algo ya procesado no repite el efecto, pero **sí regenera** la contestación
  correspondiente como sobre nuevo: `receipt`, `answer` guardada, `rejected`, `connect_approved` o
  `connect_rejected`.
- `expiresAt` debe ser ≤ `rumor.created_at` + 24 h + 10 min de tolerancia de reloj; si no, se
  rechaza con `expired`.

## Direcciones de tableros

Las direcciones que llegan en enlaces y solicitudes son **entradas hostiles**. `relay-url` acepta una
dirección solo si:

- el esquema es `wss://`, sin usuario, contraseña, consulta ni fragmento, y mide ≤ 200 caracteres;
- el host es un nombre de dominio, no una IP literal;
- al momento de conectar, el nombre resuelve solo a direcciones públicas: se rechazan loopback,
  privadas, link-local, CGNAT, ULA y multicast;
- la conexión no sigue redirecciones.

Máximo 5 por contacto. Las direcciones de un `nprofile` son un localizador sin firma. Solo cambian
por un mensaje autenticado del propio contacto (`connect_request` o `connect_approved`).

## Tableros: conexión, lectura y cursores

- **AUTH NIP-42:** al recibir un reto `AUTH`, se responde firmando con la llave propia. Un `CLOSED`
  o `OK false` con prefijo `auth-required:` provoca autenticación y un reintento de la suscripción o
  publicación.
- **Éxito de publicación:** al menos 1 tablero respondió `OK true`. Si ninguno, el mensaje queda en
  la bandeja de salida (`outbox`) y se reintenta con espera creciente.
- **Cursores:** uno por tablero y por papel (pregunta, contesta), en SQLite. El cursor guarda la hora
  local de la última `EOSE` cuyos eventos ya se persistieron; nunca avanza antes de persistir. La
  siguiente suscripción usa `since = cursor − 2 días − 10 min`, porque NIP-59 pone fechas al azar
  hasta 2 días atrás. `since` filtra por `created_at`, no por hora de llegada al tablero, así que la
  deduplicación hace inofensivo releer.
- **Recuperación larga:** en la primera ejecución o tras más de 2 días sin cursor, se lee hacia atrás
  por ventanas de 1 día con `until` y `limit`, hasta 7 días, para que el límite de resultados de un
  tablero no trunque el historial.
- **`doctor`:** por cada tablero, publica un sobre dirigido a la propia llave y lo vuelve a leer.
  "Responde" significa que se pudo publicar **y** leer, no solo conectar.

## Conexión entre personas

### Flujo

1. Quien contesta corre `setup`: se crea su llave y se muestra su enlace (también con `link`).
2. Quien pregunta corre `connect <enlace> --note "…"` o se lo pide a su Claude Code (herramienta MCP
   `connect`). Se genera `requestId`, se guarda el contacto como `pending` y se envía
   `connect_request`, que se reintenta hasta recibir `connect_approved` o `connect_rejected`, o
   durante 7 días.
3. El canal de quien contesta guarda la solicitud y lanza una notificación del sistema con **texto
   fijo** ("AgentBridge: tienes solicitudes nuevas"), sin interpolar nombre ni nota, invocada con
   argumentos sin shell (macOS `osascript`; Linux `notify-send` si existe). Solicitudes del mismo
   minuto producen un solo aviso.
4. `requests` lista cada solicitud con un **identificador estable** (los primeros 8 caracteres de la
   llave del solicitante), nombre declarado, nota y el aviso "si lo apruebas, podrá leer tu carpeta
   compartida". `approve <id>` o `reject <id>`; un índice numérico no se acepta porque la lista
   puede cambiar entre listar y aprobar.
5. Aprobar, en una transacción: incrementa la `generation` de ese contacto, lo marca `approved`,
   asigna un nombre local válido para `HandleSchema` y encola `connect_approved`.

### Revocación atómica

`revoke <nombre>`, en una sola transacción: marca el contacto `revoked`, incrementa `generation`,
cancela todas las preguntas de ese contacto que no estén contestadas y encola `connect_revoked`.

- El despachador toma la siguiente pregunta **dentro de una transacción** que verifica que el
  contacto sigue `approved` con la misma `generation` con la que se admitió la pregunta.
- Antes de encolar una respuesta para publicar, otra transacción verifica lo mismo. Si falla, la
  respuesta se descarta y la pregunta activa se cancela en Claude, como hoy con `cancel` por
  `revoked`.
- Volver a aprobar crea una `generation` nueva: las preguntas de la generación anterior no
  resucitan y se contestan con `rejected` / `stale_generation` si llegan otra vez.
- Las respuestas guardadas no se reenvían a un contacto revocado.
- Revocar **no** retira sobres ya publicados ni respuestas que la otra persona ya recibió.

### Estados del contacto

| Lado | Estados | Reglas |
|---|---|---|
| Quien contesta | `requested` → `approved(g)` \| `rejected`; `approved(g)` → `revoked(g+1)` → `approved(g+2)` | Solo `approve`, `reject` y `revoke` cambian el estado |
| Quien pregunta | `pending` → `approved(g)` \| `rejected`; `approved(g)` → `revoked(g')` | Se ignora cualquier mensaje con `generation` menor o igual a la última revocación conocida |

## Entrega de preguntas y respuestas

### Admisión, en quien contesta

Una transacción, al recibir un `question` válido de un contacto:

1. Si `(senderPubkey, questionId)` ya existe: regenerar lo que corresponda a su estado (`receipt`,
   `answer` guardada o `rejected`) y terminar.
2. Si el contacto no está `approved` con esa `generation`: `rejected` / `stale_generation` si hubo
   una generación anterior; si nunca hubo relación, descartar en silencio.
3. Si expiró: `rejected` / `expired`.
4. Si excede 5 abiertas o 20 por día para ese contacto: `rejected` / `limit`.
5. Si no: persistir en la cola como `queued` y **después** encolar `receipt`.

### Despachador

- **Un solo despachador por identidad:** el proceso del canal toma un arrendamiento en SQLite
  (`dispatcher_lease`, con dueño y latido cada 15 s, vencido a los 60 s). Otro canal con la misma
  identidad sigue admitiendo y guardando, pero no entrega preguntas a Claude.
- **Una a la vez:** toma la pregunta `queued` más antigua, crea un intento con `attemptId` y código de
  4 caracteres, la marca `dispatched` y la manda a Claude.
- **Tiempo límite:** si Claude no llama `reply` en `attemptTimeoutMs` (10 min), se cancela el intento
  en Claude y la pregunta vuelve a `queued`. Tras 2 intentos fallidos pasa a `unanswered` y se encola
  `rejected` / `unanswered`.
- **Recuperación:** al arrancar, los intentos `dispatched` vencidos vuelven a `queued`.
- **Respuesta:** `reply` valida el código, y en una transacción verifica el permiso, guarda la
  respuesta, marca la pregunta `answered` y encola `answer`. La respuesta se guarda 7 días.
- **Tableros caídos:** no cancelan la pregunta activa. Las respuestas esperan en `outbox` hasta
  poder publicarse.

### Reintentos de quien pregunta

Mientras corre algún cliente (`ask`, `ticket`, `contacts` o el servidor MCP abierto), quien pregunta
reenvía con sobre nuevo toda pregunta que no esté en un estado final: cada 5 min la primera hora,
después cada 30 min, hasta 7 días desde el envío. **Recibir el acuse no detiene los reintentos**:
solo los detiene `answer` o `rejected`. Si quien contesta ya respondió, cada reintento regenera la
respuesta guardada, sin volver a llamar a Claude.

### Estados de la pregunta, en quien pregunta

| Desde | Evento | Hacia |
|---|---|---|
| `sending` | al menos 1 tablero aceptó | `sent` |
| `sending` / `sent` | llega `receipt` autenticado | `received` |
| `sending` / `sent` / `received` | llega `answer` autenticado | `answered` (final) |
| `sending` / `sent` / `received` | llega `rejected` autenticado | `rejected` (final) |
| `sending` / `sent` / `received` | 7 días sin estado final | `lost` (final) |

Las transiciones ocurren dentro de transacciones que leen el estado actual. Un estado final nunca
cambia. Un `answer` válido gana aunque llegue después de las 24 h, porque la admisión la decide quien
contesta. Los textos para Claude y la terminal distinguen "recibida" (llegó a su computadora) de
"contestada".

## Estado local

Una sola carpeta de identidad y estado, `~/.agentbridge` (o `AGENTBRIDGE_HOME`), 0700, para preguntar
y contestar:

- `identity.json`, 0600, creado con `wx`.
- `agentbridge.db`, SQLite en modo WAL con `busy_timeout`. Los archivos `-wal` y `-shm` se crean con
  `umask 077`.

Tablas principales:

| Tabla | Contenido |
|---|---|
| `contacts` | llave, nombre local, papel, estado, `generation`, tableros |
| `requests` | solicitudes entrantes pendientes |
| `inbox_questions` | preguntas recibidas, estado, `generation`, respuesta guardada |
| `attempts` | intentos del despachador |
| `outbox_questions` | preguntas enviadas y su estado |
| `outbox` | mensajes por publicar, con reintentos |
| `cursors` | último visto por tablero y papel |
| `dispatcher_lease` | dueño actual del despacho |
| `schema_version` | versión del esquema |

Toda operación de lectura-modificación-escritura corre en una transacción `BEGIN IMMEDIATE`.
`(senderPubkey, questionId)` y `(senderPubkey, requestId)` son claves únicas. Se requiere Node
≥ 22.13, donde `node:sqlite` no necesita bandera; si Node emite un `ExperimentalWarning` de SQLite, el
CLI filtra solo ese aviso. Una limpieza periódica borra respuestas guardadas, solicitudes y mensajes
enviados de más de 7 días.

## Seguridad y abuso

- **Antes de descifrar:** tamaño, kind, destinatario, fecha, prueba de trabajo de 16 bits, firma y
  límite de ritmo por tablero. Descifrar solo ocurre para sobres que pasan esos filtros.
- **Solicitudes:** una pendiente por llave; máximo 20 en total. Si la lista está llena, **se desaloja
  la más antigua** en vez de bloquear las nuevas. Una llave rechazada en los últimos 7 días se ignora.
  Las solicitudes de más de 7 días se borran.
- **Sin relación:** cualquier mensaje que no sea `connect_request` de una llave sin relación se
  descarta sin guardar ni contestar, así que no cuesta tokens y no sirve para rebotar spam.
- **Memoria y disco acotados:** cachés de deduplicación en memoria con tope; filas acotadas por los
  límites por contacto, el tope de solicitudes y la limpieza de 7 días.
- **Suplantación y repetición:** tubería de recepción completa, claves únicas por remitente y
  `expiresAt` acotado.
- **Direcciones de tableros:** ver "Direcciones de tableros".
- **Notificaciones:** texto fijo, sin datos de terceros, sin shell.
- **Instrucciones tramposas en preguntas:** sin cambios; la sesión encerrada sigue sin `Bash`, sin
  edición y sin lectura fuera de la carpeta.
- **Errores:** ningún mensaje de error ni registro incluye la llave, contenido descifrado de
  terceros ni rutas de la carpeta compartida.

## Cambios por componente

- **CLI:** nuevos `link`, `connect`, `requests`, `approve <id>`, `reject <id>`; `revoke`,
  `contacts`, `ask`, `ticket` y `whoami` pasan a SQLite y tableros; se borran `enroll`, `invite`,
  `accept` y `admin`. `setup` ya no pide enlace de alta: crea la llave y, según el papel, muestra tu
  enlace o pide el de la persona a quien quieres preguntar. Los comandos se nombran en inglés, como
  hoy.
- **`setup-responder` y `doctor`:** `identityHome` y `profileHome` separados. `doctor` revisa: llave
  presente, 0600 y fuera de la carpeta compartida; carpeta 0700; base de datos accesible; por cada
  tablero, publicar **y** leer; solicitudes pendientes; y lo que ya revisa de la sesión encerrada.
- **Canal:** `dispatcher` en lugar de `RelayWsClient` + `InFlight`; notificación de solicitudes; texto
  de `reply` corregido.
- **Servidor MCP de quien pregunta:** `AskerService`; herramientas `list_contacts` (sin presencia),
  `ask_contact`, `check_answer` (estados nuevos) y `connect`.
- **Documentación:** README, `docs/inicio-rapido.md`, `docs/runbooks/m1-acceptance.md` y
  `docs/known-gaps.md` reescritos para el flujo sin Render, con la sección de privacidad de este
  documento. El `CLAUDE.md` del proyecto deja de pedir Docker Postgres.
- **Dependencias:** `nostr-tools` en versión exacta, empaquetada por esbuild en ambos bundles.
  `engines.node` pasa a `>=22.13`.
- **Versión:** 0.2.0. Quien use 0.1.x vuelve a correr `setup`; no hay migración automática.

## Pruebas

**Tablero falso en memoria** (NIP-01 sobre WebSocket) con: `EVENT`, `REQ` con `kinds`, `#p`,
`since`, `until` y `limit`, `CLOSE`, `EOSE`, `OK`, `CLOSED`, AUTH NIP-42 obligatorio configurable,
rechazo por tamaño, tope de resultados, y modos de falla para perder eventos, aceptar publicaciones
sin permitir lectura y desconectar a mitad de una suscripción.

**Unitarias:** `identity` (enlace de ida y vuelta, creación exclusiva), `relay-url` (cada rango de
direcciones prohibido, esquemas, longitudes), `envelope` (cada paso de la tubería de recepción en su
orden, topes por capa con vectores Unicode y escapes JSON, prueba de trabajo), `store` (cada
transición permitida y prohibida de las tablas de estados).

**Integración, sin internet:**
- Flujo completo: solicitud → aprobación → pregunta → acuse → respuesta.
- Quien contesta apagado y luego prendido; quien pregunta apagado y luego prendido.
- Sobre perdido en 4 de 5 tableros; respuesta perdida en todos después del acuse (se recupera por
  reintento); acuse perdido.
- Caída del canal después del acuse y antes de contestar; caída después de guardar la respuesta y
  antes de publicarla.
- Revocación con preguntas en cola, con una pregunta activa y con una respuesta a punto de
  publicarse; volver a aprobar sin resucitar preguntas.
- Mismo `questionId` con contenido distinto; sobre de llave sin relación (no llega a Claude ni se
  guarda); pregunta expirada; límites por contacto; lista de solicitudes llena (desalojo).
- Tablero que exige AUTH para leer; tablero que acepta publicar pero rechaza leer (`doctor` lo marca);
  tablero que rechaza por tamaño; recuperación larga con paginación y reloj simulado.
- Dirección de tablero hostil en un enlace y en una solicitud.

**Multiproceso:** dos procesos reales de Node sobre la misma carpeta: `approve` y `revoke`
concurrentes con admisión; dos canales compitiendo por el arrendamiento; CLI y servidor MCP
actualizando la misma pregunta; dos `setup` simultáneos creando identidad.

**Fallas de persistencia:** base de datos de solo lectura y disco lleno simulado: nada se publica sin
haberse guardado antes.

**En vivo, opcional** (`npm run test:live`, fuera de `npm test`): ida y vuelta completa contra
tableros públicos reales y medición de límites de publicación al mandar 5 copias.

**Aceptación manual:** los 8 escenarios de seguridad de la sesión encerrada; prueba real entre dos
personas en redes distintas; y una **prueba de 24 horas** con quien contesta apagado durante la noche
antes de apagar Render.

## Migración y apagado de Render

1. Etiquetar el estado actual como `v0.1.1`. Render sigue desplegado desde ahí; el piloto con la
   0.1.1 continúa.
2. En la rama 0.2, **primero** borrar `apps/relay`, sus pruebas y helpers, su entrada en `workspaces`,
   `render.yaml`, `db:up`, y las suites que importan helpers de Postgres (por ejemplo
   `tests/e2e/pipe.test.ts`), para que `npm test` corra sin Docker desde el inicio.
3. Construir la 0.2.0 unidad por unidad; `npm test` en verde en cada paso.
4. `npm run test:live` en verde.
5. Aceptación manual, incluida la prueba de 24 horas.
6. Publicar la 0.2.0 en npm y fusionar la rama.
7. Borrar en Render el servicio `agentbridge-relay` y su base de datos (acción irreversible, se
   confirma con el dueño antes) y quitar `ADMIN_TOKEN` del Llavero.

## Fuera de alcance (0.2)

Respaldo de la llave y varios dispositivos por identidad; secreto hacia adelante; nombres legibles
NIP-05; descubrimiento de tableros por kind 10050 y compatibilidad con apps NIP-17; quien contesta en
la nube con la computadora apagada; tableros de pago; cliente web o móvil; ajuste automático de la
dificultad de la prueba de trabajo.

## Riesgos

- **Tableros de la comunidad:** pueden cerrar, limitar o empezar a exigir pago para kind 1059.
  Mitigación: hasta 5 tableros por destino, lista configurable, AUTH soportado y `doctor` probando
  publicar y leer.
- **Retención real desconocida más allá de 20 minutos.** Mitigación: reintentos con sobre nuevo
  durante 7 días y la prueba de 24 horas antes de apagar Render.
- **Límites de publicación de los tableros** con 5 copias por mensaje y reintentos: se miden en
  `test:live`; si hace falta, bajar a 3 copias.
- **`node:sqlite`** es relativamente nuevo en Node: se fija el mínimo en 22.13 y las pruebas
  multiproceso lo cubren.
- **Costo de la prueba de trabajo** en computadoras lentas: 16 bits por defecto; se mide en las
  pruebas.
- **Canal de Claude Code** sigue requiriendo `--dangerously-load-development-channels`, igual que en
  la 0.1.
- **IP y llave visibles** para los tableros a los que te conectas (ver "Privacidad").
