const BOM = "\ufeff";

function escapeCell(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers, rows) {
  const out = [headers.map(escapeCell).join(",")];
  for (const row of rows) {
    out.push(headers.map(h => escapeCell(row[h])).join(","));
  }
  return BOM + out.join("\r\n");
}

export function csvBlob(text) {
  return new Blob([text], { type: "text/csv;charset=utf-8" });
}

export async function blobToDataUrl(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:${blob.type};base64,${btoa(binary)}`;
}
