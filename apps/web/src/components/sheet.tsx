import { useEffect, useRef, type ReactNode } from "react";

/** Bottom sheet on phones, a dialog on wider screens. Escape and the backdrop close it. */
export function Sheet({
  open,
  onClose,
  title,
  kicker,
  media,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  kicker?: string;
  /** Full-bleed picture above the title. */
  media?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      {/* The page behind goes soft, like looking past a glass of wine. */}
      <button type="button" aria-label="Close" className="fade-in absolute inset-0 bg-espresso/45 backdrop-blur-md" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="sheet-up relative flex max-h-[92dvh] w-full max-w-xl flex-col bg-cream text-espresso shadow-[0_30px_80px_-20px_rgb(23_36_30/0.5)] outline-none"
      >
        <div className="overflow-y-auto">
          {media && <div className="in">{media}</div>}
          <div className="flex items-start justify-between gap-4 border-b border-espresso/15 px-6 pt-6 pb-5">
            <div>
              {kicker && <p className="eyebrow tabular text-taupe">{kicker}</p>}
              <h2 className="mt-1.5 font-serif text-[2rem] leading-tight">{title}</h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="grid size-10 shrink-0 place-items-center border border-espresso/25 transition-colors hover:border-espresso hover:bg-espresso hover:text-cream"
              aria-label="Close"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M1 1L11 11M11 1L1 11" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </button>
          </div>
          <div className="px-6 py-6">{children}</div>
        </div>
        {footer && (
          <div className="border-t border-espresso/15 bg-linen px-6 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">{footer}</div>
        )}
      </div>
    </div>
  );
}
