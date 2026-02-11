// src/App.jsx

import MapExplorer from "./routes/MapExplorer";

export default function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        {/* LEFT LOGO SLOT */}
        <div className="app-header-side app-header-left">
          {/* replace /logo-left.png with your actual file */}
          <img
            src="/oregon.jpg"
            alt="Left logo"
            className="header-logo-img"
          />
        </div>

        {/* CENTER TITLE + SUBTITLE */}
        <div className="app-header-center">
          <h1 className="app-title">VMRC Seedling Mortality Simulator</h1>
        </div>

        {/* RIGHT LOGO SLOT */}
        <div className="app-header-side app-header-right">
          {/* replace /logo-right.png with your actual file */}
          <img
            src="/vmrc.png"
            alt="Right logo"
            className="header-logo-img"
          />
        </div>
      </header>

      <main className="app-main">
        <MapExplorer />
      </main>
    </div>
  );
}
