# Inicio rápido

Guía para las dos personas que van a probarlo. Si buscas la explicación técnica del proyecto,
está en el [README](../README.md).

## La idea, en una frase

Tu agente le pregunta al agente de otra persona, con el permiso de esa persona, sin que ninguno de
los dos tenga que estar disponible en el mismo momento.

## Cómo funciona, con una analogía

Las dos computadoras nunca se hablan entre sí, y ninguna queda expuesta a internet. Las dos le
hablan a un **relay** que tú instalas, que funciona como la recepción de un edificio: los dos
dejan y recogen mensajes ahí.

Quien contesta arma un **cuarto cerrado**: una carpeta donde copia solo lo que está dispuesto a
compartir. Su agente puede leer esa carpeta y **nada más de su computadora**. Eso no depende de
que el modelo se porte bien: está impuesto por configuración.

La consecuencia, que conviene tener clarísima: **todo lo que esté en esa carpeta es visible** para
quien tenga permiso de preguntar. Incluido un `.env` o un archivo de llaves. Por eso la carpeta se
arma a propósito, con copias. **No apuntes esto a tu repositorio de trabajo.**

## Quién hace qué

Hay tres papeles. En una prueba entre dos personas, normalmente una carga con dos.

| Papel | Quién | Qué hace |
| --- | --- | --- |
| **Operador del relay** | quien lo instala, casi siempre tú | Lo despliega una vez y reparte un enlace de alta por persona. **Puede leer todas las preguntas y respuestas**: dilo en voz alta. |
| **Quien contesta** | la persona que tiene el conocimiento | Deja una sesión de Claude Code corriendo en el cuarto cerrado. |
| **Quien pregunta** | la persona con la duda | Pregunta desde su propio Claude Code, o desde la terminal. |

El permiso va **en una sola dirección**. Que Ana pueda preguntarle a Dev no le permite a Dev
preguntarle a Ana. Si quieren las dos direcciones, hacen el paso del permiso dos veces, una en
cada sentido. Cualquiera de los dos puede quitarlo cuando quiera.

En esta guía **Ana pregunta** y **Dev contesta**. Cambia los nombres por los de ustedes.

## Lo más rápido: un solo comando

En cada computadora, en vez de seguir la lista de pasos de más abajo, puedes correr un único
comando guiado, en español:

```bash
npx -y @joseamica/agentbridge@latest setup
```

Te pregunta lo necesario: si esta computadora ya está dada de alta (y si no, te pide el enlace),
qué vas a hacer aquí — contestar, preguntar, o las dos cosas — y, si vas a contestar, qué carpeta
vas a compartir. Antes de esa última pregunta te explica, otra vez y en el momento en que importa,
lo mismo que dice la sección de arriba: todo lo que pongas en esa carpeta queda visible para quien
te pueda preguntar. Si la carpeta que eliges se ve peligrosa — tu carpeta de usuario, un
repositorio de trabajo (tiene `.git`), o archivos con pinta de credenciales — te lo dice y te pide
escribir una confirmación exacta para seguir, o de plano se niega. Nunca la crea sin avisarte
primero.

Al final te dice, sin rodeos, qué quedó listo, qué falta, y cuál es el siguiente comando a correr.

`setup` no reinventa nada: cada paso que da es uno de los comandos de esta misma guía (`enroll`,
`setup-responder`, `doctor`, `claude mcp add`), nomás que encadenados y con las preguntas
correctas. Si lo corres sin una terminal interactiva — por ejemplo dentro de un script — te lo
dice de inmediato y te imprime los comandos equivalentes, en vez de quedarse esperando.

El resto de esta guía explica qué hace cada paso por dentro, por si quieres entenderlo, hacer
alguno a mano, automatizarlo, o algo te truena y necesitas saber dónde mirar.

## Antes de empezar

Las dos computadoras necesitan Node 22.4 o más nuevo, solo para correr `npx`. Dev además necesita
Claude Code instalado. Ana solo lo necesita si quiere preguntar desde su agente en vez de desde la
terminal.

En **las dos** computadoras: nada que clonar, compilar ni alias que definir. Cada comando de esta
guía corre con `npx`, que descarga AgentBridge la primera vez y lo reutiliza después:

```bash
npx -y @joseamica/agentbridge@latest --help
```

(¿Vas a modificar el código de AgentBridge en vez de solo usarlo? Mira
[Correr el CLI desde el código fuente](#correr-el-cli-desde-el-código-fuente) al final de esta
guía.)

## Una sola vez: el relay

Despliega el relay con el `render.yaml` que viene incluido, o donde quieras que te dé Postgres y
una URL pública. Ponle a `ADMIN_TOKEN` una cadena larga y aleatoria, y **guárdala en tu gestor de
contraseñas**. Con eso se generan las altas, así que es la credencial maestra. Nunca la pegues en
un chat ni se la des a un agente.

Luego generas un enlace por persona. Cada enlace sirve una sola vez, caduca, y se amarra a la
primera computadora que lo use:

```bash
read -rs AGENTBRIDGE_ADMIN_TOKEN && export AGENTBRIDGE_ADMIN_TOKEN
export AGENTBRIDGE_RELAY_URL=https://tu-relay.ejemplo.com

npx -y @joseamica/agentbridge@latest admin enroll-link --handle dev --name "Dev"
npx -y @joseamica/agentbridge@latest admin enroll-link --handle ana --name "Ana"
```

Mándale a cada quien su enlace, por donde ya se escriban normalmente.

## En la computadora de Dev, el que contesta

`agentbridge setup` llega al mismo resultado que los pasos 1, 3 y 5 de aquí abajo — pero no
corriéndolos tal cual. Se da de alta en la identidad *por defecto* de esta computadora (no
directamente en `~/.agentbridge-responder`) y luego copia esa misma credencial al perfil del
respondedor, para que la sesión dedicada del paso 3 la encuentre igual. También corre las
verificaciones de seguridad sobre la carpeta compartida y te dice qué falta. Por eso, **no hagas
las dos cosas**: si ya usaste tu enlace a mano con el paso 1 de aquí abajo, correr `setup`
después te va a pedir un enlace que ya no tienes, porque busca la identidad en la carpeta por
defecto primero, no en `~/.agentbridge-responder`. Elige un solo camino. Lo que sigue es lo que
`setup` hace por dentro, y cómo hacer cualquiera de esas partes a mano si prefieres saltártelo.

**1. Darse de alta — en la carpeta del respondedor, no en la de siempre.**

```bash
AGENTBRIDGE_HOME=~/.agentbridge-responder npx -y @joseamica/agentbridge@latest enroll "<el enlace de Dev>"
AGENTBRIDGE_HOME=~/.agentbridge-responder npx -y @joseamica/agentbridge@latest whoami
```

La sesión dedicada que vas a arrancar con `start.sh` siempre corre con
`AGENTBRIDGE_HOME=~/.agentbridge-responder` (así se evita mezclarla con tu identidad normal de
Claude Code). Si te das de alta en cualquier otro lado — incluida la carpeta por defecto,
`~/.agentbridge` — esa sesión no va a encontrar ninguna credencial y se va a cerrar sola en vez de
conectarse. Los enlaces de alta sirven una sola vez, así que si te equivocas aquí vas a necesitar
pedirle uno nuevo a quien opera el relay.

**2. Armar el cuarto.** Crea la carpeta y copia dentro **solo** lo que estés dispuesto a
compartir: un README, una configuración, una nota de arquitectura. Copias, no el repo de trabajo,
y nada con credenciales.

```bash
mkdir -p ~/AgentBridge/compartido
```

**3. Preparar la sesión cerrada.**

```bash
npx -y @joseamica/agentbridge@latest setup-responder --share ~/AgentBridge/compartido --home ~/.agentbridge-responder
```

Esto crea un perfil aparte de Claude Code, le escribe los permisos restringidos, genera un
`start.sh` y deja un `CLAUDE.md` con la personalidad dentro de la carpeta compartida. Si la
credencial fuera a quedar dentro de la carpeta compartida, se niega a continuar. (`--home` ya usa
`~/.agentbridge-responder` por defecto — se escribe aquí para que se vea igual que en el paso 1.)

**4. Iniciar sesión una vez en ese perfil y arrancarlo.** La sesión tiene que quedarse corriendo
para poder contestar: déjala en su propia ventana de terminal, o dentro de tmux.

```bash
~/.agentbridge-responder/start.sh
```

**5. Comprobar que de verdad quedó bien.**

```bash
npx -y @joseamica/agentbridge@latest doctor --home ~/.agentbridge-responder --share ~/AgentBridge/compartido
```

Todas las líneas deben decir `[ok]`. Este es el paso que te confirma que el candado existe, que el
plugin quedó instalado y que no se coló nada peligroso en la carpeta compartida. **Córrelo antes
de confiar en la instalación**, y vuelve a correrlo si algo se siente raro.

**6. Darle permiso a Ana.**

```bash
AGENTBRIDGE_HOME=~/.agentbridge-responder npx -y @joseamica/agentbridge@latest invite
```

Mándale a Ana el enlace que imprime. Eso es lo que le da permiso de preguntarte. Se lo puedes
quitar cuando quieras con `AGENTBRIDGE_HOME=~/.agentbridge-responder npx -y @joseamica/agentbridge@latest
revoke ana`. Cualquier comando que corras después sobre esta identidad —`invite`, `revoke`,
`contacts`, un `whoami` más adelante— necesita ese mismo `AGENTBRIDGE_HOME`, porque ahí es donde
quedó la credencial desde el paso 1; expórtalo una vez para toda la terminal y te ahorras
repetirlo.

## En la computadora de Ana, la que pregunta

`agentbridge setup` hace por ella el paso 1 de aquí abajo y, si se lo pide, también registra el
servidor MCP del paso 3 — recordándole reiniciar Claude Code después. Esto es lo que hace, paso a
paso, y cómo hacer cualquiera de ellos a mano.

**1. Darse de alta con su propio enlace.**

```bash
npx -y @joseamica/agentbridge@latest enroll "<el enlace de Ana>"
```

**2. Aceptar la invitación de Dev.**

```bash
npx -y @joseamica/agentbridge@latest accept "<el enlace de invitación de Dev>"
npx -y @joseamica/agentbridge@latest contacts
```

En `contacts` ya debe aparecer Dev en la lista de a quién puede preguntarle.

**3. Preguntar.** Desde la terminal:

```bash
npx -y @joseamica/agentbridge@latest ask dev "¿qué timeout aplica para la lectura de tarjeta?" --wait 120
```

O, que es el chiste de todo esto, desde su propio Claude Code:

```bash
claude mcp add agentbridge --scope user -- npx -y @joseamica/agentbridge@latest mcp
```

Después de eso hay que **abrir Claude Code**, o reiniciar la sesión que ya estuviera abierta, para
que aparezca la herramienta nueva. Ya adentro, Ana solo le dice a su agente que le pregunte a Dev.

## De ahí en adelante

Dev deja su sesión corriendo y se olvida. Ana pregunta cuando lo necesita. Ninguno de los dos
interrumpe al otro. Si la sesión de Dev está apagada, la pregunta se queda esperando en la fila.

## Si algo no jala

Lo primero, siempre: `npx -y @joseamica/agentbridge@latest doctor` con las mismas rutas del paso 5. Está
hecho para explicarte qué falta, y es seguro compartir su salida porque no imprime credenciales.

Algo que confunde la primera vez:

- **La herramienta no aparece en Claude Code.** Falta abrir o reiniciar la sesión después del
  `claude mcp add`.

## Antes de usarlo con algo que importe

Corre el protocolo completo de aceptación: [`m1-acceptance.md`](runbooks/m1-acceptance.md). Son
ocho escenarios de seguridad, incluidos los intentos de que el agente lea cosas que no debe. Y las
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
