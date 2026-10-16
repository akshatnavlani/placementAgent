import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type DbClient = SupabaseClient;

export function createDbClient(url: string, serviceRoleKey: string): DbClient {
  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
