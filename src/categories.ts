// Canonical expense/income categories + synonym normalization, so summaries don't
// fragment across "jornal" / "jornales" / "mano de obra" etc.

export const CANONICAL_CATEGORIES = [
  "mano de obra",
  "insumos",
  "herramientas",
  "transporte",
  "servicios",
  "alimentación",
  "arriendo",
  "animales",
  "venta",
  "otros",
] as const;

// Each canonical category maps to substrings that should fold into it.
const SYNONYMS: Record<string, string[]> = {
  "mano de obra": ["jornal", "jornalero", "peon", "peón", "obrero", "trabajador", "mano de obra"],
  insumos: [
    "abono", "fertilizante", "semilla", "insumo", "fumig", "fungicida", "herbicida",
    "veneno", "cal", "urea", "plaguicida",
  ],
  herramientas: ["herramienta", "machete", "pala", "azad", "equipo", "guadaña", "guadana"],
  transporte: ["transporte", "flete", "gasolina", "combustible", "acpm", "diesel", "pasaje", "mula", "carro", "moto", "viaje"],
  servicios: ["luz", "agua", "gas", "energ", "electric", "internet", "teléfono", "telefono", "servicio"],
  "alimentación": ["comida", "mercado", "aliment", "almuerzo", "remesa", "desayuno"],
  arriendo: ["arriendo", "alquiler", "renta"],
  animales: ["animal", "ganado", "vaca", "gallina", "pollo", "cerdo", "marrano", "concentrado", "res"],
  venta: ["venta", "vendi", "vendí", "cosecha vendida"],
};

/** Fold a free-form category into a canonical one; unknown values are kept (lowercased). */
export function normalizeCategory(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  for (const [canonical, needles] of Object.entries(SYNONYMS)) {
    if (needles.some((n) => s.includes(n))) return canonical;
  }
  return s;
}
