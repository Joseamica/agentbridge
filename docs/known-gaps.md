# AgentBridge 0.2 — decisiones tomadas durante la implementación y trabajo pendiente

Es la lista de las decisiones que se tomaron apartándose del plan durante la implementación de 0.2,
y de lo que quedó deliberadamente sin arreglar. (Hasta 0.1.x, AgentBridge corría sobre un relé
propio en Render cuyo operador podía leer todo el contenido; 0.2 lo reemplaza por completo con
tableros públicos de Nostr — ver
`docs/superpowers/specs/2026-09-16-nostr-transport-design.md` y la sección de privacidad del
README. Los pendientes que solo existían por ese relé desaparecieron con él y no están en esta
lista.)

## Decisiones que se apartaron del plan

Cada una se tomó porque el plan y la realidad no coincidían. Si alguna resulta equivocada, el
costo está escrito para que se pueda revertir con criterio.

1. **`blockReadsOutsideWorkingDirectories` en los ajustes del respondedor**, aunque el plan no lo
   pedía. El modo `dontAsk` ya niega esas lecturas, pero es el modo el que carga la garantía; el
   ajuste la sostiene en cualquier modo. Va **anidado dentro de `permissions`**: una copia en la
   raíz del archivo se acepta y se ignora en silencio.
2. **Las descripciones de herramientas MCP se quedan en inglés.** Las lee el modelo, no una
   persona. El CLAUDE.md del proyecto dice que las instrucciones al modelo van en inglés.
3. **Un solo traductor de errores al español** (`packages/cli/src/spanish-errors.ts`) compartido
   por el router y los dos servidores MCP. El mismo error en inglés se filtró tres veces en tareas
   distintas antes de consolidarlo.
4. **El modelo se valida por caracteres seguros, no por lista blanca.** Un id completo como
   `claude-haiku-4-5-20251001` es válido y una enumeración lo rechazaría. El esfuerzo sí es lista
   cerrada: `low|medium|high|xhigh|max`.
5. **`doctor` depende de que `claude` esté instalado.** Un chequeo que no puede decirte que el
   perfil nunca inició sesión es justo el punto ciego que hacía que dijera "todo en orden" sobre
   una instalación rota. Si falta el comando, lo reporta en español.

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
- El README y la guía en español describen los disparadores del candado como carpeta personal,
  repositorio git y archivos con pinta de credenciales. Ahora también disparan los enlaces
  simbólicos y un `node_modules` que no se pudo revisar.
- El candado avisa de cualquier enlace simbólico, incluso de los que `doctor` considera
  inofensivos por no salir de la carpeta. Es a propósito: prefiere errar del lado seguro.

## 0.2 — respondedor: brechas verificadas y deliberadas

Plan 2 (el lado que responde preguntas). Verificadas y acotadas; ninguna bloquea el uso.

1. **Linux y el reloj del sistema.** El candado del canal compara la hora de arranque del proceso
   (`ps -o lstart=`). En Linux esa hora se deriva del arranque del sistema, así que un salto del
   reloj (NTP, reanudar una VM) puede hacer que un canal vivo se vea como muerto: si en ese momento
   se abre un segundo canal, se queda con el candado y el primero se cierra solo (su pregunta
   vuelve a la cola, no se pierde nada). Candidato de arreglo en el plan 4: en Linux leer los ticks
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
