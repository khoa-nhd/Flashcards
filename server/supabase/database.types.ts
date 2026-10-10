/**
 * The shape of the database as the Supabase client sees it, kept in step with
 * supabase/migrations by hand. It lets the compiler check every table, column
 * and function name used in supabase-database.ts. Responses are still
 * validated at run time before the rest of the server trusts them.
 */
export interface Database {
  public: {
    Tables: {
      vocabulary: {
        Row: {
          id: string;
          user_id: string;
          word: string;
          word_key: string;
          meaning: string | null;
          definition: string | null;
          example: string | null;
          date_added: string | null;
          external_source: string | null;
          external_id: string | null;
          request_id: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          user_id?: string;
          word: string;
          word_key: string;
          meaning?: string | null;
          definition?: string | null;
          example?: string | null;
          date_added?: string | null;
          external_source?: string | null;
          external_id?: string | null;
          request_id?: string | null;
          created_at?: string;
          deleted_at?: string | null;
        };
        Update: {
          word?: string;
          word_key?: string;
          meaning?: string | null;
          definition?: string | null;
          example?: string | null;
          date_added?: string | null;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      card_states: {
        Row: {
          vocabulary_id: string;
          user_id: string;
          mastery: number;
          review_date: string | null;
          scheduler: string;
          updated_at: string;
        };
        Insert: { vocabulary_id: string; user_id?: string; mastery: number; review_date?: string | null };
        Update: { mastery?: number; review_date?: string | null };
        Relationships: [];
      };
      review_logs: {
        Row: {
          id: string;
          user_id: string;
          vocabulary_id: string;
          request_id: string;
          action: string;
          review_mode: string;
          reviewed_at: string;
          reviewed_on: string;
          duration_ms: number | null;
          mastery_before: number;
          mastery_after: number;
          review_date_before: string | null;
          review_date_after: string | null;
          scheduler: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      user_settings: {
        Row: { user_id: string; time_zone: string; preferences: unknown; created_at: string; updated_at: string };
        Insert: { user_id?: string; time_zone?: string };
        Update: { time_zone?: string };
        Relationships: [];
      };
    };
    Views: {
      vocabulary_cards: {
        Row: {
          id: string;
          user_id: string;
          word: string;
          word_key: string;
          meaning: string | null;
          definition: string | null;
          example: string | null;
          date_added: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
          mastery: number;
          review_date: string | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      create_vocabulary: {
        Args: {
          p_word: string;
          p_word_key: string;
          p_mastery: number;
          p_meaning?: string | null;
          p_definition?: string | null;
          p_example?: string | null;
          p_date_added?: string | null;
          p_review_date?: string | null;
          p_request_id?: string | null;
          p_external_source?: string | null;
          p_external_id?: string | null;
          p_created_at?: string | null;
        };
        Returns: Array<{ id: string; created: boolean }>;
      };
      update_vocabulary: {
        Args: { p_id: string; p_patch: Record<string, string | number | null> };
        Returns: boolean;
      };
      apply_review: {
        Args: {
          p_vocabulary_id: string;
          p_request_id: string;
          p_action: string;
          p_expected_mastery: number;
          p_expected_review_date: string | null;
          p_new_mastery: number;
          p_new_review_date: string | null;
          p_reviewed_on: string;
          p_duration_ms?: number | null;
          p_review_mode?: string;
        };
        Returns: Array<{ outcome: string; mastery: number | null; review_date: string | null }>;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
