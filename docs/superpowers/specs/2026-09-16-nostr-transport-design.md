# AgentBridge 0.2 — sin servidor propio, sobre tableros públicos (Nostr)

Fecha: 2026-09-16 · Estado: diseño aprobado por partes en conversación, pendiente de revisión escrita.

## Objetivo

Que **cualquier persona, incluidos desconocidos, use AgentBridge sin contratar ni operar un
servidor**: ni quien lo mantiene, ni quien pregunta, ni quien contesta. Lo único que necesita cada
quien es su computadora y Claude Code.

Hoy (0.1.x) todo pasa por un relay propio en Render (Fastify + Postgres) que cuesta $10.50 al mes,
exige un `ADMIN_TOKEN` para dar de alta a cada persona, y deja que su operador lea todas las
preguntas y respuestas. La 0.2 lo reemplaza por **tableros públicos de Nostr**: servidores de
mensajes que opera la comunidad, gratuitos, donde se dejan **sobres cerrados y sin remitente**.

### Criterios de éxito

1. Dos personas en redes distintas, sin servidor propio, completan: compartir enlace → solicitud →
   aprobación → pregunta → acuse → respuesta.
2. Si la computadora de quien contesta está apagada, la pregunta espera y se contesta al prenderse
   (dentro de 24 h). Si la de quien pregunta está apagada, la respuesta la espera.
3. Revocar un permiso surte efecto de inmediato, sin depender de internet.
4. Nadie en medio (tableros ni quien mantiene el proyecto) puede leer el contenido ni saber quién le
   pregunta a quién.
5. Las pruebas automáticas corren sin internet y sin Docker.
6. El servicio y la base de datos de Render se borran y dejan de cobrar.

## Evidencia: prueba desechable del 2026-09-16

Se publicaron sobres NIP-17 (gift wrap, kind 1059) con llaves de usar y tirar en 9 tableros
públicos gratuitos, usando `nostr-tools` 2.25.2. El código de la prueba no se conserva.

| Pregunta | Resultado |
|---|---|
| ¿Aceptan sobres sin pago ni registro? | 7 de 9 (uno no conectó; otro exige AUTH NIP-42 y falló) |
| Latencia con quien contesta escuchando | 0.2–1 s |
| ¿Se recuperan con una conexión nueva (quien contesta estaba apagado)? | Sí, en los 7 |
| ¿Siguen ahí a los 20 minutos? | Sí, 100 % en los 7 |
| ¿Se verifica quién lo mandó? | Sí, el remitente del sello coincide con el de adentro |
| Tamaño en red | 1 KB de texto → 4 KB; 30 KB → 64 KB (rechazado por 3 tableros con tope de 65 536 bytes); 90 KB → 214 KB (solo 3 lo aceptan) |

No se pudo comprobar retención de horas o días; el diseño la cubre con reenvío (ver "Entrega").

Tableros que funcionaron: `relay.primal.net`, `relay.snort.social`, `relay.nostr.net`,
`nostr.oxtr.dev`, `nos.lol`, `offchain.pub`, `nostr.mom`.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Punto de encuentro | Tableros públicos Nostr. Sin servidor propio. |
| Relay de Render | Se reemplaza por completo y se apaga cuando la 0.2 esté validada. No hay modo dual. |
| Sobre | Sin remitente visible: NIP-59 (seal + gift wrap). |
| Conexión entre personas | Solicitud y aprobación explícita de quien contesta. |
| Enlace para agregarte | Público, no secreto. Se puede publicar en cualquier lado. |
| Disponibilidad | Se contesta solo con la computadora de quien contesta prendida, como hoy. Preguntas expiran a las 24 h. |
| Piloto actual | Sigue con la 0.1.1; Render sigue prendido hasta validar la 0.2. |

## Arquitectura

```
Quien pregunta                         Tableros públicos (Nostr)              Quien contesta
──────────────                         ─────────────────────────              ──────────────
CLI / servidor MCP  ── sobres ──►  [ 5 tableros, copias del mismo sobre ] ──► canal (plugin) en la
     │                                                                        sesión encerrada
     └ ~/.agentbridge: llave, contactos,                                          │
       preguntas enviadas                               ~/.agentbridge: llave, aprobados, solicitudes,
                                                        preguntas recibidas y respuestas dadas
```

El relay era el archivero: identidades, permisos, cola y contenido. En la 0.2 **cada computadora
lleva su propio archivero** y los tableros solo transportan sobres cerrados.

### Qué se va, qué se queda, qué llega

- **Se va:** `apps/relay` completo, `render.yaml`, el botón "Deploy to Render", `ADMIN_TOKEN`,
  `admin enroll-link`, `enroll`, `invite`, `accept`, `RelayHttpClient` (`packages/core/src/http.ts`)
  y lo que solo sirva al relay en `packages/core`. Con ellos desaparecen los pendientes de
  `docs/known-gaps.md` que solo existen en el relay (deadlock de revocación, ping/pong, `hub.ts`,
  502 de `http.ts`, el operador que puede acuñar un dispositivo bajo un handle ajeno).
- **Se queda igual:** la sesión encerrada de quien contesta (`setup-responder`, ajustes,
  `blockReadsOutsideWorkingDirectories` anidado en `permissions`, `RESPONDER_PERSONA`), la
  herramienta `reply`, el código de 4 caracteres por pregunta, una pregunta a la vez, preguntar
  desde Claude Code (MCP) o la terminal, `setup` guiado, `doctor`, el traductor de errores
  `packages/cli/src/spanish-errors.ts`.
- **Llega:** identidad por llave, estado local en archivos, un transporte Nostr, solicitudes y
  aprobaciones.

### Puntos de corte en el código actual

El canal ya habla con el relay a través de la interfaz `RelayConnection`
(`packages/channel/src/relay-client.ts`) y el servidor MCP de quien pregunta a través de
`AskerApi` (`packages/cli/src/mcp-asker.ts`). La 0.2 implementa ambas sobre Nostr en lugar de
reescribir el canal y el servidor MCP.

### Unidades nuevas

Cada una con un solo propósito y probable por separado:

1. **`identity`** (`packages/core`): genera y lee la llave secp256k1; produce y lee el enlace
   (`agentbridge:` + `nprofile` NIP-19 con la llave pública y hasta 5 tableros).
2. **`envelope`** (`packages/core`): arma y abre sobres NIP-59 con kind interno propio (no 14, para
   que ninguna app de chat Nostr lo muestre como conversación), valida el contenido con zod y
   verifica que `seal.pubkey === rumor.pubkey` y la firma del sello. Si algo no cuadra, descarta.
3. **`boards`** (`packages/core`): conecta a una lista de tableros, publica el mismo sobre en todos
   (éxito si al menos 1 lo acepta), se suscribe por `#p` con `since`, deduplica por id de evento, y
   mide el tamaño serializado antes de publicar.
4. **`local-store`** (`packages/core`): archivos JSON por elemento con escritura atómica (temporal +
   `rename`), permisos 0600, carpeta 0700.
5. **`asker-transport`** (`packages/cli`): implementa `AskerApi` y los comandos de quien pregunta.
6. **`responder-transport`** (`packages/channel`): implementa `RelayConnection` para el canal.

## Protocolo

Todo mensaje es el contenido JSON de un rumor dentro de un sobre NIP-59, con `v: 1` y un `type`:

| `type` | Dirección | Campos |
|---|---|---|
| `connect_request` | pregunta → contesta | `name`, `note`, `relays` (dónde quiere recibir) |
| `connect_approved` | contesta → pregunta | `name`, `relays` |
| `connect_revoked` | contesta → pregunta | — (aviso de cortesía) |
| `question` | pregunta → contesta | `id` (uuid), `text`, `expiresAt` |
| `receipt` | contesta → pregunta | `questionId` |
| `answer` | contesta → pregunta | `questionId`, `text`, `source`, `confidence` |
| `rejected` | contesta → pregunta | `questionId`, `reason`: `expired` \| `limit` |

- Cada sobre va a los tableros que el destinatario declaró (enlace o `connect_request`), máximo 5.
- Todo sobre lleva etiqueta de caducidad NIP-40 a 7 días para que los tableros que la respetan lo
  borren.
- Tope de contenido: pregunta ≤ 4 000 caracteres, respuesta ≤ 8 000 caracteres y fuente ≤ 500
  caracteres (los `LIMITS` de hoy), y además ≤ 16 KB en UTF-8 por mensaje. Antes de publicar se
  verifica que el sobre serializado mida < 60 KB; si no, error en español. Así nunca se usa la
  extensión no estándar de NIP-44 para textos mayores a 65 535 bytes.
- Las suscripciones usan `since = último visto − 2 días − 10 min`, porque NIP-59 pone fechas al azar
  hasta 2 días atrás. La deduplicación hace inofensivo releer.

## Conexión entre personas

1. Quien contesta corre `setup`: se crea su llave y se muestra su enlace (también con `link`).
2. Quien pregunta corre `connect <enlace> --note "…"` o se lo pide a su Claude Code (herramienta MCP
   `connect`). Se manda `connect_request` y el contacto queda "pendiente" en su agenda.
3. El canal de quien contesta recibe la solicitud, la guarda y lanza una notificación del sistema
   (macOS `osascript`; Linux `notify-send` si existe; si no, nada). Las solicitudes que llegan en el
   mismo minuto producen un solo aviso ("3 solicitudes nuevas").
4. Quien contesta corre `requests` (ve nombre declarado, nota, llave corta y el aviso "si lo apruebas,
   podrá leer tu carpeta compartida") y luego `approve <n>` o `reject <n>`. Aprobar asigna un nombre
   local válido para `HandleSchema` y manda `connect_approved`.
5. `revoke <nombre>` borra el permiso localmente y manda `connect_revoked`. El canal vuelve a revisar
   el permiso antes de entregar cada pregunta en cola a Claude y antes de mandar cada respuesta: si
   ya no está aprobado, la descarta y, si Claude la tenía en curso, le avisa que fue cancelada, igual
   que hoy con `cancel` por `revoked`.

Los nombres son locales y declarados: la identidad real es la llave. Los comandos se nombran en
inglés, como los de hoy.

## Entrega de preguntas y respuestas

```
Quien pregunta                     Quien contesta
question #id (×5 tableros) ──────► 1. deduplica por id
estado: enviada                    2. ¿aprobado? ¿no expiró? ¿dentro de límites? (si no está aprobado:
                                      se descarta en silencio, sin llamar a Claude ni contestar)
          ◄──────── receipt #id    3. acuse inmediato
estado: recibida                   4. una a la vez a Claude, con código de 4 caracteres
          ◄──────── answer #id     5. guarda la respuesta 7 días
estado: contestada
```

- **Reenvío:** mientras su cliente corre (`ask`, `ticket`, o el servidor MCP abierto), quien pregunta
  reenvía con el mismo `id` toda pregunta sin acuse cada 5 minutos, hasta que expire.
- **Respuesta perdida:** si llega otra vez una pregunta ya contestada, quien contesta reenvía la
  respuesta guardada sin volver a llamar a Claude.
- **Límites:** 5 preguntas abiertas y 20 por día por persona aprobada; al excederlos, `rejected` con
  `limit`. Expiración: 24 h (`expired`).
- **Estados de quien pregunta:** `sent` → `received` → `answered`, o `expired` / `rejected`. Nunca
  retroceden: al combinar dos escrituras gana el estado más avanzado.

## Estado local

Una sola carpeta de identidad y estado, `~/.agentbridge` (o `AGENTBRIDGE_HOME`), para preguntar y
contestar. `~/.agentbridge-responder` queda solo como perfil de Claude Code de la sesión encerrada
(ajustes, `start.sh`, `claude/`) y ya no guarda credenciales. Esto elimina la copia de credenciales
entre carpetas que hoy hace `setup` y sus errores asociados (C2, token rancio).

```
~/.agentbridge/                 0700
  identity.json                 0600  llave secreta + tableros propios
  contacts/<pubkey>.json        a quién puedo preguntar (lo escribe quien pregunta)
  approved/<pubkey>.json        quién me puede preguntar (lo escriben approve/revoke)
  requests/<pubkey>.json        solicitudes pendientes (lo crea el canal; lo borra approve/reject)
  outbox/<questionId>.json      preguntas enviadas y su estado
  inbox/<questionId>.json       preguntas recibidas, acuse y respuesta dada
  cursors/<role>.json           último visto por tablero, uno para quien pregunta y otro para el canal
```

Si dos procesos del mismo papel escriben su cursor a la vez, gana el último. Es inofensivo porque la
suscripción relee con 2 días de margen y todo se deduplica.

Un archivo por elemento evita que dos procesos (canal, servidor MCP, CLI) se pisen. El canal vuelve
a leer `approved/` en cada mensaje, así que una revocación aplica al siguiente sobre. Varios
procesos pueden suscribirse a la vez con la misma llave; cada uno atiende solo los `type` de su
papel.

## Seguridad y abuso

- **Llave:** `identity.json` 0600. `setup` y `doctor` rechazan cualquier carpeta compartida que la
  contenga, igual que hoy con la credencial. Perderla implica llave nueva y volver a pedir
  aprobación; no hay respaldo en la 0.2.
- **Solicitudes:** cualquiera puede mandar `connect_request`; se guarda una pendiente por llave y 20
  en total (si ya hay 20, las nuevas se descartan); las de más de 7 días se borran; las
  notificaciones se agrupan.
- **No aprobados:** cualquier sobre que no sea `connect_request` de una llave no aprobada se descarta
  sin respuesta y sin llamar a Claude, así que no cuesta tokens y el sistema no sirve para rebotar
  spam.
- **Suplantación:** toda respuesta y toda aprobación se aceptan solo si el sello está firmado por la
  llave del contacto esperado.
- **Repetición:** deduplicación por id más `expiresAt`.
- **Instrucciones tramposas en preguntas:** sin cambios; la sesión encerrada sigue sin `Bash`, sin
  edición y sin lectura fuera de la carpeta.
- **Qué ven los tableros:** la llave pública del destinatario, tamaño y hora de cada sobre, y la IP
  de quien se conecta. No ven contenido ni remitente.

## Cambios por componente

- **CLI:** nuevos `link`, `connect`, `requests`, `approve`, `reject`; `revoke`, `contacts`, `ask`,
  `ticket` y `whoami` pasan a estado local y tableros; se borran `enroll`, `invite`, `accept` y
  `admin`. `setup` ya no pide enlace de alta: crea la llave, y según el papel muestra tu enlace o
  pide el de la persona a quien quieres preguntar.
- **Servidor MCP de quien pregunta:** herramientas actuales más `connect`.
- **Canal:** `responder-transport` en lugar del WebSocket al relay; notificación de solicitudes.
- **`doctor`:** llave presente y 0600, fuera de la carpeta compartida; cuántos tableros responden;
  solicitudes pendientes; se conservan las revisiones de la sesión encerrada.
- **Documentación:** README, `docs/inicio-rapido.md`, `docs/runbooks/m1-acceptance.md` y
  `docs/known-gaps.md` reescritos para el flujo sin Render. El `CLAUDE.md` del proyecto deja de pedir
  Docker Postgres para las pruebas.
- **Dependencias:** `nostr-tools` en versión exacta, empaquetada por esbuild en ambos bundles.
- **Versión:** 0.2.0. Quien use 0.1.x vuelve a correr `setup`; no hay migración automática.

## Pruebas

- **Tablero falso en memoria** (subconjunto de NIP-01 sobre WebSocket: `EVENT`, `REQ` con `kinds`,
  `#p` y `since`, `CLOSE`, `EOSE`, `OK`, rechazo por tamaño) para las pruebas de integración de
  canal, servidor MCP y CLI. Sin internet, sin Docker.
- **Unitarias:** `identity` (enlace de ida y vuelta), `envelope` (sello falsificado, remitente
  distinto, contenido inválido, tamaño), `local-store` (escritura atómica, estados que no
  retroceden), límites y expiración.
- **Escenarios obligatorios:** solicitud → aprobación → pregunta → acuse → respuesta; quien contesta
  apagado y luego prendido; sobre perdido en 4 de 5 tableros; pregunta repetida ya contestada;
  revocación con preguntas en cola; sobre de no aprobado (no llega a Claude); pregunta expirada;
  tablero que rechaza por tamaño.
- **Prueba en vivo opcional** (`npm run test:live`, fuera de `npm test`) contra tableros públicos
  reales, antes de cada publicación.
- **Aceptación manual:** los 8 escenarios de seguridad de la sesión encerrada, más una prueba real
  entre dos personas en redes distintas.

## Migración y apagado de Render

1. Piloto entre dos personas con la 0.1.1 (Render prendido).
2. Construir la 0.2.0 en una rama; `npm test` y `npm run test:live` en verde.
3. Prueba real entre dos personas con la 0.2.0.
4. Publicar la 0.2.0 en npm.
5. Borrar en Render el servicio `agentbridge-relay` y su base de datos (acción irreversible, se
   confirma con el dueño antes), borrar `apps/relay` y `render.yaml`, y quitar `ADMIN_TOKEN` del
   Llavero.

## Fuera de alcance (0.2)

Respaldo de la llave y varios dispositivos por identidad; nombres legibles NIP-05; descubrimiento de
tableros por kind 10050; prueba de trabajo (NIP-13) contra spam; quien contesta en la nube con la
computadora apagada; tableros de pago o con AUTH NIP-42; cliente web o móvil.

## Riesgos

- **Tableros de la comunidad:** pueden cerrar, limitar o empezar a exigir AUTH o pago para kind
  1059. Mitigación: 5 tableros por destinatario, lista configurable y revisión en `doctor`.
- **Retención de horas o días no comprobada.** Mitigación: acuse y reenvío.
- **Límites de publicación** de los tableros al mandar 5 copias por sobre: por medir en
  `test:live`.
- **Canal de Claude Code** sigue requiriendo `--dangerously-load-development-channels`, igual que
  en la 0.1.
- **IP visible** para los tableros a los que te conectas.
