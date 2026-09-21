# AgentBridge — decisiones tomadas durante la implementación y trabajo pendiente

Es la lista de las decisiones que se tomaron apartándose del plan durante la implementación —0.2
primero, 0.3 después— y de lo que quedó deliberadamente sin arreglar. Lo más reciente va arriba.
(Hasta 0.1.x, AgentBridge corría sobre un relé
propio en Render cuyo operador podía leer todo el contenido; 0.2 lo reemplaza por completo con
tableros públicos de Nostr — ver
`docs/superpowers/specs/2026-09-16-nostr-transport-design.md` y la sección de privacidad del
README. Los pendientes que solo existían por ese relé desaparecieron con él y no están en esta
lista.)

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
  OneDrive se le pasa. En Windows, el "Known Folder Move" de OneDrive mueve Documentos, Escritorio
  e Imágenes, pero no la raíz del perfil de usuario, así que la ubicación predeterminada casi nunca
  va a coincidir — este chequeo se gana el sueldo sobre todo cuando alguien elige la carpeta él
  mismo.
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

- **Todo lo que esté en la carpeta compartida es legible** por el agente que responde, incluido un
  `.env` o una llave, porque `Grep` no está negado y las dos reglas `Read(**/.env*)` no lo cubren.
  El modelo mental correcto es: esa carpeta es pública para quien te pueda preguntar.
- **Configuración de proyecto que llegue después** a esa carpeta (por sincronización o `git pull`)
  toma efecto en el siguiente arranque. `doctor` la marca; nada la impide.
- **Fuera de la carpeta compartida no hay alcance** por herramientas de archivo, en cualquier modo
  de permisos.

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
