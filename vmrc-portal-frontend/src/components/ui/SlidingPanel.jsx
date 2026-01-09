// src/components/ui/SlidingPanel.jsx

import { useState } from "react";
import { FiChevronLeft, FiChevronRight } from "react-icons/fi";

/**
 * SlidingPanel
 * -------------
 * Fixed right-side panel whose WIDTH animates open/closed.
 * When closed, panel width is 0 (invisible) and only the
 * little toggle button remains on the screen edge.
 */

export default function SlidingPanel({ width = 350, children }) {
  const [open, setOpen] = useState(true);

  const panelWidth = open ? width : 0;

  return (
    <>
      {/* The PANEL itself */}
      <div
        className="sliding-panel"
        style={{
          width: `${panelWidth}px`,
          minWidth: `${panelWidth}px`, // Prevent collapse when width is 0
        }}
      >
        {/* Only render content when open to avoid weird overflow */}
        {open && <div className="sliding-panel-inner">{children}</div>}
      </div>

      {/* The TOGGLE BUTTON (fixed position, outside grid) */}
      <button
        className="panel-toggle-button"
        style={{
          right: open ? `calc(18px + ${width}px)` : '18px', // Account for grid gap when open
        }}
        onClick={() => setOpen((prev) => !prev)}
        aria-label="Toggle side panel"
      >
        {open ? <FiChevronRight size={20} /> : <FiChevronLeft size={20} />}
      </button>
    </>
  );
}
