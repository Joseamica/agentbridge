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
compartir. Lo normal —y lo recomendado— es que su agente pueda leer esa carpeta y **nada más de su
computadora**. Si quiere, puede abrirle más puertas: otras carpetas suyas, o toda su carpeta
personal menos una "caja fuerte" que nunca se abre (lo explica la sección
[Qué puede ver tu agente](#qué-puede-ver-tu-agente)). En cualquier caso, lo que el agente puede y
no puede leer no depende de que el modelo se porte bien: está impuesto por configuración.

La consecuencia, que conviene tener clarísima: **todo lo que tu agente pueda leer es visible** para
quien tenga permiso de preguntarte. En la carpeta compartida eso incluye un `id_rsa`, un
`credentials.json` o una contraseña escrita en un documento; lo único que ahí está cerrado siempre
son los archivos que se llaman `.env` o `.env.<algo>`. Por eso la carpeta se arma a propósito, con
copias.
**No apuntes esto a tu repositorio de trabajo.**

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
  (`AgentBridge/compartido`, dentro de tu carpeta personal); si esta computadora ya compartía
  una, te propone esa misma, así que con Enter sigues con la de siempre en vez de estrenar otra
  vacía. Antes de crear nada te muestra la ruta completa y te pide confirmarla.

  **Hay carpetas que no te va a dejar usar**, digas lo que digas: tu carpeta personal misma (si
  quieres que tu agente vea toda tu carpeta personal, eso se elige en la pregunta siguiente);
  cualquiera que tenga dentro tu identidad de AgentBridge (tu llave) o el perfil dedicado del respondedor; y
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
- **Si vas a contestar, qué puede ver tu agente**: `1` solo esa carpeta (la recomendada), `2` esa
  carpeta y otras que elijas, o `3` toda tu carpeta personal menos la caja fuerte. Es una sola
  elección para todas las personas que te pueden preguntar. Enter deja lo que ya tenías (la
  primera vez, la `1`). Lo que significa cada opción está en
  [Qué puede ver tu agente](#qué-puede-ver-tu-agente), más abajo.

Si vas a preguntar, también te pregunta si ya tienes el enlace de la otra persona (y, si lo tienes,
te lo pide y se conecta ahí mismo) y si quieres que registre la herramienta dentro de tu Claude
Code.

## 4. Qué va a hacer solo

Sin que tú ejecutes nada aparte. Si dijiste que vas a **contestar**:

- **Te abre el inicio de sesión de Claude** en un perfil aparte, dedicado a contestar preguntas —
  tu Claude de todos los días no se toca. Se abre tu navegador, escribes tu contraseña ahí, y
  vuelves a la terminal. Después comprueba solo si la sesión de verdad quedó iniciada.
- **Deja la carpeta lista**, con los permisos que impiden que esa sesión corra comandos, edite
  archivos o salga a internet, y que la dejan leer solo lo que elegiste. Esos permisos los vuelve a
  escribir cada vez que corres `setup`: si cambiaron, te lo dice.
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

## Qué puede ver tu agente

Solo importa si vas a contestar. Piénsalo como una casa:

- **Opción 1 — Solo esta carpeta.** Tu agente atiende en un solo cuarto: la carpeta compartida.
  Es la recomendada, y la que tienes si no eliges otra.
- **Opción 2 — Esta carpeta y otras que elijas.** Le abres, además, los cuartos que tú señales,
  uno por uno.
- **Opción 3 — Toda tu carpeta personal, menos la caja fuerte.** Le abres la casa entera, menos
  una caja fuerte que nadie puede abrir.

En las tres, lo que queda fuera de lo que elegiste está cerrado por configuración, no por
cortesía del modelo: los archivos del sistema, por ejemplo, siguen cerrados incluso en la opción
3. Es **una sola elección para todas las personas** que te pueden preguntar; no se puede dar más
alcance a una que a otra. Para cambiarla, vuelve a correr `setup` y elige otra opción: Enter deja
la que ya tenías.

| | Tu agente puede leer | Sigue cerrado |
| --- | --- | --- |
| **1** | la carpeta compartida | todo lo demás; y en la carpeta compartida, los archivos que se llaman `.env` o `.env.<algo>` |
| **2** | la carpeta compartida y las carpetas que elegiste | todo lo demás; la caja fuerte; y dentro de esas carpetas y de la compartida, los archivos `.env`, `.env.<algo>` y los que terminan en `.pem`, `.key`, `.p12` o `.pfx` |
| **3** | la carpeta compartida y toda tu carpeta personal | la caja fuerte, y todo lo demás que está fuera de tu carpeta personal |

### La caja fuerte

Es lo que sigue cerrado en las opciones 2 y 3, y **nadie la puede abrir desde `setup`, ni tú**. En
palabras de todos los días:

- tu llave de AgentBridge (y el perfil dedicado del respondedor);
- tu Claude de todos los días: tu sesión y todas tus conversaciones;
- los lugares más conocidos donde se guardan contraseñas y llaves: las del navegador, las de tu
  llavero y las que dan acceso a servidores y a la nube;
- tus archivos `.env`, donde los programas guardan sus contraseñas, y los archivos de llaves que
  terminan en `.pem`, `.key`, `.p12` o `.pfx`.

Si quieres la lista exacta: la carpeta de tu identidad de AgentBridge y la del perfil dedicado,
estén donde estén; `~/.claude`, `~/.claude.json` y sus copias, y la configuración de la app de
escritorio de Claude; `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`,
`~/.docker`, `~/.config/gh`, `~/.npmrc`, `~/.pypirc`, `~/.netrc`, `~/.git-credentials`, las
credenciales de `~/.cargo`, `~/.terraform.d` y `~/.config/op` (1Password); los historiales de la
terminal y de consolas (zsh, bash, fish, Python, Node, psql, MySQL, SQLite); en Mac, el llavero
(`~/Library/Keychains`), las cookies y los datos de Chrome, Firefox, Safari, Brave, Edge y Arc; en
Linux, los de Firefox, Chrome, Chromium, Brave y Edge, y `~/.local/share/keyrings`; en Windows,
toda la carpeta `AppData`; y, en cualquier parte de tu carpeta personal, los archivos `.env`,
`.env.<algo>`, `.pem`, `.key`, `.p12` y `.pfx`. En las opciones 2 y 3, los archivos que terminan en
`.pem`, `.key`, `.p12` o `.pfx` también quedan cerrados dentro de la carpeta compartida, aunque esa
carpeta esté fuera de tu carpeta personal.

**La caja fuerte no lo cubre todo.** Cierra los lugares más conocidos, no todos los secretos que
puedas tener. Si tienes una contraseña escrita en un documento, correos o chats guardados en tu
computadora, o un archivo de llaves con un nombre poco común, tu agente sí puede leerlos. La lista
es fija: no se puede ampliar ni abrir desde `setup`.

### Opción 2, en detalle

Te pide las carpetas una por una; cuando termines, deja la respuesta vacía y presiona Enter. Cada
carpeta pasa por las mismas revisiones que la carpeta compartida —los siete avisos que piden
`CONFIRMAR`— y además estas, que no se pueden saltar:

- tiene que existir ya: son carpetas tuyas, no se crean;
- no puede ser tu carpeta personal ni contenerla (para eso está la opción 3);
- no puede estar dentro de la caja fuerte: tu agente no podría leer nada ahí;
- no puede ser la carpeta compartida ni estar dentro de ella, ni contener tu identidad de
  AgentBridge o el perfil dedicado;
- su ruta no puede tener `*`, `?`, `[`, `]`, `{` ni `}` (en Mac y Linux, tampoco `\`): Claude Code
  los tomaría como comodines y la protección no quedaría bien puesta. Cámbiale el nombre.

Si añades una carpeta que contiene otra que ya estaba en la lista, la de adentro sale de la lista
(la de afuera ya la cubre). Si te rechaza tres seguidas, sigue con las que ya elegiste; si no
añadiste ninguna, te quedas con la opción 1. La siguiente vez que corras `setup`, te muestra las
que elegiste y te pregunta si las dejas; si dices que sí, las vuelve a revisar una por una.

Lo que tengan esas carpetas **se lee, pero no se carga**: si una trae su propio `CLAUDE.md`,
`.mcp.json`, habilidades o comandos de Claude, tu agente no los recibe como instrucciones al
arrancar. Eso se comprobó con Claude Code 2.1.282.

**En Windows la opción 2 todavía no está disponible**: no está comprobado cómo proteger los
archivos de llaves dentro de cada carpeta extra. `setup` te lo dice y te deja elegir otra.

### Opción 3, en detalle

Antes de aceptarla, `setup` te explica qué vas a abrir y te pide escribir `CONFIRMAR`; cualquier
otra respuesta te deja en la opción 1. Te lo pide cada vez que eliges la opción 3, también al
volver a correr `setup` con Enter.

Lo más importante, dicho sin rodeos: **con la opción 3, cualquier persona a la que le des permiso
de preguntarte puede preguntar por cualquier archivo de tu carpeta personal que no esté en la caja
fuerte, y tu agente se lo va a leer.** No solo lo que tú pensabas compartir: tus documentos, tus
fotos, tus proyectos, todo lo que tengas ahí.

**En Windows** solo está disponible si la carpeta compartida, tu identidad de AgentBridge y el
perfil dedicado están los tres dentro de tu carpeta personal; si no, `setup` te lo dice y te deja
elegir otra. Y una advertencia honesta: que la caja fuerte se sostenga en Windows no está
comprobado todavía con Claude Code real; en Mac sí.

### Cómo sabe tu agente qué puede leer

`setup` escribe en la carpeta compartida un archivo propio, `.agentbridge-scope.md`, con lo que
elegiste, y lo reescribe cada vez que lo corres; no lo edites, porque se sobrescribe. El
`CLAUDE.md` que `setup` deja en esa carpeta lo incluye (si tienes el que escribió una versión
anterior de AgentBridge y nunca lo cambiaste, lo actualiza y te avisa). Si ese `CLAUDE.md` lo
cambiaste tú, `setup` no lo toca; en las opciones 2 y 3 te avisa si no menciona `.agentbridge-scope.md` y te da la línea
que tienes que añadir al principio del archivo, sola:

```
@.agentbridge-scope.md
```

Sin esa línea, tu agente puede creer que solo puede usar la carpeta compartida. Lo que puede leer
de verdad no cambia —eso lo deciden los permisos—, pero podría negarse a leer una carpeta que sí le
diste. `doctor` te lo sigue diciendo hasta que lo arregles.

Cada vez que te pones a contestar con `responder`, lo primero que imprime es qué puede ver tu
agente (por ejemplo, `Tu agente puede ver: solo la carpeta compartida.`). Y si los permisos del
perfil dedicado no coinciden con lo que elegiste, se niega a arrancar y te dice que vuelvas a
correr `setup`.

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

Y sobre [qué puede ver tu agente](#qué-puede-ver-tu-agente):

- **Permisos del respondedor** — se comparan con lo que elegiste, exactamente. Si falta una
  protección de la caja fuerte, si hay una carpeta legible que no elegiste (por ejemplo, porque
  alguien editó el archivo a mano) o si falta una que sí elegiste, sale en `[falla]` y `responder`
  no arranca hasta que vuelvas a correr `setup`.
- **Alcance del respondedor** — la opción que tienes, con las mismas palabras que usó `setup`. En la
  opción 2 nombra las carpetas.
- **Caja fuerte** — solo en la opción 3: qué sigue cerrado y qué no cubre.
- **Tu agente sabe qué carpetas puede usar** — que el `CLAUDE.md` de la carpeta compartida mencione
  `.agentbridge-scope.md` y que ese archivo diga lo que elegiste (en la opción 1 solo aparece si tu
  `CLAUDE.md` menciona ese archivo). Si sale en `[falla]`, el detalle
  dice qué hacer; no bloquea, porque lo que tu agente puede leer lo deciden los permisos.
- **En la opción 2, una línea por cada carpeta extra**: si ya no existe (se movió, se renombró o
  está en un disco desconectado), que `responder` no va a arrancar hasta que la quites o elijas
  otra; y si existe, que no tenga enlaces simbólicos que salgan de ella. Una carpeta muy grande o
  muy anidada no se revisa entera —se detiene a los 20000 elementos o a los 6 niveles de
  profundidad— y lo dice, sin marcarlo como falla.
- **En Mac, si el sistema no deja entrar a una carpeta** —la compartida o una extra, sobre todo si
  está en Documentos, Escritorio o Descargas—, lo dice así: que macOS no deja que este programa
  entre en esa carpeta, y dónde se arregla: Ajustes del Sistema › Privacidad y seguridad › Archivos
  y carpetas (o Acceso total al disco), dándole permiso a la app de terminal donde lo corres.
  Hasta entonces tu agente tampoco puede leerla.

Volver a correr `setup` también sirve: nunca recrea tu llave ni cambia tu enlace, y de paso repara
los permisos de tu carpeta de identidad si algo los había aflojado. Si eliges contestar, hace esa
revisión completa por su cuenta y te dice solo lo que necesitas atender — eso sí, te vuelve a
preguntar qué carpeta compartes y qué puede ver tu agente. Enter deja lo que ya tenías en las dos
preguntas (la opción 3 te vuelve a pedir `CONFIRMAR`); si no es lo que quieres, escríbelo otra vez en vez de aceptar con Enter.

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
[`runbooks/aceptacion-0.4.md`](runbooks/aceptacion-0.4.md). Incluye la prueba de que una pregunta
mandada de noche, con quien contesta apagado, llega y se contesta al día siguiente, y los
escenarios de seguridad — entre ellos, intentos de que el agente lea cosas que no debe, y la
comprobación, contra el Claude Code que tienes instalado, de que la caja fuerte sigue cerrada. Las
limitaciones conocidas, sin adornos, están en [`known-gaps.md`](known-gaps.md).

¿Vas a modificar el código de AgentBridge en vez de solo usarlo? Eso está en el README, en
[Running the CLI from a local clone](../README.md#running-the-cli-from-a-local-clone).
