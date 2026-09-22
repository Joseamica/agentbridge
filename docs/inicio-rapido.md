# Inicio rápido

Guía para las dos personas que van a usarlo. Si buscas la explicación técnica del proyecto, está
en el [README](../README.md) (en inglés).

## La idea, en una frase

Tu agente le pregunta al agente de otra persona, con el permiso de esa persona, sin que ninguno de
los dos tenga que estar disponible en el mismo momento — y sin que ninguno de los dos tenga que
instalar, pagar ni mantener un servidor.

## Cómo funciona, con una analogía

Las dos computadoras nunca se hablan directamente entre sí, y ninguna queda expuesta a internet.
Las dos dejan y recogen **sobres cerrados** en varios **tableros de anuncios públicos** — son
servidores que opera la comunidad de Nostr, gratuitos, donde cualquiera puede publicar y cualquiera
puede mirar. Cualquiera que pase frente a un tablero ve que hay un sobre ahí clavado; nadie más que
el destinatario puede abrirlo.

El sobre lleva por fuera, sin cifrar, **la llave de quien lo va a recibir** — así es como esa
persona lo encuentra entre todos los demás sobres del tablero — y va firmado por una llave que se
usa una sola vez y se tira. Así que quien opera un tablero puede ver que cierta llave recibe
sobres, y de qué tamaño y a qué hora, pero no puede leer el contenido ni saber quién lo escribió.

Quien contesta arma un **cuarto cerrado**: una carpeta donde copia solo lo que está dispuesto a
compartir. Su agente puede leer esa carpeta y **nada más de su computadora**. Eso no depende de
que el modelo se porte bien: está impuesto por configuración.

La consecuencia, que conviene tener clarísima: **todo lo que esté en esa carpeta es visible** para
quien tenga permiso de preguntar. Incluido un `.env` o un archivo de llaves. Por eso la carpeta se
arma a propósito, con copias. **No apuntes esto a tu repositorio de trabajo.**

## Quién hace qué

Hay dos papeles. En una prueba entre dos personas, cada una suele tener uno solo, pero nada impide
tener los dos a la vez.

| Papel | Quién | Qué hace |
| --- | --- | --- |
| **Quien contesta** | la persona que tiene el conocimiento | Deja una sesión de Claude Code corriendo en el cuarto cerrado. |
| **Quien pregunta** | la persona con la duda | Pregunta desde su propio Claude Code, o desde la terminal. |

El permiso va **en una sola dirección**. Que Ana pueda preguntarle a Dev no le permite a Dev
preguntarle a Ana. Si quieren las dos direcciones, hacen el paso del permiso dos veces, una en
cada sentido. `revoke` también va en una sola dirección: solo quien dio el permiso (quien
contesta) puede quitarlo, al instante. Quien pregunta simplemente deja de preguntar — no hay un
`revoke` para ese lado.

En esta guía **Ana pregunta** y **Dev contesta**. Cambia los nombres por los de ustedes.

## 1. Qué necesitas

En **las dos** computadoras, y nada más que esto:

- **Node 22.13 o más nuevo.** No hay que clonar, compilar ni instalar AgentBridge: el comando de
  abajo lo descarga solo la primera vez y lo reutiliza después.
- **Claude Code instalado.** Quien contesta lo necesita sí o sí. Quien pregunta solo lo necesita si
  quiere preguntar desde dentro de su agente, en vez de desde la terminal.

## 2. Un comando

En cada computadora, una vez:

```
npx -y @joseamica/agentbridge@latest setup
```

Eso es todo lo que hay que escribir para dejarlo instalado. Lo demás son preguntas que contestas.

## 3. Qué te va a preguntar

- **Tu nombre o apodo.** Es como te van a ver las personas a las que te conectes.
- **Qué vas a hacer desde esta computadora**: contestar preguntas, hacer preguntas, o las dos
  cosas. Se responde con `1`, `2` o `3`.
- **Si vas a contestar, qué carpeta compartes.** Compartir una carpeta significa esto: **quien
  tenga tu permiso puede leer todo lo que esté ahí dentro**, así que pon copias de lo que quieras
  compartir, nunca tu carpeta de trabajo. La primera vez te propone una carpeta nueva
  (`AgentBridge/compartido`, dentro de tu carpeta de usuario); si esta computadora ya compartía
  una, te propone esa misma, así que con Enter sigues con la de siempre en vez de estrenar otra
  vacía. Antes de crear nada te muestra la ruta completa y te pide confirmarla.

  **Hay carpetas que no te va a dejar usar**, digas lo que digas: tu carpeta de usuario; cualquiera
  que tenga dentro tu identidad de AgentBridge (tu llave) o el perfil dedicado del respondedor; y
  una ruta que no sea una carpeta — un archivo, un enlace roto, o algo que no pudo ni revisar. En
  esos casos te dice cuál es el problema y te pide otra ruta ahí mismo, sin perder lo que ya
  llevabas; si insistes tres veces con una carpeta que no sirve, se detiene sin tocar nada.

  **Y hay carpetas que te deja usar solo si escribes `CONFIRMAR`.** Son siete avisos, y te dice
  cuál o cuáles saltaron: que dentro haya un repositorio con `.git`; archivos con pinta de
  credenciales (`.env`, `.pem`, `.key`, `id_rsa…`, `credentials…`); enlaces simbólicos, porque no
  mira qué hay del otro lado; un `node_modules` que no revisó por dentro; configuración de proyecto
  que el agente cargaría sola al arrancar (`.claude/settings.json`, `.mcp.json`, `AGENTS.md`,
  `CLAUDE.local.md`, `.claude/agents`, `.claude/skills`, `.claude/commands`); y —los dos últimos—
  una carpeta tan anidada o tan grande que no alcanzó a recorrerla completa, así que no puede
  prometerte que no haya nada de lo anterior más adentro.

Si vas a preguntar, también te pregunta si ya tienes el enlace de la otra persona (y, si lo tienes,
te lo pide y se conecta ahí mismo) y si quieres que registre la herramienta dentro de tu Claude
Code.

## 4. Qué va a hacer solo

Sin que tú ejecutes nada aparte. Si dijiste que vas a **contestar**:

- **Te abre el inicio de sesión de Claude** en un perfil aparte, dedicado a contestar preguntas —
  tu Claude de todos los días no se toca. Se abre tu navegador, escribes tu contraseña ahí, y
  vuelves a la terminal. Después comprueba solo si la sesión de verdad quedó iniciada.
- **Deja la carpeta lista**, con los permisos que impiden que esa sesión corra comandos, edite
  archivos o salga a internet.
- **Revisa que todo esté bien** y habla **solo** de lo que necesitas atender: lo que te impide
  contestar (lo marca `Falta algo:`) y cualquier cosa que afecte la seguridad de tu llave o de tu
  carpeta compartida aunque no bloquee nada (lo marca `Ojo:` — por ejemplo, que tu llave haya
  quedado dentro de una carpeta que se sincroniza con la nube). De lo demás se queda callado: un
  tablero caído de cinco es clima, y para eso está `doctor`.
- **Te copia tu enlace al portapapeles**, para que se lo pases a quien quieras que pueda
  preguntarte.
- Y al final, **si le dices que sí, te pone a contestar** ahí mismo. Esa terminal se queda
  ocupada esperando preguntas; para parar, Ctrl+C.

Si dijiste que vas a **preguntar**: te imprime tu enlace, manda tu solicitud de permiso si le
pegaste el enlace de la otra persona, y registra la herramienta dentro de tu Claude Code si le
dijiste que sí.

Y en los dos casos, si algo quedó a medias te lo dice en un resumen corto al final: qué quedó
listo y qué te falta.

## 5. Los comandos del día a día

Estos dos son los que vas a usar de verdad, y se escriben completos:

```
npx -y @joseamica/agentbridge@latest responder
```

Ponerte a contestar. Es lo que corres mañana, y pasado, cuando quieras volver a dejar tu agente
disponible. Ocupa la terminal hasta que lo pares con Ctrl+C. La primera vez, antes de quedar
esperando preguntas, Claude te hace un par de preguntas suyas —el tema de colores y, si hace
falta, el inicio de sesión—; eso es normal, no es que algo haya fallado.

```
npx -y @joseamica/agentbridge@latest requests
```

Ver quién te pidió permiso para preguntarte. Te muestra un identificador corto junto a cada
nombre; con él apruebas (`approve <id>`) o rechazas (`reject <id>`).

El resto, cuando lo necesites:

| Para | Comando |
| --- | --- |
| Ver tu enlace otra vez | `npx -y @joseamica/agentbridge@latest link` |
| Pedirle permiso a alguien | `npx -y @joseamica/agentbridge@latest connect "<su enlace>" --note "soy Ana"` |
| Ver a quién puedes preguntarle y quién puede preguntarte | `npx -y @joseamica/agentbridge@latest contacts` |
| Aprobar una solicitud | `npx -y @joseamica/agentbridge@latest approve <id>` |
| Preguntar desde la terminal | `npx -y @joseamica/agentbridge@latest ask dev "¿qué timeout aplica?" --wait 120` |
| Recoger después una respuesta que no esperaste | `npx -y @joseamica/agentbridge@latest ticket <identificador> --wait 60` |
| Quitarle el permiso a alguien | `npx -y @joseamica/agentbridge@latest revoke <nombre>` |

Dos notas sobre preguntar:

- `ask` con `--no-wait` regresa de inmediato con un identificador, y la respuesta la recoges
  después con `ticket`.
- Para preguntar **desde dentro de tu Claude Code** —que es el chiste de todo esto— basta con que
  `setup` haya registrado la herramienta. Después de eso hay que **cerrar y volver a abrir** Claude
  Code: las herramientas nuevas (`list_contacts`, `ask_contact`, `check_answer` y `connect`) no
  aparecen hasta que reinicias la sesión. Ya adentro, solo le dices a tu agente que le pregunte a
  Dev.

## 6. Si algo falla

Lo primero, siempre:

```
npx -y @joseamica/agentbridge@latest doctor
```

Cada renglón empieza con `[ok]` o `[falla]`, sigue con el nombre de lo que revisó, y termina con
el detalle — que, cuando algo está mal, dice exactamente qué hacer. Es seguro compartir esa salida
con alguien que te ayude: no imprime tu llave ni ninguna contraseña.

Lo que revisa siempre:

- **Llave de AgentBridge** — que exista tu llave en esta computadora.
- **Base de datos** — que tu archivo de contactos y preguntas abra y responda.
- **Candado del canal** — si hay una sesión contestando ahora mismo.
- **Solicitudes pendientes** — cuántas personas están esperando que las apruebes.
- **Tablero `<dirección>`**, uno por cada tablero público que usas — y no solo que conecte: que
  acepte publicar un sobre de prueba y te lo devuelva. Que **uno** salga en `[falla]` es normal, es
  el clima de internet; lo grave es que fallen todos, y en ese caso aparece un renglón aparte,
  **Tableros públicos**, diciéndolo.
- **Carpeta sincronizada con la nube** — solo aparece si tu llave quedó dentro de OneDrive,
  Dropbox, Google Drive o iCloud. Avisa, no bloquea.

Si eres quien contesta y quieres la revisión completa, pásale las dos carpetas que elegiste
durante `setup`:

```
npx -y @joseamica/agentbridge@latest doctor --profile <carpeta del perfil dedicado> --share <tu carpeta compartida>
```

Con esas dos revisa además: que los permisos de la sesión que contesta sigan siendo los
restringidos, que su configuración esté completa, que el plugin esté instalado, que la sesión de
Claude esté iniciada, y —del lado de la carpeta compartida— que tenga su `CLAUDE.md`, que no haya
enlaces simbólicos que salgan de ella, que no haya llegado ahí configuración de proyecto que el
agente cargaría sola al arrancar, y que el perfil dedicado no haya quedado dentro de la carpeta
compartida (ahí sus archivos serían legibles para cualquier pregunta).

Volver a correr `setup` también sirve: nunca recrea tu llave ni cambia tu enlace, y de paso repara
los permisos de tu carpeta de identidad si algo los había aflojado. Si eliges contestar, hace esa
revisión completa por su cuenta y te dice solo lo que necesitas atender — eso sí, te vuelve a
preguntar qué carpeta compartes, así que si no usas la que propone, escríbela otra vez en vez de
aceptar con Enter.

Dos cosas que confunden la primera vez:

- **La herramienta no aparece en Claude Code.** Falta cerrar y volver a abrir la sesión.
- **Una solicitud o una pregunta no llegan de inmediato.** No hace falta que hagas nada especial:
  se reintentan solas cada vez que corres un comando que habla con los tableros — `ask`, `ticket`,
  `connect`, `contacts`, `whoami`, `requests`, `approve`, `reject`, `revoke` — y también mientras la
  herramienta dentro de Claude Code esté abierta. Así hasta por una semana. Si quien responde
  tiene la computadora apagada, la pregunta simplemente espera.
  **`doctor` no cuenta:** diagnostica, pero no reintenta nada. Si estás esperando algo, el que lo
  empuja es cualquiera de los de arriba.

## Quitar el permiso

Lo hace quien contesta, sobre alguien a quien le dio permiso de preguntarle:

```
npx -y @joseamica/agentbridge@latest revoke <nombre>
```

`<nombre>` es el que aparece en `contacts`, en la lista de "Quién puede preguntarte a ti". Si había
una pregunta suya en camino cuando revocas, esa persona no recibe un "se canceló" al instante:
recibe el rechazo (con motivo "el permiso con esa persona cambió mientras esta pregunta seguía en
camino") **la próxima vez que su lado reintenta**, que puede tardar hasta unos minutos.

## Antes de usarlo con algo que importe

Corre el protocolo completo de aceptación:
[`runbooks/aceptacion-0.3.md`](runbooks/aceptacion-0.3.md). Incluye la prueba de que una pregunta
mandada de noche, con quien contesta apagado, llega y se contesta al día siguiente, y los
escenarios de seguridad — entre ellos, intentos de que el agente lea cosas que no debe. Las
limitaciones conocidas, sin adornos, están en [`known-gaps.md`](known-gaps.md).

¿Vas a modificar el código de AgentBridge en vez de solo usarlo? Eso está en el README, en
[Running the CLI from a local clone](../README.md#running-the-cli-from-a-local-clone).
