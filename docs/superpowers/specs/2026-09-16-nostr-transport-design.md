# AgentBridge 0.2 — sin servidor propio, sobre tableros públicos (Nostr)

Fecha: 2026-09-16 · Estado: revisión 4, tras tres auditorías de Codex. Pendiente de revisión escrita.

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
2. Si la computadora de quien contesta está apagada, una pregunta enviada en las últimas 24 h se
   contesta al prenderse, siempre que algún tablero haya conservado el sobre. Si la de quien pregunta
   está apagada, la respuesta se recupera al volver a usar cualquier cliente, con la misma condición.
3. Revocar cumple el contrato de "Revocación" sin excepciones fuera de la ventana documentada.
4. Ningún tablero ni quien mantiene el proyecto puede leer el contenido, y el evento público no
   revela al remitente, con los límites de "Privacidad: qué se garantiza y qué no".
5. Canal, servidor MCP y CLI usando la misma identidad no pierden, duplican ni contradicen estado.
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

Veinte minutos **no** validan retención de 24 horas o días. Eso se comprueba en la aceptación, y el
diseño asume que un tablero puede perder cualquier sobre.

Tableros que funcionaron: `relay.primal.net`, `relay.snort.social`, `relay.nostr.net`,
`nostr.oxtr.dev`, `nos.lol`, `offchain.pub`, `nostr.mom`.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Punto de encuentro | Tableros públicos Nostr. Sin servidor propio. |
| Relay de Render | Se reemplaza por completo. Se borra el código en la rama 0.2; el despliegue sigue vivo hasta la aceptación. |
| Protocolo | Aplicación propia sobre NIP-59 (seal + gift wrap) con kind interno propio. **No** es NIP-17. |
| Conexión entre personas | Solicitud y aprobación explícita de quien contesta, con generaciones de permiso estrictamente crecientes. |
| Enlace para agregarte | Público, no secreto. Localizador sin firma. |
| Estado local | SQLite local (`node:sqlite`) con transacciones. Node mínimo 22.13. |
| Turnos | **Un solo canal por identidad**, con bloqueo exclusivo durante toda su vida. Un segundo canal se niega a arrancar. |
| Antispam | Prueba de trabajo NIP-13 **fija en el protocolo**: 16 bits en todo sobre y 22 bits en solicitudes de conexión. No configurable en 0.2. |
| AUTH | Soporte NIP-42 para leer y publicar. |
| Disponibilidad | Se contesta solo con la computadora de quien contesta prendida. Admisión de preguntas: 24 h desde su creación. |
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
- **Disponibilidad bajo ataque dirigido.** Los límites contienen el abuso casual; un atacante con
  recursos puede degradar el servicio para una llave concreta, incluido desplazar solicitudes
  legítimas.
- **Protección de la llave frente a programas del mismo usuario.** Los permisos 0600 impiden que la
  lean otros usuarios del sistema, no otros programas tuyos. La sesión encerrada no la lee por sus
  reglas de permisos, igual que hoy con el token del dispositivo; una sesión normal de Claude Code sí
  podría.

## Arquitectura

```
Quien pregunta                          Tableros públicos (Nostr)            Quien contesta
──────────────                          ─────────────────────────            ──────────────
CLI (sincroniza y cierra) ── sobres ──► [ hasta 5 tableros por destino ] ──► canal (plugin) en la
servidor MCP (persistente)                                                   sesión encerrada:
     │                                                                       dueño exclusivo del
~/.agentbridge/                                                              despacho
  identity.json                                                                   │
  agentbridge.db                                                         ~/.agentbridge/
                                                                           identity.json
                                                                           agentbridge.db
                                                                         ~/.agentbridge-responder/
                                                                           perfil de Claude Code
```

El relay era el archivero y el coordinador de turnos. En la 0.2 cada computadora lleva su propio
archivero (SQLite) y el canal de quien contesta asume la coordinación de turnos.

### Qué se va

`apps/relay` completo con sus pruebas y helpers de Postgres, su entrada en `workspaces`,
`render.yaml`, el botón "Deploy to Render", `ADMIN_TOKEN`, `admin enroll-link`, `enroll`, `invite`,
`accept`, `RelayHttpClient` (`packages/core/src/http.ts`), `RelayWsClient`
(`packages/channel/src/relay-client.ts`), `InFlight` (`packages/channel/src/inflight.ts`),
`TicketView` y los mensajes de servidor de `packages/core/src/protocol.ts`, y el script `db:up`. Con
ellos desaparecen los pendientes de `docs/known-gaps.md` que solo existen en el relay.

### Qué se queda igual

Los ajustes de la sesión encerrada (`responderSettings`, `RESPONDER_DENY`,
`blockReadsOutsideWorkingDirectories` anidado en `permissions`), `RESPONDER_PERSONA`, la validación
de `--model` y `--effort`, el escaneo de carpetas peligrosas de `setup`, la herramienta `reply` con
su código de 4 caracteres, `LIMITS.questionMaxChars`, `answerMaxChars`, `sourceMaxChars`,
`maxOpenTicketsPerPair`, `maxTicketsPerPairPerDay` y `attemptTimeoutMs`, y el traductor de errores
`packages/cli/src/spanish-errors.ts`.

### Qué cambia en código existente

- **`setup-responder` y `doctor`:** hoy `startScript()` y `runDoctor()` usan un solo `home` para la
  credencial y para el perfil de Claude Code (`setup-responder.ts:87`, `doctor.ts:150`). Se separan
  en `identityHome` (`~/.agentbridge`) y `profileHome` (`~/.agentbridge-responder`) en ambas APIs,
  en sus opciones de línea de comandos y en `start.sh`, que exporta
  `AGENTBRIDGE_HOME=<identityHome>` y `CLAUDE_CONFIG_DIR=<profileHome>/claude`. Las dos rutas se
  verifican fuera de la carpeta compartida. Desaparece la copia de credenciales entre carpetas que
  hoy hace `setup`.
- **Canal:** el estado en memoria que `reply` consulta hoy antes de enviar (`channel.ts:89`) se
  sustituye por transacciones en SQLite (ver "Despacho"). El texto de `reply` deja de decir
  "Respuesta entregada" (`channel.ts:99`): dice que la respuesta quedó guardada y en envío. Perder
  tableros no cancela la pregunta activa.
- **Servidor MCP de quien pregunta:** `AskerApi` hoy es `Pick<RelayHttpClient, …>` con estados
  `queued/dispatched/…` y `online: boolean` (`mcp-asker.ts:10`, `protocol.ts:24`). Se reemplaza por
  `AskerService`, con los estados nuevos y sin presencia: Nostr no permite saber si alguien está en
  línea y las herramientas lo dicen así. Se agrega la herramienta `connect`.
- **CLI:** `ask` y `ticket` (`ask.ts:61`) usan el ciclo de sincronización de "Clientes de corta
  vida".
- **Empaquetado:** `scripts/pack.mjs:90` fija hoy `engines` por su cuenta en `>=22.4`; pasa a
  `>=22.13`, igual que el `package.json` raíz.

### Unidades nuevas

Cada una con un solo propósito y probable por separado:

1. **`identity`** (`packages/core`): crea la llave secp256k1 escribiendo un archivo temporal completo
   (0600) y enlazándolo con `link()` a `identity.json`, que falla si ya existe: dos `setup`
   simultáneos no generan identidades distintas ni dejan un archivo a medias. Lee la llave; produce y
   lee el enlace (`agentbridge:` + `nprofile` NIP-19).
2. **`relay-url`** (`packages/core`): valida direcciones de tableros como entrada hostil y provee la
   función de resolución que usa el propio socket.
3. **`envelope`** (`packages/core`): arma y abre sobres con la tubería de recepción y los topes por
   capa. La prueba de trabajo corre en un `worker_thread`.
4. **`boards`** (`packages/core`): conexiones con AUTH NIP-42, publicación, suscripción en vivo,
   recuperación histórica paginada, contrapresión y manejo de `CLOSED`.
5. **`store`** (`packages/core`): SQLite con esquema versionado; las máquinas de estados, las claves
   únicas y los reclamos transaccionales viven aquí.
6. **`dispatcher`** (`packages/channel`): bloqueo exclusivo del canal, cola, intentos, tiempo límite
   y recuperación.
7. **`asker-service`** (`packages/cli`): `AskerService` para CLI y servidor MCP.

## Protocolo

### Mensajes

Todo mensaje es el contenido JSON de un **rumor** (kind interno propio, fijo) dentro de un sello
(kind 13) dentro de un sobre (kind 1059). El contenido lleva `v: 1` y `type`.

| `type` | Dirección | Campos propios |
|---|---|---|
| `connect_request` | pregunta → contesta | `requestId`, `name`, `note`, `relays` |
| `connect_approved` | contesta → pregunta | `requestId`, `generation`, `name`, `relays` |
| `connect_rejected` | contesta → pregunta | `requestId` |
| `connect_revoked` | contesta → pregunta | `generation` |
| `question` | pregunta → contesta | `questionId`, `generation`, `text` |
| `receipt` | contesta → pregunta | `questionId` |
| `answer` | contesta → pregunta | `questionId`, `text`, `source`, `confidence` |
| `rejected` | contesta → pregunta | `questionId`, `reason`: `expired` \| `limit` \| `unanswered` \| `stale_generation` |

### Identidad de mensajes y reintentos

- **Identidad del mensaje:** `(senderPubkey, rumor.id)`. El `id` del rumor cubre contenido, tipo,
  autor y `created_at`.
- **Un reintento reusa el mismo rumor** (mismo `id`, misma fecha) dentro de un sello y un sobre
  **nuevos** (llave desechable nueva, prueba de trabajo nueva). Así ningún tablero ni cliente descarta
  el reintento como duplicado de sobre, y el receptor lo reconoce como el mismo mensaje.
- **Identidad de la entidad:** `(senderPubkey, questionId)` para una pregunta y
  `(senderPubkey, requestId)` para una solicitud. Sus campos inmutables son el `rumor.id` de la
  pregunta o solicitud original, su texto y su `generation`. Si llega otro rumor distinto con la misma
  identidad de entidad, se descarta y se registra; no altera nada.
- **Respuestas de quien contesta:** una sola decisión por pregunta, guardada antes de enviarse:
  `receipt` puede coexistir con exactamente una de `answer` o `rejected`, nunca con ambas. Los
  rumores de respuesta se guardan y cada regeneración reenvía **el mismo rumor** en sobre nuevo.

### Fechas

- `created_at` del sobre ≤ ahora + 10 min.
- `rumor.created_at` ≤ ahora + 10 min al recibirlo por primera vez.
- Una pregunta vence en `rumor.created_at` + 24 h. El remitente no puede elegir otra fecha: el campo
  no existe. Como `rumor.created_at` no puede estar en el futuro y los reintentos reusan el rumor, los
  reintentos no renuevan el plazo.
- Una `connect_request` se acepta solo si su `rumor.created_at` tiene como máximo 7 días.
- Las **decisiones de mensajes** (claves de entidad y decisión final de cada pregunta y solicitud) se
  conservan **9 días** (7 de retención más 2 de fechas aleatorias de NIP-59). El contenido de
  preguntas y respuestas se borra a los 7 días. Un reintento que llegue después de 9 días cae fuera
  del plazo por su propia fecha.
- El **estado del contacto** (contador de `generation`, estado del permiso, máxima generación
  observada y tableros) **nunca caduca**: se conserva mientras exista la identidad.

### Tubería de recepción, en este orden

Cada paso es más caro que el anterior; un sobre que falla un paso no llega al siguiente.

1. Tamaño del evento ≤ 64 KB; `kind` 1059; etiqueta `p` igual a mi llave; `created_at` válido.
2. `id` recalculado igual al declarado y prueba de trabajo NIP-13 de ese `id` ≥ 16 bits.
3. Deduplicación de sobre por `id` en una caché acotada.
4. Firma del sobre válida.
5. Entrada en la **cola de descifrado**: acotada a 200 sobres, un descifrado a la vez. Si la cola está
   llena, `boards` deja de leer de ese tablero (contrapresión) en lugar de descartar.
6. Descifrado del sobre; el sello ≤ 40 KB, kind 13, hash y firma válidos.
7. Descifrado del sello; el rumor ≤ 28 KB, kind interno correcto, `id` recalculado,
   `rumor.pubkey === seal.pubkey`, fecha válida.
8. Contenido JSON validado con zod, `v === 1`, textos dentro de `LIMITS` y ≤ 16 KB en UTF-8.
9. Si es `connect_request`: prueba de trabajo del sobre ≥ 22 bits.
10. Autorización según `type` y remitente. Cualquier mensaje que no sea `connect_request` de una llave
    sin relación se descarta sin guardar nada.

El envío verifica los mismos topes por capa antes de publicar y devuelve un error en español si se
exceden. Estos topes son propios y pequeños; no dependemos del formato extendido de NIP-44 para
mensajes de más de 65 535 bytes. `nostr-tools` se fija en versión exacta y el plan incluye vectores
de prueba con Unicode y escapes JSON.

## Direcciones de tableros

Las direcciones que llegan en enlaces y solicitudes son **entradas hostiles**. `relay-url` acepta una
dirección solo si:

- el esquema es `wss://`, sin usuario, contraseña, consulta ni fragmento, y mide ≤ 200 caracteres;
- el host es un nombre de dominio, no una IP literal;
- la conexión no sigue redirecciones.

La resolución DNS se valida **dentro de la función `lookup` que usa el propio socket**: se rechazan
loopback, privadas, link-local, CGNAT, ULA y multicast, y el socket se conecta a la misma dirección
validada, sin una segunda resolución que permita DNS rebinding. TLS se verifica contra el nombre del
host.

Máximo 5 por contacto. Las direcciones de un `nprofile` son un localizador sin firma. Solo cambian
por un mensaje autenticado del contacto cuya `generation` sea ≥ la máxima observada (o por su
`connect_request` mientras está pendiente).

## Tableros: conexión, lectura y cursores

- **AUTH NIP-42:** al recibir un reto `AUTH`, se responde firmando con la llave propia. Un `CLOSED` o
  `OK false` con prefijo `auth-required:` provoca autenticación y un reintento.
- **Éxito de publicación:** al menos 1 tablero respondió `OK true`.
- **Recepción en vivo:** suscripción con `since = ahora − 2 días − 10 min` al conectar. Nunca descarta
  por ritmo: aplica contrapresión.
- **Recuperación histórica**, separada de la recepción en vivo: cubre hasta 9 días hacia atrás por
  ventanas de 1 día. Dentro de cada ventana pagina con `until` y `limit` = 200: si llegan 200
  resultados, repite con `until` = la fecha más antigua que el tablero garantiza haber enviado
  completa (incluida; el traslape se deduplica), sin contar sobres ajenos que lleguen antes de
  `EOSE`. Si los 200 comparten el mismo segundo, repite con `limit` 400 y luego 800; si aún no
  alcanza, la ventana queda marcada **incompleta** y se reintenta más tarde.
  Cada ventana tiene un presupuesto de 250 consultas; al agotarlo queda incompleta.
- **Cursores:** uno por tablero y por papel, en SQLite. Registran qué ventanas están completas. Una
  ventana solo se marca completa después de persistir todo lo recibido en ella; `EOSE` por sí solo no
  demuestra que esté completa.
- **`doctor`:** por cada tablero, publica un sobre dirigido a la propia llave y lo vuelve a leer.
  "Responde" significa que se pudo publicar **y** leer.

## Conexión entre personas

### Flujo

1. Quien contesta corre `setup`: se crea su llave y se muestra su enlace (también con `link`).
2. Quien pregunta corre `connect <enlace> --note "…"` o se lo pide a su Claude Code (herramienta MCP
   `connect`). Se genera `requestId`, se guarda el contacto como `pending` y se encola
   `connect_request` con prueba de trabajo de 22 bits (unos segundos, una vez). Se reintenta hasta
   recibir `connect_approved` o `connect_rejected`, o durante 7 días.
3. El canal de quien contesta guarda la solicitud y lanza una notificación del sistema con **texto
   fijo** ("AgentBridge: tienes solicitudes nuevas"), sin datos de terceros, invocada con argumentos
   sin shell (macOS `osascript`; Linux `notify-send` si existe). Como máximo una cada 10 minutos.
4. `requests` lista cada solicitud con un **identificador estable** (los primeros 8 caracteres de la
   llave del solicitante), nombre declarado, nota y el aviso "si lo apruebas, podrá leer tu carpeta
   compartida". `approve <id>` o `reject <id>`; no se acepta un índice numérico.
5. `approve` y `reject` son idempotentes por `requestId`. Un reintento de una solicitud ya decidida
   regenera la misma decisión. En quien pregunta, `connect_rejected` y `connect_approved` solo se
   aplican si su `requestId` es el de la solicitud pendiente actual; los demás se ignoran.

### Generaciones

Quien contesta lleva un contador `generation` por contacto que **solo crece**: cada `approve` y cada
`revoke` lo incrementa, así que cada generación corresponde a exactamente un estado. Ambos lados
guardan la **máxima generación observada** para cada contacto, en cualquier estado, incluido
`pending`. Hay dos reglas distintas:

- **Cambios de permiso** (`connect_approved`, `connect_revoked`): se aplican solo si su `generation`
  es **mayor** que la máxima observada. Un `connect_revoked(2)` retrasado que llega después de
  `connect_approved(3)` se ignora.
- **Preguntas:** quien pregunta pone en cada `question` la `generation` de su última aprobación.
  Quien contesta la admite solo si es **igual** a la generación con la que el contacto está
  `approved` en ese momento.

### Revocación

`revoke <nombre>`, en **una sola transacción**: marca el contacto `revoked`, incrementa
`generation`, fija la decisión final `rejected` / `stale_generation` en sus preguntas no contestadas
(sin encolarla; se regenera solo si llega un reintento), **borra de la bandeja de salida todo lo
dirigido a ese contacto que no esté reclamado** y encola `connect_revoked`.

El contrato exacto:

- **Despacho a Claude:** la transacción que reserva una pregunta verifica `approved` y la misma
  `generation` con la que se admitió. Si `revoke` confirma después de esa reserva y antes de que
  Claude conteste, el canal le avisa a Claude que la pregunta fue cancelada, y la transacción de
  `reply` la rechaza.
- **Respuesta:** la transacción de `reply` es el punto de autorización final para crear una
  respuesta. Si el permiso no sigue vigente, no se guarda ni se encola nada.
- **Publicación:** el publicador **reclama** cada salida en una transacción que verifica permiso y
  `generation`, y justo antes de escribir en el socket vuelve a comprobar que su reclamo no venció.
  **Única excepción al contrato:** una salida autorizada (reclamada) antes de que `revoke` confirme
  puede publicarse después de la revocación, por ejemplo si el proceso se suspende entre la
  comprobación y la escritura. No se promete una duración para esa ventana.
- **Resultados ya decididos:** una pregunta que ya tiene `answer` conserva ese resultado; sus
  reintentos de un contacto revocado, o de una generación anterior, se descartan en silencio y la
  respuesta no se regenera. Una pregunta sin contestar al momento de revocar recibe la decisión final
  `rejected` / `stale_generation`, que sí se regenera ante un reintento.
- Volver a aprobar crea una `generation` nueva: las preguntas anteriores no resucitan.
- Revocar **no** retira sobres ya publicados ni respuestas que la otra persona ya recibió.

## Entrega de preguntas y respuestas

### Admisión, en quien contesta

Una transacción, al recibir un `question` válido de un contacto:

1. Si la entidad `(senderPubkey, questionId)` existe con el mismo `rumor.id`: regenerar exactamente lo
   ya decidido (el mismo rumor de `receipt`, y el de `answer` o `rejected` si existe), sujeto al
   límite de regeneración, y terminar. Si el contacto ya no está `approved` con la `generation` de esa
   pregunta, solo se regenera un `rejected`; si la pregunta tenía `answer`, el reintento se descarta
   en silencio (ver "Revocación"). Si existe con otro `rumor.id`: descartar y registrar.
2. Si es nueva y el contacto no está `approved` con esa `generation`: decisión `rejected` /
   `stale_generation` si hubo relación; descartar en silencio si nunca la hubo.
3. Si venció: decisión `rejected` / `expired`.
4. Si excede 5 abiertas o 20 por día para ese contacto: decisión `rejected` / `limit`.
5. Si no: persistir la pregunta como `queued` con decisión `receipt`.

Toda decisión se **guarda antes de encolarse** y es final: un reintento posterior la repite (salvo la
excepción de "Revocación" para preguntas ya contestadas), aunque
las condiciones hayan cambiado (por ejemplo, ya no se excede el límite).

### Despacho

- **Bloqueo exclusivo del canal:** al arrancar, el canal toma el bloqueo de la identidad en SQLite
  (`channel_lock`: PID, hora de inicio del proceso y un `epoch` que crece en cada toma). Si el dueño
  registrado sigue vivo, el segundo canal **se niega a arrancar** con un error en español. Solo se
  toma el bloqueo de un proceso que ya no existe. Toda escritura del despacho verifica su `epoch`
  (fencing): un canal que despierta después de perder el bloqueo no puede confirmar nada.
- **Una a la vez:** en una transacción, reserva la pregunta `queued` más antigua, crea un intento con
  `attemptId`, código de 4 caracteres y `deadline` = ahora + `attemptTimeoutMs`, y la marca
  `dispatched`. Después de confirmar, la manda a Claude.
- **`reply`**, en una transacción: verifica código, que el intento sea el vigente, que no haya pasado
  su `deadline`, el `epoch` del canal y el permiso; guarda la respuesta, marca la pregunta `answered`
  y encola `answer`. Una respuesta tardía o de un intento viejo se rechaza con un mensaje a Claude.
- **Tiempo límite:** al vencer el `deadline`, se cancela el intento en Claude y la pregunta vuelve a
  `queued`. Tras 2 intentos vencidos, decisión `rejected` / `unanswered`.
- **Recuperación:** al tomar el bloqueo, los intentos `dispatched` de un `epoch` anterior vuelven a
  `queued`.

### Bandeja de salida y límites de trabajo

- **Una fila por mensaje lógico** (clave: destinatario + `rumor.id`); regenerar actualiza la fila, no
  crea otra.
- **Reclamo transaccional:** `claimed_by` y `claimed_until` (2 minutos). Una fila reclamada por un
  proceso caído vuelve a estar disponible al vencer.
- **Regeneración por reintentos:** como máximo una vez cada 10 minutos por mensaje lógico.
- **Topes:** 1 MB en la bandeja por contacto y 20 MB por identidad; como máximo 60 publicaciones por
  minuto por identidad. Al exceder, se pospone.

### Clientes de corta vida

`ask`, `ticket`, `contacts`, `connect`, `requests`, `approve`, `reject` y `revoke` siguen el ciclo
**iniciar → sincronizar → operar → sincronizar → cerrar**:

- **Sincronizar** (máximo 10 s): conectar a los tableros propios, leer desde el cursor, procesar lo
  recibido, publicar las salidas vencidas (incluidos los reintentos que tocan) y persistir.
- **`ask --wait N`** mantiene la conexión hasta N segundos esperando la respuesta; `ticket` sincroniza
  y muestra el estado.
- **Cerrar** termina conexiones y temporizadores, para que el comando siempre termine.
- Solo el servidor MCP y el canal, que son persistentes, corren reintentos con temporizador. Quien
  pregunta solo desde la terminal ve este aviso en español: los reintentos ocurren cada vez que corre
  un comando.

### Reintentos de quien pregunta

Toda pregunta que no esté en un estado final se reintenta: cada 5 min la primera hora, después cada
30 min, hasta 7 días desde su envío. **El acuse no detiene los reintentos**; solo los detiene `answer`
o `rejected`.

### Estados de la pregunta, en quien pregunta

| Desde | Evento | Hacia |
|---|---|---|
| `sending` | al menos 1 tablero aceptó | `sent` |
| `sending` / `sent` | llega `receipt` autenticado | `received` |
| `sending` / `sent` / `received` | llega `answer` autenticado | `answered` (final) |
| `sending` / `sent` / `received` | llega `rejected` autenticado | `rejected` (final) |
| `sending` / `sent` / `received` | 7 días sin estado final | `lost` (final) |

Las transiciones ocurren en transacciones que leen el estado actual; un estado final nunca cambia.
Como quien contesta toma una sola decisión por pregunta, no pueden llegar `answer` y `rejected`
auténticos para la misma pregunta; si llegara el segundo, se registra y se ignora. Los textos para
Claude y la terminal distinguen "recibida" (llegó a su computadora) de "contestada".

## Estado local

Una sola carpeta de identidad y estado, `~/.agentbridge` (o `AGENTBRIDGE_HOME`), 0700:

- `identity.json`, 0600, creado con temporal + `link()`.
- `agentbridge.db`, SQLite en modo WAL con `busy_timeout`; los archivos `-wal` y `-shm` se crean con
  `umask 077`.

| Tabla | Contenido |
|---|---|
| `contacts` | llave, nombre local, papel, estado, `generation` máxima observada, tableros |
| `requests` | solicitudes entrantes pendientes |
| `inbox_questions` | preguntas recibidas: `rumor.id`, texto, `generation`, estado, decisión final y rumores de respuesta |
| `attempts` | intentos del despacho con `deadline` y `epoch` |
| `outbox_questions` | preguntas enviadas y su estado |
| `outbox` | mensajes por publicar: una fila por mensaje lógico, con reclamo |
| `cursors` | ventanas completas por tablero y papel |
| `channel_lock` | dueño actual del despacho y `epoch` |
| `schema_version` | versión del esquema |

Toda operación de lectura-modificación-escritura corre en `BEGIN IMMEDIATE`.
`(senderPubkey, questionId)`, `(senderPubkey, requestId)` y `(recipient, rumor.id)` en `outbox` son
claves únicas. Si Node emite un `ExperimentalWarning` de SQLite, el CLI filtra solo ese aviso. La
limpieza borra contenido a los 7 días y decisiones a los 9.

## Seguridad y abuso

- **Antes de descifrar:** tamaño, kind, destinatario, fecha, `id`, prueba de trabajo de 16 bits,
  deduplicación y firma. Descifrar ocurre de a uno, en cola acotada con contrapresión.
- **Solicitudes:** prueba de trabajo de 22 bits; una pendiente por llave; máximo 20 en total. Si la
  lista está llena, se desaloja la más antigua. Una llave rechazada en los últimos 7 días se ignora.
  Esto no impide que un atacante con recursos desplace solicitudes legítimas (ver "Privacidad").
- **Sin relación:** cualquier mensaje que no sea `connect_request` de una llave sin relación se
  descarta sin guardar ni contestar.
- **Trabajo acotado:** regeneración como máximo cada 10 minutos por mensaje, una fila de salida por
  mensaje lógico, topes de bytes y de publicaciones por minuto, prueba de trabajo en `worker_thread`.
- **Suplantación y repetición:** tubería de recepción completa, identidades de mensaje y de entidad,
  decisiones persistentes durante 9 días y fechas acotadas.
- **Direcciones de tableros:** ver "Direcciones de tableros".
- **Notificaciones:** texto fijo, sin datos de terceros, sin shell, una cada 10 minutos como máximo.
- **Instrucciones tramposas en preguntas:** sin cambios; la sesión encerrada sigue sin `Bash`, sin
  edición y sin lectura fuera de la carpeta.
- **Errores:** ningún mensaje de error ni registro incluye la llave, contenido descifrado de terceros
  ni rutas de la carpeta compartida.

## Cambios por componente

- **CLI:** nuevos `link`, `connect`, `requests`, `approve <id>`, `reject <id>`; `revoke`, `contacts`,
  `ask`, `ticket` y `whoami` pasan a SQLite, tableros y el ciclo de corta vida; se borran `enroll`,
  `invite`, `accept` y `admin`. `setup` crea la llave y, según el papel, muestra tu enlace o pide el
  de la persona a quien quieres preguntar. Toda instrucción impresa usa `CLI_COMMAND`, incluido el
  aviso de `ask` que hoy dice `agentbridge ticket` (`ask.ts:73`). Los comandos se nombran en inglés.
- **`setup-responder` y `doctor`:** `identityHome` y `profileHome` separados. `doctor` revisa llave
  presente, 0600 y fuera de la carpeta compartida; carpeta 0700; base de datos accesible; bloqueo del
  canal; por cada tablero, publicar **y** leer; solicitudes pendientes; y lo que ya revisa de la
  sesión encerrada.
- **Canal:** `dispatcher` en lugar de `RelayWsClient` + `InFlight`; notificación de solicitudes; texto
  de `reply` corregido.
- **Servidor MCP de quien pregunta:** `AskerService`; herramientas `list_contacts` (sin presencia),
  `ask_contact`, `check_answer` (estados nuevos) y `connect`.
- **Documentación:** README, `docs/inicio-rapido.md`, `docs/runbooks/m1-acceptance.md` y
  `docs/known-gaps.md` reescritos para el flujo sin Render, con la sección de privacidad de este
  documento. El `CLAUDE.md` del proyecto deja de pedir Docker Postgres.
- **Dependencias:** `nostr-tools` en versión exacta, empaquetada por esbuild en ambos bundles.
  `engines.node` pasa a `>=22.13` en el `package.json` raíz y en `scripts/pack.mjs`.
- **Versión:** 0.2.0. Quien use 0.1.x vuelve a correr `setup`; no hay migración automática.

## Pruebas

**Tablero falso en memoria** (NIP-01 sobre WebSocket) con: `EVENT`, `REQ` con `kinds`, `#p`,
`since`, `until` y `limit`, `CLOSE`, `EOSE`, `OK`, `CLOSED`, AUTH NIP-42 obligatorio configurable,
rechazo por tamaño, tope de resultados, muchos eventos con el mismo `created_at`, y modos de falla
para perder eventos, aceptar publicaciones sin permitir lectura, responder lento y desconectar a mitad
de una suscripción.

**Unitarias:** `identity` (enlace de ida y vuelta, creación exclusiva sin archivo a medias),
`relay-url` (cada rango prohibido, esquemas, longitudes, rebinding simulado en `lookup`), `envelope`
(cada paso de la tubería en su orden, topes por capa con vectores Unicode y escapes JSON, 16 y 22 bits
de prueba de trabajo, reintento que reusa el rumor), `store` (cada transición permitida y prohibida,
claves únicas, reclamos y su vencimiento, generaciones que no retroceden).

**Integración, sin internet:**
- Flujo completo: solicitud → aprobación → pregunta → acuse → respuesta.
- Quien contesta apagado y luego prendido; quien pregunta solo con CLI, apagado y luego sincronizando.
- Sobre perdido en 4 de 5 tableros; respuesta perdida en todos después del acuse (se recupera por
  reintento); acuse perdido; pregunta que llega después de 24 h (`expired`); `rumor.created_at` en el
  futuro (descartado).
- Mismo `questionId` con otro rumor; `rejected` / `limit` repetido en un reintento posterior aunque
  ya no se exceda el límite.
- Caída del canal después del acuse y antes de contestar; después de guardar la respuesta y antes de
  publicarla; con una fila de salida reclamada.
- Revocación con preguntas en cola, con una pregunta activa, con respuesta encolada sin reclamar y con
  respuesta reclamada; `connect_revoked` retrasado después de una aprobación más nueva; volver a
  aprobar sin resucitar preguntas.
- `reply` después del `deadline`; `reply` de un intento viejo tras un nuevo intento.
- Sobre de llave sin relación (no llega a Claude ni se guarda); solicitud con 16 bits (rechazada);
  lista de solicitudes llena (desalojo).
- Tablero que exige AUTH para leer; tablero que acepta publicar pero rechaza leer (`doctor` lo marca);
  tablero que rechaza por tamaño; recuperación histórica de 9 días con paginación, empates de fecha y
  una ventana incompleta; inundación que activa la contrapresión sin perder mensajes legítimos.
- Dirección de tablero hostil en un enlace y en una solicitud.
- Comandos de corta vida que siempre terminan, con tableros lentos o caídos.

**Multiproceso:** procesos reales de Node sobre la misma carpeta: `approve` y `revoke` concurrentes
con admisión; un segundo canal que se niega a arrancar; un canal suspendido que despierta tras perder
el bloqueo (fencing); CLI y servidor MCP actualizando la misma pregunta y reclamando la misma salida;
dos `setup` simultáneos creando identidad.

**Fallas de persistencia:** base de datos de solo lectura y disco lleno simulado: nada se publica sin
haberse guardado antes.

**En vivo, opcional** (`npm run test:live`, fuera de `npm test`): ida y vuelta completa contra
tableros públicos reales y medición de límites de publicación.

**Paquete:** antes de publicar, instalar el tarball de `npm run pack` y correr una prueba de humo con
Node 22.13 y con Node 24.

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
4. `npm run test:live` en verde y prueba del paquete con Node 22.13 y 24.
5. Aceptación manual, incluida la prueba de 24 horas.
6. Publicar la 0.2.0 en npm y fusionar la rama.
7. Borrar en Render el servicio `agentbridge-relay` y su base de datos (acción irreversible, se
   confirma con el dueño antes) y quitar `ADMIN_TOKEN` del Llavero.

## Fuera de alcance (0.2)

Respaldo de la llave y varios dispositivos por identidad; secreto hacia adelante; nombres legibles
NIP-05; descubrimiento de tableros por kind 10050 y compatibilidad con apps NIP-17; quien contesta en
la nube con la computadora apagada; tableros de pago; cliente web o móvil; dificultad de prueba de
trabajo configurable o negociada; más de un canal activo por identidad.

## Riesgos

- **Tableros de la comunidad:** pueden cerrar, limitar o empezar a exigir pago para kind 1059.
  Mitigación: hasta 5 tableros por destino, lista configurable, AUTH soportado y `doctor` probando
  publicar y leer.
- **Retención real desconocida más allá de 20 minutos.** Mitigación: reintentos durante 7 días y la
  prueba de 24 horas antes de apagar Render.
- **Límites de publicación de los tableros** con 5 copias por mensaje y reintentos: se miden en
  `test:live`; si hace falta, bajar a 3 copias.
- **`node:sqlite`** es relativamente nuevo: mínimo 22.13, pruebas multiproceso y prueba del paquete
  con esa versión.
- **Costo de la prueba de trabajo** en computadoras lentas: 16 bits por mensaje y 22 bits por
  solicitud; se mide en las pruebas.
- **Canal de Claude Code** sigue requiriendo `--dangerously-load-development-channels`, igual que en
  la 0.1.
- **IP y llave visibles** para los tableros a los que te conectas (ver "Privacidad").
- **Tamaño del cambio:** la 0.2 reemplaza el transporte, el estado y la coordinación de turnos a la
  vez. El plan debe construirlo por unidades independientes, cada una con sus pruebas en verde antes
  de la siguiente.
