const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");
const root = path.resolve("server","data");
function walk(dir) {
  const res = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) res.push(...walk(p));
    else if (p.toLowerCase().endsWith(".xlsx")) res.push(p);
  }
  return res;
}
const files = walk(root);
if (!files.length) {
  console.log("No XLSX files found.");
  process.exit(0);
}
for (const file of files) {
  const workbook = xlsx.readFile(file, { cellDates: true });
  const output = {};
  for (const name of workbook.SheetNames) {
    output[name] = xlsx.utils.sheet_to_json(workbook.Sheets[name], { defval: null });
  }
  const jsonPath = file.replace(/\.xlsx$/i, ".json");
  fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2), "utf8");
  console.log("Wrote", jsonPath);
  fs.unlinkSync(file);
  console.log("Deleted", file);
}
