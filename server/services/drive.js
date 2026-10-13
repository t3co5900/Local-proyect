// Subida a Google Drive con OAuth de usuario (tu cuenta personal / Google One).
//
// - Scope mínimo: drive.file => la app solo ve archivos que ella misma crea.
//   Por eso crea su propia carpeta "Mr.Cook Backups" en vez de usar una existente.
// - Un "service account" NO sirve para cuentas personales: Google le niega
//   cuota de almacenamiento en un Drive personal.

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export function buildAuthUrl({ clientId, redirectUri, state }) {
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', DRIVE_SCOPE);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent'); // fuerza que Google devuelva refresh_token
  u.searchParams.set('state', state);
  return u.toString();
}

export async function exchangeCode({ clientId, clientSecret, redirectUri, code, fetchImpl = fetch }) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.refresh_token) {
    throw new Error(
      body.error_description ||
        (body.refresh_token === undefined && res.ok
          ? 'Google no devolvió el permiso permanente. Quitá el acceso de la app en tu cuenta de Google y volvé a conectar.'
          : `Google rechazó la autorización (${res.status}).`),
    );
  }
  return body.refresh_token;
}

export function createDriveClient({ clientId, clientSecret, refreshToken, folderId, fetchImpl = fetch }) {
  let cached = null;

  async function accessToken() {
    if (cached && cached.exp > Date.now() + 30000) return cached.token;
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const hint =
        body.error === 'invalid_grant'
          ? ' El permiso venció o fue revocado: reconectá Google Drive en Configuración. (Si la app de Google Cloud está en modo "Prueba", el permiso vence a los 7 días: publicala.)'
          : '';
      throw new Error(`Google Drive: no se pudo renovar el acceso (${body.error || res.status}).${hint}`);
    }
    cached = { token: body.access_token, exp: Date.now() + (body.expires_in || 3600) * 1000 };
    return cached.token;
  }

  async function api(url, init = {}) {
    const token = await accessToken();
    const res = await fetchImpl(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Google Drive respondió ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  const escapeQ = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  return {
    /** Devuelve el id de la carpeta de respaldos (la crea si no existe). */
    async ensureFolder(name = 'Mr.Cook Backups') {
      if (folderId) {
        try {
          const f = await api(`${API}/files/${folderId}?fields=id,trashed`);
          if (!f.trashed) return f.id;
        } catch {
          // la carpeta ya no existe o no es accesible: se crea otra
        }
      }
      const q = `name='${escapeQ(name)}' and mimeType='${FOLDER_MIME}' and trashed=false`;
      const found = await api(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`);
      if (found.files?.length) return found.files[0].id;
      const created = await api(`${API}/files?fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
      });
      return created.id;
    },

    /** Sube un archivo; si ya hay uno con el mismo nombre en la carpeta, lo reemplaza. */
    async upsertFile({ folder, name, mimeType, data }) {
      const q = `name='${escapeQ(name)}' and '${folder}' in parents and trashed=false`;
      const found = await api(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`);
      if (found.files?.length) {
        const id = found.files[0].id;
        await api(`${UPLOAD}/files/${id}?uploadType=media&fields=id`, {
          method: 'PATCH',
          headers: { 'Content-Type': mimeType },
          body: data,
        });
        return { id, replaced: true };
      }
      const boundary = `mrcook${Date.now().toString(16)}`;
      const meta = JSON.stringify({ name, parents: [folder] });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
        Buffer.from(data),
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      const created = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      });
      return { id: created.id, replaced: false };
    },
  };
}
