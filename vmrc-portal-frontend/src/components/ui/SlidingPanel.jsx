// src/components/ui/SlidingPanel.jsx

export default function SlidingPanel({ width = 350, children }) {
  return (
    <div
      className="sliding-panel"
      style={{
        width: `${width}px`,
        minWidth: `${width}px`,
      }}
    >
      <div className="sliding-panel-inner">{children}</div>
    </div>
  );
}
