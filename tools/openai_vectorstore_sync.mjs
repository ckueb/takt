#!/usr/bin/env node
/**
 * Create a NEW OpenAI Vector Store and upload all .txt files from an input folder.
 *
 * Required env:
 *   OPENAI_API_KEY
 *
 * Optional env:
 *   RULESET_VERSION (e.g. git sha)
 *
 * Usage:
 *   node tools/openai_vectorstore_sync.mjs --in docs/compiled --out .vector_store.json
 *
 * Output JSON:
 *   { vector_store_id, file_ids, ruleset_version, created_at }
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import OpenAI from "openai";

function argValue(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  return process.argv[i + 1] || fallback;
}

const inDir = argValue("--in");
const outPath = argValue("--out", ".vector_store.json");

if (!process.env.OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}
if (!inDir) {
  console.error("Missing --in <input_dir>");
  process.exit(1);
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function listTxtFiles(dir) {
  return fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith(".txt"))
    .map(f => path.join(dir, f));
}

function detectDocType(filename) {
  const f = filename.toLowerCase();
  if (f.includes("regelwerk")) return "regelwerk";
  if (f.includes("brandvoice") || f.includes("brand_voice") || f.includes("print")) return "brandvoice";
  if (f.includes("eskalations") || f.includes("konfliktanalyst") || f.includes("instructions")) return "role_instructions";
  return "unknown";
}

async function uploadFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const base = path.basename(filePath);
  // Node 20 has global File (undici). If not present, fall back to Blob.
  const file = new File([buffer], base, { type: "text/plain" });

  const created = await client.files.create({
    file,
    purpose: "assistants",
  });
  return created.id;
}

async function main() {
  const files = listTxtFiles(inDir);
  if (!files.length) {
    console.error(`No .txt files found in ${inDir}`);
    process.exit(1);
  }

  const rulesetVersion = process.env.RULESET_VERSION || new Date().toISOString().slice(0, 10);

  const vectorStore = await client.vectorStores.create({
    name: `takt-ruleset-${rulesetVersion}`,
    metadata: {
      ruleset_version: String(rulesetVersion),
      app: "takt",
    },
  });

  const uploads = [];
  for (const fp of files) {
    const fileId = await uploadFile(fp);
    uploads.push({ file_id: fileId, attributes: { doc_type: detectDocType(fp), ruleset_version: String(rulesetVersion) } });
  }

  // Attach as a batch (lets us set per-file attributes)
  const batch = await client.vectorStores.fileBatches.create(vectorStore.id, {
    files: uploads,
  });

  // Poll until completed
  let status = batch.status;
  const batchId = batch.id;
  const started = Date.now();
  while (status === "in_progress") {
    if (Date.now() - started > 10 * 60 * 1000) {
      throw new Error("Timed out waiting for vector store file batch to complete");
    }
    await new Promise(r => setTimeout(r, 3000));
    const latest = await client.vectorStores.fileBatches.retrieve(vectorStore.id, batchId);
    status = latest.status;
  }
  if (status !== "completed") {
    throw new Error(`File batch ended with status: ${status}`);
  }

  const out = {
    vector_store_id: vectorStore.id,
    file_ids: uploads.map(u => u.file_id),
    ruleset_version: rulesetVersion,
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf-8");
  console.log(JSON.stringify(out, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
