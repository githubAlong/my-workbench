import { createMaterialHandler } from './handler.mjs';

Deno.serve(createMaterialHandler({
  backendUrl: Deno.env.get('SUPABASE_URL') || '',
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
}));

