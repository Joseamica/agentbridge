import type { FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler<Error>((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    }
    if (err instanceof ZodError) {
      const fields = Array.from(new Set(err.issues.map((i) => (i.path.length ? i.path.join('.') : 'cuerpo'))))
      return reply
        .status(400)
        .send({ error: { code: 'invalid_request', message: `Datos inválidos en: ${fields.join(', ')}` } })
    }
    const statusCode = (err as { statusCode?: number }).statusCode
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({ error: { code: 'invalid_request', message: 'Solicitud inválida' } })
    }
    app.log.error(err)
    return reply.status(500).send({ error: { code: 'internal', message: 'Error interno del relay' } })
  })

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: { code: 'not_found', message: 'Ruta no encontrada' } })
  })
}
