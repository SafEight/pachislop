import type { Slice } from './core';

// Toasts and in-app confirmations.

export const notifySlice: Slice<'notify' | 'confirm' | 'answerConfirm'> = ({ get, set }) => ({
  notify(text, kind = 'info') {
    const toast = { id: Date.now() + Math.random(), text, kind };
    set({ toast });
    setTimeout(
      () => {
        if (get().toast?.id === toast.id) set({ toast: null });
      },
      kind === 'error' ? 6000 : 3000,
    );
  },
  confirm(req) {
    get().confirmation?.resolve(false);
    return new Promise<boolean>((resolve) => set({ confirmation: { ...req, resolve } }));
  },
  answerConfirm(ok) {
    const c = get().confirmation;
    if (!c) return;
    set({ confirmation: null });
    c.resolve(ok);
  },
});
