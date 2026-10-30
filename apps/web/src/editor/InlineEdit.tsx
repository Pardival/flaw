import { useEffect, useRef, useState } from "react";

/**
 * Texte de l'en-tête modifiable sur place : un clic ouvre un champ,
 * Entrée ou sortie du champ valide, Échap annule.
 */
export function InlineEdit({
  value,
  label,
  className,
  onCommit,
}: {
  value: string;
  label: string;
  className: string;
  onCommit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  if (!editing) {
    return (
      <button
        type="button"
        className={`inline-edit ${className}`}
        title={label}
        aria-label={`${label} : ${value}`}
        onClick={() => {
          cancelled.current = false;
          setDraft(value);
          setEditing(true);
        }}
      >
        {value}
      </button>
    );
  }
  return (
    <input
      ref={input}
      className={`inline-edit-input ${className}`}
      value={draft}
      maxLength={300}
      aria-label={label}
      size={Math.max(6, draft.length + 1)}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancelled.current = true;
          event.currentTarget.blur();
        }
      }}
      onBlur={() => {
        setEditing(false);
        const next = draft.trim();
        if (!cancelled.current && next !== value) {
          onCommit(next);
        }
      }}
    />
  );
}
