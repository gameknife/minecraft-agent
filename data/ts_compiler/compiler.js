const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");

// Regolith sets working dir to temp build root (contains BP/, RP/, data/)
const scriptsDir = path.join("BP", "scripts");
const entryPoint = path.join(scriptsDir, "main.ts");

if (!fs.existsSync(entryPoint)) {
  console.error("[ts_compiler] main.ts not found in BP/scripts/");
  process.exit(1);
}

console.log("[ts_compiler] Compiling main.ts ...");

esbuild.buildSync({
  entryPoints: [entryPoint],
  bundle: true,
  outfile: path.join(scriptsDir, "main.js"),
  format: "esm",
  external: ["@minecraft/server"],
  target: "es2020",
  sourcemap: true,
});

// Remove .ts source files from output (only .js should ship)
const files = fs.readdirSync(scriptsDir);
for (const f of files) {
  if (f.endsWith(".ts")) {
    fs.unlinkSync(path.join(scriptsDir, f));
  }
}

console.log("[ts_compiler] Done.");
