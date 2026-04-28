import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeReports(rows, { command, dir = "logs", now = new Date() } = {}) {
  await mkdir(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const base = join(dir, `${stamp}-${command}`);
  const jsonPath = `${base}.json`;
  const csvPath = `${base}.csv`;

  await writeFile(jsonPath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  await writeFile(csvPath, toCsv(rows), "utf8");
  return { jsonPath, csvPath };
}

export function toCsv(rows) {
  const headers = ["blk", "burn", "calldata_text", "txHash", "status", "error"];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header] ?? "")).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(value) {
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}
