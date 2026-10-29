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
          /** From schema version 15. */
          due_on?: string | null;
          revision?: number;
          suspended_at?: string | null;
          suspended_reason?: string | null;
        };
        Insert: {
          vocabulary_id: string;
          user_id?: string;
          mastery: number;
          review_date?: string | null;
          due_on?: string | null;
          revision?: number;
          suspended_at?: string | null;
          suspended_reason?: string | null;
        };
        Update: {
          mastery?: number;
          review_date?: string | null;
          due_on?: string | null;
          revision?: number;
          suspended_at?: string | null;
          suspended_reason?: string | null;
        };
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
      /** From schema version 15. */
      study_days: {
        Row: {
          user_id: string;
          day: string;
          new_words: number;
          reviews: number;
          new_goal: number;
          review_goal: number;
          met: boolean;
          updated_at: string;
        };
        Insert: { user_id?: string; day: string; new_words?: number; reviews?: number; new_goal: number; review_goal: number; met?: boolean };
        Update: { new_words?: number; reviews?: number; new_goal?: number; review_goal?: number; met?: boolean };
        Relationships: [];
      };
      /** From schema version 17. Read only: written through game_commit alone. */
      game_state: {
        Row: { user_id: string; version: number; total_xp: number; state: Record<string, unknown>; updated_at: string };
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      xp_ledger: {
        Row: {
          user_id: string;
          source: 'answer' | 'goal' | 'reward';
          source_id: string;
          amount: number;
          base: number;
          bonus: number;
          reason: string;
          earned_at: string;
          earned_on: string;
        };
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      game_quests: {
        Row: {
          user_id: string;
          period: 'day' | 'week';
          period_start: string;
          slot: number;
          kind: string;
          target: number;
          reward: number;
          progress: number;
          completed_at: string | null;
        };
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      game_badges: {
        Row: { user_id: string; badge: string; tier: number; earned_at: string };
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      game_freezes: {
        Row: { id: string; user_id: string; granted_on: string; used_on: string | null };
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      game_rewards: {
        Row: { id: string; user_id: string; kind: string; payload: Record<string, unknown>; created_at: string; claimed_at: string | null };
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
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
          /** From schema version 13. Whether a review moves a word's mastery. */
          count_reviews_toward_mastery: boolean;
          /** From schema version 15. The two daily goals, the review limit and the interface language. */
          study_goal_new_words?: number | null;
          study_goal_reviews?: number | null;
          study_goal_practice?: number | null;
          maintenance_mode?: boolean;
          max_reviews_per_day?: number | null;
          ui_language?: 'vi' | 'en' | null;
        };
        Insert: {
          user_id?: string;
          time_zone?: string;
          fsrs_request_retention?: number;
          daily_goal_reviews?: number | null;
          daily_goal_minutes?: number | null;
          scheduler?: 'mastery_v1' | 'fsrs';
          count_reviews_toward_mastery?: boolean;
          study_goal_new_words?: number | null;
          study_goal_reviews?: number | null;
          study_goal_practice?: number | null;
          maintenance_mode?: boolean;
          max_reviews_per_day?: number | null;
          ui_language?: 'vi' | 'en' | null;
        };
        Update: {
          time_zone?: string;
          fsrs_request_retention?: number;
          daily_goal_reviews?: number | null;
          daily_goal_minutes?: number | null;
          scheduler?: 'mastery_v1' | 'fsrs';
          count_reviews_toward_mastery?: boolean;
          study_goal_new_words?: number | null;
          study_goal_reviews?: number | null;
          study_goal_practice?: number | null;
          maintenance_mode?: boolean;
          max_reviews_per_day?: number | null;
          ui_language?: 'vi' | 'en' | null;
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
      /** From schema version 10. */
      ai_conversations: {
        Row: { id: string; user_id: string; mode: string; title: string; created_at: string; updated_at: string };
        Insert: { id?: string; user_id?: string; mode: string; title?: string };
        Update: { title?: string };
        Relationships: [];
      };
      /** From schema version 10. */
      ai_messages: {
        Row: { id: string; user_id: string; conversation_id: string; role: string; content: string; metadata: unknown; created_at: string };
        Insert: { id?: string; user_id?: string; conversation_id: string; role: string; content: string; metadata?: unknown };
        Update: Record<string, never>;
        Relationships: [];
      };
      /** From schema version 10. */
      ai_rate_limits: {
        Row: { user_id: string; mode: string; window_start: string; count: number };
        Insert: { user_id?: string; mode: string; window_start: string; count?: number };
        Update: { count?: number };
        Relationships: [];
      };
      /** From schema version 11. */
      vocabulary_analysis: {
        Row: {
          id: string;
          user_id: string;
          vocabulary_id: string;
          pronunciation: string | null;
          part_of_speech: string | null;
          cefr_level: string | null;
          confidence: number | null;
          english_definition: string | null;
          vietnamese_meaning: string | null;
          senses: unknown;
          examples: unknown;
          word_family: unknown;
          collocations: unknown;
          synonyms: unknown;
          antonyms: unknown;
          usage_notes: string | null;
          common_mistakes: string | null;
          revision_summary: string | null;
          model: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string;
          vocabulary_id: string;
          pronunciation?: string | null;
          part_of_speech?: string | null;
          cefr_level?: string | null;
          confidence?: number | null;
          english_definition?: string | null;
          vietnamese_meaning?: string | null;
          senses?: unknown;
          examples?: unknown;
          word_family?: unknown;
          collocations?: unknown;
          synonyms?: unknown;
          antonyms?: unknown;
          usage_notes?: string | null;
          common_mistakes?: string | null;
          revision_summary?: string | null;
          model?: string | null;
        };
        Update: {
          pronunciation?: string | null;
          part_of_speech?: string | null;
          cefr_level?: string | null;
          confidence?: number | null;
          english_definition?: string | null;
          vietnamese_meaning?: string | null;
          senses?: unknown;
          examples?: unknown;
          word_family?: unknown;
          collocations?: unknown;
          synonyms?: unknown;
          antonyms?: unknown;
          usage_notes?: string | null;
          common_mistakes?: string | null;
          revision_summary?: string | null;
          model?: string | null;
        };
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
      /** From schema version 15. */
      record_fsrs_review: {
        Args: { p_event: Record<string, unknown> };
        Returns: Array<{ outcome: string; revision: number | null; due_on: string | null; fsrs: unknown }>;
      };
      /** From schema version 15. */
      undo_fsrs_review: {
        Args: { p_review_request_id: string; p_request_id: string };
        Returns: Array<{ outcome: string; vocabulary_id: string | null; revision: number | null; due_on: string | null; fsrs: unknown }>;
      };
      /** From schema version 15. */
      game_pending_answers: {
        Args: { p_limit: number };
        Returns: Array<{
          id: string;
          kind: 'review' | 'practice' | 'undo';
          undoes: string | null;
          answered_at: string;
          answered_on: string;
          is_new: boolean;
          counted: boolean;
          was_due: boolean;
          duration_ms: number | null;
          mode: string | null;
          mastered: boolean;
        }>;
      };
      game_badge_metrics: {
        Args: Record<string, never>;
        Returns: Array<{
          words_studied: number;
          mastered: number;
          reviews: number;
          practice: number;
          duration_ms: number;
          night_answers: number;
        }>;
      };
      game_commit: {
        Args: { p_payload: string; p_signature: string };
        Returns: Array<{ outcome: 'ok' | 'stale'; version: number; total_xp: number }>;
      };
      study_day_counts: {
        Args: { p_day: string };
        Returns: Array<{ new_words: number; reviews: number }>;
      };
      /** From schema version 15. */
      record_study_day: {
        Args: { p_day: string; p_new_words: number; p_reviews: number; p_new_goal: number; p_review_goal: number; p_met: boolean };
        Returns: boolean;
      };
      /** From schema version 15. */
      set_cards_suspended: {
        Args: { p_ids: string[]; p_suspended: boolean };
        Returns: Array<{ vocabulary_id: string }>;
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
      /** From schema version 14. */
      weak_word_days: {
        Args: Record<string, never>;
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
      /** From schema version 10. */
      list_ai_conversations: {
        Args: { p_limit?: number; p_offset?: number };
        Returns: Array<{ id: string; mode: string; title: string; created_at: string; updated_at: string }>;
      };
      /** From schema version 10. */
      create_ai_conversation: {
        Args: { p_mode: string; p_title?: string };
        Returns: Array<{ id: string; mode: string; title: string; created_at: string; updated_at: string }>;
      };
      /** From schema version 10. */
      get_ai_conversation: {
        Args: { p_id: string };
        Returns: Array<{ id: string; mode: string; title: string; created_at: string; updated_at: string }>;
      };
      /** From schema version 10. */
      update_ai_conversation_title: {
        Args: { p_id: string; p_title: string };
        Returns: boolean;
      };
      /** From schema version 10. */
      delete_ai_conversation: {
        Args: { p_id: string };
        Returns: boolean;
      };
      /** From schema version 10. */
      list_ai_messages: {
        Args: { p_conversation_id: string; p_limit?: number; p_offset?: number };
        Returns: Array<{ id: string; role: string; content: string; metadata: unknown; created_at: string }>;
      };
      /** From schema version 10. */
      insert_ai_message: {
        Args: { p_conversation_id: string; p_role: string; p_content: string; p_metadata?: unknown };
        Returns: Array<{ id: string; role: string; content: string; metadata: unknown; created_at: string }>;
      };
      /** From schema version 12. */
      mark_ai_message_saved: {
        Args: { p_conversation_id: string; p_message_id: string; p_vocabulary_id: string };
        Returns: boolean;
      };
      /** From schema version 10. */
      check_ai_rate_limit: {
        Args: { p_mode: string; p_window: string; p_limit: number };
        Returns: Array<{ allowed: boolean; retry_after_seconds: number; current_count: number; limit: number }>;
      };
      /** From schema version 10. */
      prune_ai_rate_limits: {
        Args: Record<string, never>;
        Returns: number;
      };
      /** From schema version 11. */
      upsert_vocabulary_analysis: {
        Args: {
          p_vocabulary_id: string;
          p_pronunciation?: string | null;
          p_part_of_speech?: string | null;
          p_cefr_level?: string | null;
          p_confidence?: number | null;
          p_english_definition?: string | null;
          p_vietnamese_meaning?: string | null;
          p_senses?: unknown;
          p_examples?: unknown;
          p_word_family?: unknown;
          p_collocations?: unknown;
          p_synonyms?: unknown;
          p_antonyms?: unknown;
          p_usage_notes?: string | null;
          p_common_mistakes?: string | null;
          p_revision_summary?: string | null;
          p_model?: string | null;
        };
        Returns: Array<{
          id: string;
          vocabulary_id: string;
          pronunciation: string | null;
          part_of_speech: string | null;
          cefr_level: string | null;
          confidence: number | null;
          english_definition: string | null;
          vietnamese_meaning: string | null;
          senses: unknown;
          examples: unknown;
          word_family: unknown;
          collocations: unknown;
          synonyms: unknown;
          antonyms: unknown;
          usage_notes: string | null;
          common_mistakes: string | null;
          revision_summary: string | null;
          model: string | null;
          created_at: string;
          updated_at: string;
        }>;
      };
      /** From schema version 11. */
      get_vocabulary_analysis: {
        Args: { p_vocabulary_id: string };
        Returns: Array<{
          id: string;
          vocabulary_id: string;
          pronunciation: string | null;
          part_of_speech: string | null;
          cefr_level: string | null;
          confidence: number | null;
          english_definition: string | null;
          vietnamese_meaning: string | null;
          senses: unknown;
          examples: unknown;
          word_family: unknown;
          collocations: unknown;
          synonyms: unknown;
          antonyms: unknown;
          usage_notes: string | null;
          common_mistakes: string | null;
          revision_summary: string | null;
          model: string | null;
          created_at: string;
          updated_at: string;
        }>;
      };
      /** From schema version 11. */
      delete_vocabulary_analysis: {
        Args: { p_vocabulary_id: string };
        Returns: boolean;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
