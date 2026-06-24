// Shared client for the admin-guarded write APIs (/api/config, /api/playbook).
// The dashboard reads with the anon key; these writes go through the
// service-role key and are gated by ADMIN_SECRET. The secret is kept in
// localStorage; a 401 prompts for it and retries once.

/** POST JSON to an admin-guarded route, attaching the saved admin secret. On a
 *  401 it prompts for the secret, stores it, and retries once. */
export async function adminPost(url: string, body: unknown): Promise<Response> {
  const send = (secret: string | null) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret ? { 'x-admin-secret': secret } : {}),
      },
      body: JSON.stringify(body),
    })
  let res = await send(localStorage.getItem('adminSecret'))
  if (res.status === 401) {
    const entered = window.prompt('Admin secret required to save:')
    if (!entered) return res
    localStorage.setItem('adminSecret', entered)
    res = await send(entered)
  }
  return res
}
