/** Short-lived confirmations shown at the edge of the screen, optionally with one action. */
export interface Toast {
  id: number;
  message: string;
  tone: 'success' | 'error';
  action?: { label: string; run: () => void };
}

export interface ToastStore {
  getState(): Toast[];
  subscribe(listener: () => void): () => void;
  show(toast: Omit<Toast, 'id' | 'tone'> & { tone?: Toast['tone'] }): number;
  dismiss(id: number): void;
}

export const TOAST_DURATION_MS = 6000;

export function createToastStore(): ToastStore {
  let toasts: Toast[] = [];
  let nextId = 1;
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) listener();
  };

  const dismiss = (id: number) => {
    if (!toasts.some((toast) => toast.id === id)) return;
    toasts = toasts.filter((toast) => toast.id !== id);
    publish();
  };

  return {
    getState: () => toasts,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    show(toast) {
      const id = nextId++;
      // Newest replaces the rest: one message at a time is enough here.
      toasts = [{ tone: 'success', ...toast, id }];
      publish();
      setTimeout(() => dismiss(id), TOAST_DURATION_MS);
      return id;
    },
    dismiss,
  };
}
