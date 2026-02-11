import { useState, useRef, useEffect } from "react";
import { FILTER_HELP } from "../../lib/filterHelp";

/**
 * Renders a filter label with an optional ⓘ icon that shows help text in a tooltip (hover/focus) or popover (click).
 * Uses FILTER_HELP[id] for short/long text. Accessible: focusable icon, aria-label, tooltip content for screen readers.
 */
export default function FilterLabelWithInfo({ id, label: labelOverride, showShort = false }) {
  const help = FILTER_HELP[id];
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);

  const label = labelOverride ?? help?.label ?? id;
  const short = help?.short ?? "";
  const long = help?.long ?? "";
  const tooltipId = `filter-info-${id}`;

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  if (!help) {
    return <label>{label}</label>;
  }

  return (
    <div
      className="filter-label-with-info"
      ref={wrapperRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <label className="filter-label-with-info__label">
        {label}
        <span className="filter-label-with-info__spacer" aria-hidden="true"> </span>
        <button
          type="button"
          className="filter-label-with-info__trigger"
          aria-label={`More info about ${label}`}
          aria-describedby={open ? tooltipId : undefined}
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
        >
          ⓘ
        </button>
      </label>
      {showShort && short && (
        <p className="filter-label-with-info__short" aria-hidden="true">{short}</p>
      )}
      {open && long && (
        <div
          id={tooltipId}
          className="filter-label-with-info__popover"
          role="tooltip"
          aria-live="polite"
        >
          {long}
        </div>
      )}
    </div>
  );
}
