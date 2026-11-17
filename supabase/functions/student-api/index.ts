import { createStudentApiHandler } from './handler.mjs';

Deno.serve(createStudentApiHandler({
  backendUrl: Deno.env.get('SUPABASE_URL') || '',
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
}));
