import { setTimeout as delay } from 'node:timers/promises'

// Stands in for Claude Code during the startup window — before it has grabbed the terminal and
// started handling Ctrl+C itself. It does nothing about SIGINT, so Node's default applies and the
// signal kills it, which is exactly the shape `runResponder`'s `code === null` branch is written
// for. The marker goes out before the wait so the driving test never has to guess when this
// process is actually up.
console.log('CHILD_READY')
await delay(10_000)
console.log('CHILD_FINISHED_ON_ITS_OWN')
