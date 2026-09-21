const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function backupName(date = new Date()) {
  return `listingflow-${date.toISOString().replace(/[:.]/g, "-")}`;
}

function runBackup({ dataDir = process.env.DATA_DIR, backupDir = process.env.BACKUP_DIR, retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 30), now = new Date() } = {}) {
  if (!dataDir) throw new Error("Задайте DATA_DIR.");
  if (!backupDir) throw new Error("Задайте BACKUP_DIR.");
  const source = path.resolve(dataDir);
  const destinationRoot = path.resolve(backupDir);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error(`Каталог данных не найден: ${source}`);
  if (destinationRoot === source || destinationRoot.startsWith(`${source}${path.sep}`)) throw new Error("BACKUP_DIR должен находиться вне DATA_DIR.");
  fs.mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  const name = backupName(now);
  const finalPath = path.join(destinationRoot, name);
  const stagingPath = path.join(destinationRoot, `.${name}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  fs.mkdirSync(stagingPath, { mode: 0o700 });
  try {
    fs.cpSync(source, path.join(stagingPath, "data"), { recursive: true, errorOnExist: true, force: false });
    const manifest = { service: "ListingFlow", createdAt: now.toISOString(), source, format: 1 };
    fs.writeFileSync(path.join(stagingPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(stagingPath, finalPath);
  } catch (error) {
    fs.rmSync(stagingPath, { recursive: true, force: true });
    throw error;
  }
  const cutoff = now.getTime() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
  for (const entry of fs.readdirSync(destinationRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("listingflow-")) continue;
    const candidate = path.join(destinationRoot, entry.name);
    if (fs.statSync(candidate).mtimeMs < cutoff) fs.rmSync(candidate, { recursive: true, force: true });
  }
  return finalPath;
}

if (require.main === module) {
  try { console.log(runBackup()); }
  catch (error) { console.error(`Backup failed: ${error.message}`); process.exitCode = 1; }
}

module.exports = { runBackup, backupName };
