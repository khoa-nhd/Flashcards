import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../lib/api-client.js';

export type Remote<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'failed'; data: null; error: string };

/**
 * Loads something once when the component appears, and again on `reload`.
 * `load` must keep its identity between renders (an API method does). A reload
 * keeps what is on screen until the new answer arrives. `adopt` puts an answer
 * that arrived another way (a save, say) on screen without another request.
 */
export function useRemote<T>(
  load: () => Promise<T>,
  fallbackMessage: string,
): Remote<T> & { reload(): void; adopt(data: T): void } {
  const [state, setState] = useState<Remote<T>>({ status: 'loading', data: null, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    load()
      .then((data) => {
        if (current) setState({ status: 'ready', data, error: null });
      })
      .catch((cause: unknown) => {
        if (current) {
          setState({ status: 'failed', data: null, error: cause instanceof ApiError ? cause.message : fallbackMessage });
        }
      });
    return () => {
      current = false;
    };
  }, [load, fallbackMessage, attempt]);

  const reload = useCallback(() => setAttempt((count) => count + 1), []);
  const adopt = useCallback((data: T) => setState({ status: 'ready', data, error: null }), []);
  return { ...state, reload, adopt };
}
