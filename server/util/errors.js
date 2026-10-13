/** Error de negocio con código HTTP y mensaje apto para mostrar al usuario. */
export class HttpError extends Error {
  constructor(status, message, code = 'error', extra = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (msg, code = 'bad_request', extra) => new HttpError(400, msg, code, extra);
export const unauthorized = (msg = 'Tenés que iniciar sesión.', code = 'unauthorized') => new HttpError(401, msg, code);
export const forbidden = (msg = 'No tenés permiso para hacer esto.', code = 'forbidden') => new HttpError(403, msg, code);
export const notFound = (msg = 'No encontrado.', code = 'not_found') => new HttpError(404, msg, code);
export const conflict = (msg, code = 'conflict', extra) => new HttpError(409, msg, code, extra);
