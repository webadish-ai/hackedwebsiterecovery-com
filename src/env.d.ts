import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { Database } from './lib/database.types.ts';

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    trackPhoneClick?: () => void;
    trackWhatsAppClick?: () => void;
  }
  namespace App {
    interface Locals {
      supabase?: SupabaseClient<Database>;
      user?: User;
    }
  }
}

export {};
