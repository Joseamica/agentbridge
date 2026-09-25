# AgentBridge — decisiones tomadas durante la implementación y trabajo pendiente

Es la lista de las decisiones que se tomaron apartándose del plan durante la implementación —0.2
primero, 0.3 y 0.4 después— y de lo que quedó deliberadamente sin arreglar. Lo más reciente va arriba.
(Hasta 0.1.x, AgentBridge corría sobre un relé
propio en Render cuyo operador podía leer todo el contenido; 0.2 lo reemplaza por completo con
tableros públicos de Nostr — ver
`docs/superpowers/specs/2026-09-16-nostr-transport-design.md` y la sección de privacidad del
README. Los pendientes que solo existían por ese relé desaparecieron con él y no están en esta
lista.)

## 0.4 — qué puede ver el agente que contesta: lo que queda fuera a propósito

Esta versión deja que quien contesta elija el alcance de su agente: una carpeta (lo de siempre),
varias, o toda su carpeta personal menos una caja fuerte fija. Esto es lo que **no** hace, y por qué.

- **Una sola elección para todos los contactos.** No se puede dejar que Ana vea toda tu carpeta
  personal y Beto solo la carpeta compartida. Hacerlo exige un agente que contesta por contacto
  —otro perfil dedicado, otra sesión corriendo—, y eso es otro producto. Quien necesite alcances
  distintos tiene que elegir el más estrecho que le sirva a todos.
- **La caja fuerte es una lista fija.** Vive en el código (`CAJA_FUERTE_HOME` en
  `packages/cli/src/commands/setup-responder.ts`, más la carpeta de la identidad y la del perfil
  dedicado, dondequiera que estén) y nadie la puede abrir ni ampliar desde `setup`: lo decidió el
  dueño del proyecto, a propósito. La consecuencia hay que decirla tal cual: **cierra los lugares
  más conocidos donde se guardan contraseñas y llaves, no todos los secretos.** Una contraseña
  escrita en un documento, los correos y chats guardados en la computadora, o un archivo de llaves
  con un nombre poco común (un `id_rsa` fuera de `~/.ssh`, un `credentials.json`, la exportación de
  un gestor de contraseñas) se leen en la opción 3, y en la opción 2 si están dentro de una carpeta
  elegida. Ampliar la lista sin fin nunca la haría completa; los textos de `setup`, `doctor` y la
  guía dicen lo que cubre y lo que no.
- **La opción 2 no existe en Windows.** Proteger los archivos de llaves de cada carpeta extra exige
  escribir su ruta absoluta dentro de una regla, y no está comprobado cómo ancla Claude Code una
  ruta con letra de unidad (`C:\…`). Una forma adivinada que no coincide con nada parecería
  protección y no cubriría nada —el mismo fallo que V6—, así que `setup` la rechaza con una frase.
- **La opción 3 en Windows solo con todo dentro de la carpeta personal**, por la misma razón: la
  carpeta compartida, la identidad y el perfil dedicado se protegen con reglas `~/…`, y fuera de la
  carpeta personal habría que escribir una ruta con letra de unidad. Además, **que las reglas `~/…`
  se sostengan en Windows tampoco está comprobado**: todas las verificaciones se hicieron en macOS.
  La sección 8 del runbook es la forma de comprobarlo en una máquina Windows.
- **Una ruta con `*`, `?`, `[`, `]`, `{` o `}` (en Mac y Linux también `\`) se rechaza**, no se
  escapa: si Claude Code respeta un escape dentro de una regla no está comprobado, y una regla con
  un comodín sin querer no protegería la carpeta.
- **Lo verificado vale para Claude Code 2.1.282.** Todo lo que este diseño supone de Claude Code se
  comprobó contra ese binario antes de escribir el código
  (`.superpowers/sdd/2026-09-25-agentbridge-0.4-alcance/verificaciones.md`, V1–V19): que
  `additionalDirectories` abre carpetas sin apagar la valla; que una regla anclada deniega dentro
  de una carpeta abierta y una sin anclar no (V6); que Grep y Glob respetan esas reglas, también al
  recorrer desde una carpeta de arriba; que una variante en mayúsculas o una ruta que pasa por un
  enlace simbólico también se deniegan (V8, V11); que las reglas de un solo archivo y las de
  asterisco final cierran (V14, V15); que la importación de `.agentbridge-scope.md` se carga sola y
  sin pedir aprobación (V16, V17); y que **nada de la configuración de una carpeta extra llega al
  modelo** —ni habilidades, ni comandos, ni subagentes, ni `.mcp.json`, ni `CLAUDE.local.md`, ni
  `AGENTS.md` (V18)—, con el control de que esos mismos archivos en la carpeta de trabajo sí se
  cargan (V19), sin el cual el "no llegó" no probaría nada. Una versión futura de Claude Code podría
  cambiar cualquiera de estas cosas sin avisar. Por eso la sección 8 del runbook
  (`docs/runbooks/aceptacion-0.4.md`) las vuelve a comprobar contra el Claude Code instalado.
- **`doctor` recorre las carpetas extra con límite** (20000 elementos o 6 niveles de profundidad) y
  dice cuando no terminó, sin marcarlo como falla; la carpeta compartida se sigue recorriendo
  entera. Y en las carpetas extra no busca configuración de proyecto: por V18 no llega al modelo, y
  marcarla era una falsa alarma bloqueante justo en la carpeta que más se añade, un proyecto.
- **En Mac, macOS puede no dejar entrar a la terminal** en Documentos, Escritorio o Descargas.
  `doctor` lo detecta por el error, no por el nombre de la carpeta, y dice dónde se da el permiso;
  no lo puede dar por ti. En la opción 3 no hay un chequeo equivalente para cada carpeta de la
  carpeta personal: si macOS le niega una a la terminal, tu agente tampoco la puede leer, y nadie
  lo dice.

## 0.3 — el setup interactivo: lo que queda fuera a propósito

Esta versión existe porque una persona que no programa instaló la 0.2.0 en Windows y la instalación
—no el transporte— fue lo que se rompió. `setup` pasó de imprimir instrucciones a ejecutarlas. Esto
es lo que **no** hace, y por qué.

- **El inicio de sesión de Claude lo hace la persona.** El asistente abre la ventana correcta, en el
  perfil correcto, y comprueba después si quedó iniciada; escribir la contraseña es de ella. No hay
  forma de automatizarlo y no debería haberla.
- **El portapapeles puede no existir.** En un Linux sin `wl-copy`, `xclip` ni `xsel`, el enlace se
  imprime y ya. Es una comodidad; nada depende de ella.
- **Windows no se prueba en CI.** Las dos correcciones de esta versión que dependen de la
  plataforma (los permisos POSIX que ya no se exigen ahí, y el aviso de carpetas sincronizadas)
  están probadas inyectando la plataforma, no corriendo en Windows. Por eso el runbook de
  aceptación pide que, si se puede, una de las dos máquinas sea Windows.
- **Windows con Claude Code instalado por npm.** Todos los `spawn` de este proyecto corren sin
  shell —a propósito: es lo que hace que una ruta con espacios o un apóstrofo no se reinterprete—,
  y un `spawn` sin shell no puede lanzar un `claude.cmd`, que es justo lo que produce
  `npm i -g @anthropic-ai/claude-code` en Windows. La evidencia dice que ese no es el camino común:
  la instalación real de Windows que originó este plan ejecutó `claude plugin install` y
  `claude auth status --json` por ese mismo `spawn` sin problema. Pero quien haya instalado Claude
  Code por npm en Windows va a ver "no pude ejecutar Claude Code", y el arreglo es instalarlo con
  su propio instalador, o cerrar y volver a abrir la terminal. No construimos un rodeo porque no se
  puede probar en esta máquina, justo en la plataforma donde equivocarse cuesta más caro.
- **El aviso de carpeta sincronizada mira solo la carpeta de la identidad, y solo su nombre
  literal.** No revisa el perfil dedicado de Claude (que es donde queda la credencial del inicio de
  sesión) y no resuelve enlaces simbólicos, así que un `~/.agentbridge` que sea un enlace hacia
  OneDrive se le pasa. Además —y esto es razonado, no probado aquí: no hay forma de comprobarlo en
  esta máquina— en Windows el "Known Folder Move" de OneDrive mueve Documentos, Escritorio e
  Imágenes, pero no la raíz del perfil de usuario, así que la ubicación predeterminada casi nunca
  va a coincidir. Si eso es correcto, este chequeo se gana el sueldo sobre todo cuando alguien
  elige la carpeta él mismo.
- **El comando de todos los días es largo.** No instalamos nada en el PATH, así que ponerse a
  contestar al día siguiente se escribe `npx -y @joseamica/agentbridge@latest responder`. `setup` lo
  arranca por ti la primera vez, y eso cubre el peor momento; el resto de los días sigue siendo una
  línea larga. Acortarla querría decir instalar un binario global, que es una decisión de producto,
  no una corrección de este plan.
- **La reparación de permisos de la identidad solo ocurre en `setup`.** `loadOrCreateIdentity` es
  quien aprieta un `~/.agentbridge` en 0755 o un `identity.json` en 0644, y el único comando que lo
  llama es `setup`. Los demás cargan la identidad en modo lectura y no la tocan, así que `doctor`
  puede seguir marcando el permiso hasta que se vuelva a correr `setup` — que es exactamente lo que
  su remedio dice.

## Decisiones que se apartaron del plan

Cada una se tomó porque el plan y la realidad no coincidían. Si alguna resulta equivocada, el
costo está escrito para que se pueda revertir con criterio.

1. **`blockReadsOutsideWorkingDirectories` en los ajustes del respondedor**, aunque el plan no lo
   pedía. El modo `dontAsk` ya niega esas lecturas, pero es el modo el que carga la garantía; el
   ajuste la sostiene en cualquier modo. Va **anidado dentro de `permissions`**: una copia en la
   raíz del archivo se acepta y se ignora en silencio.
2. **Las descripciones de herramientas MCP se quedan en inglés.** Las lee el modelo, no una
   persona. El CLAUDE.md del proyecto dice que las instrucciones al modelo van en inglés.
3. **Un solo traductor de errores al español** (`packages/cli/src/spanish-errors.ts`), usado hoy
   por `setup.ts` y por el servidor MCP del preguntador (`mcp-asker.ts`); el router ya no lo
   importa. El mismo error en inglés se filtró tres veces en tareas distintas antes de
   consolidarlo. `packages/channel/src/channel.ts` (otro workspace) tiene su propia copia de la
   misma lógica para errores de Zod en vez de importar de aquí — deliberado y preexistente, pero
   vale decirlo ya que la regla de "un solo traductor" está escrita en un lugar y rota en el de al
   lado.
4. **El modelo se valida por caracteres seguros, no por lista blanca.** Un id completo como
   `claude-haiku-4-5-20251001` es válido y una enumeración lo rechazaría. El esfuerzo sí es lista
   cerrada: `low|medium|high|xhigh|max`.
5. **`doctor` depende de que `claude` esté instalado.** Un chequeo que no puede decirte que el
   perfil nunca inició sesión es justo el punto ciego que hacía que dijera "todo en orden" sobre
   una instalación rota. Si falta el comando, lo reporta en español.
6. **La prueba de tablero de `doctor` (`probeBoard`) dirige su sobre a una llave efímera, no a la
   propia**, aunque el spec dice "publica un sobre dirigido a la propia llave y lo vuelve a leer"
   (`docs/superpowers/specs/2026-09-16-nostr-transport-design.md`, línea 284). Es más seguro, no
   menos: un tablero que solo sirve sobres etiquetados para el lector autenticado haría fallar la
   prueba en vez de darla por buena por error, y el destinatario efímero evita que `doctor` escriba
   en la propia bandeja un sobre indescifrable que viviría ahí siete días.

## Pendiente, en orden de importancia

Nada de esto bloquea el piloto. Todo está verificado y acotado.

### Antes de meter a una tercera persona
- **`doctor` no revisa `CLAUDE.md` que llegue después** a la carpeta compartida. No puede
  compararlo contra nada porque `setup-responder` escribe uno; necesitaría contrastar con
  `RESPONDER_PERSONA`.

### Higiene
- Las pruebas de ciclos de symlink (`packages/cli/test/fs-paths.test.ts`) se ponen rojas por el
  timeout global de vitest, no por su propia aserción de tiempo. Una regresión futura se leerá
  como "test timed out" en vez del mensaje puntual que promete el comentario.
- `doctor` no revisa permisos de directorios: un `<perfil>/claude` que quedó en 0755 por una
  corrida previa de `claude` no se detecta, y `ensureOwnedDir` (`setup-responder.ts`) no lo repara
  a propósito — solo aplica el modo a una carpeta que él mismo acaba de crear.

## Exposición residual, tal como quedó

- **Todo lo que esté en la carpeta compartida es legible** por el agente que responde, incluido
  un archivo de llaves, salvo los que se llaman `.env` o `.env.*` (y, en las opciones 2 y 3, los
  `.pem`, `.key`, `.p12` y `.pfx`). En 0.3 esta línea decía que un `.env` también se leía, por
  Grep; en Claude Code 2.1.282 Grep se salta los archivos denegados (V6, V13 de las
  verificaciones de 0.4). El modelo mental correcto sigue siendo: esa carpeta es pública para quien
  te pueda preguntar.
- **En las opciones 2 y 3, lo mismo vale para todo lo que el agente puede leer**: las carpetas
  elegidas, o toda la carpeta personal menos la caja fuerte.
- **Configuración de proyecto que llegue después** a esa carpeta (por sincronización o `git pull`)
  toma efecto en el siguiente arranque. `doctor` la marca; nada la impide.
- **Fuera de lo que eligió quien contesta no hay alcance** por herramientas de archivo, en
  cualquier modo de permisos: la valla sigue puesta en las tres opciones.

## Pendientes del comando guiado `setup`

Todo esto es preexistente o cosmético, verificado y acotado. Ninguno bloquea el uso.

- `scanShareDirForDanger` se salta en silencio una subcarpeta que no puede leer
  (`setup.ts:280-283`). Es la misma forma de bug que la de los enlaces simbólicos: "no pude mirar y
  no dije nada". No es una exposición, porque la sesión respondedora corre con el mismo usuario y
  tampoco podría leerla.
- Un enlace de otra persona mal escrito, pasado a `connect` durante el flujo guiado de preguntar,
  termina la corrida en vez de volver a preguntar; `askWithRetries` solo reintenta cuando la
  respuesta viene vacía, y nada envuelve la llamada a `connectWith` en un `try/catch` que la
  convierta en un reintento.
- El candado de la carpeta compartida dispara con más cosas de las que su nombre sugiere: además
  de la carpeta personal, un repositorio git y los archivos con pinta de credenciales, también con
  los enlaces simbólicos, con un `node_modules` que no se revisó por dentro, y con un árbol
  demasiado grande o demasiado anidado para recorrerlo completo. El README y la guía en español ya
  los enumeran todos (0.3); si se añade otro disparador, hay que actualizarlos.
- El candado avisa de cualquier enlace simbólico, incluso de los que `doctor` considera
  inofensivos por no salir de la carpeta. Es a propósito: prefiere errar del lado seguro.

## 0.2 — respondedor: brechas verificadas y deliberadas

Plan 2 (el lado que responde preguntas). Verificadas y acotadas; ninguna bloquea el uso.

1. **Linux y el reloj del sistema.** El candado del canal compara la hora de arranque del proceso
   (`ps -o lstart=`). En Linux esa hora se deriva del arranque del sistema, así que un salto del
   reloj (NTP, reanudar una VM) puede hacer que un canal vivo se vea como muerto: si en ese momento
   se abre un segundo canal, se queda con el candado y el primero se cierra solo (su pregunta
   vuelve a la cola, no se pierde nada). Candidato de arreglo en un plan futuro: en Linux leer los ticks
   de arranque de `/proc/<pid>/stat`, que no se mueven.
2. **Un mensaje que siempre falla al guardarse bloquea la recuperación histórica de ese tablero.**
   Si procesar un mensaje lanza siempre el mismo error, su identificador no se marca como visto y
   la pasada histórica de ese tablero falla cada vez, así que su cursor deja de avanzar. Es
   deliberado (nunca descartar un mensaje en silencio) y se ve en el reporte de sincronización y en
   el log, pero no hay reintento acotado ni cuarentena.
3. **La copia de una respuesta en la cola de salida vive hasta 7 días después de la respuesta**,
   mientras que la copia en la bandeja se borra a los 7 días de la pregunta: el contenido de una
   respuesta puede quedar en la cola de salida hasta unos 14 días después de la pregunta.
4. **Los tableros de un contacto ya aprobado no se pueden actualizar.** El spec solo permite
   cambiarlos con un mensaje autenticado de generación mayor o con la solicitud mientras está
   pendiente; si alguien cambia de tableros después de ser aprobado, sus acuses y respuestas siguen
   yendo a los viejos hasta que se revoque y vuelva a solicitar. Es como está especificado, pero no
   hay salida por protocolo; un plan futuro debe decidir si añade una.

## 0.2 — preguntador: brechas verificadas y deliberadas

Plan 3 (el lado que pregunta). Verificadas y acotadas; ninguna bloquea el uso.

1. **Una sincronización corta puede pasar de los diez segundos —hasta cerca de treinta en el peor
   caso— si el tablero de un contacto está lento.** El plazo (`maxMs`, diez segundos por defecto) acota las lecturas de red de
   la sincronización — cada consulta al tablero y cada publicación que todavía no empezó respetan
   ese límite —, pero una fila que ya se minó y reclamó siempre se publica, aunque el plazo haya
   vencido mientras tanto: descartarla significaría volver a minar la misma solicitud de conexión en
   cada comando, para siempre. Esa publicación solo queda acotada por el tiempo
   de espera propio del tablero por relé, y una sincronización del preguntador corre dos rondas de
   publicación — una reservada, antes de leer el historial, para que este no le quite su turno, y la
   propia de `Device.syncOnce` después —, así que la garantía real es "el plazo
   pactado, más como mucho una fila ya reclamada que se pasa del plazo por cada ronda de publicación:
   como mucho dos por sincronización". Pasa en `connect` y en `ask`, los dos
   comandos donde la persona acaba de pedir una acción y ya se le avisa que el primer paso (minar)
   tarda unos segundos; en el peor caso, con un tablero lento en las dos rondas, el comando completo
   se acerca a los treinta segundos en vez de diez.
2. **Mientras espera, `ask --wait` corre el mismo trabajo de fondo que un servidor persistente.** El
   spec dice que solo el servidor MCP y el canal, por ser persistentes, corren reintentos con
   temporizador; `waitForAnswer` arranca igual la suscripción en vivo y, con ella, los temporizadores
   de reintento, historial y purga, durante los segundos que dure `--wait` (hasta dos minutos), lo
   que sube la contención sobre la base de datos si ese comando y el servidor MCP corren a la vez
   sobre la misma carpeta. Se detiene en cuanto el comando termina: no queda nada corriendo después.
   Aceptado a propósito; `tests/asker/multiprocess.test.ts` cubre justamente un comando
   y el servidor MCP compartiendo una carpeta.
