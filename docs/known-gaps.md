# AgentBridge M1 — decisiones tomadas durante la ejecución y trabajo pendiente

Hito M1. Es la lista de las decisiones que se tomaron apartándose del plan durante la
implementación, y de lo que quedó deliberadamente sin arreglar.

## Decisiones que se apartaron del plan

Cada una se tomó porque el plan y la realidad no coincidían. Si alguna resulta equivocada, el
costo está escrito para que se pueda revertir con criterio.

1. **Recuperación al arrancar en vez de drenar al apagar** (relay). En cada boot se cierran los
   intentos abiertos y sus tickets vuelven a la cola. Cubre también las caídas, que un drenado no
   cubre. Costo: durante el solape de un despliegue sin downtime, una pregunta puede reenviarse.
2. **`blockReadsOutsideWorkingDirectories` en los ajustes del respondedor**, aunque el plan no lo
   pedía. El modo `dontAsk` ya niega esas lecturas, pero es el modo el que carga la garantía; el
   ajuste la sostiene en cualquier modo. Va **anidado dentro de `permissions`**: una copia en la
   raíz del archivo se acepta y se ignora en silencio.
3. **Las descripciones de herramientas MCP se quedan en inglés.** Las lee el modelo, no una
   persona. El CLAUDE.md del proyecto dice que las instrucciones al modelo van en inglés.
4. **Un solo traductor de errores al español** (`packages/cli/src/spanish-errors.ts`) compartido
   por el router y el servidor MCP. El mismo error en inglés se filtró tres veces en tareas
   distintas antes de consolidarlo.
5. **El modelo se valida por caracteres seguros, no por lista blanca.** Un id completo como
   `claude-haiku-4-5-20251001` es válido y una enumeración lo rechazaría. El esfuerzo sí es lista
   cerrada: `low|medium|high|xhigh|max`.
6. **`doctor` depende de que `claude` esté instalado.** Un chequeo que no puede decirte que el
   perfil nunca inició sesión es justo el punto ciego que hacía que dijera "todo en orden" sobre
   una instalación rota. Si falta el comando, lo reporta en español.

## Pendiente, en orden de importancia

Nada de esto bloquea el piloto. Todo está verificado y acotado.

### Antes de meter a una tercera persona
- **`doctor` no revisa `CLAUDE.md` que llegue después** a la carpeta compartida. No puede
  compararlo contra nada porque `setup-responder` escribe uno; necesitaría contrastar con
  `RESPONDER_PERSONA`.
- **Orden de locks en el relay**: el barrendero toma `attempts→tickets` y la revocación
  `tickets→attempts`. Se reprodujo un deadlock real (SQLSTATE 40P01). Cuando ocurra, `DELETE
  /v1/grants/:handle` responde 500 y la revocación no pasó; reintentar funciona. Se arregla con un
  reintento en 40P01 o cerrando los intentos primero.

### Correctitud
- **No hay ping/pong del lado del servidor.** Una conexión medio abierta (tapa cerrada, wifi
  caído) no se detecta: el ticket termina en `expired`, que es terminal, en vez de volver a la
  cola. Contradice la promesa de 24 horas del runbook.
- **`hub.ts:223` hace `return false` donde debería lanzar**, así que un `outcome='answered'` puede
  quedar comprometido para un ticket que nadie contestó. Hoy inalcanzable; una palabra lo arregla.
- **`http.ts:48`**: una respuesta no-JSON del relay sale como `HTTP 502` pelón. Es lo que verá
  cualquiera cuando Render arranque en frío.
- **`writeConfig` no es atómico.** Si truena a media escritura, recuperar exige un enlace de alta
  nuevo del operador del relay.
- **`main.ts` llama `process.exit(0)`** justo después de `relay.stop()`, así que el cierre
  asíncrono del socket no alcanza a correr. Cosmético: el requeue del relay lo dispara el socket
  al cerrarse, no el handler.

### Higiene
- Las pruebas de ciclos de symlink se ponen rojas por el timeout global de vitest, no por su
  propia aserción de tiempo. Una regresión futura se leerá como "test timed out" en vez del
  mensaje puntual que promete el comentario.
- Valores muertos del protocolo: `'replaced'` y `'invalid'` no los emite nadie.
- `render.yaml` no fija `plan`, `postgresMajorVersion` ni `numInstances`.
- Dos definiciones distintas de `latencyMs` (reloj del relay contra reloj de la base).
- `doctor` no revisa permisos de directorios: un `<home>/claude` que quedó en 0755 por una corrida
  previa de `claude` no se detecta, y `ensureOwnedDir` no lo repara a propósito.

## Exposición residual, tal como quedó

- **Todo lo que esté en la carpeta compartida es legible** por el agente que responde, incluido un
  `.env` o una llave, porque `Grep` no está negado y las dos reglas `Read(**/.env*)` no lo cubren.
  El modelo mental correcto es: esa carpeta es pública para quien te pueda preguntar.
- **Configuración de proyecto que llegue después** a esa carpeta (por sincronización o `git pull`)
  toma efecto en el siguiente arranque. `doctor` la marca; nada la impide.
- **El operador del relay lee todo** el contenido de preguntas y respuestas durante 7 días, y
  puede acuñarse un dispositivo bajo un handle existente y heredar sus permisos.
- **Fuera de la carpeta compartida no hay alcance** por herramientas de archivo, en cualquier modo
  de permisos.

## Pendientes del comando guiado `setup`

Todo esto es preexistente o cosmético, verificado y acotado. Ninguno bloquea el uso.

- Un `config.json` del respondedor que sea JSON válido pero no una configuración (por ejemplo
  `{}`) revienta con `Error inesperado: Cannot read properties of undefined` y código de salida 2,
  en inglés (`packages/core/src/http.ts:28`). Un archivo verdaderamente corrupto sí se maneja bien,
  en español y con salida 1.
- `scanShareDirForDanger` se salta en silencio una subcarpeta que no puede leer
  (`setup.ts:262-266`). Es la misma forma del bug de los enlaces simbólicos: "no pude mirar y no
  dije nada". No es una exposición, porque la sesión respondedora corre con el mismo usuario y
  tampoco podría leerla.
- Un enlace de alta mal escrito o caducado termina la corrida en vez de volver a preguntar;
  `askWithRetries` solo reintenta cuando la respuesta viene vacía.
- En el camino manual, `setup-responder` corrido por separado todavía dice "1. Da de alta este
  dispositivo" justo después de que el paso 1 de la guía ya te dio de alta. Dentro de `setup` esa
  contradicción ya no aparece.
- El README y la guía en español describen los disparadores del candado como carpeta personal,
  repositorio git y archivos con pinta de credenciales. Ahora también disparan los enlaces
  simbólicos y un `node_modules` que no se pudo revisar.
- El candado avisa de cualquier enlace simbólico, incluso de los que el `doctor` considera
  inofensivos por no salir de la carpeta. Es a propósito: prefiere errar del lado seguro.
