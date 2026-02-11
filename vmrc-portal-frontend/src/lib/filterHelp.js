/**
 * Single source of truth for filter help content.
 * Used by FilterLabelWithInfo in the Filters panel (monthly mortality + HSL).
 * Keys match the id prop passed to FilterLabelWithInfo.
 */
export const FILTER_HELP = {
  timeOfYear: {
    label: "Time of the Year",
    short: "Selects the time period used for mortality calculation.",
    long: "Selects the time period used for mortality calculation. High Stress Level represents the highest predicted mortality across all months. April–September show mortality for individual growing-season months.",
  },
  species: {
    label: "Species",
    short: "Selects the tree species used in the mortality model.",
    long: "Selects the tree species used in the mortality model. Options include Douglas-fir and Western Hemlock, which differ in drought sensitivity and survival response.",
  },
  climateScenario: {
    label: "Climate Scenario",
    short: "Select Dry, Normal, or Wet climate scenario.",
    long: "Defines the climate scenario used in the model. Dry, Wet and Normal are the three climate scenarios.",
  },
  condition: {
    label: "Condition",
    short: "Select Dry, Normal, or Wet climate condition for mortality maps.",
    long: "Defines the climate scenario used in the model. Dry, Wet and Normal are the three climate scenarios.",
  },
  coverPercent: {
    label: "Maximum Vegetation Cover (%)",
    short: "Sets the percentage of surrounding vegetation cover (0–100%).",
    long: "Sets the percentage of surrounding vegetation cover, ranging from 0–100%. Higher vegetation cover increases competition for water, which can raise seedling mortality.",
  },
  stressLevel: {
    label: "Stress Level",
    short: "Controls the stress level used in the mortality output.",
    long: "For Western hemlock, this is fixed to Medium. For Douglas-fir, multiple levels may be available depending on the dataset.",
  },
  seedlingDroughtCategory: {
    label: "Seedling Drought Resistance Category",
    short: "Defines drought tolerance based on PLC (Percent Loss of Conductivity).",
    long: "Defines the drought tolerance level of seedlings based on PLC (Percent Loss of Conductivity). Ranges from Low to Very High, where higher resistance indicates better survival under drought stress.",
  },
  hslCondition: {
    label: "HSL Condition",
    short: "Defines the climate scenario used in the model.",
    long: "Defines the climate scenario used in the model. Dry: Drier and hotter than average. Normal: Average climate conditions. Wet: Wetter and cooler than average.",
  },
  exportFilename: {
    label: "Filename (optional)",
    short: "Base name for exported files; extensions are added automatically.",
    long: "Enter a base name only (e.g. my_map). The export will add the correct extension for each format (.png, .tif, .pdf, etc.).",
  },
  exportFormats: {
    label: "Export Formats",
    short: "Choose which formats to include in the export.",
    long: "Select one or more formats. PNG and GeoTIFF are raster outputs; GeoJSON exports the AOI geometry; PDF produces a report with map and statistics.",
  },
  generateMap: {
    label: "Generate Map",
    short: "Clip the selected raster to your AOI and show statistics.",
    long: "Draw or upload an area of interest (AOI) first, then click to generate the map. The raster is clipped to your AOI and stats appear in the right panel.",
  },
  aoiDraw: {
    label: "Draw AOI",
    short: "Draw a polygon on the map to define your area of interest.",
    long: "Use the draw tool on the map to create a polygon. This area is used to clip rasters and compute statistics.",
  },
  aoiUpload: {
    label: "Upload AOI",
    short: "Upload a shapefile or GeoJSON to define your area of interest.",
    long: "Upload a file containing a polygon or multipolygon. The same area is used to clip rasters and compute statistics.",
  },
};
