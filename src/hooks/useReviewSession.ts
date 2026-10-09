import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReviewApi } from '../lib/api-client.js';
import { createSessionController, type SessionController } from '../lib/session-controller.js';
import type { SessionState } from '../lib/session-machine.js';

/** Creates one review session for the component's lifetime and loads its queue. */
export function useReviewSession(api: Pick<ReviewApi, 'fetchQueue' | 'submitAction'>): {
  state: SessionState;
  session: SessionController;
} {
  const [session] = useState(() => createSessionController(api));
  const state = useSyncExternalStore(session.subscribe, session.getState);

  useEffect(() => {
    void session.load();
  }, [session]);

  return { state, session };
}
