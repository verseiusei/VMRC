// src/main.jsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

// Log API base URL at startup for debugging
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "https://feel-robin-punch-ping.trycloudflare.com";
console.log("[main] API Base URL:", API_BASE_URL);
console.log("[main] Environment mode:", import.meta.env.MODE);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
