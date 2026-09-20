# Inicio rápido

Guía para las dos personas que van a probarlo. Si buscas la explicación técnica del proyecto,
está en el [README](../README.md) (en inglés).

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
cada sentido. Cualquiera de los dos puede quitarlo cuando quiera, con `revoke`.

En esta guía **Ana pregunta** y **Dev contesta**. Cambia los nombres por los de ustedes.

## 1. Antes de empezar

En **las dos** computadoras:

- Node 22.13 o más nuevo, solo para correr `npx` — nada que clonar, compilar ni instalar aparte.
- Claude Code instalado. Dev (quien va a contestar) necesita además haber iniciado sesión ahí.
  Ana (quien va a preguntar) solo lo necesita si quiere preguntar desde dentro de su agente en vez
  de desde la terminal.

Para comprobar que todo corre, en cualquiera de las dos:

```bash
npx -y @joseamica/agentbridge@latest --help
```

La primera vez tarda un poco porque descarga AgentBridge; después lo reutiliza.

(¿Vas a modificar el código de AgentBridge en vez de solo usarlo? Mira
[Correr el CLI desde el código fuente](#correr-el-cli-desde-el-código-fuente) al final de esta
guía.)

## 2. El comando guiado: `setup`

En cada computadora corres el mismo comando, una vez:

```bash
npx -y @joseamica/agentbridge@latest setup
```

Te va haciendo preguntas, en español. Esto es lo que vas a ver y un ejemplo de respuesta para
cada una:

| Te pregunta | Respuesta de ejemplo |
| --- | --- |
| `¿Cómo quieres que te vean las personas a las que te conectes? (tu nombre o apodo):` | `Dev` |
| `¿Qué vas a hacer desde esta computadora? 1) Contestar preguntas … 2) Hacer preguntas … 3) Las dos cosas — Escribe 1, 2 o 3:` | `1` (Dev contesta; Ana escribiría `2`) |
| *(solo si vas a contestar)* `Carpeta a compartir (Enter para usar ~/AgentBridge/compartido):` | Enter, para aceptar la que propone |
| *(solo si vas a contestar)* `¿Está bien? [S/n]:` | `s` |
| *(solo si la carpeta se ve peligrosa)* `Escribe CONFIRMAR para continuar:` | Solo si de verdad quieres usar esa carpeta a pesar del aviso |
| *(solo si vas a preguntar)* `¿Ya tienes su enlace? [s/n]:` | `n` la primera vez, si todavía no te lo han pasado |
| *(solo si vas a preguntar y dijiste que sí)* `Pega su enlace:` | el enlace que te compartió la otra persona |
| *(solo si vas a preguntar)* `¿Lo registro ahora? [s/n]:` | `s`, para que la herramienta aparezca dentro de tu Claude Code |

Antes de pedirte la carpeta, `setup` te explica — en el momento en que importa, no antes — lo
mismo que dice la sección de arriba: todo lo que pongas ahí queda visible para quien te pueda
preguntar. Si la carpeta que elijas se ve peligrosa — tu carpeta de usuario, un repositorio de
trabajo (tiene `.git`), o archivos con pinta de credenciales — te lo dice y te pide escribir
`CONFIRMAR` para seguir, o de plano se niega. Nunca crea la carpeta sin avisarte primero.

Al final te dice, sin rodeos, qué quedó listo, qué falta, y cuál es el siguiente comando a correr.
`setup` no reinventa nada: cada paso que da es uno de los comandos de esta misma guía (`connect`,
`setup-responder`, `doctor`, `claude mcp add`), nomás que encadenados y con las preguntas
correctas. Si lo corres sin una terminal interactiva — por ejemplo dentro de un script — te lo dice
de inmediato y te imprime los comandos equivalentes, en vez de quedarse esperando.

El resto de esta guía explica qué hace cada paso por dentro, por si quieres entenderlo, hacer
alguno a mano, o algo te truena y necesitas saber dónde mirar.

## 3. Para quien contesta (Dev)

### Elegir la carpeta compartida

Es el paso más importante de todos. Crea una carpeta nueva, dedicada solo a esto, y copia ahí
**solo** lo que de verdad estés dispuesto a compartir: un README, una nota de arquitectura, una
configuración. No tu repositorio de trabajo, y nada con credenciales.

```bash
mkdir -p ~/AgentBridge/compartido
```

El aviso completo, para que quede clarísimo: todo lo que haya en esa carpeta lo puede leer
cualquier persona a la que le des permiso de preguntarte, incluido un `.env` o un archivo de
llaves, aunque le digas a tu agente que no lo lea. Eso no depende de que el modelo se porte bien:
está impuesto por configuración, y esa configuración solo protege lo que está **dentro** de la
carpeta que elijas.

### Lo que crea el perfil dedicado

```bash
npx -y @joseamica/agentbridge@latest setup-responder --share ~/AgentBridge/compartido
```

Esto crea, en `~/.agentbridge-responder` (puedes cambiarlo con `--profile`): un perfil de Claude
Code aparte —para no mezclarlo con el que usas todos los días—, los permisos restringidos que le
impiden correr comandos, editar archivos o salir a internet, un script `start.sh` para arrancarlo,
y un `CLAUDE.md` con las reglas del respondedor, dentro de la carpeta compartida. Se niega a
continuar si ese perfil quedaría dentro de la carpeta compartida.

### Iniciar sesión y arrancar

```bash
CLAUDE_CONFIG_DIR=~/.agentbridge-responder/claude claude
```

Adentro, escribe `/login`, inicia sesión, y `/exit`. Esto se hace una sola vez.

```bash
~/.agentbridge-responder/start.sh
```

La primera vez te va a preguntar si confías en cargar el "canal de desarrollo" — contesta que sí;
es justo el plugin de AgentBridge que acabas de instalar. Deja esta terminal abierta: es la sesión
que se queda esperando preguntas.

### Qué ves cuando llega una pregunta

En esa misma terminal vas a ver actividad: Claude Code mostrando que recibió algo por el canal de
AgentBridge y, más abajo, que llamó su herramienta `reply` con la respuesta que decidió mandar. No
memorices un texto exacto — lo importante es que veas movimiento ahí, no una terminal inmóvil.

### Comprobar que quedó bien

```bash
npx -y @joseamica/agentbridge@latest doctor --profile ~/.agentbridge-responder --share ~/AgentBridge/compartido
```

Todas las líneas deben decir `[ok]`. Corre esto antes de confiar en la instalación, y de nuevo si
algo se siente raro.

### Darle tu enlace a quien va a preguntarte

```bash
npx -y @joseamica/agentbridge@latest link
```

Mándale ese enlace por donde ya se escriban normalmente. Cuando te llegue su solicitud (sección
siguiente), ahí está el comando completo para verla y aprobarla.

## 4. Para quien pregunta (Ana)

### Conseguir el enlace y pedir permiso

Pídele a Dev su enlace (lo saca con el comando de la sección 3, "Darle tu enlace a quien va a
preguntarte"). Con él en la mano:

```bash
npx -y @joseamica/agentbridge@latest connect "<el enlace de Dev>" --note "soy Ana"
```

El primer paso tarda unos segundos — tu computadora resuelve una prueba de trabajo, a propósito,
como medida contra el abuso. Del lado de Dev, él revisa y decide:

```bash
npx -y @joseamica/agentbridge@latest requests
npx -y @joseamica/agentbridge@latest approve <id>
```

El `<id>` es el que le muestra `requests` junto al nombre de quien pidió permiso (si se
equivocara de persona, `reject <id>` la rechaza en vez de aprobarla). Después de eso, los dos
pueden confirmar el mismo estado con:

```bash
npx -y @joseamica/agentbridge@latest contacts
```

### Preguntar desde la terminal

```bash
npx -y @joseamica/agentbridge@latest ask dev "¿qué timeout aplica para la lectura de tarjeta?" --wait 120
```

Si no quieres esperar en la misma terminal, usa `--no-wait` y consulta después con el identificador
que te da:

```bash
npx -y @joseamica/agentbridge@latest ticket <identificador> --wait 60
```

### Preguntar desde dentro de Claude Code

Que es el chiste de todo esto:

```bash
claude mcp add agentbridge --scope user -- npx -y @joseamica/agentbridge@latest mcp
```

Después de eso hay que **abrir Claude Code**, o reiniciar la sesión que ya estuviera abierta, para
que aparezcan las herramientas nuevas: `list_contacts`, `ask_contact`, `check_answer` y `connect`.
Ya adentro, Ana solo le dice a su agente que le pregunte a Dev.

## 5. Si algo no jala

Lo primero, siempre:

```bash
npx -y @joseamica/agentbridge@latest doctor
```

(Agrega `--profile` y `--share` con las mismas rutas del paso 3 si estás revisando el lado que
contesta.) Cada línea dice `[ok]` o `[falla]`, y el detalle explica exactamente qué falta —
incluyendo, para cada tablero que usas, si aceptó publicar y devolver lo que se le mandó, no solo
si el socket abrió. Es seguro compartir su salida porque no imprime credenciales.

Algo que confunde la primera vez:

- **La herramienta no aparece en Claude Code.** Falta abrir o reiniciar la sesión después del
  `claude mcp add`.
- **Una solicitud o una pregunta no llegan de inmediato.** No hace falta que hagas nada especial:
  se reintentan solas cada vez que corres un comando de AgentBridge (`ask`, `contacts`, `doctor`,
  el servidor MCP mientras esté abierto…), hasta por una semana. Si quien responde tiene la
  computadora apagada, la pregunta simplemente espera.

## 6. Quitar el permiso

```bash
npx -y @joseamica/agentbridge@latest revoke <nombre>
```

`<nombre>` es el que aparece en `contacts`. Si había una pregunta suya en camino cuando revocas,
esa persona no recibe un "se canceló" al instante: recibe el rechazo (con motivo "el permiso
cambió mientras la pregunta seguía en camino") **la próxima vez que su lado reintenta**, que puede
tardar hasta unos minutos.

## Antes de usarlo con algo que importe

Corre el protocolo completo de aceptación:
[`runbooks/aceptacion-0.2.md`](runbooks/aceptacion-0.2.md). Incluye la prueba de que una pregunta
mandada de noche, con quien contesta apagado, llega y se contesta al día siguiente, y ocho
escenarios de seguridad — entre ellos, intentos de que el agente lea cosas que no debe. Las
limitaciones conocidas, sin adornos, están en [`known-gaps.md`](known-gaps.md).

## Correr el CLI desde el código fuente

La guía de arriba no instala nada: todo corre con `npx`. Si en cambio vas a modificar el código de
AgentBridge, córrelo directamente desde tu copia local, ya compilada:

```bash
git clone https://github.com/Joseamica/agentbridge.git
cd agentbridge
npm ci
npm run build
alias ab="node $PWD/packages/cli/dist/main.js"
```

Ojo con ese `alias`: en Mac, `ab` ya es otro programa (ApacheBench). En una terminal nueva donde no
hayas vuelto a definir el alias, `ab` no te va a decir "comando no encontrado" — te va a salir la
ayuda de una herramienta que no tiene nada que ver. Ese choque, y el alias mismo, solo existen en
este camino desde el código fuente; el comando publicado `agentbridge` no lo tiene. Aquí
`setup-responder` y `doctor` también siguen aceptando `--repo <carpeta>` si alguna vez quieres
apuntarlos a una copia distinta de la que los está ejecutando.
