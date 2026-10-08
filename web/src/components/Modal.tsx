import { useState, type FormEvent, type ReactNode } from 'react';
import { Mono } from './ui';

type ModalApi = { close: () => void; leaving: boolean };

/**
 * Shared modal shell: backdrop, fade-down-in / fade-up-out animations,
 * backdrop-click to close. All modals in the app go through this so the
 * animation and behaviour stay identical everywhere.
 */
export function Modal({
  onClose,
  wide = false,
  form = false,
  locked = false,
  children,
}: {
  onClose: () => void;
  wide?: boolean;
  form?: boolean;
  locked?: boolean;
  children: (api: ModalApi) => ReactNode;
}) {
  const [leaving, setLeaving] = useState(false);
  const close = () => {
    if (leaving || locked) return;
    setLeaving(true);
    window.setTimeout(() => {
      onClose();
      setLeaving(false);
    }, 220);
  };

  const panelClass = `w-full ${wide ? 'max-w-lg' : 'max-w-md'} max-h-[90vh] overflow-y-auto mx-4 border border-line bg-black rounded-xl p-6 ${
    leaving ? '' : 'sg-modal-in'
  }`;

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/80 ${leaving ? 'sg-modal-out' : 'sg-backdrop-in'}`}
      onClick={close}
    >
      {form ? (
        <form onClick={(e: FormEvent) => e.stopPropagation()} className={panelClass}>
          {children({ close, leaving })}
        </form>
      ) : (
        <div onClick={(e) => e.stopPropagation()} className={panelClass}>
          {children({ close, leaving })}
        </div>
      )}
    </div>
  );
}

function ApproveCircle() {
  return (
    <svg viewBox="0 0 64 64" className="w-16 h-16 rounded-full sg-approve-circle" aria-hidden="true">
      <circle cx="32" cy="32" r="30" fill="#4CAF50" />
      <path d="M20 33l8 8 16-18" stroke="white" strokeWidth="4" fill="none" strokeLinecap="round" strokeLinejoin="round" className="sg-check" />
    </svg>
  );
}

/**
 * Confirmation modal with the standard approve animation: on confirm the
 * panel heightens, a green check circle plays, then the modal fades up.
 * onConfirm returns true on success (or a Promise of it).
 */
export function ConfirmModal({
  title,
  body,
  confirmLabel = 'Confirm',
  busyLabel = 'Working…',
  doneMessage,
  danger = false,
  error,
  onConfirm,
  onClose,
}: {
  title: ReactNode;
  body: ReactNode;
  confirmLabel?: string;
  busyLabel?: string;
  doneMessage: string;
  danger?: boolean;
  error?: string | null;
  onConfirm: () => boolean | Promise<boolean>;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  const handleConfirm = async (close: () => void) => {
    setSaving(true);
    const ok = await Promise.resolve(onConfirm());
    setSaving(false);
    if (!ok) return;
    setDone(true);
    window.setTimeout(close, 1100);
  };

  return (
    <Modal onClose={onClose} locked={saving || done}>
      {({ close, leaving }) => (
        <div className={`transition-[min-height] duration-300 ${done ? 'min-h-[230px] flex flex-col justify-center' : 'min-h-[178px]'}`}>
          {done ? (
            <div className="flex flex-col items-center justify-center gap-4 py-4">
              <ApproveCircle />
              <p className="font-body text-[15px] text-paper">{doneMessage}</p>
            </div>
          ) : (
            <>
              <h3 className="font-body text-[15px] font-medium text-paper mb-2">{title}</h3>
              <p className="font-mono text-[13px] text-paper/70 mb-6">{body}</p>
              {error && <Mono className="text-[#E0522A] block mb-4">{error}</Mono>}
              <div className="flex items-center gap-4">
                <button
                  disabled={saving}
                  onClick={() => handleConfirm(close)}
                  className={`h-10 px-5 py-2.5 rounded-md font-mono text-[13px] tracking-[0.04em] transition-colors disabled:opacity-50 ${
                    danger ? 'bg-[#E0522A] text-white hover:bg-[#F0643C]' : 'bg-paper text-bg hover:bg-paper/80'
                  }`}
                >
                  {saving ? busyLabel : confirmLabel}
                </button>
                <button
                  onClick={() => { if (!leaving && !saving) close(); }}
                  className="font-mono text-[13px] tracking-[0.04em] text-paper/60 hover:text-white"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
