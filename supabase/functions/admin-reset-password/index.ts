const allowedOrigin = 'https://githubalong.github.io';
const corsHeaders = {
  'Access-Control-Allow-Origin': allowedOrigin,
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};

function respond(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function normalizePhone(phone: unknown) {
  const value = String(phone || '').trim().replace(/[\s()-]/g, '');
  if (/^1[3-9]\d{9}$/.test(value)) return '+86' + value;
  if (/^\+861[3-9]\d{9}$/.test(value)) return value;
  return '';
}

function makeTemporaryPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return respond(405, { error: 'METHOD_NOT_ALLOWED' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.replace(/\/+$/, '');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const adminUserId = Deno.env.get('ADMIN_USER_ID');
  const adminPhone = normalizePhone(Deno.env.get('ADMIN_PHONE_E164'));
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !adminUserId || !adminPhone) {
    console.error('Missing required admin-reset-password environment configuration');
    return respond(500, { error: 'SERVER_NOT_CONFIGURED' });
  }

  const authorization = request.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) return respond(401, { error: 'UNAUTHORIZED' });

  try {
    const callerResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: authorization },
    });
    if (!callerResponse.ok) return respond(401, { error: 'UNAUTHORIZED' });
    const caller = await callerResponse.json();
    if (caller.id !== adminUserId || normalizePhone(caller.phone) !== adminPhone) {
      return respond(403, { error: 'ADMIN_ONLY' });
    }

    const body = await request.json().catch(() => null);
    const targetPhone = normalizePhone(body?.phone);
    if (!targetPhone) return respond(400, { error: 'INVALID_PHONE' });

    let target: { id: string; phone?: string } | null = null;
    for (let page = 1; page <= 100; page += 1) {
      const usersResponse = await fetch(
        `${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=1000`,
        { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } },
      );
      if (!usersResponse.ok) {
        console.error('Unable to list Supabase Auth users', usersResponse.status);
        return respond(502, { error: 'USER_LOOKUP_FAILED' });
      }
      const result = await usersResponse.json();
      const users: Array<{ id: string; phone?: string }> = Array.isArray(result.users) ? result.users : [];
      target = users.find((user: { phone?: string }) => normalizePhone(user.phone) === targetPhone) || null;
      if (target || users.length < 1000) break;
      if (page === 100) return respond(503, { error: 'USER_LOOKUP_LIMIT' });
    }
    if (!target) return respond(404, { error: 'USER_NOT_FOUND' });
    if (target.id === caller.id) return respond(400, { error: 'CANNOT_RESET_ADMIN_PASSWORD' });

    const password = makeTemporaryPassword();
    const updateResponse = await fetch(
      `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(target.id)}`,
      {
        method: 'PUT',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password }),
      },
    );
    if (!updateResponse.ok) {
      console.error('Unable to update Supabase Auth user password', updateResponse.status);
      return respond(502, { error: 'PASSWORD_RESET_FAILED' });
    }

    return respond(200, { phone: targetPhone, password });
  } catch (error) {
    console.error('Admin password reset failed', error);
    return respond(500, { error: 'INTERNAL_ERROR' });
  }
});
