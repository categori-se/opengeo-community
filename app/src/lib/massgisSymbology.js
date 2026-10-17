// Derived from data/massgis-enviroscreen.json; source hash is retained below.
// Cartographic recipes only; no dataset geometry or credentials.
export const MASSGIS_SYMBOLOGY = {
  "sourceSha256": "aa615de3b448dde8d41815116c7866a5f343d76d71ff7f021b03e43fb0e9d04d",
  "source": {
    "title": "MassGIS · MassEnviroScreen",
    "version": "2026-04-18",
    "url": "https://www.mass.gov/info-details/cumulative-impact-analysis",
    "license": "LicenseRef-Public-Domain",
    "licenseUrl": "https://www.mass.gov/info-details/massgis-frequently-asked-questions",
    "attribution": "MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts EOTSS"
  },
  "presets": [
    {
      "id": "statewide-percentile-fill",
      "geometry": "fill",
      "classification": "step",
      "breaks": [
        20,
        40,
        60,
        80
      ],
      "colors": [
        "#ffffcc",
        "#fed976",
        "#fd8d3c",
        "#e31a1c",
        "#800026"
      ],
      "opacity": 0.76,
      "outlineColor": "#ffffff",
      "outlineWidth": 0.35,
      "nullColor": "#9ca3af"
    },
    {
      "id": "cumulative-score-fill",
      "geometry": "fill",
      "classification": "step",
      "breaks": [
        20,
        40,
        60,
        80
      ],
      "colors": [
        "#f7fcfd",
        "#bfd3e6",
        "#8c96c6",
        "#88419d",
        "#4d004b"
      ],
      "opacity": 0.68,
      "outlineColor": "#ffffff",
      "outlineWidth": 0.3,
      "nullColor": "#9ca3af"
    },
    {
      "id": "pollution-burden-line",
      "geometry": "line",
      "classification": "step",
      "breaks": [
        20,
        40,
        60,
        80
      ],
      "colors": [
        "#fff7ec",
        "#fdd49e",
        "#fc8d59",
        "#d7301f",
        "#7f0000"
      ],
      "opacity": 0.9,
      "outlineColor": "#7f0000",
      "outlineWidth": 1.6,
      "nullColor": "#9ca3af"
    },
    {
      "id": "population-characteristics-line",
      "geometry": "line",
      "classification": "step",
      "breaks": [
        20,
        40,
        60,
        80
      ],
      "colors": [
        "#f7fbff",
        "#c6dbef",
        "#6baed6",
        "#2171b5",
        "#08306b"
      ],
      "opacity": 0.9,
      "outlineColor": "#08306b",
      "outlineWidth": 1.2,
      "nullColor": "#9ca3af"
    }
  ],
  "examples": [
    {
      "id": "pm25-concentration",
      "title": "PM2.5 concentration",
      "description": "Annual average fine-particle concentration, shown as a statewide percentile.",
      "category": "Environmental Exposures",
      "presetId": "statewide-percentile-fill",
      "field": "EXPpctilePM25",
      "fieldAlias": "PM2.5 concentration statewide percentile",
      "sourceField": "PM25",
      "sourceFieldAlias": "Annual average PM2.5 concentration in micrograms per cubic meter",
      "unit": "statewide percentile"
    },
    {
      "id": "ozone-concentration",
      "title": "Ozone concentration",
      "description": "Maximum eight-hour ozone concentration, shown as a statewide percentile.",
      "category": "Environmental Exposures",
      "presetId": "statewide-percentile-fill",
      "field": "EXPpctileOZONE",
      "fieldAlias": "Ozone (O3) concentration statewide percentile",
      "sourceField": "OZONE",
      "sourceFieldAlias": "Maximum 8-hour ozone (O3) concentration in parts per billion",
      "unit": "statewide percentile"
    },
    {
      "id": "diesel-particulate-matter",
      "title": "Diesel particulate matter",
      "description": "Diesel particulate matter concentration, shown as a statewide percentile.",
      "category": "Environmental Exposures",
      "presetId": "statewide-percentile-fill",
      "field": "EXPpctileDSLPM",
      "fieldAlias": "Diesel particulate matter concentration statewide percentile",
      "sourceField": "DSLPM",
      "sourceFieldAlias": "Diesel particulate matter concentration in micrograms per cubic meter",
      "unit": "statewide percentile"
    },
    {
      "id": "nitrogen-dioxide-concentration",
      "title": "Nitrogen dioxide concentration",
      "description": "Average annual nitrogen dioxide concentration, shown as a statewide percentile.",
      "category": "Environmental Exposures",
      "presetId": "statewide-percentile-fill",
      "field": "EXPpctileNO2",
      "fieldAlias": "Nitrogen dioxide (NO2) concentration statewide percentile",
      "sourceField": "NO2",
      "sourceFieldAlias": "Nitrogen dioxide (NO2) average annual concentration in parts per billion",
      "unit": "statewide percentile"
    },
    {
      "id": "heavy-traffic-proximity",
      "title": "Proximity to heavy traffic",
      "description": "Heavy Traffic Proximity Index, shown as a statewide percentile.",
      "category": "Environmental Exposures",
      "presetId": "statewide-percentile-fill",
      "field": "EXPpctilePTRAF",
      "fieldAlias": "Heavy Traffic Proximity Index statewide percentile",
      "sourceField": "PTRAF",
      "sourceFieldAlias": "Heavy Traffic Proximity Index",
      "unit": "statewide percentile"
    },
    {
      "id": "drinking-water-non-compliance",
      "title": "Drinking water non-compliance score",
      "description": "Community water-system compliance performance, shown as a statewide percentile.",
      "category": "Environmental Exposures",
      "presetId": "statewide-percentile-fill",
      "field": "EXPpctileDWATER",
      "fieldAlias": "Safe Drinking Water Act compliance performance score statewide percentile",
      "sourceField": "DWATER",
      "sourceFieldAlias": "Safe Drinking Water Act compliance performance score of a community water system",
      "unit": "statewide percentile"
    },
    {
      "id": "air-toxics-cancer-risk",
      "title": "Air toxics cancer risk",
      "description": "Cumulative lifetime cancer risk from air toxics, shown as a statewide percentile.",
      "category": "Environmental Exposures",
      "presetId": "statewide-percentile-fill",
      "field": "EXPpctileCancerRisk",
      "fieldAlias": "Cumulative Lifetime Cancer Risk from Exposure to Air Toxics statewide percentile",
      "sourceField": "CancerRisk",
      "sourceFieldAlias": "Cumulative Lifetime Cancer Risk from Exposure to Air Toxics per million people",
      "unit": "statewide percentile"
    },
    {
      "id": "air-toxics-respiratory-hazard",
      "title": "Air toxics respiratory hazard",
      "description": "Air toxics respiratory hazard index, shown as a statewide percentile.",
      "category": "Environmental Exposures",
      "presetId": "statewide-percentile-fill",
      "field": "EXPpctileRespHI",
      "fieldAlias": "Air Toxics Respiratory Hazard Index statewide percentile",
      "sourceField": "Respiratory_HI",
      "sourceFieldAlias": "Air Toxics Respiratory Hazard Index",
      "unit": "statewide percentile"
    },
    {
      "id": "pollution-cleanup-sites",
      "title": "Pollution cleanup sites",
      "description": "Weighted cleanup sites requiring federal or state oversight, shown as a statewide percentile.",
      "category": "Environmental Effects",
      "presetId": "statewide-percentile-fill",
      "field": "EFFCTpctileCleanup",
      "fieldAlias": "Weighted sum of cleanup sites statewide percentile",
      "sourceField": "cleanup_score",
      "sourceFieldAlias": "Weighted sum of cleanup sites requiring federal or state oversight",
      "unit": "statewide percentile"
    },
    {
      "id": "groundwater-threats",
      "title": "Groundwater threats",
      "description": "Weighted groundwater threats, shown as a statewide percentile.",
      "category": "Environmental Effects",
      "presetId": "statewide-percentile-fill",
      "field": "EFFCTpctileGrndWater",
      "fieldAlias": "Weighted sum of groundwater threats statewide percentile",
      "sourceField": "gwater_score",
      "sourceFieldAlias": "Weighted sum of groundwater threats",
      "unit": "statewide percentile"
    },
    {
      "id": "hazardous-waste-facilities",
      "title": "Hazardous waste facilities",
      "description": "Weighted hazardous waste facilities, shown as a statewide percentile.",
      "category": "Environmental Effects",
      "presetId": "statewide-percentile-fill",
      "field": "EFFCTpctileBWPMAJOR_PT",
      "fieldAlias": "Weighted sum of hazardous waste facilities statewide percentile",
      "sourceField": "BWPScore",
      "sourceFieldAlias": "Weighted sum of hazardous waste facilities",
      "unit": "statewide percentile"
    },
    {
      "id": "solid-waste-sites-and-facilities",
      "title": "Solid waste sites and facilities",
      "description": "Weighted solid waste facilities, shown as a statewide percentile.",
      "category": "Environmental Effects",
      "presetId": "statewide-percentile-fill",
      "field": "EFFCTpctileSW",
      "fieldAlias": "Weighted sum of solid waste facilities statewide percentile",
      "sourceField": "SWScore",
      "sourceFieldAlias": "Weighted sum of solid waste facilities",
      "unit": "statewide percentile"
    },
    {
      "id": "impaired-water-bodies",
      "title": "Impaired water bodies",
      "description": "Summed pollutants across impaired water bodies, shown as a statewide percentile.",
      "category": "Environmental Effects",
      "presetId": "statewide-percentile-fill",
      "field": "EFFCTpctileIL",
      "fieldAlias": "Summed number of pollutants across impaired water bodies statewide percentile",
      "sourceField": "IL_count",
      "sourceFieldAlias": "Summed number of pollutants across impaired water bodies within the area",
      "unit": "statewide percentile"
    },
    {
      "id": "drought",
      "title": "Drought",
      "description": "Drought frequency and severity measure, shown as a statewide percentile.",
      "category": "Climate Risks",
      "presetId": "statewide-percentile-fill",
      "field": "CLIMpctilDrought",
      "fieldAlias": "Drought measure statewide percentile",
      "sourceField": "AnnFreqWeight",
      "sourceFieldAlias": "Annualized drought frequency weighted by severity",
      "unit": "statewide percentile"
    },
    {
      "id": "wildfire-risk",
      "title": "Wildfire risk",
      "description": "Wildfire hazard potential risk, shown as a statewide percentile.",
      "category": "Climate Risks",
      "presetId": "statewide-percentile-fill",
      "field": "CLIMpctilFIRE",
      "fieldAlias": "Wildfire Risk statewide percentile",
      "sourceField": "AIAmean",
      "sourceFieldAlias": "Annualized wildfire impacts to highly valued resources or assets",
      "unit": "statewide percentile"
    },
    {
      "id": "flooding",
      "title": "Flooding",
      "description": "Area with one-percent annual-chance flood risk, shown as a statewide percentile.",
      "category": "Climate Risks",
      "presetId": "statewide-percentile-fill",
      "field": "CLIMpctilFLD",
      "fieldAlias": "Flood risk statewide percentile",
      "sourceField": "PopFloodPct",
      "sourceFieldAlias": "Percentage of population in the flood-risk area",
      "unit": "statewide percentile"
    },
    {
      "id": "heat",
      "title": "Heat",
      "description": "Summer heat measure, shown as a statewide percentile.",
      "category": "Climate Risks",
      "presetId": "statewide-percentile-fill",
      "field": "CLIMpctilHEAT",
      "fieldAlias": "Unhealthy heat events statewide percentile",
      "sourceField": "HeatEvents",
      "sourceFieldAlias": "Count of unhealthy heat events",
      "unit": "statewide percentile"
    },
    {
      "id": "high-blood-pressure",
      "title": "High blood pressure",
      "description": "Adult high-blood-pressure prevalence, shown as a statewide percentile.",
      "category": "Sensitive Populations",
      "presetId": "statewide-percentile-fill",
      "field": "SPpctileHPRSSR",
      "fieldAlias": "High blood pressure crude prevalence statewide percentile",
      "sourceField": "High_blood_pressure_among_adults",
      "sourceFieldAlias": "High blood pressure crude prevalence among adults",
      "unit": "statewide percentile"
    },
    {
      "id": "coronary-heart-disease",
      "title": "Coronary heart disease",
      "description": "Adult coronary-heart-disease prevalence, shown as a statewide percentile.",
      "category": "Sensitive Populations",
      "presetId": "statewide-percentile-fill",
      "field": "SPpctileHRTDIS",
      "fieldAlias": "Coronary Heart Disease crude prevalence statewide percentile",
      "sourceField": "Coronary_heart_disease_among_adults",
      "sourceFieldAlias": "Coronary Heart Disease crude prevalence among adults",
      "unit": "statewide percentile"
    },
    {
      "id": "chronic-obstructive-pulmonary-disease",
      "title": "Chronic obstructive pulmonary disease",
      "description": "Adult COPD prevalence, shown as a statewide percentile.",
      "category": "Sensitive Populations",
      "presetId": "statewide-percentile-fill",
      "field": "SPpctileCOPD",
      "fieldAlias": "Chronic Obstructive Pulmonary Disease crude prevalence statewide percentile",
      "sourceField": "Chronic_obstructive_pulmonary_disease_among_adults",
      "sourceFieldAlias": "Chronic Obstructive Pulmonary Disease crude prevalence among adults",
      "unit": "statewide percentile"
    },
    {
      "id": "adult-cancer",
      "title": "Adult cancer",
      "description": "Non-skin-cancer or melanoma prevalence among adults, shown as a statewide percentile.",
      "category": "Sensitive Populations",
      "presetId": "statewide-percentile-fill",
      "field": "SPpctileCANCER",
      "fieldAlias": "Cancer crude prevalence statewide percentile",
      "sourceField": "Cancer__non_skin__or_melanoma_among_adults",
      "sourceFieldAlias": "Cancer crude prevalence among adults",
      "unit": "statewide percentile"
    },
    {
      "id": "pediatric-asthma",
      "title": "Pediatric asthma",
      "description": "Pediatric asthma prevalence, shown as a statewide percentile.",
      "category": "Sensitive Populations",
      "presetId": "statewide-percentile-fill",
      "field": "SPpctileAsthmaPed",
      "fieldAlias": "Pediatric Asthma Average prevalence statewide percentile",
      "sourceField": "pedAsthmaPrevalence",
      "sourceFieldAlias": "Pediatric Asthma Average prevalence",
      "unit": "statewide percentile"
    },
    {
      "id": "elevated-blood-lead",
      "title": "Elevated blood lead",
      "description": "Elevated blood-lead prevalence in children, shown as a statewide percentile.",
      "category": "Sensitive Populations",
      "presetId": "statewide-percentile-fill",
      "field": "SPpctileBLL",
      "fieldAlias": "Elevated Blood Level prevalence in children statewide percentile",
      "sourceField": "BLL",
      "sourceFieldAlias": "Elevated Blood Level prevalence in children",
      "unit": "statewide percentile"
    },
    {
      "id": "low-birth-weight",
      "title": "Low birth weight",
      "description": "Low-birth-weight annual average, shown as a statewide percentile.",
      "category": "Sensitive Populations",
      "presetId": "statewide-percentile-fill",
      "field": "SPpctileLBW",
      "fieldAlias": "Low Birth Weight annual average statewide percentile",
      "sourceField": "LBW",
      "sourceFieldAlias": "Low Birth Weight 5-year Annual Average per 100 full-term births",
      "unit": "statewide percentile"
    },
    {
      "id": "premature-mortality",
      "title": "Premature mortality",
      "description": "Age-adjusted premature-mortality rate, shown as a statewide percentile.",
      "category": "Sensitive Populations",
      "presetId": "statewide-percentile-fill",
      "field": "SPpctilePMR",
      "fieldAlias": "Age-adjusted Premature Mortality Rate statewide percentile",
      "sourceField": "PMR",
      "sourceFieldAlias": "Age-adjusted Premature Mortality Rate per 100,000",
      "unit": "statewide percentile"
    },
    {
      "id": "adults-without-high-school-diploma",
      "title": "Adults without a high school diploma",
      "description": "Adults without a high-school diploma, shown as a statewide percentile.",
      "category": "Socioeconomic Factors",
      "presetId": "statewide-percentile-fill",
      "field": "SEpctileHS",
      "fieldAlias": "Adults without a high school diploma statewide percentile",
      "sourceField": "HSlesspctE",
      "sourceFieldAlias": "Percentage of adults without a high school diploma",
      "unit": "statewide percentile"
    },
    {
      "id": "low-income-housing-burden",
      "title": "Low-income housing burden",
      "description": "Low-income households that are housing burdened, shown as a statewide percentile.",
      "category": "Socioeconomic Factors",
      "presetId": "statewide-percentile-fill",
      "field": "SEpctileHHB",
      "fieldAlias": "Low-income housing burden statewide percentile",
      "sourceField": "hhburden",
      "sourceFieldAlias": "Percentage of low income households that are housing burdened",
      "unit": "statewide percentile"
    },
    {
      "id": "limited-english-speaking-households",
      "title": "Limited-English-speaking households",
      "description": "Households in which no adult speaks English well, shown as a statewide percentile.",
      "category": "Socioeconomic Factors",
      "presetId": "statewide-percentile-fill",
      "field": "SEpctileLEP",
      "fieldAlias": "Limited-English-speaking households statewide percentile",
      "sourceField": "limitEngpctE",
      "sourceFieldAlias": "Percentage of households in which no adult speaks English well",
      "unit": "statewide percentile"
    },
    {
      "id": "households-below-poverty",
      "title": "Households below poverty",
      "description": "Households below the poverty level, shown as a statewide percentile.",
      "category": "Socioeconomic Factors",
      "presetId": "statewide-percentile-fill",
      "field": "SEpctilePOV",
      "fieldAlias": "Households below poverty statewide percentile",
      "sourceField": "povHHpctE",
      "sourceFieldAlias": "Percentage of households below the poverty level",
      "unit": "statewide percentile"
    },
    {
      "id": "unemployment",
      "title": "Unemployment",
      "description": "Unemployed working-age civilians, shown as a statewide percentile.",
      "category": "Socioeconomic Factors",
      "presetId": "statewide-percentile-fill",
      "field": "SEpctileEMP",
      "fieldAlias": "Unemployment statewide percentile",
      "sourceField": "unemploypctE",
      "sourceFieldAlias": "Percentage of working age civilians who are unemployed",
      "unit": "statewide percentile"
    },
    {
      "id": "massenviroscreen-score",
      "title": "MassEnviroScreen score",
      "description": "A shared-source map composing the MassEnviroScreen score with pollution burden and population characteristics percentile lines.",
      "category": "Combined analysis",
      "presetId": "cumulative-score-fill",
      "field": "MassEnviroScore",
      "fieldAlias": "MassEnviroScore cumulative burden percentile score",
      "unit": "statewide percentile"
    },
    {
      "id": "pollution-burden",
      "title": "Pollution burden",
      "description": "A shared-source map composing the MassEnviroScreen score with pollution burden and population characteristics percentile lines.",
      "category": "Combined analysis",
      "presetId": "pollution-burden-line",
      "field": "PollutionBurden",
      "fieldAlias": "Weighted average of pollution and climate burden components",
      "unit": "weighted component score"
    },
    {
      "id": "population-characteristics",
      "title": "Population characteristics",
      "description": "A shared-source map composing the MassEnviroScreen score with pollution burden and population characteristics percentile lines.",
      "category": "Combined analysis",
      "presetId": "population-characteristics-line",
      "field": "PopCharacteristics",
      "fieldAlias": "Weighted average of population characteristics components",
      "unit": "weighted component score"
    }
  ]
};
