// Diagnostic: run guard + interpreter on the REAL chat messages and verify search.
process.env.DATABASE_PATH = "./test/diag.sqlite";
process.env.TIMEZONE = "America/Bogota";
import { rmSync } from "node:fs";
for (const e of ["", "-wal", "-shm"]) { try { rmSync(process.env.DATABASE_PATH + e); } catch {} }

const { guardInput } = await import("../dist/guard.js");
const { interpret } = await import("../dist/extract.js");
const db = await import("../dist/db.js");

const MSGS = [
  "Dame el resumen de todo lo que hemos hecho hasta ahora",
  "Que onda que podemos hacer acá",
  "Dame el resumen en pdf",
  "En el resumen no veo el gasto de los jornales, donde esta ese",
  "Pero hace nada te dije y anotaste un gasto por 300mil de un jornal",
  "Que gasto ahí acerca de preparación del terreno",
  "Hola",
  "gracias",
];

const today = new Date().toISOString().slice(0, 10);
console.log("# intent classification of the real chat messages");
for (const m of MSGS) {
  const g = await guardInput(m);
  let intent = "—";
  if (g.allow) { try { intent = (await interpret(m, today)).intent; } catch (e) { intent = "ERR:" + e.message; } }
  console.log(`${(g.allow ? "allow" : "BLOCK").padEnd(6)} ${String(intent).padEnd(14)} | ${m}`);
}

console.log("\n# search now finds the jornales/preparación entries");
const CHAT = "1";
db.recordEntries({ chatId: CHAT, messageId: 1, authorUserId: null, authorName: null, rawTranscript: "mayo 17 pagué 300 mil jornales preparación del terreno picar 3 jornales a 100 mil c/u" }, [
  { direction: "expense", amount: 300000, currency: "COP", concept: "Preparación del terreno (picar)", category: "mano de obra", quantity: 3, unit: "jornal", unitPrice: 100000, counterparty: null, note: null, occurredOn: "2026-05-17", status: "recorded" },
]);
const byJornales = db.searchEntries(CHAT, { text: "jornales", counterparty: null, from: null, to: null });
const byPrep = db.searchEntries(CHAT, { text: "preparación del terreno", counterparty: null, from: null, to: null });
console.log(`search "jornales" -> ${byJornales.length} hit(s) ${byJornales[0]?.concept ?? ""}`);
console.log(`search "preparación del terreno" -> ${byPrep.length} hit(s) ${byPrep[0]?.concept ?? ""}`);

for (const e of ["", "-wal", "-shm"]) { try { rmSync(process.env.DATABASE_PATH + e); } catch {} }
