# VMRC Mortality Portal

An interactive geospatial web application for exploring **drought-induced seedling mortality** across western Oregon forests. This project integrates large raster-based ecological models with a modern web interface to allow users to draw areas of interest (AOIs), visualize mortality stress layers, inspect histograms, and export geospatial outputs.

---

## 🌲 Project Overview

The **VMRC Mortality Portal** was developed as part of the VMRC (Vegetation Management & Resilience under Climate change) research effort. It models and visualizes seedling mortality for:

* **Species**: Douglas-fir (DF), Western Hemlock (WH)
* **Climate Conditions**: Dry, Normal, Wet
* **Vegetation Cover**: 0–100% (in 25% increments)
* **Months**: April–September

The system allows users to interactively explore **High Stress Mortality (HSL)** rasters and related datasets through a web-based map interface.

---

## ✨ Key Features

* 🗺️ **Interactive Map (Leaflet)**

  * Draw polygon or rectangle AOIs
  * Upload AOI shapefiles/GeoJSON
  * Toggle basemaps and overlays

* 📊 **Dynamic Raster Visualization**

  * On-the-fly clipping of large `.tif` rasters to AOIs
  * Colorized PNG overlays rendered on the map
  * Accurate histograms that match map pixel values

* 📈 **Statistics & Analysis**

  * Pixel distribution histograms
  * Summary statistics per AOI

* 📦 **Export Tools**

  * GeoTIFF export with ArcGIS-compatible metadata
  * PNG map export
  * (Optional) GeoPDF support for ArcGIS workflows

* 🔁 **Multi-layer Management**

  * Generate multiple rasters per session
  * Scrollable raster list with remove/replace controls

---

## 🧱 Tech Stack

### Frontend

* **React + Vite**
* **Leaflet** (mapping)
* **Chart.js / D3** (histograms)
* **Tailwind / CSS** (UI styling)

### Backend

* **Python (Flask / FastAPI)**
* **Rasterio** – raster clipping & reprojection
* **GDAL** – geospatial processing
* **NumPy** – statistics

### Data & Storage

* Large raster datasets (`.tif`, ~75GB locally)
* Cloud storage support (Cloudflare R2 / local disk)
* Metadata sidecar files (`.tif.xml`) for ArcGIS

---

## 📂 Project Structure (Simplified)

```
vmrc-portal/
├── backend/
│   ├── api/
│   │   ├── generate.py        # AOI clip + raster processing
│   │   ├── export.py          # GeoTIFF / PNG / GeoPDF exports
│   │   └── metadata.py        # ArcGIS metadata writer
│   ├── raster_index.py        # Raster discovery & indexing
│   └── app.py                 # API entry point
│
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── MapExplorer.jsx
│   │   │   ├── Histogram.jsx
│   │   │   └── ExportPanel.jsx
│   │   ├── lib/
│   │   │   └── rasterApi.js
│   │   └── main.jsx
│   └── vite.config.js
│
├── rasters/                   # Local raster store (not tracked in git)
├── README.md
└── .gitignore
```

---

## 🚀 Running the Project Locally

### 1️⃣ Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Backend runs at:

```
http://localhost:8000
```

---

### 2️⃣ Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs at:

```
http://localhost:5173
```

Make sure the frontend API base URL points to the backend (via `.env` or config).

---

## 🗂️ Raster Naming Conventions

Examples:

```
M_DF_DRY04.tif        # Douglas-fir, Dry, April
M_WH_WET09.tif       # Western Hemlock, Wet, September
HSL_100_NORMAL.tif   # High Stress Mortality, 100% cover, Normal
```

Consistent naming is required for automatic raster indexing.

---

## 🧪 Known Challenges & Design Decisions

* AOIs are **preserved across filter changes** to allow regeneration without redraw
* Raster overlays are replaced without clearing AOI state
* ArcGIS metadata requires **`.tif.xml`**, not `.aux.xml`
* Large raster volumes are indexed once at backend startup for performance

---

## 📌 Future Improvements

* User authentication & saved projects
* Time-series animation (month slider)
* Database-backed raster metadata (PostGIS)
* Cloud-native raster tiling (COGs)
* Public demo deployment

---

## 👩‍💻 Authors & Acknowledgements

Developed by **VMRC Research Team**

Special thanks to:

* Faculty & advisors for ecological modeling guidance
* Forestry collaborators in Oregon
* Open-source GIS community

---

## 📜 License

This project is for **research and educational use**. Licensing terms can be added here if distribution is planned.

---

If you have questions or want to contribute, feel free to open an issue or reach out!
