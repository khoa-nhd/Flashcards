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
          /** From schema version 2. */
          kind: string;
          session_id: string | null;
          undoes_log_id: string | null;
          /** From schema version 3. */
          rating: number | null;
          /** From schema version 5. */
          confidence: number | null;
          /** From schema version 6: set on practice rows only. */
          answer_correct: boolean | null;
          submitted_answer: string | null;
          grading: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      /** From schema version 2. */
      study_sessions: {
        Row: { id: string; user_id: string; mode: string; started_at: string; ended_at: string | null };
        Insert: { id: string; user_id?: string; mode?: string };
        Update: { ended_at?: string | null };
        Relationships: [];
      };
      user_settings: {
        Row: {
          user_id: string;
          time_zone: string;
          preferences: unknown;
          created_at: string;
          updated_at: string;
          /** From schema version 3. */
          fsrs_request_retention: number;
          /** From schema version 5. Empty means no goal of that kind. */
          daily_goal_reviews: number | null;
          daily_goal_minutes: number | null;
          /** From schema version 8. Which scheduler decides what is due. */
          scheduler: 'mastery_v1' | 'fsrs';
        };
        Insert: {
          user_id?: string;
          time_zone?: string;
          fsrs_request_retention?: number;
          daily_goal_reviews?: number | null;
          daily_goal_minutes?: number | null;
          scheduler?: 'mastery_v1' | 'fsrs';
        };
        Update: {
          time_zone?: string;
          fsrs_request_retention?: number;
          daily_goal_reviews?: number | null;
          daily_goal_minutes?: number | null;
          scheduler?: 'mastery_v1' | 'fsrs';
        };
        Relationships: [];
      };
      /** From schema version 7. */
      collections: {
        Row: { id: string; user_id: string; name: string; name_key: string; created_at: string; updated_at: string };
        Insert: { id?: string; user_id?: string; name: string; name_key: string };
        Update: { name?: string; name_key?: string };
        Relationships: [];
      };
      collection_items: {
        Row: { collection_id: string; vocabulary_id: string; user_id: string; added_at: string };
        Insert: { collection_id: string; vocabulary_id: string; user_id?: string };
        Update: Record<string, never>;
        Relationships: [];
      };
      vocabulary_examples: {
        Row: {
          id: string;
          user_id: string;
          vocabulary_id: string;
          sentence: string;
          source: string | null;
          preferred: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: { id?: string; user_id?: string; vocabulary_id: string; sentence: string; source?: string | null };
        Update: { sentence?: string; source?: string | null };
        Relationships: [];
      };
      vocabulary_relations: {
        Row: { id: string; user_id: string; low_id: string; high_id: string; kind: string; created_at: string };
        Insert: { id?: string; user_id?: string; low_id: string; high_id: string; kind: string };
        Update: Record<string, never>;
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
          /** From schema version 3. */
          fsrs_due: string | null;
          fsrs_stability: number | null;
          fsrs_difficulty: number | null;
          fsrs_last_review: string | null;
          fsrs_reps: number | null;
          fsrs_lapses: number | null;
          fsrs_state: number | null;
          fsrs_scheduled_days: number | null;
          fsrs_learning_steps: number | null;
          fsrs_version: string | null;
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
      /** From schema version 2. Absent on a database that only has the first migration. */
      app_schema_version: { Args: Record<string, never>; Returns: number };
      record_review: {
        Args: { p_event: Record<string, unknown> };
        Returns: Array<{ outcome: string; mastery: number | null; review_date: string | null }>;
      };
      undo_review: {
        Args: { p_review_request_id: string; p_request_id: string };
        Returns: Array<{
          outcome: string;
          vocabulary_id: string | null;
          mastery: number | null;
          review_date: string | null;
        }>;
      };
      /** From schema version 4. */
      review_daily_stats: {
        Args: { p_from: string; p_to: string };
        Returns: Array<Record<string, string | number | null>>;
      };
      card_review_stats: {
        Args: { p_since: string };
        Returns: Array<Record<string, string | number | null>>;
      };
      confidence_stats: {
        Args: { p_since: string };
        Returns: Array<{ confidence: number; reviews: number; remembered: number }>;
      };
      set_preferred_example: {
        Args: { p_example_id: string; p_preferred: boolean };
        Returns: boolean;
      };
      record_practice: {
        Args: { p_event: Record<string, unknown> };
        Returns: Array<{ outcome: string }>;
      };
      practice_daily_stats: {
        Args: { p_from: string; p_to: string };
        Returns: Array<Record<string, string | number | null>>;
      };
      practice_history: {
        Args: { p_since: string | null };
        Returns: Array<{
          vocabulary_id: string;
          review_mode: string;
          answer_correct: boolean;
          grading: string;
          submitted_answer: string | null;
          reviewed_on: string;
          reviewed_at: string;
          duration_ms: number | null;
          confidence: number | null;
          session_id: string | null;
        }>;
      };
      session_summary: {
        Args: { p_session_id: string };
        Returns: Array<{
          session_id: string;
          started_at: string;
          last_review_at: string | null;
          reviewed: number;
          remembered: number;
          not_remembered: number;
          first_time: number;
          undone: number;
          duration_ms: number;
          timed_reviews: number;
        }>;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
