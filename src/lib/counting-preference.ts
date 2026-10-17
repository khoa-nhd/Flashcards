/**
 * Whether a review moves a word: the reviewer's own choice, made with the switch
 * beside the words being reviewed, and remembered for next time.
 *
 * The choice belongs to the account, so it follows the reviewer to another
 * device, and is kept on this device as well, so it is still there — and can
 * still be changed — with no connection. A change made offline is sent when the
 * connection returns, and until then this device's own copy is the newer one.
 */
import type { LocalStore } from './offline/storage.js';

export interface CountingPreference {
  /** True when a review moves the word's mastery. */
  get(): boolean;
  subscribe(listener: () => void): () => void;
  /** The reviewer's choice: applies from the next answer on, and is remembered. */
  set(value: boolean): void;
  /**
   * A starting point chosen by the screen rather than by the reviewer — the
   * weakest-words review starts with counting off. It applies at once, and is
   * kept here, but it is not written to the account: only the reviewer's own
   * choice is. The account's stored value is not read over it.
   */
  preset(value: boolean): void;
  /** What the account has stored, where it could be read. A change still waiting to be sent wins. */
  adopt(value: boolean): void;
}

/** The choice as this device keeps it, with whether it has reached the account yet. */
interface Stored {
  value: boolean;
  pending: boolean;
}

export interface CountingPreferenceOptions {
  store: LocalStore;
  accountId: string;
  /** Writes the choice to the account. Where there is none, it is only kept here. */
  save(value: boolean): Promise<unknown>;
}

export function createCountingPreference(options: CountingPreferenceOptions): CountingPreference {
  const { store, accountId, save } = options;
  const key = `${accountId}:preference:counting`;

  // Counted by default: that is what every review did before the choice existed.
  let state: Stored = { value: true, pending: false };
  /** Set once anything has changed the value, so a late read of this device's copy cannot undo it. */
  let touched = false;
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  const write = (next: Stored) => {
    void store.kv.put(key, next).catch(() => undefined);
  };

  void store.kv
    .get<Stored>(key)
    .then((stored) => {
      if (stored === null || touched || stored.value === state.value) return;
      state = stored;
      publish();
    })
    .catch(() => undefined);

  /** Sends the current choice, clearing the pending mark once the account has it. */
  const send = (value: boolean) => {
    void save(value)
      .then(() => {
        // A flip made while this was on its way has its own send to come; this one must not
        // put the older value back or clear a pending mark that is no longer its own.
        if (state.value !== value) return;
        state = { value, pending: false };
        write(state);
      })
      .catch(() => undefined);
  };

  return {
    get: () => state.value,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    set(value) {
      touched = true;
      state = { value, pending: true };
      write(state);
      publish();
      send(value);
    },

    preset(value) {
      // From the screen, so the account is told nothing; but it is still what the reviewer
      // sees, so the account's own value must not be read over it.
      touched = true;
      if (state.value === value) return;
      state = { value, pending: false };
      write(state);
      publish();
    },

    adopt(value) {
      // A change made here that the account has not confirmed yet is the newer of the two.
      if (state.pending) {
        send(state.value);
        return;
      }
      // Anything already chosen here is newer than what the account has on file.
      if (touched) return;
      touched = true;
      if (state.value === value) return;
      state = { value, pending: false };
      write(state);
      publish();
    },
  };
}
